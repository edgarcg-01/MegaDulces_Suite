import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Permission, RequirePermissions } from '@megadulces/platform-core';
import {
  LogisticsExpensesService,
  UpsertExpenseDto,
} from './logistics-expenses.service';

/**
 * `[AUTHZ.5]` — Controller sin autorización hasta acá (ver `logistics-fleet.controller`). Son los
 * costos del viaje: casetas, combustible, viáticos.
 */
@ApiTags('logistics-expenses')
@Controller('logistics/expenses')
export class LogisticsExpensesController {
  constructor(private readonly service: LogisticsExpensesService) {}

  @Put('shipments/:shipmentId')
  @RequirePermissions(Permission.LOGISTICS_EXPENSES_GESTIONAR)
  @ApiOperation({ summary: 'Upsert expense (1:1 con shipment). Recalcula totales.' })
  upsert(@Param('shipmentId') shipmentId: string, @Body() body: UpsertExpenseDto) {
    return this.service.upsert(shipmentId, body);
  }

  @Get('shipments/:shipmentId')
  @RequirePermissions(Permission.LOGISTICS_EXPENSES_VER)
  @ApiOperation({ summary: 'Leer expense del shipment' })
  find(@Param('shipmentId') shipmentId: string) {
    return this.service.findByShipment(shipmentId);
  }

  @Get('summary')
  @RequirePermissions(Permission.LOGISTICS_EXPENSES_VER)
  @ApiOperation({ summary: 'Resumen agregado por rango (suma por categoría + total)' })
  summary(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.summary(from, to);
  }

  @Get()
  @RequirePermissions(Permission.LOGISTICS_EXPENSES_VER)
  @ApiOperation({ summary: 'J.9.4: Lista todos los expenses con info del shipment (para página Costs)' })
  list(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.findAll({ from, to, limit: limit ? Number(limit) : undefined });
  }
}
