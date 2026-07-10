import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { CommercialReplenishmentService, CreateRequisitionDto, ReceiveRequisitionDto } from './commercial-replenishment.service';

/**
 * RA.4/RA.7 — Proyecto Compras (ADR-030). Existencia crítica + sugerido + requisiciones.
 * VER = lectura del reporte y requisiciones · GESTIONAR = crear/aprobar/rechazar requisición.
 */
@ApiTags('commercial-replenishment')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/replenishment')
export class CommercialReplenishmentController {
  constructor(private readonly svc: CommercialReplenishmentService) {}

  @Get('critical-stock')
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'Existencia crítica: existencia vs mín/reorden/máx + sugerido. Filtros: warehouse_id, warehouse_ids(CSV), supplier_id, abc, bucket, source, search, target_basis(min|reorder|max), scope(all).' })
  criticalStock(
    @Query('warehouse_id') warehouse_id?: string,
    @Query('warehouse_ids') warehouse_ids?: string,
    @Query('supplier_id') supplier_id?: string,
    @Query('abc') abc?: string,
    @Query('xyz') xyz?: string,
    @Query('bucket') bucket?: string,
    @Query('source') source?: string,
    @Query('search') search?: string,
    @Query('target_basis') target_basis?: string,
    @Query('scope') scope?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.svc.criticalStock({ warehouse_id, warehouse_ids, supplier_id, abc, xyz, bucket, source, search, target_basis, scope, page: page ? Number(page) : undefined, pageSize: pageSize ? Number(pageSize) : undefined });
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

  @Get('filters')
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'Almacenes + proveedores con política de reorden (para los selects del frontend).' })
  filters() { return this.svc.filters(); }

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
}
