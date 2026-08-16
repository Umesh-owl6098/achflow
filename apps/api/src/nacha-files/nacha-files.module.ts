import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { NachaFilesController } from './nacha-files.controller';
import { NachaFilesService } from './nacha-files.service';

@Module({
  imports: [AuthModule, RateLimitModule],
  controllers: [NachaFilesController],
  providers: [NachaFilesService],
  exports: [NachaFilesService],
})
export class NachaFilesModule {}
