/* eslint-disable no-console */
/**
 * `[PR.D5]` — Candado del universo de experimentos de precio.
 *
 * Esta matvista existe por una razón medida: diseñar un experimento tardaba **104,911 ms**.
 * Un candado de rendimiento que sólo mide «¿tarda poco?» no sirve, porque una matvista vacía
 * tarda nada. Así que las aserciones son tres, y van juntas:
 *
 *  1. ⭐ **Que sea una COPIA fiel**, no una segunda definición: la matvista y la vista viva
 *     tienen que dar el mismo universo. Si divergen, la pantalla decide sobre un catálogo que
 *     ya no existe y se ve igual de confiable.
 *  2. ⭐ **Que el atajo esté justificado**: se comprueba que filtrar la VISTA sigue siendo caro.
 *     El día que deje de serlo, esta matvista es deuda y hay que retirarla.
 *  3. ⛔ **Que la frescura nocturna no corrompa `precio_antes`**: el diseño excluye las celdas
 *     con precio inestable, así que lo que sobrevive debería tener el mismo precio hoy que
 *     ayer. Eso es el argumento que sostiene materializar — y se COMPRUEBA, no se asume.
 */
'use strict';

const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); }
catch { /* en el contenedor la URL viene del entorno */ }
const { Client } = require('pg');

const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const MV = 'analytics.mv_price_experiment_universe';
let ok = 0, fail = 0, nomedido = 0;
const check = (c, m) => { if (c) { ok++; console.log('  ✔ ' + m); } else { fail++; console.log('  ✘ ' + m); } };
const skip = (m) => { nomedido++; console.log('  — NO MEDIDO: ' + m); };

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL_NEW });
  await db.connect();
  await db.query(`SET app.tenant_id = '${TENANT}'`);
  await db.query("SET statement_timeout = '180s'");
  const q = async (s, p) => (await db.query(s, p)).rows;

  console.log('\n[1] La forma');
  const mv = await q(`SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='analytics' AND c.relname='mv_price_experiment_universe'`);
  check(mv.length === 1 && mv[0].relkind === 'm', 'existe y es una matvista');
  const ix = await q(`SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname='analytics' AND tablename='mv_price_experiment_universe'`);
  check(ix.some((i) => /UNIQUE/i.test(i.indexdef)),
    'tiene índice UNIQUE: sin él REFRESH CONCURRENTLY no corre y el refresco bloquea las lecturas');
  check(ix.length >= 2, `tiene ${ix.length} índices (el del camino caliente, además del UNIQUE)`);

  console.log('\n[2] Está poblada');
  const n = await q(`SELECT count(*)::int total, count(*) FILTER (WHERE oscila)::int osc,
      max(calculado_al)::text al FROM ${MV}`);
  if (!n[0].total) {
    skip('la matvista está vacía — nace WITH NO DATA y la puebla el nocturno; el resto no se mide');
    await db.end();
    console.log(`\n${ok} ✓ / ${fail} ✗ / ${nomedido} no medido`);
    process.exit(fail ? 1 : 0);
  }
  console.log(`     ${n[0].total.toLocaleString('es-MX')} filas · ${n[0].osc.toLocaleString('es-MX')} con precio inestable · calculada ${n[0].al}`);
  check(n[0].total > 50000, `${n[0].total} filas`);
  check(n[0].osc > 0 && n[0].osc < n[0].total,
    'el candado de precio inestable marca a algunas y no a todas: si marcara a todas, nadie sería elegible');

  console.log('\n[3] ⭐ Es una COPIA fiel, no una segunda definición');
  const cmp = await q(`
    WITH viva AS MATERIALIZED (
      SELECT sucursal, sku, precio, terminacion, veredicto, venta_neta_30d
        FROM analytics.v_price_psychology)
    SELECT
      (SELECT count(*) FROM viva)::int AS en_la_vista,
      (SELECT count(*) FROM ${MV})::int AS en_la_mv,
      (SELECT count(*) FROM viva v JOIN ${MV} m USING (sucursal, sku)
        WHERE v.terminacion IS DISTINCT FROM m.terminacion
           OR v.veredicto   IS DISTINCT FROM m.veredicto)::int AS difieren_clasificacion`);
  const c = cmp[0];
  console.log(`     vista ${c.en_la_vista} · matvista ${c.en_la_mv} · clasifican distinto ${c.difieren_clasificacion}`);
  check(Math.abs(c.en_la_vista - c.en_la_mv) <= c.en_la_vista * 0.02,
    'la matvista cubre el mismo universo que la vista (±2 %: el catálogo se mueve entre refrescos)');
  check(c.difieren_clasificacion === 0,
    `ninguna celda está clasificada distinto en las dos (${c.difieren_clasificacion})`);

  console.log('\n[4] ⛔ La frescura nocturna NO corrompe el precio del experimento');
  // El diseño excluye las celdas con precio inestable. Si el argumento es cierto, las elegibles
  // tienen hoy el mismo precio que cuando se materializó.
  const fr = await q(`
    WITH viva AS MATERIALIZED (SELECT sucursal, sku, precio FROM analytics.v_price_psychology)
    SELECT count(*)::int elegibles,
           count(*) FILTER (WHERE v.precio IS DISTINCT FROM m.precio)::int movidas
      FROM ${MV} m JOIN viva v USING (sucursal, sku)
     WHERE NOT m.oscila AND m.terminacion='sucio' AND m.veredicto <> 'fuera_de_alcance'
       AND m.venta_neta_30d > 0`);
  if (!fr[0].elegibles) { skip('sin celdas elegibles: la frescura no se puede comprobar'); }
  else {
    const pct = (100 * fr[0].movidas) / fr[0].elegibles;
    console.log(`     ${fr[0].movidas} de ${fr[0].elegibles} elegibles cambiaron de precio desde el refresco (${pct.toFixed(2)} %)`);
    // ⚠️ La banda es 5 %, no 0: entre el refresco y esta corrida pasa tiempo real. Lo que el
    //    candado vigila es que NO se dispare — si lo hace, el filtro de precio inestable dejó de
    //    funcionar y materializar deja de ser defendible.
    check(pct < 5,
      `menos del 5 % se movió: el filtro de precio inestable sostiene el argumento de materializar`);
  }

  console.log('\n[5] ⭐ El atajo sigue estando justificado');
  const t0 = Date.now();
  await q(`SELECT sucursal, sku FROM analytics.v_price_psychology
            WHERE precio >= 10 AND precio < 50 AND terminacion='sucio' AND venta_neta_30d > 0`);
  const msVista = Date.now() - t0;
  const t1 = Date.now();
  await q(`SELECT sucursal, sku FROM ${MV}
            WHERE precio >= 10 AND precio < 50 AND terminacion='sucio' AND venta_neta_30d > 0`);
  const msMv = Date.now() - t1;
  console.log(`     la vista viva ${msVista} ms · la matvista ${msMv} ms`);
  check(msVista > msMv * 5,
    `la vista sigue siendo al menos 5× más cara (${Math.round(msVista / Math.max(msMv, 1))}×); si dejara de serlo, esta matvista es deuda`);

  console.log('\n[6] La pantalla: medio segundo, no uno');
  const t2 = Date.now();
  await q(`SELECT u.sucursal, u.sku, u.precio, u.cand_99, u.venta_neta_30d, count(*) OVER () AS e
             FROM ${MV} u
            WHERE u.precio >= 10 AND u.precio < 50 AND u.terminacion='sucio'
              AND u.veredicto <> 'fuera_de_alcance' AND u.venta_neta_30d > 0
              AND u.cand_99 IS NOT NULL AND u.cand_99 <> u.precio AND NOT u.oscila
            ORDER BY u.venta_neta_30d DESC LIMIT 5260`);
  const ms = Date.now() - t2;
  // ⛔ 500 ms, no 1,000: es el número que Edgar puso, y la compuerta sigue al usuario.
  check(ms < 500, `el estrato más grande en ${ms} ms (la compuerta de esta pantalla es 500 ms)`);

  await db.end();
  console.log(`\n${ok} ✓ / ${fail} ✗ / ${nomedido} no medido`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
