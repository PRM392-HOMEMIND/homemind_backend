import { Controller, Get, Res, ServiceUnavailableException } from '@nestjs/common';
import type { Response } from 'express';
import { DatabaseService } from '../database/database.service';
import { environment } from '../config/env';

@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  @Get('live')
  live(@Res({ passthrough: true }) response: Response) {
    response.setHeader('X-HomeMind-Revision', environment().revision);
    return { status: 'live' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) response: Response) {
    try {
      const rows = await this.db.$transaction(async tx => tx.$queryRaw<Array<{ safe: boolean }>>`
        select current_user = 'homemind_app' and not rolsuper and not rolbypassrls
          and has_table_privilege(current_user, 'public.users', 'SELECT')
          and has_table_privilege(current_user, 'public.products', 'SELECT')
          and not exists (
            select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
            where n.nspname='public' and c.relkind='r' and c.relowner=r.oid
          ) and exists (
            select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
            where n.nspname='public' and c.relname='products' and c.relrowsecurity
          ) as safe from pg_roles r where rolname=current_user
      `, { maxWait: 2000, timeout: 3000 });
      if (!rows[0]?.safe) throw new Error('Database is not ready');
      response.setHeader('X-HomeMind-Revision', environment().revision);
      return { status: 'ready' };
    } catch {
      throw new ServiceUnavailableException({ code: 'NOT_READY', message: 'Service unavailable' });
    }
  }
}
