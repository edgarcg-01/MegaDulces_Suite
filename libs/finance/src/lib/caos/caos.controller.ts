import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { CaosService, type CaosQuery } from './caos.service';

/**
 * CS.2 — Reporte de movimientos de CAOS (caja fuerte de efectivo). Sólo lectura.
 *
 * Permiso PROPIO `FINANCE_CAOS_VER` (no alias de Caja General): CAOS es otro circuito de efectivo.
 */
@ApiTags('finance-caos')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/caos')
export class CaosController {
  constructor(private readonly svc: CaosService) {}

  @Get('movimientos')
  @RequirePermissions(Permission.FINANCE_CAOS_VER)
  @ApiOperation({ summary: 'Movimientos de la caja fuerte CAOS (depósitos/dispensaciones) + KPIs.' })
  movimientos(@Query() q: CaosQuery) {
    return this.svc.movimientos(q);
  }

  @Get('resumen')
  @RequirePermissions(Permission.FINANCE_CAOS_VER)
  @ApiOperation({ summary: 'CS.6/CS.7 — resumen de CAOS por ruta (del ref) y por operador.' })
  resumen(@Query() q: CaosQuery) {
    return this.svc.resumen(q);
  }

  @Get('movimientos/:id')
  @RequirePermissions(Permission.FINANCE_CAOS_VER)
  @ApiOperation({ summary: 'Detalle por denominación de un movimiento de CAOS.' })
  detalle(@Param('id') id: string) {
    return this.svc.detalle(id);
  }
}
