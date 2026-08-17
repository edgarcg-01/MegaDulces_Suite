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
import { InventoryInvestigationService, OpenInvestigationDto } from './inventory-investigation.service';

/**
 * Fase PREV.1 — Expediente de investigación de diferencias (Apéndice B).
 * Ver = COMMERCIAL_PREVENTION_VER · operar = COMMERCIAL_PREVENTION_GESTIONAR
 * (segregación: Prevención NO es quien cuenta/reconcilia).
 */
@ApiTags('commercial-inventory')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/inventory/investigations')
export class InventoryInvestigationController {
  constructor(private readonly service: InventoryInvestigationService) {}

  @Post()
  @RequirePermissions(Permission.COMMERCIAL_PREVENTION_GESTIONAR)
  @ApiOperation({ summary: 'Abrir un expediente de investigación manual sobre una diferencia' })
  open(@Body() body: OpenInvestigationDto) {
    return this.service.open(body);
  }

  @Post('from-count')
  @RequirePermissions(Permission.COMMERCIAL_PREVENTION_GESTIONAR)
  @ApiOperation({ summary: 'Generar expedientes desde un folio de conteo (1 por item con varianza, idempotente)' })
  fromCount(@Body() body: { count: string }) {
    return this.service.fromCount(body?.count);
  }

  @Get()
  @RequirePermissions(Permission.COMMERCIAL_PREVENTION_VER)
  @ApiOperation({ summary: 'Bandeja de expedientes (filtros: status/warehouse_id/product_id)' })
  list(
    @Query('status') status?: string,
    @Query('warehouse_id') warehouseId?: string,
    @Query('product_id') productId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.list({ status, warehouse_id: warehouseId, product_id: productId, limit: limit ? Number(limit) : undefined });
  }

  @Get('timeline')
  @RequirePermissions(Permission.COMMERCIAL_PREVENTION_VER)
  @ApiOperation({ summary: 'Línea de tiempo del SKU (app + ERP) — ?warehouse_id=&product_id=' })
  timeline(@Query('warehouse_id') warehouseId: string, @Query('product_id') productId: string) {
    return this.service.skuTimeline(warehouseId, productId);
  }

  @Get(':id')
  @RequirePermissions(Permission.COMMERCIAL_PREVENTION_VER)
  @ApiOperation({ summary: 'Detalle del expediente + línea de tiempo del SKU' })
  detail(@Param('id') id: string) {
    return this.service.detail(id);
  }

  @Post(':id/classify')
  @RequirePermissions(Permission.COMMERCIAL_PREVENTION_GESTIONAR)
  @ApiOperation({ summary: 'Clasificar la causa raíz (EC/ER/EA/DC/DP/TR/UB/MR/PNI)' })
  classify(@Param('id') id: string, @Body() body: { root_cause: string; notes?: string }) {
    return this.service.classify(id, body?.root_cause, body?.notes);
  }

  @Post(':id/resolve')
  @RequirePermissions(Permission.COMMERCIAL_PREVENTION_GESTIONAR)
  @ApiOperation({ summary: 'Cerrar el expediente con causa + notas (+ ligar ajuste)' })
  resolve(@Param('id') id: string, @Body() body: { root_cause?: string; resolution_notes?: string; adjustment_movement_id?: string }) {
    return this.service.resolve(id, body || {});
  }

  @Post(':id/monitoring')
  @RequirePermissions(Permission.COMMERCIAL_PREVENTION_GESTIONAR)
  @ApiOperation({ summary: 'Pérdida no identificada → monitoreo intensivo (PREV.2)' })
  toMonitoring(@Param('id') id: string) {
    return this.service.toMonitoring(id);
  }
}
