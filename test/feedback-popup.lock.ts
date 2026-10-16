import type { PrismaClient } from '@prisma/client';

/**
 * The feedback popup campaign is a single row per database, and test files run in
 * parallel. Any test that flips it takes this transaction-scoped advisory lock first,
 * so only one such file runs at a time. The lock lives in an open transaction on the
 * disposable test database and is released by calling the returned function.
 */
export async function acquireCampaignLock(operator: PrismaClient): Promise<() => Promise<void>> {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let acquired!: () => void;
  const ready = new Promise<void>(resolve => { acquired = resolve; });
  const transaction = operator.$transaction(async tx => {
    await tx.$executeRawUnsafe("select pg_advisory_xact_lock(hashtextextended('homemind.test.feedback-popup.campaign',0))");
    acquired();
    await held;
  }, { maxWait: 600_000, timeout: 1_800_000 });
  // Surface a failed transaction instead of waiting forever for the lock.
  await Promise.race([ready, transaction]);
  return async () => { release(); await transaction; };
}
