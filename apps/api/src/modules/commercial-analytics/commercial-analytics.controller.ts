import { Controller, Get, Post, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { CommercialAnalyticsService } from './commercial-analytics.service';
import { AnalyticsRefreshService } from './analytics-refresh.service';

@ApiTags('commercial-analytics')
@Controller('commercial/analytics')
export class CommercialAnalyticsController {
  constructor(
    private readonly service: CommercialAnalyticsService,
    private readonly refresh: AnalyticsRefreshService,
  ) {}

  @Get('overview')
  @ApiOperation({
    summary:
      'KPIs rolling 30d (MV por default). Con from/to o ?live=true → on-the-fly.',
  })
  overview(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('live') live?: string,
  ) {
    return this.service.overview({ from, to, live: live === 'true' });
  }

  @Get('top-customers')
  @ApiOperation({ summary: 'Top N customers por revenue (MV rolling 30d o live)' })
  topCustomers(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('live') live?: string,
  ) {
    return this.service.topCustomers({
      from,
      to,
      limit: limit ? Number(limit) : undefined,
      live: live === 'true',
    });
  }

  @Get('top-products')
  @ApiOperation({ summary: 'Top N productos (MV rolling 30d o live, orderBy=units|revenue)' })
  topProducts(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('orderBy') orderBy?: 'units' | 'revenue',
    @Query('live') live?: string,
  ) {
    return this.service.topProducts({
      from,
      to,
      limit: limit ? Number(limit) : undefined,
      orderBy,
      live: live === 'true',
    });
  }

  @Post('refresh')
  @ApiOperation({
    summary:
      'Disparar refresh manual de las MVs en `analytics.*` (admin only — sin guard formal aún)',
  })
  refreshMvs() {
    return this.refresh.refreshAll('manual');
  }

  @Get('inactive-customers')
  @ApiOperation({
    summary:
      'Customers activos sin pedidos en los últimos N días (oportunidad de recuperación)',
  })
  inactiveCustomers(@Query('days') days?: string, @Query('limit') limit?: string) {
    return this.service.inactiveCustomers(days, limit);
  }

  @Get('sales-by-brand')
  @ApiOperation({ summary: 'Revenue + units por brand en el período + share %' })
  salesByBrand(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.salesByBrand({ from, to });
  }

  @Get('low-stock')
  @ApiOperation({
    summary: 'Productos con stock disponible (quantity - reserved) bajo threshold',
  })
  lowStock(
    @Query('threshold') threshold?: string,
    @Query('warehouse_id') warehouseId?: string,
  ) {
    return this.service.lowStock(threshold, warehouseId);
  }

  @Get('daily-series')
  @ApiOperation({ summary: 'Series diarias de revenue + orders count (TZ MX)' })
  dailySeries(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.dailySeries({ from, to });
  }
}
