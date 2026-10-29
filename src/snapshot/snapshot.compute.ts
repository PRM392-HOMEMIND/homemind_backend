import { expiryLevel, dateRange, todayVietnam } from '../common/date';
import { quantitySummary } from '../common/quantity';

/**
 * Các hàm thuần tính dữ liệu hiển thị từ một lần đọc DB duy nhất.
 * Kết quả giữ NGUYÊN hình dạng JSON của các endpoint cũ (home, inventory,
 * shopping, notifications) để app không phải đổi gì.
 */

export type RawProduct = { id: string; name: string; category: string | null; unit: string | null; status: string; createdBy?:string|null };
export type RawLot = { productId: string; lotId: string; quantity: number; unit: string | null; expiry: string | null; location?: string | null; known?: boolean; createdBy?:string|null };
export type RawShopping = {
  id: string; name: string; quantity: number | null; unit: string | null; status: string; source: string; linkedProductId: string | null;createdBy?:string|null;
};
export type Raw = {
  member: boolean;
  actor?:string;
  shared?:boolean;
  suggestions?:Array<{name:string;reason:string;productId:string}>;
  products: RawProduct[];
  lots: RawLot[];
  shopping: RawShopping[];
  counts: Record<string, number>;
  reads: string[];
  plan: { plan: string; limit: number | null } | null;
  /** Các gói người dùng này đã yêu cầu nâng cấp. */
  requested?: string[];
};

export type InventoryItem = {
  productId: string; name: string; category: string | null; quantity: number | null; unit: string | null;
  expiryDate: string | null; expiryLevel: string; status: 'in_stock' | 'out'; storageLocation: string | null;
  quantityState?: string; quantityBreakdown?: Array<{unit:string|null;knownQuantity:number;unknownLots:number}>;
  createdBy?:string|null;canEdit?:boolean;
};

const asDate = (value: string | null): Date | null => (value ? new Date(`${value}T00:00:00Z`) : null);

export function computeInventory(raw: Raw, today = todayVietnam()): InventoryItem[] {
  // Lô đã được SQL sắp theo hạn tăng dần (không hạn xếp cuối), rồi theo ngày tạo.
  const lotsByProduct = new Map<string, RawLot[]>();
  for (const lot of raw.lots) {
    if (!(Number(lot.quantity) > 0)) continue;
    const list = lotsByProduct.get(lot.productId);
    if (list) list.push(lot);
    else lotsByProduct.set(lot.productId, [lot]);
  }
  return raw.products.map((product) => {
    const positive = lotsByProduct.get(product.id) ?? [];
    const nearest = positive.find((lot) => lot.expiry) ?? positive[0];
    // Lô không nói số lượng chỉ cho biết "có hàng": không cộng vào số lượng. Không có lô nào rõ số lượng => null.
    const quantities = quantitySummary(positive);
    const expiry = nearest?.expiry ?? null;
    return {
      productId: product.id, name: product.name, category: product.category, ...quantities,
      createdBy:product.createdBy??null,canEdit:!raw.shared||(product.createdBy===raw.actor&&positive.every(l=>l.createdBy===raw.actor)),
      expiryDate: expiry, expiryLevel: expiryLevel(asDate(expiry), today),
      status: positive.length > 0 ? 'in_stock' : 'out',
      // Nơi cất của lô dùng trước (gần hết hạn nhất); lô đó chưa ghi thì lấy lô khác có ghi.
      storageLocation: nearest?.location ?? positive.find((lot) => lot.location)?.location ?? null,
    };
  });
}

export type InventoryFilters = { q?: string; category?: string; status?: string; expiryRange?: string; limit?: number };

export function filterInventory(all: InventoryItem[], filters: InventoryFilters = {}, today = todayVietnam()) {
  let items = all;
  if (filters.category) items = items.filter((i) => i.category === filters.category);
  if (filters.q) {
    const q = filters.q.toLowerCase();
    items = items.filter((i) => i.name.toLowerCase().includes(q));
  }
  if (filters.status) items = items.filter((i) => i.status === filters.status);
  if (filters.expiryRange) {
    const range = dateRange(filters.expiryRange, today);
    items = items.filter((i) => i.expiryDate && i.status === 'in_stock' && i.expiryDate >= range.from && i.expiryDate <= range.to);
  }
  return { total: items.length, items: items.slice(0, filters.limit ?? 50) };
}

export function computeHome(raw: Raw, inventory: InventoryItem[]) {
  const expiringSoon = inventory.filter((i) => i.status === 'in_stock' && ['soon', 'urgent'].includes(i.expiryLevel));
  const expired = inventory.filter((i) => i.status === 'in_stock' && i.expiryLevel === 'expired');
  return {
    toolId: 'home.summary', totalProducts: inventory.length,
    inStockCount: inventory.filter((i) => i.status === 'in_stock').length,
    outCount: inventory.filter((i) => i.status === 'out').length,
    expiredCount: expired.length, expiringSoonCount: expiringSoon.length,
    shoppingNeededCount: raw.counts.needed ?? 0,
    plan: raw.plan?.plan ?? 'free',
    // Có dòng gói mà product_limit rỗng = không giới hạn; chưa có dòng gói = mặc định 30 (Miễn phí).
    freePlanLimit: (raw.plan ? raw.plan.limit : 30) as number | null, productCountTowardLimit: inventory.length,
    expiringSoon, expired,
    requestedPlans: raw.requested ?? [],
    alerts: [...expired, ...expiringSoon].map((i) => ({
      type: 'expiry', severity: i.expiryLevel, productId: i.productId, title: i.name,
      subtitle: `Hết hạn ${i.expiryDate}`, expiryDate: i.expiryDate, cta: 'buy',
    })),
  };
}

export function computeShopping(raw: Raw) {
  const byStatus = (status: string) => raw.shopping.filter((row) => row.status === status);
  const shape = (row: RawShopping) => ({
    id: row.id, name: row.name, quantity: row.quantity === null ? null : Number(row.quantity), unit: row.unit, status: row.status, source: row.source,
    createdBy:row.createdBy??null,canEdit:!raw.shared||row.createdBy===raw.actor,
  });
  const needed = byStatus('needed');
  const neededProductIds = new Set(needed.map((row) => row.linkedProductId));
  const suggestions = raw.products
    .filter((product) => product.status === 'out' && !neededProductIds.has(product.id))
    .map((product) => ({ name: product.name, reason: 'out', productId: product.id }));
  return {
    byStatus: {
      needed: needed.map(shape), bought: byStatus('bought').map(shape), skipped: byStatus('skipped').map(shape),
    } as Record<string, ReturnType<typeof shape>[]>,
    counts: { needed: raw.counts.needed ?? 0, bought: raw.counts.bought ?? 0, skipped: raw.counts.skipped ?? 0 } as Record<string, number>,
    suggestions:raw.suggestions??suggestions.slice(0,50),
    pagination:Object.fromEntries(['needed','bought','skipped'].map(status=>[status,{loaded:byStatus(status).length,total:raw.counts[status]??0,hasMore:(raw.counts[status]??0)>byStatus(status).length,continuation:'SHOPPING_LIST_FIRST_PAGE',limit:100}])),
  };
}

export type NotificationItem = { id: string; title: string; body: string; context: string; type: string; read: boolean };

export function computeNotifications(home: ReturnType<typeof computeHome>, readKeys: Set<string>) {
  const items: NotificationItem[] = home.alerts.map((alert) => {
    const id = `expiry.${alert.productId}.${alert.expiryDate ?? 'unknown'}`;
    return { id, title: alert.title, body: alert.subtitle, context: 'Dữ liệu tồn kho hiện tại', type: alert.type, read: readKeys.has(id) };
  });
  return { items, unreadCount: items.filter((item) => !item.read).length };
}

export type Snapshot = {
  inventory: InventoryItem[];
  home: ReturnType<typeof computeHome>;
  shopping: ReturnType<typeof computeShopping>;
  readKeys: Set<string>;
  notifications: ReturnType<typeof computeNotifications>;
  products: Array<{ id: string; name: string; unit: string | null }>;
  loadedAt: number;
};

export function buildSnapshot(raw: Raw, today = todayVietnam()): Snapshot {
  const inventory = computeInventory(raw, today);
  const home = computeHome(raw, inventory);
  const readKeys = new Set(raw.reads);
  return {
    inventory, home, shopping: computeShopping(raw), readKeys,
    notifications: computeNotifications(home, readKeys),
    products: raw.products.map((p) => ({ id: p.id, name: p.name, unit: p.unit })),
    loadedAt: Date.now(),
  };
}

/** Đánh dấu đã đọc ngay trong snapshot đang có (không cần tải lại từ DB). */
export function withReads(snapshot: Snapshot, keys: string[]): Snapshot {
  const readKeys = new Set([...snapshot.readKeys, ...keys]);
  return { ...snapshot, readKeys, notifications: computeNotifications(snapshot.home, readKeys) };
}

/** Thêm gói đã yêu cầu nâng cấp vào snapshot đang có (không phải tải lại). */
export function withRequestedPlan(snapshot: Snapshot, plan: string): Snapshot {
  const requested = [...new Set([...snapshot.home.requestedPlans, plan])];
  return { ...snapshot, home: { ...snapshot.home, requestedPlans: requested } };
}
