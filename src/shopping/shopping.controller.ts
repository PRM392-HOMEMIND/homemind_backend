import { BadRequestException, NotFoundException, Body, Controller, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthGuard, AuthRequest } from '../auth/auth.guard';
import { DatabaseService } from '../database/database.service';
import { AddShoppingDto, PatchShoppingDto, ReceiveShoppingDto } from '../common/dto';
import { idempotencyKey } from '../common/idempotency';
import { ApiCommonErrors, ApiIdempotentWrite, ApiWorkspaceId } from '../common/openapi.decorators';
import { ApiErrorResponseDto, MutationResponseDto, ShoppingListResponseDto } from '../common/openapi.dto';
import { ShoppingService } from './shopping.service';
import { pageSize } from '../common/scoped-cursor';

@ApiTags('shopping') @ApiBearerAuth() @ApiCommonErrors() @ApiWorkspaceId() @UseGuards(AuthGuard) @Controller('workspaces/:id/shopping-items')
export class ShoppingController {
  constructor(private readonly shopping: ShoppingService, private readonly db: DatabaseService) {}

  @Get()
  @ApiOperation({ summary: 'Liệt kê món cần mua hoặc đã xử lý' })
  @ApiQuery({ name: 'status', required: false, enum: ['needed', 'bought', 'skipped'], description: 'Mặc định needed.' })
  @ApiQuery({ name: 'includeSuggestions', required: false, type: Boolean, description: 'Gợi ý từ sản phẩm đã hết; mặc định false.' })
  @ApiOkResponse({ type: ShoppingListResponseDto })
  @ApiQuery({name:'limit',required:false,type:Number,description:'1–50, mặc định50.'})
  @ApiQuery({name:'cursor',required:false,type:String})
  @ApiQuery({name:'q',required:false,type:String})
  list(@Req() request: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Query('status') status?: string, @Query('includeSuggestions') includeSuggestions?: string,
    @Query('limit') limit?:string,@Query('cursor') cursor?:string,@Query('q') q?:string) {
    return this.shopping.list(request.userId, id, status, includeSuggestions === 'true',pageSize(limit,50),cursor,q);
  }

  @Post()
  @ApiOperation({ summary: 'Thêm món vào danh sách mua' })
  @ApiIdempotentWrite()
  @ApiCreatedResponse({ type: MutationResponseDto })
  add(@Req() request: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Headers('idempotency-key') key: string | undefined, @Body() body: AddShoppingDto) {
    return this.db.operation(request.userId, id, idempotencyKey(key), 'shopping.add', body);
  }

  @Get(':itemId')
  @ApiOperation({summary:'Chi tiết món theo quyền không gian hiện tại'})
  @ApiParam({name:'itemId',format:'uuid'})
  @ApiOkResponse({schema:{type:'object',required:['id','name','status'],properties:{id:{type:'string',format:'uuid'},name:{type:'string'},quantity:{type:'number',nullable:true},unit:{type:'string',nullable:true},status:{type:'string'}}}})
  detail(@Req() request: AuthRequest, @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string) {
    return this.db.inWorkspace(request.userId, id, async tx => {
      const item = await tx.shoppingItem.findFirst({where:{workspaceId:id,id:itemId}});
      if (!item) throw new NotFoundException();
      return {id:item.id,name:item.name,quantity:item.quantity===null?null:Number(item.quantity),unit:item.unit,status:item.status};
    });
  }

  @Patch(':itemId')
  @ApiOperation({ summary: 'Sửa món hoặc chuyển sang bought/skipped' })
  @ApiParam({ name: 'itemId', format: 'uuid' })
  @ApiIdempotentWrite()
  @ApiOkResponse({ type: MutationResponseDto })
  @ApiResponse({ status: 404, type: ApiErrorResponseDto })
  patch(@Req() request: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('itemId', ParseUUIDPipe) itemId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() body: PatchShoppingDto) {
    if (!Object.keys(body).length) throw new BadRequestException('Không có trường cần sửa.');
    return this.db.operation(request.userId, id, idempotencyKey(key), 'shopping.patch', { itemId, ...body });
  }

  @Post(':itemId/receive')
  @ApiOperation({
    summary: 'Nhận hàng: cất món vào kho và đóng món trong danh sách mua',
    description: 'Cộng kho và chuyển món sang bought trong cùng transaction. Retry hoặc nhận đồng thời không cộng hai lần.',
  })
  @ApiParam({ name: 'itemId', format: 'uuid' })
  @ApiIdempotentWrite()
  @ApiCreatedResponse({ type: MutationResponseDto })
  @ApiResponse({ status: 404, type: ApiErrorResponseDto })
  async receive(@Req() request: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('itemId', ParseUUIDPipe) itemId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() body: ReceiveShoppingDto) {
    const idem = idempotencyKey(key);
    return this.db.operation(request.userId, id, idem, 'shopping.receive', { itemId, ...body, unit: body.unit?.trim() || null });
  }
}
