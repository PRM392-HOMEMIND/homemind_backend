import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {LocalAccount,LocalFamilyHttp} from './support/local-family-http';

describe.skipIf(process.env.RUN_DB_TESTS!=='1')('Family departure after AI history: local HTTP and RLS',()=>{
 const h=new LocalFamilyHttp();
 beforeAll(()=>h.start(),30000);
 afterAll(()=>h.close());
 it('keeps independent actor/workspace foreign keys and denies direct runtime writes',async()=>{
  const [shape]=await h.fixtures.$queryRaw<Array<{workspace:boolean;actor:boolean;membership:boolean}>>`select
   exists(select 1 from pg_constraint where conrelid='public.assistant_turns'::regclass and confrelid='public.workspaces'::regclass and contype='f') workspace,
   exists(select 1 from pg_constraint where conrelid='public.assistant_turns'::regclass and confrelid='public.users'::regclass and contype='f') actor,
   exists(select 1 from pg_constraint where conrelid='public.assistant_turns'::regclass and confrelid='public.workspace_members'::regclass and contype='f') membership`;
  expect(shape).toEqual({workspace:true,actor:true,membership:false});
  const [permissions]=await h.db.$queryRaw`select has_table_privilege(current_user,'public.assistant_turns','INSERT') ins,has_table_privilege(current_user,'public.assistant_turns','UPDATE') upd,has_table_privilege(current_user,'public.assistant_turns','DELETE') del`;
  expect(permissions).toEqual({ins:false,upd:false,del:false});
 });
 for(const action of ['remove','leave','end','expiry'] as const){
  describe(action,()=>{
   let owner:LocalAccount,relative:LocalAccount,readId:string,draft:any,providerCalls=0;
   beforeAll(async()=>{
    [owner,relative]=await h.family(2);
    h.planner.plan=async()=>{providerCalls++;return {toolId:'inventory.list',arguments:{limit:20}};};
    const read=await h.turn(relative,owner.ws);expect(read.status).toBe(201);expect(read.body.kind).toBe('read_result');readId=read.body.turnId;
    h.planner.plan=async()=>{providerCalls++;return {toolId:'shopping.add',arguments:{name:'Local retained draft'}};};
    const write=await h.turn(relative,owner.ws,'Thêm gạo vào danh sách mua');expect(write.status).toBe(201);expect(write.body.kind).toBe('write_draft');draft=write.body;
   },30000);
   it('retains history while revoking membership, reads, confirmation and further quota admission',async()=>{
    const before=providerCalls;
    if(action==='remove')expect((await h.call(owner,`/workspaces/${owner.ws}/family/members/${relative.id}`,'DELETE')).status).toBe(200);
    if(action==='leave')expect((await h.call(relative,`/workspaces/${owner.ws}/family/leave`,'POST')).status).toBe(200);
    if(action==='end')expect((await h.call(owner,`/workspaces/${owner.ws}/family/end`,'POST')).status).toBe(200);
    if(action==='expiry'){
     await h.fixtures.$executeRaw`update public.workspace_entitlements set plan='free',product_limit=30 where workspace_id=${owner.ws}::uuid and source='legacy_manual'`;
    }
    const me=await h.call(relative,'/me');expect(me.status).toBe(200);expect(me.body).toMatchObject({workspaceId:relative.ws,plan:'free'});
    expect(await h.fixtures.workspaceMember.count({where:{workspaceId:owner.ws,userId:relative.id}})).toBe(0);
    const retained=await h.fixtures.assistantTurn.findMany({where:{id:{in:[readId,draft.turnId]}},select:{id:true,status:true}});
    expect(retained).toHaveLength(2);expect(retained.find(t=>t.id===readId)?.status).toBe('completed');
    expect(await h.db.asUser(relative.id,(tx:any)=>tx.assistantTurn.count({where:{workspaceId:owner.ws}}))).toBe(0);
    expect((await h.call(relative,`/workspaces/${owner.ws}/inventory`)).status).toBe(403);
    const confirm=await h.call(relative,`/assistant/turns/${draft.turnId}/confirm`,'POST',{workspaceId:owner.ws,idempotencyKey:randomUUID(),tools:draft.toolsProposed});
    expect(confirm.status).toBe(403);
    expect((await h.turn(relative,owner.ws)).status).toBe(403);
    expect(providerCalls).toBe(before);
    expect(await h.fixtures.shoppingItem.count({where:{workspaceId:owner.ws}})).toBe(0);
    expect(await h.fixtures.$queryRaw`select id from public.assistant_quota_requests where workspace_id=${owner.ws}::uuid and state='RESERVED'`).toHaveLength(0);
   });
  });
 }
});
