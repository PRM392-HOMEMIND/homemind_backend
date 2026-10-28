// Isolated CI upgrade rehearsal. Never used against a production database.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
if (process.env.HOMEMIND_ISOLATED_CI !== '1') throw new Error('Isolated CI only');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'homemind-migrations-'));
try {
  fs.mkdirSync(path.join(root, 'migrations'));
  fs.copyFileSync('prisma/schema.prisma', path.join(root, 'schema.prisma'));
  fs.copyFileSync('prisma/migrations/migration_lock.toml', path.join(root, 'migrations/migration_lock.toml'));
  const names = fs.readdirSync('prisma/migrations').filter(n => /^\d{14}_/.test(n)).sort();
  const mode = process.argv[2] || 'all';
  let selected = names;
  if (mode === 'initial') selected = names.slice(0, 1);
  else if (mode === 'legacy-billing') {
    if (!/^\/homemind_upgrade_[a-f0-9]{12}$/.test(new URL(process.env.MIGRATION_DATABASE_URL).pathname)) throw new Error('Owned upgrade database required');
    const boundary = '20261003008000_billing_durable_cancellation';
    if (!names.includes(boundary)) throw new Error('Legacy billing boundary missing');
    selected = names.filter(name => name <= boundary);
  } else if (mode !== 'all') throw new Error('Unknown migration rehearsal mode');
  for (const name of selected) fs.cpSync(path.join('prisma/migrations', name), path.join(root, 'migrations', name), { recursive: true });
  const config = path.join(root, 'prisma.config.ts');
  fs.writeFileSync(config, `import {defineConfig} from ${JSON.stringify(require.resolve('prisma/config'))}; process.env.DATABASE_URL=process.env.MIGRATION_DATABASE_URL; export default defineConfig({schema:${JSON.stringify(path.join(root,'schema.prisma'))},migrations:{path:${JSON.stringify(path.join(root,'migrations'))}},datasource:{url:process.env.MIGRATION_DATABASE_URL}});`);
  execFileSync('./node_modules/.bin/prisma', ['migrate', 'deploy', '--config', config], { stdio: 'inherit' });
} finally { fs.rmSync(root, { recursive: true, force: true }); }
