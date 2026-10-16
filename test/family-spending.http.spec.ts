import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {LocalFamilyHttp,LocalAccount} from './support/local-family-http';
describe.skipIf(process.env.RUN_DB_TESTS!=='1')('Family attributed purchases and bounded pages over real HTTP',()=>{
 const h=new LocalFamilyHttp();beforeAll(()=>h.start(),30000);afterAll(()=>h.close());
 const add=(a:LocalAccount,ws:string,body:object)=>h.call(a,`/workspaces/${ws}/inventory/items`,'POST',body);
 it('separates recorded personal spending from workspace total, null from zero, and rejects peer edits',async()=>{
  const [owner,member]=await h.family(2),ws=owner.ws;
  const a=await add(owner,ws,{productName:'Gạo chung',quantity:5,unit:'kg',priceVnd:100000});expect(a.status).toBe(201);
  const b=await add(member,ws,{productName:'Trứng được tặng',quantity:3,unit:'quả',priceVnd:0});expect(b.status).toBe(201);
  const unknown=await add(member,ws,{productName:'Muối chưa ghi giá'});expect(unknown.status).toBe(201);
  await add(member,member.ws,{productName:'Riêng tư',priceVnd:900000});
  expect((await h.call(member,`/workspaces/${ws}/spending?scope=workspace`)).body).toMatchObject({totalVnd:100000,pricedCount:2,unpricedCount:1,purchaseCount:3});
  const personal=await h.call(member,`/workspaces/${ws}/spending?scope=personal`);
  expect(personal.body).toMatchObject({totalVnd:0,pricedCount:1,unpricedCount:1,purchaseCount:2,scope:'personal'});
  expect(personal.body.unpriced[0]).toMatchObject({createdBy:member.id,canEdit:true});
  expect((await h.call(owner,`/workspaces/${ws}/spending?scope=workspace`)).body.unpriced[0].canEdit).toBe(false);
  const lot=b.body.created.lotIds[0];
  expect((await h.call(owner,`/workspaces/${ws}/lots/${lot}`,'PATCH',{priceVnd:1})).status).toBe(403);
  expect((await h.call(member,`/workspaces/${ws}/lots/${lot}`,'PATCH',{priceVnd:1})).status).toBe(200);
 });
 it('preserves total price, original purchase count and author when expiry splits an existing lot',async()=>{
  const [owner,member]=await h.family(2),ws=owner.ws;
  const r=await add(member,ws,{productName:'Mì tách hạn',quantity:5,unit:'gói',priceVnd:50001});expect(r.status).toBe(201);
  const product=r.body.created.productIds[0];
  await h.db.operation(member.id,ws,randomUUID(),'inventory.set_expiry',{productId:product,quantity:2,expiryDate:'2026-12-01'});
  const lots=await h.fixtures.$queryRaw<Array<{purchase_id:string;created_by:string;price_vnd:bigint}>>`select purchase_id,created_by,price_vnd from public.inventory_lots where workspace_id=${ws}::uuid`;
  expect(lots).toHaveLength(2);expect(new Set(lots.map(l=>l.purchase_id)).size).toBe(1);expect(lots.every(l=>l.created_by===member.id)).toBe(true);
  expect(lots.reduce((s,l)=>s+l.price_vnd,0n)).toBe(50001n);
  expect((await h.call(member,`/workspaces/${ws}/spending?scope=personal`)).body).toMatchObject({totalVnd:50001,pricedCount:1,purchaseCount:1});
  await expect(h.db.operation(owner.id,ws,randomUUID(),'inventory.set_expiry',{productId:product,quantity:1,expiryDate:'2026-12-02'})).rejects.toThrow('CONTRIBUTION_FORBIDDEN');
  expect((await h.call(member,`/workspaces/${ws}/spending`)).body.totalVnd).toBe(50001);
 });
 it('supports more than 30 missing-price rows with scoped keyset paging and no false completion',async()=>{
  const a=await h.account();
  for(let i=0;i<35;i++)expect((await add(a,a.ws,{productName:'Nhiều lần mua cùng sản phẩm'})).status).toBe(201);
  const seen:string[]=[];let cursor:string|null=null,loops=0;
  do{
   const r=await h.call(a,`/workspaces/${a.ws}/spending?limit=10${cursor?'&cursor='+encodeURIComponent(cursor):''}`);expect(r.status).toBe(200);
   expect(r.body).toMatchObject({unpricedCount:35,unpricedLotCount:35});seen.push(...r.body.unpriced.map((l:any)=>l.lotId));cursor=r.body.nextCursor;expect(r.body.hasMore).toBe(cursor!==null);loops++;
  }while(cursor&&loops<5);
  expect(seen).toHaveLength(35);expect(new Set(seen).size).toBe(35);expect(cursor).toBeNull();
  const first=await h.call(a,`/workspaces/${a.ws}/spending?limit=10`);
  expect((await h.call(a,`/workspaces/${a.ws}/spending?scope=personal&cursor=${encodeURIComponent(first.body.nextCursor)}`)).status).toBe(400);
 });
 it('allows an owned contribution to a peer product without transferring metadata ownership',async()=>{
  const [owner,a]=await h.family(2),ws=owner.ws;
  const seed=await add(owner,ws,{productName:'Táo'});expect(seed.status).toBe(201);const product=seed.body.created.productIds[0];
  const contributed=await add(a,ws,{productName:'Táo',productCandidateId:product,quantity:2,unit:'quả',priceVnd:20000});expect(contributed.status).toBe(201);
  const detail=await h.call(a,`/workspaces/${ws}/inventory/${product}`);
  expect(detail.status).toBe(200);expect(detail.body).toMatchObject({createdBy:owner.id,canEdit:false});
  // Check DB metadata too; the new lot belongs to the contributor, the product does not.
  expect((await h.fixtures.product.findUniqueOrThrow({where:{id:product}})).createdBy).toBe(owner.id);
  expect((await h.fixtures.inventoryLot.findUniqueOrThrow({where:{id:contributed.body.created.lotIds[0]}})).createdBy).toBe(a.id);
 });
 it('accepts the exact numeric(12,3) upper boundary and rejects excess precision before any write',async()=>{
  const a=await h.account();
  const r=await add(a,a.ws,{productName:'Giới hạn',quantity:999999999.999,unit:'g'});expect(r.status).toBe(201);
  expect((await add(a,a.ws,{productName:'Sai độ chính xác',quantity:0.0009})).status).toBe(400);
  expect(await h.fixtures.product.count({where:{workspaceId:a.ws}})).toBe(1);
 });
});
