/**
 * `[CC.33]` El interruptor por sucursal para **escribir el COBRO `U-A-7` en Kepler desde la pantalla**.
 *
 * Nace **apagado en las nueve**, igual que nació el del Ajuste Abono: encender es un acto aparte, con nombre y
 * fecha, no un efecto de desplegar. La fila existe desde ya para que la pantalla pueda preguntar «¿se puede aquí?»
 * y no ofrecer un botón que va a fallar.
 *
 * ⛔⛔ Y lo que el interruptor NO enciende: **el timbre**. El complemento de pago lo emite el programa `FE4Cobro`
 * de Kepler llamando al PAC; escribir las tablas no lo dispara (`CC.26`, medido). Un cobro escrito por la Suite
 * nace sin complemento — como los 6 que el propio Kepler dejó así en Canindo el 22 y 23 de septiembre (`CC.32`).
 *
 * Idempotente: si la fila ya está, no la pisa (no vuelve a apagar lo que alguien encendió a propósito).
 */
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const SUCURSALES = ['00', '01', '02', '03', '04', '05', '06', '07', '08'];
const NOTA = '[CC.33] Registrar el cobro U-A-7 en Kepler desde la bandeja de fichas. NO timbra: el complemento lo pone Kepler.';

exports.up = async function up(knex) {
  const hay = await knex.raw(`SELECT to_regclass('commercial.kepler_push_switch') IS NOT NULL AS ok`);
  if (!hay.rows[0]?.ok) {
    console.log('commercial.kepler_push_switch no existe todavía: no hay dónde poner el interruptor.');
    return;
  }

  let nuevas = 0;
  for (const sucursal of SUCURSALES) {
    const r = await knex.raw(
      `INSERT INTO commercial.kepler_push_switch (tenant_id, sucursal, tipo, encendida, nota)
       VALUES (?, ?, 'cobro', false, ?)
       ON CONFLICT DO NOTHING`,
      [TENANT, sucursal, NOTA]);
    nuevas += r.rowCount || 0;
  }

  const total = await knex.raw(
    `SELECT count(*) FILTER (WHERE encendida) AS encendidas, count(*) AS filas
       FROM commercial.kepler_push_switch WHERE tenant_id = ? AND tipo = 'cobro'`, [TENANT]);
  const t = total.rows[0] || {};
  console.log(`[CC.33] interruptor 'cobro': ${nuevas} fila(s) nueva(s); quedan ${t.filas} fila(s), ${t.encendidas} encendida(s).`);
};

exports.down = async function down(knex) {
  // ⛔ Sólo las que siguen apagadas: si alguien encendió una sucursal, bajar la migración NO le quita el permiso
  //    sin que se note. Se borra lo que esta migración puso y nadie tocó.
  const r = await knex.raw(
    `DELETE FROM commercial.kepler_push_switch
      WHERE tenant_id = ? AND tipo = 'cobro' AND encendida = false`, [TENANT]);
  console.log(`[CC.33] revertido: ${r.rowCount || 0} interruptor(es) 'cobro' apagados borrados.`);
};
