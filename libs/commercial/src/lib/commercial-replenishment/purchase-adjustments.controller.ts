import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { PurchaseAdjustmentsService } from './purchase-adjustments.service';

/**
 * RE.10 — Descuentos y ajustes de compra (X-D-40 / X-D-55). Proyecto Compras.
 * Read-only sobre `analytics.erp_purchase_adjustments`. VER = lectura.
 * Hace visible el canal de descuentos/apoyos ($20M) + facturas duplicadas ($6.7M)
 * que el Excel de recepción nunca capturó.
 */
@ApiTags('commercial-purchase-adjustments')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/purchase-adjustments')
export class PurchaseAdjustmentsController {
  constructor(private readonly svc: PurchaseAdjustmentsService) {}

  @Get('summary')
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'RE.10 — resumen: total + por grupo (comercial/operacional/error de captura) + por categoría + por doctype. Filtros: doctype, categoria, grupo, search, date_from, date_to.' })
  summary(
    @Query('doctype') doctype?: string,
    @Query('categoria') categoria?: string,
    @Query('grupo') grupo?: string,
    @Query('search') search?: string,
    @Query('date_from') date_from?: string,
    @Query('date_to') date_to?: string,
  ) {
    return this.svc.summary({ doctype, categoria, grupo, search, date_from, date_to });
  }

  @Get()
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'RE.10 — lista paginada de ajustes de compra. Filtros: doctype, categoria, grupo, search, date_from, date_to, page, pageSize.' })
  list(
    @Query('doctype') doctype?: string,
    @Query('categoria') categoria?: string,
    @Query('grupo') grupo?: string,
    @Query('search') search?: string,
    @Query('date_from') date_from?: string,
    @Query('date_to') date_to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.svc.list({ doctype, categoria, grupo, search, date_from, date_to, page: page ? Number(page) : undefined, pageSize: pageSize ? Number(pageSize) : undefined });
  }

  @Get('for-entrada')
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'RE.2 — ajustes (X-D-40/55) que EXPLICAN el descuadre de una entrada: por entrada_folio exacto (cuando existe) o por proveedor + ventana de fecha (window_days, default 15). Params: proveedor_code, entrada_folio, date, window_days.' })
  forEntrada(
    @Query('proveedor_code') proveedor_code?: string,
    @Query('entrada_folio') entrada_folio?: string,
    @Query('date') date?: string,
    @Query('window_days') window_days?: string,
  ) {
    return this.svc.forEntrada({ proveedor_code, entrada_folio, date, window_days: window_days ? Number(window_days) : undefined });
  }

  @Get('duplicates')
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'RE.10 — posibles facturas DUPLICADAS: entradas del mismo proveedor con el MISMO monto exacto repetido dentro de N días (window_days, default 30). Control proactivo HITL sobre las entradas reales.' })
  duplicates(@Query('window_days') window_days?: string) {
    return this.svc.potentialDuplicates(window_days ? Number(window_days) : undefined);
  }

  @Get('by-supplier')
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'RE.10 — top proveedores por $ de ajustes (apoyos/descuentos/duplicadas). Mismos filtros que summary.' })
  bySupplier(
    @Query('doctype') doctype?: string,
    @Query('categoria') categoria?: string,
    @Query('grupo') grupo?: string,
    @Query('search') search?: string,
    @Query('date_from') date_from?: string,
    @Query('date_to') date_to?: string,
  ) {
    return this.svc.bySupplier({ doctype, categoria, grupo, search, date_from, date_to });
  }
}
