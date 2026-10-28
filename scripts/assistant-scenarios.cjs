// Kịch bản end-to-end cho trợ lý giọng nói (giá, nơi cất, còn lại, chi tiêu) trên backend ĐANG CHẠY.
// Dùng Gemini thật nên tốn lượt; chỉ chạy với backend/DB local dùng một lần:
//   node scripts/assistant-scenarios.cjs            (BASE=http://127.0.0.1:3000/v1)
// Mỗi bước: nói một câu -> kiểm tra bản nháp/kết quả -> (tùy chọn) xác nhận -> kiểm tra kho + chi tiêu.
const crypto = require('node:crypto');
const BASE = process.env.BASE || 'http://127.0.0.1:3000/v1';
let token, ws;
let credentials;
const http = async (path, method = 'GET', body, retried = false) => {
  const result = await send(path, method, body);
  // Access token chỉ sống 15 phút mà một lần chạy (kèm chờ Gemini quá tải) có thể lâu hơn: đăng nhập lại rồi gửi lại.
  if (result.status === 401 && credentials && !retried && path !== '/auth/login') {
    const login = await send('/auth/login', 'POST', credentials);
    if (login.status === 200 || login.status === 201) { token = login.data.accessToken; return http(path, method, body, true); }
  }
  return result;
};
const send = async (path, method = 'GET', body) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID(), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').toLowerCase();
const has = (s, w) => norm(s).includes(norm(w));
const items = (args) => Array.isArray(args?.items) ? args.items : [args];
const find = (args, name) => items(args).find((i) => has(i.productName ?? i.name, name));
const inventory = async () => (await http(`/workspaces/${ws}/inventory?limit=100`)).data.items;
const stock = async (name) => (await inventory()).find((i) => has(i.name, name));
const spending = async () => (await http(`/workspaces/${ws}/spending`)).data;

const results = [];
let beforeSplit;
async function step(id, text, check, { confirm = false, confirmAll = false, after } = {}) {
  let turn, notes = [], ok = true;
  const fail = (m) => { ok = false; notes.push(m); };
  try {
    // Backend giới hạn 20 yêu cầu/phút/người dùng và Gemini có thể quá tải: gặp RATE_LIMITED/AI_UNAVAILABLE thì chờ rồi gửi lại (không tính là lỗi).
    let r;
    for (let attempt = 0; attempt < 4; attempt++) {
      r = await http('/assistant/turn', 'POST', { requestId: crypto.randomUUID(), workspaceId: ws, locale: 'vi-VN',
      clientDate: new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10), timezone: 'Asia/Ho_Chi_Minh', dictionaryVersion: '1.1.0', input: { type: 'voice_transcript', text } });
      if (!['RATE_LIMITED', 'AI_UNAVAILABLE'].includes(r.data?.error?.code)) break;
      await new Promise((resolve) => setTimeout(resolve, 20000));
    }
    if (r.status !== 201) { fail(`HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`); }
    else {
      turn = r.data;
      const tool = (turn.toolsProposed ?? turn.toolsUsed ?? [])[0] ?? {};
      const view = { followUps: turn.followUps ?? [], kind: turn.kind, toolId: tool.toolId, args: tool.arguments ?? {}, message: turn.message, data: turn.data };
      notes.push(`${view.toolId}${view.args && Object.keys(view.args).length ? ' ' + JSON.stringify(view.args) : ''}`);
      const problem = check(view);
      if (problem) fail(problem);
      if (ok && confirm && turn.kind === 'write_draft') {
        const c = await http(`/assistant/turns/${turn.turnId}/confirm`, 'POST', { workspaceId: ws, idempotencyKey: crypto.randomUUID(), tools: turn.toolsProposed });
        if (c.status !== 201) fail(`confirm HTTP ${c.status} ${JSON.stringify(c.data).slice(0, 120)}`);
        else if (confirmAll) {
          for (const f of turn.followUps ?? []) {
            const cf = await http(`/assistant/turns/${f.turnId}/confirm`, 'POST', { workspaceId: ws, idempotencyKey: crypto.randomUUID(), tools: f.toolsProposed });
            if (cf.status !== 201) fail(`follow-up confirm HTTP ${cf.status} ${JSON.stringify(cf.data).slice(0, 120)}`);
          }
          if (ok && after) { const p = await after(); if (p) fail(p); }
        }
        else if (after) { const p = await after(); if (p) fail(p); }
      }
    }
  } catch (e) { fail(String(e.message ?? e)); }
  results.push({ id, text, ok, notes });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}\n      "${text}"\n      ${notes.join(' | ')}`);
}

(async () => {
  const email = `scn${Date.now()}@example.com`, password = crypto.randomBytes(16).toString('hex');
  const reg = await http('/auth/register', 'POST', { acceptedTerms: true, acceptedPrivacy: true, displayName: 'Kịch bản', email, password, workspaceType: 'household' });
  // Gói Miễn phí chỉ có ít lượt trợ lý; nâng lên Gia đình (DB local) để chạy hết kịch bản.
  if (process.env.MIGRATION_DATABASE_URL) require('node:child_process').execFileSync(process.execPath, [require('node:path').join(__dirname, 'set-plan.cjs'), email, 'family'], { stdio: 'ignore' });
  credentials = { identifier: email, password };
  token = reg.data.accessToken; ws = (await http('/me')).data.workspaceId;
  const eq = (a, b, label) => (a === b ? null : `${label}: cần ${b}, có ${a}`);

  // ── Nhập kho một món, giọng nói sai chính tả ────────────────────────
  await step('A1 nghe sai + giá + nơi cất', 'thietj lơn mua đc 3 ký giá 275000 để ở tử dá', (v) => {
    const i = find(v.args, 'thit lon'); if (v.toolId !== 'inventory.add' || !i) return 'phải là inventory.add thịt lợn';
    return eq(i.quantity, 3, 'số lượng') || eq(i.priceVnd, 275000, 'giá') || (has(i.storageLocation, 'da') ? null : `nơi cất phải là tủ/ngăn đá, có ${i.storageLocation}`);
  }, { confirm: true, after: async () => { const s = await stock('thit lon'); const sp = await spending();
    return eq(s?.quantity, 3, 'tồn') || eq(sp.totalVnd, 275000, 'chi tiêu') || eq(has(s?.storageLocation, 'da'), true, 'kho có nơi cất'); } });

  // ── Còn lại sau khi dùng ────────────────────────────────────────────
  await step('B1 "còn 3 ký" trong khi kho đã đúng 3 ký (mâu thuẫn)', 'thịt lợn ăn gần hết rồi còn 3 ký thôi', (v) =>
    v.toolId === 'clarify' ? null : `phải hỏi lại vì kho đang đúng 3 ký, có ${v.toolId} ${JSON.stringify(v.args)}`);
  await step('B2 còn nửa ký => trừ 2,5', 'thịt lợn ăn gần hết rồi, chỉ còn nửa ký', (v) =>
    v.toolId !== 'inventory.mark_out' ? 'phải là mark_out' : eq(v.args.quantity, 2.5, 'trừ'), { confirm: true,
    after: async () => eq((await stock('thit lon'))?.quantity, 0.5, 'tồn sau khi trừ') });
  await step('B3 ăn 200 gram (khác đơn vị ký)', 'ăn 200 gram thịt lợn', (v) =>
    v.toolId === 'clarify' || (v.toolId === 'inventory.mark_out' && (v.args.quantity === 0.2 || v.args.quantity === 200) ) ? null : 'phải trừ 0,2 ký hoặc hỏi lại về đơn vị');
  await step('B4 hết hẳn', 'thịt lợn hết sạch rồi', (v) => v.toolId !== 'inventory.mark_out' ? 'phải là mark_out' : eq(v.args.quantity, null, 'toàn bộ'));

  // ── Nhiều món, giá/nơi cất riêng từng món ───────────────────────────
  await step('C1 hai món, giá + nơi cất riêng', 'vừa mua 2 hộp sữa tươi 38 nghìn để tủ lạnh và 1 chục trứng 35k để trên kệ bếp', (v) => {
    const a = find(v.args, 'sua'), b = find(v.args, 'trung'); if (!a || !b) return 'phải có sữa và trứng';
    const eggs = (b.quantity === 10 && has(b.unit, 'qua')) || (b.quantity === 1 && has(b.unit, 'chuc')) ? null : `trứng phải là 10 quả (hoặc 1 chục), có ${b.quantity} ${b.unit}`;
    return eggs || eq(a.priceVnd, 38000, 'giá sữa') || eq(b.priceVnd, 35000, 'giá trứng') || (has(a.storageLocation, 'tu lanh') ? null : `nơi cất sữa: ${a.storageLocation}`)
      || (has(b.storageLocation, 'ke') ? null : `nơi cất trứng: ${b.storageLocation}`);
  }, { confirm: true, after: async () => { const sp = await spending(); return eq(sp.totalVnd, 275000 + 38000 + 35000, 'tổng chi tiêu'); } });
  await step('C2 chỉ có giá', 'mới mua về 1 chai nước mắm 52 nghìn', (v) => { const i = find(v.args, 'nuoc mam'); return !i ? 'thiếu nước mắm' : eq(i.priceVnd, 52000, 'giá') || (i.storageLocation ? `không được bịa nơi cất: ${i.storageLocation}` : null); });
  await step('C3 chỉ có nơi cất', 'đã mua 4 gói mì tôm cất trong tủ bếp', (v) => { const i = find(v.args, 'mi'); return !i ? 'thiếu mì' : has(i.productName, 'goi') ? `tên không được kèm đơn vị: ${i.productName}` : (i.priceVnd ? `không được bịa giá: ${i.priceVnd}` : has(i.storageLocation, 'tu bep') ? null : `nơi cất: ${i.storageLocation}`); });
  await step('C4 không giá, không nơi cất', 'vừa mua 5 quả chanh', (v) => { const i = find(v.args, 'chanh'); return !i ? 'thiếu chanh' : i.priceVnd || i.storageLocation ? 'không được bịa giá/nơi cất' : null; });
  await step('C5 tổng cho nhiều món (mơ hồ)', 'vừa mua 2 ký cam và 1 ký táo hết 150 nghìn', (v) => {
    const total = items(v.args).reduce((s, i) => s + (i.priceVnd ?? 0), 0);
    return total === 0 || total === 150000 ? null : `tổng giá các món phải 0 (mơ hồ) hoặc 150000, có ${total}`; });

  // ── Cách đọc số tiền ────────────────────────────────────────────────
  for (const [text, name, price] of [
    ['vừa mua 1 hộp bơ giá một triệu hai', 'bo', 1200000],
    ['vừa mua 1 con gà giá hai trăm bảy lăm nghìn', 'ga', 275000],
    ['đã mua 1 lọ mật ong ba chục nghìn', 'mat ong', 30000],
    ['mới mua 1 gói cà phê 85 ngàn rưỡi', 'ca phe', 85500],
    ['vừa mua 1 hộp hạt điều giá 120 ngàn', 'hat dieu', 120000],
  ]) await step(`D đọc số tiền: ${price}`, text, (v) => { const i = find(v.args, name); return !i ? `thiếu ${name}` : eq(i.priceVnd, price, 'giá'); });
  await step('D6 đơn giá nhân số lượng', 'mua về 3 chai dầu ăn mỗi chai 45 nghìn', (v) => { const i = find(v.args, 'dau an'); return !i ? 'thiếu dầu ăn' : eq(i.priceVnd, 135000, 'giá'); });
  await step('D7 giá hai món nói liền không "mỗi" là tổng từng món', 'đã mua 2 bó rau muống 12k', (v) => { const i = find(v.args, 'rau muong'); return !i ? 'thiếu rau muống' : eq(i.priceVnd, 12000, 'giá'); });

  // ── Cách nói nơi cất ────────────────────────────────────────────────
  for (const [text, name, want] of [
    ['vừa mua 1 hộp phô mai bỏ vào ngăn mát', 'pho mai', 'ngan mat'],
    ['mua về 1 túi đá viên cất ngăn đông', 'da vien', 'dong'],
    ['mới mua 1 chai dầu gội xếp vào phòng tắm', 'dau goi', 'phong tam'],
    ['đã mua 1 bao gạo 10 ký để dưới gầm bếp', 'gao', 'gam bep'],
  ]) await step(`E nơi cất: ${want}`, text, (v) => { const i = find(v.args, name); return !i ? `thiếu ${name}` : has(i.storageLocation, want) ? null : `nơi cất: ${i.storageLocation}`; });

  // ── Không được nhầm ý định / không bịa ──────────────────────────────
  await step('F1 sẽ mua => danh sách mua, không giá', 'nhớ mua dầu ăn khoảng 50k', (v) =>
    v.toolId === 'shopping.add' ? (JSON.stringify(v.args).includes('priceVnd') ? 'shopping.add không có giá' : null) : `phải là shopping.add, có ${v.toolId}`);
  await step('F2 hỏi tồn kho', 'trong nhà còn gì không', (v) => v.kind === 'read_result' ? null : `phải là read, có ${v.kind}`);
  await step('F3 ngoài phạm vi', 'hôm nay thời tiết thế nào', (v) => v.toolId === 'unknown' ? null : `phải là unknown, có ${v.toolId}`);
  await step('F4 sửa giá đã nhập (chưa hỗ trợ bằng giọng nói)', 'sửa giá thịt lợn thành 300 nghìn', (v) =>
    v.toolId === 'clarify' && has(v.message, 'chua ho tro') ? null : `phải báo "Mình chưa hỗ trợ", có ${v.toolId} ${v.message}`);

  // ── Hỏi chi tiêu và nơi cất ─────────────────────────────────────────
  await step('G1 hỏi chi tiêu tháng này', 'tháng này tôi tiêu hết bao nhiêu tiền', (v) => v.kind === 'read_result' && /\d/.test(v.message) ? null : `phải trả lời số tiền, có ${v.kind}: ${v.message}`);
  await step('G2 hỏi món chưa có giá', 'còn món nào chưa ghi giá không', (v) => v.kind === 'read_result' ? null : `phải là read, có ${v.kind}: ${v.message}`);
  await step('G3 hỏi nơi cất', 'sữa tươi để ở đâu', (v) => v.kind === 'read_result' && has(v.message, 'tu lanh') ? null : `phải nói tủ lạnh, có ${v.kind}: ${v.message}`);

  // ── Chỉ tên là bắt buộc ─────────────────────────────────────────────
  await step('H1 chỉ có tên', 'vừa mua muối', (v) => {
    const i = find(v.args, 'muoi'); if (v.toolId !== 'inventory.add' || !i) return 'phải là inventory.add muối';
    return i.quantity ? `không được bịa số lượng: ${i.quantity}` : i.unit ? `không được bịa đơn vị: ${i.unit}` : null; },
    { confirm: true, after: async () => { const s = await stock('muoi'); return !s ? 'muối không vào kho' : eq(s.quantity, null, 'số lượng') || eq(s.status, 'in_stock', 'trạng thái'); } });
  await step('H2 chỉ tên + đơn vị', 'mới mua một túi bột mì', (v) => { const i = find(v.args, 'bot mi'); return !i ? 'thiếu bột mì' : i.quantity && i.quantity !== 1 ? `số lượng: ${i.quantity}` : null; });

  // ── Hàng đã có: kể hạn của một phần, KHÔNG được cộng thêm ───────────
  await step('I0 nhập 5 gói mì tôm', 'vừa mua 5 gói mì tôm giá 40 nghìn để trong tủ bếp', (v) => {
    const i = find(v.args, 'mi tom'); return !i ? 'thiếu mì tôm' : eq(i.quantity, 5, 'số lượng'); }, { confirm: true, after: async () => { beforeSplit = await spending(); return null; } });
  await step('I1 "có 2 gói sắp hết hạn" (không có ngày) => hỏi lại, không cộng 7', 'có 2 gói mì tôm sắp hết hạn', (v) => {
    if (v.toolId === 'inventory.add') return 'KHÔNG được inventory.add (sẽ thành 7 gói)';
    return v.toolId === 'clarify' ? null : `phải hỏi ngày hạn, có ${v.toolId}`; },
    { after: async () => null });
  await step('I2 "2 gói mì tôm hạn 20 tháng 10" khi kho có 5 => đặt hạn cho 2 gói', 'trong 5 gói mì tôm có 2 gói hạn 20 tháng 10 năm 2026', (v) =>
    v.toolId !== 'inventory.set_expiry' ? `phải là set_expiry, có ${v.toolId}` : eq(v.args.quantity, 2, 'số gói') || eq(v.args.expiryDate, '2026-10-20', 'hạn'),
    { confirm: true, after: async () => { const s = await stock('mi tom'); const sp = await spending();
      return eq(s?.quantity, 5, 'tồn phải vẫn 5') || eq(s?.expiryDate, '2026-10-20', 'hạn gần nhất') || eq(sp.unpricedCount, beforeSplit.unpricedCount, 'tách lô không được thành lần mua mới') || eq(sp.totalVnd, beforeSplit.totalVnd, 'tổng chi tiêu'); } });
  await step('I3 mua thêm mới thì vẫn cộng', 'vừa mua thêm 2 gói mì tôm hạn 30 tháng 11 năm 2026', (v) => {
    const i = find(v.args, 'mi tom'); return v.toolId !== 'inventory.add' || !i ? `phải là inventory.add, có ${v.toolId}` : eq(i.quantity, 2, 'số lượng'); },
    { confirm: true, after: async () => eq((await stock('mi tom'))?.quantity, 7, 'tồn sau khi mua thêm') });
  await step('I4 nhiều hơn tồn kho => hỏi lại', 'trong mì tôm có 20 gói hạn 5 tháng 12 năm 2026', (v) =>
    v.toolId === 'clarify' || v.toolId === 'inventory.add' ? null : `phải hỏi lại hoặc coi là mua mới, có ${v.toolId}`);

  // ── Câu dài nói liền một mạch (ca thật từ máy): nhiều món cùng là mua, KHÔNG được bảo "từng việc một" ──
  const LONG = 'vừa mua được 3 kg thịt lợn với giá 175.000đ hai chai một chai dầu gội một chai sữa tắm một chai dầu xả mỗi chai trung bình có giá 150.000 một chai hạn sử dụng là đến năm 2027 và tháng 9 mua được 3 kg muối với giá là 10.000 một ký hạn sử dụng là một';
  await step('J1 câu dài 5 món, giá riêng, hạn chung tháng 9/2027', LONG, (v) => {
    if (v.toolId !== 'inventory.add') return `phải là inventory.add (một lần nhập nhiều món), có ${v.toolId}: ${v.message ?? ''}`;
    const pork = find(v.args, 'thit lon'), shampoo = find(v.args, 'dau goi'), shower = find(v.args, 'sua tam'), cond = find(v.args, 'dau xa'), salt = find(v.args, 'muoi');
    if (!pork || !shampoo || !shower || !cond || !salt) return `thiếu món, có ${items(v.args).map((i) => i.productName).join(', ')}`;
    if (items(v.args).length !== 5) return `phải đúng 5 món, có ${items(v.args).length}`;
    for (const [n, i, price] of [['thịt lợn', pork, 175000], ['dầu gội', shampoo, 150000], ['sữa tắm', shower, 150000], ['dầu xả', cond, 150000], ['muối', salt, 30000]]) {
      const bad = eq(i.priceVnd, price, `giá ${n}`); if (bad) return bad;
    }
    for (const [n, i] of [['dầu gội', shampoo], ['sữa tắm', shower], ['dầu xả', cond]]) {
      const bad = eq(i.quantity, 1, `số lượng ${n}`) || eq(i.expiryDate, '2027-09-30', `hạn ${n}`); if (bad) return bad;
    }
    return eq(pork.quantity, 3, 'số lượng thịt') || eq(salt.quantity, 3, 'số lượng muối') || (salt.expiryDate ? `hạn muối bị cắt dở phải để trống, có ${salt.expiryDate}` : null);
  }, { confirm: true, after: async () => { const sp = await spending(); const inv = await inventory();
    return eq(sp.totalVnd >= 655000, true, 'tổng chi tiêu tăng ít nhất 655.000') || eq(!!inv.find((i) => has(i.name, 'dau xa')), true, 'dầu xả vào kho'); } });

  // ── Nhiều việc khác loại trong MỘT câu: không được bắt nói từng việc một ──
  const shoppingNames = async () => (await http(`/workspaces/${ws}/shopping-items`)).data.items.map((i) => i.name);
  await step('K1 mua + hết món khác trong một câu', 'vừa mua 2 hộp sữa và 3 quả trứng rồi hết dầu ăn', (v) => {
    if (v.toolId !== 'inventory.add') return `việc 1 phải là inventory.add, có ${v.toolId}: ${v.message ?? ''}`;
    const extra = v.followUps.map((f) => f.toolsProposed[0]).find((t) => ['shopping.add', 'inventory.mark_out'].includes(t.toolId));
    return extra ? (JSON.stringify(extra.arguments).includes('dầu ăn') ? null : 'việc phụ phải nói về dầu ăn') : 'thiếu việc phụ "hết dầu ăn"';
  }, { confirm: true, confirmAll: true, after: async () => {
    const names = await shoppingNames();
    return (await stock('trung')) && (await stock('sua')) ? (names.some((n) => has(n, 'dau an')) ? null : 'dầu ăn phải vào danh sách cần mua') : 'sữa/trứng phải vào kho'; } });
  await step('K2 bỏ món không có trong danh sách: làm phần còn lại và báo rõ', 'vừa mua thịt bò và rau muống, bỏ qua món ớt khỏi danh sách', (v) =>
    v.toolId !== 'inventory.add' ? `phải làm phần mua trước, có ${v.toolId}` : (has(v.message, 'chua xu ly') ? null : `phải báo phần chưa xử lý được: ${v.message}`));
  await step('K3 ăn hết món này + mua món khác', 'ăn hết trứng rồi, vừa mua 1 chục cam', (v) => {
    const all = [v.toolId, ...v.followUps.map((f) => f.toolsProposed[0].toolId)];
    return all.includes('inventory.mark_out') && all.includes('inventory.add') ? null : `phải có mark_out và add, có ${all.join(', ')}`;
  }, { confirm: true, confirmAll: true, after: async () => ((await stock('trung'))?.status === 'out' ? ((await stock('cam')) ? null : 'cam phải vào kho') : 'trứng phải hết') });
  await step('K4 vừa ghi vừa hỏi => làm phần ghi trước, không ghi nửa vời', 'vừa mua 5 quả táo, trong kho còn gì', (v) =>
    v.toolId === 'clarify' && !v.followUps.length ? null : `phải hỏi lại, có ${v.toolId} +${v.followUps.length}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\nKẾT QUẢ: ${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) console.log('FAIL:\n' + failed.map((f) => ` - ${f.id}: ${f.notes[f.notes.length - 1]}`).join('\n'));
  process.exit(failed.length ? 1 : 0);
})();
