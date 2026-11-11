import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequireAnyPermission, RequireAuthGuard, RolesGuard } from '@megadulces/platform-core';
import type { SellerDayRecap } from '@megadulces/contracts';
import { SellerDayRecapService } from './recuento-dia.service';

/**
 * `[MCP.19]` Recuento del día del vendedor. Sin `user_id` es el de quien consulta; con `user_id`, el
 * de alguien de su equipo (lo valida el servicio con la regla del monitoreo de visitas).
 */
@ApiTags('vendor-day-recap')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('vendor/day-recap')
export class SellerDayRecapController {
  constructor(private readonly service: SellerDayRecapService) {}

  @Get()
  @RequireAnyPermission(Permission.VENDOR_APP_ACCESS, Permission.COMMERCIAL_CARTERA_VER)
  @ApiOperation({ summary: 'Recuento del día: lo levantado, cómo va al surtir, las visitas y lo pendiente' })
  recap(@Query('date') date?: string, @Query('user_id') userId?: string): Promise<SellerDayRecap> {
    return this.service.recap(userId, date);
  }
}
