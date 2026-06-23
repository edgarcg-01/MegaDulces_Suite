import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { LogisticsAnalyticsService } from './logistics-analytics.service';

@ApiTags('logistics-analytics')
@Controller('logistics/analytics')
export class LogisticsAnalyticsController {
  constructor(private readonly service: LogisticsAnalyticsService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Overview: shipments, revenue, cost, margin, km, cost/km del rango' })
  overview(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.overview({ from, to });
  }

  @Get('kpi-cards')
  @ApiOperation({ summary: 'J14: KPIs del dashboard con value + delta% (vs período previo) + serie diaria para micro-gráficas' })
  kpiCards(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.kpiCards({ from, to });
  }

  @Get('shipment-profitability')
  @ApiOperation({ summary: 'Lista embarques realizados con rentabilidad individual (top N por margen)' })
  profitability(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('vehicle_id') vehicle_id?: string,
    @Query('route_id') route_id?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.shipmentProfitability({
      from, to, vehicle_id, route_id,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('fleet-utilization')
  @ApiOperation({ summary: 'Uso por vehículo: count, km, revenue, cost, margen en el rango' })
  fleet(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.fleetUtilization({ from, to });
  }

  @Get('pending-by-route')
  @ApiOperation({
    summary:
      'Pipeline: pedidos confirmed/pending_approval sin shipment activo, agrupados por ruta. Cola "lista para embarcar".',
  })
  pendingByRoute() {
    return this.service.pendingByRoute();
  }

  @Get('payroll-totals')
  @ApiOperation({ summary: 'Totales liquidados por período (commissions, per_diem, load/unload, bonuses, neto, pagado)' })
  payroll(@Query('year') year?: string) {
    return this.service.payrollTotals(year ? Number(year) : undefined);
  }

  @Get('roi')
  @ApiOperation({ summary: 'J12.7: historia de costo/ROI — flete, costo/km, combustible, mantenimiento, margen' })
  roi(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.roiSummary({ from, to });
  }
}
