import { Global, Module } from '@nestjs/common';
import { BANK_CAPTURE_PORT } from '@megadulces/contracts';
import { FinanceBankCaptureModule, BankCaptureService } from '@megadulces/finance';

/**
 * Composition root del Port de captura bancaria (ADR-042, Fase CBW).
 *
 * Liga BANK_CAPTURE_PORT (contracts, inyectado @Optional por la ingesta de
 * WhatsApp) al `BankCaptureService` de finance. Único lugar que conoce ambos
 * lados → libs/whatsapp no importa finance. @Global para que el token sea
 * resoluble desde WhatsAppModule.
 *
 * El servicio ya implementa el contrato (resolveSender/capture/confirm), así que
 * el binding es un simple alias (useExisting), sin adapter intermedio.
 */
@Global()
@Module({
  imports: [FinanceBankCaptureModule],
  providers: [{ provide: BANK_CAPTURE_PORT, useExisting: BankCaptureService }],
  exports: [BANK_CAPTURE_PORT],
})
export class BankCaptureBindingModule {}
