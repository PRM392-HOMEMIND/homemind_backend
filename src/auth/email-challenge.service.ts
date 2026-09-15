import { BadRequestException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseService, UserTx } from '../database/database.service';
import { emailConfig } from '../email/email.config';
import { InfobipProvider } from '../email/infobip.provider';
import { otpTemplate, OtpPurpose } from '../email/email.templates';
import { isBootstrappedReviewer, reviewerOperationUnavailable } from './reviewer-policy';

export type Challenge = { id: string; capability_hash: string; purpose: OtpPurpose; email: string; user_id: string | null;
  binding: string; generation: number; payload: Record<string, any>; state: string; code_hash: string | null;
  issued_at: Date | null; expires_at: Date | null; resend_at: Date; attempts: number; fingerprint: string; ticket_hash: string | null; ticket_expires_at: Date | null };
export type ChallengeProof = { challengeId: string; challengeToken: string };
const invalid = () => new BadRequestException({ code: 'OTP_INVALID', message: 'Mã không hợp lệ, đã dùng hoặc hết hạn. Vui lòng kiểm tra hoặc yêu cầu mã mới.' });
const limit = () => new HttpException({ code: 'OTP_RATE_LIMITED', message: 'Bạn đã thử quá nhiều lần. Vui lòng chờ trước khi thử lại.' }, 429);
const restart = () => new BadRequestException({code:'OTP_RESTART_REQUIRED',message:'Yêu cầu đã hết hạn. Vui lòng quay lại và bắt đầu yêu cầu mới.'});
@Injectable()
export class EmailChallengeService {
  private readonly config = emailConfig();
  constructor(private readonly db: DatabaseService, private readonly provider: InfobipProvider) {}
  private payloadPresent(row: Pick<Challenge,'purpose'|'payload'>) {
    if(row.purpose==='REGISTER')return typeof row.payload.passwordHash==='string' && typeof row.payload.displayName==='string' && typeof row.payload.acceptedAt==='string';
    if(row.purpose==='CHANGE_PASSWORD')return typeof row.payload.passwordHash==='string' && typeof row.payload.nextPasswordDigest==='string';
    if(row.purpose==='CHANGE_EMAIL_NEW')return typeof row.payload.oldEmail==='string';
    return true;
  }
  digest(...parts: string[]) {
    if (Buffer.byteLength(this.config.secret) < 32) throw new ServiceUnavailableException({ code: 'EMAIL_NOT_CONFIGURED', message: 'Xác thực email chưa sẵn sàng. Vui lòng thử lại sau.' });
    return createHmac('sha256', this.config.secret).update(JSON.stringify(parts)).digest('hex');
  }
  private equal(a: string | null, b: string) { return !!a && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
  private async lock(tx: UserTx, key: string) { await tx.$executeRaw`select pg_advisory_xact_lock(hashtextextended(${key},10))`; }
  private async clock(tx: UserTx) { return (await tx.$queryRaw<Array<{ now: Date }>>`select clock_timestamp() as now`)[0].now; }
  private async rate(tx: UserTx, email: string, ip: string, now: Date) {
    // Brief shared critical section. The provider is NEVER awaited inside it.
    await this.lock(tx, 'email-rate');
    const keys = [this.digest('recipient', email), this.digest('ip', ip), 'global'];
    const rows = await tx.$queryRaw<Array<{ key: string; quarter: number; hour: number; minute: number }>>`
      select key,count(*) filter(where occurred_at>${new Date(now.getTime()-900000)})::int quarter,
       count(*)::int as "hour",count(*) filter(where occurred_at>${new Date(now.getTime()-60000)})::int as "minute"
      from public.auth_email_limits where key=any(${keys}::text[]) and kind='send' and occurred_at>${new Date(now.getTime()-3600000)} group by key`;
    const emailRow = rows.find(r => r.key === keys[0]), ipRow = rows.find(r => r.key === keys[1]), global = rows.find(r => r.key === 'global');
    if ((emailRow?.quarter || 0) >= this.config.perQuarter || (emailRow?.hour || 0) >= this.config.perHour || (ipRow?.quarter || 0) >= this.config.ipQuarter || (global?.minute || 0) >= this.config.globalMinute) throw limit();
    await tx.$executeRaw`insert into public.auth_email_limits(key,kind,occurred_at) select unnest(${keys}::text[]),'send',${now}`;
  }
  async request(purpose: OtpPurpose, email: string, userId: string | null, payload: object, fingerprint: string, ip = '', transaction?: UserTx, requestId: string = randomUUID()) {
    if (!this.provider.available()) throw new ServiceUnavailableException({ code: 'EMAIL_NOT_CONFIGURED', message: 'Xác thực email chưa sẵn sàng. Vui lòng thử lại sau.' });
    if(!/^[0-9a-f-]{36}$/i.test(requestId))throw new BadRequestException('Idempotency-Key không hợp lệ.');
    const id = randomUUID(), token = this.digest('request-capability',id,requestId);
    const binding = this.digest('binding', purpose, userId || email);
    const create = async (tx: UserTx) => {
      if(await isBootstrappedReviewer(tx,userId,email))throw reviewerOperationUnavailable();
      await this.lock(tx, binding);
      const now = await this.clock(tx);
      const requestHash=this.digest('request-body',fingerprint,JSON.stringify(Object.fromEntries(Object.entries(payload).filter(([key])=>!['passwordHash','acceptedAt'].includes(key)).sort(([a],[b])=>a.localeCompare(b)))));
      const duplicate=(await tx.$queryRaw<Array<Pick<Challenge,'id'|'fingerprint'|'resend_at'|'purpose'|'payload'> & {request_hash:string}>>`select id,fingerprint,resend_at,request_hash,purpose,payload from public.auth_email_challenges where binding=${binding} and request_id=${requestId}::uuid`)[0];
      if(duplicate){
        if(duplicate.request_hash!==requestHash)throw new BadRequestException({code:'IDEMPOTENCY_CONFLICT',message:'Yêu cầu đã dùng với dữ liệu khác.'});
        if(!this.payloadPresent(duplicate))throw restart();
        return {challengeId:duplicate.id,challengeToken:this.digest('request-capability',duplicate.id,requestId),purpose,serverTime:now.toISOString(),state:'preparing',expiresAt:null,resendAvailableAt:duplicate.resend_at.toISOString(),maskedEmail:email.replace(/^(.).+(@.+)$/,'$1•••$2')};
      }
      const previous = (await tx.$queryRaw<Challenge[]>`select * from public.auth_email_challenges where binding=${binding} and state in('queued','submitting','accepted','unknown','verified') for update`)[0];
      // Clients retain the same capability on retry/resend; a new caller cannot overwrite it.
      if (previous && previous.resend_at > now) throw limit();
      await this.rate(tx, email, ip, now);
      await tx.$executeRaw`update public.auth_email_challenges set state='expired',code_hash=null,payload='{}',ticket_hash=null where binding=${binding} and state in('queued','submitting','accepted','unknown','verified')`;
      await tx.$executeRaw`insert into public.auth_email_challenges(id,capability_hash,purpose,email,user_id,binding,payload,fingerprint,resend_at,request_id,request_hash)
       values(${id}::uuid,${this.digest('capability', id, token)},${purpose},${email},${userId}::uuid,${binding},${JSON.stringify(payload)}::jsonb,${fingerprint},${new Date(now.getTime()+60000)},${requestId}::uuid,${requestHash})`;
      return { challengeId: id, challengeToken: token, purpose, serverTime: now.toISOString(), state: 'preparing', expiresAt: null, resendAvailableAt: new Date(now.getTime()+60000).toISOString(), maskedEmail: email.replace(/^(.).+(@.+)$/, '$1•••$2') };
    };
    return transaction ? create(transaction) : this.db.$transaction(create);
  }
  private async owned(tx: UserTx, proof: ChallengeProof) {
    const row = (await tx.$queryRaw<Challenge[]>`select * from public.auth_email_challenges where id=${proof.challengeId}::uuid for update`)[0];
    if (!row || !this.equal(row.capability_hash, this.digest('capability', row.id, proof.challengeToken))) throw invalid();
    if(await isBootstrappedReviewer(tx,row.user_id,row.email))throw reviewerOperationUnavailable();
    return row;
  }
  async status(proof: ChallengeProof) {
    return this.db.$transaction(async tx => {
      const row = await this.owned(tx, proof), now = await this.clock(tx);
      // Reset responses never reveal account eligibility/provider success.
      const state = row.state === 'queued' ? 'preparing' : row.expires_at && now >= row.expires_at ? 'expired' :
        row.purpose === 'RESET' ? 'ready' : ['submitting','accepted','unknown'].includes(row.state) ? 'ready' : row.state;
      return { challengeId: row.id, purpose: row.purpose, state, serverTime: now.toISOString(),
        issuedAt: row.issued_at?.toISOString() || null, expiresAt: row.expires_at?.toISOString() || null,
        resendAvailableAt: row.resend_at.toISOString(), maskedEmail: row.email.replace(/^(.).+(@.+)$/, '$1•••$2') };
    });
  }
  async resend(proof: ChallengeProof, ip = '', requestId: string = randomUUID()) {
    return this.db.$transaction(async tx => {
      const row = await this.owned(tx, proof);
      if(!this.payloadPresent(row))throw restart();
      const now = await this.clock(tx);
      const prior=(await tx.$queryRaw<Array<{same:boolean}>>`select last_resend_request=${requestId}::uuid as same from public.auth_email_challenges where id=${row.id}::uuid`)[0];
      if(prior.same)return {...proof,state:'preparing',serverTime:now.toISOString(),expiresAt:row.expires_at?.toISOString() || null,resendAvailableAt:row.resend_at.toISOString()};
      if (['consumed','verified'].includes(row.state)) throw invalid();
      if (now < row.resend_at) throw limit();
      await this.rate(tx, row.email, ip, now);
      await tx.$executeRaw`update public.auth_email_challenges set state='queued',generation=generation+1,code_hash=null,issued_at=null,expires_at=null,
       attempts=0,message_id=null,delivery_state=null,resend_at=${new Date(now.getTime()+60000)},last_resend_request=${requestId}::uuid where id=${row.id}::uuid`;
      return { ...proof, state: 'preparing', serverTime: now.toISOString(), expiresAt: null, resendAvailableAt: new Date(now.getTime()+60000).toISOString() };
    });
  }
  async verify<T>(proof: ChallengeProof, purpose: OtpPurpose, code: string, apply: (tx: UserTx, row: Challenge, now: Date) => Promise<T>) {
    if (!/^[0-9]{6}$/.test(code)) throw invalid();
    const result = await this.db.$transaction(async tx => {
      const row = await this.owned(tx, proof), now = await this.clock(tx);
      await this.lock(tx, this.digest('failures', row.email));
      const errors = (await tx.$queryRaw<Array<{ count: number }>>`select count(*)::int count from public.auth_email_limits where key=${this.digest('recipient', row.email)} and kind='failure' and occurred_at>${new Date(now.getTime()-900000)}`)[0].count;
      if (errors >= 10) return { error: 'limit' } as const;
      if (row.purpose !== purpose || !row.expires_at || now >= row.expires_at || !['submitting','accepted','unknown'].includes(row.state) || row.attempts >= 5) return { error: 'invalid' } as const;
      if (!this.equal(row.code_hash, this.digest('otp', row.id, String(row.generation), row.purpose, row.email, row.user_id || '', code))) {
        await tx.$executeRaw`update public.auth_email_challenges set attempts=attempts+1,state=case when attempts>=4 then 'locked' else state end where id=${row.id}::uuid`;
        await tx.$executeRaw`insert into public.auth_email_limits(key,kind,occurred_at) values(${this.digest('recipient', row.email)},'failure',${now})`;
        return { error: 'invalid' } as const;
      }
      const value = await apply(tx, row, now);
      await tx.$executeRaw`update public.auth_email_challenges set state=case when state='verified' then state else 'consumed' end,code_hash=null,
       payload=case when state='verified' then payload else '{}'::jsonb end where id=${row.id}::uuid`;
      return { value };
    }, { timeout: 10000 });
    if ('error' in result) throw result.error === 'limit' ? limit() : invalid();
    return result.value;
  }
  async ticket(tx: UserTx, row: Challenge, now: Date) {
    const ticket = randomBytes(48).toString('base64url');
    await tx.$executeRaw`update public.auth_email_challenges set state='verified',ticket_hash=${this.digest('ticket', row.id, ticket)},ticket_expires_at=${new Date(now.getTime()+300000)} where id=${row.id}::uuid`;
    return { ticket, ticketExpiresAt: new Date(now.getTime()+300000).toISOString() };
  }
  async useTicket<T>(proof: ChallengeProof, purpose: OtpPurpose, ticket: string, apply: (tx: UserTx, row: Challenge, now: Date) => Promise<T>) {
    return this.db.$transaction(async tx => {
      const row = await this.owned(tx, proof), now = await this.clock(tx);
      if (row.purpose !== purpose || row.state !== 'verified' || !row.ticket_expires_at || now >= row.ticket_expires_at || !this.equal(row.ticket_hash, this.digest('ticket', row.id, ticket))) throw invalid();
      const result = await apply(tx, row, now);
      await tx.$executeRaw`update public.auth_email_challenges set state='consumed',payload='{}',ticket_hash=null where id=${row.id}::uuid`;
      return result;
    });
  }
  async deliverNext(ownedChallengeId?: string) {
    if (!this.provider.available()) return false;
    const claimed = await this.db.$transaction(async tx => {
      const row = (await tx.$queryRaw<Challenge[]>`select * from public.auth_email_challenges where state='queued' and (${ownedChallengeId || null}::uuid is null or id=${ownedChallengeId || null}::uuid) order by created_at,id limit 1 for update skip locked`)[0];
      if (!row) return null;
      if(!this.payloadPresent(row)) {
        await tx.$executeRaw`update public.auth_email_challenges set state='failed',code_hash=null,error_code='OTP_RESTART_REQUIRED' where id=${row.id}::uuid`;
        return {discarded:true} as const;
      }
      const now = await this.clock(tx), code = randomInt(0, 1000000).toString().padStart(6, '0'), expires = new Date(now.getTime()+60000), messageId = randomUUID();
      await tx.$executeRaw`update public.auth_email_challenges set state='submitting',issued_at=${now},expires_at=${expires},resend_at=${expires},message_id=${messageId},
       code_hash=${this.digest('otp', row.id, String(row.generation), row.purpose, row.email, row.user_id || '', code)} where id=${row.id}::uuid`;
      return { row, code, expires, messageId };
    });
    if (!claimed) return false;
    if('discarded' in claimed)return true;
    const { row, code, expires, messageId } = claimed;
    if(await isBootstrappedReviewer(this.db,row.user_id,row.email)) {
      await this.db.$executeRaw`update public.auth_email_challenges set state='failed',code_hash=null,payload='{}',error_code='ACCOUNT_OPERATION_UNAVAILABLE' where id=${row.id}::uuid and generation=${row.generation} and state='submitting'`;
      return true;
    }
    const stillValid=(await this.db.$queryRaw<Array<{valid:boolean}>>`select clock_timestamp()<${expires} as valid`)[0].valid;
    if(!stillValid) {await this.db.$executeRaw`update public.auth_email_challenges set state='expired',code_hash=null where id=${row.id}::uuid and generation=${row.generation} and state='submitting'`;return true;}
    if(row.user_id){
      const subject=await this.db.user.findUnique({where:{id:row.user_id}});
      const emailBound=row.purpose==='LEGACY_EMAIL'?subject?.email===null:row.purpose==='CHANGE_EMAIL_NEW'?subject?.email===row.payload.oldEmail:subject?.email===row.email;
      if(!subject||subject.status!=='ACTIVE'||subject.passwordHash!==row.fingerprint||!emailBound){
        await this.db.$executeRaw`update public.auth_email_challenges set state='failed',delivery_state='failed',error_code='EMAIL_SUBJECT_CHANGED',code_hash=null where id=${row.id}::uuid and generation=${row.generation} and state='submitting'`;return true;
      }
    }
    // Decoy reset challenge follows the same worker/state timing, with no mail to unknown accounts.
    const suppressed=(await this.db.$queryRaw<Array<{exists:boolean}>>`select exists(select 1 from public.email_suppressions where email=${row.email}) as exists`)[0].exists;
    const started=performance.now();
    const outcome = suppressed ? {state:'suppressed',code:'EMAIL_SUPPRESSED'} : row.purpose === 'RESET' && !row.user_id ? { state: 'accepted',code:undefined } :
      await this.provider.send(row.email, otpTemplate(row.purpose, code, expires), messageId, true);
    await this.db.$executeRaw`update public.auth_email_challenges set delivery_state=${outcome.state},error_code=${outcome.code || null},state=${outcome.state === 'delivered' ? 'accepted' : outcome.state === 'suppressed' ? 'failed' : outcome.state}
     where id=${row.id}::uuid and generation=${row.generation} and state='submitting'`;
    if(process.env.NODE_ENV!=='test')console.log(JSON.stringify({event:'email_submit',category:'otp',purpose:row.purpose,messageId,state:outcome.state,durationMs:Math.round(performance.now()-started)}));
    return true;
  }
}

// Handled by Le Nguyen Quoc Hung
