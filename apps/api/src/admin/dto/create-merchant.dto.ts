import { MerchantStatus } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Matches,
} from 'class-validator';

export class CreateMerchantDto {
  @IsString() @IsNotEmpty() @MaxLength(40) merchantCode!: string;
  @IsString() @IsNotEmpty() @MaxLength(140) legalName!: string;
  @IsString() @IsNotEmpty() @MaxLength(100) displayName!: string;
  @IsString() @Matches(/^\d+$/) perPaymentLimit!: string;
  @IsString() @Matches(/^\d+$/) dailyAmountLimit!: string;
  @IsOptional() @IsBoolean() allowAchDebit?: boolean;
  @IsOptional() @IsBoolean() allowAchCredit?: boolean;
  @IsOptional() @IsEnum(MerchantStatus) status?: MerchantStatus;
}
