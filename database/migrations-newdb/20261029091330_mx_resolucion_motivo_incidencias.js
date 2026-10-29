'use strict';
/**
 * `[MX.2.4]` — **La resolución de una incidencia de movimientos guarda su MOTIVO.**
 *
 * La bandeja `/almacen/incidencias` (MX.3.2) trae sólo lo que el motor no pudo dar por bueno; al
 * atender una, la persona dice POR QUÉ quedó resuelta (se corrigió en Kepler, faltante confirmado,
 * error de captura…). Decisión D8 de la fase (Edgar, 2026-10-29): se guarda en la misma tabla que la
 * marca «auditado» del Diario, `commercial.stock_movement_audits` — una sola tabla de estado humano
 * por documento, no una segunda. La nota libre ya existía (`note`); faltaba el motivo CODIFICADO, que
 * es lo que permite contar después cuántas incidencias fueron faltante real y cuántas captura.
 *
 * ── Lo medido antes (sólo lectura, prod 2026-10-28) ─────────────────────────────────────────
 *  · 4,282 marcas «auditado» en la tabla; el 90.7 % sobre documentos que el motor ya cuadraba (MX.0.1).
 *  · Esas marcas NO traen motivo: quedan con `resolution_reason` NULL, que la bandeja lee como
 *    «auditado en el Diario sin motivo» — no como resuelta. No se inventa un motivo para el pasado.
 *
 * Sin CHECK de vocabulario a propósito: el catálogo de motivos vive en `@megadulces/contracts`
 * (`MOTIVOS_RESOLUCION_MOVIMIENTO`) y el servicio lo valida; un CHECK duplicaría la lista y obligaría
 * a una migración por motivo nuevo. La prueba `test-newdb-mx-resolucion.js` ejerce el rechazo.
 *
 * Columna nullable sin default: sólo metadatos, no reescribe la tabla. Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`ALTER TABLE commercial.stock_movement_audits ADD COLUMN IF NOT EXISTS resolution_reason text`);
  await knex.raw(`COMMENT ON COLUMN commercial.stock_movement_audits.resolution_reason IS
    '[MX.2.4] motivo con que se resolvió la incidencia (catálogo MOTIVOS_RESOLUCION_MOVIMIENTO de @megadulces/contracts). NULL = marca del Diario sin motivo: no cuenta como resuelta.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE commercial.stock_movement_audits DROP COLUMN IF EXISTS resolution_reason`);
};
