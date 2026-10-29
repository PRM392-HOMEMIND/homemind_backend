import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PayOS, APIError, NotFoundError } from '@payos/node';
import { createHash, timingSafeEqual } from 'node:crypto';
import { environment } from '../config/env';
import { memoMatches, verifyTransferQr } from './vietqr';
import type { CreatePaymentLinkRequest, PaymentLink, Webhook } from '@payos/node';

export function safeCheckoutUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('PROVIDER_IDENTITY_CONFLICT');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'pay.payos.vn' || url.port || url.username || url.password || url.hash) throw new Error('PROVIDER_IDENTITY_CONFLICT');
  return value;
}
export function validLink(value: PaymentLink): PaymentLink {
  if (!value || typeof value.id !== 'string' || !value.id || value.id.length > 200
    || !Number.isSafeInteger(value.orderCode) || !Number.isSafeInteger(value.amount) || value.amount <= 0
    || !Number.isSafeInteger(value.amountPaid) || value.amountPaid < 0 || value.amountPaid > 2147483647
    || !Number.isSafeInteger(value.amountRemaining) || value.amountRemaining < 0
    // Genuine overpayments still reach financial review; they cannot have a
    // negative remainder. All other totals must describe the same order amount.
    || value.amountRemaining !== Math.max(0,value.amount-value.amountPaid)
    || !['PENDING','CANCELLED','UNDERPAID','PAID','EXPIRED','PROCESSING','FAILED'].includes(value.status)
    || !Array.isArray(value.transactions) || value.transactions.length > 1000) throw new Error('PROVIDER_IDENTITY_CONFLICT');
  const seen = new Set<string>();
  if (value.canceledAt != null) {
    if (typeof value.canceledAt !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value.canceledAt)
      || !Number.isFinite(Date.parse(value.canceledAt))) throw new Error('PROVIDER_IDENTITY_CONFLICT');
    value.canceledAt = new Date(value.canceledAt).toISOString();
  }
  for (const transaction of value.transactions) {
    if (!transaction || typeof transaction.reference !== 'string' || seen.has(transaction.reference)
      || !Number.isSafeInteger(transaction.amount) || transaction.amount <= 0 || typeof transaction.transactionDateTime !== 'string') throw new Error('PROVIDER_IDENTITY_CONFLICT');
    seen.add(transaction.reference);
    const time = /(?:Z|[+-]\d{2}:?\d{2})$/.test(transaction.transactionDateTime) ? transaction.transactionDateTime : transaction.transactionDateTime.replace(' ', 'T') + '+07:00';
    if (!Number.isFinite(Date.parse(time))) throw new Error('PROVIDER_IDENTITY_CONFLICT');
    transaction.transactionDateTime = new Date(time).toISOString();
  }
  value.transactions.sort((a,b)=>a.reference.localeCompare(b.reference));
  return value;
}
@Injectable()
export class PayosProvider {
  readonly channel: string;
  readonly enabled: boolean;
  protected readonly client?: PayOS;
  constructor() {
    const config = environment();
    this.enabled = config.payosEnabled;
    this.channel = createHash('sha256').update(config.payosKeys[0]).digest('hex');
    if (this.enabled) this.client = new PayOS({ clientId: config.payosKeys[0], apiKey: config.payosKeys[1], checksumKey: config.payosKeys[2],
      baseURL: 'https://api-merchant.payos.vn', timeout: 8000, maxRetries: 0, logLevel: 'off' });
  }
  private active(): PayOS {
    if (!this.client) throw new ServiceUnavailableException({code:'BILLING_NOT_CONFIGURED',message:'Thanh toán chưa được cấu hình.'});
    return this.client;
  }
  async create(data: CreatePaymentLinkRequest) {
    let result;
    try { result = await this.active().paymentRequests.create(data); }
    catch (error) {
      // A definite rejection provides no provenance for a later same-code link.
      // Connection failures, timeouts and retryable responses remain uncertain.
      if (error instanceof APIError && error.status !== undefined
        && ((error.status >= 400 && error.status < 500 && ![408,429].includes(error.status))
          || (error.status >= 200 && error.status < 300 && error.code && error.code !== '00'))) {
        throw new Error('PROVIDER_CREATE_REJECTED');
      }
      throw error;
    }
    safeCheckoutUrl(result.checkoutUrl);
    if (new URL(result.checkoutUrl).pathname !== '/web/' + result.paymentLinkId) throw new Error('PROVIDER_IDENTITY_CONFLICT');
    if (result.orderCode !== data.orderCode || result.amount !== data.amount ||
        !memoMatches(data.description, result.description) || result.currency !== 'VND' ||
        typeof result.qrCode !== 'string' || !result.qrCode || result.qrCode.length > 4096 ||
        !/^[0-9]{6}$/.test(result.bin) || !/^[a-zA-Z0-9]{1,50}$/.test(result.accountNumber) ||
        typeof result.accountName !== 'string' || !result.accountName || result.accountName.length > 200) {
      throw new Error('PROVIDER_IDENTITY_CONFLICT');
    }
    verifyTransferQr(result);
    return result;
  }
  async get(code: number): Promise<PaymentLink | null> {
    try { return validLink(await this.active().paymentRequests.get(code)); }
    catch (error) {
      if (error instanceof NotFoundError || (error instanceof APIError && error.code === '231')) return null;
      // The merchant GET endpoint also reports an absent payment code in a
      // successful HTTP envelope. Do not interpret other 101/access errors as
      // absence: that would authorize a create after an unverified lookup.
      if (error instanceof APIError && error.status === 200 && error.code === '101'
        && error.desc?.normalize('NFC').trim().replace(/[.!]$/, '').toLowerCase() === 'mã thanh toán không tồn tại') return null;
      throw error;
    }
  }
  async cancel(code: number): Promise<PaymentLink> {
    return validLink(await this.active().paymentRequests.cancel(code, 'HomeMind user requested cancellation'));
  }
  async verify(body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Buffer.byteLength(JSON.stringify(body)) > 32768) throw new BadRequestException('Webhook không hợp lệ');
    const client = this.active(), webhook = body as Webhook;
    if (typeof webhook.signature !== 'string' || !/^[a-f0-9]{64}$/.test(webhook.signature)) throw new BadRequestException('Webhook không hợp lệ');
    const expected = await client.crypto.createSignatureFromObj(webhook.data, client.checksumKey);
    if (!expected || !timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(webhook.signature,'hex'))) throw new BadRequestException('Chữ ký webhook không hợp lệ');
    let data;
    try { data = await client.webhooks.verify(webhook); } catch { throw new BadRequestException('Chữ ký webhook không hợp lệ'); }
    if (data.code !== '00' || data.currency !== 'VND' || !Number.isSafeInteger(data.orderCode) || data.orderCode <= 0
      || !Number.isSafeInteger(data.amount) || data.amount <= 0 || data.amount > 2147483647
      || typeof data.reference !== 'string' || !data.reference || data.reference.length > 200
      || typeof data.paymentLinkId !== 'string' || !data.paymentLinkId || data.paymentLinkId.length > 200
      || typeof data.description !== 'string' || data.description.length > 200) throw new BadRequestException('Dữ liệu thanh toán không hợp lệ');
    return {...data, fingerprint:createHash('sha256').update(webhook.signature).digest('hex')};
  }
}
