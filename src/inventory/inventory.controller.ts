import { BadRequestException, Body, Controller, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthGuard, AuthRequest } from '../auth/auth.guard';
import { DatabaseService } from '../database/database.service';
import { AddInventoryDto, MarkOutDto, PatchProductDto } from '../common/dto';
import { idempotencyKey } from '../common/idempotency';
import { ApiCommonErrors, ApiIdempotentWrite, ApiWorkspaceId } from '../common/openapi.decorators';
import { ApiErrorResponseDto, InventoryListResponseDto, MutationResponseDto, ProductDetailResponseDto } from '../common/openapi.dto';
import { InventoryService } from './inventory.service';
import { PlanGuard } from '../billing/plan-guard.service';

@ApiTags('inventory') @ApiBearerAuth() @ApiCommonErrors() @ApiWorkspaceId() @UseGuards(AuthGuard) @Controller('workspaces/:id/inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService, private readonly db: DatabaseService, private readonly guard: PlanGuard) {}

  @Get()
  @ApiOperation({ summary: 'Liệt kê sản phẩm trong kho' })
  @ApiQuery({ name: 'q', required: false, description: 'Tìm theo tên sản phẩm.' })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'status', required: false, enum: ['in_stock', 'out'] })
  @ApiQuery({ name: 'expiryRange', required: false, enum: ['expired', 'next_7_days', 'next_30_days', 'this_week', 'this_month'] })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 50, description: 'Từ 1 đến 100; mặc định 50.' })
  @ApiOkResponse({ type: InventoryListResponseDto })
  async list(@Req() request: AuthRequest, @Param('id', ParseUUIDPipe) id: string,
    @Query('q') q?: string, @Query('category') category?: string, @Query('status') status?: string,
    @Query('expiryRange') expiryRange?: string, @Query('limit') limitText?: string) {
    const limit = limitText === undefined ? 50 : Number(limitText);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (status && !['in_stock','out'].includes(status))) throw new BadRequestException('Bộ lọc kho không hợp lệ.');
    return this.inventory.list(request.userId, id, { q, category, status, expiryRange, limit });
  }

  @Get(':productId')
  @ApiOperation({ summary: 'Xem sản phẩm và các lô tồn kho' })
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiOkResponse({ type: ProductDetailResponseDto })
  @ApiResponse({ status: 404, type: ApiErrorResponseDto })
  detail(@Req() request: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('productId', ParseUUIDPipe) productId: string) {
    return this.inventory.detail(request.userId, id, productId);
  }

  @Post('items')
  @ApiOperation({ summary: 'Thêm sản phẩm hoặc lô tồn kho' })
  @ApiIdempotentWrite()
  @ApiCreatedResponse({ type: MutationResponseDto })
  async add(@Req() request: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Headers('idempotency-key') key: string | undefined, @Body() body: AddInventoryDto) {
    await this.guard.assertCanAddProduct(request.userId, id, { productName: body.productName, productCandidateId: body.productCandidateId });
    return this.db.operation(request.userId, id, idempotencyKey(key), 'inventory.add', body);
  }

  @Patch(':productId')
  @ApiOperation({ summary: 'Sửa tên hoặc danh mục sản phẩm' })
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiIdempotentWrite()
  @ApiOkResponse({ type: MutationResponseDto })
  @ApiResponse({ status: 404, type: ApiErrorResponseDto })
  patch(@Req() request: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('productId', ParseUUIDPipe) productId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() body: PatchProductDto) {
    if (!Object.keys(body).length) throw new BadRequestException('Không có trường cần sửa.');
    return this.db.operation(request.userId, id, idempotencyKey(key), 'inventory.patch', { productId, ...body });
  }

  @Post(':productId/mark-out')
  @ApiOperation({ summary: 'Trừ tồn kho hoặc đánh dấu hết; có thể thêm vào danh sách mua' })
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiIdempotentWrite()
  @ApiCreatedResponse({ type: MutationResponseDto })
  @ApiResponse({ status: 404, type: ApiErrorResponseDto })
  markOut(@Req() request: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('productId', ParseUUIDPipe) productId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() body: MarkOutDto) {
    return this.db.operation(request.userId, id, idempotencyKey(key), 'inventory.mark_out', { productId, ...body });
  }
}
