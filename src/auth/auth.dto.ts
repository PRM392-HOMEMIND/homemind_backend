import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Equals, IsBoolean, IsIn, IsOptional, IsString, IsUUID, Matches, Length, MaxLength, MinLength } from 'class-validator';
import { otpTitles, OtpPurpose } from '../email/email.templates';

export class LoginDto {
  @ApiProperty() @IsString() @Length(1, 254) identifier!: string;
  @ApiProperty({ writeOnly: true }) @IsString() @Length(1, 128) password!: string;
}
export class RegisterDto {
  @ApiProperty({ enum: [true] }) @IsBoolean() @Equals(true) acceptedTerms!: boolean;
  @ApiProperty({ enum: [true] }) @IsBoolean() @Equals(true) acceptedPrivacy!: boolean;
  @ApiProperty() @IsString() @Length(1, 120) displayName!: string;
  @ApiProperty() @IsString() @Length(3,254) email!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @ApiProperty({ writeOnly: true }) @IsString() @Length(8, 128) password!: string;
  @ApiProperty() @IsIn(['household', 'store']) workspaceType: 'household' | 'store' = 'household';
}
export class RefreshDto {
  @ApiProperty({ writeOnly: true }) @IsString() @Length(32, 256) refreshToken!: string;
}
export class ForgotPasswordDto {
  @ApiProperty() @IsString() @Length(1, 254) identifier!: string;
}
export class ResetPasswordDto {
  @ApiProperty({ writeOnly: true }) @IsString() @Length(32, 256) token!: string;
  @ApiProperty({ writeOnly: true }) @IsString() @Length(8, 128) newPassword!: string;
}
export class CurrentPasswordDto {
  @ApiProperty({ writeOnly: true }) @IsString() @MinLength(1) @MaxLength(128) currentPassword!: string;
}
export class ChangePasswordDto extends CurrentPasswordDto {
  @ApiProperty({ writeOnly: true }) @IsString() @Length(8, 128) newPassword!: string;
}
export class ChangeIdentifiersDto extends CurrentPasswordDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(254) newEmail?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) newPhone?: string | null;
}
export class ChallengeDto {
  @ApiProperty() @IsUUID('4') challengeId!: string;
  @ApiProperty({writeOnly:true}) @IsString() @Length(43,64) challengeToken!: string;
}
export class VerifyChallengeDto extends ChallengeDto {
  @ApiProperty({enum:Object.keys(otpTitles)}) @IsIn(Object.keys(otpTitles)) purpose!: OtpPurpose;
  @ApiProperty({writeOnly:true,pattern:'^[0-9]{6}$'}) @IsString() @Matches(/^[0-9]{6}$/) code!: string;
}
export class ResetTicketDto extends ChallengeDto {
  @ApiProperty({writeOnly:true}) @IsString() @Length(64,128) ticket!: string;
  @ApiProperty({writeOnly:true}) @IsString() @Length(8,128) newPassword!: string;
}
export class NewEmailDto extends ChallengeDto {
  @ApiProperty({writeOnly:true}) @IsString() @Length(64,128) ticket!: string;
  @ApiProperty() @IsString() @Length(3,254) email!: string;
}
export class LegacyEmailDto {
  @ApiProperty() @IsUUID('4') legacyId!: string;
  @ApiProperty({writeOnly:true}) @IsString() @Length(64,128) legacyProof!: string;
  @ApiProperty() @IsString() @Length(3,254) email!: string;
}
