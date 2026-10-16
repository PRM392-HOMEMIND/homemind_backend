import { randomBytes } from 'node:crypto';
import { AuthService, SessionMetadata } from '../../src/auth/auth.service';
import { RegisterDto } from '../../src/auth/auth.dto';
import { DatabaseService } from '../../src/database/database.service';
import { EmailChallengeService } from '../../src/auth/email-challenge.service';
import { ResetDeliveryService } from '../../src/auth/reset-delivery.service';
import { InfobipProvider, EmailContent } from '../../src/email/infobip.provider';

// Explicit in-process test injection. No runtime mock mode or secret-reading HTTP endpoint.
const captured = new WeakMap<AuthService, Map<string, string>>();
export function mockEmailAuth(db: DatabaseService) {
  process.env.AUTH_OTP_SECRET ||= randomBytes(64).toString('hex');
  process.env.AUTH_OTP_IP_15M ||= '1000';
  process.env.AUTH_OTP_GLOBAL_MINUTE ||= '10000';
  const codes = new Map<string,string>();
  const provider = { available:()=>true, send:async(to:string,content:EmailContent,id:string)=>{
    const code=content.text.match(/\n\n([0-9]{6})\n\n/)?.[1];if(code)codes.set(to,code);
    return {state:'accepted',messageId:id};
  } } as unknown as InfobipProvider;
  const auth=new AuthService(db,new ResetDeliveryService(),new EmailChallengeService(db,provider));
  captured.set(auth,codes);return auth;
}
export function installMockEmailAuth(app: {get:(type:any)=>any}) {
  const auth:AuthService=app.get(require('../../dist/auth/auth.service.js').AuthService),mock=mockEmailAuth(app.get(require('../../dist/database/database.service.js').DatabaseService));
  Object.defineProperty(auth,'challenges',{value:mock.challenges});captured.set(auth,captured.get(mock)!);return auth;
}
export async function verifyHttpRegistration(base:string,auth:AuthService,challenge:any,email?:string) {
  if(!email){const rows=await (auth as any).db.$queryRaw`select email from public.auth_email_challenges where id=${challenge.challengeId}::uuid`;email=rows[0].email;}
  const code=await fixtureCode(auth,email!.trim().toLowerCase());
  const response=await fetch(base+'/auth/email/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({challengeId:challenge.challengeId,challengeToken:challenge.challengeToken,purpose:'REGISTER',code})});
  if(response.status!==200)throw Error('Verified HTTP fixture failed: '+response.status);
  return response.json() as ReturnType<AuthService['response']>;
}
export async function fixtureCode(auth: AuthService, email: string) {
  const codes=captured.get(auth);if(!codes)throw Error('Explicit test email injection required');
  // Explicit test adapters own only their fixture, never another Vitest worker's recipient.
  for(let i=0;i<500;i++) {
    if(codes.has(email)){const code=codes.get(email)!;codes.delete(email);return code;}
    const rows=await (auth as any).db.$queryRaw`select id from public.auth_email_challenges where email=${email} and state='queued' order by created_at desc limit 1`;
    if(!rows[0]||!await auth.challenges.deliverNext(rows[0].id))break;
  }
  throw Error('Owned OTP was not submitted to the mock provider');
}
export async function registerVerified(auth: AuthService, body: RegisterDto, metadata:SessionMetadata={}) {
  const challenge=await auth.register(body,metadata);
  const code=await fixtureCode(auth,body.email.trim().toLowerCase());
  const result=await auth.verifyEmailChallenge(challenge,'REGISTER',code,metadata);
  if(!('accessToken' in result))throw Error('Verified registration must yield a session');
  return result;
}
export async function changeVerifiedPassword(auth: AuthService,userId:string,email:string,currentPassword:string,newPassword:string) {
  const challenge=await auth.changePassword(userId,currentPassword,newPassword,{});
  if('reauthenticationRequired' in challenge)return auth.login(email,newPassword,{});
  await auth.verifyEmailChallenge(challenge,'CHANGE_PASSWORD',await fixtureCode(auth,email),{},userId);
  return auth.login(email,newPassword,{});
}
export async function changeVerifiedEmail(auth: AuthService,userId:string,oldEmail:string,newEmail:string,password:string) {
  const old=await auth.requestEmailChange(userId,password,{});
  const proof=await auth.verifyEmailChallenge(old,'CHANGE_EMAIL_OLD',await fixtureCode(auth,oldEmail),{},userId);
  if(!('ticket' in proof))throw Error('Old-email proof missing');
  const next=await auth.requestNewEmail(userId,old,proof.ticket,newEmail,{});
  await auth.verifyEmailChallenge(next,'CHANGE_EMAIL_NEW',await fixtureCode(auth,newEmail),{},userId);
}
