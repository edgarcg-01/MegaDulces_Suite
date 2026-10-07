import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import {
  Permission,
  RequireAnyPermission,
  RequirePermissions,
} from '@megadulces/platform-core';
import {
  LogisticsChecklistsService,
  CreateChecklistDto,
  CompleteChecklistDto,
  ChecklistType,
} from './logistics-checklists.service';

/**
 * `[AUTHZ.5]` — Controller sin autorización hasta acá (ver `logistics-fleet.controller`).
 *
 * El checklist es del embarque, así que se gatea con el permiso del embarque. Llenarlo es trabajo de
 * ruta: mismo OR con `REPARTO_ENTREGAR` que las transiciones de `logistics-shipments`, y por el
 * mismo motivo medido.
 */
@ApiTags('logistics-checklists')
@Controller('logistics/checklists')
export class LogisticsChecklistsController {
  constructor(private readonly service: LogisticsChecklistsService) {}

  @Get('template/:type')
  @RequirePermissions(Permission.LOGISTICS_SHIPMENTS_VER)
  @ApiOperation({ summary: 'Template default de checklist (salida|llegada)' })
  template(@Param('type') type: ChecklistType) {
    return this.service.getTemplate(type);
  }

  @Post()
  @RequireAnyPermission(Permission.LOGISTICS_SHIPMENTS_GESTIONAR, Permission.REPARTO_ENTREGAR)
  @ApiOperation({ summary: 'Crear checklist (pendiente) para shipment' })
  create(@Body() body: CreateChecklistDto) {
    return this.service.create(body);
  }

  @Get('shipment/:shipmentId')
  @RequirePermissions(Permission.LOGISTICS_SHIPMENTS_VER)
  @ApiOperation({ summary: 'Listar checklists de un shipment' })
  listByShipment(@Param('shipmentId') shipmentId: string) {
    return this.service.findByShipment(shipmentId);
  }

  @Get(':id')
  @RequirePermissions(Permission.LOGISTICS_SHIPMENTS_VER)
  @ApiOperation({ summary: 'Obtener checklist por id' })
  findOne(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Post(':id/complete')
  @RequireAnyPermission(Permission.LOGISTICS_SHIPMENTS_GESTIONAR, Permission.REPARTO_ENTREGAR)
  @ApiOperation({ summary: 'Completar checklist (respuestas requeridas)' })
  complete(@Param('id') id: string, @Body() body: CompleteChecklistDto) {
    return this.service.complete(id, body);
  }
}
