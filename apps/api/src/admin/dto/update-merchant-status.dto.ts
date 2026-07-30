import { IsEnum } from 'class-validator';
import { MerchantStatus } from '@prisma/client';
export class UpdateMerchantStatusDto {
  @IsEnum(MerchantStatus) status!: MerchantStatus;
}
