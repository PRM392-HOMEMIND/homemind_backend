import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { GatewayTimeoutException,HttpException } from '@nestjs/common';
import { LocalFamilyHttp,RequestMeasurement } from './support/local-family-http';

describe.skipIf(process.env.RUN_DB_TESTS!=='1')('Assistant concurrency: local HTTP + PostgreSQL + deterministic provider',()=>{
 const h=new LocalFamilyHttp();
 const plan={toolId:'inventory.list',arguments:{limit:20}};
 beforeAll(()=>h.start(),30000);afterAll(()=>h.close());
 it('returns each independent result immediately in completion order, without provider-wait transactions',async()=>{
  const users=await h.family(3),entered:string[]=[],finished:string[]=[];
  let release!:()=>void;const barrier=new Promise<void>(r=>release=r);
  h.planner.plan=async(text:string,_items:any,_date:string,signal:AbortSignal)=>{
   entered.push(text);if(entered.length===3)release();await barrier;
   expect(h.context.getStore()).toBeDefined();
   // Background workers may transact independently; none of these requests may do so while awaiting the provider.
   expect(labels.map(label=>h.measurements.get(label)?.activeTransactions)).toEqual([0,0,0]);
   await delay(Number(text.slice(-3)),undefined,{signal});return plan;
  };
  const names=['Chậm 800','Nhanh 100','Vừa 400'],labels=names.map(()=>randomUUID());
  // Keep an unrelated transaction open to reproduce real worker overlap deterministically.
  let releaseBackground!:()=>void,backgroundReady!:()=>void;
  const gate=new Promise<void>(r=>releaseBackground=r),ready=new Promise<void>(r=>backgroundReady=r);
  const background=h.db.$transaction(async()=>{backgroundReady();await gate;});await ready;
  let results:Awaited<ReturnType<typeof h.turn>>[];
  try{
   expect(h.transactions).toBeGreaterThan(0);
   results=await Promise.all(users.map((a,i)=>h.turn(a,users[0].ws,names[i],undefined,undefined,labels[i]).then(r=>{finished.push(names[i]);return r;})));
  }finally{releaseBackground();await background;}
  expect(results.map(r=>r.status)).toEqual([201,201,201]);expect(finished).toEqual([names[1],names[2],names[0]]);
  expect((await h.call(users[0],'/me')).body.voiceQuota).toMatchObject({total:100,used:3,remaining:97,shared:true,poolWorkspaceId:users[0].ws});
 });
 it('attributes transactions to their own request and clears the count on failure',async()=>{
  const measurement:RequestMeasurement={label:randomUUID(),queries:0,activeTransactions:0,transactionWaitMs:[],queryMs:[],providerTransactions:[]};
  const failure=new Error('Controlled measurement rollback');
  await expect(h.context.run(measurement,()=>h.db.$transaction(async()=>{
   expect(measurement.activeTransactions).toBe(1);
   expect(h.context.getStore()).toBe(measurement);
   throw failure;
  }))).rejects.toBe(failure);
  expect(measurement.activeTransactions).toBe(0);
 });
 it('admits exactly the final two seats of one shared quota and blocks private-context bypass',async()=>{
  const users=await h.family(6),workspace=users[0].ws;
  const period=(await h.call(users[0],'/me')).body.voiceQuota.periodId;
  await h.fixtures.$executeRaw`update public.assistant_quota_periods set used=98 where id=${period}::uuid and plan='family'`;
  let providerCalls=0;h.planner.plan=async()=>{providerCalls++;await delay(120);return plan;};
  const responses=await Promise.all(Array.from({length:10},(_,i)=>h.turn(users[i%6],i%2?workspace:users[i%6].ws)));
  expect(responses.filter(r=>r.status===201)).toHaveLength(2);
  expect(responses.filter(r=>r.status===429&&r.body.error.code==='VOICE_QUOTA_EXHAUSTED')).toHaveLength(8);expect(providerCalls).toBe(2);
  for(const a of users){
   const state=await h.call(a,'/me');expect(state.body.voiceQuota).toMatchObject({used:100,remaining:0,total:100,shared:true});
   expect((await h.turn(a,a.ws)).status).toBe(429);
  }
  const periods=await h.fixtures.$queryRaw<Array<{used:number}>>`select used from public.assistant_quota_periods where id=${period}::uuid`;
  expect(periods[0].used).toBe(100);
 });
 it('releases failed reservations, fences duplicate in-flight requests and charges a replay only once',async()=>{
  const [owner,a]=await h.family(2),key=randomUUID();let calls=0;
  h.planner.plan=async()=>{calls++;throw new HttpException({code:'AI_UNAVAILABLE',message:'Controlled mock failure'},503);};
  expect((await h.turn(a,a.ws,'Trong nhà còn gì?',key)).status).toBe(503);
  expect((await h.call(owner,'/me')).body.voiceQuota.used).toBe(0);
  h.planner.plan=async()=>{calls++;await delay(100);return plan;};
  const results=await Promise.all([h.turn(a,a.ws,'Trong nhà còn gì?',key),h.turn(a,a.ws,'Trong nhà còn gì?',key)]);
  expect(results.map(r=>r.status).sort()).toEqual([201,409]);
  const success=results.find(r=>r.status===201)!;
  expect((await h.turn(a,a.ws,'Trong nhà còn gì?',key)).body.turnId).toBe(success.body.turnId);
  expect((await h.call(owner,'/me')).body.voiceQuota.used).toBe(1);expect(calls).toBe(2);
 });
 it('provider timeout returns504 and releases the reservation without charging Family',async()=>{
  const [owner,a]=await h.family(2);
  h.planner.plan=async()=>{throw new GatewayTimeoutException('Controlled provider timeout');};
  const failed=await h.turn(a,owner.ws);expect(failed.status).toBe(504);expect(failed.body.error.code).toBe('TIMEOUT');
  expect((await h.call(owner,'/me')).body.voiceQuota).toMatchObject({used:0,reserved:0,remaining:100});
  expect(h.assistant.concurrencySnapshot().active).toBe(0);
 });
 it('cancels a disconnected request, releases its quota and leaves no stored turn',async()=>{
  const a=await h.account(),controller=new AbortController();let entered!:()=>void,ended!:()=>void;
  const start=new Promise<void>(r=>entered=r),end=new Promise<void>(r=>ended=r);
  h.planner.plan=async(_text:string,_items:any,_date:string,signal:AbortSignal)=>{entered();try{await delay(10000,undefined,{signal});return plan;}finally{ended();}};
  const pending=h.turn(a,a.ws,'Trong nhà còn gì?',randomUUID(),controller.signal);await start;controller.abort();
  await expect(pending).rejects.toThrow();await end;
  // A DB read is the barrier for the release, bounded by the request lifecycle (no fixed sleep).
  for(let i=0;i<40&&h.assistant.concurrencySnapshot().active;i++)await delay(10);
  expect(h.assistant.concurrencySnapshot().active).toBe(0);
  expect((await h.call(a,'/me')).body.voiceQuota.used).toBe(0);
  expect(await h.fixtures.assistantTurn.count({where:{workspaceId:a.ws}})).toBe(0);
 });
 it('bounds active requests and answers overload explicitly while unrelated work completes',async()=>{
  const a=await h.account('family');let release!:()=>void;const gate=new Promise<void>(r=>release=r);
  let started=0,allEntered!:()=>void;const ready=new Promise<void>(r=>allEntered=r);
  h.planner.plan=async()=>{if(++started===16)allEntered();await gate;return plan;};
  const pending=Array.from({length:16},()=>h.turn(a));await ready;
  expect(h.assistant.concurrencySnapshot()).toEqual({active:16,max:16});
  const rejected=await h.turn(a);expect(rejected.status).toBe(503);expect(rejected.body.error.code).toBe('AI_CAPACITY_BUSY');
  release();expect((await Promise.all(pending)).every(r=>r.status===201)).toBe(true);expect(h.assistant.concurrencySnapshot().active).toBe(0);
 });
 it('does not return another workspace data or charge a forged workspace request',async()=>{
  const a=await h.account(),b=await h.account();h.planner.plan=async()=>plan;
  expect((await h.turn(a,b.ws)).status).toBe(403);
  expect((await h.call(b,'/me')).body.voiceQuota.used).toBe(0);
 });
});
