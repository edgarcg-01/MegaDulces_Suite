import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequireAuthGuard, RequirePermissions, RolesGuard } from '@megadulces/platform-core';
import type {
  PresaleReviewDetail,
  PresaleReviewFinishRequest,
  PresaleReviewFinishResponse,
  PresaleReviewInboxResponse,
} from '@megadulces/contracts';
import { PresaleReviewService } from './presale-review.service';

/**
 * `[MCP.10]` Revisión en caja de los pedidos de preventa surtidos. Cuelga de
 * `PREVENTA_GUIAS_GESTIONAR`: es el permiso de la caja sobre la preventa (las guías de carga) y ya
 * está repartido a `cajero` y `encargado_tienda` en prod (medido 2026-10-29), así que la revisión no
 * nace con un permiso declarado y sin repartir (regla 20). El alcance por sucursal lo pone `ScopeService`.
 */
@ApiTags('warehouse-presale-review')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('warehouse/presale-review')
export class PresaleReviewController {
  constructor(private readonly service: PresaleReviewService) {}

  @Get()
  @RequirePermissions(Permission.PREVENTA_GUIAS_GESTIONAR)
  @ApiOperation({ summary: 'Pedidos de preventa surtidos de mi sucursal: por revisar y lo revisado hoy' })
  inbox(@Query() query: Record<string, unknown>): Promise<PresaleReviewInboxResponse> {
    return this.service.inbox(query);
  }

  @Get(':id')
  @RequirePermissions(Permission.PREVENTA_GUIAS_GESTIONAR)
  @ApiOperation({ summary: 'Un pedido surtido para revisar: lo pedido, lo surtido y la existencia de Kepler' })
  detail(@Param('id') id: string, @Query() query: Record<string, unknown>): Promise<PresaleReviewDetail> {
    return this.service.detail(id, query);
  }

  @Post(':id/finish')
  @RequirePermissions(Permission.PREVENTA_GUIAS_GESTIONAR)
  @ApiOperation({ summary: 'Cerrar la revisión: el pedido queda con lo que se va a cobrar' })
  finish(
    @Param('id') id: string,
    @Body() body: PresaleReviewFinishRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<PresaleReviewFinishResponse> {
    return this.service.finish(id, body, query);
  }
}
