import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
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
      estado: raw.estado,
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

  @Get('document')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_VER)
  @ApiOperation({ summary: 'Drill al documento: TODAS las líneas de un folio (header + líneas + totales + contraparte + auditado). Params: folio, warehouse_id, doc_code, doc_serie.' })
  document(@Query('folio') folio: string, @Query('warehouse_id') warehouse_id: string, @Query('doc_code') doc_code?: string, @Query('doc_serie') doc_serie?: string) {
    return this.svc.document({ folio, warehouse_id, doc_code, doc_serie });
  }

  @Post('audit')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_SUPERVISAR)
  @ApiOperation({ summary: 'DM.4 — marca/desmarca un documento como auditado. Body: { warehouse_id, doc_code, doc_serie?, folio, audited, note? }.' })
  setAudit(@Body() dto: { warehouse_id: string; doc_code: string; doc_serie?: string | null; folio: string; audited: boolean; note?: string | null }) {
    return this.svc.setAudit(dto);
  }

  @Get('transfers-check')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_VER)
  @ApiOperation({ summary: 'DM.3 — Validación de traspasos: parea salida (UD41) ↔ recepción (UA50) por serie+folio y clasifica ok/diferencia/sin_recepcion/sin_origen.' })
  transfersCheck(@Query() raw: Record<string, string>) { return this.svc.transfersCheck(this.q(raw)); }

  @Get('filters')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_VER)
  @ApiOperation({ summary: 'Almacenes + tipos de documento presentes en el feed (para los selects).' })
  filters() { return this.svc.filters(); }
}
