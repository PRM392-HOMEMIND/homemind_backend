import type { Plan } from './planner';

type CatalogItem = { id: string; name: string; unit?: string | null };
type Entry = Record<string, unknown>;

const norm = (value: unknown): string => (typeof value === 'string' ? value.trim().toLowerCase() : '');

// Đơn vị cùng loại đổi được cho nhau: { loại, hệ số về đơn vị gốc }. Gốc: kg và lít.
const CONVERTIBLE: Record<string, { dim: 'mass' | 'volume'; factor: number }> = {
  kg: { dim: 'mass', factor: 1 }, kí: { dim: 'mass', factor: 1 }, ký: { dim: 'mass', factor: 1 }, kilogam: { dim: 'mass', factor: 1 },
  g: { dim: 'mass', factor: 0.001 }, gam: { dim: 'mass', factor: 0.001 }, gram: { dim: 'mass', factor: 0.001 },
  lạng: { dim: 'mass', factor: 0.1 }, yến: { dim: 'mass', factor: 10 }, tạ: { dim: 'mass', factor: 100 },
  l: { dim: 'volume', factor: 1 }, lít: { dim: 'volume', factor: 1 }, lit: { dim: 'volume', factor: 1 },
  ml: { dim: 'volume', factor: 0.001 },
};

function convertQuantity(quantity: unknown, from: string, to: string): number | null {
  const a = CONVERTIBLE[from], b = CONVERTIBLE[to];
  if (typeof quantity !== 'number' || !a || !b || a.dim !== b.dim) return null;
  const value = (quantity * a.factor) / b.factor;
  return Math.round(value * 10000) / 10000;
}

/**
 * Mỗi sản phẩm chỉ có một đơn vị (DB từ chối lô khác đơn vị). Đối chiếu bản nháp inventory.add với kho
 * ngay lúc tạo draft để người dùng thấy lỗi bằng lời dễ hiểu, thay vì "Chưa lưu được" khi bấm Lưu:
 * - nói thiếu đơn vị: điền sẵn đơn vị của sản phẩm;
 * - nói đơn vị cùng loại (gram↔kg, ml↔lít...): tự quy đổi sang đơn vị của sản phẩm;
 * - nói đơn vị khác loại: dùng đơn vị của sản phẩm, bỏ số lượng (không đổi "2 lốc" thành "2 hộp") và cảnh báo.
 */
export function reconcileUnits(plan: Plan, catalog: CatalogItem[]): Plan {
  if (plan.toolId !== 'inventory.add') return plan;
  const fix = (entry: Entry): Entry => {
    const known = catalog.find((c) => c.id === entry.productCandidateId)
      ?? catalog.find((c) => norm(c.name) !== '' && norm(c.name) === norm(entry.productName));
    if (!known?.unit) return entry;
    const spoken = norm(entry.unit);
    if (!spoken) return { ...entry, unit: known.unit };
    if (spoken === norm(known.unit)) return entry;
    const converted = convertQuantity(entry.quantity, spoken, norm(known.unit));
    if (converted !== null) return { ...entry, unit: known.unit, quantity: converted };
    const previous = Array.isArray(entry.warnings) ? entry.warnings.filter((w): w is string => typeof w === 'string') : [];
    return {
      ...entry, unit: known.unit, quantity: null,
      warnings: [...previous, `"${String(entry.productName)}" đang tính theo "${known.unit}". Hãy nhập số lượng theo "${known.unit}" (bạn vừa nói "${String(entry.unit)}").`],
    };
  };
  const args = plan.arguments;
  if (Array.isArray(args.items)) {
    return { ...plan, arguments: { ...args, items: (args.items as Entry[]).map((item) => (item && typeof item === 'object' ? fix(item) : item)) } };
  }
  return { ...plan, arguments: fix(args) };
}
