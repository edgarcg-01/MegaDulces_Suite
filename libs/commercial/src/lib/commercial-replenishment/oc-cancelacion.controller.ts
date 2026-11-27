import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import type {
  OcCancelacionDisponibleDto, OcCancelacionDto, OcCancelarInputDto, RequisicionCancelacionDisponibleDto, RequisicionCancelacionDto,
  OcEdicionDisponibleDto, OcEdicionDto, OcEditarInputDto,
} from '@megadulces/contracts';

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

  /**
   * `[KR.7]` Mismo camino para preguntar (GET) y para cancelar (POST): la requisición de la Suite por su id.
   * No choca con `requisitions/:id` del controlador grande (otro número de segmentos).
   */
  @Post('requisitions/:id/kepler-cancellation')
  @RequirePermissions(Permission.COMPRAS_REQUISICION_CANCELAR)
  @ApiOperation({ summary: 'KR.7 — Cancela en Kepler la requisición de compra (X-A-30) de esta requisición de la Suite, como Kepler: sólo si ya no tiene OC viva y está en N o A; renglones borrados. Motivo obligatorio. D43: la de la Suite queda cancelada con el motivo y quién. Apagado por sucursal en kepler_push_switch (tipo cancela_requisicion). Devuelve cancelada|rechazada con el porqué.' })
  cancelarRequisicion(
    @Param('id') id: string,
    // Se valida adentro (motivoValido): el cuerpo llega sin garantías.
    @Body() body: Partial<OcCancelarInputDto>,
  ): Promise<RequisicionCancelacionDto> {
    return this.svc.cancelarRequisicion(id, body ?? {});
  }

  @Get('requisitions/:id/kepler-cancellation')
  @RequirePermissions(Permission.COMPRAS_REQUISICION_CANCELAR)
  @ApiOperation({ summary: 'KR.7 — ¿Se puede ofrecer «Cancelar en Kepler» en la ficha de esta requisición? No escribe. Revisa que haya llegado a Kepler, el interruptor, el tope, si ya se canceló y la regla de Kepler contra la réplica (al cancelar se revisa otra vez contra Kepler vivo).' })
  disponibleRequisicion(@Param('id') id: string): Promise<RequisicionCancelacionDisponibleDto> {
    return this.svc.disponibleRequisicion(id);
  }

  /** `[PQ.160]` Editar las cantidades de la OC en Kepler, con motivo. Mismo prefijo y mismo controlador (sin firma nueva, #414). */
  @Post('open-purchase-orders/:sucursal/:folio/editar')
  @RequirePermissions(Permission.COMPRAS_OC_EDITAR)
  @ApiOperation({ summary: 'PQ.160 — Cambia en Kepler las cantidades de una OC pendiente y sin vale, con las fórmulas de Kepler (renglón y encabezado), todo o nada. Sólo renglones existentes y cantidades > 0. Motivo obligatorio. Apagado por sucursal en kepler_push_switch (tipo edita_oc). Devuelve aplicada|rechazada con el porqué.' })
  editar(
    @Param('sucursal') sucursal: string,
    @Param('folio') folio: string,
    // Se valida adentro (motivo, renglones): el cuerpo llega sin garantías.
    @Body() body: Partial<OcEditarInputDto>,
  ): Promise<OcEdicionDto> {
    return this.svc.editar(sucursal, folio, body ?? {});
  }

  @Get('open-purchase-orders/:sucursal/:folio/edicion')
  @RequirePermissions(Permission.COMPRAS_OC_EDITAR)
  @ApiOperation({ summary: 'PQ.160 — ¿Se puede ofrecer «Editar cantidades» para esta OC, y con qué renglones? No escribe. Revisa el interruptor, el tope y la regla contra la réplica (al guardar se revisa otra vez contra Kepler vivo).' })
  disponibleEdicion(
    @Param('sucursal') sucursal: string,
    @Param('folio') folio: string,
  ): Promise<OcEdicionDisponibleDto> {
    return this.svc.disponibleEdicion(sucursal, folio);
  }
}
