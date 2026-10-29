'use strict';
// Approved operational retention:90 days. Operator-only bounded batch; no HTTP purge.
const {PrismaClient}=require('@prisma/client');
async function main(){
 let input='';for await(const c of process.stdin){input+=c;if(input.length>1024)throw new Error();}
 const request=JSON.parse(input);
 if(!request || Array.isArray(request) || Object.keys(request).sort().join(',')!=='maxRows,operation,retentionDays' || request.operation!=='prune-audit' || request.retentionDays!==90 || request.maxRows!==5000)throw new Error();
 const url=process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;if(!url)throw new Error();
 const db=new PrismaClient({datasourceUrl:url,log:[]});
 try{
  const [role]=await db.$queryRawUnsafe('SELECT current_user name');if(role.name!=='homemind_migrator')throw new Error();
  const n=await db.$executeRawUnsafe("DELETE FROM admin.audit_logs WHERE id IN (SELECT id FROM admin.audit_logs WHERE occurred_at<now()-interval '90 days' ORDER BY occurred_at,id LIMIT 5000)");
  const sessions=await db.$executeRawUnsafe("DELETE FROM admin.sessions WHERE id IN (SELECT id FROM admin.sessions WHERE expires_at<now()-interval '1 day' ORDER BY expires_at,id LIMIT 5000)");
  console.log(JSON.stringify({status:'PRUNED_APPROVED_RETENTION',removed:n,expiredSessionsRemoved:sessions,retentionDays:90,maxRows:5000}));
 }finally{await db.$disconnect();}
}
main().catch(()=>{console.error('ADMIN_AUDIT_MAINTENANCE_FAILED_VALUES_WITHHELD');process.exitCode=1;});
