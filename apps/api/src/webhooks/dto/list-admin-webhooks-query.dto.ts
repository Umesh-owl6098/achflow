import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ListWebhooksQueryDto } from './list-webhooks-query.dto';

export class ListAdminWebhooksQueryDto extends ListWebhooksQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  merchantId?: string;
}
