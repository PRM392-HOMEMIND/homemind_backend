import { Body, Controller, Get, Headers, HttpCode, Options, Post, Req, Res, ServiceUnavailableException, UseGuards, HttpException, PayloadTooLargeException } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle, Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { environment } from '../config/env';
import { applyPublicCors, PublicCorsGuard } from './feedback-popup.cors';
import { FeedbackPopupService } from './feedback-popup.service';

const MAX_BODY_BYTES = 32 * 1024;
const submitLimit = { default: { limit: () => environment().feedbackSubmitRateLimit, ttl: 60_000 } };
const configLimit = { default: { limit: () => environment().feedbackConfigRateLimit, ttl: 60_000 } };

/** Public, unauthenticated homepage feedback popup. No account, session or credential is ever created here. */
@ApiTags('feedback-popup')
@Controller('public/feedback-popup')
@UseGuards(PublicCorsGuard, ThrottlerGuard)
export class FeedbackPopupPublicController {
  constructor(private readonly service: FeedbackPopupService) {}

  @Get()
  @Throttle(configLimit)
  @ApiOperation({ summary: 'Cấu hình popup góp ý công khai (bật/tắt, ưu đãi, giới hạn trường)' })
  config(@Res({ passthrough: true }) response: Response) {
    // A disabled/enabled switch must take effect immediately; never serve a cached copy.
    response.setHeader('Cache-Control', 'no-store');
    return this.service.publicConfig();
  }

  @Post('submissions')
  @HttpCode(202)
  @Throttle(submitLimit)
  @ApiOperation({ summary: 'Gửi góp ý (ẩn danh hoặc đã đăng nhập); luôn trả 202 đồng nhất' })
  @ApiBody({ schema: { type: 'object', additionalProperties: false, required: ['fullName', 'phoneNumber', 'email', 'review'],
    properties: { fullName: { type: 'string', minLength: 1, maxLength: 120 }, phoneNumber: { type: 'string' }, email: { type: 'string', format: 'email', maxLength: 254 }, review: { type: 'string', minLength: 1, maxLength: 5000 } } } })
  async submit(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string) {
    response.setHeader('Cache-Control', 'no-store');
    const type = String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') {
      throw new HttpException({ code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Chỉ hỗ trợ Content-Type: application/json.', details: null }, 415);
    }
    if (Number(request.headers['content-length'] ?? 0) > MAX_BODY_BYTES) {
      throw new PayloadTooLargeException({ code: 'PAYLOAD_TOO_LARGE', message: 'Nội dung gửi lên quá lớn.', details: null });
    }
    try {
      return await this.service.submit(body, { authorization: request.headers.authorization, idempotencyKey, ip: request.ip, userAgent: request.headers['user-agent'] });
    } catch (error) {
      if (error instanceof ServiceUnavailableException) response.setHeader('Retry-After', '2');
      throw error;
    }
  }

  @Options()
  @SkipThrottle()
  @HttpCode(204)
  preflightConfig(@Req() request: Request, @Res() response: Response) {
    applyPublicCors(request, response, true);
    response.status(204).end();
  }

  @Options('submissions')
  @SkipThrottle()
  @HttpCode(204)
  preflightSubmit(@Req() request: Request, @Res() response: Response) {
    applyPublicCors(request, response, true);
    response.status(204).end();
  }
}
