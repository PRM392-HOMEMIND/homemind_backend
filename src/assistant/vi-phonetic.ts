// Nhận giọng nói tiếng Việt hay nhầm âm đầu: s↔x ("sả"/"xả") và ch↔tr ("chứng"/"trứng").
// Thanh điệu và dấu đã bị bỏ khi chuẩn hoá, nên chỉ cần gộp thêm hai cặp âm đầu này.
// Cố ý KHÔNG gộp d/gi/r hay l/n: "rau" và "dầu" là hai món khác nhau quá phổ biến.
export function normalizeVi(value: string): string {
  return value.toLowerCase().replace(/đ/g, 'd').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function phoneticWord(word: string): string {
  if (word.startsWith('tr')) return 'ch' + word.slice(2);
  if (word.startsWith('x')) return 's' + word.slice(1);
  return word;
}

/** Dạng so khớp theo âm: bỏ dấu, rồi gộp âm đầu s/x và ch/tr ở đầu mỗi từ. */
export function phoneticNormalize(value: string): string {
  return normalizeVi(value).split(' ').filter(Boolean).map(phoneticWord).join(' ');
}

/** "xả kho", "xả hàng"... là từ khoá bán hết, không phải tên món. */
export function stripClearanceKeywords(value: string): string {
  return normalizeVi(value).replace(/\bxa (kho|hang|het|sach|dut)\b/g, ' ').replace(/\s+/g, ' ').trim();
}
