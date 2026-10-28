// Marker data stays inside an ephemeral CI database, never the owner's database.
const { PrismaClient } = require('@prisma/client');
const { randomUUID, randomBytes } = require('node:crypto');
const argon2 = require('argon2');
if (process.env.HOMEMIND_ISOLATED_CI !== '1') throw new Error('Isolated CI only');
const db = new PrismaClient();
(async () => {
  const email = 'isolated-upgrade@example.com';
  if (process.argv[2] === 'seed') {
    // Seed runs before additive migrations. Returning only the original ID
    // avoids selecting consent columns that do not exist at this boundary.
    const user = await db.user.create({ data: { email, passwordHash: await argon2.hash(randomBytes(32)) }, select: { id: true } });
    await db.$transaction(async tx => {
      await tx.$queryRaw`select set_config('app.user_id',${user.id},true)`;
      const rows = await tx.$queryRaw`select public.provision_home(${user.id}::uuid,'Upgrade marker','household') as id`;
      await tx.$queryRaw`select public.apply_operation(${rows[0].id}::uuid,${randomUUID()}::uuid,'inventory.add','{"productName":"Preserved upgrade marker","quantity":2,"unit":"hộp"}'::jsonb,null::uuid)`;
    });
  } else {
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    await db.$transaction(async tx => {
      await tx.$queryRaw`select set_config('app.user_id',${user.id},true)`;
      if (await tx.product.count({ where: { name: 'Preserved upgrade marker' } }) !== 1) throw new Error('Upgrade lost marker data');
      const lots = await tx.inventoryLot.findMany();
      if (lots.length !== 1 || Number(lots[0].quantity) !== 2) throw new Error('Upgrade changed inventory');
    });
  }
  console.log('Migration '+process.argv[2]+' PASS');
})().finally(() => db.$disconnect()).catch(() => { console.error('Migration fixture FAIL'); process.exitCode=1; });
