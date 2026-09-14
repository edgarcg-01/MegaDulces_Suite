import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { CommercialBiAlmacenService } from './commercial-bi-almacen.service';

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
  constructor(private readonly svc: CommercialBiAlmacenService) {}

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
}
