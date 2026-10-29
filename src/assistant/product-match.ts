import { phoneticNormalize, stripClearanceKeywords } from './vi-phonetic';

export type ProductCandidate = { id: string; name: string; unit?: string | null; stock?: number | null };

// 'xa' không nằm ở đây: "xả" cũng là nghe nhầm của "sả"; cụm "xả kho/xả hàng" được bỏ riêng ở stripClearanceKeywords.
const SOLD_OUT_WORDS = new Set(['kho', 'ban', 'het', 'roi', 'sach', 'can', 'loai', 'cai', 'chai', 'goi', 'hop', 'thung', 'lon', 'kg', 'qua', 'bo', 'tui', 'mua', 'them', 'nhap', 'vua', 'da', 'con', 'cua', 'toi', 'minh', 'nhe', 'nha', 'oi', 'hom', 'nay', 'va', 'voi', 'thi']);

export function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/đ/g, 'd')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Điểm 0..1: tỉ lệ từ khoá trong câu nói xuất hiện trong tên sản phẩm (đã bỏ dấu). */
export function matchScore(utterance: string, productName: string): number {
  const exact = scoreWith(stripClearanceKeywords(utterance), normalize(productName));
  // Khớp theo âm (s↔x, ch↔tr) bị trừ nhẹ để tên khớp chữ chính xác luôn thắng.
  const phonetic = scoreWith(phoneticNormalize(stripClearanceKeywords(utterance)), phoneticNormalize(productName)) * 0.9;
  return Math.max(exact, phonetic);
}

function scoreWith(utteranceKey: string, name: string): number {
  const nameTokens = new Set(name.split(' ').filter(Boolean));
  const words = utteranceKey.split(' ').filter(Boolean).filter((word) => !SOLD_OUT_WORDS.has(word));
  if (!words.length || !nameTokens.size) return 0;
  let hit = 0;
  for (const word of words) {
    if (nameTokens.has(word) || (word.length >= 3 && name.includes(word))) hit += 1;
  }
  const phrase = words.join(' ');
  const bonus = phrase.length >= 4 && name.includes(phrase) ? 0.5 : 0;
  // Phạt nhẹ nếu tên có nhiều từ không được nhắc để ưu tiên tên khớp chính xác hơn.
  const coverage = hit / nameTokens.size;
  return hit / words.length + bonus + coverage * 0.25;
}

export function rankCandidates<T extends ProductCandidate>(utterance: string, products: T[], limit = 12): T[] {
  return products
    .map((product) => ({ product, score: matchScore(utterance, product.name) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.product);
}

/** Sản phẩm khớp nhất nếu đủ tự tin (>= 0.6 và trội hơn ứng viên thứ hai); ngược lại null. */
export function bestMatch<T extends ProductCandidate>(utterance: string, products: T[]): T | null {
  const scored = products
    .map((product) => ({ product, score: matchScore(utterance, product.name) }))
    .sort((a, b) => b.score - a.score);
  if (!scored.length || scored[0].score < 0.6) return null;
  if (scored[1] && scored[0].score - scored[1].score < 0.15) return null;
  return scored[0].product;
}
