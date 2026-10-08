'use strict';
/**
 * `[IC.15]` — LOS TRES RITMOS NO CABEN: HAY UN FOLIO VIVO POR ALMACÉN.
 *
 * Medido en prod el 2026-10-07, el índice que lo impide:
 *
 * ```text
 * commercial_inv_counts_one_open_per_wh
 *   UNIQUE (tenant_id, warehouse_id)
 *   WHERE status IN (open, counting, review, ready_to_reconcile)
 * ```
 *
 * **Un folio vivo por almacén, punto.** Mientras el diario esté abierto, el mensual no puede
 * existir, y al revés. Los tres ritmos de esta fase son incompatibles con ese índice, así que
 * nada aguas abajo (`[IC.18]`, `[IC.19]`, `[IC.22]`) puede construirse hasta cambiarlo.
 *
 * ── Por qué una columna nueva y no reusar `type` ────────────────────────────────────────────
 *
 * `type` admite `full` y `cycle`, y responde **«¿se cuenta todo o un subconjunto?»**.
 * `ritmo` responde **«¿cada cuándo y para qué?»**. Son ejes distintos y se cruzan:
 *
 * | | `type` | `ritmo` |
 * |---|---|---|
 * | conteo diario de alta rotación | `cycle` | `diario` |
 * | barrido mensual del complemento | `cycle` | `mensual` |
 * | físico completo de Kepler       | `full`  | `trimestral` |
 *
 * ⛔ Meterlos en una columna es el `CASE` que le miente a una de las dos preguntas — el mismo
 * error que esta fase ya pagó en `v_count_priority_score`, donde `s_venta` y `s_parado` se suman
 * y el resultado no es ninguno de los dos.
 *
 * ── Los 6 folios que ya existen NO se re-etiquetan ──────────────────────────────────────────
 *
 * Medido: **6 folios, los 6 `type='full'`, los 6 `cancelled`, los 6 de junio-2026**. Es tentador
 * marcarlos `trimestral` porque son `full`, pero **nunca corrieron como el trimestral**: fueron
 * intentos que se cancelaron. Van a `adhoc`, que es lo que de verdad son. *Inventarle un ritmo
 * retroactivo a un folio es dibujar historia que no ocurrió* (ADR-056).
 *
 * ── El riesgo de aflojar el índice, y su freno ──────────────────────────────────────────────
 *
 * ⚠️ Permitir N folios vivos por almacén abre una puerta que antes estaba cerrada **por accidente**:
 * que **el mismo SKU esté en dos folios vivos a la vez**. Dos personas lo cuentan por separado, los
 * dos folios se resuelven, y el segundo ajuste pisa al primero — un descuadre fabricado por el
 * sistema. El índice viejo lo impedía como efecto colateral de ser demasiado estricto.
 *
 * El freno va en el SERVICIO (`openCount`), porque un índice parcial no puede mirar la tabla de
 * ítems ni el estado del folio padre. Esta migración deja el índice por `(almacén, ritmo)`; el
 * guard de «un SKU en un solo folio vivo» viaja con ella en el mismo commit y tiene su prueba
 * negativa en `inventory-count.ritmo.spec.ts`.
 *
 * ── Lo medido antes de tocar el índice ──────────────────────────────────────────────────────
 *  · folios vivos en prod ahora mismo: **0** → cambiar el índice no puede chocar con nada
 *  · la tabla tiene 6 filas → el `DROP`/`CREATE` del índice es instantáneo, sin `CONCURRENTLY`
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const VIVOS = `'open','counting','review','ready_to_reconcile'`;
const IDX_VIEJO = 'commercial_inv_counts_one_open_per_wh';
const IDX_NUEVO = 'commercial_inv_counts_one_open_per_wh_ritmo';
const RITMOS = `'diario','mensual','trimestral','adhoc'`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── 1. La columna ──────────────────────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasColumn('inventory_counts', 'ritmo'))) {
    await knex.schema.withSchema('commercial').alterTable('inventory_counts', (t) => {
      t.string('ritmo', 12).notNullable().defaultTo('adhoc');
    });
    await knex.raw(
      `ALTER TABLE commercial.inventory_counts
         ADD CONSTRAINT commercial_inv_counts_ritmo_check
         CHECK (ritmo IN (${RITMOS}))`);
    await knex.raw(
      `COMMENT ON COLUMN commercial.inventory_counts.ritmo IS
       'Cada cuando y para que se cuenta. Eje ORTOGONAL a type (que dice todo-vs-subconjunto): '
       'un diario es cycle+diario, el fisico de Kepler es full+trimestral. [IC.15]'`);
  }

  // ── 2. ⛔ Pre-vuelo del indice: nadie puede tener ya dos folios vivos ───────────────────
  // Si los hubiera, el indice nuevo fallaria a mitad y dejaria la tabla SIN ninguno de los dos.
  const [{ chocan }] = (await knex.raw(
    `SELECT count(*)::int AS chocan FROM (
       SELECT tenant_id, warehouse_id, ritmo
         FROM commercial.inventory_counts
        WHERE status IN (${VIVOS})
        GROUP BY 1, 2, 3 HAVING count(*) > 1) z`)).rows;
  if (chocan > 0) {
    throw new Error(
      `${chocan} grupos (almacen, ritmo) ya tienen mas de un folio vivo: `
      + 'el indice nuevo no se puede crear. Resolvelos antes.');
  }

  // ── 3. El indice: la llave pasa de (almacen) a (almacen, ritmo) ────────────────────────
  await knex.raw(`DROP INDEX IF EXISTS commercial.${IDX_VIEJO}`);
  await knex.raw(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${IDX_NUEVO}
       ON commercial.inventory_counts (tenant_id, warehouse_id, ritmo)
       WHERE status IN (${VIVOS})`);

  // ── 4. Verificar que quedó como se quería, no suponerlo ────────────────────────────────
  const idx = (await knex.raw(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname = 'commercial' AND tablename = 'inventory_counts'`)).rows.map((r) => r.indexname);
  if (idx.includes(IDX_VIEJO)) throw new Error(`${IDX_VIEJO} sigue vivo: el DROP no tomo`);
  if (!idx.includes(IDX_NUEVO)) throw new Error(`${IDX_NUEVO} no se creo`);

  const d = (await knex.raw(
    `SELECT count(*)::int AS folios,
            count(*) FILTER (WHERE ritmo = 'adhoc')::int AS adhoc,
            count(*) FILTER (WHERE status IN (${VIVOS}))::int AS vivos
       FROM commercial.inventory_counts`)).rows[0];

  console.log(`  [ic15-ritmo] ${d.folios} folios · ${d.adhoc} en adhoc · ${d.vivos} vivos`
    + ` · llave ahora (almacen, ritmo)`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`. */
exports.down = async function down(knex) {
  // ⚠️ Volver al indice viejo puede ser IMPOSIBLE si ya hay dos ritmos vivos en un almacen:
  //    se dice en vez de fallar con un error de indice que no explica nada.
  const [{ chocan }] = (await knex.raw(
    `SELECT count(*)::int AS chocan FROM (
       SELECT tenant_id, warehouse_id FROM commercial.inventory_counts
        WHERE status IN (${VIVOS}) GROUP BY 1, 2 HAVING count(*) > 1) z`)).rows;
  if (chocan > 0) {
    throw new Error(
      `${chocan} almacenes tienen mas de un folio vivo (que es justo lo que [IC.15] habilito): `
      + 'cerralos o cancelalos antes de revertir.');
  }
  await knex.raw(`DROP INDEX IF EXISTS commercial.${IDX_NUEVO}`);
  await knex.raw(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${IDX_VIEJO}
       ON commercial.inventory_counts (tenant_id, warehouse_id)
       WHERE status IN (${VIVOS})`);
  await knex.raw(
    `ALTER TABLE commercial.inventory_counts
       DROP CONSTRAINT IF EXISTS commercial_inv_counts_ritmo_check`);
  if (await knex.schema.withSchema('commercial').hasColumn('inventory_counts', 'ritmo')) {
    await knex.schema.withSchema('commercial').alterTable('inventory_counts', (t) => t.dropColumn('ritmo'));
  }
};
