import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { invalidateWorkspace } from '../common/workspace-cache';
import { PlanLimitException } from '../billing/plan-limit.exception';
import { randomUUID } from 'node:crypto';
import { requestContext } from '../common/request-context';

export type UserTx = Prisma.TransactionClient;

@Injectable()
export class DatabaseService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private warmTimer?: NodeJS.Timeout;

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.warmTimer = setInterval(() => { void this.$queryRaw`select 1`.catch(() => undefined); }, 20_000);
    this.warmTimer.unref();
  }
  async onModuleDestroy(): Promise<void> {
    if (this.warmTimer) clearInterval(this.warmTimer);
    await this.$disconnect();
  }
  async asUser<T>(userId: string, callback: (tx: UserTx) => Promise<T>): Promise<T> {
    return this.$transaction(tx => this.profileTransaction(tx,userId,'workspace',async tx=>{
      await tx.$executeRaw`select public.family_reconcile_current()`;
      return callback(tx);
    }), { maxWait: 5000, timeout: 20000 });
  }
  /** JWT signature is verified first. No Family mutation or external await. */
  async identity<T>(userId:string,callback:(tx:UserTx)=>Promise<T>):Promise<T> {
    return this.$transaction(tx=>this.profileTransaction(tx,userId,'identity',callback),{maxWait:5000,timeout:10000});
  }
  private async profileTransaction<T>(tx:UserTx,userId:string,scope:'workspace'|'identity',callback:(tx:UserTx)=>Promise<T>):Promise<T> {
      await tx.$queryRaw`select set_config('app.user_id', ${userId}, true)`;
      const spanId=randomUUID();
      const [observation]=await tx.$queryRaw<Array<{trace: {pid:number;transactionId:string;runId:string}|null}>>`select public.audit_trace_begin(${spanId}::uuid) as trace`;
      const context=requestContext.getStore();
      if(observation.trace) {
        if(context)context.traced=true;
        console.log(JSON.stringify({event:'sql_profile_span',phase:'begin',requestId:context?.id ?? null,spanId,scope,...observation.trace}));
      }
      const result=await callback(tx);
      if(observation.trace) {
        await tx.$executeRaw`select public.audit_trace_end(${spanId}::uuid)`;
        console.log(JSON.stringify({event:'sql_profile_span',phase:'end',requestId:context?.id ?? null,spanId,scope,...observation.trace}));
      }
      return result;
  }
  async inWorkspace<T>(userId: string, workspaceId: string, callback: (tx: UserTx) => Promise<T>): Promise<T> {
    return this.asUser(userId, async tx => {
      const member = await tx.workspaceMember.findFirst({ where: { userId, workspaceId }, select: { id: true } });
      if (!member) throw new Error('FORBIDDEN');
      return callback(tx);
    });
  }

  /** SQL mutations enforce membership and commit atomically. */
  async operation(userId: string, workspaceId: string, key: string, name: string, payload: object, turnId?: string): Promise<Record<string, unknown>> {
    invalidateWorkspace(workspaceId);
    try {
      return await this.asUser(userId, async tx => {
        const rows = await tx.$queryRaw<Array<{ result: Record<string, unknown> }>>`
          select public.apply_operation(${workspaceId}::uuid, ${key}::uuid, ${name},
            ${JSON.stringify(payload)}::jsonb, ${turnId ?? null}::uuid) as result`;
        return rows[0].result;
      });
    } catch (error) {
      // SQL has rolled back. Fetch authorized current details, not cached quota.
      if (error instanceof Error && error.message.includes('PLAN_LIMIT_REACHED')) {
        const quota = await this.inWorkspace(userId, workspaceId, async tx => {
          // Recompute lazy expiry: the rejected mutation rolled its refresh back.
          const rows = await tx.$queryRaw<Array<{ entitlement: { plan: string; productLimit: number | null } }>>`
            select public.billing_recover_effective(${workspaceId}::uuid) as entitlement`;
          const entitlement = rows[0].entitlement;
          const count = await tx.product.count({ where: { workspaceId, archivedAt: null } });
          return { plan: entitlement.plan, limit: entitlement.productLimit, count };
        });
        throw new PlanLimitException(quota.plan, quota.limit, quota.count);
      }
      throw error;
    } finally {
      invalidateWorkspace(workspaceId);
    }
  }
}

// Handled by FarleyNGX
