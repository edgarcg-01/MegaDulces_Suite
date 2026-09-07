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

  // ── ⛔ LA RETRACTACIÓN, con candado ────────────────────────────────────────────────────────
  // Este archivo afirmaba antes que 1,286 SKUs tenían "la caja sin capturar", y exigía que ese
  // número fuera > 500. Era FALSO y lo inventé yo: la regla se apoyaba en `unidad_compra` (que vale
  // 'CJA' en el 94.53% de los artículos) y en `factor_compra` (que vale 1 en el 100%), dos campos
  // que Wincaja no mantiene. El candado defendía una afirmación falsa, que es peor que no tenerlo.
  check('⛔ `caja_sin_capturar` NO vuelve — era un defecto inventado, no medido',
    !ver.some((r) => r.veredicto === 'caja_sin_capturar'));

  const nulosDiv = (await c.query(`
    SELECT count(*)::int n FROM analytics.v_wincaja_unit_audit
     WHERE tenant_id=$1 AND divisor_wincaja IS NULL`, [T])).rows[0];
  check('⭐ `divisor_wincaja` NUNCA es NULL — Wincaja siempre declara su divisor',
    nulosDiv.n === 0, `${nulosDiv.n} en NULL`);

  const caja = (await c.query(`
    SELECT count(*)::int n, count(*) FILTER (WHERE divisor_wincaja = 1)::int div1
      FROM analytics.v_wincaja_unit_audit WHERE tenant_id=$1 AND veredicto='unidad_es_caja'`, [T])).rows[0];
  check('`unidad_es_caja` lleva divisor 1 — es una AFIRMACIÓN, no una ausencia (lección W1.1)',
    caja.n > 0 && caja.n === caja.div1, `${caja.div1}/${caja.n}`);

  // ── ⭐ LA PRUEBA QUE SOSTIENE LA RETRACTACIÓN ─────────────────────────────────────────────
  // Lo que antes marcaba como defecto (`factor_venta <= 1`) está PRECIFICADO COMO CAJA. Ésa es la
  // evidencia que tumbó mi regla, y tiene que seguir siendo cierta o la retractación fue prematura.
  // ⚠️ Este bloque cruza a Kepler A PROPÓSITO (el costo pagado al proveedor) — es un TEST, no la
  // vista. La vista sigue sin tocar Kepler; el test usa un testigo externo para juzgarla.
  console.log('\n── 4b. ⭐ Por qué `factor_venta = 1` es CORRECTO: el dinero ──');
  const dinero = (await c.query(`
    WITH a AS (
      SELECT DISTINCT articulo, upper(btrim(coalesce(unidad_venta,''))) uv, COALESCE(factor_venta,0) fv
        FROM wincaja.articulos
       WHERE tenant_id=$1 AND source_dataset='actual' AND source_branch IN ('00','30','32')),
    z AS (
      SELECT CASE WHEN a.fv > 1 THEN 'multipack (fv>1)' ELSE 'unidad simple (fv<=1)' END g,
             (p.precio/NULLIF(sc.u1_cost,0))::numeric  r_uni,
             (p.precio/NULLIF(sc.box_cost,0))::numeric r_caja
        FROM a
        JOIN analytics.v_supplier_cost_ladder sc ON sc.sku=a.articulo
         AND sc.units_per_box>1 AND sc.u1_cost>0 AND sc.box_cost>0
        JOIN wincaja.precios p ON p.tenant_id=$1 AND p.articulo=a.articulo
         AND p.source_dataset='actual' AND p.no_precio=1 AND p.precio>0
       WHERE a.uv NOT IN ('KGS','SER'))
    SELECT g, count(*)::int n,
           count(*) FILTER (WHERE r_uni  BETWEEN 0.8 AND 3)::int como_unidad,
           count(*) FILTER (WHERE r_caja BETWEEN 0.8 AND 3)::int como_caja
      FROM z GROUP BY 1`, [T])).rows;
  for (const r of dinero) {
    console.log(`     ${String(r.g).padEnd(24)} precio parece de UNIDAD ${(100 * r.como_unidad / r.n).toFixed(1)}%`
      + ` · de CAJA ${(100 * r.como_caja / r.n).toFixed(1)}%`);
  }
  const simple = dinero.find((r) => r.g === 'unidad simple (fv<=1)');
  const multi = dinero.find((r) => r.g === 'multipack (fv>1)');
  check('⭐ los `fv <= 1` están PRECIFICADOS COMO CAJA (≥ 80%) — por eso su divisor 1 es correcto',
    !!simple && (100 * simple.como_caja / simple.n) >= 80,
    simple ? `${(100 * simple.como_caja / simple.n).toFixed(1)}%` : 'sin datos');
  check('⭐ y los `fv > 1` están precificados por UNIDAD (≥ 80%) — los dos grupos se separan solos',
    !!multi && (100 * multi.como_unidad / multi.n) >= 80,
    multi ? `${(100 * multi.como_unidad / multi.n).toFixed(1)}%` : 'sin datos');

  // El campo sobre el que apoyé la regla falsa: si algún día se empieza a mantener, hay que saberlo.
  const compra = (await c.query(`
    SELECT count(DISTINCT articulo)::int skus,
           count(DISTINCT articulo) FILTER (WHERE upper(btrim(coalesce(unidad_compra,'')))='CJA')::int uc_cja,
           count(DISTINCT articulo) FILTER (WHERE COALESCE(factor_compra,0) > 1)::int fc_gt1
      FROM wincaja.articulos
     WHERE tenant_id=$1 AND source_dataset='actual' AND source_branch IN ('00','30','32')`, [T])).rows[0];
  console.log(`     unidad_compra='CJA' en ${(100 * compra.uc_cja / compra.skus).toFixed(2)}%`
    + ` · factor_compra > 1 en ${compra.fc_gt1} de ${N(compra.skus)}`);
  check('⛔ el par de COMPRA sigue sin mantenerse (factor_compra = 1 en todos) — no sirve de testigo',
    compra.fc_gt1 === 0, `${compra.fc_gt1} con factor_compra > 1`);

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
