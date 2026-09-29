import { Module } from '@nestjs/common';
import { SupplierPaymentObligationsService } from './supplier-payment-obligations.service';
import { SupplierPaymentObligationsController } from './supplier-payment-obligations.controller';
import { SupplierCreditTermsService } from './supplier-credit-terms.service';
import { SupplierCreditTermsController } from './supplier-credit-terms.controller';

/**
 * Fase TP.1 (ADR-064) — Obligaciones a proveedor de mercancía (Compras). Alimenta el
 * Calendario de Pagos de Finanzas (que solo lee `commercial.supplier_payment_obligations`
 * vía knex directo, sin depender de este módulo).
 *
 * `[RE.30]` — también el plazo de pago por proveedor (días + base factura/recepción), que es
 * de donde va a salir el vencimiento de cada obligación.
 */
@Module({
  controllers: [SupplierPaymentObligationsController, SupplierCreditTermsController],
  providers: [SupplierPaymentObligationsService, SupplierCreditTermsService],
  exports: [SupplierPaymentObligationsService, SupplierCreditTermsService],
})
export class CommercialSupplierPaymentObligationsModule {}
