import { Controller, Get, Param, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthenticatedReadThrottleGuard } from '../common/authenticated-read-throttle.guard';
import { AuthGuard, AuthRequest } from '../auth/auth.guard';
import { pageSize } from '../common/scoped-cursor';
import { SearchService } from './search.service';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ApiCommonErrors, ApiWorkspaceId } from '../common/openapi.decorators';
import { SearchListResponseDto } from '../common/openapi.dto';
@ApiTags('search') @ApiBearerAuth() @ApiCommonErrors() @ApiWorkspaceId()
@Controller('workspaces/:id/search') @UseGuards(AuthGuard,AuthenticatedReadThrottleGuard) @Throttle({default:{limit:90,ttl:60000}})
export class SearchController {
  constructor(private readonly searchService:SearchService){}
  @Get() @ApiOperation({summary:'Tìm kiếm dữ liệu được phép trong không gian hiện tại'})
  @ApiQuery({name:'q',required:false,schema:{type:'string',maxLength:120}})
  @ApiQuery({name:'limit',required:false,type:Number,description:'Mặc định 20, tối đa 50.'})
  @ApiQuery({name:'cursor',required:false,type:String})
  @ApiQuery({name:'filter',required:false,enum:['all','inventory','shopping','profile','billing','notification','feature','plan']})
  @ApiOkResponse({type:SearchListResponseDto})
  search(@Req()req:AuthRequest,@Param('id',ParseUUIDPipe)ws:string,@Query('q')q='',
    @Query('limit')limit?:string,@Query('cursor')cursor?:string,@Query('filter')filter?:string){
    return this.searchService.search(req.userId,ws,q,pageSize(limit),cursor,filter);
  }
  @Get('resolve') @ApiOperation({summary:'Kiểm tra lại quyền mở một đích có kiểu được cho phép'})
  @ApiQuery({name:'type',enum:['inventory','shopping','profile','billing','notification','feature','plan']})
  @ApiQuery({name:'target',type:String})
  @ApiOkResponse({schema:{type:'object',required:['type','id'],properties:{type:{type:'string'},id:{type:'string'}}}})
  resolve(@Req()req:AuthRequest,@Param('id',ParseUUIDPipe)ws:string,@Query('type')type='',@Query('target')target=''){
    return this.searchService.resolve(req.userId,ws,type,target);
  }
}
