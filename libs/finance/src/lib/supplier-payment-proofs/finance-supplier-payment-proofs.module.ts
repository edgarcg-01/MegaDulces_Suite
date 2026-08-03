import { Module } from '@nestjs/common';
import { CloudinaryModule, AiProductMatcherModule } from '@megadulces/platform-core';
import { SupplierPaymentProofsService } from './supplier-payment-proofs.service';
import { SupplierPaymentProofsController } from './supplier-payment-proofs.controller';

/**
 * Fase CC (extensión) — Comprobantes de Pago a Proveedor. Adjunta el comprobante
 * de transferencia (imagen/PDF) + OCR a un pago de Kepler (XD2501). Reusa
 * `CloudinaryModule` (adjunto img/PDF) y `AiProductMatcherModule` (que exporta
 * `LlmExtractorService` para el OCR). Lee los pagos del espejo read-only
 * `analytics.erp_supplier_payments`; NO escribe a Kepler.
 */
@Module({
  imports: [CloudinaryModule, AiProductMatcherModule],
  controllers: [SupplierPaymentProofsController],
  providers: [SupplierPaymentProofsService],
  exports: [SupplierPaymentProofsService],
})
export class FinanceSupplierPaymentProofsModule {}
