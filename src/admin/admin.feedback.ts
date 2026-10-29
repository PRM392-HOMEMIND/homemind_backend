import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { normalizePhone } from '../auth/identifiers';
import { ScopedCursor } from '../common/scoped-cursor';
import { AdminRequest } from './admin.auth';
import { adminId, AdminRead, Query } from './admin.read';

const CAMPAIGN = 'homepage-feedback-premium-30d';
export const FEEDBACK_BENEFIT_STATES = ['PENDING_ACCOUNT', 'WAITING_ENTITLEMENT', 'SCHEDULED', 'ACTIVE', 'EXPIRED', 'CONFLICT', 'BLOCKED', 'DUPLICATE'] as const;
const LIST_PARAMETERS = ['limit', 'cursor', 'sort', 'from', 'to', 'q', 'benefitState', 'userId', 'duplicate'];

function fail(): never { throw new BadRequestException('Invalid admin filter.'); }
/** Timestamps leave the API as UTC ISO-8601 with milliseconds, whatever the session time zone is. */
const iso = (value: unknown): string | null => (value === null || value === undefined ? null : (value instanceof Date ? value : new Date(String(value))).toISOString());
function window(q: Query) {
  if ((q.from === undefined) !== (q.to === undefined)) fail();
  const parse = (v: string | undefined) => {
    if (v === undefined) return null;
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 19) !== v.slice(0, 19)) fail();
    return new Date(v);
  };
  const from = parse(q.from), to = parse(q.to);
  if (from && to && (from >= to || to.getTime() - from.getTime() > 366 * 86400000)) fail();
  return { from, to };
}

type Benefit = Record<string, unknown>;
type SegmentRow = { id: string; startsAt: string; endsAt: string; plannedEndsAt: string; supersededAt: string | null; supersededBy: string | null };

/** Admin-only view of the homepage feedback popup: configuration, audited toggle, submissions. */
@Injectable()
export class AdminFeedback {
  private readonly cursors = new ScopedCursor();
  constructor(private readonly read: AdminRead) {}

  private static campaign(row: Record<string, unknown>) {
    return {
      campaignId: row.campaignId ?? row.id, enabled: row.enabled, revision: row.revision, plan: 'personal', planName: 'Premium', durationSeconds: 2592000,
      createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt), updatedBy: row.updatedBy ?? null,
    };
  }

  private static item(data: Record<string, unknown>, detail: boolean, segments?: SegmentRow[]) {
    const benefit = data.benefit as Benefit;
    const storedLifecycle = data.lifecycle as Record<string, unknown> | undefined;
    const lifecycle = storedLifecycle ? { ...storedLifecycle } : undefined;
    if (lifecycle) {
      for (const key of ['accountCreatedAt', 'linkedAt', 'awardedAt', 'firstSubmittedAt', 'lastSubmittedAt', 'expectedStartsAt', 'expectedEndsAt', 'actualStartedAt', 'completedAt']) {
        lifecycle[key] = iso(lifecycle[key]);
      }
    }
    const base = {
      id: data.id, campaignId: data.campaignId, submittedAt: iso(data.submittedAt), fullName: data.fullName, email: data.email,
      phoneNumber: data.phoneNumber, submitterUserId: data.submitterUserId ?? null, duplicate: data.duplicate,
      ...(lifecycle ? { lifecycle } : {}),
      benefit: {
        state: benefit.state, reason: benefit.reason ?? null, plan: 'personal', planName: 'Premium', durationSeconds: benefit.durationSeconds,
        userId: benefit.userId ?? null, workspaceId: benefit.workspaceId ?? null, anchorAt: iso(benefit.anchorAt), boundAt: iso(benefit.boundAt),
        grantedAt: iso(benefit.grantedAt), startsAt: iso(benefit.startsAt), endsAt: iso(benefit.endsAt), postponed: benefit.postponed === true,
      },
    };
    if (!detail) return { ...base, reviewPreview: data.reviewPreview, reviewLength: data.reviewLength };
    return {
      ...base, review: data.review, reviewLength: data.reviewLength,
      segments: (segments ?? []).map(segment => ({ id: segment.id, startsAt: iso(segment.startsAt), endsAt: iso(segment.endsAt), plannedEndsAt: iso(segment.plannedEndsAt),
        supersededAt: iso(segment.supersededAt), supersededBy: segment.supersededBy })),
    };
  }

  config(req: AdminRequest) {
    return this.read.execute(req, 'feedbackPopup.config', async tx => {
      const [campaign] = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        'SELECT id,enabled,revision,created_at AS "createdAt",updated_at AS "updatedAt",updated_by AS "updatedBy" FROM public.feedback_popup_campaigns WHERE id=$1', CAMPAIGN);
      if (!campaign) throw new NotFoundException();
      const [last] = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        'SELECT actor_id AS "actorId",previous_enabled AS "previousEnabled",enabled,previous_revision AS "previousRevision",revision,occurred_at AS "occurredAt" FROM public.feedback_popup_config_events WHERE campaign_id=$1 ORDER BY occurred_at DESC,id DESC LIMIT 1', CAMPAIGN);
      return {
        ...AdminFeedback.campaign(campaign),
        lastChange: last ? { actorId: last.actorId ?? null, previousEnabled: last.previousEnabled, enabled: last.enabled, previousRevision: last.previousRevision, revision: last.revision, occurredAt: iso(last.occurredAt) } : null,
      };
    });
  }

  /** Audited write: optimistic revision, idempotent for the same value, one event per real change. */
  async update(req: AdminRequest, body: { enabled: boolean; expectedRevision?: number }) {
    req.auditScopeHash = this.read.auth.sign('audit-scope', JSON.stringify(['feedbackPopup.update']));
    await this.read.throttle(req);
    try {
      const result = await this.read.auth.db.transaction(async tx => {
        const rows = await tx.$queryRawUnsafe<Array<{ result: Record<string, unknown> }>>(
          'SELECT public.feedback_popup_admin_set($1::boolean,$2::integer,$3::uuid,$4::uuid) AS result', body.enabled, body.expectedRevision ?? null, req.admin!.admin_id, req.requestId);
        return rows[0].result;
      });
      await this.read.auth.audit(req, 'feedbackPopup.update', 'SUCCESS', 1);
      return { data: { ...AdminFeedback.campaign(result), changed: result.changed === true }, meta: { requestId: req.requestId, asOf: new Date().toISOString(), version: 'admin-v1', freshness: 'committed' } };
    } catch (error) {
      await this.read.auth.audit(req, 'feedbackPopup.update', 'ERROR');
      if (error instanceof Error && error.message.includes('CONFIG_REVISION_CONFLICT')) {
        throw new ConflictException({ code: 'CONFIG_REVISION_CONFLICT', message: 'Configuration changed; reload and retry.' });
      }
      throw error;
    }
  }

  list(req: AdminRequest, q: Query) {
    for (const [key, value] of Object.entries(q)) if (!LIST_PARAMETERS.includes(key) || typeof value !== 'string' || value.length > 2048) fail();
    const size = q.limit === undefined ? 25 : Number(q.limit);
    if (q.limit !== undefined && !/^[1-9]\d{0,2}$/.test(q.limit) || !Number.isInteger(size) || size < 1 || size > 100) fail();
    const sort = q.sort ?? 'newest';
    if (!['newest', 'oldest'].includes(sort)) fail();
    const ascending = sort === 'oldest', direction = ascending ? 'ASC' : 'DESC';
    const values: unknown[] = [];
    const bind = (v: unknown) => { values.push(v); return '$' + values.length; };
    const filters: string[] = [];
    const range = window(q);
    if (range.from) filters.push(`v.submitted_at>=${bind(range.from)}::timestamptz AND v.submitted_at<${bind(range.to)}::timestamptz`);
    if (q.q !== undefined) {
      const term = q.q.trim();
      if (term.length > 120) fail();
      if (term) {
        const like = bind('%' + term.replace(/[\\%_]/g, '\\$&') + '%');
        const parts = [`lower(v.full_name) LIKE lower(${like})`, `lower(v.email) LIKE lower(${like})`, `v.phone LIKE ${like}`];
        try { parts.push(`v.phone=${bind(normalizePhone(term))}`); } catch { /* not a phone number: text match only */ }
        filters.push('(' + parts.join(' OR ') + ')');
      }
    }
    if (q.benefitState !== undefined) {
      if (!(FEEDBACK_BENEFIT_STATES as readonly string[]).includes(q.benefitState)) fail();
      filters.push(`v.benefit_state=${bind(q.benefitState)}`);
    }
    if (q.userId !== undefined) filters.push(`v.user_id=${bind(adminId(q.userId))}::uuid`);
    if (q.duplicate !== undefined) {
      if (!['true', 'false'].includes(q.duplicate)) fail();
      filters.push(`v.benefit_state${q.duplicate === 'true' ? '=' : '<>'}'DUPLICATE'`);
    }
    const scope = createHash('sha256').update(JSON.stringify([req.admin!.admin_id, 'feedback-submissions', Object.entries(q).filter(([k]) => !['limit', 'cursor'].includes(k)).sort()])).digest('hex');
    const cursor = this.cursors.decode(q.cursor, scope) as { time?: string; id?: string } | null;
    if (cursor) {
      if (typeof cursor.time !== 'string' || typeof cursor.id !== 'string' || !Number.isFinite(Date.parse(cursor.time))) fail();
      filters.push(`(v.submitted_at,v.id) ${ascending ? '>' : '<'} (${bind(cursor.time)}::timestamptz,${bind(adminId(cursor.id))}::uuid)`);
    }
    return this.read.execute(req, 'feedbackPopup.submissions', async tx => {
      const rows = await tx.$queryRawUnsafe<Array<{ id: string; time: string; data: Record<string, unknown> }>>(
        `SELECT v.id,to_char(v.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS time,v.data FROM admin.feedback_submissions v ${filters.length ? 'WHERE ' + filters.join(' AND ') : ''} ORDER BY v.submitted_at ${direction},v.id ${direction} LIMIT ${bind(size + 1)}`, ...values);
      const hasMore = rows.length > size, items = rows.slice(0, size), last = items.at(-1);
      return {
        items: items.map(row => AdminFeedback.item(row.data, false)),
        page: { limit: size, hasMore, nextCursor: hasMore && last ? this.cursors.encode(scope, { time: last.time, id: last.id }) : null },
      };
    }, q.userId ? adminId(q.userId) : null);
  }

  detail(req: AdminRequest, id: string) {
    adminId(id);
    return this.read.execute(req, 'feedbackPopup.submission', async tx => {
      const rows = await tx.$queryRawUnsafe<Array<{ data: Record<string, unknown>; segments: SegmentRow[] }>>(
        `SELECT v.data,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',g.id,'startsAt',g.starts_at,'endsAt',coalesce(g.effective_until,g.expires_at),'plannedEndsAt',g.expires_at,'supersededAt',g.superseded_at,'supersededBy',g.superseded_by) ORDER BY g.starts_at,g.id)
           FROM public.billing_grants g JOIN public.feedback_popup_rewards r ON r.id=g.reward_id WHERE r.submission_id=v.id),'[]'::jsonb) AS segments
         FROM admin.feedback_submissions v WHERE v.id=$1::uuid`, id);
      if (!rows[0]) throw new NotFoundException();
      return AdminFeedback.item(rows[0].data, true, rows[0].segments);
    }, id);
  }
}
