'use strict';
// Verified operator reporting metadata only. No customer/business fields are changed.
const {PrismaClient}=require('@prisma/client');
async function main(){
 let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>1024)throw new Error();}
 const p=JSON.parse(input);
 if(!p || Array.isArray(p) || Object.keys(p).sort().join(',')!=='id,kind,provenance' || !['customer','workspace'].includes(p.kind) || !['REAL','SIMULATED_TEST'].includes(p.provenance) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(p.id))throw new Error();
 const db=new PrismaClient({datasourceUrl:process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL,log:[]});
 try{
  const [role]=await db.$queryRawUnsafe('SELECT current_user name');if(role.name!=='homemind_migrator')throw new Error();
  const table=p.kind==='customer'?'admin.customer_scope':'admin.workspace_scope',key=p.kind==='customer'?'user_id':'workspace_id';
  await db.$transaction(async tx=>{
   await tx.$executeRawUnsafe(`INSERT INTO ${table}(${key},provenance) VALUES($1::uuid,$2) ON CONFLICT(${key}) DO UPDATE SET provenance=excluded.provenance,identified_at=now()`,p.id,p.provenance);
   await tx.$executeRawUnsafe("INSERT INTO admin.audit_logs(request_id,action,target_id,outcome) VALUES(gen_random_uuid(),$1,$2::uuid,'SUCCESS')",'operator.classify.'+p.kind,p.id);
  });
  console.log(JSON.stringify({status:'CLASSIFIED_REPORTING_ONLY',kind:p.kind,id:p.id,provenance:p.provenance}));
 }finally{await db.$disconnect();}
}
main().catch(()=>{console.error('ADMIN_DATA_SCOPE_FAILED_VALUES_WITHHELD');process.exitCode=1;});
