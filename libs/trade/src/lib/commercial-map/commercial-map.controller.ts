import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  ReqUser,
  RequireAuthGuard,
  RequirePermissions,
  RolesGuard,
} from '@megadulces/platform-core';
import { CommercialMapService } from './commercial-map.service';
import {
  CommercialMapHistoryFilterDto,
  CommercialMapStoresFilterDto,
  ProductPresenceFilterDto,
} from './dto/commercial-map-filter.dto';

@ApiTags('commercial-map')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
@Controller('commercial-map')
export class CommercialMapController {
  constructor(private readonly service: CommercialMapService) {}

  @Get('stores')
  @RequirePermissions(Permission.COMMERCIAL_MAP_VER)
  @ApiOperation({
    summary:
      'Tiendas geolocalizadas (coord híbrida) con presencia de exhibidores propios vs competencia',
  })
  getStores(@ReqUser() user: any, @Query() filters: CommercialMapStoresFilterDto) {
    return this.service.getStores(filters, user);
  }

  @Get('stores/:id/history')
  @RequirePermissions(Permission.COMMERCIAL_MAP_VER)
  @ApiOperation({
    summary:
      'Historial de visitas/exhibiciones de una tienda, separado propio vs competencia',
  })
  getStoreHistory(
    @ReqUser() user: any,
    @Param('id') id: string,
    @Query() filters: CommercialMapHistoryFilterDto,
  ) {
    return this.service.getStoreHistory(id, filters, user);
  }

  @Get('stores/:id/top-products')
  @RequirePermissions(Permission.COMMERCIAL_MAP_VER)
  @ApiOperation({
    summary: 'Productos más frecuentes de la tienda (desde productosMarcados de sus capturas)',
  })
  getStoreTopProducts(@ReqUser() user: any, @Param('id') id: string) {
    return this.service.getStoreTopProducts(id, user);
  }

  @Get('product-presence')
  @RequirePermissions(Permission.COMMERCIAL_MAP_VER)
  @ApiOperation({
    summary:
      'Superbuscador: tiendas + visitas donde aparece un producto (por texto o product_ids)',
  })
  getProductPresence(@ReqUser() user: any, @Query() filters: ProductPresenceFilterDto) {
    const product_ids = filters.product_ids
      ? filters.product_ids.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
    return this.service.getProductPresence(
      { q: filters.q, product_ids, date_from: filters.date_from, date_to: filters.date_to },
      user,
    );
  }

  @Get('product-search')
  @RequirePermissions(Permission.COMMERCIAL_MAP_VER)
  @ApiOperation({ summary: 'Autocomplete de productos (contains) para elegir uno' })
  searchProducts(@ReqUser() user: any, @Query('q') q: string) {
    return this.service.searchProducts(q || '', user);
  }
}
