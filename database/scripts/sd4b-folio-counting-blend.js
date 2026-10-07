/* eslint-disable no-console */
/**
 * [SD.4b] FOLIO-COUNTING en analytics.mv_sales_blended — tickets desde el ODS, no hardcodeados a 0.
 *
 * ── QUÉ ARREGLA ───────────────────────────────────────────────────────────────────────────────
 * `mv_sales_blended.tickets` (26k/mes) es 20× menor que `sales_daily.tickets` (536k) porque sus 3
 * piernas hardcodean `0 AS tickets` salvo la de rutas. Eso bloquea retirar `sales_daily` (SD.5): el
 * Command Center cuenta folios desde la tabla imperativa. Este script hace que el blend cuente folios
 * desde el ODS, con lo que `sales_daily.tickets` deja de ser una dependencia.
 *
 * ── DISEÑO (validado en PROD 2026-09-14, read-only) ───────────────────────────────────────────
 * Se crean DOS vistas de conteo de folios y el blend las suma; NO se tocan `mv_kepler_sales_daily`
 * ni `mv_wincaja_sales_daily` (cada una alimenta también `v_sellout_daily` → tocarlas obliga CASCADE).
 * `mv_sales_blended` NO tiene dependientes (verificado) → su DROP+CREATE es limpio, sin CASCADE.
 *   1. analytics.v_kepler_ticket_count  = count(DISTINCT documento kdm1 c1..c6) por (dia,rama,producto,canal)
 *      → reproduce sales_daily.tickets al 98–99.9% en las 5 ramas puras-Kepler.
 *   2. analytics.v_wincaja_ticket_count = count(DISTINCT v_sales_lines.doc_ref) mismo grano
 *      → reproduce sales_daily.tickets Wincaja al 100.00% (ratio 1.0000 medido).
 *   3. mv_sales_blended: los `0 AS tickets` de las piernas Kepler y Wincaja pasan a un LEFT JOIN a
 *      esas vistas, atribuido UNA vez por (dia,rama,producto,canal) con `row_number()=1` para NO
 *      multiplicar el conteo por los sub-renglones de mv_kepler/mv_wincaja (unit_kind × vendor × box).
 *
 * ⚠️ La sucursal 06 (Canindo) corre los DOS ERPs en el mismo almacén (KX.2): su ticket se compone de
 *    Kepler (pierna 1) + Wincaja (pierna 3). Por eso hacían falta las DOS vistas.
 * ⚠️ Paridad esperada ~98–100% (no exacta): `sales_daily.tickets` sobre-cuenta ~1–2% cuando un
 *    producto se vende en dos unidades el mismo día (attach por unit-row); este diseño cuenta el folio
 *    UNA vez → es MÁS correcto, y difiere de la tabla por ese ~1–2%. El candado lo mide con tolerancia.
 *
 * ── ⛔ CÓMO SE APLICA — NO es una migración de migrate.latest() ────────────────────────────────
 * Recrear el blend (4.5M filas) lo deja NO disponible varios minutos mientras refresca → el sell-out,
 * el margen y el Command Center leen vacío en esa ventana. **Correr SOLO en ventana fuera de horario,
 * a mano, con autorización.** Por eso vive en scripts/, no en migrations-newdb/ (migrate.latest lo
 * aplicaría sin ventana). Regla del proyecto: nada de escrituras pesadas a prod en horario hábil.
 *
 *   node database/scripts/sd4b-folio-counting-blend.js            # DRY-RUN: imprime el plan + tickets hoy
 *   node database/scripts/sd4b-folio-counting-blend.js --apply    # aplica (¡en ventana!) + refresca + cuadra
 *
 * Tras aplicar: `node database/tests/test-newdb-sales-lineage-parity.js` (extender con paridad de tickets).
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

// ── DDL ────────────────────────────────────────────────────────────────────────────────────────
const V_KEPLER = `
CREATE OR REPLACE VIEW analytics.v_kepler_ticket_count AS
SELECT '${T}'::uuid AS tenant_id,
       h.c9::date AS business_date,
       btrim(h.sucursal) AS source_branch,
       p.id AS product_id,
       CASE
         WHEN btrim(v.c3) ILIKE 'RUTA VECINAL%' OR btrim(h.c12) ~ '^[0-9]+V[0-9]' THEN 'preventa'
         WHEN btrim(v.c3) ILIKE 'RUTA %' OR btrim(h.c12) ~ '^1V' THEN 'ruta'
         WHEN btrim(h.sucursal) = '06' AND h.c4::int = 10 AND btrim(h.c67) ~ '^500[1-9]$' THEN 'ruta'
         WHEN h.c4::int = 8 THEN 'mayoreo'
         WHEN h.c4::int = 12 THEN 'credito'
         ELSE 'mostrador'
       END AS channel,
       count(DISTINCT (btrim(h.c1)||'|'||h.c2||'|'||h.c3||'|'||h.c4||'|'||h.c5||'|'||btrim(h.c6))) AS tickets
FROM kepler_ods.kdm1 h
  JOIN kepler_ods.kdm2 l ON btrim(l.sucursal)=btrim(h.sucursal) AND btrim(l.c1)=btrim(h.c1)
    AND l.c2=h.c2 AND l.c3=h.c3 AND l.c4::int=h.c4::int AND l.c5::int=h.c5::int AND btrim(l.c6)=btrim(h.c6)
  LEFT JOIN kepler_ods.kduv v ON btrim(v.sucursal)=btrim(h.sucursal) AND btrim(v.c2)=btrim(h.c12)
  JOIN catalog.products p ON p.tenant_id='${T}'::uuid AND btrim(p.sku::text)=btrim(l.c8) AND p.deleted_at IS NULL
  JOIN commercial.warehouses w ON w.tenant_id='${T}'::uuid AND w.deleted_at IS NULL AND w.code::text=btrim(h.sucursal)
WHERE h.c2='U' AND h.c3='D' AND h.c4::int = ANY(ARRAY[8,10,12]) AND btrim(h.c1)=btrim(h.sucursal)
  AND COALESCE(NULLIF(btrim(h.c43),''),'') <> 'C' AND COALESCE(btrim(l.c11),'') <> 'SER'
  AND abs(COALESCE(l.c9::numeric,0)) > 0 AND h.c9::date <= (now() AT TIME ZONE 'America/Mexico_City')::date
GROUP BY 2, 3, 4, 5;`;

const V_WINCAJA = `
CREATE OR REPLACE VIEW analytics.v_wincaja_ticket_count AS
SELECT vl.tenant_id,
       vl.business_date,
       vl.source_branch,
       p.id AS product_id,
       CASE vl.sale_channel
         WHEN 'mayoreo_credito' THEN 'credito'
         WHEN 'preventa_vecinal' THEN 'preventa'
         WHEN 'ruta_venta' THEN 'ruta'
         ELSE 'mostrador'
       END AS channel,
       count(DISTINCT vl.doc_ref) AS tickets
FROM wincaja.v_sales_lines vl
  JOIN catalog.products p ON p.tenant_id=vl.tenant_id AND p.sku::text=vl.sku
WHERE vl.business_date <= (now() AT TIME ZONE 'America/Mexico_City')::date
GROUP BY 1, 2, 3, 4, 5;`;

// El blend, VERBATIM de su def actual (2026-09-14) salvo: nombres calificados + los dos `0 AS tickets`
// reemplazados por el conteo del ODS atribuido una vez por (dia,rama,producto,canal) con row_number.
const MV_BLEND = `
CREATE MATERIALIZED VIEW analytics.mv_sales_blended AS
SELECT tenant_id, product_id, warehouse_id, channel, sale_date, unit_kind,
       sum(units) AS units, sum(revenue) AS revenue, sum(cost) AS cost,
       sum(tickets) AS tickets, max(updated_at) AS updated_at
FROM (
  -- (1) KEPLER (ramas fijas), tickets = folios del ODS (kdm1)
  SELECT k.tenant_id, k.product_id, w.id AS warehouse_id,
         CASE k.channel WHEN 'mostrador' THEN 'tienda' WHEN 'mayoreo' THEN 'credito' ELSE k.channel END AS channel,
         k.business_date AS sale_date, k.unit_kind, k.units, k.monto AS revenue,
         round(k.monto / (1::numeric + COALESCE(p.markup_pct, 0::numeric) / 100.0), 2) AS cost,
         CASE WHEN row_number() OVER (PARTITION BY k.tenant_id, k.business_date, k.source_branch, k.product_id, k.channel ORDER BY k.unit_kind) = 1
              THEN COALESCE(ktc.tickets, 0) ELSE 0 END AS tickets,
         k.business_date::timestamptz AS updated_at
  FROM analytics.mv_kepler_sales_daily k
    JOIN commercial.warehouses w ON w.tenant_id = k.tenant_id AND w.code::text = k.warehouse_code::text AND w.deleted_at IS NULL
    LEFT JOIN catalog.products p ON p.id = k.product_id
    LEFT JOIN analytics.v_kepler_ticket_count ktc ON ktc.tenant_id = k.tenant_id AND ktc.business_date = k.business_date
       AND ktc.source_branch = k.source_branch AND ktc.product_id = k.product_id AND ktc.channel = k.channel
  WHERE k.product_deleted = false AND (
        k.source_branch = '01' AND k.business_date >= '2026-07-01'::date
     OR k.source_branch = '02' AND k.business_date >= '2025-10-01'::date
     OR k.source_branch = '06' AND k.business_date >= '2026-08-15'::date
     OR k.source_branch = '07' AND k.business_date >= '2026-09-08'::date
     OR k.source_branch = ANY (ARRAY['03','04','05']))
  UNION ALL
  -- (2) RUTAS NUMERADAS (fuera del ODS): sales_daily RUTA-% — tickets ya vienen bien
  SELECT sd.tenant_id, sd.product_id, sd.warehouse_id, sd.channel, sd.sale_date, sd.unit_kind,
         sd.units, sd.revenue, sd.cost, sd.tickets, sd.updated_at
  FROM analytics.sales_daily sd
    JOIN commercial.warehouses w ON w.id = sd.warehouse_id
  WHERE sd.channel !~~ 'wincaja_%' AND w.code::text ~~ 'RUTA-%' AND sd.sale_date >= '2026-07-01'::date
  UNION ALL
  -- (3) WINCAJA, tickets = folios de Wincaja (v_sales_lines.doc_ref)
  SELECT mw.tenant_id, mw.product_id, w.id AS warehouse_id,
         'wincaja_' || mw.channel AS channel, mw.business_date AS sale_date, mw.unit_kind,
         mw.units, mw.monto AS revenue, mw.costo AS cost,
         CASE WHEN row_number() OVER (PARTITION BY mw.tenant_id, mw.business_date, mw.source_branch, mw.product_id, mw.channel ORDER BY mw.unit_kind) = 1
              THEN COALESCE(wtc.tickets, 0) ELSE 0 END AS tickets,
         mw.business_date::timestamptz AS updated_at
  FROM analytics.mv_wincaja_sales_daily mw
    JOIN commercial.warehouses w ON w.tenant_id = mw.tenant_id AND w.code::text = mw.warehouse_code::text AND w.deleted_at IS NULL
    LEFT JOIN analytics.v_wincaja_ticket_count wtc ON wtc.tenant_id = mw.tenant_id AND wtc.business_date = mw.business_date
       AND wtc.source_branch = mw.source_branch AND wtc.product_id = mw.product_id AND wtc.channel = mw.channel
  WHERE mw.product_deleted = false AND (
        mw.wincaja_only = true
     OR mw.source_branch = '10' AND mw.business_date < '2026-07-01'::date
     OR mw.source_branch = '42' AND mw.business_date < '2025-10-01'::date
     OR mw.source_branch = '50' AND mw.business_date < '2026-08-15'::date)
    AND NOT (mw.source_branch = '32' AND mw.business_date >= '2026-09-08'::date)
) q
GROUP BY tenant_id, product_id, warehouse_id, channel, sale_date, unit_kind
WITH NO DATA;`;

const INDEXES = [
  `CREATE UNIQUE INDEX ux_mv_sales_blended ON analytics.mv_sales_blended USING btree (tenant_id, product_id, warehouse_id, channel, sale_date, unit_kind)`,
  `CREATE INDEX ix_mv_sales_blended_cover ON analytics.mv_sales_blended USING btree (tenant_id, sale_date) INCLUDE (channel, revenue, cost, units)`,
  `CREATE INDEX ix_mv_sales_blended_date ON analytics.mv_sales_blended USING btree (tenant_id, sale_date)`,
  `CREATE INDEX ix_mv_sales_blended_channel ON analytics.mv_sales_blended USING btree (tenant_id, channel, sale_date)`,
];
const COMMENT = `COMMENT ON MATERIALIZED VIEW analytics.mv_sales_blended IS 'PARIDAD/ODS: venta real consolidada Kepler(mv_kepler)+rutas(sales_daily RUTA-%)+Wincaja(mv_wincaja), mismo schema que sales_daily, dedup sin doble-conteo, grano dia x producto x almacen x canal x unit_kind. Fuente de los KPIs del Command Center. Costo kepler=revenue/(1+markup) (MR/ADR-051 pendiente). [SD.4b] tickets = folios del ODS (v_kepler_ticket_count + v_wincaja_ticket_count), atribuidos una vez por dia/rama/producto/canal. Refresh nightly.'`;

async function ticketParity(q, etiqueta) {
  for (const mes of ['2026-08', '2026-07']) {
    const r = (await q(`SELECT
      (SELECT COALESCE(sum(tickets),0) FROM analytics.sales_daily WHERE tenant_id=$1 AND to_char(sale_date,'YYYY-MM')=$2)::bigint sd,
      (SELECT COALESCE(sum(tickets),0) FROM analytics.mv_sales_blended WHERE tenant_id=$1 AND to_char(sale_date,'YYYY-MM')=$2)::bigint mb`,
      [T, mes])).rows[0];
    const ratio = Number(r.sd) ? (Number(r.mb) / Number(r.sd)) : 0;
    console.log(`  ${etiqueta} ${mes}: sales_daily=${Number(r.sd).toLocaleString()} blended=${Number(r.mb).toLocaleString()} ratio=${ratio.toFixed(4)}`);
  }
}

(async () => {
  const u = url();
  if (classify(u).kind !== 'prod') { console.error('ABORT: destino no es prod'); process.exit(2); }
  const c = new Client({ connectionString: u, ssl: { rejectUnauthorized: false }, statement_timeout: 600000 });
  await c.connect();
  const q = (s, p) => c.query(s, p);
  if ((await q('select current_database() d')).rows[0].d !== 'railway') { console.error('ABORT !railway'); process.exit(2); }

  console.log(`\n=== SD.4b folio-counting en mv_sales_blended · ${APPLY ? 'APLICAR' : 'DRY-RUN'} ===\n`);
  console.log('tickets ANTES (0 en Kepler/Wincaja, sólo rutas):');
  await ticketParity(q, 'antes');

  if (!APPLY) {
    console.log('\n[dry-run] DDL que se aplicaría (en ventana, con --apply):');
    console.log('  1. CREATE OR REPLACE VIEW analytics.v_kepler_ticket_count');
    console.log('  2. CREATE OR REPLACE VIEW analytics.v_wincaja_ticket_count');
    console.log('  3. DROP + CREATE MATERIALIZED VIEW analytics.mv_sales_blended (WITH NO DATA) + 4 índices + grant + comment');
    console.log('  4. REFRESH MATERIALIZED VIEW analytics.mv_sales_blended  (⚠️ minutos NO disponible)');
    console.log('\n⛔ NO aplicado. Corré con --apply SÓLO en ventana fuera de horario.');
    await c.end(); process.exit(0);
  }

  console.log('\n[apply] creando vistas de conteo…');
  await q(V_KEPLER); await q(V_WINCAJA);
  console.log('[apply] recreando mv_sales_blended (DROP + CREATE WITH NO DATA)…');
  await q('BEGIN');
  await q('SET LOCAL lock_timeout = \'10s\'');
  await q('DROP MATERIALIZED VIEW IF EXISTS analytics.mv_sales_blended');
  await q(MV_BLEND);
  for (const ix of INDEXES) await q(ix);
  await q('GRANT SELECT ON analytics.mv_sales_blended TO app_runtime');
  await q(COMMENT);
  await q('COMMIT');
  console.log('[apply] REFRESH (esto tarda; el blend está vacío hasta que termine)…');
  const t0 = Date.now();
  await q('REFRESH MATERIALIZED VIEW analytics.mv_sales_blended');
  console.log(`[apply] refresh OK en ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  console.log('\ntickets DESPUÉS:');
  await ticketParity(q, 'después');
  console.log('\n✅ aplicado. Correr el candado: node database/tests/test-newdb-sales-lineage-parity.js');
  await c.end(); process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
