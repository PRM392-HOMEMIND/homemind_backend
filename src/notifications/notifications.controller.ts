import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsDateString, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthenticatedReadThrottleGuard } from '../common/authenticated-read-throttle.guard';
import { pageSize } from '../common/scoped-cursor';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AuthGuard, AuthRequest } from '../auth/auth.guard';
import { ApiCommonErrors, ApiWorkspaceId } from '../common/openapi.decorators';
import { NotificationListResponseDto, NotificationDetailResponseDto, NotificationMutationResponseDto } from '../common/openapi.dto';
import { NotificationsService } from './notifications.service';
export class NotificationReadBatchDto {
  @ApiPropertyOptional({format:'date-time',description:'Cutoff server trả từ batch đầu; giữ nguyên khi tiếp tục. Không nhận tương lai.'})
  @IsOptional() @IsDateString() cutoff?:string;
}

@ApiTags('notifications')
@ApiBearerAuth()
@ApiCommonErrors()
@ApiWorkspaceId()
@UseGuards(AuthGuard, AuthenticatedReadThrottleGuard)
@Throttle({default:{limit:120,ttl:60000}})
@Controller('workspaces/:id/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'Danh sách thông báo thật kèm trạng thái đã đọc' })
  @ApiOkResponse({ type: NotificationListResponseDto })
  @ApiQuery({name:'limit',required:false,type:Number,description:'Preview 5, inbox 20, tối đa 50.'})
  @ApiQuery({name:'cursor',required:false,type:String})
  @ApiQuery({name:'unread',required:false,type:Boolean})
  list(
    @Req() request: AuthRequest,
    @Param('id', ParseUUIDPipe) workspaceId: string,
    @Query('limit') limit?: string, @Query('cursor') cursor?: string, @Query('unread') unread?: string,
  ) {
    return this.notifications.list(request.userId, workspaceId, pageSize(limit, 5), cursor, unread === 'true');
  }

  @Get(':notificationId')
  @ApiOperation({summary:'Đọc chi tiết mà không thay đổi thời điểm đã đọc'})
  @ApiOkResponse({type:NotificationDetailResponseDto})
  detail(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) ws: string,
    @Param('notificationId', ParseUUIDPipe) id: string) { return this.notifications.detail(req.userId, ws, id); }

  @Patch(':notificationId/read')
  @ApiOperation({ summary: 'Đánh dấu một thông báo đã đọc' })
  @ApiOkResponse({ type: NotificationMutationResponseDto })
  markRead(
    @Req() request: AuthRequest,
    @Param('id', ParseUUIDPipe) workspaceId: string,
    @Param('notificationId', ParseUUIDPipe) notificationId: string,
  ) {
    return this.notifications.markRead(request.userId, workspaceId, notificationId);
  }

  @Post('read-all')
  @HttpCode(200)
  @ApiOperation({ summary: 'Đánh dấu một batch tối đa50 thông báo trước cutoff; hasMore báo cần tiếp tục' })
  @ApiOkResponse({ type: NotificationMutationResponseDto })
  markAllRead(
    @Req() request: AuthRequest,
    @Param('id', ParseUUIDPipe) workspaceId: string,
    @Body() body:NotificationReadBatchDto,
  ) {
    return this.notifications.markAllRead(request.userId, workspaceId,body?.cutoff);
  }
}

@ApiTags('notifications') @ApiBearerAuth() @ApiCommonErrors()
@UseGuards(AuthGuard,AuthenticatedReadThrottleGuard) @Throttle({default:{limit:120,ttl:60000}})
@Controller('me/notifications')
export class AccountNotificationsController {
 constructor(private readonly notifications:NotificationsService){}
 @Get() @ApiOkResponse({type:NotificationListResponseDto})
 @ApiQuery({name:'limit',required:false,type:Number,description:'1–50, mặc định20.'})
 @ApiQuery({name:'cursor',required:false,type:String})
 @ApiQuery({name:'unread',required:false,type:Boolean})
 list(@Req()r:AuthRequest,@Query('limit')limit?:string,@Query('cursor')cursor?:string,@Query('unread')unread?:string){return this.notifications.list(r.userId,null,pageSize(limit),cursor,unread==='true');}
 @Get(':notificationId') @ApiOkResponse({type:NotificationDetailResponseDto})
 detail(@Req()r:AuthRequest,@Param('notificationId',ParseUUIDPipe)id:string){return this.notifications.detail(r.userId,null,id);}
 @Patch(':notificationId/read') @ApiOkResponse({type:NotificationMutationResponseDto})
 read(@Req()r:AuthRequest,@Param('notificationId',ParseUUIDPipe)id:string){return this.notifications.markRead(r.userId,null,id);}
 @Post('read-all') @HttpCode(200) @ApiOkResponse({type:NotificationMutationResponseDto})
 batch(@Req()r:AuthRequest,@Body()body:NotificationReadBatchDto){return this.notifications.markAllRead(r.userId,null,body?.cutoff);}
}
