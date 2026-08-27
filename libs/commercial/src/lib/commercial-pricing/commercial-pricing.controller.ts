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
  PriceHealthFlag,
} from './commercial-pricing.service';
import { RolesGuard } from '@megadulces/platform-core';
import { RequirePermissions } from '@megadulces/platform-core';
import { RequireAnyPermission } from '@megadulces/platform-core';
import { Permission } from '@megadulces/platform-core';

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
  // Interfaz vendedor independiente (catálogo del take-order): VENDOR_APP_ACCESS.
  @RequireAnyPermission(Permission.COMMERCIAL_PRICING_VER, Permission.VENDOR_APP_ACCESS)
  @ApiOperation({
    summary:
      'Listar price lists. customer_b2b solo ve su default_price_list (+ tenant default si la suya no es default). Sin esto vería todas las listas (VIP, wholesaler, etc.).',
  })
  listPriceLists(@Query('active') active?: string) {
    return this.service.listPriceLists(
      active === undefined ? undefined : active === 'true',
    );
  }

  // OJO: va ANTES de 'price-lists/:id'. Nest resuelve en orden de declaración;
  // al revés, 'health' entraría como :id y reventaría el UUID_REGEX.
  @Get('price-lists/health')
  @RequirePermissions(Permission.COMMERCIAL_PRICING_VER)
  @ApiOperation({
    summary:
      'Salud de todas las price lists en una consulta: catálogo, con precio, sin precio, centinela (<=$0.05), bajo costo, margen flaco (<10%) y sin costo. Alimenta el índice y los chips-filtro de /comercial/pricing. customer_b2b no recibe los contadores derivados del costo.',
  })
  listPriceListsHealth() {
    return this.service.listPriceListsHealth();
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
  @RequireAnyPermission(Permission.COMMERCIAL_PRICING_VER, Permission.VENDOR_APP_ACCESS)
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
    @Query('commercial_only') commercialOnly?: string,
    @Query('priced_only') pricedOnly?: string,
    @Query('unpriced_only') unpricedOnly?: string,
    @Query('flag') flag?: string,
    @Query('sort') sort?: string,
    @Query('dir') dir?: string,
  ) {
    return this.service.listPrices(priceListId, {
      warehouseId,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      search,
      commercialOnly: commercialOnly === 'true' || commercialOnly === '1',
      pricedOnly: pricedOnly === 'true' || pricedOnly === '1',
      unpricedOnly: unpricedOnly === 'true' || unpricedOnly === '1',
      flag: flag as PriceHealthFlag | undefined,
      sort,
      dir: dir === 'desc' ? 'desc' : 'asc',
    });
  }

  @Get('price-lists/:id/top-sellers')
  @RequireAnyPermission(Permission.COMMERCIAL_PRICING_VER, Permission.VENDOR_APP_ACCESS)
  @ApiOperation({
    summary:
      'Top sellers de una price list (lee MATERIALIZED VIEW products_top_sellers). Default limit=20, máx 1000. Incluye sales_rank, units_sold, revenue, last_sold_at + precio del price_list del customer.',
  })
  topSellers(
    @Param('id') priceListId: string,
    @Query('warehouse_id') warehouseId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listTopSellers(priceListId, {
      warehouseId,
      limit: limit ? Number(limit) : undefined,
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
