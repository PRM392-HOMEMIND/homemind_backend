import type { Plan } from './planner';
import { normalizeVi, phoneticNormalize } from './vi-phonetic';

type Entry = Record<string, unknown>;

/**
 * Nhận giọng nói hay nghe nhầm âm đầu ("sả" -> "xả"). Nếu tên trong bản nháp KHÁC tên món bạn đã có
 * chỉ ở âm đầu (s/x, ch/tr) và khớp đúng một món thì đổi về tên đã có, kèm cảnh báo để bạn biết.
 * Không đoán khi có nhiều món cùng âm hoặc khi tên đã trùng chính xác một món đang có.
 */
export function canonicalizeNames(plan: Plan, known: string[]): Plan {
  if (plan.toolId !== 'shopping.add' && plan.toolId !== 'inventory.add') return plan;
  const exact = new Set(known.map((n) => normalizeVi(n)));
  const byPhonetic = new Map<string, Set<string>>();
  for (const name of known) {
    const key = phoneticNormalize(name);
    if (!key) continue;
    (byPhonetic.get(key) ?? byPhonetic.set(key, new Set()).get(key)!).add(name.trim());
  }
  const field = plan.toolId === 'shopping.add' ? 'name' : 'productName';
  const fix = (entry: Entry): Entry => {
    const spoken = typeof entry[field] === 'string' ? (entry[field] as string).trim() : '';
    if (!spoken || exact.has(normalizeVi(spoken))) return entry;
    const matches = byPhonetic.get(phoneticNormalize(spoken));
    if (!matches || matches.size !== 1) return entry;
    const [canonical] = [...matches];
    const previous = Array.isArray(entry.warnings) ? entry.warnings.filter((w): w is string => typeof w === 'string') : [];
    return {
      ...entry, [field]: canonical,
      warnings: [...previous, `Mình nghe là "${spoken}", đã đổi thành "${canonical}" (món bạn đã có). Nếu sai, hãy sửa lại tên.`],
    };
  };
  const args = plan.arguments;
  if (Array.isArray(args.items)) {
    return { ...plan, arguments: { ...args, items: (args.items as Entry[]).map((i) => (i && typeof i === 'object' ? fix(i) : i)) } };
  }
  return { ...plan, arguments: fix(args) };
}
