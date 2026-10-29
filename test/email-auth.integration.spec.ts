import 'reflect-metadata';
import { deleteFixtureUsers } from './support/delete-fixture-users';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { DatabaseService } from '../src/database/database.service';
import { mockEmailAuth, registerVerified, fixtureCode } from './support/email-auth-fixture';
import { requireDisposableDatabase } from './disposable-database';
import type { ChallengeProof } from '../src/auth/email-challenge.service';
import { EmailDeliveryService } from '../src/email/email-delivery.service';

describe.skipIf(process.env.RUN_DB_TESTS !== '1')('email OTP: real PostgreSQL state and atomic auth; only provider mocked',()=>{
  const db=new DatabaseService(),owner=new PrismaClient({datasourceUrl:process.env.MIGRATION_DATABASE_URL});
  const auth=mockEmailAuth(db),users:string[]=[],emails:string[]=[];
  const password=randomBytes(24).toString('hex');
  const input=()=>{const email='otp-'+randomUUID()+'@example.invalid';emails.push(email);return {email,password,displayName:'Kiểm thử OTP',workspaceType:'household' as const,acceptedTerms:true,acceptedPrivacy:true};};
  const proof=(row:ChallengeProof)=>({challengeId:row.challengeId,challengeToken:row.challengeToken});
  async function account(){const body=input(),session=await registerVerified(auth,body);users.push(session.user.id);return {body,session};}
  async function reset(){const a=await account(),challenge=await auth.forgot(a.body.email);return {a,challenge,code:await fixtureCode(auth,a.body.email)};}
  beforeAll(()=>requireDisposableDatabase());
  afterAll(async()=>{
    const ws=await owner.workspaceMember.findMany({where:{userId:{in:users}}});
    await deleteFixtureUsers(owner,users,ws.map(r=>r.workspaceId));
    await owner.$executeRaw`delete from public.auth_email_challenges where email=any(${emails}::text[])`;
    await Promise.all([owner.$disconnect(),db.$disconnect()]);
  });
  it('requires email; normalizes case/space without dropping +tags or dots; no credential/session before verification',async()=>{
    for(const email of ['', ' ', 'bad',null,undefined])await expect(auth.register({...input(),email} as any,{})).rejects.toMatchObject({status:400});
    const body=input();body.email='Case.Tag+'+randomUUID()+'@Example.Invalid';const normalized=body.email.toLowerCase();emails.push(normalized);
    const pending=await auth.register({...body,email:' '+body.email+' '},{});
    expect(pending).not.toHaveProperty('accessToken');expect(pending).not.toHaveProperty('code');
    expect(await owner.user.count({where:{email:normalized}})).toBe(0);
    const code=await fixtureCode(auth,normalized);expect(code).toMatch(/^[0-9]{6}$/);
    const result=await auth.verifyEmailChallenge(pending,'REGISTER',code,{});
    expect(result).toHaveProperty('accessToken');if('accessToken' in result){users.push(result.user.id);expect(result.user.email).toBe(normalized);}
  });
  it('keeps only keyed OTP digest/password hash; TTL is exactly 60000ms and never starts on status fetch',async()=>{
    const {challenge,code}=await reset();const rows=await owner.$queryRaw<any[]>`select * from public.auth_email_challenges where id=${challenge.challengeId}::uuid`;
    expect(rows[0].expires_at-rows[0].issued_at).toBe(60000);expect(rows[0].code_hash).toHaveLength(64);
    expect(JSON.stringify(rows[0])).not.toContain('"'+code+'"');expect(JSON.stringify(rows[0])).not.toContain(password);
    const first=await auth.challenges.status(challenge),second=await auth.challenges.status(challenge);expect(second.expiresAt).toBe(first.expiresAt);
  });
  it('expired registration payload cannot be resent as a broken challenge; a fresh registration can verify',async()=>{
    const body=input(),challenge=await auth.register(body,{});await fixtureCode(auth,body.email);
    await owner.$executeRaw`update public.auth_email_challenges set expires_at=clock_timestamp()-interval '11 minutes',resend_at=clock_timestamp()-interval '1 minute' where id=${challenge.challengeId}::uuid`;
    await new EmailDeliveryService(db,(auth.challenges as any).provider,auth.challenges).maintain();
    expect((await owner.$queryRaw<any[]>`select payload from public.auth_email_challenges where id=${challenge.challengeId}::uuid`)[0].payload).toEqual({});
    await expect(auth.challenges.resend(challenge)).rejects.toMatchObject({status:400,response:{code:'OTP_RESTART_REQUIRED'}});
    const fresh=await auth.register(body,{});expect(fresh.challengeId).not.toBe(challenge.challengeId);
    const result=await auth.verifyEmailChallenge(fresh,'REGISTER',await fixtureCode(auth,body.email),{});
    expect(result).toHaveProperty('accessToken');if('accessToken' in result)users.push(result.user.id);
  });
  it('duplicate request/resend idempotency never creates a second intent/generation; changed input conflicts',async()=>{
    const body=input(),requestId=randomUUID();const first=await auth.register(body,{requestId});
    const same=await auth.register(body,{requestId});expect(same.challengeId).toBe(first.challengeId);expect(same.challengeToken).toBe(first.challengeToken);
    await expect(auth.register({...body,password:'Other-test-password'},{requestId})).rejects.toMatchObject({status:400});
    await fixtureCode(auth,body.email);await owner.$executeRaw`update public.auth_email_challenges set resend_at=clock_timestamp()-interval '1 second' where id=${first.challengeId}::uuid`;
    const resendId=randomUUID();await auth.challenges.resend(first,'',resendId);await auth.challenges.resend(first,'',resendId);
    expect((await owner.$queryRaw<any[]>`select generation from public.auth_email_challenges where id=${first.challengeId}::uuid`)[0].generation).toBe(2);
  });
  for(const [offset,valid] of [[59999,true],[60000,false]] as const)it(`server boundary ${offset}ms is ${valid?'valid':'expired'}`,async()=>{
    const {challenge,code}=await reset();const row=(await owner.$queryRaw<any[]>`select issued_at from public.auth_email_challenges where id=${challenge.challengeId}::uuid`)[0];
    const clock=vi.spyOn(auth.challenges as any,'clock').mockResolvedValue(new Date(row.issued_at.getTime()+offset));
    try{const operation=auth.verifyEmailChallenge(challenge,'RESET',code,{});if(valid)expect(await operation).toHaveProperty('ticket');else await expect(operation).rejects.toMatchObject({status:400});}finally{clock.mockRestore();}
  });
  it('accepts a leading-zero six-digit code, rejects malformed/replayed/wrong-purpose/capability codes',async()=>{
    const {challenge}=await reset();const row=(await owner.$queryRaw<any[]>`select * from public.auth_email_challenges where id=${challenge.challengeId}::uuid`)[0];
    await owner.$executeRaw`update public.auth_email_challenges set code_hash=${auth.challenges.digest('otp',row.id,String(row.generation),row.purpose,row.email,row.user_id,'000042')} where id=${row.id}::uuid`;
    for(const code of ['42','0000420','ab0042'])await expect(auth.verifyEmailChallenge(challenge,'RESET',code,{})).rejects.toMatchObject({status:400});
    await expect(auth.verifyEmailChallenge(challenge,'REGISTER','000042',{})).rejects.toMatchObject({status:400});
    await expect(auth.verifyEmailChallenge({...challenge,challengeToken:randomBytes(32).toString('base64url')},'RESET','000042',{})).rejects.toMatchObject({status:400});
    expect(await auth.verifyEmailChallenge(challenge,'RESET','000042',{})).toHaveProperty('ticket');
    await expect(auth.verifyEmailChallenge(challenge,'RESET','000042',{})).rejects.toMatchObject({status:400});
  });
  it('wrong attempts commit, lock at five, cumulative failures survive resend; never permanently locks the account',async()=>{
    const {a,challenge,code}=await reset();const wrong=code==='999999'?'888888':'999999';
    for(let i=0;i<5;i++)await expect(auth.verifyEmailChallenge(challenge,'RESET',wrong,{})).rejects.toMatchObject({status:400});
    const row=(await owner.$queryRaw<any[]>`select * from public.auth_email_challenges where id=${challenge.challengeId}::uuid`)[0];expect(row.attempts).toBe(5);expect(row.state).toBe('locked');
    await owner.$executeRaw`update public.auth_email_challenges set resend_at=clock_timestamp()-interval '1 second' where id=${row.id}::uuid`;
    await auth.challenges.resend(challenge);await fixtureCode(auth,a.body.email);
    for(let i=0;i<5;i++)await expect(auth.verifyEmailChallenge(challenge,'RESET',wrong,{})).rejects.toThrow();
    await owner.$executeRaw`update public.auth_email_challenges set resend_at=clock_timestamp()-interval '1 second' where id=${row.id}::uuid`;
    await auth.challenges.resend(challenge);const newest=await fixtureCode(auth,a.body.email);
    await expect(auth.verifyEmailChallenge(challenge,'RESET',newest,{})).rejects.toMatchObject({status:429});
    expect((await auth.login(a.body.email,password,{})).user.id).toBe(a.session.user.id);
  });
  it('resend invalidates old generation and a verify/resend race cannot apply twice',async()=>{
    const {a,challenge,code}=await reset();await expect(auth.challenges.resend(challenge)).rejects.toMatchObject({status:429});
    await owner.$executeRaw`update public.auth_email_challenges set resend_at=clock_timestamp()-interval '1 second' where id=${challenge.challengeId}::uuid`;
    await auth.challenges.resend(challenge);const next=await fixtureCode(auth,a.body.email);
    if(next!==code)await expect(auth.verifyEmailChallenge(challenge,'RESET',code,{})).rejects.toMatchObject({status:400});
    const results=await Promise.allSettled([auth.verifyEmailChallenge(challenge,'RESET',next,{}),auth.verifyEmailChallenge(challenge,'RESET',next,{})]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  });
  it('failed resend cannot revive the prior OTP',async()=>{
    const {a,challenge,code}=await reset();await owner.$executeRaw`update public.auth_email_challenges set resend_at=clock_timestamp()-interval '1 second' where id=${challenge.challengeId}::uuid`;
    await auth.challenges.resend(challenge);
    const provider=(auth.challenges as any).provider;
    const submit=vi.spyOn(provider,'send').mockImplementationOnce(async()=>({state:'failed',messageId:randomUUID(),code:'EMAIL_HTTP_403'}));
    try{await auth.challenges.deliverNext(challenge.challengeId);}finally{submit.mockRestore();}
    await expect(auth.verifyEmailChallenge(challenge,'RESET',code,{})).rejects.toMatchObject({status:400});
    expect((await owner.$queryRaw<any[]>`select state from public.auth_email_challenges where id=${challenge.challengeId}::uuid`)[0].state).toBe('failed');
  });
  it('recipient send limit is shared atomically across purposes/concurrent requests',async()=>{
    const email=input().email;
    const purposes=['REGISTER','RESET','CHANGE_PASSWORD','VERIFY_EMAIL','LEGACY_EMAIL','CHANGE_EMAIL_OLD','CHANGE_EMAIL_NEW'] as const;
    const requests=await Promise.allSettled(purposes.map(purpose=>auth.challenges.request(purpose,email,null,{},'',randomUUID())));
    expect(requests.filter(r=>r.status==='fulfilled')).toHaveLength(5);
    expect(requests.filter(r=>r.status==='rejected').every((r:any)=>r.reason.status===429)).toBe(true);
    const rows=await owner.$queryRaw<any[]>`select count(*)::int count from public.auth_email_limits where key=${auth.challenges.digest('recipient',email)} and kind='send'`;
    expect(rows[0].count).toBe(5);
  });
  it('reset response for unknown/eligible email has identical fields; decoy never yields reset proof',async()=>{
    const {a}=await reset();const unknown=input().email;
    await owner.$executeRaw`update public.auth_email_challenges set state='expired' where user_id=${a.session.user.id}::uuid and purpose='RESET'`;
    const known=await auth.forgot(a.body.email),decoy=await auth.forgot(unknown);
    expect(Object.keys(known).sort()).toEqual(Object.keys(decoy).sort());expect(decoy).not.toHaveProperty('accountExists');
    await auth.challenges.deliverNext(known.challengeId);await auth.challenges.deliverNext(decoy.challengeId);
    await expect(auth.verifyEmailChallenge(decoy,'RESET','000000',{})).rejects.toThrow();
  });
  it('reset ticket is bound, one-use, expires in five minutes and revokes old access/refresh credentials',async()=>{
    const {a,challenge,code}=await reset();const result=await auth.verifyEmailChallenge(challenge,'RESET',code,{});if(!('ticket' in result))throw Error('ticket missing');
    await expect(auth.resetWithTicket(challenge,randomBytes(48).toString('base64url'),'New-password-long')).rejects.toThrow();
    await auth.resetWithTicket(challenge,result.ticket,'New-password-long');
    await expect(auth.resetWithTicket(challenge,result.ticket,'Another-password')).rejects.toThrow();
    await expect(auth.authenticate(a.session.accessToken)).rejects.toThrow();await expect(auth.refresh(a.session.refreshToken,{})).rejects.toThrow();
    await expect(auth.login(a.body.email,password,{})).rejects.toThrow();expect((await auth.login(a.body.email,'New-password-long',{})).user.id).toBe(a.session.user.id);
  });
  it('expired ticket and legacy raw-token reset cannot bypass OTP',async()=>{
    const {challenge,code}=await reset();const result=await auth.verifyEmailChallenge(challenge,'RESET',code,{});if(!('ticket' in result))throw Error('ticket missing');
    await owner.$executeRaw`update public.auth_email_challenges set ticket_expires_at=clock_timestamp() where id=${challenge.challengeId}::uuid`;
    await expect(auth.resetWithTicket(challenge,result.ticket,'New-password-long')).rejects.toThrow();
    await expect(auth.reset(randomBytes(48).toString('base64url'),'New-password-long')).rejects.toMatchObject({status:400});
  });
  it('change password requires current password, own active session and OTP; does not issue a replacement session',async()=>{
    const a=await account();await expect(auth.changePassword(a.session.user.id,'wrong','New-password-long',{})).rejects.toMatchObject({status:401});
    const challenge=await auth.changePassword(a.session.user.id,password,'New-password-long',{}),code=await fixtureCode(auth,a.body.email);
    if(!('challengeId' in challenge))throw Error('Normal users must require OTP');
    await expect(auth.verifyEmailChallenge(challenge,'CHANGE_PASSWORD',code,{})).rejects.toMatchObject({status:401});
    const result=await auth.verifyEmailChallenge(challenge,'CHANGE_PASSWORD',code,{},a.session.user.id);expect(result).toEqual({ok:true,reauthenticationRequired:true});
    await expect(auth.authenticate(a.session.accessToken)).rejects.toThrow();await expect(auth.refresh(a.session.refreshToken,{})).rejects.toThrow();
  });
  it('legacy unverified account gets no full session until password-proven verification, preserving UUID/workspace',async()=>{
    const a=await account();await owner.user.update({where:{id:a.session.user.id},data:{emailVerifiedAt:null}});
    await expect(auth.authenticate(a.session.accessToken)).rejects.toThrow();
    let pending:any;try{await auth.login(a.body.email,password,{});}catch(e:any){expect(e.status).toBe(403);pending=e.response.details;}
    expect(pending).not.toHaveProperty('accessToken');const code=await fixtureCode(auth,a.body.email);
    const result=await auth.verifyEmailChallenge(pending,'VERIFY_EMAIL',code,{});if(!('accessToken' in result))throw Error('session missing');expect(result.user.id).toBe(a.session.user.id);
  });
  it('phone-only legacy identity has bounded add-email proof and no phone-only full login bypass',async()=>{
    const a=await account(),phone='+849'+String(Math.floor(Math.random()*1e8)).padStart(8,'0');await owner.user.update({where:{id:a.session.user.id},data:{email:null,emailVerifiedAt:null,phone}});
    let legacy:any;try{await auth.login(phone,password,{});}catch(e:any){expect(e.response.code).toBe('EMAIL_REQUIRED');legacy=e.response.details;}
    const email=input().email;const challenge=await auth.addLegacyEmail(legacy.legacyId,legacy.legacyProof,email,{});
    const result=await auth.verifyEmailChallenge(challenge,'LEGACY_EMAIL',await fixtureCode(auth,email),{});expect(result).toHaveProperty('accessToken');
    expect((await owner.user.findUniqueOrThrow({where:{id:a.session.user.id}})).email).toBe(email);await expect(auth.login(phone,password,{})).rejects.toMatchObject({status:401});
  });
  it('email change requires old and new OTP; direct identifier PATCH is blocked and old sessions revoked',async()=>{
    const a=await account(),next=input().email;
    await expect(auth.identifiers(a.session.user.id,{currentPassword:password,newEmail:next})).rejects.toMatchObject({status:400});
    const old=await auth.requestEmailChange(a.session.user.id,password,{}),verified=await auth.verifyEmailChallenge(old,'CHANGE_EMAIL_OLD',await fixtureCode(auth,a.body.email),{},a.session.user.id);
    if(!('ticket' in verified))throw Error('old proof missing');const challenge=await auth.requestNewEmail(a.session.user.id,old,verified.ticket,next,{});
    expect((await owner.user.findUniqueOrThrow({where:{id:a.session.user.id}})).email).toBe(a.body.email);
    await auth.verifyEmailChallenge(challenge,'CHANGE_EMAIL_NEW',await fixtureCode(auth,next),{},a.session.user.id);
    await expect(auth.authenticate(a.session.accessToken)).rejects.toThrow();expect((await auth.login(next,password,{})).user.id).toBe(a.session.user.id);
  });
});
