// Bản gọn của phân nhóm trong app (homemind_mobile/lib/core/product_groups.dart), chỉ để trợ lý
// trả lời câu hỏi theo nhóm ("có đồ uống nào không?"). Không dùng để ghi dữ liệu: nhóm hiển thị
// trong app vẫn do app quyết định.
export type GroupKey = 'fresh' | 'dry' | 'spice' | 'drink' | 'home' | 'beauty';

export function normalizeVi(value: string): string {
  return value.toLowerCase().replace(/đ/g, 'd').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

const GROUP_TERMS: Record<GroupKey, string[]> = {
  fresh: ['do tuoi', 'tuoi song', 'rau cu', 'thit ca', 'thuc pham tuoi'],
  dry: ['do kho', 'luong thuc', 'do hop', 'banh keo', 'do an kho'],
  spice: ['gia vi', 'nuoc cham'],
  drink: ['do uong', 'thuc uong', 'nuoc giai khat', 'nuoc uong'],
  home: ['do gia dung', 'gia dung', 'do dung gia dinh', 'do dung', 'hoa pham', 've sinh'],
  beauty: ['my pham', 'lam dep', 'skincare', 'makeup', 'cham soc da', 'cham soc ca nhan'],
};

// Chữ còn dấu quyết định các cặp bỏ dấu trùng nhau: dưỡng/đường, sơn/son, râu/rau, phấn/phân.
function prepare(raw: string): string {
  return normalizeVi(raw.toLowerCase()
    .replace(/dưỡng/g, ' xcarex ').replace(/đường/g, ' xsugarx ').replace(/râu/g, ' xbeardx ')
    .replace(/sơn/g, ' xpaintx ').replace(/phấn/g, ' xpowderx ').replace(/(^|\s)son(\s|$)/g, ' xlipx '));
}

const BEAUTY = /\b(xcarex|xlipx|xpowderx|sua rua mat|rua mat|toner|serum|essence|kem chong nang|tay trang|mat na|nuoc hoa|lotion|my pham|kem nen|kem lot|mascara|ke mat|tinh dau|muoi tam|son moi|lip balm)\b/;
const HOME = /\b(bot giat|nuoc giat|nuoc rua|nuoc xa|nuoc lau|giay ve sinh|khan giay|dau goi|dau xa|sua tam|kem danh rang|ban chai|dao cao|xbeardx|bim|ta lot|gel rua tay|xa phong|pin|khau trang|tui rac|nen|xit phong|xpaintx)\b/;
const DRINK = /\b(bia|coca|pepsi|7up|sting|red bull|ca phe|cafe|coffee|tra xanh|tra|nuoc suoi|nuoc ngot|nuoc ep|nuoc khoang|nuoc dua|soda|aquafina|nuoc giai khat|ruou|sinh to|sua chua uong)\b/;
const SPICE = /\b(xsugarx|nuoc mam|nuoc tuong|nuoc cham|tuong ot|tuong ca|tuong|dau an|dau hao|dau olive|dau oliu|muoi|bot ngot|bot canh|hat nem|tieu|giam|gia vi|sa te|mat ong|bot nghe|duong)\b/;
const DRY = /\b(kho|do hop|mi|bun|pho|mien|banh|keo|snack|bim bim|gao|nep|hat|sua dac|sua bot|ngu coc|bot|yen mach)\b/;
const FRESH = /\b(rau|cu|ca chua|thit|ca|tom|muc|trung|sua|pho mai|bo|chuoi|cam|tao|trai cay|hanh|toi|gung|ot|sua chua|sa|chanh)\b/;

export function groupOf(name: string, category?: string | null): GroupKey | null {
  const text = prepare(name);
  if (BEAUTY.test(text)) return 'beauty';
  if (HOME.test(text)) return 'home';
  if (DRINK.test(text)) return 'drink';
  if (/\bsua (hat|dau nanh|dau|gao)\b/.test(text)) return 'fresh';
  if (SPICE.test(text)) return 'spice';
  if (/\bpho mai\b/.test(text)) return 'fresh';
  if (DRY.test(text)) return 'dry';
  if (FRESH.test(text)) return 'fresh';
  const cat = normalizeVi(category ?? '');
  for (const key of Object.keys(GROUP_TERMS) as GroupKey[]) if (GROUP_TERMS[key].includes(cat)) return key;
  return null;
}

/** `term` là cụm người dùng nói/AI trích ra ("đồ uống", "gia vị", "sữa"...). */
export function matchesCategoryTerm(item: { name: string; category?: string | null }, term: string): boolean {
  const t = normalizeVi(term);
  if (!t) return true;
  const cat = normalizeVi(item.category ?? '');
  if (cat && (cat.includes(t) || t.includes(cat))) return true;
  const group = groupOf(item.name, item.category);
  if (group && GROUP_TERMS[group].some((alias) => alias.includes(t) || t.includes(alias))) return true;
  return false;
}
