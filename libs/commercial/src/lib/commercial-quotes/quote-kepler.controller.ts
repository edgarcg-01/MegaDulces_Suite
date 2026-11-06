import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';

import { QuoteKeplerService, type DireccionesCotizacion, type EnvioKepler } from './quote-kepler.service';
import type { QuienCotiza } from './quote-scope';

/** Lo que `RolesGuard` deja en `request.user`: el mapa y los roles FRESCOS de DB (COT.21). */
type ConQuien = { user?: QuienCotiza };

/**
 * `[COT.7.4]` — Aceptar la cotización y armar el «Pedido Telemarketing» en Kepler (ADR-113).
 *
 * Controlador aparte del de cotizaciones, con la misma ruta base: no toca la firma inyectada del
 * que ya está en producción. Exige `COMMERCIAL_QUOTES_GESTIONAR` (D4); el resto de los frenos
 * —autor, sucursal, cliente, vendedor, precio de hoy, interruptor— los aplica el servicio.
 */
@ApiTags('commercial-quotes')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/quotes')
export class QuoteKeplerController {
  constructor(private readonly service: QuoteKeplerService) {}

  @Post(':id/kepler')
  @RequirePermissions(Permission.COMMERCIAL_QUOTES_GESTIONAR)
  @ApiOperation({
    summary:
      '[COT.7] Acepta la cotización y la escribe como Pedido Telemarketing (U-D-40, CREADO) en el Kepler de su sucursal. '
      + 'Idempotente: con folio guardado devuelve ese. Rechaza si el precio cambió en Kepler desde que se cotizó, '
      + 'sin cliente o vendedor del ERP, con regalos, o con la escritura apagada en kepler_push_switch.',
  })
  enviar(@Param('id') id: string, @Req() req: ConQuien): Promise<EnvioKepler> {
    return this.service.enviar(id, req?.user);
  }

  @Get(':id/delivery-addresses')
  @RequirePermissions(Permission.COMMERCIAL_QUOTES_VER)
  @ApiOperation({ summary: '[COT.26] Direcciones de entrega del cliente en Kepler (kdudent) y la elegida para el pedido.' })
  direcciones(@Param('id') id: string, @Req() req: ConQuien): Promise<DireccionesCotizacion> {
    return this.service.direcciones(id, req?.user);
  }

  @Patch(':id/delivery-address')
  @RequirePermissions(Permission.COMMERCIAL_QUOTES_GESTIONAR)
  @ApiOperation({
    summary: '[COT.26] Elige la dirección de entrega (kdudent.c2 → Dir. envío c85 del pedido). Sólo antes de que exista en Kepler.',
  })
  fijarDireccion(
    @Param('id') id: string,
    @Body() body: { delivery_address_key: string | null },
    @Req() req: ConQuien,
  ): Promise<DireccionesCotizacion> {
    return this.service.fijarDireccion(id, body?.delivery_address_key ?? null, req?.user);
  }

  @Patch(':id/order-notes')
  @RequirePermissions(Permission.COMMERCIAL_QUOTES_GESTIONAR)
  @ApiOperation({
    summary: '[COT.28] Observaciones del pedido (hasta 120 caracteres) → «Comentarios» del pedido en Kepler (kdm1.c25/c26). Sólo antes de que exista en Kepler.',
  })
  fijarObservaciones(
    @Param('id') id: string,
    @Body() body: { order_notes: string | null },
    @Req() req: ConQuien,
  ): Promise<{ order_notes: string | null }> {
    return this.service.fijarObservaciones(id, body?.order_notes ?? null, req?.user);
  }
}
