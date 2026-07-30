import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class ListWebhooksQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  search?: string;

  @IsOptional()
  @IsIn(['all', 'active', 'disabled'])
  status?: 'all' | 'active' | 'disabled';

  @IsOptional()
  @IsIn(['all', 'PENDING', 'PROCESSING', 'DELIVERED', 'FAILED'])
  deliveryStatus?: 'all' | 'PENDING' | 'PROCESSING' | 'DELIVERED' | 'FAILED';
}
