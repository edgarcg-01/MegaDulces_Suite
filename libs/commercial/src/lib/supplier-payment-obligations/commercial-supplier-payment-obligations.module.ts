import { Module } from '@nestjs/common';
import { SupplierPaymentObligationsService } from './supplier-payment-obligations.service';
import { SupplierPaymentObligationsController } from './supplier-payment-obligations.controller';

/**
 * Fase TP.1 (ADR-064) — Obligaciones a proveedor de mercancía (Compras). Alimenta el
 * Calendario de Pagos de Finanzas (que solo lee `commercial.supplier_payment_obligations`
 * vía knex directo, sin depender de este módulo).
 */
@Module({
  controllers: [SupplierPaymentObligationsController],
  providers: [SupplierPaymentObligationsService],
  exports: [SupplierPaymentObligationsService],
})
export class CommercialSupplierPaymentObligationsModule {}
