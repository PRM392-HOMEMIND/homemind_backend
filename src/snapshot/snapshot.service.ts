import { Injectable,OnModuleDestroy } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { WorkspaceCache } from '../common/workspace-cache';
import { buildSnapshot, Raw, Snapshot, withReads, withRequestedPlan } from './snapshot.compute';

/**
 * One set-based data projection, plus separate entitlement/authorization checks.
 * Shopping is a bounded preview; authenticated paging owns full-list traversal.
 * Cache access is scoped and authorization is rechecked before releasing data.
 */
@Injectable()
export class SnapshotService implements OnModuleDestroy {
  private readonly cache = new WorkspaceCache<Snapshot>(30_000);

  constructor(private readonly db: DatabaseService) {}
  onModuleDestroy(){this.cache.dispose();}

  private async loadRaw(userId: string, workspaceId: string): Promise<Raw> {
    const rows = await this.db.asUser(userId, tx => tx.$queryRaw<Array<{ data: Raw }>>`
      select json_build_object(
        'actor',${userId},'shared',not public.family_can_edit(${workspaceId}::uuid,null),
        'member', exists(select 1 from public.workspace_members where workspace_id = ${workspaceId}::uuid and user_id = ${userId}::uuid),
        'products', coalesce((
          select json_agg(json_build_object('id', p.id, 'name', p.name, 'category', p.category, 'unit', p.default_unit, 'status', p.status,'createdBy',p.created_by)
                          order by p.name asc, p.id asc)
          from public.products p where p.workspace_id = ${workspaceId}::uuid and p.archived_at is null), '[]'::json),
        'lots', coalesce((
          select json_agg(json_build_object('productId', l.product_id, 'lotId', l.id, 'quantity', l.quantity, 'unit', l.unit,
                                             'expiry', to_char(l.expiry_date, 'YYYY-MM-DD'), 'location', l.storage_location, 'known', l.quantity_known,'createdBy',l.created_by)
                          order by l.expiry_date asc nulls last, l.created_at asc)
          from public.inventory_lots l where l.workspace_id = ${workspaceId}::uuid and l.quantity > 0), '[]'::json),
        'shopping', coalesce((
          select json_agg(json_build_object('id', t.id, 'name', t.name, 'quantity', t.quantity, 'unit', t.unit, 'status', t.status,
                                            'source', t.source, 'linkedProductId', t.linked_product_id,'createdBy',t.created_by)
                          order by t.created_at desc, t.id asc)
          from (select s.*, row_number() over (partition by s.status order by s.created_at desc, s.id asc) as rn
                from public.shopping_items s where s.workspace_id = ${workspaceId}::uuid) t
          where t.rn <= 100), '[]'::json),
        'counts', coalesce((
          select json_object_agg(status, c) from (
            select status, count(*)::int as c from public.shopping_items where workspace_id = ${workspaceId}::uuid group by status) x), '{}'::json),
        'suggestions',coalesce((select json_agg(s) from (
          select p.name,'out' as reason,p.id as "productId" from public.products p
          where p.workspace_id=${workspaceId}::uuid and p.status='out' and p.archived_at is null
            and not exists(select 1 from public.shopping_items i where i.workspace_id=p.workspace_id and i.linked_product_id=p.id and i.status='needed')
          order by p.name,p.id limit 50)s),'[]'::json),
        'reads', coalesce((
          select json_agg(notification_key) from public.notification_reads
          where workspace_id = ${workspaceId}::uuid and user_id = ${userId}::uuid), '[]'::json),
        'plan', (select json_build_object('plan', e->>'plan', 'limit', (e->>'productLimit')::integer)
                 from (select public.billing_effective(${workspaceId}::uuid) as e) access),
        'requested', coalesce((
          select json_agg(plan order by created_at) from public.upgrade_requests
          where workspace_id = ${workspaceId}::uuid and user_id = ${userId}::uuid), '[]'::json)
      ) as data`);
    return rows[0].data;
  }

  /** Snapshot của workspace cho người dùng; ném FORBIDDEN nếu không phải thành viên. */
  async get(userId: string, workspaceId: string): Promise<Snapshot> {
    const effective = await this.db.asUser(userId, tx => tx.$queryRaw<Array<{ result: { changed: boolean; plan: string; productLimit: number | null } }>>`
      select public.billing_effective(${workspaceId}::uuid) as result`);
    if (effective[0].result.changed) this.invalidate(workspaceId);
    const load = async () => {
      const raw = await this.loadRaw(userId, workspaceId);
      if (!raw.member) throw new Error('FORBIDDEN');
      return buildSnapshot(raw);
    };
    let snapshot = await this.cache.get(userId, workspaceId, load);
    if (snapshot.home.plan !== effective[0].result.plan || snapshot.home.freePlanLimit !== effective[0].result.productLimit) {
      this.invalidate(workspaceId);
      snapshot=await this.cache.get(userId, workspaceId, load);
    }
    // A cache miss may finish after membership has been revoked. Recheck before releasing protected data.
    const [access]=await this.db.asUser(userId,tx=>tx.$queryRaw<Array<{allowed:boolean}>>`select public.is_workspace_member(${workspaceId}::uuid) as allowed`);
    if(!access.allowed){this.invalidate(workspaceId);throw new Error('FORBIDDEN');}
    return snapshot;
  }

  /** Thông báo đã đọc: cập nhật cache tại chỗ, không phải tải lại. */
  markNotificationsRead(userId: string, workspaceId: string, keys: string[]): void {
    this.cache.update(userId, workspaceId, (snapshot) => withReads(snapshot, keys));
  }

  /** Ghi nhận gói đã yêu cầu nâng cấp ngay trong cache của người dùng. */
  markUpgradeRequested(userId: string, workspaceId: string, plan: string): void {
    this.cache.update(userId, workspaceId, (snapshot) => withRequestedPlan(snapshot, plan));
  }

  invalidate(workspaceId: string): void {
    this.cache.invalidate(workspaceId);
  }
}
