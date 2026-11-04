/**
 * Utility script to bootstrap or rotate the initial System Admin account.
 * Usage:
 *   node scripts/create-admin.cjs <email> <password>
 * Example:
 *   node scripts/create-admin.cjs admin@homemind.vn "HomeMind@Admin#2026!SecureKey$"
 */
'use strict';
require('./load-env.cjs').loadEnvironment();
const { PrismaClient } = require('@prisma/client');
const argon2 = require('argon2');

async function main() {
  const email = (process.argv[2] || 'admin@homemind.vn').trim().toLowerCase();
  const password = process.argv[3] || 'HomeMind@Admin#2026!SecureKey$';

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Email không hợp lệ.');
  }

  if (
    password.length < 20 ||
    password.length > 128 ||
    !/[a-z]/.test(password) ||
    !/[A-Z]/.test(password) ||
    !/[0-9]/.test(password) ||
    !/[^A-Za-z0-9]/.test(password)
  ) {
    throw new Error(
      'Mật khẩu phải từ 20-128 ký tự, bao gồm chữ hoa, chữ thường, số và ký tự đặc biệt.'
    );
  }

  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('Cần biến môi trường DATABASE_URL hoặc MIGRATION_DATABASE_URL');

  const prisma = new PrismaClient({ datasourceUrl: url, log: [] });
  try {
    const hash = await argon2.hash(password, { type: argon2.argon2id });

    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        "SELECT pg_advisory_xact_lock(hashtextextended('homemind.admin.initial', 0))"
      );
      const existing = await tx.$queryRawUnsafe(
        "SELECT id, email, status FROM admin.principals WHERE bootstrap_key = 'initial'"
      );

      if (existing.length) {
        // Update password and ensure active
        await tx.$executeRawUnsafe(
          'UPDATE admin.principals SET email = $1, password_hash = $2, password_changed_at = now(), status = $3 WHERE id = $4::uuid',
          email,
          hash,
          'ACTIVE',
          existing[0].id
        );
        await tx.$executeRawUnsafe(
          'UPDATE admin.sessions SET revoked_at = coalesce(revoked_at, now()) WHERE admin_id = $1::uuid',
          existing[0].id
        );
        await tx.$executeRawUnsafe(
          "INSERT INTO admin.audit_logs(actor_id, request_id, action, outcome) VALUES($1::uuid, gen_random_uuid(), 'operator.rotate', 'SUCCESS')",
          existing[0].id
        );
        return { action: 'UPDATED', id: existing[0].id, email, status: 'ACTIVE' };
      }

      const [created] = await tx.$queryRawUnsafe(
        "INSERT INTO admin.principals(bootstrap_key, email, password_hash, status) VALUES('initial', $1, $2, 'ACTIVE') RETURNING id, email, status",
        email,
        hash
      );
      await tx.$executeRawUnsafe(
        "INSERT INTO admin.audit_logs(actor_id, request_id, action, outcome) VALUES($1::uuid, gen_random_uuid(), 'operator.bootstrap', 'SUCCESS')",
        created.id
      );
      return { action: 'CREATED', id: created.id, email: created.email, status: created.status };
    });

    console.log('\n=============================================');
    console.log('  HỆ THỐNG QUẢN TRỊ HOMEMIND - TÀI KHOẢN ADMIN');
    console.log('=============================================');
    console.log(` Trạng thái : ${result.action}`);
    console.log(` Admin ID   : ${result.id}`);
    console.log(` Email      : ${result.email}`);
    console.log(` Mật khẩu   : ${password}`);
    console.log('=============================================\n');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Lỗi khởi tạo tài khoản admin:', err.message);
  process.exit(1);
});
