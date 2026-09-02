import { Module } from '@nestjs/common';
import { CancelledDocsService } from './cancelled-docs.service';
import { CancelledDocsController } from './cancelled-docs.controller';

/**
 * Apartado "Documentos cancelados" (Kepler c43='C'). Read-only sobre la vista
 * analytics.kepler_cancelled_docs (derive-no-copy). TenantKnexService/TenantContextService
 * vienen del core global.
 */
@Module({
  controllers: [CancelledDocsController],
  providers: [CancelledDocsService],
  exports: [CancelledDocsService],
})
export class FinanceCancelledDocsModule {}
