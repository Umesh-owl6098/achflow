import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum SimulatorDirection {
  DEBIT = 'DEBIT',
  CREDIT = 'CREDIT',
  MIXED = 'MIXED',
}

export class SimulatorScenarioDto {
  @IsInt() @Min(0) @Max(100) successfulPercent = 100;
  @IsInt() @Min(0) @Max(100) validationFailurePercent = 0;
  @IsInt() @Min(0) @Max(100) returnPercent = 0;
  @IsInt() @Min(0) @Max(100) insufficientFundsPercent = 0;
  @IsInt() @Min(0) @Max(100) duplicatePercent = 0;
  @IsInt() @Min(0) @Max(100) delayedProcessingPercent = 0;
  @IsInt() @Min(0) @Max(100) webhookFailurePercent = 0;
}

export class CreateSimulatorRunDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  merchantIds!: string[];
  @IsEnum(SimulatorDirection)
  direction!: SimulatorDirection;
  @IsInt()
  @Min(1)
  @Max(500)
  transactionCount!: number;
  @IsInt()
  @Min(1)
  @Max(25)
  transactionsPerSecond!: number;
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  minimumAmountCents!: number;
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  maximumAmountCents!: number;
  @IsString()
  @MaxLength(3)
  secCode!: string;
  @IsOptional()
  @IsDateString()
  effectiveDate?: string;
  @IsString()
  @MaxLength(100)
  descriptionPrefix!: string;
  @IsOptional()
  @IsString()
  @MaxLength(80)
  idempotencyKeyPrefix?: string;
  @ValidateNested()
  @Type(() => SimulatorScenarioDto)
  scenario!: SimulatorScenarioDto;
}
