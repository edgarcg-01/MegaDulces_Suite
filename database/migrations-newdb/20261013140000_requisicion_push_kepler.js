'use strict';
/**
 * `[KR.2]` — **La requisición dice si ya salió hacia Kepler, y con qué folio.**
 *
 * Hermana de `[RQ.15]` (`20261009182516`), que guarda la coordenada de la ORDEN DE COMPRA que
 * alguien capturó a mano. Ésta guarda la de la REQUISICIÓN que escribimos nosotros. Son dos
 * documentos distintos de la misma cadena y no comparten columna a propósito: confundirlos
 * haría que "esto ya se pidió" y "esto ya se compró" fueran el mismo dato.
 *
 * ── Para qué sirve de verdad: idempotencia ──────────────────────────────────────────────────
 *
 * ⛔ **Sin estas columnas, dos envíos crean DOS documentos en el ERP y no hay forma de saberlo
 * desde acá** — habría que ir a contarlos a Kepler. No es hipotético: pasó el 2026-10-13, en el
 * primer uso real y todavía sin botón. La requisición `RQ-2026-00807` se empujó dos veces con
 * segundos de diferencia y dejó los folios `0003114` (consolidado) y `0003115` (6 renglones)
 * vivos a la vez — **$175,608.84 de requisiciones para una necesidad de $87,804.42**, a un
 * proveedor real. Se quitó uno a mano desde «Baja de requisición».
 *
 * El índice único parcial es lo que convierte el reenvío en un no-op en vez de en un duplicado.
 *
 * ⚠️ Nace NULLABLE y **sin backfill**. Las requisiciones que ya existen nunca salieron hacia
 * Kepler; ponerles un folio inferido por fecha e importe sería fabricar un vínculo que nadie
 * verificó, justo en la columna que después dice "esto ya está en el ERP". Se DECLARA el hueco
 * (ADR-056) y se llena hacia adelante. La única liga real que existe hoy —`RQ-2026-00807` →
 * `00`/`0003114`— se captura a mano, porque se creó antes que esta migración.
 *
 * ── Por qué `kepler_error` y no sólo el folio ───────────────────────────────────────────────
 *
 * ⭐ Porque "no salió" y "salió mal" son dos ausencias distintas y se arreglan distinto: la
 * primera la resuelve volver a intentar, la segunda la resuelve una persona. Con una sola
 * columna en NULL las dos se leen igual — que es exactamente el modo de fallar que ADR-056
 * existe para evitar.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const tiene = async (col) =>
    knex.schema.withSchema('commercial').hasColumn('purchase_requisitions', col);

  const columnas = [
    ['kepler_sucursal', (t) => t.text('kepler_sucursal')],
    ['kepler_folio', (t) => t.text('kepler_folio')],
    ['kepler_pushed_at', (t) => t.timestamp('kepler_pushed_at', { useTz: true })],
    ['kepler_pushed_by', (t) => t.uuid('kepler_pushed_by')],
    ['kepler_error', (t) => t.text('kepler_error')],
  ];
  for (const [col, add] of columnas) {
    if (!(await tiene(col))) {
      await knex.schema.withSchema('commercial').alterTable('purchase_requisitions', add);
    }
  }

  // ⛔ Las DOS o NINGUNA — misma razón que `[RQ.15]`: el folio se repite entre sucursales, así
  // que media coordenada apunta a varios documentos y se lee como si apuntara a uno.
  await knex.raw(`ALTER TABLE commercial.purchase_requisitions
                    DROP CONSTRAINT IF EXISTS purchase_req_kepler_completa_chk`);
  await knex.raw(`
    ALTER TABLE commercial.purchase_requisitions
      ADD CONSTRAINT purchase_req_kepler_completa_chk
      CHECK ((kepler_sucursal IS NULL AND kepler_folio IS NULL)
          OR (btrim(COALESCE(kepler_sucursal,'')) <> '' AND btrim(COALESCE(kepler_folio,'')) <> ''))`);

  // Un documento de Kepler sale de UNA requisición, y una requisición produce UN documento.
  // Parcial: lo no enviado no compite.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS purchase_req_kepler_unica
      ON commercial.purchase_requisitions (tenant_id, kepler_sucursal, kepler_folio)
      WHERE kepler_folio IS NOT NULL`);

  await knex.raw(`
    COMMENT ON COLUMN commercial.purchase_requisitions.kepler_folio IS
      'KR.2 - folio de la requisicion X-A-30 que ESTA Suite escribio en Kepler (no la captura '
      'una persona: la escribe el sink). Junto con kepler_sucursal es la coordenada del '
      'documento en el ERP. NULL = nunca salio; si ademas kepler_error tiene texto, salio y '
      'fallo. NO se infiere por fecha e importe.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP INDEX IF EXISTS commercial.purchase_req_kepler_unica`);
  await knex.raw(`ALTER TABLE commercial.purchase_requisitions
                    DROP CONSTRAINT IF EXISTS purchase_req_kepler_completa_chk`);
  for (const col of ['kepler_error', 'kepler_pushed_by', 'kepler_pushed_at', 'kepler_folio', 'kepler_sucursal']) {
    if (await knex.schema.withSchema('commercial').hasColumn('purchase_requisitions', col)) {
      await knex.schema.withSchema('commercial').alterTable('purchase_requisitions', (t) => t.dropColumn(col));
    }
  }
};
