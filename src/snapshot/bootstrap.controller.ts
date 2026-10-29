import { Controller, Get, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard, AuthRequest } from '../auth/auth.guard';
import { ApiCommonErrors, ApiWorkspaceId } from '../common/openapi.decorators';
import { SnapshotService } from './snapshot.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BootstrapResponseDto } from '../common/openapi.dto';

@ApiTags('home') @ApiBearerAuth() @ApiCommonErrors() @ApiWorkspaceId() @UseGuards(AuthGuard) @Controller('workspaces/:id/bootstrap')
export class BootstrapController {
  constructor(private readonly snapshots: SnapshotService, private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({
    summary: 'Tải một lần toàn bộ dữ liệu màn hình: tổng quan, kho, mua sắm, thông báo',
    description: 'Snapshot tổng hợp có cache ngắn hạn; quyền và entitlement được kiểm tra lại. Shopping là preview tối đa100 mỗi trạng thái, tiếp tục bằng API shopping-items từ trang đầu. Thông báo dùng trang riêng có cursor.',
  })
  @ApiOkResponse({ type:BootstrapResponseDto })
  async get(@Req() request: AuthRequest, @Param('id', ParseUUIDPipe) workspaceId: string) {
    const s = await this.snapshots.get(request.userId, workspaceId);
    return {
      home: s.home,
      inventory: { total: s.inventory.length, items: s.inventory },
      shopping: { items: [...s.shopping.byStatus.needed, ...s.shopping.byStatus.bought, ...s.shopping.byStatus.skipped], suggestions: s.shopping.suggestions, pagination:s.shopping.pagination },
      notifications: await this.notifications.list(request.userId, workspaceId),
      serverTime: new Date().toISOString(),
    };
  }
}
