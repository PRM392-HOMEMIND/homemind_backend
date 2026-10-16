import { installMockEmailAuth, verifyHttpRegistration } from './support/email-auth-fixture';
import 'reflect-metadata';
import { deleteFixtureUsers } from './support/delete-fixture-users';
import { randomBytes,randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { INestApplication,ValidationPipe } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { requireDisposableDatabase } from './disposable-database';

describe.skipIf(process.env.RUN_DB_TESTS!=='1')('Family: real HTTP, isolated PostgreSQL, all providers OFF',()=>{
 let emailAuth:any;
 const db=new PrismaClient({datasourceUrl:process.env.MIGRATION_DATABASE_URL});
 const accounts:Array<{id:string;ws:string;email:string;token:string;password:string}>=[];
 let app:INestApplication,base:string;
 type Account=typeof accounts[number];
 const call=async(a:Account,path:string,method='GET',body?:object,key:string=randomUUID())=>{
  const r=await fetch(base+path,{method,headers:{Authorization:'Bearer '+a.token,'Content-Type':'application/json','Idempotency-Key':key},body:body?JSON.stringify(body):undefined});
  return {status:r.status,body:await r.json()};
 };
 async function account(plan='free'){
  const email='family-test-'+randomUUID()+'@example.invalid',password=randomBytes(30).toString('hex');
  const r=await fetch(base+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password,displayName:'Local Family fixture',acceptedTerms:true,acceptedPrivacy:true})});
  expect(r.status).toBe(201);const data=await verifyHttpRegistration(base,emailAuth,await r.json(),email);
  const a={id:data.user.id,email,password,token:data.accessToken,ws:''};accounts.push(a);
  a.ws=(await call(a,'/me')).body.workspaceId;
  await db.$executeRaw`insert into admin.customer_scope(user_id,provenance) values(${a.id}::uuid,'SIMULATED_TEST')`;
  await db.$executeRaw`insert into admin.workspace_scope(workspace_id,provenance) values(${a.ws}::uuid,'SIMULATED_TEST')`;
  if(plan!=='free')await db.$executeRaw`update public.workspace_entitlements set plan=${plan},product_limit=null,source='legacy_manual' where workspace_id=${a.ws}::uuid`;
  return a;
 }
 async function invite(owner:Account,member:Account,key?:string){return call(owner,`/workspaces/${owner.ws}/invitations`,'POST',{email:member.email},key);}
 async function accept(a:Account,id:string,key?:string){return call(a,`/me/workspace-invitations/${id}/accept`,'POST',undefined,key);}
 beforeAll(async()=>{
  requireDisposableDatabase();expect(process.env.PAYOS_ENABLED).toBe('false');expect(process.env.GEMINI_API_KEY??'').toBe('');
  if(process.env.HOMEMIND_ISOLATED_CI!=='1'){
  const built=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.build.json'],{encoding:'utf8'});if(built.status!==0)throw Error('Backend compile failed');
  }
  const {AppModule}=require('../dist/app.module.js'),{ApiErrorFilter}=require('../dist/common/api-error.filter.js');
  app=await NestFactory.create(AppModule,{logger:false});emailAuth=installMockEmailAuth(app);app.setGlobalPrefix('v1');app.useGlobalPipes(new ValidationPipe({transform:true,whitelist:true,forbidNonWhitelisted:true}));app.useGlobalFilters(new ApiErrorFilter());
  await app.listen(0,'127.0.0.1');base=await app.getUrl()+'/v1';
 },30000);
 afterAll(async()=>{
  if(app)await app.close();
  // Delete only synthetic fixture identities; new family foreign keys deliberately preserve history.
  const ids=accounts.map(a=>a.id),ws=accounts.map(a=>a.ws);
  await db.$executeRaw`delete from public.family_validation_limits where owner_id=any(${ids}::uuid[])`;
  await db.$executeRaw`delete from public.family_operations where actor_id=any(${ids}::uuid[])`;
  await db.$executeRaw`delete from public.family_refusals where inviter_id=any(${ids}::uuid[]) or invitee_id=any(${ids}::uuid[])`;
  await db.$executeRaw`delete from public.family_groups where workspace_id=any(${ws}::uuid[])`;
  await deleteFixtureUsers(db,ids,ws);await db.$disconnect();
 });
 it('keeps purchase OFF even for a synthetic eligible owner',async()=>{
  const owner=await account('family');const r=await call(owner,`/workspaces/${owner.ws}/billing/payments`,'POST',{priceId:'family-month-v2',transition:'immediate_upgrade'});
  expect(r.status).toBe(403);expect(r.body.error.code).toBe('BILLING_DISTRIBUTION_DISABLED');expect(await db.billingOrder.count({where:{workspaceId:owner.ws}})).toBe(0);
 });
 it('accepts Free/Premium, selects Family, keeps private data, denies peer editing then returns Free',async()=>{
  const owner=await account('family'),relative=await account('personal'),outsider=await account();
  const own=await call(relative,`/workspaces/${relative.ws}/inventory/items`,'POST',{productName:'Private rice',quantity:2,unit:'kg',priceVnd:0});expect(own.status).toBe(201);
  const created=await invite(owner,relative);expect(created.status).toBe(201);
  expect((await call(relative,'/me/workspace-invitations')).body.items.some((i:any)=>i.id===created.body.invitationId)).toBe(true);
  const key=randomUUID();expect((await accept(relative,created.body.invitationId,key)).status).toBe(200);
  expect((await accept(relative,created.body.invitationId,key)).body.replayed).toBe(true);
  expect((await call(relative,'/me')).body).toMatchObject({workspaceId:owner.ws,role:'member',plan:'family',productLimit:null});
  expect((await call(outsider,`/workspaces/${owner.ws}/family`)).status).toBe(403);
  const dir=await call(relative,`/workspaces/${owner.ws}/family`);expect(dir.status).toBe(200);expect(dir.body.members).toHaveLength(2);
  for(const m of dir.body.members){expect(m).not.toHaveProperty('email');expect(m).not.toHaveProperty('phone');expect(m).not.toHaveProperty('address');}
  expect((await call(relative,`/workspaces/${owner.ws}/inventory`)).body.items.some((i:any)=>i.name==='Private rice')).toBe(false);
  const entry=await call(relative,`/workspaces/${owner.ws}/shopping-items`,'POST',{name:'Relative item'});expect(entry.status).toBe(201);
  const item=entry.body.created.shoppingItemIds[0];
  expect((await call(owner,`/workspaces/${owner.ws}/shopping-items/${item}`,'PATCH',{status:'skipped'})).status).toBe(403);
  expect((await call(owner,`/workspaces/${owner.ws}/family/members/${relative.id}`,'DELETE')).status).toBe(200);
  expect((await call(relative,'/me')).body).toMatchObject({workspaceId:relative.ws,plan:'free',productLimit:30});
  expect((await call(relative,`/workspaces/${owner.ws}/shopping-items`)).status).toBe(403);
  expect((await call(relative,`/workspaces/${relative.ws}/inventory`)).body.items.some((i:any)=>i.name==='Private rice')).toBe(true);
  expect((await call(owner,`/workspaces/${owner.ws}/shopping-items`)).body.items.some((i:any)=>i.id===item)).toBe(true);
 });
 it('reserves five seats transactionally, handles duplicate keys and concurrent last seats',async()=>{
  const owner=await account('family'),relatives=await Promise.all(Array.from({length:6},()=>account()));
  const key=randomUUID(),first=await invite(owner,relatives[0],key);expect(first.status).toBe(201);
  expect((await invite(owner,relatives[0],key)).body.invitationId).toBe(first.body.invitationId);
  expect((await invite(owner,relatives[0])).status).toBe(409);
  const results=await Promise.all(relatives.slice(1).map(a=>invite(owner,a)));
  expect(results.filter(r=>r.status===201)).toHaveLength(4);expect(results.filter(r=>r.status===409&&r.body.error.code==='FAMILY_FULL')).toHaveLength(1);
  expect((await call(owner,`/workspaces/${owner.ws}/family`)).body).toMatchObject({relativeCount:0,pendingCount:5,availableSeats:0});
  expect((await accept(relatives[0],first.body.invitationId)).status).toBe(200);
  expect((await call(owner,`/workspaces/${owner.ws}/family`)).body).toMatchObject({relativeCount:1,pendingCount:4,availableSeats:0});
 });
 it('three real refusals block 24h, retries do not count, email changes do not bypass, new cycle after boundary',async()=>{
  const owner=await account('family'),relative=await account();
  for(let i=1;i<=3;i++){
   const invitation=await invite(owner,relative);expect(invitation.status).toBe(201);
   const path=`/me/workspace-invitations/${invitation.body.invitationId}/decline`,key=randomUUID();
   expect((await call(relative,path,'POST',undefined,key)).status).toBe(200);expect((await call(relative,path,'POST',undefined,key)).status).toBe(200);
   expect((await call(relative,path,'POST')).status).toBe(200);
  }
  const stored=await db.$queryRaw<Array<{declines:number;blocked_until:Date}>>`select declines,blocked_until from public.family_refusals where inviter_id=${owner.id}::uuid and invitee_id=${relative.id}::uuid`;
  expect(stored[0].declines).toBe(3);expect(stored[0].blocked_until.getTime()-Date.now()).toBeGreaterThan(86390000);
  relative.email='renamed-'+randomUUID()+'@example.invalid';await db.user.update({where:{id:relative.id},data:{email:relative.email}});
  const blocked=await invite(owner,relative);expect(blocked.status).toBe(409);expect(blocked.body.error).toMatchObject({code:'FAMILY_INVITE_COOLDOWN',details:{blockedUntil:expect.any(String)}});
  await db.$executeRaw`update public.family_refusals set blocked_until=clock_timestamp()-interval '1 millisecond' where inviter_id=${owner.id}::uuid and invitee_id=${relative.id}::uuid`;
  const again=await invite(owner,relative);expect(again.status).toBe(201);
  expect((await call(relative,`/me/workspace-invitations/${again.body.invitationId}/decline`,'POST')).status).toBe(200);
  expect((await db.$queryRaw<Array<{declines:number}>>`select declines from public.family_refusals where inviter_id=${owner.id}::uuid and invitee_id=${relative.id}::uuid`)[0].declines).toBe(1);
 });
 it('owner cannot leave; end sharing preserves owner plan, invalidates pending and never auto-rejoins',async()=>{
  const owner=await account('family'),a=await account(),b=await account();
  const accepted=await invite(owner,a),pending=await invite(owner,b);expect((await accept(a,accepted.body.invitationId)).status).toBe(200);
  expect((await call(owner,`/workspaces/${owner.ws}/family/leave`,'POST')).status).toBe(409);
  expect((await call(owner,`/workspaces/${owner.ws}/family/end`,'POST')).status).toBe(200);
  expect((await call(owner,'/me')).body.plan).toBe('family');expect((await call(a,'/me')).body.plan).toBe('free');
  expect((await accept(b,pending.body.invitationId)).status).toBe(409);
  expect((await call(a,`/workspaces/${owner.ws}/inventory`)).status).toBe(403);
 });
 it('validates comma-separated emails individually, normalizes, hides identities, and creates all-or-nothing',async()=>{
  const owner=await account('family'),a=await account(),b=await account();
  const missing='not-registered-'+randomUUID()+'@example.invalid';
  const path=`/workspaces/${owner.ws}/invitations`;
  const invalid=await call(owner,path+'/validate','POST',{emails:` ${a.email.toUpperCase()}, ${a.email}, not-email, ${missing}`});
  expect(invalid.status).toBe(200);expect(invalid.body.canSubmit).toBe(false);expect(invalid.body.validationToken).toBeNull();
  expect(invalid.body.results.map((r:any)=>r.code)).toEqual(['DUPLICATE_EMAIL','DUPLICATE_EMAIL','INVALID_EMAIL','EMAIL_NOT_REGISTERED']);
  expect(invalid.body.results[3].message).toBe(`Email ${missing} chưa được đăng ký tài khoản HomeMind.`);
  expect(JSON.stringify(invalid.body)).not.toContain(a.id);
  const emails=` ${a.email.toUpperCase()}, ${b.email} `;
  const valid=await call(owner,path+'/validate','POST',{emails});expect(valid.status).toBe(200);expect(valid.body.canSubmit).toBe(true);
  const key=randomUUID(),created=await call(owner,path+'/batch','POST',{emails,validationToken:valid.body.validationToken},key);
  expect(created.status).toBe(201);expect(created.body.createdCount).toBe(2);expect(created.body.invitations).toHaveLength(2);
  const replay=await call(owner,path+'/batch','POST',{emails,validationToken:valid.body.validationToken},key);
  expect(replay.status).toBe(201);expect(replay.body.replayed).toBe(true);
  expect(await db.$queryRaw`select id from public.family_invitations where workspace_id=${owner.ws}::uuid`).toHaveLength(2);
 });
 it('members cannot enumerate, invite, cancel, remove, or end sharing through any owner endpoint',async()=>{
  const owner=await account('family'),member=await account(),target=await account();
  const invitation=await invite(owner,member);expect((await accept(member,invitation.body.invitationId)).status).toBe(200);
  const routes:Array<[string,string,object|undefined]>=[
   ['POST','invitations/validate',{emails:target.email}],['POST','invitations/batch',{emails:target.email,validationToken:'forged'}],
   ['POST','invitations',{email:target.email}],['POST',`invitations/${invitation.body.invitationId}/cancel`,undefined],
   ['DELETE',`family/members/${owner.id}`,undefined],['POST','family/end',undefined],
  ];
  for(const [method,path,body] of routes)expect((await call(member,`/workspaces/${owner.ws}/${path}`,method,body)).status).toBe(403);
  expect((await call(target,`/workspaces/${owner.ws}/invitations/validate`,'POST',{emails:member.email})).status).toBe(403);
  const {DatabaseService}=require('../dist/database/database.service.js');const service=app.get<any>(DatabaseService);
  await expect(service.asUser(member.id,(tx:any)=>tx.$queryRaw`select public.family_validate_batch(${owner.ws}::uuid,'[]'::jsonb)`)).rejects.toThrow('FORBIDDEN');
  await expect(service.asUser(member.id,(tx:any)=>tx.$queryRaw`select public.family_operation('remove',${owner.ws}::uuid,${owner.id}::uuid,null,${randomUUID()}::uuid,7)`)).rejects.toThrow('FORBIDDEN');
 });
 it('rejects a stale batch after a competing invitation without sending its remaining valid addresses',async()=>{
  const owner=await account('family'),a=await account(),b=await account();
  const path=`/workspaces/${owner.ws}/invitations`,emails=`${a.email},${b.email}`;
  const valid=await call(owner,path+'/validate','POST',{emails});expect(valid.body.canSubmit).toBe(true);
  expect((await invite(owner,a)).status).toBe(201);
  const stale=await call(owner,path+'/batch','POST',{emails,validationToken:valid.body.validationToken});
  expect(stale.status).toBe(409);expect(stale.body.error.code).toBe('INVITATION_VALIDATION_CHANGED');
  const rows=await db.$queryRaw<Array<{invitee_id:string}>>`select invitee_id from public.family_invitations where workspace_id=${owner.ws}::uuid`;
  expect(rows).toEqual([{invitee_id:a.id}]);
 });
 it('serializes only the short bulk transaction and cannot overbook two simultaneous three-person batches',async()=>{
  const owner=await account('family'),relatives=await Promise.all(Array.from({length:6},()=>account()));
  const path=`/workspaces/${owner.ws}/invitations`,batches=[relatives.slice(0,3),relatives.slice(3)].map(list=>list.map(a=>a.email).join(','));
  const previews=await Promise.all(batches.map(emails=>call(owner,path+'/validate','POST',{emails})));
  expect(previews.every(p=>p.body.canSubmit)).toBe(true);
  const result=await Promise.all(batches.map((emails,i)=>call(owner,path+'/batch','POST',{emails,validationToken:previews[i].body.validationToken})));
  expect(result.map(r=>r.status).sort()).toEqual([201,409]);
  expect(await db.$queryRaw`select id from public.family_invitations where workspace_id=${owner.ws}::uuid`).toHaveLength(3);
 });
 it('bounds owner account-existence checks and refuses overlong batches',async()=>{
  const owner=await account('family'),path=`/workspaces/${owner.ws}/invitations/validate`;
  const {DatabaseService}=require('../dist/database/database.service.js'),service=app.get<any>(DatabaseService);
  for(let i=0;i<5;i++)await service.asUser(owner.id,(tx:any)=>tx.$queryRaw`select public.family_validate_batch(${owner.ws}::uuid,${JSON.stringify([{email:'unknown@example.invalid',valid:true}])}::jsonb)`);
  await expect(service.asUser(owner.id,(tx:any)=>tx.$queryRaw`select public.family_validate_batch(${owner.ws}::uuid,${JSON.stringify([{email:'unknown@example.invalid',valid:true}])}::jsonb)`)).rejects.toThrow('FAMILY_VALIDATION_RATE_LIMIT');
  expect((await call(owner,path,'POST',{emails:Array(6).fill(owner.email).join(',')})).status).toBe(400);
 });
});
