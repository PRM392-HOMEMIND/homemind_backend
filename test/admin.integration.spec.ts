import { installMockEmailAuth, verifyHttpRegistration } from './support/email-auth-fixture';
import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { NestFactory } from '@nestjs/core';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { requireDisposableDatabase } from './disposable-database';
import { ADMIN_SCHEMAS } from '../src/admin/admin.schemas';
import { acquireCampaignLock } from './feedback-popup.lock';

describe.skipIf(process.env.RUN_ADMIN_DB_TESTS!=='1')('SYSTEM_ADMIN actual PostgreSQL + compiled HTTP boundary',()=>{
 let emailAuth:any;
 const operator=new PrismaClient({datasourceUrl:process.env.MIGRATION_DATABASE_URL});
 let app:INestApplication,base:string,principal:string,cookie='',csrf='',user:string,other:string,ws:string,otherWs:string,customerToken:string,realOrders:string[]=[];
 const password='Adm!'+randomBytes(24).toString('hex'),email='admin-'+randomUUID()+'@example.invalid';
 let singletonOwned=false;
 async function request(path:string,method='GET',body?:object,headers:Record<string,string>={}) {
  const response=await fetch(base+path,{method,headers:{Origin:'https://homemind.vn',...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-HomeMind-Admin-CSRF':csrf}:{}),...(body?{'Content-Type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});
  const raw=await response.text();let data: any=null;try{data=JSON.parse(raw);}catch{}
  return {status:response.status,body:data,headers:response.headers,raw};
 }
 async function login() {
  cookie='';csrf='';const challenge=await request('/admin/auth/csrf');expect(challenge.status).toBe(200);
  const pre=challenge.headers.getSetCookie().find(x=>x.startsWith('__Host-homemind-admin-csrf='))!;cookie=pre.split(';')[0];csrf=challenge.body.data.csrfToken;
  const r=await request('/admin/auth/login','POST',{email,password});expect(r.status,r.raw).toBe(200);
  cookie=r.headers.getSetCookie().find(x=>x.startsWith('__Host-homemind-admin='))!.split(';')[0];csrf=r.body.data.csrfToken;
  return r;
 }
 function validateSchema(value:any,schema:any):void {
  if(schema.$ref)return validateSchema(value,ADMIN_SCHEMAS[schema.$ref.split('/').at(-1)]);
  if(value===null){expect(schema.nullable || schema.enum?.includes(null)).toBeTruthy();return;}
  if(schema.enum)expect(schema.enum).toContain(value);
  if(schema.type==='object') {expect(typeof value).toBe('object');for(const key of schema.required || [])expect(value).toHaveProperty(key);for(const [key,item]of Object.entries(value)){if(schema.properties?.[key])validateSchema(item,schema.properties[key]);else if(schema.additionalProperties===false)throw new Error('Undocumented response field: '+key);else if(typeof schema.additionalProperties==='object')validateSchema(item,schema.additionalProperties);}}
  else if(schema.type==='array'){expect(Array.isArray(value)).toBe(true);for(const item of value)validateSchema(item,schema.items);}
  else if(schema.type==='integer')expect(Number.isInteger(value)).toBe(true);
  else if(schema.type)expect(typeof value).toBe(schema.type);
 }
 async function register(emailValue:string) {
  const r=await request('/auth/register','POST',{email:emailValue,password:'Customer!'+randomBytes(20).toString('hex'),displayName:'Owned admin fixture',workspaceType:'household',acceptedTerms:true,acceptedPrivacy:true},{Cookie:''});expect(r.status).toBe(201);r.body=await verifyHttpRegistration(base,emailAuth,r.body,emailValue);
  const profile=await request('/me','GET',undefined,{Cookie:'',Authorization:'Bearer '+r.body.accessToken});expect(profile.status).toBe(200);
  return {id:r.body.user.id,ws:profile.body.workspaceId,token:r.body.accessToken};
 }
 async function order(status:string,financial:string,fulfillment:string,amount:number,origin='REAL_PAYOS',version='voice-30d-v2',payer=user) {
  const id=randomUUID(),code=BigInt(9000000000000)+BigInt(parseInt(randomBytes(5).toString('hex'),16));
  const snapshot={id:'personal-month-v2',plan:'personal',amount:financial==='PARTIAL'||financial==='REVIEW'?29000:amount,currency:'VND',durationSeconds:2592000,voiceLimit:60,workspaceType:'household',productLimit:null,policyVersion:version};
  await operator.$executeRawUnsafe(`INSERT INTO public.billing_orders(id,workspace_id,actor_id,idempotency_key,payload_hash,order_code,channel,price_id,price_snapshot,description,status,financial_state,fulfillment,amount_paid,origin,paid_at,checkout_url,qr_code,bank_bin,bank_account,bank_name) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'test',$5::bigint,$6,'personal-month-v2',$7::jsonb,'ABCDEFGHI',$8,$9,$10,$11,$12,now(),'https://pay.payos.vn/SECRET_SENTINEL','SECRET_SENTINEL_QR','970416','SECRET_SENTINEL_BANK','SECRET_SENTINEL_OWNER')`,id,ws,payer,randomUUID(),code.toString(),'admin-fixture-'+principal,JSON.stringify(snapshot),status,financial,fulfillment,financial==='UNPAID'?0:amount,origin);
  if(fulfillment==='GRANTED')await operator.$executeRawUnsafe("INSERT INTO public.billing_grants(order_id,workspace_id,plan,starts_at,expires_at,price_snapshot) VALUES($1::uuid,$2::uuid,'personal',now()-interval '2 days',now()+interval '28 days',$3::jsonb)",id,ws,JSON.stringify(snapshot));
  return id;
 }
 beforeAll(async()=>{
  requireDisposableDatabase();if(!process.env.ADMIN_DATABASE_URL)throw new Error('Admin fixture missing');
  const compiled=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.build.json'],{encoding:'utf8'});if(compiled.status!==0)throw new Error('Admin compilation failed: '+compiled.stdout);
  const {AppModule}=require('../dist/app.module.js');const {ApiErrorFilter}=require('../dist/common/api-error.filter.js');
  app=await NestFactory.create(AppModule,{logger:false});emailAuth=installMockEmailAuth(app);app.setGlobalPrefix('v1');app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));app.useGlobalFilters(new ApiErrorFilter());await app.listen(0,'127.0.0.1');base=await app.getUrl()+'/v1';
  const child=spawnSync(process.execPath,['scripts/admin-operator.cjs'],{input:JSON.stringify({email,password,operation:'bootstrap'}),encoding:'utf8',env:process.env});expect(child.status,child.stderr).toBe(0);const result=JSON.parse(child.stdout);expect(result.status).toBe('PROVISIONED');principal=result.id;singletonOwned=true;
  const a=await register(email),b=await register('customer-'+randomUUID()+'@example.invalid');user=a.id;ws=a.ws;customerToken=a.token;other=b.id;otherWs=b.ws;
  await operator.$executeRawUnsafe("INSERT INTO admin.customer_scope VALUES($1::uuid,'REAL',now())",user);
  await operator.$executeRawUnsafe("INSERT INTO admin.workspace_scope VALUES($1::uuid,'REAL',now())",ws);
  await operator.$executeRawUnsafe("UPDATE public.profiles SET phone='+84912345678',address='Owned test address' WHERE id=$1::uuid",user);
  realOrders=[await order('PAID','PAID','GRANTED',29000),await order('PAID','PAID','GRANTED',29000)];
  await order('PENDING','UNPAID','NONE',29000);await order('CANCELLED','UNPAID','NONE',29000);await order('EXPIRED','UNPAID','NONE',29000);
  const partial=await order('UNDERPAID','PARTIAL','NONE',10000);
  await order('PAID','PAID','GRANTED',29000,'SIMULATED_TEST');await order('PAID','PAID','GRANTED',29000,'REAL_PAYOS','legacy');
  const review=await order('REVIEW','REVIEW','REVIEW',35000);
  for(const [id,reference,amount]of [[partial,'partial',10000],[review,'excess-review',35000]] as const)await operator.$executeRawUnsafe("INSERT INTO public.billing_transactions(channel,reference,order_id,amount,paid_at) VALUES($1,$2,$3::uuid,$4,now())",'admin-fixture-'+principal,reference,id,amount);
  for(const [i,id] of realOrders.entries())await operator.$executeRawUnsafe("INSERT INTO public.billing_transactions(channel,reference,order_id,amount,paid_at) VALUES($1,$2,$3::uuid,29000,now()) ON CONFLICT DO NOTHING",'admin-fixture-'+principal,'verified-'+i,id);
  await login();
 },30000);
 beforeEach(async()=>{await operator.$executeRawUnsafe('DELETE FROM admin.login_limits');});
 afterAll(async()=>{
  if(app)await app.close();
  if(ws)await operator.$transaction(async tx=>{
   await tx.$executeRawUnsafe('DELETE FROM public.billing_transactions WHERE order_id IN(SELECT id FROM public.billing_orders WHERE workspace_id=$1::uuid)',ws);
   await tx.$executeRawUnsafe('DELETE FROM public.billing_grants WHERE workspace_id=$1::uuid',ws);
   await tx.$executeRawUnsafe('DELETE FROM public.billing_orders WHERE workspace_id=$1::uuid',ws);
   await tx.workspace.deleteMany({where:{id:{in:[ws,otherWs].filter(Boolean)}}});await tx.user.deleteMany({where:{id:{in:[user,other].filter(Boolean)}}});
  });
  if(singletonOwned) {await operator.$executeRawUnsafe('DELETE FROM admin.audit_logs WHERE actor_id=$1::uuid',principal);await operator.$executeRawUnsafe('DELETE FROM admin.sessions WHERE admin_id=$1::uuid',principal);await operator.$executeRawUnsafe('DELETE FROM admin.principals WHERE id=$1::uuid',principal);}
  await operator.$disconnect();
 });
 it('bootstrap is singleton/idempotent, no reset/reactivation and namespace is separate',async()=>{
  const p2='Other!'+randomBytes(24).toString('hex');
  const children=await Promise.all([1,2].map(()=>new Promise<number|null>(resolve=>{const {spawn}=require('node:child_process');const p=spawn(process.execPath,['scripts/admin-operator.cjs'],{env:process.env,stdio:['pipe','ignore','ignore']});p.stdin.end(JSON.stringify({email,password:p2,operation:'bootstrap'}));p.on('exit',resolve);})));expect(children).toEqual([0,0]);
  const [count]=await operator.$queryRawUnsafe<{n:bigint}[]>('SELECT count(*) n FROM admin.principals');expect(Number(count.n)).toBe(1);
  expect((await request('/admin/auth/me')).body.data.id).not.toBe(user);await login();
  await operator.$executeRawUnsafe("UPDATE admin.principals SET status='DISABLED' WHERE id=$1::uuid",principal);
  const repeat=spawnSync(process.execPath,['scripts/admin-operator.cjs'],{env:process.env,input:JSON.stringify({email,password:p2,operation:'bootstrap'}),encoding:'utf8'});
  expect(repeat.status).toBe(0);expect(JSON.parse(repeat.stdout).adminStatus).toBe('DISABLED');
  await operator.$executeRawUnsafe("UPDATE admin.principals SET status='ACTIVE' WHERE id=$1::uuid",principal);await login();
  const collision=spawnSync(process.execPath,['scripts/admin-operator.cjs'],{env:process.env,input:JSON.stringify({email:'different@example.invalid',password:p2,operation:'bootstrap'}),encoding:'utf8'});expect(collision.status).toBe(1);
  for(const path of ['/admin/register','/admin/users','/admin/promote','/admin/set-plan','/admin/reset-quota'])expect((await request(path,'POST',{role:'SYSTEM_ADMIN'})).status).toBe(404);
 });
 it('cookie/login-CSRF/Origin/CORS and generic invalid credentials fail closed',async()=>{
  expect((await request('/admin/auth/me')).headers.get('cache-control')).toBe('private, no-store');
  expect((await request('/admin/auth/login','POST',{email,password},{'X-HomeMind-Admin-CSRF':''})).status).toBe(403);
  expect((await request('/admin/auth/me','GET',undefined,{Origin:'https://evil.example'})).status).toBe(403);
  const pre=await request('/admin/meta','OPTIONS',undefined,{'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'content-type'});expect(pre.status).toBe(204);expect(pre.headers.get('access-control-allow-origin')).toBe('https://homemind.vn');
  expect((await request('/admin/meta','OPTIONS',undefined,{Origin:'https://evil.example','Access-Control-Request-Method':'GET'})).status).toBe(403);
  const r=await login();for(const header of r.headers.getSetCookie().filter(x=>x.startsWith('__Host-homemind-admin='))) {expect(header).toContain('Secure');expect(header).toContain('HttpOnly');expect(header).toContain('SameSite=Strict');expect(header).not.toContain('Domain=');}
  expect(r.raw).not.toContain(cookie.split('=')[1]);
 });
 it('guest/customer JWT/forged role cannot access any data resource; no escalation inputs',async()=>{
  for(const path of ['/admin/meta','/admin/dashboard/overview','/admin/users','/admin/workspaces','/admin/payments','/admin/entitlements','/admin/usage/periods','/admin/usage/requests','/admin/notifications','/admin/operations/status','/admin/audit-logs']) {
   expect((await request(path,'GET',undefined,{Cookie:''})).status).toBe(401);
   expect((await request(path,'GET',undefined,{Cookie:'',Authorization:'Bearer '+customerToken,'x-role':'SYSTEM_ADMIN'})).status).toBe(401);
  }
  expect((await request('/admin/users?role=SYSTEM_ADMIN')).status).toBe(400);
  expect((await request('/me','PATCH',{role:'SYSTEM_ADMIN'},{Authorization:'Bearer '+customerToken})).status).toBe(400);
 });
 it('global lists/details/subresources have real envelopes, bounded pages and no sensitive sentinel',async()=>{
  const paths=['/admin/meta','/admin/auth/me','/admin/auth/sessions','/admin/dashboard/overview','/admin/dashboard/trends','/admin/dashboard/plan-distribution','/admin/dashboard/top-paying-users','/admin/users','/admin/users/'+user,'/admin/users/'+user+'/workspaces','/admin/users/'+user+'/spending','/admin/users/'+user+'/activity','/admin/workspaces','/admin/workspaces/'+ws,'/admin/workspaces/'+ws+'/members','/admin/workspaces/'+ws+'/inventory','/admin/workspaces/'+ws+'/shopping','/admin/payments','/admin/payments/'+realOrders[0],'/admin/payments/'+realOrders[0]+'/transactions','/admin/entitlements','/admin/usage/current?workspaceId='+ws,'/admin/usage/periods','/admin/usage/requests','/admin/notifications','/admin/operations/status','/admin/audit-logs'];
  for(const path of paths) {const r=await request(path);expect(r.status,path+' '+r.raw).toBe(200);expect(r.body.meta.requestId).toMatch(/^[0-9a-f-]{36}$/);expect(r.raw).not.toMatch(/SECRET_SENTINEL|password_hash|passwordHash|token_hash|tokenHash|checkoutUrl|qrCode|AUTH_ACCESS_SECRET|raw_input|tools_json/);}
  const contracts:Record<string,string>={'/admin/meta':'Vocabulary','/admin/auth/me':'Identity','/admin/auth/sessions':'Sessions','/admin/users':'CustomerPage','/admin/workspaces':'WorkspacePage','/admin/payments':'PaymentPage','/admin/dashboard/overview':'Overview','/admin/dashboard/trends':'Trends','/admin/dashboard/plan-distribution':'PlanDistribution','/admin/dashboard/top-paying-users':'TopPayingUsers','/admin/usage/turns':'TurnPage','/admin/operations/status':'Operations'};
  for(const [path,schema]of Object.entries(contracts)){const r=await request(path);expect(r.status).toBe(200);validateSchema(r.body.data,ADMIN_SCHEMAS[schema]);}
  const {SwaggerModule,DocumentBuilder}=require('@nestjs/swagger');const doc=SwaggerModule.createDocument(app,new DocumentBuilder().build());const adminPaths=Object.entries(doc.paths).filter(([p])=>p.startsWith('/v1/admin/'));expect(adminPaths.reduce((n,[,m])=>n+Object.keys(m as object).length,0)).toBe(36);
  const notices=await request('/admin/users/'+user+'/activity');const note=notices.body.data.items[0];
  if(note) {await operator.$executeRawUnsafe('INSERT INTO public.in_app_notifications(id,recipient_id,workspace_id,financial,event_key,kind,title,summary,detail,target_type,target_id,occurred_at) SELECT id,recipient_id,workspace_id,financial,event_key,kind,title,summary,detail,target_type,target_id,occurred_at FROM public.notification_outbox WHERE id=$1::uuid ON CONFLICT DO NOTHING',note.id);expect((await request('/admin/notifications/'+note.id)).status).toBe(200);}
  const audits=await request('/admin/audit-logs');expect((await request('/admin/audit-logs/'+audits.body.data.items[0].id)).status).toBe(200);
  const sessions=await request('/admin/auth/sessions');expect(sessions.body.data.length).toBeGreaterThan(1);
  const [sessionAudit]=await operator.$queryRawUnsafe<{row_count:number}[]>('SELECT row_count FROM admin.audit_logs WHERE request_id=$1::uuid',sessions.body.meta.requestId);
  expect(sessionAudit.row_count).toBe(sessions.body.data.length);
  for(const path of ['/admin/users/'+randomUUID(),'/admin/workspaces/'+randomUUID(),'/admin/payments/'+randomUUID(),'/admin/notifications/'+randomUUID(),'/admin/audit-logs/'+randomUUID(),'/admin/users/'+randomUUID()+'/workspaces','/admin/workspaces/'+randomUUID()+'/inventory'])expect((await request(path)).status).toBe(404);
 });
 it('two same-price orders total 58000; test/legacy/pending/partial/review excluded; receipts separate',async()=>{
  const spending=await request('/admin/users/'+user+'/spending');expect(spending.body.data.completedPurchases).toBe(2);expect(spending.body.data.completedSpending).toEqual({currency:'VND',amount:'58000'});expect(spending.body.data.refunds).toBeNull();
  const d=await request('/admin/dashboard/overview');expect(d.body.data.completedSales.amount).toBe('58000');expect(d.body.data.verifiedReceipts.amount).toBe('103000');expect(d.body.data.customers.total).toBe(1);expect(d.body.data.customers.allRecords).toBeGreaterThanOrEqual(2);expect(d.body.data.customers.provenanceCounts.UNCLASSIFIED_LEGACY).toBeGreaterThanOrEqual(1);expect(d.body.data.workspaces.total).toBe(1);expect(d.body.data.attention.orders).toBe(2);expect(d.body.data.attention.receivedAmount.amount).toBe('45000');
  expect((await request('/admin/users/'+user+'/spending?provenance=SIMULATED_TEST')).body.data.completedSpending.amount).toBe('29000');expect((await request('/admin/users/'+user+'/spending?provenance=UNCLASSIFIED_LEGACY')).body.data.completedSpending.amount).toBe('29000');
  await operator.$executeRawUnsafe("INSERT INTO public.billing_transactions(channel,reference,order_id,amount,paid_at) VALUES($1,'verified-0',$2::uuid,29000,now()) ON CONFLICT DO NOTHING",'admin-fixture-'+principal,realOrders[0]);
  expect((await request('/admin/dashboard/overview')).body.data.verifiedReceipts.amount).toBe('103000');
  const tops=await request('/admin/dashboard/top-paying-users');expect(tops.body.data.items.find((x:any)=>x.payerId===user).money.amount).toBe('58000');
 });
 it('pagination/cursor/sort/filter/time/IDs strictly validate and binding rejects changed scope',async()=>{
  const a=await request('/admin/payments?limit=1');expect(a.body.data.page.hasMore).toBe(true);
  const next=encodeURIComponent(a.body.data.page.nextCursor);const b=await request('/admin/payments?limit=1&cursor='+next);expect(b.status).toBe(200);expect(b.body.data.items[0].id).not.toBe(a.body.data.items[0].id);
  for(const path of ['/admin/users?limit=101','/admin/users?limit=1.5','/admin/users?sort=password_hash','/admin/users?paying=1','/admin/users?status=admin','/admin/users?from=2026-01-01','/admin/users?from=2026-02-30T00:00:00Z&to=2026-03-05T00:00:00Z','/admin/dashboard/trends?timezone=Bad','/admin/dashboard/overview?from=2026-01-01T00:00:00Z','/admin/dashboard/top-paying-users?limit=1e2','/admin/payments/'+realOrders[0]+'/transactions?limit=1e2','/admin/dashboard/trends?from=2025-01-01T00:00:00Z&to=2026-02-01T00:00:00Z','/admin/payments?cursor=bad','/admin/users?cursor='+next,'/admin/payments?status=PENDING&cursor='+next,'/admin/users/not-uuid','/admin/meta?unexpected=1'])expect((await request(path)).status,path).toBe(400);
  expect((await request('/admin/users?q='+encodeURIComponent("' OR 1=1 --"))).body.data.items).toEqual([]);
 });
 it('D01 admin inventory never turns unknown sentinel or incompatible units into a total',async()=>{
  const cases=[
   {name:'empty',lots:[],quantity:'0',state:'empty'},
   {name:'known',lots:[{quantity:2,known:true,unit:'kg'}],quantity:'2.000',state:'known'},
   {name:'unknown',lots:[{quantity:1,known:false,unit:'kg'}],quantity:null,state:'unknown'},
   {name:'mixed',lots:[{quantity:2,known:true,unit:'kg'},{quantity:1,known:false,unit:'kg'}],quantity:null,state:'mixed'},
   {name:'units',lots:[{quantity:2,known:true,unit:'kg'},{quantity:500,known:true,unit:'g'}],quantity:null,state:'incompatible_units'},
  ];
  for(const c of cases){
   const p=await operator.product.create({data:{workspaceId:ws,name:'D01 '+c.name,nameNormalized:'d01 '+c.name}});
   for(const lot of c.lots)await operator.inventoryLot.create({data:{workspaceId:ws,productId:p.id,quantity:lot.quantity,quantityKnown:lot.known,unit:lot.unit}});
  }
  const response=await request('/admin/workspaces/'+ws+'/inventory');expect(response.status).toBe(200);
  for(const c of cases){
   const row=response.body.data.items.find((r:any)=>r.name==='D01 '+c.name);expect(row).toBeDefined();validateSchema(row,ADMIN_SCHEMAS.Inventory);
   // Numeric strings remain exact; null remains unknown, not the sentinel1.000.
   expect(row.quantity===null?null:Number(row.quantity)).toBe(c.quantity===null?null:Number(c.quantity));
   expect(row.quantityState).toBe(c.state);
   expect(row.quantityBreakdown).toHaveLength(c.state==='empty'?0:c.state==='incompatible_units'?2:1);
   if(c.state==='mixed')expect(row.quantityBreakdown[0]).toMatchObject({knownQuantity:'2.000',unknownLots:1});
  }
 });
 it('business reads preserve customer scope and write no orders/grants/usage/notifications',async()=>{
  // Other CI workers legitimately write their own customer fixtures. Compare
  // all data owned by these customers/workspaces, while the next test proves
  // the admin role has no business-write privileges in any tenant.
  const counts=()=>operator.$queryRawUnsafe('SELECT (SELECT count(*) FROM public.billing_orders WHERE workspace_id=ANY($1::uuid[]))::text orders,(SELECT count(*) FROM public.billing_grants WHERE workspace_id=ANY($1::uuid[]))::text grants,(SELECT sum(used) FROM public.assistant_quota_periods WHERE workspace_id=ANY($1::uuid[]))::text usage,(SELECT count(*) FROM public.notification_outbox WHERE workspace_id=ANY($1::uuid[]) OR recipient_id=ANY($2::uuid[]))::text outbox,(SELECT count(*) FROM public.in_app_notifications WHERE read_at IS NOT NULL AND (workspace_id=ANY($1::uuid[]) OR recipient_id=ANY($2::uuid[])))::text reads',[ws,otherWs],[user,other]);
  const before=await counts();for(const p of ['/admin/dashboard/overview','/admin/workspaces/'+ws,'/admin/usage/current?workspaceId='+ws,'/admin/notifications','/admin/operations/status'])expect((await request(p)).status).toBe(200);expect(await counts()).toEqual(before);
  expect((await request('/workspaces/'+otherWs+'/inventory','GET',undefined,{Authorization:'Bearer '+customerToken})).status).toBe(403);
  const r=await request('/me','GET',undefined,{Authorization:'Bearer '+customerToken});expect(r.status).toBe(200);expect(r.body.workspaceId).toBe(ws);
 });
 // ---- Homepage feedback popup (admin surface). The admin-v1 contract itself is unchanged: 36 operations. ----
 it('feedback popup admin routes deny guests and customer tokens, and the documented admin contract is untouched',async()=>{
  for(const [method,path] of [['GET','/admin/feedback-popup'],['PATCH','/admin/feedback-popup'],['GET','/admin/feedback-popup/submissions'],['GET','/admin/feedback-popup/submissions/'+randomUUID()]]) {
   const body=method==='PATCH'?{enabled:true}:undefined;
   expect((await request(path,method,body,{Cookie:'','X-HomeMind-Admin-CSRF':''})).status,method+' '+path).toBe(401);
   expect((await request(path,method,body,{Cookie:'',Authorization:'Bearer '+customerToken,'X-HomeMind-Admin-CSRF':''})).status,method+' '+path).toBe(401);
  }
  const {SwaggerModule,DocumentBuilder}=require('@nestjs/swagger');const doc=SwaggerModule.createDocument(app,new DocumentBuilder().build());
  expect(Object.keys(doc.paths).filter(p=>p.includes('feedback-popup')&&p.startsWith('/v1/admin/'))).toEqual([]);
 },30000);
 it('feedback popup toggle: strict body, CSRF and origin, optimistic revision, audited, and the public switch follows',async()=>{
  await login();process.env.FEEDBACK_POPUP_SUBMIT_RATE_LIMIT='1000';process.env.FEEDBACK_POPUP_CONFIG_RATE_LIMIT='1000';
  const release=await acquireCampaignLock(operator);
  const pub=(method='GET',body?:object)=>request('/public/feedback-popup'+(method==='POST'?'/submissions':''),method,body,{Cookie:'','X-HomeMind-Admin-CSRF':'',Origin:'https://homemind.vn'});
  try {
   await operator.$executeRawUnsafe('UPDATE public.feedback_popup_campaigns SET enabled=false,revision=revision+1');
   const config=await request('/admin/feedback-popup');expect(config.status).toBe(200);
   expect(Object.keys(config.body.data).sort()).toEqual(['campaignId','createdAt','durationSeconds','enabled','lastChange','plan','planName','revision','updatedAt','updatedBy']);
   expect(config.body.data).toMatchObject({campaignId:'homepage-feedback-premium-30d',enabled:false,plan:'personal',planName:'Premium',durationSeconds:2592000});
   expect(config.body.meta).toMatchObject({version:'admin-v1'});expect(config.headers.get('cache-control')).toBe('private, no-store');
   const preflight=await request('/admin/feedback-popup','OPTIONS',undefined,{'Access-Control-Request-Method':'PATCH','Access-Control-Request-Headers':'content-type, x-homemind-admin-csrf'});
   expect(preflight.status).toBe(204);expect(preflight.headers.get('access-control-allow-methods')).toBe('GET, PATCH');expect(preflight.headers.get('access-control-allow-credentials')).toBe('true');
   expect((await request('/admin/meta','OPTIONS',undefined,{'Access-Control-Request-Method':'PATCH'})).status).toBe(400); // PATCH exists nowhere else
   expect((await request('/admin/users','OPTIONS',undefined,{'Access-Control-Request-Method':'PATCH'})).status).toBe(400);
   expect((await request('/admin/feedback-popup','PATCH',{enabled:true},{'X-HomeMind-Admin-CSRF':''})).status).toBe(403);
   expect((await request('/admin/feedback-popup','PATCH',{enabled:true},{Origin:'https://evil.example'})).status).toBe(403);
   for(const body of [{},{enabled:'true'},{enabled:1},{enabled:true,role:'SYSTEM_ADMIN'},{enabled:true,plan:'family'},{enabled:true,durationSeconds:1},{enabled:true,expectedRevision:0},{enabled:true,expectedRevision:'1'},{enabled:true,expectedRevision:1.5}]) {
    const r=await request('/admin/feedback-popup','PATCH',body);expect(r.status,JSON.stringify(body)).toBe(400);expect(r.body.error.code).toBe('INVALID_REQUEST');
   }
   const revision=config.body.data.revision;
   const stale=await request('/admin/feedback-popup','PATCH',{enabled:true,expectedRevision:revision+7});expect(stale.status).toBe(409);expect(stale.body.error.code).toBe('CONFIG_REVISION_CONFLICT');
   const publicView=await pub();expect(publicView.body.enabled).toBe(false);
   expect(config.body.data.updatedAt).toBe(publicView.body.updatedAt); // same instant, millisecond precision in both views
   const on=await request('/admin/feedback-popup','PATCH',{enabled:true,expectedRevision:revision});
   expect(on.status).toBe(200);expect(on.body.data).toMatchObject({enabled:true,revision:revision+1,changed:true,updatedBy:principal});
   const repeat=await request('/admin/feedback-popup','PATCH',{enabled:true});expect(repeat.body.data).toMatchObject({enabled:true,revision:revision+1,changed:false});
   expect((await pub()).body).toMatchObject({enabled:true,revision:revision+1});
   expect((await request('/admin/feedback-popup')).body.data.lastChange).toMatchObject({actorId:principal,previousEnabled:false,enabled:true,previousRevision:revision,revision:revision+1});
   const accepted=await pub('POST',{fullName:'Admin Fixture',phoneNumber:'+84911000011',email:'fp-toggle-'+randomUUID()+'@fp-admin.example',review:'Toggle fixture'});expect(accepted.status).toBe(202);
   const off=await request('/admin/feedback-popup','PATCH',{enabled:false});expect(off.body.data).toMatchObject({enabled:false,revision:revision+2,changed:true});
   const refused=await pub('POST',{fullName:'Admin Fixture',phoneNumber:'+84911000012',email:'fp-toggle-'+randomUUID()+'@fp-admin.example',review:'Disabled'});
   expect(refused.status).toBe(409);expect(refused.body.error.code).toBe('FEEDBACK_POPUP_DISABLED');expect((await pub()).status).toBe(200);
   const events=await operator.$queryRawUnsafe<any[]>('SELECT previous_enabled,enabled,previous_revision,revision FROM public.feedback_popup_config_events WHERE actor_id=$1::uuid AND revision>$2 ORDER BY revision',principal,revision);
   expect(events).toEqual([{previous_enabled:false,enabled:true,previous_revision:revision,revision:revision+1},{previous_enabled:true,enabled:false,previous_revision:revision+1,revision:revision+2}]);
   const audits=await operator.$queryRawUnsafe<any[]>("SELECT outcome,row_count FROM admin.audit_logs WHERE actor_id=$1::uuid AND action LIKE 'PATCH %feedback-popup' ORDER BY occurred_at",principal);
   expect(audits.filter(x=>x.outcome==='SUCCESS').length).toBeGreaterThanOrEqual(3);expect(audits.some(x=>x.outcome==='ERROR')).toBe(true);
   expect(await operator.$queryRawUnsafe('SELECT count(*)::int n FROM public.feedback_popup_campaigns')).toEqual([{n:1}]);
  } finally {
   await operator.$executeRawUnsafe("DELETE FROM public.feedback_popup_rewards WHERE submission_id IN(SELECT id FROM public.feedback_popup_submissions WHERE email LIKE '%@fp-admin.example')");
   await operator.$executeRawUnsafe("DELETE FROM public.feedback_popup_submissions WHERE email LIKE '%@fp-admin.example'");
   await operator.$executeRawUnsafe('UPDATE public.feedback_popup_campaigns SET enabled=false');
   delete process.env.FEEDBACK_POPUP_SUBMIT_RATE_LIMIT;delete process.env.FEEDBACK_POPUP_CONFIG_RATE_LIMIT;await release();
  }
 },30000);
 it('feedback popup submissions: paginated, filtered, detailed; reward time never appears as a purchased entitlement',async()=>{
  await login();process.env.FEEDBACK_POPUP_SUBMIT_RATE_LIMIT='1000';
  const release=await acquireCampaignLock(operator);
  let account:{id:string;ws:string}|undefined;
  try {
   await operator.$executeRawUnsafe('UPDATE public.feedback_popup_campaigns SET enabled=true,revision=revision+1');
   const mail='fp-list-'+randomUUID()+'@fp-admin.example';account=await register(mail);
   const post=(body:object)=>request('/public/feedback-popup/submissions','POST',body,{Cookie:'','X-HomeMind-Admin-CSRF':'',Origin:'https://homemind.vn'});
   const stranger='fp-stranger-'+randomUUID()+'@fp-admin.example';
   const bodies=[{fullName:'Nguyễn Thị Hoa',phoneNumber:'0912000111',email:mail,review:'Review A '+'dài '.repeat(100)},{fullName:'Trần Văn Bình',phoneNumber:'0912000222',email:stranger,review:'Review B'},{fullName:'Lê Thu Cúc',phoneNumber:'+84912000333',email:mail,review:'Review C'}];
   const ids:string[]=[];for(const b of bodies){const r=await post(b);expect(r.status,r.raw).toBe(202);ids.push(r.body.submissionId);await new Promise(done=>setTimeout(done,150));}
   const all=await request('/admin/feedback-popup/submissions?limit=100');expect(all.status).toBe(200);
   expect(all.body.meta).toMatchObject({version:'admin-v1'});
   const mine=all.body.data.items.filter((x:any)=>ids.includes(x.id));expect(mine.map((x:any)=>x.id)).toEqual([...ids].reverse()); // newest first
   expect(mine.map((x:any)=>x.benefit.state)).toEqual(['DUPLICATE','PENDING_ACCOUNT','ACTIVE']);
   expect(mine.every((x:any)=>!('review' in x)&&typeof x.reviewPreview==='string'&&x.reviewPreview.length<=200&&x.reviewLength>0)).toBe(true);
   expect(mine[2].reviewLength).toBeGreaterThan(200);
   expect(mine[0]).toMatchObject({fullName:'Lê Thu Cúc',email:mail,phoneNumber:'+84912000333',duplicate:true,benefit:{state:'DUPLICATE',reason:'ACCOUNT_ALREADY_REWARDED',plan:'personal',userId:account.id}});
   expect(mine[2].benefit).toMatchObject({state:'ACTIVE',userId:account.id,workspaceId:account.ws,plan:'personal',postponed:false});
   expect(mine[2].lifecycle).toMatchObject({accountId:account.id,sourceSubmissionId:ids[0],logicalRewardCount:1,submissionCount:2,allotmentConsumed:true,segmentCount:1,durationBudgetSeconds:2592000,allocatedSeconds:2592000,featureUsage:{status:'NOT_TRACKED',used:null}});
   expect(mine[0].lifecycle.rewardId).toBe(mine[2].lifecycle.rewardId);
   expect(mine[0].lifecycle.awardedAt).toBe(mine[2].lifecycle.awardedAt);
   expect(mine[1].lifecycle).toMatchObject({rewardId:null,accountId:null,accountCreatedAt:null,linkedAt:null,awardedAt:null,logicalRewardCount:0,submissionCount:1,segmentCount:0,elapsedSeconds:null,remainingSeconds:null});
   expect(mine[2].lifecycle.elapsedSeconds+mine[2].lifecycle.remainingSeconds).toBeCloseTo(2592000,4);
   expect(new Date(mine[2].benefit.endsAt).getTime()-new Date(mine[2].benefit.startsAt).getTime()).toBe(30*86400000);
   expect(new Date(mine[2].submittedAt).toISOString()).toBe(mine[2].submittedAt);
   // pagination with a stable cursor, both directions
   const page1=await request('/admin/feedback-popup/submissions?limit=1');expect(page1.body.data.page).toMatchObject({limit:1,hasMore:true});
   const page2=await request('/admin/feedback-popup/submissions?limit=1&cursor='+encodeURIComponent(page1.body.data.page.nextCursor));
   expect(page2.status).toBe(200);expect(page2.body.data.items[0].id).not.toBe(page1.body.data.items[0].id);
   expect((await request('/admin/feedback-popup/submissions?limit=1&sort=oldest')).body.data.items[0].submittedAt<=page1.body.data.items[0].submittedAt).toBe(true);
   // filters
   const by=async(query:string)=>(await request('/admin/feedback-popup/submissions?limit=100&'+query)).body.data.items.map((x:any)=>x.id).filter((id:string)=>ids.includes(id));
   expect(await by('benefitState=ACTIVE')).toEqual([ids[0]]);expect(await by('benefitState=PENDING_ACCOUNT')).toEqual([ids[1]]);
   expect(await by('duplicate=true')).toEqual([ids[2]]);expect((await by('duplicate=false')).sort()).toEqual([ids[0],ids[1]].sort());
   expect((await by('userId='+account.id)).sort()).toEqual([ids[0],ids[2]].sort());
   expect(await by('q='+encodeURIComponent('Trần Văn'))).toEqual([ids[1]]);expect(await by('q='+encodeURIComponent(stranger.slice(0,20)))).toEqual([ids[1]]);
   expect(await by('q='+encodeURIComponent('0912000222'))).toEqual([ids[1]]); // local notation finds the canonical +84 phone
   expect(await by('q=%25')).toEqual([]);expect(await by('q='+encodeURIComponent("' OR 1=1 --"))).toEqual([]);
   const t=new Date(mine[1].submittedAt);
   expect(await by('from='+encodeURIComponent(new Date(t.getTime()-60).toISOString())+'&to='+encodeURIComponent(new Date(t.getTime()+60).toISOString()))).toEqual([ids[1]]);
   for(const bad of ['limit=0','limit=101','limit=1.5','limit=abc','sort=password_hash','benefitState=BOGUS','userId=not-a-uuid','from=2026-01-01T00:00:00Z','duplicate=maybe','role=SYSTEM_ADMIN','cursor=tampered','q='+'x'.repeat(121)]) expect((await request('/admin/feedback-popup/submissions?'+bad)).status,bad).toBe(400);
   expect((await request('/admin/feedback-popup/submissions?cursor='+encodeURIComponent(page1.body.data.page.nextCursor)+'&sort=oldest')).status).toBe(400); // cursor is bound to its query
   // detail
   const detail=await request('/admin/feedback-popup/submissions/'+ids[0]);expect(detail.status).toBe(200);
   expect(detail.body.data.review).toBe(bodies[0].review.trim()); // input is trimmed, never truncated
   expect(detail.body.data.reviewLength).toBe(Array.from(bodies[0].review.trim()).length);expect(detail.body.data.segments).toHaveLength(1);
   expect(detail.body.data.segments[0]).toMatchObject({supersededAt:null,supersededBy:null});
   expect((await request('/admin/feedback-popup/submissions/'+randomUUID())).status).toBe(404);
   expect((await request('/admin/feedback-popup/submissions/not-a-uuid')).status).toBe(400);
   const repeatDetail=await request('/admin/feedback-popup/submissions/'+ids[2]);
   expect(repeatDetail.body.data.segments).toEqual([]); // Old per-decision segment contract stays unchanged.
   expect(repeatDetail.body.data.lifecycle.sourceSubmissionId).toBe(ids[0]);
   expect(JSON.stringify([all.body,detail.body])).not.toMatch(/password|token_hash|ip_hash|idempotency|payload_hash/i);
   // the existing admin contract: purchased entitlements only, paid fields stay paid-only, schemas still hold
   const entitlements=await request('/admin/entitlements?userId='+account.id);expect(entitlements.status).toBe(200);
   expect(entitlements.body.data.items).toEqual([]);validateSchema(entitlements.body.data,ADMIN_SCHEMAS.EntitlementPage);
   const workspace=await request('/admin/workspaces/'+account.ws);validateSchema(workspace.body.data,ADMIN_SCHEMAS.Workspace);
   expect(workspace.body.data).toMatchObject({plan:'personal',grantId:null,paidExpiresAt:null});expect(workspace.body.data.quota.total).toBe(60);
   const overview=await request('/admin/dashboard/overview');validateSchema(overview.body.data,ADMIN_SCHEMAS.Overview);
  } finally {
   if(account)await operator.$transaction(async tx=>{
    await tx.$executeRawUnsafe("DELETE FROM public.billing_grants WHERE workspace_id=$1::uuid",account!.ws);
    await tx.$executeRawUnsafe("DELETE FROM public.feedback_popup_rewards WHERE submission_id IN(SELECT id FROM public.feedback_popup_submissions WHERE email LIKE '%@fp-admin.example')");
    await tx.$executeRawUnsafe("DELETE FROM public.feedback_popup_submissions WHERE email LIKE '%@fp-admin.example'");
    await tx.$executeRawUnsafe('DELETE FROM public.workspaces WHERE id=$1::uuid',account!.ws);await tx.$executeRawUnsafe('DELETE FROM public.users WHERE id=$1::uuid',account!.id);
   });
   await operator.$executeRawUnsafe('UPDATE public.feedback_popup_campaigns SET enabled=false');delete process.env.FEEDBACK_POPUP_SUBMIT_RATE_LIMIT;await release();
  }
 },30000);
 it('feedback popup: the admin DB role reads only the allowed columns and can execute exactly one audited write',async()=>{
  const db=new PrismaClient({datasourceUrl:process.env.ADMIN_DATABASE_URL});
  const forbidden=["INSERT INTO public.feedback_popup_submissions(campaign_id,full_name,email,phone,review,payload_hash,submitted_at) VALUES('homepage-feedback-premium-30d','x','x@x.xx','+84912345678','x',repeat('a',64),now())","UPDATE public.feedback_popup_campaigns SET enabled=true","DELETE FROM public.feedback_popup_campaigns","DELETE FROM public.feedback_popup_rewards","UPDATE public.feedback_popup_rewards SET state='GRANTED'","INSERT INTO public.billing_grants(workspace_id,plan,starts_at,expires_at,price_snapshot) VALUES(gen_random_uuid(),'personal',now(),now()+interval '1 day','{}')","SELECT ip_hash FROM public.feedback_popup_submissions","SELECT idempotency_key FROM public.feedback_popup_submissions","SELECT payload_hash FROM public.feedback_popup_submissions","SELECT * FROM public.feedback_popup_claim_retries","SELECT public.feedback_popup_submit('homepage-feedback-premium-30d','a','a@a.aa','+84912345678','r',NULL,repeat('a',64),NULL,NULL,NULL)","SELECT public.feedback_popup_reconcile(1)","SELECT public.feedback_popup_bind_at(gen_random_uuid(),gen_random_uuid(),now())","SELECT public.feedback_popup_claim_at(gen_random_uuid(),now())"];
  for(const sql of forbidden)await expect(db.$queryRawUnsafe(sql),sql).rejects.toThrow();
  await expect(db.$queryRawUnsafe('SELECT public.feedback_popup_admin_set(true,NULL,gen_random_uuid(),gen_random_uuid())')).rejects.toThrow(); // the actor must be a real admin principal
  expect(await db.$queryRawUnsafe('SELECT count(*)::int n FROM public.feedback_popup_campaigns')).toEqual([{n:1}]);
  await expect(db.$queryRawUnsafe('SELECT nomination_key FROM public.feedback_popup_rewards')).rejects.toThrow();
  expect(Array.isArray(await db.$queryRawUnsafe('SELECT logical_reward_id,allotment_consumed,awarded_at FROM public.feedback_popup_rewards LIMIT 1'))).toBe(true);
  expect(Array.isArray(await db.$queryRawUnsafe('SELECT id,review,full_name FROM public.feedback_popup_submissions LIMIT 1'))).toBe(true);
  await db.$disconnect();
 },30000);
 it('DB role cannot read credentials/business content or write/escalate; read context cleans up',async()=>{
  const db=new PrismaClient({datasourceUrl:process.env.ADMIN_DATABASE_URL});
  for(const sql of ['SELECT password_hash FROM public.users','SELECT token_hash FROM public.refresh_sessions','SELECT checkout_url FROM public.billing_orders','SELECT raw_input FROM public.assistant_turns','UPDATE public.users SET status=status','UPDATE public.workspace_entitlements SET plan=plan','DELETE FROM public.billing_orders','INSERT INTO admin.principals(bootstrap_key,email,password_hash) VALUES(\'initial\',\'x@example.invalid\',\'x\')','SET ROLE homemind_migrator',"UPDATE admin.customer_scope SET provenance='REAL'","UPDATE admin.workspace_scope SET provenance='REAL'"])await expect(db.$executeRawUnsafe(sql)).rejects.toThrow();
  const [role]=await db.$queryRawUnsafe<{super:boolean;bypass:boolean}[]>("SELECT rolsuper super,rolbypassrls bypass FROM pg_roles WHERE rolname=current_user");expect(role).toEqual({super:false,bypass:false});
  expect((await db.$queryRawUnsafe("SELECT current_setting('app.user_id',true) context")) as any[]).toEqual([{context:null}]);await db.$disconnect();
 });
 it('invalid login is generic, rate limit bounded, unknown body/query fails closed',async()=>{
  const saved={cookie,csrf};
  cookie='';csrf='';const challenge=await request('/admin/auth/csrf');cookie=challenge.headers.getSetCookie()[0].split(';')[0];csrf=challenge.body.data.csrfToken;
  const a=await request('/admin/auth/login','POST',{email,password:'Wrong!'+randomBytes(20).toString('hex')});
  const b=await request('/admin/auth/login','POST',{email:'missing@example.invalid',password:'Wrong!'+randomBytes(20).toString('hex')});expect(a.status).toBe(401);expect(b.status).toBe(401);expect(a.body.error.code).toBe(b.body.error.code);expect(a.body.error.message).toBe(b.body.error.message);
  expect((await request('/admin/auth/login','POST',{email,password,role:'SYSTEM_ADMIN'})).status).toBe(400);
  let throttled=false;for(let i=0;i<11;i++){const r=await request('/admin/auth/login','POST',{email,password:'Wrong!'+randomBytes(20).toString('hex')});if(r.status===429){throttled=true;break;}}expect(throttled).toBe(true);
  cookie=saved.cookie;csrf=saved.csrf;
 });
 it('audit outage/capacity fail closes admin only; timeout releases its transaction',async()=>{
  await login();await operator.$executeRawUnsafe('UPDATE admin.audit_capacity SET row_count=100000 WHERE singleton');
  try {expect((await request('/admin/users')).status).toBe(503);expect((await request('/health/live')).status).toBe(200);expect((await request('/me','GET',undefined,{Authorization:'Bearer '+customerToken})).status).toBe(200);}
  finally{await operator.$executeRawUnsafe('UPDATE admin.audit_capacity SET row_count=(SELECT count(*) FROM admin.audit_logs) WHERE singleton');}
  const {AdminDatabase}=require('../dist/admin/admin.database.js');const db=app.get<any>(AdminDatabase);
  await expect(db.transaction((tx:any)=>tx.$queryRawUnsafe('SELECT pg_sleep(4)'),true)).rejects.toThrow();
  const rows=await db.transaction((tx:any)=>tx.$queryRawUnsafe("SELECT current_setting('transaction_read_only') ro,current_setting('app.user_id',true) context"),true);expect(rows[0]).toEqual({ro:'on',context:null});
 });
 it('free projection, shared membership, paid and expired quota match anchored rules without insertion',async()=>{
  await login();
  await operator.$executeRawUnsafe("INSERT INTO public.workspace_members(workspace_id,user_id,role) VALUES($1::uuid,$2::uuid,'member')",ws,other);
  const before=await operator.$queryRawUnsafe('SELECT count(*)::text n FROM public.assistant_quota_periods WHERE workspace_id=ANY($1::uuid[])',[ws,otherWs]);
  const free=await request('/admin/usage/current?workspaceId='+ws);expect(free.body.data.quota.total).toBe(15);expect(free.body.data.freeLifetimeAccess).toBe(true);expect(free.body.data.quota.remaining).toBe(15);
  expect((await request('/admin/users/'+other+'/workspaces')).body.data.items.find((x:any)=>x.id===ws).membershipRole).toBe('member');
  await operator.$executeRawUnsafe("UPDATE public.workspace_entitlements SET source='billing',plan='personal',product_limit=NULL WHERE workspace_id=$1::uuid",ws);
  const paid=await request('/admin/usage/current?workspaceId='+ws);expect(paid.body.data.plan).toBe('personal');expect(paid.body.data.quota.total).toBe(60);expect(paid.body.data.freeLifetimeAccess).toBe(false);
  const pure=await operator.$queryRawUnsafe<{starts_at:Date;expires_at:Date}[]>('SELECT starts_at,expires_at FROM public.billing_grants WHERE id=$1::uuid',paid.body.data.grantId);
  expect(Date.parse(paid.body.data.quota.startsAt)).toBe(pure[0].starts_at.getTime());
  await operator.$executeRawUnsafe("UPDATE public.billing_grants SET effective_until=now()-interval '1 second',superseded_at=now()-interval '1 second' WHERE workspace_id=$1::uuid",ws);
  const expired=await request('/admin/usage/current?workspaceId='+ws);expect(expired.body.data.plan).toBe('free');expect(expired.body.data.paidExpiresAt).toBeNull();expect(expired.body.data.quota.total).toBe(15);
  expect(await operator.$queryRawUnsafe('SELECT count(*)::text n FROM public.assistant_quota_periods WHERE workspace_id=ANY($1::uuid[])',[ws,otherWs])).toEqual(before);
  expect((await request('/admin/users/'+user+'/spending')).body.data.completedSpending.amount).toBe('58000');
  expect((await request('/admin/users/'+other+'/spending')).body.data.completedSpending.amount).toBe('0');
  await operator.$executeRawUnsafe("UPDATE public.workspace_members SET role=CASE WHEN user_id=$2::uuid THEN 'owner' ELSE 'member' END WHERE workspace_id=$1::uuid",ws,other);
  expect((await request('/admin/users/'+user+'/spending')).body.data.completedSpending.amount).toBe('58000');
  expect((await request('/admin/users/'+other+'/spending')).body.data.completedSpending.amount).toBe('0');
  await operator.$executeRawUnsafe("UPDATE public.workspace_entitlements SET source='legacy_manual',plan='family' WHERE workspace_id=$1::uuid",ws);
  expect((await request('/admin/usage/current?workspaceId='+ws)).body.data.quota.total).toBe(100);
  await operator.$executeRawUnsafe("UPDATE public.workspaces SET type='store' WHERE id=$1::uuid",otherWs);
  await operator.$executeRawUnsafe("UPDATE public.workspace_entitlements SET source='legacy_manual',plan='micro_pos',product_limit=NULL WHERE workspace_id=$1::uuid",otherWs);
  expect((await request('/admin/usage/current?workspaceId='+otherWs)).body.data.quota.total).toBe(200);
 });
 it('simultaneous refresh/replay never leaves two live descendants or an unbounded session',async()=>{
  await operator.$executeRawUnsafe('DELETE FROM admin.login_limits');await login();
  const originalSession=(await request('/admin/auth/me')).body.data.sessionId;
  const pair=await Promise.all([request('/admin/auth/refresh','POST'),request('/admin/auth/refresh','POST')]);
  expect(pair.filter(x=>x.status===200).length).toBeLessThanOrEqual(1);expect(pair.every(x=>[200,401].includes(x.status))).toBe(true);
  const [n]=await operator.$queryRawUnsafe<{n:bigint}[]>('SELECT count(*) n FROM admin.sessions WHERE family_id=(SELECT family_id FROM admin.sessions WHERE id=$1::uuid) AND revoked_at IS NULL',originalSession);expect(Number(n.n)).toBeLessThanOrEqual(1);
  await login();const session=(await request('/admin/auth/me')).body.data.sessionId;await operator.$executeRawUnsafe("UPDATE admin.sessions SET expires_at=now()-interval '1 second' WHERE id=$1::uuid",session);expect((await request('/admin/auth/me')).status).toBe(401);
 });
 it('operator retention removes only approved old records; rotation revokes without reactivation',async()=>{
  const old=randomUUID(),recent=randomUUID();
  await operator.$executeRawUnsafe("INSERT INTO admin.audit_logs(id,request_id,action,outcome,occurred_at) VALUES($1::uuid,gen_random_uuid(),'retention.test','SUCCESS',now()-interval '91 days'),($2::uuid,gen_random_uuid(),'retention.test','SUCCESS',now()-interval '89 days')",old,recent);
  const prune=spawnSync(process.execPath,['scripts/admin-audit-maintain.cjs'],{env:process.env,input:JSON.stringify({maxRows:5000,operation:'prune-audit',retentionDays:90}),encoding:'utf8'});
  expect(prune.status,prune.stderr).toBe(0);expect(JSON.parse(prune.stdout).removed).toBeGreaterThanOrEqual(1);
  expect((await operator.$queryRawUnsafe<any[]>('SELECT id FROM admin.audit_logs WHERE id=ANY($1::uuid[])',[old,recent])).map(x=>x.id)).toEqual([recent]);
  const [capacity]=await operator.$queryRawUnsafe<any[]>('SELECT row_count,(SELECT count(*)::integer FROM admin.audit_logs) actual FROM admin.audit_capacity');expect(capacity.row_count).toBe(capacity.actual);
  const forbidden=spawnSync(process.execPath,['scripts/admin-audit-maintain.cjs'],{env:process.env,input:JSON.stringify({operation:'prune-audit',retentionDays:1,maxRows:5000}),encoding:'utf8'});expect(forbidden.status).toBe(1);
  await login();await operator.$executeRawUnsafe("UPDATE admin.principals SET status='DISABLED' WHERE id=$1::uuid",principal);
  const rotated=spawnSync(process.execPath,['scripts/admin-operator.cjs'],{env:process.env,input:JSON.stringify({email,password,operation:'rotate'}),encoding:'utf8'});expect(rotated.status).toBe(0);expect(JSON.parse(rotated.stdout).adminStatus).toBe('DISABLED');expect((await request('/admin/auth/me')).status).toBe(401);
  await operator.$executeRawUnsafe("UPDATE admin.principals SET status='ACTIVE' WHERE id=$1::uuid",principal);await login();
 });
 it('refresh rotates, replay revokes family; logout/all/own revoke/disabled/expiry deny immediately',async()=>{
  await login();const oldCookie=cookie,oldCsrf=csrf;const refresh=await request('/admin/auth/refresh','POST');expect(refresh.status).toBe(200);cookie=refresh.headers.getSetCookie()[0].split(';')[0];csrf=refresh.body.data.csrfToken;
  expect((await request('/admin/auth/me')).status).toBe(200);expect((await request('/admin/auth/refresh','POST',undefined,{Cookie:oldCookie,'X-HomeMind-Admin-CSRF':oldCsrf})).status).toBe(401);expect((await request('/admin/auth/me')).status).toBe(401);
  await login();const me=await request('/admin/auth/me');expect((await request('/admin/auth/sessions/'+me.body.data.sessionId,'DELETE')).status).toBe(200);expect((await request('/admin/auth/me')).status).toBe(401);
  await login();await operator.$executeRawUnsafe("UPDATE admin.principals SET status='DISABLED' WHERE id=$1::uuid",principal);expect((await request('/admin/auth/me')).status).toBe(401);await operator.$executeRawUnsafe("UPDATE admin.principals SET status='ACTIVE' WHERE id=$1::uuid",principal);
  await login();const s=(await request('/admin/auth/me')).body.data.sessionId;await operator.$executeRawUnsafe("UPDATE admin.sessions SET last_seen_at=now()-interval '16 minutes' WHERE id=$1::uuid",s);expect((await request('/admin/auth/me')).status).toBe(401);
  await login();expect((await request('/admin/auth/logout','POST')).status).toBe(200);expect((await request('/admin/auth/me')).status).toBe(401);
  await login();expect((await request('/admin/auth/logout-all','POST')).status).toBe(200);expect((await request('/admin/auth/me')).status).toBe(401);
 });
});
