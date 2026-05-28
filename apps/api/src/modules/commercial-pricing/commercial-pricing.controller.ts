import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import {
  CommercialPricingService,
  CreatePriceListDto,
  UpdatePriceListDto,
  BulkUpsertProductPricesDto,
} from './commercial-pricing.service';

@ApiTags('commercial-pricing')
@Controller('commercial')
export class CommercialPricingController {
  constructor(private readonly service: CommercialPricingService) {}

  // ───── price_lists ─────

  @Post('price-lists')
  @ApiOperation({ summary: 'Crear price list' })
  createPriceList(@Body() body: CreatePriceListDto) {
    return this.service.createPriceList(body);
  }

  @Get('price-lists')
  @ApiOperation({ summary: 'Listar price lists' })
  listPriceLists(@Query('active') active?: string) {
    return this.service.listPriceLists(
      active === undefined ? undefined : active === 'true',
    );
  }

  @Get('price-lists/:id')
  findPriceList(@Param('id') id: string) {
    return this.service.findPriceListById(id);
  }

  @Patch('price-lists/:id')
  updatePriceList(@Param('id') id: string, @Body() body: UpdatePriceListDto) {
    return this.service.updatePriceList(id, body);
  }

  @Delete('price-lists/:id')
  deletePriceList(@Param('id') id: string) {
    return this.service.softDeletePriceList(id);
  }

  // ───── product_prices ─────

  @Get('price-lists/:id/prices')
  @ApiOperation({
    summary:
      'Listar precios de una price list. J.6.7: con ?warehouse_id=X incluye stock_available por producto.',
  })
  listPrices(
    @Param('id') priceListId: string,
    @Query('warehouse_id') warehouseId?: string,
  ) {
    return this.service.listPrices(priceListId, warehouseId);
  }

  @Post('product-prices/bulk-upsert')
  @ApiOperation({
    summary: 'Bulk upsert de precios (idempotente por price_list_id + product_id)',
  })
  bulkUpsertPrices(@Body() body: BulkUpsertProductPricesDto) {
    return this.service.bulkUpsertPrices(body);
  }

  @Delete('product-prices/:id')
  deletePrice(@Param('id') id: string) {
    return this.service.deletePrice(id);
  }

  // ───── price resolution ─────

  @Get('products/:product_id/price')
  @ApiOperation({
    summary:
      'Resolver precio aplicable a un producto para un cliente (fallback a price_list default)',
  })
  resolvePrice(
    @Param('product_id') productId: string,
    @Query('customer_id') customerId: string,
  ) {
    return this.service.resolvePriceForCustomer(productId, customerId);
  }
}
