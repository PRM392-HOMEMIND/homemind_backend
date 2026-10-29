import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { EmailChallengeService } from '../auth/email-challenge.service';
import { InfobipProvider } from './infobip.provider';
import { emailConfig } from './email.config';
import { notificationTemplate } from './email.templates';

type Delivery = { id: string; notification_id: string; user_id: string; email: string; message_id: string; attempts: number };
@Injectable()
export class EmailDeliveryService implements OnModuleInit, OnModuleDestroy {
  private readonly config = emailConfig();
  private timer?: NodeJS.Timeout; private work?: Promise<unknown>; private stopped = false; private ticks = 0;
  private readonly slots = new Map<number,Promise<unknown>>();
  constructor(private readonly db: DatabaseService, private readonly provider: InfobipProvider, private readonly challenges: EmailChallengeService) {}
  onModuleInit() {
    if (!this.provider.available()) return;
    this.timer = setInterval(() => {
      if(this.stopped)return;
      for(let slot=0;slot<this.config.concurrency;slot++)if(!this.slots.has(slot)){
        const task=this.challenges.deliverNext().then(otp=>otp || this.deliverNext()).catch(()=>undefined).finally(()=>this.slots.delete(slot));
        this.slots.set(slot,task);
      }
      if(++this.ticks%40===0&&!this.work)this.work=this.collectReport().then(()=>this.maintain()).catch(()=>undefined).finally(()=>{this.work=undefined;});
    }, 250); this.timer.unref();
  }
  async onModuleDestroy() { this.stopped = true; if (this.timer) clearInterval(this.timer); await Promise.allSettled([...this.slots.values(),this.work]); }
  async drain() {
    // Separate OTP capacity from normal notices. Bounded fan-out, not a global request lock.
    await Promise.all(Array.from({ length: this.config.concurrency }, () => this.challenges.deliverNext()));
    await Promise.all(Array.from({ length: this.config.concurrency }, () => this.deliverNext()));
    if (++this.ticks % 40 === 0) { await this.collectReport(); await this.maintain(); }
  }
  async deliverNext() {
    if (!this.provider.available()) return false;
    const row = await this.db.$transaction(async tx => {
      const claimed = (await tx.$queryRaw<Delivery[]>`select * from public.email_deliveries where state='queued' and available_at<=clock_timestamp()
        order by (snapshot->>'kind' like 'account.%') desc,available_at,id limit 1 for update skip locked`)[0];
      if (!claimed) return null;
      const messageId = claimed.message_id || randomUUID();
      await tx.$executeRaw`update public.email_deliveries set state='submitting',message_id=${messageId},attempts=attempts+1,lease_until=clock_timestamp()+interval '30 seconds',submitted_at=clock_timestamp() where id=${claimed.id}::uuid`;
      return { ...claimed, message_id: messageId };
    });
    if (!row) return false;
    let notice = await this.db.asUser(row.user_id, async tx => {
      const rows = await tx.$queryRaw<Array<{ kind: string; title: string; summary: string; detail: string; occurredAt: Date }>>`
        select n.kind,n.title,n.summary,coalesce(d.snapshot->>'detail',n.detail) as detail,n.occurred_at as "occurredAt" from public.in_app_notifications n
        join public.email_deliveries d on d.notification_id=n.id
        join public.users u on u.id=n.recipient_id where n.id=${row.notification_id}::uuid and d.id=${row.id}::uuid and u.status='ACTIVE'
        and (u.email=${row.email} and u.email_verified_at is not null or d.verified_old_destination and n.kind='account.security')
        and not exists(select 1 from public.email_suppressions where email=${row.email})`;
      return rows[0];
    });
    if(!notice) {
      // Account closure removes in-app access, but its minimal verified security
      // receipt still belongs to this recipient. No workspace payload is exposed.
      const security=await this.db.$queryRaw<Array<{kind:string;title:string;summary:string;detail:string;occurredAt:Date}>>`
        select snapshot->>'kind' as kind,snapshot->>'title' as title,snapshot->>'summary' as summary,snapshot->>'detail' as detail,
        (snapshot->>'occurredAt')::timestamptz as "occurredAt" from public.email_deliveries
        where id=${row.id}::uuid and user_id=${row.user_id}::uuid and verified_old_destination and snapshot->>'kind'='account.security'
        and not exists(select 1 from public.email_suppressions where email=${row.email})`;
      notice=security[0];
    }
    if (!notice) {
      await this.db.$executeRaw`update public.email_deliveries set state='ineligible',completed_at=clock_timestamp() where id=${row.id}::uuid`;
      return true;
    }
    let content;
    try { content = notificationTemplate(notice); } catch {
      await this.db.$executeRaw`update public.email_deliveries set state='unmapped',error_code='EMAIL_TEMPLATE_UNMAPPED' where id=${row.id}::uuid`; return true;
    }
    if (!content) { await this.db.$executeRaw`update public.email_deliveries set state='ineligible' where id=${row.id}::uuid`; return true; }
    const started=performance.now();
    const outcome = await this.provider.send(row.email, content, row.message_id, notice.kind.startsWith('account.'));
    const retry = outcome.retryable && row.attempts < 3;
    await this.db.$transaction(async tx => {
      await tx.$executeRaw`update public.email_deliveries set state=${retry ? 'queued' : outcome.state},message_id=${outcome.messageId},error_code=${outcome.code || null},
       available_at=clock_timestamp()+make_interval(secs=>${Math.min(300, 5 * 2 ** row.attempts) + Math.floor(Math.random()*3)}),lease_until=null,
       completed_at=case when ${['failed','delivered','suppressed'].includes(outcome.state) && !retry} then clock_timestamp() else null end where id=${row.id}::uuid`;
      if (outcome.state === 'suppressed') await tx.$executeRaw`insert into public.email_suppressions(email,reason) values(${row.email},${outcome.code || 'SUPPRESSED'}) on conflict(email) do nothing`;
    });
    if(process.env.NODE_ENV!=='test')console.log(JSON.stringify({event:'email_submit',category:'notification',kind:notice.kind,messageId:outcome.messageId,state:outcome.state,retry,durationMs:Math.round(performance.now()-started)}));
    return true;
  }
  async collectReport() {
    const row = await this.db.$transaction(async tx => {
      const result = (await tx.$queryRaw<Delivery[]>`select * from public.email_deliveries where state in('accepted','unknown') and message_id is not null
       and created_at>clock_timestamp()-interval '48 hours' and coalesce(report_checked_at,'epoch')<clock_timestamp()-interval '30 seconds'
       order by report_checked_at nulls first,id limit 1 for update skip locked`)[0];
      if (result) await tx.$executeRaw`update public.email_deliveries set report_checked_at=clock_timestamp() where id=${result.id}::uuid`;
      return result;
    });
    if (!row) {
      const challenge=await this.db.$transaction(async tx=>{
        const found=(await tx.$queryRaw<Array<{id:string;message_id:string}>>`select id,message_id from public.auth_email_challenges
          where delivery_state in('accepted','unknown') and message_id is not null and created_at>clock_timestamp()-interval '24 hours'
          and coalesce(report_checked_at,'epoch')<clock_timestamp()-interval '30 seconds' order by report_checked_at nulls first,id limit 1 for update skip locked`)[0];
        if(found)await tx.$executeRaw`update public.auth_email_challenges set report_checked_at=clock_timestamp() where id=${found.id}::uuid`;
        return found;
      });
      if(challenge){const report=await this.provider.report(challenge.message_id);if(report)await this.db.$executeRaw`update public.auth_email_challenges set delivery_state=${report.state},error_code=${report.code || null} where id=${challenge.id}::uuid and delivery_state in('accepted','unknown')`;}
      return;
    }
    const result = await this.provider.report(row.message_id);
    if (!result) return;
    await this.db.$transaction(async tx => {
      // Never regress a final delivery state due to duplicated/out-of-order reports.
      await tx.$executeRaw`update public.email_deliveries set state=${result.state},error_code=${result.code || null},completed_at=case when ${['delivered','failed','suppressed'].includes(result.state)} then clock_timestamp() else null end
       where id=${row.id}::uuid and state in('accepted','unknown')`;
      if (result.state === 'suppressed' || /HARD_BOUNCE|COMPLAINT|INVALID_DESTINATION/.test(result.code || '')) {
        await tx.$executeRaw`insert into public.email_suppressions(email,reason) values(${row.email},${result.code || 'SUPPRESSED'}) on conflict(email) do nothing`;
      }
    });
  }
  async maintain() {
    // A crash after submit cannot justify sending a duplicate. Resend is always explicit.
    await this.db.$executeRaw`update public.email_deliveries set state='unknown',lease_until=null where state='submitting' and lease_until<clock_timestamp()`;
    await this.db.$executeRaw`update public.auth_email_challenges set state='expired',code_hash=null,payload='{}',ticket_hash=null
      where state<>'consumed' and coalesce(ticket_expires_at,expires_at,created_at+interval '10 minutes')<clock_timestamp()-interval '10 minutes'`;
    await this.db.$executeRaw`delete from public.auth_email_limits where occurred_at<clock_timestamp()-interval '1 day'`;
    await this.db.$executeRaw`delete from public.auth_legacy_email_proofs where expires_at<clock_timestamp()-interval '1 day'`;
    await this.db.$executeRaw`delete from public.auth_email_challenges where created_at<clock_timestamp()-interval '1 day' and state in('consumed','expired','failed','locked')`;
    await this.db.$executeRaw`delete from public.email_deliveries where created_at<clock_timestamp()-interval '30 days' and state not in('queued','submitting')`;
  }
}
