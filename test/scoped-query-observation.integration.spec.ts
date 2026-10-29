import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../src/database/database.service';
import { requestContext, withRequestContext } from '../src/common/request-context';
import { mockEmailAuth, registerVerified } from './support/email-auth-fixture';
import { requireDisposableDatabase } from './disposable-database';
import { deleteFixtureUsers } from './support/delete-fixture-users';

describe.skipIf(process.env.RUN_DB_TESTS!=='1')('bounded operator query leases (no production configuration)',()=>{
 const db=new DatabaseService(),owner=new PrismaClient({datasourceUrl:process.env.MIGRATION_DATABASE_URL});
 const auth=mockEmailAuth(db),ids:string[]=[];let id:string;
 beforeAll(async()=>{
  requireDisposableDatabase();
  const account=await registerVerified(auth,{email:'trace-'+randomUUID()+'@example.invalid',password:randomBytes(24).toString('hex'),displayName:'Trace fixture',workspaceType:'household',acceptedTerms:true,acceptedPrivacy:true});id=account.user.id;ids.push(id);
 });
 afterAll(async()=>{
  const ws=await owner.workspaceMember.findMany({where:{userId:{in:ids}}});
  await deleteFixtureUsers(owner,ids,ws.map(m=>m.workspaceId));await Promise.all([db.$disconnect(),owner.$disconnect()]);
 });
 it('OFF without lease; client IDs cannot enable tracing and runtime cannot enrol fixtures',async()=>{
  const log=vi.spyOn(console,'log').mockImplementation(()=>undefined);
  try{
   expect(await db.asUser(id,tx=>tx.profile.findUnique({where:{id}}))).toHaveProperty('id',id);
   expect(log).not.toHaveBeenCalled();
   await expect(db.$executeRaw`insert into public.audit_query_leases(user_id,run_id,expires_at,remaining) values(${id}::uuid,'untrusted-client',clock_timestamp()+interval '1 minute',1)`).rejects.toThrow();
   await expect(db.$queryRaw`select public.audit_trace_end(${randomUUID()}::uuid)`).rejects.toThrow();
  }finally{log.mockRestore();}
 });
 it('cannot create an oversized or long-lived operator lease',async()=>{
  for(const remaining of [-1,501])await expect(owner.$executeRaw`insert into public.audit_query_leases(user_id,run_id,expires_at,remaining) values(${id}::uuid,'test-lease',clock_timestamp()+interval '1 minute',${remaining})`).rejects.toThrow();
  await expect(owner.$executeRaw`insert into public.audit_query_leases(user_id,run_id,expires_at,remaining) values(${id}::uuid,'test-lease',clock_timestamp()+interval '31 minutes',1)`).rejects.toThrow();
 });
 it('separate asynchronous request contexts keep independent server UUIDs',async()=>{
  const contexts=await Promise.all(Array.from({length:20},(_,i)=>withRequestContext(async()=>{
   const before=requestContext.getStore()!.id;
   await new Promise(resolve=>setTimeout(resolve,(20-i)%5));
   expect(requestContext.getStore()!.id).toBe(before);return before;
  })));
  expect(new Set(contexts).size).toBe(20);expect(requestContext.getStore()).toBeUndefined();
 });
 it('expired lease does not consume budget or emit SQL (module/grants not required)',async()=>{
  await owner.$executeRaw`insert into public.audit_query_leases(user_id,run_id,created_at,expires_at,remaining) values(${id}::uuid,'expired-lease',clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute',1)`;
  try{
   await db.asUser(id,tx=>tx.$queryRaw`select 1`);
   expect((await owner.$queryRaw<Array<{remaining:number}>>`select remaining from public.audit_query_leases where user_id=${id}::uuid`)[0].remaining).toBe(1);
  }finally{await owner.$executeRaw`delete from public.audit_query_leases where user_id=${id}::uuid`;}
 });
});
