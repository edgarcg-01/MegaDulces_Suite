/* eslint-disable no-console */
/**
 * `[CANON.7.1]` — CANDADO: la existencia del ODS se lee DIRECTO y rápido, sin copia.
 *
 * Para retirar `commercial.stock` (la copia del importer `import-branch-stock-live`) los lectores pasan a
 * `analytics.v_erp_stock_on_hand`. Esa vista tardaba 10.5–14 s por sucursal porque el planificador estimaba 204 filas
 * de `kdil` donde hay 37 mil (el filtro `sucursal = c1` compara dos columnas). La migración
 * `20261119083212_canon71_existencia_ods_estimado_y_factor_por_evento` le da la estadística y lee el factor de caja de
 * la tabla por evento de `[CANON.6.21]`. Lo que este archivo existe para que no vuelva:
 *
 *   1. ⛔ Que alguien reescriba el filtro como `k.sucursal = k.c1` (se ve igual y es lo «limpio»): el planificador deja
 *      de usar la estadística y la vista vuelve a 11 s. Se exige la forma `IS TRUE` Y que la estadística exista.
 *   2. ⛔ Que el ESTIMADO vuelva a mentir (estadística borrada, tabla nunca analizada): se lee del EXPLAIN contra el
 *      conteo real, no de la forma del SQL.
 *   3. Que el arreglo de velocidad cambie la CANTIDAD: se compara al renglón contra el texto anterior de la vista.
 *   4. Que el factor de caja difiera de su vista por algo que no sea el retraso declarado (la tabla por evento vs
 *      `v_product_box_factor`): toda diferencia de `display_box_factor` tiene que estar entre las que ya difieren ahí.
 *   5. El tiempo por sucursal, bajo el gate de 500 ms. ⚠️ Sólo vale medido con un rol SIN superusuario ni BYPASSRLS
 *      (como corre la app): con `postgres` la vista vieja también era rápida. Si no, se declara NO MEDIDO.
 *
 * Sólo lectura (`BEGIN READ ONLY`). Sin datos en `kdil` (la base del CI), lo que pide datos queda NO MEDIDO.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-canon71-existencia-ods.js
 */
const path = require('path');
const { Client } = require('pg');

const T = '00000000-0000-0000-0000-00000000d01c';
const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();
const MIG = require(path.resolve(__dirname, '..', 'migrations-newdb',
  '20261119083212_canon71_existencia_ods_estimado_y_factor_por_evento.js'));
const GATE_MS = 500;

let ok = 0; let fail = 0; let skip = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const nomedido = (label, why) => { skip++; console.log(`  ○ NO MEDIDO — ${label}: ${why}`); };
const fin = async (c) => {
  await c.query('ROLLBACK').catch(() => {});
  await c.end();
  console.log(`\n=== ${ok} OK · ${fail} FAIL · ${skip} NO MEDIDO ===\n`);
  process.exit(fail ? 1 : 0);
};

(async () => {
  const c = new Client({ connectionString: URL, ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await c.connect();
  await c.query('BEGIN READ ONLY');
  await c.query(`SET LOCAL app.tenant_id = '${T}'`);
  await c.query(`SET LOCAL statement_timeout = '120s'`);
  console.log('\n=== CANDADO [CANON.7.1] · la existencia del ODS, directa y rápida ===\n');

  const { rows: [h] } = await c.query(`SELECT to_regclass('analytics.v_erp_stock_on_hand') IS NOT NULL AS vista,
      EXISTS (SELECT 1 FROM pg_statistic_ext WHERE stxrelid = to_regclass('kepler_ods.kdil')
                AND stxnamespace = 'kepler_ods'::regnamespace AND stxname = 'st_kdil_almacen_propio') AS estadistica`);
  if (!h.vista) { nomedido('analytics.v_erp_stock_on_hand no existe', 'base sin migrar'); return fin(c); }

  // ── 1. La forma: la estadística y el filtro que la usa van juntos ─────────────────────────────────────────────
  check('existe kepler_ods.st_kdil_almacen_propio (la estadística de sucursal = c1)', h.estadistica);
  const { rows: [e] } = await c.query(`SELECT pg_get_statisticsobjdef_expressions(oid)::text AS x FROM pg_statistic_ext
     WHERE stxname = 'st_kdil_almacen_propio' AND stxnamespace = 'kepler_ods'::regnamespace`);
  check('la estadística es de la expresión (sucursal = c1), no de las columnas', /^\{"?\(sucursal = c1\)"?\}$/.test(e?.x || ''), e?.x);
  const { rows: [d] } = await c.query(`SELECT pg_get_viewdef('analytics.v_erp_stock_on_hand'::regclass, true) AS d`);
  check('la vista filtra con (k.sucursal = k.c1) IS TRUE — sin IS TRUE el planificador no usa la estadística',
    /\(k\.sucursal = k\.c1\) IS TRUE/.test(d.d));
  check('la vista no compara las dos columnas sueltas (k.sucursal = k.c1 fuera del IS TRUE)',
    !/(^|[^(])k\.sucursal = k\.c1(?!\) IS TRUE)/m.test(d.d));
  check('el factor de caja sale de la tabla por evento, no de v_product_box_factor (~330 ms por lectura)',
    /analytics\.resolved_product_box_factor bfx/.test(d.d) && !/v_product_box_factor/.test(d.d));

  const { rows: [k] } = await c.query(`SELECT count(*)::int AS n FROM kepler_ods.kdil`);
  if (k.n < 1000) {
    nomedido('estimado, cantidad, factor y tiempo', `kdil trae ${k.n} filas (base sin datos del ERP)`);
    return fin(c);
  }

  // ── 2. El estimado contra el conteo real, en la sucursal con más filas propias ────────────────────────────────
  const { rows: [w] } = await c.query(`SELECT w.code, count(*)::int AS reales FROM kepler_ods.kdil k
      JOIN commercial.warehouses w ON w.kepler_code = k.sucursal AND w.deleted_at IS NULL
     WHERE k.sucursal = k.c1 GROUP BY w.code ORDER BY 2 DESC LIMIT 1`);
  const plan = (await c.query(`EXPLAIN SELECT * FROM analytics.v_erp_stock_on_hand WHERE warehouse_code = $1`, [w.code]))
    .rows.map((r) => r['QUERY PLAN']);
  const linea = plan.find((l) => /Scan on kdil k\b/.test(l)) || '';
  const est = Number((linea.match(/rows=(\d+)/) || [])[1]);
  const { rows: [propio] } = await c.query(`SELECT count(*) FILTER (WHERE sucursal = c1)::int AS n FROM kepler_ods.kdil`);
  check(`el planificador ve las filas propias de kdil (estima ${est}, son ${propio.n}; sin estadística estimaba ~0.5 %)`,
    est >= propio.n * 0.5 && est <= propio.n * 2, linea.trim());

  // ── 3. La cantidad, al renglón, contra el texto anterior de la vista ──────────────────────────────────────────
  const anterior = MIG.SQL_ANTERIOR.replace(/^\s*CREATE OR REPLACE VIEW analytics\.v_erp_stock_on_hand AS/, '');
  const huella = (q) => `SELECT count(*)::int AS n, md5(string_agg(x::text, '|' ORDER BY x::text)) AS h
                           FROM (SELECT warehouse_id, product_id, qty_stock_units, unit_source, source FROM (${q}) v) x`;
  const [ahora, antes] = [(await c.query(huella('SELECT * FROM analytics.v_erp_stock_on_hand'))).rows[0],
    (await c.query(huella(anterior))).rows[0]];
  check(`la CANTIDAD es la misma que con el texto anterior (${ahora.n} filas)`, ahora.n === antes.n && ahora.h === antes.h,
    `${ahora.n} vs ${antes.n}`);

  // ── 4. El factor de caja: sólo difiere donde la tabla por evento difiere de su vista (retraso declarado) ─────
  const { rows: [f] } = await c.query(`
    WITH a AS (SELECT * FROM analytics.v_erp_stock_on_hand), b AS (${anterior}),
    dif AS (SELECT a.product_id FROM a JOIN b USING (warehouse_id, product_id) WHERE a.display_box_factor IS DISTINCT FROM b.display_box_factor),
    lag AS (SELECT COALESCE(t.product_id, v.product_id) AS product_id
              FROM analytics.resolved_product_box_factor t FULL JOIN analytics.v_product_box_factor v USING (tenant_id, product_id)
             WHERE t.box_factor IS DISTINCT FROM v.box_factor)
    SELECT (SELECT count(DISTINCT product_id) FROM dif)::int AS productos,
           (SELECT count(DISTINCT product_id) FROM dif WHERE product_id NOT IN (SELECT product_id FROM lag))::int AS sin_explicar,
           (SELECT count(*) FROM lag)::int AS retraso`);
  check(`display_box_factor difiere en ${f.productos} productos, TODOS entre los ${f.retraso} en que la tabla por evento `
    + 'aún no alcanza a v_product_box_factor', f.sin_explicar === 0, `${f.sin_explicar} sin explicar`);

  // ── 5. El tiempo, sólo si se mide como la app ─────────────────────────────────────────────────────────────────
  const { rows: [r] } = await c.query(`SELECT current_user AS u, rolsuper OR rolbypassrls AS salta FROM pg_roles WHERE rolname = current_user`);
  if (r.salta) {
    nomedido('tiempo por sucursal', `el rol ${r.u} salta RLS: con él la vista vieja también era rápida; medir con uno como app_runtime`);
  } else {
    const ts = [];
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      await c.query(`SELECT count(*) FROM analytics.v_erp_stock_on_hand WHERE warehouse_code = $1`, [w.code]);
      ts.push(Date.now() - t0);
    }
    const med = [...ts].sort((x, y) => x - y)[1];
    check(`una sucursal (${w.code}) bajo ${GATE_MS} ms con RLS, como ${r.u}: ${ts.join(' / ')} ms (antes 10.5–14 s)`, med < GATE_MS);
  }
  return fin(c);
})().catch((err) => { console.error('ERROR:', err.message); process.exit(1); });
