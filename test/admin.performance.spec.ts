import 'reflect-metadata';
import { beforeAll,afterAll,describe,expect,it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync,writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { AdminDatabase } from '../src/admin/admin.database';
import { AdminAuth,AdminRequest } from '../src/admin/admin.auth';
import { AdminRead } from '../src/admin/admin.read';
import { requireDisposableDatabase } from './disposable-database';
describe.skipIf(process.env.RUN_ADMIN_PERF_TESTS!=='1')('admin bounded database plans:2000 customers/20000 orders/events',()=>{
 const owner=new PrismaClient({datasourceUrl:process.env.MIGRATION_DATABASE_URL});const db=new AdminDatabase();const label=randomUUID();
 let users:string[]=[],workspaces:string[]=[],principal:string;
 beforeAll(async()=>{
  requireDisposableDatabase();
  const rows=await owner.$queryRawUnsafe<{id:string}[]>("INSERT INTO admin.principals(bootstrap_key,email,password_hash) VALUES('initial',$1,'unused-test-no-auth') RETURNING id",'perf-admin-'+label+'@example.invalid');principal=rows[0].id;
  users=(await owner.$queryRawUnsafe<{id:string}[]>("INSERT INTO public.users(email,password_hash) SELECT 'perf-'||$1||'-'||n||'@example.invalid','unused-test-no-auth' FROM generate_series(1,2000)n RETURNING id",label)).map(x=>x.id);
  workspaces=(await owner.$queryRawUnsafe<{id:string}[]>("INSERT INTO public.workspaces(name,type) SELECT 'Admin performance '||$1||'-'||n,'household' FROM generate_series(1,2000)n RETURNING id",label)).map(x=>x.id);
  await owner.$executeRawUnsafe("INSERT INTO admin.customer_scope SELECT unnest($1::uuid[]),'REAL',now()",users);
  await owner.$executeRawUnsafe("INSERT INTO admin.workspace_scope SELECT unnest($1::uuid[]),'REAL',now()",workspaces);
  for(let start=0;start<2000;start+=200){const u=users.slice(start,start+200),w=workspaces.slice(start,start+200);
   await owner.$executeRawUnsafe("INSERT INTO public.workspace_members(workspace_id,user_id,role) SELECT w.id,u.id,'owner' FROM unnest($1::uuid[]) WITH ORDINALITY w(id,n) JOIN unnest($2::uuid[]) WITH ORDINALITY u(id,n) USING(n)",w,u);
   await owner.$executeRawUnsafe("INSERT INTO public.workspace_entitlements(workspace_id) SELECT unnest($1::uuid[])",w);
   await owner.$executeRawUnsafe(`INSERT INTO public.billing_orders(workspace_id,actor_id,idempotency_key,payload_hash,order_code,channel,price_id,price_snapshot,description,status,financial_state,fulfillment,origin,paid_at) SELECT w.id,u.id,gen_random_uuid(),'perf',$3::bigint+w.n*10+z.n,$4,'personal-month-v2','{"plan":"personal","amount":29000,"currency":"VND","policyVersion":"voice-30d-v2"}'::jsonb,'ABCDEFGHI','CANCELLED','UNPAID','NONE','SIMULATED_TEST',null FROM unnest($1::uuid[]) WITH ORDINALITY w(id,n) JOIN unnest($2::uuid[]) WITH ORDINALITY u(id,n) USING(n) CROSS JOIN generate_series(1,10)z(n)`,w,u,(10000000000000n+BigInt(start*20)).toString(),label);
   await owner.$executeRawUnsafe("INSERT INTO public.notification_outbox(event_key,recipient_id,kind,title,summary,detail,target_type,occurred_at) SELECT 'perf-'||$2||'-'||u.n||'-'||z.n,u.id,'account.login','Owned test','Owned test','Owned test','security',now()-z.n*interval '1 day' FROM unnest($1::uuid[]) WITH ORDINALITY u(id,n) CROSS JOIN generate_series(1,10)z(n)",u,label+'-'+start);
  }
  await owner.$executeRawUnsafe('ANALYZE public.users');await owner.$executeRawUnsafe('ANALYZE public.billing_orders');await owner.$executeRawUnsafe('ANALYZE public.notification_outbox');
 },90000);
 afterAll(async()=>{
  if(workspaces.length){await owner.$executeRawUnsafe('DELETE FROM public.billing_orders WHERE workspace_id=ANY($1::uuid[])',workspaces);await owner.workspace.deleteMany({where:{id:{in:workspaces}}});}
  if(users.length)await owner.user.deleteMany({where:{id:{in:users}}});
  if(principal){await owner.$executeRawUnsafe('DELETE FROM admin.audit_logs WHERE actor_id=$1::uuid',principal);await owner.$executeRawUnsafe('DELETE FROM admin.sessions WHERE admin_id=$1::uuid',principal);await owner.$executeRawUnsafe('DELETE FROM admin.principals WHERE id=$1::uuid',principal);}
  await owner.$disconnect();await db.onModuleDestroy();
 },30000);
 it('measures independent SQL budgets; stable all-row pagination; EXPLAIN and no leaking context',async()=>{
  const queries={directory:'SELECT id,data FROM admin.customers ORDER BY created_at DESC,id DESC LIMIT 25',payments:'SELECT id,data FROM admin.payments ORDER BY created_at DESC,id DESC LIMIT 25',workspaces:'SELECT id,data FROM admin.workspaces ORDER BY created_at DESC,id DESC LIMIT 25',sales:"SELECT coalesce(sum(amount),0)::text amount FROM admin.payments WHERE completed AND provenance='REAL' AND currency='VND'"};
  for(const [name,sql]of Object.entries(queries)){
   const times:number[]=[];for(let n=0;n<20;n++){const start=performance.now();await db.transaction(tx=>tx.$queryRawUnsafe(sql),true);times.push(performance.now()-start);}
   times.sort((a,b)=>a-b);const p95=times[18];expect(p95).toBeLessThan(name==='sales'?3000:1000);
   const plan=await db.transaction(tx=>tx.$queryRawUnsafe('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql),true);
   console.log(JSON.stringify({metric:'admin_performance',name,customers:2000,orders:20000,events:20000,p50Ms:Math.round(times[9]),p95Ms:Math.round(p95),errors:0,queryCountPerPage:1,explainExecutionMs:(plan as any[])[0]['QUERY PLAN'][0]['Execution Time']}));
  }
  const seen=new Set<string>();let cursor:{time:string;id:string}|undefined;
  for(let page=0;page<21;page++){
   const rows=await db.transaction(tx=>tx.$queryRawUnsafe<{id:string;time:string}[]>(`SELECT id,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') time FROM admin.customers WHERE email LIKE $1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT 100`,'perf-'+label+'-%',cursor?.time||null,cursor?.id||null),true);
   for(const r of rows){expect(seen.has(r.id)).toBe(false);seen.add(r.id);}if(!rows.length)break;cursor={time:rows.at(-1)!.time,id:rows.at(-1)!.id};
  }expect(seen.size).toBe(2000);
 },60000);
 it('measures the complete real overview service and bounded concurrent reads',async()=>{
  const read=new AdminRead(new AdminAuth(db));
  const req=()=>({admin:{admin_id:principal},requestId:randomUUID(),method:'GET',query:{},route:{path:'/v1/admin/dashboard/overview'}} as unknown as AdminRequest);
  const times:number[]=[];
  for(let n=0;n<20;n++){
   const start=performance.now();
   try{const result=await read.dashboard(req(),'overview',{});expect(result.meta.freshness).toBe('transaction_snapshot');times.push(performance.now()-start);}
   catch(e){
    const source=readFileSync('src/admin/admin.read.ts','utf8'),marker=source.indexOf("'customers',jsonb_build_object"),begin=source.lastIndexOf('`SELECT jsonb_build_object(',marker)+1,end=source.indexOf('`,provenance,w.from,w.to)',begin),sql=source.slice(begin,end);
    // Diagnostic only, isolated dataset/SELECT role. The tested service still
    // failed its unchanged 3s budget; a longer EXPLAIN is never acceptance PASS.
    const diagnostic=new PrismaClient({datasourceUrl:process.env.ADMIN_DATABASE_URL});
    let plan:unknown;
    try{plan=await diagnostic.$transaction(async tx=>{await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');await tx.$executeRawUnsafe('SET LOCAL jit=off');await tx.$executeRawUnsafe("SET LOCAL statement_timeout='20000ms'");return tx.$queryRawUnsafe('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql,'REAL',new Date(Date.now()-30*86400000),new Date());},{timeout:25000});}finally{await diagnostic.$disconnect();}
    if(process.env.ADMIN_PERF_PLAN_PATH)writeFileSync(process.env.ADMIN_PERF_PLAN_PATH,JSON.stringify(plan));
    const root=(plan as any[])[0]['QUERY PLAN'][0];console.log(JSON.stringify({diagnostic:'overview_estimated_plan',cost:root.Plan['Total Cost'],jit:root.JIT}));throw e;
   }
  }
  times.sort((a,b)=>a-b);expect(times[18]).toBeLessThan(3000);
  const outcomes=await Promise.allSettled(Array.from({length:4},()=>read.dashboard(req(),'overview',{})));expect(outcomes.every(x=>x.status==='fulfilled')).toBe(true);
  console.log(JSON.stringify({metric:'admin_performance',name:'actual_overview_service',customers:2000,orders:20000,events:20000,p50Ms:Math.round(times[9]),p95Ms:Math.round(times[18]),errors:0,concurrentReads:4,measurement:'DB+limit+snapshot+audit; HTTP auth not included'}));
 },90000);
});
