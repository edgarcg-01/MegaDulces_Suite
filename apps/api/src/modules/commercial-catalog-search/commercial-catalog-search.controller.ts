import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CommercialCatalogSearchService } from './commercial-catalog-search.service';

@ApiTags('commercial-catalog-search')
@Controller('commercial/catalog')
export class CommercialCatalogSearchController {
  constructor(private readonly service: CommercialCatalogSearchService) {}

  /**
   * Lista TODOS los productos activos de `public.products` (anchor en products,
   * no en prices). El precio del customer y stock vienen como LEFT JOIN.
   * Productos sin precio configurado para el price_list del customer aparecen
   * con `price = null` — el frontend los muestra como "Sin precio configurado".
   *
   * Reemplaza el uso de `/price-lists/:id/prices` desde el portal cuando se
   * quiere ver el catálogo COMPLETO de productos, no solo los con price_list.
   */
  @Get('products')
  @ApiOperation({
    summary: 'Catálogo completo de productos (LEFT JOIN con price del customer y stock del warehouse)',
  })
  async listProducts(
    @Req() req: any,
    @Query('warehouse_id') warehouseId?: string,
    @Query('include_no_price') includeNoPrice?: string,
  ) {
    const user = req.user;
    if (!user) throw new UnauthorizedException('JWT inválido');
    return this.service.listAllProducts({
      customerId: user.customer_id || null,
      warehouseId: warehouseId || null,
      // Default: ocultar SKUs sin precio (los del RAG embebidos sin precio
      // configurado). Para debug/admin se puede pedir el listado completo con
      // `?include_no_price=true`.
      onlyWithPrice: includeNoPrice !== 'true',
    });
  }

  /**
   * Búsqueda semántica del catálogo del customer.
   *
   * Comparte el tier `long` con `match-ai` (10/min) — embeddings cuestan
   * en Voyage; evitamos vaciar la cuenta si alguien tipea muy rápido.
   */
  @Post('search')
  @Throttle({ long: { ttl: 60_000, limit: 30 } })
  @ApiOperation({
    summary: 'Búsqueda semántica del catálogo del customer (Voyage + pgvector KNN)',
  })
  async search(
    @Req() req: any,
    @Body() body: { query: string; limit?: number },
  ) {
    const user = req.user;
    if (!user) throw new UnauthorizedException('JWT inválido');
    const query = (body.query || '').trim();
    if (!query) throw new BadRequestException('query vacío');
    const limit = Math.max(1, Math.min(50, Number(body.limit) || 24));
    return this.service.search({
      query,
      limit,
      customerId: user.customer_id || null,
    });
  }
}
