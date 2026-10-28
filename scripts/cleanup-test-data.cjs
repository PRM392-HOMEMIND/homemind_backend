// Delete only explicitly supplied local test identities. Default: dry run.
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
async function main() {
  const url = new URL(process.env.MIGRATION_DATABASE_URL || '');
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/homemind') throw new Error('Only the local homemind database is supported');
  const ids = process.argv.slice(2).filter(x => x !== '--apply');
  if (!ids.length || ids.some(x => !/^[0-9a-f-]{36}$/i.test(x))) throw new Error('Supply explicit test user UUIDs');
  await db.$transaction(async tx => {
    const users = await tx.user.findMany({ where: { id: { in: ids } } });
    if (users.some(u => !u.email?.startsWith('hmtest+'))) throw new Error('Refusing to remove an account outside the test namespace');
    const memberships = await tx.workspaceMember.findMany({ where: { userId: { in: ids } } });
    const workspaces = [...new Set(memberships.map(m => m.workspaceId))];
    if (await tx.workspaceMember.count({ where: { workspaceId: { in: workspaces }, userId: { notIn: ids } } })) throw new Error('Shared workspace must not be removed');
    console.log('Explicit test users:', users.length, 'Owned workspaces:', workspaces.length);
    if (process.argv.includes('--apply')) {
      await tx.workspace.deleteMany({ where: { id: { in: workspaces } } });
      // Break refresh rotation links before deleting a complete test identity.
      await tx.refreshSession.updateMany({ where: { userId: { in: ids } }, data: { replacedBySessionId: null } });
      await tx.user.deleteMany({ where: { id: { in: ids } } });
    }
  });
}
main().catch(e => { console.error(e.message); process.exitCode=1; }).finally(()=>db.$disconnect());
