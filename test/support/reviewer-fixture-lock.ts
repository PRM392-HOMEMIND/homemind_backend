import { PrismaClient } from '@prisma/client';
/** Test-only serialisation of a singleton identity, never the app AI pipeline. */
export async function reviewerFixtureLock() {
  const url=new URL(process.env.MIGRATION_DATABASE_URL!);url.searchParams.set('connection_limit','1');
  const lock=new PrismaClient({datasourceUrl:url.toString()});
  try {
    await lock.$executeRawUnsafe("set lock_timeout='15000ms'");
    await lock.$executeRaw`select pg_advisory_lock(hashtextextended('test.reviewer.identity',0))`;
  }catch(error){await lock.$disconnect();throw error;}
  return async()=>{
    try{await lock.$executeRaw`select pg_advisory_unlock(hashtextextended('test.reviewer.identity',0))`;}finally{await lock.$disconnect();}
  };
}
