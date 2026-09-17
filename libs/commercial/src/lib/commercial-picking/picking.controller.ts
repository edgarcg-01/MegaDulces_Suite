import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  RequireAuthGuard,
  RolesGuard,
  RequirePermissions,
  Permission,
} from '@megadulces/platform-core';
import { CreateWaveDto, PickingService } from './picking.service';

/**
 * SU.2 — Pool de pedidos por surtir y olas de surtido (Fase SU, ADR-067).
 *
 * Vive bajo `almacen/` y no bajo `commercial/` a propósito: el pool y la ola son trabajo de piso.
 * El pedido —su estado comercial, su precio, su cliente— sigue siendo de `commercial/orders`.
 */
@ApiTags('almacen-surtido')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('almacen/surtido')
export class PickingController {
  constructor(private readonly service: PickingService) {}

  @Get('pool')
  @RequirePermissions(Permission.COMMERCIAL_PICKING_VER)
  @ApiOperation({
    summary:
      'Pedidos confirmados que todavía no están en ninguna ola. Declara que lo capturado sin señal aún no llegó.',
  })
  pool(
    @Query('warehouse_id') warehouseId?: string,
    @Query('delivery_date') deliveryDate?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.pool({
      warehouse_id: warehouseId,
      delivery_date: deliveryDate,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('waves')
  @RequirePermissions(Permission.COMMERCIAL_PICKING_VER)
  @ApiOperation({ summary: 'Lista de olas (bandeja del jefe de almacén).' })
  list(@Query('status') status?: string) {
    return this.service.list(status);
  }

  @Get('waves/:id')
  @RequirePermissions(Permission.COMMERCIAL_PICKING_VER)
  @ApiOperation({
    summary:
      'Detalle de la ola: pedidos + consolidado por SKU con su unidad y el desglose por pedido.',
  })
  byId(@Param('id') id: string) {
    return this.service.byId(id);
  }

  @Post('waves')
  @RequirePermissions(Permission.COMMERCIAL_PICKING_GESTIONAR)
  @ApiOperation({ summary: 'Arma una ola con los pedidos dados (folio W-YYYY-NNNNN).' })
  create(@Body() dto: CreateWaveDto) {
    return this.service.createWave(dto);
  }

  @Post('waves/:id/assign')
  @RequirePermissions(Permission.COMMERCIAL_PICKING_GESTIONAR)
  @ApiOperation({ summary: 'Asigna o reasigna la ola a un surtidor.' })
  assign(@Param('id') id: string, @Body() body: { assigned_to: string }) {
    return this.service.assign(id, body?.assigned_to);
  }

  @Post('waves/:id/cancel')
  @RequirePermissions(Permission.COMMERCIAL_PICKING_GESTIONAR)
  @ApiOperation({ summary: 'Cancela la ola; sus pedidos vuelven solos al pool.' })
  cancel(@Param('id') id: string, @Body() body: { reason?: string }) {
    return this.service.cancelWave(id, body?.reason);
  }
}
