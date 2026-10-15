import { Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { CaosService, type CaosQuery } from './caos.service';
import { CaosIngresoReconService } from './caos-ingreso-recon.service';
import { CaosRutaCajaService, type CaosPorRuta } from './caos-ruta-caja.service';

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
    private readonly rutaCaja: CaosRutaCajaService,
  ) {}

  /**
   * [CG.58.7] La liga que pide /comercial/ventas-por-ruta: de la ruta a su entrada en Caja
   * General, pasando por el deposito de CAOS que la origino.
   *
   * ⚠️ Gateado con COMMERCIAL_ROUTE_SALES_VER y NO con FINANCE_CAOS_VER, a proposito y medido:
   * de los 10 roles que abren Ventas por ruta, solo 5 tienen el permiso de CAOS -- compras,
   * compras_operaciones, jefe_marketing, repartidor y telemarketing verian un 403 en un panel de
   * SU pantalla. Es el mismo criterio que ya usan los otros dos paneles de conciliacion de esa
   * pagina (cierre de ruta y vecinal), que tambien publican dinero contado. No se acuña un
   * permiso nuevo: un permiso recien acuñado no esta REPARTIDO, y hasta que alguien lo reparta la
   * pantalla queda muda para todos (la leccion de [LC.6.2]).
   */
  @Get('por-ruta')
  @RequirePermissions(Permission.COMMERCIAL_ROUTE_SALES_VER)
  @ApiOperation({
    summary:
      '[CG.58.7] — Deposito de CAOS -> entrada a Caja General, agrupado por la ruta que declara '
      + 'el texto del deposito. Grano ruta_dia|ruta|plaza|sin_declarar: lo que el texto aguanta. '
      + 'Declara aparte la vecinal (otro circuito) y los depositos aun NO capturados en Caja '
      + 'General. Params: from, to (YYYY-MM-DD; por omision los ultimos 45 dias).',
  })
  porRuta(@Query('from') from?: string, @Query('to') to?: string): Promise<CaosPorRuta> {
    return this.rutaCaja.porRuta(from?.trim() || undefined, to?.trim() || undefined);
  }

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
