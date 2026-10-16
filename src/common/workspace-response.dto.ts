import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class VoiceQuotaDto {
  @ApiProperty({format:'uuid'}) periodId!: string;
  @ApiProperty({enum:['free','personal','family','micro_pos']}) plan!: string;
  @ApiProperty() policyVersion!: string;
  @ApiProperty({minimum:0}) used!: number;
  @ApiProperty({minimum:0}) total!: number;
  @ApiProperty({minimum:0}) reserved!: number;
  @ApiProperty({minimum:0}) remaining!: number;
  @ApiProperty({format:'date-time'}) startsAt!: string;
  @ApiProperty({format:'date-time'}) expiresAt!: string;
  @ApiProperty({format:'date-time'}) serverNow!: string;
  @ApiPropertyOptional({format:'uuid',description:'Pool chung; có thể khác workspace đang đọc dữ liệu.'}) poolWorkspaceId?: string;
  @ApiPropertyOptional() shared?: boolean;
}
export class AttributionDto {
  @ApiProperty({type:String,nullable:true,format:'uuid',description:'null = chưa xác định tác giả từ dữ liệu lịch sử.'}) createdBy!: string|null;
  @ApiProperty({description:'Quyền tại thời điểm đọc; server luôn kiểm lại khi ghi.'}) canEdit!: boolean;
}
export class QuantityPartDto {
  @ApiProperty({type:String,nullable:true}) unit!: string|null;
  @ApiProperty({minimum:0}) knownQuantity!: number;
  @ApiProperty({minimum:0}) unknownLots!: number;
}
export class UnpricedPurchaseDto extends AttributionDto {
  @ApiProperty({format:'uuid'}) lotId!: string;
  @ApiProperty({format:'uuid'}) purchaseId!: string;
  @ApiProperty({format:'uuid'}) productId!: string;
  @ApiProperty({type:String,nullable:true}) name!: string|null;
  @ApiProperty({format:'date-time'}) purchasedAt!: string;
  @ApiProperty({type:String,nullable:true}) storageLocation!: string|null;
}
export class SpendingCategoryDto {
  @ApiProperty({type:String,nullable:true}) category!: string|null;
  @ApiProperty() totalVnd!: number;
}
export class SpendingMemberDto {
  @ApiProperty({type:String,nullable:true,format:'uuid'}) userId!: string|null;
  @ApiProperty({type:String,nullable:true}) displayName!: string|null;
  @ApiProperty() purchaseCount!: number;
  @ApiProperty({description:'Chỉ số tiền đã biết, không thay null bằng0 ở từng lần mua.'}) knownTotalVnd!: number;
}
export class SpendingResponseDto {
  @ApiProperty({pattern:'^[0-9]{4}-(0[1-9]|1[0-2])$'}) month!: string;
  @ApiProperty({enum:['personal','workspace']}) scope!: string;
  @ApiProperty() totalVnd!: number;
  @ApiProperty() previousTotalVnd!: number;
  @ApiProperty() purchaseCount!: number;
  @ApiProperty() pricedCount!: number;
  @ApiProperty() unpricedCount!: number;
  @ApiProperty() unpricedLotCount!: number;
  @ApiProperty() unknownAuthorPurchaseCount!: number;
  @ApiProperty({type:[SpendingCategoryDto]}) byCategory!: SpendingCategoryDto[];
  @ApiProperty({type:[SpendingMemberDto]}) byMember!: SpendingMemberDto[];
  @ApiProperty({type:[UnpricedPurchaseDto]}) unpriced!: UnpricedPurchaseDto[];
  @ApiProperty() hasMore!: boolean;
  @ApiProperty({type:String,nullable:true}) nextCursor!: string|null;
}
export class FamilyMemberDto {
  @ApiProperty({format:'uuid'}) userId!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty({enum:['owner','member']}) role!: string;
  @ApiProperty({format:'date-time'}) joinedAt!: string;
  @ApiProperty({description:'AI đã commit trong kỳ quota chung hiện tại.'}) usage!: number;
  @ApiProperty({description:'Số purchase_id khác nhau trong kỳ; tách lô không tăng đếm.'}) recordedPurchases!: number;
}
export class FamilyOverviewDto {
  @ApiProperty({format:'uuid'}) workspaceId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() eligible!: boolean;
  @ApiProperty() sharingEnabled!: boolean;
  @ApiProperty({enum:['owner','member']}) role!: string;
  @ApiProperty({format:'uuid'}) ownerId!: string;
  @ApiProperty({minimum:0,maximum:5}) relativeCount!: number;
  @ApiProperty({minimum:0,maximum:5}) pendingCount!: number;
  @ApiProperty({enum:[5]}) capacity!: number;
  @ApiProperty({minimum:0,maximum:5}) availableSeats!: number;
  @ApiProperty({format:'date-time'}) serverNow!: string;
  @ApiProperty({type:VoiceQuotaDto}) quota!: VoiceQuotaDto;
  @ApiProperty({type:[FamilyMemberDto]}) members!: FamilyMemberDto[];
}
export class WorkspaceEntryDto {
  @ApiProperty({format:'uuid'}) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({enum:['household','store']}) type!: string;
  @ApiProperty({enum:['owner','member']}) role!: string;
  @ApiProperty({enum:['free','personal','family','micro_pos']}) plan!: string;
}
export class WorkspaceDirectoryDto {
  @ApiProperty({type:[WorkspaceEntryDto]}) items!: WorkspaceEntryDto[];
}
export class WorkspaceSelectedDto {
  @ApiProperty({format:'uuid'}) workspaceId!: string;
}
export class InvitationDto {
  @ApiProperty({format:'uuid'}) id!: string;
  @ApiProperty({format:'uuid'}) workspaceId!: string;
  @ApiProperty() workspaceName!: string;
  @ApiProperty() inviterName!: string;
  @ApiProperty() inviteeName!: string;
  @ApiProperty({enum:['PENDING','ACCEPTED','DECLINED','CANCELLED','EXPIRED','INVALIDATED']}) state!: string;
  @ApiProperty({format:'date-time'}) createdAt!: string;
  @ApiProperty({format:'date-time'}) expiresAt!: string;
  @ApiProperty({type:String,nullable:true,format:'date-time'}) respondedAt!: string|null;
  @ApiProperty({minimum:0,maximum:3}) declineCount!: number;
  @ApiProperty({type:String,nullable:true,format:'date-time'}) blockedUntil!: string|null;
}
export class InvitationDetailDto extends InvitationDto {
  @ApiProperty() isRecipient!: boolean;
}
export class InvitationPageDto {
  @ApiProperty({type:[InvitationDto]}) items!: InvitationDto[];
  @ApiProperty() hasMore!: boolean;
  @ApiProperty({type:String,nullable:true}) nextCursor!: string|null;
}
export class InvitationValidationRowDto {
  @ApiProperty() email!: string;
  @ApiProperty({enum:['INVALID_EMAIL','DUPLICATE_EMAIL','EMAIL_NOT_REGISTERED','ACCOUNT_INACTIVE','SELF_INVITATION','ALREADY_MEMBER','ALREADY_FAMILY','ALREADY_PENDING','INVITE_COOLDOWN','FAMILY_CAPACITY','READY']}) code!: string;
  @ApiProperty() message!: string;
  @ApiProperty({type:String,nullable:true,format:'date-time'}) blockedUntil!: string|null;
}
export class InvitationValidationDto {
  @ApiProperty({type:[InvitationValidationRowDto],maxItems:5}) results!: InvitationValidationRowDto[];
  @ApiProperty() canSubmit!: boolean;
  @ApiProperty({minimum:0,maximum:5}) availableSeats!: number;
  @ApiProperty({format:'date-time'}) serverNow!: string;
  @ApiProperty({type:String,nullable:true,description:'Mã xác nhận ký, hạn15 phút, gắn owner/workspace/email/account; không phải access token.'}) validationToken!: string|null;
}
export class InvitationMutationDto {
  @ApiProperty({format:'uuid'}) invitationId!: string;
  @ApiProperty({enum:['PENDING','ACCEPTED','DECLINED','CANCELLED']}) state!: string;
  @ApiPropertyOptional({format:'date-time'}) expiresAt?: string;
  @ApiPropertyOptional() changed?: boolean;
  @ApiProperty() replayed!: boolean;
}
export class InvitationBatchResponseDto {
  @ApiProperty({format:'uuid'}) workspaceId!: string;
  @ApiProperty({minimum:1,maximum:5}) createdCount!: number;
  @ApiProperty({type:[InvitationMutationDto]}) invitations!: InvitationMutationDto[];
  @ApiProperty() replayed!: boolean;
}
export class FamilyDepartureDto extends WorkspaceSelectedDto {
  @ApiProperty() ok!: boolean;
  @ApiProperty({format:'uuid'}) userId!: string;
  @ApiProperty({enum:['free']}) personalPlan!: string;
  @ApiProperty() replayed!: boolean;
}
export class FamilyEndDto {
  @ApiProperty() ok!: boolean;
  @ApiProperty({description:'false khi dừng chia sẻ thành công.'}) sharingEnabled!: boolean;
  @ApiProperty() replayed!: boolean;
}
