import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { PlanGuard, PlanLimitException } from '../src/billing/plan-guard.service';
import { ApiErrorFilter } from '../src/common/api-error.filter';
import { AssistantService } from '../src/assistant/assistant.service';
import { buildSnapshot, Raw } from '../src/snapshot/snapshot.compute';

const WS = '5d7ffda4-5a88-44a2-90d7-ba72b709b3fc';

function raw(count: number, plan: Raw['plan']): Raw {
  return {
    member: true,
    products: Array.from({ length: count }, (_, i) => ({ id: `p${i}`, name: i === 0 ? 'Sữa Chua' : `Món ${i}`, category: null, unit: 'cái', status: 'in_stock' })),
    lots: [], shopping: [], counts: {}, reads: [], plan,
  };
}

const guardFor = (r: Raw) => new PlanGuard({ get: async () => buildSnapshot(r) } as never);

describe('PlanGuard: chặn cứng khi đủ hạn mức', () => {
  const full = raw(30, { plan: 'free', limit: 30 });

  it('món MỚI thứ 31 của gói Miễn phí bị chặn (402 PLAN_LIMIT)', async () => {
    const error = await guardFor(full).assertCanAddProduct('u', WS, { productName: 'Thịt bò' }).catch((e) => e);
    expect(error).toBeInstanceOf(PlanLimitException);
    expect(error.getStatus()).toBe(402);
    expect(error.getResponse()).toMatchObject({
      code: 'PLAN_LIMIT', details: { plan: 'free', limit: 30, count: 30 },
      message: 'Gói Miễn phí đã đủ 30 sản phẩm. Hãy nâng cấp để thêm món mới.',
    });
  });

  it('còn chỗ (29/30) thì cho thêm', async () => {
    await expect(guardFor(raw(29, { plan: 'free', limit: 30 })).assertCanAddProduct('u', WS, { productName: 'Thịt bò' })).resolves.toBeUndefined();
  });

  it('nhập thêm lô cho sản phẩm ĐÃ CÓ vẫn được (khớp tên không phân biệt hoa thường/khoảng trắng)', async () => {
    await expect(guardFor(full).assertCanAddProduct('u', WS, { productName: '  sữa chua ' })).resolves.toBeUndefined();
  });

  it('nhập thêm cho sản phẩm đã có theo productCandidateId', async () => {
    await expect(guardFor(full).assertCanAddProduct('u', WS, { productName: 'Tên khác', productCandidateId: 'p7' })).resolves.toBeUndefined();
  });

  it('gói không giới hạn (limit rỗng) không bao giờ bị chặn', async () => {
    await expect(guardFor(raw(500, { plan: 'personal', limit: null })).assertCanAddProduct('u', WS, { productName: 'Mới' })).resolves.toBeUndefined();
  });

  it('Micro-POS đủ 500 mặt hàng: chặn nhưng thông điệp khác (không mời mua gói Miễn phí)', async () => {
    const error = await guardFor(raw(500, { plan: 'micro_pos', limit: 500 })).assertCanAddProduct('u', WS, { productName: 'Mới' }).catch((e) => e);
    expect(error.getResponse()).toMatchObject({ code: 'PLAN_LIMIT', details: { plan: 'micro_pos', limit: 500 } });
    expect(error.getResponse().message).toContain('liên hệ');
  });

  it('chưa có dòng gói thì mặc định 30', async () => {
    const error = await guardFor(raw(30, null)).assertCanAddProduct('u', WS, { productName: 'Mới' }).catch((e) => e);
    expect(error).toBeInstanceOf(PlanLimitException);
  });
});

describe('ApiErrorFilter: trả mã PLAN_LIMIT cùng chi tiết cho app', () => {
  it('HTTP 402 với error.code, message và details', () => {
    const json = vi.fn();
    const response = { status: vi.fn(() => ({ json })) };
    const host = { switchToHttp: () => ({ getResponse: () => response }) };
    new ApiErrorFilter().catch(new PlanLimitException('free', 30, 30), host as never);
    expect(response.status).toHaveBeenCalledWith(402);
    expect(json).toHaveBeenCalledWith({
      error: { code: 'PLAN_LIMIT', message: 'Gói Miễn phí đã đủ 30 sản phẩm. Hãy nâng cấp để thêm món mới.', details: { plan: 'free', limit: 30, count: 30 } },
    });
  });
});

describe('AssistantService.confirm: chặn trước khi ghi', () => {
  const body = (toolId: string, args: Record<string, unknown>) => ({
    workspaceId: WS, idempotencyKey: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', tools: [{ toolId, arguments: args }],
  });
  function setup(blocked: boolean) {
    const db = { operation: vi.fn(async () => ({ ok: true })) };
    const guard = { assertCanAddProduct: vi.fn(async () => { if (blocked) throw new PlanLimitException('free', 30, 30); }) };
    const service = new AssistantService(db as never, {} as never, {} as never, {} as never, {} as never, {} as never, guard as never);
    return { service, db, guard };
  }

  it('inventory.add vượt hạn mức: không gọi ghi', async () => {
    const { service, db } = setup(true);
    await expect(service.confirm('u', 't1', body('inventory.add', { productName: 'Bia', quantity: 1, unit: 'lon' }) as never)).rejects.toBeInstanceOf(PlanLimitException);
    expect(db.operation).not.toHaveBeenCalled();
  });

  it('inventory.add còn chỗ: kiểm tra đúng tên rồi mới ghi', async () => {
    const { service, db, guard } = setup(false);
    await service.confirm('u', 't1', body('inventory.add', { productName: 'Bia', productCandidateId: 'p1' }) as never);
    expect(guard.assertCanAddProduct).toHaveBeenCalledWith('u', WS, { productName: 'Bia', productCandidateId: 'p1' });
    expect(db.operation).toHaveBeenCalledTimes(1);
  });

  it('thao tác khác (đánh hết, thêm vào danh sách mua) không bị kiểm tra hạn mức', async () => {
    const { service, db, guard } = setup(true);
    await service.confirm('u', 't1', body('shopping.add', { name: 'Trứng' }) as never);
    await service.confirm('u', 't2', body('inventory.mark_out', { productId: 'p1' }) as never);
    expect(guard.assertCanAddProduct).not.toHaveBeenCalled();
    expect(db.operation).toHaveBeenCalledTimes(2);
  });
});
