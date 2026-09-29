import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { DatabaseService } from '../src/database/database.service';
import { AssistantService } from '../src/assistant/assistant.service';
import { AiPlanner } from '../src/assistant/planner';
import { InventoryService } from '../src/inventory/inventory.service';
import { ShoppingService } from '../src/shopping/shopping.service';
import { HomeService } from '../src/home/home.service';
import { SnapshotService } from '../src/snapshot/snapshot.service';
import { PlanGuard } from '../src/billing/plan-guard.service';
import { todayVietnam } from '../src/common/date';
import { requireDisposableDatabase } from './disposable-database';
import { NotificationsService } from '../src/notifications/notifications.service';
import { deleteFixtureUsers } from './support/delete-fixture-users';

type Admission = { reservationId: string; leaseId: string; exhausted?: boolean; replay?: object; quota: { used: number; total: number; remaining: number; periodId: string } };
describe.skipIf(process.env.RUN_DB_TESTS !== '1')('durable workspace assistant quota, restricted PostgreSQL', () => {
  const db = new DatabaseService(), owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
  const users: string[] = [], workspaces: string[] = [];
  beforeAll(() => requireDisposableDatabase());
  afterAll(async () => {
    await deleteFixtureUsers(owner, users, workspaces);
    await Promise.all([db.$disconnect(), owner.$disconnect()]);
  });
  async function account() {
    const user = randomUUID(); users.push(user);
    await db.user.create({ data: { id: user, email: `quota+${user}@example.invalid`, passwordHash: 'NOT_A_LOGIN_FIXTURE' } });
    const rows = await db.asUser(user, tx => tx.$queryRaw<Array<{ id: string }>>`select public.provision_home(${user}::uuid,'Owned quota','household') as id`);
    const ws = rows[0].id; workspaces.push(ws); return { user, ws };
  }
  async function quota(a: { user: string; ws: string }) {
    return (await db.asUser(a.user, tx => tx.$queryRaw<Array<{ q: Admission['quota'] }>>`select public.assistant_quota_get(${a.ws}::uuid) as q`))[0].q;
  }
  async function admit(a: { user: string; ws: string }, id = randomUUID(), hash = 'owned-logical-payload') {
    return (await db.asUser(a.user, tx => tx.$queryRaw<Array<{ r: Admission }>>`select public.assistant_quota_admit(${a.ws}::uuid,${id}::uuid,${hash}) as r`))[0].r;
  }
  async function finish(a: { user: string }, r: Admission, response: object | null = { schemaVersion: '1.0', kind: 'unknown', turnId: randomUUID() }) {
    return db.asUser(a.user, tx => tx.$queryRaw`select public.assistant_quota_finish(${r.reservationId}::uuid,${r.leaseId}::uuid,${response === null ? null : JSON.stringify(response)}::jsonb)`);
  }
  function assistant(plan: AiPlanner['plan']) {
    const snapshots = new SnapshotService(db), inventory = new InventoryService(db, snapshots), shopping = new ShoppingService(db, snapshots);
    return new AssistantService(db, inventory, shopping, new HomeService(db, inventory, shopping, snapshots),
      { plan } as AiPlanner, snapshots, new PlanGuard(snapshots));
  }
  function input(a: { ws: string }, requestId = randomUUID()) {
    return { requestId, workspaceId: a.ws, locale: 'vi-VN', clientDate: todayVietnam(), timezone: 'Asia/Ho_Chi_Minh',
      dictionaryVersion: '1.1.0', input: { type: 'text' as const, text: 'Trong nhà còn gì?' } };
  }
  it('GET/login-style reads do not reset usage; reserved admission does not charge, failure releases', async () => {
    const a = await account(), initial = await quota(a), r = await admit(a);
    expect(initial).toMatchObject({ total: 15, used: 0, remaining: 15 });
    expect(await quota(a)).toMatchObject({ used: 0, remaining: 14, periodId: initial.periodId });
    await finish(a, r, null);
    expect(await quota(a)).toMatchObject({ used: 0, remaining: 15, periodId: initial.periodId });
  });
  it('16 concurrent admissions for 15 slots never overshoot; double completion charges once', async () => {
    const a = await account();
    const results = await Promise.all(Array.from({ length: 16 }, () => admit(a)));
    expect(results.filter(r => r.exhausted)).toHaveLength(1);
    const active = results.filter(r => !r.exhausted);
    await Promise.all(active.map(r => finish(a, r)));
    await finish(a, active[0]);
    expect(await quota(a)).toMatchObject({ used: 15, total: 15, remaining: 0 });
    expect((await admit(a)).exhausted).toBe(true);
  });
  it('one real application read is replayed without another planner call; changed payload conflicts', async () => {
    const a = await account(); let calls = 0;
    const service = assistant(async () => { calls++; return { toolId: 'inventory.list', arguments: {} }; });
    const body = input(a), result = await service.turn(a.user, body);
    expect(result.kind).toBe('read_result'); expect(await quota(a)).toMatchObject({ used: 1 });
    const replay=await service.turn(a.user, body);
    expect({...replay,voiceQuota:result.voiceQuota}).toEqual(result); expect(calls).toBe(1);
    expect(replay.voiceQuota).toMatchObject({used:1,remaining:14,poolWorkspaceId:a.ws,shared:false});
    await expect(service.turn(a.user, { ...body, input: { type: 'text', text: 'Khác' } })).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    expect((await db.asUser(a.user, tx => tx.assistantTurn.count({ where: { workspaceId: a.ws } })))).toBe(1);
  });
  it('replay exposes current quota after another request without another charge or provider call', async()=>{
    const a=await account();let calls=0;
    const service=assistant(async()=>{calls++;return {toolId:'inventory.list',arguments:{}};});
    const body=input(a),first=await service.turn(a.user,body);
    await service.turn(a.user,input(a));
    const replay=await service.turn(a.user,body);
    expect({...replay,voiceQuota:first.voiceQuota}).toEqual(first);
    expect(replay.voiceQuota).toMatchObject({used:2,remaining:13});
    expect(calls).toBe(2);expect(await quota(a)).toMatchObject({used:2});
  });
  it('durable activity excludes assistant reads/drafts/cancel and emits one committed write on replay',async()=>{
    const a=await account(),notices=new NotificationsService(db,new SnapshotService(db));
    const read=assistant(async()=>({toolId:'inventory.list',arguments:{}}));await read.turn(a.user,input(a));
    const write=assistant(async()=>({toolId:'inventory.add',arguments:{productName:'Sữa xác nhận',quantity:1,unit:'hộp'}}));
    const canceled=await write.turn(a.user,input(a));await write.cancel(a.user,canceled.turnId as string);
    await notices.drain(false);
    expect((await notices.list(a.user,a.ws,50)).items.some(x=>x.type==='assistant.confirm')).toBe(false);
    const draft=await write.turn(a.user,input(a));const body={workspaceId:a.ws,idempotencyKey:randomUUID(),tools:draft.toolsProposed as never};
    await write.confirm(a.user,draft.turnId as string,body);await write.confirm(a.user,draft.turnId as string,body);
    await notices.drain(false);const events=(await notices.list(a.user,a.ws,50)).items.filter(x=>x.type==='assistant.confirm');
    expect(events).toHaveLength(1);expect(events[0].targetType).toBe('inventory');
    expect((await owner.$queryRaw<Array<{n:number}>>`select count(*)::int as n from public.notification_outbox where workspace_id=${a.ws}::uuid and kind='inventory.add'`)[0].n).toBe(0);
  });
  it('provider failure frees reservation; same request retries and a draft/cancel consumes only one', async () => {
    const a = await account(); let fail = true;
    const service = assistant(async () => { if (fail) throw Error('OWNED_PROVIDER_FAILURE'); return { toolId: 'shopping.add', arguments: { name: 'Owned disposable item' } }; });
    const body = input(a);
    await expect(service.turn(a.user, body)).rejects.toThrow('OWNED_PROVIDER_FAILURE');
    expect(await quota(a)).toMatchObject({ used: 0, remaining: 15 });
    fail = false; const draft = await service.turn(a.user, body);
    expect(draft.kind).toBe('write_draft');
    await service.cancel(a.user, String(draft.turnId));
    expect(await quota(a)).toMatchObject({ used: 1 });
    expect(await db.asUser(a.user, tx => tx.shoppingItem.count({ where: { workspaceId: a.ws } }))).toBe(0);
  });
  it('shared member uses the same workspace ledger; cross-tenant/actor request access is denied', async () => {
    const a = await account(), b = await account();
    await owner.workspaceMember.create({ data: { userId: b.user, workspaceId: a.ws, role: 'member' } });
    const member = { user: b.user, ws: a.ws }, request = randomUUID(), r = await admit(a, request);
    await expect(finish(member, r)).rejects.toThrow('FORBIDDEN');
    await finish(a, r); expect(await quota(member)).toMatchObject({ used: 1, total: 15 });
    await expect(quota({ user: a.user, ws: b.ws })).rejects.toThrow('FORBIDDEN');
  });
  it('application role cannot mutate usage or call private clock/settlement test boundary', async () => {
    const a = await account();
    await expect(db.$executeRaw`update public.assistant_quota_periods set used=0 where workspace_id=${a.ws}::uuid`).rejects.toThrow();
    await expect(db.$queryRaw`select public.assistant_period_at(${a.ws}::uuid,clock_timestamp())`).rejects.toThrow();
    await expect(db.$queryRaw`select public.billing_system_verified_at('claim',null::uuid,'{}'::jsonb,clock_timestamp())`).rejects.toThrow();
    await expect(db.$executeRaw`insert into public.billing_test_channels values(${ '0'.repeat(64) })`).rejects.toThrow();
  });
  it('legacy turn persistence is fenced and its original unmetered function is inaccessible', async () => {
    const a = await account();
    await expect(db.asUser(a.user, tx => tx.$queryRaw`
      select public.create_assistant_turn(${a.ws}::uuid,'owned','owned','unknown','[]'::jsonb,null::jsonb,null::jsonb,'owned',1)`))
      .rejects.toThrow('ASSISTANT_RESERVATION_REQUIRED');
    await expect(db.asUser(a.user, tx => tx.$queryRaw`
      select public.create_assistant_turn_unmetered_v1(${a.ws}::uuid,'owned','owned','unknown','[]'::jsonb,null::jsonb,null::jsonb,'owned',1)`))
      .rejects.toThrow();
    expect(await quota(a)).toMatchObject({ used: 0, remaining: 15 });
  });
  it('lease recovery fences delayed workers before turn persistence; duplicate request while reserved is blocked', async () => {
    const a = await account(), id = randomUUID(), first = await admit(a, id);
    await expect(admit(a, id)).rejects.toThrow('ASSISTANT_REQUEST_IN_PROGRESS');
    await owner.$executeRaw`update public.assistant_quota_requests set lease_until=clock_timestamp()-interval '1 second' where id=${first.reservationId}::uuid`;
    const recovered = await admit(a, id);
    expect(recovered.leaseId).not.toBe(first.leaseId);
    await expect(db.asUser(a.user, tx => tx.$queryRaw`select public.assistant_quota_assert_lease(${first.reservationId}::uuid,${first.leaseId}::uuid)`)).rejects.toThrow('ASSISTANT_LEASE_LOST');
    await finish(a, recovered); expect(await quota(a)).toMatchObject({ used: 1 });
  });
  it('Free rollover is anchored, exact at boundary and independent from reads/offline months', async () => {
    const a = await account(), anchor = new Date('2026-10-04T07:25:30Z');
    await owner.workspace.update({ where: { id: a.ws }, data: { createdAt: anchor } });
    async function at(date: string) {
      return (await owner.$queryRaw<Array<{ p: { starts_at: string; expires_at: string; used: number } }>>`
        select to_jsonb(public.assistant_period_at(${a.ws}::uuid,${date}::timestamptz)) as p`)[0].p;
    }
    const before = await at('2026-11-03T07:25:29Z'), exact = await at('2026-11-03T07:25:30Z');
    expect(new Date(before.expires_at).toISOString()).toBe('2026-11-03T07:25:30.000Z');
    expect(new Date(exact.starts_at).toISOString()).toBe('2026-11-03T07:25:30.000Z');
    expect(await at('2027-01-02T07:25:30Z')).toMatchObject({ used: 0 });
  });
  it.each(['clarify', 'unknown'] as const)('schema-valid %s is metered exactly once including typed retry', async kind => {
    const a = await account(); let calls = 0;
    const service = assistant(async () => { calls++; return { toolId: kind, arguments: kind === 'clarify' ? {question:'Owned clarification'} : {} }; });
    const body = input(a), response = await service.turn(a.user, body);
    expect(response.kind).toBe(kind); expect(await quota(a)).toMatchObject({used:1,remaining:14});
    const replay=await service.turn(a.user, body);
    expect({...replay,voiceQuota:response.voiceQuota}).toEqual(response); expect(calls).toBe(1);
    expect(replay.voiceQuota).toMatchObject({used:1,remaining:14,poolWorkspaceId:a.ws,shared:false});
    expect(await quota(a)).toMatchObject({used:1});
  });
  it('confirmed mutation and duplicate confirmation do not charge a second logical turn', async () => {
    const a = await account();
    const service = assistant(async () => ({toolId:'shopping.add',arguments:{name:'Owned quota confirm'}}));
    const draft = await service.turn(a.user, input(a));
    const body = {workspaceId:a.ws,idempotencyKey:randomUUID(),tools:[{toolId:'shopping.add',arguments:{name:'Owned quota confirm'}}]};
    await service.confirm(a.user,String(draft.turnId),body);
    await service.confirm(a.user,String(draft.turnId),body);
    expect(await quota(a)).toMatchObject({used:1,remaining:14});
    expect(await db.asUser(a.user,tx=>tx.shoppingItem.count({where:{workspaceId:a.ws}}))).toBe(1);
  });
  it('one last slot admits one concurrent logical turn; DB bounds reject negative/overflow usage', async () => {
    const a = await account(); await quota(a);
    await owner.$executeRaw`update public.assistant_quota_periods set used=14 where workspace_id=${a.ws}::uuid`;
    const results = await Promise.all(Array.from({length:8},()=>admit(a)));
    expect(results.filter(r=>r.exhausted)).toHaveLength(7);
    await finish(a,results.find(r=>!r.exhausted)!);
    expect(await quota(a)).toMatchObject({used:15,remaining:0});
    for(const used of [-1,16,2147483648]) {
      await expect(owner.$executeRaw`update public.assistant_quota_periods set used=${used} where workspace_id=${a.ws}::uuid`).rejects.toThrow();
    }
    expect(await quota(a)).toMatchObject({used:15});
  });
});
