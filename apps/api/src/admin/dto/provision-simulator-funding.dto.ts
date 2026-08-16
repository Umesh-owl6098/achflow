import { IsString, Matches } from 'class-validator';

export class ProvisionSimulatorFundingDto {
  @IsString()
  @Matches(/^\d+$/)
  amountCents!: string;

  @Matches(/^[A-Za-z]{3}$/)
  currency = 'USD';
}
