import { Global, Module } from '@nestjs/common';
import { RECRUITMENT_OUTBOUND_PORT, type RecruitmentOutboundPort } from '@megadulces/contracts';
import { WhatsAppIngestService, WhatsAppModule } from '@megadulces/whatsapp';

/**
 * Composition root de la SALIDA de reclutamiento (Fase RH, `[RH.3.3.4b]`).
 *
 * Liga RECRUITMENT_OUTBOUND_PORT (contracts, inyectado @Optional por libs/hr) al encolado de WhatsApp desde el número de
 * reclutamiento (`WhatsAppIngestService.sendRecruitmentText`). Único lugar que conoce ambos lados: libs/hr no importa
 * WhatsApp. Es el camino INVERSO de RecruitmentBotBindingModule y vive aparte a propósito: la ingesta ya depende del bot,
 * así que si el bot dependiera de la ingesta habría un ciclo; por eso lo consume un servicio de RH distinto del bot.
 */
@Global()
@Module({
  imports: [WhatsAppModule],
  providers: [{
    provide: RECRUITMENT_OUTBOUND_PORT,
    useFactory: (ingesta: WhatsAppIngestService): RecruitmentOutboundPort => ({
      sendText: (tenantId, to, body) => ingesta.sendRecruitmentText(tenantId, to, body),
    }),
    inject: [WhatsAppIngestService],
  }],
  exports: [RECRUITMENT_OUTBOUND_PORT],
})
export class RecruitmentOutboundBindingModule {}
