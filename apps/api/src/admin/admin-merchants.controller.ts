import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminApiKeyGuard } from './admin-api-key.guard';
import { AdminMerchantsService } from './admin-merchants.service';
import { CreateMerchantDto } from './dto/create-merchant.dto';
import { UpdateMerchantStatusDto } from './dto/update-merchant-status.dto';
@Controller('api/v1/admin/merchants')
@UseGuards(AdminApiKeyGuard)
export class AdminMerchantsController {
  constructor(private readonly merchants: AdminMerchantsService) {}
  @Get() list() {
    return this.merchants.list();
  }
  @Post() create(@Body() dto: CreateMerchantDto) {
    return this.merchants.create(dto);
  }
  @Get(':merchantId') details(@Param('merchantId') id: string) {
    return this.merchants.details(id);
  }
  @Patch(':merchantId/status') status(
    @Param('merchantId') id: string,
    @Body() dto: UpdateMerchantStatusDto,
  ) {
    return this.merchants.updateStatus(id, dto.status);
  }
  @Post(':merchantId/api-key/rotate') rotate(@Param('merchantId') id: string) {
    return this.merchants.rotate(id);
  }
}
