'use strict';
/**
 * `[RD.50]` — La corrida de comisiones **nunca se pudo guardar**: le falta una columna.
 *
 * ── Lo medido antes (sólo lectura, contra prod 2026-10-08) ──────────────────────────────────
 *  · `commercial.commission_runs` tiene **0 filas. Nunca tuvo ninguna**, ni borradas.
 *  · Log de la API, 11:16:07 — alguien apretó "Calcular desde Q1":
 *      `20 cerrada(s) · 0 calculada(s) · 0 saltada(s) · 20 falla(s) · 248,596 ms`
 *  · La falla, reproducida contra prod dentro de una transacción revertida:
 *      `42703: column "dias_multifuente" of relation "commission_runs" does not exist`
 *  · `totales()` la devuelve y `persist()` hace `...totals` dentro del `INSERT`
 *    (`commercial-commissions.service.ts`): falla el **100 %** de las veces, para toda
 *    quincena, desde `c4dff2b04` (PR #303).
 *
 * ── Por qué la columna y no sacarla del INSERT ──────────────────────────────────────────────
 * Sacarla del `insert` costaba cero migraciones, pero dejaba **dos formas del mismo objeto**:
 * `preview`/`compute` devuelven el agregado (viene de `...totals` en el payload) y releer la
 * corrida guardada no lo traería. Un campo que existe según por dónde lo pidas es la clase de
 * mentira que esta fase existe para no repetir. Se congela, por la misma razón que
 * `dias_con_venta` y `beneficiario_nombre`: derivarlo después lo contaría contra la fuente de
 * hoy, ya reparada, y una corrida vieja diría que el periodo nunca cruzó un cambio de sistema.
 *
 * ⚠️ `traslape_subtotal` (misma tabla, de `20261007210000`) queda **dead a propósito**: es el
 *    vestigio de la hipótesis de duplicación que `[RD.17]` midió y REFUTÓ, y `dias_multifuente`
 *    es justamente lo que la reemplazó. No se borra acá — borrar columnas pide confirmación.
 *
 * ⚠️ La tabla está VACÍA (0 filas), así que el `ADD COLUMN` es instantáneo y no toma lock de
 *    datos. Aun así va con `lock_timeout`: lo que puede esperar es el lock de catálogo.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const RUNS = 'commercial.commission_runs';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const tiene = await knex.schema.withSchema('commercial').hasColumn('commission_runs', 'dias_multifuente');
  if (!tiene) {
    await knex.raw(`ALTER TABLE ${RUNS} ADD COLUMN dias_multifuente integer`);
  }

  await knex.raw(`COMMENT ON COLUMN ${RUNS}.dias_multifuente IS
    'RD.50 - cuantos dias del periodo fueron alimentados por MAS DE UNA captura. No es duplicado: es el corte de sistema (medido en RD.17: 3 dias con dos capturas en 120 d y CERO folios compartidos en 200 d). Lo consume la compuerta de traslape. Sin esta columna el INSERT de persist() fallaba con 42703 y el motor no guardo nunca una corrida.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  const tiene = await knex.schema.withSchema('commercial').hasColumn('commission_runs', 'dias_multifuente');
  if (tiene) {
    await knex.raw(`ALTER TABLE ${RUNS} DROP COLUMN dias_multifuente`);
  }
};
