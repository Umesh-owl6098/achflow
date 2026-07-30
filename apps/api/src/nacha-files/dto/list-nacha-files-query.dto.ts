import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class ListNachaFilesQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  search?: string;

  @IsOptional()
  @IsIn(['SUBMITTED', 'PENDING', 'FAILED'])
  status?: 'SUBMITTED' | 'PENDING' | 'FAILED';

  @IsOptional()
  @IsIn(['all', 'today', '7d', '30d', 'custom'])
  dateRange?: 'all' | 'today' | '7d' | '30d' | 'custom';

  @IsOptional()
  @IsString()
  startDate?: string;

  @IsOptional()
  @IsString()
  endDate?: string;
}
