import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class ReturnPaymentDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Z0-9]{2,3}$/)
  returnCode!: string;
}
