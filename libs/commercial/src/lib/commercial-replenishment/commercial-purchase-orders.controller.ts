import { Body, Controller, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { CommercialPurchaseOrdersService, CreatePurchaseOrderDto, CreateReceiptDto } from './commercial-purchase-orders.service';
import { ReplenishmentExportService, PedidoExport } from './replenishment-export.service';

const PO_ESTADO_LABEL: Record<string, string> = {
  open: 'Abierta', partial: 'Parcial', received: 'Recibida', cancelled: 'Cancelada',
};

/**
 * RA.15 — Cadena de compra (ADR-031). OC (orden de compra) + OE (orden de entrada/recepción).
 * VER = lectura · GESTIONAR = generar OC, cancelar, recibir (mueve stock).
 */
@ApiTags('commercial-purchase-orders')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/purchase-orders')
export class CommercialPurchaseOrdersController {
  constructor(
    private readonly svc: CommercialPurchaseOrdersService,
    private readonly exporter: ReplenishmentExportService,
  ) {}

  @Get()
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'Lista de órdenes de compra. Filtros: estado(open|partial|received|cancelled), supplier_id, warehouse_id.' })
  list(
    @Query('estado') estado?: string,
    @Query('supplier_id') supplier_id?: string,
    @Query('warehouse_id') warehouse_id?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.svc.listPurchaseOrders({ estado, supplier_id, warehouse_id, page: page ? Number(page) : undefined, pageSize: pageSize ? Number(pageSize) : undefined });
  }

  @Get(':id')
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'Detalle de OC: header + líneas (pedido vs recibido) + recepciones (OE).' })
  get(@Param('id') id: string) { return this.svc.getPurchaseOrder(id); }

  @Get(':id/export.xlsx')
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'Exporta la orden de compra (header + líneas) a Excel con diseño.' })
  async exportXlsx(@Res() res: Response, @Param('id') id: string) {
    const p: any = await this.svc.getPurchaseOrder(id);
    const isTransfer = p.source_type === 'branch';
    const order: PedidoExport = {
      title: `ORDEN DE COMPRA ${p.folio}`,
      supplier_name: p.supplier_name,
      warehouse_label: [p.warehouse_code, p.warehouse_name].filter(Boolean).join(' · '),
      via: isTransfer ? 'transfer' : 'purchase',
      source_warehouse_code: p.source_code,
      folio: p.folio,
      estado: PO_ESTADO_LABEL[p.estado] ?? p.estado,
      lines: (p.lines || []).map((l: any) => ({
        sku: l.sku, nombre: l.nombre,
        piezas: l.ordered_qty,
        received_qty: l.received_qty,
        unit_cost: l.unit_cost, line_cost: l.line_cost,
      })),
    };
    const buf = await this.exporter.buildPedido(order);
    const filename = `Orden_Compra_${(p.folio || id).replace(/[^A-Za-z0-9]+/g, '_')}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename.replace(/[^ -~]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    res.setHeader('Content-Length', String(buf.length));
    res.end(buf);
  }

  @Post()
  @RequirePermissions(Permission.COMPRAS_GESTIONAR)
  @ApiOperation({ summary: 'Crea una OC directa (sin requisición previa; espeja las OCs directas de Kepler).' })
  create(@Body() dto: CreatePurchaseOrderDto) { return this.svc.createPurchaseOrder(dto); }

  @Post('from-requisition/:requisitionId')
  @RequirePermissions(Permission.COMPRAS_GESTIONAR)
  @ApiOperation({ summary: 'Genera la OC desde una requisición aprobada (RQ→ordered). body opcional { expected_date, notes }.' })
  fromRequisition(@Param('requisitionId') requisitionId: string, @Body() body?: { expected_date?: string | null; notes?: string }) {
    return this.svc.createFromRequisition(requisitionId, body);
  }

  @Post(':id/cancel')
  @RequirePermissions(Permission.COMPRAS_GESTIONAR)
  @ApiOperation({ summary: 'Cancela una OC (solo si no tiene recepciones).' })
  cancel(@Param('id') id: string) { return this.svc.cancelPurchaseOrder(id); }

  @Post(':id/receipts')
  @RequirePermissions(Permission.COMPRAS_GESTIONAR)
  @ApiOperation({ summary: 'Registra una recepción (OE) contra la OC. Permite parciales. Al confirmar MUEVE stock. body { lines:[{po_line_id, received_qty, unit_cost?}], notes?, received_at? }.' })
  receive(@Param('id') id: string, @Body() dto: CreateReceiptDto) { return this.svc.createReceipt(id, dto); }
}
