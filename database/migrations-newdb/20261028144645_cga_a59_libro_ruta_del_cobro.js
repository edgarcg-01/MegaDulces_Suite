'use strict';
/**
 * `[CGA-A.59]` — El libro de Caja General guarda DE QUÉ RUTA es cada cobro de camión, para poder
 * buscarlo por ruta (Edgar, 2026-10-28: *«que el buscador pueda buscar por ruta»*).
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-28) ────────────────────────────────────────
 *  · El cobro de camión llega con `origen_ref = '06-001|U-A-5|…'`: el ALMACÉN del camión, no la
 *    ruta. La ruta sólo la sabe `analytics.route_collections` (FDW al runner): `SELECT DISTINCT
 *    almacen, truck` tarda **2,016 ms**. No se puede pagar en cada carga del libro (tope: 500 ms).
 *  · Los catálogos locales NO sirven sin mover números ajenos: `analytics.erp_warehouse_map` no
 *    trae las rutas de Canindo (06-00x) y alimenta 3 matvistas de margen/costo;
 *    `commercial.warehouses.kepler_code` está vacío para RUTA-501…505 y lo leen ~20 vistas de
 *    existencia y costo. Llenarlos cambiaría inventario y margen: fuera de alcance (regla 15).
 *  · 116 cobros de camión en el libro; los 116 tienen su almacén en `route_collections`.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 *  · `finance.cash_ledger.ruta` (texto, el número: '501'). Lo llena la CAPTURA, del renglón de la
 *    bandeja que ya trae la ruta (evento, no cron). Columna nullable: ningún camino de inserción
 *    se rompe (hay uno solo, `CashLedgerService.create`).
 *  · Una sola vez, los 116 de antes desde `route_collections`. Si el FDW no contesta, la columna
 *    queda y el relleno se DECLARA no hecho (no se finge).
 *  · `ruta` no está en la lista de `cash_ledger_congelado`: es evidencia, no mueve un número del
 *    corte, así que se puede llenar en movimientos de cortes ya firmados.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
const TAG = '[cga_a59_libro_ruta_del_cobro]';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`ALTER TABLE finance.cash_ledger ADD COLUMN IF NOT EXISTS ruta text`);
  await knex.raw(`COMMENT ON COLUMN finance.cash_ledger.ruta IS
    '[CGA-A.59] Número de la ruta del cobro de camión (''501''). Lo pone la captura desde la bandeja; NULL = no es cobro de ruta o no se supo.'`);
  try {
    await knex.raw(`SAVEPOINT a59_relleno`);
    const r = await knex.raw(`
      UPDATE finance.cash_ledger l
         SET ruta = substring(m.truck from '([0-9]+)$')
        FROM (SELECT DISTINCT almacen, truck FROM analytics.route_collections) m
       WHERE l.origen_tipo = 'cobro'
         AND split_part(l.origen_ref, '|', 1) = m.almacen
         AND l.ruta IS NULL
         AND substring(m.truck from '([0-9]+)$') IS NOT NULL`);
    await knex.raw(`RELEASE SAVEPOINT a59_relleno`);
    console.log(`${TAG} ruta rellenada en ${r.rowCount ?? 0} cobro(s) de camión.`);
  } catch (e) {
    await knex.raw(`ROLLBACK TO SAVEPOINT a59_relleno`);
    console.log(`${TAG} ⚠️ NO MEDIDO: no se pudo leer analytics.route_collections (${e.message}). La columna quedó; el relleno de los cobros viejos NO se hizo.`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`. */
exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE finance.cash_ledger DROP COLUMN IF EXISTS ruta`);
};
