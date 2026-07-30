import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { resolve } from 'path';
import { PaymentsModule } from './payments/payments.module';
import { PrismaModule } from './prisma/prisma.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { LedgerModule } from './ledger/ledger.module';
import { NachaFilesModule } from './nacha-files/nacha-files.module';
import { AdminModule } from './admin/admin.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [
        resolve(process.cwd(), 'apps/api/.env'),
        resolve(process.cwd(), '.env'),
        resolve(__dirname, '../.env'),
      ],
    }),
    PrismaModule,
    WebhooksModule,
    PaymentsModule,
    DashboardModule,
    LedgerModule,
    NachaFilesModule,
    AdminModule,
  ],
})
export class AppModule {}
