import { Body, Controller, Get, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { RolesGuard, RequirePermissions, RequireAnyPermission, Permission } from '@megadulces/platform-core';
import { CommercialMovementsService, MovementsQuery } from './commercial-movements.service';
import { MovementsExportService } from './movements-export.service';

/**
 * DM.1 — Diario de movimientos (mejora del reporte Kepler). Lectura de inventario.
 * Agregación primero (summary/aggregate), folio a folio bajo demanda (lines).
 */
@ApiTags('commercial-movements')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/movements')
export class CommercialMovementsController {
  constructor(
    private readonly svc: CommercialMovementsService,
    private readonly exporter: MovementsExportService,
  ) {}

  private q(raw: Record<string, string | undefined>): MovementsQuery {
    return {
      warehouse_id: raw.warehouse_id, warehouse_ids: raw.warehouse_ids,
      from: raw.from, to: raw.to, doc_code: raw.doc_code, movement_kind: raw.movement_kind,
      product_id: raw.product_id, search: raw.search, group_by: raw.group_by,
      estado: raw.estado, transfer_wh_ids: raw.transfer_wh_ids, dest_kinds: raw.dest_kinds,
      page: raw.page ? Number(raw.page) : undefined,
      pageSize: raw.pageSize ? Number(raw.pageSize) : undefined,
    };
  }

  @Get('summary')
  @RequireAnyPermission(Permission.COMMERCIAL_MOVEMENTS_VER, Permission.RECONCILIATION_VER)
  @ApiOperation({ summary: 'KPIs (entradas/salidas/neto/valor/docs) + desglose por tipo de documento. Filtros: warehouse_id(s), from, to, doc_code, movement_kind, search.' })
  summary(@Query() raw: Record<string, string>) { return this.svc.summary(this.q(raw)); }

  @Get('aggregate')
  @RequireAnyPermission(Permission.COMMERCIAL_MOVEMENTS_VER, Permission.RECONCILIATION_VER)
  @ApiOperation({ summary: 'Vista agregada (DEFAULT). group_by=product|doc_code|day|warehouse. Cada fila: entradas/salidas/neto/valor/lineas/documentos.' })
  aggregate(@Query() raw: Record<string, string>) { return this.svc.aggregate(this.q(raw)); }

  @Get('lines')
  @RequireAnyPermission(Permission.COMMERCIAL_MOVEMENTS_VER, Permission.RECONCILIATION_VER)
  @ApiOperation({ summary: 'Drill folio a folio (line-level) de una rama. Filtros: product_id, doc_code, movement_kind, warehouse_id(s), from, to.' })
  lines(@Query() raw: Record<string, string>) { return this.svc.lines(this.q(raw)); }

  @Get('document')
  @RequireAnyPermission(Permission.COMMERCIAL_MOVEMENTS_VER, Permission.RECONCILIATION_VER)
  @ApiOperation({ summary: 'Drill al documento: TODAS las líneas de un folio (header + líneas + totales + contraparte + auditado). Params: folio, warehouse_id, doc_code, doc_serie.' })
  document(@Query('folio') folio: string, @Query('warehouse_id') warehouse_id: string, @Query('doc_code') doc_code?: string, @Query('doc_serie') doc_serie?: string) {
    return this.svc.document({ folio, warehouse_id, doc_code, doc_serie });
  }

  @Post('audit')
  @RequirePermissions(Permission.COMMERCIAL_MOVEMENTS_GESTIONAR)
  @ApiOperation({ summary: 'DM.4 — marca/desmarca un documento como auditado. Body: { warehouse_id, doc_code, doc_serie?, folio, audited, note? }.' })
  setAudit(@Body() dto: { warehouse_id: string; doc_code: string; doc_serie?: string | null; folio: string; audited: boolean; note?: string | null }) {
    return this.svc.setAudit(dto);
  }

  @Get('transfers-check')
  @RequireAnyPermission(Permission.COMMERCIAL_MOVEMENTS_VER, Permission.RECONCILIATION_VER)
  @ApiOperation({ summary: 'DM.3 — Validación de traspasos: parea salida (UD41) ↔ recepción (UA50) por serie+folio y clasifica ok/diferencia/sin_recepcion/sin_origen.' })
  transfersCheck(@Query() raw: Record<string, string>) { return this.svc.transfersCheck(this.q(raw)); }

  @Get('transfers-check-pair')
  @RequireAnyPermission(Permission.COMMERCIAL_MOVEMENTS_VER, Permission.RECONCILIATION_VER)
  @ApiOperation({ summary: 'DM.12b — Drill de la matriz física: folios de UN par origen→destino (enviado ⇄ recibido, estado por folio), scopeado y completo (sin el cap 500 global). Params: origin_wh_id, dest_wh_id (vacío = sin destino/origen). Honra rango; ignora filtro de almacén.' })
  transfersCheckPair(@Query('origin_wh_id') originWhId: string, @Query('dest_wh_id') destWhId: string, @Query() raw: Record<string, string>) {
    return this.svc.transfersCheckPair(this.q(raw), originWhId || null, destWhId || null);
  }

  @Get('transfers-ledger')
  @RequireAnyPermission(Permission.COMMERCIAL_MOVEMENTS_VER, Permission.RECONCILIATION_VER)
  @ApiOperation({ summary: 'DM.12 — Conciliación CONTABLE de traspasos (mayor 515): entrada (515-001) vs salida (515-002) por mes y sucursal. La cuenta puente debe netear ≈ $0; Δ ≠ 0 = traspasos sin cuadrar. Honra el rango de fechas; ignora el filtro de almacén.' })
  transfersLedger(@Query() raw: Record<string, string>) { return this.svc.transfersLedger(this.q(raw)); }

  @Get('transfers-physical')
  @RequireAnyPermission(Permission.COMMERCIAL_MOVEMENTS_VER, Permission.RECONCILIATION_VER)
  @ApiOperation({ summary: 'DM.12 — Pareo físico UNA sola vez → { matrix, check } (dedup: antes transfers-matrix y transfers-check corrían el mismo CTE dos veces por carga del Cuadre). Honra rango; ignora filtro de almacén.' })
  transfersPhysical(@Query() raw: Record<string, string>) { return this.svc.transfersPhysical(this.q(raw)); }

  @Get('transfers-matrix')
  @RequireAnyPermission(Permission.COMMERCIAL_MOVEMENTS_VER, Permission.RECONCILIATION_VER)
  @ApiOperation({ summary: 'DM.12 — Matriz FÍSICA origen→destino de traspasos: enviado vs recibido + Δ + conteo por estado, agregado por par de sucursales. Honra rango de fechas; ignora filtro de almacén.' })
  transfersMatrix(@Query() raw: Record<string, string>) { return this.svc.transfersMatrix(this.q(raw)); }

  @Get('transfers-ledger-detail')
  @RequireAnyPermission(Permission.COMMERCIAL_MOVEMENTS_VER, Permission.RECONCILIATION_VER)
  @ApiOperation({ summary: 'DM.12 — DETALLE del descuadre: pólizas de la cuenta 515 clasificadas (exacto/costo/sin_rastro) con su contraparte, sobre analytics.gl_poliza_lines. Filtros: bucket, kind (entrada|salida), sucursal, search (folio/referencia), min_amount. Honra rango; ignora filtro de almacén.' })
  transfersLedgerDetail(@Query() raw: Record<string, string>) {
    return this.svc.transfersLedgerDetail(this.q(raw), {
      bucket: raw.bucket, kind: raw.detail_kind, sucursal: raw.sucursal,
      destinos: raw.destinos ? raw.destinos.split(',').filter(Boolean) : undefined,
      search: raw.q, min_amount: raw.min_amount,
    });
  }

  @Get('transfers-wincaja-check')
  @RequireAnyPermission(Permission.COMMERCIAL_MOVEMENTS_VER, Permission.RECONCILIATION_VER)
  @ApiOperation({ summary: 'DM.13 — Cuadre traspasos Kepler→Wincaja (tiendas solo-Wincaja 30/32/50): Σ salida CEDIS (515-002 mapeada por destino) vs Σ recepción CEDIS en Wincaja (costo), por tienda×mes + Δ. Honra rango; ignora filtro de almacén.' })
  transfersWincajaCheck(@Query() raw: Record<string, string>) { return this.svc.transfersWincajaCheck(this.q(raw)); }

  @Get('transfers-wincaja-detail')
  @RequireAnyPermission(Permission.COMMERCIAL_MOVEMENTS_VER, Permission.RECONCILIATION_VER)
  @ApiOperation({ summary: 'DM.13b — Detalle folio a folio de UNA tienda×mes cruzando los dos sistemas: despachos Kepler (515-002 mapeados a la tienda) ⇄ recepciones Wincaja (tipo C). Params: code (30|32|50), anio_mes (YYYY-MM). Honra tenant.' })
  transfersWincajaDetail(@Query('code') code: string, @Query('anio_mes') anioMes: string, @Query() raw: Record<string, string>) {
    return this.svc.transfersWincajaDetail(this.q(raw), code, anioMes);
  }

  @Get('transfers-cuadre.pdf')
  @RequireAnyPermission(Permission.COMMERCIAL_MOVEMENTS_VER, Permission.RECONCILIATION_VER)
  @ApiOperation({ summary: 'DM.12 — Reporte del Cuadre de traspasos en PDF. mode=global (consolidado 4 secciones) | resumen (concentrado por sucursal) | detalle (desglosado por sucursal). Honra rango de fechas; ignora filtro de almacén.' })
  async exportCuadrePdf(@Res() res: Response, @Query() raw: Record<string, string>) {
    const mode = (['global', 'resumen', 'detalle'].includes(raw.mode || '') ? raw.mode : 'global') as 'global' | 'resumen' | 'detalle';
    const data = await this.svc.exportCuadreData(this.q(raw));
    const buf = await this.exporter.buildCuadrePdf(data, mode);
    const suffix = mode === 'resumen' ? ' concentrado' : mode === 'detalle' ? ' por sucursal' : '';
    this.sendFile(res, buf, this.exporter.cuadreFileName(data.range, 'pdf').replace('.pdf', `${suffix}.pdf`), 'application/pdf');
  }

  @Get('export.xlsx')
  @RequireAnyPermission(Permission.COMMERCIAL_MOVEMENTS_VER, Permission.RECONCILIATION_VER)
  @ApiOperation({ summary: 'DM.6 — Excel del Diario (hoja Documentos + hoja Validación de traspasos). Mismos filtros que /lines.' })
  async exportXlsx(@Res() res: Response, @Query() raw: Record<string, string>) {
    const data = await this.svc.exportData(this.q(raw));
    const buf = await this.exporter.buildXlsx(data);
    this.sendFile(res, buf, this.exporter.fileName(data.range, 'xlsx'),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }

  @Get('export.pdf')
  @RequireAnyPermission(Permission.COMMERCIAL_MOVEMENTS_VER, Permission.RECONCILIATION_VER)
  @ApiOperation({ summary: 'DM.6 — PDF del Diario (documentos + validación de traspasos). Mismos filtros que /lines.' })
  async exportPdf(@Res() res: Response, @Query() raw: Record<string, string>) {
    const data = await this.svc.exportData(this.q(raw));
    const buf = await this.exporter.buildPdf(data);
    this.sendFile(res, buf, this.exporter.fileName(data.range, 'pdf'), 'application/pdf');
  }

  private sendFile(res: Response, buf: Buffer, filename: string, contentType: string) {
    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename.replace(/[^ -~]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    res.setHeader('Content-Length', String(buf.length));
    res.end(buf);
  }

  @Get('filters')
  @RequireAnyPermission(Permission.COMMERCIAL_MOVEMENTS_VER, Permission.RECONCILIATION_VER)
  @ApiOperation({ summary: 'Almacenes + tipos de documento presentes en el feed (para los selects).' })
  filters() { return this.svc.filters(); }
}
