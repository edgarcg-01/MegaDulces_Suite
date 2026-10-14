/**
 * `[GX.15]` — **Un solo Chromium para los PDF** — ahora vive en `libs/platform-core` (`lib/pdf/chromium-pdf.ts`).
 *
 * Este archivo lo anunciaba: «si alguna vez se comparte, sube a un lib común». `[RH.3.3.3]` (el CV del candidato en
 * Recursos Humanos) es el segundo dominio que lo necesita, así que subió, y aquí sólo se reexporta para que los
 * consumidores de Finanzas (expediente de gasto, evidencias, pago de viajes) no cambien una línea.
 *
 * ⬜ Deuda declarada, sin cambios: `PaymentCalendarDocumentService` sigue con su copia y debe migrar al helper común.
 */
export { htmlAPdf, esc, money, type PdfOpts } from '@megadulces/platform-core';
