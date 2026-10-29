import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireDisposableDatabase } from './disposable-database';
import { deleteFixtureUsers } from './support/delete-fixture-users';

describe.skipIf(process.env.RUN_DB_TESTS !== '1')('Fixture cleanup and the normal bounded outbox worker', () => {
  const db = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
  const owned: string[] = [];
  const workspaces:string[]=[];
  beforeAll(() => requireDisposableDatabase());
  afterAll(async () => { await deleteFixtureUsers(db, owned,workspaces); await db.$disconnect(); });
  async function scenario(safe: boolean,workspaceCascade=false) {
    const uid = randomUUID(), label = 'cleanup-' + uid; owned.push(uid);
    await db.$executeRaw`insert into public.users(id,email,password_hash) values(${uid}::uuid,${uid+'@example.invalid'},'LOCAL_NOT_AN_AUTH_CREDENTIAL')`;
    await db.$executeRaw`insert into public.profiles(id,display_name) values(${uid}::uuid,'Local cleanup fixture')`;
    const workspace=workspaceCascade?randomUUID():null;
    if(workspace){
      workspaces.push(workspace);
      await db.$executeRaw`insert into public.workspaces(id,name) values(${workspace}::uuid,'Local cleanup workspace')`;
      await db.$executeRaw`insert into public.workspace_members(workspace_id,user_id,role) values(${workspace}::uuid,${uid}::uuid,'owner')`;
      await db.$executeRaw`select public.notification_enqueue(${'cleanup-workspace:'+workspace},${uid}::uuid,${workspace}::uuid,false,'inventory.add','Owned workspace','Changed','Changed','home',null,clock_timestamp())`;
    }
    await db.$executeRaw`update public.notification_outbox set available_at=now()-interval '1 year' where recipient_id=${uid}::uuid`;
    let entered!: () => void, deliver!: () => void;
    const ready = new Promise<void>(resolve => entered = resolve), gate = new Promise<void>(resolve => deliver = resolve);
    const worker = db.$transaction(async tx => {
      await tx.$queryRaw`select id from public.notification_outbox where recipient_id=${uid}::uuid for update`;
      entered(); await gate;
      await tx.$queryRaw`select public.notification_deliver()`;
    }, { timeout: 10000 });
    await ready;
    const cleanup = safe ? deleteFixtureUsers(db,[uid],workspace?[workspace]:[]) : db.$transaction(async tx => {
      await tx.$queryRaw`select set_config('application_name',${label},true)`;
      if(workspace)await tx.workspace.delete({where:{id:workspace}});
      else await tx.user.delete({ where: { id: uid } });
    }, { timeout: 10000 });
    // Observe the actual lock wait before releasing the worker, no arbitrary sleep.
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const rows = await db.$queryRaw<Array<{ waiting: boolean }>>`select exists(select 1 from pg_stat_activity where application_name=${label} and wait_event_type='Lock') as waiting`;
      if (rows[0].waiting) { waiting = true; break; }
      await delay(10);
    }
    deliver();
    const results = await Promise.allSettled([cleanup, worker]);
    expect(waiting).toBe(true);
    return results;
  }
  it('reproduces the user-first cascade deadlock with real worker/FK locks', async () => {
    const results = await scenario(false);
    expect(results.some(r => r.status === 'rejected' && /40P01|deadlock detected/.test(String(r.reason)))).toBe(true);
  }, 15000);
  it('outbox-first owned teardown completes while worker delivery remains bounded', async () => {
    const results = await scenario(true);
    expect(results.every(r => r.status === 'fulfilled')).toBe(true);
  }, 15000);
  it('reproduces workspace-first cascade deadlock and repairs only fixture FK order',async()=>{
    expect((await scenario(false,true)).some(r=>r.status==='rejected'&&/40P01|deadlock detected/.test(String(r.reason)))).toBe(true);
    expect((await scenario(true,true)).every(r=>r.status==='fulfilled')).toBe(true);
  },15000);
});
