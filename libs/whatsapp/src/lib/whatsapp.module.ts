import { Logger, Module } from '@nestjs/common';
import { WHATSAPP_PORT } from './ports/whatsapp.port';
import { SimulatorWhatsAppAdapter } from './adapters/simulator.adapter';
import { MetaCloudWhatsAppAdapter } from './adapters/meta-cloud.adapter';
import { WhatsAppQueueService } from './queue/whatsapp-queue.service';
import { ConversationThreadService } from './conversation/conversation-thread.service';
import { ConversationOrchestratorService } from './conversation/conversation-orchestrator.service';
import { WhatsAppIngestService } from './webhook/whatsapp-ingest.service';
import { WhatsAppWebhookController } from './webhook/whatsapp-webhook.controller';
import { WhatsAppOrdersService } from './orders/whatsapp-orders.service';
import { WhatsAppOrdersController } from './orders/whatsapp-orders.controller';
import { WhatsAppPromoService } from './promos/whatsapp-promo.service';
import { WhatsAppPromoController } from './promos/whatsapp-promo.controller';
import { WhatsAppOptinService } from './broadcast/whatsapp-optin.service';
import { WhatsAppCampaignService } from './broadcast/whatsapp-campaign.service';
import { WhatsAppReorderService } from './broadcast/whatsapp-reorder.service';
import { WhatsAppBroadcastController } from './broadcast/whatsapp-broadcast.controller';
import { AnthropicService } from '@megadulces/platform-core';

/**
 * Fase F (ADR-006/007/034) — Comercio conversacional por WhatsApp.
 *
 * F.0 (esta base): puerto abstracto + adaptador simulador (dev) + adaptador Meta
 * Cloud API + cola BullMQ degradable in-process + estado de conversación.
 * El webhook (F.1), el orquestador Claude (F.2) y la bandeja de revisión (F.3)
 * se montan sobre esto.
 *
 * El adaptador activo se elige con `WHATSAPP_PROVIDER=meta|simulator`
 * (default `simulator`, para no depender de credenciales de Meta en dev).
 * TenantKnexService es global (platform-core) → no se importa acá.
 */
const whatsAppPortProvider = {
  provide: WHATSAPP_PORT,
  useClass:
    (process.env.WHATSAPP_PROVIDER || 'simulator').toLowerCase() === 'meta'
      ? MetaCloudWhatsAppAdapter
      : SimulatorWhatsAppAdapter,
};

@Module({
  controllers: [WhatsAppWebhookController, WhatsAppOrdersController, WhatsAppPromoController, WhatsAppBroadcastController],
  providers: [
    // Ambos adaptables se instancian solo si son la clase elegida por el token;
    // los declaramos para que Nest los pueda construir vía el useClass.
    SimulatorWhatsAppAdapter,
    MetaCloudWhatsAppAdapter,
    whatsAppPortProvider,
    WhatsAppQueueService,
    ConversationThreadService,
    ConversationOrchestratorService,
    AnthropicService,
    WhatsAppIngestService,
    WhatsAppOrdersService,
    WhatsAppPromoService,
    WhatsAppOptinService,
    WhatsAppCampaignService,
    WhatsAppReorderService,
  ],
  exports: [WHATSAPP_PORT, WhatsAppQueueService, ConversationThreadService, ConversationOrchestratorService, WhatsAppIngestService],
})
export class WhatsAppModule {
  private readonly logger = new Logger(WhatsAppModule.name);
  constructor() {
    const provider = (process.env.WHATSAPP_PROVIDER || 'simulator').toLowerCase();
    this.logger.log(`WhatsApp habilitado — proveedor='${provider}'.`);
  }
}
