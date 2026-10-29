import { Body, Controller, Get, HttpCode, Param, Patch, Query, Req, UseFilters, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { AdminErrorFilter, AdminGuard, AdminRequest } from './admin.auth';
import { AdminFeedback } from './admin.feedback';
import { Query as AdminQuery } from './admin.read';

/** Strict body: exactly the switch and an optional optimistic revision. No other field is accepted. */
export class AdminFeedbackPopupUpdateDto {
  @IsBoolean() enabled!: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(2147483647) expectedRevision?: number;
}

/**
 * SYSTEM_ADMIN surface of the homepage feedback popup. Same cookie session, CSRF and
 * origin rules as every other /v1/admin route. Deliberately excluded from the offline
 * admin-v1 OpenAPI contract (36 read operations); it is documented in
 * docs/HOMEMIND_FEEDBACK_POPUP_API_REPORT_VI.md.
 */
@ApiExcludeController()
@Controller('admin/feedback-popup')
@UseGuards(AdminGuard)
@UseFilters(AdminErrorFilter)
export class AdminFeedbackController {
  constructor(private readonly feedback: AdminFeedback) {}

  @Get()
  feedbackPopupConfig(@Req() req: AdminRequest) { return this.feedback.config(req); }

  @Patch() @HttpCode(200)
  feedbackPopupUpdate(@Req() req: AdminRequest, @Body() body: AdminFeedbackPopupUpdateDto) { return this.feedback.update(req, body); }

  @Get('submissions')
  feedbackPopupSubmissions(@Req() req: AdminRequest, @Query() query: AdminQuery) { return this.feedback.list(req, query); }

  @Get('submissions/:submissionId')
  feedbackPopupSubmission(@Req() req: AdminRequest, @Param('submissionId') id: string) { return this.feedback.detail(req, id); }
}
