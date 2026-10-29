import { describe, expect, it } from 'vitest';
import { bestMatch, matchScore, normalize, rankCandidates } from '../src/assistant/product-match';

const products = [
  { id: '1', name: 'Nước tương Chinsu 500ml' },
  { id: '2', name: 'Tương ớt Chinsu 250g' },
  { id: '3', name: 'Nước mắm Nam Ngư 500ml' },
  { id: '4', name: 'Sữa tươi Vinamilk 220ml' },
  { id: '5', name: 'Sữa chua Vinamilk lốc 4' },
];

describe('product-match', () => {
  it('bỏ dấu tiếng Việt', () => expect(normalize('Tương ớt Đà Lạt')).toBe('tuong ot da lat'));
  it('"tương ớt loại 250g xả kho rồi" khớp Tương ớt Chinsu 250g', () => {
    expect(bestMatch('tương ớt loại 250g xả kho rồi', products)?.id).toBe('2');
  });
  it('không nhầm Nước tương với Tương ớt', () => {
    expect(matchScore('tương ớt', 'Tương ớt Chinsu 250g')).toBeGreaterThan(matchScore('tương ớt', 'Nước tương Chinsu 500ml'));
  });
  it('sữa tươi khác sữa chua', () => {
    expect(bestMatch('sữa tươi hết rồi', products)?.id).toBe('4');
  });
  it('mơ hồ thì không chọn', () => {
    expect(bestMatch('sữa vinamilk hết', products)).toBeNull();
  });
  it('xếp ứng viên liên quan lên đầu', () => {
    expect(rankCandidates('bán hết nước mắm', products, 2)[0].id).toBe('3');
  });
});
