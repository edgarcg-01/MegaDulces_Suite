import { Module } from '@nestjs/common';
import { PortalAiOrderController } from './portal-ai-order.controller';
import { PortalAiOrderService } from './portal-ai-order.service';
import { TenantKnexService } from '@megadulces/platform-core';

/**
 * Portal B2B — AI Order builder.
 *
 * `POST /api/commercial/ai-order/suggest`
 *   Input: { message, history? }
 *   Output: { assistant_message, suggestions: [{product_id, qty, reason}] }
 *
 * El servicio carga el catálogo del customer del JWT, lo manda como contexto
 * a Claude Haiku 4.5, y devuelve una respuesta estructurada via tool_use.
 */
@Module({
  controllers: [PortalAiOrderController],
  providers: [PortalAiOrderService, TenantKnexService],
})
export class PortalAiOrderModule {}
