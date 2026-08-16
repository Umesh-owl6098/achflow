import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ListWebhookDeliveriesQueryDto } from './list-webhook-deliveries-query.dto';

export class ListAdminWebhookDeliveriesQueryDto extends ListWebhookDeliveriesQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  merchantId?: string;
}
