import { Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { environment } from '../config/env';

export function adminConfiguration() {
  const base = environment();
  const dsn = process.env.ADMIN_DATABASE_URL?.trim();
  const origins = (process.env.ADMIN_WEB_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!dsn && !origins.length) return null;
  try {
    const db = new URL(dsn!); const ordinary = new URL(process.env.DATABASE_URL!);
    if (!['postgresql:','postgres:'].includes(db.protocol) || db.hash || decodeURIComponent(db.username) !== 'homemind_admin_api' || !db.password || db.hostname !== ordinary.hostname || db.port !== ordinary.port || db.pathname !== ordinary.pathname) throw new Error();
    if (!origins.length || origins.length > 5 || new Set(origins).size !== origins.length) throw new Error();
    for (const origin of origins) {
      const url = new URL(origin);
      if (url.origin !== origin || url.username || url.password || (url.protocol !== 'https:' && (base.production || !['localhost','127.0.0.1'].includes(url.hostname)))) throw new Error();
    }
    db.searchParams.set('connection_limit','4'); db.searchParams.set('pool_timeout','3'); db.searchParams.set('connect_timeout','3');
    return { dsn: db.toString(), origins, key: base.accessSecret };
  } catch { throw new Error('Invalid admin configuration (values withheld)'); }
}
@Injectable()
export class AdminDatabase implements OnModuleDestroy {
  readonly config = adminConfiguration();
  private readonly client = this.config ? new PrismaClient({ datasourceUrl: this.config.dsn, log: [] }) : null;
  private active = 0;
  async onModuleDestroy() { await this.client?.$disconnect(); }
  available() { if (!this.client) throw new ServiceUnavailableException({ code:'ADMIN_BOOTSTRAP_BLOCKED', message:'Admin is not configured.' }); return this.client; }
  async query<T extends object>(sql: string, ...values: unknown[]): Promise<T[]> {
    return this.transaction(tx=>tx.$queryRawUnsafe<T[]>(sql,...values));
  }
  async transaction<T>(f: (tx: Prisma.TransactionClient) => Promise<T>, readOnly = false): Promise<T> {
    if (this.active >= 8) throw new ServiceUnavailableException({code:'ADMIN_BUSY',message:'Try later.'});
    this.active++;
    try { return await this.available().$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '3000ms'");
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '3000ms'");
      // Bounded dashboard queries lose their entire budget compiling hundreds of
      // JIT expressions. Disable compilation only for this admin transaction.
      await tx.$executeRawUnsafe('SET LOCAL jit = off');
      if (readOnly) await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      return f(tx);
    }, { isolationLevel: readOnly?'RepeatableRead':'ReadCommitted', maxWait:3000, timeout:6000 }); }
    finally { this.active--; }
  }
}
