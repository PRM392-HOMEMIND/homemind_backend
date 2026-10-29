import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { publicCorsForError } from '../feedback-popup/feedback-popup.cors';

/** body-parser failures arrive as plain errors with a machine `type`; never report them as server faults. */
function parserFailure(exception: unknown): { status: number; code: string; message: string } | undefined {
  if (!exception || typeof exception !== 'object' || exception instanceof HttpException) return undefined;
  const { type, status } = exception as { type?: unknown; status?: unknown };
  if (typeof type !== 'string' || typeof status !== 'number' || !/^(entity|charset|encoding|request)\./.test(type)) return undefined;
  if (status === 413) return { status, code: 'PAYLOAD_TOO_LARGE', message: 'Nội dung gửi lên quá lớn.' };
  if (status === 415) return { status, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Kiểu nội dung không được hỗ trợ.' };
  if (status === 400) return { status, code: 'VALIDATION_ERROR', message: 'Nội dung gửi lên không hợp lệ.' };
  return undefined;
}
/** Express maps a JSON.parse SyntaxError to a plain 400 whose text can quote part of the body. */
function malformedJson(exception: HttpException): boolean {
  const body = exception.getResponse();
  return exception.getStatus() === 400 && typeof body === 'object' && body !== null && !Array.isArray((body as { message?: unknown }).message)
    && typeof (body as { message?: unknown }).message === 'string' && /JSON/.test((body as { message: string }).message)
    && (body as { error?: unknown }).error === 'Bad Request' && !('code' in body);
}

const known: Record<string, [number, string]> = {
  FAMILY_VALIDATION_RATE_LIMIT: [429, 'Chỉ kiểm tra tối đa5 danh sách email mỗi phút. Vui lòng chờ và thử lại.'],
  INVITATION_VALIDATION_CHANGED: [409, 'Danh sách hoặc chỗ trống đã thay đổi. Hãy tải lại và kiểm tra trước khi mời.'],
  CONTRIBUTION_FORBIDDEN: [403, 'Bạn chỉ có thể sửa dữ liệu do chính mình ghi nhận.'],
  FAMILY_NOT_ELIGIBLE: [409, 'Nhóm không còn quyền chia sẻ Family.'],
  FAMILY_TARGET_UNAVAILABLE: [422, 'Không thể mời tài khoản email này. Kiểm tra lại email đã đăng ký.'],
  FAMILY_SELF_INVITE: [422, 'Bạn không thể tự mời chính mình.'],
  FAMILY_ALREADY_ACTIVE: [409, 'Tài khoản đã tham gia một nhóm Family.'],
  FAMILY_ALREADY_MEMBER: [409, 'Tài khoản đã ở trong nhóm.'],
  FAMILY_ALREADY_PENDING: [409, 'Lời mời đang chờ phản hồi.'],
  FAMILY_FULL: [409, 'Nhóm đã đủ năm người thân hoặc chỗ đang được giữ bởi lời mời.'],
  FAMILY_OWNER_CANNOT_LEAVE: [409, 'Chủ nhóm dùng thao tác kết thúc chia sẻ thay vì rời nhóm.'],
  INVITATION_NOT_FOUND: [404, 'Không tìm thấy lời mời được phép truy cập.'],
  INVITATION_STALE: [409, 'Lời mời đã được xử lý.'],
  INVITATION_EXPIRED: [409, 'Lời mời đã hết hạn.'],
  QUANTITY_INVALID: [422, 'Số lượng phải từ 0,001 đến 999.999.999,999 và tối đa ba chữ số thập phân.'],
  FORBIDDEN: [403, 'Bạn không có quyền truy cập workspace này.'],
  NOT_FOUND: [404, 'Không tìm thấy dữ liệu.'],
  VALIDATION_ERROR: [422, 'Dữ liệu không hợp lệ.'],
  STALE_TURN: [409, 'Bản nháp đã hết hạn hoặc đã được xử lý.'],
  IDEMPOTENCY_CONFLICT: [409, 'Mã yêu cầu đã được dùng với nội dung khác.'],
  RECEIVE_REQUIRES_REVIEW: [409, 'Lần nhận hàng trước cần được kiểm tra để tránh cộng kho hai lần.'],
  MANUAL_PLAN_REQUIRES_REVIEW: [409, 'Gói được cấp thủ công cần được xem xét trước khi chuyển sang thanh toán.'],
  PLAN_CHANGE_PENDING: [409, 'Đang có đơn hoặc gói khác chờ áp dụng.'],
  PLAN_ALREADY_ACTIVE: [409, 'Gói này còn hiệu lực. Gia hạn đang cập nhật.'],
  PLAN_DOWNGRADE_BLOCKED: [409, 'Không thể hạ gói trong kỳ đang hoạt động.'],
  PLAN_SEGMENT_MISMATCH: [409, 'Gói không phù hợp loại workspace.'],
  LEGACY_COVERAGE_REQUIRES_REVIEW: [409, 'Quyền gói đã mua trước đây cần được xem xét trước khi đổi gói.'],
  ASSISTANT_REQUEST_IN_PROGRESS: [409, 'Yêu cầu trợ lý đang được xử lý.'],
  ASSISTANT_REQUEST_EXPIRED: [409, 'Yêu cầu cũ đã hết kỳ. Hãy tạo yêu cầu mới.'],
  ASSISTANT_LEASE_LOST: [409, 'Chưa xác nhận được kết quả trợ lý. Hãy kiểm tra trước khi thử lại.'],
  ASSISTANT_RESERVATION_REQUIRED: [503, 'Phiên bản trợ lý cần được cập nhật trước khi tiếp tục.'],
  PAYMENT_REQUIRES_REVIEW: [409, 'Đơn thanh toán trước cần được kiểm tra trước khi tạo đơn mới.'],
  PAYMENT_HAS_FUNDS: [409, 'Đơn đã nhận tiền; cần kiểm tra trước khi hủy.'],
  PAYMENT_CANCEL_PENDING: [503, 'Đã ghi nhận yêu cầu hủy; chưa xác nhận được trạng thái với nhà cung cấp.'],
  PRICE_NOT_AVAILABLE: [409, 'Giá gói không còn khả dụng. Hãy tải lại danh sách gói.'],
  BILLING_CHANNEL_CHANGED: [503, 'Cấu hình kênh thanh toán đã thay đổi; cần kiểm tra trước khi tạo đơn.'],
  PLAN_LIMIT_REACHED: [409, 'Đã đạt hạn mức sản phẩm của gói hiện tại.'],
};

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    if(response.destroyed||response.writableEnded)return;
    const request = typeof http.getRequest === 'function' ? http.getRequest<Request | undefined>() : undefined;
    if (request?.headers) publicCorsForError(request, response);
    if(exception instanceof Prisma.PrismaClientKnownRequestError){
      const databaseCode=exception.meta?.code;
      if(['P2024','P2028'].includes(exception.code)||
        (exception.code==='P2010'&&['55P03','57014'].includes(String(databaseCode)))){
        response.status(503).json({error:{code:'DATABASE_BUSY',message:'Dữ liệu đang bận. Vui lòng thử lại với cùng mã yêu cầu.',details:null}});return;
      }
      if(exception.code==='P2034'){
        response.status(409).json({error:{code:'CONCURRENT_CHANGE',message:'Dữ liệu vừa thay đổi. Vui lòng tải lại và thử lại.',details:null}});return;
      }
    }
    const failure = parserFailure(exception);
    if (failure) {
      response.status(failure.status).json({ error: { code: failure.code, message: failure.message, details: null } });
      return;
    }
    if (exception instanceof HttpException && malformedJson(exception)) {
      response.status(400).json({ error: { code: 'INVALID_JSON', message: 'Nội dung gửi lên không phải JSON hợp lệ.', details: null } });
      return;
    }
    const raw = exception instanceof Error ? exception.message : '';
    const code = Object.keys(known).find((key) => raw.includes(key));
    if (code) {
      const [status, message] = known[code];
      response.status(status).json({ error: { code, message, details: code==='QUANTITY_INVALID' ? {field:'quantity',min:0.001,max:999999999.999,decimalPlaces:3} : null } });
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const errorCode = status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : status === 409 ? 'CONFLICT'
        : status === 429 ? 'RATE_LIMITED' : status === 504 ? 'TIMEOUT' : status === 503 ? 'AI_UNAVAILABLE'
          : status === 502 ? 'AI_INVALID_SCHEMA' : 'VALIDATION_ERROR';
      const body = exception.getResponse();
      const message = typeof body === 'object' && body && 'message' in body ? String((body as { message: unknown }).message) : exception.message;
      const declaredCode = typeof body === 'object' && body && 'code' in body ? String((body as { code: unknown }).code) : errorCode;
      const details = typeof body === 'object' && body && 'details' in body ? (body as { details: unknown }).details : null;
      response.status(status).json({ error: { code: declaredCode, message, details } });
      return;
    }
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: { code: 'INTERNAL_ERROR', message: 'Hệ thống đang gặp lỗi. Vui lòng thử lại.', details: null } });
  }
}
