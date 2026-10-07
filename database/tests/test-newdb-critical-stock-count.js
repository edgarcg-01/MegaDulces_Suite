/* eslint-disable no-console */
/**
 * [RA-PERF.2] EL CONTEO DE EXISTENCIA CRÍTICA — con su prueba NEGATIVA.
 *
 * ── Qué protege ─────────────────────────────────────────────────────────────────────────────
 * `criticalStock()` (pantalla /compras/existencia) sacaba el total de `base.clone()`, así que el
 * `count(*)` arrastraba los MISMOS 13 joins que el listado — incluidos dos agregados caros:
 * `sbp` (un GROUP BY sobre `reorder_policy × stock` de TODO el tenant) y `sr` (un DENSE_RANK
 * sobre todo `inventory_health`). Su WHERE sólo toca `rp`, `s`, `pr` y —si se filtra por ABC—
 * `abc`. Las otras diez relaciones no las nombra ningún filtro.
 *
 * Medido en prod el 2026-09-24, almacén `00` (5,856 políticas), filtro por defecto:
 *     con los 13 joins .... 5,709 filas en 2,364 ms
 *     con las 3 que usa ... 5,709 filas en    16 ms        148×
 *
 * ── Por qué este test existe ────────────────────────────────────────────────────────────────
 * La equivalencia NO es una opinión: es un teorema, y cuelga de UN invariante. Un `LEFT JOIN`
 * sólo es neutral para `count(*)` si su lado derecho tiene **a lo sumo una fila por llave**. Si
 * cualquiera de las siete relaciones retiradas empieza a duplicar, el conteo de hoy (3 joins) y
 * el de ayer (13) dejan de coincidir — y el de 13 sería el "correcto" por accidente, porque
 * estaría contando filas repetidas que el usuario también estaría VIENDO en la tabla.
 *
 * O sea: si este test se pone rojo, el problema **no es la optimización** — es que una tabla
 * que debía ser única por su llave dejó de serlo, y eso ya estaba rompiendo el listado.
 *
 * Los tres bloques, y qué prueba cada uno:
 *   1. el invariante 1:1 sobre las siete relaciones, contra los datos REALES;
 *   2. la prueba NEGATIVA — se duplica a propósito y se comprueba que el conteo SE MUEVE
 *      (si no se moviera, el bloque 1 sería decoración);
 *   3. la equivalencia de punta a punta sobre las tablas reales, para varias combinaciones
 *      de filtro, incluida la que suma `abc`.
 *
 * ⚠️ Lo que NO se puede medir se DECLARA: sin datos, cada bloque reporta `NO MEDIDO`, nunca ✔.
 *
 * Sólo LEE. No escribe una sola fila fuera de tablas TEMP.
 */
const path = require('path');
const { Client } = require('pg');

try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); }
catch { /* dotenv opcional: el runner puede traer el env ya cargado */ }

let ok = 0; let fail = 0; let nm = 0;
const A = (cond, msg) => { if (cond) { ok++; console.log(`  ✔ ${msg}`); } else { fail++; console.log(`  ✖ ${msg}`); } };
const ND = (msg) => { nm++; console.log(`  · NO MEDIDO — ${msg}`); };

/** Las siete relaciones que el conteo dejó de joinear, con la llave por la que se pegaban. */
const RELACIONES = [
  ['commercial.stock', 'tenant_id, warehouse_id, product_id'],
  ['commercial.abc_classification', 'tenant_id, warehouse_id, product_id'],
  ['analytics.replenishment_plan', 'tenant_id, warehouse_id, product_id'],
  ['analytics.inventory_health', 'tenant_id, warehouse_id, product_id'],
  ['commercial.replenishment_channel', 'tenant_id, warehouse_id, supplier_id'],
  ['analytics.v_erp_unit_cost', 'tenant_id, warehouse_id, product_id'],
  ['analytics.v_warehouse_box_factor', 'tenant_id, warehouse_id, product_id'],
];

/** El WHERE de `criticalFilters()`, sin los filtros opcionales: es el default de la pantalla. */
const OH = '(COALESCE(s.quantity,0) - COALESCE(s.reserved_quantity,0))';

/** Las tres relaciones que el conteo SÍ conserva. `extra` suma `abc` cuando el filtro lo pide. */
function conteoNuevo(extra = '') {
  return `
    SELECT count(*)::int AS c
      FROM commercial.reorder_policy rp
      LEFT JOIN commercial.stock s
             ON s.tenant_id = rp.tenant_id AND s.warehouse_id = rp.warehouse_id AND s.product_id = rp.product_id
      JOIN catalog.products pr
             ON pr.tenant_id = rp.tenant_id AND pr.id = rp.product_id
      ${extra}`;
}

/** El conteo de ANTES: las mismas tres más las siete que se retiraron (y los dos agregados). */
function conteoViejo(tenant) {
  return `
    SELECT count(*)::int AS c
      FROM commercial.reorder_policy rp
      LEFT JOIN commercial.stock s
             ON s.tenant_id = rp.tenant_id AND s.warehouse_id = rp.warehouse_id AND s.product_id = rp.product_id
      JOIN catalog.products pr
             ON pr.tenant_id = rp.tenant_id AND pr.id = rp.product_id
      LEFT JOIN commercial.warehouses w    ON w.tenant_id = rp.tenant_id AND w.id = rp.warehouse_id
      LEFT JOIN catalog.suppliers sup      ON sup.tenant_id = rp.tenant_id AND sup.id = pr.supplier_id
      LEFT JOIN commercial.abc_classification abc
             ON abc.tenant_id = rp.tenant_id AND abc.warehouse_id = rp.warehouse_id AND abc.product_id = rp.product_id
      LEFT JOIN analytics.v_erp_unit_cost euc
             ON euc.tenant_id = rp.tenant_id AND euc.warehouse_id = rp.warehouse_id AND euc.product_id = rp.product_id
      LEFT JOIN analytics.replenishment_plan rpl
             ON rpl.tenant_id = rp.tenant_id AND rpl.warehouse_id = rp.warehouse_id AND rpl.product_id = rp.product_id
      LEFT JOIN analytics.inventory_health ih
             ON ih.tenant_id = rp.tenant_id AND ih.warehouse_id = rp.warehouse_id AND ih.product_id = rp.product_id
      LEFT JOIN commercial.replenishment_channel rc
             ON rc.tenant_id = rp.tenant_id AND rc.warehouse_id = rp.warehouse_id AND rc.supplier_id = pr.supplier_id
      LEFT JOIN commercial.warehouses srcw ON srcw.tenant_id = rp.tenant_id AND srcw.id = rc.source_warehouse_id
      LEFT JOIN (SELECT tenant_id, product_id, max(box_size) AS bs
                   FROM commercial.v_product_label_prices GROUP BY tenant_id, product_id) lbl
             ON lbl.tenant_id = rp.tenant_id AND lbl.product_id = rp.product_id
      LEFT JOIN analytics.v_warehouse_box_factor vbf
             ON vbf.tenant_id = rp.tenant_id AND vbf.warehouse_id = rp.warehouse_id AND vbf.product_id = rp.product_id
      LEFT JOIN (SELECT rp2.product_id,
                        SUM(GREATEST(0, (COALESCE(s2.quantity,0) - COALESCE(s2.reserved_quantity,0)) - rp2.max_stock)) AS surplus_total
                   FROM commercial.reorder_policy rp2
                   LEFT JOIN commercial.stock s2
                          ON s2.tenant_id = rp2.tenant_id AND s2.warehouse_id = rp2.warehouse_id AND s2.product_id = rp2.product_id
                  WHERE rp2.tenant_id = '${tenant}' GROUP BY rp2.product_id) sbp
             ON sbp.product_id = rp.product_id
      LEFT JOIN (SELECT ih2.warehouse_id, ih2.product_id,
                        DENSE_RANK() OVER (PARTITION BY ih2.warehouse_id
                          ORDER BY ih2.avg_daily_units * COALESCE(p2.cost_with_tax,0)
                                   * (1 + COALESCE(p2.markup_pct,0)/100.0) DESC, ih2.avg_daily_units DESC) AS sales_rank
                   FROM analytics.inventory_health ih2
                   JOIN catalog.products p2 ON p2.id = ih2.product_id AND p2.tenant_id = ih2.tenant_id
                  WHERE ih2.tenant_id = '${tenant}' AND ih2.avg_daily_units > 0 AND p2.activo = true) sr
             ON sr.warehouse_id = rp.warehouse_id AND sr.product_id = rp.product_id`;
}

(async () => {
  const cs = process.env.CRITICAL_COUNT_TEST_DB_URL || process.env.DATABASE_URL_NEW || process.env.DATABASE_URL;
  if (!cs) { console.log('NO MEDIDO — sin DATABASE_URL_NEW/DATABASE_URL'); process.exit(0); }
  const c = new Client({
    connectionString: cs,
    ssl: /localhost|127\.0\.0\.1|pg-prod|192\.168\./.test(cs) ? false : { rejectUnauthorized: false },
    statement_timeout: 300000,
  });
  await c.connect();
  await c.query(`SET statement_timeout = '300s'`);

  // El tenant con más políticas: así el test sirve en cualquier entorno sin UUID clavado.
  const t = (await c.query(`
    SELECT tenant_id::text AS id, count(*)::int AS n
      FROM commercial.reorder_policy GROUP BY 1 ORDER BY n DESC LIMIT 1`)).rows[0];
  if (!t || !t.n) {
    ND('commercial.reorder_policy está vacía — sin datos no hay conteo que comparar');
    console.log(`\n=== ${ok} ✔ · ${fail} ✖ · ${nm} NO MEDIDO ===\n`);
    await c.end(); process.exit(0);
  }
  console.log(`\ntenant ${t.id} · ${t.n.toLocaleString('es-MX')} políticas de reorden\n`);

  // ── 1) El invariante: ninguna relación retirada puede tener más de una fila por llave ──────
  console.log('1) el invariante 1:1 sobre los datos REALES');
  for (const [rel, llave] of RELACIONES) {
    const reg = (await c.query(`SELECT to_regclass($1) AS t`, [rel])).rows[0].t;
    if (!reg) { ND(`${rel} no existe en este entorno`); continue; }
    const r = (await c.query(`
      SELECT COALESCE(max(n),0)::int AS maxn, count(*) FILTER (WHERE n > 1)::int AS dups, count(*)::int AS llaves
        FROM (SELECT count(*) n FROM ${rel} WHERE tenant_id = $1 GROUP BY ${llave}) z`, [t.id])).rows[0];
    if (!r.llaves) { ND(`${rel} no tiene filas para este tenant`); continue; }
    A(r.dups === 0,
      `${rel}: ${r.llaves.toLocaleString('es-MX')} llaves, máx ${r.maxn} fila(s) por llave — el LEFT JOIN no multiplica`);
  }

  // ── 2) PRUEBA NEGATIVA: duplicar SÍ mueve el conteo ────────────────────────────────────────
  //
  // Sin esto, el bloque 1 sería decoración: habría que creerle que "1:1 importa". Acá se arma
  // una maqueta mínima en TEMP —una política, un producto, y una relación decorativa con DOS
  // filas para la misma llave— y se comprueba que el conteo pasa de 1 a 2.
  console.log('\n2) prueba negativa — romper el invariante a propósito');
  await c.query('BEGIN');
  try {
    await c.query(`CREATE TEMP TABLE _pol(pid int) ON COMMIT DROP`);
    await c.query(`CREATE TEMP TABLE _deco(pid int) ON COMMIT DROP`);
    await c.query(`INSERT INTO _pol VALUES (1)`);
    await c.query(`INSERT INTO _deco VALUES (1)`);
    const sano = Number((await c.query(
      `SELECT count(*)::int c FROM _pol p LEFT JOIN _deco d ON d.pid = p.pid`)).rows[0].c);
    await c.query(`INSERT INTO _deco VALUES (1)`); // la misma llave, otra vez
    const roto = Number((await c.query(
      `SELECT count(*)::int c FROM _pol p LEFT JOIN _deco d ON d.pid = p.pid`)).rows[0].c);
    A(sano === 1, `con la relación 1:1 el conteo da ${sano} (el correcto)`);
    A(roto === 2,
      `al duplicar la llave el conteo salta a ${roto} — o sea el invariante del bloque 1 es REAL, no adorno`);
  } finally { await c.query('ROLLBACK'); }

  // ── 3) Equivalencia de punta a punta, sobre las tablas reales ──────────────────────────────
  console.log('\n3) el conteo viejo (13 joins) vs el nuevo (3), contra datos reales');
  const wh = (await c.query(`
    SELECT warehouse_id::text AS id FROM commercial.reorder_policy
     WHERE tenant_id = $1 GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`, [t.id])).rows[0];

  const base = `rp.tenant_id = '${t.id}' AND pr.activo = true`;
  const casos = [
    ['default (crítico: existencia ≤ punto de reorden)', `${base} AND ${OH} <= rp.reorder_point`, ''],
    ['scope=all (sin filtro de bucket)', base, ''],
    ['bucket=agotado', `${base} AND ${OH} <= 0`, ''],
    ['un almacén + crítico', `${base} AND rp.warehouse_id = '${wh.id}' AND ${OH} <= rp.reorder_point`, ''],
    // El ÚNICO filtro que obliga al conteo a sumar una relación. Si esta línea pasara sin el
    // LEFT JOIN de abc, el conteo estaría reventando o —peor— ignorando el filtro.
    ['abc=A (suma commercial.abc_classification)',
      `${base} AND (abc.abc_class = 'A' OR rp.abc_class = 'A')`,
      `LEFT JOIN commercial.abc_classification abc
              ON abc.tenant_id = rp.tenant_id AND abc.warehouse_id = rp.warehouse_id AND abc.product_id = rp.product_id`],
  ];

  for (const [nombre, where, extra] of casos) {
    const t0 = Date.now();
    const viejo = Number((await c.query(`${conteoViejo(t.id)} WHERE ${where}`)).rows[0].c);
    const msViejo = Date.now() - t0;
    const t1 = Date.now();
    const nuevo = Number((await c.query(`${conteoNuevo(extra)} WHERE ${where}`)).rows[0].c);
    const msNuevo = Date.now() - t1;
    const veces = msNuevo > 0 ? (msViejo / msNuevo).toFixed(1) : 'n/d';
    A(viejo === nuevo,
      `${nombre}: ${viejo.toLocaleString('es-MX')} = ${nuevo.toLocaleString('es-MX')}  ·  ${msViejo} ms → ${msNuevo} ms (${veces}×)`);
  }

  // ── 4) El filtro por ABC no puede ser un no-op ─────────────────────────────────────────────
  //
  // Un conteo que ignora el filtro también "coincide" con el viejo si el viejo lo ignora igual.
  // Acá se comprueba que filtrar por ABC devuelve MENOS que no filtrar: si diera lo mismo, la
  // igualdad del caso anterior no probaría nada.
  console.log('\n4) el filtro que suma la relación extra realmente recorta');
  const todos = Number((await c.query(`${conteoNuevo()} WHERE ${base}`)).rows[0].c);
  const soloA = Number((await c.query(`${conteoNuevo(casos[4][2])} WHERE ${casos[4][1]}`)).rows[0].c);
  if (!soloA) ND('no hay productos clase A en este tenant — el filtro no se puede ejercer');
  else A(soloA < todos,
    `abc=A devuelve ${soloA.toLocaleString('es-MX')} de ${todos.toLocaleString('es-MX')} — el filtro recorta, no es no-op`);

  await c.end();
  console.log(`\n=== ${ok} ✔ · ${fail} ✖ · ${nm} NO MEDIDO ===\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
