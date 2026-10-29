import { describe, expect, it } from 'vitest';
import { dateRange, expiryLevel } from '../src/common/date';
import { buildPlannerPrompt, PLAN_RESPONSE_SCHEMA, validatePlan } from '../src/assistant/planner';

describe('ngày và mức hạn dùng', () => {
  it('phân loại đúng quanh ngày hiện tại', () => {
    expect(expiryLevel(new Date('2026-09-29T00:00:00Z'), '2026-09-30')).toBe('expired');
    expect(expiryLevel(new Date('2026-09-30T00:00:00Z'), '2026-09-30')).toBe('urgent');
    expect(expiryLevel(new Date('2026-10-05T00:00:00Z'), '2026-09-30')).toBe('soon');
    expect(expiryLevel(null, '2026-09-30')).toBe('ok');
  });
  it('tính biên tháng và tuần', () => {
    expect(dateRange('this_month', '2026-09-30')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(dateRange('this_week', '2026-09-30')).toEqual({ from: '2026-09-28', to: '2026-10-04' });
  });
});

describe('allowlist của AI', () => {
  it('gửi schema tham số và quy ước khoảng ngày cho planner', () => {
    const prompt = buildPlannerPrompt('Hôm nay có món nào sắp hết hạn?', [], '2026-10-01');
    expect(prompt).toContain('"toolId":"inventory.expiring"');
    expect(prompt).toContain('"name":"range"');
    // "Sắp hết hạn" dùng cùng ngưỡng 30 ngày với Tủ đồ/Trang chủ; chỉ "gấp/7 ngày" mới là 7 ngày.
    expect(prompt).toContain('"sắp hết hạn", "cận date", "sắp quá hạn" => next_30_days');
    expect(prompt).toContain('"hôm nay", "7 ngày tới", "gấp", "sắp hỏng ngay" => next_7_days');
    expect(PLAN_RESPONSE_SCHEMA.required).toEqual(['toolId', 'arguments']);
  });

  it('từ chối SQL và tool ngoài phạm vi', () => {
    expect(() => validatePlan({ toolId: 'sql.execute', arguments: { sql: 'delete' } })).toThrow();
    expect(() => validatePlan({ toolId: 'inventory.add', arguments: { productName: 'Sữa', sql: 'delete' } })).toThrow();
    expect(() => validatePlan({ toolId: 'shopping.add', arguments: { name: 'Trứng', source: 'voice' } })).toThrow();
    expect(() => validatePlan({ toolId: 'inventory.expiring', arguments: { range: 'custom' } })).toThrow();
  });
  it('hỏi lại khi thiếu tên và giữ số lượng chưa biết', () => {
    expect(validatePlan({ toolId: 'inventory.add', arguments: { quantity: null, unit: null } }).toolId).toBe('clarify');
    expect(validatePlan({ toolId: 'inventory.add', arguments: { productName: 'Sữa', quantity: null, unit: null } }).arguments.quantity).toBeNull();
  });
  it('nhận inventory.add nhiều món trong một câu', () => {
    const items = [{ productName: 'Sữa rửa mặt', quantity: null, unit: null, expiryDate: '2027-09-01' }, { productName: 'Toner', quantity: 2, unit: 'chai', expiryDate: '2029-01-01' }];
    const plan = validatePlan({ toolId: 'inventory.add', arguments: { items } });
    expect(plan.toolId).toBe('inventory.add');
    expect((plan.arguments.items as unknown[]).length).toBe(2);
  });
  it('từ chối items sai: key lạ, ngày sai, quá 20, tên rỗng thì hỏi lại', () => {
    expect(() => validatePlan({ toolId: 'inventory.add', arguments: { items: [{ productName: 'A', sql: 'x' }] } })).toThrow();
    expect(() => validatePlan({ toolId: 'inventory.add', arguments: { items: [{ productName: 'A', expiryDate: '2027-02-31' }] } })).toThrow();
    expect(() => validatePlan({ toolId: 'inventory.add', arguments: { items: Array.from({ length: 21 }, () => ({ productName: 'A' })) } })).toThrow();
    expect(validatePlan({ toolId: 'inventory.add', arguments: { items: [{ productName: '  ' }] } }).toolId).toBe('clarify');
  });
  it('hỏi lại với kế hoạch nhiều tool', () => {
    expect(validatePlan([{ toolId: 'inventory.add', arguments: {} }, { toolId: 'shopping.add', arguments: {} }]).toolId).toBe('clarify');
  });
});
