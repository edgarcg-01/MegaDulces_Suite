import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import type { OcCancelacionDisponibleDto, OcCancelacionDto, OcCancelarInputDto } from '@megadulces/contracts';

import { OcCancelacionService } from './oc-cancelacion.service';

/**
 * `[PQ.110]` Controlador aparte (mismo prefijo que `CommercialReplenishmentController`) para no tocar
 * la firma inyectada del controlador grande: una firma rota tumba el arranque de la API (#414).
 */
@ApiTags('commercial-replenishment')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/replenishment')
export class OcCancelacionController {
  constructor(private readonly svc: OcCancelacionService) {}

  @Post('open-purchase-orders/:sucursal/:folio/cancelar')
  @RequirePermissions(Permission.COMPRAS_OC_CANCELAR)
  @ApiOperation({ summary: 'PQ.110 — Cancela en Kepler una OC pendiente y sin vale (como Kepler: OC en C, renglones borrados, su requisición reabierta). Motivo obligatorio. Apagado por sucursal en kepler_push_switch (tipo cancela_oc). Devuelve estado cancelada|rechazada con el porqué.' })
  cancelar(
    @Param('sucursal') sucursal: string,
    @Param('folio') folio: string,
    // Se valida adentro (motivoValido): el cuerpo llega sin garantías.
    @Body() body: Partial<OcCancelarInputDto>,
  ): Promise<OcCancelacionDto> {
    return this.svc.cancelar(sucursal, folio, body ?? {});
  }

  @Get('open-purchase-orders/:sucursal/:folio/cancelacion')
  @RequirePermissions(Permission.COMPRAS_OC_CANCELAR)
  @ApiOperation({ summary: 'PQ.110 — ¿Se puede ofrecer «Cancelar en Kepler» para esta OC? No escribe. Revisa el interruptor, el tope, si ya se canceló y la regla de Kepler contra la réplica (al cancelar se revisa otra vez contra Kepler vivo). Devuelve disponible, el porqué y el último intento.' })
  disponible(
    @Param('sucursal') sucursal: string,
    @Param('folio') folio: string,
  ): Promise<OcCancelacionDisponibleDto> {
    return this.svc.disponible(sucursal, folio);
  }
}
