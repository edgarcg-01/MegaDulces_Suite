import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CloudinaryModule, AiProductMatcherModule } from '@megadulces/platform-core';
import { SupplierPaymentProofsService } from './supplier-payment-proofs.service';
import { SupplierPaymentProofsController } from './supplier-payment-proofs.controller';
import { PagosComprobantesGateway } from './pagos-comprobantes.gateway';

/**
 * Fase CC (extensión) — Comprobantes de Pago a Proveedor. Adjunta el comprobante
 * de transferencia (imagen/PDF) + OCR a un pago de Kepler (XD2501). Reusa
 * `CloudinaryModule` (adjunto img/PDF) y `AiProductMatcherModule` (que exporta
 * `LlmExtractorService` para el OCR). Lee los pagos del espejo read-only
 * `analytics.erp_supplier_payments`; NO escribe a Kepler.
 */
@Module({
  imports: [
    CloudinaryModule,
    AiProductMatcherModule,
    // JwtModule local para el handshake del gateway (mismo default que AlertsGateway).
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'super_secret_dev_key_change_in_prod',
      signOptions: { expiresIn: (process.env.JWT_EXPIRES_IN || '12h') as any },
    }),
  ],
  controllers: [SupplierPaymentProofsController],
  providers: [SupplierPaymentProofsService, PagosComprobantesGateway],
  exports: [SupplierPaymentProofsService],
})
export class FinanceSupplierPaymentProofsModule {}
