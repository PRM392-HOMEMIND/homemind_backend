import { installMockEmailAuth, verifyHttpRegistration } from './email-auth-fixture';
import {deleteFixtureUsers} from './delete-fixture-users';
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { requireDisposableDatabase } from '../disposable-database';

export type LocalAccount={id:string;ws:string;email:string;token:string;password:string};
export type RequestMeasurement={label:string;queries:number;activeTransactions:number;transactionWaitMs:number[];queryMs:number[];providerTransactions:number[]};

/** Real HTTP/auth/RLS/quota; only the external AI planner is replaced by callers. */
export class LocalFamilyHttp {
 readonly fixtures=new PrismaClient({datasourceUrl:process.env.MIGRATION_DATABASE_URL});
 readonly accounts:LocalAccount[]=[];
 readonly context=new AsyncLocalStorage<RequestMeasurement>();
 readonly measurements=new Map<string,RequestMeasurement>();
 emailAuth:any; app!:INestApplication; base=''; db:any; planner:any; assistant:any;
 private readonly backend=process.env.LOCAL_BENCHMARK_BASELINE?resolve(process.env.LOCAL_BENCHMARK_BASELINE):resolve(__dirname,'../..');
 transactions=0; peakTransactions=0; queuedTransactions=0; peakQueued=0;
 async start(){
  requireDisposableDatabase();
  if(process.env.PAYOS_ENABLED!=='false'||process.env.GEMINI_API_KEY)throw Error('Local providers must be OFF');
  if(process.env.HOMEMIND_ISOLATED_CI!=='1'){
  const build=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.build.json'],{encoding:'utf8',cwd:this.backend});
  if(build.status!==0)throw Error('Backend compilation failed: '+build.stdout);
  }
  const {AppModule}=require(resolve(this.backend,'dist/app.module.js'));
  const {ApiErrorFilter}=require(resolve(this.backend,'dist/common/api-error.filter.js'));
  const {NestFactory}=require(resolve(this.backend,'node_modules/@nestjs/core'));
  const {ValidationPipe}=require(resolve(this.backend,'node_modules/@nestjs/common'));
  this.app=await NestFactory.create(AppModule,{logger:false,abortOnError:false});this.emailAuth=installMockEmailAuth(this.app);this.app.setGlobalPrefix('v1');
  this.app.useGlobalPipes(new ValidationPipe({transform:true,whitelist:true,forbidNonWhitelisted:true}));
  this.app.useGlobalFilters(new ApiErrorFilter());
  this.app.use((req:any,_res:any,next:()=>void)=>{
   const label=String(req.headers['x-local-measurement']??'');
   if(!label)return next();
   const measurement:RequestMeasurement={label,queries:0,activeTransactions:0,transactionWaitMs:[],queryMs:[],providerTransactions:[]};
   this.measurements.set(label,measurement);this.context.run(measurement,next);
  });
  this.db=this.app.get(require(resolve(this.backend,'dist/database/database.service.js')).DatabaseService);
  this.planner=this.app.get(require(resolve(this.backend,'dist/assistant/planner.js')).AiPlanner);
  this.assistant=this.app.get(require(resolve(this.backend,'dist/assistant/assistant.service.js')).AssistantService);
  const instrument=(target:any)=>new Proxy(target,{get:(object,key)=>{
   const value=Reflect.get(object,key);
   if(typeof value==='function')return (...args:any[])=>{
    const measurement=this.context.getStore(),started=performance.now();if(measurement)measurement.queries++;
    return Promise.resolve(value.apply(object,args)).finally(()=>measurement?.queryMs.push(performance.now()-started));
   };
   return value&&typeof value==='object'?instrument(value):value;
  }});
  const transaction=this.db.$transaction.bind(this.db);
  this.db.$transaction=(callback:any,options:any)=>{
   if(typeof callback!=='function')return transaction(callback,options);
   const start=performance.now(),measurement=this.context.getStore();let entered=false;
   this.queuedTransactions++;this.peakQueued=Math.max(this.peakQueued,this.queuedTransactions);
   return transaction(async(tx:any)=>{
    entered=true;this.queuedTransactions--;this.transactions++;if(measurement)measurement.activeTransactions++;this.peakTransactions=Math.max(this.peakTransactions,this.transactions);
    measurement?.transactionWaitMs.push(performance.now()-start);
    if(process.env.LOCAL_QUERY_PLAN_LABELS==='1'&&measurement){
     await tx.$queryRaw`select set_config('application_name',${measurement.label},true)`;
    }
    try{return await callback(instrument(tx));}finally{this.transactions--;if(measurement)measurement.activeTransactions--;}
   },options).finally(()=>{if(!entered)this.queuedTransactions--;});
  };
  // Authentication makes two direct Prisma calls outside transactions. Count them too.
  for(const model of ['user','refreshSession']){
   const original=this.db[model].findUnique.bind(this.db[model]);
   this.db[model].findUnique=(...args:any[])=>{const m=this.context.getStore(),start=performance.now();if(m)m.queries++;
    return original(...args).finally(()=>m?.queryMs.push(performance.now()-start));};
  }
  await this.app.listen(0,'127.0.0.1');this.base=(await this.app.getUrl())+'/v1';
 }
 async call(a:LocalAccount,path:string,method='GET',body?:object,key:string=randomUUID(),signal?:AbortSignal,label?:string){
  const r=await fetch(this.base+path,{method,signal,headers:{Authorization:'Bearer '+a.token,'Content-Type':'application/json','Idempotency-Key':key,...(label?{'X-Local-Measurement':label}:{})},body:body?JSON.stringify(body):undefined});
  return {status:r.status,body:await r.json()};
 }
 async account(plan='free'){
  const email='local-ai-'+randomUUID()+'@example.invalid',password=randomBytes(30).toString('hex');
  const r=await fetch(this.base+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password,displayName:'Local concurrent fixture',acceptedTerms:true,acceptedPrivacy:true})});
  if(r.status!==201)throw Error('Local registration failed: '+r.status);
  const data=await verifyHttpRegistration(this.base,this.emailAuth,await r.json(),email),a={id:data.user.id,email,password,token:data.accessToken,ws:''};this.accounts.push(a);
  a.ws=(await this.call(a,'/me')).body.workspaceId;
  await this.fixtures.$executeRaw`insert into admin.customer_scope(user_id,provenance) values(${a.id}::uuid,'SIMULATED_TEST')`;
  await this.fixtures.$executeRaw`insert into admin.workspace_scope(workspace_id,provenance) values(${a.ws}::uuid,'SIMULATED_TEST')`;
  if(plan!=='free')await this.fixtures.$executeRaw`update public.workspace_entitlements set plan=${plan},product_limit=null,source='legacy_manual' where workspace_id=${a.ws}::uuid`;
  return a;
 }
 async family(size=3){
  const owner=await this.account('family'),members=[owner];
  for(let i=1;i<size;i++){
   const a=await this.account();const invite=await this.call(owner,`/workspaces/${owner.ws}/invitations`,'POST',{email:a.email});
   if(invite.status!==201)throw Error('Fixture invitation failed: '+JSON.stringify(invite));
   const accept=await this.call(a,`/me/workspace-invitations/${invite.body.invitationId}/accept`,'POST');
   if(accept.status!==200)throw Error('Fixture acceptance failed: '+JSON.stringify(accept));members.push(a);
  }
  return members;
 }
 turn(a:LocalAccount,workspace=a.ws,text='Trong nhà còn gì?',requestId:string=randomUUID(),signal?:AbortSignal,label?:string){
  const clientDate=require(resolve(this.backend,'dist/common/date.js')).todayVietnam();
  return this.call(a,'/assistant/turn','POST',{workspaceId:workspace,requestId,locale:'vi-VN',clientDate,timezone:'Asia/Ho_Chi_Minh',dictionaryVersion:'1.1.0',input:{type:'voice_transcript',text}},randomUUID(),signal,label);
 }
 async close(){
  if(this.app)await this.app.close();
  const ids=this.accounts.map(a=>a.id),ws=this.accounts.map(a=>a.ws);
  if(!process.env.LOCAL_BENCHMARK_BASELINE){
   await this.fixtures.$executeRaw`delete from public.family_validation_limits where owner_id=any(${ids}::uuid[])`;
   await this.fixtures.$executeRaw`delete from public.family_operations where actor_id=any(${ids}::uuid[])`;
   await this.fixtures.$executeRaw`delete from public.family_refusals where inviter_id=any(${ids}::uuid[]) or invitee_id=any(${ids}::uuid[])`;
   await this.fixtures.$executeRaw`delete from public.family_groups where workspace_id=any(${ws}::uuid[])`;
  }
  await this.fixtures.workspace.deleteMany({where:{id:{in:ws}}});await deleteFixtureUsers(this.fixtures,ids);await this.fixtures.$disconnect();
 }
}
