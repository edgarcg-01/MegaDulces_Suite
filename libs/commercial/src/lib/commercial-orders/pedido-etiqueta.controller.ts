import { Controller, Get, Header, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Permission, Public, RequireAnyPermission, RolesGuard, requestOrigin } from '@megadulces/platform-core';
import type { RequestConCabeceras } from '@megadulces/platform-core';
import type { FirmaEtiquetaPedido, PedidoPublico } from '@megadulces/contracts';
import { PedidoEtiquetaService } from './pedido-etiqueta.service';

/**
 * `[MCP.36]` La firma de la etiqueta del pedido, para quien la imprime: el surtidor (Surtir) y la cajera (Revisión).
 * La liga que devuelve ya trae el dominio público de la Suite (la pantalla puede estar en la IP de la oficina).
 */
@ApiTags('commercial-pedido-etiqueta')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/etiqueta-pedido')
export class PedidoEtiquetaController {
  constructor(private readonly svc: PedidoEtiquetaService) {}

  @Get('firma/:folio')
  @RequireAnyPermission(Permission.COMMERCIAL_PICKING_GESTIONAR, Permission.PREVENTA_GUIAS_GESTIONAR)
  @ApiOperation({ summary: '[MCP.36] La liga firmada del pedido para el QR de su etiqueta.' })
  firma(@Param('folio') folio: string, @Req() req: RequestConCabeceras): Promise<FirmaEtiquetaPedido> {
    return this.svc.firmar(folio, requestOrigin(req));
  }
}

/**
 * `[MCP.36]` **El pedido desde la liga de su etiqueta, SIN sesión** (chofer, cliente o cualquiera con la bolsa en la
 * mano). La autoridad es la firma `k` de la liga, que vence. Límite propio: sin sesión, cada intento cuesta.
 * `authInterceptor` de la Suite exceptúa `/commercial/pedido-publico` (no pega ni pierde sesión aquí).
 */
@ApiTags('commercial-pedido-etiqueta')
@Controller('commercial/pedido-publico')
export class PedidoPublicoController {
  constructor(private readonly svc: PedidoEtiquetaService) {}

  @Public()
  @Throttle({ medium: { limit: 30, ttl: 60_000 } })
  @Get(':folio')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: '[MCP.36] El pedido de la etiqueta, autorizado por la firma de su liga (sin sesión).' })
  leer(@Param('folio') folio: string, @Query('k') k: string): Promise<PedidoPublico> {
    return this.svc.leer(folio, String(k ?? ''));
  }
}
