/**
 * `[RE.32.2]` — **La «Referencia» de la orden de entrada queda en el papel firmado.**
 *
 * `commercial.purchase_delivery_lines` es el SNAPSHOT de lo que Compras le entregó a Finanzas (el
 * PDF de firmas se arma con él). Igual que `oc_folio`, la referencia se copia al generar la
 * entrega, para que el detalle y el PDF digan lo mismo que se firmó aunque luego cambie en Kepler.
 *
 * Las entregas que YA existen se rellenan una vez desde la misma fuente que publica la vista
 * (`kdm1.c11` de la cabecera XA2001, ver `20261007300000`). Sólo se escribe donde está en NULL:
 * re-correrla no pisa nada. Las entradas que no son XA2001 (Wincaja) se quedan en NULL — no tienen
 * ese campo.
 *
 * Aditiva: el servicio sondea la columna y, si la migración no se ha aplicado, sigue funcionando
 * sin ella.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);

  const has = await knex.schema.withSchema('commercial').hasColumn('purchase_delivery_lines', 'referencia');
  if (!has) {
    await knex.raw(`ALTER TABLE commercial.purchase_delivery_lines ADD COLUMN referencia text`);
  }
  await knex.raw(`COMMENT ON COLUMN commercial.purchase_delivery_lines.referencia IS
    '[RE.32.2] «Referencia» de la orden de entrada en Kepler (kdm1.c11 del XA2001), copiada al generar la entrega. Texto capturado a mano.'`);

  await knex.raw(`
    UPDATE commercial.purchase_delivery_lines l
       SET referencia = NULLIF(btrim(k.c11), '')
      FROM kepler_ods.kdm1 k
     WHERE l.referencia IS NULL
       AND l.receipt_doc_prefix = 'XA2001'
       AND k.sucursal = l.receipt_sucursal
       AND btrim(k.c1) = k.sucursal
       AND k.c2 = 'X' AND k.c3 = 'A' AND btrim(k.c4::text) = '20'
       AND btrim(k.c6) = l.receipt_folio
       AND btrim(COALESCE(k.c43, '')) <> 'C'
       AND NULLIF(btrim(k.c11), '') IS NOT NULL`);
};

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE commercial.purchase_delivery_lines DROP COLUMN IF EXISTS referencia`);
};
