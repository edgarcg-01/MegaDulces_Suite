import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import {
  ReceivingSessionService,
  OpenSessionDto,
  ScanDto,
  DiscrepancyKind,
} from './receiving-session.service';

/**
 * Fase WMS-REC (Pieza 1 — Modo recepción por escaneo / Vale vivo, ADR-044).
 * Todo el flujo de recepción por escaneo bajo `COMMERCIAL_INVENTORY_RECIBIR`.
 */
@ApiTags('commercial-receiving')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/receiving/sessions')
export class ReceivingSessionController {
  constructor(private readonly service: ReceivingSessionService) {}

  @Post()
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_RECIBIR)
  @ApiOperation({ summary: 'Abrir un Vale de entrada (sesión de recepción): manual o desde orden de entrada del ERP' })
  open(@Body() body: OpenSessionDto) {
    return this.service.open(body);
  }

  @Get()
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_RECIBIR)
  @ApiOperation({ summary: 'Listar sesiones de recepción (filtros: status/warehouse_id/limit)' })
  list(
    @Query('status') status?: string,
    @Query('warehouse_id') warehouseId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.list({ status, warehouse_id: warehouseId, limit: limit ? Number(limit) : undefined });
  }

  @Get(':id')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_RECIBIR)
  @ApiOperation({ summary: 'Detalle de una sesión + líneas + progreso (qué falta validar)' })
  detail(@Param('id') id: string) {
    return this.service.detail(id);
  }

  @Post(':id/scan')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_RECIBIR)
  @ApiOperation({ summary: 'Escanear código de barras/SKU → suma a su línea (o crea sobrante)' })
  scan(@Param('id') id: string, @Body() body: ScanDto) {
    return this.service.scan(id, body);
  }

  @Post(':id/lines/:lineId')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_RECIBIR)
  @ApiOperation({ summary: 'Ajuste manual de una línea (cantidad recibida, discrepancia tipificada, notas)' })
  setLine(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() body: { received_qty?: number; discrepancy_kind?: DiscrepancyKind; notes?: string },
  ) {
    return this.service.setLine(id, lineId, body);
  }

  @Post(':id/add-line')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_RECIBIR)
  @ApiOperation({ summary: 'Agregar una línea esperada manualmente' })
  addLine(@Param('id') id: string, @Body() body: { product_id?: string; barcode?: string; expected_qty?: number }) {
    return this.service.addLine(id, body);
  }

  @Post(':id/close')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_RECIBIR)
  @ApiOperation({ summary: 'Cerrar la sesión (finaliza discrepancias: pending+esperado → faltante)' })
  close(@Param('id') id: string) {
    return this.service.close(id);
  }

  @Post(':id/cancel')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_RECIBIR)
  @ApiOperation({ summary: 'Cancelar la sesión' })
  cancel(@Param('id') id: string) {
    return this.service.cancel(id);
  }
}
