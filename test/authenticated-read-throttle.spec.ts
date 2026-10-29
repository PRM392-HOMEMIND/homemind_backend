import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { AuthenticatedReadThrottleGuard } from '../src/common/authenticated-read-throttle.guard';
class ExposedGuard extends AuthenticatedReadThrottleGuard {
  tracker(request: Record<string, unknown>) { return this.getTracker(request); }
}
describe('authenticated hub read budgets', () => {
  const guard = () => new ExposedGuard([], new ThrottlerStorageService(), new Reflector());
  it('requires the verified identity rather than trusting network/header claims', async () => {
    const g = guard(), userId = '00000000-0000-4000-8000-000000000001';
    await expect(g.tracker({userId,ip:'shared',headers:{'x-user-id':'attacker'}})).resolves.toBe(userId);
    await expect(g.tracker({ip:'shared',headers:{'x-user-id':userId}})).rejects.toThrow();
    await expect(g.tracker({userId:''})).rejects.toThrow();
  });
  it('keeps accounts independent on one NAT without changing the limits', async () => {
    const g=guard();
    expect(await g.tracker({ip:'shared',userId:'00000000-0000-4000-8000-000000000001'}))
      .not.toEqual(await g.tracker({ip:'shared',userId:'00000000-0000-4000-8000-000000000002'}));
  });
});
