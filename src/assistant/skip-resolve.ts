import type { Plan } from './planner';
import { normalizeVi } from './product-groups';
import { phoneticNormalize } from './vi-phonetic';

type Needed = { id: string; name: string };

/**
 * Đổi tên món người dùng nói thành đúng các dòng trong danh sách cần mua (itemId), để bản nháp
 * hiển thị chính xác món sẽ bị bỏ qua. Khớp đúng tên trước; nếu không thì chỉ nhận khi duy nhất
 * một món chứa cụm đó (nhiều món → hỏi lại, không đoán).
 */
export function resolveSkip(plan: Plan, needed: Needed[]): Plan {
  if (plan.toolId !== 'shopping.skip') return plan;
  const rawNames = Array.isArray(plan.arguments.names) ? plan.arguments.names : [plan.arguments.name];
  const wanted = rawNames.filter((n): n is string => typeof n === 'string' && n.trim() !== '');
  const picked = new Map<string, string>();
  const missing: string[] = [];
  for (const want of wanted) {
    const w = normalizeVi(want);
    if (!w) continue;
    const find = (key: (v: string) => string) => {
      const k = key(want);
      const same = needed.filter((n) => key(n.name) === k);
      const part = needed.filter((n) => { const t = key(n.name); return t.includes(k) || k.includes(t); });
      return { exact: same, partial: part };
    };
    // Khớp chữ trước; không có thì khớp theo âm (nghe nhầm "sả" thành "xả").
    let { exact, partial } = find(normalizeVi);
    if (!exact.length && !partial.length) ({ exact, partial } = find(phoneticNormalize));
    const matches = exact.length ? exact : partial;
    if (matches.length === 0) { missing.push(want); continue; }
    if (!exact.length && matches.length > 1) {
      const options = matches.map((m) => `"${m.name}"`).join(', ');
      return { toolId: 'clarify', arguments: { question: `Trong danh sách cần mua có nhiều món gần giống "${want}": ${options}. Bạn muốn bỏ món nào?` } };
    }
    for (const m of matches) picked.set(m.id, m.name);
  }
  if (!picked.size) {
    const first = missing[0] ?? 'món đó';
    return { toolId: 'clarify', arguments: { question: `Không thấy "${first}" trong danh sách cần mua.` } };
  }
  const warnings = missing.map((m) => `Không thấy "${m}" trong danh sách cần mua nên bỏ qua.`);
  return {
    toolId: 'shopping.skip',
    arguments: { items: [...picked].map(([itemId, name]) => ({ itemId, name })), ...(warnings.length ? { warnings } : {}) },
  };
}
