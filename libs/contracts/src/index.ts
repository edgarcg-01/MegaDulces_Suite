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
// [SN.2] Identidad: el contexto de la persona en sesión (persona/puesto/departamento) para "Mi trabajo".
export * from './http/identity-me.contract';
// [OR.4] Trabajo: el vocabulario común de una tarea asignada. El reparto se construyó CUATRO veces
// (recon_tasks, supervisor_tasks, inventory_count_assignments, daily_assignments) y ninguna subió a
// libs/. Esto NO crea una quinta tabla: declara el mapeo de las cuatro a un solo vocabulario, y
// enumera lo que cada una NO puede contestar. Sólo tipos y constantes: no pega al bundle.
export * from './work/task.contract';
// [TDA.1] Tienda: los eventos que el gateway /store empuja a las pantallas.
export * from './http/store.contract';
// Orden canónico de presentación de tiendas (PH · MA · MM · 8ESQ · LPA · YUR · CAN · Zamora · CEDIS).
// Dato chico: no pega al bundle inicial.
export * from './http/warehouse-order.contract';
// [GX.9] Egresos: etiqueta/serie por familia contable (150 activo · 511 compras · 6xx gastos · 702-764 financieros e impuestos).
// Dato chico (4 entradas): no pega al bundle inicial.
export * from './http/expense-family.contract';

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
