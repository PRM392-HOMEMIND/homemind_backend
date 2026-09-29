import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {writeFileSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {LocalFamilyHttp,LocalAccount} from './support/local-family-http';

const percentile=(values:number[],p:number)=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]??0;};
/** Opt-in bounded HTTP benchmark: no emulator, microphone, network provider or production URL. */
describe.skipIf(process.env.RUN_LOCAL_AI_BENCHMARK!=='1')('Local deterministic HTTP benchmark',()=>{
 const h=new LocalFamilyHttp(),evidence:any[]=[];let users:LocalAccount[]=[];
 beforeAll(async()=>{await h.start();for(let i=0;i<20;i++)users.push(await h.account());},30000);
 afterAll(async()=>{
  await h.close();
  if(process.env.LOCAL_BENCHMARK_OUTPUT){
   const path=resolve(process.env.LOCAL_BENCHMARK_OUTPUT),rel=relative(process.cwd(),path);
   if(!rel.startsWith('..')&&!isAbsolute(rel))throw Error('Measurement output must be outside backend repository');
   writeFileSync(path,JSON.stringify({provider:'DETERMINISTIC_MOCK',realGeminiLatency:'NOT_MEASURED',sttLatency:'NOT_MEASURED',poolLimit:new URL(process.env.DATABASE_URL!).searchParams.get('connection_limit'),queryMetric:'Prisma statement/model calls, excluding SQL function internals; transaction begin/commit not counted',evidence},null,2));
  }
 });
 async function wave(level:number,family?:LocalAccount[]){
  const tag=(family?'shared':'independent')+'-'+level,started=performance.now(),cpu=process.cpuUsage();
  const completed:number[]=[],samples:any[]=[],results:any[]=[];let active=0,peakProvider=0,provider=0;
  h.peakTransactions=0;h.peakQueued=0;
  h.planner.plan=async(text:string,_items:any,_date:string,signal?:AbortSignal)=>{
   provider++;peakProvider=Math.max(peakProvider,provider);const m=h.context.getStore();m?.providerTransactions.push(h.transactions);
   try{await delay(Number(text.split(':').at(-1)),undefined,{signal});return {toolId:'inventory.list',arguments:{limit:20}};}finally{provider--;}
  };
  const timer=setInterval(()=>samples.push({atMs:performance.now()-started,activeHttp:active,activeProvider:provider,transactions:h.transactions,queuedTransactions:h.queuedTransactions,rssBytes:process.memoryUsage().rss,heapUsedBytes:process.memoryUsage().heapUsed}),20);
  const load=family??users;
  try{await Promise.all(Array.from({length:level},(_,i)=>(async()=>{
   const label=tag+'-'+i,begin=performance.now();active++;
   try{const result=await h.turn(load[i%load.length],family?family[0].ws:load[i].ws,`Trong nhà còn gì? Độ trễ giả lập:${600+(level-1-i)*15}`,undefined,undefined,label);
    completed.push(i);results.push({submission:i,completion:completed.length,status:result.status,errorCode:result.body.error?.code??null,latencyMs:performance.now()-begin,...h.measurements.get(label)});
   }finally{active--;}
  })()));}finally{clearInterval(timer);}
  const elapsed=performance.now()-started,spent=process.cpuUsage(cpu),latency=results.map(r=>r.latencyMs),success=results.filter(r=>r.status===201);
  const stats={scenario:tag,total:level,success:success.length,failures:results.filter(r=>r.status!==201).map(r=>({status:r.status,code:r.errorCode})),elapsedMs:elapsed,
   meanMs:latency.reduce((a,b)=>a+b,0)/level,medianMs:percentile(latency,.5),p90Ms:percentile(latency,.9),p95Ms:percentile(latency,.95),p99Ms:percentile(latency,.99),minMs:Math.min(...latency),maxMs:Math.max(...latency),
   throughput:level/(elapsed/1000),successfulThroughput:success.length/(elapsed/1000),cpuUserMs:spent.user/1000,cpuSystemMs:spent.system/1000,cpuOneCorePercent:100*(spent.user+spent.system)/(elapsed*1000),peakProvider,
   peakTransactions:h.peakTransactions,peakQueuedTransactions:h.peakQueued,peakRssBytes:Math.max(...samples.map(s=>s.rssBytes),process.memoryUsage().rss),
   transactionWaitP95Ms:percentile(results.flatMap(r=>r.transactionWaitMs),.95),maxStatementMs:Math.max(...results.flatMap(r=>r.queryMs),0),completionOrder:completed,results:results.sort((a,b)=>a.submission-b.submission),samples};
  evidence.push(stats);
  expect(results.every(r=>r.status===201||r.status===503&&r.errorCode==='AI_CAPACITY_BUSY')).toBe(true);
  expect(success.length).toBe(process.env.LOCAL_BENCHMARK_BASELINE?level:Math.min(level,16));
  expect(h.peakTransactions).toBeLessThanOrEqual(5);expect(h.queuedTransactions).toBe(0);
  if(level>1)expect(peakProvider).toBeGreaterThan(1);
 }
 for(const level of [1,5,10,20])it(`measures ${level} independent simultaneous request(s)`,()=>wave(level),30000);
 it.skipIf(!!process.env.LOCAL_BENCHMARK_BASELINE)('measures shared Family at 1/5/10/20 without creating per-member quota',async()=>{
  const family=await h.family(6);for(const level of [1,5,10,20])await wave(level,family);
  expect((await h.call(family[0],'/me')).body.voiceQuota).toMatchObject({used:32,total:100,shared:true});
 },30000);
});
