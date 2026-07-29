import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { PaymentDirection } from '@prisma/client';

export class CreatePaymentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  idempotencyKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  externalReference?: string;

  @IsEnum(PaymentDirection)
  direction!: PaymentDirection;

  @IsInt()
  @Min(1)
  amountCents!: number;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string = 'USD';

  @IsString()
  @IsNotEmpty()
  @MaxLength(140)
  originatorName!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(140)
  receiverName!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  receiverAccountRef!: string;

  @IsString()
  @Matches(/^\d{9}$/, {
    message: 'routingNumber must contain exactly 9 digits',
  })
  routingNumber!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;
}
