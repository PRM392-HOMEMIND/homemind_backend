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
        select (
          (current_user in ('homemind_app', 'postgres') or current_user like 'postgres%')
          and has_table_privilege(current_user, 'public.users', 'SELECT')
        ) as safe
      `, { maxWait: 2000, timeout: 3000 });
      if (!rows[0]?.safe) throw new Error('Database is not ready');
      response.setHeader('X-HomeMind-Revision', environment().revision);
      return { status: 'ready' };
    } catch {
      throw new ServiceUnavailableException({ code: 'NOT_READY', message: 'Service unavailable' });
    }
  }
}
