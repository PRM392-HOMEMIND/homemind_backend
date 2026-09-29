import { describe, expect, it } from 'vitest';
import { validatePlan } from '../src/assistant/planner';

const add = { toolId: 'inventory.add', arguments: { items: [{ productName: 'sữa' }] } };
const out = { toolId: 'inventory.mark_out', arguments: { productId: 'p', quantity: null } };
const buy = { toolId: 'shopping.add', arguments: { items: [{ name: 'dầu ăn' }] } };

describe('planner: nhiều việc ghi trong một câu', () => {
  it('giữ việc đầu và các việc còn lại đã được kiểm tra', () => {
    const plan = validatePlan({ ...add, moreActions: [out, buy] });
    expect(plan.toolId).toBe('inventory.add');
    expect(plan.more?.map((m) => m.toolId)).toEqual(['inventory.mark_out', 'shopping.add']);
  });

  it('mỗi việc phụ vẫn bị kiểm tra như việc thường', () => {
    expect(() => validatePlan({ ...add, moreActions: [{ toolId: 'inventory.add', arguments: { items: [{ productName: 'x', priceVnd: -1 }] } }] })).toThrow('AI_INVALID_SCHEMA');
    expect(() => validatePlan({ ...add, moreActions: ['x'] })).toThrow('AI_INVALID_SCHEMA');
  });

  it('vừa hỏi vừa ghi, hoặc quá 4 việc phụ thì hỏi lại (không ghi nửa vời)', () => {
    const read = { toolId: 'inventory.list', arguments: {} };
    expect(validatePlan({ ...add, moreActions: [read] }).toolId).toBe('clarify');
    expect(validatePlan({ ...read, moreActions: [add] }).toolId).toBe('clarify');
    expect(validatePlan({ ...add, moreActions: [out, out, out, out, out] }).toolId).toBe('clarify');
  });

  it('việc phụ là clarify/unknown thì bỏ qua; việc phụ không lồng thêm việc nữa', () => {
    expect(validatePlan({ ...add, moreActions: [{ toolId: 'unknown', arguments: {} }] }).more).toBeUndefined();
    const nested = validatePlan({ ...add, moreActions: [{ ...buy, moreActions: [out] }] });
    expect(nested.more?.[0].more).toBeUndefined();
  });

  it('không có moreActions thì giữ nguyên hành vi một việc', () => {
    expect(validatePlan(add).more).toBeUndefined();
  });
});
