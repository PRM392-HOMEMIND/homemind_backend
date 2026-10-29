import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { DatabaseService, UserTx } from '../database/database.service';
import { InventoryService } from '../inventory/inventory.service';
import { ShoppingService } from '../shopping/shopping.service';
import { HomeService } from '../home/home.service';
import { SnapshotService } from '../snapshot/snapshot.service';
import { PlanGuard } from '../billing/plan-guard.service';
import { AssistantTurnDto, ConfirmDto } from '../common/dto';
import { AiPlanner, isRead, isWrite, Plan } from './planner';
import { todayVietnam } from '../common/date';
import { bestMatch, matchScore, rankCandidates } from './product-match';
import { reconcileUnits } from './unit-reconcile';
import { resolveSkip } from './skip-resolve';
import { canonicalizeNames } from './name-canonical';
import { phoneticNormalize } from './vi-phonetic';
import { buildReadMessage } from './read-message';
import { matchesCategoryTerm } from './product-groups';
import { createHash } from 'node:crypto';
import { environment } from '../config/env';
type AssistantResult = { kind: string; data?: Record<string, unknown> | null; [key: string]: unknown };

@Injectable()
export class AssistantService {
  private readonly calls = new Map<string, number[]>();
  private activeRequests=0;
  private readonly maxConcurrent=environment().assistantMaxConcurrency;
  concurrencySnapshot(){return {active:this.activeRequests,max:this.maxConcurrent};}
  private checkCancellation(signal?:AbortSignal){if(signal?.aborted)throw new HttpException({code:'REQUEST_CANCELLED',message:'Yêu cầu đã được hủy.'},408);}
  constructor(private readonly db: DatabaseService, private readonly inventory: InventoryService,
    private readonly shopping: ShoppingService, private readonly home: HomeService, private readonly planner: AiPlanner,
    private readonly snapshots: SnapshotService, private readonly guard: PlanGuard) {}

  private limit(userId: string, workspaceId: string): void {
    const key = `${userId}:${workspaceId}`;
    const now = Date.now();
    const recent = (this.calls.get(key) ?? []).filter((time) => now - time < 60000);
    if (recent.length >= 20) throw new HttpException('Bạn đã gửi quá nhiều yêu cầu. Vui lòng thử lại sau.', HttpStatus.TOO_MANY_REQUESTS);
    if(!this.calls.has(key)&&this.calls.size>=2000)this.calls.delete(this.calls.keys().next().value!);
    recent.push(now); this.calls.set(key, recent);
  }

  private async readIn(tx: UserTx, workspaceId: string, plan: Plan): Promise<Record<string, unknown>> {
    const args = plan.arguments;
    if (plan.toolId === 'inventory.list') {
      const limit = typeof args.limit === 'number' ? Math.min(Math.max(args.limit, 1), 50) : 50;
      const term = typeof args.category === 'string' && args.category.trim() ? args.category : undefined;
      // Câu hỏi theo nhóm ("có đồ uống nào không?"): lọc theo danh mục lẫn nhóm đoán từ tên,
      // vì nhiều sản phẩm chưa có danh mục.
      const query = typeof args.query === 'string' && args.query.trim() ? args.query.trim() : undefined;
      const status = typeof args.status === 'string' ? args.status : undefined;
      let value = await this.inventory.listIn(tx, workspaceId, { q: query, status, limit: term ? 500 : limit });
      if (query && !value.items.length) {
        // Không thấy theo chữ: thử khớp theo âm (nghe nhầm "sả" thành "xả", "trứng" thành "chứng").
        const all = await this.inventory.listIn(tx, workspaceId, { status, limit: 500 });
        const key = phoneticNormalize(query);
        const items = all.items.filter((i) => phoneticNormalize(i.name).includes(key));
        value = { items: items.slice(0, limit), total: items.length };
      }
      if (!term) return { toolId: plan.toolId, ...value };
      const matched = value.items.filter((item) => matchesCategoryTerm(item, term));
      return { toolId: plan.toolId, items: matched.slice(0, limit), total: matched.length };
    }
    if (plan.toolId === 'inventory.expiring') return this.inventory.expiringIn(tx, workspaceId, String(args.range), args.includeExpired === true);
    if (plan.toolId === 'shopping.list') return { toolId: plan.toolId, ...await this.shopping.listIn(tx, workspaceId,
      typeof args.status === 'string' ? args.status : 'needed', args.includeSuggestions === true) };
    if (plan.toolId === 'spending.month') {
      const month = typeof args.month === 'string' ? args.month : todayVietnam().slice(0, 7);
      const rows = await tx.$queryRaw<Array<{ result: Record<string, unknown> | null }>>`
        select public.spending_summary(${workspaceId}::uuid, ${`${month}-01`}::date) as result`;
      if (!rows[0]?.result) throw new Error('FORBIDDEN');
      return { toolId: plan.toolId, ...rows[0].result };
    }
    if (plan.toolId === 'home.summary') {
      const summary = await this.home.summaryIn(tx, workspaceId);
      // Cùng ngưỡng "sắp hết hạn" (30 ngày) với màn Tủ đồ và Trang chủ trong app.
      const inventory = await this.inventory.listIn(tx, workspaceId, { limit: 500 });
      const soon = inventory.items.filter((i) => i.status !== 'out' && ['urgent', 'soon', 'attention'].includes(i.expiryLevel)).length;
      return { ...summary, expiringSoonCount: soon };
    }
    throw new Error('VALIDATION_ERROR');
  }

  async turn(userId: string, body: AssistantTurnDto,signal?:AbortSignal) {
    this.checkCancellation(signal);
    if(this.activeRequests>=this.maxConcurrent)throw new HttpException({code:'AI_CAPACITY_BUSY',message:'Trợ lý đang bận. Vui lòng thử lại sau.',details:{retryAfterSeconds:1}},503);
    this.activeRequests++;
    try {
    const hash = createHash('sha256').update(JSON.stringify({ workspaceId: body.workspaceId,
      locale: body.locale, clientDate: body.clientDate, timezone: body.timezone,
      dictionaryVersion: body.dictionaryVersion, input: body.input })).digest('hex');
    const rows = await this.db.asUser(userId, tx => tx.$queryRaw<Array<{ result: {
      replay?: AssistantResult; exhausted?: boolean; quota: Record<string, unknown>;
      reservationId: string; leaseId: string;
    } }>>`select public.assistant_quota_admit(${body.workspaceId}::uuid,${body.requestId}::uuid,${hash}) as result`);
    const admission = rows[0].result;
    if (admission.replay) return admission.replay;
    if (admission.exhausted) throw new HttpException({ code: 'VOICE_QUOTA_EXHAUSTED',
      message: 'Gói đang dùng đã hết lượt trợ lý trong kỳ này.', details: admission.quota }, HttpStatus.TOO_MANY_REQUESTS);
    try {
      return await this.generate(userId, body, admission.reservationId, admission.leaseId,signal);
    } catch (error) {
      // Release only this lease; never conceal the original planner/application error.
      try { await this.db.asUser(userId, tx => tx.$queryRaw`
        select public.assistant_quota_finish(${admission.reservationId}::uuid,${admission.leaseId}::uuid,null::jsonb)`); }
      catch { /* Expired/fenced leases are reclaimed by admission, without charging. */ }
      throw error;
    }
    } finally {this.activeRequests--;}
  }

  private async generate(userId: string, body: AssistantTurnDto, reservationId: string, leaseId: string,signal?:AbortSignal) {
    const started = Date.now();
    console.log(JSON.stringify({ event: 'assistant_request', stage: 'received', inputType: body.input.type }));
    const raw = body.input.text.trim();
    if (!raw) throw new Error('VALIDATION_ERROR');
    // U+FFFD = văn bản đã bị hỏng mã hoá trên đường gửi; không lưu chữ lỗi vào dữ liệu.
    if (raw.includes('�')) throw new HttpException('Câu nói bị lỗi font chữ khi gửi lên. Bạn thử nói hoặc gõ lại nhé.', HttpStatus.BAD_REQUEST);
    const dateDelta = Math.abs(Date.parse(body.clientDate) - Date.parse(todayVietnam()));
    if (!Number.isFinite(dateDelta) || dateDelta > 86400000) throw new Error('VALIDATION_ERROR');
    this.limit(userId, body.workspaceId);
    // Danh mục sản phẩm lấy từ snapshot có cache (không tốn ~8 vòng đi về DB như trước).
    const products = (await this.snapshots.get(userId, body.workspaceId)).products.map((p) => ({ id: p.id, name: p.name, defaultUnit: p.unit }));
    const catalog = products.map((item) => ({ id: item.id, name: item.name, unit: item.defaultUnit }));
    // Gửi cho AI những sản phẩm liên quan nhất tới câu nói, không phải N sản phẩm mới cập nhật.
    const candidates = rankCandidates(raw, catalog, 15);
    this.checkCancellation(signal);
    const planned = await this.planner.plan(raw, candidates, body.clientDate,signal);
    this.checkCancellation(signal);
    let plan = await this.refine(userId, body, catalog, raw, planned);
    // Nhiều việc ghi trong một câu: mỗi việc là một bản nháp riêng, người dùng duyệt lần lượt (mỗi bản vẫn ghi nguyên tử).
    const extras: Plan[] = [];
    const notes: string[] = [];
    if (planned.more?.length) {
      const refined = [plan, ...(await Promise.all(planned.more.map((m) => this.refine(userId, body, catalog, raw, m))))];
      for (const item of refined) if (item.toolId === 'clarify' && item.arguments.question) notes.push(String(item.arguments.question));
      const drafts = refined.filter((p) => isWrite(p.toolId));
      if (drafts.length) { plan = drafts[0]; extras.push(...drafts.slice(1)); }
    }
    const kind = isRead(plan.toolId) ? 'read_result' : isWrite(plan.toolId) ? 'write_draft' : plan.toolId;
    console.log(JSON.stringify({ event: 'assistant_request', stage: 'tool_routing', toolId: plan.toolId, kind }));
    return this.db.inWorkspace(userId, body.workspaceId, async (tx) => {
      this.checkCancellation(signal);
      // Fence before creating a turn; a delayed old worker cannot persist an orphan draft.
      await tx.$queryRaw`select public.assistant_quota_assert_lease(${reservationId}::uuid,${leaseId}::uuid)`;
      const data = isRead(plan.toolId) ? await this.readIn(tx, body.workspaceId, plan) : null;
      const message = kind === 'read_result'
        ? this.readMessage(plan, data!)
        : kind === 'write_draft' ? 'Đã tạo bản nháp. Vui lòng kiểm tra và xác nhận trước khi lưu.'
          : kind === 'clarify' ? String(plan.arguments.question ?? 'Bạn có thể nói rõ hơn không?')
            : 'HomeMind chỉ hỗ trợ quản lý tồn kho, hạn sử dụng và danh sách mua sắm.';
      const tools = [{ toolId: plan.toolId, arguments: plan.arguments }];
      const ms = Date.now() - started;
      const rows = await tx.$queryRaw<Array<{ id: string }>>`select public.create_assistant_turn(${body.workspaceId}::uuid,${raw},${raw},${kind},${JSON.stringify(tools)}::jsonb,${data ? JSON.stringify(data) : null}::jsonb,${kind === 'write_draft' ? JSON.stringify(tools) : null}::jsonb,${message},${ms}::int) as id`;
      const followUps: Array<Record<string, unknown>> = [];
      for (const extra of extras) {
        const extraTools = [{ toolId: extra.toolId, arguments: extra.arguments }];
        const extraMessage = 'Đã tạo bản nháp. Vui lòng kiểm tra và xác nhận trước khi lưu.';
        const extraRows = await tx.$queryRaw<Array<{ id: string }>>`select public.create_assistant_turn(${body.workspaceId}::uuid,${raw},${raw},${'write_draft'},${JSON.stringify(extraTools)}::jsonb,${null}::jsonb,${JSON.stringify(extraTools)}::jsonb,${extraMessage},${ms}::int) as id`;
        followUps.push({ schemaVersion: '1.0', turnId: extraRows[0].id, kind: 'write_draft', dictionaryVersion: '1.1.0', correctedInput: raw,
          processingTimeMs: ms, requiresConfirmation: true, toolsProposed: extraTools, message: extraMessage, warnings: [] });
      }
      const response = {
        schemaVersion: '1.0', turnId: rows[0].id, kind, dictionaryVersion: '1.1.0', correctedInput: raw,
        processingTimeMs: ms, ...(kind === 'write_draft' ? { requiresConfirmation: true, toolsProposed: tools } : { toolsUsed: tools, data }),
        ...(followUps.length ? { followUps } : {}),
        message: notes.length && kind === 'write_draft' ? `${message} Mình chưa xử lý được: ${notes.join(' ')}` : message, warnings: [],
      };
      const committed = await tx.$queryRaw<Array<{ result: AssistantResult }>>`
        select public.assistant_quota_finish(${reservationId}::uuid,${leaseId}::uuid,${JSON.stringify(response)}::jsonb) as result`;
      return committed[0].result;
    });
  }

  /** Đối chiếu một việc do AI đề xuất với kho/danh sách mua thật; có thể đổi thành clarify nếu mơ hồ. */
  private async refine(userId: string, body: AssistantTurnDto, catalog: Array<{ id: string; name: string; unit: string | null }>, raw: string, first: Plan): Promise<Plan> {
    let plan = first;
    if (plan.toolId === 'inventory.mark_out' || plan.toolId === 'inventory.set_expiry') {
      const chosen = catalog.find((item) => item.id === plan.arguments.productId);
      const matched = bestMatch(raw, catalog);
      if (matched && (!chosen || (matched.id !== chosen.id && matchScore(raw, matched.name) > matchScore(raw, chosen.name)))) {
        plan = { ...plan, arguments: { ...plan.arguments, productId: matched.id, productName: matched.name } };
      } else if (!chosen && plan.toolId === 'inventory.mark_out' && typeof plan.arguments.productName === 'string' && plan.arguments.productName.trim()) {
        // "Hết dầu ăn" mà kho không có món nào tên như vậy: người dùng cần mua nó (cùng quy tắc với lời hướng dẫn cho AI).
        plan = { toolId: 'shopping.add', arguments: { items: [{ name: plan.arguments.productName.trim(), quantity: null, unit: null }] } };
      } else if (!chosen) {
        plan = { toolId: 'clarify', arguments: { question: plan.toolId === 'inventory.set_expiry' ? 'Bạn muốn đặt hạn cho sản phẩm nào trong kho?' : 'Bạn muốn đánh dấu hết sản phẩm nào trong kho?' } };
      } else if (plan.arguments.productName !== chosen.name) {
        plan = { ...plan, arguments: { ...plan.arguments, productName: chosen.name } };
      }
    }
    if (plan.toolId === 'inventory.set_expiry' && typeof plan.arguments.quantity === 'number') {
      const item = (await this.snapshots.get(userId, body.workspaceId)).inventory.find((i) => i.productId === plan.arguments.productId);
      if (item?.quantity != null && plan.arguments.quantity > item.quantity) {
        plan = { toolId: 'clarify', arguments: { question: `Kho chỉ đang ghi ${item.quantity}${item.unit ? ` ${item.unit}` : ''} ${item.name}, ít hơn số bạn vừa nói. Có bao nhiêu trong số đó có hạn này?` } };
      }
    }
    if (plan.toolId === 'inventory.mark_out' && typeof plan.arguments.remainingQuantity === 'number') {
      plan = await this.fromRemaining(userId, body.workspaceId, plan);
    }
    if (plan.toolId === 'shopping.add' || plan.toolId === 'inventory.add' || plan.toolId === 'shopping.skip') {
      const needed = (await this.db.inWorkspace(userId, body.workspaceId, (tx) => this.shopping.listIn(tx, body.workspaceId, 'needed', false))).items;
      // Nhận giọng nói hay nghe nhầm âm đầu (sả/xả): ưu tiên tên món đã có trong kho và danh sách mua.
      plan = canonicalizeNames(plan, [...catalog.map((c) => c.name), ...needed.map((n) => n.name)]);
      if (plan.toolId === 'shopping.skip') plan = resolveSkip(plan, needed);
    }
    plan = reconcileUnits(plan, catalog);
    if (plan.toolId === 'inventory.add' && plan.arguments.productCandidateId
      && !catalog.some((item) => item.id === plan.arguments.productCandidateId)) {
      const { productCandidateId: _ignored, ...rest } = plan.arguments;
      plan = { ...plan, arguments: rest };
    }
    return plan;
  }

  /** "Chỉ còn nửa ký": số đã dùng = tồn kho - còn lại. Mâu thuẫn với tồn kho thì hỏi lại, không tự đoán. */
  private async fromRemaining(userId: string, workspaceId: string, plan: Plan): Promise<Plan> {
    const { remainingQuantity, ...rest } = plan.arguments;
    const remaining = remainingQuantity as number;
    const item = (await this.snapshots.get(userId, workspaceId)).inventory.find((i) => i.productId === rest.productId);
    if (!item || item.status !== 'in_stock' || item.quantity === null) return { toolId: 'clarify', arguments: { question: `Trong kho hiện không còn ${String(rest.productName ?? 'món này')}.` } };
    const unit = item.unit ? ` ${item.unit}` : '';
    const clean = (n: number) => String(Math.round(n * 1000) / 1000);
    if (remaining >= item.quantity) {
      return { toolId: 'clarify', arguments: { question: `Kho đang ghi còn ${clean(item.quantity)}${unit} ${item.name}, bằng hoặc ít hơn số bạn vừa nói. Bạn đã dùng bao nhiêu, hoặc còn lại chính xác bao nhiêu?` } };
    }
    const used = remaining <= 0 ? null : Math.round((item.quantity - remaining) * 1000) / 1000;
    const note = used === null ? `Còn 0, đánh dấu hết ${item.name}.` : `Kho đang ghi ${clean(item.quantity)}${unit}, còn ${clean(remaining)}${unit} nên trừ ${clean(used)}${unit}.`;
    const warnings = [...(Array.isArray(rest.warnings) ? rest.warnings as string[] : []), note];
    return { ...plan, arguments: { ...rest, quantity: used, warnings } };
  }

  private readMessage(plan: Plan, data: Record<string, unknown>): string {
    return buildReadMessage(plan.toolId, plan.arguments, data, todayVietnam());
  }

  async confirm(userId: string, turnId: string, body: ConfirmDto) {
    const tool = body.tools[0];
    if (tool?.toolId === 'inventory.add') {
      const args = tool.arguments as { items?: unknown; productName?: unknown; productCandidateId?: unknown };
      const entries = Array.isArray(args.items) ? args.items as Array<{ productName?: unknown; productCandidateId?: unknown }> : [args];
      // Khống chế theo từng món; trigger DB vẫn là hàng rào cuối cùng cho cả loạt.
      for (const entry of entries) await this.guard.assertCanAddProduct(userId, body.workspaceId, {
        productName: typeof entry?.productName === 'string' ? entry.productName : null,
        productCandidateId: typeof entry?.productCandidateId === 'string' ? entry.productCandidateId : null,
      });
    }
    return this.db.operation(userId, body.workspaceId, body.idempotencyKey, 'assistant.confirm', { tools: body.tools }, turnId);
  }

  async cancel(userId: string, turnId: string) {
    const success = await this.db.asUser(userId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ ok: boolean }>>`select public.cancel_assistant_turn(${turnId}::uuid) as ok`;
      return rows[0].ok;
    });
    if (!success) throw new Error('STALE_TURN');
    return { turnId, kind: 'cancelled', ok: true, message: 'Đã hủy bản nháp.' };
  }
}
