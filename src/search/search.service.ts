import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../database/database.service';
import { ScopedCursor } from '../common/scoped-cursor';
export type SearchHit = { type: string; id: string; title: string; summary: string; rank: number };
export const FEATURE_DESTINATIONS = [
  ['home','Trang chủ Home'], ['inventory','Kho hàng Tủ đồ Inventory'], ['shopping','Đi chợ Cần nhập Shopping'],
  ['profile','Hồ sơ Cá nhân Profile Không gian'], ['security','Bảo mật tài khoản Account Security'],
  ['billing','Gói thanh toán Plans Billing'], ['history','Lịch sử thanh toán Payment history'],
  ['notifications','Thông báo Notifications'], ['help','Trợ giúp Support'],
] as const;
const kinds = ['inventory','shopping','profile','billing','notification','feature','plan'];
type Position = { rank: number; type: string; id: string };
@Injectable()
export class SearchService {
  private readonly cursors = new ScopedCursor();
  constructor(private readonly db: DatabaseService) {}
  async search(userId: string, workspaceId: string, raw: string, limit = 20, cursor?: string, filter = 'all') {
    if (typeof raw !== 'string' || [...raw].length > 120 || !Number.isInteger(limit) || limit < 1 || limit > 50
      || (filter !== 'all' && !kinds.includes(filter))) throw new BadRequestException('Tìm kiếm không hợp lệ.');
    const q = raw.normalize('NFC').trim().replace(/\s+/g,' ');
    const scope = JSON.stringify(['search-v1',userId,workspaceId,q,filter]);
    const position = this.cursors.decode(cursor,scope) as Position | null;
    if (position && (!Number.isInteger(position.rank) || position.rank < 0 || position.rank > 3
      || !kinds.includes(position.type) || typeof position.id !== 'string' || position.id.length > 160)) throw new BadRequestException('Cursor không hợp lệ.');
    return this.db.inWorkspace(userId,workspaceId,async tx => {
      await tx.$executeRaw`set local statement_timeout='750ms'`;
      const member = await tx.workspaceMember.findFirstOrThrow({where:{userId,workspaceId}});
      const features = FEATURE_DESTINATIONS.filter(([id]) => !['billing','history','help'].includes(id) || member.role==='owner');
      if (!q) return {items:(filter==='all'||filter==='feature'?features:[]).slice(0,9).map(([id,title])=>({type:'feature',id,title,summary:'',rank:0})),nextCursor:null,hasMore:false};
      if ([...q.replace(/[^\p{L}\p{N}]/gu,'')].length < 2) return {items:[],nextCursor:null,hasMore:false};
      const normalized = (await tx.$queryRaw<Array<{q:string}>>`select public.search_normalize(${q}) as q`)[0].q;
      const pattern = normalized.replace(/[\\%_]/g,'\\$&') + '%';
      const contains = '%' + pattern;
      const rank = Prisma.sql`case when normalized_title=${normalized} then 0 when normalized like ${pattern} then 1
        when normalized like ${'% ' + pattern} then 2 else 3 end`;
      const batches = kinds.slice(0,5).filter(type => filter==='all'||filter===type).map(type => Prisma.sql`
        (select kind as type,entity_id as id,title,summary,${rank} as rank from public.search_documents
         where workspace_id=${workspaceId}::uuid and kind=${type}
         and (${normalized.length<3} and normalized like ${pattern} or ${normalized.length>=3} and normalized like ${contains})
         and (${position===null} or (${rank},kind,entity_id)>(${position?.rank??-1},${position?.type??''},${position?.id??''}))
         order by rank,kind,entity_id limit ${limit+1})`);
      const databaseRows = batches.length ? await tx.$queryRaw<SearchHit[]>(Prisma.sql`select * from (${Prisma.join(batches,' union all ')}) scoped_results order by rank,type,id limit ${limit+1}`) : [];
      const extras: SearchHit[] = [];
      const score = (title:string) => {
        const t=title.normalize('NFD').replace(/\p{M}/gu,'').replace(/đ/gi,'d').toLowerCase();
        return t===normalized?0:t.startsWith(normalized)?1:t.includes(' '+normalized)?2:t.includes(normalized)?3:-1;
      };
      if (filter==='all'||filter==='feature') for (const [id,title] of features) {
        const n=score(title); if(n>=0) extras.push({type:'feature',id,title,summary:'',rank:n});
      }
      if ((filter==='all'||filter==='plan') && member.role==='owner') {
        const plans = await tx.$queryRaw<Array<{id:string;plan:string}>>`select id,plan from public.search_available_plans(${workspaceId}::uuid)`;
        for (const plan of plans) {
          const names:Record<string,string>={personal:'Cá nhân Personal',family:'Gia đình Family',micro_pos:'Micro-POS Tạp hóa'};
          const title = names[plan.plan]??plan.plan;
          const n=score(title); if(n>=0) extras.push({type:'plan',id:plan.id,title,summary:'Gói thanh toán',rank:n});
        }
      }
      const compare=(a:Position,b:Position)=>a.rank-b.rank||(a.type<b.type?-1:a.type>b.type?1:0)||(a.id<b.id?-1:a.id>b.id?1:0);
      const rows=[...databaseRows,...extras.filter(x=>!position||compare(x,position)>0)].sort(compare);
      const items=rows.slice(0,limit),last=items.at(-1);
      return {items,hasMore:rows.length>limit,nextCursor:rows.length>limit&&last?this.cursors.encode(scope,{rank:last.rank,type:last.type,id:last.id}):null,
        consistency:'LIVE_KEYSET_REFRESH_AFTER_MUTATION'};
    });
  }
  async resolve(userId:string,workspaceId:string,type:string,id:string) {
    if (!kinds.includes(type) || id.length>160) throw new BadRequestException('Đích không hợp lệ.');
    return this.db.inWorkspace(userId,workspaceId,async tx=>{
      await tx.$executeRaw`set local statement_timeout='750ms'`;
      if (type==='feature') {
        const m=await tx.workspaceMember.findFirstOrThrow({where:{userId,workspaceId}});
        if (!FEATURE_DESTINATIONS.some(([key])=>key===id)||(['billing','history','help'].includes(id)&&m.role!=='owner')) throw new NotFoundException();
        return {type,id};
      }
      if (type==='plan') {
        const rows=await tx.$queryRaw<Array<{id:string}>>`select id from public.search_available_plans(${workspaceId}::uuid) where id=${id} limit 1`;
        if(!rows.length)throw new NotFoundException(); return {type,id};
      }
      const rows=await tx.$queryRaw<SearchHit[]>`select kind as type,entity_id as id,title,summary,0 as rank
        from public.search_documents where workspace_id=${workspaceId}::uuid and kind=${type} and entity_id=${id} limit 1`;
      if(!rows.length)throw new NotFoundException('Không còn được phép mở kết quả này.');
      return rows[0];
    });
  }
}
