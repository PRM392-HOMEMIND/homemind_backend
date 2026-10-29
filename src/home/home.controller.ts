import { Controller, Get, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard, AuthRequest } from '../auth/auth.guard';
import { ApiCommonErrors, ApiWorkspaceId } from '../common/openapi.decorators';
import { HomeResponseDto } from '../common/openapi.dto';
import { HomeService } from './home.service';

@ApiTags('home') @ApiBearerAuth() @ApiCommonErrors() @ApiWorkspaceId() @UseGuards(AuthGuard) @Controller('workspaces/:id/home')
export class HomeController {
  constructor(private readonly home: HomeService) {}
  @Get()
  @ApiOperation({ summary: 'Tổng quan kho, cảnh báo hạn dùng và danh sách mua' })
  @ApiOkResponse({ type: HomeResponseDto })
  summary(@Req() request: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.home.summary(request.userId, id); }
}
