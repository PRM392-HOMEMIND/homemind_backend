import { describe, expect, it, vi } from 'vitest';
import { validate } from 'class-validator';
import { AddInventoryDto, AddShoppingDto, MarkOutDto, PatchShoppingDto, ReceiveShoppingDto } from '../src/common/dto';
import { computeInventory, Raw } from '../src/snapshot/snapshot.compute';
import { HomeService } from '../src/home/home.service';

const raw: Raw = { member:true, products:[{id:'p',name:'Gạo',unit:'kg',category:null,status:'in_stock'}], lots:[], shopping:[],counts:{},reads:[],plan:{plan:'family',limit:null} };
describe('D01 truthful quantity, units and subtotal', () => {
  it.each([
    [[], 0, 'empty'],
    [[{quantity:2,unit:'kg',known:true}],2,'known'],
    [[{quantity:1,unit:'kg',known:false}],null,'unknown'],
    [[{quantity:2,unit:'kg',known:true},{quantity:1,unit:'kg',known:false}],null,'mixed'],
    [[{quantity:2,unit:'kg',known:true},{quantity:500,unit:'g',known:true}],null,'incompatible_units'],
    [[{quantity:0.1,unit:'kg',known:true},{quantity:0.2,unit:'kg',known:true}],0.3,'known'],
  ])('does not invent a total for %j', (lots, quantity, quantityState) => {
    const value=computeInventory({...raw,lots:lots.map((x,i)=>({...x,productId:'p',lotId:String(i),expiry:null}))})[0];
    expect(value.quantity).toBe(quantity);
    expect(value).toMatchObject({quantityState});
  });
});

describe('D02 bounded numeric(12,3) input before SQL', () => {
  const cases=[ [AddInventoryDto,{productName:'Gạo'}], [AddShoppingDto,{name:'Gạo'}], [MarkOutDto,{addToShoppingList:false}], [PatchShoppingDto,{}], [ReceiveShoppingDto,{}] ] as const;
  for(const [Dto,body] of cases) {
    it(`${Dto.name} preserves unknown and accepted boundaries`,async()=>{
      for(const quantity of [null,undefined,0.001,0.3,999999999.999])expect(await validate(Object.assign(new Dto(),body,{quantity}))).toEqual([]);
    });
    it(`${Dto.name} rejects overflow, precision, strings and nonfinite`,async()=>{
      for(const quantity of [0,-1,1e12,1000000000,0.0001,1.2345,NaN,Infinity,'1']) {
        const errors=await validate(Object.assign(new Dto(),body,{quantity}));
        expect(errors.some(e=>e.property==='quantity'),String(quantity)).toBe(true);
      }
    });
  }
});

describe('D03 effective unlimited Home projection',()=>{
  it('preserves explicit null instead of treating it as missing',async()=>{
    const tx={$queryRaw:vi.fn().mockResolvedValue([{plan:'family',product_limit:null}])};
    const inventory={listIn:vi.fn().mockResolvedValue({items:[],total:0})};
    const shopping={listIn:vi.fn().mockResolvedValue({total:0})};
    const service=new HomeService({} as never,inventory as never,shopping as never,{} as never);
    expect(await service.summaryIn(tx as never,'w')).toMatchObject({plan:'family',freePlanLimit:null});
  });
});
