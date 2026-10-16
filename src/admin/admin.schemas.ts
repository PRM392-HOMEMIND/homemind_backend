/** Explicit output allowlist; shared by OpenAPI and contract tests, never DB serialization. */
type Schema = Record<string,unknown>;
const text=(nullable=false):Schema=>({type:'string',nullable});
const id=(nullable=false):Schema=>({...text(nullable),format:'uuid'});
const date=(nullable=false):Schema=>({...text(nullable),format:'date-time'});
const int:Schema={type:'integer',minimum:0};const bool:Schema={type:'boolean'};
const ref=(name:string):Schema=>({$ref:'#/components/schemas/'+name});
const array=(name:string):Schema=>({type:'array',items:ref(name)});
const object=(properties:Record<string,Schema>):Schema=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
const money=ref('Money');
const commonMetric={generatedAt:date(),from:date(),to:date(),timezone:text(),provenance:text(),definitionsVersion:text(),refundAvailability:text(),refunds:{nullable:true,enum:[null]},net:{nullable:true,enum:[null]}};
export const ADMIN_SCHEMAS:Record<string,Schema>={
 Meta:object({requestId:id(),asOf:date(),version:text(),freshness:text()}),
 Error:object({error:object({code:text(),message:text(),requestId:id(),fields:{type:'array',items:object({field:text(),code:{type:'string',enum:['INVALID_VALUE','UNKNOWN_PROPERTY']}})}})}),
 Money:object({currency:{type:'string',enum:['VND']},amount:{type:'string',pattern:'^[0-9]+$'}}),
 Page:object({limit:{...int,minimum:1,maximum:100},hasMore:bool,nextCursor:text(true)}),
 Csrf:object({csrfToken:text(),expiresIn:int}),
 Login:object({id:id(),email:{type:'string',format:'email'},role:{type:'string',enum:['SYSTEM_ADMIN']},sessionId:id(),expiresAt:date(),csrfToken:text()}),
 Refresh:object({sessionId:id(),expiresAt:date(),csrfToken:text()}),
 Revoked:object({revoked:bool}),
 Identity:object({id:id(),email:{type:'string',format:'email'},role:{type:'string',enum:['SYSTEM_ADMIN']},sessionId:id(),expiresAt:date(),capabilities:{type:'array',items:text()},idleSeconds:int,absoluteSeconds:int}),
 Session:object({id:id(),createdAt:date(),lastSeenAt:date(),expiresAt:date(),client:{type:'string',enum:['browser','other']},current:bool}),
 Sessions:array('Session'),
 Customer:object({id:id(),email:text(true),loginPhone:text(true),contactPhone:text(true),displayName:text(true),address:text(true),language:text(true),status:{type:'string',enum:['ACTIVE','DISABLED','DELETED']},createdAt:date(),updatedAt:date(),deletedAt:date(true),termsAcceptedAt:date(true),privacyAcceptedAt:date(true),lastExplicitLoginAt:date(true),lastLoginSource:text()}),
 Quota:object({periodId:id(true),plan:text(),policyVersion:text(),startsAt:date(),expiresAt:date(),total:int,used:int,reserved:int,remaining:int,projectionOnly:bool,entitlementKnown:bool}),
 Workspace:object({id:id(),name:text(),type:{type:'string',enum:['household','store']},createdAt:date(),updatedAt:date(),archivedAt:date(true),plan:text(),source:text(),entitlementKnown:bool,freeLifetimeAccess:bool,productLimit:{type:'integer',nullable:true},productCount:int,grantId:id(true),paidExpiresAt:date(true),quota:ref('Quota')}),
 Member:object({id:id(),workspaceId:id(),userId:id(),role:{type:'string',enum:['owner','member']},createdAt:date()}),
 Payment:object({id:id(),workspaceId:id(),payerId:id(),orderCode:text(),plan:text(),priceId:text(),money,amountPaid:money,status:text(),financialState:text(),fulfillment:text(),reviewReason:text(true),createdAt:date(),paidAt:date(true),cancelledAt:date(true),expiresAt:date(),attempts:int,nextCheckAt:date(),provenance:text(),completedSale:bool}),
 Transaction:object({orderId:id(),reference:text(),money,paidAt:date()}),
 Entitlement:object({id:id(),workspaceId:id(),orderId:id(),plan:text(),productLimit:{type:'integer',nullable:true},startsAt:date(),expiresAt:date(),originalExpiresAt:date(),supersededAt:date(true),supersededBy:id(true),createdAt:date()}),
 Period:object({id:id(),workspaceId:id(),plan:text(),policyVersion:text(),startsAt:date(),expiresAt:date(),grantId:id(true),total:int,used:int}),
 UsageRequest:object({id:id(),workspaceId:id(),actorId:id(),periodId:id(),state:{type:'string',enum:['RESERVED','RELEASED','COMMITTED']},createdAt:date(),completedAt:date(true),leaseUntil:date(),charged:bool}),
 Turn:object({id:id(),workspaceId:id(),actorId:id(),kind:text(),status:text(),processingTimeMs:{type:'integer',nullable:true},errorCode:text(true),createdAt:date(),expiresAt:date(true),committedAt:date(true)}),
 Activity:object({id:id(),recipientId:id(),workspaceId:id(true),kind:text(),targetType:text(),targetId:text(true),occurredAt:date(),deliveredAt:date(true),attempts:int}),
 Notification:object({id:id(),recipientId:id(),workspaceId:id(true),kind:text(),financial:bool,targetType:text(),targetId:text(true),occurredAt:date(),receivedAt:date(),readAt:date(true)}),
 Audit:object({id:id(),actorId:id(true),requestId:id(),action:text(),targetId:id(true),outcome:{type:'string',enum:['SUCCESS','DENIED','ERROR']},rowCount:{type:'integer',nullable:true},occurredAt:date()}),
 QuantityGroup:object({unit:text(true),knownQuantity:text(),unknownLots:int}),
 Inventory:object({id:id(),workspaceId:id(),name:text(),category:text(true),unit:text(true),status:text(),archivedAt:date(true),createdAt:date(),updatedAt:date(),quantity:text(true),quantityState:{type:'string',enum:['empty','known','unknown','mixed','incompatible_units']},quantityBreakdown:array('QuantityGroup'),nearestExpiry:{type:'string',format:'date',nullable:true}}),
 Shopping:object({id:id(),workspaceId:id(),name:text(),quantity:text(true),unit:text(true),status:text(),source:text(),linkedProductId:id(true),createdBy:id(),createdAt:date(),updatedAt:date()}),
 Spending:object({payerId:id(),provenance:text(),from:date(true),to:date(true),completedPurchases:int,completedSpending:money,refunds:{nullable:true,enum:[null]},net:{nullable:true,enum:[null]},refundAvailability:text()}),
 Overview:object({...commonMetric,customers:object({total:int,active:int,disabled:int,deleted:int,newInWindow:int}),workspaces:object({total:int,active:int,archived:int,household:int,store:int}),currentlyPayingCustomers:int,completedSales:money,completedPurchases:int,verifiedReceipts:money,attention:object({orders:int,receivedAmount:money}),provenanceCounts:{type:'object',additionalProperties:int},committedUsageInWindow:int,exhaustedWorkspaces:int,upcomingPaidWorkspaces:int,expiredUnsupersededGrants:int,activityAvailability:text()}),
 TrendItem:object({bucketLocalStart:text(),completedSales:money,signups:int,committedUsage:int}),
 Trends:object({...commonMetric,bucket:{type:'string',enum:['day','week','month']},items:array('TrendItem'),comparison:{nullable:true,enum:[null]},comparisonAvailability:text()}),
 PlanDistributionItem:object({segment:text(),plan:text(),workspaces:int}),
 PlanDistribution:object({...commonMetric,items:array('PlanDistributionItem'),scope:text()}),
 TopPayingItem:object({payerId:id(),purchases:int,money}),
 TopPayingUsers:object({...commonMetric,items:array('TopPayingItem'),limit:int,scope:text()}),
 Operations:object({...commonMetric,undeliveredNotifications:int,exhaustedDeliveryAttempts:int,staleReservations:int,missingEntitlements:int,quotaAnomalies:int,onlinePresence:{nullable:true,enum:[null]},providerHealth:{nullable:true,enum:[null]},availability:text()}),
 Vocabulary:object({version:text(),role:text(),plans:{type:'array',items:text()},segments:{type:'array',items:text()},accountStatuses:{type:'array',items:text()},orderStatuses:{type:'array',items:text()},financialStates:{type:'array',items:text()},fulfillments:{type:'array',items:text()},provenances:{type:'array',items:text()},timezones:{type:'array',items:text()},pageDefault:int,pageMax:int,readOnly:bool,refundsAvailable:bool,mfaAvailable:bool}),
};
const overviewProperties=ADMIN_SCHEMAS.Overview.properties as Record<string,Schema>;
for(const name of ['Customer','Workspace']) { (ADMIN_SCHEMAS[name].properties as Record<string,Schema>).provenance={type:'string',enum:['REAL','SIMULATED_TEST','UNCLASSIFIED_LEGACY']}; (ADMIN_SCHEMAS[name].required as string[]).push('provenance'); }
for(const name of ['customers','workspaces']) { const group=overviewProperties[name]; Object.assign(group.properties as object,{allRecords:int,scopeProvenance:text(),provenanceCounts:{type:'object',additionalProperties:int}}); (group.required as string[]).push('allRecords','scopeProvenance','provenanceCounts'); }
overviewProperties.usageByPlan={type:'object',additionalProperties:int};
overviewProperties.currentlyCoveredCustomers=int;
(ADMIN_SCHEMAS.Overview.required as string[]).push('currentlyCoveredCustomers');
(ADMIN_SCHEMAS.Overview.required as string[]).push('usageByPlan');
(ADMIN_SCHEMAS.Workspace.properties as Record<string,Schema>).membershipRole={type:'string',enum:['owner','member'],nullable:true};
(ADMIN_SCHEMAS.Workspace.required as string[]).push('membershipRole');
(ADMIN_SCHEMAS.Audit.properties as Record<string,Schema>).scopeHash=text(true);
(ADMIN_SCHEMAS.Audit.required as string[]).push('scopeHash');
for(const name of ['Customer','Workspace','Member','Payment','Transaction','Entitlement','Period','UsageRequest','Turn','Activity','Notification','Audit','Inventory','Shopping'])ADMIN_SCHEMAS[name+'Page']=object({items:array(name),page:ref('Page')});
