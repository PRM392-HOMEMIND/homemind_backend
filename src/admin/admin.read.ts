import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { AdminAuth, AdminRequest } from './admin.auth';
import { ScopedCursor } from '../common/scoped-cursor';

export type Query = Record<string,string|undefined>;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function adminId(value:string) {if(!uuid.test(value)) throw new BadRequestException('Invalid UUID.');return value.toLowerCase();}
function fail():never {throw new BadRequestException('Invalid admin filter.');}
const base=['limit','cursor','sort','from','to'];
export const resources = {
 users:{table:'admin.customers',time:'created_at',filters:['status','q','segment','plan','paying','provenance'],json:'data'},
 workspaces:{table:'admin.workspaces',time:'created_at',filters:['segment','plan','archived','userId','provenance'],json:'data'},
 payments:{table:'admin.payments',time:'created_at',filters:['status','financialState','fulfillment','provenance','userId','workspaceId'],json:'data'},
 // Promotional time (feedback popup reward) has no order; this contract lists purchased entitlements only.
 entitlements:{table:'public.billing_grants',time:'created_at',filters:['workspaceId','userId','plan'],where:'t.order_id IS NOT NULL',json:"jsonb_build_object('id',id,'workspaceId',workspace_id,'orderId',order_id,'plan',plan,'productLimit',product_limit,'startsAt',starts_at,'expiresAt',coalesce(effective_until,expires_at),'originalExpiresAt',expires_at,'supersededAt',superseded_at,'supersededBy',superseded_by,'createdAt',created_at)"},
 periods:{table:'public.assistant_quota_periods',time:'starts_at',filters:['workspaceId','userId','plan'],json:"jsonb_build_object('id',id,'workspaceId',workspace_id,'plan',plan,'policyVersion',policy_version,'startsAt',starts_at,'expiresAt',expires_at,'grantId',grant_id,'total',usage_limit,'used',used)"},
 requests:{table:'public.assistant_quota_requests',time:'created_at',filters:['workspaceId','userId','state'],json:"jsonb_build_object('id',id,'workspaceId',workspace_id,'actorId',actor_id,'periodId',period_id,'state',state,'createdAt',created_at,'completedAt',completed_at,'leaseUntil',lease_until,'charged',state='COMMITTED')"},
 turns:{table:'public.assistant_turns',time:'created_at',filters:['workspaceId','userId','status','kind'],json:"jsonb_build_object('id',id,'workspaceId',workspace_id,'actorId',user_id,'kind',kind,'status',status,'processingTimeMs',processing_time_ms,'errorCode',error_code,'createdAt',created_at,'expiresAt',expires_at,'committedAt',committed_at)"},
 notifications:{table:'public.in_app_notifications',time:'received_at',filters:['workspaceId','userId','kind','read'],json:"jsonb_build_object('id',id,'recipientId',recipient_id,'workspaceId',workspace_id,'kind',kind,'financial',financial,'targetType',target_type,'targetId',target_id,'occurredAt',occurred_at,'receivedAt',received_at,'readAt',read_at)"},
 activity:{table:'public.notification_outbox',time:'occurred_at',filters:['workspaceId','userId','kind'],json:"jsonb_build_object('id',id,'recipientId',recipient_id,'workspaceId',workspace_id,'kind',kind,'targetType',target_type,'targetId',target_id,'occurredAt',occurred_at,'deliveredAt',delivered_at,'attempts',attempts)"},
 audit:{table:'admin.audit_logs',time:'occurred_at',filters:['adminId','outcome'],json:"jsonb_build_object('id',id,'actorId',actor_id,'requestId',request_id,'action',action,'targetId',target_id,'scopeHash',scope_hash,'outcome',outcome,'rowCount',row_count,'occurredAt',occurred_at)"},
 members:{table:'public.workspace_members',time:'created_at',filters:['workspaceId','userId'],json:"jsonb_build_object('id',id,'workspaceId',workspace_id,'userId',user_id,'role',role,'createdAt',created_at)"},
 inventory:{table:'public.products',time:'created_at',filters:['workspaceId','status'],json:"jsonb_build_object('id',id,'workspaceId',workspace_id,'name',name,'category',category,'status',status,'archivedAt',archived_at,'createdAt',created_at,'updatedAt',updated_at,'nearestExpiry',(select min(l.expiry_date) from public.inventory_lots l where l.product_id=t.id and l.workspace_id=t.workspace_id and l.quantity>0)) || public.inventory_quantity_summary(t.workspace_id,t.id)"},
 shopping:{table:'public.shopping_items',time:'created_at',filters:['workspaceId','status'],json:"jsonb_build_object('id',id,'workspaceId',workspace_id,'name',name,'quantity',quantity::text,'unit',unit,'status',status,'source',source,'linkedProductId',linked_product_id,'createdBy',created_by,'createdAt',created_at,'updatedAt',updated_at)"},
} as const;
export type Resource = keyof typeof resources;
function window(q:Query,defaultWindow=false) {
  if((q.from===undefined)!==(q.to===undefined))fail();
  const parse=(v:string|undefined)=>{if(v===undefined)return null;if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0,19)!==v.slice(0,19))fail();return new Date(v);};
  const to=parse(q.to) || (defaultWindow?new Date():null),from=parse(q.from) || (defaultWindow?new Date(to!.getTime()-30*86400000):null);
  if(Boolean(from)!==Boolean(to) || (from && to && (from>=to || to.getTime()-from.getTime()>366*86400000))) fail();
  return {from,to};
}
function validate(q:Query,allowed:readonly string[]) {for(const [key,v] of Object.entries(q))if(!allowed.includes(key) || typeof v!=='string' || v.length>2048)fail();}
function enumValue(v:string,values:readonly string[]) {if(!values.includes(v))fail();return v;}
@Injectable()
export class AdminRead {
  private readonly cursors=new ScopedCursor();
  constructor(readonly auth:AdminAuth) {}
  /** One per-admin request budget (120/min) shared by every admin read and the audited feedback-popup toggle. */
  async throttle(req:AdminRequest) {
    const key=this.auth.sign('read-limit',req.admin!.admin_id);
    const limit=await this.auth.db.query<{attempts:number}>("INSERT INTO admin.login_limits(key,started_at,attempts) VALUES($1,now(),1) ON CONFLICT(key) DO UPDATE SET started_at=CASE WHEN admin.login_limits.started_at<now()-interval '60 seconds' THEN now() ELSE admin.login_limits.started_at END,attempts=CASE WHEN admin.login_limits.started_at<now()-interval '60 seconds' THEN 1 ELSE admin.login_limits.attempts+1 END RETURNING attempts",key);
    if(limit[0].attempts>120) throw new (require('@nestjs/common').HttpException)({code:'ADMIN_RATE_LIMITED',message:'Try later.'},429);
  }
  async execute<T>(req:AdminRequest,action:string,operation:(tx:Prisma.TransactionClient)=>Promise<T>,target:string|null=null) {
    req.auditScopeHash=this.auth.sign('audit-scope',JSON.stringify([action,Object.entries(req.query || {}).filter(([key])=>key!=='cursor').sort()]));
    await this.throttle(req);
    try {
      const result=await this.auth.db.transaction(async tx=>{
        const [{asOf}]=await tx.$queryRawUnsafe<{asOf:Date}[]>('SELECT now() AS "asOf"');
        return {data:await operation(tx),meta:{requestId:req.requestId,asOf:asOf.toISOString(),version:'admin-v1',freshness:'transaction_snapshot'}};
      },true);
      const d=result.data as {items?:unknown[]};
      const rows=Array.isArray(result.data)?result.data.length:Array.isArray(d?.items)?d.items.length:1;
      await this.auth.audit(req,action,'SUCCESS',rows,target);return result;
    } catch(e) {await this.auth.audit(req,action,'ERROR',null,target);throw e;}
  }
  async list(req:AdminRequest,resource:Resource,q:Query,fixed:Query={}) {
    const spec=resources[resource];validate(q,[...base,...spec.filters]);
    if(Object.keys(fixed).some(k=>q[k]!==undefined && q[k]!==fixed[k]))fail();
    q={...q,...fixed};const size=q.limit===undefined?25:Number(q.limit);
    if(q.limit!==undefined && !/^[1-9]\d{0,2}$/.test(q.limit) || !Number.isInteger(size) || size<1 || size>100)fail();
    enumValue(q.sort || 'newest',['newest','oldest']);const asc=q.sort==='oldest',dir=asc?'ASC':'DESC';
    const w=window(q);const vals:unknown[]=[];const p=(v:unknown)=>{vals.push(v);return '$'+vals.length;};const filters:string[]=[];
    if('where' in spec)filters.push(spec.where);
    if(w.from)filters.push(`t.${spec.time}>=${p(w.from)}::timestamptz AND t.${spec.time}<${p(w.to)}::timestamptz`);
    for(const name of spec.filters) {
      const value=q[name];if(value===undefined)continue;
      if(name==='q') {const term=value.trim();if(term.length>120)fail();if(!term)continue;const s=p('%'+term.replace(/[\\%_]/g,'\\$&')+'%');filters.push(`(lower(t.email) LIKE lower(${s}) OR lower(t.display_name) LIKE lower(${s}) OR t.login_phone LIKE ${s} OR t.contact_phone LIKE ${s} OR t.id::text=${p(term.toLowerCase())})`);}
      else if(['workspaceId','userId','adminId'].includes(name)) {
        const v=p(adminId(value));
        if(name==='workspaceId')filters.push(`t.workspace_id=${v}::uuid`);
        else if(name==='adminId')filters.push(`t.actor_id=${v}::uuid`);
        else if(resource==='workspaces')filters.push(`EXISTS(SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=t.id AND m.user_id=${v}::uuid)`);
        else if(['entitlements','periods'].includes(resource))filters.push(`EXISTS(SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=t.workspace_id AND m.user_id=${v}::uuid)`);
        else filters.push(`t.${['notifications','activity'].includes(resource)?'recipient_id':['members','turns'].includes(resource)?'user_id':'actor_id'}=${v}::uuid`);
      } else if(name==='segment' || (name==='plan' && resource==='users')) {
        const v=p(enumValue(value,name==='segment'?['household','store']:['free','personal','family','micro_pos']));
        filters.push(resource==='users'?`EXISTS(SELECT 1 FROM public.workspace_members m JOIN admin.workspaces w ON w.id=m.workspace_id WHERE m.user_id=t.id AND w.${name==='segment'?'type':'plan'}=${v})`:`t.type=${v}`);
      } else if(name==='paying') {enumValue(value,['true','false']);filters.push(`${value==='false'?'NOT ':''}EXISTS(SELECT 1 FROM admin.payments o WHERE o.actor_id=t.id AND o.completed AND o.provenance='REAL')`);}
      else if(name==='archived') {enumValue(value,['true','false']);filters.push(`t.archived_at IS ${value==='true'?'NOT ':''}NULL`);}
      else if(name==='read') {enumValue(value,['true','false']);filters.push(`t.read_at IS ${value==='true'?'NOT ':''}NULL`);}
      else {const choices:Record<string,readonly string[]>={plan:['free','personal','family','micro_pos'],financialState:['UNPAID','PARTIAL','PAID','REVIEW'],fulfillment:['NONE','GRANTED','REVIEW'],provenance:['REAL','SIMULATED_TEST','UNCLASSIFIED_LEGACY'],state:['RESERVED','RELEASED','COMMITTED'],outcome:['SUCCESS','DENIED','ERROR']};
        let parsed=value;if(name==='status')parsed=enumValue(value,resource==='users'?['ACTIVE','DISABLED','DELETED']:resource==='payments'?['CREATED','CREATE_UNCERTAIN','PENDING','UNDERPAID','PAID','CANCELLED','EXPIRED','REVIEW']:resource==='turns'?['completed','pending_confirmation','committed','cancelled','failed']:resource==='inventory'?['in_stock','out']:['needed','bought','skipped']);
        else if(name==='kind') {if(resource==='turns')enumValue(value,['read_result','write_draft','write_committed','clarify','unknown','cancelled']);else if(!/^[a-z][a-z0-9_.]{0,79}$/.test(value))fail();}else parsed=enumValue(value,choices[name]);
        filters.push(`t.${name==='financialState'?'financial_state':name}=${p(parsed)}`);
      }
    }
    const scope=createHash('sha256').update(JSON.stringify([req.admin!.admin_id,resource,Object.entries(q).filter(([k])=>!['limit','cursor'].includes(k)).sort()])).digest('hex');
    const cursor=this.cursors.decode(q.cursor,scope) as {time?:string;id?:string}|null;
    if(cursor) {if(typeof cursor.time!=='string' || typeof cursor.id!=='string' || !Number.isFinite(Date.parse(cursor.time)))fail();filters.push(`(t.${spec.time},t.id) ${asc?'>':'<'} (${p(cursor.time)}::timestamptz,${p(adminId(cursor.id))}::uuid)`);}
    const projection=resource==='workspaces'&&q.userId!==undefined?`(${spec.json} || jsonb_build_object('membershipRole',(SELECT m.role FROM public.workspace_members m WHERE m.workspace_id=t.id AND m.user_id=${p(adminId(q.userId))}::uuid)))`:spec.json;
    return this.execute(req,'read.'+resource,async tx=>{
      for(const [key,id]of Object.entries(fixed)) {
        const parent=key==='userId'?'admin.customers':'admin.workspaces';
        if(!(await tx.$queryRawUnsafe<object[]>(`SELECT id FROM ${parent} WHERE id=$1::uuid`,id)).length)throw new NotFoundException();
      }
      const rows=await tx.$queryRawUnsafe<{id:string;time:string;data:object}[]>(`SELECT t.id,to_char(t.${spec.time} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') time,${projection} data FROM ${spec.table} t ${filters.length?'WHERE '+filters.join(' AND '):''} ORDER BY t.${spec.time} ${dir},t.id ${dir} LIMIT ${p(size+1)}`,...vals);
      const hasMore=rows.length>size;const items=rows.slice(0,size),last=items.at(-1);
      return {items:items.map(x=>x.data),page:{limit:size,hasMore,nextCursor:hasMore&&last?this.cursors.encode(scope,{time:last.time,id:last.id}):null}};
    },q.userId || q.workspaceId || q.adminId || null);
  }
  detail(req:AdminRequest,resource:'users'|'workspaces'|'payments'|'notifications'|'audit',id:string) {
    adminId(id);const s=resources[resource];return this.execute(req,'detail.'+resource,async tx=>{
      const rows=await tx.$queryRawUnsafe<{data:object}[]>(`SELECT ${s.json} data FROM ${s.table} t WHERE id=$1::uuid`,id);
      if(!rows[0])throw new NotFoundException();return rows[0].data;
    },id);
  }
  transactions(req:AdminRequest,id:string,q:Query) {
    adminId(id);validate(q,['limit','cursor']);const n=q.limit===undefined?25:Number(q.limit);if(q.limit!==undefined && !/^[1-9]\d{0,2}$/.test(q.limit) || !Number.isInteger(n)||n<1||n>100)fail();
    const scope=createHash('sha256').update(req.admin!.admin_id+':transactions:'+id).digest('hex');
    const c=this.cursors.decode(q.cursor,scope) as {time?:string;key?:string}|null;
    if(c && (typeof c.time!=='string'||!Number.isFinite(Date.parse(c.time))||!/^\w{32}$/.test(c.key || '')))fail();
    return this.execute(req,'read.transactions',async tx=>{
      const order=await tx.$queryRawUnsafe<{id:string}[]>('SELECT id FROM admin.payments WHERE id=$1::uuid',id);if(!order.length)throw new NotFoundException();
      const rows=await tx.$queryRawUnsafe<{key:string;time:string;data:object}[]>(`SELECT md5(channel||':'||reference) key,to_char(paid_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') time,jsonb_build_object('orderId',order_id,'reference',reference,'money',jsonb_build_object('currency','VND','amount',amount::text),'paidAt',paid_at) data FROM public.billing_transactions WHERE order_id=$1::uuid AND ($2::timestamptz IS NULL OR (paid_at,md5(channel||':'||reference))<($2::timestamptz,$3)) ORDER BY paid_at DESC,md5(channel||':'||reference) DESC LIMIT $4`,id,c?.time || null,c?.key || null,n+1);
      const last=rows[Math.min(rows.length,n)-1];return {items:rows.slice(0,n).map(x=>x.data),page:{limit:n,hasMore:rows.length>n,nextCursor:rows.length>n?this.cursors.encode(scope,{time:last.time,key:last.key}):null}};
    },id);
  }
  spending(req:AdminRequest,userId:string,q:Query) {
    adminId(userId);validate(q,['from','to','provenance']);const w=window(q),provenance=enumValue(q.provenance || 'REAL',['REAL','SIMULATED_TEST','UNCLASSIFIED_LEGACY']);
    return this.execute(req,'user.spending',async tx=>{if(!(await tx.$queryRawUnsafe<object[]>('SELECT id FROM admin.customers WHERE id=$1::uuid',userId)).length)throw new NotFoundException();
      const [data]=await tx.$queryRawUnsafe<object[]>(`SELECT jsonb_build_object('payerId',$1::text,'provenance',$2::text,'from',$3::timestamptz,'to',$4::timestamptz,'completedPurchases',count(*)::integer,'completedSpending',jsonb_build_object('currency','VND','amount',coalesce(sum(amount),0)::text),'refunds',null,'net',null,'refundAvailability','UNAVAILABLE') data FROM admin.payments WHERE actor_id=$1::uuid AND completed AND provenance=$2 AND currency='VND' AND ($3::timestamptz IS NULL OR (paid_at>=$3::timestamptz AND paid_at<$4::timestamptz))`,userId,provenance,w.from,w.to) as {data:object}[];return (data as {data:object}).data;
    },userId);
  }
  dashboard(req:AdminRequest,kind:'overview'|'trends'|'plan-distribution'|'top-paying-users'|'operations',q:Query) {
    validate(q,kind==='operations'||kind==='plan-distribution'?[]:kind==='top-paying-users'?['from','to','provenance','timezone','limit']:kind==='trends'?['from','to','provenance','timezone','bucket']:['from','to','provenance','timezone']);
    const w=window(q,true),provenance=enumValue(q.provenance || 'REAL',['REAL','SIMULATED_TEST','UNCLASSIFIED_LEGACY']);
    const timezone=enumValue(q.timezone || 'Asia/Ho_Chi_Minh',['Asia/Ho_Chi_Minh','UTC']);const bucket=enumValue(q.bucket || 'day',['day','week','month']);
    const n=q.limit===undefined?25:Number(q.limit);if(q.limit!==undefined && !/^[1-9]\d{0,2}$/.test(q.limit) || !Number.isInteger(n)||n<1||n>100)fail();
    return this.execute(req,'dashboard.'+kind,async tx=>{
      const common={generatedAt:new Date().toISOString(),from:w.from!.toISOString(),to:w.to!.toISOString(),timezone,provenance,definitionsVersion:'admin-v1',refundAvailability:'UNAVAILABLE',refunds:null,net:null};
      if(kind==='plan-distribution') {
        const items=await tx.$queryRawUnsafe<object[]>("SELECT type segment,plan,count(*)::integer workspaces FROM admin.workspaces WHERE archived_at IS NULL AND provenance=$1 GROUP BY type,plan ORDER BY type,plan",provenance);return {...common,items,scope:'current_active_verified_REAL_workspaces; unclassified excluded; one row per workspace'};
      }
      if(kind==='top-paying-users') {
        const items=await tx.$queryRawUnsafe<object[]>("SELECT actor_id AS \"payerId\",count(*)::integer purchases,jsonb_build_object('currency','VND','amount',sum(amount)::text) money FROM admin.payments WHERE completed AND currency='VND' AND provenance=$1 AND paid_at>=$2::timestamptz AND paid_at<$3::timestamptz GROUP BY actor_id ORDER BY sum(amount) DESC,actor_id LIMIT $4",provenance,w.from,w.to,n);return {...common,items,limit:n,scope:'historical_payer_id'};
      }
      if(kind==='trends') {
        const items=await tx.$queryRawUnsafe<object[]>(`WITH buckets AS (SELECT generate_series(date_trunc($1,$2::timestamptz AT TIME ZONE $4),date_trunc($1,($3::timestamptz-interval '1 microsecond') AT TIME ZONE $4),('1 '||$1)::interval) b),sales AS (SELECT date_trunc($1,paid_at AT TIME ZONE $4) b,sum(amount) amount FROM admin.payments WHERE completed AND currency='VND' AND provenance=$5 AND paid_at>=$2::timestamptz AND paid_at<$3::timestamptz GROUP BY 1),signups AS (SELECT date_trunc($1,created_at AT TIME ZONE $4) b,count(*) n FROM admin.customers WHERE provenance=$5 AND created_at>=$2::timestamptz AND created_at<$3::timestamptz GROUP BY 1),usage AS (SELECT date_trunc($1,completed_at AT TIME ZONE $4) b,count(*) n FROM public.assistant_quota_requests r LEFT JOIN admin.workspace_scope s ON s.workspace_id=r.workspace_id WHERE state='COMMITTED' AND coalesce(s.provenance,'UNCLASSIFIED_LEGACY')=$5 AND completed_at>=$2::timestamptz AND completed_at<$3::timestamptz GROUP BY 1) SELECT to_char(buckets.b,'YYYY-MM-DD\"T\"HH24:MI:SS') AS \"bucketLocalStart\",jsonb_build_object('currency','VND','amount',coalesce(sales.amount,0)::text) AS \"completedSales\",coalesce(signups.n,0)::integer signups,coalesce(usage.n,0)::integer AS \"committedUsage\" FROM buckets LEFT JOIN sales USING(b) LEFT JOIN signups USING(b) LEFT JOIN usage USING(b) ORDER BY b`,bucket,w.from,w.to,timezone,provenance);return {...common,bucket,items,comparison:null,comparisonAvailability:'not_requested'};
      }
      if(kind==='operations') {
        const [data]=await tx.$queryRawUnsafe<{data:object}[]>(`SELECT jsonb_build_object('undeliveredNotifications',(SELECT count(*) FROM public.notification_outbox WHERE delivered_at IS NULL),'exhaustedDeliveryAttempts',(SELECT count(*) FROM public.notification_outbox WHERE delivered_at IS NULL AND attempts>=8),'staleReservations',(SELECT count(*) FROM public.assistant_quota_requests WHERE state='RESERVED' AND lease_until<=now()),'missingEntitlements',(SELECT count(*) FROM admin.workspaces WHERE NOT entitlement_known),'quotaAnomalies',(SELECT count(*) FROM public.assistant_quota_periods p WHERE p.used<>(SELECT count(*) FROM public.assistant_quota_requests r WHERE r.period_id=p.id AND state='COMMITTED')),'onlinePresence',null,'providerHealth',null,'availability','database_snapshot_only') data`);return {...common,...data.data};
      }
      const [data]=await tx.$queryRawUnsafe<{data:object}[]>(`SELECT jsonb_build_object(
        'customers',jsonb_build_object('total',(SELECT count(*) FROM admin.customers WHERE provenance=$1),'active',(SELECT count(*) FROM admin.customers WHERE provenance=$1 AND status='ACTIVE'),'disabled',(SELECT count(*) FROM admin.customers WHERE provenance=$1 AND status='DISABLED'),'deleted',(SELECT count(*) FROM admin.customers WHERE provenance=$1 AND status='DELETED'),'newInWindow',(SELECT count(*) FROM admin.customers WHERE provenance=$1 AND created_at>=$2::timestamptz AND created_at<$3::timestamptz),'allRecords',(SELECT count(*) FROM admin.customers),'scopeProvenance',$1::text,'provenanceCounts',(SELECT coalesce(jsonb_object_agg(provenance,n),'{}'::jsonb) FROM (SELECT provenance,count(*) n FROM admin.customers GROUP BY provenance)c)),
        'workspaces',jsonb_build_object('total',(SELECT count(*) FROM admin.workspaces WHERE provenance=$1),'active',(SELECT count(*) FROM admin.workspaces WHERE provenance=$1 AND archived_at IS NULL),'archived',(SELECT count(*) FROM admin.workspaces WHERE provenance=$1 AND archived_at IS NOT NULL),'household',(SELECT count(*) FROM admin.workspaces WHERE provenance=$1 AND type='household'),'store',(SELECT count(*) FROM admin.workspaces WHERE provenance=$1 AND type='store'),'allRecords',(SELECT count(*) FROM admin.workspaces),'scopeProvenance',$1::text,'provenanceCounts',(SELECT coalesce(jsonb_object_agg(provenance,n),'{}'::jsonb) FROM (SELECT provenance,count(*) n FROM admin.workspaces GROUP BY provenance)c)),
        'currentlyPayingCustomers',(SELECT count(DISTINCT p.actor_id) FROM admin.workspaces w JOIN public.billing_grants g ON g.id=w.grant_id JOIN admin.payments p ON p.id=g.order_id JOIN admin.customers u ON u.id=p.actor_id WHERE u.status='ACTIVE' AND w.archived_at IS NULL AND w.source='billing' AND p.completed AND p.provenance=$1 AND u.provenance=$1 AND w.provenance=$1),
        'currentlyCoveredCustomers',(SELECT count(DISTINCT m.user_id) FROM public.workspace_members m JOIN admin.workspaces w ON w.id=m.workspace_id JOIN admin.customers u ON u.id=m.user_id JOIN public.billing_grants g ON g.id=w.grant_id JOIN admin.payments p ON p.id=g.order_id WHERE u.status='ACTIVE' AND w.archived_at IS NULL AND w.source='billing' AND p.completed AND p.provenance=$1 AND u.provenance=$1 AND w.provenance=$1),
        'completedSales',jsonb_build_object('currency','VND','amount',(SELECT coalesce(sum(amount),0)::text FROM admin.payments WHERE completed AND provenance=$1 AND currency='VND' AND paid_at>=$2::timestamptz AND paid_at<$3::timestamptz)),
        'completedPurchases',(SELECT count(*) FROM admin.payments WHERE completed AND provenance=$1 AND paid_at>=$2::timestamptz AND paid_at<$3::timestamptz),
        'verifiedReceipts',jsonb_build_object('currency','VND','amount',(SELECT coalesce(sum(t.amount),0)::text FROM public.billing_transactions t JOIN admin.payments p ON p.id=t.order_id WHERE p.provenance=$1 AND t.paid_at>=$2::timestamptz AND t.paid_at<$3::timestamptz)),
        'attention',jsonb_build_object('orders',(SELECT count(*) FROM admin.payments WHERE provenance=$1 AND (financial_state IN ('PARTIAL','REVIEW') OR financial_state='PAID' AND NOT completed)),'receivedAmount',jsonb_build_object('currency','VND','amount',(SELECT coalesce(sum(amount_paid),0)::text FROM admin.payments WHERE provenance=$1 AND (financial_state IN ('PARTIAL','REVIEW') OR financial_state='PAID' AND NOT completed)))),
        'provenanceCounts',(SELECT coalesce(jsonb_object_agg(provenance,n),'{}'::jsonb) FROM (SELECT provenance,count(*) n FROM admin.payments GROUP BY provenance) x),
        'committedUsageInWindow',(SELECT count(*) FROM public.assistant_quota_requests r LEFT JOIN admin.workspace_scope s ON s.workspace_id=r.workspace_id WHERE state='COMMITTED' AND coalesce(s.provenance,'UNCLASSIFIED_LEGACY')=$1 AND completed_at>=$2::timestamptz AND completed_at<$3::timestamptz),
        'usageByPlan',(SELECT coalesce(jsonb_object_agg(plan,n),'{}'::jsonb) FROM (SELECT p.plan,count(*) n FROM public.assistant_quota_requests r JOIN public.assistant_quota_periods p ON p.id=r.period_id LEFT JOIN admin.workspace_scope s ON s.workspace_id=r.workspace_id WHERE coalesce(s.provenance,'UNCLASSIFIED_LEGACY')=$1 AND r.state='COMMITTED' AND r.completed_at>=$2::timestamptz AND r.completed_at<$3::timestamptz GROUP BY p.plan) u),
        'exhaustedWorkspaces',(SELECT count(*) FROM admin.workspaces WHERE archived_at IS NULL AND remaining=0 AND provenance=$1),
        'upcomingPaidWorkspaces',(SELECT count(*) FROM admin.workspaces WHERE archived_at IS NULL AND paid_expires_at<now()+interval '7 days' AND provenance=$1),
        'expiredUnsupersededGrants',(SELECT count(*) FROM public.billing_grants g LEFT JOIN admin.workspace_scope s ON s.workspace_id=g.workspace_id WHERE coalesce(s.provenance,'UNCLASSIFIED_LEGACY')=$1 AND g.order_id IS NOT NULL AND superseded_at IS NULL AND coalesce(effective_until,expires_at)<=now()),
        'activityAvailability','explicit_login_outbox; no_online_presence') data`,provenance,w.from,w.to);return {...common,...data.data};
    });
  }
}
