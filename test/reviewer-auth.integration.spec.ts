import 'reflect-metadata';
import { deleteFixtureUsers } from './support/delete-fixture-users';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../src/database/database.service';
import { isBootstrappedReviewer, REVIEWER_EMAIL } from '../src/auth/reviewer-policy';
import { mockEmailAuth, registerVerified, fixtureCode } from './support/email-auth-fixture';
import { requireDisposableDatabase } from './disposable-database';
import { reviewerFixtureLock } from './support/reviewer-fixture-lock';
const {bootstrap}=require('../scripts/reviewer-bootstrap.cjs');

describe.skipIf(process.env.RUN_DB_TESTS!=='1')('operator-bound reviewer; provider mocked, real DB/auth/session',()=>{
  const owner=new PrismaClient({datasourceUrl:process.env.MIGRATION_DATABASE_URL}),db=new DatabaseService(),auth=mockEmailAuth(db);
  const password=randomBytes(24).toString('hex'),next=randomBytes(24).toString('hex');
  const ids:string[]=[],emails:string[]=[REVIEWER_EMAIL];let id:string;
  let unlock:(()=>Promise<void>)|undefined;
  beforeAll(async()=>{requireDisposableDatabase();unlock=await reviewerFixtureLock();expect(await owner.user.count({where:{email:REVIEWER_EMAIL}})).toBe(0);});
  afterAll(async()=>{
    const memberships=await owner.workspaceMember.findMany({where:{userId:{in:ids}}});
    await deleteFixtureUsers(owner,ids,memberships.map(m=>m.workspaceId));
    await owner.$executeRaw`delete from public.auth_email_challenges where email=any(${emails}::text[])`;
    await owner.$executeRaw`delete from public.email_suppressions where email=${REVIEWER_EMAIL}`;
    await Promise.all([owner.$disconnect(),db.$disconnect()]);await unlock?.();
  });
  it('bootstrap is idempotent and runtime cannot enrol, update or delete a binding',async()=>{
    const first=await bootstrap(owner,{email:REVIEWER_EMAIL,password});id=first.userId;ids.push(id);
    expect(first.status).toBe('PROVISIONED');
    expect(await bootstrap(owner,{email:REVIEWER_EMAIL,password})).toMatchObject({status:'ALREADY_PROVISIONED',userId:id});
    await expect(bootstrap(owner,{email:REVIEWER_EMAIL,password:next})).rejects.toThrow('REVIEWER_IDENTITY_COLLISION');
    for(const query of ['delete from public.auth_reviewer_identity','update public.auth_reviewer_identity set singleton=true',"insert into public.auth_reviewer_identity(user_id,email) select id,email from public.users where email='homemind.test@gmail.com'"])
      await expect(db.$executeRawUnsafe(query)).rejects.toThrow();
    expect(await isBootstrappedReviewer(db,id,REVIEWER_EMAIL)).toBe(true);
    expect(await isBootstrappedReviewer(db,randomUUID(),REVIEWER_EMAIL)).toBe(false);
    expect(await isBootstrappedReviewer(db,id,'homemind.test+alias@gmail.com')).toBe(false);
  });
  it('correct password logs in normally without challenge; wrong/email-only cannot issue credentials or overwrite signup',async()=>{
    expect((await auth.login(REVIEWER_EMAIL,password,{})).user.id).toBe(id);
    await expect(auth.login(REVIEWER_EMAIL,next,{})).rejects.toMatchObject({status:401});
    await expect(auth.login(REVIEWER_EMAIL,'',{})).rejects.toMatchObject({status:401});
    await expect(auth.register({email:REVIEWER_EMAIL,password:next,displayName:'Other',workspaceType:'household',acceptedTerms:true,acceptedPrivacy:true},{})).rejects.toMatchObject({status:409});
    expect(await owner.$queryRaw`select id from public.auth_email_challenges where email=${REVIEWER_EMAIL}`).toHaveLength(0);
  });
  it('email-only recovery, fake OTP, email transfer and closure fail closed without sending mail',async()=>{
    const send=vi.spyOn((auth.challenges as any).provider,'send');
    try {
      await expect(auth.forgot(REVIEWER_EMAIL)).rejects.toMatchObject({status:403});
      await expect(auth.reset('fake-token',next)).rejects.toMatchObject({status:400});
      await expect(auth.challenges.request('RESET',REVIEWER_EMAIL,id,{},'')).rejects.toMatchObject({status:403});
      await expect(auth.verifyEmailChallenge({challengeId:randomUUID(),challengeToken:'fabricated'},'RESET','000000',{})).rejects.toMatchObject({status:400});
      await expect(auth.requestEmailChange(id,next,{})).rejects.toMatchObject({status:401});
      await expect(auth.requestEmailChange(id,password,{})).rejects.toMatchObject({status:403});
      for(const status of ['DISABLED','DELETED'] as const)await expect(auth.closeAccount(id,password,status)).rejects.toMatchObject({status:403});
      expect(send).not.toHaveBeenCalled();
      expect(await owner.$queryRaw`select id from public.auth_email_challenges where email=${REVIEWER_EMAIL}`).toHaveLength(0);
    } finally {send.mockRestore();}
  });
  it('password completion requires correct current password and a capable client; revokes sessions atomically, no OTP',async()=>{
    const session=await auth.login(REVIEWER_EMAIL,password,{});
    await expect(auth.changePassword(id,next,password,{authContract:'2'})).rejects.toMatchObject({status:401});
    await expect(auth.changePassword(id,password,next,{})).rejects.toMatchObject({status:403});
    expect((await auth.login(REVIEWER_EMAIL,password,{})).user.id).toBe(id);
    expect(await auth.changePassword(id,password,next,{authContract:'2'})).toEqual({ok:true,reauthenticationRequired:true});
    await expect(auth.authenticate(session.accessToken)).rejects.toMatchObject({status:401});
    await expect(auth.refresh(session.refreshToken,{})).rejects.toMatchObject({status:401});
    await expect(auth.login(REVIEWER_EMAIL,password,{})).rejects.toMatchObject({status:401});
    expect((await auth.login(REVIEWER_EMAIL,next,{})).user.id).toBe(id);
    expect(await owner.$queryRaw`select id from public.auth_email_challenges where email=${REVIEWER_EMAIL}`).toHaveLength(0);
  });
  it('same-domain/plus/dot aliases and a forged v2 header still require real normal-user OTP',async()=>{
    for(const email of ['homemind.test+qa@gmail.com','home.mind.test@gmail.com','ordinary-review-'+randomUUID()+'@gmail.com']) {
      emails.push(email);
      const session=await registerVerified(auth,{email,password,displayName:'Normal fixture',workspaceType:'household',acceptedTerms:true,acceptedPrivacy:true});ids.push(session.user.id);
      const challenge=await auth.changePassword(session.user.id,password,next,{authContract:'2'});
      expect(challenge).toHaveProperty('challengeId');expect(challenge).not.toHaveProperty('reauthenticationRequired');
      if('challengeId' in challenge)expect(await auth.verifyEmailChallenge(challenge,'CHANGE_PASSWORD',await fixtureCode(auth,email),{},session.user.id)).toEqual({ok:true,reauthenticationRequired:true});
    }
  });
  it('a database reset/reseed binds a new immutable ID; old access and refresh cannot resurrect',async()=>{
    const old=await auth.login(REVIEWER_EMAIL,next,{});
    const memberships=await owner.workspaceMember.findMany({where:{userId:id}});
    await deleteFixtureUsers(owner,[id],memberships.map(m=>m.workspaceId));
    const fresh=await bootstrap(owner,{email:REVIEWER_EMAIL,password});ids.push(fresh.userId);
    expect(fresh.userId).not.toBe(id);expect(await isBootstrappedReviewer(db,id,REVIEWER_EMAIL)).toBe(false);
    await expect(auth.authenticate(old.accessToken)).rejects.toMatchObject({status:401});
    await expect(auth.refresh(old.refreshToken,{})).rejects.toMatchObject({status:401});
    expect((await auth.login(REVIEWER_EMAIL,password,{})).user.id).toBe(fresh.userId);
  });
});
