import { PrismaClient } from '@prisma/client';

/** Physical deletion is fixture teardown, never the customer deactivation path.
 * A global outbox worker locks outbox before acquiring recipient FK locks.
 * Remove only these owned recipients' events first, using the same lock order.
 */
export async function deleteFixtureUsers(db: PrismaClient, ids: string[], workspaceIds: string[] = []) {
  if (!ids.length && !workspaceIds.length) return;
  await db.$transaction(async tx => {
    await tx.$queryRaw`select set_config('application_name',${'cleanup-'+ids[0]},true)`;
    await tx.$executeRaw`delete from public.notification_outbox where recipient_id=any(${ids}::uuid[]) or workspace_id=any(${workspaceIds}::uuid[])`;
    if(workspaceIds.length)await tx.workspace.deleteMany({where:{id:{in:workspaceIds}}});
    await tx.user.deleteMany({ where: { id: { in: ids } } });
  });
}
