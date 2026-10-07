/**
 * `[RE.26.2]` — Las 2 columnas del **folio interno** que se quedaron fuera de prod.
 *
 * ⚠️ **Por qué existe esta migración y no vive en `20260902160000`.**
 * Esas dos columnas SÍ estaban escritas en `20260902160000_re25_receipt_match_signals.js`, pero
 * las agregué **después** de que esa migración ya había corrido en prod (batch 251, 2026-09-02
 * 19:35, cuando traía sólo las 3 señales del proveedor). Knex la tenía registrada en
 * `public.knex_migrations`, así que nunca la volvió a ejecutar: prod quedó con `prov_score` /
 * `prov_rfc_match` / `paquete_ok` y **sin** `folio_interno` / `folio_interno_ok`, y la lista de
 * `/compras/costo-por-compra` tronó completa con `42703 column "folio_interno" does not exist`.
 *
 * **La lección: una migración ya aplicada es historia, no un archivo editable.** Ser idempotente
 * no ayuda — el problema no es que se ejecute dos veces, es que **no se vuelve a ejecutar nunca**.
 * Lo que se agrega después va en un archivo nuevo, siempre.
 *
 * (La otra mitad del incidente estaba en el código: un solo `existeCol('prov_score')` gateaba los
 * dos grupos de columnas, así que dio por presentes unas que no estaban. Cada grupo que puede
 * llegar en un despliegue distinto ahora se prueba solo.)
 *
 * `folio_interno` es el folio impreso en **nuestra hoja** dentro del paquete de evidencia, y
 * `folio_interno_ok` dice si es el de ESTA entrada. Es el control que detecta evidencia pegada a
 * la orden equivocada — medido, pasa de verdad (`0000863` con un `XA2001-0001120` adentro). Se
 * guarda el folio leído además del veredicto para que la pantalla muestre **contra qué** se
 * comparó, y no sólo que no coincide.
 *
 * Idempotente (`hasColumn`): en local y en `platform_test`, donde `20260902160000` sí corrió con
 * las 5, esta migración no hace nada y sólo se registra.
 */

exports.up = async function up(knex) {
  const t = 'goods_receipt_proofs';
  const has = (col) => knex.schema.withSchema('finance').hasColumn(t, col);

  if (!(await has('folio_interno'))) {
    await knex.schema.withSchema('finance').alterTable(t, (tb) => {
      tb.text('folio_interno').nullable();
    });
  }
  if (!(await has('folio_interno_ok'))) {
    await knex.schema.withSchema('finance').alterTable(t, (tb) => {
      tb.boolean('folio_interno_ok').nullable();
    });
  }

  // `NULL` = "no se pudo comparar", que **no** es `false` = "no coincide". Las filas viejas
  // quedan en `NULL` hasta que corra `database/scripts/backfill-receipt-match.js`, y eso es
  // correcto: dice "todavía no se evaluó", que es la verdad.
  await knex.raw(`
    COMMENT ON COLUMN finance.goods_receipt_proofs.folio_interno IS
      'RE.26 — folio impreso en nuestra hoja interna, tal cual lo leyó el OCR (ej. "XA2001-0000353"). Se guarda crudo para poder mostrar contra qué se comparó.';
    COMMENT ON COLUMN finance.goods_receipt_proofs.folio_interno_ok IS
      'RE.26 — ese folio es el de ESTA entrada (comparado sin el prefijo del doctype, que NO es parte del número). Detecta evidencia pegada a la orden equivocada. NULL = no se pudo comparar.';
  `);
};

exports.down = async function down(knex) {
  const t = 'goods_receipt_proofs';
  for (const col of ['folio_interno', 'folio_interno_ok']) {
    if (await knex.schema.withSchema('finance').hasColumn(t, col)) {
      await knex.schema.withSchema('finance').alterTable(t, (tb) => tb.dropColumn(col));
    }
  }
};
