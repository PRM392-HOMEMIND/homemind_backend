import { CHALLENGE_SCHEMA, STATUS_SCHEMA, SESSION_SCHEMA, TICKET_SCHEMA, REAUTH_SCHEMA } from './email-auth.schemas';
import { Body, Controller, Delete, Header, HttpCode, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ApiTags, ApiResponse } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthService, SessionMetadata } from './auth.service';
import { AuthGuard, AuthRequest } from './auth.guard';
import { ChangeIdentifiersDto, ChangePasswordDto, CurrentPasswordDto, ForgotPasswordDto, LoginDto, RefreshDto, RegisterDto, ResetPasswordDto, ChallengeDto, VerifyChallengeDto, ResetTicketDto, NewEmailDto, LegacyEmailDto } from './auth.dto';

const metadata = (req: Request): SessionMetadata => ({ userAgent: req.headers['user-agent'], ip: req.ip,requestId:typeof req.headers['idempotency-key']==='string'?req.headers['idempotency-key']:undefined,
  authContract:req.headers['x-homemind-auth-contract']==='2'?'2':undefined });
@ApiTags('auth') @UseGuards(ThrottlerGuard) @Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Header('Cache-Control','no-store') @ApiResponse({status:201,schema:CHALLENGE_SCHEMA}) @Post('register') register(@Body() body: RegisterDto, @Req() req: Request) { return this.auth.register(body, metadata(req)); }
  @Header('Cache-Control','no-store') @ApiResponse({status:200,schema:SESSION_SCHEMA}) @Post('login') @HttpCode(200) login(@Body() body: LoginDto, @Req() req: Request) { return this.auth.login(body.identifier, body.password, metadata(req)); }
  @Header('Cache-Control','no-store') @Post('refresh') @HttpCode(200) refresh(@Body() body: RefreshDto, @Req() req: Request) { return this.auth.refresh(body.refreshToken, metadata(req)); }
  @Header('Cache-Control','no-store') @Post('logout') @HttpCode(200) logout(@Body() body: RefreshDto) { return this.auth.logout(body.refreshToken); }
  @Header('Cache-Control','no-store') @Post('logout-all') @HttpCode(200) @UseGuards(AuthGuard) logoutAll(@Req() req: AuthRequest) { return this.auth.logoutAll(req.userId); }
  @Header('Cache-Control','no-store') @Post('password/forgot') @HttpCode(202) forgot(@Body() body: ForgotPasswordDto,@Req() req:Request) { return this.auth.forgot(body.identifier,metadata(req)); }
  @Header('Cache-Control','no-store') @Post('password/reset') @HttpCode(200) reset(@Body() body: ResetPasswordDto) { return this.auth.reset(body.token, body.newPassword); }
  @Header('Cache-Control','no-store') @ApiResponse({status:200,schema:{oneOf:[CHALLENGE_SCHEMA,REAUTH_SCHEMA]}}) @Post('password/change') @HttpCode(200) @UseGuards(AuthGuard) change(@Body() body: ChangePasswordDto, @Req() req: AuthRequest) { return this.auth.changePassword(req.userId, body.currentPassword, body.newPassword, metadata(req)); }
  @Header('Cache-Control','no-store') @ApiResponse({status:200,schema:STATUS_SCHEMA}) @Post('email/status') @HttpCode(200) status(@Body() body: ChallengeDto) { return this.auth.challenges.status(body); }
  @Header('Cache-Control','no-store') @Post('email/resend') @HttpCode(202) resend(@Body() body: ChallengeDto,@Req() req:Request) { return this.auth.challenges.resend(body,req.ip,metadata(req).requestId); }
  @Header('Cache-Control','no-store') @ApiResponse({status:200,schema:{oneOf:[SESSION_SCHEMA,TICKET_SCHEMA,REAUTH_SCHEMA]}}) @Post('email/verify') @HttpCode(200) verify(@Body() body: VerifyChallengeDto,@Req() req:Request) { return this.auth.verifyEmailChallenge(body,body.purpose,body.code,metadata(req)); }
  @Header('Cache-Control','no-store') @ApiResponse({status:200,schema:{oneOf:[SESSION_SCHEMA,TICKET_SCHEMA,REAUTH_SCHEMA]}}) @Post('email/verify-authenticated') @HttpCode(200) @UseGuards(AuthGuard) verifyAuthenticated(@Body() body: VerifyChallengeDto,@Req() req:AuthRequest) { return this.auth.verifyEmailChallenge(body,body.purpose,body.code,metadata(req),req.userId); }
  @Header('Cache-Control','no-store') @ApiResponse({status:200,schema:REAUTH_SCHEMA}) @Post('password/reset-ticket') @HttpCode(200) resetTicket(@Body() body:ResetTicketDto) { return this.auth.resetWithTicket(body,body.ticket,body.newPassword); }
  @Header('Cache-Control','no-store') @ApiResponse({status:202,schema:CHALLENGE_SCHEMA}) @Post('email/change') @HttpCode(202) @UseGuards(AuthGuard) changeEmail(@Body() body:CurrentPasswordDto,@Req() req:AuthRequest) { return this.auth.requestEmailChange(req.userId,body.currentPassword,metadata(req)); }
  @Header('Cache-Control','no-store') @ApiResponse({status:202,schema:CHALLENGE_SCHEMA}) @Post('email/change-new') @HttpCode(202) @UseGuards(AuthGuard) newEmail(@Body() body:NewEmailDto,@Req() req:AuthRequest) { return this.auth.requestNewEmail(req.userId,body,body.ticket,body.email,metadata(req)); }
  @Header('Cache-Control','no-store') @ApiResponse({status:202,schema:CHALLENGE_SCHEMA}) @Post('email/legacy') @HttpCode(202) legacyEmail(@Body() body:LegacyEmailDto,@Req() req:Request) { return this.auth.addLegacyEmail(body.legacyId,body.legacyProof,body.email,metadata(req)); }
  @Header('Cache-Control','no-store') @Patch('account/identifiers') @UseGuards(AuthGuard) identifiers(@Body() body: ChangeIdentifiersDto, @Req() req: AuthRequest) { return this.auth.identifiers(req.userId, body); }
  @Header('Cache-Control','no-store') @Post('account/deactivate') @HttpCode(200) @UseGuards(AuthGuard) deactivate(@Body() body: CurrentPasswordDto, @Req() req: AuthRequest) { return this.auth.closeAccount(req.userId, body.currentPassword, 'DISABLED'); }
  @Header('Cache-Control','no-store') @Delete('account') @UseGuards(AuthGuard) delete(@Body() body: CurrentPasswordDto, @Req() req: AuthRequest) { return this.auth.closeAccount(req.userId, body.currentPassword, 'DELETED'); }
}
