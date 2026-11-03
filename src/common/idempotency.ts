import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';

export function idempotencyKey(value: string | undefined): string {
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestException('Thiếu hoặc sai Idempotency-Key UUID.');
  }
  return value;
}

/** Sinh UUID ổn định từ key gốc, dùng cho bước thứ hai của một thao tác gồm nhiều bước. */
export function derivedIdempotencyKey(base: string, suffix: string): string {
  const h = createHash('sha1').update(`${base}:${suffix}`).digest('hex');
  const variant = (8 + (parseInt(h[16], 16) % 4)).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// Handled by Tran Huu Thang
