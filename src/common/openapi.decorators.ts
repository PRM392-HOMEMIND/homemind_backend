import { applyDecorators } from '@nestjs/common';
import { ApiHeader, ApiParam, ApiResponse } from '@nestjs/swagger';
import { ApiErrorResponseDto } from './openapi.dto';

export function ApiCommonErrors() {
  return applyDecorators(
    ApiResponse({ status: 400, description: 'Tham số hoặc body không hợp lệ.', type: ApiErrorResponseDto }),
    ApiResponse({ status: 401, description: 'Thiếu hoặc sai HomeMind access token.', type: ApiErrorResponseDto }),
    ApiResponse({ status: 403, description: 'Không thuộc workspace được yêu cầu.', type: ApiErrorResponseDto }),
    ApiResponse({ status: 500, description: 'Lỗi hệ thống.', type: ApiErrorResponseDto }),
  );
}

export function ApiWorkspaceId() {
  return ApiParam({ name: 'id', format: 'uuid', description: 'UUID của household hiện tại.' });
}

export function ApiIdempotentWrite() {
  return applyDecorators(
    ApiHeader({ name: 'Idempotency-Key', required: true, description: 'UUID giữ nguyên khi gửi lại cùng thao tác.', schema: { type: 'string', format: 'uuid' } }),
    ApiResponse({ status: 409, description: 'Idempotency key xung đột.', type: ApiErrorResponseDto }),
    ApiResponse({ status: 422, description: 'Dữ liệu vi phạm quy tắc nghiệp vụ.', type: ApiErrorResponseDto }),
  );
}
