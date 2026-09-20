// Local transport only: production never imports this module. The official SDK
// signs/verifies requests/responses; these are synthetic bank transactions.
import { PayOS } from '@payos/node';
import { randomBytes, randomUUID } from 'node:crypto';
import { PayosProvider } from '../src/billing/payos.provider';
import type { CreatePaymentLinkRequest, PaymentLink } from '@payos/node';
import { transferQr } from './vietqr.fixture';

export function sdkFixture() {
  const keys = {clientId:'HomeMind-synthetic-fixture-only',apiKey:randomBytes(24).toString('hex'),checksumKey:randomBytes(32).toString('hex')};
  process.env.PAYOS_ENABLED='true'; process.env.PAYOS_CLIENT_ID=keys.clientId;
  process.env.PAYOS_API_KEY=keys.apiKey; process.env.PAYOS_CHECKSUM_KEY=keys.checksumKey;
  const links=new Map<number,PaymentLink>(), descriptions=new Map<number,string>();
  const calls={create:0,get:0,cancel:0};
  const createDeadlines:Array<{orderCode:number;expiredAt:number}>=[];
  let failAfterCreate=false, unavailable=false, rejectTerminalCancel=false;
  let rejectCreate:{status:number;code:string}|undefined;
  let missingResponse = {status:404,code:'231',desc:'Synthetic order not found'};
  let memoPrefix = '';
  let onCreate:((code:number)=>Promise<void>)|undefined;
  const signer=new PayOS({...keys,logLevel:'off',maxRetries:0});
  const response=async(data:object)=>new Response(JSON.stringify({code:'00',desc:'success',data,signature:await signer.crypto.createSignatureFromObj(data,keys.checksumKey)}),{status:200,headers:{'content-type':'application/json'}});
  const fetcher:typeof fetch=async(input,init)=>{
    if(unavailable) throw Error('Synthetic provider unavailable');
    const url=new URL(String(input)), method=(init?.method??'GET').toUpperCase();
    const headers=new Headers(init?.headers);
    if(headers.get('x-api-key')!==keys.apiKey||headers.get('x-client-id')!==keys.clientId) throw Error('Synthetic transport credential mismatch');
    const body=init?.body?JSON.parse(String(init.body)):null;
    if(method==='POST' && url.pathname==='/v2/payment-requests') {
      calls.create++;
      createDeadlines.push({orderCode:body.orderCode,expiredAt:body.expiredAt});
      if(await signer.crypto.createSignatureOfPaymentRequest(body,keys.checksumKey)!==body.signature) throw Error('Synthetic transport request signature mismatch');
      if(rejectCreate) {const rejection=rejectCreate;rejectCreate=undefined;return new Response(JSON.stringify({code:rejection.code,desc:'Synthetic create rejection'}),{status:rejection.status,headers:{'content-type':'application/json'}});}
      if(links.has(body.orderCode)) return new Response(JSON.stringify({code:'409',desc:'Duplicate synthetic order'}),{status:409});
      const id=randomUUID().replaceAll('-','');
      const link={id,orderCode:body.orderCode,amount:body.amount,amountPaid:0,amountRemaining:body.amount,status:'PENDING' as const,createdAt:new Date().toISOString(),transactions:[],cancellationReason:null,canceledAt:null};
      const memo = memoPrefix + body.description;
      links.set(body.orderCode,link); descriptions.set(body.orderCode,memo);
      if(onCreate) await onCreate(body.orderCode);
      if(failAfterCreate) {failAfterCreate=false;throw Error('Synthetic lost create response');}
      return response({paymentLinkId:id,orderCode:body.orderCode,amount:body.amount,description:memo,currency:'VND',status:'PENDING',checkoutUrl:'https://pay.payos.vn/web/'+id,qrCode:transferQr(body.amount,memo),accountNumber:'000000000',accountName:'LOCAL TEST ONLY',bin:'000000'});
    }
    const code=Number(url.pathname.split('/')[3]), link=links.get(code);
    if(!link) return new Response(JSON.stringify({code:missingResponse.code,desc:missingResponse.desc}),{status:missingResponse.status,headers:{'content-type':'application/json'}});
    if(method==='POST' && url.pathname.endsWith('/cancel')) {
      calls.cancel++;
      if(rejectTerminalCancel&&['CANCELLED','EXPIRED'].includes(link.status))return new Response(JSON.stringify({code:'409',desc:'Synthetic terminal cancellation rejection'}),{status:409,headers:{'content-type':'application/json'}});
      if(link.status!=='PAID') link.status='CANCELLED';
    }
    else calls.get++;
    return response(structuredClone(link));
  };
  const provider=new PayosProvider();
  Object.defineProperty(provider,'client',{value:new PayOS({...keys,fetch:fetcher,baseURL:'https://api-merchant.payos.vn',logLevel:'off',timeout:1000,maxRetries:0})});
  return {provider,links,descriptions,calls,createDeadlines,
    setMissingResponse(value?:{status:number;code:string;desc:string}){missingResponse=value??{status:404,code:'231',desc:'Synthetic order not found'};},
    setMemoPrefix(value=''){memoPrefix=value;},
    rejectNextCreate(status:number,code='409'){rejectCreate={status,code};},
    rejectDuplicateCancel(value:boolean){rejectTerminalCancel=value;},
    beforeCreateResponse(callback?:((code:number)=>Promise<void>)){onCreate=callback;},
    setUnavailable(value:boolean){unavailable=value;},loseNextCreate(){failAfterCreate=true;},
    pay(code:number,amount?:number,reference=randomUUID()) {
      const link=links.get(code)!; const value=amount??link.amount;
      link.amountPaid=value; link.amountRemaining=Math.max(0,link.amount-value);link.status=value>=link.amount?'PAID':'UNDERPAID';
      link.transactions=[{reference,amount:value,accountNumber:'000000000',description:descriptions.get(code)!,transactionDateTime:new Date().toISOString(),virtualAccountName:null,virtualAccountNumber:null,counterAccountBankId:null,counterAccountBankName:null,counterAccountName:null,counterAccountNumber:null}];
    },
    async webhook(code:number,changes:Record<string,unknown>={}) {
      const link=links.get(code)!, t=link.transactions[0];
      const data={orderCode:code,amount:t?.amount??link.amount,description:descriptions.get(code)!,accountNumber:'000000000',reference:t?.reference??randomUUID(),transactionDateTime:t?.transactionDateTime??new Date().toISOString(),currency:'VND',paymentLinkId:link.id,code:'00',desc:'success',...changes};
      return {code:'00',desc:'success',success:true,data,signature:await signer.crypto.createSignatureFromObj(data,keys.checksumKey)};
    },
    async sign(data:object){return signer.crypto.createSignatureFromObj(data,keys.checksumKey);}
  };
}
