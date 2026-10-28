'use strict';
/**
 * `[PQ.22]` — **La orden de compra de Kepler, generada por la Suite: un interruptor por sucursal.**
 *
 * Pedido de Edgar (2026-10-28): *«nosotros generar automáticamente la orden de compra en
 * kepler»*. Con `genera_orden = true`, al escribir la requisición `X-A-30` de esa sucursal el
 * adapter escribe TAMBIÉN la OC `X-A-35`, ligada como la liga Kepler al convertir.
 *
 * ── Lo medido antes (sólo lectura, `kepler_ods`, 2026-10-28) ──────────────────────────────
 *  · 1,142 pares OC ← requisición en los nueve servidores: la OC copia el encabezado salvo
 *    `c4 c6 c31 c63` y la liga `c36..c39`; 1,893 renglones copian el renglón salvo la liga
 *    `c19..c23` y `c31 = c9`. La requisición convertida queda `c43 F`, `c42 0` (1,099 de 1,142).
 *
 * Nace APAGADO en las nueve: quien tenga `COMPRAS_KEPLER_ESCRITURA` lo enciende desde
 * `/compras/kepler-escritura`, sin desplegar. Sólo aplica a `tipo = 'compra'` (CHECK).
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  // DEFAULT false llena las 18 filas existentes y cubre los dos caminos que insertan
  // (`setKeplerSwitch` y la siembra de PQ.20, que no la nombran).
  if (!(await knex.schema.withSchema('commercial').hasColumn('kepler_push_switch', 'genera_orden'))) {
    await knex.raw(`ALTER TABLE commercial.kepler_push_switch ADD COLUMN genera_orden boolean NOT NULL DEFAULT false`);
  }
  await knex.raw(`ALTER TABLE commercial.kepler_push_switch DROP CONSTRAINT IF EXISTS kepler_push_switch_orden_ck`);
  await knex.raw(`ALTER TABLE commercial.kepler_push_switch ADD CONSTRAINT kepler_push_switch_orden_ck CHECK (NOT genera_orden OR tipo = 'compra')`);
  await knex.raw(`COMMENT ON COLUMN commercial.kepler_push_switch.genera_orden IS
    '[PQ.22] true = al escribir la requisicion X-A-30 se escribe tambien la orden de compra X-A-35 ligada (solo compra).'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE commercial.kepler_push_switch DROP CONSTRAINT IF EXISTS kepler_push_switch_orden_ck`);
  await knex.raw(`ALTER TABLE commercial.kepler_push_switch DROP COLUMN IF EXISTS genera_orden`);
};
