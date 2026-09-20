import { BadRequestException, Body, Controller, Param, ParseUUIDPipe, Post, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard, AuthRequest } from '../auth/auth.guard';
import { DatabaseService } from '../database/database.service';
import { UpgradeRequestDto } from '../common/dto';
import { ApiCommonErrors, ApiWorkspaceId } from '../common/openapi.decorators';
import { SnapshotService } from '../snapshot/snapshot.service';
import { requireExternalBilling } from './billing-distribution';

@ApiTags('billing') @ApiBearerAuth() @ApiCommonErrors() @ApiWorkspaceId() @UseGuards(AuthGuard) @Controller('workspaces/:id/upgrade-requests')
export class UpgradeController {
  constructor(private readonly db: DatabaseService, private readonly snapshots: SnapshotService) {}

  @Post()
  @ApiOperation({
    summary: 'Ghi nhận yêu cầu nâng cấp gói',
    description: 'Chưa có cổng thanh toán: yêu cầu được lưu để đội ngũ liên hệ lại. Gửi lại cùng gói là an toàn (alreadyRequested = true).',
  })
  @ApiCreatedResponse({ description: '{ ok, plan, alreadyRequested }' })
  async request(@Req() request: AuthRequest, @Param('id', ParseUUIDPipe) workspaceId: string, @Body() body: UpgradeRequestDto) {
    requireExternalBilling(request.headers['x-homemind-distribution']);
    if (process.env.NODE_ENV === 'production') throw new ServiceUnavailableException({ code: 'BILLING_PAUSED', message: 'Billing is paused.' });
    const snapshot = await this.snapshots.get(request.userId, workspaceId); // kiểm tra thành viên
    if (snapshot.home.plan === body.plan) throw new BadRequestException('Bạn đang dùng gói này rồi.');
    const inserted = await this.db.asUser(request.userId, tx => tx.$executeRaw`
      insert into public.upgrade_requests (workspace_id, user_id, plan, source)
      values (${workspaceId}::uuid, ${request.userId}::uuid, ${body.plan}, ${body.source})
      on conflict (workspace_id, user_id, plan) do nothing`);
    this.snapshots.markUpgradeRequested(request.userId, workspaceId, body.plan);
    return { ok: true, plan: body.plan, alreadyRequested: inserted === 0 };
  }
}
