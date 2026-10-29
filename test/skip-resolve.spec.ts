import { describe, expect, it } from 'vitest';
import { resolveSkip } from '../src/assistant/skip-resolve';

const needed = [{ id: 'i-ot', name: 'ớt' }, { id: 'i-otc', name: 'ớt chuông' }, { id: 'i-sa', name: 'Sả' }, { id: 'i-chanh', name: 'chanh' }];
const skip = (args: Record<string, unknown>) => ({ toolId: 'shopping.skip' as const, arguments: args });

describe('resolveSkip', () => {
  it('khớp đúng tên (không phân biệt hoa thường/dấu) và trả itemId', () => {
    const r = resolveSkip(skip({ names: ['sa', 'Chanh'] }), needed);
    expect(r.toolId).toBe('shopping.skip');
    expect(r.arguments.items).toEqual([{ itemId: 'i-sa', name: 'Sả' }, { itemId: 'i-chanh', name: 'chanh' }]);
  });
  it('ưu tiên khớp đúng: "ớt" không kéo theo "ớt chuông"', () => {
    expect(resolveSkip(skip({ name: 'ớt' }), needed).arguments.items).toEqual([{ itemId: 'i-ot', name: 'ớt' }]);
  });
  it('nhiều món gần giống mà không có khớp đúng thì hỏi lại, không đoán', () => {
    const r = resolveSkip(skip({ name: 'chuông' }), [{ id: 'a', name: 'ớt chuông đỏ' }, { id: 'b', name: 'ớt chuông xanh' }]);
    expect(r.toolId).toBe('clarify');
    expect(String(r.arguments.question)).toContain('ớt chuông đỏ');
  });
  it('món không có trong danh sách: báo rõ; một phần khớp thì cảnh báo phần còn lại', () => {
    const none = resolveSkip(skip({ name: 'cà chua' }), needed);
    expect(none).toMatchObject({ toolId: 'clarify' });
    expect(String(none.arguments.question)).toContain('cà chua');
    const some = resolveSkip(skip({ names: ['sả', 'cà chua'] }), needed);
    expect(some.toolId).toBe('shopping.skip');
    expect((some.arguments.warnings as string[])[0]).toContain('cà chua');
  });
  it('tool khác giữ nguyên', () => {
    const other = { toolId: 'shopping.add' as const, arguments: { name: 'x' } };
    expect(resolveSkip(other, needed)).toBe(other);
  });
});
