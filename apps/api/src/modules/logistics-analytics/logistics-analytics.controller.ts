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

  @Get('payroll-totals')
  @ApiOperation({ summary: 'Totales liquidados por período (commissions, per_diem, load/unload, bonuses, neto, pagado)' })
  payroll(@Query('year') year?: string) {
    return this.service.payrollTotals(year ? Number(year) : undefined);
  }
}
