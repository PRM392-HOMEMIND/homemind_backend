import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { UpdateProfileDto } from '../src/common/dto';

const check = async (value: object) => validate(plainToInstance(UpdateProfileDto, value), { whitelist: true, forbidNonWhitelisted: true });

describe('UpdateProfileDto', () => {
  it('chấp nhận cập nhật một phần', async () => {
    expect(await check({ phone: '0912 345 678' })).toHaveLength(0);
    expect(await check({ address: '12 Nguyễn Huệ, Quận 1' })).toHaveLength(0);
    expect(await check({ language: 'en' })).toHaveLength(0);
    expect(await check({})).toHaveLength(0);
  });

  it('cho phép chuỗi rỗng để xoá số điện thoại', async () => {
    expect(await check({ phone: '' })).toHaveLength(0);
  });

  it('từ chối số điện thoại sai định dạng', async () => {
    expect(await check({ phone: 'abc' })).not.toHaveLength(0);
    expect(await check({ phone: '12345' })).not.toHaveLength(0);
    expect(await check({ phone: '123+45678' })).not.toHaveLength(0);
    expect(await check({ phone: '+' + '1'.repeat(20) })).not.toHaveLength(0);
    expect(await check({ phone: '+' + '1'.repeat(19) })).toHaveLength(0);
    expect(await check({ phone: ' 0912 345 678 ' })).toHaveLength(0);
    expect(await check({ phone: null })).toHaveLength(0);
  });

  it('từ chối ngôn ngữ không hỗ trợ và tên rỗng', async () => {
    expect(await check({ language: 'fr' })).not.toHaveLength(0);
    expect(await check({ displayName: '' })).not.toHaveLength(0);
  });

  it.each([' ', '\t\r\n', '\u00a0\u2003'])('rejects whitespace-only displayName after canonical trim (%j)', async (displayName) => {
    const errors = await check({ displayName });
    expect(errors.some(error => error.property === 'displayName')).toBe(true);
  });

  it.each([null, 123, {}, []])('rejects non-string displayName while omitted name remains optional (%j)', async (displayName) => {
    expect(await check({ displayName })).not.toHaveLength(0);
    expect(await check({})).toHaveLength(0);
  });

  it('validates the trimmed Unicode name and its actual length boundary', async () => {
    const dto = plainToInstance(UpdateProfileDto, { displayName: '  Nguyễn Văn An  ' });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.displayName).toBe('Nguyễn Văn An');
    expect(await check({ displayName: '  ' + 'a'.repeat(120) + '  ' })).toHaveLength(0);
    expect(await check({ displayName: 'a'.repeat(121) })).not.toHaveLength(0);
    expect(await check({ phone: null, address: null })).toHaveLength(0);
  });

  it.each([null, 123, ''])('rejects a null or unsupported language instead of accepting an invalid database value (%j)', async (language) => {
    expect(await check({ language })).not.toHaveLength(0);
    expect(await check({})).toHaveLength(0);
  });

  it('từ chối địa chỉ quá dài', async () => {
    expect(await check({ address: 'x'.repeat(301) })).not.toHaveLength(0);
  });

  it('từ chối trường lạ (không cho sửa email, workspace…)', async () => {
    expect(await check({ email: 'a@b.c' })).not.toHaveLength(0);
  });
});
