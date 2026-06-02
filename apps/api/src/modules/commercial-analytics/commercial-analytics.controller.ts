import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CommercialAnalyticsService } from './commercial-analytics.service';
import { AnalyticsRefreshService } from './analytics-refresh.service';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { RequirePermissions } from '../../shared/decorators/permissions.decorator';
import { Permission } from '../../shared/constants/permissions';

@ApiTags('commercial-analytics')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/analytics')
export class CommercialAnalyticsController {
  constructor(
    private readonly service: CommercialAnalyticsService,
    private readonly refresh: AnalyticsRefreshService,
  ) {}

  @Get('overview')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
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
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
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
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
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
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_FULFILL)
  @Throttle({ short: { limit: 3, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Disparar refresh manual de las MVs en `analytics.*`. Gate: COMMERCIAL_ORDERS_FULFILL (admin-only). 3 req/min anti-DoS porque REFRESH MATERIALIZED VIEW es operación cara.',
  })
  refreshMvs() {
    return this.refresh.refreshAll('manual');
  }

  @Get('inactive-customers')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({
    summary:
      'Customers activos sin pedidos en los últimos N días (oportunidad de recuperación)',
  })
  inactiveCustomers(@Query('days') days?: string, @Query('limit') limit?: string) {
    return this.service.inactiveCustomers(days, limit);
  }

  @Get('sales-by-brand')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({ summary: 'Revenue + units por brand en el período + share %' })
  salesByBrand(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.salesByBrand({ from, to });
  }

  @Get('low-stock')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({
    summary:
      'Productos con stock disponible (quantity - reserved) bajo threshold. Gate ORDERS_VER (no INVENTORY_VER) porque el command-center necesita alertas para todos los roles comerciales sin requerir CRUD de inventario.',
  })
  lowStock(
    @Query('threshold') threshold?: string,
    @Query('warehouse_id') warehouseId?: string,
  ) {
    return this.service.lowStock(threshold, warehouseId);
  }

  @Get('daily-series')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({ summary: 'Series diarias de revenue + orders count (TZ MX)' })
  dailySeries(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.dailySeries({ from, to });
  }

  // ─────────── Sprint M.3 — Ventas históricas (ERP Mega_Dulces vía FDW) ───────────

  @Get('historical/daily')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({
    summary:
      'Series diarias de ventas REALES del ERP (Mega_Dulces.ventas vía FDW). Read-only, no se mezcla con commercial.orders. Soporta filtro ?zona=La Piedad.',
  })
  historicalDaily(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('zona') zona?: string,
  ) {
    return this.service.historicalSalesDaily({ from, to, zona });
  }

  @Get('historical/top-products')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({
    summary: 'Top N productos del ERP por revenue (FDW). Filtros: from/to/zona/limit',
  })
  historicalTopProducts(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('zona') zona?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.historicalTopProducts({
      from,
      to,
      zona,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('historical/by-zona')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({
    summary:
      'Ventas del ERP por zona/sucursal en el período: tickets, customers únicos, units, revenue',
  })
  historicalByZona(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.historicalSalesByZona({ from, to });
  }
}
