import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { CommercialReplenishmentService, CreateRequisitionDto } from './commercial-replenishment.service';

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
  @ApiOperation({ summary: 'Existencia crítica: existencia vs mín/reorden/máx + sugerido. Filtros: warehouse_id, supplier_id, abc, bucket, source, search, target_basis(min|reorder|max), scope(all).' })
  criticalStock(
    @Query('warehouse_id') warehouse_id?: string,
    @Query('supplier_id') supplier_id?: string,
    @Query('abc') abc?: string,
    @Query('bucket') bucket?: string,
    @Query('source') source?: string,
    @Query('search') search?: string,
    @Query('target_basis') target_basis?: string,
    @Query('scope') scope?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.svc.criticalStock({ warehouse_id, supplier_id, abc, bucket, source, search, target_basis, scope, page: page ? Number(page) : undefined, pageSize: pageSize ? Number(pageSize) : undefined });
  }

  @Get('critical-stock/summary')
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'KPIs por bucket (agotado/bajo mínimo/bajo reorden/sobrestock) + costo sugerido.' })
  summary(
    @Query('warehouse_id') warehouse_id?: string,
    @Query('supplier_id') supplier_id?: string,
    @Query('target_basis') target_basis?: string,
  ) {
    return this.svc.summary({ warehouse_id, supplier_id, target_basis });
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
}
