import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { LedgerController } from './ledger.controller';
import { LedgerService } from './ledger.service';

@Module({
  imports: [AuthModule, RateLimitModule],
  controllers: [LedgerController],
  providers: [LedgerService],
})
export class LedgerModule {}
