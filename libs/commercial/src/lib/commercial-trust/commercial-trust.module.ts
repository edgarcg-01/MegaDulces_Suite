import { Module } from '@nestjs/common';
import { ContactTrustEngineService } from './contact-trust-engine.service';
import { ContactTrustCronService } from './contact-trust-cron.service';

/**
 * FIQ.7 (ADR-037) — Trust-score del contacto + gate determinista.
 *
 * El motor (ContactTrustEngineService) se exporta para el composition root
 * (binding del Port conversacional). El cron nocturno refresca el feature store.
 * tk/tenantCtx/KNEX_NEW_DB vienen del @Global NewDatabaseModule.
 */
@Module({
  providers: [ContactTrustEngineService, ContactTrustCronService],
  exports: [ContactTrustEngineService],
})
export class CommercialTrustModule {}
