// @megadulces/commercial — barrel público.
// Dominio Comercial: clientes, almacenes, pricing, inventario, órdenes
// (state machine + reserva/consumo atómico), analytics, alerts, recomendaciones,
// promociones, productos, catalog-search, televenta, portal AI order,
// ticket OCR e ingesta ERP (mega-dulces-sync). Depende solo de platform-core
// + contracts. NO importa trade ni logistics.

export * from './lib/commercial-customers/commercial-customers.module';
export * from './lib/commercial-warehouses/commercial-warehouses.module';
export * from './lib/commercial-pricing/commercial-pricing.module';
export * from './lib/commercial-inventory/commercial-inventory.module';
export * from './lib/commercial-orders/commercial-orders.module';
export * from './lib/commercial-analytics/commercial-analytics.module';
export * from './lib/commercial-alerts/commercial-alerts.module';
export * from './lib/commercial-recommendations/commercial-recommendations.module';
export * from './lib/commercial-promotions/commercial-promotions.module';
export * from './lib/commercial-products/commercial-products.module';
export * from './lib/commercial-catalog-search/commercial-catalog-search.module';
export * from './lib/commercial-televenta/commercial-televenta.module';
export * from './lib/commercial-route-control/commercial-route-control.module';
export * from './lib/commercial-vendor-sales/commercial-vendor-sales.module';
export * from './lib/portal-ai-order/portal-ai-order.module';
export * from './lib/ticket-extractor/ticket-extractor.module';
export * from './lib/mega-dulces-sync/mega-dulces-sync.module';
export * from './lib/commercial-telemetry/commercial-telemetry.module';

// Servicio expuesto para el composition root (OrderFulfillmentBindingModule).
export * from './lib/commercial-orders/commercial-orders.service';
