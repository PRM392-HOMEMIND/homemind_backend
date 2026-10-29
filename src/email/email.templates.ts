import type { EmailContent } from './infobip.provider';

export const notificationRegistry = {
  'account.welcome': 'auth', 'account.security': 'security',
  'account.login': null, 'account.logout': null, 'account.logout_all': null,
  'profile.updated': 'account',
  'inventory.add': 'inventory', 'inventory.patch': 'inventory', 'inventory.mark_out': 'inventory',
  'inventory.set_expiry': 'inventory', 'inventory.expiry': 'reminder',
  'shopping.add': 'shopping', 'shopping.patch': 'shopping', 'shopping.receive': 'shopping', 'shopping.skip': 'shopping',
  'assistant.confirm': 'inventory',
  'billing.created': 'billing', 'billing.activated': 'billing', 'billing.review': 'billing',
  'billing.cancelled': 'billing', 'billing.expired': 'billing', 'billing.plan_expired': 'billing',
  'quota.renewed': 'quota', 'quota.exhausted': 'quota',
  'family.invited': 'family', 'family.accepted': 'family', 'family.declined': 'family', 'family.cancelled': 'family',
  'family.invitation_expired': 'family', 'family.invitation_invalidated': 'family',
  'family.leave': 'family', 'family.remove': 'family', 'family.sharing_ended': 'family', 'family.access_expired': 'family',
  'family.owner_closed': 'family', 'family.account_closed': 'family',
} as const;
export const otpTitles = {
  REGISTER: 'Xác minh email đăng ký', RESET: 'Đặt lại mật khẩu', CHANGE_PASSWORD: 'Xác nhận đổi mật khẩu',
  VERIFY_EMAIL: 'Xác minh email tài khoản', LEGACY_EMAIL: 'Bổ sung email tài khoản',
  CHANGE_EMAIL_OLD: 'Xác nhận địa chỉ email hiện tại', CHANGE_EMAIL_NEW: 'Xác minh địa chỉ email mới',
};
export type OtpPurpose = keyof typeof otpTitles;
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
function layout(title: string, preheader: string, text: string, body: string): EmailContent {
  return { subject: title.replace(/[\r\n]/g, ' ').slice(0, 160), text: 'HomeMind\n\n' + title + '\n\n' + text + '\n\nHomeMind · Thư tự động. Không chia sẻ thông tin bảo mật.',
    html: `<!doctype html><html lang="vi"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="UTF-8"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title)}</title></head><body style="margin:0;background:#F7F8FA;color:#1F2933;font:16px Arial,sans-serif"><div style="display:none;max-height:0;overflow:hidden">${escapeHtml(preheader)}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="600" style="width:100%;max-width:600px;background:#fff;border:1px solid #E5E7EB;border-radius:20px" cellspacing="0" cellpadding="0"><tr><td style="padding:28px"><img src="cid:homemind-logo" width="64" height="64" alt="HomeMind" style="display:block"><div style="font-size:24px;font-weight:bold;color:#1B8450">HomeMind</div><h1 style="font-size:23px;line-height:1.4">${escapeHtml(title)}</h1>${body}<hr style="border:0;border-top:1px solid #E5E7EB"><p style="font-size:13px;color:#4B5563">HomeMind · Thư tự động. Không chia sẻ thông tin bảo mật.</p></td></tr></table></td></tr></table></body></html>` };
}
export function otpTemplate(purpose: OtpPurpose, code: string, expires: Date, smoke = false): EmailContent {
  if (!/^[0-9]{6}$/.test(code)) throw Error('OTP_FORMAT');
  const time = expires.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
  const title = (smoke ? '[Kiểm thử HomeMind] ' : '') + otpTitles[purpose];
  const intro = 'Bạn đang yêu cầu ' + otpTitles[purpose].toLowerCase() + '. Nhập mã này tại màn hình xác thực HomeMind.';
  const expiry = 'Mã có hiệu lực trong 60 giây kể từ khi được tạo. Hết hạn lúc ' + time + ' (giờ Việt Nam).';
  const safety = 'Nếu mã hết hạn, hãy yêu cầu mã mới trong ứng dụng. Không chia sẻ mã với bất kỳ ai. Nếu bạn không yêu cầu, hãy bỏ qua thư này; tài khoản chưa được thay đổi.';
  return layout(title, 'Nhập mã tại HomeMind để xác nhận yêu cầu của bạn.', intro + '\n\n' + code + '\n\n' + expiry + '\n\n' + safety,
    `<p>${escapeHtml(intro)}</p><p style="background:#E8F8EF;border-radius:14px;padding:20px;font-size:32px;letter-spacing:8px;font-weight:bold;color:#1B8450;text-align:center">${code}</p><p>${escapeHtml(expiry)}</p><p>${escapeHtml(safety)}</p>`);
}
export type NoticeEmail = { kind: string; title: string; summary: string; detail: string; occurredAt: Date };
export function notificationTemplate(notice: NoticeEmail, smoke = false): EmailContent | null {
  if (!(notice.kind in notificationRegistry)) throw Error('EMAIL_TEMPLATE_UNMAPPED');
  if (notificationRegistry[notice.kind as keyof typeof notificationRegistry] === null) return null;
  const time = notice.occurredAt.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
  const title = (smoke ? '[Kiểm thử HomeMind] ' : '') + notice.title;
  const action = 'Bạn có thể mở thông báo tương ứng trong HomeMind để xem dữ liệu hiện tại. Nếu thay đổi không đúng, kiểm tra lại dữ liệu và Bảo mật tài khoản trong ứng dụng.';
  return layout(title, notice.summary, `${notice.summary}\n\n${notice.detail}\n\nThời điểm: ${time} (giờ Việt Nam).\n\n${action}`,
    `<p>${escapeHtml(notice.summary)}</p><div style="background:#F0FBF5;padding:18px;border-radius:14px;white-space:pre-line">${escapeHtml(notice.detail)}</div><p>Thời điểm: ${escapeHtml(time)} (giờ Việt Nam).</p><p>${escapeHtml(action)}</p>`);
}
