import { BadRequestException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DatabaseService,UserTx } from '../database/database.service';
import { SnapshotService } from '../snapshot/snapshot.service';
import { ScopedCursor } from '../common/scoped-cursor';
import { InfobipProvider } from '../email/infobip.provider';
export type { NotificationItem } from '../snapshot/snapshot.compute';
type Notice = { id: string; title: string; body: string; detail: string; type: string; read: boolean;
  occurredAt: string; receivedAt: string; readAt: string | null; targetType: string; targetId: string | null };
@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private readonly cursors = new ScopedCursor();
  private timer?: NodeJS.Timeout;
  private work?: Promise<unknown>;
  private ticks = 0;
  private stopped = false;
  constructor(private readonly db: DatabaseService, private readonly snapshots: SnapshotService, private readonly email: InfobipProvider = new InfobipProvider()) {}
  private inContext<T>(user:string,workspace:string|null,callback:(tx:UserTx)=>Promise<T>){return workspace===null?this.db.asUser(user,callback):this.db.inWorkspace(user,workspace,callback);}
  onModuleInit() {
    this.timer = setInterval(() => { if (!this.work && !this.stopped) {
      this.work = this.drain(++this.ticks % 5 === 0).catch(() => undefined).finally(() => { this.work = undefined; });
    } }, 1000);
    this.timer.unref();
  }
  async onModuleDestroy() { this.stopped = true; if (this.timer) clearInterval(this.timer); await this.work; }
  async drain(scan = true) {
    return this.db.$transaction(async tx => {
      await tx.$executeRaw`set local statement_timeout='3000ms'`;
      await tx.$executeRaw`set local lock_timeout='250ms'`;
      await tx.$queryRaw`select set_config('app.email_delivery_enabled',${String(this.email.available())},true)`;
      if (scan) {await tx.$queryRaw`select public.family_scan_due()`;await tx.$queryRaw`select public.notification_scan_due()`;}
      return tx.$queryRaw`select public.notification_deliver()`;
    }, { timeout: 5000 });
  }
  async list(userId: string, workspaceId: string|null, limit = 5, cursor?: string, unread = false) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new BadRequestException('Cỡ trang không hợp lệ.');
    const scope = JSON.stringify(['notifications', userId, workspaceId, unread]);
    const position = this.cursors.decode(cursor, scope) as { time: string; id: string } | null;
    if (position && (!Number.isFinite(Date.parse(position.time)) || !/^[\da-f-]{36}$/i.test(position.id))) throw new BadRequestException('Cursor không hợp lệ.');
    return this.inContext(userId, workspaceId, async tx => {
      await tx.$executeRaw`set local statement_timeout='1000ms'`;
      const rows = await tx.$queryRaw<Notice[]>`
        select id,title,summary as body,kind as type,(read_at is not null) as read,
          occurred_at::text as "occurredAt",received_at::text as "receivedAt",read_at::text as "readAt",target_type as "targetType",target_id as "targetId"
        from public.in_app_notifications
        where recipient_id=${userId}::uuid and (workspace_id is null or workspace_id=${workspaceId}::uuid)
        and (not ${unread} or read_at is null)
        and (${position === null} or (received_at,id)<(${position?.time ?? '9999-01-01'}::timestamptz,${position?.id ?? 'ffffffff-ffff-ffff-ffff-ffffffffffff'}::uuid))
        order by received_at desc,id desc limit ${limit}`;
      const items = rows, last = items.at(-1);
      const counts = await tx.$queryRaw<Array<{ count: number; more: boolean }>>`
        select (select count(*)::int from (select 1 from public.in_app_notifications
          where recipient_id=${userId}::uuid and (workspace_id is null or workspace_id=${workspaceId}::uuid) and read_at is null limit 100) u) as count,
          exists(select 1 from public.in_app_notifications where recipient_id=${userId}::uuid
            and (workspace_id is null or workspace_id=${workspaceId}::uuid) and (not ${unread} or read_at is null)
            and ${last !== undefined} and (received_at,id)<(${last?.receivedAt ?? '0001-01-01'}::timestamptz,
              ${last?.id ?? '00000000-0000-0000-0000-000000000000'}::uuid) limit 1) as more`;
      return { items, unreadCount: counts[0].count, hasMore: counts[0].more,
        nextCursor: counts[0].more && last ? this.cursors.encode(scope, { time: last.receivedAt, id: last.id }) : null };
    });
  }
  async detail(userId: string, workspaceId: string|null, id: string) {
    return this.inContext(userId, workspaceId, async tx => {
      await tx.$executeRaw`set local statement_timeout='1000ms'`;
      const rows = await tx.$queryRaw<Notice[]>`select id,title,summary as body,detail,kind as type,(read_at is not null) as read,
       occurred_at::text as "occurredAt",received_at::text as "receivedAt",read_at::text as "readAt",target_type as "targetType",target_id as "targetId"
       from public.in_app_notifications where id=${id}::uuid and recipient_id=${userId}::uuid
        and (workspace_id is null or workspace_id=${workspaceId}::uuid)`;
      if (!rows[0]) throw new NotFoundException('Thông báo không còn được phép truy cập.');
      return rows[0];
    });
  }
  async markRead(userId: string, workspaceId: string|null, id: string) {
    const readAt = await this.inContext(userId, workspaceId, async tx => {
      await tx.$executeRaw`set local statement_timeout='1000ms'`;
      const rows = await tx.$queryRaw<Array<{ id: string; readAt: string }>>`update public.in_app_notifications
        set read_at=coalesce(read_at,clock_timestamp()) where id=${id}::uuid and recipient_id=${userId}::uuid
        and (workspace_id is null or workspace_id=${workspaceId}::uuid) returning id,read_at::text as "readAt"`;
      if (!rows.length) throw new NotFoundException('Thông báo không còn được phép truy cập.');
      return rows[0].readAt;
    });
    return { ok: true, readAt, ...(await this.list(userId, workspaceId, 1)) };
  }
  // Legacy explicit endpoint retained, bounded to 50 authorized unread items.
  async markAllRead(userId: string, workspaceId: string|null, cutoff?:string) {
    return this.inContext(userId, workspaceId, async tx => {
      await tx.$executeRaw`set local statement_timeout='1000ms'`;
      const clock=await tx.$queryRaw<Array<{now:Date}>>`select clock_timestamp() as now`;
      const before=cutoff?new Date(cutoff):clock[0].now;
      if(!Number.isFinite(before.getTime())||before>clock[0].now)throw new BadRequestException('Cutoff không hợp lệ.');
      const n = await tx.$executeRaw`update public.in_app_notifications set read_at=clock_timestamp()
       where id in(select id from public.in_app_notifications where recipient_id=${userId}::uuid
        and (workspace_id is null or workspace_id=${workspaceId}::uuid) and read_at is null and received_at<=${before}
        order by received_at desc,id desc limit 50) and read_at is null`;
      const remaining=await tx.$queryRaw<Array<{count:number}>>`select count(*)::int count from public.in_app_notifications
       where recipient_id=${userId}::uuid and (workspace_id is null or workspace_id=${workspaceId}::uuid) and read_at is null and received_at<=${before}`;
      return { ok: true, readCount: n,cutoff:before.toISOString(),hasMore:remaining[0].count>0,remainingCount:remaining[0].count,complete:remaining[0].count===0 };
    });
  }
}
