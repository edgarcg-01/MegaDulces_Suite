import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Permission, Public, RequirePermissions, RolesGuard } from '@megadulces/platform-core';
import {
  FIRMA_RUTA_PC_API, FIRMA_RUTA_PUBLICA_API,
  type ContextoFirma, type FirmaSolicitudAbierta, type FirmaSolicitudEstado, type FirmaSolicitudTelefono,
} from '@megadulces/contracts';
import { CajaFirmaService } from './caja-firma.service';

interface AuthedRequest { user?: { id?: string; sub?: string; userId?: string; username?: string } }

/**
 * `[CG.201]` **La PC pide, consulta y cancela la firma.** Con sesión y permiso de GESTIONAR:
 * pedir una firma es parte de capturar.
 */
@ApiTags('finance-caja-firmas')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller(FIRMA_RUTA_PC_API)
export class CajaFirmaController {
  constructor(private readonly svc: CajaFirmaService) {}

  private user(req: AuthedRequest): { id?: string; username?: string } {
    const u = req?.user ?? {};
    return { id: u.id ?? u.sub ?? u.userId, username: u.username };
  }

  @Post()
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: 'Pide la firma de un movimiento en el teléfono. Devuelve el token que va dentro del QR.' })
  abrir(@Body() body: ContextoFirma, @Req() req: AuthedRequest): Promise<FirmaSolicitudAbierta> {
    return this.svc.abrir(body, this.user(req));
  }

  /** La PC repasa esto mientras espera: el socket sólo lo adelanta. */
  @Get(':id')
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: 'Estado del pedido de firma; la imagen sólo viaja cuando ya está firmada.' })
  estado(@Param('id') id: string): Promise<FirmaSolicitudEstado> {
    return this.svc.estado(id);
  }

  @Post(':id/cancelar')
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: 'Cancela el pedido: el QR deja de servir al instante.' })
  cancelar(@Param('id') id: string, @Req() req: AuthedRequest): Promise<{ ok: true }> {
    return this.svc.cancelar(id, this.user(req));
  }
}

/**
 * ⭐⭐ `[CG.201]` **La superficie PÚBLICA: el teléfono que viene a firmar, sin cuenta ni sesión.**
 *
 * Se autoriza con el token del QR (JWT con el id del pedido), y la autoridad es la FILA, releída en
 * cada uso. Las reglas, que hay que sostener si alguien agrega un endpoint:
 *
 *   · **Sólo ve lo suyo:** los cuatro datos del contexto de ESE pedido. Nada de la caja.
 *   · **Sólo escribe un trazo**, una vez, para ese pedido (lo demás es idempotente).
 *   · **Rate limit propio**, más apretado que el global: es una puerta sin sesión.
 *
 * El teléfono se identifica con un id que genera él mismo (`telefono`): no es una credencial, es
 * lo que permite que el MISMO teléfono vuelva (bloqueo, recarga) sin contarlo como otro.
 */
@ApiTags('finance-firma-publica')
@Controller(FIRMA_RUTA_PUBLICA_API)
export class CajaFirmaPublicController {
  constructor(private readonly svc: CajaFirmaService) {}

  @Public()
  @Throttle({ medium: { limit: 30, ttl: 60_000 } })
  @Post(':token/ver')
  @ApiExcludeEndpoint()
  ver(@Param('token') token: string, @Body() body: { telefono?: string }): Promise<FirmaSolicitudTelefono> {
    return this.svc.verPorToken(token, String(body?.telefono ?? ''));
  }

  @Public()
  @Throttle({ medium: { limit: 20, ttl: 60_000 } })
  @Post(':token/firmar')
  @ApiExcludeEndpoint()
  firmar(
    @Param('token') token: string,
    @Body() body: { telefono?: string; png?: string; nombre?: string },
  ): Promise<{ ok: true; repetida: boolean }> {
    return this.svc.firmarPorToken(token, String(body?.telefono ?? ''), body?.png, body?.nombre);
  }
}
