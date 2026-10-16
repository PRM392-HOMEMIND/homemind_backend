import { mockEmailAuth, registerVerified, changeVerifiedPassword, changeVerifiedEmail } from './support/email-auth-fixture';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { DatabaseService } from '../src/database/database.service';
import { AuthService } from '../src/auth/auth.service';
import { ResetDeliveryService } from '../src/auth/reset-delivery.service';
import { RegisterDto } from '../src/auth/auth.dto';
import { requireDisposableDatabase } from './disposable-database';

describe.skipIf(process.env.RUN_DB_TESTS!=='1')('real legal registration and status-only closure',()=>{
 const db=new DatabaseService();
 const owner=new PrismaClient({datasourceUrl:process.env.MIGRATION_DATABASE_URL});
 const auth=mockEmailAuth(db);
 const password=randomBytes(24).toString('hex');
 const body=(type:'household'|'store'='household'):RegisterDto=>({email:`legal-${randomUUID()}@example.invalid`,password,displayName:'Disposable legal fixture',workspaceType:type,acceptedTerms:true,acceptedPrivacy:true});
 afterAll(async()=>{await Promise.all([db.$disconnect(),owner.$disconnect()]);});

 async function deliveredHistory(userId:string) {
  // Use the real bounded worker; a parallel worker may also finish owned rows.
  for(let i=0;i<40;i++) {
   await db.$queryRaw`select public.notification_deliver()`;
   const [pending]=await owner.$queryRaw<Array<{n:number}>>`select count(*)::int n from public.notification_outbox where recipient_id=${userId}::uuid and delivered_at is null`;
   if(pending.n===0)return owner.$queryRaw<Array<{id:string;kind:string}>>`select * from public.in_app_notifications where recipient_id=${userId}::uuid order by id`;
  }
  throw Error('Owned account history did not materialize within bounded worker batches');
 }

 it('service also rejects missing/false acceptance before any account or session write',async()=>{
  requireDisposableDatabase();
  for(const fields of [{acceptedTerms:false,acceptedPrivacy:true},{acceptedTerms:true,acceptedPrivacy:false},{acceptedTerms:undefined,acceptedPrivacy:undefined}]) {
   const input={...body(),...fields} as RegisterDto;
   await expect(auth.register(input,{})).rejects.toMatchObject({status:400});
   expect(await owner.user.count({where:{email:input.email}})).toBe(0);
  }
 });
 for(const type of ['household','store'] as const) {
  it(`${type} registration atomically stores server timestamps and preserves provisioning/login`,async()=>{
   const input=body(type),start=Date.now();const session=await registerVerified(auth,input,{});
   const user=await owner.user.findUniqueOrThrow({where:{id:session.user.id}});
   expect(user.termsAcceptedAt!.getTime()).toBeGreaterThanOrEqual(start);
   expect(user.termsAcceptedAt!.getTime()).toBeLessThanOrEqual(Date.now());
   expect(user.privacyAcceptedAt).toEqual(user.termsAcceptedAt);
   expect(session.user).not.toHaveProperty('termsAcceptedAt');
   const membership=await owner.workspaceMember.findFirstOrThrow({where:{userId:user.id}});
   expect(membership.role).toBe('owner');
   expect((await owner.workspace.findUniqueOrThrow({where:{id:membership.workspaceId}})).type).toBe(type);
   expect((await owner.profile.findUniqueOrThrow({where:{id:user.id}})).displayName).toBe(input.displayName);
   expect((await auth.authenticate((await auth.login(input.email!,password,{})).accessToken)).userId).toBe(user.id);
   await expect(auth.register(input,{})).rejects.toMatchObject({status:409});
   expect(await owner.user.count({where:{email:input.email}})).toBe(1);
  });
 }
 it('provision failure rolls back user and consent evidence together',async()=>{
  const input={...body(),workspaceType:'invalid'} as unknown as RegisterDto;
  await expect(auth.register(input,{})).rejects.toThrow();
  expect(await owner.user.count({where:{email:input.email}})).toBe(0);
 });
 for(const status of ['DELETED','DISABLED'] as const) {
  it(`${status} preserves row/profile/membership/history and invalidates auth; retry cannot mutate again`,async()=>{
   const input=body(),session=await registerVerified(auth,input,{});
   const membership=await owner.workspaceMember.findFirstOrThrow({where:{userId:session.user.id}});
   const prior=await owner.user.findUniqueOrThrow({where:{id:session.user.id}});
   const reset=await owner.passwordResetToken.create({data:{userId:prior.id,tokenHash:randomBytes(32).toString('hex'),expiresAt:new Date(Date.now()+60000)}});
   const notifications=await deliveredHistory(prior.id);
   expect(notifications.length).toBeGreaterThan(0);
   const historyIds=new Set(notifications.map(row=>row.id));
   await auth.closeAccount(prior.id,password,status);
   const after=await owner.user.findUniqueOrThrow({where:{id:prior.id}});
   expect(after.status).toBe(status);expect(after.email).toBe(prior.email);expect(after.passwordHash).toBe(prior.passwordHash);
   expect(Boolean(after.deletedAt)).toBe(status==='DELETED');expect(after.termsAcceptedAt).toEqual(prior.termsAcceptedAt);
   expect(await owner.profile.count({where:{id:prior.id}})).toBe(1);
   expect(await owner.workspaceMember.count({where:{id:membership.id}})).toBe(1);
   expect((await owner.workspace.findUniqueOrThrow({where:{id:membership.workspaceId}})).archivedAt).not.toBeNull();
   expect(await owner.refreshSession.count({where:{userId:prior.id,revokedAt:null}})).toBe(0);
   expect((await owner.passwordResetToken.findUniqueOrThrow({where:{id:reset.id}})).usedAt).not.toBeNull();
   const remaining=await deliveredHistory(prior.id);
   expect(remaining.filter(row=>historyIds.has(row.id))).toEqual(notifications);
   // Status changes emit a new security event; they must not erase old history.
   expect(remaining.filter(row=>!historyIds.has(row.id)).map(row=>row.kind)).toEqual(['account.security']);
   await expect(auth.authenticate(session.accessToken)).rejects.toThrow();
   await expect(auth.refresh(session.refreshToken,{})).rejects.toThrow();
   await expect(auth.login(input.email!,password,{})).rejects.toMatchObject({status:403});
   await expect(auth.closeAccount(prior.id,password,status)).rejects.toMatchObject({status:403});
   expect(await owner.user.findUniqueOrThrow({where:{id:prior.id}})).toEqual(after);
   expect(await deliveredHistory(prior.id)).toEqual(remaining);
  });
 }
 it('shared sole-owner guard retains all members and account/session state',async()=>{
  const first=await registerVerified(auth,body(),{}),other=await registerVerified(auth,body(),{});
  const member=await owner.workspaceMember.findFirstOrThrow({where:{userId:first.user.id}});
  await owner.workspaceMember.create({data:{userId:other.user.id,workspaceId:member.workspaceId,role:'member'}});
  await expect(auth.closeAccount(first.user.id,password,'DELETED')).rejects.toMatchObject({status:409});
  expect((await owner.user.findUniqueOrThrow({where:{id:first.user.id}})).status).toBe('ACTIVE');
  expect((await owner.workspace.findUniqueOrThrow({where:{id:member.workspaceId}})).archivedAt).toBeNull();
  expect(await owner.workspaceMember.count({where:{workspaceId:member.workspaceId}})).toBe(2);
  expect((await auth.authenticate(first.accessToken)).userId).toBe(first.user.id);
 });
});
