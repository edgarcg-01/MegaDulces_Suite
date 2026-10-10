'use strict';
/**
 * `[GP.4]` — El checado muestra la cantidad en la unidad en que se PIDIÓ ("Pedido 2 BOL · Llevas
 * 1 BOL · Faltan 1 BOL"), no en la base ("40 PZA"). Decisión de Francisco tras la prueba visual
 * (2026-10-10, `FASE_GP` §9.6.2): "respetando la unidad solicitada".
 *
 * `commercial.order_check_lines` guarda la presentación del pedido y cuántas de la base trae. Se
 * llenan al tomar el pedido desde `wave_order_lines` (lo congelado al arrancar el surtido, GP.3);
 * NULL = surtido anterior a GP.3, y la pantalla cae a la base.
 *
 * ── Lo medido antes (sólo lectura, prod) ────────────────────────────────────────────────────
 *  · `20261008143820_gp4_checado` ya está aplicada (2026-10-09) y la tabla NO tiene estas columnas.
 *    Por eso va en una migración nueva y no se edita la aplicada.
 *  · `commercial.order_checks` tiene 0 filas: no hay nada que rellenar hacia atrás.
 *
 * Crea esquema (columnas): la compuerta del despliegue no frena. Va ANTES del código: el servidor
 * del checado lee estas columnas al cargar un pedido.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`ALTER TABLE commercial.order_check_lines
    ADD COLUMN IF NOT EXISTS unidad_pedida varchar(20),
    ADD COLUMN IF NOT EXISTS factor_pedida numeric(14,3)`);
  await knex.raw(`COMMENT ON COLUMN commercial.order_check_lines.unidad_pedida IS
    '[GP.4] Presentación en que se pidió (BOL, PAQ, CJA). NULL = surtido anterior a GP.3: se muestra en la base.'`);
  await knex.raw(`COMMENT ON COLUMN commercial.order_check_lines.factor_pedida IS
    '[GP.4] Cuántas de la unidad base trae una unidad pedida (3 BOL = 60 PZA → 20).'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`ALTER TABLE commercial.order_check_lines
    DROP COLUMN IF EXISTS unidad_pedida,
    DROP COLUMN IF EXISTS factor_pedida`);
};
