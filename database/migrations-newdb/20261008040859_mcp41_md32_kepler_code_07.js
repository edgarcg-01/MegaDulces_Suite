'use strict';
/**
 * `[MCP.4.1]` — El almacén dado de baja `MD-32` (Morelia Madero en Wincaja) cobra en Kepler como `07`.
 *
 * ── Por qué ──────────────────────────────────────────────────────────────────────────────
 * La Mesa de Control de Preventa (Fase MCP, ADR-089) busca el ticket de Kepler con que se cobró un
 * pedido en la sucursal Kepler del almacén del pedido (`warehouses.kepler_code`, el crosswalk
 * canónico de la mig 20260815130000). Medido en prod el 2026-10-08:
 *   · `MD-32` "Almacén Morelia Madero (32)" se dio de BAJA el 2026-09-11 (`deleted_at`), sin
 *     `kepler_code`; lo reemplazó el almacén `07` "Morelia Madero" con `kepler_code = '07'`.
 *   · 7 pedidos de preventa (6 al 11 de septiembre) quedaron apuntando a `MD-32`, y sus clientes
 *     traen clave de Kepler de la sucursal 07.
 * Francisco confirmó el 2026-10-08 que Morelia Madero cobra en Kepler como sucursal 07.
 *
 * ── Qué hace ─────────────────────────────────────────────────────────────────────────────
 * Sólo escribe `kepler_code = '07'` en la fila de `MD-32`, y sólo si está vacío. No revive el
 * almacén ni toca otra columna. El índice único `warehouses_kepler_code_uq` es parcial sobre filas
 * VIVAS, así que no choca con el almacén `07` (MD-32 está dado de baja).
 *
 * Idempotente: si ya tiene un código, no lo pisa — y si tiene uno DISTINTO de 07 se detiene, porque
 * alguien más decidió otra cosa y no hay que adivinar cuál es la buena.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);

  const { rows } = await knex.raw(`
    SELECT id, kepler_code, deleted_at
      FROM commercial.warehouses
     WHERE code = 'MD-32'`);

  if (!rows.length) {
    console.log('  [MCP.4.1] ◻ NO APLICA: no existe el almacén MD-32 en esta base.');
    return;
  }
  if (rows.length > 1) {
    throw new Error(`[MCP.4.1] hay ${rows.length} almacenes con código MD-32: no se adivina cuál es.`);
  }
  const w = rows[0];
  if (w.kepler_code === '07') {
    console.log('  [MCP.4.1] ✓ MD-32 ya tiene kepler_code 07: nada que hacer.');
    return;
  }
  if (w.kepler_code) {
    throw new Error(`[MCP.4.1] MD-32 ya tiene kepler_code '${w.kepler_code}', distinto de 07: no se pisa.`);
  }

  const n = await knex('commercial.warehouses')
    .where({ id: w.id })
    .whereNull('kepler_code')
    .update({ kepler_code: '07', updated_at: knex.fn.now() });
  if (n !== 1) throw new Error(`[MCP.4.1] se esperaba actualizar 1 fila y se actualizaron ${n}.`);
  console.log(`  [MCP.4.1] MD-32 → kepler_code 07 (almacén ${w.deleted_at ? 'dado de baja' : 'vivo'}).`);
};

exports.down = async function down(knex) {
  await knex('commercial.warehouses').where({ code: 'MD-32', kepler_code: '07' }).update({ kepler_code: null });
};
