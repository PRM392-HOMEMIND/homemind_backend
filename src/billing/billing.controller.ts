import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsString, Matches } from 'class-validator';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Response } from 'express';
import { AuthGuard, AuthRequest } from '../auth/auth.guard';
import { BillingService } from './billing.service';
import { consumptionBilling, externalBillingAllowed, requireExternalBilling } from './billing-distribution';
export class CreatePaymentDto {
  @IsString() @Matches(/^(personal|family|micro_pos)-month-v\d+$/) priceId!:string;
  @IsIn(['immediate_upgrade']) transition!:string;
}
@ApiTags('billing') @Controller('billing')
export class BillingPublicController {
  constructor(private readonly billing:BillingService) {}
  @Get('plans') async plans(@Headers('x-homemind-distribution') distribution?:string) {
    const catalog = await this.billing.plans();
    return {...catalog, checkoutEnabled:catalog.checkoutEnabled && externalBillingAllowed(distribution)};
  }
  @Post('payos/webhook') @HttpCode(200)
  webhook(@Body() body:object) { return this.billing.webhook(body); }
  @Get('payos/return') returned(@Res() res:Response) { return this.page(res,'Đã quay lại từ trang thanh toán. Mở HomeMind và kiểm tra trạng thái đơn; trang này không xác nhận đã trả tiền.'); }
  @Get('payos/cancel') cancelled(@Res() res:Response) { return this.page(res,'Bạn đã rời trang thanh toán. Mở HomeMind để kiểm tra hoặc hủy đơn; trang này không thay đổi gói.'); }
  private page(res:Response,message:string) {
    res.set({'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':'no-store'});
    return res.type('html').send(`<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>HomeMind</title><body><h1>HomeMind</h1><p>${message}</p></body></html>`);
  }
}
@ApiTags('billing') @ApiBearerAuth() @UseGuards(AuthGuard,ThrottlerGuard)
@Throttle({default:{limit:30,ttl:60000}}) @Controller('workspaces/:workspaceId/billing')
export class BillingController {
  constructor(private readonly billing:BillingService) {}
  private async read(req:AuthRequest,ws:string,id:string|null,offset=0) {
    const result=await this.billing.read(req.userId,ws,id,offset);
    return externalBillingAllowed(req.headers['x-homemind-distribution']) ? result : consumptionBilling(result);
  }
  @Get('subscription') subscription(@Req() req:AuthRequest,@Param('workspaceId',ParseUUIDPipe) ws:string) { return this.read(req,ws,null); }
  @Get('payments') history(@Req() req:AuthRequest,@Param('workspaceId',ParseUUIDPipe) ws:string,@Query('offset') value?:string) {
    const offset=Number(value??0); if(!Number.isInteger(offset)||offset<0||offset>100000) throw new BadRequestException('Offset không hợp lệ');
    return this.read(req,ws,null,offset);
  }
  @Post('payments') @Throttle({default:{limit:6,ttl:60000}})
  create(@Req() req:AuthRequest,@Param('workspaceId',ParseUUIDPipe) ws:string,@Body() body:CreatePaymentDto,@Headers('idempotency-key') key:string) {
    requireExternalBilling(req.headers['x-homemind-distribution']);
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(key??'')) throw new BadRequestException('Cần Idempotency-Key UUID v4');
    return this.billing.create(req.userId,ws,body.priceId,key);
  }
  @Get('payments/:paymentId') detail(@Req() req:AuthRequest,@Param('workspaceId',ParseUUIDPipe) ws:string,@Param('paymentId',ParseUUIDPipe) id:string) { return this.read(req,ws,id); }
  @Post('payments/:paymentId/reconcile') @HttpCode(200) reconcile(@Req() req:AuthRequest,@Param('workspaceId',ParseUUIDPipe) ws:string,@Param('paymentId',ParseUUIDPipe) id:string) { requireExternalBilling(req.headers['x-homemind-distribution']); return this.billing.reconcile(req.userId,ws,id); }
  @Post('payments/:paymentId/cancel') @HttpCode(200) cancel(@Req() req:AuthRequest,@Param('workspaceId',ParseUUIDPipe) ws:string,@Param('paymentId',ParseUUIDPipe) id:string) { requireExternalBilling(req.headers['x-homemind-distribution']); return this.billing.cancel(req.userId,ws,id); }
}
