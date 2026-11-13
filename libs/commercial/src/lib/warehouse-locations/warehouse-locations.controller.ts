import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireAuthGuard, RolesGuard, RequirePermissions, RequireAnyPermission, Permission } from '@megadulces/platform-core';
import type {
  BulkAssignmentsBody,
  BulkAssignmentsPreview,
  BulkAssignmentsResult,
  CreateAssignmentBody,
  ProductAssignment,
  ProductLocationDetail,
  ProductLocationFilter,
  ProductLocationsList,
  UpdateAssignmentBody,
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
import { WarehouseLocationsAssignService } from './warehouse-locations-assign.service';

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
    private readonly assign: WarehouseLocationsAssignService,
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

  // ── `[UB.3]` Asignación por producto y presentación ─────────────────────────────────────────
  // Leer: cualquiera de las tres (quien acomoda necesita saber dónde va cada cosa).
  // Asignar, cambiar y quitar: GESTIONAR (es catálogo, no piso).

  @Get('products')
  @RequireAnyPermission(Permission.ALMACEN_UBICACIONES_VER, Permission.ALMACEN_UBICACIONES_ACOMODAR, Permission.ALMACEN_UBICACIONES_GESTIONAR)
  @ApiOperation({ summary: 'Productos con ficha Kepler en el almacén, con su lugar fijo (?warehouse_id=&q=&filtro=todos|sin_ubicacion|con_ubicacion&limit=&offset=).' })
  products(
    @Query('warehouse_id') warehouseId: string,
    @Query('q') q?: string,
    @Query('filtro') filtro?: ProductLocationFilter,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<ProductLocationsList> {
    const f: ProductLocationFilter = filtro === 'sin_ubicacion' || filtro === 'con_ubicacion' ? filtro : 'todos';
    return this.assign.products(warehouseId, q, f, Number(limit), Number(offset));
  }

  @Get('products/:productId')
  @RequireAnyPermission(Permission.ALMACEN_UBICACIONES_VER, Permission.ALMACEN_UBICACIONES_ACOMODAR, Permission.ALMACEN_UBICACIONES_GESTIONAR)
  @ApiOperation({ summary: 'Un producto en el almacén: sus presentaciones de Kepler (con factor y códigos) y sus asignaciones.' })
  productDetail(@Param('productId') productId: string, @Query('warehouse_id') warehouseId: string): Promise<ProductLocationDetail> {
    return this.assign.detail(warehouseId, productId);
  }

  // Va ANTES de 'assignments/:id' para que Nest no lea «bulk» como un id.
  @Post('assignments/bulk/preview')
  @RequirePermissions(Permission.ALMACEN_UBICACIONES_GESTIONAR)
  @ApiOperation({ summary: 'Vista previa de un Excel producto → presentación → ubicación → papel.' })
  assignmentsBulkPreview(@Body() body: BulkAssignmentsBody): Promise<BulkAssignmentsPreview> {
    return this.assign.bulkPreview(body);
  }

  @Post('assignments/bulk')
  @RequirePermissions(Permission.ALMACEN_UBICACIONES_GESTIONAR)
  @ApiOperation({ summary: 'Aplicar el Excel de asignaciones: crea las nuevas y mueve las que cambian.' })
  assignmentsBulkApply(@Body() body: BulkAssignmentsBody): Promise<BulkAssignmentsResult> {
    return this.assign.bulkApply(body);
  }

  @Post('assignments')
  @RequirePermissions(Permission.ALMACEN_UBICACIONES_GESTIONAR)
  @ApiOperation({ summary: 'Asignar una presentación de un producto a una ubicación con un papel y su mínimo/máximo.' })
  createAssignment(@Body() body: CreateAssignmentBody): Promise<ProductAssignment> {
    return this.assign.create(body);
  }

  @Patch('assignments/:id')
  @RequirePermissions(Permission.ALMACEN_UBICACIONES_GESTIONAR)
  @ApiOperation({ summary: 'Cambiar la ubicación o el mínimo/máximo de una asignación.' })
  updateAssignment(@Param('id') id: string, @Body() body: UpdateAssignmentBody): Promise<ProductAssignment> {
    return this.assign.update(id, body);
  }

  @Delete('assignments/:id')
  @RequirePermissions(Permission.ALMACEN_UBICACIONES_GESTIONAR)
  @ApiOperation({ summary: 'Quitar una asignación (no se borra: queda quién y cuándo).' })
  removeAssignment(@Param('id') id: string): Promise<{ id: string; quitada: true }> {
    return this.assign.remove(id);
  }
}
