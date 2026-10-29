import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { normalizeEmail, normalizePhone } from '../auth/identifiers';

export const FEEDBACK_POPUP_CAMPAIGN_ID = 'homepage-feedback-premium-30d';

/** Limits are measured in Unicode code points after trimming (what PostgreSQL char_length counts). */
export const FEEDBACK_FIELD_LIMITS = {
  fullName: { minLength: 1, maxLength: 120 },
  phoneNumber: { minLength: 1, maxLength: 40 },
  email: { minLength: 3, maxLength: 254 },
  review: { minLength: 1, maxLength: 5000 },
} as const;

export const FEEDBACK_FIELDS = ['fullName', 'phoneNumber', 'email', 'review'] as const;
export type FeedbackField = (typeof FEEDBACK_FIELDS)[number];
export type FeedbackFieldError = { field: string; code: 'REQUIRED' | 'INVALID_TYPE' | 'TOO_LONG' | 'INVALID_FORMAT' | 'INVALID_CHARACTERS' | 'UNKNOWN_FIELD'; message: string };
export type ParsedFeedback = { fullName: string; email: string; phone: string; review: string };

// Raw input is capped before any normalisation work so a hostile body stays cheap.
const RAW_CAP: Record<FeedbackField, number> = { fullName: 1000, phoneNumber: 200, email: 1000, review: 20000 };
const CONTROL = /[\u0000-\u001F\u007F]/;
// Free text may contain tab / line breaks, never other control characters.
const REVIEW_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const SAFE_KEY = /^[A-Za-z0-9_.-]{1,40}$/;

const LABEL: Record<FeedbackField, string> = { fullName: 'họ và tên', phoneNumber: 'số điện thoại', email: 'email', review: 'góp ý về HomeMind' };

export const codePoints = (value: string) => Array.from(value).length;

function reject(errors: FeedbackFieldError[]): never {
  throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Dữ liệu gửi lên chưa hợp lệ.', details: errors });
}

/**
 * Validates and normalises the public submission. Only the four business fields are
 * accepted: any other property (userId, role, plan, duration, timestamps, state…) is
 * rejected, so a client can never influence beneficiary, plan, duration or state.
 */
export function parseFeedbackBody(body: unknown): ParsedFeedback {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    reject([{ field: 'body', code: 'INVALID_TYPE', message: 'Nội dung gửi lên phải là một đối tượng JSON.' }]);
  }
  const input = body as Record<string, unknown>;
  const errors: FeedbackFieldError[] = [];
  for (const key of Object.keys(input)) {
    if (!(FEEDBACK_FIELDS as readonly string[]).includes(key)) {
      errors.push({ field: SAFE_KEY.test(key) ? key : 'body', code: 'UNKNOWN_FIELD', message: 'Trường này không được hỗ trợ.' });
    }
  }

  const read = (field: FeedbackField): string | null => {
    const raw = input[field];
    if (raw === undefined || raw === null) { errors.push({ field, code: 'REQUIRED', message: `Vui lòng nhập ${LABEL[field]}.` }); return null; }
    if (typeof raw !== 'string') { errors.push({ field, code: 'INVALID_TYPE', message: `${LABEL[field]} phải là chuỗi văn bản.` }); return null; }
    if (raw.length > RAW_CAP[field]) { errors.push({ field, code: 'TOO_LONG', message: `${LABEL[field]} quá dài.` }); return null; }
    if (LONE_SURROGATE.test(raw)) { errors.push({ field, code: 'INVALID_CHARACTERS', message: `${LABEL[field]} chứa ký tự không hợp lệ.` }); return null; }
    // NFC is for presentation text only. Contact identifiers must keep exactly
    // the same canonicalization as registration/login (not merge email identities).
    const value = (field === 'fullName' || field === 'review' ? raw.normalize('NFC') : raw).trim();
    if (!value) { errors.push({ field, code: 'REQUIRED', message: `Vui lòng nhập ${LABEL[field]}.` }); return null; }
    if ((field === 'review' ? REVIEW_CONTROL : CONTROL).test(value)) {
      errors.push({ field, code: 'INVALID_CHARACTERS', message: `${LABEL[field]} chứa ký tự điều khiển không hợp lệ.` }); return null;
    }
    if (codePoints(value) > FEEDBACK_FIELD_LIMITS[field].maxLength) {
      errors.push({ field, code: 'TOO_LONG', message: `${LABEL[field]} tối đa ${FEEDBACK_FIELD_LIMITS[field].maxLength} ký tự.` }); return null;
    }
    return value;
  };

  const fullName = read('fullName');
  const phoneRaw = read('phoneNumber');
  const emailRaw = read('email');
  const review = read('review');

  let phone: string | null = null;
  if (phoneRaw !== null) {
    try { phone = normalizePhone(phoneRaw); } catch { errors.push({ field: 'phoneNumber', code: 'INVALID_FORMAT', message: 'Số điện thoại không hợp lệ.' }); }
  }
  let email: string | null = null;
  if (emailRaw !== null) {
    try { email = normalizeEmail(emailRaw); } catch { errors.push({ field: 'email', code: 'INVALID_FORMAT', message: 'Email không hợp lệ.' }); }
  }
  if (errors.length || fullName === null || phone === null || email === null || review === null) reject(errors);
  return { fullName, email, phone, review };
}

/** Stable hash of the NORMALISED payload: a retry that only changes formatting is still the same request. */
export function payloadHash(campaignId: string, value: ParsedFeedback): string {
  return createHash('sha256').update(JSON.stringify([campaignId, value.fullName, value.email, value.phone, value.review])).digest('hex');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function parseIdempotencyKey(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new BadRequestException({ code: 'INVALID_IDEMPOTENCY_KEY', message: 'Idempotency-Key phải là UUID.', details: null });
  }
  return value.toLowerCase();
}
