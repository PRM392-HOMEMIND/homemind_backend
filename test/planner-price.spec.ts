import { describe, expect, it } from 'vitest';
import { validatePlan } from '../src/assistant/planner';

const add = (args: Record<string, unknown>) => validatePlan({ toolId: 'inventory.add', arguments: args });

describe('planner: giá mua và nơi cất (tùy chọn)', () => {
  it('nhận giá và nơi cất ở một món và ở từng món trong items', () => {
    expect(add({ productName: 'sữa', quantity: 1, unit: 'hộp', priceVnd: 45000, storageLocation: 'Tủ lạnh' }).toolId).toBe('inventory.add');
    const batch = add({ items: [
      { productName: 'a', priceVnd: 0, storageLocation: null },
      { productName: 'b', priceVnd: null },
    ] });
    expect(batch.toolId).toBe('inventory.add');
  });

  it.each([-1, 1.5, '45000', 100_000_000_001, Number.NaN])('từ chối giá không hợp lệ %s', (priceVnd) => {
    expect(() => add({ productName: 'x', priceVnd })).toThrow('AI_INVALID_SCHEMA');
    expect(() => add({ items: [{ productName: 'x', priceVnd }] })).toThrow('AI_INVALID_SCHEMA');
  });

  it('từ chối nơi cất quá dài hoặc sai kiểu', () => {
    expect(() => add({ productName: 'x', storageLocation: 'x'.repeat(61) })).toThrow('AI_INVALID_SCHEMA');
    expect(() => add({ items: [{ productName: 'x', storageLocation: 5 }] })).toThrow('AI_INVALID_SCHEMA');
  });

  it('tool khác (vd. shopping.add) bị bỏ hai trường này thay vì báo lỗi', () => {
    const plan = validatePlan({ toolId: 'shopping.add', arguments: { name: 'dầu ăn', priceVnd: 50000, storageLocation: 'Kệ' } });
    expect(plan.arguments).toEqual({ name: 'dầu ăn' });
    const batch = validatePlan({ toolId: 'shopping.add', arguments: { items: [{ name: 'a', priceVnd: 1 }] } });
    expect(batch.arguments).toEqual({ items: [{ name: 'a' }] });
  });

  it('mark_out nhận remainingQuantity không âm; spending.month nhận tháng đúng định dạng', () => {
    expect(validatePlan({ toolId: 'inventory.mark_out', arguments: { productId: 'p', remainingQuantity: 0.5 } }).toolId).toBe('inventory.mark_out');
    expect(() => validatePlan({ toolId: 'inventory.mark_out', arguments: { productId: 'p', remainingQuantity: -1 } })).toThrow('AI_INVALID_SCHEMA');
    expect(validatePlan({ toolId: 'spending.month', arguments: { month: '2026-10' } }).toolId).toBe('spending.month');
    expect(validatePlan({ toolId: 'spending.month', arguments: {} }).toolId).toBe('spending.month');
    expect(() => validatePlan({ toolId: 'spending.month', arguments: { month: '2026-13' } })).toThrow('AI_INVALID_SCHEMA');
    expect(() => validatePlan({ toolId: 'spending.month', arguments: { month: '0000-01' } })).toThrow('AI_INVALID_SCHEMA');
  });
});
