import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentMerchant } from '../auth/current-merchant.decorator';
import type { AuthenticatedMerchant } from '../auth/merchant-authentication.service';
import { MerchantApiKeyGuard } from '../auth/merchant-api-key.guard';
import { PaymentRateLimitGuard } from '../rate-limit/payment-rate-limit.guard';
import { ListNachaFilesQueryDto } from './dto/list-nacha-files-query.dto';
import { NachaFilesService } from './nacha-files.service';

@Controller('api/v1/nacha-files')
@UseGuards(MerchantApiKeyGuard, PaymentRateLimitGuard)
export class NachaFilesController {
  constructor(private readonly nachaFilesService: NachaFilesService) {}

  @Get()
  list(
    @Query() query: ListNachaFilesQueryDto,
    @CurrentMerchant() merchant: AuthenticatedMerchant,
  ) {
    return this.nachaFilesService.list(query, merchant);
  }

  @Get(':fileId/download')
  async download(
    @Param('fileId') fileId: string,
    @CurrentMerchant() merchant: AuthenticatedMerchant,
    @Res() response: Response,
  ) {
    const file = await this.nachaFilesService.download(fileId, merchant);
    response
      .status(200)
      .setHeader('Content-Type', 'text/plain; charset=utf-8')
      .setHeader(
        'Content-Disposition',
        `attachment; filename="${file.fileName}"`,
      )
      .send(file.contents);
  }
}
