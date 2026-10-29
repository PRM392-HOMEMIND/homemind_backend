import { mockEmailAuth, registerVerified, changeVerifiedPassword, changeVerifiedEmail } from './support/email-auth-fixture';
import 'reflect-metadata';
import { deleteFixtureUsers } from './support/delete-fixture-users';
import { randomBytes,randomUUID } from 'node:crypto';
import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { DatabaseService } from '../src/database/database.service';
import { AuthService } from '../src/auth/auth.service';
import { ResetDeliveryService } from '../src/auth/reset-delivery.service';
import { MeController } from '../src/me/me.controller';
import { AuthRequest } from '../src/auth/auth.guard';
import { SnapshotService } from '../src/snapshot/snapshot.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { SearchService } from '../src/search/search.service';
import { requireDisposableDatabase } from './disposable-database';

describe.skipIf(process.env.RUN_DB_TESTS!=='1')('real database scoped search and durable committed activity',()=>{
 const db=new DatabaseService(),owner=new PrismaClient({datasourceUrl:process.env.MIGRATION_DATABASE_URL});
 const auth=mockEmailAuth(db),me=new MeController(db),notices=new NotificationsService(db,new SnapshotService(db)),search=new SearchService(db);
 const users:string[]=[],workspaces:string[]=[],password=randomBytes(24).toString('hex');
 beforeAll(()=>requireDisposableDatabase());
 afterAll(async()=>{
  await deleteFixtureUsers(owner,users,workspaces);
  await Promise.all([db.$disconnect(),owner.$disconnect()]);
 });
 async function account(type:'household'|'store'='household'){
  const email=`hub-${randomUUID()}@example.invalid`;
  const session=await registerVerified(auth,{acceptedTerms:true,acceptedPrivacy:true,displayName:'Hồ sơ thử',email,password,workspaceType:type},{});
  users.push(session.user.id);const req={userId:session.user.id} as AuthRequest,p=await me.get(req);workspaces.push(p.workspaceId);
  return {user:session.user.id,ws:p.workspaceId,req,email,session};
 }
 async function drainOwnedDue(a:{user:string},scan=false,worker=notices){
  // A global delivery batch is bounded to 50, not to this fixture's recipient.
  // Other parallel suites can queue earlier records. Observe owned readiness
  // using normal batches; poison backoff/attempt limits remain separate asserts.
  for(let batch=0;batch<20;batch++){
   await worker.drain(scan&&batch===0);
   const rows=await owner.$queryRaw<Array<{n:number}>>`select count(*)::int as n from public.notification_outbox
    where recipient_id=${a.user}::uuid and delivered_at is null and attempts<8 and available_at<=clock_timestamp()`;
   if(rows[0].n===0)return;
  }
  throw Error('Owned due notifications not processed within bounded worker batches');
 }
 async function kinds(a:{user:string;ws:string}){
  await drainOwnedDue(a);return (await notices.list(a.user,a.ws,50)).items.map(x=>x.type);
 }
 it('new registration emits one welcome; refresh and restored reads emit no login',async()=>{
  const a=await account();expect(await kinds(a)).toEqual(['account.welcome']);
  const rotated=await auth.refresh(a.session.refreshToken,{});await me.get(a.req);
  expect(await kinds(a)).toEqual(['account.welcome']);
  await auth.login(a.email,password,{});expect(await kinds(a)).toContain('account.login');
  await auth.logout(rotated.refreshToken);await auth.logout(rotated.refreshToken);
  expect((await kinds(a)).filter(x=>x==='account.logout')).toHaveLength(1);
 });
 it('profile changed/noop/rollback produces only actual committed safe events',async()=>{
  const a=await account();await me.update(a.req,{displayName:'Đổi tên'});await me.update(a.req,{displayName:'Đổi tên'});
  expect((await kinds(a)).filter(x=>x==='profile.updated')).toHaveLength(1);
  await expect(db.asUser(a.user,async tx=>{await tx.profile.update({where:{id:a.user},data:{phone:'123456789'}});throw new Error('rollback');})).rejects.toThrow('rollback');
  expect((await kinds(a)).filter(x=>x==='profile.updated')).toHaveLength(1);
  const rows=await owner.$queryRaw<Array<{detail:string;summary:string}>>`select detail,summary from public.notification_outbox where recipient_id=${a.user}::uuid`;
  expect(JSON.stringify(rows)).not.toContain('123456789');
 });
 it('explicit logout-all is one event across sessions; password and identifier changes are private real events',async()=>{
  const a=await account();await auth.login(a.email,password,{});await auth.login(a.email,password,{});
  await auth.logoutAll(a.user);await auth.logoutAll(a.user);
  expect((await kinds(a)).filter(x=>x==='account.logout_all')).toHaveLength(1);
  const nextPassword=randomBytes(24).toString('hex');await changeVerifiedPassword(auth,a.user,a.email,password,nextPassword);
  const nextEmail=`renamed-${randomUUID()}@example.invalid`;
  await changeVerifiedEmail(auth,a.user,a.email,nextEmail,nextPassword);
  await auth.identifiers(a.user,{currentPassword:nextPassword,newEmail:nextEmail});
  expect((await kinds(a)).filter(x=>x==='account.security')).toHaveLength(2);
  const payload=await owner.$queryRaw<Array<{title:string;summary:string;detail:string}>>`select title,summary,detail from public.notification_outbox where recipient_id=${a.user}::uuid`;
  expect(JSON.stringify(payload)).not.toContain(nextEmail);expect(JSON.stringify(payload)).not.toContain(nextPassword);
 });
 it('contact/address/language and inventory/shopping changes notify only on real committed changes',async()=>{
  const a=await account();await me.update(a.req,{phone:'0911111111',address:'LOCAL FIXTURE',language:'en'});
  await me.update(a.req,{phone:'0911111111',address:'LOCAL FIXTURE',language:'en'});
  const added=await db.operation(a.user,a.ws,randomUUID(),'inventory.add',{productName:'Đậu thử',quantity:2,unit:'hộp'});
  const productId=(added.created as {productIds:string[]}).productIds[0];
  await db.operation(a.user,a.ws,randomUUID(),'inventory.patch',{productId,name:'Đậu mới'});
  await db.operation(a.user,a.ws,randomUUID(),'inventory.mark_out',{productId,addToShopping:false});
  const s=await db.operation(a.user,a.ws,randomUUID(),'shopping.add',{name:'Đậu mua'});
  const itemId=(s.created as {shoppingItemIds:string[]}).shoppingItemIds[0];
  await db.operation(a.user,a.ws,randomUUID(),'shopping.patch',{itemId,status:'skipped'});
  const k=await kinds(a);for(const kind of ['profile.updated','inventory.add','inventory.patch','inventory.mark_out','shopping.add','shopping.patch'])expect(k.filter(x=>x===kind)).toHaveLength(1);
 });
 it('receive emits one logical event, same-key replay and already-received noop emit none',async()=>{
  const a=await account(),key=randomUUID();
  const result=await db.operation(a.user,a.ws,key,'shopping.add',{name:'Sữa thử',quantity:1,unit:'hộp'});
  const id=(result.created as {shoppingItemIds:string[]}).shoppingItemIds[0],receive=randomUUID();
  await db.operation(a.user,a.ws,receive,'shopping.receive',{itemId:id,quantity:1,unit:'hộp'});
  await db.operation(a.user,a.ws,receive,'shopping.receive',{itemId:id,quantity:1,unit:'hộp'});
  await db.operation(a.user,a.ws,randomUUID(),'shopping.receive',{itemId:id,quantity:1,unit:'hộp'});
  const k=await kinds(a);expect(k.filter(x=>x==='shopping.receive')).toHaveLength(1);expect(k.filter(x=>x==='inventory.add')).toHaveLength(0);expect(k.filter(x=>x==='shopping.patch')).toHaveLength(0);
 });
 it('preview uses five rows; inbox cursors are recipient/scope-bound and first-read is immutable',async()=>{
  const a=await account(),b=await account();
  for(let i=0;i<8;i++)await me.update(a.req,{displayName:'Version '+i});
  await drainOwnedDue(a);
  const preview=await notices.list(a.user,a.ws);expect(preview.items).toHaveLength(5);expect(preview.hasMore).toBe(true);
  const next=await notices.list(a.user,a.ws,5,preview.nextCursor!);expect(next.items).toHaveLength(4);
  expect(new Set([...preview.items,...next.items].map(x=>x.id)).size).toBe(9);
  await expect(notices.list(b.user,b.ws,5,preview.nextCursor!)).rejects.toThrow();
  // The last base64url character can differ only in unused padding bits.
  // Change a decoded HMAC byte so this is always real signature tampering.
  const [data,signature]=preview.nextCursor!.split('.'),tampered=Buffer.from(signature,'base64url');
  tampered[0]^=1;
  await expect(notices.list(a.user,a.ws,5,data+'.'+tampered.toString('base64url'))).rejects.toThrow();
  const id=preview.items[0].id;expect((await notices.detail(a.user,a.ws,id)).read).toBe(false);
  await notices.markRead(a.user,a.ws,id);const first=(await notices.detail(a.user,a.ws,id)).readAt;
  await notices.markRead(a.user,a.ws,id);expect((await notices.detail(a.user,a.ws,id)).readAt).toBe(first);
  await expect(notices.detail(b.user,b.ws,id)).rejects.toThrow();
  await expect(notices.markRead(b.user,b.ws,id)).rejects.toThrow();
 });
 it('delivery transaction crash rolls back; concurrent workers deliver exactly once',async()=>{
  const a=await account();
  await drainOwnedDue(a);
  // Keep this owned event unavailable outside the transaction under test.
  // A parallel normal worker must not turn a successful rollback into a
  // misleading post-rollback delivery observation.
  await owner.$transaction(async tx=>{
   await tx.profile.update({where:{id:a.user},data:{displayName:'Owned rollback event'}});
   await tx.$executeRaw`update public.notification_outbox set available_at=now()+interval '1 hour'
    where recipient_id=${a.user}::uuid and kind='profile.updated' and delivered_at is null`;
  });
  await expect(owner.$transaction(async tx=>{
   await tx.$executeRaw`update public.notification_outbox set available_at=now()
    where recipient_id=${a.user}::uuid and kind='profile.updated' and delivered_at is null`;
   let delivered=false;
   for(let batch=0;batch<20;batch++){
    await tx.$queryRaw`select public.notification_deliver()`;
    const rows=await tx.$queryRaw<Array<{n:number}>>`select count(*)::int as n from public.in_app_notifications where recipient_id=${a.user}::uuid and kind='profile.updated'`;
    if(rows[0].n===1){delivered=true;break;}
   }
   expect(delivered).toBe(true);
   throw Error('crash');
  })).rejects.toThrow('crash');
  await drainOwnedDue(a);
  const before=await notices.list(a.user,a.ws);expect(before.items.filter(x=>x.type==='profile.updated')).toHaveLength(0);
  expect(before.items.filter(x=>x.type==='account.welcome')).toHaveLength(1);
  await owner.$executeRaw`update public.notification_outbox set available_at=now()
   where recipient_id=${a.user}::uuid and kind='profile.updated' and delivered_at is null`;
  await Promise.all([drainOwnedDue(a),drainOwnedDue(a),drainOwnedDue(a)]);
  const after=(await notices.list(a.user,a.ws)).items;
  expect(after.filter(x=>x.type==='profile.updated')).toHaveLength(1);
  expect(after.filter(x=>x.type==='account.welcome')).toHaveLength(1);
 });
 it('owned delivery reaches a recipient behind more than one global batch',async()=>{
  const older=await account();
  for(let i=0;i<55;i++)await me.update(older.req,{displayName:'Owned backlog '+i});
  const next=await account();await drainOwnedDue(next);
  expect((await notices.list(next.user,next.ws)).items.map(x=>x.type)).toEqual(['account.welcome']);
  const pending=await owner.$queryRaw<Array<{n:number}>>`select count(*)::int as n from public.notification_outbox
   where recipient_id=${next.user}::uuid and delivered_at is null`;
  expect(pending[0].n).toBe(0);
 });
 it('search normalizes Vietnamese, has true indexed data beyond the screen cache and rechecks target access',async()=>{
  const a=await account(),b=await account();
  const added=await db.operation(a.user,a.ws,randomUUID(),'inventory.add',{productName:'Sữa Đậu nành',quantity:1,unit:'hộp',category:'Đồ uống'});
  const id=(added.created as {productIds:string[]}).productIds[0];
  const q=await search.search(a.user,a.ws,'sua dau');expect(q.items.some(x=>x.type==='inventory'&&x.id===id)).toBe(true);
  expect((await search.search(a.user,a.ws,'SU\u0303A')).items.some(x=>x.id===id)).toBe(true);
  expect((await search.search(b.user,b.ws,'sua')).items).toHaveLength(0);
  await expect(search.resolve(b.user,b.ws,'inventory',id)).rejects.toThrow();
  expect((await search.resolve(a.user,a.ws,'inventory',id)).id).toBe(id);
  await expect(search.search(a.user,b.ws,'sua')).rejects.toThrow();
  await expect(search.search(a.user,a.ws,'x'.repeat(121))).rejects.toThrow();
  await expect(search.search(a.user,a.ws,'sua',51)).rejects.toThrow();
  expect((await search.search(a.user,a.ws,'s')).items).toHaveLength(0);
 });
 it('search pages rank/type/id stably; filter and cursor tampering cannot widen scope',async()=>{
  const a=await account();
  for(let i=0;i<6;i++)await db.operation(a.user,a.ws,randomUUID(),'shopping.add',{name:'Sữa '+i,unit:'hộp'});
  const p=await search.search(a.user,a.ws,'sua',2,undefined,'shopping');expect(p.items).toHaveLength(2);expect(p.hasMore).toBe(true);
  const n=await search.search(a.user,a.ws,'sua',2,p.nextCursor!,'shopping');expect(new Set([...p.items,...n.items].map(x=>x.id)).size).toBe(4);
  await expect(search.search(a.user,a.ws,'sua',2,p.nextCursor!,'all')).rejects.toThrow();
  expect((await search.search(a.user,a.ws,"sua%' OR true --")).items).toHaveLength(0);
 });
 it('runtime role cannot forge activity/search documents or bypass recipient RLS',async()=>{
  const a=await account(),b=await account();await drainOwnedDue(a);await drainOwnedDue(b);
  const present=await owner.$queryRaw<Array<{n:number}>>`select count(*)::int as n from public.in_app_notifications where recipient_id=${a.user}::uuid`;
  expect(present[0].n).toBe(1);
  const actual=await db.asUser(b.user,tx=>tx.$queryRaw<Array<{n:number}>>`select count(*)::int as n from public.in_app_notifications where recipient_id=${a.user}::uuid`);
  expect(actual[0].n).toBe(0);
  await expect(db.$executeRaw`insert into public.notification_due_receipts values('fake',${randomUUID()}::uuid)`).rejects.toThrow();
  await expect(db.$queryRaw`select public.notification_enqueue('fake',${a.user}::uuid,null,false,'fake','fake','','','home',null,now())`).rejects.toThrow();
 });
 it('revocation after discovery removes notification/search detail and counts on next request',async()=>{
  const a=await account();await db.operation(a.user,a.ws,randomUUID(),'inventory.add',{productName:'Sữa riêng',quantity:1,unit:'hộp'});await drainOwnedDue(a);
  const page=await notices.list(a.user,a.ws,50),id=page.items.find(x=>x.type==='inventory.add')!.id;
  await owner.workspaceMember.deleteMany({where:{userId:a.user,workspaceId:a.ws}});
  await expect(notices.detail(a.user,a.ws,id)).rejects.toThrow();await expect(notices.list(a.user,a.ws)).rejects.toThrow();
  await expect(search.search(a.user,a.ws,'sua')).rejects.toThrow();
 });
 it('quota exhausts once, renews once and GET/read replay neither repeats nor resets allowance',async()=>{
  const a=await account(),p=(await me.get(a.req)).voiceQuota.periodId as string;
  await owner.$executeRaw`update public.assistant_quota_periods set used=usage_limit where id=${p}::uuid`;
  await me.get(a.req);await me.get(a.req);expect((await kinds(a)).filter(x=>x==='quota.exhausted')).toHaveLength(1);
  const next=await owner.$queryRaw<Array<{p:{id:string}}>>`select to_jsonb(public.assistant_period_at(${a.ws}::uuid,now()+interval '31 days')) as p`;
  expect(next[0].p.id).not.toBe(p);await drainOwnedDue(a);await drainOwnedDue(a);
  expect((await kinds(a)).filter(x=>x==='quota.renewed')).toHaveLength(1);
 });
 it('expiry scan reuses legacy read identity and skips removed/zero stock',async()=>{
  const a=await account(),date=new Date().toISOString().slice(0,10);
  // Publish the source fact and its pre-existing legacy read marker atomically.
  // Otherwise a parallel expiry worker can deliver before fixture setup ends.
  const id=await db.asUser(a.user,async tx=>{
   const [op]=await tx.$queryRaw<Array<{result:{created:{productIds:string[]}}}>>`
    select public.apply_operation(${a.ws}::uuid,${randomUUID()}::uuid,${'inventory.add'},
     ${JSON.stringify({productName:'Hàng gần hạn',quantity:1,unit:'hộp',expiryDate:date})}::jsonb,null::uuid) as result`;
   const id=op.result.created.productIds[0],key=`expiry.${id}.${date}`;
   await tx.$executeRaw`insert into public.notification_reads(user_id,workspace_id,notification_key) values(${a.user}::uuid,${a.ws}::uuid,${key})`;
   return id;
  });
  // Scan batches are global and bounded too; observe this owned expiry fact.
  for(let batch=0;batch<20;batch++){
   await drainOwnedDue(a,true);
   if((await notices.list(a.user,a.ws,50)).items.some(x=>x.type==='inventory.expiry'))break;
  }
  const expiry=(await notices.list(a.user,a.ws,50)).items.filter(x=>x.type==='inventory.expiry');expect(expiry).toHaveLength(1);expect(expiry[0].read).toBe(true);
  await db.operation(a.user,a.ws,randomUUID(),'inventory.mark_out',{productId:id,addToShopping:false});
  await drainOwnedDue(a,true);expect((await notices.list(a.user,a.ws,50)).items.filter(x=>x.type==='inventory.expiry')).toHaveLength(1);
 });
 it('worker skips poison with bounded retries and crash-before-delivery resumes after API restart',async()=>{
  const a=await account();
  // A parallel HTTP suite's normal worker may deliver welcome before fault
  // installation. Make that interleaving explicit, then enqueue the poison
  // event only after its trigger is active; never retry a delivered event.
  await drainOwnedDue(a);
  expect((await notices.list(a.user,a.ws)).items.map(x=>x.type)).toEqual(['account.welcome']);
  await owner.$executeRawUnsafe(`create function public.rdb_poison_test() returns trigger language plpgsql as $$begin if new.recipient_id='${a.user}'::uuid then raise exception 'OWNED_TEST_POISON';end if;return new;end $$`);
  await owner.$executeRawUnsafe('create trigger rdb_poison_test before insert on public.in_app_notifications for each row execute function public.rdb_poison_test()');
  try{
   await me.update(a.req,{displayName:'Owned poison event'});
   const b=await account();
   for(let i=0;i<8;i++){
    await owner.$executeRaw`update public.notification_outbox set available_at=now() where recipient_id=${a.user}::uuid and kind='profile.updated' and delivered_at is null`;
    await drainOwnedDue(a);
   }
   const rows=await owner.$queryRaw<Array<{attempts:number;delivered_at:Date|null}>>`select attempts,delivered_at from public.notification_outbox where recipient_id=${a.user}::uuid and kind='profile.updated'`;
   expect(rows).toHaveLength(1);
   expect(rows[0].attempts).toBe(8);expect(rows[0].delivered_at).toBeNull();await drainOwnedDue(b);expect((await notices.list(b.user,b.ws)).items).toHaveLength(1);
  }finally{await owner.$executeRawUnsafe('drop trigger rdb_poison_test on public.in_app_notifications');await owner.$executeRawUnsafe('drop function public.rdb_poison_test()');}
  await owner.$executeRaw`update public.notification_outbox set attempts=0,available_at=now() where recipient_id=${a.user}::uuid and kind='profile.updated' and delivered_at is null`;
  const restarted=new NotificationsService(db,new SnapshotService(db));await drainOwnedDue(a,false,restarted);await drainOwnedDue(a,false,restarted);
  const resumed=(await restarted.list(a.user,a.ws)).items;
  expect(resumed).toHaveLength(2);
  expect(resumed.filter(x=>x.type==='profile.updated')).toHaveLength(1);
  expect(resumed.filter(x=>x.type==='account.welcome')).toHaveLength(1);
 });
 it('Free lifetime projection does not expire access or reset its finite quota',async()=>{
  for(const type of ['household','store'] as const){const a=await account(type);
   const e=await db.asUser(a.user,tx=>tx.$queryRaw<Array<{e:{plan:string;accessLifetime:boolean}}>>`select public.billing_effective(${a.ws}::uuid) as e`);
   expect(e[0].e).toMatchObject({plan:'free',accessLifetime:true});
   const first=(await me.get(a.req)).voiceQuota,second=(await me.get(a.req)).voiceQuota;
   expect(first.total).toBe(15);expect(second.periodId).toBe(first.periodId);expect(second.used).toBe(0);
   expect(Date.parse(first.expiresAt as string)-Date.parse(first.startsAt as string)).toBe(2592000000);
   expect((await kinds(a)).some(x=>x==='billing.plan_expired')).toBe(false);
  }
 });
});
