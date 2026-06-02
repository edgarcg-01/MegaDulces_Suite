import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import {
  CommercialPricingService,
  CreatePriceListDto,
  UpdatePriceListDto,
  BulkUpsertProductPricesDto,
} from './commercial-pricing.service';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { RequirePermissions } from '../../shared/decorators/permissions.decorator';
import { Permission } from '../../shared/constants/permissions';

@ApiTags('commercial-pricing')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial')
export class CommercialPricingController {
  constructor(private readonly service: CommercialPricingService) {}

  // ───── price_lists ─────

  @Post('price-lists')
  @RequirePermissions(Permission.COMMERCIAL_PRICING_GESTIONAR)
  @ApiOperation({ summary: 'Crear price list' })
  createPriceList(@Body() body: CreatePriceListDto) {
    return this.service.createPriceList(body);
  }

  @Get('price-lists')
  @RequirePermissions(Permission.COMMERCIAL_PRICING_VER)
  @ApiOperation({
    summary:
      'Listar price lists. customer_b2b solo ve su default_price_list (+ tenant default si la suya no es default). Sin esto vería todas las listas (VIP, wholesaler, etc.).',
  })
  listPriceLists(@Query('active') active?: string) {
    return this.service.listPriceLists(
      active === undefined ? undefined : active === 'true',
    );
  }

  @Get('price-lists/:id')
  @RequirePermissions(Permission.COMMERCIAL_PRICING_VER)
  findPriceList(@Param('id') id: string) {
    return this.service.findPriceListById(id);
  }

  @Patch('price-lists/:id')
  @RequirePermissions(Permission.COMMERCIAL_PRICING_GESTIONAR)
  updatePriceList(@Param('id') id: string, @Body() body: UpdatePriceListDto) {
    return this.service.updatePriceList(id, body);
  }

  @Delete('price-lists/:id')
  @RequirePermissions(Permission.COMMERCIAL_PRICING_GESTIONAR)
  deletePriceList(@Param('id') id: string) {
    return this.service.softDeletePriceList(id);
  }

  // ───── product_prices ─────

  @Get('price-lists/:id/prices')
  @RequirePermissions(Permission.COMMERCIAL_PRICING_VER)
  @ApiOperation({
    summary:
      'Listar precios (paginado) de una price list. J.6.7: con ?warehouse_id=X incluye stock_available. M.1: incluye sku, barcode, category_name. ?search filtra por nombre/sku/barcode. customer_b2b solo puede listar prices de SU price list.',
  })
  listPrices(
    @Param('id') priceListId: string,
    @Query('warehouse_id') warehouseId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
  ) {
    return this.service.listPrices(priceListId, {
      warehouseId,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      search,
    });
  }

  @Post('product-prices/bulk-upsert')
  @RequirePermissions(Permission.COMMERCIAL_PRICING_GESTIONAR)
  @ApiOperation({
    summary: 'Bulk upsert de precios (idempotente por price_list_id + product_id)',
  })
  bulkUpsertPrices(@Body() body: BulkUpsertProductPricesDto) {
    return this.service.bulkUpsertPrices(body);
  }

  @Delete('product-prices/:id')
  @RequirePermissions(Permission.COMMERCIAL_PRICING_GESTIONAR)
  deletePrice(@Param('id') id: string) {
    return this.service.deletePrice(id);
  }

  // ───── price resolution ─────

  @Get('products/:product_id/price')
  @RequirePermissions(Permission.COMMERCIAL_PRICING_VER)
  @ApiOperation({
    summary:
      'Resolver precio aplicable a un producto para un cliente (fallback a price_list default). customer_b2b: el customer_id se fuerza al del JWT (no puede consultar precios de otros).',
  })
  resolvePrice(
    @Param('product_id') productId: string,
    @Query('customer_id') customerId: string,
  ) {
    return this.service.resolvePriceForCustomer(productId, customerId);
  }
}
