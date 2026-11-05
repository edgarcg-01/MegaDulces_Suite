import { Body, Controller, Get, Headers, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import type { ConteoDeCaja, HechoDePersona, ResultadoConteo, ResultadoHecho, SaldosDelLibro } from '@megadulces/contracts';
import { CashbookService, type UsuarioDelLibro } from './cashbook.service';

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
  constructor(private readonly svc: CashbookService) {}

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

  @Post('hallazgos/:id/cerrar')
  @RequirePermissions(Permission.FINANCE_CAJA_AUTORIZAR)
  @ApiOperation({ summary: '[LE.4.3] Cierra un hallazgo con un asiento, o con una nota que firma la sesión (nunca quien lo registró)' })
  cerrarHallazgo(@Param('id') id: string, @Body() body: { entry_id?: string; nota?: string },
    @Req() req: AuthedRequest): Promise<void> {
    return this.svc.cerrarHallazgo(id, body ?? {}, this.user(req));
  }
}
