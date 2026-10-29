import { describe, expect, it } from 'vitest';
import { consumptionBilling, consumptionPayment, externalBillingAllowed, requireExternalBilling } from '../src/billing/billing-distribution';

describe('consumption-only billing contract',()=>{
 const pending={id:'owned',status:'PENDING',financialState:'UNPAID',price:{plan:'personal',amount:29000,checkoutUrl:'https://pay.payos.vn/hidden'},
  qr:{payload:'QR_SECRET',bin:'970000',accountNumber:'OWNED_ACCOUNT',accountName:'OWNED_RECEIVER',description:'OWNED_MEMO',amount:29000},
  checkoutUrl:'https://pay.payos.vn/owned',providerDetails:{bank:'OWNED_BANK'},futureProviderField:'OWNED_MEMO',
  grant:{plan:'personal',startsAt:'2026-10-06',checkoutUrl:'https://pay.payos.vn/hidden'}};
 it('all mobile channels are read-only, including explicit direct and malformed metadata',()=>{
  for(const channel of [undefined,null,'','store','direct','debug','DIRECT','direct, store',['direct'],'untrusted']) {
   expect(externalBillingAllowed(channel)).toBe(false);expect(()=>requireExternalBilling(channel)).toThrow();
  }
 });
 it('pending/read projection removes every instruction, including unknown/nested fields, without changing the source',()=>{
  const projected=consumptionPayment(pending);
  expect(projected).toEqual({id:'owned',status:'PENDING',financialState:'UNPAID',price:{plan:'personal'},grant:{plan:'personal',startsAt:'2026-10-06'}});
  expect(pending.qr.accountNumber).toBe('OWNED_ACCOUNT');
  expect(consumptionBilling({payments:[pending],nextOffset:20,futureProviderField:'OWNED_MEMO'})).toEqual({payments:[projected],nextOffset:20,checkoutEnabled:false});
 });
 it('retains paid receipt amounts and subscription dates, never receiver or provider instructions',()=>{
  const paid=consumptionPayment({...pending,status:'PAID',financialState:'PAID',amountPaid:29000});
  expect(paid.price).toEqual({plan:'personal',amount:29000});expect(paid.amountPaid).toBe(29000);
  expect(JSON.stringify(paid)).not.toContain('pay.payos.vn');expect(paid).not.toHaveProperty('qr');
 });
});
