import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import type { CortesSucursalesResponse, FacturasContadoResponse } from '@megadulces/contracts';
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

  /**
   * `[CSU.30]` Facturas de contado por tipo, con sus notas de crédito y el corte de su turno (y si su dinero llegó).
   * Mismo permiso y alcance que la lista: una sucursal fuera del alcance es 403.
   */
  @Get('facturas')
  @RequirePermissions(Permission.FINANCE_CORTES_VER)
  @ApiOperation({ summary: 'Facturas de contado (U-D-5, U-D-12) por tipo, con sus notas y el corte de su turno. Filtros: month o from+to; sucursal (código, opcional); corte (clave, opcional: las facturas de su turno).' })
  facturas(
    @Query('month') month?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('sucursal') sucursal?: string,
    @Query('corte') corte?: string,
  ): Promise<FacturasContadoResponse> {
    return this.svc.facturas({ month, from, to, sucursal, corte });
  }
}
