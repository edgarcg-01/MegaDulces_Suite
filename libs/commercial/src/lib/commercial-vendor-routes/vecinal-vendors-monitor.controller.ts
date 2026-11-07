import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequireAuthGuard, RequirePermissions, RolesGuard } from '@megadulces/platform-core';
import type { VecinalVendorDetail, VecinalVendorsResponse } from '@megadulces/contracts';
import { VecinalVendorsMonitorService } from './vecinal-vendors-monitor.service';

/**
 * `[MV.2]` Monitoreo vecinal — vendedores (el surtido y la caja viven en `presale-picking`, con el
 * mismo prefijo de ruta). Sólo lectura, llave `COMMERCIAL_MONITOREO_VECINAL_VER`. Periodo
 * `?from=&to=` (AAAA-MM-DD; sin fechas = hoy), sucursal `?warehouse=`, ruta vecinal `?route=`.
 */
@ApiTags('commercial-vecinal-monitor')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('commercial/vecinal-monitor')
export class VecinalVendorsMonitorController {
  constructor(private readonly service: VecinalVendorsMonitorService) {}

  @Get('vendors')
  @RequirePermissions(Permission.COMMERCIAL_MONITOREO_VECINAL_VER)
  @ApiOperation({ summary: 'Vendedores vecinales del periodo: visitas, pedidos levantados, cobrado en Kepler, meta, GPS y actividad' })
  vendors(@Query() query: Record<string, unknown>): Promise<VecinalVendorsResponse> {
    return this.service.vendors(query);
  }

  @Get('vendors/:userId')
  @RequirePermissions(Permission.COMMERCIAL_MONITOREO_VECINAL_VER)
  @ApiOperation({ summary: 'Un vendedor: cada cliente que visitó (tiempo, resultado), qué le levantó, qué cobró Kepler, y su recorrido' })
  vendorDetail(@Param('userId') userId: string, @Query() query: Record<string, unknown>): Promise<VecinalVendorDetail> {
    return this.service.vendorDetail(userId, query);
  }
}
