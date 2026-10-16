import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { environment } from '../src/config/env';
import { ApiErrorFilter } from '../src/common/api-error.filter';
import { applyPublicCors, PublicCorsGuard, publicCorsForError } from '../src/feedback-popup/feedback-popup.cors';
import { codePoints, FEEDBACK_POPUP_CAMPAIGN_ID, parseFeedbackBody, parseIdempotencyKey, payloadHash } from '../src/feedback-popup/feedback-popup.validation';
import { AdminFeedback } from '../src/admin/admin.feedback';
import { normalizeEmail } from '../src/auth/identifiers';
import { FeedbackPopupService } from '../src/feedback-popup/feedback-popup.service';

function baseline() {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DATABASE_URL', 'postgresql://placeholder:placeholder@invalid/homemind_unit_test');
  for (const key of ['AUTH_ACCESS_SECRET', 'AUTH_REFRESH_SECRET', 'AUTH_RESET_SECRET']) vi.stubEnv(key, randomBytes(32).toString('hex'));
  vi.stubEnv('AUTH_DEV_RESET_DELIVERY', 'false');
  vi.stubEnv('AUTH_REQUIRE_VERIFICATION', 'false');
  vi.stubEnv('PUBLIC_WEB_ORIGINS', '');
}
beforeEach(baseline);
afterEach(() => vi.unstubAllEnvs());

describe('feedback transaction contention response', () => {
  it.each(['40P01 deadlock detected', '40001 could not serialize access due to concurrent update', '55P03 lock timeout', '57014 statement timeout'])('returns retryable 503 without exposing SQL for %s', async message => {
    const transaction = vi.fn().mockRejectedValue(new Error(message));
    const service = new FeedbackPopupService({ $transaction: transaction } as never, {} as never);
    try {
      await service.submit({ fullName: 'Synthetic fixture', email: 'fixture@example.invalid', phoneNumber: '0912345678', review: 'Valid feedback' }, {});
      throw new Error('Expected contention failure');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).getStatus()).toBe(503);
      expect((e as HttpException).getResponse()).toMatchObject({ code: 'FEEDBACK_POPUP_BUSY', details: null });
      expect(JSON.stringify((e as HttpException).getResponse())).not.toContain(message);
    }
    expect(transaction).toHaveBeenCalledTimes(1); // No unbounded automatic retry.
  });
});

const fieldErrors = (body: unknown) => {
  try { parseFeedbackBody(body); } catch (error) {
    return ((error as HttpException).getResponse() as { details: Array<{ field: string; code: string }> }).details;
  }
  throw new Error('expected a validation error');
};
const valid = (over: Record<string, unknown> = {}) => ({ fullName: 'Nguyễn Văn An', phoneNumber: '0912345678', email: 'an@example.com', review: 'Rất hữu ích', ...over });

describe('feedback popup input validation (pure)', () => {
  it('preserves the existing auth email identity without merging Unicode forms', () => {
    const decomposed = 'u\u0308ser@example.invalid';
    const composed = decomposed.normalize('NFC');
    expect(normalizeEmail(decomposed)).not.toBe(normalizeEmail(composed));
    for (const email of [decomposed, composed]) {
      expect(parseFeedbackBody(valid({ email })).email).toBe(normalizeEmail(email));
    }
  });
  it('normalises names, phones, e-mail and review without truncating anything', () => {
    expect(parseFeedbackBody(valid({ fullName: '  Nguyễn  Văn A ', phoneNumber: ' 0912 345 678 ', email: ' Hoa.Nguyen@Example.COM ', review: '  tốt  \n' })))
      .toEqual({ fullName: 'Nguyễn  Văn A', phone: '+84912345678', email: 'hoa.nguyen@example.com', review: 'tốt' });
    for (const notation of ['0912345678', '+84912345678', '+84 912 345 678', '84912345678', '(+84) 912-345-678']) {
      expect(parseFeedbackBody(valid({ phoneNumber: notation })).phone, notation).toBe('+84912345678');
    }
    expect(parseFeedbackBody(valid({ fullName: 'Nguyễn' })).fullName).toBe('Nguyễn'.normalize('NFC'));
  });

  it('counts Unicode code points, so emoji and diacritics hit the documented limits exactly', () => {
    expect(codePoints('🥦'.repeat(120))).toBe(120);
    expect(parseFeedbackBody(valid({ fullName: '🥦'.repeat(120) })).fullName).toHaveLength(240);
    expect(fieldErrors(valid({ fullName: '🥦'.repeat(121) }))).toEqual([expect.objectContaining({ field: 'fullName', code: 'TOO_LONG' })]);
    expect(parseFeedbackBody(valid({ review: 'ệ'.repeat(5000) })).review).toHaveLength(5000);
    expect(fieldErrors(valid({ review: 'ệ'.repeat(5001) }))).toEqual([expect.objectContaining({ field: 'review', code: 'TOO_LONG' })]);
    expect(fieldErrors(valid({ email: `${'a'.repeat(250)}@b.vn` }))).toEqual([expect.objectContaining({ field: 'email', code: 'TOO_LONG' })]);
    expect(fieldErrors(valid({ email: 'khong-hop-le' }))).toEqual([expect.objectContaining({ field: 'email', code: 'INVALID_FORMAT' })]);
    expect(fieldErrors(valid({ phoneNumber: '1'.repeat(201) }))).toEqual([expect.objectContaining({ field: 'phoneNumber', code: 'TOO_LONG' })]);
    expect(fieldErrors(valid({ review: 'x'.repeat(20001) }))).toEqual([expect.objectContaining({ field: 'review', code: 'TOO_LONG' })]);
  });

  it('reports every problem at once with a stable code per case', () => {
    const errors = fieldErrors({ fullName: '   ', phoneNumber: 5, email: 'nope', review: null, userId: 'x', role: 'admin' });
    expect(errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'userId', code: 'UNKNOWN_FIELD' }), expect.objectContaining({ field: 'role', code: 'UNKNOWN_FIELD' }),
      expect.objectContaining({ field: 'fullName', code: 'REQUIRED' }), expect.objectContaining({ field: 'phoneNumber', code: 'INVALID_TYPE' }),
      expect.objectContaining({ field: 'email', code: 'INVALID_FORMAT' }), expect.objectContaining({ field: 'review', code: 'REQUIRED' }),
    ]));
    for (const body of [null, [], 'text', 42, true]) expect(fieldErrors(body)).toEqual([expect.objectContaining({ field: 'body', code: 'INVALID_TYPE' })]);
    expect(fieldErrors(valid({ ['<script>']: 1 }))).toEqual([expect.objectContaining({ field: 'body', code: 'UNKNOWN_FIELD' })]); // hostile key names are not echoed
    expect((() => { try { parseFeedbackBody({}); } catch (e) { return (e as HttpException).getStatus(); } })()).toBe(400);
  });

  it('rejects control characters and broken UTF-16 but allows line breaks in free text only', () => {
    expect(parseFeedbackBody(valid({ review: 'Dòng 1\nDòng 2\tcó tab\r\nXong' })).review).toContain('\n');
    for (const field of ['fullName', 'review']) {
      for (const bad of ['a\u0000b', 'a\u0007b', 'a\u007fb', 'a\ud800b', 'a\udc00b']) {
        expect(fieldErrors(valid({ [field]: bad })), `${field} ${JSON.stringify(bad)}`).toEqual([expect.objectContaining({ field, code: 'INVALID_CHARACTERS' })]);
      }
    }
    expect(fieldErrors(valid({ fullName: 'Hai\ndòng' }))).toEqual([expect.objectContaining({ field: 'fullName', code: 'INVALID_CHARACTERS' })]);
    expect(parseFeedbackBody(valid({ review: 'ok 🥦 😀' })).review).toContain('😀'); // a valid surrogate pair is fine
  });

  it('hashes the normalised request, so a retry that only changes formatting is the same request', () => {
    const a = parseFeedbackBody(valid({ phoneNumber: '0912345678', email: 'AN@example.com' }));
    const b = parseFeedbackBody(valid({ phoneNumber: '+84 912 345 678', email: 'an@example.com' }));
    expect(payloadHash(FEEDBACK_POPUP_CAMPAIGN_ID, a)).toBe(payloadHash(FEEDBACK_POPUP_CAMPAIGN_ID, b));
    expect(payloadHash(FEEDBACK_POPUP_CAMPAIGN_ID, a)).not.toBe(payloadHash(FEEDBACK_POPUP_CAMPAIGN_ID, { ...a, review: 'khác' }));
    expect(payloadHash('another-campaign', a)).not.toBe(payloadHash(FEEDBACK_POPUP_CAMPAIGN_ID, a));
    expect(payloadHash(FEEDBACK_POPUP_CAMPAIGN_ID, a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts only UUID idempotency keys and lower-cases them', () => {
    expect(parseIdempotencyKey(undefined)).toBeNull();
    expect(parseIdempotencyKey('7D6B0F0E-3C2A-4A39-9D57-2D1C4F5A9E11')).toBe('7d6b0f0e-3c2a-4a39-9d57-2d1c4f5a9e11');
    for (const bad of ['', 'abc', '7d6b0f0e3c2a4a399d572d1c4f5a9e11', ['7d6b0f0e-3c2a-4a39-9d57-2d1c4f5a9e11', 'x'], '7d6b0f0e-3c2a-4a39-9d57-2d1c4f5a9e1z']) {
      expect(() => parseIdempotencyKey(bad as string), String(bad)).toThrow(BadRequestException);
    }
  });
});

describe('public CORS policy', () => {
  const response = () => {
    const headers: Record<string, string> = {};
    return { headers, setHeader: (k: string, v: string) => { headers[k.toLowerCase()] = v; }, vary: (v: string) => { headers.vary = v; } };
  };
  const request = (headers: Record<string, string>, extra: Record<string, unknown> = {}) => ({ headers, method: 'POST', originalUrl: '/v1/public/feedback-popup/submissions', ...extra });

  it('answers only the configured website origin, never with credentials or a wildcard', () => {
    const res = response();
    applyPublicCors(request({ origin: 'https://homemind.vn' }) as never, res as never);
    expect(res.headers['access-control-allow-origin']).toBe('https://homemind.vn');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    expect(res.headers.vary).toBe('Origin');
    const plain = response();
    applyPublicCors(request({}) as never, plain as never);
    expect(plain.headers['access-control-allow-origin']).toBeUndefined(); // curl, mobile, server-to-server
    for (const origin of ['https://evil.example', 'https://homemind.vn.evil.example', 'http://homemind.vn', 'https://www.homemind.vn', 'null', '*']) {
      expect(() => applyPublicCors(request({ origin }) as never, response() as never), origin).toThrow(ForbiddenException);
    }
  });

  it('validates preflight method and headers against what the form really uses', () => {
    const ok = response();
    applyPublicCors(request({ origin: 'https://homemind.vn', 'access-control-request-method': 'POST', 'access-control-request-headers': 'Content-Type, Idempotency-Key, Authorization' }) as never, ok as never, true);
    expect(ok.headers['access-control-allow-methods']).toBe('GET, POST, OPTIONS');
    expect(ok.headers['access-control-max-age']).toBe('600');
    for (const [method, headers] of [['PUT', 'content-type'], ['DELETE', ''], ['POST', 'x-requested-with'], ['POST', 'content-type, cookie']]) {
      expect(() => applyPublicCors(request({ origin: 'https://homemind.vn', 'access-control-request-method': method, 'access-control-request-headers': headers }) as never, response() as never, true)).toThrow(BadRequestException);
    }
  });

  it('the guard skips OPTIONS (handled explicitly) and the error hook only touches the feedback routes', () => {
    const guard = new PublicCorsGuard();
    const context = (method: string, origin?: string) => ({ switchToHttp: () => ({ getRequest: () => request(origin ? { origin } : {}, { method }), getResponse: () => response() }) }) as never;
    expect(guard.canActivate(context('OPTIONS', 'https://evil.example'))).toBe(true);
    expect(() => guard.canActivate(context('POST', 'https://evil.example'))).toThrow(ForbiddenException);
    const ours = response(), other = response();
    publicCorsForError(request({ origin: 'https://homemind.vn' }) as never, ours as never);
    publicCorsForError(request({ origin: 'https://homemind.vn' }, { originalUrl: '/v1/billing/plans' }) as never, other as never);
    expect(ours.headers['access-control-allow-origin']).toBe('https://homemind.vn');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
    const foreign = response();
    publicCorsForError(request({ origin: 'https://evil.example' }) as never, foreign as never);
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('PUBLIC_WEB_ORIGINS accepts exact origins only, with https required in production', () => {
    expect(environment().publicWebOrigins).toEqual(['https://homemind.vn']);
    vi.stubEnv('PUBLIC_WEB_ORIGINS', 'https://homemind.vn, https://www.homemind.vn');
    expect(environment().publicWebOrigins).toEqual(['https://homemind.vn', 'https://www.homemind.vn']);
    vi.stubEnv('PUBLIC_WEB_ORIGINS', 'http://localhost:5173');
    expect(environment().publicWebOrigins).toEqual(['http://localhost:5173']);
    for (const bad of ['*', 'https://homemind.vn/', 'https://homemind.vn/path', 'homemind.vn', 'http://homemind.vn', 'https://user:pw@homemind.vn', 'https://homemind.vn,https://homemind.vn', 'ftp://homemind.vn', 'a,b,c,d,e,f']) {
      vi.stubEnv('PUBLIC_WEB_ORIGINS', bad);
      expect(() => environment(), bad).toThrow('PUBLIC_WEB_ORIGINS');
    }
    vi.stubEnv('PUBLIC_WEB_ORIGINS', 'http://localhost:5173');
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('BILLING_ORDER_NAMESPACE', '2');
    expect(() => environment()).toThrow('PUBLIC_WEB_ORIGINS');
  });

  it('rate limits and the reconciliation interval are validated; the worker is off by default in tests', () => {
    const config = environment();
    expect(config).toMatchObject({ feedbackSubmitRateLimit: 5, feedbackConfigRateLimit: 60, feedbackReconcileSeconds: 0 });
    vi.stubEnv('NODE_ENV', 'development');
    expect(environment().feedbackReconcileSeconds).toBe(15);
    vi.stubEnv('FEEDBACK_POPUP_RECONCILE_SECONDS', '0');
    expect(environment().feedbackReconcileSeconds).toBe(0);
    for (const [name, value] of [['FEEDBACK_POPUP_SUBMIT_RATE_LIMIT', '0'], ['FEEDBACK_POPUP_SUBMIT_RATE_LIMIT', '1001'], ['FEEDBACK_POPUP_CONFIG_RATE_LIMIT', 'x'], ['FEEDBACK_POPUP_RECONCILE_SECONDS', '-1'], ['FEEDBACK_POPUP_RECONCILE_SECONDS', '3601']]) {
      vi.stubEnv(name, value);
      expect(() => environment(), `${name}=${value}`).toThrow(name);
      delete process.env[name];
    }
    // A blank value is the same as unset: it can never prevent the API from starting.
    for (const name of ['FEEDBACK_POPUP_SUBMIT_RATE_LIMIT', 'FEEDBACK_POPUP_CONFIG_RATE_LIMIT', 'FEEDBACK_POPUP_RECONCILE_SECONDS', 'PUBLIC_WEB_ORIGINS']) vi.stubEnv(name, '  ');
    expect(environment()).toMatchObject({ feedbackSubmitRateLimit: 5, feedbackConfigRateLimit: 60, feedbackReconcileSeconds: 15, publicWebOrigins: ['https://homemind.vn'] });
  });
});

describe('shared error filter', () => {
  function run(exception: unknown, request: Record<string, unknown> = { headers: {}, originalUrl: '/v1/x' }) {
    const res: { statusCode?: number; body?: unknown; headers: Record<string, string>; status(code: number): typeof res; json(body: unknown): typeof res; setHeader(k: string, v: string): void; vary(v: string): void } = {
      headers: {}, status(code) { res.statusCode = code; return res; }, json(body) { res.body = body; return res; },
      setHeader(k, v) { res.headers[k.toLowerCase()] = v; }, vary(v) { res.headers.vary = v; },
    };
    new ApiErrorFilter().catch(exception, { switchToHttp: () => ({ getRequest: () => request, getResponse: () => res }) } as never);
    return res;
  }

  it('turns body-parser failures into client errors instead of INTERNAL_ERROR', () => {
    const tooLarge = Object.assign(new Error('request entity too large'), { type: 'entity.too.large', status: 413 });
    expect(run(tooLarge)).toMatchObject({ statusCode: 413, body: { error: { code: 'PAYLOAD_TOO_LARGE', details: null } } });
    expect(run(Object.assign(new Error('unsupported charset "UTF-7"'), { type: 'charset.unsupported', status: 415 }))).toMatchObject({ statusCode: 415, body: { error: { code: 'UNSUPPORTED_MEDIA_TYPE' } } });
    expect(run(Object.assign(new Error('request aborted'), { type: 'request.aborted', status: 400 }))).toMatchObject({ statusCode: 400, body: { error: { code: 'VALIDATION_ERROR' } } });
    expect(run(new Error('something else'))).toMatchObject({ statusCode: 500, body: { error: { code: 'INTERNAL_ERROR' } } });
  });

  it('never echoes a fragment of a malformed JSON body, and leaves validation messages alone', () => {
    const syntax = new BadRequestException('Unexpected token \'}\', "{"secret-value": }" is not valid JSON');
    const response = run(syntax);
    expect(response).toMatchObject({ statusCode: 400, body: { error: { code: 'INVALID_JSON' } } });
    expect(JSON.stringify(response.body)).not.toContain('secret-value');
    const validation = run(new BadRequestException(['email must be an email', 'property x should not exist']));
    expect(validation).toMatchObject({ statusCode: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'email must be an email,property x should not exist' } } });
    const coded = run(new BadRequestException({ code: 'INVALID_IDEMPOTENCY_KEY', message: 'Mã JSON sai', details: null }));
    expect(coded.body).toEqual({ error: { code: 'INVALID_IDEMPOTENCY_KEY', message: 'Mã JSON sai', details: null } });
  });

  it('adds CORS headers to error responses of the public feedback routes only', () => {
    const ours = run(new NotFoundException(), { headers: { origin: 'https://homemind.vn' }, originalUrl: '/v1/public/feedback-popup/submissions?x=1' });
    expect(ours.headers['access-control-allow-origin']).toBe('https://homemind.vn');
    const other = run(new NotFoundException(), { headers: { origin: 'https://homemind.vn' }, originalUrl: '/v1/inventory' });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('admin submission query validation', () => {
  const request = { admin: { admin_id: 'ab6e0b6c-8e1c-4c3a-9d8b-2c6a8fd0f111' } } as never;
  const service = () => { const execute = vi.fn().mockResolvedValue({ data: {}, meta: {} }); return { feedback: new AdminFeedback({ execute, auth: {} } as never), execute }; };

  it('keeps old decision fields while optionally serializing truthful lifecycle timestamps to UTC', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const base = { id, campaignId: FEEDBACK_POPUP_CAMPAIGN_ID, submittedAt: '2026-10-10T07:00:00+07:00', fullName: 'Fixture', email: 'fixture@example.invalid', phoneNumber: '+84912345678', duplicate: true,
      benefit: { state: 'DUPLICATE', reason: 'ACCOUNT_ALREADY_REWARDED', durationSeconds: 2592000, startsAt: null, endsAt: null } };
    const query = vi.fn();
    const feedback = new AdminFeedback({ execute: async (_req: unknown, _action: unknown, fn: (tx: unknown) => unknown) => ({ data: await fn({ $queryRawUnsafe: query }), meta: {} }) } as never);
    query.mockResolvedValueOnce([{ data: base, segments: [] }]);
    const old = (await feedback.detail(request, id)).data;
    expect(old).not.toHaveProperty('lifecycle');
    expect(old.benefit).toMatchObject({ state: 'DUPLICATE', startsAt: null, endsAt: null });
    const life = { rewardId: id, state: 'ACTIVE', awardedAt: '2026-10-10T07:00:00+07:00', accountCreatedAt: new Date('2026-10-09T00:00:00Z'), linkedAt: null, firstSubmittedAt: null, lastSubmittedAt: null,
      expectedStartsAt: null, expectedEndsAt: null, actualStartedAt: null, completedAt: null, featureUsage: { status: 'NOT_TRACKED', used: null } };
    query.mockResolvedValueOnce([{ data: { ...base, lifecycle: life }, segments: [] }]);
    const extended = (await feedback.detail(request, id)).data;
    expect(extended.benefit).toEqual(old.benefit);
    expect(extended.lifecycle).toMatchObject({ awardedAt: '2026-10-10T00:00:00.000Z', accountCreatedAt: '2026-10-09T00:00:00.000Z', linkedAt: null, state: 'ACTIVE', featureUsage: { status: 'NOT_TRACKED', used: null } });
    expect(extended).toHaveProperty('segments', []);
    expect(life.awardedAt).toBe('2026-10-10T07:00:00+07:00'); // Does not mutate SQL data.
  });

  it('accepts the documented filters and rejects everything else before touching the database', () => {
    const { feedback, execute } = service();
    expect(() => feedback.list(request, { limit: '100', sort: 'oldest', benefitState: 'ACTIVE', duplicate: 'true', userId: '9ac3a4d1-0123-4567-8abc-123456789abc', q: 'Hoa', from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00.123Z' })).not.toThrow();
    expect(execute).toHaveBeenCalledTimes(1);
    execute.mockClear();
    for (const q of [{ limit: '0' }, { limit: '101' }, { limit: '1.5' }, { limit: '1e1' }, { sort: 'password_hash' }, { benefitState: 'bogus' }, { benefitState: 'active' }, { userId: 'x' }, { duplicate: 'yes' },
      { from: '2026-10-01T00:00:00Z' }, { to: '2026-10-01T00:00:00Z' }, { from: '2026-10-02T00:00:00Z', to: '2026-10-01T00:00:00Z' }, { from: '2024-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' },
      { from: '2026-02-30T00:00:00Z', to: '2026-03-05T00:00:00Z' }, { q: 'x'.repeat(121) }, { role: 'SYSTEM_ADMIN' }, { cursor: 'x'.repeat(2049) }, { cursor: 'not-a-cursor' }] as Array<Record<string, string>>) {
      expect(() => feedback.list(request, q), JSON.stringify(q)).toThrow(BadRequestException);
    }
    expect(execute).not.toHaveBeenCalled();
    expect(() => feedback.detail(request, 'not-a-uuid')).toThrow(BadRequestException);
  });
});
