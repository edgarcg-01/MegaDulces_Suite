import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { WincajaService } from './wincaja.service';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';

/**
 * Lectura de la data Wincaja (POS Access) sobre la capa silver. Fase W / ADR-031.
 * Reusa COMMERCIAL_ANALYTICS_VER (evita permiso nuevo ausente en prod).
 */
@ApiTags('wincaja')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/wincaja')
export class WincajaController {
  constructor(private readonly service: WincajaService) {}

  @Get('branches')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({ summary: 'Crosswalk de sucursales Wincaja + estado (viva/Kepler).' })
  branches() {
    return this.service.branches();
  }

  @Get('overview')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({ summary: 'KPIs por sucursal: venta, inventario, cartera real, demanda perdida.' })
  overview() {
    return this.service.overview();
  }

  @Get('sales-daily')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({ summary: 'Venta diaria (branch/from/to opcionales).' })
  salesDaily(@Query('branch') branch?: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.service.salesDaily({ branch, from, to });
  }

  @Get('lost-demand')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({ summary: 'Top SKUs con venta perdida (demanda insatisfecha, U6).' })
  lostDemand(@Query('branch') branch?: string, @Query('limit') limit?: string) {
    return this.service.lostDemand({ branch, limit: limit ? Number(limit) : undefined });
  }

  @Get('cartera')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({ summary: 'Cartera de clientes reales (excluye traspasos internos).' })
  cartera(@Query('branch') branch?: string, @Query('limit') limit?: string) {
    return this.service.cartera({ branch, limit: limit ? Number(limit) : undefined });
  }

  @Get('cash-audit')
  @RequirePermissions(Permission.COMMERCIAL_ANALYTICS_VER)
  @ApiOperation({ summary: 'Overrides de supervisor por autorizante (prevencion, U12).' })
  cashAudit(@Query('branch') branch?: string) {
    return this.service.cashAudit({ branch });
  }
}
