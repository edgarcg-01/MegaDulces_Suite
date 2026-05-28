import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import {
  LogisticsShipmentsService,
  CreateShipmentDto,
  UpdateShipmentDto,
  ShipmentStatus,
} from './logistics-shipments.service';

@ApiTags('logistics-shipments')
@Controller('logistics/shipments')
export class LogisticsShipmentsController {
  constructor(private readonly service: LogisticsShipmentsService) {}

  @Post()
  @ApiOperation({ summary: 'Crear shipment (status=programado)' })
  create(@Body() body: CreateShipmentDto) {
    return this.service.create(body);
  }

  @Get()
  @ApiOperation({ summary: 'Listar shipments con paginación + filtros' })
  list(
    @Query('status') status?: ShipmentStatus,
    @Query('vehicle_id') vehicle_id?: string,
    @Query('driver_id') driver_id?: string,
    @Query('order_id') order_id?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.list({
      status,
      vehicle_id,
      driver_id,
      order_id,
      from,
      to,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get('pending-orders')
  @ApiOperation({
    summary: 'J.7.1: pedidos confirmed sin shipment activo (bandeja de entrada de logística)',
  })
  pendingOrders() {
    return this.service.pendingOrders();
  }

  @Get('my-driver')
  @ApiOperation({
    summary: 'J.9.7: shipments del chofer logueado (lookup logistics.drivers.user_id = JWT user_id)',
  })
  myDriverShipments(
    @Query('status') status?: ShipmentStatus,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.myDriverShipments({ status, from, to });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener shipment por id' })
  findOne(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar shipment (no permitido si cerrado/cancelado)' })
  update(@Param('id') id: string, @Body() body: UpdateShipmentDto) {
    return this.service.update(id, body);
  }

  @Post(':id/start-salida-checklist')
  @ApiOperation({ summary: 'J.8.3: programado → checklist_salida (opcional, flujo formal)' })
  startSalidaChecklist(@Param('id') id: string) {
    return this.service.startSalidaChecklist(id);
  }

  @Post(':id/depart')
  @ApiOperation({ summary: 'Transición: programado|checklist_salida → en_ruta' })
  depart(@Param('id') id: string) {
    return this.service.depart(id);
  }

  @Post(':id/deliver')
  @ApiOperation({ summary: 'Transición: en_ruta → entregado' })
  deliver(@Param('id') id: string) {
    return this.service.deliver(id);
  }

  @Post(':id/start-llegada-checklist')
  @ApiOperation({ summary: 'J.8.3: entregado → checklist_llegada (opcional, flujo formal)' })
  startLlegadaChecklist(@Param('id') id: string) {
    return this.service.startLlegadaChecklist(id);
  }

  @Post(':id/mark-costs-pending')
  @ApiOperation({ summary: 'J.8.3: checklist_llegada → costos_pendientes' })
  markCostsPending(@Param('id') id: string) {
    return this.service.markCostsPending(id);
  }

  @Post(':id/close')
  @ApiOperation({ summary: 'Transición: (entregado|checklist_llegada|costos_pendientes) → cerrado (libera vehicle, marca order=fulfilled si aplica)' })
  close(@Param('id') id: string) {
    return this.service.close(id);
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Cancelar shipment (desde programado o en_ruta)' })
  cancel(@Param('id') id: string, @Body() body: { reason?: string }) {
    return this.service.cancel(id, body?.reason);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete (solo si cancelado o cerrado)' })
  remove(@Param('id') id: string) {
    return this.service.softDelete(id);
  }
}
