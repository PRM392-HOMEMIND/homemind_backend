import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { derivedIdempotencyKey, idempotencyKey } from '../src/common/idempotency';
import { ShoppingController } from '../src/shopping/shopping.controller';

const WS = '5d7ffda4-5a88-44a2-90d7-ba72b709b3fc';
const ITEM = 'b4000000-0000-4000-8000-000000000001';
const KEY = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const req = { userId: 'u1' } as never;

function setup(status: string, linkedProductId: string | null = null) {
  const calls: Array<{ key: string; name: string; payload: Record<string, unknown> }> = [];
  const db = {
    inWorkspace: vi.fn(async (_u: string, _w: string, fn: (tx: unknown) => unknown) =>
      fn({ shoppingItem: { findFirst: async () => ({ id: ITEM, name: 'Muối i-ốt 500g', status, linkedProductId }) } })),
    operation: vi.fn(async (_u: string, _w: string, key: string, name: string, payload: Record<string, unknown>) => {
      calls.push({ key, name, payload });
      if (status === 'skipped') throw new Error('VALIDATION_ERROR');
      return { ok: true, created: { lotIds: status === 'bought' ? [] : ['lot1'], productIds: ['p1'], transactionIds: ['t1'], shoppingItemIds: [ITEM] } };
    }),
  };
  const controller = new ShoppingController({} as never, db as never);
  return { controller, db, calls };
}

describe('POST shopping-items/:id/receive', () => {
  it('cất hàng vào kho rồi đóng món mua sắm', async () => {
    const { controller, calls } = setup('needed', 'prod-1');
    const result = await controller.receive(req, WS, ITEM, KEY, { quantity: 20, unit: ' gói ', expiryDate: '2026-12-31' });

    expect(calls.map((c) => c.name)).toEqual(['shopping.receive']);
    expect(calls[0].payload).toMatchObject({
      itemId: ITEM, quantity: 20, unit: 'gói', expiryDate: '2026-12-31',
    });
    expect(calls).toHaveLength(1);
    expect(result.created).toEqual(expect.objectContaining({ shoppingItemIds: [ITEM], lotIds: ['lot1'] }));
  });

  it('dùng tên người dùng sửa nếu có', async () => {
    const { controller, calls } = setup('needed');
    await controller.receive(req, WS, ITEM, KEY, { quantity: 1, unit: 'kg', productName: 'Cá khô loại 1' });
    expect(calls[0].payload.productName).toBe('Cá khô loại 1');
  });

  it('thử lại sau khi đã nhận thì thành công nhưng KHÔNG cộng kho lần nữa', async () => {
    const { controller, calls } = setup('bought');
    const result = await controller.receive(req, WS, ITEM, KEY, { quantity: 20, unit: 'gói' });
    expect(calls).toHaveLength(1);
    expect(result.created).toEqual(expect.objectContaining({ lotIds: [] }));
    expect(result.ok).toBe(true);
  });

  it('món đã bỏ qua thì từ chối', async () => {
    const { controller } = setup('skipped');
    await expect(controller.receive(req, WS, ITEM, KEY, { quantity: 1, unit: 'kg' })).rejects.toThrow('VALIDATION_ERROR');
  });

  it('thiếu Idempotency-Key thì từ chối', async () => {
    const { controller, calls } = setup('needed');
    await expect(controller.receive(req, WS, ITEM, undefined, { quantity: 1, unit: 'kg' })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('bước hai dùng key dẫn xuất ổn định và hợp lệ', () => {
    const derived = derivedIdempotencyKey(KEY, 'bought');
    expect(() => idempotencyKey(derived)).not.toThrow();
    expect(derivedIdempotencyKey(KEY, 'bought')).toBe(derived);
    expect(derived).not.toBe(KEY);
  });
});
