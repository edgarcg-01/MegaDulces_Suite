import { Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { RecommendationsService } from './recommendations.service';
import { RecommendationsRefreshService } from './recommendations-refresh.service';

@ApiTags('commercial-recommendations')
@Controller('commercial/recommendations')
export class RecommendationsController {
  constructor(
    private readonly recommendations: RecommendationsService,
    private readonly refresh: RecommendationsRefreshService,
  ) {}

  @Get('my')
  @ApiOperation({
    summary:
      'Canasta estratégica del customer del JWT (Portal B2B). Recomputa si stale (>24h).',
  })
  my() {
    return this.recommendations.getForMyCustomer();
  }

  @Get(':customer_id')
  @ApiOperation({
    summary:
      'Canasta estratégica de un customer específico (admin). Recomputa si stale.',
  })
  getForCustomer(@Param('customer_id') customerId: string) {
    return this.recommendations.getForCustomer(customerId);
  }

  @Post(':customer_id/compute')
  @ApiOperation({
    summary: 'Forzar recómputo (UPSERT) de la canasta de un customer',
  })
  compute(@Param('customer_id') customerId: string) {
    return this.recommendations.computeForCustomer(customerId);
  }

  @Post('refresh-all')
  @ApiOperation({
    summary:
      'Trigger manual del cron nightly: refresca canasta de TODOS los customers (admin only)',
  })
  refreshAll() {
    return this.refresh.refreshAllTenants();
  }
}
