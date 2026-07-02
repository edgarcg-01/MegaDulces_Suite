import { Controller, Get, Post, Query, Param, UseGuards, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CommercialAnalyticsService } from './commercial-analytics.service';
import { AnalyticsRefreshService } from './analytics-refresh.service';
import { SellOutExportService } from './sell-out-export.service';
import { RolesGuard } from '@megadulces/platform-core';
import { RequirePermissions } from '@megadulces/platform-core';
import { Permission } from '@megadulces/platform-core';

@ApiTags('commercial-analytics')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/analytics')
export class CommercialAnalyticsController {
  constructor(
    private readonly service: CommercialAnalyticsService,
    private readonly refresh: AnalyticsRefreshService,
    private readonly exporter: SellOutExportService,
  ) {}

  @Get('overview')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({
    summary:
      'KPIs rolling 30d (MV por default). Con from/to o ?live=true → on-the-fly.',
  })
  overview(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('live') live?: string,
  ) {
    return this.service.overview({ from, to, live: live === 'true' });
  }

  // ── VENTA REAL de la red (analytics.*, feeds Kepler) — Command Center ──

  @Get('network/overview')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({
    summary:
      'KPIs 30d sobre VENTA REAL de la red (analytics.sales_daily): bruto, margen, unidades, tickets, mix por canal + clientes activos (KV.3) + pipeline B2B.',
  })
  networkOverview() {
    return this.service.networkOverview();
  }

  @Get('network/top-products')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({ summary: 'Top productos por venta real 30d (analytics.product_sales_stats + ABC)' })
  networkTopProducts(@Query('limit') limit?: string) {
    return this.service.networkTopProducts(limit);
  }

  @Get('network/sales-by-brand')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({ summary: 'Mix por marca sobre venta real 30d + share %' })
  networkSalesByBrand() {
    return this.service.networkSalesByBrand();
  }

  @Get('network/daily-series')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({ summary: 'Serie diaria de venta real (revenue/units/tickets) para sparklines' })
  networkDailySeries(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.networkDailySeries({ from, to });
  }

  @Get('top-customers')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({ summary: 'Top N customers por revenue (MV rolling 30d o live)' })
  topCustomers(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('live') live?: string,
  ) {
    return this.service.topCustomers({
      from,
      to,
      limit: limit ? Number(limit) : undefined,
      live: live === 'true',
    });
  }

  @Get('top-products')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({ summary: 'Top N productos (MV rolling 30d o live, orderBy=units|revenue)' })
  topProducts(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('orderBy') orderBy?: 'units' | 'revenue',
    @Query('live') live?: string,
  ) {
    return this.service.topProducts({
      from,
      to,
      limit: limit ? Number(limit) : undefined,
      orderBy,
      live: live === 'true',
    });
  }

  @Post('refresh')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_FULFILL)
  @Throttle({ short: { limit: 3, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Disparar refresh manual de las MVs en `analytics.*`. Gate: COMMERCIAL_ORDERS_FULFILL (admin-only). 3 req/min anti-DoS porque REFRESH MATERIALIZED VIEW es operación cara.',
  })
  refreshMvs() {
    return this.refresh.refreshAll('manual');
  }

  @Get('inactive-customers')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({
    summary:
      'Customers activos sin pedidos en los últimos N días (oportunidad de recuperación)',
  })
  inactiveCustomers(@Query('days') days?: string, @Query('limit') limit?: string) {
    return this.service.inactiveCustomers(days, limit);
  }

  @Get('sales-by-brand')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({ summary: 'Revenue + units por brand en el período + share %' })
  salesByBrand(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.salesByBrand({ from, to });
  }

  @Get('low-stock')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({
    summary:
      'Productos con stock disponible (quantity - reserved) bajo threshold. Gate ORDERS_VER (no INVENTORY_VER) porque el command-center necesita alertas para todos los roles comerciales sin requerir CRUD de inventario.',
  })
  lowStock(
    @Query('threshold') threshold?: string,
    @Query('warehouse_id') warehouseId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.lowStock(threshold, warehouseId, limit);
  }

  @Get('dead-stock')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({
    summary:
      'Stock muerto: existencia > 0 sin venta reciente (sales_units_30d=0). Capital parado al costo, por almacén. Accionable para compras (liquidar / dejar de surtir).',
  })
  deadStock(
    @Query('warehouse_id') warehouseId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.deadStock(warehouseId, limit);
  }

  @Get('daily-series')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({ summary: 'Series diarias de revenue + orders count (TZ MX)' })
  dailySeries(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.dailySeries({ from, to });
  }

  // ─────────── Sprint M.3 — Ventas históricas (ERP Mega_Dulces vía FDW) ───────────

  @Get('historical/daily')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({
    summary:
      'Series diarias de ventas REALES del ERP (Mega_Dulces.ventas vía FDW). Read-only, no se mezcla con commercial.orders. Soporta filtro ?zona=La Piedad.',
  })
  historicalDaily(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('zona') zona?: string,
  ) {
    return this.service.historicalSalesDaily({ from, to, zona });
  }

  @Get('historical/top-products')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({
    summary: 'Top N productos del ERP por revenue (FDW). Filtros: from/to/zona/limit',
  })
  historicalTopProducts(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('zona') zona?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.historicalTopProducts({
      from,
      to,
      zona,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('historical/by-zona')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({
    summary:
      'Ventas del ERP por zona/sucursal en el período: tickets, customers únicos, units, revenue',
  })
  historicalByZona(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.historicalSalesByZona({ from, to });
  }

  @Get('historical/ranking')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({
    summary:
      'Top N pre-calculado por el ERP (Mega_Dulces.ranking_productos). Cuenta TODA la venta del ERP, no solo pedidos levantados por la app. Default limit 100, max 1000.',
  })
  historicalRanking(@Query('limit') limit?: string) {
    return this.service.historicalRanking({ limit: limit ? Number(limit) : undefined });
  }

  @Get('historical/margin-by-category')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({
    summary:
      'Margen por categoría en el período. JOIN ventas_legacy (FDW) ↔ products.cost_base ↔ categories. Devuelve revenue, costo, margen $, margen %.',
  })
  historicalMarginByCategory(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.historicalMarginByCategory({
      from,
      to,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('ranking-out-of-stock')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({
    summary:
      'Productos en el top-N del ERP con stock disponible 0 — oportunidad de venta perdida. Scan default top-200 del ERP, devuelve hasta `limit` (default 10).',
  })
  rankingOutOfStock(
    @Query('limit') limit?: string,
    @Query('topN') topN?: string,
  ) {
    return this.service.rankingOutOfStock({
      limit: limit ? Number(limit) : undefined,
      topN: topN ? Number(topN) : undefined,
    });
  }

  // ─────────── KV.3/5/6 — analytics.* (venta real Kepler) ───────────

  @Get('inventory-health')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({ summary: 'KV.5 — Salud de inventario: días de cobertura + status por producto×almacén.' })
  inventoryHealth(@Query('warehouse_id') warehouseId?: string, @Query('status') status?: string) {
    return this.service.inventoryHealth({ warehouse_id: warehouseId, status });
  }

  @Get('erp-customers')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({ summary: 'KV.3 — Clientes Kepler con compra agregada 180d.' })
  erpCustomers(@Query('search') search?: string, @Query('limit') limit?: string) {
    return this.service.erpCustomers({ search, limit: limit ? Number(limit) : undefined });
  }

  @Get('erp-customers/:code/products')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({ summary: 'KV.3 — Productos comprados por un cliente Kepler.' })
  erpCustomerProducts(@Param('code') code: string) {
    return this.service.erpCustomerProducts(code);
  }

  @Get('erp-promotions')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({ summary: 'KV.6 — Promos vigentes del ERP.' })
  erpPromotions() {
    return this.service.erpPromotions();
  }

  @Get('erp-shipments')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({ summary: 'KV.8 — Embarques reales del ERP agregados. ?group_by=route|status|warehouse|day|product ?from ?to ?route ?status' })
  erpShipments(
    @Query('group_by') groupBy?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('route') route?: string,
    @Query('status') status?: string,
  ) {
    return this.service.erpShipments({ group_by: groupBy, from, to, route, status });
  }

  // ─────────── Fase RS — Generador Sell-Out por empresa ───────────

  @Get('sell-out/brands')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({ summary: 'RS — Empresas/proveedores (marcas con productos) para el selector de reporte.' })
  sellOutBrands(@Query('search') search?: string) {
    return this.service.sellOutBrands(search);
  }

  @Get('sell-out/warehouses')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({ summary: 'RS — Almacenes/sucursales con venta (para el selector del reporte).' })
  sellOutWarehouses() {
    return this.service.sellOutWarehouses();
  }

  @Get('sell-out')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({
    summary:
      'RS — Reporte Sell-Out: matriz Producto × (Sucursal[×Canal]) con cajas + monto. Fuente = analytics.sales_daily. Params: brand_id, from, to, group_by=branch|branch_channel, channels=csv, warehouses=csv (códigos), include_zeros=true.',
  })
  sellOut(
    @Query('brand_id') brandId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('group_by') groupBy?: 'branch' | 'branch_channel',
    @Query('channels') channels?: string,
    @Query('warehouses') warehouses?: string,
    @Query('include_zeros') includeZeros?: string,
  ) {
    return this.service.sellOut(
      this.parseSellOutQuery(brandId, from, to, groupBy, channels, warehouses, includeZeros),
    );
  }

  @Get('sell-out.xlsx')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({ summary: 'RS — Descarga XLSX del reporte Sell-Out (mismos params que /sell-out).' })
  async sellOutXlsx(
    @Res() res: Response,
    @Query('brand_id') brandId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('group_by') groupBy?: 'branch' | 'branch_channel',
    @Query('channels') channels?: string,
    @Query('warehouses') warehouses?: string,
    @Query('include_zeros') includeZeros?: string,
  ) {
    const report = await this.service.sellOut(
      this.parseSellOutQuery(brandId, from, to, groupBy, channels, warehouses, includeZeros),
    );
    const buf = await this.exporter.buildXlsx(report);
    this.sendFile(res, buf, this.exporter.fileName(report, 'xlsx'),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }

  @Get('sell-out.pdf')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({ summary: 'RS — Descarga PDF del reporte Sell-Out (mismos params que /sell-out).' })
  async sellOutPdf(
    @Res() res: Response,
    @Query('brand_id') brandId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('group_by') groupBy?: 'branch' | 'branch_channel',
    @Query('channels') channels?: string,
    @Query('warehouses') warehouses?: string,
    @Query('include_zeros') includeZeros?: string,
  ) {
    const report = await this.service.sellOut(
      this.parseSellOutQuery(brandId, from, to, groupBy, channels, warehouses, includeZeros),
    );
    const buf = await this.exporter.buildPdf(report);
    this.sendFile(res, buf, this.exporter.fileName(report, 'pdf'), 'application/pdf');
  }

  @Get('salidas')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({
    summary:
      'SAL — Salidas/Ventas por Producto. Modo AÑO (year → columnas por mes) o RANGO (from/to ISO → Venta/Costo del período, venta diaria). Params: year | from,to · warehouses=csv, brand_id, supplier_id, search.',
  })
  salidas(
    @Query('year') year?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('warehouses') warehouses?: string,
    @Query('brand_id') brandId?: string,
    @Query('supplier_id') supplierId?: string,
    @Query('search') search?: string,
  ) {
    return this.service.salidasReport(this.parseSalidasQuery(year, from, to, warehouses, brandId, supplierId, search));
  }

  @Get('salidas.xlsx')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({ summary: 'SAL — Descarga XLSX de Salidas por Producto (mismos params que /salidas).' })
  async salidasXlsx(
    @Res() res: Response,
    @Query('year') year?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('warehouses') warehouses?: string,
    @Query('brand_id') brandId?: string,
    @Query('supplier_id') supplierId?: string,
    @Query('search') search?: string,
  ) {
    const report = await this.service.salidasReport(this.parseSalidasQuery(year, from, to, warehouses, brandId, supplierId, search));
    const buf = await this.exporter.buildSalidasXlsx(report);
    this.sendFile(res, buf, this.exporter.salidasFileName(report),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }

  private parseSalidasQuery(
    year?: string, from?: string, to?: string, warehouses?: string,
    brandId?: string, supplierId?: string, search?: string,
  ) {
    const isRange = !!(from && to);
    return {
      year: isRange ? undefined : (year ? Number(year) : new Date().getFullYear()),
      from: isRange ? from : undefined,
      to: isRange ? to : undefined,
      warehouses: warehouses ? warehouses.split(',').map((c) => c.trim()).filter(Boolean) : undefined,
      brand_id: brandId,
      supplier_id: supplierId,
      search,
    };
  }

  // ─────────── Fase RR — Ventas por Ruta ───────────

  @Get('sales-by-route')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({
    summary:
      'RR — Ventas por Ruta: fila por (sucursal, ruta) con venta (importe/unidades/tickets) mes a mes + share%. Ruta = serie de folio Kepler c63 (UD+almacén+ruta). Params: year, warehouses=csv.',
  })
  salesByRoute(@Query('year') year?: string, @Query('warehouses') warehouses?: string) {
    return this.service.salesByRoute({
      year: year ? Number(year) : new Date().getFullYear(),
      warehouses: warehouses ? warehouses.split(',').map((c) => c.trim()).filter(Boolean) : undefined,
    });
  }

  @Get('sales-by-route.xlsx')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({ summary: 'RR — Descarga XLSX de Ventas por Ruta (mismos params que /sales-by-route).' })
  async salesByRouteXlsx(
    @Res() res: Response,
    @Query('year') year?: string,
    @Query('warehouses') warehouses?: string,
  ) {
    const report = await this.service.salesByRoute({
      year: year ? Number(year) : new Date().getFullYear(),
      warehouses: warehouses ? warehouses.split(',').map((c) => c.trim()).filter(Boolean) : undefined,
    });
    const buf = await this.exporter.buildSalesByRouteXlsx(report);
    this.sendFile(res, buf, this.exporter.salesByRouteFileName(report),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }

  // ─────────── Fase T — Traspasos (movimientos que NO son venta) ───────────

  @Get('transfers')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({
    summary:
      'T — Traspasos / movimientos que NO son venta (consolidación UD06, recepción UA50, traspasos): fila por (sucursal, tipo) mes a mes + share%. Params: year, warehouses=csv.',
  })
  transfers(@Query('year') year?: string, @Query('warehouses') warehouses?: string) {
    return this.service.transfersReport({
      year: year ? Number(year) : new Date().getFullYear(),
      warehouses: warehouses ? warehouses.split(',').map((c) => c.trim()).filter(Boolean) : undefined,
    });
  }

  @Get('transfers.xlsx')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({ summary: 'T — Descarga XLSX de Traspasos (mismos params que /transfers).' })
  async transfersXlsx(
    @Res() res: Response,
    @Query('year') year?: string,
    @Query('warehouses') warehouses?: string,
  ) {
    const report = await this.service.transfersReport({
      year: year ? Number(year) : new Date().getFullYear(),
      warehouses: warehouses ? warehouses.split(',').map((c) => c.trim()).filter(Boolean) : undefined,
    });
    const buf = await this.exporter.buildTransfersXlsx(report);
    this.sendFile(res, buf, this.exporter.transfersFileName(report),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }

  private parseSellOutQuery(
    brandId: string,
    from: string,
    to: string,
    groupBy?: 'branch' | 'branch_channel',
    channels?: string,
    warehouses?: string,
    includeZeros?: string,
  ) {
    const csv = (s?: string) => (s ? s.split(',').map((v) => v.trim()).filter(Boolean) : undefined);
    return {
      brand_id: brandId,
      from,
      to,
      group_by: groupBy,
      channels: csv(channels),
      warehouses: csv(warehouses),
      include_zeros: includeZeros === 'true',
    };
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
}
