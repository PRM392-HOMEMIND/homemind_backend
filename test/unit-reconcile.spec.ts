import { describe, expect, it } from 'vitest';
import { reconcileUnits } from '../src/assistant/unit-reconcile';

const catalog = [
  { id: 'p-sc', name: 'sữa chua', unit: 'hộp' },
  { id: 'p-sa', name: 'sả', unit: null },
];
const add = (args: Record<string, unknown>) => ({ toolId: 'inventory.add' as const, arguments: args });

describe('reconcileUnits', () => {
  it('đơn vị khác đơn vị của sản phẩm: dùng đơn vị sản phẩm, bỏ số lượng, cảnh báo', () => {
    const r = reconcileUnits(add({ items: [{ productName: 'sữa chua', productCandidateId: 'p-sc', quantity: 2, unit: 'lốc' }] }), catalog);
    const item = (r.arguments.items as Array<Record<string, unknown>>)[0];
    expect(item).toMatchObject({ unit: 'hộp', quantity: null });
    expect(String((item.warnings as string[])[0])).toContain('"hộp"');
  });
  it('đơn vị cùng loại thì tự quy đổi: 500 gram -> 0.5 kg, 250 ml -> 0.25 lít, 2 lạng -> 0.2 kg', () => {
    const cat = [{ id: 'p-thit', name: 'thịt bò', unit: 'kg' }, { id: 'p-nm', name: 'nước mắm', unit: 'lít' }];
    expect(reconcileUnits(add({ productName: 'thịt bò', quantity: 500, unit: 'gram' }), cat).arguments).toMatchObject({ unit: 'kg', quantity: 0.5 });
    expect(reconcileUnits(add({ productName: 'nước mắm', quantity: 250, unit: 'ml' }), cat).arguments).toMatchObject({ unit: 'lít', quantity: 0.25 });
    expect(reconcileUnits(add({ productName: 'thịt bò', quantity: 2, unit: 'lạng' }), cat).arguments).toMatchObject({ unit: 'kg', quantity: 0.2 });
    // Khác loại (khối lượng vs thể tích) thì không đổi, vẫn cảnh báo.
    expect(reconcileUnits(add({ productName: 'thịt bò', quantity: 1, unit: 'lít' }), cat).arguments).toMatchObject({ unit: 'kg', quantity: null });
  });
  it('thiếu đơn vị: điền sẵn đơn vị sản phẩm và giữ số lượng', () => {
    const r = reconcileUnits(add({ productName: 'Sữa chua', quantity: 3, unit: null }), catalog);
    expect(r.arguments).toMatchObject({ unit: 'hộp', quantity: 3 });
  });
  it('cùng đơn vị (không phân biệt hoa thường) thì giữ nguyên', () => {
    const args = { productName: 'sữa chua', productCandidateId: 'p-sc', quantity: 2, unit: 'Hộp' };
    expect(reconcileUnits(add(args), catalog).arguments).toEqual(args);
  });
  it('sản phẩm mới hoặc chưa có đơn vị, và tool khác: không đụng tới', () => {
    const args = { productName: 'bánh quy', quantity: 5, unit: 'gói' };
    expect(reconcileUnits(add(args), catalog).arguments).toEqual(args);
    expect(reconcileUnits(add({ productName: 'sả', unit: 'kg', quantity: 1 }), catalog).arguments).toMatchObject({ unit: 'kg' });
    const other = { toolId: 'shopping.add' as const, arguments: { name: 'x', unit: 'lốc' } };
    expect(reconcileUnits(other, catalog)).toEqual(other);
  });
});
