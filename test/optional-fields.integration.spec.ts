import { mockEmailAuth, registerVerified, changeVerifiedPassword, changeVerifiedEmail } from './support/email-auth-fixture';
import {deleteFixtureUsers} from './support/delete-fixture-users';
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { DatabaseService } from '../src/database/database.service';
import { AuthService } from '../src/auth/auth.service';
import { ResetDeliveryService } from '../src/auth/reset-delivery.service';
import { MeController } from '../src/me/me.controller';
import { AuthRequest } from '../src/auth/auth.guard';
import { SnapshotService } from '../src/snapshot/snapshot.service';
import { SpendingService } from '../src/spending/spending.service';
import { requireDisposableDatabase } from './disposable-database';

// Chỉ TÊN là bắt buộc khi nhập kho; số lượng, đơn vị, hạn dùng, giá, nơi cất đều tùy chọn.
describe.skipIf(process.env.RUN_DB_TESTS !== '1')('nhập kho chỉ cần tên (DB thật)', () => {
  const db = new DatabaseService(), owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
  const auth = mockEmailAuth(db), me = new MeController(db);
  const snapshots = new SnapshotService(db), spending = new SpendingService(db);
  const users: string[] = [], workspaces: string[] = [], password = randomBytes(24).toString('hex');
  beforeAll(() => requireDisposableDatabase());
  afterAll(async () => {
    await owner.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await deleteFixtureUsers(owner,users);
    await Promise.all([db.$disconnect(), owner.$disconnect()]);
  });
  async function account() {
    const session = await registerVerified(auth,{ acceptedTerms: true, acceptedPrivacy: true, displayName: 'Tùy chọn', email: `opt-${randomUUID()}@example.invalid`, password, workspaceType: 'household' }, {});
    users.push(session.user.id);
    const profile = await me.get({ userId: session.user.id } as AuthRequest);
    workspaces.push(profile.workspaceId);
    return { user: session.user.id, ws: profile.workspaceId };
  }
  const add = (a: { user: string; ws: string }, payload: Record<string, unknown>) => db.operation(a.user, a.ws, randomUUID(), 'inventory.add', payload);
  const ids = (r: Record<string, unknown>, k: 'productIds' | 'lotIds') => (r.created as Record<string, string[]>)[k];
  const item = async (a: { user: string; ws: string }, name: string) => (await snapshots.get(a.user, a.ws)).inventory.find(i => i.name === name);
  async function confirm(a: { user: string; ws: string }, tool: { toolId: string; arguments: Record<string, unknown> }) {
    const turn = randomUUID();
    await owner.$executeRaw`insert into public.assistant_turns(id,workspace_id,user_id,raw_input,kind,tools_json,status,expires_at)
      values(${turn}::uuid,${a.ws}::uuid,${a.user}::uuid,'x','write_draft',${JSON.stringify([tool])}::jsonb,'pending_confirmation',now()+interval '10 minutes')`;
    return db.operation(a.user, a.ws, randomUUID(), 'assistant.confirm', { tools: [tool] }, turn);
  }

  it('chỉ có tên: lưu được, là "có hàng", không bịa số lượng hay đơn vị', async () => {
    const a = await account();
    const r = await add(a, { productName: 'Muối thử' });
    const lot = await owner.inventoryLot.findUniqueOrThrow({ where: { id: ids(r, 'lotIds')[0] } });
    expect([lot.unit, lot.quantityKnown]).toEqual([null, false]);
    expect(await item(a, 'Muối thử')).toMatchObject({ quantity: null, unit: null, status: 'in_stock' });
    const home = (await snapshots.get(a.user, a.ws)).home;
    expect([home.totalProducts, home.inStockCount, home.outCount]).toEqual([1, 1, 0]);
  });

  it('chỉ tên + đơn vị, hoặc chỉ tên + số lượng', async () => {
    const a = await account();
    await add(a, { productName: 'Gạo thử', unit: 'kg' });
    await add(a, { productName: 'Trứng thử', quantity: 6 });
    expect(await item(a, 'Gạo thử')).toMatchObject({ quantity: null, unit: 'kg' });
    expect(await item(a, 'Trứng thử')).toMatchObject({ quantity: 6, unit: null });
  });

  it('sản phẩm chưa có đơn vị nhận đơn vị lần đầu có nói; sau đó không đổi được', async () => {
    const a = await account();
    await add(a, { productName: 'Sữa thử' });
    await add(a, { productName: 'Sữa thử', quantity: 2, unit: 'hộp' });
    expect(await item(a, 'Sữa thử')).toMatchObject({ quantity: null,quantityState:'incompatible_units',quantityBreakdown:[
      {unit:null,knownQuantity:0,unknownLots:1},{unit:'hộp',knownQuantity:2,unknownLots:0},
    ] });
    await add(a, { productName: 'Sữa thử' }); // không nói đơn vị: dùng đơn vị sẵn có
    await expect(add(a, { productName: 'Sữa thử', quantity: 1, unit: 'chai' })).rejects.toThrow();
    expect(await item(a, 'Sữa thử')).toMatchObject({quantity:null,quantityBreakdown:[
      {unit:null,knownQuantity:0,unknownLots:1},{unit:'hộp',knownQuantity:2,unknownLots:1},
    ]}); // subtotal thật không được trình bày thành tổng đầy đủ
  });

  it('số lượng và đơn vị nếu có thì vẫn được kiểm tra', async () => {
    const a = await account();
    for (const bad of [{ quantity: 0 }, { quantity: -1 }, { unit: 'x'.repeat(41) }]) {
      await expect(add(a, { productName: 'Hỏng', ...bad })).rejects.toThrow();
    }
    await expect(add(a, { productName: '   ' })).rejects.toThrow();
    expect(await owner.inventoryLot.count({ where: { workspaceId: a.ws } })).toBe(0);
  });

  it('trừ kho: lô không rõ số lượng bị hết khi "hết hàng", hoặc nhận phần còn thiếu khi trừ một phần', async () => {
    const a = await account();
    const p1 = ids(await add(a, { productName: 'Nấm thử' }), 'productIds')[0];
    await db.operation(a.user, a.ws, randomUUID(), 'inventory.mark_out', { productId: p1 });
    expect(await item(a, 'Nấm thử')).toMatchObject({ status: 'out' });

    const p2 = ids(await add(a, { productName: 'Cà thử', quantity: 2, unit: 'kg' }), 'productIds')[0];
    await add(a, { productName: 'Cà thử' }); // thêm một lô không rõ số lượng
    await db.operation(a.user, a.ws, randomUUID(), 'inventory.mark_out', { productId: p2, quantity: 1 });
    expect((await item(a, 'Cà thử'))).toMatchObject({ quantity: null,quantityState:'mixed',quantityBreakdown:[{unit:'kg',knownQuantity:1,unknownLots:1}], status: 'in_stock' });
    await db.operation(a.user, a.ws, randomUUID(), 'inventory.mark_out', { productId: p2, quantity: 5 }); // quá số đã biết: lô chưa rõ nhận phần thiếu
    expect(await item(a, 'Cà thử')).toMatchObject({ status: 'out' });
    await expect(db.operation(a.user, a.ws, randomUUID(), 'inventory.mark_out', { productId: p2 })).rejects.toThrow(); // hết rồi
  });

  it('nhận hàng từ danh sách mua không cần số lượng hay đơn vị', async () => {
    const a = await account();
    const s = await db.operation(a.user, a.ws, randomUUID(), 'shopping.add', { name: 'Hành thử' });
    const itemId = (s.created as { shoppingItemIds: string[] }).shoppingItemIds[0];
    await db.operation(a.user, a.ws, randomUUID(), 'shopping.receive', { itemId, priceVnd: 10000 });
    expect(await item(a, 'Hành thử')).toMatchObject({ quantity: null, status: 'in_stock' });
    expect((await spending.summary(a.user, a.ws)).totalVnd).toBe(10000);
  });

  it('thông báo chỉ nêu những gì người dùng đã nói', async () => {
    const a = await account();
    await add(a, { productName: 'Ớt thử' });
    const [n] = await owner.$queryRaw<Array<{ summary: string }>>`select summary from public.notification_outbox where recipient_id=${a.user}::uuid and kind='inventory.add' order by occurred_at desc`;
    expect(n.summary).toBe('Đã thêm vào kho: Ớt thử.');
  });

  describe('inventory.set_expiry: đặt hạn cho một phần hàng đã có, không cộng thêm tồn kho', () => {
    it('"5 gói mì, 2 gói sắp hết hạn": tách lô 3 + 2, tổng vẫn 5, giá chia theo tỉ lệ, không thành lần mua mới', async () => {
      const a = await account();
      const r = await add(a, { productName: 'Mì thử', quantity: 5, unit: 'gói', priceVnd: 50000, storageLocation: 'Tủ bếp' });
      const productId = ids(r, 'productIds')[0];
      await confirm(a, { toolId: 'inventory.set_expiry', arguments: { productId, quantity: 2, expiryDate: '2026-10-20' } });
      const lots = await owner.inventoryLot.findMany({ where: { productId }, orderBy: { quantity: 'desc' } });
      expect(lots.map(l => [Number(l.quantity), l.expiryDate?.toISOString().slice(0, 10) ?? null, l.priceVnd, l.storageLocation]))
        .toEqual([[3, null, 30000n, 'Tủ bếp'], [2, '2026-10-20', 20000n, 'Tủ bếp']]);
      expect(lots[0].createdAt.getTime()).toBe(lots[1].createdAt.getTime()); // giữ ngày nhập gốc
      expect(await item(a, 'Mì thử')).toMatchObject({ quantity: 5, expiryDate: '2026-10-20' });
      const s = await spending.summary(a.user, a.ws);
      // Two physical lots retain ONE original purchase identity.
      expect([s.totalVnd, s.pricedCount, s.unpricedCount]).toEqual([50000, 1, 0]);
      expect(s.purchaseCount).toBe(1);
    });

    it('đặt hạn cho cả lô, hoặc toàn bộ khi không nói số lượng', async () => {
      const a = await account();
      const productId = ids(await add(a, { productName: 'Bột thử', quantity: 4, unit: 'gói' }), 'productIds')[0];
      await confirm(a, { toolId: 'inventory.set_expiry', arguments: { productId, expiryDate: '2026-12-01' } });
      const lots = await owner.inventoryLot.findMany({ where: { productId } });
      expect(lots).toHaveLength(1);
      expect(lots[0].expiryDate?.toISOString().slice(0, 10)).toBe('2026-12-01');
    });

    it('từ chối: vượt tồn kho, thiếu ngày, ngày sai, sản phẩm lạ', async () => {
      const a = await account();
      const productId = ids(await add(a, { productName: 'Dầu thử', quantity: 2, unit: 'chai' }), 'productIds')[0];
      for (const args of [{ productId, quantity: 3, expiryDate: '2026-10-20' }, { productId, quantity: 1 }, { productId, expiryDate: '2026-02-30' }, { productId: randomUUID(), expiryDate: '2026-10-20' }]) {
        await expect(confirm(a, { toolId: 'inventory.set_expiry', arguments: args })).rejects.toThrow();
      }
      expect(await owner.inventoryLot.count({ where: { productId } })).toBe(1);
    });
  });
});
