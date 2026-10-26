/**
 * `[AB.40]` LA POLÍTICA (mín/reorden/máx) USA LA MISMA DEMANDA QUE EL PEDIDO — antes/después, SÓLO LECTURA.
 *
 * Toma de los importers el texto EXACTO de lo que calculan (`CALC` de import-computed-reorder.js y
 * `CALC_RED` + `calc` de import-network-reorder.js), lo ejecuta en una transacción de sólo lectura y lo
 * compara, por almacén, contra `commercial.reorder_policy` vigente:
 *   · cuánto se mueve el máximo;
 *   · el máximo medido en DÍAS de la demanda del pedido (la regla: lead 7 + ciclo 14 + seguridad);
 *   · cuántos productos quedan con existencia ≤ reorden (lo que entra a Autoabasto), antes y después.
 * Comprobaciones:
 *   1. Ningún almacén empeora: con la política nueva hay MENOS productos cuyo máximo no alcanza ni para
 *      14 días de la demanda del pedido (no cubre entrega + ciclo) — el defecto que se corrige: hoy 1 de
 *      cada 5 políticas usa menos de la mitad de la demanda. CONTROL: con la vigente, hay cortos.
 *      (El máximo en días NO tiene un rango «correcto»: depende de la seguridad por clase y de la
 *      variabilidad; por eso se mide la cola de los cortos, no la mediana.)
 *   2. Mr Beast 97245 en Padre Hidalgo: el máximo nuevo alcanza para 21+ días de su demanda (hoy 7.5).
 * Sin datos: NO MEDIDO, nunca ✔.
 *
 * Uso: node database/tests/test-newdb-politica-misma-demanda.js
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }

const T = '00000000-0000-0000-0000-00000000d01c';
const K = path.join(__dirname, '..', 'importers', 'kepler');
let pass = 0, fail = 0, nm = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, extra !== undefined ? JSON.stringify(extra) : ''); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };

/** Inversa de la normal (Acklam, tramo central), la misma de los importers, para los mismos Z. */
function invNorm(p) {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
const archivo = (n) => fs.readFileSync(path.join(K, n), 'utf8');
const constante = (s, nombre) => {
  const m = s.match(new RegExp(`const ${nombre} = \`([\\s\\S]*?)\`;`));
  if (!m) throw new Error(`no encontré ${nombre}`);
  return m[1];
};

/** Lo que se compara por almacén, sobre una CTE `nueva(warehouse_id, product_id, min_stock, reorder_point, max_stock)`. */
const COMPARA = (t) => `
  , cmp AS (
    SELECT w.code, n.min_stock, n.reorder_point, n.max_stock,
           pol.reorder_point::numeric reo_v, pol.max_stock::numeric max_v, rp.stock_pz::numeric oh, rp.daily_pieces::numeric dp
      FROM nueva n
      JOIN commercial.warehouses w ON w.id = n.warehouse_id
      LEFT JOIN commercial.reorder_policy pol ON pol.tenant_id = ${t} AND pol.warehouse_id = n.warehouse_id AND pol.product_id = n.product_id
      LEFT JOIN analytics.replenishment_plan rp ON rp.tenant_id = ${t} AND rp.warehouse_id = n.warehouse_id AND rp.product_id = n.product_id
  )
  SELECT COALESCE(code, 'RED') code, count(*)::int n,
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY max_stock / NULLIF(max_v, 0))::numeric, 2) max_nuevo_entre_viejo,
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY max_v / NULLIF(dp, 0))::numeric, 1) dias_max_antes,
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY max_stock / NULLIF(dp, 0))::numeric, 1) dias_max_despues,
         count(*) FILTER (WHERE oh <= reo_v)::int entra_antes,
         count(*) FILTER (WHERE oh <= reorder_point)::int entra_despues,
         count(*) FILTER (WHERE dp > 0 AND max_v / dp < 14)::int corto_antes,
         count(*) FILTER (WHERE dp > 0 AND max_stock / dp < 14)::int corto_despues,
         count(*) FILTER (WHERE dp > 0 AND max_v / dp > 90)::int largo_antes,
         count(*) FILTER (WHERE dp > 0 AND max_stock / dp > 90)::int largo_despues
    FROM cmp GROUP BY ROLLUP(code) ORDER BY code`;

(async () => {
  const comp = archivo('import-computed-reorder.js');
  const red = archivo('import-network-reorder.js');
  const CALC = constante(comp, 'CALC');
  const CALC_RED = constante(red, 'CALC_RED');
  const calcRed = red.match(/WITH RECURSIVE \$\{CALC_RED\}, (calc AS \([\s\S]*?\r?\n\s*\))\s*\r?\n\s*INSERT INTO/);
  if (!calcRed) throw new Error('no encontré el calc de import-network-reorder.js');

  const sucursales = `WITH ${CALC} ${COMPARA('$1')}`;
  // El cálculo del INSERT de la red (min/reorden/máx), con los MISMOS parámetros $1..$5 del importer.
  const matrices = `WITH RECURSIVE ${CALC_RED}, ${calcRed[1]}, nueva AS (
      SELECT cedis_id AS warehouse_id, product_id, $3::numeric AS service_level,
             ceil($5 * net_sigma * sqrt(lead)) AS min_stock,
             ceil(net_mean * lead) + ceil($5 * net_sigma * sqrt(lead)) AS reorder_point,
             ceil(net_mean * lead) + ceil($5 * net_sigma * sqrt(lead)) + ceil(net_mean * $4) AS max_stock
        FROM calc) ${COMPARA('$1')}`;

  const c = new Client({ connectionString: process.env.DATABASE_URL_NEW });
  await c.connect();
  try {
    await c.query('BEGIN READ ONLY');
    await c.query('SET LOCAL statement_timeout = 900000');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [T]);
    console.log('  base', (await c.query('SELECT system_identifier::text s FROM pg_control_system()')).rows[0].s);
    const s = (await c.query(sucursales, [T, 7, 0.98, 0.95, 0.90, invNorm(0.98), invNorm(0.95), invNorm(0.90), 2, 14])).rows;
    const m = (await c.query(matrices, [T, 7, 0.98, 14, invNorm(0.98)])).rows;
    if (!s.length && !m.length) { noMedido('la base no tiene demanda con qué calcular'); return; }
    console.log('\n  Sucursales (import-computed-reorder):'); console.table(s);
    console.log('  Puntos de abasto (import-network-reorder):'); console.table(m);

    console.log('\n  1 · menos máximos que no alcanzan ni para 14 días de la demanda del pedido');
    // El CEDIS (00) no vende: su demanda en el plan es 0 y «días» no se puede medir ahí.
    for (const r of [...s, ...m].filter((x) => x.code !== 'RED' && x.code !== '00' && x.n >= 20)) {
      ok(r.corto_despues <= r.corto_antes,
        `${r.code}: cortos ${r.corto_antes} → ${r.corto_despues} · largos (>90 d) ${r.largo_antes} → ${r.largo_despues}`);
    }
    const cortos = [...s, ...m].filter((x) => x.code !== 'RED').reduce((t, x) => t + x.corto_antes, 0);
    ok(cortos > 0, `CONTROL: con la política vigente hay ${cortos} máximos que no alcanzan ni para 14 días`);

    console.log('\n  2 · Mr Beast 97245 en Padre Hidalgo');
    const mb = (await c.query(`WITH RECURSIVE ${CALC_RED}, ${calcRed[1]}
      SELECT $3::numeric AS service_level, c.net_mean, ceil(c.net_mean * c.lead) + ceil($5 * c.net_sigma * sqrt(c.lead)) + ceil(c.net_mean * $4) AS max_n,
             (SELECT max_stock FROM commercial.reorder_policy WHERE warehouse_id = c.cedis_id AND product_id = c.product_id) max_v
        FROM calc c JOIN commercial.warehouses w ON w.id = c.cedis_id AND w.code = '01'
        JOIN catalog.products p ON p.id = c.product_id AND p.sku = '97245'`, [T, 7, 0.98, 14, invNorm(0.98)])).rows[0];
    if (!mb) noMedido('Mr Beast no tiene demanda de red en Padre Hidalgo en esta base');
    else ok(Number(mb.max_n) / Number(mb.net_mean) >= 21,
      `máximo ${Math.round(mb.max_n)} pz = ${(mb.max_n / mb.net_mean).toFixed(1)} días de ${Math.round(mb.net_mean)} pz/día (vigente: ${mb.max_v} pz)`);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
})().catch((e) => { fail++; console.log('  ✗ error:', e.message); })
  .finally(() => { console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`); process.exit(fail ? 1 : (pass ? 0 : 2)); });
