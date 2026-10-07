import { Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { CaosService, type CaosQuery } from './caos.service';
import { CaosIngresoReconService } from './caos-ingreso-recon.service';

interface AuthedRequest { user?: { id?: string; sub?: string; userId?: string } }

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
  constructor(
    private readonly svc: CaosService,
    private readonly recon: CaosIngresoReconService,
  ) {}

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

  @Get('conciliacion')
  @RequirePermissions(Permission.FINANCE_CAOS_VER)
  @ApiOperation({ summary: 'CS.4 — cuadre de total de control: CAOS vs Caja General de Kepler (0011).' })
  conciliacion(@Query() q: CaosQuery) {
    return this.svc.conciliacion(q);
  }

  @Get('movimientos/:id')
  @RequirePermissions(Permission.FINANCE_CAOS_VER)
  @ApiOperation({ summary: 'Detalle por denominación de un movimiento de CAOS.' })
  detalle(@Param('id') id: string) {
    return this.svc.detalle(id);
  }

  // ── [CG.58] La conciliacion de INGRESOS, al 100% ───────────────────────────────────────
  //
  // Distinta del cuadre de total de control de arriba (CS.4), que compara SUMAS. Esta ata cada
  // deposito a los cobros de Kepler que lo explican, uno por uno. Se puede porque el cobro va
  // ANTES que el deposito: medido sobre 708 depositos y 2,548 eventos, el saldo corrido nunca
  // se va a negativo. El egreso no tiene esa ley y por eso se queda en el casador heuristico.

  @Get('ingresos/estado')
  @RequirePermissions(Permission.FINANCE_CAOS_VER)
  @ApiOperation({ summary: '[CG.58] Cuanto de los ingresos de CAOS esta conciliado contra cobros de Kepler. Publica TRES cantidades separadas (ADR-056): conciliado, pendiente (deposito sin cobros que lo expliquen) y sin depositar (cobros que todavia no entraron al equipo). Las dos ultimas NO son lo mismo y las arregla gente distinta.' })
  estadoIngresos(@Query() q: { from?: string; to?: string }) {
    return this.recon.estado(q);
  }

  @Post('ingresos/conciliar')
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: '[CG.58] Reparte los cobros de Kepler entre los depositos de CAOS y GUARDA la atribucion. FIFO sobre cobros anteriores o del mismo dia, sin reusar ninguno; el ultimo tramo de cada deposito queda parcial (los depositos son multiplos de 10 y el 57% de los cobros traen centavos). Es lo que corre al generar el arqueo. Idempotente: descuenta lo ya atribuido, asi que correrlo dos veces no duplica tramos.' })
  conciliarIngresos(@Query() q: { from?: string; to?: string }, @Req() req: AuthedRequest) {
    const u = req?.user ?? {};
    return this.recon.conciliar({ id: u.id ?? u.sub ?? u.userId }, q);
  }
}
