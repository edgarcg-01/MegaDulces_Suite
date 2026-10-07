'use strict';
/**
 * `[RD.41]` — La declaracion de `[RD.40]` se materializa, porque medida cuesta 305 ms.
 *
 * `analytics.v_rd_route_opening` pega contra `kepler_ods.kdm1`/`kdm2` con tres laterales por
 * ruta. Devuelve 11 filas y tarda **305 ms**. Medido contra prod el 2026-10-07, sobre la
 * consulta de la pantalla de inventario de ruta:
 *
 *   sin la declaracion : 130 / 136 / 133 ms
 *   con la declaracion : 427 / 418 / 431 ms
 *
 * El liston de este proyecto es **500 ms**, y esa prueba es una version RECORTADA de la
 * consulta real (le faltan `carga_dia`, `ultimo_dia` y el join a `commercial.warehouses`). O
 * sea: con la declaracion leida en vivo, la pantalla se pasa.
 *
 * ⭐ Materializar por COSTO es legitimo (`GOTCHAS` §19); lo que la regla principal prohibe es
 *    materializar un valor **inventado**. Esto es `SELECT *` de la vista — exactamente el mismo
 *    patron que `mv_rd_route_ledger` sobre `v_rd_route_ledger`, y entra al mismo ciclo de
 *    refresco de 30 min que las otras tres matvistas de RD. La vista viva sigue siendo el
 *    arbitro de paridad.
 *
 * ⚠️ El `UNIQUE` no es decoracion: es requisito de `REFRESH ... CONCURRENTLY` **y** la asercion
 *    de que el grano es una fila por ruta. Si algun dia la vista duplicara, el refresco falla
 *    en vez de publicar doble.
 *
 * @param { import("knex").Knex } knex
 */

const VISTA = 'analytics.v_rd_route_opening';
const MV = 'analytics.mv_rd_route_opening';

exports.up = async function up(knex) {
  const existe = (await knex.raw('SELECT to_regclass(?) AS t', [MV])).rows[0];
  if (!existe || !existe.t) {
    await knex.raw(`CREATE MATERIALIZED VIEW ${MV} AS SELECT * FROM ${VISTA}`);
    await knex.raw(`CREATE UNIQUE INDEX ux_mv_rd_route_opening ON ${MV} (tenant_id, route_no)`);
    await knex.raw(`GRANT SELECT ON ${MV} TO app_runtime`);
    await knex.raw(`COMMENT ON MATERIALIZED VIEW ${MV} IS
      'RD.41 - copia POR COSTO de analytics.v_rd_route_opening (SELECT *, para que no pueda
       divergir). La vista viva sigue siendo el arbitro. Medido: leida en vivo le sumaba 297 ms
       a una pantalla con liston de 500. Se refresca con las otras tres matvistas de RD.'`);
  }

  // ── Freno 1: PARIDAD. Una copia que no coincide con su fuente es una segunda verdad. ──────
  const dif = (await knex.raw(`
    SELECT count(*)::int AS n FROM (
      SELECT tenant_id, route_no, exposicion_costo, medible FROM ${MV}
      EXCEPT
      SELECT tenant_id, route_no, exposicion_costo, medible FROM ${VISTA}
    ) d`)).rows[0];
  if (Number(dif.n) > 0) {
    throw new Error(`[RD.41] la copia difiere de la vista en ${dif.n} fila(s) recien creada. No publicar.`);
  }

  // ── Freno 2: el grano. Si hubiera mas de una fila por ruta, el UNIQUE ya habria fallado,
  //    pero la asercion se escribe igual: un indice que protege no explica. ──────────────────
  const g = (await knex.raw(`
    SELECT count(*)::int AS filas, count(DISTINCT route_no)::int AS rutas FROM ${MV}`)).rows[0];
  if (Number(g.filas) !== Number(g.rutas)) {
    throw new Error(`[RD.41] la copia trae ${g.filas} filas para ${g.rutas} rutas.`);
  }
  if (Number(g.rutas) < 10) throw new Error(`[RD.41] solo ${g.rutas} rutas en la copia; esperaba 10+.`);

  // ── Freno 3: el PROPOSITO era el tiempo. Si no bajo, esta migracion no sirvio de nada. ────
  const mide = async (sql) => {
    await knex.raw(sql);
    const t = [];
    for (let i = 0; i < 3; i++) { const t0 = Date.now(); await knex.raw(sql); t.push(Date.now() - t0); }
    return Math.min(...t);
  };
  const msVista = await mide(`SELECT * FROM ${VISTA}`);
  const msCopia = await mide(`SELECT * FROM ${MV}`);
  if (!(msCopia < msVista)) {
    throw new Error(`[RD.41] la copia (${msCopia} ms) no es mas rapida que la vista (${msVista} ms): ` +
      'materializarla no sirvio.');
  }
  if (msCopia > 50) {
    throw new Error(`[RD.41] la copia tarda ${msCopia} ms para 11 filas: algo esta mal con el indice.`);
  }
  console.log(`  · [RD.41] vista ${msVista} ms -> copia ${msCopia} ms · ${g.rutas} rutas`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MV}`);
};
