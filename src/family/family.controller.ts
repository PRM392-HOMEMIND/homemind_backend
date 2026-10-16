import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiProperty, ApiTags, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ApiCommonErrors, ApiIdempotentWrite, ApiWorkspaceId } from '../common/openapi.decorators';
import { FamilyDepartureDto, FamilyEndDto, FamilyOverviewDto, InvitationBatchResponseDto, InvitationDetailDto, InvitationMutationDto, InvitationPageDto, InvitationValidationDto, WorkspaceDirectoryDto, WorkspaceSelectedDto } from '../common/workspace-response.dto';
import { IsEmail, IsString, IsUUID, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { FamilyOwnerGuard } from './family-owner.guard';
import { AuthGuard, AuthRequest } from '../auth/auth.guard';
import { AuthenticatedReadThrottleGuard } from '../common/authenticated-read-throttle.guard';
import { Throttle } from '@nestjs/throttler';
import { idempotencyKey } from '../common/idempotency';
import { pageSize } from '../common/scoped-cursor';
import { FamilyService } from './family.service';
export class InviteRelativeDto {@ApiProperty({format:'email'}) @Transform(({value})=>typeof value==='string'?value.trim():value) @IsEmail() @MaxLength(254) email!:string;}
export class InvitationBatchDto {@ApiProperty({description:'Tối đa5 email, phân cách dấu phẩy.'}) @IsString() @MaxLength(1280) emails!:string;}
export class CreateInvitationBatchDto extends InvitationBatchDto {@ApiProperty() @IsString() @MaxLength(4096) validationToken!:string;}
export class SelectWorkspaceDto {@ApiProperty({format:'uuid'}) @IsUUID() workspaceId!:string;}

@ApiTags('family') @ApiBearerAuth() @ApiCommonErrors() @ApiResponse({status:429,description:'Giới hạn tần suất theo tài khoản.'}) @ApiResponse({status:503,description:'DB đang bận; thử lại với cùng Idempotency-Key.'}) @UseGuards(AuthGuard,AuthenticatedReadThrottleGuard)
@Throttle({default:{limit:60,ttl:60000}}) @Controller('me')
export class FamilyAccountController {
 constructor(private readonly family:FamilyService){}
 @Get('workspaces') @ApiOperation({summary:'Các workspace còn quyền; không trộn dữ liệu'})
 @ApiOkResponse({type:WorkspaceDirectoryDto})
 workspaces(@Req()r:AuthRequest){return this.family.workspaces(r.userId);}
 @Post('workspace-context') @HttpCode(200)
 @ApiOkResponse({type:WorkspaceSelectedDto})
 context(@Req()r:AuthRequest,@Body()b:SelectWorkspaceDto){return this.family.select(r.userId,b.workspaceId);}
 @Get('workspace-invitations')
 @ApiOkResponse({type:InvitationPageDto}) @ApiQuery({name:'limit',required:false,type:Number,description:'1–50, mặc định20.'}) @ApiQuery({name:'cursor',required:false})
 inbox(@Req()r:AuthRequest,@Query('limit')limit?:string,@Query('cursor')cursor?:string){return this.family.invitations(r.userId,null,pageSize(limit),cursor);}
 @Get('workspace-invitations/:invitationId')
 @ApiOkResponse({type:InvitationDetailDto})
 detail(@Req()r:AuthRequest,@Param('invitationId',ParseUUIDPipe)id:string){return this.family.invitation(r.userId,id);}
 @Post('workspace-invitations/:invitationId/accept') @HttpCode(200)
 @ApiIdempotentWrite() @ApiOkResponse({type:InvitationMutationDto})
 accept(@Req()r:AuthRequest,@Param('invitationId',ParseUUIDPipe)id:string,@Headers('idempotency-key')key?:string){return this.family.operation(r.userId,'accept',null,id,null,idempotencyKey(key));}
 @Post('workspace-invitations/:invitationId/decline') @HttpCode(200)
 @ApiIdempotentWrite() @ApiOkResponse({type:InvitationMutationDto})
 decline(@Req()r:AuthRequest,@Param('invitationId',ParseUUIDPipe)id:string,@Headers('idempotency-key')key?:string){return this.family.operation(r.userId,'decline',null,id,null,idempotencyKey(key));}
}
@ApiTags('family') @ApiBearerAuth() @ApiCommonErrors() @ApiWorkspaceId() @ApiResponse({status:429,description:'Giới hạn tần suất theo owner.'}) @ApiResponse({status:503,description:'DB đang bận; thử lại với cùng Idempotency-Key.'}) @UseGuards(AuthGuard,AuthenticatedReadThrottleGuard)
@Throttle({default:{limit:60,ttl:60000}}) @Controller('workspaces/:id')
export class FamilyWorkspaceController {
 constructor(private readonly family:FamilyService){}
 @Get('family') @ApiOkResponse({type:FamilyOverviewDto}) overview(@Req()r:AuthRequest,@Param('id',ParseUUIDPipe)ws:string){return this.family.overview(r.userId,ws);}
 @Get('invitations') @ApiOkResponse({type:InvitationPageDto}) @ApiQuery({name:'limit',required:false,type:Number,description:'1–50, mặc định20.'}) @ApiQuery({name:'cursor',required:false}) invites(@Req()r:AuthRequest,@Param('id',ParseUUIDPipe)ws:string,@Query('limit')limit?:string,@Query('cursor')cursor?:string){return this.family.invitations(r.userId,ws,pageSize(limit),cursor);}
 @Post('invitations/validate') @HttpCode(200) @UseGuards(FamilyOwnerGuard) @Throttle({default:{limit:5,ttl:60000}})
 @ApiOkResponse({type:InvitationValidationDto})
 validate(@Req()r:AuthRequest,@Param('id',ParseUUIDPipe)ws:string,@Body()b:InvitationBatchDto){return this.family.validateBatch(r.userId,ws,b.emails);}
 @Post('invitations/batch') @UseGuards(FamilyOwnerGuard) @Throttle({default:{limit:5,ttl:60000}})
 @ApiIdempotentWrite() @ApiCreatedResponse({type:InvitationBatchResponseDto})
 batch(@Req()r:AuthRequest,@Param('id',ParseUUIDPipe)ws:string,@Body()b:CreateInvitationBatchDto,@Headers('idempotency-key')key?:string){return this.family.createBatch(r.userId,ws,b.emails,b.validationToken,idempotencyKey(key));}
 @Post('invitations') @Throttle({default:{limit:10,ttl:60000}})
 @ApiIdempotentWrite() @ApiCreatedResponse({type:InvitationMutationDto})
 @UseGuards(FamilyOwnerGuard)
 invite(@Req()r:AuthRequest,@Param('id',ParseUUIDPipe)ws:string,@Body()b:InviteRelativeDto,@Headers('idempotency-key')key?:string){return this.family.operation(r.userId,'invite',ws,null,b.email,idempotencyKey(key));}
 @Post('invitations/:invitationId/cancel') @HttpCode(200)
 @ApiIdempotentWrite() @ApiOkResponse({type:InvitationMutationDto})
 @UseGuards(FamilyOwnerGuard)
 cancel(@Req()r:AuthRequest,@Param('id',ParseUUIDPipe)ws:string,@Param('invitationId',ParseUUIDPipe)id:string,@Headers('idempotency-key')key?:string){return this.family.operation(r.userId,'cancel',ws,id,null,idempotencyKey(key));}
 @Delete('family/members/:userId')
 @ApiIdempotentWrite() @ApiOkResponse({type:FamilyDepartureDto})
 @UseGuards(FamilyOwnerGuard)
 remove(@Req()r:AuthRequest,@Param('id',ParseUUIDPipe)ws:string,@Param('userId',ParseUUIDPipe)id:string,@Headers('idempotency-key')key?:string){return this.family.operation(r.userId,'remove',ws,id,null,idempotencyKey(key));}
 @Post('family/leave') @HttpCode(200)
 @ApiIdempotentWrite() @ApiOkResponse({type:FamilyDepartureDto})
 leave(@Req()r:AuthRequest,@Param('id',ParseUUIDPipe)ws:string,@Headers('idempotency-key')key?:string){return this.family.operation(r.userId,'leave',ws,null,null,idempotencyKey(key));}
 @Post('family/end') @HttpCode(200)
 @ApiIdempotentWrite() @ApiOkResponse({type:FamilyEndDto})
 @UseGuards(FamilyOwnerGuard)
 end(@Req()r:AuthRequest,@Param('id',ParseUUIDPipe)ws:string,@Headers('idempotency-key')key?:string){return this.family.operation(r.userId,'end',ws,null,null,idempotencyKey(key));}
}
