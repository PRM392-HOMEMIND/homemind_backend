// Câu trả lời cho các câu hỏi đọc dữ liệu. App hiển thị đúng `message`, nên phải nêu tên món,
// số lượng và hạn dùng thay vì chỉ đếm ("Có 4 lô...").
type Row = { storageLocation?: unknown; name?: unknown; quantity?: unknown; unit?: unknown; expiryDate?: unknown; expiryLevel?: unknown; status?: unknown };

const MAX_LISTED = 6;

function day(iso: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(typeof iso === 'string' ? iso : '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

function qty(row: Row): string {
  if (typeof row.quantity !== 'number') return '';
  const n = Number.isInteger(row.quantity) ? String(row.quantity) : String(Math.round(row.quantity * 1000) / 1000);
  return [n, typeof row.unit === 'string' ? row.unit : ''].filter(Boolean).join(' ');
}

function daysLeft(iso: unknown, today: string): number | null {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
  return Math.round((Date.parse(iso.slice(0, 10)) - Date.parse(today)) / 86400000);
}

function dueNote(row: Row, today: string): string {
  const d = daysLeft(row.expiryDate, today);
  if (d === null) return '';
  if (d < 0) return `quá hạn ${-d} ngày`;
  if (d === 0) return 'hết hạn hôm nay';
  return `còn ${d} ngày`;
}

function listed(rows: string[], total: number): string {
  const shown = rows.slice(0, MAX_LISTED).join('; ');
  return total > MAX_LISTED ? `${shown}; và ${total - MAX_LISTED} món khác` : shown;
}

export function buildReadMessage(
  toolId: string, args: Record<string, unknown>, data: Record<string, unknown>, today: string,
): string {
  if (toolId === 'inventory.list') {
    const items = (data.items as Row[]) ?? [];
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const term = typeof args.category === 'string' ? args.category.trim() : '';
    const wantsOut = args.status === 'out';
    if (!items.length) {
      if (wantsOut) return 'Hiện không có món nào đã hết.';
      if (query) return `Không thấy "${query}" trong kho.`;
      if (term) return `Chưa có món nào thuộc nhóm "${term}" trong kho.`;
      return 'Kho đang trống.';
    }
    if (wantsOut) return `Đã hết ${items.length} món: ${listed(items.map((i) => String(i.name)), items.length)}.`;
    const inStock = items.filter((i) => i.status !== 'out');
    const out = items.filter((i) => i.status === 'out');
    if (!inStock.length) return `${out.map((i) => String(i.name)).join(', ')} đã hết.`;
    const detailed = Boolean(query) || inStock.length <= 3;
    const rows = inStock.map((i) => {
      const place = detailed && typeof i.storageLocation === 'string' && i.storageLocation ? `để ở ${i.storageLocation}` : '';
      const parts = [qty(i), place, detailed && day(i.expiryDate) ? `hạn ${day(i.expiryDate)}${dueNote(i, today) ? ` (${dueNote(i, today)})` : ''}` : ''].filter(Boolean);
      return parts.length ? `${String(i.name)} (${parts.join(', ')})` : String(i.name);
    });
    const label = query ? `Còn ${inStock.length} món` : term ? `Nhóm "${term}" có ${inStock.length} món` : `Trong kho có ${inStock.length} món`;
    return `${label}: ${listed(rows, inStock.length)}.`;
  }
  if (toolId === 'inventory.expiring') {
    const items = (data.items as Row[]) ?? [];
    const range = String(data.range ?? args.range ?? '');
    if (!items.length) {
      return range === 'expired' ? 'Chưa có món nào quá hạn.' : 'Không có món nào hết hạn trong khoảng này.';
    }
    const rows = items.map((i) => {
      const d = day(i.expiryDate);
      return `${String(i.name)}${qty(i) ? ` (${qty(i)})` : ''}${d ? `, hạn ${d}` : ''}${dueNote(i, today) ? ` – ${dueNote(i, today)}` : ''}`;
    });
    // Phần mở đầu phải khớp nội dung: câu hỏi "sắp hết hạn" có thể kèm cả món đã quá hạn.
    const overdue = items.filter((i) => (daysLeft(i.expiryDate, today) ?? 0) < 0).length;
    const head = range === 'expired' || overdue === items.length ? `Có ${items.length} lô đã quá hạn`
      : overdue > 0 ? `Có ${items.length} lô sắp hoặc đã quá hạn`
        : `Có ${items.length} lô sắp hết hạn`;
    return `${head}: ${listed(rows, items.length)}.`;
  }
  if (toolId === 'shopping.list') {
    const items = (data.items as Row[]) ?? [];
    const status = typeof args.status === 'string' ? args.status : 'needed';
    const word = status === 'bought' ? 'đã mua' : status === 'skipped' ? 'đã bỏ qua' : 'cần mua';
    if (!items.length) return status === 'needed' ? 'Danh sách cần mua đang trống.' : `Chưa có món nào ${word}.`;
    const rows = items.map((i) => (qty(i) ? `${String(i.name)} (${qty(i)})` : String(i.name)));
    return `Có ${items.length} món ${word}: ${listed(rows, items.length)}.`;
  }
  if (toolId === 'spending.month') {
    const month = String(data.month ?? '').split('-');
    const label = month.length === 2 ? `tháng ${Number(month[1])}/${month[0]}` : 'tháng này';
    const money = (v: unknown) => `${String(Math.round(Number(v) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')} ₫`;
    const total = Number(data.totalVnd ?? 0), unpriced = Number(data.unpricedCount ?? 0), priced = Number(data.pricedCount ?? 0);
    if (!priced && !unpriced) return `Chưa có lần mua nào trong ${label}.`;
    const names = [...new Set(((data.unpriced as Row[]) ?? []).map((u) => String(u.name)).filter(Boolean))];
    const head = priced ? `Trong ${label} bạn đã chi ${money(total)}` : `Trong ${label} chưa có lần mua nào ghi giá`;
    const prev = Number(data.previousTotalVnd ?? 0);
    const delta = priced && prev > 0 ? `, ${total >= prev ? 'cao' : 'thấp'} hơn tháng trước (${money(prev)})` : '';
    const tail = unpriced ? `. Còn ${unpriced} lần mua chưa có giá nên chưa tính: ${listed(names, names.length)}` : '';
    return `${head}${delta}${tail}.`;
  }
  const n = (k: string) => Number(data[k] ?? 0);
  const bits = [`Kho có ${n('totalProducts')} sản phẩm`];
  if (n('expiringSoonCount')) bits.push(`${n('expiringSoonCount')} sắp hết hạn`);
  if (n('expiredCount')) bits.push(`${n('expiredCount')} đã quá hạn`);
  if (n('outCount')) bits.push(`${n('outCount')} đã hết`);
  if (n('shoppingNeededCount')) bits.push(`${n('shoppingNeededCount')} món cần mua`);
  return `${bits.join(', ')}.`;
}
