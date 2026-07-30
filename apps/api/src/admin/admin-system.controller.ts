import { Controller, Get, UseGuards } from '@nestjs/common';
import { AdminApiKeyGuard } from './admin-api-key.guard';
import { AdminSystemService } from './admin-system.service';

@Controller('api/v1/admin/system')
@UseGuards(AdminApiKeyGuard)
export class AdminSystemController {
  constructor(private readonly system: AdminSystemService) {}

  @Get('status')
  getStatus() {
    return this.system.getStatus();
  }
}
