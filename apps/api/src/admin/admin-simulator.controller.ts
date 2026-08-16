import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AdminApiKeyGuard } from './admin-api-key.guard';
import { AdminSimulatorService } from './admin-simulator.service';
import { CreateSimulatorRunDto } from './dto/create-simulator-run.dto';
import { ProvisionSimulatorFundingDto } from './dto/provision-simulator-funding.dto';

@Controller('api/v1/admin/simulator')
@UseGuards(AdminApiKeyGuard)
export class AdminSimulatorController {
  constructor(private readonly simulator: AdminSimulatorService) {}

  @Get('runs')
  list() {
    return this.simulator.listRuns();
  }

  @Get('runs/:runId')
  get(@Param('runId') runId: string) {
    return this.simulator.getRun(runId);
  }

  @Post('runs')
  create(@Body() dto: CreateSimulatorRunDto) {
    return this.simulator.createRun(dto);
  }

  @Post('runs/:runId/pause')
  pause(@Param('runId') runId: string) {
    return this.simulator.pause(runId);
  }

  @Post('runs/:runId/resume')
  resume(@Param('runId') runId: string) {
    return this.simulator.resume(runId);
  }

  @Post('runs/:runId/stop')
  stop(@Param('runId') runId: string) {
    return this.simulator.stop(runId);
  }

  @Post('merchants/:merchantId/demo-funding')
  provisionFunding(
    @Param('merchantId') merchantId: string,
    @Body() dto: ProvisionSimulatorFundingDto,
  ) {
    return this.simulator.provisionDemoFunding(merchantId, dto);
  }
}
