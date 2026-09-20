import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { DatabaseService } from '../src/database/database.service';
import { BillingService } from '../src/billing/billing.service';
import { sdkFixture } from './payos.fixture';
import { safeCheckoutUrl } from '../src/billing/payos.provider';
import { transferQr } from './vietqr.fixture';
import { requireDisposableDatabase } from './disposable-database';
import { NotificationsService } from '../src/notifications/notifications.service';
import { SearchService } from '../src/search/search.service';
import { SnapshotService } from '../src/snapshot/snapshot.service';

describe.skipIf(process.env.RUN_DB_TESTS!=='1')('billing: restricted real PostgreSQL and signed synthetic SDK transport',()=>{
 const db=new DatabaseService(),owner=new PrismaClient({datasourceUrl:process.env.MIGRATION_DATABASE_URL});
 let fixture:ReturnType<typeof sdkFixture>,billing:BillingService;
 const users:string[]=[],workspaces:string[]=[],channelIds:string[]=[];
 const unknownReferences:string[]=[];
 async function account(type='household') {
  const user=randomUUID();users.push(user);
  await db.user.create({data:{id:user,email:`billing+${user}@example.com`,passwordHash:'not-a-login-fixture'}});
  const rows=await db.asUser(user,tx=>tx.$queryRaw<Array<{id:string}>>`select public.provision_home(${user}::uuid,'Isolated billing',${type}) as id`);
  const ws=rows[0].id;workspaces.push(ws);return {user,ws};
 }
 async function order(a:{user:string;ws:string},price='personal-month-v2',key=randomUUID()) {return billing.create(a.user,a.ws,price,key);}
 async function grantCount(id:string) {const r=await owner.$queryRaw<Array<{n:bigint}>>`select count(*) as n from public.billing_grants where order_id=${id}::uuid`;return Number(r[0].n);}
 async function drainNotices(service:NotificationsService,scan=false){
  for(let batch=0;batch<32;batch++){
   const delivered=await service.drain(scan&&batch===0) as Array<{notification_deliver:number}>;
   expect(delivered[0].notification_deliver).toBeLessThanOrEqual(50);
   if(delivered[0].notification_deliver<50)return;
  }throw Error('Owned fixture backlog exceeded bounded delivery batches');
 }
 async function paid(a:{user:string;ws:string},price='personal-month-v2') {const p=await order(a,price);fixture.pay(Number(p.orderCode));await billing.webhook(await fixture.webhook(Number(p.orderCode)));return billing.read(a.user,a.ws,p.id);}
 // Private clock fixtures use only this disposable database/operator role.
 // They are not real provider payments or a public settlement bypass.
 async function historicalPayment(a:{user:string;ws:string},paidAt:Date) {
  const template=await order(a);await billing.cancel(a.user,a.ws,template.id);
  const id=randomUUID(),link=randomUUID().replaceAll('-','');
  const rows=await owner.$queryRaw<Array<{order_code:bigint}>>`
   insert into public.billing_orders(id,workspace_id,actor_id,idempotency_key,payload_hash,order_code,channel,
    price_id,price_snapshot,description,payment_link_id,status,created_at,expires_at,origin)
   values(${id}::uuid,${a.ws}::uuid,${a.user}::uuid,${randomUUID()}::uuid,'PRIVATE_TIME_FIXTURE',
    9000000000000+nextval('public.billing_order_sequence'),${fixture.provider.channel},'personal-month-v2',
    ${JSON.stringify(template.price)}::jsonb,'SYNTH0001',${link},'PENDING',
    ${new Date(paidAt.getTime()-60000)}::timestamptz,${new Date(paidAt.getTime()+3600000)}::timestamptz,'SIMULATED_TEST')
   returning order_code`;
  const snapshot={channel:fixture.provider.channel,id:link,orderCode:Number(rows[0].order_code),amount:29000,
   amountPaid:29000,amountRemaining:0,status:'PAID',transactions:[{reference:randomUUID(),amount:29000,
    description:'SYNTH0001',transactionDateTime:paidAt.toISOString()}]};
  const settle=async(at:Date)=> (await owner.$queryRaw<Array<{r:{fulfillment:string;reviewReason:string}}>>`
   select public.billing_system_verified_at('settle',${id}::uuid,${JSON.stringify(snapshot)}::jsonb,${at}::timestamptz) as r`)[0].r;
  const cancel=async(at:Date)=>owner.$queryRaw`select public.billing_system_verified_at('settle',${id}::uuid,
   ${JSON.stringify({...snapshot,status:'CANCELLED',amountPaid:0,amountRemaining:29000,transactions:[]})}::jsonb,${at}::timestamptz)`;
  return {id,paidAt,expiresAt:new Date(paidAt.getTime()+2592000000),settle,cancel};
 }
 beforeAll(async()=>{
  requireDisposableDatabase();
  await owner.$executeRaw`delete from public.billing_identity where not exists(select 1 from public.billing_orders)`;
  fixture=sdkFixture();await owner.$executeRaw`insert into public.billing_test_channels(channel) values(${fixture.provider.channel}) on conflict do nothing`;billing=new BillingService(db,fixture.provider);channelIds.push(fixture.provider.channel);
 });
 afterAll(async()=>{
  await owner.$transaction(async tx=>{
   await tx.$executeRaw`delete from public.billing_test_channels where channel=any(${channelIds}::text[])`;
   await tx.$executeRaw`delete from public.billing_transactions where order_id in(select id from public.billing_orders where workspace_id=any(${workspaces}::uuid[]))`;
   await tx.$executeRaw`delete from public.billing_grants where workspace_id=any(${workspaces}::uuid[])`;
   await tx.$executeRaw`delete from public.billing_webhook_inbox where order_code in(select order_code from public.billing_orders where workspace_id=any(${workspaces}::uuid[])) or reference=any(${unknownReferences}::text[])`;
   await tx.$executeRaw`delete from public.billing_orders where workspace_id=any(${workspaces}::uuid[])`;
   await tx.workspace.deleteMany({where:{id:{in:workspaces}}});await tx.user.deleteMany({where:{id:{in:users}}});
  });await Promise.all([db.$disconnect(),owner.$disconnect()]);
 });
 it('catalog prices come from approved immutable versions; versioned plans enforce workspace segments',async()=>{
  const plans=await billing.plans();expect(plans.plans.map(p=>p.amount)).toEqual([29000,59000,149000]);
  expect(plans.plans.every(p=>p.durationSeconds===2592000&&p.currency==='VND'&&p.autoRenew===false&&p.workspaceTypes.length===1)).toBe(true);
  for(const type of ['household','store']) expect((await order(await account(type),type==='store'?'micro_pos-month-v2':'personal-month-v2')).status).toBe('PENDING');
 });
 it('same idempotency key and parallel create produce one provider order; different price conflicts',async()=>{
  const a=await account(),key=randomUUID(),before=fixture.calls.create;
  const p=await Promise.all(Array.from({length:8},()=>order(a,'personal-month-v2',key)));
  expect(new Set(p.map(x=>x.id)).size).toBe(1);expect(fixture.calls.create-before).toBe(1);
  await expect(order(a,'family-month-v2',key)).rejects.toThrow('IDEMPOTENCY_CONFLICT');
 });
 it('observed HTTP200/code101 absent payment code creates once and stays unpaid',async()=>{
  fixture.setMissingResponse({status:200,code:'101',desc:'Mã thanh toán không tồn tại'});
  try {
   const a=await account(),key=randomUUID(),before=fixture.calls.create;
   const p=await order(a,'personal-month-v2',key);
   expect(p.status).toBe('PENDING');expect(p.financialState).toBe('UNPAID');
   expect((await order(a,'personal-month-v2',key)).id).toBe(p.id);
   expect(fixture.calls.create-before).toBe(1);expect(await grantCount(p.id)).toBe(0);
  } finally {fixture.setMissingResponse();}
 });
 it.each([
  [200,'101','Invalid API key'],[200,'101','Unknown merchant response'],
  [401,'101','Mã thanh toán không tồn tại'],[500,'101','Mã thanh toán không tồn tại'],
 ] as const)('unverified lookup HTTP%s/code%s does not authorize a POST (%s)',async(status,code,desc)=>{
  fixture.setMissingResponse({status,code,desc});
  try {
   const a=await account(),before=fixture.calls.create,p=await order(a);
   expect(p.status).toBe('CREATE_UNCERTAIN');expect(fixture.calls.create).toBe(before);
   expect(await grantCount(p.id)).toBe(0);
   expect(await owner.$queryRaw`select count(*)::int as n from public.billing_create_intents where order_id=${p.id}::uuid`).toEqual([{n:0}]);
  } finally {fixture.setMissingResponse();}
 });
 it('pending/checkout/return claims never grant; invalid signatures and mutated signed fields are rejected',async()=>{
  const a=await account(),p=await order(a);expect(await grantCount(p.id)).toBe(0);
  fixture.pay(Number(p.orderCode));const hook=await fixture.webhook(Number(p.orderCode));
  await expect(billing.webhook({...hook,signature:'0'.repeat(64)})).rejects.toThrow();
  await expect(billing.webhook({...hook,data:{...hook.data,amount:1}})).rejects.toThrow();
  await expect(billing.webhook(await fixture.webhook(Number(p.orderCode),{currency:'USD'}))).rejects.toThrow();
  await expect(billing.webhook(await fixture.webhook(Number(p.orderCode),{code:'01'}))).rejects.toThrow();
  expect(await grantCount(p.id)).toBe(0);
 });
 it('signed payment arriving before create response binds once and late response cannot regress it',async()=>{
  const a=await account();
  fixture.beforeCreateResponse(async code=>{fixture.pay(code);await billing.webhook(await fixture.webhook(code));});
  try {const p=await order(a);expect([p.status,p.financialState,p.fulfillment]).toEqual(['PAID','PAID','GRANTED']);expect(await grantCount(p.id)).toBe(1);}
  finally {fixture.beforeCreateResponse();}
 });
 it('active same-plan renewal is blocked and a full-price upgrade supersedes coverage immediately',async()=>{
  const a=await account(),p=await paid(a);
  await expect(order(a)).rejects.toThrow('PLAN_ALREADY_ACTIVE');
  const q=await paid(a,'family-month-v2');
  const grants=await owner.$queryRaw<Array<{id:string;starts_at:Date;expires_at:Date;effective_until:Date|null;superseded_by:string|null}>>`select id,starts_at,expires_at,effective_until,superseded_by from public.billing_grants where workspace_id=${a.ws}::uuid order by starts_at`;
  expect(grants).toHaveLength(2);expect(grants[0].effective_until?.toISOString()).toBe(grants[1].starts_at.toISOString());
  expect(grants[0].superseded_by).toBe(grants[1].id);expect(grants[0].expires_at>grants[0].effective_until!).toBe(true);
  expect(q.price).toMatchObject({amount:59000,durationSeconds:2592000,voiceLimit:100});
  await expect(order(a,'personal-month-v2')).rejects.toThrow('PLAN_DOWNGRADE_BLOCKED');
  const store=await account('store');await paid(store,'micro_pos-month-v2');
  expect((await billing.read(store.user,store.ws,null)).entitlement).toMatchObject({plan:'micro_pos',productLimit:500});
 });
 it('verified duplicate/concurrent webhook and reconcile grant exactly 2592000 seconds',async()=>{
  const a=await account(),p=await order(a);fixture.pay(Number(p.orderCode));const hook=await fixture.webhook(Number(p.orderCode));
  await Promise.all(Array.from({length:8},()=>billing.webhook(hook)));
  await billing.reconcile(a.user,a.ws,p.id);expect(await grantCount(p.id)).toBe(1);
  const r=await billing.read(a.user,a.ws,p.id);expect([r.financialState,r.fulfillment]).toEqual(['PAID','GRANTED']);
  const g=await owner.$queryRaw<Array<{valid:boolean}>>`select expires_at=starts_at+interval '2592000 seconds' as valid from public.billing_grants where order_id=${p.id}::uuid`;
  expect(g[0].valid).toBe(true);
 });
 it('unsigned outer success is irrelevant; signed data + signed provider lookup are authoritative',async()=>{
  const a=await account(),p=await order(a);fixture.pay(Number(p.orderCode));
  const hook=await fixture.webhook(Number(p.orderCode));await billing.webhook({...hook,success:false,code:'evil-client-hint'});
  expect(await grantCount(p.id)).toBe(1);
 });
 it('underpayment records financial facts without access; later full payment grants once',async()=>{
  const a=await account(),p=await order(a);fixture.pay(Number(p.orderCode),1000);
  await billing.webhook(await fixture.webhook(Number(p.orderCode)));let r=await billing.read(a.user,a.ws,p.id);
  expect([r.status,r.financialState,r.fulfillment]).toEqual(['UNDERPAID','PARTIAL','NONE']);
  expect(await grantCount(p.id)).toBe(0);
  const link=fixture.links.get(Number(p.orderCode))!;
  const first=structuredClone(link.transactions[0]);fixture.pay(Number(p.orderCode),28000);
  link.transactions.unshift(first);link.amountPaid=29000;link.amountRemaining=0;link.status='PAID';
  await billing.webhook(await fixture.webhook(Number(p.orderCode)));expect(await grantCount(p.id)).toBe(1);
 });
 it('overpayment remains paid with review, without false cancellation or access',async()=>{
  const a=await account(),p=await order(a);fixture.pay(Number(p.orderCode),30000);
  await billing.webhook(await fixture.webhook(Number(p.orderCode)));const r=await billing.read(a.user,a.ws,p.id);
  expect([r.financialState,r.fulfillment]).toEqual(['PAID','REVIEW']);expect(await grantCount(p.id)).toBe(0);
  await expect(billing.cancel(a.user,a.ws,p.id)).rejects.toThrow();
  await expect(order(a)).rejects.toThrow('PAYMENT_REQUIRES_REVIEW');
 });
 it('a definitively absent unpaid expired order terminates without another provider POST',async()=>{
  const a=await account();
  const prepared=await db.asUser(a.user,tx=>tx.$queryRaw<Array<{p:{id:string;orderCode:string}}>>`
   select public.billing_prepare(${a.ws}::uuid,'personal-month-v2',${randomUUID()}::uuid,'expired-test',1,${fixture.provider.channel}) as p`);
  const p=prepared[0].p;
  await owner.$executeRaw`update public.billing_orders set expires_at=now()-interval '1 second' where id=${p.id}::uuid`;
  const before=fixture.calls.create;await billing.sync(p.id);
  expect((await billing.read(a.user,a.ws,p.id)).status).toBe('EXPIRED');
  await billing.sync(p.id);expect(fixture.calls.create).toBe(before);expect(await grantCount(p.id)).toBe(0);
 });
 it('a provider-closed partial payment enters review and cannot initiate another charge',async()=>{
  const a=await account(),p=await order(a);fixture.pay(Number(p.orderCode),1000);
  fixture.links.get(Number(p.orderCode))!.status='EXPIRED';
  await billing.webhook(await fixture.webhook(Number(p.orderCode)));
  const r=await billing.read(a.user,a.ws,p.id);
  expect([r.status,r.financialState,r.fulfillment]).toEqual(['REVIEW','PARTIAL','REVIEW']);
  expect(await grantCount(p.id)).toBe(0);await expect(order(a)).rejects.toThrow('PAYMENT_REQUIRES_REVIEW');
 });
 it('lost create response survives service restart without a second order code or POST',async()=>{
  const a=await account();fixture.loseNextCreate();const p=await order(a);const before=fixture.calls.create;
  expect(p.status).toBe('CREATE_UNCERTAIN');fixture.pay(Number(p.orderCode));
  const restarted=new BillingService(db,fixture.provider);await restarted.webhook(await fixture.webhook(Number(p.orderCode)));
  await restarted.reconcile(a.user,a.ws,p.id);expect(fixture.calls.create).toBe(before);expect(await grantCount(p.id)).toBe(1);
 });
 it('recovers an unpaid lost create response before checkout without another provider POST',async()=>{
  const a=await account();fixture.loseNextCreate();const p=await order(a),before=fixture.calls.create;
  expect([p.status,p.checkoutUrl]).toEqual(['CREATE_UNCERTAIN',null]);
  const restarted=new BillingService(db,fixture.provider);
  const recovered=await restarted.reconcile(a.user,a.ws,p.id);
  expect(recovered.status).toBe('PENDING');
  expect(recovered.checkoutUrl).toBe('https://pay.payos.vn/web/'+fixture.links.get(Number(p.orderCode))!.id);
  expect(fixture.calls.create).toBe(before);expect(await grantCount(p.id)).toBe(0);
  expect(await owner.$queryRaw`select count(*)::int as n from public.billing_orders where workspace_id=${a.ws}::uuid`).toEqual([{n:1}]);
  fixture.pay(Number(p.orderCode));const hook=await fixture.webhook(Number(p.orderCode));
  await restarted.webhook(hook);await restarted.webhook(hook);expect(await grantCount(p.id)).toBe(1);
 });
 it('a lookup failure before create cannot authorize a later foreign link even on attempt two',async()=>{
  const a=await account();fixture.setUnavailable(true);let p:Awaited<ReturnType<typeof order>>;
  try {p=await order(a);}finally {fixture.setUnavailable(false);}
  expect(p.status).toBe('CREATE_UNCERTAIN');
  expect(await owner.$queryRaw`select count(*)::int as n from public.billing_create_intents where order_id=${p.id}::uuid`).toEqual([{n:0}]);
  const rows=await owner.$queryRaw<Array<{description:string}>>`select description from public.billing_orders where id=${p.id}::uuid`;
  await fixture.provider.create({orderCode:Number(p.orderCode),amount:29000,description:rows[0].description,returnUrl:'https://api.homemind.vn/v1/billing/payos/return',cancelUrl:'https://api.homemind.vn/v1/billing/payos/cancel'});
  const r=await billing.reconcile(a.user,a.ws,p.id);expect(r.status).toBe('REVIEW');expect(await grantCount(p.id)).toBe(0);
 });
 it('uncertain checkout recovery rejects changed provider identity, amount, and creation time',async()=>{
  for(const change of ['amount','id','orderCode','createdAt']) {
   const a=await account();fixture.loseNextCreate();const p=await order(a),before=fixture.calls.create;
   const link=fixture.links.get(Number(p.orderCode))!;
   if(change==='amount'){link.amount++;link.amountRemaining++;}
   if(change==='id')link.id='../foreign';
   if(change==='orderCode')link.orderCode++;
   if(change==='createdAt')link.createdAt='invalid-date';
   expect((await billing.reconcile(a.user,a.ws,p.id)).status).toBe('REVIEW');
   expect(fixture.calls.create).toBe(before);expect(await grantCount(p.id)).toBe(0);
  }
 });
 it('cancels a recovered unpaid checkout without creating another charge or granting access',async()=>{
  const a=await account();fixture.loseNextCreate();const p=await order(a),before=fixture.calls.create;
  const cancelled=await billing.cancel(a.user,a.ws,p.id);
  expect(cancelled.status).toBe('CANCELLED');expect(fixture.calls.create).toBe(before);
  expect(fixture.calls.cancel).toBeGreaterThan(0);expect(await grantCount(p.id)).toBe(0);
 });
 it.each(['CANCELLED','EXPIRED'] as const)('acknowledges signed terminal %s without a duplicate provider cancellation',async(status)=>{
  const a=await account(),p=await order(a);fixture.links.get(Number(p.orderCode))!.status=status;
  const before=fixture.calls.cancel;fixture.rejectDuplicateCancel(true);
  try {
   expect((await billing.cancel(a.user,a.ws,p.id)).status).toBe(status);
   expect(fixture.calls.cancel).toBe(before);expect(await grantCount(p.id)).toBe(0);
  } finally {fixture.rejectDuplicateCancel(false);}
 });
 it.each([[0,0],[1000,29000],[29000,1000],[0,30000]])('quarantines signed contradictory paid%s remaining%s before provider mutation',async(paid,remaining)=>{
  const a=await account(),p=await order(a),link=fixture.links.get(Number(p.orderCode))!;
  link.amountPaid=paid;link.amountRemaining=remaining;
  const before=fixture.calls.cancel;
  await expect(fixture.provider.get(Number(p.orderCode))).rejects.toThrow('PROVIDER_IDENTITY_CONFLICT');
  await expect(billing.cancel(a.user,a.ws,p.id)).rejects.toThrow();
  expect((await billing.read(a.user,a.ws,p.id)).status).toBe('REVIEW');
  expect(fixture.calls.cancel).toBe(before);expect(link.status).toBe('PENDING');expect(await grantCount(p.id)).toBe(0);
 });
 it('durably cancels a never-created order even when a worker already holds its lease',async()=>{
  const a=await account();
  const rows=await db.asUser(a.user,tx=>tx.$queryRaw<Array<{p:{id:string}}>>`
   select public.billing_prepare(${a.ws}::uuid,'personal-month-v2',${randomUUID()}::uuid,'cancel-before-create',1,${fixture.provider.channel}) as p`);
  const id=rows[0].p.id,before=fixture.calls.create;
  const claim=await billing.system<{lease_id:string}>('claim',id,{});
  expect((await billing.cancel(a.user,a.ws,id)).status).toBe('CANCELLED');
  await expect(billing.system('begin_create',id,{leaseId:claim.lease_id})).rejects.toThrow('PAYMENT_CANCEL_PENDING');
  const restarted=new BillingService(db,fixture.provider);await restarted.sync(id);await restarted.sync(null);
  expect((await billing.read(a.user,a.ws,id)).status).toBe('CANCELLED');
  expect(fixture.calls.create).toBe(before);expect(await grantCount(id)).toBe(0);
 });
 it('absent uncertain create retains cancellation across restart and forbids another POST',async()=>{
  const a=await account();fixture.rejectNextCreate(500);const p=await order(a),before=fixture.calls.create;
  expect(p.status).toBe('CREATE_UNCERTAIN');
  await expect(billing.cancel(a.user,a.ws,p.id)).rejects.toThrow();
  const restarted=new BillingService(db,fixture.provider);await expect(restarted.sync(p.id)).rejects.toThrow();
  expect(await owner.$queryRaw`select count(*)::int as n from public.billing_cancel_requests where order_id=${p.id}::uuid`).toEqual([{n:1}]);
  expect(fixture.calls.create).toBe(before);expect(await grantCount(p.id)).toBe(0);
 });
 it('unavailable cancel lookup is not successful and a worker later cancels without a new create',async()=>{
  const a=await account();fixture.loseNextCreate();const p=await order(a),before=fixture.calls.create;
  fixture.setUnavailable(true);
  try {await expect(billing.cancel(a.user,a.ws,p.id)).rejects.toThrow();}
  finally {fixture.setUnavailable(false);}
  await new BillingService(db,fixture.provider).sync(p.id);
  expect((await billing.read(a.user,a.ws,p.id)).status).toBe('CANCELLED');
  expect(fixture.calls.create).toBe(before);expect(await grantCount(p.id)).toBe(0);
 });
 it('cancellation racing an authorized in-flight create stays pending until provider cancellation is durable',async()=>{
  const a=await account();let pending=false;
  fixture.beforeCreateResponse(async code=>{
   const rows=await owner.$queryRaw<Array<{id:string}>>`select id from public.billing_orders where order_code=${BigInt(code)} and workspace_id=${a.ws}::uuid`;
   await expect(billing.cancel(a.user,a.ws,rows[0].id)).rejects.toThrow();pending=true;
  });
  let p:Awaited<ReturnType<typeof order>>;
  try {p=await order(a);}finally {fixture.beforeCreateResponse();}
  expect(pending).toBe(true);const before=fixture.calls.create;
  await new BillingService(db,fixture.provider).sync(p.id);
  expect((await billing.read(a.user,a.ws,p.id)).status).toBe('CANCELLED');expect(fixture.calls.create).toBe(before);
 });
 it('cancellation cannot discard partial payment or mutate protected intent storage directly',async()=>{
  const a=await account(),p=await order(a);fixture.pay(Number(p.orderCode),1000);
  await billing.webhook(await fixture.webhook(Number(p.orderCode)));
  await expect(billing.cancel(a.user,a.ws,p.id)).rejects.toThrow('PAYMENT_HAS_FUNDS');
  expect((await billing.read(a.user,a.ws,p.id)).financialState).toBe('PARTIAL');expect(await grantCount(p.id)).toBe(0);
  await expect(db.$executeRaw`insert into public.billing_cancel_requests(order_id) values(${p.id}::uuid)`).rejects.toThrow();
 });
 it('contradictory signed zero amount with positive transactions enters review without provider cancellation',async()=>{
  const a=await account(),p=await order(a);fixture.pay(Number(p.orderCode),1000);
  const link=fixture.links.get(Number(p.orderCode))!;link.amountPaid=0;link.amountRemaining=link.amount;link.status='PENDING';
  const before=fixture.calls.cancel;
  await expect(billing.cancel(a.user,a.ws,p.id)).rejects.toThrow();
  const result=await billing.read(a.user,a.ws,p.id);
  expect([result.status,result.financialState,result.fulfillment]).toEqual(['REVIEW','REVIEW','REVIEW']);
  expect(link.transactions[0].amount).toBe(1000);expect(link.status).toBe('PENDING');
  expect(fixture.calls.cancel).toBe(before);expect(await grantCount(p.id)).toBe(0);
  await new BillingService(db,fixture.provider).sync(p.id);expect(fixture.calls.cancel).toBe(before);
 });
 it('a pre-existing foreign provider link is quarantined even at the same price',async()=>{
  const a=await account();const prepared=await db.asUser(a.user,tx=>tx.$queryRaw<Array<{p:{id:string;orderCode:string}}>>`
   select public.billing_prepare(${a.ws}::uuid,'personal-month-v2',${randomUUID()}::uuid,'foreign-test',1,${fixture.provider.channel}) as p`);
  const p=prepared[0].p;
  await fixture.provider.create({orderCode:Number(p.orderCode),amount:29000,description:'FOREIGN01',returnUrl:'https://api.homemind.vn/v1/billing/payos/return',cancelUrl:'https://api.homemind.vn/v1/billing/payos/cancel'});
  await billing.sync(p.id);expect((await billing.read(a.user,a.ws,p.id)).status).toBe('REVIEW');expect(await grantCount(p.id)).toBe(0);
 });
 it('a duplicate POST racing after the absent lookup cannot adopt the foreign link',async()=>{
  const a=await account(),get=fixture.provider.get.bind(fixture.provider);let armed=true;
  fixture.provider.get=async code=>{const result=await get(code);if(armed&&!result){armed=false;
   await fixture.provider.create({orderCode:code,amount:29000,description:'FOREIGN01',returnUrl:'https://api.homemind.vn/v1/billing/payos/return',cancelUrl:'https://api.homemind.vn/v1/billing/payos/cancel'});
   return null;
  }return result;};
  try {
   const p=await order(a),before=fixture.calls.create;
   expect({status:p.status,checkoutUrl:p.checkoutUrl}).toEqual({status:'REVIEW',checkoutUrl:null});
   const r=await billing.reconcile(a.user,a.ws,p.id);
   expect({status:r.status,checkoutUrl:r.checkoutUrl}).toEqual({status:'REVIEW',checkoutUrl:null});
   expect(fixture.calls.create).toBe(before);expect(await grantCount(p.id)).toBe(0);
  }finally {fixture.provider.get=get;}
 });
 it('definitive HTTP and provider-envelope create rejections enter review without retry',async()=>{
  for(const status of [400,401,403,409,422,200]) {
   const a=await account(),before=fixture.calls.create;fixture.rejectNextCreate(status);
   const p=await order(a);
   expect({status:p.status,checkoutUrl:p.checkoutUrl}).toEqual({status:'REVIEW',checkoutUrl:null});
   await billing.reconcile(a.user,a.ws,p.id);
   expect(fixture.calls.create-before).toBe(1);expect(await grantCount(p.id)).toBe(0);
  }
 });
 it('retryable create statuses retain uncertainty and do not replay the POST inside the SDK',async()=>{
  for(const status of [408,429,500,503]) {
   const a=await account(),before=fixture.calls.create;fixture.rejectNextCreate(status);
   const p=await order(a);
   expect({status:p.status,checkoutUrl:p.checkoutUrl}).toEqual({status:'CREATE_UNCERTAIN',checkoutUrl:null});
   expect(fixture.calls.create-before).toBe(1);expect(await grantCount(p.id)).toBe(0);
  }
 });
 it('provider transaction reference cannot pay two workspaces, including a concurrency race',async()=>{
  const a=await account(),b=await account(),p=await order(a),q=await order(b),reference=randomUUID();
  fixture.pay(Number(p.orderCode),29000,reference);fixture.pay(Number(q.orderCode),29000,reference);
  await Promise.all([billing.webhook(await fixture.webhook(Number(p.orderCode))),billing.webhook(await fixture.webhook(Number(q.orderCode)))]);
  expect((await grantCount(p.id))+(await grantCount(q.id))).toBe(1);
  const results=await Promise.all([billing.read(a.user,a.ws,p.id),billing.read(b.user,b.ws,q.id)]);
  expect(results.filter(r=>r.fulfillment==='REVIEW')).toHaveLength(1);
 });
 it('same plan cannot reset quota and new higher-plan coverage is never scheduled after old expiry',async()=>{
  const a=await account(),first=await paid(a);
  await expect(paid(a)).rejects.toThrow('PLAN_ALREADY_ACTIVE');
  const upgraded=await paid(a,'family-month-v2');
  const grants=await owner.$queryRaw<Array<{plan:string;starts_at:Date;expires_at:Date}>>`select plan,starts_at,expires_at from public.billing_grants where workspace_id=${a.ws}::uuid order by starts_at`;
  expect(grants.map(g=>g.plan)).toEqual(['personal','family']);
  expect(grants[1].starts_at<grants[0].expires_at).toBe(true);
  expect(await grantCount(first.id)).toBe(1);expect(await grantCount(upgraded.id)).toBe(1);
  await expect(order(a,'micro_pos-month-v2')).rejects.toThrow('PLAN_SEGMENT_MISMATCH');
 });
 it('unchanged free and paid entitlement reads do not wait on workspace write locks',async()=>{
  for(const plan of ['free','personal']) {
   const a=await account();if(plan==='personal')await paid(a);
   let unlock!:()=>void,locked!:()=>void;
   const release=new Promise<void>(resolve=>{unlock=resolve;}),ready=new Promise<void>(resolve=>{locked=resolve;});
   const holder=owner.$transaction(async tx=>{await tx.$queryRaw`select id from public.workspaces where id=${a.ws}::uuid for update`;locked();await release;},{timeout:10000});
   try {
    await ready;
    const read=await db.asUser(a.user,async tx=>{
     await tx.$executeRawUnsafe("set local statement_timeout='1500ms'");
     return tx.$queryRaw<Array<{p:{plan:string;changed:boolean}}>>`select public.billing_effective(${a.ws}::uuid) as p`;
    });
    expect(read[0].p).toMatchObject({plan,changed:false});
   } finally {unlock();await holder;}
  }
 });
 it('lazy expiry returns free without deleting over-quota inventory; direct SQL races enforce quota',async()=>{
  const a=await account();await paid(a);
  const snapshots=new SnapshotService(db);expect((await snapshots.get(a.user,a.ws)).home.plan).toBe('personal');
  for(let i=0;i<31;i++) await db.operation(a.user,a.ws,randomUUID(),'inventory.add',{productName:`Expiry fixture ${i}`,quantity:1,unit:'box'});
  await owner.$executeRaw`update public.billing_grants set starts_at=now()-interval '2 months',expires_at=now()-interval '1 month' where workspace_id=${a.ws}::uuid`;
  const e=await db.asUser(a.user,tx=>tx.$queryRaw<Array<{p:{plan:string;productLimit:number}}>>`select public.billing_effective(${a.ws}::uuid) as p`);
  expect(e[0].p.plan).toBe('free');expect(e[0].p.productLimit).toBe(30);
  expect((await snapshots.get(a.user,a.ws)).home.plan).toBe('free');
  await expect(db.operation(a.user,a.ws,randomUUID(),'inventory.add',{productName:'Must not add',quantity:1,unit:'box'})).rejects.toMatchObject({status:402,response:{code:'PLAN_LIMIT',details:{plan:'free',limit:30,count:31}}});
  await db.operation(a.user,a.ws,randomUUID(),'inventory.add',{productName:'Expiry fixture 0',quantity:1,unit:'box'});
  expect(await owner.product.count({where:{workspaceId:a.ws}})).toBe(31);
  const b=await account();for(let i=0;i<29;i++) await db.operation(b.user,b.ws,randomUUID(),'inventory.add',{productName:`Race ${i}`,quantity:1,unit:'box'});
  const results=await Promise.allSettled([0,1,2].map(i=>db.operation(b.user,b.ws,randomUUID(),'inventory.add',{productName:`Last ${i}`,quantity:1,unit:'box'})));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await owner.product.count({where:{workspaceId:b.ws}})).toBe(30);
 });
 it('existing manual entitlements cannot be converted or expired by billing',async()=>{
  const a=await account();await owner.$executeRaw`update public.workspace_entitlements set plan='micro_pos',product_limit=500,source='legacy_manual' where workspace_id=${a.ws}::uuid`;
  await expect(order(a)).rejects.toThrow('MANUAL_PLAN_REQUIRES_REVIEW');
  const r=await billing.read(a.user,a.ws,null);expect(r.entitlement).toMatchObject({plan:'micro_pos',productLimit:500,source:'legacy_manual'});
 });
 it('quota recovery commits effective expiry when the rejected mutation first discovers it',async()=>{
  const a=await account();await paid(a);
  for(let i=0;i<31;i++)await db.operation(a.user,a.ws,randomUUID(),'inventory.add',{productName:`Unrefreshed expiry ${i}`,quantity:1,unit:'box'});
  await owner.$executeRaw`update public.billing_grants set starts_at=now()-interval '2 months',expires_at=now()-interval '1 month' where workspace_id=${a.ws}::uuid`;
  // No snapshot/billing read between expiry and rejection: the first refresh rolls back.
  expect(await owner.workspaceEntitlement.findUnique({where:{workspaceId:a.ws}})).toMatchObject({plan:'personal',productLimit:null});
  const key=randomUUID();
  await expect(db.operation(a.user,a.ws,key,'inventory.add',{productName:'Rejected expired plan',quantity:1,unit:'box'})).rejects.toMatchObject({status:402,response:{code:'PLAN_LIMIT',details:{plan:'free',limit:30,count:31}}});
  expect(await owner.workspaceEntitlement.findUnique({where:{workspaceId:a.ws}})).toMatchObject({plan:'free',productLimit:30});
  expect(await owner.product.count({where:{workspaceId:a.ws}})).toBe(31);
  expect(await owner.idempotencyOperation.count({where:{workspaceId:a.ws,idempotencyKey:key}})).toBe(0);
 });
 it('membership loss/archive/disabled actor retain payment but hold fulfillment for review',async()=>{
  for(const condition of ['membership','archive','disabled','manual']) {
   const a=await account(),p=await order(a);fixture.pay(Number(p.orderCode));
   if(condition==='membership') await owner.workspaceMember.updateMany({where:{workspaceId:a.ws},data:{role:'member'}});
   if(condition==='archive') await owner.workspace.update({where:{id:a.ws},data:{archivedAt:new Date()}});
   if(condition==='disabled') await owner.user.update({where:{id:a.user},data:{status:'DISABLED'}});
   if(condition==='manual') await owner.$executeRaw`update public.workspace_entitlements set source='legacy_manual' where workspace_id=${a.ws}::uuid`;
   await billing.webhook(await fixture.webhook(Number(p.orderCode)));
   const r=await owner.$queryRaw<Array<{financial_state:string;fulfillment:string}>>`select financial_state,fulfillment from public.billing_orders where id=${p.id}::uuid`;
   expect(r[0]).toEqual({financial_state:'PAID',fulfillment:'REVIEW'});expect(await grantCount(p.id)).toBe(0);
  }
 });
 it('late payment remains paid/review; unpaid cancellation never grants; stale status cannot reverse paid',async()=>{
  const a=await account(),p=await order(a);await owner.$executeRaw`update public.billing_orders set expires_at=now()-interval '1 minute' where id=${p.id}::uuid`;
  fixture.pay(Number(p.orderCode));await billing.webhook(await fixture.webhook(Number(p.orderCode)));expect((await billing.read(a.user,a.ws,p.id)).fulfillment).toBe('REVIEW');
  const b=await account(),q=await order(b);const cancelled=await billing.cancel(b.user,b.ws,q.id);expect(cancelled.status).toBe('CANCELLED');expect(await grantCount(q.id)).toBe(0);
  const c=await account(),r=await paid(c);const link=fixture.links.get(Number(r.orderCode))!;link.status='CANCELLED';link.amountPaid=0;link.transactions=[];
  await billing.system('settle',r.id,link);expect((await billing.read(c.user,c.ws,r.id)).fulfillment).toBe('GRANTED');
 });
 it('cross-workspace/non-owner reads fail; runtime cannot directly modify billing or grants',async()=>{
  const a=await account(),b=await account(),p=await order(a);
  await expect(billing.read(b.user,a.ws,p.id)).rejects.toThrow('FORBIDDEN');
  await expect(billing.read(a.user,b.ws,p.id)).rejects.toThrow('FORBIDDEN');
  await expect(db.$executeRaw`update public.workspace_entitlements set plan='family' where workspace_id=${a.ws}::uuid`).rejects.toThrow();
  await expect(db.$executeRawUnsafe('insert into public.billing_grants default values')).rejects.toThrow();
  await expect(owner.$executeRaw`update public.billing_prices set amount=1 where id='personal-month-v2'`).rejects.toThrow('PRICE_VERSION_IMMUTABLE');
  await expect(owner.$executeRaw`update public.billing_orders set price_snapshot='{}'::jsonb where id=${p.id}::uuid`).rejects.toThrow('ORDER_TERMS_IMMUTABLE');
 });
 it('unknown signed webhook is durably quarantined; transient provider failures never create grants',async()=>{
  const a=await account(),p=await order(a);fixture.pay(Number(p.orderCode));fixture.setUnavailable(true);
  await expect(billing.webhook(await fixture.webhook(Number(p.orderCode)))).rejects.toThrow();fixture.setUnavailable(false);
  expect(await grantCount(p.id)).toBe(0);await billing.reconcile(a.user,a.ws,p.id);expect(await grantCount(p.id)).toBe(1);
  const data={orderCode:8000000000999,amount:1000,description:'UNKNOWN01',accountNumber:'000000000',reference:randomUUID(),transactionDateTime:new Date().toISOString(),currency:'VND',paymentLinkId:randomUUID(),code:'00',desc:'success'};
  unknownReferences.push(data.reference);
  expect(await billing.webhook({data,signature:await fixture.sign(data),success:true,code:'00',desc:'success'})).toEqual({code:'00',desc:'Accepted'});
 });
 it('checkout URL cannot be an arbitrary redirect, HTTP, userinfo, port or foreign host',()=>{
  for(const url of ['http://pay.payos.vn/web/a','https://pay.payos.vn.evil.test/a','https://evil.test/a','https://user@pay.payos.vn/a','https://pay.payos.vn:444/a','javascript:alert(1)']) expect(()=>safeCheckoutUrl(url)).toThrow();
  expect(safeCheckoutUrl('https://pay.payos.vn/web/a')).toBe('https://pay.payos.vn/web/a');
 });
 it('segment, same plan, downgrade and one workspace pending intent fail before provider POST',async()=>{
  const a=await account(),store=await account('store'),before=fixture.calls.create;
  await expect(order(a,'micro_pos-month-v2')).rejects.toThrow('PLAN_SEGMENT_MISMATCH');
  await expect(order(store,'family-month-v2')).rejects.toThrow('PLAN_SEGMENT_MISMATCH');
  expect(fixture.calls.create).toBe(before);
  const first=await order(a);
  await expect(order(a)).rejects.toThrow('PLAN_CHANGE_PENDING');
  await billing.cancel(a.user,a.ws,first.id);
  expect((await order(a,'family-month-v2')).status).toBe('PENDING');
 });
 it('unknown and inactive prices, initial non-owner and archived workspace reject before provider create',async()=>{
  const a=await account(),member=await account(),archived=await account(),before=fixture.calls.create;
  await expect(order(a,'unknown-owned-'+randomUUID())).rejects.toThrow('PRICE_NOT_AVAILABLE');
  await expect(order(a,'personal-month-v1')).rejects.toThrow('PRICE_NOT_AVAILABLE');
  await owner.workspaceMember.create({data:{workspaceId:a.ws,userId:member.user,role:'member'}});
  await expect(billing.create(member.user,a.ws,'personal-month-v2',randomUUID())).rejects.toThrow('FORBIDDEN');
  await owner.workspace.update({where:{id:archived.ws},data:{archivedAt:new Date()}});
  await expect(order(archived)).rejects.toThrow();
  expect(fixture.calls.create).toBe(before);
  expect(await owner.$queryRaw<Array<{n:bigint}>>`select count(*) as n from public.billing_orders where workspace_id=any(${[a.ws,archived.ws]}::uuid[])`).toEqual([{n:0n}]);
 });
 it('QR source remains signed provider create metadata, read/history survive service restart',async()=>{
  const a=await account(),p=await order(a),restarted=new BillingService(db,fixture.provider);
  expect(p.origin).toBe('SIMULATED_TEST');
  expect(p.qr).toMatchObject({payload:transferQr(29000,fixture.descriptions.get(Number(p.orderCode))!),amount:29000,description:fixture.descriptions.get(Number(p.orderCode))});
  expect((await restarted.read(a.user,a.ws,p.id)).qr).toEqual(p.qr);
  const history=(await restarted.read(a.user,a.ws,null)).payments as Array<Record<string,unknown>>;
  const stored=await restarted.read(a.user,a.ws,p.id) as Record<string,unknown>;
  expect(history.map(({serverNow,...facts})=>facts)).toEqual([(({serverNow,...facts})=>facts)(stored)]);
  expect(Math.abs(Date.now()-Date.parse(stored.serverNow as string))).toBeLessThan(5000);
 });
 it('canonical signed memo/QR persists, pays once and cannot be replaced after attachment',async()=>{
  fixture.setMemoPrefix('CSYNTHETIC1 ');
  try {
   const a=await account(),p=await order(a),canonical=fixture.descriptions.get(Number(p.orderCode))!;
   expect(p.qr).toMatchObject({description:canonical,payload:transferQr(29000,canonical)});
   const row=await owner.$queryRaw<Array<{description:string;provider_description:string}>>`select description,provider_description from public.billing_orders where id=${p.id}::uuid`;
   expect(canonical).toBe('CSYNTHETIC1 '+row[0].description);expect(row[0].provider_description).toBe(canonical);
   await expect(owner.$executeRaw`update public.billing_orders set provider_description=description where id=${p.id}::uuid`).rejects.toThrow('PROVIDER_MEMO_IMMUTABLE');
   fixture.pay(Number(p.orderCode));const hook=await fixture.webhook(Number(p.orderCode));
   await billing.webhook(hook);await new BillingService(db,fixture.provider).webhook(hook);
   expect(await grantCount(p.id)).toBe(1);
   expect(await billing.read(a.user,a.ws,p.id)).toMatchObject({financialState:'PAID',fulfillment:'GRANTED'});
  } finally {fixture.setMemoPrefix();}
 });
 it('lost prefixed create recovers owned link and binds only a verified matching payment memo',async()=>{
  fixture.setMemoPrefix('CSYNTHETIC1 ');fixture.loseNextCreate();
  try {
   const a=await account(),p=await order(a),before=fixture.calls.create;
   const r=await new BillingService(db,fixture.provider).reconcile(a.user,a.ws,p.id);
   expect(r.status).toBe('PENDING');expect(fixture.calls.create).toBe(before);
   expect(await grantCount(p.id)).toBe(0);fixture.pay(Number(p.orderCode));
   await billing.webhook(await fixture.webhook(Number(p.orderCode)));
   expect(await grantCount(p.id)).toBe(1);
  } finally {fixture.setMemoPrefix();}
 });
 it('signed transaction with a different canonical memo stays in review without a grant',async()=>{
  fixture.setMemoPrefix('CSYNTHETIC1 ');
  try {
   const a=await account(),p=await order(a);fixture.pay(Number(p.orderCode));
   fixture.links.get(Number(p.orderCode))!.transactions[0].description='FOREIGN MEMO';
   await billing.webhook(await fixture.webhook(Number(p.orderCode)));
   expect(await billing.read(a.user,a.ws,p.id)).toMatchObject({fulfillment:'REVIEW',reviewReason:'PROVIDER_IDENTITY_CONFLICT'});
   expect(await grantCount(p.id)).toBe(0);
  } finally {fixture.setMemoPrefix();}
 });
 it('verified paidAt starts exact 30days; expiry boundary returns Free without read-driven extension',async()=>{
  const a=await account(),p=await paid(a);
  const g=await owner.$queryRaw<Array<{starts_at:Date;expires_at:Date}>>`select starts_at,expires_at from public.billing_grants where order_id=${p.id}::uuid`;
  expect(g[0].starts_at.toISOString()).toBe(new Date(String(p.paidAt)).toISOString());
  expect(g[0].expires_at.getTime()-g[0].starts_at.getTime()).toBe(2592000000);
  const before=new Date(g[0].expires_at.getTime()-1000),at=g[0].expires_at;
  const one=await owner.$queryRaw<Array<{e:{plan:string}}>>`select public.billing_refresh_at(${a.ws}::uuid,${before}::timestamptz) as e`;
  expect(one[0].e.plan).toBe('personal');
  const exact=await owner.$queryRaw<Array<{e:{plan:string}}>>`select public.billing_refresh_at(${a.ws}::uuid,${at}::timestamptz) as e`;
  expect(exact[0].e.plan).toBe('free');
  const period=await owner.$queryRaw<Array<{p:{starts_at:string;usage_limit:number}}>>`select to_jsonb(public.assistant_period_at(${a.ws}::uuid,${at}::timestamptz)) as p`;
  expect(new Date(period[0].p.starts_at).toISOString()).toBe(at.toISOString());expect(period[0].p.usage_limit).toBe(15);
 });
 it('upgrade starts new unused quota but an already admitted turn charges only its old period',async()=>{
  const a=await account();await paid(a);
  const reserved=await db.asUser(a.user,tx=>tx.$queryRaw<Array<{r:{reservationId:string;leaseId:string;quota:{periodId:string}}}>>`select public.assistant_quota_admit(${a.ws}::uuid,${randomUUID()}::uuid,'owned-upgrade-turn') as r`);
  const r=reserved[0].r;await paid(a,'family-month-v2');
  await db.asUser(a.user,tx=>tx.$queryRaw`select public.assistant_quota_finish(${r.reservationId}::uuid,${r.leaseId}::uuid,${JSON.stringify({schemaVersion:'1.0',kind:'unknown',turnId:randomUUID()})}::jsonb)`);
  const current=await db.asUser(a.user,tx=>tx.$queryRaw<Array<{q:{periodId:string;used:number;total:number}}>>`select public.assistant_quota_get(${a.ws}::uuid) as q`);
  expect(current[0].q).toMatchObject({used:0,total:100});expect(current[0].q.periodId).not.toBe(r.quota.periodId);
  expect(await owner.$queryRaw`select used from public.assistant_quota_periods where id=${r.quota.periodId}::uuid`).toEqual([{used:1}]);
 });
 it('owned grant failure rolls back financial settlement and quota, then normal reconcile grants once',async()=>{
  const a=await account(),p=await order(a);
  const before=await db.asUser(a.user,tx=>tx.$queryRaw<Array<{q:{periodId:string;used:number;total:number}}>>`select public.assistant_quota_get(${a.ws}::uuid) as q`);
  fixture.pay(Number(p.orderCode));
  await owner.$executeRawUnsafe(`create function public.ppv_owned_grant_fault() returns trigger language plpgsql as $$ begin if NEW.workspace_id='${a.ws}'::uuid then raise exception 'PPV_OWNED_GRANT_FAULT'; end if; return NEW; end $$`);
  await owner.$executeRawUnsafe('create trigger ppv_owned_grant_fault after insert on public.billing_grants for each row execute function public.ppv_owned_grant_fault()');
  try {
   await expect(billing.webhook(await fixture.webhook(Number(p.orderCode)))).rejects.toThrow('PPV_OWNED_GRANT_FAULT');
   expect(await grantCount(p.id)).toBe(0);
   expect(await owner.billingTransaction.count({where:{orderId:p.id}})).toBe(0);
   const current=await billing.read(a.user,a.ws,p.id);
   expect(current).toMatchObject({financialState:'UNPAID',fulfillment:'NONE'});
   const quota=await db.asUser(a.user,tx=>tx.$queryRaw<Array<{q:{periodId:string;used:number;total:number}}>>`select public.assistant_quota_get(${a.ws}::uuid) as q`);
   expect(quota[0].q).toMatchObject({periodId:before[0].q.periodId,used:0,total:15});
  } finally {
   await owner.$executeRawUnsafe('drop trigger ppv_owned_grant_fault on public.billing_grants');
   await owner.$executeRawUnsafe('drop function public.ppv_owned_grant_fault()');
  }
  await billing.reconcile(a.user,a.ws,p.id);
  await billing.reconcile(a.user,a.ws,p.id);
  expect(await grantCount(p.id)).toBe(1);
  expect(await billing.read(a.user,a.ws,p.id)).toMatchObject({financialState:'PAID',fulfillment:'GRANTED'});
  const after=await db.asUser(a.user,tx=>tx.$queryRaw<Array<{q:{used:number;total:number}}>>`select public.assistant_quota_get(${a.ws}::uuid) as q`);
  expect(after[0].q).toMatchObject({used:0,total:60});
 });
 it('signed provider time beyond the allowed future window is quarantined without a grant',async()=>{
  const a=await account(),p=await order(a);fixture.pay(Number(p.orderCode));
  fixture.links.get(Number(p.orderCode))!.transactions[0].transactionDateTime=new Date(Date.now()+3600000).toISOString();
  await billing.webhook(await fixture.webhook(Number(p.orderCode)));
  const result=await billing.read(a.user,a.ws,p.id);
  expect(result.fulfillment).toBe('REVIEW');
  expect(result.reviewReason).toBeTruthy();
  expect(await grantCount(p.id)).toBe(0);
  expect((await billing.read(a.user,a.ws,null)).entitlement).toMatchObject({plan:'free'});
 });
 it('invalid signed provider transaction time cannot create financial entitlement',async()=>{
  const a=await account(),p=await order(a);fixture.pay(Number(p.orderCode));
  fixture.links.get(Number(p.orderCode))!.transactions[0].transactionDateTime='not-a-timestamp';
  await expect(billing.webhook(await fixture.webhook(Number(p.orderCode)))).rejects.toThrow();
  expect(await grantCount(p.id)).toBe(0);
  expect((await billing.read(a.user,a.ws,null)).entitlement).toMatchObject({plan:'free'});
 });
 it('paid but no longer segment-eligible stays PAID/REVIEW without entitlement grant',async()=>{
  const a=await account(),p=await order(a);await owner.workspace.update({where:{id:a.ws},data:{type:'store'}});
  fixture.pay(Number(p.orderCode));await billing.webhook(await fixture.webhook(Number(p.orderCode)));
  expect(await billing.read(a.user,a.ws,p.id)).toMatchObject({financialState:'PAID',fulfillment:'REVIEW',reviewReason:'PLAN_SEGMENT_MISMATCH'});
  expect(await grantCount(p.id)).toBe(0);
 });
 // Deterministic clock fixtures are private migrator inserts into an owned DB.
 // They exercise the same settlement/period SQL, not a public fake-paid route
 // or real bank settlement. SDK signatures are covered separately above.
 it.each(['2027-01-31T16:59:58Z','2027-02-28T16:59:58Z','2028-02-29T16:59:58Z',
  '2027-04-30T16:59:58Z','2027-05-31T16:59:58Z','2027-12-31T16:59:58Z'])
 ('private verified settlement on %s is fixed seconds across all expiry boundaries',async(date)=>{
  const a=await account(),template=await order(a),id=randomUUID(),link=randomUUID().replaceAll('-','');
  const paidAt=new Date(date),observedAt=new Date(paidAt.getTime()+2000),expires=new Date(paidAt.getTime()+2592000000);
  const rows=await owner.$queryRaw<Array<{order_code:bigint}>>`
   insert into public.billing_orders(id,workspace_id,actor_id,idempotency_key,payload_hash,order_code,channel,
    price_id,price_snapshot,description,payment_link_id,status,created_at,expires_at,origin)
   values(${id}::uuid,${a.ws}::uuid,${a.user}::uuid,${randomUUID()}::uuid,'PRIVATE_TIME_FIXTURE',
    9000000000000+nextval('public.billing_order_sequence'),${fixture.provider.channel},'personal-month-v2',
    ${JSON.stringify(template.price)}::jsonb,'SYNTH0001',${link},'PENDING',
    ${new Date(paidAt.getTime()-60000)}::timestamptz,${new Date(paidAt.getTime()+3600000)}::timestamptz,'SIMULATED_TEST')
   returning order_code`;
  const snapshot={channel:fixture.provider.channel,id:link,orderCode:Number(rows[0].order_code),amount:29000,
   amountPaid:29000,amountRemaining:0,status:'PAID',transactions:[{reference:randomUUID(),amount:29000,
    description:'SYNTH0001',transactionDateTime:date}]};
  const settle=async()=> (await owner.$queryRaw<Array<{r:{fulfillment:string}}>>`
   select public.billing_system_verified_at('settle',${id}::uuid,${JSON.stringify(snapshot)}::jsonb,${observedAt}::timestamptz) as r`)[0].r;
  expect((await settle()).fulfillment).toBe('GRANTED');
  const grant=await owner.$queryRaw<Array<{starts_at:Date;expires_at:Date}>>`select starts_at,expires_at from public.billing_grants where order_id=${id}::uuid`;
  expect(grant).toEqual([{starts_at:paidAt,expires_at:expires}]);
  for(const [delta,expected] of [[-1000,'personal'],[0,'free'],[1000,'free']] as const) {
   const at=new Date(expires.getTime()+delta);
   const result=await owner.$queryRaw<Array<{e:{plan:string};p:{usage_limit:number;starts_at:string}}>>`
    select public.billing_refresh_at(${a.ws}::uuid,${at}::timestamptz) as e,
     to_jsonb(public.assistant_period_at(${a.ws}::uuid,${at}::timestamptz)) as p`;
   expect(result[0].e.plan).toBe(expected);expect(result[0].p.usage_limit).toBe(expected==='free'?15:60);
   if(delta===0)expect(new Date(result[0].p.starts_at).toISOString()).toBe(expires.toISOString());
  }
  await settle();expect(await grantCount(id)).toBe(1);
  expect(await owner.$queryRaw`select starts_at,expires_at from public.billing_grants where order_id=${id}::uuid`).toEqual(grant);
 });
 it('expired paid coverage retains its history, creates no Free financial row and permits a new same-plan purchase',async()=>{
  const a=await account(),now=new Date(),old=await historicalPayment(a,new Date(now.getTime()-2592000000-10000));
  expect((await old.settle(now)).fulfillment).toBe('GRANTED');
  expect((await billing.read(a.user,a.ws,null)).entitlement).toMatchObject({plan:'free'});
  const before=await owner.billingOrder.count({where:{workspaceId:a.ws}});
  for(let i=0;i<3;i++) {
   const quota=await db.asUser(a.user,tx=>tx.$queryRaw<Array<{q:{total:number;used:number}}>>`select public.assistant_quota_get(${a.ws}::uuid) as q`);
   expect(quota[0].q).toMatchObject({total:15,used:0});
  }
  expect(await owner.billingOrder.count({where:{workspaceId:a.ws}})).toBe(before);
  const again=await paid(a);
  expect(again.id).not.toBe(old.id);expect(again.financialState).toBe('PAID');
  expect((await billing.read(a.user,a.ws,null)).entitlement).toMatchObject({plan:'personal'});
  expect(await grantCount(old.id)).toBe(1);expect(await grantCount(again.id)).toBe(1);
  const rows=await owner.$queryRaw<Array<{order_id:string;starts_at:Date;expires_at:Date}>>`select order_id,starts_at,expires_at from public.billing_grants where workspace_id=${a.ws}::uuid order by starts_at`;
  expect(rows).toHaveLength(2);expect(rows[0]).toMatchObject({order_id:old.id,starts_at:old.paidAt,expires_at:old.expiresAt});
  expect(rows[1].starts_at.getTime()).toBeGreaterThan(old.expiresAt.getTime());
 });
 it('delayed valid paidAt retains seconds and replay after expiry cannot reactivate or extend its period',async()=>{
  const a=await account(),old=await historicalPayment(a,new Date('2027-01-31T16:59:58.000Z'));
  expect((await old.settle(new Date(old.paidAt.getTime()+600000))).fulfillment).toBe('GRANTED');
  const original=await owner.$queryRaw`select starts_at,expires_at from public.billing_grants where order_id=${old.id}::uuid`;
  expect(original).toEqual([{starts_at:old.paidAt,expires_at:old.expiresAt}]);
  const after=new Date(old.expiresAt.getTime()+1000);
  await old.settle(after);await old.settle(new Date(after.getTime()+86400000));
  expect(await grantCount(old.id)).toBe(1);
  expect(await owner.$queryRaw`select starts_at,expires_at from public.billing_grants where order_id=${old.id}::uuid`).toEqual(original);
  const result=await owner.$queryRaw<Array<{e:{plan:string};p:{usage_limit:number}}>>`select public.billing_refresh_at(${a.ws}::uuid,${after}::timestamptz) as e,to_jsonb(public.assistant_period_at(${a.ws}::uuid,${after}::timestamptz)) as p`;
  expect(result[0].e.plan).toBe('free');expect(result[0].p.usage_limit).toBe(15);
 });
 it('an older delayed paid event cannot replace a newer active grant',async()=>{
  const a=await account(),old=await historicalPayment(a,new Date(Date.now()-3600000));
  await old.cancel(new Date());
  const newer=await paid(a,'family-month-v2');
  expect((await old.settle(new Date())).fulfillment).toBe('REVIEW');
  expect(await billing.read(a.user,a.ws,old.id)).toMatchObject({financialState:'PAID',fulfillment:'REVIEW',reviewReason:'STALE_PAYMENT_REQUIRES_REVIEW'});
  expect(await grantCount(old.id)).toBe(0);expect(await grantCount(newer.id)).toBe(1);
  expect((await billing.read(a.user,a.ws,null)).entitlement).toMatchObject({plan:'family'});
 });
 it('an in-flight paid reservation is debited only to its original period after the exact expiry transition',async()=>{
  const a=await account(),now=new Date(),old=await historicalPayment(a,new Date(now.getTime()-2592000000+60000));
  expect((await old.settle(now)).fulfillment).toBe('GRANTED');
  const admission=(await db.asUser(a.user,tx=>tx.$queryRaw<Array<{r:{reservationId:string;leaseId:string;quota:{periodId:string;total:number}}}>>`
   select public.assistant_quota_admit(${a.ws}::uuid,${randomUUID()}::uuid,'OWNED_EXPIRY_PAYLOAD') as r`))[0].r;
  expect(admission.quota.total).toBe(60);
  const next=(await owner.$queryRaw<Array<{p:{id:string;usage_limit:number;used:number}}>>`
   select to_jsonb(public.assistant_period_at(${a.ws}::uuid,${old.expiresAt}::timestamptz)) as p`)[0].p;
  expect(next).toMatchObject({usage_limit:15,used:0});expect(next.id).not.toBe(admission.quota.periodId);
  const response={schemaVersion:'1.0',kind:'unknown',turnId:randomUUID()};
  await db.asUser(a.user,tx=>tx.$queryRaw`select public.assistant_quota_finish(${admission.reservationId}::uuid,${admission.leaseId}::uuid,${JSON.stringify(response)}::jsonb)`);
  const ledgers=await owner.$queryRaw<Array<{id:string;used:number}>>`select id,used from public.assistant_quota_periods where id in(${admission.quota.periodId}::uuid,${next.id}::uuid)`;
  expect(ledgers.find(x=>x.id===admission.quota.periodId)?.used).toBe(1);expect(ledgers.find(x=>x.id===next.id)?.used).toBe(0);
 });
 it('catalog version drift cannot rewrite an existing order or its settlement terms',async()=>{
  const a=await account(),p=await order(a);fixture.pay(Number(p.orderCode));
  const snapshot={...await fixture.provider.get(Number(p.orderCode)),channel:fixture.provider.channel};
  const version='personal-owned-'+randomUUID();
  const rollback=Error('OWNED_CATALOG_PROBE_ROLLBACK');
  try {
   await owner.$transaction(async tx=>{
    await tx.$executeRaw`update public.billing_prices set active=false where id='personal-month-v2'`;
    await tx.$executeRaw`insert into public.billing_prices(id,plan,amount,currency,months,product_limit,duration_seconds,voice_limit,workspace_type,policy_version)
     values(${version},'personal',39000,'VND',1,null,2592000,70,'household','OWNED_CATALOG_DRIFT')`;
    const active=await tx.$queryRaw<Array<{amount:number;voice_limit:number}>>`select amount,voice_limit from public.billing_prices where id=${version} and active`;
    expect(active).toEqual([{amount:39000,voice_limit:70}]);
    const result=await tx.$queryRaw<Array<{r:{fulfillment:string}}>>`select public.billing_system_verified_at('settle',${p.id}::uuid,${JSON.stringify(snapshot)}::jsonb,clock_timestamp()) as r`;
    expect(result[0].r.fulfillment).toBe('GRANTED');
    const grant=await tx.$queryRaw<Array<{price_id:string;voice_limit:number;seconds:number}>>`select price_snapshot->>'id' as price_id,(price_snapshot->>'voiceLimit')::int as voice_limit,extract(epoch from expires_at-starts_at)::int as seconds from public.billing_grants where order_id=${p.id}::uuid`;
    expect(grant).toEqual([{price_id:'personal-month-v2',voice_limit:60,seconds:2592000}]);
    throw rollback;
   });
  } catch(error) {expect(error).toBe(rollback);}
  expect((await billing.plans()).plans.map(x=>x.amount)).toEqual([29000,59000,149000]);
  expect((await billing.read(a.user,a.ws,p.id)).price).toEqual(p.price);
  expect(await grantCount(p.id)).toBe(0);
  await billing.webhook(await fixture.webhook(Number(p.orderCode)));
  expect((await billing.read(a.user,a.ws,p.id)).price).toEqual(p.price);expect(await grantCount(p.id)).toBe(1);
 });
 it.each([['household','personal-month-v2',60],['household','family-month-v2',100],['store','micro_pos-month-v2',200]] as const)
 ('%s %s has its exact independent voice quota %s',async(type,price,total)=>{
  const a=await account(type);await paid(a,price);
  const result=await db.asUser(a.user,tx=>tx.$queryRaw<Array<{q:{used:number;total:number;remaining:number}}>>`
   select public.assistant_quota_get(${a.ws}::uuid) as q`);
  expect(result[0].q).toMatchObject({used:0,total,remaining:total});
 });
 it.each([['household','personal-month-v2',60],['household','family-month-v2',100],['store','micro_pos-month-v2',200]] as const)
 ('active %s %s cannot replenish quota at any usage boundary',async(type,price,total)=>{
  const a=await account(type);await paid(a,price);
  const initial=await db.asUser(a.user,tx=>tx.$queryRaw<Array<{q:{periodId:string}}>>`select public.assistant_quota_get(${a.ws}::uuid) as q`);
  const period=initial[0].q.periodId,before=fixture.calls.create;
  for(const used of [0,total-1,total]) {
   await owner.$executeRaw`update public.assistant_quota_periods set used=${used} where id=${period}::uuid`;
   await expect(order(a,price)).rejects.toThrow('PLAN_ALREADY_ACTIVE');
   if(price==='family-month-v2')await expect(order(a,'personal-month-v2')).rejects.toThrow('PLAN_DOWNGRADE_BLOCKED');
   if(type==='store')await expect(order(a,'family-month-v2')).rejects.toThrow('PLAN_SEGMENT_MISMATCH');
   expect(fixture.calls.create).toBe(before);
   const q=await db.asUser(a.user,tx=>tx.$queryRaw<Array<{q:{used:number;remaining:number;periodId:string}}>>`select public.assistant_quota_get(${a.ws}::uuid) as q`);
   expect(q[0].q).toMatchObject({used,remaining:total-used,periodId:period});
  }
 });
 it('persists one 30-minute deadline before SDK create; replay/read never extend it',async()=>{
  const a=await account(),key=randomUUID(),p=await order(a,'personal-month-v2',key);
  expect(Date.parse(p.expiresAt as string)-Date.parse(p.createdAt as string)).toBe(1800000);
  expect(fixture.createDeadlines.find(x=>String(x.orderCode)===p.orderCode)?.expiredAt).toBe(Math.floor(Date.parse(p.expiresAt as string)/1000));
  const before=fixture.calls.create,replay=await order(a,'personal-month-v2',key);
  expect(replay.expiresAt).toBe(p.expiresAt);expect(fixture.calls.create).toBe(before);
  expect((await billing.read(a.user,a.ws,p.id)).serverNow).toBeTruthy();
 });
 it('records confirmed cancellation time once, then keeps it through replay and paid races',async()=>{
  const a=await account(),p=await order(a),cancelled=await billing.cancel(a.user,a.ws,p.id);
  expect(cancelled.status).toBe('CANCELLED');expect(cancelled.cancelledAt).toBeTruthy();expect(cancelled.cancellationTimeSource).toBe('SERVER_CONFIRMED');
  const replay=await billing.cancel(a.user,a.ws,p.id);expect(replay.cancelledAt).toBe(cancelled.cancelledAt);
  expect((await billing.read(a.user,a.ws,p.id)).cancelledAt).toBe(cancelled.cancelledAt);
  expect(await grantCount(p.id)).toBe(0);
 });
 it('durable financial events preserve verified money/activation, review and cancellation exactly once',async()=>{
  const a=await account(),notices=new NotificationsService(db,new SnapshotService(db));
  const first=await order(a);await billing.cancel(a.user,a.ws,first.id);await billing.cancel(a.user,a.ws,first.id);
  const second=await order(a);fixture.pay(Number(second.orderCode));await billing.webhook(await fixture.webhook(Number(second.orderCode)));
  await billing.webhook(await fixture.webhook(Number(second.orderCode)));await drainNotices(notices);
  const rows=(await notices.list(a.user,a.ws,50)).items;
  expect(rows.filter(x=>x.type==='billing.created')).toHaveLength(2);
  expect(rows.filter(x=>x.type==='billing.cancelled')).toHaveLength(1);
  expect(rows.filter(x=>x.type==='billing.activated')).toHaveLength(1);
  expect(rows.some(x=>x.type==='billing.paid')).toBe(false);
  const reviewOwner=await account(),review=await order(reviewOwner);fixture.pay(Number(review.orderCode),1);
  await billing.reconcile(reviewOwner.user,reviewOwner.ws,review.id);await drainNotices(notices);
  const state=await billing.read(reviewOwner.user,reviewOwner.ws,review.id);
  expect(state.fulfillment).not.toBe('GRANTED');expect(await grantCount(review.id)).toBe(0);
 });
 it('provider-confirmed cancellation time is validated and legacy terminal records keep unknown time',async()=>{
  const a=await account(),p=await order(a),at=new Date().toISOString();
  fixture.links.get(Number(p.orderCode))!.canceledAt=at;
  const canceled=await billing.cancel(a.user,a.ws,p.id);
  expect(canceled.cancellationTimeSource).toBe('PROVIDER_CONFIRMED');expect(Date.parse(canceled.cancelledAt as string)).toBe(Date.parse(at));
  const legacy=randomUUID();await owner.$executeRaw`insert into public.billing_orders(id,workspace_id,actor_id,idempotency_key,payload_hash,order_code,channel,price_id,price_snapshot,description,status,origin)
   values(${legacy}::uuid,${a.ws}::uuid,${a.user}::uuid,${randomUUID()}::uuid,'OWNED_LEGACY_FIXTURE',9000000000000+nextval('public.billing_order_sequence'),${fixture.provider.channel},'personal-month-v2',${JSON.stringify(p.price)}::jsonb,'SYNTH0001','CANCELLED','SIMULATED_TEST')`;
  const old=await billing.read(a.user,a.ws,legacy);expect(old.cancelledAt).toBeNull();expect(old.cancellationTimeSource).toBeNull();
 });
 it('financial scope loss hides notices/search without deleting preserved financial history',async()=>{
  const a=await account(),p=await order(a),notices=new NotificationsService(db,new SnapshotService(db)),search=new SearchService(db);
  await drainNotices(notices);const n=(await notices.list(a.user,a.ws,50)).items.find(x=>x.type==='billing.created')!;
  expect((await search.search(a.user,a.ws,p.orderCode as string,20,undefined,'billing')).items).toHaveLength(1);
  await owner.workspaceMember.updateMany({where:{workspaceId:a.ws,userId:a.user},data:{role:'member'}});
  expect((await notices.list(a.user,a.ws,50)).items.some(x=>x.id===n.id)).toBe(false);
  await expect(notices.detail(a.user,a.ws,n.id)).rejects.toThrow();
  expect((await search.search(a.user,a.ws,p.orderCode as string,20,undefined,'billing')).items).toHaveLength(0);
  await expect(search.resolve(a.user,a.ws,'billing',p.id)).rejects.toThrow();
  expect(await owner.billingOrder.count({where:{id:p.id}})).toBe(1);
 });
 it('bounded due worker confirms paid expiry/fallback, preserves grant history and does not notify a superseded grant',async()=>{
  const a=await account(),old=await historicalPayment(a,new Date(Date.now()-31*86400000));await old.settle(new Date());
  // Represents an app-closed entitlement whose clock deadline just passed.
  await owner.$executeRaw`update public.workspace_entitlements set plan='personal',source='billing' where workspace_id=${a.ws}::uuid`;
  const notices=new NotificationsService(db,new SnapshotService(db));await drainNotices(notices,true);await drainNotices(notices,true);
  expect((await notices.list(a.user,a.ws,50)).items.filter(x=>x.type==='billing.plan_expired')).toHaveLength(1);
  expect(await grantCount(old.id)).toBe(1);
  const b=await account(),previous=await historicalPayment(b,new Date(Date.now()-31*86400000));await previous.settle(new Date());
  await paid(b);await drainNotices(notices,true);
  expect((await notices.list(b.user,b.ws,50)).items.some(x=>x.type==='billing.plan_expired')).toBe(false);
  const c=await account(),manual=await historicalPayment(c,new Date(Date.now()-31*86400000));await manual.settle(new Date());
  await owner.$executeRaw`update public.workspace_entitlements set plan='family',source='legacy_manual' where workspace_id=${c.ws}::uuid`;
  await drainNotices(notices,true);
  expect((await notices.list(c.user,c.ws,50)).items.some(x=>x.type==='billing.plan_expired')).toBe(false);
  expect((await billing.read(c.user,c.ws,null)).entitlement).toMatchObject({plan:'family',source:'legacy_manual'});
 });
});
