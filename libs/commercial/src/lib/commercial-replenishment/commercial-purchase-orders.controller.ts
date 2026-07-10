import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { CommercialPurchaseOrdersService, CreatePurchaseOrderDto, CreateReceiptDto } from './commercial-purchase-orders.service';

/**
 * RA.15 — Cadena de compra (ADR-031). OC (orden de compra) + OE (orden de entrada/recepción).
 * VER = lectura · GESTIONAR = generar OC, cancelar, recibir (mueve stock).
 */
@ApiTags('commercial-purchase-orders')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/purchase-orders')
export class CommercialPurchaseOrdersController {
  constructor(private readonly svc: CommercialPurchaseOrdersService) {}

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
