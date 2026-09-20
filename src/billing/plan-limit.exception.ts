import { HttpException } from '@nestjs/common';

/** Public quota contract shared by preflight and authoritative SQL rejection. */
export class PlanLimitException extends HttpException {
  constructor(plan: string, limit: number | null, count: number) {
    const message = limit === null
      ? 'Hạn mức đã thay đổi sau khi xử lý yêu cầu. Hãy tải lại và thử lại.'
      : plan === 'free'
      ? `Gói Miễn phí đã đủ ${limit} sản phẩm. Hãy nâng cấp để thêm món mới.`
      : `Gói của bạn đã đủ ${limit} sản phẩm. Hãy liên hệ để nâng hạn mức.`;
    super({ code: 'PLAN_LIMIT', message, details: { plan, limit, count } }, 402);
  }
}
