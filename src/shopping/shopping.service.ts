import { Injectable } from '@nestjs/common';
import { DatabaseService, UserTx } from '../database/database.service';
import { SnapshotService } from '../snapshot/snapshot.service';
import { ScopedCursor } from '../common/scoped-cursor';
import { BadRequestException } from '@nestjs/common';

@Injectable()
export class ShoppingService {
  private readonly cursors = new ScopedCursor();
  constructor(private readonly db: DatabaseService, private readonly snapshots: SnapshotService) {}

  async listIn(tx: UserTx, workspaceId: string, status = 'needed', includeSuggestions = false) {
    if (!['needed','bought','skipped'].includes(status)) throw new Error('VALIDATION_ERROR');
    const [rows, total] = await Promise.all([
      tx.shoppingItem.findMany({ where: { workspaceId, status }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: 100 }),
      tx.shoppingItem.count({ where: { workspaceId, status } }),
    ]);
    const [access] = await tx.$queryRaw<Array<{actor:string;privateSpace:boolean}>>`select public.current_user_id() as actor, public.family_can_edit(${workspaceId}::uuid,null) as "privateSpace"`;
    const items = rows.map((row) => ({ id: row.id, name: row.name, quantity: row.quantity === null ? null : Number(row.quantity), unit: row.unit, status: row.status, source: row.source,createdBy:row.createdBy,canEdit:access.privateSpace||row.createdBy===access.actor }));
    const suggestions = includeSuggestions ? await tx.$queryRaw<Array<{ name: string; reason: string; productId: string }>>`
      select p.name,'out' as reason,p.id as "productId" from public.products p
      where p.workspace_id=${workspaceId}::uuid and p.status='out' and p.archived_at is null
        and not exists(select 1 from public.shopping_items s where s.workspace_id=p.workspace_id and s.linked_product_id=p.id and s.status='needed')
      order by p.name,p.id limit 50` : [];
    return { items, suggestions, total,hasMore:total>items.length,continuation:'SHOPPING_LIST_FIRST_PAGE',limit:100 };
  }

  async list(userId: string, workspaceId: string, status?: string, suggestions?: boolean, limit=50, cursor?:string, q='') {
    const wanted = status ?? 'needed';
    if (!['needed', 'bought', 'skipped'].includes(wanted)) throw new Error('VALIDATION_ERROR');
    if (!Number.isInteger(limit)||limit<1||limit>50||q.length>120) throw new BadRequestException('Bộ lọc không hợp lệ.');
    const scope=JSON.stringify(['shopping',userId,workspaceId,wanted,q,'created-desc-id-desc']);
    const p=this.cursors.decode(cursor,scope) as {time:string;id:string}|null;
    if(p && (!Number.isFinite(Date.parse(p.time))||!/^[0-9a-f-]{36}$/i.test(p.id)))throw new BadRequestException('Cursor không hợp lệ.');
    return this.db.inWorkspace(userId,workspaceId,async tx=>{
      await tx.$executeRaw`set local statement_timeout='2000ms'`;
      type Item={id:string;name:string;quantity:number|null;unit:string|null;status:string;source:string;createdBy:string|null;canEdit:boolean;createdAt:string};
      const [row]=await tx.$queryRaw<Array<{data:{items:Item[];total:number;suggestions:Array<{name:string;reason:string;productId:string}>}}>>`
       select public.shopping_page(${workspaceId}::uuid,${wanted},${q},${limit+1}::integer,
        ${p?.time??null}::timestamptz,${p?.id??null}::uuid,${suggestions===true}) as data`;
      const items=row.data.items.slice(0,limit),last=items.at(-1),hasMore=row.data.items.length>limit;
      return {items:items.map(({createdAt,...item})=>item),suggestions:row.data.suggestions,total:row.data.total,
       hasMore,nextCursor:hasMore&&last?this.cursors.encode(scope,{time:last.createdAt,id:last.id}):null};
    });
  }
}

// Handled by Tran Huu Thang
