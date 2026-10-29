import { Body, Controller, Delete, Get, HttpCode, Options, Param, Post, Query, Req, Res, UseFilters, UseGuards, BadRequestException } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiExcludeEndpoint, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { AdminAuth, AdminErrorFilter, AdminGuard, AdminRequest } from './admin.auth';
import { AdminLoginDto } from './admin.dto';
import { AdminRead, adminId, Query as AdminQuery, Resource, resources } from './admin.read';

export function ReadContract(id:string,schema:string,list:Resource|undefined=undefined):MethodDecorator {
  const decorators:MethodDecorator[]=[ApiOperation({operationId:id}),ApiResponse({status:200,schema:{type:'object',required:['data','meta'],properties:{data:{$ref:'#/components/schemas/'+schema},meta:{$ref:'#/components/schemas/Meta'}}}}),... [400,401,403,404,429,503].map(status=>ApiResponse({status,schema:{$ref:'#/components/schemas/Error'}}))];
  if(list)for(const name of ['limit','cursor','sort','from','to',...resources[list].filters])decorators.push(ApiQuery({name,required:false,type:String,description:'See admin-v1 contract; strict allowlist.'}));
  return (target,key,descriptor)=>decorators.forEach(d=>d(target,key,descriptor));
}
function emptyBody(req:AdminRequest) {if(req.body && Object.keys(req.body).length)throw new BadRequestException('No body allowed.');}
@ApiTags('admin-auth') @ApiCookieAuth('__Host-homemind-admin')
@Controller('admin/auth') @UseGuards(AdminGuard) @UseFilters(AdminErrorFilter)
export class AdminAuthController {
  constructor(private readonly auth:AdminAuth,private readonly read:AdminRead) {}
  private wrap(req:AdminRequest,data:object) {return {data,meta:{requestId:req.requestId,asOf:new Date().toISOString(),version:'admin-v1',freshness:'live_session'}};}
  @Get('csrf') @ReadContract('adminCsrf','Csrf')
  async csrf(@Req()req:AdminRequest,@Res({passthrough:true})res:Response) {return this.wrap(req,await this.auth.csrf(req,res));}
  @Post('login') @HttpCode(200) @ApiBody({type:AdminLoginDto}) @ReadContract('adminLogin','Login')
  async login(@Req()req:AdminRequest,@Res({passthrough:true})res:Response,@Body()body:AdminLoginDto) {return this.wrap(req,await this.auth.login(req,res,body.email,body.password));}
  @Get('me') @ReadContract('adminMe','Identity')
  me(@Req()req:AdminRequest) {return this.read.execute(req,'auth.me',async()=>({id:req.admin!.admin_id,email:req.admin!.email,role:'SYSTEM_ADMIN',sessionId:req.admin!.id,expiresAt:req.admin!.expires_at,capabilities:['customers:read','workspaces:read','payments:read','usage:read','audit:read'],idleSeconds:900,absoluteSeconds:28800}));}
  @Post('refresh') @HttpCode(200) @ReadContract('adminRefresh','Refresh')
  async refresh(@Req()req:AdminRequest,@Res({passthrough:true})res:Response) {emptyBody(req);return this.wrap(req,await this.auth.refresh(req,res));}
  @Post('logout') @HttpCode(200) @ReadContract('adminLogout','Revoked')
  async logout(@Req()req:AdminRequest,@Res({passthrough:true})res:Response) {emptyBody(req);return this.wrap(req,await this.auth.logout(req,res));}
  @Post('logout-all') @HttpCode(200) @ReadContract('adminLogoutAll','Revoked')
  async logoutAll(@Req()req:AdminRequest,@Res({passthrough:true})res:Response) {emptyBody(req);return this.wrap(req,await this.auth.logout(req,res,true));}
  @Get('sessions') @ReadContract('adminSessions','Sessions')
  sessions(@Req()req:AdminRequest) {return this.read.execute(req,'auth.sessions',tx=>tx.$queryRawUnsafe("SELECT id,created_at AS \"createdAt\",last_seen_at AS \"lastSeenAt\",expires_at AS \"expiresAt\",client,id=$2::uuid AS current FROM admin.sessions WHERE admin_id=$1::uuid AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC,id DESC LIMIT 10",req.admin!.admin_id,req.admin!.id));}
  @Delete('sessions/:sessionId') @ApiParam({name:'sessionId',format:'uuid'}) @ReadContract('adminRevokeSession','Revoked')
  async revoke(@Req()req:AdminRequest,@Res({passthrough:true})res:Response,@Param('sessionId')id:string) {emptyBody(req);return this.wrap(req,await this.auth.logout(req,res,false,adminId(id)));}
}
@ApiTags('admin-read') @ApiCookieAuth('__Host-homemind-admin')
@Controller('admin') @UseGuards(AdminGuard) @UseFilters(AdminErrorFilter)
export class AdminReadController {
  constructor(private readonly read:AdminRead) {}
  @Options('*') @HttpCode(204) @ApiExcludeEndpoint()
  preflight(@Req()req:AdminRequest,@Res()res:Response) {
    // The feedback-popup toggle is the only PATCH in the admin API; every other path keeps the original methods.
    const methods=/^\/v1\/admin\/feedback-popup(?:\/|$)/.test(req.path)?['GET','PATCH']:['GET','POST','DELETE'];
    if(!req.headers.origin || !methods.includes(String(req.headers['access-control-request-method'])))throw new BadRequestException();
    const headers=String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean);
    if(headers.some(x=>!['content-type','x-homemind-admin-csrf'].includes(x)))throw new BadRequestException();
    res.setHeader('Access-Control-Allow-Methods',methods.join(', '));res.setHeader('Access-Control-Allow-Headers','Content-Type, X-HomeMind-Admin-CSRF');res.setHeader('Access-Control-Max-Age','300');res.status(204).end();
  }
  @Get('meta') @ReadContract('adminMeta','Vocabulary')
  meta(@Req()req:AdminRequest) {return this.read.execute(req,'meta',async()=>({version:'admin-v1',role:'SYSTEM_ADMIN',plans:['free','personal','family','micro_pos'],segments:['household','store'],accountStatuses:['ACTIVE','DISABLED','DELETED'],orderStatuses:['CREATED','CREATE_UNCERTAIN','PENDING','UNDERPAID','PAID','CANCELLED','EXPIRED','REVIEW'],financialStates:['UNPAID','PARTIAL','PAID','REVIEW'],fulfillments:['NONE','GRANTED','REVIEW'],provenances:['REAL','SIMULATED_TEST','UNCLASSIFIED_LEGACY'],timezones:['Asia/Ho_Chi_Minh','UTC'],pageDefault:25,pageMax:100,readOnly:true,refundsAvailable:false,mfaAvailable:false}));}
  @Get('dashboard/overview') @ReadContract('adminOverview','Overview')
  overview(@Req()r:AdminRequest,@Query()q:AdminQuery) {return this.read.dashboard(r,'overview',q);}
  @Get('dashboard/trends') @ReadContract('adminTrends','Trends')
  trends(@Req()r:AdminRequest,@Query()q:AdminQuery) {return this.read.dashboard(r,'trends',q);}
  @Get('dashboard/plan-distribution') @ReadContract('adminPlanDistribution','PlanDistribution')
  distribution(@Req()r:AdminRequest,@Query()q:AdminQuery) {return this.read.dashboard(r,'plan-distribution',q);}
  @Get('dashboard/top-paying-users') @ReadContract('adminTopPayingUsers','TopPayingUsers')
  top(@Req()r:AdminRequest,@Query()q:AdminQuery) {return this.read.dashboard(r,'top-paying-users',q);}
  @Get('users') @ReadContract('adminUsers','CustomerPage','users')
  users(@Req()r:AdminRequest,@Query()q:AdminQuery) {return this.read.list(r,'users',q);}
  @Get('users/:userId') @ReadContract('adminUser','Customer')
  user(@Req()r:AdminRequest,@Param('userId')id:string) {return this.read.detail(r,'users',id);}
  @Get('users/:userId/workspaces') @ReadContract('adminUserWorkspaces','WorkspacePage','workspaces')
  userWorkspaces(@Req()r:AdminRequest,@Param('userId')id:string,@Query()q:AdminQuery) {return this.read.list(r,'workspaces',q,{userId:adminId(id)});}
  @Get('users/:userId/spending') @ReadContract('adminUserSpending','Spending')
  spending(@Req()r:AdminRequest,@Param('userId')id:string,@Query()q:AdminQuery) {return this.read.spending(r,id,q);}
  @Get('users/:userId/activity') @ReadContract('adminUserActivity','ActivityPage','activity')
  activity(@Req()r:AdminRequest,@Param('userId')id:string,@Query()q:AdminQuery) {return this.read.list(r,'activity',q,{userId:adminId(id)});}
  @Get('workspaces') @ReadContract('adminWorkspaces','WorkspacePage','workspaces')
  workspaces(@Req()r:AdminRequest,@Query()q:AdminQuery) {return this.read.list(r,'workspaces',q);}
  @Get('workspaces/:workspaceId') @ReadContract('adminWorkspace','Workspace')
  workspace(@Req()r:AdminRequest,@Param('workspaceId')id:string) {return this.read.detail(r,'workspaces',id);}
  @Get('workspaces/:workspaceId/members') @ReadContract('adminWorkspaceMembers','MemberPage','members')
  members(@Req()r:AdminRequest,@Param('workspaceId')id:string,@Query()q:AdminQuery) {return this.read.list(r,'members',q,{workspaceId:adminId(id)});}
  @Get('workspaces/:workspaceId/inventory') @ReadContract('adminWorkspaceInventory','InventoryPage','inventory')
  inventory(@Req()r:AdminRequest,@Param('workspaceId')id:string,@Query()q:AdminQuery) {return this.read.list(r,'inventory',q,{workspaceId:adminId(id)});}
  @Get('workspaces/:workspaceId/shopping') @ReadContract('adminWorkspaceShopping','ShoppingPage','shopping')
  shopping(@Req()r:AdminRequest,@Param('workspaceId')id:string,@Query()q:AdminQuery) {return this.read.list(r,'shopping',q,{workspaceId:adminId(id)});}
  @Get('payments') @ReadContract('adminPayments','PaymentPage','payments')
  payments(@Req()r:AdminRequest,@Query()q:AdminQuery) {return this.read.list(r,'payments',q);}
  @Get('payments/:paymentId') @ReadContract('adminPayment','Payment')
  payment(@Req()r:AdminRequest,@Param('paymentId')id:string) {return this.read.detail(r,'payments',id);}
  @Get('payments/:paymentId/transactions') @ReadContract('adminPaymentTransactions','TransactionPage')
  transactions(@Req()r:AdminRequest,@Param('paymentId')id:string,@Query()q:AdminQuery) {return this.read.transactions(r,id,q);}
  @Get('entitlements') @ReadContract('adminEntitlements','EntitlementPage','entitlements')
  entitlements(@Req()r:AdminRequest,@Query()q:AdminQuery) {return this.read.list(r,'entitlements',q);}
  @Get('usage/current') @ReadContract('adminCurrentUsage','Workspace')
  current(@Req()r:AdminRequest,@Query()q:AdminQuery) {if(Object.keys(q).length!==1 || !q.workspaceId)throw new BadRequestException();return this.read.detail(r,'workspaces',q.workspaceId);}
  @Get('usage/periods') @ReadContract('adminUsagePeriods','PeriodPage','periods')
  periods(@Req()r:AdminRequest,@Query()q:AdminQuery) {return this.read.list(r,'periods',q);}
  @Get('usage/requests') @ReadContract('adminUsageRequests','UsageRequestPage','requests')
  requests(@Req()r:AdminRequest,@Query()q:AdminQuery) {return this.read.list(r,'requests',q);}
  @Get('usage/turns') @ReadContract('adminUsageTurns','TurnPage','turns')
  turns(@Req()r:AdminRequest,@Query()q:AdminQuery) {return this.read.list(r,'turns',q);}
  @Get('notifications') @ReadContract('adminNotifications','NotificationPage','notifications')
  notifications(@Req()r:AdminRequest,@Query()q:AdminQuery) {return this.read.list(r,'notifications',q);}
  @Get('notifications/:notificationId') @ReadContract('adminNotification','Notification')
  notification(@Req()r:AdminRequest,@Param('notificationId')id:string) {return this.read.detail(r,'notifications',id);}
  @Get('operations/status') @ReadContract('adminOperations','Operations')
  operations(@Req()r:AdminRequest,@Query()q:AdminQuery) {return this.read.dashboard(r,'operations',q);}
  @Get('audit-logs') @ReadContract('adminAuditLogs','AuditPage','audit')
  audits(@Req()r:AdminRequest,@Query()q:AdminQuery) {return this.read.list(r,'audit',q);}
  @Get('audit-logs/:entryId') @ReadContract('adminAuditLog','Audit')
  audit(@Req()r:AdminRequest,@Param('entryId')id:string) {return this.read.detail(r,'audit',id);}
}
