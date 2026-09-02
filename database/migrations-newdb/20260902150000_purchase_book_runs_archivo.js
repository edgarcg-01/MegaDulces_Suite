/**
 * LC.6.3 — Guarda el TXT que se entregó, no sólo su hash.
 *
 * La corrida guardaba `archivo_hash` + `archivo_nombre` pero **no el contenido**: el TXT se
 * regeneraba en cada descarga. Dos consecuencias, las dos malas:
 *
 *   1. `GET /archivo` llamaba a `generar()`, que ESCRIBE. Descargar un mes que ya estaba
 *      en `entregado` lo regresaba a `generado` — el trámite retrocedía solo.
 *   2. El hash se recalculaba en cada descarga. Si entre generar y descargar llegaba un
 *      CFDI nuevo (y llegan: el feed del ADD corre continuo), el archivo bajado ya no era
 *      el firmado, y como el hash se pisaba nadie se enteraba. El hash dejaba de probar
 *      nada, que era exactamente para lo que existía.
 *
 * Por qué persistir el contenido y no derivarlo (§32 "nunca copiar tablas"): esto NO es una
 * copia de una tabla ni un valor inventado — es el **artefacto entregado a un tercero**, y
 * su fuente es mutable por diseño. `fiscal.cfdis` sigue creciendo, así que el TXT del
 * 3-sep-2026 es irreproducible el 4-sep. Mismo criterio que el snapshot denormalizado de
 * `daily_captures.captured_by_username`: evidencia de auditoría, no debt.
 *
 * Tamaño: el mes más grande medido (ago-2026, 515 facturas, 1,058 renglones) pesa 225 KB.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('finance').hasTable('purchase_book_runs'))) return;

  if (!(await knex.schema.withSchema('finance').hasColumn('purchase_book_runs', 'archivo_contenido'))) {
    await knex.raw(`ALTER TABLE finance.purchase_book_runs ADD COLUMN archivo_contenido text`);
    await knex.raw(`
      COMMENT ON COLUMN finance.purchase_book_runs.archivo_contenido IS
        'El TXT exacto que se entregó a contabilidad, tal como se importa a ContPAQi. Se guarda porque su fuente (fiscal.cfdis) sigue creciendo: el archivo no se puede reproducir después. La descarga lo sirve de aquí, sin regenerar.'`);
  }
};

exports.down = async function (knex) {
  if (await knex.schema.withSchema('finance').hasColumn('purchase_book_runs', 'archivo_contenido')) {
    await knex.schema.withSchema('finance').alterTable('purchase_book_runs', (t) => t.dropColumn('archivo_contenido'));
  }
};
