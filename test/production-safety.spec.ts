import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { environment } from '../src/config/env';
import { ResetDeliveryService } from '../src/auth/reset-delivery.service';
import { HealthController } from '../src/health/health.controller';
import { UpgradeController } from '../src/billing/upgrade.controller';

function production() {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('DATABASE_URL', 'postgresql://placeholder:placeholder@invalid/homemind');
  for (const key of ['AUTH_ACCESS_SECRET', 'AUTH_REFRESH_SECRET', 'AUTH_RESET_SECRET']) vi.stubEnv(key, randomBytes(32).toString('hex'));
  vi.stubEnv('AUTH_DEV_RESET_DELIVERY', 'false');
  vi.stubEnv('AUTH_REQUIRE_VERIFICATION', 'false');
  vi.stubEnv('BILLING_ORDER_NAMESPACE', '2');
}
afterEach(() => vi.unstubAllEnvs());
describe('production safety', () => {
  it('refuses to start with development password-reset disclosure', () => {
    production(); vi.stubEnv('AUTH_DEV_RESET_DELIVERY', 'true');
    expect(() => environment()).toThrow('production');
  });
  it('does not return a reset token in production', async () => {
    production();
    expect(await new ResetDeliveryService().deliver('owner@example.com', randomBytes(48).toString('hex'))).toEqual({});
  });
  it('does not publish the unfinished upgrade flow in production', async () => {
    production();
    const db = { asUser: vi.fn() }, snapshots = { get: vi.fn() };
    await expect(new UpgradeController(db as never, snapshots as never).request({ userId: 'test', headers: { 'x-homemind-distribution': 'direct' } } as never, 'test', { plan: 'personal', source: 'test' })).rejects.toMatchObject({status:403,response:{code:'BILLING_DISTRIBUTION_DISABLED'}});
    expect(snapshots.get).not.toHaveBeenCalled();
    expect(db.asUser).not.toHaveBeenCalled();
  });
  it('liveness does not query the database or an AI provider', () => {
    production(); const query = vi.fn(), setHeader = vi.fn();
    expect(new HealthController({ $transaction: query } as never).live({ setHeader } as never)).toEqual({ status: 'live' });
    expect(query).not.toHaveBeenCalled();
  });
  it('returns unavailable when the database or runtime role is unsafe', async () => {
    production();
    for (const transaction of [vi.fn().mockRejectedValue(new Error('secret database error')), vi.fn().mockResolvedValue([{ safe: false }])]) {
      await expect(new HealthController({ $transaction: transaction } as never).ready({ setHeader: vi.fn() } as never)).rejects.toThrow('Service unavailable');
    }
  });
});
