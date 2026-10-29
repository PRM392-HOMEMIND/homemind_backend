import { BadRequestException } from '@nestjs/common';
import { isEmail } from 'class-validator';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

export function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!isEmail(email) || email.length > 254) throw new BadRequestException('Email không hợp lệ.');
  return email;
}
export function normalizePhone(value: string): string {
  const phone = parsePhoneNumberFromString(value.trim(), 'VN');
  if (!phone?.isValid()) throw new BadRequestException('Số điện thoại không hợp lệ.');
  return phone.number;
}
export function normalizeIdentifier(value: string): { email: string } | { phone: string } {
  return value.includes('@') ? { email: normalizeEmail(value) } : { phone: normalizePhone(value) };
}
