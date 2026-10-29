import { mockEmailAuth, registerVerified, changeVerifiedPassword, changeVerifiedEmail } from './support/email-auth-fixture';
import 'reflect-metadata';
import { deleteFixtureUsers } from './support/delete-fixture-users';
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

describe.skipIf(process.env.RUN_DB_TESTS !== '1')('giá mua, nơi cất và chi tiêu theo tháng (DB thật)', () => {
  const db = new DatabaseService(), owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
  const auth = mockEmailAuth(db), me = new MeController(db);
  const spending = new SpendingService(db), snapshots = new SnapshotService(db);
  const users: string[] = [], workspaces: string[] = [], password = randomBytes(24).toString('hex');
  beforeAll(() => requireDisposableDatabase());
  afterAll(async () => {
    await deleteFixtureUsers(owner,users,workspaces);
    await Promise.all([db.$disconnect(), owner.$disconnect()]);
  });
  async function account() {
    const session = await registerVerified(auth,{ acceptedTerms: true, acceptedPrivacy: true, displayName: 'Chi tiêu thử', email: `spend-${randomUUID()}@example.invalid`, password, workspaceType: 'household' }, {});
    users.push(session.user.id);
    const profile = await me.get({ userId: session.user.id } as AuthRequest);
    workspaces.push(profile.workspaceId);
    return { user: session.user.id, ws: profile.workspaceId };
  }
  const lotOf = (r: Record<string, unknown>, i = 0) => (r.created as { lotIds: string[] }).lotIds[i];
  const outbox = (user: string) => owner.$queryRaw<Array<{ summary: string; detail: string }>>`
    select summary,detail from public.notification_outbox where recipient_id=${user}::uuid and kind='inventory.add' order by occurred_at desc`;

  it('lưu giá và nơi cất khi nhập; tổng tháng chỉ cộng lô có giá và đếm lô chưa có giá', async () => {
    const a = await account();
    const sữa = await db.operation(a.user, a.ws, randomUUID(), 'inventory.add', { productName: 'Sữa thử', quantity: 2, unit: 'hộp', priceVnd: 45000, storageLocation: ' Tủ lạnh ' });
    await db.operation(a.user, a.ws, randomUUID(), 'inventory.add', { productName: 'Gạo thử', quantity: 5, unit: 'kg' });
    const s = await spending.summary(a.user, a.ws);
    expect(s).toMatchObject({ totalVnd: 45000, pricedCount: 1, unpricedCount: 1, previousTotalVnd: 0 });
    expect(s.unpriced.map(x => x.name)).toEqual(['Gạo thử']);
    expect(s.byCategory).toEqual([{ category: null, totalVnd: 45000 }]);
    const lot = await owner.inventoryLot.findUniqueOrThrow({ where: { id: lotOf(sữa) } });
    expect(lot.priceVnd).toBe(45000n);
    expect(lot.storageLocation).toBe('Tủ lạnh');
    const inv = (await snapshots.get(a.user, a.ws)).inventory.find(i => i.name === 'Sữa thử');
    expect(inv?.storageLocation).toBe('Tủ lạnh');
  });

  it('nhập giá sau cho lô chưa có giá; đặt lại cùng giá là idempotent; null xóa giá', async () => {
    const a = await account();
    const r = await db.operation(a.user, a.ws, randomUUID(), 'inventory.add', { productName: 'Trứng thử', quantity: 10, unit: 'quả' });
    const lotId = lotOf(r);
    expect((await spending.summary(a.user, a.ws)).unpricedCount).toBe(1);
    await spending.patchLot(a.user, a.ws, lotId, { priceVnd: 35000, storageLocation: 'Ngăn mát' });
    await spending.patchLot(a.user, a.ws, lotId, { priceVnd: 35000 });
    expect(await spending.summary(a.user, a.ws)).toMatchObject({ totalVnd: 35000, pricedCount: 1, unpricedCount: 0 });
    await spending.patchLot(a.user, a.ws, lotId, { priceVnd: null });
    expect(await spending.summary(a.user, a.ws)).toMatchObject({ totalVnd: 0, unpricedCount: 1 });
    expect((await owner.inventoryLot.findUniqueOrThrow({ where: { id: lotId } })).storageLocation).toBe('Ngăn mát');
  });

  it('giá không hợp lệ làm hỏng cả thao tác (không để lại lô mồ côi)', async () => {
    const a = await account();
    for (const priceVnd of [-1, 1.5, '45000', 100_000_000_001]) {
      await expect(db.operation(a.user, a.ws, randomUUID(), 'inventory.add', { productName: 'Hỏng', quantity: 1, unit: 'cái', priceVnd })).rejects.toThrow();
    }
    expect(await owner.inventoryLot.count({ where: { workspaceId: a.ws } })).toBe(0);
    const r = await db.operation(a.user, a.ws, randomUUID(), 'inventory.add', { productName: 'Tốt', quantity: 1, unit: 'cái' });
    await expect(spending.patchLot(a.user, a.ws, lotOf(r), { storageLocation: 'x'.repeat(61) })).rejects.toThrow();
    await expect(spending.patchLot(a.user, a.ws, lotOf(r), {})).rejects.toThrow();
  });

  it('nhận hàng từ danh sách mua và xác nhận nhiều món qua trợ lý đều ghi giá theo đúng món', async () => {
    const a = await account();
    const added = await db.operation(a.user, a.ws, randomUUID(), 'shopping.add', { name: 'Cà chua thử', quantity: 1, unit: 'kg' });
    const itemId = (added.created as { shoppingItemIds: string[] }).shoppingItemIds[0], key = randomUUID();
    const body = { itemId, quantity: 1, unit: 'kg', priceVnd: 30000, storageLocation: 'Kệ bếp' };
    const first = await db.operation(a.user, a.ws, key, 'shopping.receive', body);
    await db.operation(a.user, a.ws, key, 'shopping.receive', body); // gửi lại: không cộng hai lần
    expect((await owner.inventoryLot.findUniqueOrThrow({ where: { id: lotOf(first) } })).priceVnd).toBe(30000n);
    const turn = randomUUID(), items = [
      { productName: 'Thịt thử', quantity: 1, unit: 'kg', priceVnd: 150000, storageLocation: 'Ngăn đá' },
      { productName: 'Hành thử', quantity: 1, unit: 'bó' },
    ];
    await owner.$executeRaw`insert into public.assistant_turns(id,workspace_id,user_id,raw_input,kind,tools_json,status,expires_at)
      values(${turn}::uuid,${a.ws}::uuid,${a.user}::uuid,'mua thịt và hành','write_draft',${JSON.stringify([{ toolId: 'inventory.add', arguments: { items } }])}::jsonb,'pending_confirmation',now()+interval '10 minutes')`;
    const confirmed = await db.operation(a.user, a.ws, randomUUID(), 'assistant.confirm', { tools: [{ toolId: 'inventory.add', arguments: { items } }] }, turn);
    const lots = await owner.inventoryLot.findMany({ where: { id: { in: (confirmed.created as { lotIds: string[] }).lotIds } } });
    const byProduct = new Map((await owner.product.findMany({ where: { id: { in: lots.map(l => l.productId) } } })).map(p => [p.id, p.name]));
    const priced = Object.fromEntries(lots.map(l => [byProduct.get(l.productId), [l.priceVnd, l.storageLocation]]));
    expect(priced).toEqual({ 'Thịt thử': [150000n, 'Ngăn đá'], 'Hành thử': [null, null] });
    expect(await spending.summary(a.user, a.ws)).toMatchObject({ totalVnd: 180000, pricedCount: 2, unpricedCount: 1 });
  });

  it('thông báo thao tác nêu tổng chi tiêu tháng và món chưa có giá; người chưa dùng giá không bị nhắc', async () => {
    const quiet = await account();
    await db.operation(quiet.user, quiet.ws, randomUUID(), 'inventory.add', { productName: 'Muối thử', quantity: 1, unit: 'gói' });
    expect((await outbox(quiet.user))[0].summary).not.toContain('Chi tiêu');

    const a = await account();
    await db.operation(a.user, a.ws, randomUUID(), 'inventory.add', { productName: 'Bột thử', quantity: 1, unit: 'gói' });
    await db.operation(a.user, a.ws, randomUUID(), 'inventory.add', { productName: 'Dầu thử', quantity: 1, unit: 'chai', priceVnd: 1250000 });
    const [latest] = await outbox(a.user);
    expect(latest.summary).toContain('Chi tiêu tháng');
    expect(latest.summary).toContain('1.250.000 ₫');
    expect(latest.summary).toContain('1 lần mua chưa có giá');
    expect(latest.detail).toContain('Bột thử');
  });

  it('thành viên ngoài không đọc hay sửa được; tháng sai định dạng bị từ chối', async () => {
    const a = await account(), b = await account();
    const r = await db.operation(a.user, a.ws, randomUUID(), 'inventory.add', { productName: 'Riêng tư', quantity: 1, unit: 'cái', priceVnd: 1000 });
    await expect(spending.summary(b.user, a.ws)).rejects.toThrow();
    await expect(spending.patchLot(b.user, a.ws, lotOf(r), { priceVnd: 1 })).rejects.toThrow();
    await expect(spending.patchLot(a.user, a.ws, randomUUID(), { priceVnd: 1 })).rejects.toThrow();
    await expect(spending.summary(a.user, a.ws, '2026-13')).rejects.toThrow();
    expect((await spending.summary(a.user, a.ws, '2020-01')).totalVnd).toBe(0);
  });
});
