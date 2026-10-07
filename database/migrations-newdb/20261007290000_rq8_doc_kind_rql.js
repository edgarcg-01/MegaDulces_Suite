'use strict';
/**
 * `[RQ.8.1]` — **El botón «Armar» de `/compras/pedido` nunca funcionó en prod.** Un CHECK.
 *
 * ── El reporte ───────────────────────────────────────────────────────────────────────────────
 * Edgar, 2026-10-07, generando 2 requisiciones de un proveedor por $548:
 *   *"No se creó NINGUNA requisición — Internal server error, el lote entero se revirtió"*.
 *
 * ── La causa, de los logs de prod ────────────────────────────────────────────────────────────
 *     POST /api/commercial/replenishment/requisitions/batch → 500:
 *     INSERT INTO commercial.purchase_doc_sequences (tenant_id, year, doc_kind, last_seq)
 *     VALUES ($1, $2, 'RQL', 1)
 *
 * Y la restricción que lo rechaza, leída en prod:
 *     CHECK (doc_kind = ANY (ARRAY['OC', 'OE']))
 *
 * `[RQ.8]` (mig `20261006190000_requisicion_lote.js`, batch 740 en prod) decidió **reusar** el
 * secuenciador que ya emitía `OC` y `OE` en vez de crear una tabla nueva — decisión correcta, y su
 * propio comentario lo dice: *"del secuenciador que ya emite OC y OE (doc_kind=RQL)"*. Pero esa
 * migración sólo agregó **columnas** a `purchase_requisitions` (`batch_id`, `batch_folio`,
 * `origin_requisition_id`) y **nunca amplió el CHECK**. O sea: el código escribe un valor que la
 * tabla tiene prohibido, y el lote entero revienta en la primera sentencia.
 *
 * ⭐ **Lo único que funcionó acá fue la atomicidad.** El mensaje dice la verdad —"el lote entero se
 * revirtió, no quedó nada a medias"— y por eso no hay basura que limpiar: ni folios quemados, ni
 * requisiciones huérfanas. El `[RQ.8]` que falló es el mismo que evitó que fallara peor.
 *
 * ⚠️ **Por qué no lo atrapó nada antes:** reusar una tabla es más barato que crear una, pero
 * hereda sus restricciones — y un `CHECK` con una lista blanca de valores es una restricción que
 * **no se ve desde el código que inserta**. Un `INSERT` con un literal nuevo (`'RQL'`) contra una
 * columna con lista cerrada es exactamente el caso que ningún tipo de TypeScript puede cuidar.
 *
 * ── El arreglo ───────────────────────────────────────────────────────────────────────────────
 * Ampliar la lista. No se toca el código: `RQL` es lo que `[RQ.8]` documentó y lo que la bandeja
 * de Requisiciones ya espera leer (`RQ-LOTE-AAAA-NNNNN`).
 *
 * Idempotente y sin candado largo: `DROP CONSTRAINT` + `ADD CONSTRAINT` sobre una tabla de **2
 * filas** (una por `doc_kind` por año). `NOT VALID` sería inútil acá: validar 2 filas es gratis.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'commercial.purchase_doc_sequences';
const NOMBRE = 'purchase_doc_sequences_doc_kind_check';
/** OC = orden de compra · OE = orden de entrada · RQL = folio de LOTE de requisición ([RQ.8]). */
const VALORES = ['OC', 'OE', 'RQL'];

exports.up = async function (knex) {
  await knex.raw(`ALTER TABLE ${TABLA} DROP CONSTRAINT IF EXISTS ${NOMBRE}`);
  // ⚠️ Los valores van INLINE, no como bind. **Postgres NO acepta parámetros en DDL**: con `?`
  // falla con *"bind message supplies 3 parameters, but prepared statement requires 0"*. Son
  // constantes de este archivo, no entrada de nadie, así que interpolarlas es seguro.
  // (Se descubrió aplicándola: la transacción de knex revirtió el `DROP` y prod nunca quedó
  // sin restricción — por eso el primer intento fallido no dejó daño.)
  await knex.raw(
    `ALTER TABLE ${TABLA} ADD CONSTRAINT ${NOMBRE} CHECK (doc_kind IN (${VALORES.map((v) => `'${v}'`).join(', ')}))`,
  );
  await knex.raw(`COMMENT ON COLUMN ${TABLA}.doc_kind IS
    'OC = orden de compra - OE = orden de entrada - RQL = folio de LOTE de requisicion (RQ.8). [RQ.8.1] Si se agrega un tipo nuevo hay que ampliar ESTE CHECK en la misma migracion: el codigo que inserta no ve la lista blanca, y el sintoma es un 500 que revierte el lote entero.'`);
};

exports.down = async function (knex) {
  // Vuelve a la lista original. ⚠️ Falla si ya hay filas con 'RQL' — y es correcto que falle:
  // revertir esto deja al botón «Armar» roto otra vez.
  await knex.raw(`ALTER TABLE ${TABLA} DROP CONSTRAINT IF EXISTS ${NOMBRE}`);
  await knex.raw(`ALTER TABLE ${TABLA} ADD CONSTRAINT ${NOMBRE} CHECK (doc_kind IN ('OC', 'OE'))`);
};
