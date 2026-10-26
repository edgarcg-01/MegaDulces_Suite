'use strict';
/**
 * `[EMB.49]` — La tarifa de carga por caja ($0.20) **rige desde el 22 de octubre de 2026**, el
 * inicio de la catorcena en que se decidió, y no desde el 24 en que se registró.
 *
 * Decisión de Edgar (2026-10-26, «aplícala»): la catorcena 22-oct → 4-nov se paga completa el
 * 6-nov con la regla nueva. La regla vieja ($30 por persona) casi no se usó: 5 capturas en toda la
 * historia, la última el 14-oct.
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-10-26) ────────────────────────────────────────
 *  · `tarifa_carga_caja` nació el 2026-10-24 a las 12:36 (México) por la migración EMB.39. Como un
 *    cambio aplica desde el día en que se registra (`tarifaVigenteEl`), las operaciones del 22 y
 *    23 de octubre —62 de las 78 de la catorcena— salían «sin tarifa»: la carga sumaba $449.80
 *    en vez de $1,729.20 (8,646 cajas).
 *
 * ── Cómo, sin reescribir la bitácora ────────────────────────────────────────────────────────
 * `logistics.tariff_changes` es la auditoría: no se le cambia la fecha a nada. Se le agrega
 * `effective_from` —desde qué día (México) aplica un cambio cuando NO es el día en que se
 * registró— y se pone en los dos movimientos de EMB.39 (el alta de $0.20 por caja y la baja de
 * $30 por persona): la historia dice cuándo se registró Y desde cuándo rige. La decisión misma
 * queda como un movimiento más (`field = 'rige_desde'`), con quién la tomó.
 *
 * El código lee la bitácora con `select *`: funciona igual antes y después de aplicar esto.
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TAG = '[emb_tarifa_caja_rige_desde]';
const DESDE = '2026-10-22';
const EMB39 = 'migración EMB.39 (Edgar, 2026-10-24)';
const QUIEN = 'migración EMB.49 (decisión de Edgar, 2026-10-26: rige desde el 22-oct)';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  if (!(await knex.schema.withSchema('logistics').hasColumn('tariff_changes', 'effective_from'))) {
    await knex.raw(`ALTER TABLE logistics.tariff_changes ADD COLUMN effective_from date`);
  }
  await knex.raw(`COMMENT ON COLUMN logistics.tariff_changes.effective_from IS
    'EMB.49 — Desde qué día (hora de México) aplica el cambio cuando NO es el día en que se registró (changed_at). NULL = desde el día de changed_at. Lo lee tarifaVigenteEl.'`);

  const fechados = (await knex.raw(
    `UPDATE logistics.tariff_changes SET effective_from = ?::date
      WHERE changed_by_username = ? AND entity = 'config' AND effective_from IS NULL
      RETURNING tenant_id, entity_id, entity_label`,
    [DESDE, EMB39],
  )).rows;

  // La decisión, como un movimiento más de cada tarifa tocada (una sola vez).
  let anotadas = 0;
  for (const r of fechados) {
    const ya = (await knex.raw(
      `SELECT 1 FROM logistics.tariff_changes
        WHERE tenant_id = ? AND entity = 'config' AND entity_id = ? AND field = 'rige_desde' AND changed_by_username = ?`,
      [r.tenant_id, r.entity_id, QUIEN],
    )).rows.length;
    if (ya) continue;
    await knex.raw(
      `INSERT INTO logistics.tariff_changes (tenant_id, entity, entity_id, entity_label, field, old_value, new_value, autorizado, changed_by_username)
       VALUES (?, 'config', ?, ?, 'rige_desde', '2026-10-24', ?, true, ?)`,
      [r.tenant_id, r.entity_id, r.entity_label, DESDE, QUIEN],
    );
    anotadas++;
  }
  console.log(`${TAG} ${fechados.length} movimiento(s) de EMB.39 rigen desde ${DESDE}; ${anotadas} decisión(es) anotada(s).`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DELETE FROM logistics.tariff_changes WHERE changed_by_username = ? AND field = 'rige_desde'`, [QUIEN]);
  if (await knex.schema.withSchema('logistics').hasColumn('tariff_changes', 'effective_from')) {
    await knex.raw(`ALTER TABLE logistics.tariff_changes DROP COLUMN effective_from`);
  }
};
