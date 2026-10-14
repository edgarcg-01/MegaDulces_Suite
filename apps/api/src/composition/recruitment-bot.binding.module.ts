import { Global, Module } from '@nestjs/common';
import { RECRUITMENT_BOT_PORT } from '@megadulces/contracts';
import { HrModule, HrRecruitmentBotService } from '@megadulces/hr';

/**
 * Composition root del Port del bot de reclutamiento (Fase RH, `[RH.3.1]`).
 *
 * Liga RECRUITMENT_BOT_PORT (contracts, inyectado @Optional por la ingesta de WhatsApp) al `HrRecruitmentBotService` de
 * libs/hr. Único lugar que conoce ambos lados → libs/whatsapp no importa hr. @Global para que el token sea resoluble desde
 * WhatsAppModule. Mismo molde que BankCaptureBindingModule.
 */
@Global()
@Module({
  imports: [HrModule],
  providers: [{ provide: RECRUITMENT_BOT_PORT, useExisting: HrRecruitmentBotService }],
  exports: [RECRUITMENT_BOT_PORT],
})
export class RecruitmentBotBindingModule {}
