import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthGuard, AuthRequest } from '../auth/auth.guard';
import { AuthenticatedReadThrottleGuard } from '../common/authenticated-read-throttle.guard';
import { PatchLotDto } from '../common/dto';
import { ApiCommonErrors, ApiWorkspaceId } from '../common/openapi.decorators';
import { ApiErrorResponseDto } from '../common/openapi.dto';
import { SpendingService } from './spending.service';
import { SpendingResponseDto } from '../common/workspace-response.dto';
import {pageSize} from '../common/scoped-cursor';

@ApiTags('spending') @ApiBearerAuth() @ApiCommonErrors() @ApiWorkspaceId() @UseGuards(AuthGuard, AuthenticatedReadThrottleGuard)
@Controller('workspaces/:id')
export class SpendingController {
  constructor(private readonly spending: SpendingService) {}

  @Get('spending')
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @ApiOperation({ summary: 'Chi tiêu trong tháng: tổng tiền, so với tháng trước, và các lần mua chưa có giá' })
  @ApiQuery({ name: 'month', required: false, example: '2026-10', description: 'YYYY-MM theo giờ Việt Nam; mặc định tháng hiện tại.' })
  @ApiQuery({name:'scope',required:false,enum:['personal','workspace'],description:'personal chỉ là tác giả hiện tại TRONG workspace này; mặc định workspace.'})
  @ApiQuery({name:'limit',required:false,type:Number,description:'1–50 lô chưa nhập giá, mặc định20.'})
  @ApiQuery({name:'cursor',required:false,type:String})
  @ApiOkResponse({ type:SpendingResponseDto })
  summary(@Req() request: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Query('month') month?: string,@Query('scope')scope?:string,@Query('limit')limit?:string,@Query('cursor')cursor?:string) {
    return this.spending.summary(request.userId, id, month,scope??'workspace',pageSize(limit),cursor);
  }

  @Patch('lots/:lotId')
  @ApiOperation({ summary: 'Nhập hoặc sửa giá mua và nơi cất của một lô (tùy chọn)' })
  @ApiParam({ name: 'lotId', format: 'uuid' })
  @ApiOkResponse({ description: 'Giá trị mới của lô.' })
  @ApiResponse({ status: 404, type: ApiErrorResponseDto })
  patchLot(@Req() request: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('lotId', ParseUUIDPipe) lotId: string, @Body() body: PatchLotDto) {
    if (body.priceVnd === undefined && body.storageLocation === undefined) throw new BadRequestException('Không có trường cần sửa.');
    return this.spending.patchLot(request.userId, id, lotId, body);
  }
}
