import { Global, Module } from '@nestjs/common';
import { CFDI_ESTATUS_PORT } from '@megadulces/finance';
import { FiscalEstatusModule, EstatusService } from '@megadulces/fiscal';

/**
 * `[LC.19.1]` — Composition root del Port de verificación de estatus CFDI ante el SAT.
 *
 * Liga CFDI_ESTATUS_PORT (declarado por el libro de compras en libs/finance, inyectado
 * @Optional) a `EstatusService.verificarUuids` de libs/fiscal (WS ConsultaCFDIService). finance
 * no puede importar fiscal por frontera; éste es el único lugar que conoce los dos lados.
 * @Global() para que el token resuelva desde FinancePurchaseBookModule.
 *
 * Sin este módulo el libro sigue funcionando, pero no puede verificar: lo declara y no deja
 * postear lo que no consta vigente.
 */
@Global()
@Module({
  imports: [FiscalEstatusModule],
  providers: [{ provide: CFDI_ESTATUS_PORT, useExisting: EstatusService }],
  exports: [CFDI_ESTATUS_PORT],
})
export class CfdiEstatusBindingModule {}
