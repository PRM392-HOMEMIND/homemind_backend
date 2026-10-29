import { describe, expect, it } from 'vitest';
import { normalizeVi, phoneticNormalize, stripClearanceKeywords } from '../src/assistant/vi-phonetic';
import { canonicalizeNames } from '../src/assistant/name-canonical';
import { bestMatch, matchScore, rankCandidates } from '../src/assistant/product-match';
import { resolveSkip } from '../src/assistant/skip-resolve';

describe('so khớp theo âm', () => {
  it('gộp s/x và ch/tr ở đầu từ, không gộp d/gi/r', () => {
    expect(phoneticNormalize('xả')).toBe(phoneticNormalize('sả'));
    expect(phoneticNormalize('chứng gà')).toBe(phoneticNormalize('trứng gà'));
    expect(phoneticNormalize('rau')).not.toBe(phoneticNormalize('dầu'));
    expect(phoneticNormalize('mì xào')).toBe('mi sao');
  });
  it('"xả kho/xả hàng" là từ khoá bán hết, còn "xả" một mình là tên món', () => {
    expect(stripClearanceKeywords('xả kho hết bia')).toBe('het bia');
    expect(stripClearanceKeywords('hết xả rồi')).toBe('het xa roi');
    expect(normalizeVi('Sả')).toBe('sa');
  });
});

describe('khớp tên sản phẩm khi nghe nhầm', () => {
  const catalog = [
    { id: 'sa', name: 'sả' }, { id: 'trung', name: 'trứng gà' }, { id: 'bia', name: 'bia Tiger' },
    { id: 'dau', name: 'dầu ăn' }, { id: 'rau', name: 'rau muống' },
  ];
  it('"hết xả" khớp "sả" và "hết chứng" khớp "trứng gà"', () => {
    expect(bestMatch('hết xả rồi', catalog)?.id).toBe('sa');
    expect(bestMatch('hết chứng rồi', catalog)?.id).toBe('trung');
    expect(rankCandidates('nhớ mua xả', catalog, 1)[0].id).toBe('sa');
  });
  it('khớp chữ chính xác luôn điểm cao hơn khớp theo âm', () => {
    expect(matchScore('sả', 'sả')).toBeGreaterThan(matchScore('xả', 'sả'));
  });
  it('"xả kho bia" vẫn khớp bia, không kéo theo sả', () => {
    expect(bestMatch('xả kho hết bia', catalog)?.id).toBe('bia');
    expect(matchScore('xả kho hết bia', 'sả')).toBe(0);
  });
  it('rau và dầu không bị nhầm với nhau', () => {
    expect(bestMatch('hết rau muống', catalog)?.id).toBe('rau');
    expect(bestMatch('hết dầu ăn', catalog)?.id).toBe('dau');
  });
});

describe('canonicalizeNames', () => {
  const known = ['sả', 'trứng gà', 'chanh'];
  const shop = (args: Record<string, unknown>) => ({ toolId: 'shopping.add' as const, arguments: args });
  it('đổi "xả" về "sả" đã có và cảnh báo', () => {
    const r = canonicalizeNames(shop({ name: 'xả' }), known);
    expect(r.arguments.name).toBe('sả');
    expect(String((r.arguments.warnings as string[])[0])).toContain('Mình nghe là "xả"');
  });
  it('nhiều món, chỉ sửa món nghe nhầm', () => {
    const r = canonicalizeNames(shop({ items: [{ name: 'chứng gà' }, { name: 'chanh' }, { name: 'bia' }] }), known);
    expect((r.arguments.items as Array<{ name: string }>).map((i) => i.name)).toEqual(['trứng gà', 'chanh', 'bia']);
  });
  it('không đổi khi trùng tên chính xác, khi không có món cùng âm, hoặc khi mơ hồ', () => {
    expect(canonicalizeNames(shop({ name: 'sả' }), known).arguments).toEqual({ name: 'sả' });
    expect(canonicalizeNames(shop({ name: 'cà chua' }), known).arguments).toEqual({ name: 'cà chua' });
    expect(canonicalizeNames(shop({ name: 'xả' }), ['sả', 'Xả']).arguments).toEqual({ name: 'xả' });
  });
  it('inventory.add dùng trường productName; tool khác giữ nguyên', () => {
    const r = canonicalizeNames({ toolId: 'inventory.add', arguments: { productName: 'xả', quantity: 0.5, unit: 'kg' } }, known);
    expect(r.arguments).toMatchObject({ productName: 'sả', quantity: 0.5, unit: 'kg' });
    const other = { toolId: 'inventory.mark_out' as const, arguments: { productName: 'xả' } };
    expect(canonicalizeNames(other, known)).toBe(other);
  });
});

describe('bỏ qua món khi nghe nhầm', () => {
  it('"bỏ qua xả" tìm ra "sả" trong danh sách cần mua', () => {
    const r = resolveSkip({ toolId: 'shopping.skip', arguments: { name: 'xả' } }, [{ id: 'i1', name: 'sả' }, { id: 'i2', name: 'chanh' }]);
    expect(r.toolId).toBe('shopping.skip');
    expect(r.arguments.items).toEqual([{ itemId: 'i1', name: 'sả' }]);
  });
});
