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
import { Permission, RequireAnyPermission, RequirePermissions } from '@megadulces/platform-core';
import {
  LogisticsGuidesService,
  CreateGuideDto,
  UpdateGuideDto,
  CreateRecipientDto,
  MarkDeliveredDto,
} from './logistics-guides.service';
import type {
  CompletarGuiaBody, GuiaCompletada, GuiaReabierta, MismoViajeBody, MismoViajeGuardado, ReabrirGuiaBody, TripulacionGuardada, TripulacionGuiaBody,
} from '@megadulces/contracts';

/**
 * `[AUTHZ.5]` — Controller sin autorización hasta acá (ver `logistics-fleet.controller`). La guía
 * lleva el POD del cliente: quién recibió, la foto y el GPS.
 *
 * Acá **no hace falta el OR con reparto**: los 2 `repartidor` de prod ya tienen
 * `LOGISTICS_GUIDES_GESTIONAR`, que es justo lo que necesitan para marcar entregado.
 */
@ApiTags('logistics-guides')
@Controller('logistics/guides')
export class LogisticsGuidesController {
  constructor(private readonly service: LogisticsGuidesService) {}

  @Post()
  @RequirePermissions(Permission.LOGISTICS_GUIDES_GESTIONAR)
  @ApiOperation({ summary: 'Crear guía (autocálculo de comisiones opcional)' })
  create(@Body() body: CreateGuideDto) {
    return this.service.create(body);
  }

  @Get()
  @RequirePermissions(Permission.LOGISTICS_GUIDES_VER)
  @ApiOperation({ summary: 'Listar guías (filtra por shipment_id opcional)' })
  list(@Query('shipment_id') shipmentId?: string) {
    return this.service.list(shipmentId);
  }

  @Get(':id')
  @RequirePermissions(Permission.LOGISTICS_GUIDES_VER)
  @ApiOperation({ summary: 'Obtener guía por id (incluye recipients)' })
  findOne(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Post(':id/complete')
  // [EMB.43] También la completa Logística › Pagos de viaje, desde su bandeja, con su permiso propio.
  @RequireAnyPermission(Permission.LOGISTICS_GUIDES_GESTIONAR, Permission.LOGISTICS_PAGOS_GESTIONAR)
  @ApiOperation({ summary: 'EMB.22: completar UNA vez la guía de un viaje de Kepler (tripulación y horario); calcula comisión y viáticos' })
  complete(@Param('id') id: string, @Body() body: CompletarGuiaBody): Promise<GuiaCompletada> {
    return this.service.complete(id, body);
  }

  @Post(':id/tripulacion')
  // [CML.HV] Al salir: la tripulación sola, sin horario. Mismo permiso que completar.
  @RequireAnyPermission(Permission.LOGISTICS_GUIDES_GESTIONAR, Permission.LOGISTICS_PAGOS_GESTIONAR)
  @ApiOperation({ summary: 'CML.HV: guardar la tripulación al salir (sin horario); no calcula nada y se corrige hasta capturar el horario' })
  guardarTripulacion(@Param('id') id: string, @Body() body: TripulacionGuiaBody): Promise<TripulacionGuardada> {
    return this.service.guardarTripulacion(id, body);
  }

  @Post(':id/mismo-viaje')
  // [CML.J] D17 A: confirmar (o deshacer) que es el mismo viaje físico que otra guía; se paga una vez.
  @RequireAnyPermission(Permission.LOGISTICS_GUIDES_GESTIONAR, Permission.LOGISTICS_PAGOS_GESTIONAR)
  @ApiOperation({ summary: 'CML.J: confirmar que la guía es el mismo viaje que otra de Kepler (misma unidad); el reporte lo paga una vez' })
  confirmarMismoViaje(@Param('id') id: string, @Body() body: MismoViajeBody): Promise<MismoViajeGuardado> {
    return this.service.confirmarMismoViaje(id, body);
  }

  @Post(':id/reabrir')
  // [CML.K] Reabrir un viaje cerrado: borra horario y montos, con motivo. Sólo quien gestiona los pagos.
  @RequirePermissions(Permission.LOGISTICS_PAGOS_GESTIONAR)
  @ApiOperation({ summary: 'CML.K: reabrir un viaje cerrado (borra horario y montos calculados), con motivo obligatorio' })
  reabrir(@Param('id') id: string, @Body() body: ReabrirGuiaBody): Promise<GuiaReabierta> {
    return this.service.reabrir(id, body);
  }

  @Patch(':id')
  @RequirePermissions(Permission.LOGISTICS_GUIDES_GESTIONAR)
  @ApiOperation({ summary: 'Actualizar guía (status transitions enforced)' })
  update(@Param('id') id: string, @Body() body: UpdateGuideDto) {
    return this.service.update(id, body);
  }

  @Delete(':id')
  @RequirePermissions(Permission.LOGISTICS_GUIDES_GESTIONAR)
  @ApiOperation({ summary: 'Soft-delete (solo si cancelada)' })
  remove(@Param('id') id: string) {
    return this.service.softDelete(id);
  }

  // ── Recipients ─────────────────────────────────────────────────────────

  @Post(':id/recipients')
  @RequirePermissions(Permission.LOGISTICS_GUIDES_GESTIONAR)
  @ApiOperation({ summary: 'Agregar destinatario a la guía' })
  addRecipient(@Param('id') guideId: string, @Body() body: CreateRecipientDto) {
    return this.service.addRecipient(guideId, body);
  }

  @Post('recipients/:recipientId/deliver')
  @RequirePermissions(Permission.LOGISTICS_GUIDES_GESTIONAR)
  @ApiOperation({ summary: 'Marcar destinatario como entregado (foto + GPS opcional)' })
  markDelivered(@Param('recipientId') id: string, @Body() body: MarkDeliveredDto) {
    return this.service.markRecipientDelivered(id, body);
  }

  @Delete('recipients/:recipientId')
  @RequirePermissions(Permission.LOGISTICS_GUIDES_GESTIONAR)
  @ApiOperation({ summary: 'Eliminar recipient (solo si pendiente)' })
  removeRecipient(@Param('recipientId') id: string) {
    return this.service.removeRecipient(id);
  }
}
