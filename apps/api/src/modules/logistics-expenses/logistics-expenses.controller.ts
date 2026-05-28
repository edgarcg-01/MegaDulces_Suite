import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import {
  LogisticsExpensesService,
  UpsertExpenseDto,
} from './logistics-expenses.service';

@ApiTags('logistics-expenses')
@Controller('logistics/expenses')
export class LogisticsExpensesController {
  constructor(private readonly service: LogisticsExpensesService) {}

  @Put('shipments/:shipmentId')
  @ApiOperation({ summary: 'Upsert expense (1:1 con shipment). Recalcula totales.' })
  upsert(@Param('shipmentId') shipmentId: string, @Body() body: UpsertExpenseDto) {
    return this.service.upsert(shipmentId, body);
  }

  @Get('shipments/:shipmentId')
  @ApiOperation({ summary: 'Leer expense del shipment' })
  find(@Param('shipmentId') shipmentId: string) {
    return this.service.findByShipment(shipmentId);
  }

  @Get('summary')
  @ApiOperation({ summary: 'Resumen agregado por rango (suma por categoría + total)' })
  summary(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.summary(from, to);
  }

  @Get()
  @ApiOperation({ summary: 'J.9.4: Lista todos los expenses con info del shipment (para página Costs)' })
  list(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.findAll({ from, to, limit: limit ? Number(limit) : undefined });
  }
}
