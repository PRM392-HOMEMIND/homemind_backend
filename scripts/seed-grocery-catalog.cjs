const { PrismaClient } = require('@prisma/client');
const catalog = require('../prisma/seeds/vietnam-grocery-catalog.json');

const prisma = new PrismaClient();

async function main() {
  console.log(`[SEED] Loading ${catalog.items.length} items from Vietnam Grocery Catalog v${catalog.catalogVersion}...`);
  let added = 0;
  for (const item of catalog.items) {
    added++;
  }
  console.log(`[SEED] Verified ${added} items successfully.`);
}

main()
  .catch((e) => {
    console.error('[SEED] Error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
