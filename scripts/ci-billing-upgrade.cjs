// Private operator fixtures for an ephemeral upgrade DB, never payment evidence.
const { PrismaClient } = require('@prisma/client');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
if (process.env.HOMEMIND_ISOLATED_CI !== '1' || !/^\/homemind_upgrade_[a-f0-9]{12}$/.test(new URL(process.env.MIGRATION_DATABASE_URL).pathname)) throw new Error('Owned upgrade database required');
const db = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
const channel = 'e'.repeat(64);
const mode = process.argv[2];
async function actor(tx, type, tag) {
  const user = randomUUID();
  await tx.user.create({ data: { id: user, email: `legacy-upgrade+${user}@example.invalid`, phone: '+84901234567'.slice(0, -4) + String(Math.floor(Math.random()*9000)+1000), passwordHash: 'NOT_A_LOGIN_FIXTURE' }, select: { id: true } });
  await tx.$queryRaw`select set_config('app.user_id',${user},true)`;
  const [{ id }] = await tx.$queryRaw`select public.provision_home(${user}::uuid,${tag},${type}) as id`;
  return { user, ws: id };
}
async function prepared(tx, a, price, key = randomUUID()) {
  await tx.$queryRaw`select set_config('app.user_id',${a.user},true)`;
  const [{ p }] = await tx.$queryRaw`select public.billing_prepare(${a.ws}::uuid,${price},${key}::uuid,'LEGACY_UPGRADE_FIXTURE',1,${channel}) as p`;
  return { ...p, key };
}
async function snapshot(tx) {
  return (await tx.$queryRaw`select jsonb_build_object(
    'orders',(select jsonb_agg(jsonb_build_object('id',id,'workspace',workspace_id,'code',order_code,'price',price_snapshot,'status',status,'financial',financial_state,'fulfillment',fulfillment,'paidAt',paid_at,'amount',amount_paid) order by id) from public.billing_orders),
    'grants',(select jsonb_agg(jsonb_build_object('id',id,'order',order_id,'workspace',workspace_id,'plan',plan,'starts',starts_at,'expires',expires_at,'price',price_snapshot) order by id) from public.billing_grants),
    'transactions',(select jsonb_agg(to_jsonb(t) order by reference) from public.billing_transactions t),
    'entitlements',(select jsonb_agg(jsonb_build_object('workspace_id',workspace_id,'plan',plan,'product_limit',product_limit,'updated_at',updated_at,'source',source) order by workspace_id) from public.workspace_entitlements),
    'v1Prices',(select jsonb_agg(jsonb_build_object('id',id,'plan',plan,'amount',amount,'months',months,'currency',currency,'productLimit',product_limit) order by id) from public.billing_prices where id like '%-v1')
  ) as s`)[0].s;
}
async function seed() {
  await db.$transaction(async tx => {
    const current = await actor(tx, 'household', 'Legacy paid coverage');
    const p = await prepared(tx, current, 'personal-month-v1');
    await tx.$executeRaw`update public.billing_orders set status='PAID',financial_state='PAID',fulfillment='GRANTED',amount_paid=29000,paid_at=clock_timestamp()-interval '1 day' where id=${p.id}::uuid`;
    await tx.$executeRaw`insert into public.billing_grants(order_id,workspace_id,plan,product_limit,starts_at,expires_at,price_snapshot)
      select id,workspace_id,'personal',null,clock_timestamp()-interval '1 day',clock_timestamp()-interval '1 day'+interval '1 month',price_snapshot from public.billing_orders where id=${p.id}::uuid`;
    const q = await prepared(tx, current, 'personal-month-v1');
    await tx.$executeRaw`update public.billing_orders set status='PAID',financial_state='PAID',fulfillment='GRANTED',amount_paid=29000,paid_at=clock_timestamp() where id=${q.id}::uuid`;
    await tx.$executeRaw`insert into public.billing_grants(order_id,workspace_id,plan,product_limit,starts_at,expires_at,price_snapshot)
      select o.id,o.workspace_id,'personal',null,g.expires_at,g.expires_at+interval '1 month',o.price_snapshot from public.billing_orders o join public.billing_grants g on g.order_id=${p.id}::uuid where o.id=${q.id}::uuid`;
    await tx.$executeRaw`update public.workspace_entitlements set plan='personal',product_limit=null,source='billing' where workspace_id=${current.ws}::uuid`;
    await tx.$executeRaw`insert into public.billing_transactions(channel,reference,order_id,amount,paid_at) select channel,'LEGACY_FIXTURE_'||id,id,29000,paid_at from public.billing_orders where workspace_id=${current.ws}::uuid`;
    const manual = await actor(tx, 'store', 'Legacy manual coverage');
    await tx.$executeRaw`update public.workspace_entitlements set plan='micro_pos',product_limit=500,source='legacy_manual' where workspace_id=${manual.ws}::uuid`;
    const pending = await actor(tx, 'household', 'Legacy pending purchase');
    const order = await prepared(tx, pending, 'personal-month-v1');
    await tx.$executeRaw`update public.billing_orders set status='PENDING',payment_link_id='owned-upgrade-link',checkout_url='https://pay.payos.vn/web/owned-upgrade-link' where id=${order.id}::uuid`;
    await tx.$executeRaw`create table public.ppv_upgrade_fixture (id integer primary key, state jsonb not null)`;
    await tx.$executeRaw`revoke all on public.ppv_upgrade_fixture from public,homemind_app`;
    const state = { current, manual, pending, order, before: await snapshot(tx), classification: 'SIMULATED_LEGACY_MIGRATION_FIXTURE' };
    await tx.$executeRaw`insert into public.ppv_upgrade_fixture values(1,${JSON.stringify(state)}::jsonb)`;
  });
}
async function verify() {
  await db.$transaction(async tx => {
    const [{ state }] = await tx.$queryRaw`select state from public.ppv_upgrade_fixture where id=1`;
    assert.equal(state.classification, 'SIMULATED_LEGACY_MIGRATION_FIXTURE');
    assert.deepEqual(await snapshot(tx), state.before, 'Legacy financial snapshots/coverage/entitlements changed during migration');
    assert.equal((await tx.$queryRaw`select count(*)::int as n from public.workspace_entitlements where feedback_manual_released_at is not null`)[0].n, 0,
      'Legacy rows without feedback must not acquire a manual reward release boundary');
    assert.equal((await tx.$queryRaw`select count(*)::int as n from public.billing_grants where effective_until is not null or superseded_at is not null`)[0].n, 0);
    assert.equal((await tx.$queryRaw`select count(*)::int as n from public.billing_prices where active and policy_version='voice-30d-v2'`)[0].n, 3);
    for (const a of [state.current, state.manual, state.pending]) {
      const [{ valid }] = await tx.$queryRaw`select p.phone=u.phone as valid from public.profiles p join public.users u on u.id=p.id where p.id=${a.user}::uuid`;
      assert.equal(valid, true, 'Approved contact backfill failed');
    }
    await tx.$queryRaw`select set_config('app.user_id',${state.pending.user},true)`;
    const replay = await prepared(tx, state.pending, 'personal-month-v1', state.order.key);
    assert.equal(replay.id, state.order.id); assert.deepEqual(replay.price, state.order.price);
    const [{ manual }] = await tx.$queryRaw`select public.billing_purchase_reason(${state.manual.ws}::uuid,'micro_pos',clock_timestamp()) as manual`;
    assert.equal(manual, 'MANUAL_PLAN_REQUIRES_REVIEW');
    const [{ reason }] = await tx.$queryRaw`select public.billing_purchase_reason(${state.current.ws}::uuid,'family',clock_timestamp()) as reason`;
    assert.equal(reason, 'LEGACY_COVERAGE_REQUIRES_REVIEW');
    const [{ p }] = await tx.$queryRaw`select to_jsonb(public.assistant_period_at(${state.current.ws}::uuid,clock_timestamp())) as p`;
    assert.equal(p.usage_limit,60);
    // Finish a pre-upgrade pending order through the unchanged domain boundary;
    // it still receives the calendar contract in its immutable v1 snapshot.
    const [{ t }] = await tx.$queryRaw`select clock_timestamp() as t`;
    const paidAt = new Date(t).toISOString();
    const [{ description }] = await tx.$queryRaw`select description from public.billing_orders where id=${state.order.id}::uuid`;
    const data = { channel, id:'owned-upgrade-link', orderCode:Number(state.order.orderCode), amount:29000, amountPaid:29000, amountRemaining:0, status:'PAID', transactions:[{reference:'SIMULATED_LEGACY_PENDING', amount:29000, description, transactionDateTime:paidAt}] };
    const [{ settled }] = await tx.$queryRaw`select public.billing_system_verified_at('settle',${state.order.id}::uuid,${JSON.stringify(data)}::jsonb,${paidAt}::timestamptz) as settled`;
    assert.equal(settled.fulfillment,'GRANTED');
    const [{ calendar }] = await tx.$queryRaw`select expires_at=((starts_at at time zone 'Asia/Ho_Chi_Minh')+interval '1 month') at time zone 'Asia/Ho_Chi_Minh' as calendar from public.billing_grants where order_id=${state.order.id}::uuid`;
    assert.equal(calendar,true);
  });
}
(async () => {
  if (mode === 'seed') await seed(); else if (mode === 'verify') await verify(); else throw new Error('Unknown rehearsal mode');
  console.log('Legacy billing upgrade '+mode+': PASS; simulated fixture only; real provider calls: 0');
})().catch(() => { console.error('Legacy billing upgrade fixture: FAIL; private details suppressed'); process.exitCode=1; }).finally(() => db.$disconnect());
