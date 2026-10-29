require('./load-env.cjs').loadEnvironment();
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { PrismaClient } = require('@prisma/client');
const argon2 = require('argon2');
const { parsePhoneNumberFromString } = require('libphonenumber-js/max');
const prisma = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
const accounts = [
  { id: '11111111-1111-4111-8111-111111111111', email: 'person@homemind.vn', name: 'Minh Anh', type: 'household', workspace: 'c62147cc-5694-4e46-942f-6c01fe291620', workspaceName: 'Nhà Minh Anh', prefix: 'DEV_PERSON', plan: 'free', limit: 30 },
  { id: '22222222-2222-4222-8222-222222222222', email: 'store@homemind.vn', name: 'Chủ cửa hàng', type: 'store', workspace: '5d7ffda4-5a88-44a2-90d7-ba72b709b3fc', workspaceName: 'Tiệm Tạp Hóa Bình', prefix: 'DEV_STORE', plan: 'micro_pos', limit: 500 },
];
async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Development seed is disabled in production');
  if (!process.env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL is required for seeding');
  await prisma.$transaction(async tx => {
    for (const a of accounts) {
      const password = process.env[a.prefix + '_PASSWORD'];
      if (!password) throw new Error(a.prefix + '_PASSWORD is required');
      const rawPhone = process.env[a.prefix + '_PHONE'];
      const parsed = rawPhone ? parsePhoneNumberFromString(rawPhone, 'VN') : undefined;
      if (rawPhone && !parsed?.isValid()) throw new Error(a.prefix + '_PHONE is invalid');
      await tx.user.upsert({ where: { id: a.id }, update: {}, create: { id: a.id, email: a.email, phone: parsed?.number, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) } });
      await tx.profile.upsert({ where: { id: a.id }, update: {}, create: { id: a.id, displayName: a.name, phone: rawPhone } });
      await tx.workspace.upsert({ where: { id: a.workspace }, update: {}, create: { id: a.workspace, name: a.workspaceName, type: a.type } });
      await tx.workspaceMember.upsert({ where: { workspaceId_userId: { workspaceId: a.workspace, userId: a.id } }, update: {}, create: { workspaceId: a.workspace, userId: a.id, role: 'owner' } });
      await tx.workspaceEntitlement.upsert({ where: { workspaceId: a.workspace }, update: {}, create: { workspaceId: a.workspace, plan: a.plan, productLimit: a.limit, source: a.plan === 'free' ? 'free' : 'legacy_manual' } });
      await tx.notificationPreference.upsert({ where: { userId: a.id }, update: {}, create: { userId: a.id } });
    }
    await tx.$executeRawUnsafe(readFileSync(resolve(__dirname, '../prisma/demo_data.sql'), 'utf8'));
  }, { timeout: 120000 });
  console.log('Development seed complete; existing identities, passwords and business rows preserved.');
}
main().catch(() => { console.error('Seed failed. Check local configuration and database constraints.'); process.exitCode = 1; }).finally(() => prisma.$disconnect());
