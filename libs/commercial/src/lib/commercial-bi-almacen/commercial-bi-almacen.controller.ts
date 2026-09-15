import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { CommercialBiAlmacenService } from './commercial-bi-almacen.service';
import { CommercialBiAlmacenExportService } from './commercial-bi-almacen-export.service';

/**
 * WMS-BI.1 — Análisis BI de Almacén. Ver el cabezal de `commercial-bi-almacen.service.ts`
 * para las decisiones de fondo (alcance por almacén vía `ScopeService`/ADR-050, costo
 * declarado cuando falta el resolvedor, Diario de Movimientos = sólo Kepler).
 *
 * Todo bajo `ALMACEN_BI_VER` (permiso de sólo lectura, WMS-BI.0). El alcance por
 * almacén NO se repite en cada endpoint como un parámetro más: cada método de servicio
 * lo resuelve internamente contra `ScopeService`, así que un query param de más
 * (`?warehouse_codes=99`) se recorta, nunca se honra a ciegas.
 */
@ApiTags('commercial-bi-almacen')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/bi-almacen')
export class CommercialBiAlmacenController {
  constructor(
    private readonly svc: CommercialBiAlmacenService,
    private readonly exporter: CommercialBiAlmacenExportService,
  ) {}

  @Get('filters')
  @RequirePermissions(Permission.ALMACEN_BI_VER)
  @ApiOperation({ summary: 'Zonas+almacenes autorizados (ya recortados a tu alcance), tipos de documento presentes en el feed, y frescura real de movimientos/existencia.' })
  filters(@Query() query: Record<string, unknown>) { return this.svc.filters(query); }

  @Get('products/search')
  @RequirePermissions(Permission.ALMACEN_BI_VER)
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiOperation({ summary: 'Buscador de productos por código o nombre, paginado (para el filtro de la pantalla — no trae el catálogo completo).' })
  productSearch(@Query('q') q: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.svc.productSearch(q, Number(page) || 1, Number(pageSize) || 20);
  }

  @Get('summary')
  @RequirePermissions(Permission.ALMACEN_BI_VER)
  @ApiQuery({ name: 'from', required: false, description: 'YYYY-MM-DD. Default: 30 días atrás.' })
  @ApiQuery({ name: 'to', required: false, description: 'YYYY-MM-DD. Default: hoy.' })
  @ApiOperation({ summary: 'Pestaña Resumen: inventario valuado (catálogo vs. costo verificado del ERP, cuando existe), movimientos del periodo, y desviación de costo por SKU.' })
  summary(@Query() query: Record<string, unknown>) { return this.svc.summary(query); }

  @Get('movements')
  @RequirePermissions(Permission.ALMACEN_BI_VER)
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'pageSize', required: false })
  @ApiOperation({ summary: 'Pestaña Movimientos: línea a línea, paginado y filtrable en el servidor. Sólo sucursales Kepler (01-06) — Morelia/CEDIS aún no tienen este feed.' })
  movements(@Query() query: Record<string, unknown>) { return this.svc.movements(query); }

  @Get('movements/detail')
  @RequirePermissions(Permission.ALMACEN_BI_VER)
  @ApiQuery({ name: 'warehouse_id', required: true })
  @ApiQuery({ name: 'folio', required: true })
  @ApiQuery({ name: 'doc_code', required: false })
  @ApiQuery({ name: 'doc_serie', required: false })
  @ApiOperation({ summary: 'Documento completo de un folio (header+líneas+contraparte). 403 si el almacén no está en tu alcance; redacta el destino si es un cliente y no tenés COMMERCIAL_CUSTOMERS_VER.' })
  movementDetail(
    @Query('warehouse_id') warehouseId: string,
    @Query('folio') folio: string,
    @Query('doc_code') docCode: string | undefined,
    @Query('doc_serie') docSerie: string | undefined,
    @Req() req: any,
  ) {
    return this.svc.movementDetail({ warehouse_id: warehouseId, folio, doc_code: docCode, doc_serie: docSerie }, req.user?.permissions);
  }

  @Get('fields')
  @RequirePermissions(Permission.ALMACEN_BI_VER)
  @ApiOperation({ summary: 'Pestaña Explorar datos: catálogo de campos agrupado, con `available:false` + motivo cuando el dato no existe en el feed o el perfil no lo alcanza.' })
  fields(@Req() req: any) { return this.svc.fields(req.user?.permissions); }

  @Get('explore')
  @RequirePermissions(Permission.ALMACEN_BI_VER)
  @ApiQuery({ name: 'fields', required: false, description: 'CSV de claves de `GET fields`. El servidor recorta las que no correspondan a tu perfil, aunque se pidan explícitas.' })
  @ApiOperation({ summary: 'Vista previa paginada con las columnas elegidas (whitelist server-side, nunca las que mande el cliente a ciegas).' })
  explore(@Query() query: Record<string, unknown>, @Req() req: any) {
    const fieldsReq = String(query['fields'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    return this.svc.explore(query, fieldsReq, req.user?.permissions);
  }

  // ═══════════════════════════════════════════════ WMS-BI.5 — exportar toda la consulta ════

  @Get('movements/export.csv')
  @RequirePermissions(Permission.ALMACEN_BI_VER)
  @ApiOperation({ summary: 'WMS-BI.5 — Movimientos: exporta TODA la consulta filtrada (no sólo la página cargada), tope 100,000 filas. CSV.' })
  async exportMovementsCsv(@Query() query: Record<string, unknown>, @Res() res: Response) {
    const { rows, from, to } = await this.movementsExportData(query);
    const buf = this.exporter.buildCsv(CommercialBiAlmacenService.MOVEMENT_EXPORT_COLUMNS, rows);
    this.sendFile(res, buf, this.exporter.fileName('Movimientos - Analisis BI Almacen', from, to, 'csv'), 'text/csv; charset=utf-8');
  }

  @Get('movements/export.xlsx')
  @RequirePermissions(Permission.ALMACEN_BI_VER)
  @ApiOperation({ summary: 'WMS-BI.5 — Movimientos: exporta TODA la consulta filtrada, tope 100,000 filas. Excel.' })
  async exportMovementsXlsx(@Query() query: Record<string, unknown>, @Res() res: Response) {
    const { rows, from, to } = await this.movementsExportData(query);
    const buf = await this.exporter.buildXlsx(CommercialBiAlmacenService.MOVEMENT_EXPORT_COLUMNS, rows, 'Movimientos');
    this.sendFile(res, buf, this.exporter.fileName('Movimientos - Analisis BI Almacen', from, to, 'xlsx'),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }

  @Get('movements/export.sqlite')
  @RequirePermissions(Permission.ALMACEN_BI_VER)
  @ApiOperation({ summary: 'WMS-BI.5 — Movimientos: exporta TODA la consulta filtrada como base de datos SQLite (equivalente moderno al .mdb del sistema anterior) — sin el límite práctico de filas de CSV/Excel, tipos preservados. Tope 100,000 filas.' })
  async exportMovementsSqlite(@Query() query: Record<string, unknown>, @Res() res: Response) {
    const { rows, from, to, total, truncated } = await this.movementsExportData(query);
    const buf = await this.exporter.buildSqlite('movimientos', CommercialBiAlmacenService.MOVEMENT_EXPORT_COLUMNS, rows, {
      total_disponible: total, exportado: rows.length, truncado: truncated,
    });
    this.sendFile(res, buf, this.exporter.fileName('Movimientos - Analisis BI Almacen', from, to, 'sqlite'), 'application/x-sqlite3');
  }

  @Get('explore/export.csv')
  @RequirePermissions(Permission.ALMACEN_BI_VER)
  @ApiOperation({ summary: 'WMS-BI.5 — Explorar datos: exporta TODA la consulta con las columnas elegidas, tope 100,000 filas. CSV.' })
  async exportExploreCsv(@Query() query: Record<string, unknown>, @Req() req: any, @Res() res: Response) {
    const { rows, columns, from, to } = await this.exploreExportData(query, req);
    const buf = this.exporter.buildCsv(columns, rows);
    this.sendFile(res, buf, this.exporter.fileName('Explorar - Analisis BI Almacen', from, to, 'csv'), 'text/csv; charset=utf-8');
  }

  @Get('explore/export.xlsx')
  @RequirePermissions(Permission.ALMACEN_BI_VER)
  @ApiOperation({ summary: 'WMS-BI.5 — Explorar datos: exporta TODA la consulta con las columnas elegidas, tope 100,000 filas. Excel.' })
  async exportExploreXlsx(@Query() query: Record<string, unknown>, @Req() req: any, @Res() res: Response) {
    const { rows, columns, from, to } = await this.exploreExportData(query, req);
    const buf = await this.exporter.buildXlsx(columns, rows, 'Explorar');
    this.sendFile(res, buf, this.exporter.fileName('Explorar - Analisis BI Almacen', from, to, 'xlsx'),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }

  @Get('explore/export.sqlite')
  @RequirePermissions(Permission.ALMACEN_BI_VER)
  @ApiOperation({ summary: 'WMS-BI.5 — Explorar datos: exporta TODA la consulta como base de datos SQLite, tope 100,000 filas.' })
  async exportExploreSqlite(@Query() query: Record<string, unknown>, @Req() req: any, @Res() res: Response) {
    const { rows, columns, from, to, total, truncated } = await this.exploreExportData(query, req);
    const buf = await this.exporter.buildSqlite('explorar', columns, rows, {
      total_disponible: total, exportado: rows.length, truncado: truncated,
    });
    this.sendFile(res, buf, this.exporter.fileName('Explorar - Analisis BI Almacen', from, to, 'sqlite'), 'application/x-sqlite3');
  }

  private async movementsExportData(query: Record<string, unknown>) {
    const data = await this.svc.exportMovements(query);
    // `BiMovementRow` no declara índice string — el exporter accede genéricamente por clave,
    // así que se recasta una vez acá (misma forma real, sólo cambia el tipo estático).
    return { ...data, rows: data.rows as unknown as Array<Record<string, unknown>> };
  }

  private exploreExportData(query: Record<string, unknown>, req: any) {
    const fieldsReq = String(query['fields'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    return this.svc.exportExplore(query, fieldsReq, req.user?.permissions);
  }

  /** Mismo helper de descarga usado en `commercial-movements` (DM.6) — Content-Disposition con
   * fallback ASCII + `filename*` UTF-8 para nombres con acentos. */
  private sendFile(res: Response, buf: Buffer, filename: string, contentType: string) {
    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename.replace(/[^ -~]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    res.setHeader('Content-Length', String(buf.length));
    res.end(buf);
  }
}
