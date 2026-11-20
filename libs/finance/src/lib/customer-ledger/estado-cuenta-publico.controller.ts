import { Controller, Get, Header, Param, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public, requestOrigin } from '@megadulces/platform-core';
import type { RequestConCabeceras } from '@megadulces/platform-core';
import { CustomerDepositsService } from '../collection-deposits/customer-deposits.service';
import { EstadoCuentaClienteDocument } from './estado-cuenta-cliente.document';

/**
 * `[CC.20.2]` **El estado de cuenta en PDF, desde el enlace personal del cliente** (Edgar, 2026-11-18, opción A).
 *
 * El enlace de WhatsApp (`wa.me`) sólo lleva texto: el PDF no viaja con el mensaje y había que adjuntarlo a mano
 * (el primer envío real salió sin él). Con esto, el mensaje dice que el PDF está en el mismo enlace.
 *
 * La autorización es la del enlace (`conCuentaDelEnlace`: token revalidado contra la versión vigente) y el documento
 * es el MISMO que imprime Cobranza (`EstadoCuentaClienteDocument`): no hay una segunda versión para el cliente. Quien
 * tenga el enlace ve el saldo de esa cuenta — decisión de Edgar (el mensaje ya lo trae escrito). Límite propio y
 * apretado: cada PDF levanta Chromium.
 */
@ApiTags('finance-customer-deposit-public')
@Controller('finance/deposito')
export class EstadoCuentaPublicoController {
  constructor(
    private readonly depositos: CustomerDepositsService,
    private readonly estadoCuenta: EstadoCuentaClienteDocument,
  ) {}

  @Public()
  @Throttle({ medium: { limit: 6, ttl: 60_000 } })
  @Get(':token/estado-de-cuenta.pdf')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: '[CC.20.2] El estado de cuenta del cliente en PDF, autorizado por su enlace personal.' })
  async pdf(
    @Param('token') token: string, @Res() res: Response, @Req() req: RequestConCabeceras,
    /** `[CXC.47]` El periodo que eligió quien lo envió (viaja en la liga); sin él, los últimos 3 meses. */
    @Query('date_from') dateFrom?: string,
  ): Promise<void> {
    const { pdf, nombre } = await this.depositos.conCuentaDelEnlace(token,
      (sucursal, cliente) => this.estadoCuenta.render(sucursal, cliente, requestOrigin(req), dateFrom));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${nombre}"`);
    res.send(pdf);
  }
}
