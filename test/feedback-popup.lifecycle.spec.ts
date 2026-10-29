import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { requireDisposableDatabase } from './disposable-database';
import { acquireCampaignLock } from './feedback-popup.lock';
import { FeedbackPopupService } from '../src/feedback-popup/feedback-popup.service';

const CAMPAIGN = 'homepage-feedback-premium-30d';
const DAY = 86_400_000;
const THIRTY_DAYS = 30 * DAY;
const DOMAIN = '@fp-sql.example';

// Real PostgreSQL, private clock: every time-dependent decision is made by passing an explicit instant
// to the *_at functions (the same technique the billing suite uses). Nothing waits for real days.
describe.skipIf(process.env.RUN_DB_TESTS !== '1')('feedback popup reward lifecycle on real PostgreSQL', () => {
  const operator = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
  let release: () => Promise<void>;
  const users: string[] = [];
  const workspaces: string[] = [];
  const phones = new Set<string>();

  const iso = (value: Date | string) => new Date(value).toISOString();
  const after = (value: Date, ms: number) => new Date(value.getTime() + ms);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q = <T = any>(sql: string, ...params: unknown[]) => operator.$queryRawUnsafe<T[]>(sql, ...params);
  const uniqueEmail = () => `fp-${randomUUID()}${DOMAIN}`;
  function uniquePhone() {
    for (;;) {
      const phone = '+8491' + String(Math.floor(Math.random() * 1e7)).padStart(7, '0');
      if (!phones.has(phone)) { phones.add(phone); return phone; }
    }
  }
  const setEnabled = (on: boolean) => q('update public.feedback_popup_campaigns set enabled=$1,revision=revision+1,updated_at=clock_timestamp() where id=$2', on, CAMPAIGN);

  async function createUser(o: { email?: string | null; phone?: string | null; createdAt?: Date; type?: 'household' | 'store' } = {}) {
    const id = randomUUID();
    const email = o.email === undefined ? uniqueEmail() : o.email;
    const phone = o.phone === undefined ? null : o.phone;
    await operator.$transaction(async tx => {
      await tx.$executeRawUnsafe("insert into public.users(id,email,phone,password_hash,created_at) values($1::uuid,$2,$3,'not-a-login-fixture',$4::timestamptz)", id, email, phone, iso(o.createdAt ?? new Date()));
      await tx.$queryRawUnsafe("select set_config('app.user_id',$1,true)", id);
      await tx.$queryRawUnsafe("select public.provision_home($1::uuid,'Synthetic fixture',$2)", id, o.type ?? 'household');
    });
    const [{ workspace_id }] = await q<{ workspace_id: string }>("select workspace_id from public.workspace_members where user_id=$1::uuid and role='owner'", id);
    users.push(id); workspaces.push(workspace_id);
    return { id, email, phone, workspaceId: workspace_id };
  }
  type Account = Awaited<ReturnType<typeof createUser>>;

  async function submit(o: { email: string; phone: string; at?: Date; key?: string | null; hash?: string; name?: string; review?: string; submitter?: string | null }) {
    const hash = o.hash ?? createHash('sha256').update(o.email + o.phone + (o.review ?? '')).digest('hex');
    const rows = await q<{ r: { submissionId: string; submittedAt: string; replayed: boolean; workspaceId: string | null; rewardState: string | null } }>(
      'select public.feedback_popup_submit_at($1,$2,$3,$4,$5,$6::uuid,$7,$8::uuid,null,null,$9::timestamptz) as r',
      CAMPAIGN, o.name ?? 'Nguyễn Thị Ánh', o.email, o.phone, o.review ?? 'HomeMind rất hữu ích', o.key ?? null, hash, o.submitter ?? null, iso(o.at ?? new Date()));
    return rows[0].r;
  }
  const reward = async (submissionId: string) => (await q('select * from public.feedback_popup_rewards where submission_id=$1::uuid', submissionId))[0];
  const segments = (submissionId: string) => q(
    'select g.id,g.starts_at,g.expires_at,g.effective_until,g.superseded_at,g.superseded_by,g.source_kind,g.order_id,g.plan from public.billing_grants g join public.feedback_popup_rewards r on r.id=g.reward_id where r.submission_id=$1::uuid order by g.starts_at,g.id', submissionId);
  const probe = async (workspaceId: string, at: Date, offset = '0 microseconds') =>
    (await q<{ e: { plan: string; productLimit: number | null; source: string } }>('select public.billing_refresh_at($1::uuid,$2::timestamptz+$3::interval) as e', workspaceId, iso(at), offset))[0].e;
  const quotaLimit = async (workspaceId: string, at: Date) =>
    (await q<{ n: number }>('select (public.assistant_period_at($1::uuid,$2::timestamptz)).usage_limit::int as n', workspaceId, iso(at)))[0].n;
  const activeKind = async (workspaceId: string, at: Date) =>
    (await q<{ k: string }>('select source_kind as k from public.billing_grants where workspace_id=$1::uuid and starts_at<=$2::timestamptz and coalesce(effective_until,expires_at)>$2::timestamptz', workspaceId, iso(at))).map(row => row.k);

  const PRICES = {
    personal: { id: 'personal-month-v2', amount: 29000, voiceLimit: 60 },
    family: { id: 'family-month-v2', amount: 59000, voiceLimit: 100 },
  } as const;
  type Plan = keyof typeof PRICES;
  const snapshot = (plan: Plan) => ({ id: PRICES[plan].id, plan, amount: PRICES[plan].amount, currency: 'VND', durationSeconds: 2592000,
    voiceLimit: PRICES[plan].voiceLimit, workspaceType: 'household', productLimit: null, transition: 'immediate_upgrade', policyVersion: 'voice-30d-v2' });

  /** A purchased grant inserted directly (the shape billing writes), for scenarios that only need the timeline. */
  async function paidGrant(a: Account, plan: Plan, startsAt: Date, expiresAt: Date) {
    const order = randomUUID();
    await q(`insert into public.billing_orders(id,workspace_id,actor_id,idempotency_key,payload_hash,order_code,channel,price_id,price_snapshot,description,status,financial_state,fulfillment,amount_paid,origin,paid_at)
      values($1::uuid,$2::uuid,$3::uuid,$4::uuid,'fp-test',9000000000000+nextval('public.billing_order_sequence'),'fp-test-channel',$5,$6::jsonb,'FPTEST001','PAID','PAID','GRANTED',$7,'SIMULATED_TEST',$8::timestamptz)`,
    order, a.workspaceId, a.id, randomUUID(), PRICES[plan].id, JSON.stringify(snapshot(plan)), PRICES[plan].amount, iso(startsAt));
    await q('update public.workspace_entitlements set source=$2 where workspace_id=$1::uuid', a.workspaceId, 'billing');
    const [grant] = await q<{ id: string }>('insert into public.billing_grants(order_id,workspace_id,plan,product_limit,starts_at,expires_at,price_snapshot) values($1::uuid,$2::uuid,$3,null,$4::timestamptz,$5::timestamptz,$6::jsonb) returning id',
      order, a.workspaceId, plan, iso(startsAt), iso(expiresAt), JSON.stringify(snapshot(plan)));
    await q('select public.billing_refresh_at($1::uuid,$2::timestamptz)', a.workspaceId, iso(new Date()));
    return { orderId: order, grantId: grant.id };
  }

  /** A real settlement through billing_system_verified_at, exactly like the billing suite's private-clock fixture. */
  async function purchase(a: Account, plan: Plan, paidAt: Date, now = paidAt) {
    const id = randomUUID(), link = randomUUID().replaceAll('-', ''), channel = 'fp-test-' + '0'.repeat(56);
    const [{ order_code }] = await q<{ order_code: bigint }>(`insert into public.billing_orders(id,workspace_id,actor_id,idempotency_key,payload_hash,order_code,channel,price_id,price_snapshot,description,payment_link_id,status,created_at,expires_at,origin)
      values($1::uuid,$2::uuid,$3::uuid,$4::uuid,'fp-test',9000000000000+nextval('public.billing_order_sequence'),$5,$6,$7::jsonb,'FPTEST002',$8,'PENDING',$9::timestamptz,$10::timestamptz,'SIMULATED_TEST') returning order_code`,
    id, a.workspaceId, a.id, randomUUID(), channel, PRICES[plan].id, JSON.stringify(snapshot(plan)), link, iso(after(paidAt, -60_000)), iso(after(paidAt, 3_600_000)));
    const payload = { channel, id: link, orderCode: Number(order_code), amount: PRICES[plan].amount, amountPaid: PRICES[plan].amount, amountRemaining: 0, status: 'PAID',
      transactions: [{ reference: randomUUID(), amount: PRICES[plan].amount, description: 'FPTEST002', transactionDateTime: iso(paidAt) }] };
    const rows = await q<{ r: { fulfillment: string; reviewReason: string | null } }>("select public.billing_system_verified_at('settle',$1::uuid,$2::jsonb,$3::timestamptz) as r", id, JSON.stringify(payload), iso(now));
    return { orderId: id, ...rows[0].r };
  }

  const billedSeconds = async (submissionId: string) => (await q<{ n: string }>(
    'select coalesce(round(sum(extract(epoch from (coalesce(g.effective_until,g.expires_at)-g.starts_at)))),0)::bigint::text as n from public.billing_grants g join public.feedback_popup_rewards r on r.id=g.reward_id where r.submission_id=$1::uuid', submissionId))[0].n;

  beforeAll(async () => {
    requireDisposableDatabase();
    release = await acquireCampaignLock(operator);
    await setEnabled(true);
  }, 600_000);

  afterAll(async () => {
    try {
      await operator.$transaction(async tx => {
        const ids = workspaces;
        await tx.$executeRawUnsafe("delete from public.billing_grants where workspace_id=any($1::uuid[]) or reward_id in (select r.id from public.feedback_popup_rewards r join public.feedback_popup_submissions s on s.id=r.submission_id where s.email like $2)", ids, '%' + DOMAIN);
        await tx.$executeRawUnsafe('delete from public.billing_transactions where order_id in (select id from public.billing_orders where workspace_id=any($1::uuid[]))', ids);
        await tx.$executeRawUnsafe('delete from public.billing_orders where workspace_id=any($1::uuid[])', ids);
        await tx.$executeRawUnsafe('delete from public.feedback_popup_claim_retries where user_id=any($1::uuid[])', users);
        await tx.$executeRawUnsafe('delete from public.feedback_popup_rewards where submission_id in (select id from public.feedback_popup_submissions where email like $1)', '%' + DOMAIN);
        await tx.$executeRawUnsafe('delete from public.feedback_popup_submissions where email like $1', '%' + DOMAIN);
        await tx.$executeRawUnsafe('delete from public.workspaces where id=any($1::uuid[])', ids);
        await tx.$executeRawUnsafe('delete from public.users where id=any($1::uuid[])', users);
        await tx.$executeRawUnsafe('update public.feedback_popup_campaigns set enabled=false where id=$1', CAMPAIGN);
      }, { timeout: 30_000 });
    } finally {
      await release?.();
      await operator.$disconnect();
    }
  }, 120_000);

  // ---------------------------------------------------------------------------------------------
  describe('configuration', () => {
    it('is one stable campaign, disabled by default, and the admin toggle is idempotent, versioned and audited', async () => {
      await q('update public.feedback_popup_campaigns set enabled=false,revision=10 where id=$1', CAMPAIGN);
      const [before] = await q('select created_at from public.feedback_popup_campaigns where id=$1', CAMPAIGN);
      const [{ started }] = await q<{ started: Date }>('select clock_timestamp() as started');
      const set = async (enabled: boolean, expected: number | null) => (await q<{ r: Record<string, unknown> }>(
        'select public.feedback_popup_admin_set($1::boolean,$2::integer,null::uuid,$3::uuid) as r', enabled, expected, randomUUID()))[0].r;
      expect(await set(true, 10)).toMatchObject({ enabled: true, revision: 11, changed: true });
      expect(await set(true, 11)).toMatchObject({ enabled: true, revision: 11, changed: false }); // same value: no new revision
      await expect(set(true, 5)).rejects.toThrow('CONFIG_REVISION_CONFLICT');
      expect(await set(false, null)).toMatchObject({ enabled: false, revision: 12, changed: true });
      expect(await set(true, null)).toMatchObject({ enabled: true, revision: 13, changed: true }); // off then on: same campaign
      expect(await q('select count(*)::int as n from public.feedback_popup_campaigns')).toEqual([{ n: 1 }]);
      const [after2] = await q('select created_at from public.feedback_popup_campaigns where id=$1', CAMPAIGN);
      expect(iso(after2.created_at)).toBe(iso(before.created_at));
      const events = await q('select previous_enabled,enabled,previous_revision,revision from public.feedback_popup_config_events where campaign_id=$1 and occurred_at>=$2::timestamptz order by occurred_at,id', CAMPAIGN, iso(started));
      expect(events).toEqual([
        { previous_enabled: false, enabled: true, previous_revision: 10, revision: 11 },
        { previous_enabled: true, enabled: false, previous_revision: 11, revision: 12 },
        { previous_enabled: false, enabled: true, previous_revision: 12, revision: 13 },
      ]);
      await expect(q("insert into public.feedback_popup_campaigns(id) values('another-campaign')")).rejects.toThrow();
    });

    it('a disabled campaign rejects NEW submissions only; an accepted request can still be replayed', async () => {
      await setEnabled(true);
      const key = randomUUID(), email = uniqueEmail(), phone = uniquePhone();
      const first = await submit({ email, phone, key });
      await setEnabled(false);
      await expect(submit({ email: uniqueEmail(), phone: uniquePhone() })).rejects.toThrow('FEEDBACK_POPUP_DISABLED');
      expect(await q('select count(*)::int as n from public.feedback_popup_submissions where email like $1 and email<>$2', '%' + DOMAIN, email)).toBeDefined();
      const replay = await submit({ email, phone, key });
      expect(replay).toMatchObject({ replayed: true, submissionId: first.submissionId });
      await setEnabled(true);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('existing accounts', () => {
    it('Free account: Premium starts at the accepted submission, with exact half-open 30-day boundaries and Premium quota', async () => {
      const a = await createUser({ createdAt: after(new Date(), -10 * DAY) });
      const now = new Date();
      const s = await submit({ email: a.email!, phone: uniquePhone(), at: now });
      expect(s).toMatchObject({ replayed: false, workspaceId: a.workspaceId, rewardState: 'GRANTED' });
      const r = await reward(s.submissionId);
      expect(r).toMatchObject({ state: 'GRANTED', user_id: a.id, workspace_id: a.workspaceId, plan: 'personal', duration_seconds: 2592000 });
      expect(iso(r.anchor_at)).toBe(iso(now)); // max(account.createdAt, submittedAt)
      const [seg, ...rest] = await segments(s.submissionId);
      expect(rest).toHaveLength(0);
      expect(seg).toMatchObject({ source_kind: 'PROMOTION', order_id: null, plan: 'personal' });
      const end = after(now, THIRTY_DAYS);
      expect(iso(seg.starts_at)).toBe(iso(now));
      expect(iso(seg.expires_at)).toBe(iso(end));
      // startsAt <= now < endsAt
      expect(await probe(a.workspaceId, now, '-1 microsecond')).toMatchObject({ plan: 'free', productLimit: 30 });
      expect(await probe(a.workspaceId, now)).toMatchObject({ plan: 'personal', productLimit: null, source: 'billing' });
      expect(await probe(a.workspaceId, end, '-1 microsecond')).toMatchObject({ plan: 'personal' });
      expect(await probe(a.workspaceId, end)).toMatchObject({ plan: 'free', productLimit: 30 });
      // Usage quota is the real Premium allowance during the reward and Free afterwards.
      expect(await quotaLimit(a.workspaceId, after(now, 3_600_000))).toBe(60);
      expect(await quotaLimit(a.workspaceId, after(end, 3_600_000))).toBe(15);
    });

    it('Premium product limit is actually lifted while the reward is active and enforced again after it ends', async () => {
      const a = await createUser();
      const s = await submit({ email: a.email!, phone: uniquePhone() });
      await q("insert into public.products(workspace_id,name,name_normalized) select $1::uuid,'Mon '||g,'mon '||g from generate_series(1,31) g", a.workspaceId);
      expect(await q('select count(*)::int as n from public.products where workspace_id=$1::uuid', a.workspaceId)).toEqual([{ n: 31 }]);
      // Move the whole reward 40 days into the past: it has ended, Free's 30-item limit applies again.
      await q("update public.billing_grants set starts_at=starts_at-interval '40 days',expires_at=expires_at-interval '40 days' where reward_id=(select id from public.feedback_popup_rewards where submission_id=$1::uuid)", s.submissionId);
      await expect(q("insert into public.products(workspace_id,name,name_normalized) values($1::uuid,'Mon 32','mon 32')", a.workspaceId)).rejects.toThrow('PLAN_LIMIT_REACHED');
    });

    it('Premium owner keeps every paid day: the reward is appended after the existing paid period', async () => {
      const a = await createUser();
      const now = new Date();
      const paidEnd = after(now, 25 * DAY);
      const paid = await paidGrant(a, 'personal', after(now, -5 * DAY), paidEnd);
      const s = await submit({ email: a.email!, phone: uniquePhone(), at: now });
      const [seg] = await segments(s.submissionId);
      expect(iso(seg.starts_at)).toBe(iso(paidEnd));
      expect(iso(seg.expires_at)).toBe(iso(after(paidEnd, THIRTY_DAYS)));
      const [grant] = await q('select expires_at,effective_until,superseded_at from public.billing_grants where id=$1::uuid', paid.grantId);
      expect(iso(grant.expires_at)).toBe(iso(paidEnd));
      expect(grant.effective_until).toBeNull();
      expect(await probe(a.workspaceId, paidEnd, '-1 microsecond')).toMatchObject({ plan: 'personal' });
      expect(await activeKind(a.workspaceId, after(paidEnd, -1))).toEqual(['PAID']);
      expect(await activeKind(a.workspaceId, paidEnd)).toEqual(['PROMOTION']);
      expect(await probe(a.workspaceId, after(paidEnd, THIRTY_DAYS))).toMatchObject({ plan: 'free' });
    });

    it('higher tier is never downgraded: the full reward is queued behind the real end of the higher plan', async () => {
      const a = await createUser();
      const now = new Date();
      const familyEnd = after(now, 29 * DAY);
      await paidGrant(a, 'family', after(now, -1 * DAY), familyEnd);
      const s = await submit({ email: a.email!, phone: uniquePhone(), at: now });
      const [seg] = await segments(s.submissionId);
      expect(iso(seg.starts_at)).toBe(iso(familyEnd));
      expect(iso(seg.expires_at)).toBe(iso(after(familyEnd, THIRTY_DAYS)));
      expect(await probe(a.workspaceId, now)).toMatchObject({ plan: 'family' });
      expect(await probe(a.workspaceId, after(familyEnd, -1))).toMatchObject({ plan: 'family' });
      expect(await probe(a.workspaceId, familyEnd)).toMatchObject({ plan: 'personal', productLimit: null });
      expect(await probe(a.workspaceId, after(familyEnd, THIRTY_DAYS))).toMatchObject({ plan: 'free' });
    });

    it('renewing or extending the higher tier postpones the queued reward instead of overlapping it', async () => {
      const a = await createUser();
      const now = new Date();
      const familyEnd = after(now, 29 * DAY);
      await paidGrant(a, 'family', after(now, -1 * DAY), familyEnd);
      const s = await submit({ email: a.email!, phone: uniquePhone(), at: now });
      const extendedEnd = after(familyEnd, 30 * DAY);
      await paidGrant(a, 'family', familyEnd, extendedEnd);
      const [seg] = await segments(s.submissionId);
      expect(iso(seg.starts_at)).toBe(iso(extendedEnd));
      expect(iso(seg.expires_at)).toBe(iso(after(extendedEnd, THIRTY_DAYS)));
      expect(await probe(a.workspaceId, after(extendedEnd, -1))).toMatchObject({ plan: 'family' });
      expect(await probe(a.workspaceId, extendedEnd)).toMatchObject({ plan: 'personal' });
    });

    it('expired higher-tier history does not block an immediate reward', async () => {
      const a = await createUser();
      const now = new Date();
      await paidGrant(a, 'family', after(now, -40 * DAY), after(now, -10 * DAY));
      const s = await submit({ email: a.email!, phone: uniquePhone(), at: now });
      const [seg] = await segments(s.submissionId);
      expect(iso(seg.starts_at)).toBe(iso(now));
      expect(await probe(a.workspaceId, after(now, 1000))).toMatchObject({ plan: 'personal' });
    });

    it('an indefinite (manual) paid plan keeps the reward waiting, unconsumed and without an invented end date', async () => {
      const a = await createUser({ createdAt: after(new Date(), -5 * DAY) });
      await q("update public.workspace_entitlements set plan='family',product_limit=null,source='legacy_manual' where workspace_id=$1::uuid", a.workspaceId);
      const submitted = after(new Date(), -2 * 3_600_000);
      const s = await submit({ email: a.email!, phone: uniquePhone(), at: submitted });
      expect(s.rewardState).toBe('WAITING_ENTITLEMENT');
      expect(await reward(s.submissionId)).toMatchObject({ state: 'WAITING_ENTITLEMENT', reason: 'INDEFINITE_ENTITLEMENT', user_id: a.id });
      expect(await segments(s.submissionId)).toHaveLength(0);
      expect(await q('select plan,source from public.workspace_entitlements where workspace_id=$1::uuid', a.workspaceId)).toEqual([{ plan: 'family', source: 'legacy_manual' }]);
      // The operator ends the manual plan one hour ago; the clock runs from that moment, not from the submission.
      const released = after(new Date(), -3_600_000);
      await q("update public.workspace_entitlements set plan='free',product_limit=30,source='free',updated_at=$2::timestamptz where workspace_id=$1::uuid", a.workspaceId, iso(released));
      await q('select public.feedback_popup_reconcile(50)');
      expect(await reward(s.submissionId)).toMatchObject({ state: 'GRANTED' });
      const [seg] = await segments(s.submissionId);
      expect(iso(seg.starts_at)).toBe(iso(released));
      expect(await q('select public.feedback_popup_reconcile(50)')).toBeDefined(); // a second run changes nothing
      expect(await segments(s.submissionId)).toHaveLength(1);
    });

    it('an ended reward never downgrades a still-valid paid plan, and an order cancellation moves nothing', async () => {
      const a = await createUser();
      const s = await submit({ email: a.email!, phone: uniquePhone() });
      await q("update public.billing_grants set starts_at=starts_at-interval '40 days',expires_at=expires_at-interval '40 days' where reward_id=(select id from public.feedback_popup_rewards where submission_id=$1::uuid)", s.submissionId);
      const now = new Date();
      await paidGrant(a, 'personal', after(now, -5 * DAY), after(now, 25 * DAY));
      expect(await probe(a.workspaceId, now)).toMatchObject({ plan: 'personal', source: 'billing' });
      expect(await activeKind(a.workspaceId, now)).toEqual(['PAID']);
      // Only grant end dates place a reward: a cancelled (never paid) order is irrelevant to the timeline.
      const queued = await createUser();
      const t0 = new Date();
      await paidGrant(queued, 'family', after(t0, -1 * DAY), after(t0, 29 * DAY));
      const waiting = await submit({ email: queued.email!, phone: uniquePhone(), at: t0 });
      const [before] = await segments(waiting.submissionId);
      await q(`insert into public.billing_orders(workspace_id,actor_id,idempotency_key,payload_hash,order_code,channel,price_id,price_snapshot,description,status,cancelled_at,origin)
        values($1::uuid,$2::uuid,$3::uuid,'fp-test',9000000000000+nextval('public.billing_order_sequence'),'fp-test-channel','family-month-v2',$4::jsonb,'FPTEST003','CANCELLED',now(),'SIMULATED_TEST')`,
      queued.workspaceId, queued.id, randomUUID(), JSON.stringify(snapshot('family')));
      await operator.$executeRawUnsafe('select public.feedback_popup_realign_at($1::uuid,clock_timestamp())', queued.workspaceId); // returns void
      expect(await segments(waiting.submissionId)).toEqual([before]);
      expect(iso(before.starts_at)).toBe(iso(after(t0, 29 * DAY)));
    });

    it('a late manual-plan release claim keeps the durable release time despite later entitlement refreshes', async () => {
      const t0 = after(new Date(), -40 * DAY);
      const a = await createUser({ createdAt: after(t0, -10 * DAY) });
      await q("update public.workspace_entitlements set plan='family',product_limit=null,source='legacy_manual' where workspace_id=$1::uuid", a.workspaceId);
      const s = await submit({ email: a.email!, phone: uniquePhone(), at: after(t0, -DAY) });
      expect(s.rewardState).toBe('WAITING_ENTITLEMENT');
      await q("update public.workspace_entitlements set plan='free',product_limit=30,source='free',updated_at=$2::timestamptz where workspace_id=$1::uuid", a.workspaceId, iso(t0));
      await paidGrant(a, 'family', t0, after(t0, 30 * DAY));
      expect(await probe(a.workspaceId, after(t0, DAY))).toMatchObject({ plan: 'family' });
      expect(await probe(a.workspaceId, after(t0, 40 * DAY))).toMatchObject({ plan: 'free' });
      const [{ feedback_manual_released_at }] = await q<{ feedback_manual_released_at: Date }>('select feedback_manual_released_at from public.workspace_entitlements where workspace_id=$1::uuid', a.workspaceId);
      expect(iso(feedback_manual_released_at)).toBe(iso(t0));
      await q('select public.feedback_popup_reconcile(50)');
      const [seg] = await segments(s.submissionId);
      expect(iso(seg.starts_at)).toBe(iso(after(t0, 30 * DAY)));
      expect(iso(seg.expires_at)).toBe(iso(after(t0, 60 * DAY)));
    });

    it('a store workspace receives the same Premium reward on the same timeline', async () => {
      const a = await createUser({ type: 'store' });
      const s = await submit({ email: a.email!, phone: uniquePhone() });
      expect(s.rewardState).toBe('GRANTED');
      expect(await probe(a.workspaceId, after(new Date(), 1000))).toMatchObject({ plan: 'personal', productLimit: null });
    });

    it('30 days is a fixed interval, not a calendar month, across month boundaries', async () => {
      const a = await createUser({ createdAt: new Date('2025-01-01T00:00:00Z') });
      const s = await submit({ email: a.email!, phone: uniquePhone(), at: new Date('2026-01-20T10:00:00Z') });
      const [seg] = await segments(s.submissionId);
      expect(iso(seg.starts_at)).toBe('2026-01-20T10:00:00.000Z');
      expect(iso(seg.expires_at)).toBe('2026-02-19T10:00:00.000Z');
      const b = await createUser({ createdAt: new Date('2025-01-01T00:00:00Z') });
      const t = await submit({ email: b.email!, phone: uniquePhone(), at: new Date('2026-02-15T23:59:59Z') });
      const [segB] = await segments(t.submissionId);
      expect(iso(segB.expires_at)).toBe('2026-03-17T23:59:59.000Z');
      expect(await probe(b.workspaceId, new Date('2026-03-17T23:59:58.999Z'))).toMatchObject({ plan: 'personal' });
      expect(await probe(b.workspaceId, new Date('2026-03-17T23:59:59.000Z'))).toMatchObject({ plan: 'free' });
      // Instants are UTC; Vietnam is UTC+7 with no daylight saving, so a start at 17:30Z ends at 00:30 local on day 31.
      const c = await createUser({ createdAt: new Date('2025-01-01T00:00:00Z') });
      const u = await submit({ email: c.email!, phone: uniquePhone(), at: new Date('2026-10-09T17:30:00Z') });
      const [segC] = await segments(u.submissionId);
      expect(iso(segC.expires_at)).toBe('2026-11-08T17:30:00.000Z');
      const [local] = await q<{ t: string }>("select (expires_at at time zone 'Asia/Ho_Chi_Minh')::text as t from public.billing_grants where id=$1::uuid", segC.id);
      expect(local.t).toBe('2026-11-09 00:30:00');
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('purchases while a reward exists', () => {
    it('a delayed settlement resumes unused reward time at the historical paid end, not execution time', async () => {
      const t0 = after(new Date(), -50 * DAY);
      const a = await createUser({ createdAt: after(t0, -DAY) });
      const s = await submit({ email: a.email!, phone: uniquePhone(), at: t0 });
      const paidAt = after(t0, 10 * DAY);
      expect(await purchase(a, 'family', paidAt, new Date())).toMatchObject({ fulfillment: 'GRANTED' });
      const [used, continuation] = await segments(s.submissionId);
      expect(iso(used.effective_until)).toBe(iso(paidAt));
      expect(iso(continuation.starts_at)).toBe(iso(after(t0, 40 * DAY)));
      expect(iso(continuation.expires_at)).toBe(iso(after(t0, 60 * DAY)));
      expect(await billedSeconds(s.submissionId)).toBe(String(THIRTY_DAYS / 1000));
    });
    it('a real settled FAMILY purchase during an active reward keeps paid access and postpones only the unused remainder', async () => {
      const a = await createUser({ createdAt: after(new Date(), -20 * DAY) });
      const rewardStart = after(new Date(), -10 * DAY);
      const s = await submit({ email: a.email!, phone: uniquePhone(), at: rewardStart });
      expect(await probe(a.workspaceId, new Date())).toMatchObject({ plan: 'personal' });
      // The reward never blocks buying: eligibility is decided from paid time only.
      expect((await q<{ r: string | null }>("select public.billing_purchase_reason($1::uuid,'family',clock_timestamp()) as r", a.workspaceId))[0].r).toBeNull();
      expect((await q<{ r: string | null }>("select public.billing_purchase_reason($1::uuid,'personal',clock_timestamp()) as r", a.workspaceId))[0].r).toBeNull();
      const paidAt = new Date();
      const settled = await purchase(a, 'family', paidAt);
      expect(settled).toMatchObject({ fulfillment: 'GRANTED', reviewReason: null });
      const rows = await segments(s.submissionId);
      expect(rows).toHaveLength(2);
      const [used, continuation] = rows;
      expect(iso(used.starts_at)).toBe(iso(rewardStart));
      expect(iso(used.effective_until)).toBe(iso(paidAt)); // 10 days used, then it yields
      expect(used.superseded_by).not.toBeNull();
      const paidEnd = after(paidAt, THIRTY_DAYS);
      const unused = rewardStart.getTime() + THIRTY_DAYS - paidAt.getTime(); // exactly what was not consumed
      expect(unused).toBeGreaterThan(19 * DAY);
      expect(iso(continuation.starts_at)).toBe(iso(paidEnd));
      expect(iso(continuation.expires_at)).toBe(iso(after(paidEnd, unused)));
      expect(await billedSeconds(s.submissionId)).toBe(String(THIRTY_DAYS / 1000)); // never counted twice, never lost
      expect(await probe(a.workspaceId, after(paidAt, DAY))).toMatchObject({ plan: 'family' });
      expect(await probe(a.workspaceId, after(paidEnd, -1))).toMatchObject({ plan: 'family' });
      expect(await probe(a.workspaceId, paidEnd)).toMatchObject({ plan: 'personal' });
      expect(await probe(a.workspaceId, after(paidEnd, unused))).toMatchObject({ plan: 'free' });
      expect(await q('select fulfillment from public.billing_orders where id=$1::uuid', settled.orderId)).toEqual([{ fulfillment: 'GRANTED' }]);
    });

    it('buying PERSONAL during a personal reward is allowed and does not waste either', async () => {
      const a = await createUser({ createdAt: after(new Date(), -20 * DAY) });
      const rewardStart = after(new Date(), -10 * DAY);
      const s = await submit({ email: a.email!, phone: uniquePhone(), at: rewardStart });
      const paidAt = new Date();
      expect(await purchase(a, 'personal', paidAt)).toMatchObject({ fulfillment: 'GRANTED' });
      const paidEnd = after(paidAt, THIRTY_DAYS);
      const rows = await segments(s.submissionId);
      expect(iso(rows[1].starts_at)).toBe(iso(paidEnd));
      expect(await billedSeconds(s.submissionId)).toBe(String(THIRTY_DAYS / 1000));
      expect(await activeKind(a.workspaceId, after(paidAt, DAY))).toEqual(['PAID']);
      expect(await activeKind(a.workspaceId, paidEnd)).toEqual(['PROMOTION']);
    });

    it('a payment that reached the provider before the reward began is not stranded in manual review', async () => {
      const a = await createUser({ createdAt: after(new Date(), -20 * DAY) });
      const paidAt = after(new Date(), -120_000);
      const s = await submit({ email: a.email!, phone: uniquePhone(), at: after(new Date(), -60_000) }); // reward starts AFTER the payment time
      const settled = await purchase(a, 'family', paidAt, new Date());
      expect(settled).toMatchObject({ fulfillment: 'GRANTED', reviewReason: null });
      const paidEnd = after(paidAt, THIRTY_DAYS);
      const rows = await segments(s.submissionId);
      expect(rows.at(-1)!.starts_at.getTime()).toBe(paidEnd.getTime());
      expect(await billedSeconds(s.submissionId)).toBe(String(THIRTY_DAYS / 1000));
      expect(await probe(a.workspaceId, after(paidAt, DAY))).toMatchObject({ plan: 'family' });
    });

    it('settlement and a feedback submission racing for one workspace converge to one non-overlapping timeline', async () => {
      for (let round = 0; round < 4; round += 1) {
        const a = await createUser({ createdAt: after(new Date(), -20 * DAY) });
        const paidAt = new Date();
        const [result, s] = await Promise.all([
          purchase(a, 'family', paidAt, paidAt),
          submit({ email: a.email!, phone: uniquePhone() }),
        ]);
        expect(result.fulfillment).toBe('GRANTED');
        expect(s.rewardState).toBe('GRANTED');
        expect(await billedSeconds(s.submissionId)).toBe(String(THIRTY_DAYS / 1000));
        const overlaps = await q('select 1 from public.billing_grants a join public.billing_grants b on b.workspace_id=a.workspace_id and b.id<>a.id where a.workspace_id=$1::uuid and (a.reward_id is not null or b.reward_id is not null) and a.starts_at<coalesce(a.effective_until,a.expires_at) and b.starts_at<coalesce(b.effective_until,b.expires_at) and a.starts_at<coalesce(b.effective_until,b.expires_at) and b.starts_at<coalesce(a.effective_until,a.expires_at)', a.workspaceId);
        expect(overlaps).toHaveLength(0);
        expect(await probe(a.workspaceId, after(paidAt, DAY))).toMatchObject({ plan: 'family' });
        expect(await probe(a.workspaceId, after(paidAt, THIRTY_DAYS + DAY))).toMatchObject({ plan: 'personal' });
      }
    });

    it('purchase-time eligibility reports PAID state only and the subscription read model labels the reward', async () => {
      const a = await createUser();
      await submit({ email: a.email!, phone: uniquePhone() });
      const [{ r }] = await operator.$transaction(async tx => {
        await tx.$queryRawUnsafe("select set_config('app.user_id',$1,true)", a.id);
        return tx.$queryRawUnsafe<Array<{ r: { subscription: { plan: string; source: string }; scheduled: unknown[]; eligibility: Record<string, string | null> } }>>('select public.billing_read($1::uuid,null::uuid,0) as r', a.workspaceId);
      });
      expect(r.subscription).toMatchObject({ plan: 'personal', source: 'PROMOTION' });
      expect(r.eligibility).toEqual({ personal: null, family: null, micro_pos: 'PLAN_SEGMENT_MISMATCH' });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('accounts that do not exist yet', () => {
    it('stays pending without any countdown, account or login, and is claimed at registration with the account creation time', async () => {
      const email = uniqueEmail(), phone = uniquePhone();
      const submittedAt = after(new Date(), -3 * DAY);
      const s = await submit({ email, phone, at: submittedAt });
      expect(s.rewardState).toBe('PENDING_ACCOUNT');
      expect(await reward(s.submissionId)).toMatchObject({ state: 'PENDING_ACCOUNT', user_id: null, workspace_id: null, anchor_at: null });
      expect(await segments(s.submissionId)).toHaveLength(0);
      expect(await q('select count(*)::int as n from public.users where email=$1 or phone=$2', email, phone)).toEqual([{ n: 0 }]);
      const createdAt = new Date();
      const u = await createUser({ email, phone: null, createdAt }); // registers with the e-mail only
      expect(await reward(s.submissionId)).toMatchObject({ state: 'GRANTED', user_id: u.id, workspace_id: u.workspaceId });
      const [seg] = await segments(s.submissionId);
      expect(iso(seg.starts_at)).toBe(iso(createdAt)); // not the submission 3 days ago, not first login
      expect(iso(seg.expires_at)).toBe(iso(after(createdAt, THIRTY_DAYS)));
      expect(await probe(u.workspaceId, after(createdAt, 1000))).toMatchObject({ plan: 'personal' });
      // The unmatched secondary contact is not attached, verified or reserved.
      expect(await q('select phone,phone_verified_at,email_verified_at from public.users where id=$1::uuid', u.id)).toEqual([{ phone: null, phone_verified_at: null, email_verified_at: null }]);
      const later = await createUser({ email: uniqueEmail(), phone }); // someone else can still own that phone
      expect(later.phone).toBe(phone);
    });

    it('is claimed by a phone-only registration too, and still after the popup was switched off', async () => {
      const email = uniqueEmail(), phone = uniquePhone();
      const s = await submit({ email, phone, at: after(new Date(), -1 * DAY) });
      await setEnabled(false);
      try {
        const createdAt = new Date();
        const u = await createUser({ email: null, phone, createdAt });
        expect(await reward(s.submissionId)).toMatchObject({ state: 'GRANTED', user_id: u.id });
        const [seg] = await segments(s.submissionId);
        expect(iso(seg.starts_at)).toBe(iso(createdAt));
        expect(await q('select email from public.users where id=$1::uuid', u.id)).toEqual([{ email: null }]);
      } finally {
        await setEnabled(true);
      }
    });

    it('a failed registration does not consume the pending reward; the next real one does, once', async () => {
      const email = uniqueEmail(), phone = uniquePhone();
      const s = await submit({ email, phone });
      const rolledBack = randomUUID();
      await expect(operator.$transaction(async tx => {
        await tx.$executeRawUnsafe("insert into public.users(id,email,password_hash) values($1::uuid,$2,'x')", rolledBack, email);
        await tx.$queryRawUnsafe("select set_config('app.user_id',$1,true)", rolledBack);
        await tx.$queryRawUnsafe("select public.provision_home($1::uuid,'Rolled back','household')", rolledBack);
        throw new Error('registration failed after provisioning');
      })).rejects.toThrow('registration failed');
      expect(await reward(s.submissionId)).toMatchObject({ state: 'PENDING_ACCOUNT', user_id: null });
      expect(await segments(s.submissionId)).toHaveLength(0);
      const u = await createUser({ email });
      expect(await reward(s.submissionId)).toMatchObject({ state: 'GRANTED', user_id: u.id });
      // A duplicate registration event cannot issue another reward or move the dates.
      const before = await segments(s.submissionId);
      expect(await q('select public.feedback_popup_claim_at($1::uuid,clock_timestamp()) as n', u.id)).toEqual([{ n: 0 }]);
      expect(await segments(s.submissionId)).toEqual(before);
    });

    it('a retry long after registration keeps the original account-creation start (never the retry time)', async () => {
      const email = uniqueEmail(), phone = uniquePhone();
      const s = await submit({ email, phone, at: after(new Date(), -2 * DAY) });
      // An account whose inline claim could not run: no provision_home claim, only a durable retry record.
      const id = randomUUID(), createdAt = after(new Date(), -6 * 3_600_000);
      const ws = await operator.$transaction(async tx => {
        await tx.$executeRawUnsafe("insert into public.users(id,email,password_hash,created_at) values($1::uuid,$2,'x',$3::timestamptz)", id, email, iso(createdAt));
        const [{ w }] = await tx.$queryRawUnsafe<Array<{ w: string }>>("insert into public.workspaces(name,type) values('Retry fixture','household') returning id as w");
        await tx.$executeRawUnsafe("insert into public.workspace_members(workspace_id,user_id,role) values($1::uuid,$2::uuid,'owner')", w, id);
        await tx.$executeRawUnsafe('insert into public.workspace_entitlements(workspace_id) values($1::uuid)', w);
        await tx.$executeRawUnsafe("insert into public.feedback_popup_claim_retries(user_id,last_error,next_attempt_at) values($1::uuid,'test',clock_timestamp()-interval '1 second')", id);
        return w;
      });
      users.push(id); workspaces.push(ws);
      await q('select public.feedback_popup_reconcile(50)');
      const [seg] = await segments(s.submissionId);
      expect(iso(seg.starts_at)).toBe(iso(createdAt));
      expect(await q('select count(*)::int as n from public.feedback_popup_claim_retries where user_id=$1::uuid', id)).toEqual([{ n: 0 }]);
      await q('select public.feedback_popup_reconcile(50)');
      expect(await segments(s.submissionId)).toHaveLength(1);
    });

    it('a delayed claim preserves paid history that ended after registration but before the retry', async () => {
      const t0 = after(new Date(), -40 * DAY);
      const email = uniqueEmail();
      const s = await submit({ email, phone: uniquePhone(), at: after(t0, -DAY) });
      const id = randomUUID();
      const ws = await operator.$transaction(async tx => {
        await tx.$executeRawUnsafe("insert into public.users(id,email,password_hash,created_at) values($1::uuid,$2,'x',$3::timestamptz)", id, email, iso(t0));
        const [{ w }] = await tx.$queryRawUnsafe<Array<{ w: string }>>("insert into public.workspaces(name,type) values('Delayed paid retry','household') returning id as w");
        await tx.$executeRawUnsafe("insert into public.workspace_members(workspace_id,user_id,role) values($1::uuid,$2::uuid,'owner')", w, id);
        await tx.$executeRawUnsafe('insert into public.workspace_entitlements(workspace_id) values($1::uuid)', w);
        await tx.$executeRawUnsafe("insert into public.feedback_popup_claim_retries(user_id,last_error,next_attempt_at) values($1::uuid,'test',clock_timestamp()-interval '1 second')", id);
        return w;
      });
      users.push(id); workspaces.push(ws);
      await paidGrant({ id, email, phone: null, workspaceId: ws }, 'family', t0, after(t0, 30 * DAY));
      await q('select public.feedback_popup_reconcile(50)');
      const [seg] = await segments(s.submissionId);
      expect(iso(seg.starts_at)).toBe(iso(after(t0, 30 * DAY)));
      expect(iso(seg.expires_at)).toBe(iso(after(t0, 60 * DAY)));
      expect(await q('select count(*)::int as n from public.feedback_popup_claim_retries where user_id=$1::uuid', id)).toEqual([{ n: 0 }]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('identity matching and one-time rewards', () => {
    it('both identifiers on one account, or exactly one identifier, award that account without touching its contact data', async () => {
      const both = await createUser({ phone: uniquePhone() });
      const s1 = await submit({ email: both.email!, phone: both.phone! });
      expect(await reward(s1.submissionId)).toMatchObject({ state: 'GRANTED', user_id: both.id });

      const emailOnly = await createUser({ phone: null });
      const secondary = uniquePhone();
      const s2 = await submit({ email: emailOnly.email!, phone: secondary });
      expect(await reward(s2.submissionId)).toMatchObject({ state: 'GRANTED', user_id: emailOnly.id });
      expect(await q('select phone,phone_verified_at from public.users where id=$1::uuid', emailOnly.id)).toEqual([{ phone: null, phone_verified_at: null }]);

      const phoneOnly = await createUser({ email: null, phone: uniquePhone() });
      const s3 = await submit({ email: uniqueEmail(), phone: phoneOnly.phone! });
      expect(await reward(s3.submissionId)).toMatchObject({ state: 'GRANTED', user_id: phoneOnly.id });
      expect(await q('select email,email_verified_at from public.users where id=$1::uuid', phoneOnly.id)).toEqual([{ email: null, email_verified_at: null }]);
    });

    it('email on one account and phone on another is an identity conflict: stored, flagged, nobody awarded', async () => {
      const a = await createUser({ phone: null });
      const b = await createUser({ email: uniqueEmail(), phone: uniquePhone() });
      const s = await submit({ email: a.email!, phone: b.phone! });
      expect(s.rewardState).toBe('CONFLICT');
      expect(await reward(s.submissionId)).toMatchObject({ state: 'CONFLICT', reason: 'IDENTITY_CONFLICT', user_id: null, workspace_id: null });
      expect(await segments(s.submissionId)).toHaveLength(0);
      expect(await probe(a.workspaceId, new Date())).toMatchObject({ plan: 'free' });
      expect(await probe(b.workspaceId, new Date())).toMatchObject({ plan: 'free' });
    });

    it('conflicts are re-checked at claim time before a pending reward is consumed', async () => {
      const email = uniqueEmail(), phone = uniquePhone();
      const s = await submit({ email, phone });
      // Someone legitimately holds that phone without having claimed (e.g. changed it after the submission).
      const holderId = randomUUID();
      await q("insert into public.users(id,phone,password_hash) values($1::uuid,$2,'x')", holderId, phone);
      users.push(holderId);
      const u = await createUser({ email });
      expect(await reward(s.submissionId)).toMatchObject({ state: 'CONFLICT', user_id: null });
      expect(await probe(u.workspaceId, new Date())).toMatchObject({ plan: 'free' });
    });

    it('suspended, disabled or deleted accounts are blocked and never reactivated', async () => {
      for (const status of ['DISABLED', 'DELETED']) {
        const a = await createUser();
        await q('update public.users set status=$2 where id=$1::uuid', a.id, status);
        const s = await submit({ email: a.email!, phone: uniquePhone() });
        expect(await reward(s.submissionId)).toMatchObject({ state: 'BLOCKED', reason: 'ACCOUNT_NOT_ACTIVE', user_id: a.id });
        expect(await q('select status from public.users where id=$1::uuid', a.id)).toEqual([{ status }]);
        expect(await segments(s.submissionId)).toHaveLength(0);
      }
    });

    it('one account receives the reward once: repeated, parallel and re-enabled submissions stay duplicates', async () => {
      const a = await createUser();
      const first = await submit({ email: a.email!, phone: uniquePhone() });
      const repeats = await Promise.all(Array.from({ length: 10 }, () => submit({ email: a.email!, phone: uniquePhone() })));
      expect(repeats.every(r => r.rewardState === 'DUPLICATE')).toBe(true);
      await setEnabled(false); await setEnabled(true); // switching the popup off and on is not a new campaign
      const again = await submit({ email: a.email!, phone: uniquePhone() });
      expect(again.rewardState).toBe('DUPLICATE');
      expect(await q("select count(*)::int as n from public.feedback_popup_rewards where user_id=$1::uuid and state='GRANTED'", a.id)).toEqual([{ n: 1 }]);
      expect(await q('select count(*)::int as n from public.billing_grants where workspace_id=$1::uuid and reward_id is not null', a.workspaceId)).toEqual([{ n: 1 }]);
      expect(await q('select reason,user_id from public.feedback_popup_rewards where submission_id=$1::uuid', again.submissionId)).toEqual([{ reason: 'ACCOUNT_ALREADY_REWARDED', user_id: a.id }]);
      const [seg] = await segments(first.submissionId);
      expect(iso(seg.starts_at)).toBe(iso(new Date(first.submittedAt))); // the authoritative first submission
    });

    it('several pending submissions that resolve to one account produce one grant, from the earliest submission', async () => {
      const email = uniqueEmail();
      const earliest = await submit({ email, phone: uniquePhone(), at: after(new Date(), -3 * DAY) });
      const second = await submit({ email, phone: uniquePhone(), at: after(new Date(), -2 * DAY) });
      const third = await submit({ email, phone: uniquePhone(), at: after(new Date(), -1 * DAY) });
      const u = await createUser({ email });
      expect(await reward(earliest.submissionId)).toMatchObject({ state: 'GRANTED', user_id: u.id });
      for (const duplicate of [second, third]) expect(await reward(duplicate.submissionId)).toMatchObject({ state: 'DUPLICATE', user_id: u.id });
      expect(await q('select count(*)::int as n from public.billing_grants where workspace_id=$1::uuid and reward_id is not null', u.workspaceId)).toEqual([{ n: 1 }]);
    });

    it('a reward never moves to another account, state is terminal, and a deleted identity cannot be recreated', async () => {
      const a = await createUser();
      const other = await createUser();
      const s = await submit({ email: a.email!, phone: uniquePhone() });
      await expect(q('update public.feedback_popup_rewards set user_id=$2::uuid where submission_id=$1::uuid', s.submissionId, other.id)).rejects.toThrow('REWARD_BINDING_IMMUTABLE');
      await expect(q("update public.feedback_popup_rewards set state='PENDING_ACCOUNT' where submission_id=$1::uuid", s.submissionId)).rejects.toThrow('REWARD_STATE_TRANSITION_INVALID');
      await q("update public.users set status='DELETED',deleted_at=now() where id=$1::uuid", a.id);
      await expect(createUser({ email: a.email })).rejects.toThrow(); // identifiers of deleted accounts stay reserved
      const again = await submit({ email: a.email!, phone: uniquePhone() });
      expect(await reward(again.submissionId)).toMatchObject({ state: 'BLOCKED', reason: 'ACCOUNT_NOT_ACTIVE' });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('database invariants', () => {
    it('refuses a second reward for an account/workspace, a second open segment and an overlap with paid time', async () => {
      const a = await createUser();
      const now = new Date();
      const s = await submit({ email: a.email!, phone: uniquePhone(), at: now });
      const [{ id: submission }] = await q<{ id: string }>("insert into public.feedback_popup_submissions(campaign_id,full_name,email,phone,review,payload_hash,submitted_at) values($1,'Dup',$2,$3,'dup',repeat('a',64),clock_timestamp()) returning id", CAMPAIGN, a.email, uniquePhone());
      await expect(q("insert into public.feedback_popup_rewards(submission_id,campaign_id,state,user_id,workspace_id,anchor_at,granted_at,created_at,updated_at) values($1::uuid,$2,'GRANTED',$3::uuid,$4::uuid,now(),now(),now(),now())", submission, CAMPAIGN, a.id, a.workspaceId)).rejects.toThrow();
      const r = await reward(s.submissionId);
      await expect(q("insert into public.billing_grants(workspace_id,plan,starts_at,expires_at,price_snapshot,source_kind,reward_id) values($1::uuid,'personal',now(),now()+interval '1 day','{}'::jsonb,'PROMOTION',$2::uuid)", a.workspaceId, r.id)).rejects.toThrow();
      // Paid time can never overlap reward time: the deferred guard rejects the commit.
      const paid = await createUser();
      const t0 = new Date();
      await paidGrant(paid, 'family', after(t0, -1 * DAY), after(t0, 29 * DAY));
      const queued = await submit({ email: paid.email!, phone: uniquePhone(), at: t0 });
      await expect(operator.$transaction(async tx => {
        await tx.$executeRawUnsafe("update public.billing_grants set starts_at=$2::timestamptz,expires_at=$2::timestamptz+interval '30 days' where reward_id=(select id from public.feedback_popup_rewards where submission_id=$1::uuid) and superseded_at is null", queued.submissionId, iso(after(t0, 5 * DAY)));
      })).rejects.toThrow('PROMOTION_OVERLAPS_ENTITLEMENT');
      const [still] = await segments(queued.submissionId);
      expect(iso(still.starts_at)).toBe(iso(after(t0, 29 * DAY)));
    });

    it('stores accepted values verbatim (NFC Vietnamese text), with canonical contact and bounded lengths', async () => {
      const email = uniqueEmail(), phone = uniquePhone();
      const s = await submit({ email, phone, name: 'Trần Thị Bích Ngọc', review: 'Ứng dụng giúp mình quản lý tủ lạnh ✨ 🥦\nRất tiện!' });
      const [row] = await q('select full_name,email,phone,review,submitted_at from public.feedback_popup_submissions where id=$1::uuid', s.submissionId);
      expect(row).toMatchObject({ full_name: 'Trần Thị Bích Ngọc', email, phone, review: 'Ứng dụng giúp mình quản lý tủ lạnh ✨ 🥦\nRất tiện!' });
      await expect(submit({ email, phone, review: 'x'.repeat(5001) })).rejects.toThrow();
      await expect(submit({ email, phone, name: ' padded ' })).rejects.toThrow();
      await expect(submit({ email, phone: '0912345678' })).rejects.toThrow(); // not canonical E.164
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('idempotency, concurrency and recovery', () => {
    it('the same key and payload is one submission; a changed payload under the same key conflicts', async () => {
      const email = uniqueEmail(), phone = uniquePhone(), key = randomUUID();
      const results = await Promise.all(Array.from({ length: 6 }, () => submit({ email, phone, key })));
      expect(new Set(results.map(r => r.submissionId)).size).toBe(1);
      expect(results.filter(r => !r.replayed)).toHaveLength(1);
      expect(await q('select count(*)::int as n from public.feedback_popup_submissions where idempotency_key=$1::uuid', key)).toEqual([{ n: 1 }]);
      await expect(submit({ email, phone, key, hash: 'f'.repeat(64) })).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    });

    it('simultaneous submission and registration of the same contact always converge to exactly one grant', async () => {
      for (let round = 0; round < 12; round += 1) {
        const email = uniqueEmail(), phone = uniquePhone();
        const [s, u] = await Promise.all([submit({ email, phone }), createUser({ email })]);
        await q('select public.feedback_popup_reconcile(50)'); // the worker is the documented backstop for a lock timeout
        const r = await reward(s.submissionId);
        expect(r, `round ${round}`).toMatchObject({ state: 'GRANTED', user_id: u.id });
        expect(await segments(s.submissionId)).toHaveLength(1);
        // Exact (microsecond) equality, evaluated in SQL: the reward starts at max(account creation, submission) and nowhere else.
        const [{ ok }] = await q<{ ok: boolean }>('select (r.anchor_at=greatest(u.created_at,s.submitted_at) and g.starts_at=r.anchor_at and g.expires_at=g.starts_at+make_interval(secs=>2592000)) as ok from public.feedback_popup_rewards r join public.feedback_popup_submissions s on s.id=r.submission_id join public.users u on u.id=r.user_id join public.billing_grants g on g.reward_id=r.id where s.id=$1::uuid', s.submissionId);
        expect(ok, `round ${round}`).toBe(true);
      }
    });

    it('a disable racing with submissions is deterministic: every accepted submission precedes the disable', async () => {
      await setEnabled(true);
      const outcomes = await Promise.allSettled([
        ...Array.from({ length: 10 }, () => submit({ email: uniqueEmail(), phone: uniquePhone(), at: undefined })),
        q('select public.feedback_popup_admin_set(false,null::integer,null::uuid,$1::uuid)', randomUUID()),
        ...Array.from({ length: 10 }, () => submit({ email: uniqueEmail(), phone: uniquePhone() })),
      ]);
      const [{ disabled_at }] = await q<{ disabled_at: Date }>('select updated_at as disabled_at from public.feedback_popup_campaigns where id=$1', CAMPAIGN);
      const accepted = outcomes.slice(0, 21).filter((o, index) => index !== 10 && o.status === 'fulfilled') as PromiseFulfilledResult<{ submissionId: string }>[];
      const rejected = outcomes.slice(0, 21).filter((o, index) => index !== 10 && o.status === 'rejected') as PromiseRejectedResult[];
      for (const o of accepted) {
        const [row] = await q<{ ok: boolean }>('select (submitted_at<=$2::timestamptz) as ok from public.feedback_popup_submissions where id=$1::uuid', o.value.submissionId, iso(disabled_at));
        expect(row.ok).toBe(true);
      }
      for (const o of rejected) expect(String(o.reason)).toContain('FEEDBACK_POPUP_DISABLED');
      await expect(submit({ email: uniqueEmail(), phone: uniquePhone() })).rejects.toThrow('FEEDBACK_POPUP_DISABLED');
      await setEnabled(true);
    });

    it('a rolled-back submission leaves nothing behind and can be retried safely', async () => {
      const email = uniqueEmail(), phone = uniquePhone(), key = randomUUID();
      await expect(operator.$transaction(async tx => {
        await tx.$queryRawUnsafe('select public.feedback_popup_submit_at($1,$2,$3,$4,$5,$6::uuid,$7,null,null,null,clock_timestamp())', CAMPAIGN, 'Name', email, phone, 'review', key, 'a'.repeat(64));
        throw new Error('boom');
      })).rejects.toThrow('boom');
      expect(await q('select count(*)::int as n from public.feedback_popup_submissions where idempotency_key=$1::uuid', key)).toEqual([{ n: 0 }]);
      const retry = await submit({ email, phone, key });
      expect(retry.replayed).toBe(false);
    });

    it('reconciliation is idempotent under duplicate delivery', async () => {
      const email = uniqueEmail();
      const s = await submit({ email, phone: uniquePhone(), at: after(new Date(), -1 * DAY) });
      const id = randomUUID(), createdAt = after(new Date(), -3_600_000);
      const ws = await operator.$transaction(async tx => {
        await tx.$executeRawUnsafe("insert into public.users(id,email,password_hash,created_at) values($1::uuid,$2,'x',$3::timestamptz)", id, email, iso(createdAt));
        const [{ w }] = await tx.$queryRawUnsafe<Array<{ w: string }>>("insert into public.workspaces(name,type) values('Retry fixture','household') returning id as w");
        await tx.$executeRawUnsafe("insert into public.workspace_members(workspace_id,user_id,role) values($1::uuid,$2::uuid,'owner')", w, id);
        await tx.$executeRawUnsafe('insert into public.workspace_entitlements(workspace_id) values($1::uuid)', w);
        await tx.$executeRawUnsafe("insert into public.feedback_popup_claim_retries(user_id,next_attempt_at) values($1::uuid,clock_timestamp()-interval '1 second')", id);
        return w;
      });
      users.push(id); workspaces.push(ws);
      await Promise.all(Array.from({ length: 5 }, () => q('select public.feedback_popup_reconcile(50)')));
      expect(await segments(s.submissionId)).toHaveLength(1);
      expect(await reward(s.submissionId)).toMatchObject({ state: 'GRANTED', user_id: id });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('program-wide hardening', () => {
    it('a real PostgreSQL deadlock aborts one request with retryable 503 and a normal retry stores exactly one submission per operation', async () => {
      const accounts = [await createUser(), await createUser()];
      let arrived = 0;
      let releaseBarrier!: () => void;
      const barrier = new Promise<void>(resolve => { releaseBarrier = resolve; });
      const bodies = accounts.map(a => ({ fullName: 'Synthetic fault fixture', email: a.email!, phoneNumber: uniquePhone(), review: 'Independent operation' }));
      const keys = accounts.map(() => randomUUID());
      const requests = accounts.map((a, index) => {
        const db = { $transaction: (fn: (tx: unknown) => Promise<unknown>) => operator.$transaction(async tx => {
          // Deterministic fault injection at the actual transaction boundary;
          // no sleep, timeout increase or production lock-order alteration.
          await tx.$queryRawUnsafe('select id from public.workspaces where id=$1::uuid for update', a.workspaceId);
          if (++arrived === 2) releaseBarrier();
          await barrier;
          await tx.$queryRawUnsafe('select id from public.workspaces where id=$1::uuid for update', accounts[1 - index].workspaceId);
          return fn(tx);
        }, { timeout: 15000 }) };
        return new FeedbackPopupService(db as never, {} as never).submit(bodies[index], { idempotencyKey: keys[index] });
      });
      const outcomes = await Promise.allSettled(requests);
      expect(outcomes.filter(x => x.status === 'fulfilled')).toHaveLength(1);
      const failed = outcomes.findIndex(x => x.status === 'rejected');
      const error = (outcomes[failed] as PromiseRejectedResult).reason;
      expect(error.getStatus()).toBe(503);
      expect(error.getResponse()).toMatchObject({ code: 'FEEDBACK_POPUP_BUSY', details: null });
      await new FeedbackPopupService(operator as never, {} as never).submit(bodies[failed], { idempotencyKey: keys[failed] });
      expect(await q('select count(*)::int n from public.feedback_popup_submissions where idempotency_key=any($1::uuid[])', keys)).toEqual([{ n: 2 }]);
      expect(await q('select count(*)::int n from public.feedback_popup_rewards where user_id=any($1::uuid[]) and allotment_consumed', accounts.map(a => a.id))).toEqual([{ n: 2 }]);
    }, 20000);

    it('the database refuses to release an issued allotment, rewrite its first award or move its source', async () => {
      const a = await createUser(), b = await createUser();
      const first = await submit({ email: a.email!, phone: uniquePhone() });
      const other = await submit({ email: b.email!, phone: uniquePhone() });
      const r = await reward(first.submissionId), foreign = await reward(other.submissionId);
      for (const sql of [
        'update public.feedback_popup_rewards set allotment_consumed=false where id=$1::uuid',
        "update public.feedback_popup_rewards set awarded_at=awarded_at+interval '1 second' where id=$1::uuid",
        'update public.feedback_popup_rewards set logical_reward_id=$2::uuid where id=$1::uuid',
        'update public.feedback_popup_rewards set bound_at=null where id=$1::uuid',
      ]) {
        await expect(q(sql, r.id, ...(sql.includes('$2') ? [foreign.id] : []))).rejects.toThrow();
      }
      expect(await reward(first.submissionId)).toEqual(r);
      expect(await billedSeconds(first.submissionId)).toBe('2592000');
    });

    it('retains twelve independent anonymous submissions while deduplicating their exact canonical nomination', async () => {
      const email = uniqueEmail(), phone = uniquePhone();
      // Use the runtime entry point: its clock is sampled AFTER the database
      // writer lock. Client-supplied private clocks cannot prove server ordering.
      const all = await Promise.all(Array.from({ length: 12 }, async () => {
        const [{ r }] = await q<{ r: { submissionId: string } }>(
          'select public.feedback_popup_submit($1,$2,$3,$4,$5,null,$6,null,null,null) r',
          CAMPAIGN, 'Synthetic fixture', email, phone, 'Independent operation', 'a'.repeat(64));
        return r;
      }));
      expect(new Set(all.map(s => s.submissionId)).size).toBe(12);
      const [{ n, roots }] = await q<{ n: number; roots: number }>(
        'select count(*)::int n,count(distinct r.logical_reward_id)::int roots from public.feedback_popup_submissions s join public.feedback_popup_rewards r on r.submission_id=s.id where s.email=$1', email);
      expect({ n, roots }).toEqual({ n: 12, roots: 1 });
      const [{ first }] = await q<{ first: string }>('select id first from public.feedback_popup_submissions where email=$1 order by submitted_at,id limit 1', email);
      const account = await createUser({ email });
      expect((await reward(first)).state).toBe('GRANTED');
      const rows = await q<{ state: string; logical_reward_id: string }>('select state,logical_reward_id from public.feedback_popup_rewards where user_id=$1::uuid', account.id);
      expect(rows.filter(r => r.state === 'GRANTED')).toHaveLength(1);
      expect(rows.filter(r => r.state === 'DUPLICATE')).toHaveLength(11);
      expect(new Set(rows.map(r => r.logical_reward_id)).size).toBe(1);
    });

    it('an issued waiting reward remains the consumed allotment after the worker blocks the inactive account', async () => {
      const a = await createUser();
      await q("update public.workspace_entitlements set plan='family',source='legacy_manual' where workspace_id=$1::uuid", a.workspaceId);
      const first = await submit({ email: a.email!, phone: uniquePhone() });
      expect(first.rewardState).toBe('WAITING_ENTITLEMENT');
      await q("update public.users set status='DISABLED' where id=$1::uuid", a.id);
      await q('select public.feedback_popup_reconcile(50)');
      expect((await reward(first.submissionId)).state).toBe('BLOCKED');
      // Operator recovery is a local fixture only, not a new product activation API.
      await q("update public.users set status='ACTIVE' where id=$1::uuid", a.id);
      await q("update public.workspace_entitlements set plan='free',source='free' where workspace_id=$1::uuid", a.workspaceId);
      const again = await submit({ email: a.email!, phone: uniquePhone() });
      expect(again.rewardState).toBe('DUPLICATE');
      expect(await segments(again.submissionId)).toHaveLength(0);
      const r = await reward(first.submissionId);
      expect((await reward(again.submissionId)).logical_reward_id).toBe(r.id);
      expect(r.awarded_at).not.toBeNull();
    });

    it('repeat, identity changes, another owned workspace and expiration do not replace source, award time or budget', async () => {
      const a = await createUser({ phone: uniquePhone(), createdAt: after(new Date(), -80 * DAY) });
      const first = await submit({ email: a.email!, phone: a.phone!, at: after(new Date(), -40 * DAY) });
      const before = await reward(first.submissionId);
      const newerEmail = uniqueEmail();
      await q('update public.users set email=$2 where id=$1::uuid', a.id, newerEmail);
      const [{ w }] = await q<{ w: string }>("insert into public.workspaces(name,type) values('Second owned fixture','household') returning id w");
      workspaces.push(w);
      await q("insert into public.workspace_members(workspace_id,user_id,role,created_at) values($1::uuid,$2::uuid,'owner',now()-interval '10 days')", w, a.id);
      await q('insert into public.workspace_entitlements(workspace_id) values($1::uuid)', w);
      const repeat = await submit({ email: newerEmail, phone: a.phone! });
      expect(repeat.rewardState).toBe('DUPLICATE');
      expect((await reward(repeat.submissionId)).logical_reward_id).toBe(before.id);
      const after2 = await reward(first.submissionId);
      expect(after2).toEqual(before);
      expect(await billedSeconds(first.submissionId)).toBe('2592000');
      expect(await q('select count(*)::int n from public.billing_grants where workspace_id=$1::uuid', w)).toEqual([{ n: 0 }]);
    });

    it('does not conflate different unverified contact pairs or reserve a secondary contact for a different account', async () => {
      const email = uniqueEmail(), phone1 = uniquePhone(), phone2 = uniquePhone();
      const one = await submit({ email, phone: phone1 });
      const two = await submit({ email, phone: phone2 });
      expect((await reward(one.submissionId)).logical_reward_id).not.toBe((await reward(two.submissionId)).logical_reward_id);
      const a = await createUser({ email });
      expect((await reward(one.submissionId)).user_id).toBe(a.id);
      const b = await createUser({ email: uniqueEmail(), phone: phone2 });
      const fresh = await submit({ email: b.email!, phone: phone2 });
      expect(fresh.rewardState).toBe('GRANTED');
      expect((await reward(fresh.submissionId)).user_id).toBe(b.id);
      expect((await reward(two.submissionId)).user_id).toBe(a.id); // immutable original beneficiary
    });

    it('admin lifecycle links every repeat to the real first award and computes counts and duration without inventing feature usage', async () => {
      const a = await createUser({ createdAt: after(new Date(), -20 * DAY) });
      const first = await submit({ email: a.email!, phone: uniquePhone(), at: after(new Date(), -10 * DAY), key: randomUUID() });
      const later = await submit({ email: a.email!, phone: uniquePhone(), key: randomUUID() });
      const r = await reward(first.submissionId);
      const [row] = await q<{ data: { lifecycle: Record<string, any> } }>('select data from admin.feedback_submissions where id=$1::uuid', later.submissionId);
      const life = row.data.lifecycle;
      expect(life.rewardId).toBe(r.id);
      expect(life.sourceSubmissionId).toBe(first.submissionId);
      expect(life.logicalRewardCount).toBe(1);
      expect(life.submissionCount).toBe(2);
      expect(new Date(life.awardedAt).getTime()).toBe(r.bound_at.getTime());
      expect(new Date(life.accountCreatedAt).getTime()).toBe((await q<{ created_at: Date }>('select created_at from public.users where id=$1::uuid', a.id))[0].created_at.getTime());
      expect(life.featureUsage).toEqual({ status: 'NOT_TRACKED', used: null });
      expect(life.durationBudgetSeconds).toBe(2592000);
      expect(life.allocatedSeconds).toBe(2592000);
      expect(life.elapsedSeconds).toBeGreaterThan(9 * 86400);
      expect(life.elapsedSeconds + life.remainingSeconds).toBeCloseTo(2592000, 4);
      expect(life.segmentCount).toBe(1);
    });

    it('rollback after an award leaves no submission, binding or grant and response-loss replay preserves the committed award', async () => {
      const a = await createUser(), key = randomUUID(), phone = uniquePhone();
      await expect(operator.$transaction(async tx => {
        await tx.$queryRawUnsafe('select public.feedback_popup_submit_at($1,$2,$3,$4,$5,$6::uuid,$7,null,null,null,clock_timestamp())', CAMPAIGN, 'Fixture', a.email, phone, 'review', key, 'a'.repeat(64));
        throw new Error('injected after award before commit');
      })).rejects.toThrow('injected');
      expect(await q('select count(*)::int n from public.feedback_popup_rewards where user_id=$1::uuid', a.id)).toEqual([{ n: 0 }]);
      expect(await q('select count(*)::int n from public.billing_grants where workspace_id=$1::uuid', a.workspaceId)).toEqual([{ n: 0 }]);
      const committed = await submit({ email: a.email!, phone, key }); // simulate dropping its response
      const before = await reward(committed.submissionId);
      const retried = await submit({ email: a.email!, phone, key });
      expect(retried).toMatchObject({ replayed: true, submissionId: committed.submissionId });
      expect(await reward(committed.submissionId)).toEqual(before);
    });

    it('two independent accounts and repeated workers maintain independent one-time rewards with exact counters', async () => {
      const all = await Promise.all([createUser(), createUser()]);
      for (const a of all) {
        const requests = await Promise.all(Array.from({ length: 8 }, () => submit({ email: a.email!, phone: uniquePhone() })));
        expect(requests).toHaveLength(8);
        const [{ n, roots }] = await q<{ n: number; roots: number }>('select count(*)::int n,count(distinct logical_reward_id)::int roots from public.feedback_popup_rewards where user_id=$1::uuid', a.id);
        expect({ n, roots }).toEqual({ n: 8, roots: 1 });
      }
      await Promise.all(Array.from({ length: 4 }, () => q('select public.feedback_popup_reconcile(50)')));
      expect(await q('select count(*)::int n from public.billing_grants where workspace_id=any($1::uuid[])', all.map(a => a.workspaceId))).toEqual([{ n: 2 }]);
    });

    it('a seeded sequence of submit/replay/paid/reconcile preserves one logical reward across two segments and a leap-day budget', async () => {
      const t0 = new Date('2024-02-29T23:59:59.999Z');
      const a = await createUser({ createdAt: after(t0, -DAY) });
      const first = await submit({ email: a.email!, phone: uniquePhone(), at: t0 });
      await paidGrant(a, 'family', after(t0, 10 * DAY), after(t0, 40 * DAY));
      let seed = 20261010, accepted = 1;
      for (let step = 0; step < 12; step += 1) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const key = randomUUID(), phone = uniquePhone();
        const fresh = await submit({ email: a.email!, phone, key }); accepted += 1;
        if (seed & 1) expect((await submit({ email: a.email!, phone, key })).submissionId).toBe(fresh.submissionId);
        if (seed & 2) await q('select public.feedback_popup_reconcile(50)');
        expect(await billedSeconds(first.submissionId)).toBe('2592000');
        const [{ data }] = await q<{ data: { lifecycle: Record<string, any> } }>('select data from admin.feedback_submissions where id=$1::uuid', fresh.submissionId);
        expect(data.lifecycle).toMatchObject({ submissionCount: accepted, logicalRewardCount: 1, sourceSubmissionId: first.submissionId, segmentCount: 2, allocatedSeconds: 2592000 });
      }
      const [used, rest] = await segments(first.submissionId);
      expect(used.effective_until.getTime()).toBe(after(t0, 10 * DAY).getTime());
      expect(rest.expires_at.getTime()).toBe(after(t0, 60 * DAY).getTime());
    });
  });

  describe('operations and read models', () => {
    it('a reward ending is not announced as a paid plan ending', async () => {
      const a = await createUser();
      const s = await submit({ email: a.email!, phone: uniquePhone() });
      await q('select public.billing_refresh_at($1::uuid,clock_timestamp())', a.workspaceId);
      await q("update public.billing_grants set starts_at=starts_at-interval '40 days',expires_at=expires_at-interval '40 days' where reward_id=(select id from public.feedback_popup_rewards where submission_id=$1::uuid)", s.submissionId);
      await q('select public.notification_scan_due()');
      expect(await q("select count(*)::int as n from public.notification_outbox where workspace_id=$1::uuid and kind='billing.plan_expired'", a.workspaceId)).toEqual([{ n: 0 }]);
      expect(await probe(a.workspaceId, new Date())).toMatchObject({ plan: 'free' });
    });

    it('the admin read model derives every benefit state from the stored timeline', async () => {
      const states: Record<string, string> = {};
      const pending = await submit({ email: uniqueEmail(), phone: uniquePhone() });
      states.PENDING_ACCOUNT = pending.submissionId;
      const active = await createUser(); states.ACTIVE = (await submit({ email: active.email!, phone: uniquePhone() })).submissionId;
      const queued = await createUser(); const now = new Date();
      await paidGrant(queued, 'family', after(now, -1 * DAY), after(now, 10 * DAY));
      states.SCHEDULED = (await submit({ email: queued.email!, phone: uniquePhone(), at: now })).submissionId;
      const expired = await createUser(); const e = await submit({ email: expired.email!, phone: uniquePhone() });
      await q("update public.billing_grants set starts_at=starts_at-interval '40 days',expires_at=expires_at-interval '40 days' where reward_id=(select id from public.feedback_popup_rewards where submission_id=$1::uuid)", e.submissionId);
      states.EXPIRED = e.submissionId;
      const waiting = await createUser();
      await q("update public.workspace_entitlements set plan='family',product_limit=null,source='legacy_manual' where workspace_id=$1::uuid", waiting.workspaceId);
      states.WAITING_ENTITLEMENT = (await submit({ email: waiting.email!, phone: uniquePhone() })).submissionId;
      const a = await createUser({ phone: null }); const b = await createUser({ phone: uniquePhone() });
      states.CONFLICT = (await submit({ email: a.email!, phone: b.phone! })).submissionId;
      const blocked = await createUser(); await q("update public.users set status='DISABLED' where id=$1::uuid", blocked.id);
      states.BLOCKED = (await submit({ email: blocked.email!, phone: uniquePhone() })).submissionId;
      const dup = await createUser(); await submit({ email: dup.email!, phone: uniquePhone() });
      states.DUPLICATE = (await submit({ email: dup.email!, phone: uniquePhone() })).submissionId;
      for (const [state, id] of Object.entries(states)) {
        const [row] = await q<{ benefit_state: string; data: { benefit: { state: string }; duplicate: boolean } }>('select benefit_state,data from admin.feedback_submissions where id=$1::uuid', id);
        expect(row.benefit_state, state).toBe(state);
        expect(row.data.benefit.state, state).toBe(state);
        expect(row.data.duplicate).toBe(state === 'DUPLICATE');
      }
      const [workspace] = await q<{ plan: string; grant_id: string | null; paid_expires_at: Date | null }>('select plan,grant_id,paid_expires_at from admin.workspaces where id=$1::uuid', active.workspaceId);
      expect(workspace).toEqual({ plan: 'personal', grant_id: null, paid_expires_at: null }); // reward time is not paid time
    });
  });
});
