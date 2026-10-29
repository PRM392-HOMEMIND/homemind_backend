import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { invalidateWorkspace } from '../common/workspace-cache';
import { todayVietnam } from '../common/date';
import { ScopedCursor } from '../common/scoped-cursor';

export type SpendingSummary = {
  month: string;
  totalVnd: number;
  pricedCount: number;
  unpricedCount: number;
  previousTotalVnd: number;
  scope: 'personal'|'workspace'; purchaseCount:number; unpricedLotCount:number; unknownAuthorPurchaseCount:number;
  hasMore:boolean; nextCursor:string|null;
  byCategory: Array<{ category: string | null; totalVnd: number }>;
  unpriced: Array<{ lotId: string; purchaseId:string; productId: string; name: string | null; purchasedAt: string; storageLocation: string | null; createdBy:string|null;canEdit:boolean }>;
};

const MONTH = /^(?!0000)(\d{4})-(0[1-9]|1[0-2])$/;

@Injectable()
export class SpendingService {
  private readonly cursors=new ScopedCursor();
  constructor(private readonly db: DatabaseService) {}

  /** Một truy vấn có chỉ mục (workspace_id, created_at); không cache để thấy ngay giá vừa nhập. */
  async summary(userId: string, workspaceId: string, month?: string,scope='workspace',limit=20,cursor?:string): Promise<SpendingSummary> {
    const text = month ?? todayVietnam().slice(0, 7);
    if (!MONTH.test(text)) throw new BadRequestException('Tháng không hợp lệ (YYYY-MM).');
    if(!['personal','workspace'].includes(scope))throw new BadRequestException('Phạm vi chi tiêu không hợp lệ.');
    if(!Number.isInteger(limit)||limit<1||limit>50)throw new BadRequestException('Cỡ trang phải từ 1 đến 50.');
    const cursorScope=JSON.stringify(['spending',userId,workspaceId,text,scope,'created-desc-id-desc']);
    const position=this.cursors.decode(cursor,cursorScope) as {time:string;id:string}|null;
    if(position&&(!Number.isFinite(Date.parse(position.time))||!/^[0-9a-f-]{36}$/i.test(position.id)))throw new BadRequestException('Cursor không hợp lệ.');
    const rows = await this.db.asUser(userId, async tx => {
      await tx.$executeRaw`set local statement_timeout='2000ms'`;
      return tx.$queryRaw<Array<{ result: SpendingSummary | null }>>`
        select public.spending_page(${workspaceId}::uuid, ${`${text}-01`}::date,${scope},${limit+1}::integer,${position?.time??null}::timestamptz,${position?.id??null}::uuid) as result`;
    });
    const result = rows[0]?.result;
    if (!result) throw new Error('FORBIDDEN');
    const hasMore=result.unpriced.length>limit,unpriced=result.unpriced.slice(0,limit),last=unpriced.at(-1);
    return {...result,unpriced,hasMore,nextCursor:hasMore&&last?this.cursors.encode(cursorScope,{time:last.purchasedAt,id:last.lotId}):null};
  }

  /** Đặt tuyệt đối nên an toàn khi gửi lại; SQL kiểm tra thành viên, khóa dòng và giá trị. */
  async patchLot(userId: string, workspaceId: string, lotId: string, patch: { priceVnd?: number | null; storageLocation?: string | null }) {
    invalidateWorkspace(workspaceId);
    try {
      return await this.db.asUser(userId, async tx => {
        await tx.$executeRaw`set local statement_timeout='2000ms'`;
        const rows = await tx.$queryRaw<Array<{ result: Record<string, unknown> }>>`
          select public.set_lot_details(${workspaceId}::uuid, ${lotId}::uuid, ${JSON.stringify(patch)}::jsonb) as result`;
        return rows[0].result;
      });
    } finally {
      invalidateWorkspace(workspaceId);
    }
  }
}
