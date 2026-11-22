import { Body, Controller, Get, Header, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Permission, Public, RequirePermissions, RolesGuard, requestOrigin } from '@megadulces/platform-core';
import type { RequestConCabeceras } from '@megadulces/platform-core';
import type { AvisoDePago, AvisoDePagoCreado, CrearAvisoDePago } from '@megadulces/contracts/finance/aviso-de-pago';
import { AvisoDePagoService } from './aviso-de-pago.service';

type ConUsuario = RequestConCabeceras & { user?: { username?: string; full_name?: string } };

/**
 * `[PGP.194]` **El aviso de pago al proveedor, desde el Calendario.** Prefijo propio (no cuelga de
 * `finance/payment-calendar`, donde una ruta `allocations/:id/…` podría chocar). Ver el aviso y bajar su PDF piden ver
 * pagos; generar la liga (que deja registro y recuerda el contacto) pide gestionarlos, como marcar pagado.
 */
@ApiTags('finance-payment-notices')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/payment-notices')
export class AvisoDePagoController {
  constructor(private readonly svc: AvisoDePagoService) {}

  @Get(':allocationId')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: '[PGP.194] El aviso de pago de un pago del Calendario: facturas, notas aplicadas, comprobante y a quién se avisó.' })
  datos(@Param('allocationId') allocationId: string): Promise<AvisoDePago> {
    return this.svc.datos(allocationId);
  }

  @Post(':allocationId')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_GESTIONAR)
  @ApiOperation({ summary: '[PGP.194] Genera la liga del aviso (WhatsApp, correo o liga) y deja registro; recuerda el contacto de cobranza.' })
  crear(@Param('allocationId') allocationId: string, @Body() body: CrearAvisoDePago, @Req() req: ConUsuario): Promise<AvisoDePagoCreado> {
    return this.svc.crear(allocationId, body ?? ({} as CrearAvisoDePago), req?.user?.full_name || req?.user?.username, requestOrigin(req));
  }

  @Get(':allocationId/pdf')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: '[PGP.194] El PDF del aviso de pago, con el comprobante de la transferencia anexo.' })
  async pdf(@Param('allocationId') allocationId: string, @Res() res: Response): Promise<void> {
    const { pdf, nombre } = await this.svc.pdf(allocationId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${nombre}"`);
    res.send(pdf);
  }
}

/**
 * `[PGP.194]` **El PDF del aviso desde la liga que recibió el proveedor** (sin sesión). La autorización es la liga: un
 * token con el id del aviso, revalidado contra su fila (`revoked_at`). Límite propio y apretado: cada PDF levanta
 * Chromium (como `[CC.20.2]`).
 */
@ApiTags('finance-payment-notice-public')
@Controller('finance/payment-notice')
export class AvisoDePagoPublicoController {
  constructor(private readonly svc: AvisoDePagoService) {}

  @Public()
  @Throttle({ medium: { limit: 6, ttl: 60_000 } })
  @Get(':token/aviso.pdf')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: '[PGP.194] El aviso de pago en PDF, autorizado por la liga que recibió el proveedor.' })
  async pdf(@Param('token') token: string, @Res() res: Response): Promise<void> {
    const { pdf, nombre } = await this.svc.pdfDeLaLiga(token);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${nombre}"`);
    res.send(pdf);
  }
}
