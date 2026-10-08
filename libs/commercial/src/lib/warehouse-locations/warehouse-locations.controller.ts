import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireAuthGuard, RolesGuard, RequirePermissions, RequireAnyPermission, Permission } from '@megadulces/platform-core';
import type {
  BulkLocationsBody,
  BulkLocationsPreview,
  BulkLocationsResult,
  CreateWarehouseLocationBody,
  LocationCaptureBatch,
  UndoLocationBatchResult,
  WarehouseLocationRow,
  WarehouseLocationsResponse,
} from '@megadulces/contracts';
import { WarehouseLocationsService } from './warehouse-locations.service';
import { WarehouseLocationsBulkService } from './warehouse-locations-bulk.service';

/**
 * `[UB.1]` Catálogo de ubicaciones (Fase UB, ADR-090) — pantalla `/almacen/ubicaciones`.
 *
 * Permisos PROPIOS (`ALMACEN_UBICACIONES_*`, repartidos por la migración 20261008011555), no los
 * de inventario: ver el comentario en `permissions.ts`. Los endpoints de WMS-REC
 * (`/commercial/inventory/bins`, put-away, move-lot) siguen con sus permisos de siempre para no
 * romperle el Andén a nadie; se migran cuando el acomodo pase a este módulo (`[UB.5]`).
 */
@ApiTags('warehouse-locations')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('warehouse/locations')
export class WarehouseLocationsController {
  constructor(
    private readonly svc: WarehouseLocationsService,
    private readonly bulk: WarehouseLocationsBulkService,
  ) {}

  // Leer el catálogo es parte de acomodar y de gestionar: quien tiene cualquiera de las tres lo lee.
  @Get()
  @RequireAnyPermission(Permission.ALMACEN_UBICACIONES_VER, Permission.ALMACEN_UBICACIONES_ACOMODAR, Permission.ALMACEN_UBICACIONES_GESTIONAR)
  @ApiOperation({ summary: 'Ubicaciones de un almacén (?warehouse_id=, default el primero visible) + resumen y alcance.' })
  list(@Query('warehouse_id') warehouseId?: string): Promise<WarehouseLocationsResponse> {
    return this.svc.list(warehouseId);
  }

  @Post()
  @RequirePermissions(Permission.ALMACEN_UBICACIONES_GESTIONAR)
  @ApiOperation({ summary: 'Dar de alta UNA ubicación con el código [T|B][pasillo][rack 01-99][nivel 1-6].' })
  create(@Body() body: CreateWarehouseLocationBody): Promise<WarehouseLocationRow> {
    return this.svc.create(body);
  }

  // ── `[UB.2]` Captura masiva. Todo GESTIONAR: es catálogo, no piso. ──────────────────────────

  // Vista previa: no escribe nada, pero sólo la pide quien puede aplicar (no tiene sentido
  // revisar un rango que no vas a poder crear).
  @Post('bulk/preview')
  @RequirePermissions(Permission.ALMACEN_UBICACIONES_GESTIONAR)
  @ApiOperation({ summary: 'Vista previa de una captura masiva (rango o renglones de archivo): qué se crea, qué ya existe, qué trae error.' })
  bulkPreview(@Body() body: BulkLocationsBody): Promise<BulkLocationsPreview> {
    return this.bulk.preview(body);
  }

  @Post('bulk')
  @RequirePermissions(Permission.ALMACEN_UBICACIONES_GESTIONAR)
  @ApiOperation({ summary: 'Aplicar una captura masiva: crea las nuevas como UN lote que se puede deshacer.' })
  bulkApply(@Body() body: BulkLocationsBody): Promise<BulkLocationsResult> {
    return this.bulk.apply(body);
  }

  @Get('batches')
  @RequirePermissions(Permission.ALMACEN_UBICACIONES_GESTIONAR)
  @ApiOperation({ summary: 'Últimos 20 lotes de captura del almacén, con cuántas de sus ubicaciones ya se usan.' })
  batches(@Query('warehouse_id') warehouseId: string): Promise<LocationCaptureBatch[]> {
    return this.bulk.batches(warehouseId);
  }

  @Post('batches/:id/undo')
  @RequirePermissions(Permission.ALMACEN_UBICACIONES_GESTIONAR)
  @ApiOperation({ summary: 'Deshacer un lote: retira sus ubicaciones si ninguna tiene mercancía todavía.' })
  undo(@Param('id') id: string): Promise<UndoLocationBatchResult> {
    return this.bulk.undo(id);
  }
}
