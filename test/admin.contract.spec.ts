import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ADMIN_SCHEMAS } from '../src/admin/admin.schemas';
import { adminId,resources } from '../src/admin/admin.read';
import { adminConfiguration } from '../src/admin/admin.database';
describe('admin output, configuration and SQL contract',()=>{
 it('missing admin configuration disables it, partial/malformed/cross-database values fail closed',()=>{
  const before={url:process.env.ADMIN_DATABASE_URL,origins:process.env.ADMIN_WEB_ORIGINS};
  try{
   delete process.env.ADMIN_DATABASE_URL;delete process.env.ADMIN_WEB_ORIGINS;expect(adminConfiguration()).toBeNull();
   process.env.ADMIN_WEB_ORIGINS='https://homemind.vn';expect(()=>adminConfiguration()).toThrow('values withheld');
   const url=new URL(process.env.DATABASE_URL!);url.username='homemind_admin_api';url.password='fixture-only-not-logged';process.env.ADMIN_DATABASE_URL=url.toString();expect(adminConfiguration()?.origins).toEqual(['https://homemind.vn']);
   for(const origin of ['*','https://homemind.vn/path','https://homemind.vn/','https://homemind.vn,https://homemind.vn']){process.env.ADMIN_WEB_ORIGINS=origin;expect(()=>adminConfiguration()).toThrow('values withheld');}
   process.env.ADMIN_WEB_ORIGINS='https://homemind.vn';url.username='homemind_migrator';process.env.ADMIN_DATABASE_URL=url.toString();expect(()=>adminConfiguration()).toThrow('values withheld');
   url.username='homemind_admin_api';process.env.ADMIN_DATABASE_URL=url.toString().replace(/^postgres(?:ql)?:/,'http:');expect(()=>adminConfiguration()).toThrow('values withheld');
  }finally{
   if(before.url===undefined)delete process.env.ADMIN_DATABASE_URL;else process.env.ADMIN_DATABASE_URL=before.url;
   if(before.origins===undefined)delete process.env.ADMIN_WEB_ORIGINS;else process.env.ADMIN_WEB_ORIGINS=before.origins;
  }
 });
 it('all projections exclude credential/payment instructions and assistant content',()=>{
  const source=JSON.stringify(ADMIN_SCHEMAS)+JSON.stringify(resources);
  expect(source).not.toMatch(/password_hash|passwordHash|token_hash|tokenHash|checkoutUrl|checkout_url|qrCode|qr_code|bank_account|raw_input|tools_json/);
  expect(ADMIN_SCHEMAS.Money).toHaveProperty('properties.amount.type','string');
 });
 it('UUIDs and fixed resource names cannot become dynamic SQL identifiers',()=>{
  expect(()=>adminId("';DROP TABLE users;--")).toThrow();expect(adminId('9ac3a4d1-0123-4567-8abc-123456789abc')).toBe('9ac3a4d1-0123-4567-8abc-123456789abc');
  expect(Object.keys(resources)).toHaveLength(13);
 });
 it('migration/role permissions never escalate customer or grant business writes',()=>{
  const migration=readFileSync('prisma/migrations/20261006024000_system_admin/migration.sql','utf8');
  expect(migration).not.toMatch(/bypassrls|disable row level|alter policy|grant all|password '/i);
  const grants=readFileSync('prisma/admin-grants.sql','utf8');expect(grants).not.toMatch(/grant (insert|update|delete).*public\./i);expect(grants).not.toMatch(/grant.*homemind_admin_api to homemind_app/i);
 });
});
