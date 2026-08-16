import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { DashboardService } from '../dashboard/dashboard.service';
import { ListLedgerQueryDto } from '../ledger/dto/list-ledger-query.dto';
import { LedgerService } from '../ledger/ledger.service';
import { ListNachaFilesQueryDto } from '../nacha-files/dto/list-nacha-files-query.dto';
import { NachaFilesService } from '../nacha-files/nacha-files.service';
import { PaymentsService } from '../payments/payments.service';
import { ListAdminPaymentsQueryDto } from '../payments/dto/list-admin-payments-query.dto';
import { ListAdminWebhookDeliveriesQueryDto } from '../webhooks/dto/list-admin-webhook-deliveries-query.dto';
import { ListAdminWebhooksQueryDto } from '../webhooks/dto/list-admin-webhooks-query.dto';
import { ListWebhookDeliveriesQueryDto } from '../webhooks/dto/list-webhook-deliveries-query.dto';
import { MerchantWebhookEndpointsService } from '../webhooks/merchant-webhook-endpoints.service';
import { AdminApiKeyGuard } from './admin-api-key.guard';

@Controller('api/v1/admin')
@UseGuards(AdminApiKeyGuard)
export class AdminOperationsController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly ledger: LedgerService,
    private readonly nachaFiles: NachaFilesService,
    private readonly payments: PaymentsService,
    private readonly webhooks: MerchantWebhookEndpointsService,
  ) {}

  @Get('dashboard')
  getDashboard(@Query('merchantId') merchantId?: string) {
    return this.dashboard.getAdminDashboard(merchantId);
  }

  @Get('ledger')
  getLedger(@Query() query: ListLedgerQueryDto) {
    return this.ledger.listAdmin(query, query.merchantId);
  }

  @Get('nacha-files')
  getNachaFiles(@Query() query: ListNachaFilesQueryDto) {
    return this.nachaFiles.listAdmin(query, query.merchantId);
  }

  @Get('nacha-files/:fileId/download')
  async download(@Param('fileId') fileId: string, @Res() response: Response) {
    const file = await this.nachaFiles.downloadAdmin(fileId);
    response.setHeader('content-type', 'text/plain; charset=utf-8');
    response.setHeader(
      'content-disposition',
      `attachment; filename="${file.fileName}"`,
    );
    response.send(file.contents);
  }

  @Get('payments')
  getPayments(@Query() query: ListAdminPaymentsQueryDto) {
    return this.payments.listAdmin(query);
  }

  @Get('payments/:paymentId')
  getPayment(@Param('paymentId') paymentId: string) {
    return this.payments.detailsAdmin(paymentId);
  }

  @Get('webhooks')
  getWebhooks(@Query() query: ListAdminWebhooksQueryDto) {
    return this.webhooks.listAdmin(query);
  }

  @Get('webhooks/deliveries')
  getWebhookDeliveries(@Query() query: ListAdminWebhookDeliveriesQueryDto) {
    return this.webhooks.listDeliveriesAdmin(query);
  }

  @Get('webhooks/:endpointId/deliveries')
  getEndpointWebhookDeliveries(
    @Param('endpointId') endpointId: string,
    @Query() query: ListWebhookDeliveriesQueryDto,
  ) {
    return this.webhooks.deliveriesAdmin(endpointId, query);
  }
}
