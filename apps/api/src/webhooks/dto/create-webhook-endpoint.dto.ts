import { IsNotEmpty, IsString, IsUrl, MaxLength } from 'class-validator';

export class CreateWebhookEndpointDto {
  @IsString()
  @IsUrl({ require_tld: false })
  @MaxLength(2048)
  url!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  signingSecret!: string;
}
