import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';

export class UpdateWebhookEndpointDto {
  @IsOptional()
  @IsString()
  @IsUrl({ require_tld: false })
  @MaxLength(2048)
  url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  signingSecret?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
