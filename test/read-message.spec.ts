import { describe, expect, it } from 'vitest';
import { buildReadMessage } from '../src/assistant/read-message';
import { matchesCategoryTerm } from '../src/assistant/product-groups';

const TODAY = '2026-10-12';
const item = (name: string, quantity: number, unit: string, expiryDate: string | null, status = 'in_stock') => ({ name, quantity, unit, expiryDate, status });

describe('câu trả lời cho câu hỏi đọc dữ liệu', () => {
  it('còn trứng không: nêu số lượng và hạn còn lại', () => {
    const msg = buildReadMessage('inventory.list', { query: 'trứng' }, { items: [item('trứng gà', 10, 'quả', '2026-10-17')], total: 1 }, TODAY);
    expect(msg).toBe('Còn 1 món: trứng gà (10 quả, hạn 17/10/2026 (còn 5 ngày)).');
  });
  it('không thấy món: nói rõ, không "0 sản phẩm phù hợp"', () => {
    expect(buildReadMessage('inventory.list', { query: 'cà chua' }, { items: [], total: 0 }, TODAY)).toBe('Không thấy "cà chua" trong kho.');
    expect(buildReadMessage('inventory.list', { status: 'out' }, { items: [], total: 0 }, TODAY)).toBe('Hiện không có món nào đã hết.');
  });
  it('liệt kê tối đa 6 món rồi "và N món khác"', () => {
    const items = Array.from({ length: 9 }, (_, i) => item(`m${i}`, 1, 'cái', null));
    const msg = buildReadMessage('inventory.list', {}, { items, total: 9 }, TODAY);
    expect(msg).toContain('Trong kho có 9 món: m0 (1 cái); m1 (1 cái)');
    expect(msg).toContain('và 3 món khác');
  });
  it('sắp hết hạn: tên, hạn, còn bao nhiêu ngày; quá hạn: nói số ngày đã quá', () => {
    const exp = buildReadMessage('inventory.expiring', { range: 'next_30_days' }, { range: 'next_30_days', items: [item('cá hồi', 0.6, 'kg', '2026-10-13')] }, TODAY);
    expect(exp).toBe('Có 1 lô sắp hết hạn: cá hồi (0.6 kg), hạn 13/10/2026 – còn 1 ngày.');
    const old = buildReadMessage('inventory.expiring', { range: 'expired' }, { range: 'expired', items: [item('thịt bò', 0.5, 'kg', '2026-10-11')] }, TODAY);
    expect(old).toContain('quá hạn 1 ngày');
    expect(buildReadMessage('inventory.expiring', { range: 'expired' }, { range: 'expired', items: [] }, TODAY)).toBe('Chưa có món nào quá hạn.');
  });
  it('lẫn món quá hạn trong câu hỏi "sắp hết hạn": phần mở đầu nói đúng', () => {
    const msg = buildReadMessage('inventory.expiring', { range: 'next_30_days' }, { range: 'next_30_days', items: [item('thịt bò', 0.5, 'kg', '2026-10-11'), item('cá hồi', 0.6, 'kg', '2026-10-13')] }, TODAY);
    expect(msg.startsWith('Có 2 lô sắp hoặc đã quá hạn: thịt bò')).toBe(true);
  });
  it('danh sách cần mua và tóm tắt', () => {
    expect(buildReadMessage('shopping.list', {}, { items: [{ name: 'sả' }, { name: 'bia', quantity: 5, unit: 'thùng' }], total: 2 }, TODAY)).toBe('Có 2 món cần mua: sả; bia (5 thùng).');
    expect(buildReadMessage('shopping.list', {}, { items: [], total: 0 }, TODAY)).toBe('Danh sách cần mua đang trống.');
    expect(buildReadMessage('home.summary', {}, { totalProducts: 12, expiringSoonCount: 3, expiredCount: 1, outCount: 0, shoppingNeededCount: 4 }, TODAY))
      .toBe('Kho có 12 sản phẩm, 3 sắp hết hạn, 1 đã quá hạn, 4 món cần mua.');
  });
});

describe('lọc theo nhóm cho câu hỏi "có đồ uống nào không"', () => {
  it('nhận sản phẩm chưa có danh mục theo tên', () => {
    expect(matchesCategoryTerm({ name: 'bia Tiger' }, 'đồ uống')).toBe(true);
    expect(matchesCategoryTerm({ name: 'nước ngọt' }, 'đồ uống')).toBe(true);
    expect(matchesCategoryTerm({ name: 'gạo' }, 'đồ uống')).toBe(false);
    expect(matchesCategoryTerm({ name: 'nước mắm', category: 'Gia vị' }, 'gia vị')).toBe(true);
    expect(matchesCategoryTerm({ name: 'son dưỡng' }, 'mỹ phẩm')).toBe(true);
    expect(matchesCategoryTerm({ name: 'đường cát' }, 'gia vị')).toBe(true);
  });
});
