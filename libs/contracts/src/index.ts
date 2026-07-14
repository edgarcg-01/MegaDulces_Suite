// @megadulces/contracts — barrel público.
// Tipos de eventos cross-domain + DTOs compartidos + Port interfaces.
// SIN deps de runtime de NestJS: solo tipos y constantes string.
// Producer y consumer importan el mismo tipo → un cambio de payload
// es error de compilación en ambos lados (garantía "no romper en silencio").

export * from './ports/order-fulfillment.port';
export * from './ports/customer-provisioning.port';
export * from './ports/finance-notifier.port';
export * from './ports/finance-findings-sink.port';
