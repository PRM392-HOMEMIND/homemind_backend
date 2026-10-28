/** Operator-only, protected stdin. Never called by app startup or HTTP. */
'use strict';
const {PrismaClient}=require('@prisma/client');
const argon2=require('argon2');
const EMAIL='homemind.test@gmail.com';
async function bootstrap(db,input) {
  if(Object.keys(input).some(k=>!['email','password'].includes(k)) || input.email!==EMAIL ||
    typeof input.password!=='string' || input.password.length<8 || input.password.length>128 || !input.password.trim())throw Error('INPUT_REJECTED');
  const [{role}]=await db.$queryRaw`select current_user as role`;
  if(role!=='homemind_migrator')throw Error('OPERATOR_ROLE_REQUIRED');
  const hash=await argon2.hash(input.password,{type:argon2.argon2id});
  return db.$transaction(async tx=>{
    await tx.$executeRaw`select pg_advisory_xact_lock(hashtextextended('homemind.reviewer.bootstrap',0))`;
    const prior=await tx.user.findUnique({where:{email:EMAIL}});
    if(prior) {
      const binding=await tx.$queryRaw`select user_id from public.auth_reviewer_identity where singleton and user_id=${prior.id}::uuid and email=${EMAIL}`;
      if(!binding.length || prior.status!=='ACTIVE' || !prior.emailVerifiedAt || !await argon2.verify(prior.passwordHash,input.password))throw Error('REVIEWER_IDENTITY_COLLISION');
      return {status:'ALREADY_PROVISIONED',userId:prior.id,role:'normal_user'};
    }
    if((await tx.$queryRaw`select user_id from public.auth_reviewer_identity`).length)throw Error('REVIEWER_IDENTITY_COLLISION');
    // No mail side effects, including welcome and future business notifications.
    await tx.$executeRaw`insert into public.email_suppressions(email,reason) values(${EMAIL},'REVIEWER_NO_EMAIL') on conflict(email) do nothing`;
    const user=await tx.user.create({data:{email:EMAIL,passwordHash:hash,emailVerifiedAt:new Date(),termsAcceptedAt:new Date(),privacyAcceptedAt:new Date()}});
    await tx.$queryRaw`select set_config('app.user_id',${user.id},true)`;
    await tx.$queryRaw`select public.provision_home(${user.id}::uuid,'HomeMind Reviewer','household')`;
    await tx.$executeRaw`insert into public.auth_reviewer_identity(singleton,user_id,email) values(true,${user.id}::uuid,${EMAIL})`;
    return {status:'PROVISIONED',userId:user.id,role:'normal_user'};
  },{timeout:10000});
}
async function main() {
  let raw='';for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>4096)throw Error('INPUT_REJECTED');}
  const url=process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if(!url)throw Error('OPERATOR_DATABASE_REQUIRED');
  const db=new PrismaClient({datasourceUrl:url,log:[]});
  try{process.stdout.write(JSON.stringify(await bootstrap(db,JSON.parse(raw)))+'\n');}finally{await db.$disconnect();}
}
module.exports={bootstrap};
if(require.main===module)main().catch(e=>{
  const allowed=['INPUT_REJECTED','OPERATOR_ROLE_REQUIRED','OPERATOR_DATABASE_REQUIRED','REVIEWER_IDENTITY_COLLISION'];
  process.stderr.write((allowed.includes(e.message)?e.message:'REVIEWER_BOOTSTRAP_FAILED_VALUES_WITHHELD')+'\n');process.exitCode=1;
});
