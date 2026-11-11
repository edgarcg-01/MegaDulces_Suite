'use strict';
/**
 * `[CANON.6.6]` — El `warehouse_id` se resuelve AL ESCRIBIR, no con un barrido nocturno.
 *
 * Hasta hoy dos pasos del nocturno (`backfill-warehouse-id-batch1.js` y `-batch2.js`, oleada 12 del
 * anexo CANON §8) llenaban cada noche el `warehouse_id` que algunos escritores dejan en NULL, a partir de
 * `warehouse_code` (lote 1) o `sucursal` (lote 2). Edgar: «ningún importer y ningún cron». Un trigger
 * `BEFORE INSERT OR UPDATE` por tabla resuelve con la MISMA regla en el momento en que se escribe, sin
 * importar quién escribe (la app, la carga de RH, los triggers de pólizas de `[OPS-AUD.14]`).
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-11) ────────────────────────────────────────
 *  · De las 33 tablas de los dos barridos: 10 ya son VISTAS (derivan el almacén en vivo), 5 están
 *    congeladas sin escritor y 18 son tablas vivas. Pendientes HOY (NULL pero resolubles):
 *    `identity.users` 1,015 (altas de noviembre: la carga de RH) · `reconciliation.blind_counts` 57
 *    (de esta mañana) · `finance.goods_receipt_proofs` 13 · `analytics.gl_poliza_lines` 393 ·
 *    `analytics.gl_polizas` 3 · el resto 0 (sus escritores ya ponen el almacén).
 *  · Ningún valor resuelve a dos almacenes con ninguna de las dos reglas: el trigger elige lo mismo
 *    que el barrido (que con `UPDATE … FROM` elegía uno al azar si hubiera habido empate).
 *
 * ── Qué crea ─────────────────────────────────────────────────────────────────────────────────
 *  · `commercial.warehouse_id_de(tenant, valor, regla)`: LA regla, en un solo lugar. `SECURITY DEFINER`
 *    con `search_path` fijo: corre dentro de escritores sin contexto de tenant (triggers de pólizas).
 *  · Dos funciones de trigger (por `warehouse_code` y por `sucursal`). **Nunca frenan al escritor**: si
 *    resolver falla, el renglón se escribe con el almacén en NULL, igual que antes de esto.
 *  · `trg_warehouse_id_al_escribir` en las 18 tablas vivas. El nombre ordena DESPUÉS de
 *    `trg_auto_populate_tenant_id` (los BEFORE corren en orden alfabético): el tenant ya está puesto.
 *  · Llenado de lo pendiente hoy: es exactamente lo que el barrido hacía cada noche.
 *
 * El `down` quita triggers y funciones; el llenado no se deshace (el barrido lo habría hecho igual).
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
const TENANT = '00000000-0000-0000-0000-00000000d01c';

// [esquema, tabla, columna con el código]. Las 5 congeladas (cash_sessions, pos_cashiers,
// pos_ticket_sales, stock_ledger, erp_purchase_adjustments) no tienen escritor: no llevan trigger.
const TABLAS = [
  ['analytics', 'cash_cuts', 'warehouse_code'],
  ['analytics', 'store_live_tickets', 'warehouse_code'],
  ['identity', 'users', 'warehouse_code'],
  ['logistics', 'home_delivery_warehouses', 'warehouse_code'],
  ['reconciliation', 'actions', 'warehouse_code'],
  ['reconciliation', 'blind_counts', 'warehouse_code'],
  ['analytics', 'ap_provider', 'sucursal'],
  ['analytics', 'expense_doc_chain', 'sucursal'],
  ['analytics', 'expense_document_lines', 'sucursal'],
  ['analytics', 'expense_entries', 'sucursal'],
  ['analytics', 'expense_findings', 'sucursal'],
  ['analytics', 'gl_poliza_lines', 'sucursal'],
  ['analytics', 'gl_polizas', 'sucursal'],
  ['analytics', 'ledger_monthly', 'sucursal'],
  ['analytics', 'sales_by_channel_monthly', 'sucursal'],
  ['finance', 'expense_comprobaciones', 'sucursal'],
  ['finance', 'goods_receipt_proofs', 'sucursal'],
  ['finance', 'supplier_payment_proofs', 'sucursal'],
];
const REGLA = { warehouse_code: 'codigo', sucursal: 'sucursal' };
const TRIGGER = 'trg_warehouse_id_al_escribir';

exports.TABLAS = TABLAS;

async function aplicable(knex, esquema, tabla, col) {
  const r = await knex.raw(
    `SELECT c.relkind::text AS k,
            (SELECT count(*)::int FROM information_schema.columns
              WHERE table_schema = ? AND table_name = ? AND column_name IN ('warehouse_id', 'tenant_id', ?)) AS cols
       FROM pg_class c WHERE c.oid = to_regclass(?)`,
    [esquema, tabla, col, `${esquema}.${tabla}`],
  );
  const x = r.rows[0];
  return !!x && (x.k === 'r' || x.k === 'p') && x.cols === 3;
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);

  // La regla: la misma de los dos barridos. 'codigo' = lote 1 (code, kepler_code, y Canindo '06' →
  // MD-50 explícito); 'sucursal' = lote 2 (code, kepler_code, wincaja_source_branch).
  await knex.raw(`
    CREATE OR REPLACE FUNCTION commercial.warehouse_id_de(p_tenant uuid, p_valor text, p_regla text)
    RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
      SELECT w.id FROM commercial.warehouses w
       WHERE w.tenant_id = p_tenant AND w.deleted_at IS NULL
         AND (w.code = btrim(p_valor) OR w.kepler_code = btrim(p_valor)
              OR (p_regla = 'codigo' AND w.code = 'MD-50' AND btrim(p_valor) = '06')
              OR (p_regla = 'sucursal' AND w.wincaja_source_branch = btrim(p_valor)))
       ORDER BY w.id LIMIT 1
    $fn$`);
  await knex.raw(`REVOKE ALL ON FUNCTION commercial.warehouse_id_de(uuid, text, text) FROM PUBLIC`);
  await knex.raw(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT EXECUTE ON FUNCTION commercial.warehouse_id_de(uuid, text, text) TO app_runtime; END IF; END $$`);

  for (const [col, regla] of Object.entries(REGLA)) {
    await knex.raw(`
      CREATE OR REPLACE FUNCTION commercial.tg_warehouse_id_por_${regla}()
      RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
      BEGIN
        IF NEW.warehouse_id IS NULL AND NEW.${col} IS NOT NULL AND NEW.tenant_id IS NOT NULL THEN
          BEGIN
            NEW.warehouse_id := commercial.warehouse_id_de(NEW.tenant_id, NEW.${col}, '${regla}');
          EXCEPTION WHEN OTHERS THEN
            NULL; -- nunca frena al escritor: queda en NULL, como antes de este trigger
          END;
        END IF;
        RETURN NEW;
      END $fn$`);
  }

  let n = 0;
  for (const [esquema, tabla, col] of TABLAS) {
    if (!(await aplicable(knex, esquema, tabla, col))) { console.log(`[CANON.6.6] ${esquema}.${tabla}: no es tabla o le falta columna — sin trigger`); continue; }
    await knex.raw(`DROP TRIGGER IF EXISTS ${TRIGGER} ON ${esquema}.${tabla}`);
    await knex.raw(`CREATE TRIGGER ${TRIGGER} BEFORE INSERT OR UPDATE ON ${esquema}.${tabla}
      FOR EACH ROW EXECUTE FUNCTION commercial.tg_warehouse_id_por_${REGLA[col]}()`);
    const r = await knex.raw(
      `UPDATE ${esquema}.${tabla} t SET warehouse_id = commercial.warehouse_id_de(t.tenant_id, t.${col}, ?)
        WHERE t.warehouse_id IS NULL AND t.${col} IS NOT NULL AND t.tenant_id IS NOT NULL
          AND commercial.warehouse_id_de(t.tenant_id, t.${col}, ?) IS NOT NULL`,
      [REGLA[col], REGLA[col]],
    );
    n++;
    if (r.rowCount) console.log(`[CANON.6.6] ${esquema}.${tabla}: ${r.rowCount} pendientes llenadas`);
  }
  console.log(`[CANON.6.6] trigger en ${n} de ${TABLAS.length} tablas (medido antes: 18 vivas; pendientes 1,015 users · 57 blind_counts · 13 proofs · 393+3 pólizas)`);
};

/** Deshace los triggers y las funciones. El llenado no se deshace: es el mismo que hacía el barrido. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  for (const [esquema, tabla] of TABLAS) {
    const hay = await knex.raw(`SELECT to_regclass(?) AS t`, [`${esquema}.${tabla}`]);
    if (hay.rows[0].t) await knex.raw(`DROP TRIGGER IF EXISTS ${TRIGGER} ON ${esquema}.${tabla}`);
  }
  for (const regla of Object.values(REGLA)) await knex.raw(`DROP FUNCTION IF EXISTS commercial.tg_warehouse_id_por_${regla}()`);
  await knex.raw('DROP FUNCTION IF EXISTS commercial.warehouse_id_de(uuid, text, text)');
};
