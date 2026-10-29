import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { AuthService } from '../auth/auth.service';
import { invalidateWorkspace } from '../common/workspace-cache';
import { environment } from '../config/env';
import { DatabaseService } from '../database/database.service';
import { FEEDBACK_FIELD_LIMITS, FEEDBACK_POPUP_CAMPAIGN_ID, parseFeedbackBody, parseIdempotencyKey, payloadHash } from './feedback-popup.validation';

export type SubmitContext = { authorization?: string; idempotencyKey?: string | string[]; ip?: string; userAgent?: string };
type SubmitResult = { submissionId: string; submittedAt: string; replayed: boolean; workspaceId: string | null; rewardState: string | null };

export const ACCEPTED_MESSAGE = 'Cảm ơn bạn đã gửi góp ý cho HomeMind. Nếu thông tin liên hệ khớp với một tài khoản đủ điều kiện, ưu đãi Premium 30 ngày sẽ được áp dụng theo thể lệ chương trình.';

@Injectable()
export class FeedbackPopupService {
  constructor(private readonly db: DatabaseService, private readonly auth: AuthService) {}

  /** Safe to cache nowhere: the controller sends Cache-Control: no-store. */
  async publicConfig() {
    const rows = await this.db.$queryRaw<Array<{ config: { campaignId: string; enabled: boolean; revision: number; updatedAt: string } | null }>>`
      select public.feedback_popup_public_config() as config`;
    const config = rows[0]?.config;
    if (!config) throw new ServiceUnavailableException({ code: 'FEEDBACK_POPUP_UNAVAILABLE', message: 'Chương trình chưa sẵn sàng.', details: null });
    return {
      campaignId: config.campaignId,
      enabled: config.enabled,
      revision: config.revision,
      updatedAt: new Date(config.updatedAt).toISOString(),
      offer: { name: 'Premium', planId: 'personal', durationDays: 30, durationSeconds: 2592000 },
      fields: {
        fullName: { required: true, ...FEEDBACK_FIELD_LIMITS.fullName },
        phoneNumber: { required: true, ...FEEDBACK_FIELD_LIMITS.phoneNumber },
        email: { required: true, ...FEEDBACK_FIELD_LIMITS.email },
        review: { required: true, ...FEEDBACK_FIELD_LIMITS.review },
      },
      idempotency: { header: 'Idempotency-Key', format: 'uuid', required: false },
    };
  }

  /** A valid Bearer token only records who submitted; it never changes who is rewarded. */
  private async submitter(authorization: string | undefined): Promise<string | null> {
    if (!authorization?.startsWith('Bearer ') || authorization.length > 4096) return null;
    try { return (await this.auth.authenticate(authorization.slice(7))).userId; } catch { return null; }
  }

  async submit(body: unknown, context: SubmitContext) {
    const value = parseFeedbackBody(body);
    const idempotencyKey = parseIdempotencyKey(context.idempotencyKey);
    const hash = payloadHash(FEEDBACK_POPUP_CAMPAIGN_ID, value);
    const submitterUserId = await this.submitter(context.authorization);
    // Raw IPs are not stored: a keyed hash is enough to spot abuse from one address.
    const ipHash = context.ip ? createHmac('sha256', environment().accessSecret).update('feedback-popup.ip.v1:' + context.ip).digest('hex') : null;
    const userAgent = context.userAgent?.slice(0, 300) ?? null;
    let result: SubmitResult;
    try {
      const rows = await this.db.$transaction(async tx => {
        await tx.$executeRaw`set local lock_timeout='3000ms'`;
        await tx.$executeRaw`set local statement_timeout='10000ms'`;
        return tx.$queryRaw<Array<{ result: SubmitResult }>>`
          select public.feedback_popup_submit(${FEEDBACK_POPUP_CAMPAIGN_ID}, ${value.fullName}, ${value.email}, ${value.phone}, ${value.review},
            ${idempotencyKey}::uuid, ${hash}, ${submitterUserId}::uuid, ${ipHash}, ${userAgent}) as result`;
      }, { maxWait: 5000, timeout: 15000 });
      result = rows[0].result;
    } catch (error) {
      throw this.mapError(error);
    }
    // The workspace plan may have changed inside this transaction: drop any cached snapshot.
    if (result.workspaceId) invalidateWorkspace(result.workspaceId);
    // Identical for every outcome (new account, pending, granted, scheduled, duplicate, conflict, replay).
    return { status: 'ACCEPTED' as const, submissionId: result.submissionId, acceptedAt: new Date(result.submittedAt).toISOString(), message: ACCEPTED_MESSAGE };
  }

  private mapError(error: unknown): unknown {
    const text = error instanceof Error ? error.message : '';
    if (text.includes('FEEDBACK_POPUP_DISABLED')) {
      return new ConflictException({ code: 'FEEDBACK_POPUP_DISABLED', message: 'Chương trình góp ý hiện không nhận phản hồi mới.', details: null });
    }
    if (text.includes('IDEMPOTENCY_CONFLICT')) {
      return new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: 'Idempotency-Key này đã được dùng với nội dung khác.', details: null });
    }
    // PostgreSQL aborts the transaction on these contention failures. A caller can
    // retry its optional operation key; the server never loops or issues twice.
    if (/lock timeout|statement timeout|deadlock detected|serialization failure|could not serialize|Transaction API error|P2028|55P03|57014|40P01|40001/i.test(text)) {
      return new ServiceUnavailableException({ code: 'FEEDBACK_POPUP_BUSY', message: 'Hệ thống đang bận. Vui lòng thử lại sau ít giây.', details: null });
    }
    return error;
  }
}
