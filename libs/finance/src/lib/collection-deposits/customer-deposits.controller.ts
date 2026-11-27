import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Permission, Public, RequirePermissions, RolesGuard, requestOrigin, RequestConCabeceras } from '@megadulces/platform-core';
import { CustomerDepositsService } from './customer-deposits.service';
// ⚠️ `import type`: con `emitDecoratorMetadata` + `isolatedModules`, un tipo en la firma de un método decorado tiene
// que entrar así o el compilador lo rechaza (TS1272).
import type {
  EnvioFichaDto, ContextoDepositoResp, ArchivoFicha, LecturaFichaResp, EnvioFichaResp, BandejaResp, CobroCandidato, FacturasQueCuadran, CambioFichaResp, AbonoDeclaradoResp,
} from './customer-deposits.service';
import type { ResultadoCobroKepler } from '../customer-ledger/kepler-cobro-sink.adapter';

interface AuthedRequest extends RequestConCabeceras { user?: { username?: string; full_name?: string } }
const origenDe = (req?: AuthedRequest) => requestOrigin(req);

/**
 * `[CC.20]` La superficie PÚBLICA: el celular del cliente, sin cuenta ni sesión. Todo es `@Public()` y se autoriza con
 * el token del enlace (en la URL), que el servicio revalida contra la versión vigente de la cuenta en cada uso. Las
 * reglas de esta superficie están en `CustomerDepositsService`: sólo escribe fichas de SU cuenta, sólo lee lo suyo,
 * nunca aplica un cobro. Límites de peticiones propios, más apretados que el global: es una puerta sin sesión, y cada
 * foto cuesta (almacenamiento + una lectura con visión).
 */
@ApiTags('finance-customer-deposit-public')
@Controller('finance/deposito')
export class CustomerDepositPublicController {
  constructor(private readonly svc: CustomerDepositsService) {}

  @Public()
  @Throttle({ medium: { limit: 30, ttl: 60_000 } })
  @Get(':token')
  @ApiOperation({ summary: 'Contexto del enlace: nombre del cliente y SUS fichas anteriores con su estado.' })
  contexto(@Param('token') token: string): Promise<ContextoDepositoResp> {
    return this.svc.contexto(token);
  }

  @Public()
  @Throttle({ medium: { limit: 12, ttl: 60_000 } })
  @Post(':token/subir')
  @ApiExcludeEndpoint()
  subir(@Param('token') token: string, @Body() body: { file_base64?: string }): Promise<ArchivoFicha> {
    return this.svc.subir(token, body?.file_base64 || '');
  }

  @Public()
  @Throttle({ medium: { limit: 10, ttl: 60_000 } })
  @Post(':token/leer')
  @ApiExcludeEndpoint()
  leer(@Param('token') token: string, @Body() body: { file_base64?: string }): Promise<LecturaFichaResp> {
    return this.svc.leer(token, body?.file_base64 || '');
  }

  @Public()
  @Throttle({ medium: { limit: 6, ttl: 60_000 } })
  @Post(':token')
  @ApiOperation({ summary: 'Envía la ficha del cliente: entra como «recibido», sin cobro, y avisa a Cobranza. Nunca se aplica sola.' })
  enviar(@Param('token') token: string, @Body() body: EnvioFichaDto): Promise<EnvioFichaResp> {
    return this.svc.enviar(token, body || {});
  }
}

/** `[CC.20]` El lado de Cobranza: el enlace de una cuenta y la bandeja de fichas que subieron los clientes. */
@ApiTags('finance-customer-deposits')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/collections/clientes')
export class CustomerDepositsController {
  constructor(private readonly svc: CustomerDepositsService) {}

  /** La URL del enlace de una cuenta (para copiarla o mandarla). No escribe nada. */
  @Post('enlace')
  @RequirePermissions(Permission.FINANCE_RECEIVABLES_VER)
  @ApiOperation({ summary: 'URL del enlace personal de una cuenta para subir su ficha de depósito.' })
  async enlace(@Body() body: { sucursal?: string; cliente?: string }, @Req() req: AuthedRequest): Promise<{ url: string | null }> {
    return { url: await this.svc.enlaceDe(body?.sucursal || '', body?.cliente || '', origenDe(req)) };
  }

  /** Da de baja todos los enlaces que se hayan mandado de esa cuenta (el siguiente sale nuevo). */
  @Post('enlace/renovar')
  @RequirePermissions(Permission.FINANCE_COLLECTIONS_GESTIONAR)
  renovar(@Body() body: { sucursal?: string; cliente?: string }, @Req() req: AuthedRequest): Promise<{ version: number }> {
    return this.svc.renovar(body?.sucursal || '', body?.cliente || '', req.user?.username);
  }

  @Get()
  @RequirePermissions(Permission.FINANCE_COLLECTIONS_VER)
  @ApiOperation({ summary: 'Fichas que subieron los clientes (por default, las que esperan revisión).' })
  bandeja(@Query('estado') estado?: string, @Query('limit') limit?: string): Promise<BandejaResp> {
    return this.svc.bandeja({ estado, limit: limit ? Number(limit) : undefined });
  }

  @Get(':id/candidatos')
  @RequirePermissions(Permission.FINANCE_COLLECTIONS_VER)
  candidatos(@Param('id') id: string): Promise<{ cobros: CobroCandidato[] }> {
    return this.svc.candidatos(id);
  }

  /**
   * `[CC.31]` Qué factura del cliente cuadra con este depósito, para que quien capture el cobro en Kepler no tenga
   * que buscarla. ⛔ No captura nada: el cobro lo da de alta una persona en Kepler, que es donde se timbra.
   */
  @Get(':id/facturas-que-cuadran')
  @RequirePermissions(Permission.FINANCE_COLLECTIONS_VER)
  facturasQueCuadran(@Param('id') id: string): Promise<FacturasQueCuadran> {
    return this.svc.facturasQueCuadran(id);
  }

  /**
   * `[CC.33]` ⭐⭐ **Registra el cobro en Kepler desde la pantalla.** Escribe el documento `U-A-7` con su renglón
   * de cartera, sus aplicaciones y su póliza, y verifica el efecto dentro de la transacción.
   *
   * ⛔⛔ **No timbra**, y el resultado lo dice (`timbrado: false`): el complemento de pago lo emite el programa de
   * Kepler. Quien lo use tiene que cerrar el timbre por ahí.
   */
  /** `[CC.33]` Si en esta sucursal se puede registrar el cobro, para no ofrecer un botón que va a fallar. */
  @Get('cobro/habilitado/:sucursal')
  @RequirePermissions(Permission.FINANCE_COLLECTIONS_VER)
  cobroHabilitado(@Param('sucursal') sucursal: string): Promise<{ habilitado: boolean; motivo?: string }> {
    return this.svc.cobroHabilitadoEn(sucursal);
  }

  @Post(':id/escribir-cobro')
  @RequirePermissions(Permission.FINANCE_COLLECTIONS_GESTIONAR)
  escribirCobro(
    @Param('id') id: string,
    @Body() body: { facturas?: { doc_code: string; folio: string; monto: number }[] },
    @Req() req: AuthedRequest,
  ): Promise<ResultadoCobroKepler> {
    return this.svc.escribirCobroEnKepler(id, body, req?.user?.full_name || req?.user?.username);
  }

  @Post(':id/ligar')
  @RequirePermissions(Permission.FINANCE_COLLECTIONS_GESTIONAR)
  @ApiOperation({ summary: 'Liga la ficha del cliente al cobro que Cobranza registró en Kepler (queda validada).' })
  ligar(@Param('id') id: string, @Body() body: { sucursal?: string; folio?: string }, @Req() req: AuthedRequest): Promise<CambioFichaResp> {
    return this.svc.ligar(id, body || {}, req.user?.username);
  }

  /** `[CC.21]` El dinero ya entró al banco y Kepler no tiene el cobro: el abono se declara de este cliente. */
  @Post(':id/abono')
  @RequirePermissions(Permission.FINANCE_COLLECTIONS_GESTIONAR)
  @ApiOperation({ summary: 'Declara el abono del banco que corresponde a la ficha como de ese cliente (sin cobro en Kepler).' })
  declararAbono(@Param('id') id: string, @Req() req: AuthedRequest): Promise<AbonoDeclaradoResp> {
    return this.svc.declararAbono(id, req.user?.full_name || req.user?.username);
  }

  @Post(':id/rechazar')
  @RequirePermissions(Permission.FINANCE_COLLECTIONS_GESTIONAR)
  @ApiOperation({ summary: 'Rechaza la ficha con un motivo que el cliente lee en su enlace.' })
  rechazar(@Param('id') id: string, @Body() body: { motivo?: string }, @Req() req: AuthedRequest): Promise<CambioFichaResp> {
    return this.svc.rechazar(id, body?.motivo, req.user?.username);
  }
}
