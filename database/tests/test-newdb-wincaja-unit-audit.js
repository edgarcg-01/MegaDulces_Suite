/* eslint-disable no-console */
/**
 * U.10.1 — CANDADO: Wincaja se audita con la vara de Wincaja.
 *
 * Nace del pedido de Edgar: *"wincaja usa sus unidades en sus sucursales, y kepler en sus
 * sucursales. ninguno debería tener unidades incorrectas."*
 *
 * Lo que este archivo protege:
 *
 *  1. **Que la auditoría NO consulte Kepler.** Es lo único que la hace valer: los tres chequeos
 *     de unidad de Wincaja que existían antes usaban `box_cost`, `c84`/`c81` o `cost_with_tax`
 *     — los tres de Kepler. Juzgar un ERP con la vara del otro es lo que fabrica la categoría
 *     "por convertir".
 *  2. **Que Wincaja siga siendo internamente inequívoco.** Un artículo, una unidad. Si eso deja
 *     de ser cierto, toda la fase se apoya en una premisa falsa y hay que enterarse acá.
 *  3. **Que el detector no pase en vacío ni se rellene.** `caja_sin_capturar` tiene que existir
 *     (se midieron 1,286 SKUs) y viajar con `divisor_wincaja` NULL, nunca con un 1 de relleno.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-wincaja-unit-audit.js
 */
const { Client } = require('pg');

const T = '00000000-0000-0000-0000-00000000d01c';
const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';

let ok = 0; let fail = 0; let skip = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const nomedido = (label, why) => { skip++; console.log(`  ○ NO MEDIDO — ${label}: ${why}`); };
const N = (n) => Number(n || 0).toLocaleString('en-US');
const money = (n) => `$${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

(async () => {
  const c = new Client({ connectionString: URL, ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await c.connect();
  await c.query(`SET app.tenant_id = '${T}'`);
  await c.query("SET statement_timeout = '600s'");
  console.log('\n=== U.10.1 · Wincaja auditada con la vara de Wincaja ===\n');

  const rel = (await c.query(
    `SELECT relkind FROM pg_class WHERE oid = to_regclass('analytics.v_wincaja_unit_audit')`)).rows[0];
  if (!rel) {
    nomedido('la vista no existe en este destino', 'corré la mig 20260907260000');
    console.log(`\n=== ${ok} OK · ${fail} FAIL · ${skip} NO MEDIDO ===\n`);
    await c.end(); process.exit(fail ? 1 : 0);
  }

  console.log('── 1. La forma ──');
  check('es VISTA, no tabla copiada', rel.relkind === 'v', `relkind=${rel.relkind}`);
  const inv = (await c.query(`SELECT reloptions FROM pg_class
     WHERE oid = to_regclass('analytics.v_wincaja_unit_audit')`)).rows[0];
  check('conserva security_invoker',
    (inv.reloptions || []).some((o) => /security_invoker\s*=\s*true/i.test(o)));
  check('app_runtime puede leerla',
    (await c.query(`SELECT has_table_privilege('app_runtime','analytics.v_wincaja_unit_audit','SELECT') g`)).rows[0].g);

  // ── 2. ⭐ LA aserción del archivo: la vara es de Wincaja ────────────────────────────────────
  console.log('\n── 2. ⭐ La vara es de Wincaja, no de Kepler ──');
  const def = (await c.query(
    `SELECT pg_get_viewdef(to_regclass('analytics.v_wincaja_unit_audit'), true) AS d`)).rows[0].d;
  check('lee wincaja.articulos (la declaración de Wincaja sobre sí misma)', /wincaja\.articulos/i.test(def));
  for (const ajeno of ['kepler_ods', 'v_product_box_factor', 'v_product_unit_ladder',
    'v_supplier_cost_ladder', 'v_warehouse_box_factor', 'product_label_prices',
    'replenishment_plan', 'cost_with_tax', 'factor_sale']) {
    check(`⛔ NO consulta ${ajeno} — juzgar a Wincaja con la vara de Kepler es lo que fabrica el "por convertir"`,
      !new RegExp(ajeno, 'i').test(def));
  }
  check('⛔ excluye los almacenes que hoy son de Kepler (Canindo conserva la rama 50)',
    /kepler_code\s+IS\s+NULL/i.test(def));
  check('⛔ sólo el dataset vivo (`actual`), no el histórico `concentrada`',
    /source_dataset\s*=\s*'actual'/i.test(def));

  // ── 3. La premisa: Wincaja es internamente inequívoco ──────────────────────────────────────
  console.log('\n── 3. La premisa de la fase: Wincaja no tiene ambigüedad de unidad ──');
  const amb = (await c.query(`
    SELECT count(*)::int articulos, count(*) FILTER (WHERE n > 1)::int con_varias FROM (
      SELECT source_branch, articulo, count(DISTINCT upper(btrim(coalesce(unidad_venta,''))))::int n
        FROM wincaja.articulos
       WHERE tenant_id=$1 AND source_dataset='actual' AND source_branch IN ('00','30','32')
       GROUP BY 1,2) z`, [T])).rows[0];
  console.log(`     ${N(amb.articulos)} (rama, artículo) · con más de una unidad: ${amb.con_varias}`);
  check('⭐ cada artículo tiene UNA sola unidad de venta', amb.con_varias === 0, `${amb.con_varias} con varias`);

  const entre = (await c.query(`
    SELECT count(*)::int skus, count(*) FILTER (WHERE n > 1)::int discrepan FROM (
      SELECT articulo, count(DISTINCT upper(btrim(coalesce(unidad_venta,''))))::int n
        FROM wincaja.articulos
       WHERE tenant_id=$1 AND source_dataset='actual' AND source_branch IN ('00','30','32')
       GROUP BY 1) z`, [T])).rows[0];
  check('⭐ el mismo SKU tiene la misma unidad en las 3 ramas vivas',
    entre.discrepan === 0, `${entre.discrepan} de ${N(entre.skus)} discrepan`);

  const fac = (await c.query(`
    SELECT count(*)::int skus, count(*) FILTER (WHERE n > 1)::int discrepan FROM (
      SELECT articulo, count(DISTINCT factor_venta)::int n
        FROM wincaja.articulos
       WHERE tenant_id=$1 AND source_dataset='actual' AND source_branch IN ('00','30','32')
         AND factor_venta IS NOT NULL
       GROUP BY 1) z`, [T])).rows[0];
  const pctFac = 100 * (fac.skus - fac.discrepan) / fac.skus;
  console.log(`     factor_venta consistente entre ramas: ${N(fac.skus - fac.discrepan)}/${N(fac.skus)} = ${pctFac.toFixed(2)}%`);
  check('el factor_venta es consistente entre ramas (≥ 99%)', pctFac >= 99, `${pctFac.toFixed(2)}%`);

  // ── 4. El veredicto: particiona, no se rellena, y no pasa en vacío ─────────────────────────
  console.log('\n── 4. El veredicto ──');
  const ver = (await c.query(`
    SELECT veredicto, count(DISTINCT sku)::int skus, count(*)::int celdas,
           count(*) FILTER (WHERE existencia > 0)::int con_exist,
           round(sum(valor) FILTER (WHERE existencia > 0)::numeric, 0) valor
      FROM analytics.v_wincaja_unit_audit WHERE tenant_id=$1
     GROUP BY 1 ORDER BY skus DESC`, [T])).rows;
  for (const r of ver) {
    console.log(`     ${String(r.veredicto).padEnd(20)} skus=${N(r.skus).padStart(6)}`
      + ` conExist=${N(r.con_exist).padStart(5)} valor=${money(r.valor)}`);
  }
  const nulos = (await c.query(`
    SELECT count(*)::int n FROM analytics.v_wincaja_unit_audit
     WHERE tenant_id=$1 AND veredicto IS NULL`, [T])).rows[0];
  check('los veredictos PARTICIONAN (ninguna celda sin veredicto)', nulos.n === 0, `${nulos.n} sin veredicto`);

  const malo = ver.find((r) => r.veredicto === 'caja_sin_capturar');
  check('⭐ `caja_sin_capturar` EXISTE — un 0 significaría que el detector se rompió (se midieron 1,286 SKUs)',
    !!malo && malo.skus > 500, malo ? `${N(malo.skus)} SKUs` : 'ninguno');
  if (malo) {
    console.log(`     ⚠️  ${N(malo.skus)} SKUs donde Wincaja se contradice: se compran por CJA y declaran`);
    console.log(`        que en una caja cabe UNA unidad. ${N(malo.con_exist)} con existencia = ${money(malo.valor)}`);
  }

  const relleno = (await c.query(`
    SELECT count(*)::int n FROM analytics.v_wincaja_unit_audit
     WHERE tenant_id=$1 AND veredicto='caja_sin_capturar' AND divisor_wincaja IS NOT NULL`, [T])).rows[0];
  check('⛔ lo incoherente viaja con divisor NULL, jamás con un 1 de relleno (ADR-056)',
    relleno.n === 0, `${relleno.n} con divisor`);

  const caja = (await c.query(`
    SELECT count(*)::int n, count(*) FILTER (WHERE divisor_wincaja = 1)::int div1
      FROM analytics.v_wincaja_unit_audit WHERE tenant_id=$1 AND veredicto='unidad_es_caja'`, [T])).rows[0];
  check('`unidad_es_caja` lleva divisor 1 — es una AFIRMACIÓN, no una ausencia (lección W1.1)',
    caja.n > 0 && caja.n === caja.div1, `${caja.div1}/${caja.n}`);

  // ── 5. El límite estructural, declarado ⭐ ─────────────────────────────────────────────────
  // Sin esto alguien lee "Wincaja ya está auditada" y lo aplica a una pregunta que la vista no
  // puede contestar.
  console.log('\n── 5. Lo que esta auditoría NO puede decidir, y se declara ──');
  const rotulos = (await c.query(`
    SELECT upper(btrim(coalesce(unidad_venta,''))) u, count(DISTINCT articulo)::int n
      FROM wincaja.articulos
     WHERE tenant_id=$1 AND source_dataset='actual' AND source_branch IN ('00','30','32')
     GROUP BY 1 ORDER BY n DESC`, [T])).rows;
  console.log(`     rótulos de unidad en Wincaja: ${rotulos.map((r) => `${r.u || '(vacío)'} ${N(r.n)}`).join(' · ')}`);
  check('⛔ Wincaja NO tiene rótulo `PAQ` — un multipack vendido por paquete se rotula `PZA` igual que una pieza suelta, y separarlos exige f2/f3 de Kepler',
    !rotulos.some((r) => ['PAQ', 'PQT', 'CAJ'].includes(r.u)),
    `rótulos=${rotulos.map((r) => r.u).join(',')}`);

  console.log('     ⚠️  Por eso esta vista dice si el factor está CAPTURADO y es COHERENTE,');
  console.log('        no si el artículo se vende por pieza o por paquete. Eso último no es');
  console.log('        decidible dentro de Wincaja, y se declara en vez de adivinarse.');
  console.log('     ⚠️  El testigo de dinero (precios.margen_utilidad) se PROBÓ y se DESCARTÓ:');
  console.log('        cuadra en 41.8% de los sanos contra 51.9% de los defectuosos — está');
  console.log('        invertido. Es un margen objetivo, no un invariante vivo.');

  console.log(`\n=== ${ok} OK · ${fail} FAIL · ${skip} NO MEDIDO ===\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
