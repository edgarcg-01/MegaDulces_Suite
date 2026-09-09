// @megadulces/contracts — barrel público.
// Tipos de eventos cross-domain + DTOs compartidos + Port interfaces.
// SIN deps de runtime de NestJS: solo tipos y constantes string.
// Producer y consumer importan el mismo tipo → un cambio de payload
// es error de compilación en ambos lados (garantía "no romper en silencio").

export * from './ports/order-fulfillment.port';
export * from './ports/customer-provisioning.port';
export * from './ports/finance-notifier.port';
export * from './ports/recon-notifier.port';
export * from './ports/finance-findings-sink.port';
export * from './ports/invoice-issuer.port';
export * from './ports/commerce-conversation.port';
export * from './ports/bank-capture.port';
export * from './ports/health-notifier.port';
export * from './ports/mailer.port';

// ── http wire contracts (ADR-052): request/response del boundary REST ──
export * from './http/command-center.contract';
// [VP.2.1] Procedencia (ADR-056): con qué se calculó el número que se publica.
export * from './http/provenance.contract';
// [CH.1.10] Identidad: el tipo de cuenta y la duración de sesión de un dispositivo.
export * from './http/identity.contract';
// [TDA.1] Tienda: los eventos que el gateway /store empuja a las pantallas.
export * from './http/store.contract';

// ── [ID.28] authz — NO se re-exporta desde acá, a propósito ───────────────────
// El catálogo de permisos vive en `./authz` y se importa por SUBRUTA:
//   · `@megadulces/contracts/permissions` → el enum `Permission` (caliente)
//   · `@megadulces/contracts/authz`       → enum + árbol + etiquetas + presets
//
// Colgarlo de este barrel fue el primer intento y **rompió el presupuesto de
// bundle de `apps/view`**: este archivo lo importan cosas del chunk inicial de
// las 3 apps Angular, así que los ~80 kB de dato del catálogo —que sólo
// necesita una pantalla lazy— se iban al arranque. +225 kB medidos.
//
// La regla que queda: un barrel compartido por backend y frontend no puede
// llevar dato frío. Si agregás algo grande y sólo lo usa una pantalla, dale su
// subruta.
