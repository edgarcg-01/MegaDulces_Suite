import { Global, Module } from '@nestjs/common';
import { FINANCE_FINDINGS_SINK_PORT } from '@megadulces/contracts';
import { FinanceMaatModule, MaatFindingsSinkService } from '@megadulces/finance';

/**
 * FISCAL.1.1 — Composition root del Port de consolidación de hallazgos.
 *
 * Liga FINANCE_FINDINGS_SINK_PORT (declarado en contracts, inyectado @Optional
 * por el bridge de libs/fiscal) a la impl real de Maat (MaatFindingsSinkService
 * → finance.findings). @Global() para que el token resuelva sin que fiscal
 * importe finance. Único lugar que conoce ambos lados.
 *
 * Si este módulo no se registra (o Maat está apagado), fiscal sigue corriendo
 * sin consolidar: la inyección es @Optional y best-effort.
 */
@Global()
@Module({
  imports: [FinanceMaatModule],
  providers: [{ provide: FINANCE_FINDINGS_SINK_PORT, useExisting: MaatFindingsSinkService }],
  exports: [FINANCE_FINDINGS_SINK_PORT],
})
export class FinanceFindingsSinkBindingModule {}
