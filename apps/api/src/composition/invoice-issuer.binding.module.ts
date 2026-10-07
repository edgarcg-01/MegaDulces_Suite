import { Global, Module } from '@nestjs/common';
import { INVOICE_ISSUER_PORT } from '@megadulces/contracts';
import { FiscalEmisionModule, OrderInvoiceIssuerService } from '@megadulces/fiscal';

/**
 * FE.5 — Composition root del Port de emisión de facturas.
 *
 * Liga INVOICE_ISSUER_PORT (declarado en contracts, inyectado @Optional por
 * CommercialOrdersService al entregar un pedido) al adapter real de fiscal
 * (OrderInvoiceIssuerService → EmisionService → PAC). @Global() para que el token
 * resuelva sin que commercial importe fiscal. Único lugar que conoce ambos lados.
 *
 * Si no se registra (o fiscal/PAC apagado), commercial sigue entregando pedidos
 * sin facturar: la inyección es @Optional y best-effort.
 */
@Global()
@Module({
  imports: [FiscalEmisionModule],
  providers: [{ provide: INVOICE_ISSUER_PORT, useExisting: OrderInvoiceIssuerService }],
  exports: [INVOICE_ISSUER_PORT],
})
export class InvoiceIssuerBindingModule {}
