import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireAuthGuard, RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import type {
  PresaleCandidatesResponse,
  PresaleDetail,
  PresaleLinkRequest,
  PresaleLinkResponse,
  PresaleListResponse,
  PresaleUnlinkRequest,
} from '@megadulces/contracts';
import { PresaleControlService } from './presale-control.service';

/**
 * `[MCP.1]` / `[MCP.4]` Mesa de Control de Preventa (Fase MCP, ADR-089): los pedidos `PD-` que
 * levanta el vendedor, por etapa y por sucursal, con el documento de Kepler con que se cobraron.
 *
 * Permisos (no nace ninguna clave nueva → sin re-login):
 *  · ver   = `ALMACEN_PEDIDOS_VER`, el del tablero de GP donde vive la mesa (origen "Preventa").
 *  · ligar = `COMMERCIAL_PICKING_GESTIONAR`: lo tiene el encargado de sucursal, que es quien
 *            opera la mesa (D4). Ligar desde el celular del repartidor llega en MCP.6.
 *
 * El alcance por sucursal sale de `ScopeService` (query `warehouse`), igual que la bandeja de
 * avisos de surtido.
 */
@ApiTags('warehouse-presale')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('warehouse/presale')
export class PresaleControlController {
  constructor(private readonly svc: PresaleControlService) {}

  @Get()
  @RequirePermissions(Permission.ALMACEN_PEDIDOS_VER)
  @ApiOperation({
    summary:
      'Pedidos de preventa vivos (confirmados) + cerrados de los últimos closed_days días (default 7), con etapa derivada, semáforo contra la fecha de entrega, documento de Kepler ligado y documentos posibles. Recorte por sucursal con el alcance del usuario.',
  })
  list(@Query() query: Record<string, unknown>): Promise<PresaleListResponse> {
    return this.svc.list(query);
  }

  @Get(':id')
  @RequirePermissions(Permission.ALMACEN_PEDIDOS_VER)
  @ApiOperation({ summary: 'Un pedido de preventa: recorrido, historial de ligas y pedido contra documento renglón por renglón.' })
  detail(@Param('id') id: string, @Query() query: Record<string, unknown>): Promise<PresaleDetail> {
    return this.svc.detail(id, query);
  }

  @Get(':id/candidates')
  @RequirePermissions(Permission.ALMACEN_PEDIDOS_VER)
  @ApiOperation({
    summary:
      'Documentos de Kepler del cliente (misma sucursal, desde la captura) que podrían ser el cobro del pedido, ordenados por productos en común. Los ligados a otro pedido vienen marcados.',
  })
  candidates(@Param('id') id: string, @Query() query: Record<string, unknown>): Promise<PresaleCandidatesResponse> {
    return this.svc.candidates(id, query);
  }

  @Post(':id/link')
  @RequirePermissions(Permission.COMMERCIAL_PICKING_GESTIONAR)
  @ApiOperation({ summary: 'Liga el pedido a uno de sus documentos candidatos de Kepler (desde la mesa).' })
  link(@Param('id') id: string, @Body() body: PresaleLinkRequest, @Query() query: Record<string, unknown>): Promise<PresaleLinkResponse> {
    return this.svc.link(id, body?.folio_digital, query);
  }

  @Post(':id/unlink')
  @RequirePermissions(Permission.COMMERCIAL_PICKING_GESTIONAR)
  @ApiOperation({ summary: 'Corrige una liga equivocada: la cierra con motivo (no la borra).' })
  unlink(@Param('id') id: string, @Body() body: PresaleUnlinkRequest, @Query() query: Record<string, unknown>): Promise<PresaleLinkResponse> {
    return this.svc.unlink(id, body?.reason, query);
  }
}
