/* eslint-disable no-console */
/**
 * P.0 — CANDADO DE PARIDAD: lo que entregamos tiene que ser lo que entrega Kepler.
 *
 * Pedido de Edgar: *"enfoquemos que kepler queda idéntico, no haya diferencia entre lo que entrega
 * Kepler y lo que entregamos nosotros."*
 *
 * Compara `analytics.sales_daily` contra la suma CRUDA de los renglones de Kepler (`kepler_ods.kdm2`)
 * por (SKU, sucursal, fecha), y parte el delta por CAUSA. No es un reporte: es la compuerta de la
 * Fase P y el antes/después que la regla del proyecto exige antes de mover un número.
 *
 * ── Tres trampas que ya produjeron una medición falsa en esta misma fase ───────────────────
 *
 *  1. ⭐ **Aislar los canales de Kepler.** Los almacenes `01/02/04/05/06` también contienen venta
 *     HISTÓRICA de Wincaja remapeada (`services/feeds-ingest/sales-daily-projection.js:75-91`
 *     mapea 10→01, 42→02, 44→04, 54→05, 50→06). Comparar esa mezcla contra Kepler infla el delta
 *     al 27% cuando el real contra el ticket es 1.6%. Filtro obligatorio: `channel NOT LIKE
 *     'wincaja_%'`.
 *  2. **Anti-réplica `btrim(c1) = sucursal`**: `kdm2` arrastra filas de OTRAS sucursales (la 03
 *     trae 112,377 renglones de la 02, $7.5M, muertos el 2026-01-07).
 *  3. **Contar los DOS lados del FULL OUTER JOIN.** La lección de U.6: una comparación que sólo
 *     mira la intersección no puede ver lo que falta. Acá lo que falta son 5,112 filas.
 *
 * ── El estado medido el 2026-09-07 (90 días, sucursales 01-06) ────────────────────────────
 *
 *     contra el TICKET (U-D-10)     cantidad 98.03%   importe 99.74%   delta $727,320
 *     contra U-D-8/10/12            cantidad 93.90%   importe 95.54%   delta $16,370,247
 *
 * Las cinco causas de la brecha, todas NUESTRAS:
 *     1  falta U-D-8  (Factura Telemarketing)          $14,151,697   mart.ventas filtra c4=10
 *     2  falta U-D-12 (Factura Cont No Fiscal)          $1,491,231
 *     3  5,112 filas que Kepler tiene y el fact no        $871,238   el SKU SÍ existe en el catálogo
 *     4  1,101 celdas multiplicadas x12                              pickPriceTier adivina el factor
 *     5  4,581 celdas divididas /2                                   conversión de 500 g a kilos
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-kepler-parity.js
 */
const { Client } = require('pg');

const T = '00000000-0000-0000-0000-00000000d01c';
const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const DIAS = Number(process.env.PARITY_DAYS || 90);

let ok = 0; let fail = 0; let skip = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const nomedido = (label, why) => { skip++; console.log(`  ○ NO MEDIDO — ${label}: ${why}`); };
const N = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const money = (n) => `$${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const pct = (a, b) => (b ? (100 * a / b) : 0);

/** Lo que Kepler entrega: la suma de sus propios renglones, sin tocar nada. */
const kepler = (docs) => `
  SELECT btrim(l.c8) sku, l.sucursal suc, l.c32::date d,
         sum(l.c9)  qty, sum(l.c13) imp
    FROM kepler_ods.kdm2 l
   WHERE l.c2='U' AND l.c3='D' AND btrim(l.c4::text) IN (${docs})
     AND btrim(l.c1::text) = l.sucursal::text
     AND l.c32::date > current_date - ${DIAS}
   GROUP BY 1,2,3`;

/** Lo que entregamos nosotros, SÓLO por los canales que alimenta Kepler. */
const nuestro = `
  SELECT p.sku, w.kepler_code suc, s.sale_date d,
         sum(s.units) qty, sum(s.revenue) imp,
         max(s.rung_factor) rf, bool_or(s.rung_mixed) mix
    FROM analytics.sales_daily s
    JOIN catalog.products p ON p.tenant_id=s.tenant_id AND p.id=s.product_id
    JOIN commercial.warehouses w ON w.tenant_id=s.tenant_id AND w.id=s.warehouse_id
   WHERE s.tenant_id='${T}'::uuid AND s.sale_date > current_date - ${DIAS}
     AND w.kepler_code IS NOT NULL AND s.channel NOT LIKE 'wincaja_%'
   GROUP BY 1,2,3`;

(async () => {
  const c = new Client({ connectionString: URL, ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await c.connect();
  await c.query(`SET app.tenant_id = '${T}'`);
  await c.query("SET statement_timeout = '1200s'");
  console.log(`\n=== P.0 · PARIDAD con Kepler (${DIAS} días, sucursales 01-06) ===\n`);

  if (!(await c.query(`SELECT to_regclass('kepler_ods.kdm2') AS t`)).rows[0].t) {
    nomedido('kepler_ods.kdm2 no existe en este destino', 'la paridad sólo se puede medir contra el ODS');
    console.log(`\n=== ${ok} OK · ${fail} FAIL · ${skip} NO MEDIDO ===\n`);
    await c.end(); process.exit(0);
  }

  // ── 1. Contra el TICKET: es donde el fact YA debería ser idéntico ──────────────────────────
  console.log('── 1. Contra el ticket de mostrador (U-D-10) ──');
  const t = (await c.query(`
    WITH kep AS (${kepler("'10'")}), nos AS (${nuestro})
    SELECT count(*) FILTER (WHERE k.sku IS NOT NULL AND n.sku IS NOT NULL)::int ambos,
           count(*) FILTER (WHERE k.sku IS NOT NULL AND n.sku IS NOT NULL AND abs(n.qty-k.qty)<=0.01)::int qty_ok,
           count(*) FILTER (WHERE k.sku IS NOT NULL AND n.sku IS NOT NULL AND abs(n.imp-k.imp)<=0.05)::int imp_ok,
           round(sum(k.imp)::numeric,0) imp_kep, round(sum(n.imp)::numeric,0) imp_nos,
           count(*) FILTER (WHERE n.sku IS NULL)::int solo_kep,
           round(sum(k.imp) FILTER (WHERE n.sku IS NULL)::numeric,0) imp_solo_kep,
           count(*) FILTER (WHERE k.sku IS NULL)::int solo_nos,
           round(sum(n.imp) FILTER (WHERE k.sku IS NULL)::numeric,0) imp_solo_nos
      FROM kep k FULL OUTER JOIN nos n ON n.sku=k.sku AND n.suc=k.suc AND n.d=k.d`)).rows[0];
  const qP = pct(t.qty_ok, t.ambos); const iP = pct(t.imp_ok, t.ambos);
  console.log(`     celdas en ambos: ${N(t.ambos)}`);
  console.log(`     CANTIDAD idéntica: ${N(t.qty_ok)} (${qP.toFixed(2)}%)`);
  console.log(`     IMPORTE  idéntico: ${N(t.imp_ok)} (${iP.toFixed(2)}%)`);
  console.log(`     totales: Kepler ${money(t.imp_kep)}  ·  nosotros ${money(t.imp_nos)}  ·  delta ${money(Number(t.imp_kep) - Number(t.imp_nos))}`);
  check('la CANTIDAD del ticket coincide con Kepler (≥ 98%)', qP >= 98, `${qP.toFixed(2)}%`);
  check('el IMPORTE del ticket coincide con Kepler (≥ 99.7%)', iP >= 99.7, `${iP.toFixed(2)}%`);

  // ── 2. Los dos lados: lo que falta y lo que sobra ⭐ ───────────────────────────────────────
  console.log('\n── 2. Los DOS lados (una comparación que sólo mira la intersección no ve lo que falta) ──');
  console.log(`     sólo en Kepler:  ${N(t.solo_kep)} celdas ${money(t.imp_solo_kep)}`);
  console.log(`     sólo nuestras:   ${N(t.solo_nos)} celdas ${money(t.imp_solo_nos)}`);
  check('⭐ no publicamos venta que Kepler NO tiene (≤ 500 celdas)', t.solo_nos <= 500,
    `${N(t.solo_nos)} celdas ${money(t.imp_solo_nos)}`);
  check('la venta que Kepler tiene y nosotros no, no crece (≤ 6,000 celdas — hoy 5,112)',
    t.solo_kep <= 6000, `${N(t.solo_kep)} celdas ${money(t.imp_solo_kep)}`);

  // ── 3. La brecha por CAUSA — es lo que convierte esto en instrumento ──────────────────────
  console.log('\n── 3. La CANTIDAD que difiere, partida por causa ──');
  for (const r of (await c.query(`
    WITH kep AS (${kepler("'10'")}), nos AS (${nuestro})
    SELECT CASE WHEN abs(n.qty-k.qty)<=0.01 THEN 'IDÉNTICA'
                WHEN COALESCE(n.rf,1) > 1   THEN 'el importer MULTIPLICÓ (rung_factor>1)'
                WHEN n.mix                  THEN 'peldaño mezclado'
                WHEN n.qty < k.qty          THEN 'convertimos a una unidad MAYOR (p.ej. 500 g -> kg)'
                ELSE                             'otra' END causa,
           count(*)::int celdas,
           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY n.qty/NULLIF(k.qty,0))::numeric,3) razon
      FROM kep k JOIN nos n ON n.sku=k.sku AND n.suc=k.suc AND n.d=k.d
     GROUP BY 1 ORDER BY celdas DESC`)).rows) {
    console.log(`     ${String(r.causa).padEnd(46)} ${N(r.celdas).padStart(7)} celdas · razón nuestra/Kepler ${r.razon}`);
  }

  // ── 4. La cobertura de doctypes: la causa del 96% de la brecha ⭐ ──────────────────────────
  // `mart.ventas` (la fuente del fact) filtra `h.c4=10`, así que la Factura Telemarketing y la no
  // fiscal NO llegan al fact — pero SÍ están en `mv_kepler_sales_daily`, que usa 8/10/12. Las dos
  // superficies se contradicen entre sí. Este bloque mide esa contradicción.
  console.log('\n── 4. ⭐ Los doctypes de venta que el fact NO cuenta ──');
  const faltan = (await c.query(`
    SELECT btrim(l.c4::text) doc, count(*)::int renglones, round(sum(l.c13)::numeric,0) imp
      FROM kepler_ods.kdm2 l
     WHERE l.c2='U' AND l.c3='D' AND btrim(l.c1::text)=l.sucursal::text
       AND l.c32::date > current_date - ${DIAS} AND btrim(l.c4::text) IN ('8','12')
     GROUP BY 1 ORDER BY imp DESC`)).rows;
  let totalFalta = 0;
  for (const r of faltan) {
    totalFalta += Number(r.imp);
    console.log(`     U-D-${String(r.doc).padEnd(3)} ${N(r.renglones).padStart(7)} renglones · ${money(r.imp)}`);
  }
  console.log(`     TOTAL fuera del fact: ${money(totalFalta)}`);
  check('⛔ la brecha de cobertura sigue medida y NO se está ignorando (P.2 pendiente)',
    totalFalta > 0, 'si da 0, o ya entró o el corte cambió — revisar antes de cantar victoria');

  // ── 5. Lo que este candado NO mide, declarado ─────────────────────────────────────────────
  console.log('\n── 5. Lo que este candado no mide ──');
  console.log('     ⚠️  Sólo las sucursales de Kepler (01-06). Wincaja no tiene un renglón crudo');
  console.log('        comparable: su unidad sale del catálogo, no de la línea.');
  console.log('     ⚠️  Sólo `sales_daily`. El sell-out lee `mv_kepler_sales_daily`, que usa OTRO');
  console.log('        corte de doctypes (8/10/12) — por eso las dos superficies difieren entre sí.');

  console.log(`\n=== ${ok} OK · ${fail} FAIL · ${skip} NO MEDIDO ===\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
