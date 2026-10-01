// @megadulces/commercial — barrel público.
// Dominio Comercial: clientes, almacenes, pricing, inventario, órdenes
// (state machine + reserva/consumo atómico), analytics, alerts, recomendaciones,
// promociones, productos, catalog-search, televenta, portal AI order,
// ticket OCR e ingesta ERP (mega-dulces-sync). Depende solo de platform-core
// + contracts. NO importa trade ni logistics.

export * from './lib/commercial-customers/commercial-customers.module';
export * from './lib/commercial-warehouses/commercial-warehouses.module';
export * from './lib/commercial-pricing/commercial-pricing.module';
export * from './lib/commercial-profitability/commercial-profitability.module';
export * from './lib/commercial-profitability/commercial-profitability.service';
export * from './lib/commercial-commissions/commercial-commissions.module';
export * from './lib/commercial-commissions/commercial-commissions.service';
export * from './lib/commercial-inventory/commercial-inventory.module';
export * from './lib/commercial-receiving/commercial-receiving.module';
export * from './lib/commercial-expiry-reviews/commercial-expiry-reviews.module';
// [FLT] Lista de faltantes: la venta que NO ocurrió, reportada desde el piso.
export * from './lib/commercial-stockouts/commercial-stockouts.module';
export * from './lib/commercial-stockouts/floor-stockouts.service';
// [BP] Bitácora de retiros en caja: Kepler exige contraseña de supervisor y no guarda el hecho.
export * from './lib/commercial-pos-voids/commercial-pos-voids.module';
export * from './lib/commercial-pos-voids/pos-line-voids.service';
export * from './lib/commercial-standard-cost/commercial-standard-cost.module';
export * from './lib/commercial-standard-cost/standard-cost.service';
// [MKT.1] Acuerdos con proveedor (formato MKTN001) y su expediente por plaza.
// NO confundir con commercial-promotions, que es el motor de PRECIO de los pedidos.
export * from './lib/commercial-promo-agreements/commercial-promo-agreements.module';
export * from './lib/commercial-promo-agreements/promo-agreements.service';
export * from './lib/commercial-orders/commercial-orders.module';
export * from './lib/commercial-payments/commercial-payments.module';
export * from './lib/commercial-home-delivery/commercial-home-delivery.module';
export * from './lib/commercial-home-delivery/commercial-home-delivery.service';
export * from './lib/commercial-rider-liquidation/commercial-rider-liquidation.module';
// Fase SU.2 — pool de pedidos por surtir + olas de surtido (ADR-067)
export * from './lib/commercial-picking/commercial-picking.module';
export * from './lib/commercial-picking/picking.service';
export * from './lib/commercial-carga/commercial-carga.module';
export * from './lib/commercial-analytics/commercial-analytics.module';
export * from './lib/commercial-replenishment/commercial-replenishment.module';
export * from './lib/commercial-movements/commercial-movements.module';
export * from './lib/commercial-bi-almacen/commercial-bi-almacen.module';
export * from './lib/commercial-sales-documents/commercial-sales-documents.module';
export * from './lib/commercial-sales-documents/commercial-sales-documents.service';
export * from './lib/commercial-tickets/commercial-tickets.module';
export * from './lib/commercial-tickets/commercial-tickets.service';
export * from './lib/commercial-tickets/customer-report.service';
export * from './lib/commercial-labels/commercial-labels.module';
export * from './lib/commercial-alerts/commercial-alerts.module';
export * from './lib/commercial-recommendations/commercial-recommendations.module';
export * from './lib/commercial-intelligence/commercial-intelligence.module';
export * from './lib/commercial-promotions/commercial-promotions.module';
export * from './lib/commercial-products/commercial-products.module';
export * from './lib/commercial-catalog-search/commercial-catalog-search.module';
export * from './lib/commercial-catalog-search/commercial-catalog-search.service';
export * from './lib/commercial-televenta/commercial-televenta.module';
export * from './lib/commercial-quotes/commercial-quotes.module';
export * from './lib/commercial-quotes/commercial-quotes.service';
export * from './lib/commercial-quotes/quote-pricing.service';
export * from './lib/commercial-stock-reservation/commercial-stock-reservation.module';
export * from './lib/commercial-stock-reservation/stock-reservation.service';
export * from './lib/commercial-trust/commercial-trust.module';
export * from './lib/commercial-trust/contact-trust-engine.service';
export * from './lib/commercial-route-control/commercial-route-control.module';
export * from './lib/commercial-vendor-sales/commercial-vendor-sales.module';
export * from './lib/commercial-vendor-routes/commercial-vendor-routes.module';
export * from './lib/commercial-tracking/commercial-tracking.module';
export * from './lib/portal-ai-order/portal-ai-order.module';
export * from './lib/ticket-extractor/ticket-extractor.module';
export * from './lib/mega-dulces-sync/mega-dulces-sync.module';
export * from './lib/commercial-telemetry/commercial-telemetry.module';
export * from './lib/commercial-push/commercial-push.module';
export * from './lib/commercial-push/commercial-push.service';
export * from './lib/supplier-payment-obligations/commercial-supplier-payment-obligations.module';
export * from './lib/supplier-payment-obligations/supplier-payment-obligations.service';
export * from './lib/supplier-payment-accounts/commercial-supplier-payment-accounts.module';
export * from './lib/supplier-payment-accounts/supplier-payment-accounts.service';

// Servicios expuestos para el composition root (binding modules de los Ports).
export * from './lib/commercial-orders/commercial-orders.service';
export * from './lib/commercial-customers/commercial-customers.service';
export * from './lib/commercial-alerts/alerts.service';
export * from './lib/entity-ref/entity-ref.module';
export * from './lib/entity-ref/entity-ref.types';

// [MKT.6] La otra mitad de la pregunta que abre [MKT.1]: el expediente prueba que la promoción
// se EJECUTÓ; esto mide si SIRVIÓ, leyendo la venta del ERP contra una línea base.
export * from './lib/commercial-promo-sellout/commercial-promo-sellout.module';
export * from './lib/commercial-promo-sellout/promo-sellout.service';
