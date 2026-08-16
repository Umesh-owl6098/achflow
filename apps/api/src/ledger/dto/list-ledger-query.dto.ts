import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';
import { LedgerEntryType } from '@prisma/client';

export class ListLedgerQueryDto {
  @IsOptional()
  @IsUUID()
  merchantId?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsEnum(LedgerEntryType)
  entryType?: LedgerEntryType;

  @IsOptional()
  @IsIn(['all', 'today', '7d', '30d', 'custom'])
  dateRange?: 'all' | 'today' | '7d' | '30d' | 'custom';

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @Transform(({ value }) => String(value))
  @Matches(/^\d+$/)
  minAmountCents?: string;

  @IsOptional()
  @Transform(({ value }) => String(value))
  @Matches(/^\d+$/)
  maxAmountCents?: string;
}
