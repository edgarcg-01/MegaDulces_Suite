import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import type { CortesSucursalesResponse } from '@megadulces/contracts';
import { CortesSucursalesService } from './cortes-sucursales.service';

/**
 * `[CSU.1]` Cortes/Sucursales: corte de caja POS (`U-D-23`, cliente CONTADO) → cobros aplicados →
 * arqueo del turno. Sólo lectura sobre Kepler: el cobro se sigue capturando en el ERP.
 */
@ApiTags('finance-cortes-sucursales')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/cortes-sucursales')
export class CortesSucursalesController {
  constructor(private readonly svc: CortesSucursalesService) {}

  @Get()
  @RequirePermissions(Permission.FINANCE_CORTES_VER)
  @ApiOperation({ summary: 'Cortes de caja POS por sucursal con su cobro y su arqueo. Filtros: month (AAAA-MM, default mes en curso) o from+to (AAAA-MM-DD).' })
  list(
    @Query('month') month?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<CortesSucursalesResponse> {
    return this.svc.list({ month, from, to });
  }
}
