/* eslint-disable no-console */
/**
 * [SD-PAY] Dimensión de CONDICIÓN DE PAGO (credito/contado) — venta a crédito bien modelada, desde la cartera.
 *
 * ── POR QUÉ (decisión de Edgar: "opción a") ────────────────────────────────────────────────────
 * "credito" NO es un canal de venta — es una condición de PAGO. Medido en prod 2026-09-14:
 *   · U-D-12 (lo que mv_kepler/blend llaman "credito") es "Factura CONTADO No Fiscal" = EFECTIVO.
 *   · El crédito REAL (U-D-13) son $0.16M/30d, y está fuera del sell-out.
 *   · El crédito CRUZA canales pero está 96% concentrado en mayoreo/telemarketing (684 de 711 folios).
 *   · sales_daily.credito (~$6.13M) = esencialmente "mayoreo vendido a crédito".
 * La señal correcta de crédito: el CLIENTE tiene días de crédito > 0 (`kdud.c16`), ligado por
 * `kdm1.c10 → kdud.c2` (match 100%). Contado = días 0 / público general.
 *
 * ── QUÉ HACE ────────────────────────────────────────────────────────────────────────────────────
 * Crea `analytics.mv_sales_payment_terms` — venta del sell-out por (día, rama, canal, payment_term),
 * DERIVADA del ODS (derive-no-copy). Es ADITIVA: no toca mv_kepler/blend/v_sellout (que tienen
 * dependientes y obligarían CASCADE de 4 objetos). Con esto el negocio ve "cuánto se vendió a crédito"
 * cruzando canales, sin cirugía del linaje principal.
 *
 * ⚠️ Canales con la taxonomía CORREGIDA: `mayoreo` se preserva (U-D-8), y U-D-12 se rotula `contado_nf`
 *    (no "credito"). El fix del remapeo `mayoreo→credito` en el BLEND y en v_sellout_daily es una pieza
 *    APARTE (chica) — este script no lo toca.
 *
 * ── CÓMO SE APLICA — NO es migración de migrate.latest() ────────────────────────────────────────
 * Crea un matview nuevo (refresh sobre kdm1⋈kdm2⋈kdud, 13 meses → minutos). CERO riesgo a objetos
 * existentes (es aditivo), pero pesado: correr en ventana. dry-run por default.
 *   node database/scripts/pay-dimension-payment-terms.js          # dry-run: mide el split + plan
 *   node database/scripts/pay-dimension-payment-terms.js --apply  # crea + refresca + mide (en ventana)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { classify } = require('../../libs/platform-core/src/lib/provenance/target-guard.js');

const T = '00000000-0000-0000-0000-00000000d01c';
const APPLY = process.argv.includes('--apply');
function url() {
  if (process.env.FLEET_DB_URL) return process.env.FLEET_DB_URL;
  const env = fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8');
  const m = env.match(/^FLEET_DB_URL=(.*)$/m);
  if (!m) throw new Error('falta FLEET_DB_URL');
  return m[1].trim();
}

// El SELECT del sell-out por canal corregido + payment_term. HEADER-ONLY (kdm1): el revenue sale del
// TOTAL de encabezado `h.c16` (= SUM de renglones al 99.61% medido; el 0.39% son líneas SER que el
// grano por-renglón excluye — despreciable para un split de condición de pago). Sin el join a kdm2 el
// refresh es rápido (kdm1 603k filas, no 3.9M de kdm2). Canal/payment/folio ya son todos de encabezado.
// ⚠️ DOS niveles a propósito: si el kdud se une por-renglón de kdm1, el planner estima kdm1=1 fila (no
// puede medir los filtros btrim) y elige un NESTED LOOP contra kdud = catastrófico (250k × 2231). Se
// AGREGA kdm1 primero (rápido, índice de fecha) por (día,rama,canal,cliente) y RECIÉN ahí se hace hash-join
// a kdud sobre el conjunto chico, y se re-agrega colapsando el cliente en payment_term.
const SELECT_BODY = `
WITH base AS (
  SELECT h.c9::date AS business_date,
         btrim(h.sucursal) AS source_branch,
         CASE
           WHEN btrim(v.c3) ILIKE 'RUTA VECINAL%' OR btrim(h.c12) ~ '^[0-9]+V[0-9]' THEN 'preventa'
           WHEN btrim(v.c3) ILIKE 'RUTA %' OR btrim(h.c12) ~ '^1V' THEN 'ruta'
           WHEN btrim(h.sucursal) = '06' AND h.c4::int = 10 AND btrim(h.c67) ~ '^500[1-9]$' THEN 'ruta'
           WHEN h.c4::int = 8 THEN 'mayoreo'          -- preservado (era plegado a credito)
           WHEN h.c4::int = 12 THEN 'contado_nf'      -- U-D-12 = Factura Contado No Fiscal (NO credito)
           ELSE 'tienda'                              -- mostrador (U-D-10)
         END AS channel,
         btrim(h.c10::text) AS cli,
         round(sum(round(COALESCE(NULLIF(regexp_replace(h.c16::text,'[^0-9.-]','','g'),'')::numeric,0),2))::numeric,2) AS revenue,
         count(*) AS folios   -- kdm1 = un renglón por documento → count(*) = folios
  FROM kepler_ods.kdm1 h
    LEFT JOIN kepler_ods.kduv v ON btrim(v.sucursal)=btrim(h.sucursal) AND btrim(v.c2)=btrim(h.c12)
  WHERE h.c2='U' AND h.c3='D' AND h.c4::int = ANY(ARRAY[8,10,12]) AND btrim(h.c1)=btrim(h.sucursal)
    AND COALESCE(NULLIF(btrim(h.c43),''),'') <> 'C'
    AND h.c9::date <= (now() AT TIME ZONE 'America/Mexico_City')::date
    AND h.c9::date >= (now() AT TIME ZONE 'America/Mexico_City')::date - INTERVAL '13 months'
  GROUP BY 1, 2, 3, 4
),
kd AS (SELECT DISTINCT ON (btrim(c2)) btrim(c2) code, NULLIF(regexp_replace(c16::text,'[^0-9-]','','g'),'')::int dias
       FROM kepler_ods.kdud ORDER BY btrim(c2), c7 DESC)
SELECT '${T}'::uuid AS tenant_id, base.business_date, base.source_branch, base.channel,
       CASE WHEN COALESCE(kd.dias, 0) > 0 THEN 'credito' ELSE 'contado' END AS payment_term,
       round(sum(base.revenue)::numeric,2) AS revenue, sum(base.folios) AS folios
FROM base LEFT JOIN kd ON kd.code = base.cli
GROUP BY 2, 3, 4, 5`;

const MV = `CREATE MATERIALIZED VIEW analytics.mv_sales_payment_terms AS ${SELECT_BODY} WITH NO DATA`;
const IDX = `CREATE UNIQUE INDEX ux_mv_sales_payment_terms ON analytics.mv_sales_payment_terms (tenant_id, business_date, source_branch, channel, payment_term)`;
const GRANT = `GRANT SELECT ON analytics.mv_sales_payment_terms TO app_runtime`;
const COMMENT = `COMMENT ON MATERIALIZED VIEW analytics.mv_sales_payment_terms IS 'SD-PAY: venta del sell-out Kepler por dia x rama x canal x payment_term (credito/contado). El credito = cliente con dias de credito >0 (kdud.c16 via kdm1.c10->c2). Cruza canales (96% en mayoreo). Canales corregidos: mayoreo preservado, U-D-12=contado_nf. Derive-no-copy sobre kepler_ods. Refresh nightly.'`;

(async () => {
  const u = url();
  if (classify(u).kind !== 'prod') { console.error('ABORT: destino no es prod'); process.exit(2); }
  const c = new Client({ connectionString: u, ssl: { rejectUnauthorized: false }, statement_timeout: 900000 });
  await c.connect();
  const q = (s) => c.query(s);
  if ((await q('select current_database() d')).rows[0].d !== 'railway') { console.error('ABORT !railway'); process.exit(2); }

  console.log(`\n=== SD-PAY dimensión de condición de pago · ${APPLY ? 'APLICAR' : 'DRY-RUN'} ===\n`);

  if (!APPLY) {
    console.log('[dry-run] plan: CREATE MATERIALIZED VIEW analytics.mv_sales_payment_terms (aditivo, sin CASCADE) + índice único + grant + comment + REFRESH.');
    console.log('[dry-run] split de crédito medido (folios, 30d, header-only):');
    const r = await q(`
      WITH kd AS (SELECT DISTINCT ON (btrim(c2)) btrim(c2) code, NULLIF(regexp_replace(c16::text,'[^0-9-]','','g'),'')::int dias FROM kepler_ods.kdud ORDER BY btrim(c2), c7 DESC)
      SELECT CASE WHEN COALESCE(kd.dias,0)>0 THEN 'credito' ELSE 'contado' END pt, count(*) folios
      FROM kepler_ods.kdm1 h LEFT JOIN kd ON kd.code=btrim(h.c10::text)
      WHERE h.c2='U' AND h.c3='D' AND h.c4::int=ANY(ARRAY[8,10,12]) AND btrim(h.c1)=btrim(h.sucursal)
        AND COALESCE(NULLIF(btrim(h.c43),''),'')<>'C' AND h.c9::date>=current_date-30 GROUP BY 1`);
    for (const x of r.rows) console.log(`    ${x.pt}: ${Number(x.folios).toLocaleString()} folios`);
    console.log('\n⛔ NO aplicado. Corré con --apply en ventana. Pieza aparte (no acá): preservar mayoreo en el blend + v_sellout_daily.');
    await c.end(); process.exit(0);
  }

  console.log('[apply] creando mv_sales_payment_terms (WITH NO DATA)…');
  await q('BEGIN'); await q(`SET LOCAL lock_timeout = '10s'`);
  await q(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_sales_payment_terms`);
  await q(MV); await q(IDX); await q(GRANT); await q(COMMENT);
  await q('COMMIT');
  console.log('[apply] REFRESH (kdm1⋈kdm2⋈kdud, 13 meses — tarda)…');
  const t0 = Date.now();
  await q('REFRESH MATERIALIZED VIEW analytics.mv_sales_payment_terms');
  console.log(`[apply] refresh OK en ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log('\ncrédito vs contado (30d, del matview nuevo):');
  const r = await q(`SELECT payment_term, round(sum(revenue))::numeric monto FROM analytics.mv_sales_payment_terms
    WHERE tenant_id=$1 AND business_date>=current_date-30 GROUP BY 1 ORDER BY 2 DESC`.replace('$1', `'${T}'`));
  for (const x of r.rows) console.log(`  ${x.payment_term}: $${Number(x.monto).toLocaleString()}`);
  await c.end(); process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
