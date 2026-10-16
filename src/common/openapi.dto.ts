import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AttributionDto, QuantityPartDto, VoiceQuotaDto } from './workspace-response.dto';

const uuid = { format: 'uuid', example: '11111111-1111-4111-8111-111111111111' } as const;
const expiryLevels = ['ok', 'attention', 'soon', 'urgent', 'expired'] as const;

export class ApiErrorDetailDto {
  @ApiProperty({ example: 'VALIDATION_ERROR' }) code!: string;
  @ApiProperty({ example: 'Dữ liệu không hợp lệ.' }) message!: string;
  @ApiProperty({ nullable: true, type: Object, example: null }) details!: Record<string, unknown> | null;
}

export class ApiErrorResponseDto {
  @ApiProperty({ type: ApiErrorDetailDto }) error!: ApiErrorDetailDto;
}

export class MeResponseDto {
  @ApiProperty({type:VoiceQuotaDto}) voiceQuota!: VoiceQuotaDto;
  @ApiProperty(uuid) userId!: string;
  @ApiProperty({ example: 'person@homemind.vn' }) email!: string;
  @ApiProperty({ example: 'Minh Anh' }) displayName!: string;
  @ApiProperty({ type: String, nullable: true, example: '0912345678' }) phone!: string | null;
  @ApiProperty({ type: String, nullable: true, example: '+84912345678' }) loginPhone!: string | null;
  @ApiProperty({ type: String, nullable: true, example: '12 Nguyễn Huệ, Q.1, TP.HCM' }) address!: string | null;
  @ApiProperty({ enum: ['vi', 'en'] }) language!: string;
  @ApiProperty(uuid) workspaceId!: string;
  @ApiProperty({ example: 'Nhà Minh Anh' }) workspaceName!: string;
  @ApiProperty({ enum: ['household', 'store'] }) workspaceType!: string;
  @ApiProperty({ enum: ['owner', 'member'] }) role!: string;
  @ApiProperty({ enum: ['free', 'personal', 'family', 'micro_pos'] }) plan!: string;
  @ApiProperty({ type: Number, nullable: true }) productLimit!: number | null;
}

export class InventoryItemResponseDto extends AttributionDto {
  @ApiProperty({enum:['empty','known','unknown','mixed','incompatible_units']}) quantityState!: string;
  @ApiProperty({type:[QuantityPartDto]}) quantityBreakdown!: QuantityPartDto[];
  @ApiProperty(uuid) productId!: string;
  @ApiProperty({ example: 'Sữa chua Vinamilk' }) name!: string;
  @ApiProperty({ type: String, nullable: true, example: 'Thực phẩm' }) category!: string | null;
  @ApiProperty({ type: Number, nullable: true, example: 2, description: 'null = có hàng nhưng không ghi số lượng.' }) quantity!: number | null;
  @ApiProperty({ type: String, nullable: true, example: 'hộp' }) unit!: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true, example: '2026-10-05' }) expiryDate!: string | null;
  @ApiProperty({ enum: expiryLevels }) expiryLevel!: string;
  @ApiProperty({ enum: ['in_stock', 'out'] }) status!: string;
  @ApiProperty({ type: String, nullable: true, maxLength: 60 }) storageLocation!: string | null;
}

export class InventoryListResponseDto {
  @ApiProperty({ type: [InventoryItemResponseDto] }) items!: InventoryItemResponseDto[];
  @ApiProperty({ example: 1 }) total!: number;
}

export class InventoryLotResponseDto extends AttributionDto {
  @ApiProperty(uuid) lotId!: string;
  @ApiProperty({ type: Number, nullable: true, example: 2 }) quantity!: number | null;
  @ApiProperty({ type: String, nullable: true, example: 'hộp' }) unit!: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true }) expiryDate!: string | null;
  @ApiProperty({ enum: expiryLevels }) expiryLevel!: string;
  @ApiProperty({ type: Number, nullable: true, minimum: 0, maximum: 100000000000, description: 'Tổng giá mua của lô, đơn vị VND; null nếu chưa nhập.' }) priceVnd!: number | null;
  @ApiProperty({ type: String, nullable: true, maxLength: 60 }) storageLocation!: string | null;
  @ApiProperty({ format: 'date-time', description: 'Thời điểm nhập lô dùng để tính tháng chi tiêu theo giờ Việt Nam.' }) purchasedAt!: string;
}

export class ProductDetailResponseDto extends AttributionDto {
  @ApiProperty(uuid) productId!: string;
  @ApiProperty({ example: 'Sữa chua Vinamilk' }) name!: string;
  @ApiProperty({ type: String, nullable: true }) category!: string | null;
  @ApiProperty({ enum: ['in_stock', 'out'] }) status!: string;
  @ApiProperty({ type: String, nullable: true }) unit!: string | null;
  @ApiProperty({ type: [InventoryLotResponseDto] }) lots!: InventoryLotResponseDto[];
}

export class ShoppingItemResponseDto extends AttributionDto {
  @ApiProperty(uuid) id!: string;
  @ApiProperty({ example: 'Trứng' }) name!: string;
  @ApiProperty({ type: Number, nullable: true, example: 10 }) quantity!: number | null;
  @ApiProperty({ type: String, nullable: true, example: 'quả' }) unit!: string | null;
  @ApiProperty({ enum: ['needed', 'bought', 'skipped'] }) status!: string;
  @ApiProperty({ enum: ['manual', 'voice', 'assistant', 'repurchase'] }) source!: string;
}

export class ShoppingSuggestionResponseDto {
  @ApiProperty({ example: 'Trứng' }) name!: string;
  @ApiProperty({ example: 'out' }) reason!: string;
  @ApiProperty(uuid) productId!: string;
}

export class ShoppingListResponseDto {
  @ApiProperty() hasMore!: boolean;
  @ApiProperty({type:String,nullable:true}) nextCursor!: string|null;
  @ApiProperty({ type: [ShoppingItemResponseDto] }) items!: ShoppingItemResponseDto[];
  @ApiProperty({ type: [ShoppingSuggestionResponseDto] }) suggestions!: ShoppingSuggestionResponseDto[];
  @ApiProperty({ example: 1 }) total!: number;
}

export class HomeAlertResponseDto {
  @ApiProperty({ example: 'expiry' }) type!: string;
  @ApiProperty({ enum: expiryLevels }) severity!: string;
  @ApiProperty(uuid) productId!: string;
  @ApiProperty({ example: 'Sữa chua Vinamilk' }) title!: string;
  @ApiProperty({ example: 'Hết hạn 2026-10-05' }) subtitle!: string;
  @ApiProperty({ example: 'buy' }) cta!: string;
  @ApiProperty({ type: String, format: 'date', nullable: true }) expiryDate!: string | null;
}

export class HomeResponseDto {
  @ApiProperty({ enum: ['home.summary'] }) toolId!: string;
  @ApiProperty() totalProducts!: number;
  @ApiProperty() inStockCount!: number;
  @ApiProperty() outCount!: number;
  @ApiProperty() expiredCount!: number;
  @ApiProperty() expiringSoonCount!: number;
  @ApiProperty() shoppingNeededCount!: number;
  @ApiProperty({ type: Number, nullable: true }) freePlanLimit!: number | null;
  @ApiProperty({ enum: ['free', 'personal', 'family', 'micro_pos'] }) plan!: string;
  @ApiProperty() productCountTowardLimit!: number;
  @ApiProperty({ type: [InventoryItemResponseDto] }) expiringSoon!: InventoryItemResponseDto[];
  @ApiProperty({ type: [InventoryItemResponseDto] }) expired!: InventoryItemResponseDto[];
  @ApiProperty({ type: [HomeAlertResponseDto] }) alerts!: HomeAlertResponseDto[];
}

export class NotificationItemResponseDto {
  @ApiProperty({ example: 'expiry.product-id.2026-10-05' }) id!: string;
  @ApiProperty({ example: 'Sữa chua Vinamilk' }) title!: string;
  @ApiProperty({ example: 'Hết hạn 2026-10-05' }) body!: string;
  @ApiProperty({ example: 'expiry' }) type!: string;
  @ApiProperty({ example: false }) read!: boolean;
  @ApiProperty({ format: 'date-time' }) occurredAt!: string;
  @ApiProperty({ format: 'date-time' }) receivedAt!: string;
  @ApiProperty({ nullable: true, format: 'date-time' }) readAt!: string | null;
  @ApiProperty({ example: 'inventory' }) targetType!: string;
  @ApiProperty({ nullable: true }) targetId!: string | null;
}

export class NotificationDetailResponseDto extends NotificationItemResponseDto {
  @ApiProperty({ maxLength: 2000 }) detail!: string;
}

export class NotificationListResponseDto {
  @ApiProperty({ type: [NotificationItemResponseDto] }) items!: NotificationItemResponseDto[];
  @ApiProperty({ example: 3 }) unreadCount!: number;
  @ApiProperty() hasMore!: boolean;
  @ApiProperty({ nullable: true }) nextCursor!: string | null;
}

export class NotificationMutationResponseDto {
  @ApiPropertyOptional({format:'date-time'}) cutoff?: string;
  @ApiPropertyOptional() hasMore?: boolean;
  @ApiPropertyOptional() remainingCount?: number;
  @ApiPropertyOptional() complete?: boolean;
  @ApiProperty({ example: true }) ok!: boolean;
  @ApiProperty({ required: false, example: 3 }) readCount?: number;
  @ApiProperty({ required: false, format: 'date-time' }) readAt?: string;
  @ApiProperty({ required: false }) unreadCount?: number;
}

export class SearchHitResponseDto {
  @ApiProperty({ enum: ['inventory','shopping','profile','billing','notification','feature','plan'] }) type!: string;
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty() summary!: string;
  @ApiProperty({ minimum: 0, maximum: 3 }) rank!: number;
}
export class SearchListResponseDto {
  @ApiProperty({ type: [SearchHitResponseDto] }) items!: SearchHitResponseDto[];
  @ApiProperty() hasMore!: boolean;
  @ApiProperty({ nullable: true }) nextCursor!: string | null;
}

export class CreatedIdsDto {
  @ApiProperty({ type: [String], format: 'uuid' }) productIds!: string[];
  @ApiProperty({ type: [String], format: 'uuid' }) lotIds!: string[];
  @ApiProperty({ type: [String], format: 'uuid' }) transactionIds!: string[];
  @ApiProperty({ type: [String], format: 'uuid' }) shoppingItemIds!: string[];
}

export class MutationResponseDto {
  @ApiProperty({ example: true }) ok!: boolean;
  @ApiProperty({ type: CreatedIdsDto }) created!: CreatedIdsDto;
}

export class AssistantToolResponseDto {
  @ApiProperty({ example: 'inventory.list' }) toolId!: string;
  @ApiProperty({ type: 'object', additionalProperties: true }) arguments!: Record<string, unknown>;
}

export class DictionaryParameterDto {
  @ApiProperty({ example: 'range' }) name!: string;
  @ApiProperty({ example: 'expired | next_7_days | next_30_days | this_week | this_month' }) type!: string;
  @ApiProperty({ example: true }) required!: boolean;
  @ApiProperty({ example: 'Khoảng ngày hỗ trợ trong pilot.' }) description!: string;
}

export class DictionaryToolDto {
  @ApiProperty({ example: 'inventory.expiring' }) toolId!: string;
  @ApiProperty({ enum: ['read', 'write', 'none'] }) sideEffect!: string;
  @ApiProperty({ example: false }) confirmRequired!: boolean;
  @ApiProperty({ example: 'Tìm lô còn tồn theo khoảng hạn sử dụng.' }) description!: string;
  @ApiProperty({ type: String, nullable: true, example: 'GET /v1/workspaces/{id}/inventory?expiryRange={range}',
    description: 'Route thủ công tương ứng; AI không gọi route này trực tiếp.' }) manualHttp!: string | null;
  @ApiProperty({ type: [DictionaryParameterDto] }) parameters!: DictionaryParameterDto[];
  @ApiProperty({ type: [String], example: ['Tuần này có gì sắp hết hạn?'] }) examples!: string[];
}

export class DictionaryResponseDto {
  @ApiProperty({ enum: ['1.1.0'] }) dictionaryVersion!: string;
  @ApiProperty({ type: [DictionaryToolDto] }) tools!: DictionaryToolDto[];
}

export class AssistantTurnPayloadDto {
  @ApiProperty({ enum: ['1.0'] }) schemaVersion!: string;
  @ApiProperty(uuid) turnId!: string;
  @ApiProperty({ enum: ['read_result', 'write_draft', 'clarify', 'unknown'] }) kind!: string;
  @ApiProperty({ enum: ['1.1.0'] }) dictionaryVersion!: string;
  @ApiProperty({ example: 'Trong nhà còn gì?' }) correctedInput!: string;
  @ApiProperty({ example: 125 }) processingTimeMs!: number;
  @ApiPropertyOptional({ type: [AssistantToolResponseDto] }) toolsUsed?: AssistantToolResponseDto[];
  @ApiPropertyOptional({ type: [AssistantToolResponseDto] }) toolsProposed?: AssistantToolResponseDto[];
  @ApiPropertyOptional({ type: 'object', additionalProperties: true, nullable: true,
    description: 'Dữ liệu đọc từ inventory.list, inventory.expiring, shopping.list, home.summary hoặc spending.month.' }) data?: Record<string, unknown> | null;
  @ApiPropertyOptional({ type: () => [AssistantTurnPayloadDto], description: 'Các bản nháp bổ sung, mỗi turnId cần được xác nhận hoặc hủy riêng; quota chỉ ở response gốc.' }) followUps?: AssistantTurnPayloadDto[];
  @ApiPropertyOptional({ example: true }) requiresConfirmation?: boolean;
  @ApiProperty({ example: 'Trong kho có 3 sản phẩm phù hợp.' }) message!: string;
  @ApiProperty({ type: [String] }) warnings!: string[];
}

export class AssistantTurnResponseDto extends AssistantTurnPayloadDto {
  @ApiProperty({type:VoiceQuotaDto}) voiceQuota!: VoiceQuotaDto;
}

export class AssistantConfirmResponseDto {
  @ApiProperty({ enum: ['1.0'] }) schemaVersion!: string;
  @ApiProperty(uuid) turnId!: string;
  @ApiProperty({ enum: ['write_committed'] }) kind!: string;
  @ApiProperty({ example: true }) ok!: boolean;
  @ApiProperty({ type: CreatedIdsDto }) created!: CreatedIdsDto;
  @ApiProperty({ example: 'Đã lưu thay đổi.' }) message!: string;
}

export class AssistantCancelResponseDto {
  @ApiProperty(uuid) turnId!: string;
  @ApiProperty({ enum: ['cancelled'] }) kind!: string;
  @ApiProperty({ example: true }) ok!: boolean;
  @ApiProperty({ example: 'Đã hủy bản nháp.' }) message!: string;
}

export class ShoppingPreviewPageDto {
  @ApiProperty({maximum:100}) loaded!: number;
  @ApiProperty() total!: number;
  @ApiProperty() hasMore!: boolean;
  @ApiProperty({enum:['SHOPPING_LIST_FIRST_PAGE']}) continuation!: string;
  @ApiProperty({enum:[100]}) limit!: number;
}
export class ShoppingPreviewPaginationDto {
  @ApiProperty({type:ShoppingPreviewPageDto}) needed!: ShoppingPreviewPageDto;
  @ApiProperty({type:ShoppingPreviewPageDto}) bought!: ShoppingPreviewPageDto;
  @ApiProperty({type:ShoppingPreviewPageDto}) skipped!: ShoppingPreviewPageDto;
}
export class ShoppingPreviewDto {
  @ApiProperty({type:[ShoppingItemResponseDto]}) items!: ShoppingItemResponseDto[];
  @ApiProperty({type:[ShoppingSuggestionResponseDto]}) suggestions!: ShoppingSuggestionResponseDto[];
  @ApiProperty({type:ShoppingPreviewPaginationDto}) pagination!: ShoppingPreviewPaginationDto;
}
export class BootstrapResponseDto {
  @ApiProperty({type:HomeResponseDto}) home!: HomeResponseDto;
  @ApiProperty({type:InventoryListResponseDto}) inventory!: InventoryListResponseDto;
  @ApiProperty({type:ShoppingPreviewDto}) shopping!: ShoppingPreviewDto;
  @ApiProperty({type:NotificationListResponseDto}) notifications!: NotificationListResponseDto;
  @ApiProperty({format:'date-time'}) serverTime!: string;
}
