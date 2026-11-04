import { Body, Controller, Get, Headers, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import type {
  CobroEnVentanilla, ConteoDeCaja, EstadoDeCobro, ExplicarSuspenso, HechoDePersona, HojaDeReposicion, PedirReposicion, QuienLlevaDeposito, CustodiaAbierta, PersonaDeCustodia, RendirCustodia, ResultadoRendicion, RetiroACustodia, OrdenPorFirmar, PagoEnVentanilla, PartidaEnSuspenso, PlanDePagoVentanilla,
  ResultadoCobro, ResultadoConteo, ResultadoHecho, ResultadoPago, SaldosDelLibro, VeredictoDePago,
} from '@megadulces/contracts';
import { CashbookService, type UsuarioDelLibro } from './cashbook.service';
import { CashbookVentanillaService } from './cashbook-ventanilla.service';

interface AuthedRequest { user?: { id?: string; sub?: string; userId?: string; username?: string } }

/**
 * `[LE.4]` — El libro de efectivo de partida doble. Permisos (los de Caja General, ya repartidos):
 * VER lee, GESTIONAR registra y cuenta, AUTORIZAR firma. Los permisos finos por acción (B13) son
 * deuda con nombre antes del cambio (E7).
 */
@ApiTags('finance-libro-efectivo')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/libro-efectivo')
export class CashbookController {
  constructor(private readonly svc: CashbookService, private readonly ventanilla: CashbookVentanillaService) {}

  private user(req: AuthedRequest): UsuarioDelLibro {
    const u = req?.user ?? {};
    return { id: u.id ?? u.sub ?? u.userId, username: u.username };
  }

  @Get('saldos')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: '[LE.4.5] Saldo de cada cuenta, último asiento, jornada abierta e integridad de la cadena' })
  saldos(): Promise<SaldosDelLibro> {
    return this.svc.saldos(false);
  }

  @Get('saldos/piezas')
  @RequirePermissions(Permission.FINANCE_CAJA_AUTORIZAR)
  @ApiOperation({ summary: '[LE.4.6] Saldos con desglose por pieza: es el esperado de un arqueo, sólo para quien autoriza' })
  saldosConPiezas(): Promise<SaldosDelLibro> {
    return this.svc.saldos(true);
  }

  @Get('mayor')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: '[LE.4.5] Asientos después de una secuencia, línea por línea' })
  mayor(@Query('desde') desde?: string, @Query('limite') limite?: string): Promise<Record<string, unknown>[]> {
    return this.svc.mayor(Number(desde) || 0, Number(limite) || 200);
  }

  @Get('hallazgos')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: '[LE.4.5] Hallazgos abiertos con su antigüedad' })
  hallazgos(): Promise<Record<string, unknown>[]> {
    return this.svc.hallazgos();
  }

  @Get('solicitudes')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: '[LE.4.5] Solicitudes pendientes de autorizar' })
  pendientes(): Promise<Record<string, unknown>[]> {
    return this.svc.pendientes();
  }

  @Post('hechos')
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: '[LE.4.3] Registra un hecho (Idempotency-Key obligatorio). Si pide cuatro ojos, queda por autorizar' })
  registrar(@Body() body: HechoDePersona, @Headers('idempotency-key') key: string | undefined, @Req() req: AuthedRequest): Promise<ResultadoHecho> {
    return this.svc.registrarHecho(body, this.user(req), key);
  }

  @Post('solicitudes/:id/autorizar')
  @RequirePermissions(Permission.FINANCE_CAJA_AUTORIZAR)
  @ApiOperation({ summary: '[LE.4.3] Autoriza una solicitud (nunca la propia)' })
  autorizar(@Param('id') id: string, @Req() req: AuthedRequest): Promise<{ entry_id: string }> {
    return this.svc.autorizar(id, this.user(req));
  }

  @Post('solicitudes/:id/rechazar')
  @RequirePermissions(Permission.FINANCE_CAJA_AUTORIZAR)
  @ApiOperation({ summary: '[LE.4.3] Rechaza una solicitud, con motivo' })
  rechazar(@Param('id') id: string, @Body() body: { nota: string }, @Req() req: AuthedRequest): Promise<void> {
    return this.svc.rechazar(id, body?.nota, this.user(req));
  }

  @Post('asientos/:id/reversa')
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: '[LE.4.3] Pide la reversa de un asiento (la autoriza otra persona)' })
  reversa(@Param('id') id: string, @Body() body: { motivo: string }, @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest): Promise<ResultadoHecho> {
    return this.svc.pedirReversa(id, body?.motivo, this.user(req), key);
  }

  @Post('conteos')
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: '[LE.4.6] Registra un arqueo; en uno sorpresa no devuelve el esperado (arqueo ciego)' })
  contar(@Body() body: ConteoDeCaja, @Req() req: AuthedRequest): Promise<ResultadoConteo> {
    return this.svc.contar(body, this.user(req));
  }

  @Post('jornadas/:fecha/abrir')
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: '[LE.4.3] Abre la jornada (sólo si la anterior está cerrada)' })
  abrir(@Param('fecha') fecha: string, @Req() req: AuthedRequest): Promise<void> {
    return this.svc.abrirJornada(fecha, this.user(req));
  }

  @Post('jornadas/:fecha/cerrar')
  @RequirePermissions(Permission.FINANCE_CAJA_AUTORIZAR)
  @ApiOperation({ summary: '[LE.4.3] Cierra la jornada: la autoriza la sesión; cierra quien hizo el arqueo de cierre' })
  cerrar(@Param('fecha') fecha: string, @Req() req: AuthedRequest): Promise<{ cerro: string; autorizo: string }> {
    return this.svc.cerrarJornada(fecha, this.user(req));
  }

  // ── `[LE.4.10]` La Ventanilla: pagar un X-D-26 en un solo acto ─────────────────────────────

  @Get('pagos/plan')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: '[LE.4.10] Qué sale de la máquina y qué del cajón al pagar un X-D-26, y si firma Tesorería (no escribe)' })
  planDePago(@Query('origen_ref') origenRef: string, @Query('cuenta_kepler') cuenta?: string,
    @Query('vale_id') valeId?: string): Promise<PlanDePagoVentanilla> {
    return this.ventanilla.plan(origenRef, cuenta, valeId);
  }

  @Get('pagos/veredictos')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: '[LE.2.13] Por lote (hasta 200, separados por coma): si cada X-D-26 se puede pagar ya, por qué no, o si firma Tesorería. Lo que respalda el pago lo dice Kepler (no escribe)' })
  veredictos(@Query('docs') docs?: string): Promise<VeredictoDePago[]> {
    return this.ventanilla.veredictos(String(docs ?? '').split(','));
  }

  @Post('pagos')
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: '[LE.4.10] Paga un X-D-26 (Idempotency-Key obligatoria): con vale aprobado devuelve el código; sin él, queda por firmar' })
  pagar(@Body() body: PagoEnVentanilla, @Headers('idempotency-key') key: string | undefined, @Req() req: AuthedRequest): Promise<ResultadoPago> {
    return this.ventanilla.pagar(body, this.user(req), key);
  }

  // ── `[LE.6.7]` La Ventanilla: recibir un cobro (U-A-5 de la 0011) ──────────────────────────

  @Get('cobros/estado')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: '[LE.6.7] Por lote (hasta 200, separados por coma): si cada cobro es de ruta, de sucursal o está detenido, lo que Kepler espera y si ya se recibió (no escribe)' })
  estadoDeCobros(@Query('docs') docs?: string): Promise<EstadoDeCobro[]> {
    return this.ventanilla.estadoDeCobros(String(docs ?? '').split(','));
  }

  @Post('cobros')
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: '[LE.6.7] Recibe un cobro contado por pieza (Idempotency-Key obligatoria): de ruta contra lo que debe rendir, de sucursal como otro ingreso; la diferencia se declara' })
  recibirCobro(@Body() body: CobroEnVentanilla, @Headers('idempotency-key') key: string | undefined, @Req() req: AuthedRequest): Promise<ResultadoCobro> {
    return this.ventanilla.recibir(body, this.user(req), key);
  }

  @Get('suspenso')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: '[LE.6.7] Lo que la máquina hizo y nadie explicó (depósitos sin ruta, retiros sin código), lo más viejo primero (no escribe)' })
  suspenso(): Promise<PartidaEnSuspenso[]> {
    return this.ventanilla.suspenso();
  }

  @Post('suspenso/explicar')
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: '[LE.6.7] Explica un movimiento en Suspenso (a una ruta, al cajón o al banco; Idempotency-Key obligatoria): importe y dirección los lee el servidor del libro' })
  explicarSuspenso(@Body() body: ExplicarSuspenso, @Headers('idempotency-key') key: string | undefined, @Req() req: AuthedRequest): Promise<ResultadoHecho> {
    return this.ventanilla.explicar(body, this.user(req), key);
  }

  // ── `[LE.6.8]` La reposición: una hoja, una firma de Tesorería, un código ──────────────────

  @Get('reposiciones')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: '[LE.6.8] La hoja de reposición de cada zona desde la apertura del libro: qué va, qué no y por qué, y cuánto da la máquina y cuánto el cajón (no escribe)' })
  reposiciones(): Promise<HojaDeReposicion[]> {
    return this.ventanilla.reposiciones();
  }

  @Get('reposiciones/quien-lleva')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: '[LE.6.8] Quién puede llevar el depósito de una reposición (la responsabilidad finanzas.caja_deposito, D35)' })
  quienLleva(): Promise<QuienLlevaDeposito[]> {
    return this.ventanilla.quienLleva();
  }

  @Post('reposiciones')
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: '[LE.6.8] Pide la reposición de una zona (Idempotency-Key): nace por firmar; con la firma de Tesorería sale el código y el dinero queda en custodia de quien lleva el depósito' })
  pedirReposicion(@Body() body: PedirReposicion, @Headers('idempotency-key') key: string | undefined, @Req() req: AuthedRequest): Promise<ResultadoPago> {
    return this.ventanilla.pedirReposicion(body, this.user(req), key);
  }

  @Post('reposiciones/:id/confirmar-deposito')
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: '[LE.6.8] Cierra una reposición pagada con su testigo: el depósito en la cuenta de la zona; cada pago queda como gasto desde la custodia' })
  confirmarDeposito(@Param('id') id: string, @Req() req: AuthedRequest): Promise<ResultadoRendicion> {
    return this.ventanilla.confirmarDeposito(id, this.user(req));
  }

  // ── `[LE.6.5]` Custodias: dinero a cargo de una persona hasta que rinde ────────────────────

  @Get('custodias')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: '[LE.6.5] Lo que cada persona tiene a su cargo, desde cuándo, y las reposiciones que esperan su depósito (no escribe)' })
  custodias(): Promise<CustodiaAbierta[]> {
    return this.ventanilla.custodias();
  }

  @Get('custodias/personas')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: '[LE.6.5] Buscar a la persona que se lleva el dinero (usuarios activos; al menos 2 letras)' })
  personas(@Query('q') q?: string): Promise<PersonaDeCustodia[]> {
    return this.ventanilla.personas(q);
  }

  @Post('custodias')
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: '[LE.6.5] Saca dinero a la custodia de una persona (Idempotency-Key): de la máquina con código —desde el umbral la firma Tesorería— o del cajón por pieza' })
  retiroACustodia(@Body() body: RetiroACustodia, @Headers('idempotency-key') key: string | undefined, @Req() req: AuthedRequest): Promise<ResultadoPago | ResultadoHecho> {
    return this.ventanilla.retiroACustodia(body, this.user(req), key);
  }

  @Post('custodias/rendir')
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: '[LE.6.5] Rinde una custodia (Idempotency-Key): con documentos de Kepler y con lo que regresa al cajón por pieza' })
  rendir(@Body() body: RendirCustodia, @Headers('idempotency-key') key: string | undefined, @Req() req: AuthedRequest): Promise<ResultadoRendicion> {
    return this.ventanilla.rendir(body, this.user(req), key);
  }

  @Get('ordenes/por-firmar')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: '[LE.4.10] Las órdenes que esperan la firma de Tesorería, la más vieja primero' })
  porFirmar(): Promise<OrdenPorFirmar[]> {
    return this.ventanilla.porFirmar();
  }

  @Post('ordenes/:id/firmar')
  @RequirePermissions(Permission.FINANCE_CAJA_AUTORIZAR)
  @ApiOperation({ summary: '[LE.4.10] Tesorería firma una orden (nunca la propia): nace el código y se asienta lo del cajón' })
  firmarOrden(@Param('id') id: string, @Req() req: AuthedRequest): Promise<ResultadoPago> {
    return this.ventanilla.firmar(id, this.user(req));
  }

  @Post('ordenes/:id/rechazar')
  @RequirePermissions(Permission.FINANCE_CAJA_AUTORIZAR)
  @ApiOperation({ summary: '[LE.4.10] Tesorería rechaza una orden, con motivo' })
  rechazarOrden(@Param('id') id: string, @Body() body: { nota: string }, @Req() req: AuthedRequest): Promise<void> {
    return this.ventanilla.rechazar(id, body?.nota, this.user(req));
  }

  @Post('hallazgos/:id/cerrar')
  @RequirePermissions(Permission.FINANCE_CAJA_AUTORIZAR)
  @ApiOperation({ summary: '[LE.4.3] Cierra un hallazgo con un asiento, o con una nota que firma la sesión (nunca quien lo registró)' })
  cerrarHallazgo(@Param('id') id: string, @Body() body: { entry_id?: string; nota?: string },
    @Req() req: AuthedRequest): Promise<void> {
    return this.svc.cerrarHallazgo(id, body ?? {}, this.user(req));
  }
}
