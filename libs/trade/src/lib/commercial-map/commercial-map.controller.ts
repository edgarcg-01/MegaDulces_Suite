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
}
