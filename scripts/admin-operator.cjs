/** INTERNAL ONLY: protected stdin, migrator credential, never HTTP or startup seed. */
'use strict';
const {PrismaClient}=require('@prisma/client');
const argon2=require('argon2');
async function main() {
  let raw='';for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>4096)throw new Error('INPUT_REJECTED');}
  const input=JSON.parse(raw);
  if(Object.keys(input).some(k=>!['email','password','operation'].includes(k)))throw new Error('INPUT_REJECTED');
  const email=typeof input.email==='string'?input.email.trim().toLowerCase():'';
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)throw new Error('INPUT_REJECTED');
  if(typeof input.password!=='string'||input.password.length<20||input.password.length>128||!/[a-z]/.test(input.password)||!/[A-Z]/.test(input.password)||!/[0-9]/.test(input.password)||! /[^A-Za-z0-9]/.test(input.password))throw new Error('INPUT_REJECTED');
  if(!['bootstrap','rotate'].includes(input.operation))throw new Error('INPUT_REJECTED');
  const url=process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;if(!url)throw new Error('OPERATOR_DATABASE_REQUIRED');
  const db=new PrismaClient({datasourceUrl:url,log:[]});
  try {
    const [role]=await db.$queryRawUnsafe('SELECT current_user AS name');if(role.name!=='homemind_migrator')throw new Error('OPERATOR_ROLE_REQUIRED');
    const hash=await argon2.hash(input.password,{type:argon2.argon2id});
    const result=await db.$transaction(async tx=>{
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended('homemind.admin.initial',0))");
      const rows=await tx.$queryRawUnsafe("SELECT id,email,status FROM admin.principals WHERE bootstrap_key='initial'");
      if(rows.length) {
        if(rows[0].email!==email)throw new Error('BOOTSTRAP_IDENTITY_COLLISION');
        if(input.operation==='bootstrap')return {status:'ALREADY_PROVISIONED',id:rows[0].id,adminStatus:rows[0].status,count:1};
        await tx.$executeRawUnsafe('UPDATE admin.principals SET password_hash=$1,password_changed_at=clock_timestamp() WHERE id=$2::uuid',hash,rows[0].id);
        await tx.$executeRawUnsafe('UPDATE admin.sessions SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE admin_id=$1::uuid',rows[0].id);
        await tx.$executeRawUnsafe("INSERT INTO admin.audit_logs(actor_id,request_id,action,outcome) VALUES($1::uuid,gen_random_uuid(),'operator.rotate','SUCCESS')",rows[0].id);
        return {status:'ROTATED',id:rows[0].id,adminStatus:rows[0].status,count:1};
      }
      if(input.operation==='rotate')throw new Error('ADMIN_NOT_PROVISIONED');
      const [created]=await tx.$queryRawUnsafe("INSERT INTO admin.principals(bootstrap_key,email,password_hash) VALUES('initial',$1,$2) RETURNING id,status",email,hash);
      await tx.$executeRawUnsafe("INSERT INTO admin.audit_logs(actor_id,request_id,action,outcome) VALUES($1::uuid,gen_random_uuid(),'operator.bootstrap','SUCCESS')",created.id);
      return {status:'PROVISIONED',id:created.id,adminStatus:created.status,count:1};
    },{timeout:10000});
    process.stdout.write(JSON.stringify(result)+'\n');
  } finally{await db.$disconnect();}
}
main().catch(e=>{const allowed=['INPUT_REJECTED','OPERATOR_DATABASE_REQUIRED','OPERATOR_ROLE_REQUIRED','BOOTSTRAP_IDENTITY_COLLISION','ADMIN_NOT_PROVISIONED'];process.stderr.write((allowed.includes(e.message)?e.message:'ADMIN_OPERATOR_FAILED_VALUES_WITHHELD')+'\n');process.exitCode=1;});
