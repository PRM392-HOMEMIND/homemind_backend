import { BadRequestException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { environment } from '../config/env';
/** Signed metadata bound to the authenticated scope; never a credential. */
export class ScopedCursor {
  private readonly key = environment().accessSecret;
  encode(scope: string, position: unknown) {
    const data = Buffer.from(JSON.stringify({ v: 1, scope, position, until: Date.now() + 900_000 })).toString('base64url');
    return data + '.' + createHmac('sha256', this.key).update('homemind.cursor.v1.' + data).digest('base64url');
  }
  decode(value: string | undefined, scope: string): unknown {
    if (!value) return null;
    try {
      if (value.length > 2048) throw new Error();
      const parts = value.split('.');
      if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0])) throw new Error();
      const signature = Buffer.from(parts[1], 'base64url');
      const expected = createHmac('sha256', this.key).update('homemind.cursor.v1.' + parts[0]).digest();
      if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) throw new Error();
      const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      if (data.v !== 1 || data.scope !== scope || !Number.isSafeInteger(data.until) || data.until < Date.now()) throw new Error();
      return data.position;
    } catch { throw new BadRequestException({ code: 'INVALID_CURSOR', message: 'Trang dữ liệu đã hết hạn hoặc không hợp lệ. Hãy tải lại.' }); }
  }
}
export function pageSize(value?: string, fallback = 20) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 50) throw new BadRequestException('Cỡ trang phải từ 1 đến 50.');
  return n;
}
