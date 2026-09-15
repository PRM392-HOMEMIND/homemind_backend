import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { LocalFamilyHttp } from './support/local-family-http';
import { EmailChallengeService } from '../src/auth/email-challenge.service';
import { EmailDeliveryService } from '../src/email/email-delivery.service';

describe.skipIf(process.env.RUN_DB_TESTS!=='1')('real local HTTP enqueue + PostgreSQL; explicitly mocked email latency, no real sends',()=>{
 const h=new LocalFamilyHttp(),emails:string[]=[],results:object[]=[];let active=0,peak=0;
 const completed:Array<{submitted:number;completed:number;id:string}>=[];let submission=0;
 let challenge:EmailChallengeService,worker:EmailDeliveryService;
 const provider:any={available:()=>true,report:async()=>null,send:async(_to:string,_content:any,id:string)=>{
  const submitted=performance.now();active++;peak=Math.max(peak,active);
  const delay=submission++%3===0?60:20;await new Promise(resolve=>setTimeout(resolve,delay));active--;
  completed.push({submitted,completed:performance.now(),id});return {state:'accepted',messageId:id};
 }};
 beforeAll(async()=>{await h.start();challenge=new EmailChallengeService(h.db,provider);Object.defineProperty(h.emailAuth,'challenges',{value:challenge});worker=new EmailDeliveryService(h.db,provider,challenge);},30000);
 afterAll(async()=>{
  await h.fixtures.$executeRaw`delete from public.auth_email_challenges where email=any(${emails}::text[])`;
  await h.close();if(process.env.EMAIL_BENCHMARK_REPORT)writeFileSync(process.env.EMAIL_BENCHMARK_REPORT,JSON.stringify({provider:'MOCK_20_60_MS',results},null,2));
 });
 for(const count of [1,10,50,100])it(`${count} concurrent HTTP registration intents: bounded processing and independent completion`,async()=>{
  const cpu=process.cpuUsage(),started=performance.now(),latencies:number[]=[],http:number[]=[],order:number[]=[];
  const submitted=Array.from({length:count},(_,i)=>i);const before=completed.length;
  await Promise.all(submitted.map(async index=>{
   const start=performance.now(),email='load-'+randomUUID()+'@example.invalid';emails.push(email);
   const response=await fetch(h.base+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({email,password:'Strong-mock-load-password',displayName:'Load fixture',acceptedTerms:true,acceptedPrivacy:true})});
   const body=await response.json();http.push(response.status);latencies.push(performance.now()-start);order.push(index);
   expect(body).not.toHaveProperty('accessToken');
  }));
  expect(http.every(status=>status===201)).toBe(true);
  for(let batch=0;batch<500;batch++){
   const pending=(await h.fixtures.$queryRaw<any[]>`select count(*)::int count from public.auth_email_challenges where email=any(${emails.slice(-count)}::text[]) and state='queued'`)[0].count;
   if(!pending)break;
   const owned=await h.fixtures.$queryRaw<Array<{id:string}>>`select id from public.auth_email_challenges where email=any(${emails.slice(-count)}::text[]) and state='queued' order by created_at,id limit 4`;
   await Promise.all(owned.map(row=>challenge.deliverNext(row.id)));
  }
  const states=await h.fixtures.$queryRaw<any[]>`select state,extract(epoch from (issued_at-created_at))*1000 wait_ms from public.auth_email_challenges where email=any(${emails.slice(-count)}::text[])`;
  expect(states).toHaveLength(count);expect(states.every(r=>r.state==='accepted')).toBe(true);expect(peak).toBeLessThanOrEqual(4);
  const elapsed=performance.now()-started,sorted=latencies.slice().sort((a,b)=>a-b),pct=(p:number)=>sorted[Math.min(sorted.length-1,Math.ceil(p*sorted.length)-1)];
  const intervals=completed.slice(before);const overlaps=intervals.some((a,i)=>intervals.some((b,j)=>i!==j&&a.submitted<b.completed&&b.submitted<a.completed));
  if(count>1)expect(overlaps).toBe(true);
  const usage=process.cpuUsage(cpu);const result={count,success:http.filter(s=>s===201).length,errorRate:0,p50Ms:pct(.5),p95Ms:pct(.95),p99Ms:pct(.99),minMs:sorted[0],maxMs:sorted.at(-1),meanMs:sorted.reduce((a,b)=>a+b,0)/count,
   throughputPerSecond:count/(elapsed/1000),enqueueCompletionOrder:order,peakProviderConcurrency:peak,providerIntervals:intervals.map(({id,...r})=>r),
   queueWaitMs:states.map(r=>Number(r.wait_ms)),rssBytes:process.memoryUsage().rss,cpuUserMs:usage.user/1000,cpuSystemMs:usage.system/1000,
   databasePoolConfigured:5,providerLatency:'MOCK_ONLY_NOT_INBOX_LATENCY'};results.push(result);console.log('EMAIL_LOAD '+JSON.stringify(result));
 },30000);
});
