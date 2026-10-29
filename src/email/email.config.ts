import { isEmail } from 'class-validator';

export function emailConfig() {
  const mode = process.env.EMAIL_DELIVERY_MODE?.trim() || 'disabled';
  if (!['disabled', 'infobip'].includes(mode)) throw Error('EMAIL_DELIVERY_MODE không hợp lệ');
  const secret = process.env.AUTH_OTP_SECRET?.trim() || '';
  if (mode === 'infobip' && (Buffer.byteLength(secret) < 32 || /placeholder|change.?me/i.test(secret))) throw Error('AUTH_OTP_SECRET cần khóa riêng ổn định ít nhất 32 byte');
  if (secret && [process.env.INFOBIP_API_KEY, process.env.AUTH_ACCESS_SECRET, process.env.AUTH_REFRESH_SECRET, process.env.AUTH_RESET_SECRET].includes(secret)) throw Error('AUTH_OTP_SECRET phải độc lập');
  const baseUrl = process.env.INFOBIP_BASE_URL?.trim().replace(/\/$/, '') || '';
  const key = process.env.INFOBIP_API_KEY?.trim() || '';
  const from = process.env.INFOBIP_EMAIL_FROM?.trim().toLowerCase() || '';
  if (mode === 'infobip') {
    let url: URL;
    try { url = new URL(baseUrl); } catch { throw Error('INFOBIP_BASE_URL không hợp lệ'); }
    if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.api\.infobip\.com$/.test(url.hostname) || url.origin !== baseUrl || url.username || url.password) throw Error('INFOBIP_BASE_URL phải là HTTPS Infobip account origin');
    if (!key || /placeholder|change.?me/i.test(key) || /[\r\n]/.test(key)) throw Error('INFOBIP_API_KEY chưa cấu hình');
    if (!isEmail(from) || /[\r\n]/.test(from)) throw Error('INFOBIP_EMAIL_FROM không hợp lệ');
  }
  const integer = (name: string, fallback: number, max: number) => {
    const value = Number(process.env[name] || fallback);
    if (!Number.isInteger(value) || value < 1 || value > max) throw Error(name + ' không hợp lệ');
    return value;
  };
  return { mode, secret, baseUrl, key, from, concurrency: integer('EMAIL_WORKER_CONCURRENCY', 4, 16),
    timeoutMs: integer('EMAIL_PROVIDER_TIMEOUT_MS', 8000, 15000),
    perQuarter: integer('AUTH_OTP_SEND_15M', 5, 100), perHour: integer('AUTH_OTP_SEND_HOUR', 10, 100),
    ipQuarter: integer('AUTH_OTP_IP_15M', 20, 1000), globalMinute: integer('AUTH_OTP_GLOBAL_MINUTE', 100, 10000) };
}
