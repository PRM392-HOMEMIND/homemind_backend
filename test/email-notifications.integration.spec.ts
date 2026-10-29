import { randomUUID } from 'node:crypto';
import { deleteFixtureUsers } from './support/delete-fixture-users';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { DatabaseService } from '../src/database/database.service';
import { EmailDeliveryService } from '../src/email/email-delivery.service';
import { EmailChallengeService } from '../src/auth/email-challenge.service';
import { notificationRegistry } from '../src/email/email.templates';
import { NotificationsService } from '../src/notifications/notifications.service';
import { SnapshotService } from '../src/snapshot/snapshot.service';
import { mockEmailAuth, registerVerified } from './support/email-auth-fixture';
import { requireDisposableDatabase } from './disposable-database';

describe.skipIf(process.env.RUN_DB_TESTS!=='1')('transactional new notification/email intents and bounded multi-worker delivery',()=>{
 const db=new DatabaseService(),owner=new PrismaClient({datasourceUrl:process.env.MIGRATION_DATABASE_URL});
 const auth=mockEmailAuth(db);
 const sent:any[]=[],users:string[]=[],workspaces:string[]=[];
 let nextOutcome:string|undefined;
 const provider:any={available:()=>true,send:vi.fn(async(to:string,content:any,messageId:string)=>{if(to===email){sent.push({to,content,messageId});if(nextOutcome){const state=nextOutcome;nextOutcome=undefined;return {state,messageId,code:'EMAIL_TEST_'+state,retryable:false};}}return {state:'accepted',messageId};}),report:vi.fn(async()=>null)};
 const notices=new NotificationsService(db,new SnapshotService(db),provider);
 const worker=new EmailDeliveryService(db,provider,new EmailChallengeService(db,provider));
 let user:string,email:string,ws:string;
 beforeAll(async()=>{
  requireDisposableDatabase();email='email-notice-'+randomUUID()+'@example.invalid';
  const session=await registerVerified(auth,{email,password:'Strong-test-password',displayName:'Kiểm thử email',workspaceType:'household',acceptedTerms:true,acceptedPrivacy:true});user=session.user.id;users.push(user);
  ws=(await owner.workspaceMember.findFirstOrThrow({where:{userId:user}})).workspaceId;workspaces.push(ws);
 });
 afterAll(async()=>{await deleteFixtureUsers(owner,users,workspaces);await Promise.all([owner.$disconnect(),db.$disconnect()]);});
 async function enqueue(kind:string,workspace:string|null=null,beforeMaterialize?:()=>Promise<unknown>){
  const key='email-test:'+randomUUID();
  // Other parallel suites run real workers with email disabled. Keep this
  // fixture's new outbox row private until the real SQL worker materializes it
  // under this suite's explicit mock-provider mode. Delivery remains concurrent.
  await owner.$transaction(async tx=>{
   await tx.$executeRaw`select public.notification_enqueue(${key},${user}::uuid,${workspace}::uuid,false,${kind},'Kho đã cập nhật','Đã thêm sữa','Sữa: thêm 2 hộp, ngăn mát. Tổng chi tháng ghi nhận: 20.000đ.','home',null,clock_timestamp())`;
   await beforeMaterialize?.();
   await tx.$queryRaw`select set_config('app.email_delivery_enabled','true',true)`;
   for(let i=0;i<50;i++){
    await tx.$queryRaw`select public.notification_deliver()`;
    const rows=await tx.$queryRaw<Array<{delivered:boolean}>>`select delivered_at is not null as delivered from public.notification_outbox where event_key=${key} and recipient_id=${user}::uuid`;
    if(rows[0]?.delivered)return;
   }
   throw Error('Owned email fixture materialization missing');
  });
  return key;
 }
 async function ownedDrain(){for(let i=0;i<50;i++){await notices.drain(false);const rows=await owner.$queryRaw<any[]>`select count(*)::int count from public.notification_outbox where recipient_id=${user}::uuid and delivered_at is null`;if(rows[0].count===0)return;}throw Error('owned outbox readiness missing');}
 async function mailDrain(){for(let i=0;i<100;i++){const rows=await owner.$queryRaw<any[]>`select count(*)::int count from public.email_deliveries where user_id=${user}::uuid and state='queued'`;if(!rows[0].count)return;await worker.deliverNext();}throw Error('owned email readiness missing');}
 it('materialization atomically creates only new intents; rollback/dedup/fetch/read do not send',async()=>{
  await owner.$transaction(async tx=>{await tx.$executeRaw`select public.notification_enqueue(${'rolled:'+randomUUID()},${user}::uuid,null,false,'profile.updated','Đã cập nhật','Hồ sơ mới','Đã lưu thay đổi hồ sơ.','profile',null,clock_timestamp())`;throw Error('rollback');}).catch(()=>undefined);
  const key=await enqueue('inventory.add');await ownedDrain();
  const intent=await owner.$queryRaw<any[]>`select d.id from public.email_deliveries d join public.in_app_notifications n on n.id=d.notification_id where n.event_key=${key}`;expect(intent).toHaveLength(1);
  await owner.$executeRaw`select public.notification_enqueue(${key},${user}::uuid,null,false,'inventory.add','Trùng','Trùng','Trùng','home',null,clock_timestamp())`;await ownedDrain();
  expect((await owner.$queryRaw<any[]>`select d.id from public.email_deliveries d join public.in_app_notifications n on n.id=d.notification_id where n.event_key=${key}`)).toHaveLength(1);
  const before=sent.length;await notices.list(user,null);const list=await notices.list(user,null);await notices.markRead(user,null,list.items[0].id);expect(sent).toHaveLength(before);
 });
 it('every actual registry kind receives an email except explicit login/logout events; codes never enter in-app',async()=>{
  for(const kind of Object.keys(notificationRegistry))await enqueue(kind);
  await ownedDrain();
  const rows=await owner.$queryRaw<any[]>`select n.kind,d.state from public.in_app_notifications n left join public.email_deliveries d on d.notification_id=n.id where n.recipient_id=${user}::uuid`;
  for(const [kind,category] of Object.entries(notificationRegistry)){const found=rows.find(r=>r.kind===kind);expect(found).toBeDefined();expect(found.state===null).toBe(category===null);}
  expect(rows.some(r=>r.kind.includes('OTP'))).toBe(false);
 });
 it('simultaneous workers send one owned intent once and use detailed escaped content',async()=>{
  await Promise.all(Array.from({length:4},()=>mailDrain()));
  const ids=sent.map(s=>s.messageId);expect(new Set(ids).size).toBe(ids.length);expect(sent.length).toBeGreaterThan(20);
  expect(sent.every(s=>s.to===email)).toBe(true);expect(sent[0].content.text).toContain('giờ Việt Nam');
 });
 it('keeps mock-email fixture eligible when an email-disabled worker runs during enqueue',async()=>{
  const other=new NotificationsService(db,new SnapshotService(db),{available:()=>false} as any);
  const key=await enqueue('profile.updated',null,()=>other.drain(false));
  const rows=await owner.$queryRaw<any[]>`select d.state from public.email_deliveries d join public.in_app_notifications n on n.id=d.notification_id where n.event_key=${key}`;
  expect(rows).toEqual([{state:'queued'}]);
  const before=sent.length;await mailDrain();expect(sent).toHaveLength(before+1);
 });
 it('rechecks email verification, recipient identity and workspace authorization before delivery',async()=>{
  const key=await enqueue('inventory.add',ws);await ownedDrain();
  await owner.user.update({where:{id:user},data:{emailVerifiedAt:null}});
  await mailDrain();const rows=await owner.$queryRaw<any[]>`select d.state from public.email_deliveries d join public.in_app_notifications n on n.id=d.notification_id where n.event_key=${key}`;expect(rows[0].state).toBe('ineligible');
  await owner.user.update({where:{id:user},data:{emailVerifiedAt:new Date()}});
 });
 it('unknown timeout is quarantined, crash lease becomes unknown, permanent failure does not roll back business',async()=>{
  nextOutcome='unknown';
  await enqueue('profile.updated');await ownedDrain();await mailDrain();
  const rows=await owner.$queryRaw<any[]>`select * from public.email_deliveries where user_id=${user}::uuid and state='unknown'`;expect(rows).toHaveLength(1);
  const id=rows[0].id;await owner.$executeRaw`update public.email_deliveries set state='submitting',lease_until=clock_timestamp()-interval '1 minute' where id=${id}::uuid`;await worker.maintain();
  expect((await owner.$queryRaw<any[]>`select state from public.email_deliveries where id=${id}::uuid`)[0].state).toBe('unknown');
  nextOutcome='failed';await enqueue('profile.updated');await ownedDrain();await mailDrain();
  expect((await owner.$queryRaw<any[]>`select count(*)::int count from public.email_deliveries where user_id=${user}::uuid and state='failed'`)[0].count).toBe(1);
 });
 it('delivered reports cannot regress on duplicate/out-of-order polling and do not create notifications',async()=>{
  await enqueue('profile.updated');await ownedDrain();await mailDrain();
  const row=(await owner.$queryRaw<any[]>`select id,message_id from public.email_deliveries where user_id=${user}::uuid and state='accepted' order by created_at desc limit 1`)[0];
  provider.report.mockImplementation(async(messageId:string)=>({state:'delivered',messageId,code:'DELIVERED'}));
  await owner.$executeRaw`update public.email_deliveries set report_checked_at=null where id=${row.id}::uuid`;
  for(let i=0;i<300;i++){await worker.collectReport();if((await owner.$queryRaw<any[]>`select state from public.email_deliveries where id=${row.id}::uuid`)[0].state==='delivered')break;}
  expect((await owner.$queryRaw<any[]>`select state from public.email_deliveries where id=${row.id}::uuid`)[0].state).toBe('delivered');
  const before=(await owner.$queryRaw<any[]>`select count(*)::int count from public.in_app_notifications where recipient_id=${user}::uuid`)[0].count;
  provider.report.mockImplementation(async(messageId:string)=>({state:'failed',messageId,code:'STALE_REPORT'}));await worker.collectReport();
  expect((await owner.$queryRaw<any[]>`select state from public.email_deliveries where id=${row.id}::uuid`)[0].state).toBe('delivered');
  expect((await owner.$queryRaw<any[]>`select count(*)::int count from public.in_app_notifications where recipient_id=${user}::uuid`)[0].count).toBe(before);
 });
 it('suppression survives worker restart and prevents another recipient submission',async()=>{
  nextOutcome='suppressed';await enqueue('profile.updated');await ownedDrain();await mailDrain();
  expect((await owner.$queryRaw<any[]>`select reason from public.email_suppressions where email=${email}`)).toHaveLength(1);
  const count=sent.length;await enqueue('profile.updated');await ownedDrain();
  const restarted=new EmailDeliveryService(db,provider,new EmailChallengeService(db,provider));
  for(let i=0;i<100;i++){await restarted.deliverNext();const rows=await owner.$queryRaw<any[]>`select count(*)::int count from public.email_deliveries where user_id=${user}::uuid and state='queued'`;if(!rows[0].count)break;}
  expect(sent).toHaveLength(count);await owner.$executeRaw`delete from public.email_suppressions where email=${email}`;
 });
});
