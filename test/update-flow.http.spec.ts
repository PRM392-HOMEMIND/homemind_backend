import { installMockEmailAuth, verifyHttpRegistration } from './support/email-auth-fixture';
import 'reflect-metadata';
import { deleteFixtureUsers } from './support/delete-fixture-users';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { PrismaClient } from '@prisma/client';
import type { Plan } from '../src/assistant/planner';
import { todayVietnam } from '../src/common/date';
import { requireDisposableDatabase } from './disposable-database';

describe.skipIf(process.env.RUN_DB_TESTS !== '1')('update integration: real local HTTP, auth and PostgreSQL; mocked AI only', () => {
let emailAuth:any;
   const owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
  const accounts: Array<{ user: string; ws: string; token: string }> = [];
  let app: INestApplication, base: string;
  let schemas: Record<string, any>;
  const plan = vi.fn<(...args: unknown[]) => Promise<Plan>>();

  async function call(path: string, method = 'GET', body?: object, actor = accounts[0], key = randomUUID()) {
    const response = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', 'idempotency-key': key,
        ...(actor ? { Authorization: 'Bearer ' + actor.token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  }
  async function account() {
    const registered = await call('/auth/register', 'POST', { email: `update-${randomUUID()}@example.invalid`,
      password: randomBytes(24).toString('hex'), displayName: 'Owned update fixture', workspaceType: 'household',
      acceptedTerms: true, acceptedPrivacy: true });
    expect(registered.status).toBe(201);
    registered.body=await verifyHttpRegistration(base,emailAuth,registered.body);
    const actor = { user: registered.body.user.id, token: registered.body.accessToken, ws: '' };
    accounts.push(actor);
    actor.ws = (await call('/me', 'GET', undefined, actor)).body.workspaceId;
    return actor;
  }
  const turnBody = (ws: string, text: string) => ({ workspaceId: ws, requestId: randomUUID(),
    locale: 'vi-VN', timezone: 'Asia/Ho_Chi_Minh', clientDate: todayVietnam(), dictionaryVersion: '1.1.0',
    input: { type: 'text', text } });

  beforeAll(async () => {
    requireDisposableDatabase();
    const compiled = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { encoding: 'utf8' });
    if (compiled.status !== 0) throw new Error('Compile backend before HTTP integration');
    const { AppModule } = require('../dist/app.module.js');
    const { AiPlanner } = require('../dist/assistant/planner.js');
    const { ApiErrorFilter } = require('../dist/common/api-error.filter.js');
    app = await NestFactory.create(AppModule, { logger: false });emailAuth=installMockEmailAuth(app);
    app.get(AiPlanner).plan = plan; // no Gemini transport or payment provider is enabled
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new ApiErrorFilter());
    schemas = SwaggerModule.createDocument(app, new DocumentBuilder().build()).components!.schemas!;
    await app.listen(0, '127.0.0.1'); base = (await app.getUrl()) + '/v1';
  }, 20000);
  afterAll(async () => {
    if (app) await app.close();
    await deleteFixtureUsers(owner,accounts.map(a=>a.user),accounts.map(a=>a.ws).filter(Boolean));
    await owner.$disconnect();
  });

  it('documents the new inventory fields and separate confirmation drafts', () => {
    expect(schemas.InventoryItemResponseDto.properties.storageLocation.nullable).toBe(true);
    expect(schemas.InventoryLotResponseDto.properties).toMatchObject({
      priceVnd: { type: 'number', nullable: true }, storageLocation: { nullable: true },
      purchasedAt: { format: 'date-time' },
    });
    expect(schemas.AssistantTurnResponseDto.properties.followUps).toMatchObject({
      type: 'array', items: { $ref: '#/components/schemas/AssistantTurnPayloadDto' },
    });
  });

  it('name-only stock persists null quantity/unit; spending edit is scoped, validated and independently clearable', async () => {
    const a = await account(), b = await account(), prefix = `/workspaces/${a.ws}`;
    const created = await call(prefix + '/inventory/items', 'POST', { productName: 'Muối thử', priceVnd: 45000, storageLocation: ' Kệ bếp ' }, a);
    expect(created.status).toBe(201);
    const lot = created.body.created.lotIds[0], product = created.body.created.productIds[0];
    const detail = await call(prefix + '/inventory/' + product, 'GET', undefined, a);
    expect(detail.body.lots[0]).toMatchObject({ quantity: null, unit: null, priceVnd: 45000, storageLocation: 'Kệ bếp' });
    expect((await call(prefix + '/spending', 'GET', undefined, a)).body).toMatchObject({ totalVnd: 45000, pricedCount: 1, unpricedCount: 0 });
    expect((await fetch(base + prefix + '/spending')).status).toBe(401);
    for (const [path, method, body] of [[prefix + '/spending', 'GET', undefined], [prefix + '/lots/' + lot, 'PATCH', { priceVnd: 1 }]] as const) {
      expect((await call(path, method, body, b)).status).toBe(403);
    }
    for (const body of [{}, { priceVnd: -1 }, { priceVnd: 1.5 }, { priceVnd: '50' }, { priceVnd: 100000000001 }, { storageLocation: 'x'.repeat(61) }, { workspaceId: b.ws, priceVnd: 1 }]) {
      expect.soft((await call(prefix + '/lots/' + lot, 'PATCH', body, a)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await call(prefix + '/lots/' + randomUUID(), 'PATCH', { priceVnd: 1 }, a)).status).toBe(404);
    expect((await call(prefix + '/lots/' + lot, 'PATCH', { priceVnd: null }, a)).status).toBe(200);
    expect((await call(prefix + '/inventory/' + product, 'GET', undefined, a)).body.lots[0]).toMatchObject({ priceVnd: null, storageLocation: 'Kệ bếp' });
    expect((await call(prefix + '/spending', 'GET', undefined, a)).body).toMatchObject({ totalVnd: 0, unpricedCount: 1 });
    for (const month of ['2026-13', '2026-1', '2026-02-01', '0000-01']) {
      expect.soft((await call(prefix + '/spending?month=' + month, 'GET', undefined, a)).status, month).toBe(400);
    }
  });

  it('Vietnam month boundaries and previous-month comparison use purchase timestamps', async () => {
    const a = await account(), prefix = `/workspaces/${a.ws}`;
    for (const [at, amount] of [['2026-09-30T16:59:59Z', 1000], ['2026-09-30T17:00:00Z', 2000], ['2026-10-31T16:59:59Z', 3000], ['2026-10-31T17:00:00Z', 4000]] as const) {
      const result = await call(prefix + '/inventory/items', 'POST', { productName: 'Gạo thử', quantity: 1, unit: 'kg', priceVnd: amount }, a);
      expect(result.status).toBe(201);
      await owner.inventoryLot.update({ where: { id: result.body.created.lotIds[0] }, data: { createdAt: new Date(at) } });
    }
    expect((await call(prefix + '/spending?month=2026-10', 'GET', undefined, a)).body).toMatchObject({ totalVnd: 5000, previousTotalVnd: 1000, pricedCount: 2 });
    expect((await call(prefix + '/spending?month=2026-11', 'GET', undefined, a)).body).toMatchObject({ totalVnd: 4000, previousTotalVnd: 5000 });
  });

  it('multiple actions remain separate drafts; replay creates none, cancel writes none, confirm is exactly once', async () => {
    const a = await account();
    plan.mockResolvedValueOnce({ toolId: 'inventory.add', arguments: { items: [{ productName: 'Trứng thử', quantity: 2, unit: 'quả', priceVnd: 10000 }, { productName: 'Sả thử' }] },
      more: [{ toolId: 'shopping.add', arguments: { items: [{ name: 'Dầu thử' }] } }] });
    const request = turnBody(a.ws, 'Đã mua trứng và sả; cần mua dầu');
    const drafted = await call('/assistant/turn', 'POST', request, a);
    expect(drafted.status).toBe(201); expect(drafted.body.kind).toBe('write_draft');
    expect(drafted.body.followUps).toHaveLength(1);
    expect(await owner.inventoryLot.count({ where: { workspaceId: a.ws } })).toBe(0);
    const callsBefore = plan.mock.calls.length;
    const replay = await call('/assistant/turn', 'POST', request, a);
    expect({...replay.body,voiceQuota:drafted.body.voiceQuota}).toEqual(drafted.body); expect(plan.mock.calls.length).toBe(callsBefore);
    expect(replay.body.voiceQuota).toMatchObject({used:drafted.body.voiceQuota.used,remaining:drafted.body.voiceQuota.remaining,poolWorkspaceId:a.ws});
    expect(await owner.assistantTurn.count({ where: { workspaceId: a.ws } })).toBe(2);
    const follow = drafted.body.followUps[0];
    expect((await call(`/assistant/turns/${follow.turnId}/cancel`, 'POST', undefined, a)).status).toBe(201);
    expect(await owner.shoppingItem.count({ where: { workspaceId: a.ws } })).toBe(0);
    const confirmation = { workspaceId: a.ws, idempotencyKey: randomUUID(), tools: drafted.body.toolsProposed };
    const first = await call(`/assistant/turns/${drafted.body.turnId}/confirm`, 'POST', confirmation, a);
    expect(first.status).toBe(201); expect(first.body.ok).toBe(true);
    expect((await call(`/assistant/turns/${drafted.body.turnId}/confirm`, 'POST', confirmation, a)).body).toEqual(first.body);
    expect(await owner.inventoryLot.count({ where: { workspaceId: a.ws } })).toBe(2);
    expect((await call(`/workspaces/${a.ws}/spending`, 'GET', undefined, a)).body).toMatchObject({ totalVnd: 10000, pricedCount: 1, unpricedCount: 1 });
  });

  it('missing stock becomes a shopping draft; the new spending tool reads the same scoped data', async () => {
    const a = await account();
    plan.mockResolvedValueOnce({ toolId: 'inventory.mark_out', arguments: { productName: 'Dầu mè thử' } });
    const result = await call('/assistant/turn', 'POST', turnBody(a.ws, 'Hết dầu mè thử'), a);
    expect(result.status).toBe(201); expect(result.body.toolsProposed[0].toolId).toBe('shopping.add');
    expect(await owner.shoppingItem.count({ where: { workspaceId: a.ws } })).toBe(0);
    const confirmed = await call(`/assistant/turns/${result.body.turnId}/confirm`, 'POST', { workspaceId: a.ws, idempotencyKey: randomUUID(), tools: result.body.toolsProposed }, a);
    expect(confirmed.status).toBe(201); expect(confirmed.body.ok).toBe(true);
    expect(await owner.shoppingItem.count({ where: { workspaceId: a.ws, status: 'needed' } })).toBe(1);
    plan.mockResolvedValueOnce({ toolId: 'spending.month', arguments: {} });
    const read = await call('/assistant/turn', 'POST', turnBody(a.ws, 'Tháng này chi bao nhiêu'), a);
    expect(read.status).toBe(201); expect(read.body.kind).toBe('read_result'); expect(read.body.data.totalVnd).toBe(0);
  });
});
