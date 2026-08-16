import { IsOptional, IsString } from 'class-validator';
import { ListPaymentsQueryDto } from './list-payments-query.dto';

export class ListAdminPaymentsQueryDto extends ListPaymentsQueryDto {
  @IsOptional()
  @IsString()
  merchantId?: string;
}
