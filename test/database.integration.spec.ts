import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseService } from '../src/database/database.service';
import { InventoryService } from '../src/inventory/inventory.service';
import { ShoppingService } from '../src/shopping/shopping.service';
import { SnapshotService } from '../src/snapshot/snapshot.service';
import { PlanGuard } from '../src/billing/plan-guard.service';
import { HomeService } from '../src/home/home.service';
import { AssistantService } from '../src/assistant/assistant.service';
import type { AiPlanner } from '../src/assistant/planner';
import { todayVietnam } from '../src/common/date';
import '../src/config/env';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { deleteFixtureUsers } from './support/delete-fixture-users';

const userA = randomUUID();
const userB = randomUUID();
const run = process.env.RUN_DB_TESTS === '1';

describe.skipIf(!run)('PostgreSQL local RLS và hàm nghiệp vụ', () => {
  const db = new DatabaseService();
  const owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
  let workspaceA: string;
  let workspaceB: string;

  beforeAll(async () => {
    for (const id of [userA, userB]) {
      await db.user.create({ data: { id, email: `hmtest+${id}@example.com`, passwordHash: await argon2.hash(randomUUID(), { type: argon2.argon2id }) } });
      await db.asUser(id, tx => tx.$queryRaw`select public.provision_home(${id}::uuid, 'Database integration', 'household')`);
    }
    workspaceA = (await db.asUser(userA, async (tx) => tx.workspaceMember.findFirstOrThrow({ where: { userId: userA } }))).workspaceId;
    workspaceB = (await db.asUser(userB, async (tx) => tx.workspaceMember.findFirstOrThrow({ where: { userId: userB } }))).workspaceId;
    await db.operation(userA, workspaceA, randomUUID(), 'inventory.add', { productName: 'Sữa chua Vinamilk', quantity: 2, unit: 'hộp' });
  });
  afterAll(async () => {
    await deleteFixtureUsers(owner,[userA,userB],[workspaceA,workspaceB].filter(Boolean));
    await Promise.all([owner.$disconnect(), db.$disconnect()]);
  });

  it('không cho user A đọc workspace B', async () => {
    await expect(db.inWorkspace(userA, workspaceB, async () => true)).rejects.toThrow('FORBIDDEN');
    const rows = await db.asUser(userA, (tx) => tx.product.findMany({ where: { workspaceId: workspaceB } }));
    expect(rows).toHaveLength(0);
    await expect(db.operation(userA, workspaceB, randomUUID(), 'shopping.add', { name: 'Sai workspace' })).rejects.toThrow('FORBIDDEN');
  });

  it('cùng key ghi một lần, khác payload xung đột', async () => {
    const key = randomUUID();
    const payload = { name: `Món test ${key}`, quantity: 2, unit: 'gói' };
    const first = await db.operation(userA, workspaceA, key, 'shopping.add', payload);
    const second = await db.operation(userA, workspaceA, key, 'shopping.add', payload);
    expect(second).toEqual(first);
    await expect(db.operation(userA, workspaceA, key, 'shopping.add', { ...payload, quantity: 3 })).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  });

  it('draft chỉ ghi khi confirm, retry không nhân đôi', async () => {
    const productName = `Sữa test ${randomUUID()}`;
    const tools = [{ toolId: 'inventory.add', arguments: { productName, quantity: 2, unit: 'hộp', expiryDate: null } }];
    const turn = await db.inWorkspace(userA, workspaceA, async (tx) => {
      const admitted = (await tx.$queryRaw<Array<{r:{reservationId:string;leaseId:string}}>>`
        select public.assistant_quota_admit(${workspaceA}::uuid,${randomUUID()}::uuid,'owned-draft-fixture') as r`)[0].r;
      await tx.$queryRaw`select public.assistant_quota_assert_lease(${admitted.reservationId}::uuid,${admitted.leaseId}::uuid)`;
      const rows = await tx.$queryRaw<Array<{ id: string }>>`select public.create_assistant_turn(${workspaceA}::uuid,'thêm sữa','thêm sữa','write_draft',${JSON.stringify(tools)}::jsonb,null::jsonb,${JSON.stringify(tools)}::jsonb,'Kiểm tra bản nháp',1) as id`;
      await tx.$queryRaw`select public.assistant_quota_finish(${admitted.reservationId}::uuid,${admitted.leaseId}::uuid,
        ${JSON.stringify({schemaVersion:'1.0',turnId:rows[0].id,kind:'write_draft'})}::jsonb)`;
      return rows[0].id;
    });
    expect(await db.asUser(userA, (tx) => tx.product.count({ where: { workspaceId: workspaceA, name: productName } }))).toBe(0);
    const key = randomUUID();
    const first = await db.operation(userA, workspaceA, key, 'assistant.confirm', { tools }, turn);
    expect(await db.operation(userA, workspaceA, key, 'assistant.confirm', { tools }, turn)).toEqual(first);
    expect(await db.asUser(userA, (tx) => tx.product.count({ where: { workspaceId: workspaceA, name: productName } }))).toBe(1);
    await expect(db.operation(userB, workspaceB, randomUUID(), 'assistant.confirm', { tools }, turn)).rejects.toThrow();
  });

  it('confirm inventory.add nhiều món: lưu đủ HSD riêng, retry không nhân đôi, một món lỗi thì rollback hết', async () => {
    const tag = randomUUID();
    const items = [
      { productName: `Sữa rửa mặt ${tag}`, quantity: 1, unit: 'chai', expiryDate: '2027-09-01' },
      { productName: `Toner ${tag}`, quantity: 2, unit: 'chai', expiryDate: '2029-01-01' },
      { productName: `Son dưỡng ${tag}`, quantity: 3, unit: 'cây', expiryDate: '2028-06-01' },
    ];
    const makeTurn = (list: unknown[]) => {
      const tools = [{ toolId: 'inventory.add', arguments: { items: list } }];
      return db.inWorkspace(userA, workspaceA, async (tx) => {
        const admitted = (await tx.$queryRaw<Array<{r:{reservationId:string;leaseId:string}}>>`
          select public.assistant_quota_admit(${workspaceA}::uuid,${randomUUID()}::uuid,'batch-draft-fixture') as r`)[0].r;
        await tx.$queryRaw`select public.assistant_quota_assert_lease(${admitted.reservationId}::uuid,${admitted.leaseId}::uuid)`;
        const rows = await tx.$queryRaw<Array<{ id: string }>>`select public.create_assistant_turn(${workspaceA}::uuid,'thêm nhiều','thêm nhiều','write_draft',${JSON.stringify(tools)}::jsonb,null::jsonb,${JSON.stringify(tools)}::jsonb,'Kiểm tra bản nháp',1) as id`;
        await tx.$queryRaw`select public.assistant_quota_finish(${admitted.reservationId}::uuid,${admitted.leaseId}::uuid,
          ${JSON.stringify({schemaVersion:'1.0',turnId:rows[0].id,kind:'write_draft'})}::jsonb)`;
        return { turn: rows[0].id, tools };
      });
    };
    const ok = await makeTurn(items);
    const key = randomUUID();
    const first = await db.operation(userA, workspaceA, key, 'assistant.confirm', { tools: ok.tools }, ok.turn);
    expect(await db.operation(userA, workspaceA, key, 'assistant.confirm', { tools: ok.tools }, ok.turn)).toEqual(first);
    const found = await db.asUser(userA, async (tx) => {
      const products = await tx.product.findMany({ where: { workspaceId: workspaceA, name: { endsWith: tag } } });
      const lots = await tx.inventoryLot.findMany({ where: { workspaceId: workspaceA, productId: { in: products.map((p) => p.id) } } });
      return lots.map((l) => `${products.find((p) => p.id === l.productId)!.name.split(' ')[0]}:${l.expiryDate?.toISOString().slice(0, 10)}`).sort();
    });
    expect(found).toEqual(['Toner:2029-01-01', 'Son:2028-06-01', 'Sữa:2027-09-01'].sort());
    const bad = await makeTurn([{ productName: `Rollback ${tag}`, quantity: 1, unit: 'hộp' }, { productName: `Số lượng sai ${tag}`, quantity: 0, unit: 'hộp' }]); // đơn vị giờ là tùy chọn; số lượng đã nói thì phải hợp lệ
    await expect(db.operation(userA, workspaceA, randomUUID(), 'assistant.confirm', { tools: bad.tools }, bad.turn)).rejects.toThrow();
    expect(await db.asUser(userA, (tx) => tx.product.count({ where: { workspaceId: workspaceA, name: `Rollback ${tag}` } }))).toBe(0);
  });

  it('confirm inventory.add đánh dấu món cùng tên trong danh sách cần mua là đã mua (một món và nhiều món)', async () => {
    const tag = randomUUID();
    const makeTurn = (args: Record<string, unknown>) => {
      const tools = [{ toolId: 'inventory.add', arguments: args }];
      return db.inWorkspace(userA, workspaceA, async (tx) => {
        const admitted = (await tx.$queryRaw<Array<{r:{reservationId:string;leaseId:string}}>>`
          select public.assistant_quota_admit(${workspaceA}::uuid,${randomUUID()}::uuid,'match-draft-fixture') as r`)[0].r;
        await tx.$queryRaw`select public.assistant_quota_assert_lease(${admitted.reservationId}::uuid,${admitted.leaseId}::uuid)`;
        const rows = await tx.$queryRaw<Array<{ id: string }>>`select public.create_assistant_turn(${workspaceA}::uuid,'đã mua','đã mua','write_draft',${JSON.stringify(tools)}::jsonb,null::jsonb,${JSON.stringify(tools)}::jsonb,'Kiểm tra bản nháp',1) as id`;
        await tx.$queryRaw`select public.assistant_quota_finish(${admitted.reservationId}::uuid,${admitted.leaseId}::uuid,
          ${JSON.stringify({schemaVersion:'1.0',turnId:rows[0].id,kind:'write_draft'})}::jsonb)`;
        return { turn: rows[0].id, tools };
      });
    };
    const status = (name: string) => db.asUser(userA, (tx) => tx.shoppingItem.findMany({ where: { workspaceId: workspaceA, name: { equals: name, mode: 'insensitive' } }, orderBy: { createdAt: 'asc' } }).then((r) => r.map((i) => i.status)));
    await db.operation(userA, workspaceA, randomUUID(), 'shopping.add', { items: [{ name: `Sả ${tag}`, quantity: null, unit: null }, { name: `Chanh ${tag}`, quantity: null, unit: null }, { name: `Giữ lại ${tag}`, quantity: null, unit: null }] });
    const single = await makeTurn({ productName: `sả ${tag}`, quantity: 0.5, unit: 'kg', expiryDate: null });
    const key = randomUUID();
    await db.operation(userA, workspaceA, key, 'assistant.confirm', { tools: single.tools }, single.turn);
    expect(await status(`Sả ${tag}`)).toEqual(['bought']);
    expect(await status(`Giữ lại ${tag}`)).toEqual(['needed']);
    // Retry cùng key không đánh dấu nhầm món cùng tên được thêm sau đó.
    await db.operation(userA, workspaceA, randomUUID(), 'shopping.add', { name: `Sả ${tag}`, quantity: null, unit: null });
    await db.operation(userA, workspaceA, key, 'assistant.confirm', { tools: single.tools }, single.turn);
    expect(await status(`Sả ${tag}`)).toEqual(['bought', 'needed']);
    const batch = await makeTurn({ items: [{ productName: `Chanh ${tag}`, quantity: 3, unit: 'quả', expiryDate: null }, { productName: `Ớt ${tag}`, quantity: 1, unit: 'kg', expiryDate: null }] });
    await db.operation(userA, workspaceA, randomUUID(), 'assistant.confirm', { tools: batch.tools }, batch.turn);
    expect(await status(`Chanh ${tag}`)).toEqual(['bought']);
  });

  it('confirm shopping.skip: bỏ qua đúng món trong bản nháp, retry không lặp, không đảo món đã mua, không thêm món lạ', async () => {
    const tag = randomUUID();
    const added = await db.operation(userA, workspaceA, randomUUID(), 'shopping.add', { items: ['ớt', 'chanh', 'sả', 'khác'].map((n) => ({ name: `${n} ${tag}`, quantity: null, unit: null })) });
    const ids = (added.created as { shoppingItemIds: string[] }).shoppingItemIds;
    const [ot, chanh, sa, khac] = ids;
    const makeTurn = (picked: string[]) => {
      const tools = [{ toolId: 'shopping.skip', arguments: { items: picked.map((itemId) => ({ itemId, name: itemId })) } }];
      return db.inWorkspace(userA, workspaceA, async (tx) => {
        const admitted = (await tx.$queryRaw<Array<{r:{reservationId:string;leaseId:string}}>>`
          select public.assistant_quota_admit(${workspaceA}::uuid,${randomUUID()}::uuid,'skip-draft-fixture') as r`)[0].r;
        await tx.$queryRaw`select public.assistant_quota_assert_lease(${admitted.reservationId}::uuid,${admitted.leaseId}::uuid)`;
        const rows = await tx.$queryRaw<Array<{ id: string }>>`select public.create_assistant_turn(${workspaceA}::uuid,'bỏ qua','bỏ qua','write_draft',${JSON.stringify(tools)}::jsonb,null::jsonb,${JSON.stringify(tools)}::jsonb,'Kiểm tra bản nháp',1) as id`;
        await tx.$queryRaw`select public.assistant_quota_finish(${admitted.reservationId}::uuid,${admitted.leaseId}::uuid,
          ${JSON.stringify({schemaVersion:'1.0',turnId:rows[0].id,kind:'write_draft'})}::jsonb)`;
        return { turn: rows[0].id, tools };
      });
    };
    const status = (id: string) => db.asUser(userA, (tx) => tx.shoppingItem.findUniqueOrThrow({ where: { id } }).then((r) => r.status));
    // Một món đã được mua từ lúc tạo bản nháp: giữ nguyên "đã mua".
    await db.operation(userA, workspaceA, randomUUID(), 'shopping.patch', { itemId: sa, status: 'bought' });
    const draft = await makeTurn([ot, chanh, sa]);
    const key = randomUUID();
    const first = await db.operation(userA, workspaceA, key, 'assistant.confirm', { tools: draft.tools }, draft.turn);
    expect(await db.operation(userA, workspaceA, key, 'assistant.confirm', { tools: draft.tools }, draft.turn)).toEqual(first);
    expect(await status(ot)).toBe('skipped');
    expect(await status(chanh)).toBe('skipped');
    expect(await status(sa)).toBe('bought');
    expect(await status(khac)).toBe('needed');
    // Client không được thêm món ngoài bản nháp.
    const draft2 = await makeTurn([khac]);
    const forged = [{ toolId: 'shopping.skip', arguments: { items: [{ itemId: khac, name: 'x' }, { itemId: sa, name: 'y' }] } }];
    await expect(db.operation(userA, workspaceA, randomUUID(), 'assistant.confirm', { tools: forged }, draft2.turn)).rejects.toThrow();
    expect(await status(khac)).toBe('needed');
  });

  it('thông báo của thao tác ghi nêu rõ món và số lượng (không còn "Thao tác của bạn đã được lưu")', async () => {
    const tag = randomUUID().slice(0, 8);
    const summaryOf = async (key: string) => (await owner.$queryRaw<Array<{ summary: string }>>`
      select summary from public.notification_outbox where event_key like ${'operation:v1:%:' + key} limit 1`)[0]?.summary;
    const k1 = randomUUID();
    await db.operation(userA, workspaceA, k1, 'inventory.add', { productName: `Sả ${tag}`, quantity: 0.5, unit: 'kg' });
    expect(await summaryOf(k1)).toBe(`Đã thêm vào kho: 0.5 kg Sả ${tag}.`);
    const k2 = randomUUID();
    const shop = await db.operation(userA, workspaceA, k2, 'shopping.add', { items: [{ name: `Chanh ${tag}`, quantity: 3, unit: 'quả' }, { name: `Ớt ${tag}`, quantity: null, unit: null }] });
    expect(await summaryOf(k2)).toBe(`Đã thêm vào danh sách cần mua: 3 quả Chanh ${tag}, Ớt ${tag}.`);
    const itemId = (shop.created as { shoppingItemIds: string[] }).shoppingItemIds[0];
    const k3 = randomUUID();
    await db.operation(userA, workspaceA, k3, 'shopping.patch', { itemId, status: 'skipped' });
    expect(await summaryOf(k3)).toBe(`Đã bỏ qua Chanh ${tag}.`);
  });

  it('thao tác nhiều món rollback toàn bộ nếu một món không hợp lệ', async () => {
    const name = `Không được lưu ${randomUUID()}`;
    await expect(db.operation(userA, workspaceA, randomUUID(), 'shopping.add', {
      items: [{ name, quantity: 1, unit: 'gói' }, { name: '', quantity: 1, unit: 'gói' }],
    })).rejects.toThrow('VALIDATION_ERROR');
    expect(await db.asUser(userA, (tx) => tx.shoppingItem.count({ where: { workspaceId: workspaceA, name } }))).toBe(0);
  });

  it('mark-out nhiều lô tạo đủ ledger và đưa trạng thái về out', async () => {
    const productName = `Lô test ${randomUUID()}`;
    const first = await db.operation(userA, workspaceA, randomUUID(), 'inventory.add', { productName, quantity: 2, unit: 'hộp', expiryDate: '2026-10-05' });
    const productId = ((first.created as { productIds: string[] }).productIds)[0];
    await db.operation(userA, workspaceA, randomUUID(), 'inventory.add', { productName, quantity: 3, unit: 'hộp', expiryDate: '2026-10-10' });
    const out = await db.operation(userA, workspaceA, randomUUID(), 'inventory.mark_out', { productId, quantity: null, addToShoppingList: true });
    expect((out.created as { transactionIds: string[] }).transactionIds).toHaveLength(2);
    expect((out.created as { shoppingItemIds: string[] }).shoppingItemIds).toHaveLength(1);
    const product = await db.asUser(userA, (tx) => tx.product.findUniqueOrThrow({ where: { id: productId } }));
    expect(product.status).toBe('out');
    const lots = await db.asUser(userA, (tx) => tx.inventoryLot.findMany({ where: { workspaceId: workspaceA, productId } }));
    expect(lots.every((lot) => Number(lot.quantity) === 0)).toBe(true);
  });

  it('hai confirm đồng thời chỉ tạo một lần ghi', async () => {
    const name = `Đồng thời ${randomUUID()}`;
    const tools = [{ toolId: 'shopping.add', arguments: { items: [{ name, quantity: 1, unit: 'gói' }] } }];
    const turn = await db.inWorkspace(userA, workspaceA, async (tx) => {
      const admitted = (await tx.$queryRaw<Array<{r:{reservationId:string;leaseId:string}}>>`
        select public.assistant_quota_admit(${workspaceA}::uuid,${randomUUID()}::uuid,'owned-draft-fixture') as r`)[0].r;
      await tx.$queryRaw`select public.assistant_quota_assert_lease(${admitted.reservationId}::uuid,${admitted.leaseId}::uuid)`;
      const rows = await tx.$queryRaw<Array<{ id: string }>>`select public.create_assistant_turn(${workspaceA}::uuid,'nhớ mua','nhớ mua','write_draft',${JSON.stringify(tools)}::jsonb,null::jsonb,${JSON.stringify(tools)}::jsonb,'Kiểm tra',1) as id`;
      await tx.$queryRaw`select public.assistant_quota_finish(${admitted.reservationId}::uuid,${admitted.leaseId}::uuid,
        ${JSON.stringify({schemaVersion:'1.0',turnId:rows[0].id,kind:'write_draft'})}::jsonb)`;
      return rows[0].id;
    });
    const key = randomUUID();
    const [first, second] = await Promise.all([
      db.operation(userA, workspaceA, key, 'assistant.confirm', { tools }, turn),
      db.operation(userA, workspaceA, key, 'assistant.confirm', { tools }, turn),
    ]);
    expect(second).toEqual(first);
    expect(await db.asUser(userA, (tx) => tx.shoppingItem.count({ where: { workspaceId: workspaceA, name } }))).toBe(1);
  });

  it('assistant read lấy dữ liệu thật trong workspace', async () => {
    const snapshots = new SnapshotService(db);
    const inventory = new InventoryService(db, snapshots);
    const shopping = new ShoppingService(db, snapshots);
    const home = new HomeService(db, inventory, shopping, snapshots);
    const planner = { plan: async () => ({ toolId: 'inventory.list', arguments: {} }) } as unknown as AiPlanner;
    const assistant = new AssistantService(db, inventory, shopping, home, planner, snapshots, new PlanGuard(snapshots));
    const result = await assistant.turn(userA, { requestId: randomUUID(), workspaceId: workspaceA, locale: 'vi-VN', clientDate: todayVietnam(),
      timezone: 'Asia/Ho_Chi_Minh', dictionaryVersion: '1.1.0', input: { type: 'text', text: 'Trong nhà còn gì?' } });
    expect(result.kind).toBe('read_result');
    const data = 'data' in result ? result.data : null;
    expect(data?.toolId).toBe('inventory.list');
    expect((data?.items as Array<{ name: string }>).some((item) => item.name === 'Sữa chua Vinamilk')).toBe(true);
  });
});
