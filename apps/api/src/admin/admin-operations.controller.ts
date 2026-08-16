import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { DashboardService } from '../dashboard/dashboard.service';
import { ListLedgerQueryDto } from '../ledger/dto/list-ledger-query.dto';
import { LedgerService } from '../ledger/ledger.service';
import { ListNachaFilesQueryDto } from '../nacha-files/dto/list-nacha-files-query.dto';
import { NachaFilesService } from '../nacha-files/nacha-files.service';
import { AdminApiKeyGuard } from './admin-api-key.guard';

@Controller('api/v1/admin')
@UseGuards(AdminApiKeyGuard)
export class AdminOperationsController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly ledger: LedgerService,
    private readonly nachaFiles: NachaFilesService,
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
}
