import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import type { AcreedorEstadoCuentaResponse, AcreedoresResponse } from '@megadulces/contracts';
import { CreditorStatementsService } from './creditor-statements.service';

/**
 * `[ECA.1]` Estado de cuenta de acreedores: cada documento de Kepler con los pagos y notas de
 * crédito que se le aplicaron. Sólo lectura: los pagos se siguen capturando y aplicando en Kepler.
 * Mismo permiso que el resto de Pagos (Cuadre y deuda, Programa y Calendario de pagos).
 */
@ApiTags('finance-creditor-statements')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/creditor-statements')
export class CreditorStatementsController {
  constructor(private readonly svc: CreditorStatementsService) {}

  @Get()
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: 'Acreedores con su saldo en Kepler (pendiente, vencido, pagos sin aplicar) y totales por tipo: mercancía, servicios, financiero.' })
  resumen(): Promise<AcreedoresResponse> {
    return this.svc.resumen();
  }

  @Get(':codigo')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: 'Estado de cuenta de un acreedor: documentos con sus pagos casados (kdxe + kdxf). Default: sólo lo que tiene saldo. pendientes=false + from/to (AAAA-MM-DD): todo el periodo.' })
  estadoCuenta(
    @Param('codigo') codigo: string,
    @Query('pendientes') pendientes?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<AcreedorEstadoCuentaResponse> {
    return this.svc.estadoCuenta(codigo, { pendientes: !(pendientes === 'false' || pendientes === '0'), from, to });
  }
}
