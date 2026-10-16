import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNotEmpty, IsNumber, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { QUANTITY_MAX } from './quantity';

export class AddInventoryDto {
  @ApiProperty({ example: 'Sữa chua Vinamilk' })
  @IsString() @IsNotEmpty() @MaxLength(160) productName!: string;
  @ApiPropertyOptional({ nullable: true, example: 2, description: 'Tùy chọn. Bỏ trống = có hàng nhưng không ghi số lượng.' })
  @IsOptional() @IsNumber({maxDecimalPlaces:3}) @Min(0.001) @Max(QUANTITY_MAX) quantity?: number | null;
  @ApiPropertyOptional({ nullable: true, example: 'hộp', description: 'Tùy chọn.' })
  @IsOptional() @IsString() @MaxLength(40) unit?: string | null;
  @ApiPropertyOptional({ nullable: true })
  @IsOptional() @IsString() @MaxLength(80) category?: string | null;
  @ApiPropertyOptional({ nullable: true, example: '2026-10-05' })
  @IsOptional() @IsDateString() expiryDate?: string | null;
  @ApiPropertyOptional({ nullable: true, format: 'uuid' })
  @IsOptional() @IsUUID() productCandidateId?: string | null;
  @ApiPropertyOptional({ nullable: true, example: 45000, description: 'Tổng tiền đã mua (VND, số nguyên). Tùy chọn.' })
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000_000) priceVnd?: number | null;
  @ApiPropertyOptional({ nullable: true, example: 'Tủ lạnh', description: 'Nơi cất. Tùy chọn.' })
  @IsOptional() @IsString() @MaxLength(60) storageLocation?: string | null;
}
export class MarkOutDto {
  @ApiPropertyOptional({ nullable: true })
  @IsOptional() @IsNumber({maxDecimalPlaces:3}) @Min(0.001) @Max(QUANTITY_MAX) quantity?: number | null;
  @ApiProperty({ example: false })
  @IsBoolean() addToShoppingList!: boolean;
}
export class PatchProductDto {
  @ApiPropertyOptional()
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(160) name?: string;
  @ApiPropertyOptional({ nullable: true })
  @IsOptional() @IsString() @MaxLength(80) category?: string | null;
}
export class AddShoppingDto {
  @ApiProperty({ example: 'Trứng' })
  @IsString() @IsNotEmpty() @MaxLength(160) name!: string;
  @ApiPropertyOptional({ nullable: true })
  @IsOptional() @IsNumber({maxDecimalPlaces:3}) @Min(0.001) @Max(QUANTITY_MAX) quantity?: number | null;
  @ApiPropertyOptional({ nullable: true })
  @IsOptional() @IsString() @MaxLength(40) unit?: string | null;
}
export class PatchShoppingDto {
  @ApiPropertyOptional()
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(160) name?: string;
  @ApiPropertyOptional({ nullable: true })
  @IsOptional() @IsNumber({maxDecimalPlaces:3}) @Min(0.001) @Max(QUANTITY_MAX) quantity?: number | null;
  @ApiPropertyOptional({ nullable: true })
  @IsOptional() @IsString() @MaxLength(40) unit?: string | null;
  @ApiPropertyOptional({ enum: ['needed','bought','skipped'] })
  @IsOptional() @IsIn(['needed','bought','skipped']) status?: string;
}
export class AssistantInputDto {
  @ApiProperty({ enum: ['text','voice_transcript'] })
  @IsIn(['text','voice_transcript']) type!: 'text' | 'voice_transcript';
  @ApiProperty({ maxLength: 2000 })
  @IsString() @IsNotEmpty() @MaxLength(2000) text!: string;
}
export class AssistantTurnDto {
  @ApiProperty({ format: 'uuid', description: 'Stable logical request ID; reuse only with identical input.' })
  @IsUUID('4') requestId!: string;
  @ApiProperty({ format: 'uuid' })
  @IsUUID() workspaceId!: string;
  @ApiProperty({ enum: ['vi-VN'] })
  @IsIn(['vi-VN']) locale!: string;
  @ApiProperty({ example: '2026-09-30' })
  @IsDateString() clientDate!: string;
  @ApiProperty({ enum: ['Asia/Ho_Chi_Minh'] })
  @IsIn(['Asia/Ho_Chi_Minh']) timezone!: string;
  @ApiProperty({ enum: ['1.1.0'] })
  @IsIn(['1.1.0']) dictionaryVersion!: string;
  @ApiProperty({ type: AssistantInputDto })
  @ValidateNested() @Type(() => AssistantInputDto) input!: AssistantInputDto;
}
export class ToolDto {
  @ApiProperty()
  @IsString() toolId!: string;
  @ApiProperty({ type: Object })
  @IsObject() arguments!: Record<string, unknown>;
}
export class ConfirmDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID() workspaceId!: string;
  @ApiProperty({ format: 'uuid' })
  @IsUUID() idempotencyKey!: string;
  @ApiProperty({ type: [ToolDto] })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(1) @ValidateNested({ each: true }) @Type(() => ToolDto) tools!: ToolDto[];
}

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Minh Anh' })
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @ValidateIf((_, value) => value !== undefined)
  @IsString() @IsNotEmpty() @MaxLength(120) displayName?: string;
  @ApiPropertyOptional({ nullable: true, example: '0912345678', description: 'Chuỗi rỗng hoặc null để xóa.' })
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsOptional() @IsString() @MaxLength(20) @Matches(/^(\+?[0-9 .-]{8,20})?$/, { message: 'Số điện thoại không hợp lệ.' }) phone?: string | null;
  @ApiPropertyOptional({ nullable: true, example: '12 Nguyễn Huệ, Q.1, TP.HCM', description: 'Chuỗi rỗng hoặc null để xóa.' })
  @IsOptional() @IsString() @MaxLength(300) address?: string | null;
  @ApiPropertyOptional({ enum: ['vi', 'en'] })
  @ValidateIf((_, value) => value !== undefined)
  @IsIn(['vi', 'en']) language?: string;
}

export class ReceiveShoppingDto {
  @ApiPropertyOptional({ nullable: true, example: 20, description: 'Số lượng thực nhận để cất vào kho. Tùy chọn.' })
  @IsOptional() @IsNumber({maxDecimalPlaces:3}) @Min(0.001) @Max(QUANTITY_MAX) quantity?: number | null;
  @ApiPropertyOptional({ nullable: true, example: 'gói', description: 'Tùy chọn.' })
  @IsOptional() @IsString() @MaxLength(40) unit?: string | null;
  @ApiPropertyOptional({ nullable: true, example: '2026-12-31' })
  @IsOptional() @IsDateString() expiryDate?: string | null;
  @ApiPropertyOptional({ nullable: true })
  @IsOptional() @IsString() @MaxLength(80) category?: string | null;
  @ApiPropertyOptional({ description: 'Mặc định lấy theo tên món trong danh sách mua.' })
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(160) productName?: string;
  @ApiPropertyOptional({ nullable: true, example: 45000, description: 'Tổng tiền đã mua (VND, số nguyên). Tùy chọn.' })
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000_000) priceVnd?: number | null;
  @ApiPropertyOptional({ nullable: true, example: 'Tủ lạnh', description: 'Nơi cất. Tùy chọn.' })
  @IsOptional() @IsString() @MaxLength(60) storageLocation?: string | null;
}

export class PatchLotDto {
  @ApiPropertyOptional({ nullable: true, example: 45000, description: 'Tổng tiền của lô; null để xóa giá.' })
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000_000) priceVnd?: number | null;
  @ApiPropertyOptional({ nullable: true, example: 'Tủ lạnh', description: 'Nơi cất; null hoặc rỗng để xóa.' })
  @IsOptional() @IsString() @MaxLength(60) storageLocation?: string | null;
}

export class UpgradeRequestDto {
  @ApiProperty({ enum: ['personal', 'family', 'micro_pos'] })
  @IsIn(['personal', 'family', 'micro_pos']) plan!: string;
  @ApiProperty({ example: 'home_card', description: 'Nơi người dùng bấm nâng cấp (để đo hiệu quả phễu).' })
  @IsString() @IsNotEmpty() @MaxLength(40) source!: string;
}
