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
    const buf = await this.exporter.buildPedido(order);
    sendXlsx(res, buf, this.exporter.fileNamePedido(order));
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
  @ApiOperation({ summary: 'KPIs por bucket (agotado/bajo mínimo/bajo reorden/sobrestock) + costo sugerido.' })
  summary(
    @Query('warehouse_id') warehouse_id?: string,
    @Query('warehouse_ids') warehouse_ids?: string,
    @Query('supplier_id') supplier_id?: string,
    @Query('target_basis') target_basis?: string,
  ) {
    return this.svc.summary({ warehouse_id, warehouse_ids, supplier_id, target_basis });
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
  @ApiOperation({ summary: 'RA-PRO.10 — parámetros de pedido: cadencia override (días), colchón (días), mínimo de compra en $ y/o cajas. body { cadence_days_override, colchon_days, min_order_amount, min_order_boxes }.' })
  setSupplierOrderParams(@Param('id') id: string, @Body() body: { cadence_days_override?: number | null; colchon_days?: number | null; min_order_amount?: number | null; min_order_boxes?: number | null }) {
    return this.svc.setSupplierOrderParams(id, body ?? {});
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
