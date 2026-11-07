import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequireAuthGuard, RequirePermissions, RolesGuard } from '@megadulces/platform-core';
import type {
  VecinalCashierOrder,
  VecinalCashiersResponse,
  VecinalOrdersResponse,
  VecinalPickerOrder,
  VecinalPickersResponse,
} from '@megadulces/contracts';
import { VecinalMonitorService } from './vecinal-monitor.service';

/**
 * `[MV.1]` Monitoreo vecinal (Comercial › Ruta y vendedores): surtidores y cajeras de la preventa.
 * Sólo lectura. La llave es `COMMERCIAL_MONITOREO_VECINAL_VER`; QUÉ sucursales ve cada quien lo
 * decide su alcance (`ScopeService`), con `?warehouse=` para elegir una. El periodo es `?from=&to=`
 * (AAAA-MM-DD, hora de México; sin fechas = hoy; máximo 92 días).
 */
@ApiTags('commercial-vecinal-monitor')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('commercial/vecinal-monitor')
export class VecinalMonitorController {
  constructor(private readonly service: VecinalMonitorService) {}

  @Get('pickers')
  @RequirePermissions(Permission.COMMERCIAL_MONITOREO_VECINAL_VER)
  @ApiOperation({ summary: 'Surtidores del periodo: pedidos tomados y terminados, tiempo, faltantes, cambios y ajustes de la caja' })
  pickers(@Query() query: Record<string, unknown>): Promise<VecinalPickersResponse> {
    return this.service.pickers(query);
  }

  @Get('pickers/:userId/orders')
  @RequirePermissions(Permission.COMMERCIAL_MONITOREO_VECINAL_VER)
  @ApiOperation({ summary: 'Pedidos que surtió una persona en el periodo: cliente, productos pedido/surtido, cambios y tiempo' })
  pickerOrders(@Param('userId') userId: string, @Query() query: Record<string, unknown>): Promise<VecinalOrdersResponse<VecinalPickerOrder>> {
    return this.service.pickerOrders(userId, query);
  }

  @Get('cashiers')
  @RequirePermissions(Permission.COMMERCIAL_MONITOREO_VECINAL_VER)
  @ApiOperation({ summary: 'Cajeras del periodo: pedidos revisados, espera, lo que completaron o quitaron y cuánto debió cobrarse' })
  cashiers(@Query() query: Record<string, unknown>): Promise<VecinalCashiersResponse> {
    return this.service.cashiers(query);
  }

  @Get('cashiers/:userId/orders')
  @RequirePermissions(Permission.COMMERCIAL_MONITOREO_VECINAL_VER)
  @ApiOperation({ summary: 'Pedidos que revisó una cajera en el periodo: cliente, cómo quedó cada producto y cuánto debió cobrarse' })
  cashierOrders(@Param('userId') userId: string, @Query() query: Record<string, unknown>): Promise<VecinalOrdersResponse<VecinalCashierOrder>> {
    return this.service.cashierOrders(userId, query);
  }
}
