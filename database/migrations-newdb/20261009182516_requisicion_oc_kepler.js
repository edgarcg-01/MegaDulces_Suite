'use strict';
/**
 * `[RQ.15]` — **La requisición dice CUÁL orden de compra salió de ella.**
 *
 * Sale de la auditoría de juntas que pidió Edgar el 2026-10-09: de las once juntas de la cadena
 * documental, ésta no estaba floja — **no existía**.
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-10-09) ────────────────────────────────────────
 *
 * ⛔ `commercial.purchase_requisitions` **no tiene ni una columna que apunte a Kepler**. Las
 * únicas que hablan de la orden son `ordered_at` y `ordered_by`: *cuándo* se ordenó y *quién* lo
 * marcó. **Cuál** orden salió, no lo guarda nadie.
 *
 * ⭐ **Y el 8.4% que esta junta mostraba en la auditoría era un artefacto, hay que decirlo:**
 * `approved`, `ordered` y `received` arrancan TODOS el 2026-09-28 — el flujo lleva once días
 * vivo, y el porcentaje promediaba dos meses en los que ese camino no existía. En la cohorte
 * real (desde el 28-sep) **221 de 449 avanzaron (49%)** y sólo 37 se cancelaron:
 *
 * | estado | docs | importe |
 * |---|---:|---:|
 * | pending_approval | 191 | $6,569,988 |
 * | approved | 158 | $6,512,618 |
 * | ordered | 53 | $11,586,824 |
 * | received | 10 | $450,000 |
 * | cancelled | 37 | $464,501 |
 *
 * ⇒ El embudo funciona. Lo que falta es que, al final, **la requisición y la OC queden atadas**:
 * hoy las 53 `ordered` por $11.6 M no se pueden seguir hasta la entrada de mercancía.
 *
 * ── Por qué TEXTO y no una llave foránea ────────────────────────────────────────────────────
 *
 * ⚠️ La OC vive en **Kepler**, no acá. No hay tabla propia a la que apuntar y no se va a crear
 * una (ADR-040: integrar, no construir). Se guarda la coordenada con la que Kepler identifica el
 * documento —**sucursal + folio**— que es la misma con la que `analytics.erp_purchase_orders` y
 * `erp_goods_receipts.oc_folio` ya lo nombran. Así la cadena se puede recorrer entera:
 * requisición → OC → entrada → factura.
 *
 * ⛔ **Nace NULLABLE y sin backfill.** Las 53 `ordered` que ya existen no tienen de dónde sacar
 * el folio: nadie lo capturó. Inventarlo por cercanía de fecha e importe sería fabricar un
 * vínculo que nadie verificó, en la tabla que después se usa para decir "esto se compró".
 * Se DECLARA el hueco (ADR-056) y se llena hacia adelante.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const tiene = async (col) => knex.schema.withSchema('commercial').hasColumn('purchase_requisitions', col);

  if (!(await tiene('oc_sucursal'))) {
    await knex.schema.withSchema('commercial').alterTable('purchase_requisitions', (t) => {
      t.text('oc_sucursal');
    });
  }
  if (!(await tiene('oc_folio'))) {
    await knex.schema.withSchema('commercial').alterTable('purchase_requisitions', (t) => {
      t.text('oc_folio');
    });
  }
  if (!(await tiene('oc_capturada_at'))) {
    await knex.schema.withSchema('commercial').alterTable('purchase_requisitions', (t) => {
      t.timestamp('oc_capturada_at', { useTz: true });
    });
  }
  if (!(await tiene('oc_capturada_por'))) {
    await knex.schema.withSchema('commercial').alterTable('purchase_requisitions', (t) => {
      t.uuid('oc_capturada_por');
    });
  }

  // ⛔ Las DOS o NINGUNA. Media coordenada no identifica un documento en Kepler: el folio se
  // repite entre sucursales (lo midio la Fase CC con `doc_prefix`), asi que un folio suelto
  // apunta a varios documentos distintos y se lee como si apuntara a uno.
  await knex.raw(`ALTER TABLE commercial.purchase_requisitions
                    DROP CONSTRAINT IF EXISTS purchase_req_oc_completa_chk`);
  await knex.raw(`
    ALTER TABLE commercial.purchase_requisitions
      ADD CONSTRAINT purchase_req_oc_completa_chk
      CHECK ((oc_sucursal IS NULL AND oc_folio IS NULL)
          OR (btrim(COALESCE(oc_sucursal,'')) <> '' AND btrim(COALESCE(oc_folio,'')) <> ''))`);

  // Una OC de Kepler sale de UNA requisicion. Parcial: lo no capturado no compite.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS purchase_req_oc_unica
      ON commercial.purchase_requisitions (tenant_id, oc_sucursal, oc_folio)
      WHERE oc_folio IS NOT NULL`);

  await knex.raw(`
    COMMENT ON COLUMN commercial.purchase_requisitions.oc_folio IS
      'RQ.15 - folio de la orden de compra de Kepler que salio de esta requisicion. Junto con '
      'oc_sucursal es la coordenada con la que Kepler identifica el documento, la misma que usan '
      'analytics.erp_purchase_orders y erp_goods_receipts.oc_folio. NULL = no se capturo; NO se '
      'infiere por fecha e importe, porque esta columna es la que despues dice que se compro.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP INDEX IF EXISTS commercial.purchase_req_oc_unica`);
  await knex.raw(`ALTER TABLE commercial.purchase_requisitions
                    DROP CONSTRAINT IF EXISTS purchase_req_oc_completa_chk`);
  for (const col of ['oc_capturada_por', 'oc_capturada_at', 'oc_folio', 'oc_sucursal']) {
    if (await knex.schema.withSchema('commercial').hasColumn('purchase_requisitions', col)) {
      await knex.schema.withSchema('commercial').alterTable('purchase_requisitions', (t) => t.dropColumn(col));
    }
  }
};
