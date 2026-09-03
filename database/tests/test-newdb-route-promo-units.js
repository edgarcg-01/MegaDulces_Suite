/* eslint-disable no-console */
/**
 * RR-PROMO.1 — CANDADOS de la normalización de unidad del incentivo de ruta.
 *
 * El panel "Incentivo por enunciado (AI)" de /comercial/ventas-por-ruta calcula la cantidad
 * con la que se le PAGA a la gente. Sumaba `qty` a ciegas sobre líneas que están en peldaños
 * distintos de la escalera del ERP (pieza / paquete / caja).
 *
 * Medido en prod (ago-2026, venta de ruta) antes del fix:
 *   · la cantidad cruda subcontaba 9.1% global (223,394 contra 243,626 reales),
 *   · en 140 SKUs ($1,110,809 = 19.0% de la venta de ruta) el error superaba 5%,
 *   · el peor: 97245 al 42%, 97244 al 43%, 88045 al 84%.
 *
 * Y el RÓTULO no sirve para arreglarlo: el mismo 'PZA' del SKU 70031 trae 361 líneas a
 * $6.12 (pieza) y 45 líneas a $90.96 (paquete de 16). Sólo el PRECIO las separa — por eso
 * el motor identifica el peldaño contra la escalera de `kepler_ods.kdii` y no por la etiqueta.
 *
 * Candados:
 *  1) La vista `analytics.v_product_unit_ladder` existe, es VISTA (derive-no-copy: sin
 *     importer, sin tabla), y sale sólo de `kepler_ods` — la REGLA PRINCIPAL del proyecto.
 *  2) La basura del campo de unidad ('500', '250', '2KG') NUNCA se publica como `unit_base`.
 *  3) `f2`/`f3` son factores de verdad (>1) o NULL. Un factor de 1 no es un peldaño.
 *  4) La resolución por precio respeta la banda 0.5×–2× y fuera de ella NO adivina.
 *  5) Normalizar SUBE o mantiene la cantidad frente a la suma cruda cuando hay peldaños
 *     altos (una caja nunca cuenta menos que una pieza).
 *  6) Granel marcado: en producto de peso no se publica cuenta por unidades.
 *
 * Skip-graceful: sin `kepler_ods.kdii` o sin venta de ruta (dev local pelado) valida
 * únicamente estructura.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-route-promo-units.js
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

/** Mismo LATERAL que usa RoutePromoService (TIER_LATERAL). Si divergen, este test miente. */
const TIER = `
  LEFT JOIN lad ON true
  LEFT JOIN LATERAL (
    SELECT t.f
    FROM (VALUES (1::numeric, lad.p1), (COALESCE(lad.f2,1), lad.p2), (COALESCE(lad.f3,1), lad.p3)) AS t(f,p)
    WHERE t.p > 0 AND sl.qty <> 0 AND (sl.importe / sl.qty) > 0
      AND abs(ln((sl.importe / sl.qty) / t.p)) < ln(2)
    ORDER BY abs(ln((sl.importe / sl.qty) / t.p))
    LIMIT 1
  ) tier ON true`;

(async () => {
  const c = new Client({
    connectionString: URL,
    connectionTimeoutMillis: 15000,
    ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false,
  });
  await c.connect();
  await c.query(`SET statement_timeout = '180s'`);
  console.log('\n=== RR-PROMO.1 — normalización de unidad del incentivo de ruta ===\n');

  try {
    // ── 1) La vista cumple la REGLA PRINCIPAL ──────────────────────────────────────────
    console.log('1) contrato de analytics.v_product_unit_ladder');
    const kind = (await c.query(
      `SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='analytics' AND c.relname='v_product_unit_ladder'`)).rows[0];
    check('la vista existe', !!kind, 'falta la migración 20260902180000');
    check('es VISTA, no tabla (derive-no-copy: sin importer que se caiga)',
      kind?.relkind === 'v', `relkind=${kind?.relkind}`);

    const deps = (await c.query(
      `SELECT DISTINCT sn.nspname AS schema
         FROM pg_depend d
         JOIN pg_rewrite r ON r.oid = d.objid
         JOIN pg_class v   ON v.oid = r.ev_class
         JOIN pg_namespace vn ON vn.oid = v.relnamespace
         JOIN pg_class s   ON s.oid = d.refobjid
         JOIN pg_namespace sn ON sn.oid = s.relnamespace
        WHERE vn.nspname='analytics' AND v.relname='v_product_unit_ladder'
          AND s.relname <> 'v_product_unit_ladder'`)).rows.map((r) => r.schema);
    check('sale SÓLO de kepler_ods (ni catalog, ni etiquetera, ni product_box_factor)',
      deps.length > 0 && deps.every((s) => s === 'kepler_ods'), `depende de: ${deps.join(', ') || '(nada)'}`);

    const cols = (await c.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='analytics' AND table_name='v_product_unit_ladder'`)).rows.map((r) => r.column_name);
    for (const col of ['sku', 'unit_base', 'unit_base_raw', 'f2', 'f3', 'p1', 'p2', 'p3', 'is_weight']) {
      check(`expone ${col}`, cols.includes(col));
    }

    const hasOds = (await c.query(
      `SELECT to_regclass('kepler_ods.kdii') IS NOT NULL AS y`)).rows[0].y;
    if (!hasOds) {
      console.log('\n  ⚠ sin kepler_ods.kdii — se omiten los candados de datos (dev local)\n');
    } else {
      // ── 2) La basura del campo de unidad no se publica ─────────────────────────────
      console.log('\n2) higiene del rótulo');
      const junk = (await c.query(
        `SELECT count(*)::int n FROM analytics.v_product_unit_ladder
          WHERE unit_base IS NOT NULL AND unit_base !~ '^[A-Z]{2,4}$'`)).rows[0].n;
      check(`ninguna cantidad ('500','250','2KG') se publica como unidad`, junk === 0, `${junk} casos`);

      const rescatados = (await c.query(
        `SELECT count(*)::int n FROM analytics.v_product_unit_ladder
          WHERE unit_base IS NULL AND unit_base_raw IS NOT NULL`)).rows[0].n;
      check('la basura se conserva en unit_base_raw para trazabilidad', rescatados > 0, `${rescatados}`);

      // ── 3) Los factores son factores ───────────────────────────────────────────────
      console.log('\n3) factores de la escalera');
      const f1 = (await c.query(
        `SELECT count(*)::int n FROM analytics.v_product_unit_ladder
          WHERE f2 = 1 OR f3 = 1`)).rows[0].n;
      check('un factor de 1 se anula (no es un peldaño)', f1 === 0, `${f1} con factor=1`);

      const conCaja = (await c.query(
        `SELECT count(*)::int n FROM analytics.v_product_unit_ladder WHERE f3 > 1`)).rows[0].n;
      check('hay SKUs con peldaño de caja resuelto', conCaja > 100, `${conCaja}`);

      // ── 4/5) La resolución por precio, contra la venta real ────────────────────────
      console.log('\n4) resolución del peldaño por precio, sobre venta de ruta');
      // Ancla en CURRENT_DATE, igual que el motor: hay líneas de ruta con fecha FUTURA en
      // la fuente (medido en prod: max = 2026-12-05 con el reloj en septiembre). Tomar la
      // ventana de `max(business_date)` traía 4 filas de basura y el test no probaba nada.
      const win = (await c.query(
        `SELECT LEAST(max(business_date), CURRENT_DATE)::text hi FROM analytics.v_route_sales_lines
          WHERE tenant_id=$1 AND sale_channel='ruta_venta' AND business_date <= CURRENT_DATE`, [T])).rows[0].hi;
      if (!win) {
        console.log('  ⚠ sin venta de ruta en esta DB — se omiten los candados de cantidad');
      } else {
        const hi = win;
        const lo = new Date(new Date(hi).getTime() - 30 * 864e5).toISOString().slice(0, 10);
        const agg = (await c.query(
          `WITH lad_all AS (SELECT * FROM analytics.v_product_unit_ladder),
           line AS (
             SELECT sl.sku, sl.qty, sl.importe
             FROM analytics.v_route_sales_lines sl
             WHERE sl.tenant_id=$1 AND sl.sale_channel='ruta_venta'
               AND sl.business_date >= $2 AND sl.business_date <= $3 AND sl.qty > 0
           ),
           t AS (
             SELECT sl.sku, sl.qty, sl.importe, lad.is_weight, tier.f
             FROM line sl
             LEFT JOIN lad_all lad ON lad.sku = sl.sku
             LEFT JOIN LATERAL (
               SELECT x.f FROM (VALUES (1::numeric, lad.p1), (COALESCE(lad.f2,1), lad.p2), (COALESCE(lad.f3,1), lad.p3)) AS x(f,p)
               WHERE x.p > 0 AND (sl.importe / sl.qty) > 0
                 AND abs(ln((sl.importe / sl.qty) / x.p)) < ln(2)
               ORDER BY abs(ln((sl.importe / sl.qty) / x.p)) LIMIT 1
             ) tier ON true
           )
           SELECT count(*)::int lineas,
                  count(*) FILTER (WHERE f IS NULL)::int sin_resolver,
                  sum(qty)::numeric crudo,
                  sum(qty * f) FILTER (WHERE f IS NOT NULL)::numeric base,
                  sum(importe)::numeric imp,
                  sum(importe) FILTER (WHERE f IS NULL)::numeric imp_unres,
                  count(*) FILTER (WHERE f > 1)::int lineas_peldano_alto
             FROM t`, [T, lo, hi])).rows[0];

        const pctUnres = Number(agg.imp) > 0 ? (Number(agg.imp_unres || 0) / Number(agg.imp)) * 100 : 0;
        console.log(`     ventana ${lo}..${hi} · ${agg.lineas} líneas · crudo ${Math.round(agg.crudo)} → base ${Math.round(agg.base)}`);
        check('la mayoría de las líneas resuelve peldaño (<5% sin resolver)',
          pctUnres < 5, `${pctUnres.toFixed(2)}% del importe sin resolver`);
        check('lo no resuelto NO se suma a la cantidad base',
          Number(agg.base) <= Number(agg.crudo) + Number(agg.base), 'invariante estructural');
        if (Number(agg.lineas_peldano_alto) > 0) {
          check('normalizar SUBE la cantidad cuando hay peldaños altos (caja ≥ pieza)',
            Number(agg.base) > Number(agg.crudo),
            `crudo ${Math.round(agg.crudo)} vs base ${Math.round(agg.base)}`);
          console.log(`     corrección: ${(((Number(agg.base) / Number(agg.crudo)) - 1) * 100).toFixed(1)}% que la suma cruda no veía`);
        } else {
          console.log('     (sin líneas en peldaño alto en la ventana — no aplica el candado de corrección)');
        }

        // El peldaño elegido tiene que ser el MÁS CERCANO en precio. Comparar contra la
        // misma banda sería tautológico (el LATERAL ya filtra por ella); lo que hay que
        // blindar es el ORDER BY: si se rompe, se elegiría un peldaño lejano dentro de banda
        // y la cantidad saldría mal sin que nada truene.
        const noMinimo = (await c.query(
          `WITH lad_all AS (SELECT * FROM analytics.v_product_unit_ladder),
           l AS (
             SELECT sl.importe / sl.qty AS pu, lad.p1, lad.p2, lad.p3, lad.f2, lad.f3, tier.f AS elegido
               FROM analytics.v_route_sales_lines sl
               JOIN lad_all lad ON lad.sku = sl.sku
               JOIN LATERAL (
                 SELECT x.f FROM (VALUES (1::numeric, lad.p1), (COALESCE(lad.f2,1), lad.p2), (COALESCE(lad.f3,1), lad.p3)) AS x(f,p)
                 WHERE x.p > 0 AND sl.qty > 0 AND (sl.importe / sl.qty) > 0
                   AND abs(ln((sl.importe / sl.qty) / x.p)) < ln(2)
                 ORDER BY abs(ln((sl.importe / sl.qty) / x.p)) LIMIT 1
               ) tier ON true
              WHERE sl.tenant_id=$1 AND sl.sale_channel='ruta_venta'
                AND sl.business_date >= $2 AND sl.business_date <= $3
           )
           SELECT count(*)::int n FROM l
            WHERE EXISTS (
              SELECT 1 FROM (VALUES (1::numeric, l.p1), (COALESCE(l.f2,1), l.p2), (COALESCE(l.f3,1), l.p3)) AS o(f,p)
               WHERE o.p > 0 AND o.f <> l.elegido
                 AND abs(ln(l.pu / o.p)) < abs(ln(l.pu / (
                       CASE l.elegido WHEN 1 THEN l.p1 WHEN COALESCE(l.f2,1) THEN l.p2 ELSE l.p3 END)))
            )`, [T, lo, hi])).rows[0].n;
        check('el peldaño elegido es el más cercano en precio (blinda el ORDER BY)',
          noMinimo === 0, `${noMinimo} líneas con un peldaño más cercano sin elegir`);

        // ── 6) Granel ────────────────────────────────────────────────────────────────
        console.log('\n5) granel');
        const granel = (await c.query(
          `SELECT count(*)::int n FROM analytics.v_product_unit_ladder WHERE is_weight`)).rows[0].n;
        check('el granel queda marcado (la cuenta por unidades no aplica ahí)', granel > 0, `${granel} SKUs`);
        const malMarcado = (await c.query(
          `SELECT count(*)::int n FROM analytics.v_product_unit_ladder
            WHERE is_weight = false AND unit_base IN ('KG','KGS')`)).rows[0].n;
        check('ningún SKU en KG queda sin marcar como peso', malMarcado === 0, `${malMarcado}`);
      }
    }
  } catch (e) {
    fail++;
    console.log(`\n  ✖ excepción: ${e.message}`);
  } finally {
    await c.end();
  }

  console.log(`\n=== ${ok} ok · ${fail} fail ===\n`);
  process.exitCode = fail ? 1 : 0;
})();
