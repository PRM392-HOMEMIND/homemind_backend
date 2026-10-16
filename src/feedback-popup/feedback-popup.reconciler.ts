import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { environment } from '../config/env';
import { DatabaseService } from '../database/database.service';

export type ReconcileResult = { skipped: boolean; claims?: number; placed?: number; workspaces?: number };

/**
 * Safety net, not the enforcement point: effective access is always resolved from the
 * entitlement timeline at read time. This worker only (1) retries registration claims
 * that could not finish inline, (2) places rewards that were waiting on an indefinite
 * entitlement, and (3) refreshes the materialised plan row after a start/end boundary.
 * Every step is idempotent and anchored to stored timestamps, so a late or duplicated
 * run can never shift or extend a reward. State lives in PostgreSQL: restart-safe.
 */
@Injectable()
export class FeedbackPopupReconciler implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private work?: Promise<unknown>;
  private stopped = false;
  constructor(private readonly db: DatabaseService) {}

  onModuleInit() {
    const seconds = environment().feedbackReconcileSeconds;
    if (!seconds) return;
    this.timer = setInterval(() => {
      if (!this.work && !this.stopped) this.work = this.run().catch(() => undefined).finally(() => { this.work = undefined; });
    }, seconds * 1000);
    this.timer.unref();
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.work;
  }

  /** Public so operators and tests can run one pass deterministically. */
  async run(limit = 50): Promise<ReconcileResult> {
    return this.db.$transaction(async tx => {
      await tx.$executeRaw`set local statement_timeout='5000ms'`;
      await tx.$executeRaw`set local lock_timeout='500ms'`;
      const rows = await tx.$queryRaw<Array<{ result: ReconcileResult }>>`select public.feedback_popup_reconcile(${limit}::int) as result`;
      return rows[0].result;
    }, { timeout: 8000 });
  }
}
