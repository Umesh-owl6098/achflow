import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class ListWebhookDeliveriesQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  search?: string;

  @IsOptional()
  @IsIn(['all', 'PENDING', 'PROCESSING', 'DELIVERED', 'FAILED'])
  status?: 'all' | 'PENDING' | 'PROCESSING' | 'DELIVERED' | 'FAILED';

  @IsOptional()
  @IsString()
  @MaxLength(80)
  eventType?: string;

  @IsOptional()
  @IsIn(['all', 'today', '7d', '30d'])
  dateRange?: 'all' | 'today' | '7d' | '30d';
}
