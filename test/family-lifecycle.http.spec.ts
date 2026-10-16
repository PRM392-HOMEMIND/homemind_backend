import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {LocalFamilyHttp,LocalAccount} from './support/local-family-http';

describe.skipIf(process.env.RUN_DB_TESTS!=='1')('Family lifecycle and pressure: real local HTTP',()=>{
 const h=new LocalFamilyHttp();const submissions:string[]=[];
 beforeAll(()=>h.start(),30000);
 afterAll(async()=>{
  const ws=h.accounts.map(a=>a.ws);
  await h.fixtures.$executeRaw`delete from public.billing_grants where workspace_id=any(${ws}::uuid[])`;
  await h.fixtures.$executeRaw`delete from public.billing_orders where workspace_id=any(${ws}::uuid[])`;
  await h.fixtures.$executeRaw`delete from public.feedback_popup_rewards where submission_id=any(${submissions}::uuid[])`;
  await h.fixtures.$executeRaw`delete from public.feedback_popup_submissions where id=any(${submissions}::uuid[])`;
  await h.close();
 });
 async function invite(owner:LocalAccount,a:LocalAccount){
  const r=await h.call(owner,`/workspaces/${owner.ws}/invitations`,'POST',{email:a.email});expect(r.status).toBe(201);return r.body.invitationId as string;
 }
 async function grant(a:LocalAccount,plan:'personal'|'family',from:Date,to:Date){
  const order=randomUUID(),price=plan==='family'?59000:29000;
  const snapshot={id:plan+'-month-v2',plan,amount:price,currency:'VND',durationSeconds:2592000,voiceLimit:plan==='family'?100:60,workspaceType:'household',productLimit:null,transition:'immediate_upgrade',policyVersion:'voice-30d-v2'};
  await h.fixtures.$executeRaw`insert into public.billing_orders(id,workspace_id,actor_id,idempotency_key,payload_hash,order_code,channel,price_id,price_snapshot,description,status,financial_state,fulfillment,amount_paid,origin,paid_at)
   values(${order}::uuid,${a.ws}::uuid,${a.id}::uuid,${randomUUID()}::uuid,'family-local',9000000000000+nextval('public.billing_order_sequence'),'family-fixture',${snapshot.id},${JSON.stringify(snapshot)}::jsonb,'LOCAL0001','PAID','PAID','GRANTED',${price},'SIMULATED_TEST',${from})`;
  const [row]=await h.fixtures.$queryRaw<Array<{id:string}>>`insert into public.billing_grants(order_id,workspace_id,plan,product_limit,starts_at,expires_at,price_snapshot)
   values(${order}::uuid,${a.ws}::uuid,${plan},null,${from},${to},${JSON.stringify(snapshot)}::jsonb) returning id`;
  await h.fixtures.$executeRaw`update public.workspace_entitlements set source='billing' where workspace_id=${a.ws}::uuid`;
  return row.id;
 }
 it('ties invitation identity to the account after an email change and rejects another Family owner',async()=>{
  const owner=await h.account('family'),relative=await h.account(),otherOwner=await h.account('family'),other=await h.account();
  const id=await invite(owner,relative),otherId=await invite(otherOwner,other);
  const email='changed-'+randomUUID()+'@example.invalid';
  await h.fixtures.user.update({where:{id:relative.id},data:{email}});
  expect((await h.call(other,`/me/workspace-invitations/${id}`)).status).toBe(404);
  expect((await h.call(relative,`/me/workspace-invitations/${id}/accept`,'POST')).status).toBe(200);
  expect((await h.call(otherOwner,`/workspaces/${otherOwner.ws}/invitations`,'POST',{email:owner.email})).status).toBe(409);
  expect((await h.call(other,`/me/workspace-invitations/${otherId}/accept`,'POST')).status).toBe(200);
  expect((await h.call(relative,'/me')).body.workspaceId).toBe(owner.ws);
 });
 it('expiry rejects pending acceptance and worker creates deduplicated account notices',async()=>{
  const owner=await h.account('family'),relative=await h.account(),id=await invite(owner,relative);
  await h.fixtures.$executeRaw`update public.family_invitations set created_at=now()-interval '8 days',expires_at=now()-interval '1 second' where id=${id}::uuid`;
  expect((await h.call(relative,`/me/workspace-invitations/${id}/accept`,'POST')).status).toBe(409);
  await h.fixtures.$executeRaw`select public.family_scan_due()`;await h.fixtures.$executeRaw`select public.family_scan_due()`;
  const rows=await h.fixtures.$queryRaw<Array<{state:string}>>`select state from public.family_invitations where id=${id}::uuid`;
  expect(rows[0].state).toBe('EXPIRED');
  const events=await h.fixtures.$queryRaw<Array<{recipient_id:string}>>`select recipient_id from public.notification_outbox where target_id=${id} and kind='family.invitation_expired'`;
  expect(events.map(e=>e.recipient_id).sort()).toEqual([owner.id,relative.id].sort());
  expect((await h.call(relative,'/me')).body.workspaceId).toBe(relative.ws);
 });
 it('accept versus cancellation is atomic and cannot leave an inconsistent membership',async()=>{
  const owner=await h.account('family'),relative=await h.account(),id=await invite(owner,relative);
  const results=await Promise.all([
   h.call(relative,`/me/workspace-invitations/${id}/accept`,'POST'),
   h.call(owner,`/workspaces/${owner.ws}/invitations/${id}/cancel`,'POST'),
  ]);
  expect(results.every(r=>[200,409].includes(r.status))).toBe(true);
  const [state]=await h.fixtures.$queryRaw<Array<{state:string;members:number}>>`select state,(select count(*)::int from public.workspace_members where workspace_id=${owner.ws}::uuid and user_id=${relative.id}::uuid) members from public.family_invitations where id=${id}::uuid`;
  expect(['ACCEPTED','CANCELLED']).toContain(state.state);expect(state.members).toBe(state.state==='ACCEPTED'?1:0);
 });
 it('removal fences an in-flight AI response and releases its shared reservation',async()=>{
  const [owner,relative]=await h.family(2);let entered!:()=>void,finish!:()=>void;
  const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>finish=r);
  h.planner.plan=async()=>{entered();await gate;return {toolId:'inventory.list',arguments:{limit:20}};};
  const result=h.turn(relative,owner.ws);await ready;
  try{expect((await h.call(owner,`/workspaces/${owner.ws}/family/members/${relative.id}`,'DELETE')).status).toBe(200);}finally{finish();}
  const r=await result;expect([403,409]).toContain(r.status);
  const requests=await h.fixtures.$queryRaw<Array<{state:string}>>`select state from public.assistant_quota_requests where actor_id=${relative.id}::uuid`;
  expect(requests.every(r=>r.state!=='COMMITTED'&&r.state!=='RESERVED')).toBe(true);
  expect((await h.call(owner,'/me')).body.voiceQuota.used).toBe(0);
 });
 it('expired original Family grant removes relatives; renewal never silently rejoins them or restores old personal paid grants',async()=>{
  const owner=await h.account(),relative=await h.account(),now=Date.now(),day=86400000;
  const familyGrant=await grant(owner,'family',new Date(now-day),new Date(now+29*day));
  await grant(relative,'personal',new Date(now-day),new Date(now+29*day));
  await grant(relative,'personal',new Date(now+29*day),new Date(now+59*day));
  const id=await invite(owner,relative);expect((await h.call(relative,`/me/workspace-invitations/${id}/accept`,'POST')).status).toBe(200);
  // Expire after the invitation was accepted and the old grants existed.
  // Backdating before their creation would correctly classify them as NEW access.
  await h.fixtures.$executeRaw`update public.billing_grants set effective_until=clock_timestamp() where id=${familyGrant}::uuid`;
  const after=await h.call(relative,'/me');expect(after.status).toBe(200);expect(after.body).toMatchObject({workspaceId:relative.ws,plan:'free'});
  expect((await h.call(relative,`/workspaces/${owner.ws}/home`)).status).toBe(403);
  await grant(owner,'family',new Date(),new Date(Date.now()+30*day));
  expect((await h.call(owner,'/me')).body.plan).toBe('family');
  expect((await h.call(relative,'/me')).body.plan).toBe('free');
  const [future]=await h.fixtures.$queryRaw<Array<{plan:string}>>`select public.family_effective_at(${relative.ws}::uuid,now()+interval '35 days')->>'plan' as plan`;
  expect(future.plan).toBe('free');
  expect(await h.fixtures.billingOrder.count({where:{workspaceId:relative.ws}})).toBe(2);
  await grant(relative,'personal',new Date(),new Date(Date.now()+30*day));
  expect((await h.call(relative,'/me')).body.plan).toBe('personal');
 });
 it('rejected operation commits effective expiry separately without provider or partial mutation',async()=>{
  const a=await h.account(),day=86400000;
  const id=await grant(a,'personal',new Date(Date.now()-day),new Date(Date.now()+29*day));
  // Build the prerequisite inventory in one owned fixture transaction. Keep all
  // real SQL mutations/RLS; the expiry rejection below still uses db.operation.
  await h.db.asUser(a.id,async(tx:any)=>{
   for(let i=0;i<31;i++)await tx.$queryRaw`select public.apply_operation(${a.ws}::uuid,${randomUUID()}::uuid,'inventory.add',${JSON.stringify({productName:'Local expiry '+i,quantity:1,unit:'box'})}::jsonb,null::uuid)`;
  });
  expect(await h.fixtures.product.count({where:{workspaceId:a.ws}})).toBe(31);
  await h.fixtures.$executeRaw`update public.billing_grants set starts_at=now()-interval '2 months',expires_at=now()-interval '1 month' where id=${id}::uuid`;
  expect(await h.fixtures.workspaceEntitlement.findUnique({where:{workspaceId:a.ws}})).toMatchObject({plan:'personal',productLimit:null});
  const key=randomUUID();
  await expect(h.db.operation(a.id,a.ws,key,'inventory.add',{productName:'Rejected expiry',quantity:1,unit:'box'})).rejects.toMatchObject({status:402,response:{code:'PLAN_LIMIT',details:{plan:'free',limit:30,count:31}}});
  expect(await h.fixtures.workspaceEntitlement.findUnique({where:{workspaceId:a.ws}})).toMatchObject({plan:'free',productLimit:30});
  expect(await h.fixtures.product.count({where:{workspaceId:a.ws}})).toBe(31);
  expect(await h.fixtures.idempotencyOperation.count({where:{workspaceId:a.ws,idempotencyKey:key}})).toBe(0);
 });
 it('a delayed grant from a pre-departure promotion cannot resurrect personal paid access',async()=>{
  const [owner,a]=await h.family(2),submission=randomUUID(),reward=randomUUID();submissions.push(submission);
  await h.fixtures.$executeRaw`insert into public.feedback_popup_submissions(id,campaign_id,full_name,email,phone,review,payload_hash,submitter_user_id,submitted_at)
   values(${submission}::uuid,'homepage-feedback-premium-30d','Synthetic Family fixture',${a.email},'+84900000001','Local promotion retention fixture',repeat('0',64),${a.id}::uuid,clock_timestamp())`;
  await h.fixtures.$executeRaw`insert into public.feedback_popup_rewards(id,submission_id,campaign_id,state,created_at,updated_at)
   values(${reward}::uuid,${submission}::uuid,'homepage-feedback-premium-30d','PENDING_ACCOUNT',clock_timestamp(),clock_timestamp())`;
  await h.fixtures.$executeRaw`update public.feedback_popup_rewards set state='GRANTED',user_id=${a.id}::uuid,workspace_id=${a.ws}::uuid,anchor_at=clock_timestamp(),bound_at=clock_timestamp(),granted_at=clock_timestamp(),updated_at=clock_timestamp() where id=${reward}::uuid`;
  expect((await h.call(owner,`/workspaces/${owner.ws}/family/members/${a.id}`,'DELETE')).status).toBe(200);
  await h.fixtures.$executeRaw`select public.feedback_popup_place_at(${reward}::uuid,clock_timestamp())`;
  expect((await h.call(a,'/me')).body.plan).toBe('free');
  const [retained]=await h.fixtures.$queryRaw<Array<{source_kind:string;amount:number;allowed:boolean}>>`select source_kind,(price_snapshot->>'amount')::int amount,public.family_grant_allowed(g) allowed from public.billing_grants g where reward_id=${reward}::uuid`;
  expect(retained).toEqual({source_kind:'PROMOTION',amount:0,allowed:false});
  expect(await h.fixtures.billingOrder.count({where:{workspaceId:a.ws}})).toBe(0);
 });
 it('legacy SQL callers enforce expiry and Free fallback without the new API reconciliation hook',async()=>{
  for(const entry of ['billing_effective','assistant_quota_get','apply_operation'] as const){
   const owner=await h.account(),relative=await h.account(),now=Date.now(),day=86400000;
   const familyGrant=await grant(owner,'family',new Date(now-day),new Date(now+29*day));
   await grant(relative,'personal',new Date(now-day),new Date(now+29*day));
   const id=await invite(owner,relative);expect((await h.call(relative,`/me/workspace-invitations/${id}/accept`,'POST')).status).toBe(200);
   await h.fixtures.$executeRaw`update public.billing_grants set effective_until=clock_timestamp() where id=${familyGrant}::uuid`;
   const value=await h.db.$transaction(async(tx:any)=>{
    await tx.$queryRaw`select set_config('app.user_id',${relative.id},true)`;
    const rows=entry==='billing_effective'?await tx.$queryRaw`select public.billing_effective(${relative.ws}::uuid) as value`
     :entry==='assistant_quota_get'?await tx.$queryRaw`select public.assistant_quota_get(${relative.ws}::uuid) as value`
     :await tx.$queryRaw`select public.apply_operation(${relative.ws}::uuid,${randomUUID()}::uuid,'shopping.add','{"name":"Gao local"}'::jsonb) as value`;
    return rows[0].value;
   });
   if(entry==='billing_effective')expect(value.plan).toBe('free');
   if(entry==='assistant_quota_get')expect(value).toMatchObject({total:15,remaining:15,shared:false});
   expect(await h.fixtures.workspaceMember.count({where:{workspaceId:owner.ws,userId:relative.id}})).toBe(0);
   expect((await h.call(relative,'/me')).body.plan).toBe('free');
  }
 });
 describe('account closure with an owned Family fixture',()=>{
 let owner:LocalAccount,a:LocalAccount,b:LocalAccount;
 beforeAll(async()=>{[owner,a,b]=await h.family(3);},30000);
 it('closing owner or relative accounts revokes shared access without deleting another account',async()=>{
  expect((await h.call(a,'/auth/account/deactivate','POST',{currentPassword:a.password})).status).toBe(200);
  expect((await h.call(a,'/me')).status).toBe(401);
  expect((await h.call(owner,`/workspaces/${owner.ws}/family`)).body.members).toHaveLength(2);
  expect((await h.call(owner,'/auth/account/deactivate','POST',{currentPassword:owner.password})).status).toBe(200);
  expect((await h.call(b,'/me')).body).toMatchObject({workspaceId:b.ws,plan:'free'});
  expect((await h.call(b,`/workspaces/${owner.ws}/inventory`)).status).toBe(403);
  expect(await h.fixtures.user.count({where:{id:{in:[owner.id,a.id,b.id]}}})).toBe(3);
 });
 });
 it('returns explicit bounded 503 under lock pressure, without a partial invitation',async()=>{
  const owner=await h.account('family'),relative=await h.account();let release!:()=>void,acquired!:()=>void;
  const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>acquired=r);
  const held=h.fixtures.$transaction(async tx=>{await tx.$executeRaw`select public.family_lock()`;acquired();await gate;},{timeout:10000});
  await ready;
  try{
   const r=await h.call(owner,`/workspaces/${owner.ws}/invitations`,'POST',{email:relative.email});
   expect(r.status).toBe(503);expect(r.body.error.code).toBe('DATABASE_BUSY');
  }finally{release();await held;}
  expect(await h.fixtures.$queryRaw`select id from public.family_invitations where workspace_id=${owner.ws}::uuid`).toHaveLength(0);
  expect((await h.call(owner,`/workspaces/${owner.ws}/invitations`,'POST',{email:relative.email})).status).toBe(201);
 });
});
