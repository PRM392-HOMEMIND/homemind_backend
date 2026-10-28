// Đổi gói của workspace theo email chủ tài khoản (dùng để thử phễu nâng cấp / hạn mức).
//
//   node scripts/set-plan.cjs store@homemind.vn free        -> Miễn phí, tối đa 30 sản phẩm
//   node scripts/set-plan.cjs store@homemind.vn micro_pos   -> Micro-POS, tối đa 500 mặt hàng
//   node scripts/set-plan.cjs person@homemind.vn personal   -> Cá nhân, không giới hạn
//   node scripts/set-plan.cjs person@homemind.vn family     -> Gia đình, không giới hạn
//
// Chỉ sửa MỘT dòng workspace_entitlements của workspace do email đó sở hữu.
// Không có tham số thứ ba thì in ra gói hiện tại (không ghi gì).
require('./load-env.cjs').loadEnvironment();
const { PrismaClient } = require('@prisma/client');

const LIMITS = { free: 30, personal: null, family: null, micro_pos: 500 };
const prisma = new PrismaClient({datasourceUrl: process.env.MIGRATION_DATABASE_URL});

async function main() {
  const [email, plan] = process.argv.slice(2);
  if (!email) {
    console.log('Cách dùng: node scripts/set-plan.cjs <email> [free|personal|family|micro_pos]');
    return;
  }
  const rows = await prisma.$queryRaw`
    select w.id as workspace_id, w.name, w.type, e.plan, e.product_limit
    from public.users u
    join public.workspace_members m on m.user_id = u.id and m.role = 'owner'
    join public.workspaces w on w.id = m.workspace_id
    left join public.workspace_entitlements e on e.workspace_id = w.id
    where lower(u.email) = lower(${email})
    order by m.created_at asc limit 1`;
  const row = rows[0];
  if (!row) {
    console.error(`Không tìm thấy tài khoản ${email}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Hiện tại: ${row.name} (${row.type}) · gói ${row.plan ?? '(chưa có)'} · hạn mức ${row.product_limit ?? 'không giới hạn'}`);
  if (!plan) return;
  if (!(plan in LIMITS)) {
    console.error(`Gói không hợp lệ: ${plan}. Chọn: ${Object.keys(LIMITS).join(', ')}`);
    process.exitCode = 1;
    return;
  }
  await prisma.$executeRaw`
    insert into public.workspace_entitlements (workspace_id, plan, product_limit, source, updated_at)
    values (${row.workspace_id}::uuid, ${plan}, ${LIMITS[plan]}::int, ${plan === 'free' ? 'free' : 'legacy_manual'}, now())
    on conflict (workspace_id) do update set plan = excluded.plan, product_limit = excluded.product_limit, source = excluded.source, updated_at = now()`;
  console.log(`Đã đổi sang gói ${plan} (hạn mức ${LIMITS[plan] ?? 'không giới hạn'}). Bộ nhớ đệm của server tự hết hạn sau tối đa 30 giây.`);
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
