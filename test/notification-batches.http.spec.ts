import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {LocalFamilyHttp,LocalAccount} from './support/local-family-http';
describe.skipIf(process.env.RUN_DB_TESTS!=='1')('Notifications: bounded read batches and account-level Family access',()=>{
 const h=new LocalFamilyHttp();beforeAll(()=>h.start(),30000);afterAll(()=>h.close());
 async function enqueue(a:LocalAccount,count:number){
  const key=randomUUID();
  await h.fixtures.$executeRaw`select public.notification_enqueue(${key}||':'||n,${a.id}::uuid,null,false,'test.family','Thông báo local','Dữ liệu giả lập','Dữ liệu giả lập','family',null,clock_timestamp()) from generate_series(1,${count}::integer) n`;
  for(let i=0;i<40;i++){
   await h.db.$queryRaw`select public.notification_deliver()`;
   const [left]=await h.fixtures.$queryRaw<Array<{n:number}>>`select count(*)::integer n from public.notification_outbox where recipient_id=${a.id}::uuid and delivered_at is null`;
   if(!left.n)return;
  }
  throw Error('Owned outbox events did not become ready within bounded normal worker batches');
 }
 for(const count of [0,1,50,51,125])it(`reads ${count} notices in bounded batches, preserving a fixed cutoff`,async()=>{
  const a=await h.account();await enqueue(a,0);
  // Registration legitimately creates a welcome notice; establish an empty unread fixture via the real API.
  expect((await h.call(a,'/me/notifications/read-all','POST',{})).status).toBe(200);
  await enqueue(a,count);
  const first=await h.call(a,'/me/notifications/read-all','POST',{});expect(first.status).toBe(200);
  expect(first.body.readCount).toBe(Math.min(50,count));expect(first.body.remainingCount).toBe(Math.max(0,count-50));
  await enqueue(a,1); // A later arrival must remain unread throughout continuation/retry.
  const cutoff=first.body.cutoff;let marked=first.body.readCount,next=first.body,loops=0;
  while(next.hasMore&&loops++<3){const r=await h.call(a,'/me/notifications/read-all','POST',{cutoff});expect(r.status).toBe(200);expect(r.body.readCount).toBeLessThanOrEqual(50);marked+=r.body.readCount;next=r.body;}
  expect(marked).toBe(count);expect(next.complete).toBe(true);expect(next.hasMore).toBe(false);
  const retry=await h.call(a,'/me/notifications/read-all','POST',{cutoff});expect(retry.body).toMatchObject({readCount:0,complete:true,remainingCount:0});
  expect((await h.call(a,'/me/notifications?unread=true')).body.items).toHaveLength(1);
 });
 it('retains account-owned departure notice but denies former-member workspace data and other users notices',async()=>{
  const [owner,a]=await h.family(2),ws=owner.ws;
  expect((await h.call(owner,`/workspaces/${ws}/family/members/${a.id}`,'DELETE')).status).toBe(200);await enqueue(a,0);
  const list=await h.call(a,'/me/notifications');expect(list.status).toBe(200);
  const departure=list.body.items.find((n:any)=>n.type==='family.remove');expect(departure).toBeDefined();
  expect((await h.call(a,'/me/notifications/'+departure.id)).status).toBe(200);
  expect((await h.call(owner,'/me/notifications/'+departure.id)).status).toBe(404);
  expect((await h.call(a,`/workspaces/${ws}/notifications`)).status).toBe(403);
  expect((await h.call(a,`/workspaces/${ws}/inventory`)).status).toBe(403);
 });
});
