import { mockEmailAuth, registerVerified, changeVerifiedPassword, changeVerifiedEmail } from './support/email-auth-fixture';
import 'reflect-metadata';
import { randomUUID, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { DatabaseService } from '../src/database/database.service';
import { AuthService } from '../src/auth/auth.service';
import { ResetDeliveryService } from '../src/auth/reset-delivery.service';
import { MeController } from '../src/me/me.controller';
import type { AuthRequest } from '../src/auth/auth.guard';
import { requireDisposableDatabase } from './disposable-database';
import { deleteFixtureUsers } from './support/delete-fixture-users';

describe.skipIf(process.env.RUN_DB_TESTS !== '1')('profile contact provisioning and atomic committed save', () => {
  const db = new DatabaseService();
  const owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
  const users: string[] = [];
  let auth: AuthService;
  let me: MeController;
  const password = randomBytes(24).toString('hex');
  beforeAll(() => {
    requireDisposableDatabase();
    auth = mockEmailAuth(db);
    me = new MeController(db);
  });
  afterAll(async () => {
    const members = await owner.workspaceMember.findMany({ where: { userId: { in: users } } });
    await deleteFixtureUsers(owner,users,members.map(m => m.workspaceId));
    await Promise.all([owner.$disconnect(), db.$disconnect()]);
  });
  async function account(phone?: string, emailOnly = false) {
    const session = await registerVerified(auth,{acceptedTerms:true,acceptedPrivacy:true, displayName: 'Owned profile',
      email: `profile+${randomUUID()}@example.invalid`,
      phone, password, workspaceType: 'household' }, {});
    users.push(session.user.id);
    return { userId: session.user.id } as AuthRequest;
  }
  it('email-verified registration with phone seeds canonical contact; repeated provision never restores cleared contact', async () => {
    const request = await account('0912345678');
    const initial = await me.get(request);
    expect(initial.phone).toBe(initial.loginPhone);
    expect(initial.loginPhone).toBe('+84912345678');
    await me.update(request, { phone: '' });
    await db.asUser(request.userId, tx => tx.$queryRaw`select public.provision_home(${request.userId}::uuid,'Owned profile','household')`);
    expect((await me.get(request)).phone).toBeNull();
    expect((await me.get(request)).loginPhone).toBe(initial.loginPhone);
  });
  it('email-only registration keeps contact null and persists Unicode partial saves', async () => {
    const request = await account();
    expect((await me.get(request)).phone).toBeNull();
    const saved = await me.update(request, { displayName: '  Hồ sơ thử  ', address: 'Địa chỉ thử', language: 'en' });
    expect(saved.displayName).toBe('Hồ sơ thử');
    const persisted = await me.get(request);
    expect({ ...persisted, voiceQuota: undefined }).toEqual({ ...saved, voiceQuota: undefined });
    expect(persisted.voiceQuota).toMatchObject({ periodId: saved.voiceQuota.periodId, used: 0, total: 15 });
    await me.update(request, { address: null });
    expect((await me.get(request)).address).toBeNull();
    expect((await me.get(request)).language).toBe('en');
  });
  it('response-read failure rolls back the actual PostgreSQL update', async () => {
    const request = await account();
    const faultController = new MeController({
      asUser: (id, callback) => db.asUser(id, tx => callback(new Proxy(tx, {
      get(target, property) {
        if (property === '$queryRaw') return () => { throw new Error('fixture response-load fault'); };
        return Reflect.get(target, property);
      },
      }))),
    } as DatabaseService);
    await expect(faultController.update(request, { displayName: 'Must roll back' })).rejects.toThrow('fixture response-load fault');
    expect((await me.get(request)).displayName).toBe('Owned profile');
  });
  it('another authenticated identity cannot update the first profile through the DTO', async () => {
    const first = await account(), second = await account();
    await me.update(second, { displayName: 'Second only' });
    expect((await me.get(first)).displayName).toBe('Owned profile');
    expect((await me.get(second)).displayName).toBe('Second only');
  });
  it('private historical backfill dry-run/apply preserves existing and explicit-cleared contacts and is idempotent', async () => {
    const blank = await account('0912345681'), existing = await account('0912345682'), cleared = await account('0912345683');
    // Restore the historical pre-marker state in this isolated test DB only.
    await owner.$transaction(async tx => {
      await tx.$executeRaw`select set_config('app.profile_contact_backfill','1',true)`;
      await tx.$executeRaw`update public.profiles set phone=null,contact_phone_explicitly_cleared=false where id=${blank.userId}::uuid`;
    });
    await me.update(existing, { phone: '1234567' });
    await me.update(cleared, { phone: '' });
    const call = async (apply: boolean) => (await owner.$queryRaw<Array<{result:{eligible:number;changed:number}}>>`
      select public.profile_contact_backfill(${apply}) as result`)[0].result;
    expect(await call(false)).toMatchObject({ eligible: 1, changed: 0 });
    expect((await me.get(blank)).phone).toBeNull();
    expect(await call(true)).toMatchObject({ eligible: 1, changed: 1 });
    expect((await me.get(blank)).phone).toBe((await me.get(blank)).loginPhone);
    expect((await me.get(existing)).phone).toBe('1234567');
    expect((await me.get(cleared)).phone).toBeNull();
    expect(await call(true)).toMatchObject({ eligible: 0, changed: 0 });
    await expect(db.$queryRaw`select public.profile_contact_backfill(true)`).rejects.toThrow();
  });
  it('duplicate registration cannot create a partial profile or second workspace', async () => {
    const request = await account();
    const user = await owner.user.findUniqueOrThrow({where:{id:request.userId}});
    const memberships = await owner.workspaceMember.findMany({where:{userId:request.userId}});
    await expect(auth.register({acceptedTerms:true,acceptedPrivacy:true,displayName:'Duplicate must fail',email:user.email!,password,workspaceType:'household'},{}))
      .rejects.toThrow();
    expect(await owner.user.count({where:{email:user.email}})).toBe(1);
    expect(await owner.profile.count({where:{id:request.userId}})).toBe(1);
    expect(await owner.workspaceMember.findMany({where:{userId:request.userId}})).toEqual(memberships);
    expect((await me.get(request)).displayName).toBe('Owned profile');
  });
  it('failure after provisioning rolls back actual user/profile/member/workspace and session writes', async () => {
    let attemptedUser: string | undefined;
    let attemptedWorkspaces: string[] = [];
    const delegated = {
      $transaction: (callback: Parameters<DatabaseService['asUser']>[1]) => db.$transaction(tx => callback(new Proxy(tx, {
        get(target, property) {
          if (property === 'refreshSession') return {
            create: async (args:{data:{userId:string}}) => {
              attemptedUser = args.data.userId;
              attemptedWorkspaces = (await tx.workspaceMember.findMany({where:{userId:attemptedUser}})).map(m=>m.workspaceId);
              throw new Error('OWNED_SESSION_CREATE_FAILURE');
            },
          };
          return Reflect.get(target, property);
        },
      }))),
    } as DatabaseService;
    Object.assign(delegated,{user:db.user,$executeRaw:db.$executeRaw.bind(db),$queryRaw:db.$queryRaw.bind(db)});
    const faulty = mockEmailAuth(delegated);
    const email = `profile-rollback+${randomUUID()}@example.invalid`;
    await expect(registerVerified(faulty,{acceptedTerms:true,acceptedPrivacy:true,displayName:'Never committed',email,password,workspaceType:'household'},{}))
      .rejects.toThrow('OWNED_SESSION_CREATE_FAILURE');
    expect(attemptedUser).toBeDefined(); expect(attemptedWorkspaces).toHaveLength(1);
    expect(await owner.user.count({where:{id:attemptedUser}})).toBe(0);
    expect(await owner.profile.count({where:{id:attemptedUser}})).toBe(0);
    expect(await owner.workspaceMember.count({where:{userId:attemptedUser}})).toBe(0);
    expect(await owner.refreshSession.count({where:{userId:attemptedUser}})).toBe(0);
    expect(await owner.workspace.count({where:{id:{in:attemptedWorkspaces}}})).toBe(0);
  });
  it('authorized login-phone change leaves the independently saved contact intact', async () => {
    const request = await account();
    await me.update(request,{phone:'090 111 2233'});
    await auth.identifiers(request.userId,{currentPassword:password,newPhone:'0912345684'});
    expect(await me.get(request)).toMatchObject({phone:'090 111 2233',loginPhone:'+84912345684'});
    await auth.identifiers(request.userId,{currentPassword:password,newPhone:null});
    expect(await me.get(request)).toMatchObject({phone:'090 111 2233',loginPhone:null});
  });
});
