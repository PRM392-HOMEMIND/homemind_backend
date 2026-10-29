import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as policy from '../src/billing/billing-distribution';
import { UpgradeController } from '../src/billing/upgrade.controller';
import { buildSnapshot, Raw, withRequestedPlan } from '../src/snapshot/snapshot.compute';

const WS = '5d7ffda4-5a88-44a2-90d7-ba72b709b3fc';
const req = { userId: 'u1', headers: { 'x-homemind-distribution': 'direct' } } as never;

const raw = (over: Partial<Raw> = {}): Raw => ({
  member: true, products: [], lots: [], shopping: [], counts: {}, reads: [], plan: { plan: 'free', limit: 30 }, ...over,
});

function setup(plan = 'free', insertedRows = 1) {
  const snapshot = buildSnapshot(raw({ plan: { plan, limit: 30 } }));
  const snapshots = {
    get: vi.fn(async () => snapshot),
    markUpgradeRequested: vi.fn(),
  };
  const inserts: unknown[][] = [];
  const db = {
    $executeRaw: vi.fn(async (...args: unknown[]) => { inserts.push(args); return insertedRows; }),
    asUser: vi.fn(async (_user: string, fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { controller: new UpgradeController(db as never, snapshots as never), snapshots, db, inserts };
}

describe('POST upgrade-requests', () => {
  it.each([{}, { 'x-homemind-distribution': 'store' }, { 'x-homemind-distribution': 'direct' }])('consumption-only client is blocked before snapshot or write: %j', async headers => {
    const { controller, snapshots, db } = setup();
    await expect(controller.request({ userId: 'u1', headers } as never, WS, { plan: 'personal', source: 'paywall' })).rejects.toThrow('Consumption-only client.');
    expect(snapshots.get).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(snapshots.markUpgradeRequested).not.toHaveBeenCalled();
  });

  // Preserve inactive handler invariants in a unit-only context. The real
  // all-channel gate above and HTTP tests run without this mock.
  describe('inactive legacy handler invariants (not a public payment bypass)', () => {
    beforeEach(() => { vi.spyOn(policy, 'requireExternalBilling').mockImplementation(() => {}); });
    afterEach(() => vi.restoreAllMocks());
  it('ghi nhận yêu cầu lần đầu và cập nhật cache', async () => {
    const { controller, snapshots } = setup('free', 1);
    const result = await controller.request(req, WS, { plan: 'personal', source: 'home_card' });
    expect(result).toEqual({ ok: true, plan: 'personal', alreadyRequested: false });
    expect(snapshots.markUpgradeRequested).toHaveBeenCalledWith('u1', WS, 'personal');
  });

  it('gửi lại cùng gói là an toàn: alreadyRequested = true', async () => {
    const { controller } = setup('free', 0);
    const result = await controller.request(req, WS, { plan: 'family', source: 'paywall' });
    expect(result.alreadyRequested).toBe(true);
    expect(result.ok).toBe(true);
  });

  it('không cho nâng cấp lên chính gói đang dùng', async () => {
    const { controller, db } = setup('micro_pos');
    await expect(controller.request(req, WS, { plan: 'micro_pos', source: 'home_card' })).rejects.toThrow('Bạn đang dùng gói này rồi.');
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it('người không phải thành viên bị chặn trước khi ghi', async () => {
    const { controller, snapshots, db } = setup();
    snapshots.get.mockRejectedValueOnce(new Error('FORBIDDEN'));
    await expect(controller.request(req, WS, { plan: 'personal', source: 'x' })).rejects.toThrow('FORBIDDEN');
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });
  });
});

describe('requestedPlans trong tổng quan', () => {
  it('có trong home và được thêm tại chỗ không trùng', () => {
    const snap = buildSnapshot(raw({ requested: ['personal'] }));
    expect(snap.home.requestedPlans).toEqual(['personal']);
    const after = withRequestedPlan(withRequestedPlan(snap, 'family'), 'family');
    expect(after.home.requestedPlans).toEqual(['personal', 'family']);
    expect(snap.home.requestedPlans).toEqual(['personal']); // bất biến
  });

  it('mặc định rỗng khi chưa yêu cầu', () => {
    expect(buildSnapshot(raw()).home.requestedPlans).toEqual([]);
  });
});
