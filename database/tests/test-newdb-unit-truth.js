/* eslint-disable no-console */
/**
 * U.4 — CANDADO de `analytics.v_unit_truth`, el resolvedor de unidad con veredicto.
 *
 * Qué vigila, y por qué cada cosa:
 *
 *  1. ⭐ QUE NO CONTRADIGA AL DIVISOR QUE YA SE PUBLICA. `box_factor` tiene que ser exactamente
 *     el de `v_warehouse_box_factor`, fila por fila. Esta vista EXPLICA el número, no lo cambia.
 *     Es lo que autoriza a migrarle los 44 consumidores sin revalidar cada pantalla.
 *  2. ⭐ QUE NO PASE EN VACÍO. Una vista que no encuentra ninguna disputa se lee igual que una
 *     que no tiene nada que encontrar. Las poblaciones se afirman contra lo medido en prod
 *     el 2026-09-05.
 *  3. ⭐ ANTI-REGRESIÓN del agujero del factor 1: `no_aplica` no puede aplicarse a una celda
 *     cuyo testigo dice que SÍ hay caja. Eran 13 SKUs / $5.1M de granel archivados como
 *     "nada que verificar", entre ellos `20555`, el SKU que destapó la auditoría de peldaño.
 *  4. QUE `medible` NO SE DESINCRONICE del veredicto. Antes eran dos predicados duplicados.
 *  5. QUE LOS DOS EJES NO SE MEZCLEN. El testigo va contra `base_per_box` (unidades base por
 *     caja), NUNCA contra `box_factor` (el divisor nativo del almacén). Confundirlos marcaba
 *     16,897 celdas de Wincaja como falsos positivos: los multipack legítimos de ADR-055.
 *  6. QUE EL TESTIGO SEA INDEPENDIENTE. Si `v_unit_truth` leyera la etiquetera para juzgar a la
 *     etiquetera, el 99.84% de concordancia sería circular y no probaría nada.
 *  7. TAXONOMÍA CERRADA: un veredicto que nadie declaró acá rompe el test a propósito.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-unit-truth.js
 */
const { Client } = require('pg');

const T = '00000000-0000-0000-0000-00000000d01c';
const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';

let ok = 0; let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};

const VEREDICTOS = ['verificado', 'no_aplica', 'sin_testigo', 'en_disputa', 'disputa_granel'];
const NATIVOS = ['nativo_es_base', 'vende_la_base', 'vende_paquete', 'no_explicado', 'sin_razon'];

(async () => {
  console.log('\n=== VERDAD DE UNIDAD (v_unit_truth) ===\n');
  const c = new Client({
    connectionString: URL,
    ssl: URL.includes('localhost') ? false : { rejectUnauthorized: false },
  });
  await c.connect();

  // ── 0. Es VISTA (derivar-no-copiar) y filtra por la RLS del invocador.
  const v = (await c.query(
    `SELECT count(*)::int n FROM pg_views
      WHERE schemaname = 'analytics' AND viewname = 'v_unit_truth'`,
  )).rows[0];
  check('v_unit_truth existe y es VISTA', v.n === 1);

  const si = (await c.query(
    `SELECT c.reloptions::text AS opts FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'analytics' AND c.relname = 'v_unit_truth'`,
  )).rows[0];
  check('tiene security_invoker (la RLS del que consulta filtra el tenant)',
    (si?.opts || '').includes('security_invoker=true'), si?.opts || 'sin reloptions');

  // ── 1. ⭐ NO CONTRADICE AL DIVISOR VIGENTE. Es el candado que habilita la migración.
  const eq = (await c.query(
    `SELECT count(*)::int pares,
            count(*) FILTER (WHERE abs(t.box_factor - w.box_factor) > 0.0001)::int discrepan,
            (SELECT count(*) FROM analytics.v_warehouse_box_factor WHERE tenant_id = $1)::int en_wbf
       FROM analytics.v_unit_truth t
       JOIN analytics.v_warehouse_box_factor w
         ON w.tenant_id = t.tenant_id AND w.warehouse_id = t.warehouse_id
        AND w.product_id = t.product_id
      WHERE t.tenant_id = $1`, [T],
  )).rows[0];
  check('box_factor == el que publica v_warehouse_box_factor, fila por fila',
    eq.discrepan === 0, `${eq.discrepan} de ${eq.pares} filas discrepan`);
  check('cubre el mismo universo que v_warehouse_box_factor',
    eq.pares === eq.en_wbf, `truth=${eq.pares} wbf=${eq.en_wbf}`);

  // ── 2. ⭐ QUE NO PASE EN VACÍO. Poblaciones medidas en prod 2026-09-05.
  const t0 = Date.now();
  const pob = (await c.query(
    `SELECT veredicto, count(*)::int celdas, count(DISTINCT product_id)::int skus,
            count(*) FILTER (WHERE medible)::int medibles,
            count(*) FILTER (WHERE base_per_box <= 1
                               AND (COALESCE(testigo_pago,0) > 1.05
                                 OR COALESCE(testigo_erp,0)  > 1.05))::int uno_con_testigo
       FROM analytics.v_unit_truth WHERE tenant_id = $1 GROUP BY 1`, [T],
  )).rows;
  const ms = Date.now() - t0;
  const by = Object.fromEntries(pob.map((r) => [r.veredicto, r]));
  const n = (k) => (by[k]?.celdas ?? 0);
  console.log(`  poblaciones (${ms} ms): ${pob.map((r) => `${r.veredicto}=${r.celdas}`).join(' · ')}\n`);

  check('hay celdas VERIFICADAS por un testigo independiente', n('verificado') > 50000,
    `verificado=${n('verificado')} — si cae, el testigo dejó de llegar`);
  check('hay celdas SIN testigo (no todo el catálogo se puede probar)', n('sin_testigo') > 0);
  check('hay celdas EN DISPUTA (si da 0, el detector está pasando en vacío)',
    n('en_disputa') > 0);
  check('hay disputa de GRANEL, separada de la mecánica', n('disputa_granel') > 0);
  check('la mayoría NO está en disputa (si todo fuera anomalía, nada lo sería)',
    n('en_disputa') + n('disputa_granel') < 0.05 * (eq.pares || 1),
    `${n('en_disputa') + n('disputa_granel')} de ${eq.pares}`);

  // ── 3. ⭐ ANTI-REGRESIÓN del agujero del factor 1.
  // Medido antes del fix: 13 SKUs / $5,135,134 con base_per_box = 1 y DOS testigos coincidiendo
  // en 18 / 12 / 5 / 10 / 20 / 24 / 25 / 27 / 40, archivados como `no_aplica`.
  check('`no_aplica` NUNCA se aplica a una celda cuyo testigo ve caja',
    (by.no_aplica?.uno_con_testigo ?? 0) === 0,
    `${by.no_aplica?.uno_con_testigo} celdas — es el bug del factor 1 de 2026-09-05`);

  const uno = (await c.query(
    `SELECT count(DISTINCT product_id)::int skus, count(*)::int celdas
       FROM analytics.v_unit_truth
      WHERE tenant_id = $1 AND base_per_box <= 1
        AND (COALESCE(testigo_pago,0) > 1.05 OR COALESCE(testigo_erp,0) > 1.05)`, [T],
  )).rows[0];
  check('los SKUs que declaran "sin caja" contra el testigo SIGUEN visibles',
    uno.skus > 0, 'si da 0, o se corrigieron o el testigo desapareció — hay que mirarlo');

  // ── 4. `medible` se DERIVA del veredicto, no lo duplica.
  const md = (await c.query(
    `SELECT count(*) FILTER (WHERE medible <> (veredicto IN ('verificado','no_aplica')))::int desync,
            count(*) FILTER (WHERE medible AND veredicto IN ('en_disputa','disputa_granel','sin_testigo'))::int fugas
       FROM analytics.v_unit_truth WHERE tenant_id = $1`, [T],
  )).rows[0];
  check('`medible` coincide con el veredicto en el 100% de las filas', md.desync === 0,
    `${md.desync} filas desincronizadas`);
  check('ninguna celda en disputa o sin testigo se declara medible', md.fugas === 0);

  // ── 5. ⭐ LOS DOS EJES NO SE MEZCLAN. El testigo juzga base_per_box, no el divisor nativo.
  // Sin esto, los 1,085 multipack legítimos de Wincaja (ADR-055) saldrían marcados.
  const mp = (await c.query(
    `SELECT count(*)::int multipack,
            count(*) FILTER (WHERE veredicto IN ('en_disputa','disputa_granel'))::int marcados
       FROM analytics.v_unit_truth
      WHERE tenant_id = $1 AND veredicto_nativo = 'vende_paquete'`, [T],
  )).rows[0];
  check('los multipack de Wincaja existen y NO se marcan por vender en paquete',
    mp.multipack > 500 && mp.marcados === 0,
    `multipack=${mp.multipack} marcados=${mp.marcados}`);

  const nat = (await c.query(
    `SELECT veredicto_nativo, count(*)::int celdas
       FROM analytics.v_unit_truth WHERE tenant_id = $1 GROUP BY 1`, [T],
  )).rows;
  const byN = Object.fromEntries(nat.map((r) => [r.veredicto_nativo, r.celdas]));
  check('ADR-055 se sostiene: el nativo se explica por la escalera en > 99% de Wincaja',
    (byN.vende_la_base + byN.vende_paquete)
      / ((byN.vende_la_base + byN.vende_paquete + (byN.no_explicado || 0)) || 1) > 0.99,
    JSON.stringify(byN));
  check('quedan celdas `no_explicado` a la vista (el defecto vivo de ADR-055, 45 SKUs)',
    (byN.no_explicado || 0) > 0);

  // ── 6. ⭐ EL TESTIGO ES INDEPENDIENTE, verificado sobre la DEFINICIÓN.
  // Si la vista leyera la etiquetera para juzgar a la etiquetera, la concordancia sería circular.
  const def = (await c.query(
    `SELECT pg_get_viewdef('analytics.v_unit_truth'::regclass, true) AS d`,
  )).rows[0].d;
  check('el testigo sale de v_supplier_cost_ladder (lo PAGADO al proveedor)',
    def.includes('v_supplier_cost_ladder'));
  check('NO lee product_label_prices directo (juzgar la etiquetera con la etiquetera es circular)',
    !def.includes('product_label_prices'));
  check('NO lee catalog.products.factor_sale directo (la fuente sin unidad)',
    !def.includes('factor_sale'));

  // ── 7. TAXONOMÍA CERRADA.
  const tax = (await c.query(
    `SELECT array_agg(DISTINCT veredicto) v, array_agg(DISTINCT veredicto_nativo) vn
       FROM analytics.v_unit_truth WHERE tenant_id = $1`, [T],
  )).rows[0];
  check('todo `veredicto` está en la taxonomía declarada',
    (tax.v || []).every((x) => VEREDICTOS.includes(x)), (tax.v || []).join(','));
  check('todo `veredicto_nativo` está en la taxonomía declarada',
    (tax.vn || []).every((x) => NATIVOS.includes(x)), (tax.vn || []).join(','));

  // ── 8. La cobertura se PUBLICA, no se asume. Medido: 93.1% de la venta 365d verificada.
  const cob = (await c.query(
    `WITH s AS (SELECT product_id, sum(revenue)::numeric rev FROM analytics.sales_daily
                 WHERE tenant_id = $1 AND sale_date >= current_date - 365 GROUP BY 1),
     u AS (SELECT DISTINCT product_id, medible FROM analytics.v_unit_truth WHERE tenant_id = $1)
     SELECT round(100 * sum(s.rev) FILTER (WHERE u.medible) / NULLIF(sum(s.rev),0), 1) pct_medible,
            round(sum(s.rev) FILTER (WHERE NOT COALESCE(u.medible, true)))::numeric venta_no_medible
       FROM s LEFT JOIN u ON u.product_id = s.product_id`, [T],
  )).rows[0];
  console.log(`\n  cobertura: ${cob.pct_medible}% de la venta 365d es medible · `
    + `$${Number(cob.venta_no_medible).toLocaleString('es-MX')} no lo es`);
  check('la cobertura medible supera el 85% de la venta', Number(cob.pct_medible) > 85,
    `${cob.pct_medible}%`);
  check('queda venta NO medible declarada (si diera 0, nadie estaría mirando)',
    Number(cob.venta_no_medible) > 0);

  // ── 9. Perf. Se mide, no se estima.
  check('la agregación completa cuesta < 8,000 ms', ms < 8000, `${ms} ms`);

  console.log(`\n=== ${ok} OK · ${fail} FAIL ===\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
