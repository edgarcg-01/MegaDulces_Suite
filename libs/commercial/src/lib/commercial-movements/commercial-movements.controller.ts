import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { CommercialMovementsService, MovementsQuery } from './commercial-movements.service';

/**
 * DM.1 — Diario de movimientos (mejora del reporte Kepler). Lectura de inventario.
 * Agregación primero (summary/aggregate), folio a folio bajo demanda (lines).
 */
@ApiTags('commercial-movements')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/movements')
export class CommercialMovementsController {
  constructor(private readonly svc: CommercialMovementsService) {}

  private q(raw: Record<string, string | undefined>): MovementsQuery {
    return {
      warehouse_id: raw.warehouse_id, warehouse_ids: raw.warehouse_ids,
      from: raw.from, to: raw.to, doc_code: raw.doc_code, movement_kind: raw.movement_kind,
      product_id: raw.product_id, search: raw.search, group_by: raw.group_by,
      page: raw.page ? Number(raw.page) : undefined,
      pageSize: raw.pageSize ? Number(raw.pageSize) : undefined,
    };
  }

  @Get('summary')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_VER)
  @ApiOperation({ summary: 'KPIs (entradas/salidas/neto/valor/docs) + desglose por tipo de documento. Filtros: warehouse_id(s), from, to, doc_code, movement_kind, search.' })
  summary(@Query() raw: Record<string, string>) { return this.svc.summary(this.q(raw)); }

  @Get('aggregate')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_VER)
  @ApiOperation({ summary: 'Vista agregada (DEFAULT). group_by=product|doc_code|day|warehouse. Cada fila: entradas/salidas/neto/valor/lineas/documentos.' })
  aggregate(@Query() raw: Record<string, string>) { return this.svc.aggregate(this.q(raw)); }

  @Get('lines')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_VER)
  @ApiOperation({ summary: 'Drill folio a folio (line-level) de una rama. Filtros: product_id, doc_code, movement_kind, warehouse_id(s), from, to.' })
  lines(@Query() raw: Record<string, string>) { return this.svc.lines(this.q(raw)); }

  @Get('filters')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_VER)
  @ApiOperation({ summary: 'Almacenes + tipos de documento presentes en el feed (para los selects).' })
  filters() { return this.svc.filters(); }
}
