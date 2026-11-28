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
const TIPO = 'cobro';

/**
 * Los tipos que hoy acepta el interruptor, **leídos de la restricción que vive en prod**.
 *
 * ⛔ No se copian al código: el CHECK vive en la base y el repo no es su fuente de verdad. Si otra
 * rama ya agregó un tipo que este archivo no conoce, copiar la lista se lo comería.
 * Mismo patrón que `20261126174034_pq160_editar_oc_desde_la_suite.js`.
 */
async function tiposActuales(knex) {
  const { rows } = await knex.raw(
    `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'kepler_push_switch_tipo_ck'`);
  if (!rows.length) return null;
  return [...rows[0].d.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}
const lista = (xs) => xs.map((x) => `'${x}'`).join(',');

exports.up = async function up(knex) {
  const hay = await knex.raw(`SELECT to_regclass('commercial.kepler_push_switch') IS NOT NULL AS ok`);
  if (!hay.rows[0]?.ok) {
    console.log('commercial.kepler_push_switch no existe todavía: no hay dónde poner el interruptor.');
    return;
  }

  // ── El dominio ANTES que la fila ────────────────────────────────────────────────────────────
  // `kepler_push_switch_tipo_ck` enumera los tipos permitidos y `cobro` no estaba: sin esto el
  // INSERT de abajo viola el CHECK y la migración muere. Medido contra prod el 2026-11-27 con el
  // INSERT ejercido en `BEGIN … ROLLBACK`: control negativo → `violates check constraint
  // "kepler_push_switch_tipo_ck"`; con el CHECK ampliado → `INSERT 0 1`.
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const tipos = await tiposActuales(knex);
  if (!tipos) throw new Error('[CC.33] no existe kepler_push_switch_tipo_ck: falta la migración que crea el interruptor.');
  if (!tipos.includes(TIPO)) {
    await knex.raw(`ALTER TABLE commercial.kepler_push_switch DROP CONSTRAINT kepler_push_switch_tipo_ck`);
    await knex.raw(`ALTER TABLE commercial.kepler_push_switch ADD CONSTRAINT kepler_push_switch_tipo_ck CHECK (tipo IN (${lista([...tipos, TIPO])}))`);
    console.log(`[CC.33] el CHECK pasó de ${tipos.length} a ${tipos.length + 1} tipos (agregado '${TIPO}').`);
  }

  // La tabla tiene RLS FORZADA (`relforcerowsecurity`), con la política `kepler_push_switch_tenant`.
  // El aplicador conecta como `postgres`, que la saltea — pero no se depende de eso.
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);

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

  // El CHECK vuelve a su dominio anterior SÓLO si ya no queda ninguna fila que lo necesite: si
  // alguien encendió una sucursal, su fila sigue viva y quitarle el tipo del CHECK la dejaría
  // violando su propia restricción.
  const quedan = await knex.raw(
    `SELECT count(*)::int AS n FROM commercial.kepler_push_switch WHERE tipo = ?`, [TIPO]);
  if ((quedan.rows[0]?.n || 0) > 0) {
    console.log(`[CC.33] el CHECK NO se achica: quedan ${quedan.rows[0].n} fila(s) '${TIPO}' vivas.`);
    return;
  }
  const tipos = await tiposActuales(knex);
  if (tipos && tipos.includes(TIPO)) {
    await knex.raw(`SET LOCAL lock_timeout = '5s'`);
    await knex.raw(`ALTER TABLE commercial.kepler_push_switch DROP CONSTRAINT kepler_push_switch_tipo_ck`);
    await knex.raw(`ALTER TABLE commercial.kepler_push_switch ADD CONSTRAINT kepler_push_switch_tipo_ck CHECK (tipo IN (${lista(tipos.filter((t) => t !== TIPO))}))`);
    console.log(`[CC.33] el CHECK volvió a ${tipos.length - 1} tipos.`);
  }
};
