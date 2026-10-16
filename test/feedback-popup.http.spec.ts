import { installMockEmailAuth, verifyHttpRegistration } from './support/email-auth-fixture';
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { NestFactory } from '@nestjs/core';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { requireDisposableDatabase } from './disposable-database';
import { acquireCampaignLock } from './feedback-popup.lock';

const CAMPAIGN = 'homepage-feedback-premium-30d';
const SITE = 'https://homemind.vn';
const DOMAIN = '@fp-http.example';
const PATH = '/public/feedback-popup';

// The real compiled application, real PostgreSQL, real HTTP: exactly what the website will call.
describe.skipIf(process.env.RUN_DB_TESTS !== '1')('homepage feedback popup: public HTTP boundary', () => {
  let emailAuth:any;
  const operator = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
  const apps: INestApplication[] = [];
  const users: string[] = [];
  const workspaces: string[] = [];
  const phones = new Set<string>();
  let base = '';
  let release: () => Promise<void>;

  const email = () => `fp-${randomUUID()}${DOMAIN}`;
  function phone() {
    for (;;) {
      const value = '+8491' + String(Math.floor(Math.random() * 1e7)).padStart(7, '0');
      if (!phones.has(value)) { phones.add(value); return value; }
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q = <T = any>(sql: string, ...params: unknown[]) => operator.$queryRawUnsafe<T[]>(sql, ...params);
  const setEnabled = (on: boolean) => q('update public.feedback_popup_campaigns set enabled=$1,revision=revision+1,updated_at=clock_timestamp() where id=$2', on, CAMPAIGN);
  const valid = (over: Record<string, unknown> = {}) => ({ fullName: 'Nguyễn Văn An', phoneNumber: phone(), email: email(), review: 'Ứng dụng rất hữu ích cho cả nhà.', ...over });

  async function boot() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppModule } = require('../dist/app.module.js');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ApiErrorFilter } = require('../dist/common/api-error.filter.js');
    const app = await NestFactory.create(AppModule, { logger: false });emailAuth=installMockEmailAuth(app);
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new ApiErrorFilter());
    await app.listen(0, '127.0.0.1');
    apps.push(app);
    return (await app.getUrl()) + '/v1';
  }

  type Init = { method?: string; body?: unknown; raw?: string; headers?: Record<string, string>; url?: string };
  async function api(path: string, init: Init = {}) {
    const hasBody = init.body !== undefined || init.raw !== undefined;
    const response = await fetch((init.url ?? base) + path, {
      method: init.method ?? 'GET',
      headers: { ...(hasBody ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
      body: init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
    });
    const text = await response.text();
    let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, headers: response.headers, json, text };
  }
  const submit = (body: unknown, headers: Record<string, string> = {}, url?: string) => api(`${PATH}/submissions`, { method: 'POST', body, headers, url });

  async function register(opts: { email?: string | null; phone?: string | null; password?: string } = {}) {
    const body: Record<string, unknown> = { acceptedTerms: true, acceptedPrivacy: true, displayName: 'Người dùng thử', password: opts.password ?? randomBytes(12).toString('hex'), workspaceType: 'household' };
    const mail = opts.email === undefined ? email() : opts.email;
    if (mail) body.email = mail;
    if (opts.phone) body.phone = opts.phone;
    const response = await api('/auth/register', { method: 'POST', body });
    expect(response.status, response.text).toBe(201);
    response.json=await verifyHttpRegistration(base,emailAuth,response.json,mail!);
    const token = response.json.accessToken as string;
    const me = await api('/me', { headers: { Authorization: 'Bearer ' + token } });
    users.push(response.json.user.id); workspaces.push(me.json.workspaceId);
    return { id: response.json.user.id as string, token, workspaceId: me.json.workspaceId as string, email: mail, phone: opts.phone ?? null };
  }
  const me = async (token: string) => (await api('/me', { headers: { Authorization: 'Bearer ' + token } })).json;
  const rewardOf = async (mail: string) => q('select r.state,r.reason,r.user_id,r.workspace_id,r.anchor_at from public.feedback_popup_rewards r join public.feedback_popup_submissions s on s.id=r.submission_id where s.email=$1 order by s.submitted_at', mail);
  const countSubmissions = async (mail: string) => (await q<{ n: number }>('select count(*)::int as n from public.feedback_popup_submissions where email=$1', mail))[0].n;

  beforeAll(async () => {
    requireDisposableDatabase();
    release = await acquireCampaignLock(operator);
    const compiled = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { encoding: 'utf8' });
    if (compiled.status !== 0) throw new Error('Compilation failed: ' + compiled.stdout);
    // Rate limits are exercised on a dedicated instance; every other test must not be throttled.
    process.env.FEEDBACK_POPUP_SUBMIT_RATE_LIMIT = '1000';
    process.env.FEEDBACK_POPUP_CONFIG_RATE_LIMIT = '1000';
    await setEnabled(true);
    base = await boot();
  }, 600_000);

  afterAll(async () => {
    try {
      await Promise.all(apps.map(app => app.close()));
      await operator.$transaction(async tx => {
        // Other isolated suites still drive the bounded worker. Match its
        // outbox-before-recipient FK order when physically deleting fixtures.
        await tx.$executeRaw`delete from public.notification_outbox where recipient_id=any(${users}::uuid[])`;
        await tx.$executeRawUnsafe("delete from public.billing_grants where workspace_id=any($1::uuid[]) or reward_id in (select r.id from public.feedback_popup_rewards r join public.feedback_popup_submissions s on s.id=r.submission_id where s.email like $2)", workspaces, '%' + DOMAIN);
        await tx.$executeRawUnsafe('delete from public.feedback_popup_claim_retries where user_id=any($1::uuid[])', users);
        await tx.$executeRawUnsafe('delete from public.feedback_popup_rewards where submission_id in (select id from public.feedback_popup_submissions where email like $1)', '%' + DOMAIN);
        await tx.$executeRawUnsafe('delete from public.feedback_popup_submissions where email like $1', '%' + DOMAIN);
        await tx.$executeRawUnsafe('delete from public.workspaces where id=any($1::uuid[])', workspaces);
        await tx.$executeRawUnsafe('delete from public.users where id=any($1::uuid[])', users);
        await tx.$executeRawUnsafe('update public.feedback_popup_campaigns set enabled=false where id=$1', CAMPAIGN);
      }, { timeout: 30_000 });
    } finally {
      delete process.env.FEEDBACK_POPUP_SUBMIT_RATE_LIMIT;
      delete process.env.FEEDBACK_POPUP_CONFIG_RATE_LIMIT;
      await release?.();
      await operator.$disconnect();
    }
  }, 120_000);

  // ---------------------------------------------------------------------------------------------
  describe('public configuration', () => {
    it('awards the exact registered Unicode email identity without selecting its NFC lookalike', async () => {
      const decomposed = `u\u0308ser-${randomUUID()}${DOMAIN}`;
      const intended = await register({ email: decomposed });
      const lookalike = await register({ email: decomposed.normalize('NFC') });
      const response = await submit(valid({ email: decomposed }));
      expect(response.status).toBe(202);
      expect(await rewardOf(decomposed)).toEqual([expect.objectContaining({ state: 'GRANTED', user_id: intended.id })]);
      expect((await me(intended.token)).plan).toBe('personal');
      expect((await me(lookalike.token)).plan).toBe('free');
    });
    it('is anonymous, never cached, and exposes only safe offer and form rules', async () => {
      const r = await api(PATH, { headers: { Origin: SITE } });
      expect(r.status).toBe(200);
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(r.headers.get('access-control-allow-origin')).toBe(SITE);
      expect(r.headers.get('access-control-allow-credentials')).toBeNull();
      expect(r.headers.get('vary')?.toLowerCase()).toContain('origin');
      expect(Object.keys(r.json).sort()).toEqual(['campaignId', 'enabled', 'fields', 'idempotency', 'offer', 'revision', 'updatedAt']);
      expect(r.json).toMatchObject({ campaignId: CAMPAIGN, enabled: true, offer: { name: 'Premium', planId: 'personal', durationDays: 30, durationSeconds: 2592000 } });
      expect(r.json.fields).toMatchObject({ fullName: { required: true, maxLength: 120 }, email: { maxLength: 254 }, review: { maxLength: 5000 } });
      expect(new Date(r.json.updatedAt).toISOString()).toBe(r.json.updatedAt);
      expect(r.text).not.toMatch(/user|account|workspace|token|@/i);
    });

    it('reflects an enable/disable switch immediately (no stale copy) and a disabled popup is a normal response', async () => {
      await setEnabled(false);
      const off = await api(PATH);
      expect(off.status).toBe(200);
      expect(off.json.enabled).toBe(false);
      await setEnabled(true);
      expect((await api(PATH)).json.enabled).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('validation and transport', () => {
    it('rejects each missing, null, blank and mistyped required field with a field-level reason; nothing is stored', async () => {
      const mail = email();
      const base0 = valid({ email: mail });
      for (const field of ['fullName', 'phoneNumber', 'email', 'review']) {
        const missing: Record<string, unknown> = { ...base0 }; delete missing[field];
        for (const [label, body, code] of [
          ['missing', missing, 'REQUIRED'],
          ['null', { ...base0, [field]: null }, 'REQUIRED'],
          ['empty', { ...base0, [field]: '' }, 'REQUIRED'],
          ['whitespace', { ...base0, [field]: ' \t\n  ' }, 'REQUIRED'],
          ['number', { ...base0, [field]: 12345 }, 'INVALID_TYPE'],
          ['object', { ...base0, [field]: { a: 1 } }, 'INVALID_TYPE'],
        ] as const) {
          const r = await submit(body);
          expect(r.status, `${field} ${label}`).toBe(400);
          expect(r.json.error.code).toBe('VALIDATION_ERROR');
          expect(r.json.error.details).toContainEqual(expect.objectContaining({ field, code }));
        }
      }
      for (const [field, value] of [['email', 'not-an-email'], ['email', 'a@b'], ['phoneNumber', '12345'], ['phoneNumber', 'abcdefghij']] as const) {
        const r = await submit({ ...base0, [field]: value });
        expect(r.status).toBe(400);
        expect(r.json.error.details).toContainEqual(expect.objectContaining({ field, code: 'INVALID_FORMAT' }));
      }
      expect(await countSubmissions(mail)).toBe(0);
    });

    it('applies documented length limits to Unicode code points and accepts Vietnamese and emoji text', async () => {
      const name120 = 'Đ'.repeat(120), review5000 = 'ệ🥦'.repeat(2500).slice(0, 5000 * 2);
      const mail = email();
      const ok = await submit({ fullName: name120, phoneNumber: phone(), email: mail, review: Array.from('ệ🥦'.repeat(2500)).slice(0, 5000).join('') });
      expect(ok.status, ok.text).toBe(202);
      expect(review5000.length).toBeGreaterThan(0);
      expect((await submit(valid({ fullName: 'Đ'.repeat(121) }))).status).toBe(400);
      expect((await submit(valid({ review: 'x'.repeat(5001) }))).status).toBe(400);
      expect((await submit(valid({ email: 'a'.repeat(250) + '@b.vn' }))).json.error.details).toContainEqual(expect.objectContaining({ field: 'email' }));
      const [row] = await q('select char_length(full_name) as name,char_length(review) as review from public.feedback_popup_submissions where email=$1', mail);
      expect(row).toEqual({ name: 120, review: 5000 });
    });

    it('stores Vietnamese text in NFC and keeps hostile markup as inert plain text', async () => {
      const mail = email();
      const decomposed = 'Nguyễn Thạ́i'; // NFD input
      const review = '<script>alert(1)</script> <img src=x onerror=alert(1)> {{7*7}} \'; drop table users;--';
      expect((await submit(valid({ email: mail, fullName: decomposed, review }))).status).toBe(202);
      const [row] = await q('select full_name,review from public.feedback_popup_submissions where email=$1', mail);
      expect(row.full_name).toBe(decomposed.normalize('NFC'));
      expect(row.review).toBe(review);
      expect((await q("select to_regclass('public.users') is not null as ok"))[0].ok).toBe(true);
    });

    it('rejects control characters, lone surrogates and every client-controlled reward/identity field', async () => {
      for (const body of [valid({ fullName: 'Ten\u0000X' }), valid({ review: 'a\u0007b' }), valid({ fullName: 'bad\ud800name' })]) {
        const r = await submit(body);
        expect(r.status).toBe(400);
        expect(r.json.error.details[0].code).toBe('INVALID_CHARACTERS');
      }
      const mail = email();
      for (const extra of ['userId', 'accountId', 'role', 'plan', 'planId', 'durationDays', 'durationSeconds', 'startsAt', 'endsAt', 'expiresAt', 'state', 'status', 'enabled', 'campaignId', 'workspaceId', 'verified', 'password']) {
        const r = await submit({ ...valid({ email: mail }), [extra]: extra === 'durationDays' ? 3650 : 'x' });
        expect(r.status, extra).toBe(400);
        expect(r.json.error.details).toContainEqual(expect.objectContaining({ field: extra, code: 'UNKNOWN_FIELD' }));
      }
      expect(await countSubmissions(mail)).toBe(0);
    });

    it('answers malformed JSON, wrong media type, non-object bodies and oversize bodies with structured client errors', async () => {
      const bad = await api(`${PATH}/submissions`, { method: 'POST', raw: '{"fullName": "secret-fragment-of-body", ' });
      expect(bad.status).toBe(400);
      expect(bad.json.error.code).toBe('INVALID_JSON');
      expect(bad.text).not.toContain('secret-fragment');
      const text = await api(`${PATH}/submissions`, { method: 'POST', raw: 'fullName=a', headers: { 'Content-Type': 'text/plain' } });
      expect(text.status).toBe(415);
      expect(text.json.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
      expect((await submit([1, 2, 3])).status).toBe(400);
      expect((await submit('a string')).status).toBe(400);
      expect((await submit(null)).status).toBe(400);
      const huge = await submit({ ...valid(), review: 'x'.repeat(250_000) });
      expect(huge.status).toBe(413);
      expect(huge.json.error.code).toBe('PAYLOAD_TOO_LARGE');
      const large = await submit({ ...valid(), review: 'x'.repeat(40_000) });
      expect(large.status).toBe(413);
      for (const response of [bad, text, huge]) expect(response.text).not.toMatch(/stack|at .*\.js|node_modules/i);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('submission semantics', () => {
    it('anonymous visitors get a uniform 202 and no account, session or credential is created', async () => {
      const mail = email(), tel = phone();
      const r = await submit({ fullName: 'Khách ẩn danh', phoneNumber: tel, email: mail, review: 'Rất tiện lợi' });
      expect(r.status).toBe(202);
      expect(Object.keys(r.json).sort()).toEqual(['acceptedAt', 'message', 'status', 'submissionId']);
      expect(r.json.status).toBe('ACCEPTED');
      expect(r.text).not.toMatch(/token|session|password|userId|account|workspace|premium.*(đã|active|kích)/i);
      expect(r.headers.get('set-cookie')).toBeNull();
      expect(await q('select count(*)::int as n from public.users where email=$1 or phone=$2', mail, tel)).toEqual([{ n: 0 }]);
      expect(await rewardOf(mail)).toEqual([expect.objectContaining({ state: 'PENDING_ACCOUNT', user_id: null })]);
    });

    it('the response is indistinguishable whether the contact is new, matches an account, is a duplicate, conflicts or is blocked', async () => {

   const owner = await register({ phone: phone() });
      const other = await register({ phone: phone() });
      const disabled = await register();
      await q("update public.users set status='DISABLED' where id=$1::uuid", disabled.id);
      const outcomes = [
        valid(), // new visitor
        valid({ email: owner.email }), // matches an eligible account
        valid({ email: owner.email }), // duplicate
        valid({ email: owner.email, phoneNumber: other.phone }), // conflict
        valid({ email: disabled.email }), // ineligible account
      ];
      const results = [];
      for (const body of outcomes) results.push(await submit(body));
      for (const r of results) {
        expect(r.status).toBe(202);
        expect(Object.keys(r.json).sort()).toEqual(['acceptedAt', 'message', 'status', 'submissionId']);
      }
      expect(new Set(results.map(r => r.json.message)).size).toBe(1);
      expect(new Set(results.map(r => r.json.status)).size).toBe(1);
      expect(new Set(results.map(r => r.text.length - r.json.submissionId.length - r.json.acceptedAt.length)).size).toBe(1);
      expect((await rewardOf(owner.email!)).map(r => r.state)).toEqual(['GRANTED', 'DUPLICATE', 'CONFLICT']);
    });

    it('an authenticated submission only records who sent it; a bad token is just an anonymous visitor', async () => {
      const account = await register();
      const withToken = valid(), withBadToken = valid();
      expect((await submit(withToken, { Authorization: 'Bearer ' + account.token })).status).toBe(202);
      expect((await submit(withBadToken, { Authorization: 'Bearer not.a.real.token' })).status).toBe(202);
      expect((await q('select submitter_user_id from public.feedback_popup_submissions where email=$1', withToken.email))[0].submitter_user_id).toBe(account.id);
      expect((await q('select submitter_user_id from public.feedback_popup_submissions where email=$1', withBadToken.email))[0].submitter_user_id).toBeNull();
      // The submitter is not the beneficiary: contact data decides, not the session.
      expect((await rewardOf(withToken.email))[0]).toMatchObject({ state: 'PENDING_ACCOUNT', user_id: null });
    });

    it('an existing Free account gets effective Premium immediately in the existing profile, home and billing contracts', async () => {
      const account = await register({ phone: '+84912' + String(Math.floor(Math.random() * 1e6)).padStart(6, '0') });
      const before = await me(account.token);
      expect(before).toMatchObject({ plan: 'free', productLimit: 30 });
      expect(before.voiceQuota.total).toBe(15);
      const home0 = await api(`/workspaces/${account.workspaceId}/home`, { headers: { Authorization: 'Bearer ' + account.token } });
      expect(home0.json).toMatchObject({ plan: 'free', freePlanLimit: 30 });
      // Local Vietnamese notation of the same number must resolve to the same account.
      const local = account.phone!.replace('+84', '0');
      expect((await submit(valid({ email: email(), phoneNumber: local }))).status).toBe(202);
      const after = await me(account.token);
      expect(after).toMatchObject({ plan: 'personal', productLimit: null });
      expect(after.voiceQuota.total).toBe(60);
      const home1 = await api(`/workspaces/${account.workspaceId}/home`, { headers: { Authorization: 'Bearer ' + account.token } });
      expect(home1.json).toMatchObject({ plan: 'personal', freePlanLimit: null });
      const billing = await api(`/workspaces/${account.workspaceId}/billing/subscription`, { headers: { Authorization: 'Bearer ' + account.token } });
      expect(billing.json.subscription).toMatchObject({ plan: 'personal', source: 'PROMOTION' });
      expect(new Date(billing.json.subscription.expiresAt).getTime() - new Date(billing.json.subscription.startsAt).getTime()).toBe(30 * 86_400_000);
      expect(billing.json.scheduled).toEqual([]);
      expect(billing.json.eligibility).toMatchObject({ personal: null, family: null });
      expect(billing.json.checkoutEnabled).toBe(false);
    });

    it('a reward that expires is reflected on the next request: no stale 30-second cache or token claim', async () => {
      const account = await register();
      const mail = account.email!;
      await submit(valid({ email: mail }));
      expect((await me(account.token)).plan).toBe('personal');
      expect((await api(`/workspaces/${account.workspaceId}/home`, { headers: { Authorization: 'Bearer ' + account.token } })).json.plan).toBe('personal');
      await q("update public.billing_grants set starts_at=starts_at-interval '40 days',expires_at=expires_at-interval '40 days' where reward_id in (select r.id from public.feedback_popup_rewards r join public.feedback_popup_submissions s on s.id=r.submission_id where s.email=$1)", mail);
      expect((await me(account.token)).plan).toBe('free');
      expect((await api(`/workspaces/${account.workspaceId}/home`, { headers: { Authorization: 'Bearer ' + account.token } })).json).toMatchObject({ plan: 'free', freePlanLimit: 30 });
      expect((await me(account.token)).voiceQuota.total).toBe(15);
    });

    it('a pending reward is claimed by registration with the matching e-mail or phone, however the phone is written', async () => {
      const byEmail = valid();
      expect((await submit(byEmail)).status).toBe(202);
      expect((await rewardOf(byEmail.email))[0].state).toBe('PENDING_ACCOUNT');
      const a = await register({ email: byEmail.email });
      expect(await me(a.token)).toMatchObject({ plan: 'personal', productLimit: null });
      expect((await rewardOf(byEmail.email))[0]).toMatchObject({ state: 'GRANTED', user_id: a.id });

      const e164 = phone();
      const byPhone = valid({ phoneNumber: e164.replace('+84', '0') }); // submitted in local notation
      expect((await submit(byPhone)).status).toBe(202);
      const b = await register({ email: email(), phone: e164.replace('+84', '+84 ') }); // registered with spaces
      expect(await me(b.token)).toMatchObject({ plan: 'personal' });
      expect((await q('select phone from public.feedback_popup_submissions where email=$1', byPhone.email))[0].phone).toBe(e164);
    });

    it('registration stays unchanged for everyone else, and a contact that was never nominated gets no reward', async () => {
      const plain = await register();
      expect(await me(plain.token)).toMatchObject({ plan: 'free', productLimit: 30 });
      const login = await api('/auth/login', { method: 'POST', body: { identifier: plain.email, password: 'wrong-password-123' } });
      expect(login.status).toBe(401);
      expect(Object.keys(await me(plain.token)).sort()).toEqual(['address', 'displayName', 'email', 'language', 'loginPhone', 'phone', 'plan', 'productLimit', 'role', 'userId', 'voiceQuota', 'workspaceId', 'workspaceName', 'workspaceType']);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('retries, idempotency and concurrency', () => {
    it('Idempotency-Key: format, replay, payload conflict, and replay after the popup is switched off', async () => {
      const body = valid();
      expect((await submit(body, { 'Idempotency-Key': 'not-a-uuid' })).json.error.code).toBe('INVALID_IDEMPOTENCY_KEY');
      const key = randomUUID();
      const first = await submit(body, { 'Idempotency-Key': key });
      const second = await submit(body, { 'Idempotency-Key': key.toUpperCase() });
      expect([first.status, second.status]).toEqual([202, 202]);
      expect(second.json).toEqual(first.json);
      expect(await countSubmissions(body.email)).toBe(1);
      const conflict = await submit({ ...body, review: 'a different review' }, { 'Idempotency-Key': key });
      expect(conflict.status).toBe(409);
      expect(conflict.json.error.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(conflict.text).not.toContain(body.email);
      // Formatting-only differences are the same request.
      const sameMeaning = await submit({ ...body, phoneNumber: body.phoneNumber.replace('+84', '0') }, { 'Idempotency-Key': key });
      expect(sameMeaning.json).toEqual(first.json);
      await setEnabled(false);
      try {
        expect((await submit(body, { 'Idempotency-Key': key })).json).toEqual(first.json); // already accepted: replay still answers
        const refused = await submit(valid(), { 'Idempotency-Key': randomUUID() });
        expect(refused.status).toBe(409);
        expect(refused.json.error.code).toBe('FEEDBACK_POPUP_DISABLED');
        expect((await api(PATH)).json.enabled).toBe(false);
      } finally {
        await setEnabled(true);
      }
    });

    it('double-clicks and parallel submissions never accumulate rewards', async () => {
      const account = await register();
      const twice = await Promise.all([submit(valid({ email: account.email })), submit(valid({ email: account.email }))]);
      expect(twice.map(r => r.status)).toEqual([202, 202]);
      const burst = await Promise.all(Array.from({ length: 8 }, () => submit(valid({ email: account.email }), { 'Idempotency-Key': randomUUID() })));
      expect(burst.every(r => r.status === 202)).toBe(true);
      const states = (await rewardOf(account.email!)).map(r => r.state).sort();
      expect(states.filter(state => state === 'GRANTED')).toHaveLength(1);
      expect(states.filter(state => state === 'DUPLICATE')).toHaveLength(9);
      expect((await q('select count(*)::int as n from public.billing_grants where workspace_id=$1::uuid and reward_id is not null', account.workspaceId))[0].n).toBe(1);
      const same = valid(), key = randomUUID();
      const replays = await Promise.all(Array.from({ length: 8 }, () => submit(same, { 'Idempotency-Key': key })));
      expect(new Set(replays.map(r => r.json.submissionId)).size).toBe(1);
      expect(await countSubmissions(same.email)).toBe(1);
    });

    it('a submission racing the matching registration converges to exactly one grant', async () => {
      for (let round = 0; round < 5; round += 1) {
        const body = valid();
        const [s, a] = await Promise.all([submit(body), register({ email: body.email })]);
        expect(s.status).toBe(202);
        await q('select public.feedback_popup_reconcile(50)');
        const rewards = await rewardOf(body.email);
        expect(rewards, `round ${round}`).toEqual([expect.objectContaining({ state: 'GRANTED', user_id: a.id })]);
        expect((await me(a.token)).plan).toBe('personal');
      }
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('cross-origin access and abuse controls', () => {
    it('answers preflight only for the website origin and only for what the form uses', async () => {
      const ok = await api(`${PATH}/submissions`, { method: 'OPTIONS', headers: { Origin: SITE, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, idempotency-key' } });
      expect(ok.status).toBe(204);
      expect(ok.headers.get('access-control-allow-origin')).toBe(SITE);
      expect(ok.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
      expect(ok.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('idempotency-key');
      expect(ok.headers.get('access-control-allow-credentials')).toBeNull();
      expect(ok.headers.get('access-control-max-age')).toBe('600');
      const configPreflight = await api(PATH, { method: 'OPTIONS', headers: { Origin: SITE, 'Access-Control-Request-Method': 'GET' } });
      expect(configPreflight.status).toBe(204);
      const foreign = await api(`${PATH}/submissions`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
      expect(foreign.status).toBe(403);
      expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
      for (const [method, headers] of [['DELETE', 'content-type'], ['POST', 'x-evil-header']] as const) {
        expect((await api(`${PATH}/submissions`, { method: 'OPTIONS', headers: { Origin: SITE, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': headers } })).status).toBe(400);
      }
    });

    it('a request from a foreign website origin is refused before anything is stored; browserless clients are unaffected', async () => {
      const body = valid();
      const foreign = await submit(body, { Origin: 'https://evil.example' });
      expect(foreign.status).toBe(403);
      expect(foreign.json.error.code).toBe('ORIGIN_NOT_ALLOWED');
      expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
      expect(await countSubmissions(body.email)).toBe(0);
      expect((await submit(body, { Origin: SITE })).headers.get('access-control-allow-origin')).toBe(SITE);
      expect((await submit(valid())).status).toBe(202); // curl: no Origin header
    });

    it('error responses stay readable by the website (CORS headers on validation, size and disabled errors)', async () => {
      const invalid = await submit({}, { Origin: SITE });
      expect(invalid.status).toBe(400);
      expect(invalid.headers.get('access-control-allow-origin')).toBe(SITE);
      const huge = await submit({ ...valid(), review: 'x'.repeat(250_000) }, { Origin: SITE });
      expect(huge.status).toBe(413);
      expect(huge.headers.get('access-control-allow-origin')).toBe(SITE);
    });

    it('rate limits the public endpoints per client address with Retry-After and a stable error code', async () => {
      process.env.FEEDBACK_POPUP_SUBMIT_RATE_LIMIT = '2';
      process.env.FEEDBACK_POPUP_CONFIG_RATE_LIMIT = '3';
      try {
        const isolated = await boot(); // fresh limiter state
        const first = await submit(valid(), {}, isolated);
        const second = await submit(valid(), { Origin: SITE }, isolated);
        const third = await submit(valid(), { Origin: SITE }, isolated);
        expect([first.status, second.status, third.status]).toEqual([202, 202, 429]);
        expect(third.json.error.code).toBe('RATE_LIMITED');
        expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0);
        expect(third.headers.get('access-control-allow-origin')).toBe(SITE);
        expect(third.headers.get('access-control-expose-headers')).toContain('Retry-After');
        const statuses = [];
        for (let i = 0; i < 5; i += 1) statuses.push((await api(PATH, { url: isolated })).status);
        expect(statuses).toEqual([200, 200, 200, 429, 429]);
        // The cheap, side-effect-free preflight is never throttled.
        expect((await api(`${PATH}/submissions`, { method: 'OPTIONS', url: isolated, headers: { Origin: SITE, 'Access-Control-Request-Method': 'POST' } })).status).toBe(204);
      } finally {
        process.env.FEEDBACK_POPUP_SUBMIT_RATE_LIMIT = '1000';
        process.env.FEEDBACK_POPUP_CONFIG_RATE_LIMIT = '1000';
      }
    });
  });
});
