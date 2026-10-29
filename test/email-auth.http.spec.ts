import { randomUUID } from 'node:crypto';
import { deleteFixtureUsers } from './support/delete-fixture-users';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { LocalFamilyHttp } from './support/local-family-http';
import { fixtureCode } from './support/email-auth-fixture';
import { reviewerFixtureLock } from './support/reviewer-fixture-lock';

describe.skipIf(process.env.RUN_DB_TESTS!=='1')('actual Nest auth/email HTTP contract (local PostgreSQL, explicit mock mail)',()=>{
 const h=new LocalFamilyHttp(),emails:string[]=[];
 beforeAll(()=>h.start(),30000);
 afterAll(async()=>{await h.fixtures.$executeRaw`delete from public.auth_email_challenges where email=any(${emails}::text[])`;await h.close();});
 async function post(path:string,body:object,token?:string,key=randomUUID()){
  const response=await fetch(h.base+path,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key,...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
  return {status:response.status,body:await response.json(),headers:response.headers};
 }
 it('pending registration cannot access protected API; parallel verify yields one activation; no code/password in HTTP',async()=>{
  const email='email-http-'+randomUUID()+'@example.invalid';emails.push(email);
  const body={email,password:'Strong-owned-password',displayName:'Kiểm thử HTTP',acceptedTerms:true,acceptedPrivacy:true};
  const pending=await post('/auth/register',body),c=pending.body;expect(pending.status).toBe(201);expect(pending.headers.get('cache-control')).toBe('no-store');expect(c).not.toHaveProperty('accessToken');expect(c).not.toHaveProperty('code');
  expect((await fetch(h.base+'/me')).status).toBe(401);
  const code=await fixtureCode(h.emailAuth,email);
  const statuses=await Promise.all([1,2].map(()=>post('/auth/email/verify',{challengeId:c.challengeId,challengeToken:c.challengeToken,purpose:'REGISTER',code})));
  expect(statuses.map(r=>r.status).sort()).toEqual([200,400]);const session=statuses.find(r=>r.status===200)!.body;
  const ws=(await h.fixtures.workspaceMember.findFirstOrThrow({where:{userId:session.user.id}})).workspaceId;
  h.accounts.push({id:session.user.id,email,password:body.password,token:session.accessToken,ws});
  expect(session.user).not.toHaveProperty('passwordHash');expect((await h.call(h.accounts.at(-1)!,'/me')).status).toBe(200);
 });
 it('invalid email, client role and malformed OTP are rejected as 400; retired reset cannot bypass',async()=>{
  for(const email of ['','  ','not-email'])expect((await post('/auth/register',{email,password:'Strong-owned-password',displayName:'Test',acceptedTerms:true,acceptedPrivacy:true})).status).toBe(400);
  expect((await post('/auth/email/verify',{challengeId:randomUUID(),challengeToken:'x'.repeat(64),purpose:'REGISTER',code:'12345'})).status).toBe(400);
  expect((await post('/auth/password/reset',{token:'x'.repeat(64),newPassword:'Strong-owned-password'})).body.error.code).toBe('OTP_PROOF_REQUIRED');
 });
 it('new password stays unapplied until OTP; another customer/public route cannot confirm; old access and refresh revoked',async()=>{
  const a=await h.account(),b=await h.account();const start=await post('/auth/password/change',{currentPassword:a.password,newPassword:'New-strong-password'},a.token);expect(start.status).toBe(200);
  expect((await post('/auth/login',{identifier:a.email,password:'New-strong-password'})).status).toBe(401);
  const code=await fixtureCode(h.emailAuth,a.email),proof={challengeId:start.body.challengeId,challengeToken:start.body.challengeToken,purpose:'CHANGE_PASSWORD',code};
  expect((await post('/auth/email/verify',proof)).status).toBe(401);expect((await post('/auth/email/verify-authenticated',proof,b.token)).status).toBe(401);
  const result=await post('/auth/email/verify-authenticated',proof,a.token);expect(result.body).toEqual({ok:true,reauthenticationRequired:true});
  expect((await h.call(a,'/me')).status).toBe(401);expect((await post('/auth/login',{identifier:a.email,password:a.password})).status).toBe(401);
 });
 it('forgot/status expose no account existence and no reset proof before correct OTP',async()=>{
  const unknown='unknown-'+randomUUID()+'@example.invalid';emails.push(unknown);
  const response=await post('/auth/password/forgot',{identifier:unknown});expect(response.status).toBe(202);expect(response.body).not.toHaveProperty('accountExists');expect(response.body).not.toHaveProperty('ticket');expect(response.body).not.toHaveProperty('devResetToken');
  expect((await post('/auth/email/status',{challengeId:response.body.challengeId,challengeToken:'x'.repeat(64)})).status).toBe(400);
 });
 describe('owned reviewer fixture',()=>{
  let unlock:(()=>Promise<void>)|undefined,reviewerId:string|undefined;
  let session:Awaited<ReturnType<typeof post>>;
  const email='homemind.test@gmail.com',password='synthetic-http-reviewer-only',next='synthetic-next-reviewer-only';
  beforeAll(async()=>{
  // Singleton contention is fixture setup, not time spent exercising HTTP behavior.
  // Keep the existing 5-second test deadline and the database lock's 15-second bound.
  unlock=await reviewerFixtureLock();
  const {bootstrap}=require('../scripts/reviewer-bootstrap.cjs');
  const seeded=await bootstrap(h.fixtures,{email,password});
  reviewerId=seeded.userId;
  session=await post('/auth/login',{identifier:email,password});expect(session.status).toBe(200);
  const ws=(await h.fixtures.workspaceMember.findFirstOrThrow({where:{userId:seeded.userId}})).workspaceId;
  h.accounts.push({id:seeded.userId,email,password,token:session.body.accessToken,ws});
  },30000);
  afterAll(async()=>{
   try{
    if(reviewerId){
      const membership=await h.fixtures.workspaceMember.findMany({where:{userId:reviewerId}});
      await deleteFixtureUsers(h.fixtures,[reviewerId],membership.map(m=>m.workspaceId));
      const index=h.accounts.findIndex(a=>a.id===reviewerId);if(index>=0)h.accounts.splice(index,1);
      await h.fixtures.$executeRaw`delete from public.email_suppressions where email='homemind.test@gmail.com'`;
    }
   }finally{await unlock?.();}
  });
 it('reviewer HTTP contract is bound by operator identity; current-password proof, normal auth and strict DTOs remain required',async()=>{
  expect((await post('/auth/login',{identifier:email})).status).toBe(400);
  expect((await post('/auth/login',{identifier:email,password:next,skipOtp:true})).status).toBe(400);
  expect((await post('/auth/login',{identifier:email,password:next})).status).toBe(401);
  expect((await post('/auth/password/forgot',{identifier:email})).status).toBe(403);
  expect((await post('/auth/password/reset',{token:email,newPassword:next})).status).toBe(400);
  const change=async(current:string,token?:string)=>{
   const response=await fetch(h.base+'/auth/password/change',{method:'POST',headers:{'Content-Type':'application/json','X-HomeMind-Auth-Contract':'2',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify({currentPassword:current,newPassword:next})});
   return {status:response.status,body:await response.json()};
  };
  expect((await change(password)).status).toBe(401);
  expect((await change(next,session.body.accessToken)).status).toBe(401);
  expect((await post('/auth/password/change',{currentPassword:password,newPassword:next},session.body.accessToken)).status).toBe(403);
  const completed=await change(password,session.body.accessToken);expect(completed.status).toBe(200);expect(completed.body).toEqual({ok:true,reauthenticationRequired:true});
  expect((await post('/auth/refresh',{refreshToken:session.body.refreshToken})).status).toBe(401);
  expect((await post('/auth/login',{identifier:email,password:next})).status).toBe(200);
  expect(await h.fixtures.$queryRaw`select id from public.auth_email_challenges where email=${email}`).toHaveLength(0);
  // Normal in-app security history may retain an ineligible delivery intent.
  // It must NEVER be queued, attempted, accepted or delivered to the reviewer.
  const deliveries=await h.fixtures.$queryRaw<Array<{state:string;attempts:number;message_id:string|null}>>`select state,attempts,message_id from public.email_deliveries where email=${email}`;
  for(const delivery of deliveries)expect(delivery).toEqual({state:'ineligible',attempts:0,message_id:null});
  expect(await h.fixtures.$queryRaw`select email from public.email_suppressions where email=${email}`).toHaveLength(1);
 });
 });
});
