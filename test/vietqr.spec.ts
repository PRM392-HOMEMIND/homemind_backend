import { describe, expect, it } from 'vitest';
import { memoMatches, qrTags, verifyTransferQr } from '../src/billing/vietqr';
import { transferQr } from './vietqr.fixture';

describe('signed provider receipt/QR boundaries', () => {
 const description='CSYNTHETIC1 HM1234567';
 const receipt={amount:29000,bin:'000000',accountNumber:'000000000',description,qrCode:transferQr(29000,description)};
 it('accepts a canonical prefixed memo while binding the original request token',()=>{
  expect(memoMatches('HM1234567',description)).toBe(true);
  expect(memoMatches('HM1234567','HM1234567')).toBe(true);
  expect(memoMatches('HM2BA49B7','Qanixg4482  CASSO13103 4 VG9l9jJAwL3dFJpflcO4XZSC HM2BA49B7- Ma GD ACSP tb434978')).toBe(true);
  expect(()=>verifyTransferQr(receipt)).not.toThrow();
 });
 it.each(['OTHER123','HM1234567x','123HM1234567',''])('rejects unbound canonical memo %s',value=>{
  expect(memoMatches('HM1234567',value)).toBe(false);
 });
 it.each([
  {qrCode:transferQr(59000,description)}, {qrCode:transferQr(29000,description,'999999')},
  {qrCode:transferQr(29000,description,'000000','111111111')},
  {qrCode:transferQr(29000,'FOREIGN MEMO')}, {qrCode:receipt.qrCode.slice(0,-4)+'0000'},
  {qrCode:'SYNTHETIC_ONLY'}, {qrCode:receipt.qrCode+'0000'},
 ])('rejects mismatched signed QR content or malformed CRC/length',change=>{
  expect(()=>verifyTransferQr({...receipt,...change})).toThrow('PROVIDER_IDENTITY_CONFLICT');
 });
 it('duplicate/truncated TLV cannot silently override the signed amount',()=>{
  expect(()=>qrTags('540129540159')).toThrow();
  expect(()=>qrTags('540959')).toThrow();
 });
});
