/**
 * `[RE.25]` — Las señales del **cuadre del documento** en `finance.goods_receipt_proofs`.
 *
 * El paso de auditar renglón por renglón salió del alcance: el lineado se verifica antes de
 * subir a Kepler. Lo que nadie verificaba es el documento como un todo — **quién** lo emitió y
 * **por cuánto**. El importe ya se guardaba (`monto_match`, `discrepancy_kind`); el proveedor
 * no se comparaba nunca, aunque `ocr_proveedor`/`ocr_rfc` se venían guardando desde el inicio.
 *
 * Se persisten las **señales**, no el veredicto. El bucket (`cuadra`/`revisar`/`sin_datos`) se
 * deriva de ellas en una sola expresión compartida por el filtro y el select: una columna de
 * bucket persistida podría quedar desalineada de las señales que la explican, y entonces la
 * pantalla diría "cuadra" mostrando debajo un proveedor que no coincide.
 *
 * El criterio de cada columna está medido sobre los 161 comprobantes que había en prod al
 * escribir esto y documentado en `libs/finance/.../receipt-match.ts`. En resumen:
 *   · `prov_score`   — parecido de nombres 0..1. La señal FUERTE (76% de acierto medido).
 *   · `prov_rfc_match` — la señal DÉBIL (49%): corrobora, nunca decide. `NULL` cuando alguno de
 *     los dos RFC está malformado, que en Kepler pasa seguido (sólo 108 de 123 bien formados,
 *     y poblado en el 48% de las entradas).
 *   · `paquete_ok`   — ¿el paquete trae NUESTRA hoja interna (la orden de entrada)? Es el
 *     control que Edgar pidió en lugar del folio, y va **fuera del bucket**: hoy sólo 7 de 161
 *     paquetes la traen, así que hacerlo puerta mandaría el 96% a revisión manual.
 *
 * Las tres admiten `NULL` a propósito: `NULL` es **"no se pudo comparar"** y no es lo mismo que
 * `false` = "no coincide". Colapsarlos haría que un OCR ilegible se lea como un descuadre del
 * proveedor, que es justo la confusión que este diseño evita.
 *
 * Idempotente (`hasColumn`) y **aditiva**: no toca ni reinterpreta ninguna columna existente.
 * Las filas viejas quedan en `NULL` hasta que corra el backfill —
 * `database/scripts/backfill-receipt-match.js`— y eso es correcto: `NULL` dice "todavía no se
 * evaluó", que es la verdad.
 */

exports.up = async function up(knex) {
  const t = 'goods_receipt_proofs';
  const has = (col) => knex.schema.withSchema('finance').hasColumn(t, col);

  if (!(await has('prov_score'))) {
    await knex.schema.withSchema('finance').alterTable(t, (tb) => {
      tb.decimal('prov_score', 4, 3).nullable();
    });
  }
  if (!(await has('prov_rfc_match'))) {
    await knex.schema.withSchema('finance').alterTable(t, (tb) => {
      tb.boolean('prov_rfc_match').nullable();
    });
  }
  if (!(await has('paquete_ok'))) {
    await knex.schema.withSchema('finance').alterTable(t, (tb) => {
      tb.boolean('paquete_ok').nullable();
    });
  }
  // `[RE.26]` El folio impreso en NUESTRA hoja interna, y si es el de esta entrada. Es el
  // control que detecta la evidencia pegada a la orden equivocada — medido, hay casos reales
  // (`0000863` con un `XA2001-0001120` adentro). Se guarda el folio LEÍDO además del veredicto
  // para que la pantalla pueda mostrar contra qué se comparó, y no sólo que no coincide.
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

  await knex.raw(`
    COMMENT ON COLUMN finance.goods_receipt_proofs.prov_score IS
      'RE.25 — parecido 0..1 entre el proveedor del papel (ocr_proveedor) y el de la entrada. Señal FUERTE (76% medido). NULL = no comparable (falta un lado), que no es 0.';
    COMMENT ON COLUMN finance.goods_receipt_proofs.prov_rfc_match IS
      'RE.25 — el RFC del papel coincide con el de Kepler, normalizado. Señal DÉBIL (49% medido): CORROBORA, nunca decide. NULL cuando alguno está malformado — en Kepler pasa seguido.';
    COMMENT ON COLUMN finance.goods_receipt_proofs.paquete_ok IS
      'RE.25 — el paquete incluye NUESTRA hoja interna. Sale del ROL que declara el capturista (files[].role), no de lo que adivina el OCR: medido, 93 de 161 vs 7. Informativo, NO entra al bucket.';
    COMMENT ON COLUMN finance.goods_receipt_proofs.folio_interno IS
      'RE.26 — folio impreso en nuestra hoja interna, tal cual lo leyó el OCR (ej. "XA2001-0000353"). Se guarda crudo para poder mostrar contra qué se comparó.';
    COMMENT ON COLUMN finance.goods_receipt_proofs.folio_interno_ok IS
      'RE.26 — ese folio es el de ESTA entrada (comparado sin el prefijo del doctype). Detecta evidencia pegada a la orden equivocada. NULL = no se pudo comparar.';
  `);
};

/**
 * Baja aditiva: se borran las 3 columnas, que no existían antes de esta migración y de las que
 * nada más cuelga (el bucket se deriva en la query, no hay vista ni índice encima).
 */
exports.down = async function down(knex) {
  const t = 'goods_receipt_proofs';
  for (const col of ['prov_score', 'prov_rfc_match', 'paquete_ok', 'folio_interno', 'folio_interno_ok']) {
    if (await knex.schema.withSchema('finance').hasColumn(t, col)) {
      await knex.schema.withSchema('finance').alterTable(t, (tb) => tb.dropColumn(col));
    }
  }
};
