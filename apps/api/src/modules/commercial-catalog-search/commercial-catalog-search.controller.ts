import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CommercialCatalogSearchService } from './commercial-catalog-search.service';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { RequirePermissions } from '../../shared/decorators/permissions.decorator';
import { Permission } from '../../shared/constants/permissions';

@ApiTags('commercial-catalog-search')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/catalog')
export class CommercialCatalogSearchController {
  constructor(private readonly service: CommercialCatalogSearchService) {}

  /**
   * Lista TODOS los productos activos de `public.products` (anchor en products,
   * no en prices). El precio del customer y stock vienen como LEFT JOIN.
   * Productos sin precio configurado para el price_list del customer aparecen
   * con `price = null` — el frontend los muestra como "Sin precio configurado".
   *
   * El customer_id se resuelve en el service desde `tenantCtx.userId →
   * public.users.customer_id` (no del JWT — auth-mt no lo emite).
   */
  @Get('products')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({
    summary:
      'Catálogo completo de productos (LEFT JOIN con price del customer y stock del warehouse). ' +
      'Sin page/pageSize devuelve array (legacy). Con cualquiera de los dos, devuelve { data, pagination }.',
  })
  async listProducts(
    @Query('warehouse_id') warehouseId?: string,
    @Query('include_no_price') includeNoPrice?: string,
    @Query('q') q?: string,
    @Query('brand_id') brandId?: string,
    @Query('price_min') priceMin?: string,
    @Query('price_max') priceMax?: string,
    @Query('has_stock') hasStock?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.listAllProducts({
      warehouseId: warehouseId || null,
      // Default: ocultar SKUs sin precio (los del RAG embebidos sin precio
      // configurado). Para debug/admin se puede pedir el listado completo con
      // `?include_no_price=true`.
      onlyWithPrice: includeNoPrice !== 'true',
      q: q || undefined,
      brandId: brandId || undefined,
      priceMin: priceMin != null ? Number(priceMin) : undefined,
      priceMax: priceMax != null ? Number(priceMax) : undefined,
      hasStock: hasStock === 'true',
      page: page != null ? Number(page) : undefined,
      pageSize: pageSize != null ? Number(pageSize) : undefined,
    });
  }

  /**
   * Productos que ESTE customer ya compró (últimos N días, default 90),
   * ordenados por frecuencia. Driver del chip "Reordenar" del portal —
   * resuelve el problema de long-tail: el cliente entra y ve SUS SKUs primero
   * en lugar de los 7k del catálogo completo.
   */
  @Get('my-history')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({
    summary: 'Productos comprados por el customer del JWT (top-N por frecuencia 90d)',
  })
  async myHistory(
    @Query('warehouse_id') warehouseId?: string,
    @Query('days') days?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.getMyHistory({
      warehouseId: warehouseId || null,
      days: days ? Number(days) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  /**
   * Canasta IA del customer (D.4) hidratada con precio/stock/marca.
   * Driver del chip "Sugeridos IA" del portal — útil para customers nuevos
   * sin historial (los que el chip "Reordenar" no cubre).
   */
  @Get('my-suggested')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({
    summary: 'Canasta IA del customer del JWT hidratada con precio/stock (D.4)',
  })
  async mySuggested(@Query('warehouse_id') warehouseId?: string) {
    return this.service.getMySuggested({ warehouseId: warehouseId || null });
  }

  /**
   * Productos con promoción activa aplicable al customer del JWT.
   * Driver del chip "Con promo" del portal.
   */
  @Get('with-promo')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({
    summary: 'Productos con promoción activa hidratados con precio/stock',
  })
  async withPromo(@Query('warehouse_id') warehouseId?: string) {
    return this.service.getWithPromo({ warehouseId: warehouseId || null });
  }

  /**
   * Facets agregados del catálogo del customer: counts por brand (top-N),
   * buckets de precio, with/without stock. Driver del sidebar de filtros del
   * portal — sin esto los filtros aparecen sin números, "Marca (?)".
   */
  @Get('facets')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({
    summary: 'Counts agregados del catálogo (brand, price bucket, stock)',
  })
  async facets(
    @Query('warehouse_id') warehouseId?: string,
    @Query('brands_limit') brandsLimit?: string,
  ) {
    return this.service.getFacets({
      warehouseId: warehouseId || null,
      brandsLimit: brandsLimit != null ? Number(brandsLimit) : undefined,
    });
  }

  /**
   * Búsqueda semántica del catálogo del customer.
   *
   * Comparte el tier `long` con `match-ai` (10/min) — embeddings cuestan
   * en Voyage; evitamos vaciar la cuenta si alguien tipea muy rápido.
   */
  @Post('search')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @Throttle({ long: { ttl: 60_000, limit: 30 } })
  @ApiOperation({
    summary: 'Búsqueda semántica del catálogo del customer (Voyage + pgvector KNN)',
  })
  async search(
    @Body() body: { query: string; limit?: number },
  ) {
    const query = (body.query || '').trim();
    if (!query) throw new BadRequestException('query vacío');
    const limit = Math.max(1, Math.min(50, Number(body.limit) || 24));
    return this.service.search({
      query,
      limit,
    });
  }
}
