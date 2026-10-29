import { installMockEmailAuth, verifyHttpRegistration } from './support/email-auth-fixture';
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import { sdkFixture } from './payos.fixture';
import { requireDisposableDatabase } from './disposable-database';

describe.skipIf(process.env.RUN_DB_TESTS!=='1')('billing HTTP startup/auth/DTO/signature boundary',()=>{
 let emailAuth:any;
 let app:INestApplication,base:string,fixture:ReturnType<typeof sdkFixture>,user:string,ws:string,token:string,refreshToken:string,password:string,payment:{id:string;orderCode:string};
 const owner=new PrismaClient({datasourceUrl:process.env.MIGRATION_DATABASE_URL});
 async function call(path:string,method='GET',body?:object,authorized=true,extra:Record<string,string>={}) {
  const response=await fetch(base+path,{method,headers:{'x-homemind-distribution':'direct',...(authorized?{Authorization:'Bearer '+token}:{}),...(body?{'content-type':'application/json'}:{}),...extra},body:body?JSON.stringify(body):undefined});
  return {status:response.status,body:await response.json()};
 }
 beforeAll(async()=>{
  requireDisposableDatabase();
  fixture=sdkFixture();
  await owner.$executeRaw`insert into public.billing_test_channels(channel) values(${fixture.provider.channel}) on conflict do nothing`;
  // Exercise the actual compiled Nest runtime (Vitest's esbuild omits DI metadata).
  const built=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.build.json'],{encoding:'utf8'});
  if(built.status!==0) throw Error('Runtime compilation failed; run typecheck');
  const {AppModule}=require('../dist/app.module.js');
  const {ApiErrorFilter}=require('../dist/common/api-error.filter.js');
  const {PayosProvider}=require('../dist/billing/payos.provider.js');
  app=await NestFactory.create(AppModule,{logger:false});emailAuth=installMockEmailAuth(app);
  Object.defineProperty(app.get(PayosProvider),'client',{value:(fixture.provider as unknown as {client:unknown}).client});
  app.setGlobalPrefix('v1');app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));app.useGlobalFilters(new ApiErrorFilter());
  await app.listen(0,'127.0.0.1');base=await app.getUrl();base+='/v1';
  password=randomBytes(24).toString('hex');
  const registration=await call('/auth/register','POST',{acceptedTerms:true,acceptedPrivacy:true,displayName:'Owned HTTP fixture',email:`billing-http+${randomUUID()}@example.com`,password,workspaceType:'household'},false);
  expect(registration.status).toBe(201);registration.body=await verifyHttpRegistration(base,emailAuth,registration.body);user=registration.body.user.id;token=registration.body.accessToken;refreshToken=registration.body.refreshToken;
  const profile=await call('/me');expect(profile.status).toBe(200);ws=profile.body.workspaceId;
  // An existing historical row is seeded only in the disposable test DB.
  // No provider create is needed for read/auth/signed-webhook contracts.
  const id=randomUUID(),link=randomUUID().replaceAll('-','');
  const rows=await owner.$queryRaw<Array<{order_code:bigint}>>`
   insert into public.billing_orders(id,workspace_id,actor_id,idempotency_key,payload_hash,order_code,channel,
    price_id,price_snapshot,description,payment_link_id,checkout_url,qr_code,bank_bin,bank_account,bank_name,
    status,created_at,expires_at,next_check_at,origin)
   select ${id}::uuid,${ws}::uuid,${user}::uuid,${randomUUID()}::uuid,'HISTORICAL_READ_ONLY_FIXTURE',
    9000000000000+nextval('public.billing_order_sequence'),${fixture.provider.channel},p.id,
    jsonb_build_object('id',p.id,'plan',p.plan,'amount',p.amount,'currency',p.currency,'durationSeconds',p.duration_seconds,
     'voiceLimit',p.voice_limit,'policyVersion',p.policy_version,'productLimit',p.product_limit),
    'SYNTH0001',${link},${'https://pay.payos.vn/web/'+link},'HISTORICAL_QR','000000','000000000','LOCAL TEST ONLY',
    'PENDING',now()-interval '1 minute',now()+interval '30 minutes',now()+interval '1 day','SIMULATED_TEST'
   from public.billing_prices p where p.id='personal-month-v2' returning order_code`;
  payment={id,orderCode:String(rows[0].order_code)};
  fixture.links.set(Number(payment.orderCode),{id:link,orderCode:Number(payment.orderCode),amount:29000,amountPaid:0,
   amountRemaining:29000,status:'PENDING',createdAt:new Date().toISOString(),transactions:[],cancellationReason:null,canceledAt:null});
  fixture.descriptions.set(Number(payment.orderCode),'SYNTH0001');
  expect(fixture.calls.create).toBe(0);

 },20000);
 afterAll(async()=>{
  if(app) await app.close();
  if(ws) await owner.$transaction(async tx=>{
   await tx.$executeRaw`delete from public.billing_test_channels where channel=${fixture.provider.channel}`;
   await tx.$executeRaw`delete from public.billing_transactions where order_id in(select id from public.billing_orders where workspace_id=${ws}::uuid)`;
   await tx.$executeRaw`delete from public.billing_grants where workspace_id=${ws}::uuid`;
   await tx.$executeRaw`delete from public.billing_webhook_inbox where order_code in(select order_code from public.billing_orders where workspace_id=${ws}::uuid)`;
   await tx.$executeRaw`delete from public.billing_orders where workspace_id=${ws}::uuid`;
   await tx.workspace.deleteMany({where:{id:ws}});await tx.user.deleteMany({where:{id:user}});
  });await owner.$disconnect();
 });
 it('starts API, catalog and subscription; payment history needs active JWT owner',async()=>{
  expect((await call('/health/live', 'GET',undefined,false)).status).toBe(200);
  expect((await call('/billing/plans','GET',undefined,false)).body.plans).toHaveLength(3);
  expect((await call(`/workspaces/${ws}/billing/subscription`)).body.entitlement.plan).toBe('free');
  expect((await call(`/workspaces/${ws}/billing/payments`,'GET',undefined,false)).status).toBe(401);
  expect((await call(`/workspaces/${randomUUID()}/billing/payments`)).status).toBe(403);
  expect((await call(`/workspaces/${ws}/billing/payments?offset=-1`)).status).toBe(400);
 });
 it('real registration API rejects missing/false consent and client timestamps',async()=>{
  const baseInput={displayName:'Owned consent rejection',email:`reject-${randomUUID()}@example.invalid`,password,workspaceType:'household'};
  for(const acknowledgment of [{},{acceptedTerms:false,acceptedPrivacy:true},{acceptedTerms:true,acceptedPrivacy:false},{acceptedTerms:true,acceptedPrivacy:true,termsAcceptedAt:'2000-01-01'}]) {
   expect((await call('/auth/register','POST',{...baseInput,...acknowledgment},false)).status).toBe(400);
  }
  expect(await owner.user.count({where:{email:baseInput.email}})).toBe(0);
 });
 it('DTO injection is rejected and valid create fails closed before provider or DB mutation',async()=>{
  const path=`/workspaces/${ws}/billing/payments`;
  expect((await call(path,'POST',{priceId:'personal-month-v2',transition:'immediate_upgrade',amount:1},true,{'idempotency-key':randomUUID()})).status).toBe(400);
  expect((await call(path,'POST',{priceId:'personal-month-v2'},true,{'idempotency-key':randomUUID()})).status).toBe(400);
  const before=await owner.billingOrder.count({where:{workspaceId:ws}});
  for(const distribution of ['store','direct','']) {
   const response=await call(path,'POST',{priceId:'personal-month-v2',transition:'immediate_upgrade'},true,
    {'idempotency-key':randomUUID(),'x-homemind-distribution':distribution});
   expect(response.status).toBe(403);expect(response.body.error.code).toBe('BILLING_DISTRIBUTION_DISABLED');
  }
  expect(await owner.billingOrder.count({where:{workspaceId:ws}})).toBe(before);
  expect(fixture.calls).toEqual({create:0,get:0,cancel:0});
 });
 it('all channels preserve status-only history and cannot expose old pending instructions or bypass mutation guards',async()=>{
  expect((await call('/billing/plans','GET',undefined,false)).body.checkoutEnabled).toBe(false);
  const before={...fixture.calls};
  for(const distribution of ['store','direct','','untrusted','DIRECT','direct, store']) {
   const headers={'x-homemind-distribution':distribution};
   expect((await call('/billing/plans','GET',undefined,false,headers)).body.checkoutEnabled).toBe(false);
   for(const path of [`/workspaces/${ws}/billing/payments/${payment.id}`,`/workspaces/${ws}/billing/payments`,`/workspaces/${ws}/billing/subscription`]) {
    const response=await call(path,'GET',undefined,true,headers);
    expect(response.status).toBe(200);
    const orders=Array.isArray(response.body.payments)?response.body.payments:[response.body];
    const pending=orders.find((order:{id:string})=>order.id===payment.id);
    expect(pending.status).toBe('PENDING');expect(pending.financialState).toBe('UNPAID');
    for(const key of ['qr','checkoutUrl','paymentLinkId','description','expiresAt','orderCode','bankAccount','providerDetails']) expect(pending).not.toHaveProperty(key);
    expect(pending.price).not.toHaveProperty('amount');
    expect(JSON.stringify(response.body)).not.toContain('pay.payos.vn');
   }
   for(const [path,body] of [
    [`/workspaces/${ws}/billing/payments`,{priceId:'family-month-v2',transition:'immediate_upgrade'}],
    [`/workspaces/${ws}/billing/payments/${payment.id}/reconcile`,undefined],
    [`/workspaces/${ws}/billing/payments/${payment.id}/cancel`,undefined],
    [`/workspaces/${ws}/upgrade-requests`,{plan:'family',source:'paywall'}],
   ] as const) {
    // The create endpoint intentionally permits only six attempts/minute.
    // Exercise its store denial once; all malformed channels share the tested
    // fail-closed policy, and the read paths below exercise every header value.
    if(path===`/workspaces/${ws}/billing/payments`) continue;
    const response=await call(path,'POST',body,true,headers);
    expect(response.status).toBe(403);expect(response.body.error.code).toBe('BILLING_DISTRIBUTION_DISABLED');
   }
  }
  const noHeader=await fetch(base+`/workspaces/${ws}/billing/payments/${payment.id}`,{headers:{Authorization:'Bearer '+token}});
  expect(noHeader.status).toBe(200);expect(await noHeader.json()).not.toHaveProperty('qr');
  expect(fixture.calls).toEqual(before);
  const direct=await call(`/workspaces/${ws}/billing/payments/${payment.id}`);
  expect(direct.body.status).toBe('PENDING');expect(direct.body).not.toHaveProperty('qr');expect(direct.body).not.toHaveProperty('checkoutUrl');expect(fixture.calls.create).toBe(0);
  expect((await call(`/workspaces/${randomUUID()}/billing/payments/${payment.id}`,'GET',undefined,true,{'x-homemind-distribution':'store'})).status).toBe(403);
 });
 it('untouched signed webhook survives global ValidationPipe; duplicate callback grants once and refreshes cached bootstrap/me',async()=>{
  const before=await call(`/workspaces/${ws}/bootstrap`);expect(before.body.home.plan).toBe('free');
  fixture.pay(Number(payment.orderCode));const webhook=await fixture.webhook(Number(payment.orderCode));
  expect((await call('/billing/payos/webhook','POST',{...webhook,data:{...webhook.data,amount:1}},false)).status).toBe(400);
  expect((await call('/billing/payos/webhook','POST',webhook,false)).status).toBe(200);
  expect((await call('/billing/payos/webhook','POST',webhook,false)).status).toBe(200);
  expect((await call('/me')).body.plan).toBe('personal');
  expect((await call(`/workspaces/${ws}/bootstrap`)).body.home.plan).toBe('personal');
  const r=await owner.$queryRaw<Array<{n:bigint}>>`select count(*) as n from public.billing_grants where order_id=${payment.id}::uuid`;expect(Number(r[0].n)).toBe(1);
 });
 it('return/cancel pages ignore malicious/paid query hints and cannot grant or redirect',async()=>{
  for(const path of ['/billing/payos/return?status=PAID&returnUrl=https://evil.test&x=%3Cscript%3E','/billing/payos/cancel?cancel=true']) {
   const r=await fetch(base+path);expect(r.status).toBe(200);expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
   const body=await r.text();expect(body).not.toContain('evil.test');expect(body).not.toContain('<script>');expect(r.headers.get('location')).toBeNull();
  }
 });
 it('database acceptance failure never ACKs 2xx; a subsequent retry remains safe',async()=>{
  const {BillingService}=require('../dist/billing/billing.service.js');
  const service=app.get(BillingService) as {system:(...args:unknown[])=>Promise<unknown>};
  const hook=await fixture.webhook(Number(payment.orderCode));
  const injected=vi.spyOn(service,'system').mockRejectedValueOnce(new Error('Synthetic DB unavailable'));
  try {expect((await call('/billing/payos/webhook','POST',hook,false)).status).toBe(500);}finally{injected.mockRestore();}
  expect((await call('/billing/payos/webhook','POST',hook,false)).status).toBe(200);
 });
 it('an existing paid entitlement, quota and history survive read-only mode and normal expiry',async()=>{
  const me=await call('/me');expect(me.body.plan).toBe('personal');expect(me.body.voiceQuota.total).toBe(60);
  const history=await call(`/workspaces/${ws}/billing/payments`);
  const receipt=history.body.payments.find((row:{id:string})=>row.id===payment.id);
  expect(receipt.financialState).toBe('PAID');expect(receipt.price.amount).toBe(29000);expect(receipt.grant.expiresAt).toBeTypeOf('string');
  expect(history.body.checkoutEnabled).toBe(false);expect(JSON.stringify(history.body)).not.toContain('pay.payos.vn');
  const before=await owner.billingGrant.findMany({where:{orderId:payment.id}});
  const fallback=await owner.$queryRaw<Array<{r:{plan:string}}>>`select public.billing_refresh_at(${ws}::uuid,now()+interval '31 days') as r`;
  expect(fallback[0].r.plan).toBe('free');
  expect(await owner.billingGrant.findMany({where:{orderId:payment.id}})).toEqual(before);
  expect((await call('/me')).body.plan).toBe('personal');
  expect(fixture.calls.create).toBe(0);expect(fixture.calls.cancel).toBe(0);
 });
 it('real DELETE keeps user, profile, paid records and relationships; old access/refresh/login cannot work',async()=>{
  const prior=await owner.user.findUniqueOrThrow({where:{id:user}});
  const counts=()=>owner.$queryRaw<Array<{orders:bigint;transactions:bigint;grants:bigint}>>`select
   (select count(*) from public.billing_orders where workspace_id=${ws}::uuid) as orders,
   (select count(*) from public.billing_transactions where order_id in(select id from public.billing_orders where workspace_id=${ws}::uuid)) as transactions,
   (select count(*) from public.billing_grants where workspace_id=${ws}::uuid) as grants`;
  const before=await counts();expect(Number(before[0].orders)).toBeGreaterThan(0);expect(Number(before[0].grants)).toBeGreaterThan(0);
  expect((await call('/auth/account','DELETE',{currentPassword:password})).status).toBe(200);
  const deleted=await owner.user.findUniqueOrThrow({where:{id:user}});
  expect(deleted.status).toBe('DELETED');expect(deleted.deletedAt).not.toBeNull();
  expect(deleted.email).toBe(prior.email);expect(deleted.passwordHash).toBe(prior.passwordHash);
  expect(await owner.profile.count({where:{id:user}})).toBe(1);
  expect(await owner.workspaceMember.count({where:{userId:user,workspaceId:ws}})).toBe(1);
  expect(await counts()).toEqual(before);
  expect((await call('/me')).status).toBe(401);
  expect((await call('/auth/refresh','POST',{refreshToken},false)).status).toBe(401);
  expect((await call('/auth/login','POST',{identifier:prior.email,password},false)).status).toBe(403);
  expect((await call('/auth/account','DELETE',{currentPassword:password})).status).toBe(401);
  expect(await owner.user.findUniqueOrThrow({where:{id:user}})).toEqual(deleted);
 });
});
