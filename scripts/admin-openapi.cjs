'use strict';
/** Generate from actual compiled controllers; never open a public admin Swagger route. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
async function main(){
 process.env.NODE_ENV='test';
 for(const name of ['AUTH_ACCESS_SECRET','AUTH_REFRESH_SECRET','AUTH_RESET_SECRET'])process.env[name]=crypto.randomBytes(32).toString('hex');
 process.env.DATABASE_URL='postgresql://unused:unused@127.0.0.1:1/admin_contract_test';delete process.env.ADMIN_DATABASE_URL;delete process.env.ADMIN_WEB_ORIGINS;
 require('reflect-metadata');const {NestFactory}=require('@nestjs/core');const {SwaggerModule,DocumentBuilder}=require('@nestjs/swagger');
 const {AdminModule}=require('../dist/admin/admin.module');const {ADMIN_SCHEMAS}=require('../dist/admin/admin.schemas');
 const app=await NestFactory.create(AdminModule,{logger:false});app.setGlobalPrefix('v1');
 try{
  const config=new DocumentBuilder().setTitle('HomeMind SYSTEM_ADMIN').setVersion('admin-v1').addServer('https://api.homemind.vn').addCookieAuth('__Host-homemind-admin',{type:'apiKey',in:'cookie'},'__Host-homemind-admin').build();
  const doc=SwaggerModule.createDocument(app,config);Object.assign(doc.components.schemas,ADMIN_SCHEMAS);
  for(const [route,methods] of Object.entries(doc.paths))for(const [method,op] of Object.entries(methods)){
   op.parameters ||= [];
   for(const name of [...route.matchAll(/\{([^}]+)\}/g)].map(x=>x[1]))if(!op.parameters.some(p=>p.in==='path'&&p.name===name))op.parameters.push({name,in:'path',required:true,schema:{type:'string',format:'uuid'}});
   if(['post','delete'].includes(method))op.parameters.push({name:'Origin',in:'header',required:true,schema:{type:'string'},description:'Exact approved origin.'},{name:'X-HomeMind-Admin-CSRF',in:'header',required:true,schema:{type:'string'}});
   const dashboard=route.includes('/dashboard/')&&!route.endsWith('/plan-distribution');
   let queries=dashboard?['from','to','provenance','timezone',...(route.endsWith('/top-paying-users')?['limit']:route.endsWith('/trends')?['bucket']:[])]:route.endsWith('/spending')?['from','to','provenance']:route.endsWith('/transactions')?['limit','cursor']:[];
   if(route.endsWith('/usage/current'))queries=['workspaceId'];
   for(const name of queries)if(!op.parameters.some(p=>p.in==='query'&&p.name===name))op.parameters.push({name,in:'query',required:route.endsWith('/usage/current'),schema:{type:'string'}});
   if(route.endsWith('/auth/csrf')||route.endsWith('/auth/login'))op.security=[];
  }
  const output=path.resolve(__dirname,'../../../docs/api/HOMEMIND_ADMIN_OPENAPI.json');fs.mkdirSync(path.dirname(output),{recursive:true});const tmp=output+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(doc,null,2)+'\n');fs.renameSync(tmp,output);
  const check=JSON.parse(fs.readFileSync(output));console.log(JSON.stringify({adminOperations:Object.values(check.paths).reduce((n,p)=>n+Object.keys(p).length,0),artifact:'docs/api/HOMEMIND_ADMIN_OPENAPI.json',credentialsIncluded:false}));
 }finally{await app.close();}
}
main().catch(()=>{console.error('ADMIN_OPENAPI_GENERATION_FAILED');process.exitCode=1;});
