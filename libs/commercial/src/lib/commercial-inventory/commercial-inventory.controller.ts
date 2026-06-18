import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import {
  CommercialInventoryService,
  RecordMovementDto,
  AdjustStockDto,
  StockMovementType,
} from './commercial-inventory.service';
import { RolesGuard } from '@megadulces/platform-core';
import { RequirePermissions } from '@megadulces/platform-core';
import { Permission } from '@megadulces/platform-core';

@ApiTags('commercial-inventory')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/inventory')
export class CommercialInventoryController {
  constructor(private readonly service: CommercialInventoryService) {}

  @Get('stock')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_VER)
  @ApiOperation({ summary: 'Listar saldo de stock (paginado)' })
  listStock(
    @Query('warehouse_id') warehouseId?: string,
    @Query('product_id') productId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.listStock({
      warehouse_id: warehouseId,
      product_id: productId,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get('stock/:warehouse_id/:product_id')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_VER)
  @ApiOperation({ summary: 'Saldo puntual de un producto en un almacén' })
  getStock(
    @Param('warehouse_id') warehouseId: string,
    @Param('product_id') productId: string,
  ) {
    return this.service.getStockForProduct(warehouseId, productId);
  }

  @Get('stock/:warehouse_id/:product_id/lots')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_VER)
  @ApiOperation({ summary: 'Lotes (lote + caducidad) de un producto en un almacén, orden FEFO (P2.1b)' })
  getLots(
    @Param('warehouse_id') warehouseId: string,
    @Param('product_id') productId: string,
  ) {
    return this.service.listLots(warehouseId, productId);
  }

  @Post('movements')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_AJUSTAR)
  @ApiOperation({
    summary:
      'Registrar movimiento de inventario (in/out/reserve/release/sale/adjust). Solo ops/admin — el flujo de pedidos dispara reserve/sale/release internamente y NO debería usar este endpoint.',
  })
  recordMovement(@Body() body: RecordMovementDto) {
    return this.service.recordMovement(body);
  }

  @Post('adjust')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_AJUSTAR)
  @ApiOperation({ summary: 'Ajuste a saldo deseado (auditoría física)' })
  adjust(@Body() body: AdjustStockDto) {
    return this.service.adjustStock(body);
  }

  @Get('movements')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_AJUSTAR)
  @ApiOperation({
    summary:
      'Bitácora de movimientos (paginado, filtros). Gate AJUSTAR (no VER) porque el audit log expone operaciones internas — customer_b2b con INVENTORY_VER ve saldos disponibles, no la bitácora.',
  })
  listMovements(
    @Query('warehouse_id') warehouseId?: string,
    @Query('product_id') productId?: string,
    @Query('movement_type') movementType?: StockMovementType,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.listMovements({
      warehouse_id: warehouseId,
      product_id: productId,
      movement_type: movementType,
      from,
      to,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }
}
