'use strict';
/**
 * `[EMB.39]` — La carga del camión se paga POR CAJA, no por persona: **$0.20 por caja embarcada**,
 * repartido en partes iguales entre quienes cargaron (decisión de Edgar, 2026-10-24). La tarifa
 * vive en `logistics.config_finance` como cualquier otra (`tarifa_carga_caja`), se cambia desde
 * Logística › Configuración con el candado de EMB.28.1, y cada cambio queda en
 * `logistics.tariff_changes`: de esa bitácora se deriva qué tarifa estaba VIGENTE el día de cada
 * embarque, así que cambiarla no mueve lo que ya se pagó.
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-10-24) ───────────────────────────────────────
 *  · La única tarifa de carga que lee el código es `tarifa_maniobra_carga` = $30 «por persona»;
 *    `tarifa_maniobra_caja` ($5) y `tarifa_maniobra_descarga` ($1) existen y NINGÚN código las lee.
 *  · `logistics.load_details`: 5 filas, todas a $30, 4 de ellas a «Chofer Demo» (piloto). Ninguna
 *    llegó a un vale (`finance.trip_pay_lines` = 0 filas).
 *  · Universo de cajas: ~15–18 mil por semana en traspasos y ~4 mil a clientes
 *    (`analytics.erp_shipment_stop_load`, Σ `kdm2.c54` con `c55` en CJA/BTO).
 *
 * Qué hace:
 *  1. `load_details.boxes` y `load_details.rate_per_box` (nullable): con cuántas cajas y a qué
 *     tarifa se calculó lo que cobra cada cargador. `rate` sigue siendo lo que cobra la persona
 *     (lo lee `logistics.v_trip_pay_items` sin cambios). Las filas viejas, por persona, quedan NULL.
 *  2. Alta de `tarifa_carga_caja` = 0.20 en cada tenant que ya tenía tarifa de carga, con su
 *     renglón en la bitácora.
 *  3. Desactiva `tarifa_maniobra_carga` ($30 por persona), también con su renglón: queda como
 *     historia, no se borra.
 *
 * Idempotente. No crea objetos que un despliegue clasifique NO_MEDIDO: agrega columnas.
 *
 * @param { import("knex").Knex } knex
 */

const TAG = '[emb_carga_por_caja]';
const QUIEN = 'migración EMB.39 (Edgar, 2026-10-24)';
const KEY = 'tarifa_carga_caja';
const VIEJA = 'tarifa_maniobra_carga';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  if (!(await knex.schema.withSchema('logistics').hasColumn('load_details', 'boxes'))) {
    await knex.raw(`ALTER TABLE logistics.load_details ADD COLUMN boxes numeric(12,2)`);
  }
  if (!(await knex.schema.withSchema('logistics').hasColumn('load_details', 'rate_per_box'))) {
    await knex.raw(`ALTER TABLE logistics.load_details ADD COLUMN rate_per_box numeric(12,4)`);
  }
  await knex.raw(`COMMENT ON COLUMN logistics.load_details.boxes IS
    'EMB.39 — Cajas del embarque con que se calculó esta carga (Kepler: Σ kdm2.c54 con c55 en CJA/BTO; embarque manual: boxes_count). NULL = fila vieja, pagada por persona.'`);
  await knex.raw(`COMMENT ON COLUMN logistics.load_details.rate_per_box IS
    'EMB.39 — Tarifa por caja vigente el día del embarque (config tarifa_carga_caja). rate = cajas × rate_per_box ÷ cargadores, repartido a centavos.'`);

  const nuevas = (await knex.raw(
    `INSERT INTO logistics.config_finance (tenant_id, key, category, description, value, unit, active)
     SELECT v.tenant_id, ?, 'tarifa_maniobra',
            'Carga de camión: pesos por caja embarcada; se reparte en partes iguales entre quienes cargaron',
            0.20, 'mxn/caja', true
       FROM logistics.config_finance v
      WHERE v.key = ?
        AND NOT EXISTS (SELECT 1 FROM logistics.config_finance x WHERE x.tenant_id = v.tenant_id AND x.key = ?)
     RETURNING id, tenant_id`,
    [KEY, VIEJA, KEY],
  )).rows;
  for (const r of nuevas) {
    await knex.raw(
      `INSERT INTO logistics.tariff_changes (tenant_id, entity, entity_id, entity_label, field, old_value, new_value, autorizado, changed_by_username)
       VALUES (?, 'config', ?, ?, 'value', NULL, '0.2', true, ?)`,
      [r.tenant_id, r.id, KEY, QUIEN],
    );
  }

  const apagadas = (await knex.raw(
    `UPDATE logistics.config_finance SET active = false, updated_at = now()
      WHERE key = ? AND active RETURNING id, tenant_id`,
    [VIEJA],
  )).rows;
  for (const r of apagadas) {
    await knex.raw(
      `INSERT INTO logistics.tariff_changes (tenant_id, entity, entity_id, entity_label, field, old_value, new_value, autorizado, changed_by_username)
       VALUES (?, 'config', ?, ?, 'active', 'true', 'false', true, ?)`,
      [r.tenant_id, r.id, VIEJA, QUIEN],
    );
  }
  console.log(`${TAG} ${KEY} dada de alta en ${nuevas.length} tenant(s); ${VIEJA} desactivada en ${apagadas.length}.`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  // La vieja se reactiva sólo donde la apagó esta migración.
  await knex.raw(
    `UPDATE logistics.config_finance c SET active = true, updated_at = now()
      WHERE c.key = ? AND EXISTS (
        SELECT 1 FROM logistics.tariff_changes t
         WHERE t.entity = 'config' AND t.entity_id = c.id AND t.field = 'active' AND t.changed_by_username = ?)`,
    [VIEJA, QUIEN],
  );
  // La nueva se borra sólo si la creó esta migración y nadie la ha cambiado después.
  await knex.raw(
    `DELETE FROM logistics.config_finance c
      WHERE c.key = ?
        AND EXISTS (SELECT 1 FROM logistics.tariff_changes t
                     WHERE t.entity = 'config' AND t.entity_id = c.id AND t.changed_by_username = ?)
        AND NOT EXISTS (SELECT 1 FROM logistics.tariff_changes t
                         WHERE t.entity = 'config' AND t.entity_id = c.id AND t.changed_by_username IS DISTINCT FROM ?)`,
    [KEY, QUIEN, QUIEN],
  );
  await knex.raw(`DELETE FROM logistics.tariff_changes WHERE changed_by_username = ?`, [QUIEN]);
  if (await knex.schema.withSchema('logistics').hasColumn('load_details', 'rate_per_box')) {
    await knex.raw(`ALTER TABLE logistics.load_details DROP COLUMN rate_per_box`);
  }
  if (await knex.schema.withSchema('logistics').hasColumn('load_details', 'boxes')) {
    await knex.raw(`ALTER TABLE logistics.load_details DROP COLUMN boxes`);
  }
};
