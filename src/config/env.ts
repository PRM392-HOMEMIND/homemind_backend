require('../../scripts/load-env.cjs').loadEnvironment();
import { emailConfig } from '../email/email.config';

export function environment() {
  const required = (name: string): string => {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`Thiếu biến môi trường ${name}`);
    return value;
  };
  required('DATABASE_URL');
  const integer = (name: string, fallback: number, maximum: number) => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${name} không hợp lệ`);
    return value;
  };
  const secret = (name: string) => {
    const value = required(name);
    if (Buffer.byteLength(value) < 32 || /change.?me|placeholder|replace.?me|your.?secret/i.test(value)) throw new Error(`${name} phải có ít nhất 32 byte và không phải placeholder`);
    return value;
  };
  const production = process.env.NODE_ENV === 'production';
  // Optional tuning knobs: blank means "use the default", so an empty line in an env file can never stop the API from starting.
  const optional = (name: string, fallback: number, minimum: number, maximum: number) => {
    const raw = process.env[name]?.trim();
    const value = raw === undefined || raw === '' ? fallback : Number(raw);
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} không hợp lệ`);
    return value;
  };
  // Exact browser origins only (scheme + host [+ port]); http is accepted for loopback outside production.
  const origins = (name: string, fallback: string[]) => {
    const raw = process.env[name]?.trim();
    const list = raw ? raw.split(',').map(item => item.trim()).filter(Boolean) : fallback;
    if (!list.length || list.length > 5 || new Set(list).size !== list.length) throw new Error(`${name} không hợp lệ`);
    for (const origin of list) {
      let url: URL;
      try { url = new URL(origin); } catch { throw new Error(`${name} không hợp lệ`); }
      const loopback = ['localhost', '127.0.0.1'].includes(url.hostname);
      const schemeAllowed = url.protocol === 'https:' || (!production && loopback && url.protocol === 'http:');
      if (url.origin !== origin || url.username || url.password || !schemeAllowed) throw new Error(`${name} không hợp lệ`);
    }
    return list;
  };
  const devResetDelivery = process.env.AUTH_DEV_RESET_DELIVERY === 'true';
  if (production && devResetDelivery) throw new Error('Không được bật AUTH_DEV_RESET_DELIVERY trong production');
  emailConfig(); // Validate opt-in delivery at startup. Verification is enforced by account state.
  const authSecrets = ['AUTH_ACCESS_SECRET', 'AUTH_REFRESH_SECRET', 'AUTH_RESET_SECRET'].map(secret);
  if (new Set(authSecrets).size !== 3) throw new Error('Auth secrets phải độc lập');
  const payosEnabled = process.env.PAYOS_ENABLED === 'true';
  const payosKeys = ['PAYOS_CLIENT_ID', 'PAYOS_API_KEY', 'PAYOS_CHECKSUM_KEY'].map(name => process.env[name]?.trim() || '');
  if (payosEnabled && payosKeys.some(value => !value || /change.?me|placeholder|replace.?me/i.test(value))) throw new Error('payOS enabled nhưng chưa có đủ credentials hợp lệ');
  const billingNamespace = integer('BILLING_ORDER_NAMESPACE', production ? 2 : 1, 999);
  if (production && billingNamespace === 1) throw new Error('Production phải có namespace order riêng, khác local');
  return {
    familyInviteDays: integer('FAMILY_INVITE_DAYS',7,30),
    assistantMaxConcurrency: integer('ASSISTANT_MAX_CONCURRENCY',16,64),
    port: integer('PORT', 3000, 65535),
    host: process.env.HOST?.trim() || '127.0.0.1',
    production, devResetDelivery,
    trustedProxyIp: process.env.TRUSTED_PROXY_IP?.trim() || '',
    revision: process.env.RELEASE_SHA?.trim() || 'development',
    accessSecret: secret('AUTH_ACCESS_SECRET'),
    refreshSecret: secret('AUTH_REFRESH_SECRET'),
    resetSecret: secret('AUTH_RESET_SECRET'),
    accessTtl: integer('AUTH_ACCESS_TTL_SECONDS', 900, 3600),
    refreshTtl: integer('AUTH_REFRESH_TTL_SECONDS', 2592000, 7776000),
    resetTtl: integer('AUTH_RESET_TTL_SECONDS', 900, 3600),
    issuer: process.env.AUTH_ISSUER || 'homemind',
    audience: process.env.AUTH_AUDIENCE || 'homemind-mobile',
    authRateLimit: integer('AUTH_RATE_LIMIT', production ? 20 : 300, 1000),
    // Homepage feedback popup. The website calls the API cross-origin; only these origins are answered.
    publicWebOrigins: origins('PUBLIC_WEB_ORIGINS', ['https://homemind.vn']),
    feedbackSubmitRateLimit: optional('FEEDBACK_POPUP_SUBMIT_RATE_LIMIT', 5, 1, 1000),
    feedbackConfigRateLimit: optional('FEEDBACK_POPUP_CONFIG_RATE_LIMIT', 60, 1, 5000),
    // Seconds between reconciliation runs; 0 disables the worker (default in tests so fixtures stay deterministic).
    feedbackReconcileSeconds: optional('FEEDBACK_POPUP_RECONCILE_SECONDS', process.env.NODE_ENV === 'test' ? 0 : 15, 0, 3600),
    // API thủ công và OpenAPI vẫn chạy khi AI chưa được cấu hình; planner trả 503 khi được gọi.
    geminiKey: process.env.GEMINI_API_KEY?.trim() ?? '',
    geminiModel: process.env.GEMINI_MODEL?.trim() || 'gemini-3.5-flash-lite',
    aiProvider: (process.env.AI_PROVIDER?.trim() || 'gemini').toLowerCase(),
    aiBaseUrl: process.env.AI_BASE_URL?.trim()?.replace(/\/+$/, '') ?? '',
    aiModel: process.env.AI_MODEL?.trim() || 'qwen2.5:7b',
    aiApiKey: process.env.AI_API_KEY?.trim() ?? '',
    payosEnabled, payosKeys, billingNamespace,
    payosWebhookUrl: process.env.PAYOS_WEBHOOK_URL?.trim() || `${(process.env.PUBLIC_API_URL?.trim() || 'https://homemind.ddns.net').replace(/\/+$/, '')}/v1/billing/payos/webhook`,
    payosReturnUrl: process.env.PAYOS_RETURN_URL?.trim() || `${(process.env.PUBLIC_API_URL?.trim() || 'https://homemind.ddns.net').replace(/\/+$/, '')}/v1/billing/payos/return`,
    payosCancelUrl: process.env.PAYOS_CANCEL_URL?.trim() || `${(process.env.PUBLIC_API_URL?.trim() || 'https://homemind.ddns.net').replace(/\/+$/, '')}/v1/billing/payos/cancel`,
  };
}
export type Environment = ReturnType<typeof environment>;
