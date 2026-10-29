import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {SwaggerModule,DocumentBuilder,OpenAPIObject} from '@nestjs/swagger';
import {LocalFamilyHttp,LocalAccount} from './support/local-family-http';

describe.skipIf(process.env.RUN_DB_TESTS!=='1')('D04/D07 actual HTTP contract and bounded projections',()=>{
 const h=new LocalFamilyHttp();let document:OpenAPIObject,ajv:any;
 beforeAll(async()=>{
  await h.start();document=SwaggerModule.createDocument(h.app,new DocumentBuilder().setTitle('HomeMind local contracts').setVersion('1').addBearerAuth().build());
  // These validators are already locked by the Nest CLI toolchain, no network dependency.
  const Ajv=require('ajv');ajv=new Ajv({strict:false,allErrors:true});require('ajv-formats')(ajv);
  ajv.addSchema({$id:'workspace-contract',components:document.components});
 },30000);
 afterAll(()=>h.close());
 function schema(path:string,method:string,status:number){
  const response=(document.paths[path] as any)?.[method]?.responses?.[String(status)];
  expect(response?.content?.['application/json']?.schema,path+' '+method).toBeDefined();
  return ajv.compile({$ref:undefined,...response.content['application/json'].schema,components:document.components});
 }
 function checked(path:string,method:string,response:{status:number;body:any}){
  expect([200,201],`${path} ${method}: HTTP ${response.status}, code ${response.body?.error?.code??'none'}`).toContain(response.status);
  const validate=schema(path,method,response.status);
  expect(validate(response.body),JSON.stringify(validate.errors)).toBe(true);
  return response.body;
 }
 it('validates documented profile/preview examples and actual Assistant response with fresh replay quota',async()=>{
  const examples=JSON.parse(readFileSync(resolve(__dirname,'support/api-examples.json'),'utf8'));
  const me=examples.profile,validateMe=schema('/v1/me','get',200);
  expect(validateMe(me),JSON.stringify(validateMe.errors)).toBe(true);
  const request=examples.assistantRequest;
  const requestSchema=(document.paths['/v1/assistant/turn'] as any).post.requestBody.content['application/json'].schema;
  const checkRequest=ajv.compile({...requestSchema,components:document.components});
  expect(checkRequest(request),JSON.stringify(checkRequest.errors)).toBe(true);
  const {requestId,...withoutId}=request;expect(checkRequest(withoutId)).toBe(false);
  const preview=examples.invitationPreview;
  const validatePreview=schema('/v1/workspaces/{id}/invitations/validate','post',200);
  expect(validatePreview(preview),JSON.stringify(validatePreview.errors)).toBe(true);
  const a=await h.account();let calls=0;h.planner.plan=async()=>{calls++;return {toolId:'inventory.list',arguments:{}};};
  checked('/v1/assistant/turn','post',await h.turn(a));
  const bad=await h.call(a,'/assistant/turn','POST',{...withoutId,workspaceId:a.ws});expect(bad.status).toBe(400);expect(calls).toBe(1);
 });
 it('documents actual profile, Family, invitation, batch and departure shapes; rejects contract drift',async()=>{
  const owner=await h.account('family'),a=await h.account(),b=await h.account();
  const me=checked('/v1/me','get',await h.call(owner,'/me'));
  const validateMe=schema('/v1/me','get',200);
  const {voiceQuota,...missing}=me;expect(validateMe(missing)).toBe(false);
  expect(validateMe({...me,voiceQuota:{...voiceQuota,remaining:'100'}})).toBe(false);
  checked('/v1/me/workspaces','get',await h.call(owner,'/me/workspaces'));
  checked('/v1/me/workspace-context','post',await h.call(owner,'/me/workspace-context','POST',{workspaceId:owner.ws}));
  const overview=()=>h.call(owner,`/workspaces/${owner.ws}/family`);
  checked('/v1/workspaces/{id}/family','get',await overview());
  const emails=a.email+','+b.email;
  const preview=checked('/v1/workspaces/{id}/invitations/validate','post',await h.call(owner,`/workspaces/${owner.ws}/invitations/validate`,'POST',{emails}));
  expect(JSON.stringify(preview)).not.toContain(a.id);
  const batch=checked('/v1/workspaces/{id}/invitations/batch','post',await h.call(owner,`/workspaces/${owner.ws}/invitations/batch`,'POST',{emails,validationToken:preview.validationToken}));
  const invitation=batch.invitations[0].invitationId;
  checked('/v1/me/workspace-invitations','get',await h.call(a,'/me/workspace-invitations'));
  checked('/v1/workspaces/{id}/invitations','get',await h.call(owner,`/workspaces/${owner.ws}/invitations`));
  checked('/v1/me/workspace-invitations/{invitationId}','get',await h.call(a,`/me/workspace-invitations/${invitation}`));
  checked('/v1/me/workspace-invitations/{invitationId}/accept','post',await h.call(a,`/me/workspace-invitations/${invitation}/accept`,'POST'));
  const family=checked('/v1/workspaces/{id}/family','get',await overview());
  expect(family.members).toHaveLength(2);
  expect(JSON.stringify(family)).not.toMatch(/password|token|email|rawInput|raw_input|phone|address/i);
  checked('/v1/workspaces/{id}/family/members/{userId}','delete',await h.call(owner,`/workspaces/${owner.ws}/family/members/${a.id}`,'DELETE'));
  checked('/v1/workspaces/{id}/family/end','post',await h.call(owner,`/workspaces/${owner.ws}/family/end`,'POST'));
 });
 it('traverses every shopping status beyond100, with tied timestamps, truthful bootstrap and bound cursor scope',async()=>{
  const owner=await h.account('family'),foreign=await h.account();
  await h.fixtures.$executeRaw`insert into public.shopping_items(workspace_id,name,status,source,created_by,created_at)
   select ${owner.ws}::uuid,'Hàng '||n,s,'manual',${owner.id}::uuid,'2026-10-01T00:00:00Z'::timestamptz from generate_series(1,107)n cross join unnest(array['needed','bought','skipped'])s`;
  const bootstrap=checked('/v1/workspaces/{id}/bootstrap','get',await h.call(owner,`/workspaces/${owner.ws}/bootstrap`));
  expect(bootstrap.shopping.items).toHaveLength(300);
  for(const status of ['needed','bought','skipped']){
   expect(bootstrap.shopping.pagination[status]).toMatchObject({loaded:100,total:107,hasMore:true,continuation:'SHOPPING_LIST_FIRST_PAGE'});
   const ids=new Set<string>();let cursor:string|null=null,firstCursor='';let pages=0;
   do{
    const response=await h.call(owner,`/workspaces/${owner.ws}/shopping-items?status=${status}&limit=30${cursor?'&cursor='+encodeURIComponent(cursor):''}`);
    expect(response.status).toBe(200);const page=checked('/v1/workspaces/{id}/shopping-items','get',response);
    expect(page.total).toBe(107);expect(page.items.length).toBeLessThanOrEqual(30);
    for(const row of page.items){expect(ids.has(row.id)).toBe(false);ids.add(row.id);expect(row.canEdit).toBe(true);}
    cursor=page.nextCursor;if(!firstCursor&&cursor)firstCursor=cursor;expect(++pages).toBeLessThanOrEqual(4);
   }while(cursor);
   expect(ids.size).toBe(107);
   expect((await h.call(owner,`/workspaces/${owner.ws}/shopping-items?status=${status}&q=changed&cursor=${firstCursor}`)).status).toBe(400);
   expect((await h.call(foreign,`/workspaces/${owner.ws}/shopping-items?status=${status}&cursor=${firstCursor}`)).status).toBe(400);
  }
  const [product]=await h.fixtures.$queryRaw<Array<{id:string}>>`insert into public.products(workspace_id,name,name_normalized,status) values(${owner.ws}::uuid,'Sản phẩm đã hết','san pham da het','out') returning id`;
  await h.fixtures.$executeRaw`update public.shopping_items set linked_product_id=${product.id}::uuid where id=(select id from public.shopping_items where workspace_id=${owner.ws}::uuid and status='needed' order by created_at desc,id desc offset 106 limit 1)`;
  const response=await h.call(owner,`/workspaces/${owner.ws}/shopping-items?includeSuggestions=true`);
  expect(response.body.suggestions).toEqual([]);
 });
 it('keeps query count constant for1vs5 relatives and1vs50 rows; schemas validate known and unknown quantities and spending',async()=>{
  const [owner,a]=await h.family(2);
  const measured=async(account:LocalAccount,path:string,label:string)=>{
   const response=await h.call(account,path,'GET',undefined,randomUUID(),undefined,label);expect(response.status).toBe(200);
   return {response,measurement:h.measurements.get(label)!};
  };
  const small=await measured(owner,`/workspaces/${owner.ws}/family`,'family-small');
  for(let n=0;n<4;n++){
   const relative=await h.account();const invite=await h.call(owner,`/workspaces/${owner.ws}/invitations`,'POST',{email:relative.email});expect(invite.status).toBe(201);
   expect((await h.call(relative,`/me/workspace-invitations/${invite.body.invitationId}/accept`,'POST')).status).toBe(200);
  }
  const full=await measured(owner,`/workspaces/${owner.ws}/family`,'family-full');
  expect(small.response.body.members).toHaveLength(2);expect(full.response.body.members).toHaveLength(6);
  expect(full.measurement.queries).toBe(small.measurement.queries);
  await h.fixtures.$executeRaw`insert into public.shopping_items(workspace_id,name,status,source,created_by) select ${owner.ws}::uuid,'Gạo '||n,'needed','manual',${a.id}::uuid from generate_series(1,55)n`;
  const one=await measured(owner,`/workspaces/${owner.ws}/shopping-items?limit=1`,'shopping-one');
  const fifty=await measured(owner,`/workspaces/${owner.ws}/shopping-items?limit=50`,'shopping-fifty');
  expect(fifty.response.body.items).toHaveLength(50);expect(fifty.response.body.items.every((r:any)=>!r.canEdit)).toBe(true);
  expect(fifty.measurement.queries).toBe(one.measurement.queries);
  const create=await h.call(a,`/workspaces/${owner.ws}/inventory/items`,'POST',{productName:'Sữa chưa ghi lượng'});expect(create.status).toBe(201);
  const list=checked('/v1/workspaces/{id}/inventory','get',await h.call(owner,`/workspaces/${owner.ws}/inventory`));
  expect(list.items[0]).toMatchObject({quantity:null,quantityState:'unknown',canEdit:false});
  const product=list.items[0].productId;
  checked('/v1/workspaces/{id}/inventory/{productId}','get',await h.call(owner,`/workspaces/${owner.ws}/inventory/${product}`));
  checked('/v1/workspaces/{id}/spending','get',await h.call(owner,`/workspaces/${owner.ws}/spending`));
  checked('/v1/workspaces/{id}/notifications/read-all','post',await h.call(owner,`/workspaces/${owner.ws}/notifications/read-all`,'POST',{}));
  const productId=randomUUID();
  await h.fixtures.$executeRaw`insert into public.products(id,workspace_id,name,name_normalized,created_by) values(${productId}::uuid,${owner.ws}::uuid,'Local bulk item','local bulk item',${a.id}::uuid)`;
  await h.fixtures.$executeRaw`insert into public.inventory_lots(workspace_id,product_id,quantity,quantity_known,created_by) select ${owner.ws}::uuid,${productId}::uuid,1,false,${a.id}::uuid from generate_series(1,55)`;
  const spendOne=await measured(owner,`/workspaces/${owner.ws}/spending?limit=1`,'spending-one');
  const spendFifty=await measured(owner,`/workspaces/${owner.ws}/spending?limit=50`,'spending-fifty');
  expect(spendFifty.response.body.unpriced).toHaveLength(50);expect(spendFifty.measurement.queries).toBe(spendOne.measurement.queries);
  console.log(JSON.stringify({queryEvidence:{family1Relative:small.measurement.queries,family5Relatives:full.measurement.queries,shopping1:one.measurement.queries,shopping50:fifty.measurement.queries,spending1:spendOne.measurement.queries,spending50:spendFifty.measurement.queries},scope:'Prisma statements; SQL nested plans measured separately'}));
 });
});
