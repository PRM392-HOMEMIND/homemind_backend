import { describe, expect, it, vi } from 'vitest';
import { invalidateWorkspace, WorkspaceCache } from '../src/common/workspace-cache';
import { buildSnapshot, filterInventory, Raw, withReads } from '../src/snapshot/snapshot.compute';

const TODAY = '2026-10-01';
const raw: Raw = {
  member: true,
  products: [
    { id: 'p-ca', name: 'Cá hồi', category: 'Thịt & cá', unit: 'kg', status: 'in_stock' },
    { id: 'p-sua', name: 'Sữa chua', category: 'Sữa & bơ', unit: 'hộp', status: 'in_stock' },
    { id: 'p-trung', name: 'Trứng', category: 'Thực phẩm', unit: 'quả', status: 'out' },
    { id: 'p-gao', name: 'Gạo', category: 'Lương thực', unit: 'kg', status: 'in_stock' },
  ],
  lots: [
    { productId: 'p-ca', lotId: 'l1', quantity: 0.6, unit: 'kg', expiry: '2026-10-02' }, // urgent
    { productId: 'p-sua', lotId: 'l2', quantity: 1, unit: 'hộp', expiry: '2026-09-28' }, // expired
    { productId: 'p-sua', lotId: 'l3', quantity: 2, unit: 'hộp', expiry: '2026-10-06' }, // soon
    { productId: 'p-gao', lotId: 'l4', quantity: 8, unit: 'kg', expiry: null }, // ok
  ],
  shopping: [
    { id: 's1', name: 'Chuối', quantity: 1, unit: 'nải', status: 'needed', source: 'manual', linkedProductId: null },
    { id: 's2', name: 'Bột giặt', quantity: null, unit: null, status: 'bought', source: 'manual', linkedProductId: null },
  ],
  counts: { needed: 1, bought: 1 },
  reads: [],
  plan: { plan: 'free', limit: 30 },
};

describe('snapshot.compute', () => {
  const snap = buildSnapshot(raw, TODAY);

  it('kho: cộng các lô còn hàng, lấy hạn gần nhất, trạng thái hết khi không còn lô', () => {
    const byName = Object.fromEntries(snap.inventory.map((i) => [i.name, i]));
    expect(byName['Sữa chua']).toMatchObject({ quantity: 3, expiryDate: '2026-09-28', expiryLevel: 'expired', status: 'in_stock' });
    expect(byName['Cá hồi']).toMatchObject({ quantity: 0.6, expiryLevel: 'urgent' });
    expect(byName['Gạo']).toMatchObject({ quantity: 8, expiryDate: null, expiryLevel: 'ok' });
    expect(byName['Trứng']).toMatchObject({ quantity: 0, status: 'out' });
  });

  it('tổng quan: đếm đúng và liệt kê cảnh báo hạn dùng', () => {
    expect(snap.home).toMatchObject({
      totalProducts: 4, inStockCount: 3, outCount: 1, expiredCount: 1, expiringSoonCount: 1,
      shoppingNeededCount: 1, plan: 'free', freePlanLimit: 30,
    });
    expect(snap.home.alerts.map((a) => [a.title, a.severity])).toEqual([['Sữa chua', 'expired'], ['Cá hồi', 'urgent']]);
    expect(snap.home.alerts[0].subtitle).toBe('Hết hạn 2026-09-28');
  });

  it('thông báo: chưa đọc, rồi đánh dấu đã đọc ngay trong snapshot', () => {
    expect(snap.notifications.unreadCount).toBe(2);
    const id = snap.notifications.items[0].id;
    expect(id).toBe('expiry.p-sua.2026-09-28');
    const after = withReads(snap, [id]);
    expect(after.notifications.unreadCount).toBe(1);
    expect(after.notifications.items.find((n) => n.id === id)?.read).toBe(true);
    // snapshot cũ không bị đổi (bất biến)
    expect(snap.notifications.unreadCount).toBe(2);
  });

  it('mua sắm: theo trạng thái, gợi ý từ hàng đã hết chưa có trong danh sách', () => {
    expect(snap.shopping.byStatus.needed.map((i) => i.name)).toEqual(['Chuối']);
    expect(snap.shopping.byStatus.bought.map((i) => i.name)).toEqual(['Bột giặt']);
    expect(snap.shopping.suggestions).toEqual([{ name: 'Trứng', reason: 'out', productId: 'p-trung' }]);
    const withTrung = buildSnapshot({ ...raw, shopping: [...raw.shopping, { id: 's3', name: 'Trứng', quantity: null, unit: null, status: 'needed', source: 'x', linkedProductId: 'p-trung' }] }, TODAY);
    expect(withTrung.shopping.suggestions).toEqual([]);
  });

  it('lọc kho: tên, danh mục, trạng thái, khoảng hạn, giới hạn', () => {
    expect(filterInventory(snap.inventory, { q: 'sữa' }).items.map((i) => i.name)).toEqual(['Sữa chua']);
    expect(filterInventory(snap.inventory, { category: 'Lương thực' }).total).toBe(1);
    expect(filterInventory(snap.inventory, { status: 'out' }).items.map((i) => i.name)).toEqual(['Trứng']);
    expect(filterInventory(snap.inventory, { expiryRange: 'next_7_days' }, TODAY).items.map((i) => i.name)).toEqual(['Cá hồi']);
    expect(filterInventory(snap.inventory, { limit: 2 }).items).toHaveLength(2);
    expect(filterInventory(snap.inventory, { limit: 2 }).total).toBe(4);
  });
});

describe('WorkspaceCache', () => {
  it('gộp các lần tải đồng thời thành một lần và phục vụ lần sau từ bộ nhớ', async () => {
    const cache = new WorkspaceCache<number>(60_000);
    const load = vi.fn(async () => { await new Promise((r) => setTimeout(r, 20)); return 42; });
    const results = await Promise.all(Array.from({ length: 10 }, () => cache.get('u', 'w', load)));
    expect(results).toEqual(Array(10).fill(42));
    expect(load).toHaveBeenCalledTimes(1);
    await cache.get('u', 'w', load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('thao tác ghi huỷ cache: lần đọc sau tải lại dữ liệu mới', async () => {
    const cache = new WorkspaceCache<number>(60_000);
    let value = 1;
    const load = async () => value;
    expect(await cache.get('u', 'w', load)).toBe(1);
    value = 2;
    expect(await cache.get('u', 'w', load)).toBe(1); // còn cache
    invalidateWorkspace('w');
    expect(await cache.get('u', 'w', load)).toBe(2);
  });

  it('lần tải đang bay bị huỷ giữa chừng thì không ghi đè cache bằng dữ liệu cũ', async () => {
    const cache = new WorkspaceCache<string>(60_000);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = cache.get('u', 'w', async () => { await gate; return 'cũ'; });
    invalidateWorkspace('w'); // có thao tác ghi trong lúc đang tải
    release();
    expect(await slow).toBe('cũ'); // người gọi vẫn nhận kết quả
    expect(cache.peek('u', 'w')).toBeUndefined(); // nhưng không lưu lại
  });

  it('hết hạn TTL thì tải lại; mỗi người dùng một bản riêng', async () => {
    vi.useFakeTimers();
    try {
      const cache = new WorkspaceCache<string>(1_000);
      expect(await cache.get('a', 'w', async () => 'a1')).toBe('a1');
      expect(await cache.get('b', 'w', async () => 'b1')).toBe('b1');
      vi.advanceTimersByTime(1_500);
      expect(await cache.get('a', 'w', async () => 'a2')).toBe('a2');
    } finally {
      vi.useRealTimers();
    }
  });
  it('invalidation detaches a stale in-flight load from a new reader and cannot resurrect it after eviction',async()=>{
    const cache=new WorkspaceCache<string>(60000,1);
    let release!:()=>void;const gate=new Promise<void>(r=>release=r);
    const stale=cache.get('u','w',async()=>{await gate;return 'old';});
    cache.invalidate('w');
    expect(await cache.get('u','w',async()=>'new')).toBe('new');
    await cache.get('v','other',async()=>'other');release();await stale;
    expect(cache.peek('u','w')).toBeUndefined();expect(cache.size).toBe(1);cache.dispose();
  });

  it('cập nhật tại chỗ không đổi hạn sử dụng của entry', async () => {
    const cache = new WorkspaceCache<number[]>(60_000);
    await cache.get('u', 'w', async () => [1]);
    cache.update('u', 'w', (v) => [...v, 2]);
    expect(cache.peek('u', 'w')).toEqual([1, 2]);
  });
});
