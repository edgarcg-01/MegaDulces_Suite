import { Body, Controller, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { CommercialReplenishmentService, CreateRequisitionDto, ReceiveRequisitionDto } from './commercial-replenishment.service';
import { ReplenishmentExportService, PedidoExport } from './replenishment-export.service';

const REQ_ESTADO_LABEL: Record<string, string> = {
  draft: 'Borrador', pending_approval: 'Pendiente', approved: 'Aprobada',
  ordered: 'Ordenada', received: 'Recibida', cancelled: 'Cancelada',
};

/** Envía un buffer XLSX como descarga (nombre con fallback ASCII + UTF-8). */
function sendXlsx(res: Response, buf: Buffer, filename: string): void {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${filename.replace(/[^ -~]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
  res.setHeader('Content-Length', String(buf.length));
  res.end(buf);
}

/**
 * RA.4/RA.7 — Proyecto Compras (ADR-030). Existencia crítica + sugerido + requisiciones.
 * VER = lectura del reporte y requisiciones · GESTIONAR = crear/aprobar/rechazar requisición.
 */
@ApiTags('commercial-replenishment')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/replenishment')
export class CommercialReplenishmentController {
  constructor(
    private readonly svc: CommercialReplenishmentService,
    private readonly exporter: ReplenishmentExportService,
  ) {}

  @Get('critical-stock')
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'Existencia crítica: existencia vs mín/reorden/máx + sugerido. Filtros: warehouse_id, warehouse_ids(CSV), supplier_id, abc, bucket, source, search, target_basis(min|reorder|max), scope(all).' })
  criticalStock(
    @Query('warehouse_id') warehouse_id?: string,
    @Query('warehouse_ids') warehouse_ids?: string,
    @Query('supplier_id') supplier_id?: string,
    @Query('category_id') category_id?: string,
    @Query('abc') abc?: string,
    @Query('xyz') xyz?: string,
    @Query('bucket') bucket?: string,
    @Query('source') source?: string,
    @Query('search') search?: string,
    @Query('target_basis') target_basis?: string,
    @Query('scope') scope?: string,
    @Query('sort_by') sort_by?: string,
    @Query('sort_dir') sort_dir?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.svc.criticalStock({ warehouse_id, warehouse_ids, supplier_id, category_id, abc, xyz, bucket, source, search, target_basis, scope, sort_by, sort_dir, page: page ? Number(page) : undefined, pageSize: pageSize ? Number(pageSize) : undefined });
  }

  @Get('purchase-suggestion')
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'RA-PRO.17 — Compra sugerida anclada en el ritmo de compra REAL (entrada X-A-40). sugerido = max(0, ritmo_diario × cobertura − existencia/uxc − en_tránsito), valuado al costo real. Solo almacenes que compran directo. Filtros: warehouse_id(s), supplier_id, category_id, search, coverage_days(=30).' })
  purchaseSuggestion(
    @Query('warehouse_id') warehouse_id?: string,
    @Query('warehouse_ids') warehouse_ids?: string,
    @Query('supplier_id') supplier_id?: string,
    @Query('category_id') category_id?: string,
    @Query('search') search?: string,
    @Query('coverage_days') coverage_days?: string,
    @Query('bucket') bucket?: string,
    @Query('scope') scope?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.svc.purchaseSuggestion({ warehouse_id, warehouse_ids, supplier_id, category_id, search, coverage_days: coverage_days ? Number(coverage_days) : undefined, bucket, scope, page: page ? Number(page) : undefined, pageSize: pageSize ? Number(pageSize) : undefined });
  }

  @Get('transfer-suggestion')
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'RA-PRO.20 — traspaso preciso (topología): déficit de sucursal ← stock del CEDIS que la surte. transfer = déficit × min(1, stock_cedis/Σdéficit), en cajas al costo real. Filtros: warehouse_id(destino), supplier_id, category_id, search, coverage_days(=30).' })
  transferSuggestion(
    @Query('warehouse_id') warehouse_id?: string,
    @Query('supplier_id') supplier_id?: string,
    @Query('category_id') category_id?: string,
    @Query('search') search?: string,
    @Query('coverage_days') coverage_days?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.svc.transferPlan({ warehouse_id, supplier_id, category_id, search, coverage_days: coverage_days ? Number(coverage_days) : undefined, page: page ? Number(page) : undefined, pageSize: pageSize ? Number(pageSize) : undefined });
  }

  @Get('overstock')
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'RA-PRO.19 — sobrestock (capital inmovilizado) por almacén, topología-aware (CEDIS vs demanda de red). excedente = max(0, stock − demanda_efectiva × over_days), valuado en cajas al costo real. Filtros: warehouse_id, supplier_id, category_id, search, over_days(=90).' })
  overstock(
    @Query('warehouse_id') warehouse_id?: string,
    @Query('supplier_id') supplier_id?: string,
    @Query('category_id') category_id?: string,
    @Query('search') search?: string,
    @Query('over_days') over_days?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.svc.overstockList({ warehouse_id, supplier_id, category_id, search, over_days: over_days ? Number(over_days) : undefined, page: page ? Number(page) : undefined, pageSize: pageSize ? Number(pageSize) : undefined });
  }

  @Get('workbook')
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'RA-PRO.32 — Réplica del workbook del comprador: una fila por SKU con UXC, costo/caja y, por cada COLUMNA (sucursal o una sola General de red), su venta 30d/existencia/pedido en cajas + $Pedido/Valor Venta/Valor Existencia. Columnas dinámicas por almacén (sin hardcode). Filtros: supplier_id, category_id, search, coverage_days(=30), scope(needed), warehouse_ids(CSV, una/varias), group(general=agregado de red).' })
  workbook(
    @Query('supplier_id') supplier_id?: string,
    @Query('category_id') category_id?: string,
    @Query('search') search?: string,
    @Query('coverage_days') coverage_days?: string,
    @Query('scope') scope?: string,
    @Query('warehouse_ids') warehouse_ids?: string,
    @Query('group') group?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('iad') iad?: string,
    @Query('only_overstock') only_overstock?: string,
  ) {
    return this.svc.workbook({ supplier_id, category_id, search, coverage_days: coverage_days ? Number(coverage_days) : undefined, scope, warehouse_ids, group, page: page ? Number(page) : undefined, pageSize: pageSize ? Number(pageSize) : undefined, iad, only_overstock: only_overstock === 'true' || only_overstock === '1' });
  }

  @Get('workbook.xlsx')
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'RA-PRO.32.5 — Workbook del comprador a Excel: hoja "Todos" + UNA HOJA por proveedor (columnas por punto de compra) + hoja "Traspasos" (CEDIS→sucursal). Mismos filtros que /workbook; exporta TODO sin paginar.' })
  async workbookXlsx(
    @Res() res: Response,
    @Query('supplier_id') supplier_id?: string,
    @Query('category_id') category_id?: string,
    @Query('search') search?: string,
    @Query('coverage_days') coverage_days?: string,
    @Query('scope') scope?: string,
    @Query('warehouse_ids') warehouse_ids?: string,
    @Query('group') group?: string,
    @Query('iad') iad?: string,
    @Query('only_overstock') only_overstock?: string,
    @Query('flat') flat?: string,
  ) {
    // Mismos filtros que la tabla en pantalla (incluye group=desglosar/englobar + iad + sobrestock)
    // → el Excel refleja EXACTO lo que ve el comprador, sin paginar.
    const data = await this.svc.workbook({
      supplier_id, category_id, search, coverage_days: coverage_days ? Number(coverage_days) : undefined,
      scope, warehouse_ids, group,
      iad: iad === 'accel' || iad === 'decel' ? iad : undefined,
      only_overstock: only_overstock === 'true' || only_overstock === '1',
      export: true,
    });
    // Hoja "Traspasos" — mismos filtros estructurales (proveedor/categoría/búsqueda/cobertura).
    // Los traspasos son CEDIS→sucursal (cross-warehouse) → no se acotan por warehouse_ids ni por
    // iad/scope/sobrestock (refinamientos del pedido de compra); es la red completa en scope.
    const transfers = await this.svc.transferPlan({
      supplier_id, category_id, search,
      coverage_days: coverage_days ? Number(coverage_days) : undefined,
      export: true,
    });
    const payload = { coverage_days: data.coverage_days, territories: data.territories, rows: data.rows, transfers: transfers.rows };
    // Export unificado (canónico): hoja "Todos" (plano) + una hoja por proveedor + hoja "Traspasos".
    // `flat=true` conserva la variante de solo-plano (compat); default = unificado.
    const buf = (flat === 'true' || flat === '1')
      ? await this.exporter.buildWorkbookFlat(payload)
      : await this.exporter.buildWorkbookUnified(payload);
    sendXlsx(res, buf, this.exporter.fileNameWorkbook(data.coverage_days));
  }

  @Get('workbook/:productId')
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'RA-PRO.32 — Detalle drill-down de un SKU: economía + desglose por almacén de los 4 puntos de compra. coverage_days(=30).' })
  workbookDetail(
    @Param('productId') productId: string,
    @Query('coverage_days') coverage_days?: string,
  ) {
    return this.svc.workbookDetail(productId, coverage_days ? Number(coverage_days) : undefined);
  }

  @Get('critical-stock.xlsx')
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'Existencia crítica → Excel con diseño (mismos filtros que /critical-stock; exporta TODAS las filas del filtro, sin paginar).' })
  async criticalStockXlsx(
    @Res() res: Response,
    @Query('warehouse_id') warehouse_id?: string,
    @Query('warehouse_ids') warehouse_ids?: string,
    @Query('supplier_id') supplier_id?: string,
    @Query('category_id') category_id?: string,
    @Query('abc') abc?: string,
    @Query('xyz') xyz?: string,
    @Query('bucket') bucket?: string,
    @Query('source') source?: string,
    @Query('search') search?: string,
    @Query('target_basis') target_basis?: string,
    @Query('scope') scope?: string,
    @Query('sort_by') sort_by?: string,
    @Query('sort_dir') sort_dir?: string,
  ) {
    const report = await this.svc.criticalStock({
      warehouse_id, warehouse_ids, supplier_id, category_id, abc, xyz, bucket, source, search, target_basis, scope, sort_by, sort_dir,
      export: true,
    });
    const buf = await this.exporter.build(report);
    const filename = this.exporter.fileName(report);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename.replace(/[^ -~]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    res.setHeader('Content-Length', String(buf.length));
    res.end(buf);
  }

  @Post('pedido.xlsx')
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'Exporta un PEDIDO armado (cockpit/consolidado) a Excel con diseño. body = { title, supplier_name, warehouse_label, via, basis, source_warehouse_code, multi_warehouse, lines[] }.' })
  async pedidoXlsx(@Res() res: Response, @Body() body: PedidoExport) {
    const order: PedidoExport = { ...body, lines: Array.isArray(body?.lines) ? body.lines : [] };
    const buf = order.by_supplier
      ? await this.exporter.buildPedidoBySupplier(order)
      : await this.exporter.buildPedido(order);
    const name = order.by_supplier ? this.exporter.fileNameWorkbook(0) : this.exporter.fileNamePedido(order);
    sendXlsx(res, buf, name);
  }

  @Get('requisitions/:id/export.xlsx')
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'Exporta una requisición (header + líneas) a Excel con diseño.' })
  async requisitionXlsx(@Res() res: Response, @Param('id') id: string) {
    const r: any = await this.svc.getRequisition(id);
    const isTransfer = (r.lines || []).some((l: any) => l.source_type === 'branch');
    const order: PedidoExport = {
      title: `REQUISICIÓN ${r.folio}`,
      supplier_name: r.supplier_name,
      warehouse_label: [r.warehouse_code, r.warehouse_name].filter(Boolean).join(' · '),
      via: isTransfer ? 'transfer' : 'purchase',
      basis: r.target_basis,
      folio: r.folio,
      estado: REQ_ESTADO_LABEL[r.estado] ?? r.estado,
      lines: (r.lines || []).map((l: any) => ({
        sku: l.sku, nombre: l.nombre,
        on_hand: l.on_hand, in_transit: l.in_transit,
        reorder_point: l.reorder_point, max_stock: l.max_stock,
        suggested_qty: l.suggested_qty, piezas: l.final_qty,
        received_qty: l.received_qty,
        unit_cost: l.unit_cost, line_cost: l.line_cost,
      })),
    };
    const buf = await this.exporter.buildPedido(order);
    sendXlsx(res, buf, `Requisicion_${(r.folio || id).replace(/[^A-Za-z0-9]+/g, '_')}.xlsx`);
  }

  @Get('critical-stock/summary')
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'KPIs por bucket + costo sugerido + VALOR del punto de abasto (mín/reorden/máx) del filtro.' })
  summary(
    @Query('warehouse_id') warehouse_id?: string,
    @Query('warehouse_ids') warehouse_ids?: string,
    @Query('supplier_id') supplier_id?: string,
    @Query('search') search?: string,
    @Query('category_id') category_id?: string,
    @Query('target_basis') target_basis?: string,
  ) {
    return this.svc.summary({ warehouse_id, warehouse_ids, supplier_id, search, category_id, target_basis });
  }

  @Get('dead-stock')
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'Stock muerto: existencia SIN política de reorden (no rota → capital inmovilizado). Filtros: warehouse_id, warehouse_ids(CSV), supplier_id, search.' })
  deadStock(
    @Query('warehouse_id') warehouse_id?: string,
    @Query('warehouse_ids') warehouse_ids?: string,
    @Query('supplier_id') supplier_id?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.svc.deadStock({ warehouse_id, warehouse_ids, supplier_id, search, page: page ? Number(page) : undefined, pageSize: pageSize ? Number(pageSize) : undefined });
  }

  @Get('filters')
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'Almacenes + proveedores + categorías de compra con política (para los selects del frontend).' })
  filters() { return this.svc.filters(); }

  @Get('categories')
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'RA-PRO.12 — categorías de compra con # productos / # proveedores + flag de duplicado (normalización).' })
  listCategories(@Query('search') search?: string) { return this.svc.listCategories({ search }); }

  @Post('categories/merge')
  @RequirePermissions(Permission.COMPRAS_GESTIONAR)
  @ApiOperation({ summary: 'RA-PRO.12 — fusiona categorías: repunta productos de from_ids[] → into_id y soft-borra las fusionadas.' })
  mergeCategories(@Body() body: { into_id: string; from_ids: string[] }) { return this.svc.mergeCategories(body?.into_id, body?.from_ids || []); }

  @Post('categories/auto-dedup')
  @RequirePermissions(Permission.COMPRAS_GESTIONAR)
  @ApiOperation({ summary: 'RA-PRO.12 — auto-fusiona categorías de NOMBRE IDÉNTICO (canónica = la de más productos).' })
  autoDedupCategories() { return this.svc.autoDedupCategories(); }

  @Post('categories/:id/rename')
  @RequirePermissions(Permission.COMPRAS_GESTIONAR)
  @ApiOperation({ summary: 'RA-PRO.12 — renombra una categoría.' })
  renameCategory(@Param('id') id: string, @Body() body: { name: string }) { return this.svc.renameCategory(id, body?.name); }

  @Get('worklist')
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'RA-PRO.8 — "Qué toca": ciclos de reabasto por almacén×proveedor (canal compra/traspaso + cadencia + próximo pedido + sugerido por horizonte). Filtros: warehouse_id(s), via(purchase|transfer), status(due), search.' })
  worklist(
    @Query('warehouse_id') warehouse_id?: string,
    @Query('warehouse_ids') warehouse_ids?: string,
    @Query('via') via?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('target_basis') target_basis?: string,
    @Query('category_id') category_id?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.svc.worklist({ warehouse_id, warehouse_ids, via, status, search, target_basis, category_id, page: page ? Number(page) : undefined, pageSize: pageSize ? Number(pageSize) : undefined });
  }

  @Get('requisitions')
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'Lista de requisiciones. Filtros: estado, warehouse_id.' })
  listRequisitions(
    @Query('estado') estado?: string,
    @Query('warehouse_id') warehouse_id?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.svc.listRequisitions({ estado, warehouse_id, page: page ? Number(page) : undefined, pageSize: pageSize ? Number(pageSize) : undefined });
  }

  @Get('requisitions/:id')
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'Detalle de una requisición (header + líneas).' })
  getRequisition(@Param('id') id: string) { return this.svc.getRequisition(id); }

  @Post('requisitions')
  @RequirePermissions(Permission.COMPRAS_GESTIONAR)
  @ApiOperation({ summary: 'Crea una requisición desde el sugerido (estado pending_approval).' })
  createRequisition(@Body() dto: CreateRequisitionDto) { return this.svc.createRequisition(dto); }

  @Post('requisitions/:id/approve')
  @RequirePermissions(Permission.COMPRAS_GESTIONAR)
  @ApiOperation({ summary: 'Aprueba una requisición (pending_approval → approved).' })
  approve(@Param('id') id: string) { return this.svc.approve(id); }

  @Post('requisitions/:id/reject')
  @RequirePermissions(Permission.COMPRAS_GESTIONAR)
  @ApiOperation({ summary: 'Rechaza una requisición (pending_approval → cancelled).' })
  reject(@Param('id') id: string) { return this.svc.reject(id); }

  @Post('requisitions/:id/order')
  @RequirePermissions(Permission.COMPRAS_GESTIONAR)
  @ApiOperation({ summary: 'RA.14 — marca la requisición como ordenada/en tránsito (approved → ordered).' })
  markOrdered(@Param('id') id: string) { return this.svc.markOrdered(id); }

  @Post('requisitions/:id/receive')
  @RequirePermissions(Permission.COMPRAS_GESTIONAR)
  @ApiOperation({ summary: 'RA.14 — marca recibida (ordered → received) + captura cantidades recibidas por línea (fill rate).' })
  markReceived(@Param('id') id: string, @Body() dto?: ReceiveRequisitionDto) { return this.svc.markReceived(id, dto); }

  @Get('findings')
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'RA.8 — bandeja de hallazgos de reabastecimiento. Filtros: status(open|resolved), kind(agotado_abc|bajo_reorden), warehouse_id.' })
  listFindings(
    @Query('status') status?: string,
    @Query('kind') kind?: string,
    @Query('warehouse_id') warehouse_id?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.svc.listFindings({ status, kind, warehouse_id, page: page ? Number(page) : undefined, pageSize: pageSize ? Number(pageSize) : undefined });
  }

  @Post('scan-now')
  @RequirePermissions(Permission.COMPRAS_GESTIONAR)
  @ApiOperation({ summary: 'RA.8 — corre el scanner de reabastecimiento para el tenant actual (el cron lo corre nocturno).' })
  scanNow() { return this.svc.scanNow(); }

  @Post('suppliers/:id/min-boxes')
  @RequirePermissions(Permission.COMPRAS_GESTIONAR)
  @ApiOperation({ summary: 'RA.13a — pedido mínimo del proveedor EN CAJAS (captura manual; body { boxes }).' })
  setSupplierMinBoxes(@Param('id') id: string, @Body() body: { boxes: number | null }) {
    return this.svc.setSupplierMinBoxes(id, body?.boxes ?? null);
  }

  @Get('suppliers')
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'RA-PRO.3 — proveedores con parámetros de compra (lead time + mínimo en cajas + # productos).' })
  listSuppliers(@Query('search') search?: string) { return this.svc.listSuppliers({ search }); }

  @Post('suppliers/:id/lead-time')
  @RequirePermissions(Permission.COMPRAS_GESTIONAR)
  @ApiOperation({ summary: 'RA-PRO.3 — lead time del proveedor en DÍAS (captura manual; Kepler no lo trae; body { days }).' })
  setSupplierLeadTime(@Param('id') id: string, @Body() body: { days: number | null }) {
    return this.svc.setSupplierLeadTime(id, body?.days ?? null);
  }

  @Post('suppliers/:id/order-params')
  @RequirePermissions(Permission.COMPRAS_GESTIONAR)
  @ApiOperation({ summary: 'RA-PRO.10/27 — parámetros de pedido por proveedor: cadencia/colchón (días), mínimo en $/cajas, y personalización RA-PRO.27: fill_rate_override (0..1 o %), safety_pct (0..100), coverage_days_override.' })
  setSupplierOrderParams(@Param('id') id: string, @Body() body: { cadence_days_override?: number | null; colchon_days?: number | null; min_order_amount?: number | null; min_order_boxes?: number | null; fill_rate_override?: number | null; safety_pct?: number | null; coverage_days_override?: number | null }) {
    return this.svc.setSupplierOrderParams(id, body ?? {});
  }

  // ── RA-PRO.27 — parámetros globales del pedido (fill rate + cobertura) ──
  @Get('settings')
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'RA-PRO.27 — parámetros globales del pedido sugerido (ventana/mínimo/tope del fill rate + cobertura default).' })
  getSettings() { return this.svc.getReplenishmentSettings(); }

  @Post('settings')
  @RequirePermissions(Permission.COMPRAS_GESTIONAR)
  @ApiOperation({ summary: 'RA-PRO.27 — edita los parámetros globales. body { fill_window_days, fill_min_lines, fill_max_inflate, default_coverage_days }.' })
  updateSettings(@Body() body: { fill_window_days?: number; fill_min_lines?: number; fill_max_inflate?: number; default_coverage_days?: number }) {
    return this.svc.updateReplenishmentSettings(body ?? {});
  }

  @Post('products/:id/unit-override')
  @RequirePermissions(Permission.COMPRAS_GESTIONAR)
  @ApiOperation({ summary: 'RA-PRO.28 — override manual de unidad de venta. body { pieces_per_unit, box_factor, sold_as, note }. Ambos null = borra (vuelve a auto).' })
  setProductUnitOverride(@Param('id') id: string, @Body() body: { pieces_per_unit?: number | null; box_factor?: number | null; sold_as?: string | null; note?: string | null }) {
    return this.svc.setProductUnitOverride(id, body ?? {});
  }

  @Get('suppliers/:id/order')
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'RA-PRO.10 — pedido consolidado al proveedor (todos sus almacenes de compra), horizonte cadencia+colchón, subido al mínimo (por proveedor total) repartiendo en los que más rotan.' })
  supplierOrder(@Param('id') id: string) { return this.svc.supplierOrder(id); }

  @Get('suppliers/:id/order-history')
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'RA-PRO — histórico de compras al proveedor (X-A-40 / Wincaja) por día de entrega → tamaño típico de orden. Opcional warehouse_id (el de compra; para traspasos pásale el hub origen).' })
  supplierOrderHistory(@Param('id') id: string, @Query('warehouse_id') warehouse_id?: string) {
    return this.svc.supplierOrderHistory(id, warehouse_id);
  }

  @Get('network')
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'RA-PRO.6 — topología de red de abasto (almacenes + su CEDIS origen; DRP).' })
  networkTopology() { return this.svc.networkTopology(); }

  @Post('warehouses/:id/source')
  @RequirePermissions(Permission.COMPRAS_GESTIONAR)
  @ApiOperation({ summary: 'RA-PRO.6 — fija el CEDIS que surte a una sucursal (body { source_warehouse_id } | null = es CEDIS).' })
  setWarehouseSource(@Param('id') id: string, @Body() body: { source_warehouse_id: string | null }) {
    return this.svc.setWarehouseSource(id, body?.source_warehouse_id ?? null);
  }
}
