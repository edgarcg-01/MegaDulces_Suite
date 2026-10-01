import { Module } from '@nestjs/common';
import { SupplierPaymentObligationsService } from './supplier-payment-obligations.service';
import { SupplierPaymentObligationsController } from './supplier-payment-obligations.controller';
import { SupplierCreditTermsService } from './supplier-credit-terms.service';
import { SupplierCreditTermsController } from './supplier-credit-terms.controller';
import { PurchaseDeliveriesService } from './purchase-deliveries.service';
import { PurchaseDeliveriesController } from './purchase-deliveries.controller';

/**
 * Fase TP.1 (ADR-064) — Obligaciones a proveedor de mercancía (Compras). Alimenta el
 * Calendario de Pagos de Finanzas (que solo lee `commercial.supplier_payment_obligations`
 * vía knex directo, sin depender de este módulo).
 *
 * `[RE.30]` — también el plazo de pago por proveedor (días + base factura/recepción), que es
 * de donde va a salir el vencimiento de cada obligación.
 *
 * `[RE.32]` — y la entrega de compras recibidas a Finanzas (folio, quién entrega, quién recibe).
 */
@Module({
  controllers: [SupplierPaymentObligationsController, SupplierCreditTermsController, PurchaseDeliveriesController],
  providers: [SupplierPaymentObligationsService, SupplierCreditTermsService, PurchaseDeliveriesService],
  exports: [SupplierPaymentObligationsService, SupplierCreditTermsService, PurchaseDeliveriesService],
})
export class CommercialSupplierPaymentObligationsModule {}
