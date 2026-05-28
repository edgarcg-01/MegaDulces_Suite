import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import {
  CommercialInventoryService,
  RecordMovementDto,
  AdjustStockDto,
  StockMovementType,
} from './commercial-inventory.service';

@ApiTags('commercial-inventory')
@Controller('commercial/inventory')
export class CommercialInventoryController {
  constructor(private readonly service: CommercialInventoryService) {}

  @Get('stock')
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
  @ApiOperation({ summary: 'Saldo puntual de un producto en un almacén' })
  getStock(
    @Param('warehouse_id') warehouseId: string,
    @Param('product_id') productId: string,
  ) {
    return this.service.getStockForProduct(warehouseId, productId);
  }

  @Post('movements')
  @ApiOperation({
    summary:
      'Registrar movimiento de inventario (in/out/reserve/release/sale/adjust)',
  })
  recordMovement(@Body() body: RecordMovementDto) {
    return this.service.recordMovement(body);
  }

  @Post('adjust')
  @ApiOperation({ summary: 'Ajuste a saldo deseado (auditoría física)' })
  adjust(@Body() body: AdjustStockDto) {
    return this.service.adjustStock(body);
  }

  @Get('movements')
  @ApiOperation({ summary: 'Bitácora de movimientos (paginado, filtros)' })
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
