import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
export class AdminLoginDto {
  @ApiProperty({format:'email',maxLength:254})
  @Transform(({value})=>typeof value==='string'?value.trim().toLowerCase():value)
  @IsEmail() @MaxLength(254) email!:string;
  @ApiProperty({writeOnly:true,minLength:16,maxLength:128,description:'Input only. Never logged or returned.'})
  @IsString() @MinLength(16) @MaxLength(128) password!:string;
}
