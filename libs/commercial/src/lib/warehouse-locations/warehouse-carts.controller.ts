import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireAuthGuard, RolesGuard, RequirePermissions, RequireAnyPermission, Permission } from '@megadulces/platform-core';
import type { BulkCartsBody, BulkCartsResult, CartRow, CartsResponse, OccupyCartBody, OccupyCartResult, WaveCartsResponse } from '@megadulces/contracts';
import { WarehouseCartsService } from './warehouse-carts.service';

/**
 * `[GP.11.4]` Carretas y carritos (FASE_GP paso 4). El permiso de cada acción lo pone el guard, no el
 * servicio: deshacer es de quien surte, liberar a mano es del coordinador, dar de alta es de quien gestiona
 * ubicaciones.
 */
@ApiTags('warehouse-carts')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('warehouse/carts')
export class WarehouseCartsController {
  constructor(private readonly svc: WarehouseCartsService) {}

  @Get()
  @RequireAnyPermission(Permission.COMMERCIAL_PICKING_VER, Permission.ALMACEN_UBICACIONES_VER, Permission.ALMACEN_UBICACIONES_GESTIONAR)
  @ApiOperation({ summary: 'Carretas y carritos del almacén, con el pedido que trae cada una' })
  list(@Query('warehouse_id') warehouseId: string): Promise<CartsResponse> {
    return this.svc.list(warehouseId);
  }

  @Get('ola/:waveId')
  @RequirePermissions(Permission.COMMERCIAL_PICKING_VER)
  @ApiOperation({ summary: 'Las carretas con que se surte una ola, y si es una tanda (por ahora sin carreta)' })
  forWave(@Param('waveId') waveId: string): Promise<WaveCartsResponse> {
    return this.svc.forWave(waveId);
  }

  @Post('bulk')
  @RequirePermissions(Permission.ALMACEN_UBICACIONES_GESTIONAR)
  @ApiOperation({ summary: 'Alta por rango (C01–C99); las que ya existen no se tocan' })
  bulk(@Body() body: BulkCartsBody): Promise<BulkCartsResult> {
    return this.svc.bulk(body);
  }

  @Post('occupy')
  @RequirePermissions(Permission.COMMERCIAL_PICKING_GESTIONAR)
  @ApiOperation({ summary: 'Escanear una carreta para el pedido que se surte (D7: una carreta, un pedido)' })
  occupy(@Body() body: OccupyCartBody): Promise<OccupyCartResult> {
    return this.svc.occupy(body);
  }

  @Post(':id/undo')
  @RequirePermissions(Permission.COMMERCIAL_PICKING_GESTIONAR)
  @ApiOperation({ summary: 'Deshacer: quien escaneó la carreta por error la suelta mientras surte' })
  undo(@Param('id') id: string): Promise<CartRow> {
    return this.svc.release(id, 'deshecho');
  }

  @Post(':id/release')
  @RequirePermissions(Permission.ALMACEN_SURTIDO_COORDINAR)
  @ApiOperation({ summary: 'Liberar a mano (coordinador), provisional hasta que el embarque la libere al cargar' })
  release(@Param('id') id: string): Promise<CartRow> {
    return this.svc.release(id, 'manual');
  }
}
