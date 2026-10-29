import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { AuthGuard, AuthRequest } from "../auth/auth.guard";
import type { Response } from 'express';
import { AssistantTurnDto, ConfirmDto } from "../common/dto";
import { todayVietnam } from "../common/date";
import { ApiCommonErrors } from "../common/openapi.decorators";
import {
  ApiErrorResponseDto,
  AssistantCancelResponseDto,
  AssistantConfirmResponseDto,
  AssistantTurnResponseDto,
  DictionaryResponseDto,
} from "../common/openapi.dto";
import { activeDictionary } from "./dictionary";
import { AssistantService } from "./assistant.service";

@ApiTags("assistant")
@ApiBearerAuth()
@ApiCommonErrors()
@UseGuards(AuthGuard)
@Controller("assistant")
export class AssistantController {
  constructor(private readonly service: AssistantService) {}

  @Get("dictionary")
  @ApiOperation({
    summary: "Danh mục tool đang hoạt động của AI router",
    description:
      "Danh sách tool, tham số và route thủ công hiện có. Flutter gửi yêu cầu qua POST /v1/assistant/turn với dictionaryVersion 1.1.0. Server kiểm tra tool và tham số; read trả dữ liệu workspace, write tạo bản nháp cần xác nhận. Một yêu cầu có thể trả thêm followUps, mỗi turnId phải được xác nhận hoặc hủy riêng. clarify/unknown không ghi dữ liệu.",
  })
  @ApiOkResponse({ type: DictionaryResponseDto })
  dictionary() {
    return activeDictionary;
  }

  @Post("turn")
  @ApiOperation({
    summary: "Phân tích yêu cầu, đọc dữ liệu hoặc tạo bản nháp cần xác nhận",
    description:
      "1. Xác minh HomeMind token và membership của workspaceId. 2. Gemini đề xuất tool hoặc chuỗi thao tác trong Dictionary 1.1.0; server kiểm tra lại tool/arguments. 3. Read truy vấn dữ liệu thật và trả `read_result`; write lưu `write_draft` nhưng chưa sửa tồn kho/shopping. 4. Thiếu thông tin trả `clarify`; ngoài phạm vi trả `unknown`. Transcript gốc không được lấy làm bằng chứng phân quyền.",
  })
  @ApiBody({
    type: AssistantTurnDto,
    examples: {
      read: {
        summary: "Hỏi tồn kho",
        value: {
          requestId:'11111111-1111-4111-8111-111111111112',
          workspaceId: "11111111-1111-4111-8111-111111111111",
          locale: "vi-VN",
          clientDate: todayVietnam(),
          timezone: "Asia/Ho_Chi_Minh",
          dictionaryVersion: "1.1.0",
          input: { type: "text", text: "Trong nhà còn gì?" },
        },
      },
      write: {
        summary: "Đề xuất thêm hàng",
        value: {
          requestId:'11111111-1111-4111-8111-111111111113',
          workspaceId: "11111111-1111-4111-8111-111111111111",
          locale: "vi-VN",
          clientDate: todayVietnam(),
          timezone: "Asia/Ho_Chi_Minh",
          dictionaryVersion: "1.1.0",
          input: {
            type: "voice_transcript",
            text: "Thêm hai hộp sữa chua hạn bảy ngày",
          },
        },
      },
    },
  })
  @ApiCreatedResponse({ type: AssistantTurnResponseDto })
  @ApiResponse({ status: 422, type: ApiErrorResponseDto })
  @ApiResponse({ status: 429, type: ApiErrorResponseDto })
  @ApiResponse({ status: 502, type: ApiErrorResponseDto })
  @ApiResponse({ status: 503, type: ApiErrorResponseDto })
  @ApiResponse({ status: 504, type: ApiErrorResponseDto })
  async turn(@Req() request: AuthRequest, @Body() body: AssistantTurnDto,@Res({passthrough:true})response:Response) {
    const controller=new AbortController();const abort=()=>controller.abort();
    const disconnected=()=>{if(!response.writableEnded)abort();};
    request.once('aborted',abort);response.once('close',disconnected);
    try{return await this.service.turn(request.userId, body,controller.signal);}
    finally{request.off('aborted',abort);response.off('close',disconnected);}
  }

  @Post("turns/:turnId/confirm")
  @ApiOperation({
    summary: "Xác nhận và ghi bản nháp bằng một transaction",
    description:
      "Chỉ xác nhận turn đang chờ của chính người gọi. Dùng cùng idempotencyKey khi retry; server kiểm tra lại tool, arguments và workspace trước khi ghi DB.",
  })
  @ApiParam({ name: "turnId", format: "uuid" })
  @ApiCreatedResponse({ type: AssistantConfirmResponseDto })
  @ApiResponse({ status: 409, type: ApiErrorResponseDto })
  @ApiResponse({ status: 422, type: ApiErrorResponseDto })
  confirm(
    @Req() request: AuthRequest,
    @Param("turnId", ParseUUIDPipe) turnId: string,
    @Body() body: ConfirmDto,
  ) {
    return this.service.confirm(request.userId, turnId, body);
  }
  @Post("turns/:turnId/cancel")
  @ApiOperation({
    summary: "Hủy bản nháp đang chờ xác nhận",
    description: "Chỉ chủ turn có thể hủy bản nháp chưa xử lý.",
  })
  @ApiParam({ name: "turnId", format: "uuid" })
  @ApiCreatedResponse({ type: AssistantCancelResponseDto })
  @ApiResponse({ status: 409, type: ApiErrorResponseDto })
  cancel(
    @Req() request: AuthRequest,
    @Param("turnId", ParseUUIDPipe) turnId: string,
  ) {
    return this.service.cancel(request.userId, turnId);
  }
}
