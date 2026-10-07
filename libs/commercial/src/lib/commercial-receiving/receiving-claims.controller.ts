import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { ReceivingClaimsService } from './receiving-claims.service';

/**
 * **WMS-REC.8 — bandeja de reclamos de recepción (ADR-053).**
 *
 * Gateada con `COMPRAS_HALLAZGOS_*`, el permiso de la bandeja que ya existe: el que abre
 * esto todos los días es el comprador —el que tiene palanca con el proveedor y ya vive en
 * `/compras/*`—, y reusarlo evita un permiso nuevo (y por lo tanto un backfill y un
 * re-login) para la misma persona. El crosswalk de traspasos pide
 * `COMMERCIAL_WAREHOUSES_GESTIONAR`, igual que el mapa sucursal→almacén del vale: es
 * configuración de almacenes, no seguimiento de reclamos.
 */
@ApiTags('commercial-receiving')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/receiving/claims')
export class ReceivingClaimsController {
  constructor(private readonly service: ReceivingClaimsService) {}

  @Get()
  @RequirePermissions(Permission.COMPRAS_HALLAZGOS_VER)
  @ApiOperation({
    summary:
      'Bandeja de reclamos de recepción: estado, responsable (proveedor vs sucursal que embarcó), monto y antigüedad. ' +
      'Filtros: status (o `abiertos`), responsible_kind, kind, supplier_id, warehouse_id, date_from/date_to, search.',
  })
  list(
    @Query('status') status?: string,
    @Query('responsible_kind') responsibleKind?: string,
    @Query('kind') kind?: string,
    @Query('supplier_id') supplierId?: string,
    @Query('warehouse_id') warehouseId?: string,
    @Query('date_from') dateFrom?: string,
    @Query('date_to') dateTo?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.list({
      status,
      responsible_kind: responsibleKind,
      kind,
      supplier_id: supplierId,
      warehouse_id: warehouseId,
      date_from: dateFrom,
      date_to: dateTo,
      search,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get('by-supplier')
  @RequirePermissions(Permission.COMPRAS_PROVEEDORES_VER)
  @ApiOperation({ summary: 'Reclamos agregados por proveedor (alimenta el scorecard de /compras/proveedores).' })
  bySupplier(@Query('window_days') windowDays?: string) {
    return this.service.bySupplier({ window_days: windowDays ? Number(windowDays) : undefined });
  }

  @Get('transfer-origins')
  @RequirePermissions(Permission.COMPRAS_HALLAZGOS_VER)
  @ApiOperation({
    summary:
      'Crosswalk capturado a mano TI### → almacén que embarcó, + los códigos de traspaso que ya llegaron y siguen sin dueño.',
  })
  transferOrigins() {
    return this.service.listTransferOrigins();
  }

  @Post('transfer-origins')
  @RequirePermissions(Permission.COMMERCIAL_WAREHOUSES_GESTIONAR)
  @ApiOperation({
    summary:
      'Captura el almacén que embarcó un TI### (decisión humana: el ERP no permite deducirla). Asigna los reclamos de ese código que estaban sin dueño.',
  })
  setTransferOrigin(@Body() body: { code: string; warehouse_id: string; note?: string }) {
    return this.service.setTransferOrigin(body?.code, body?.warehouse_id, body?.note);
  }

  @Get(':id')
  @RequirePermissions(Permission.COMPRAS_HALLAZGOS_VER)
  @ApiOperation({ summary: 'Detalle de un reclamo (renglón, vale, responsable, monto y seguimiento).' })
  detail(@Param('id') id: string) {
    return this.service.detail(id);
  }

  @Post(':id/claim')
  @RequirePermissions(Permission.COMPRAS_HALLAZGOS_GESTIONAR)
  @ApiOperation({ summary: 'Marca el reclamo como pasado al responsable (canal + nota).' })
  markClaimed(@Param('id') id: string, @Body() body: { channel?: string; note?: string }) {
    return this.service.markClaimed(id, body || {});
  }

  @Post(':id/qty')
  @RequirePermissions(Permission.COMPRAS_HALLAZGOS_GESTIONAR)
  @ApiOperation({
    summary:
      'Captura la cantidad reclamada de un dañado / producto_incorrecto (el andén no la tiene y no se le suma un toque al camión). Recalcula el monto.',
  })
  setQty(@Param('id') id: string, @Body() body: { qty_claimed: number }) {
    return this.service.setQty(id, body?.qty_claimed);
  }

  @Post(':id/resolve')
  @RequirePermissions(Permission.COMPRAS_HALLAZGOS_GESTIONAR)
  @ApiOperation({
    summary:
      'Cierra el reclamo: accepted (lo reconoció) · discarded (era error de conteo nuestro, exige motivo y NO penaliza el fill rate) · written_off (perdido).',
  })
  resolve(@Param('id') id: string, @Body() body: { resolution: string; note?: string }) {
    return this.service.resolve(id, body || ({} as any));
  }
}
