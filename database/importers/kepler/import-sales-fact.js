/* eslint-disable no-console */
/**
 * KV.1 — Fact de VENTA REAL → analytics.sales_daily, MODO BULK.
 *
 * Fuente: mart.ventas_enriched (consolidación on-prem, 6 sucursales, con channel).
 * Agrega por (almacen, sku, channel, día) en ventana de 13 meses, resuelve
 * sku→product_id y almacen→warehouse_id contra el destino, calcula costo con
 * catalog.products.cost_base (costo actual; sale-time cost = refinamiento futuro),
 * carga staging temp y hace UPSERT server-side churn-free.
 *
 * RS.3 (2026-07-20) — NORMALIZACIÓN DE UNIDAD. La fuente registra cada línea en su
 * unidad de venta real (columna `unidad`: PAQ/PZA/KG/500/CJA/CUB…). Sumar `cantidad`
 * a ciegas mezclaba paquetes + piezas + kg en un solo `units` → el sell-out dividía
 * ese revoltijo por `factor_sale` y mostraba "cajas" inexistentes (granel/bulto). Ahora
 * agrupamos POR unidad y convertimos cada línea a un canónico coherente por producto:
 *   · producto de PIEZA  → units en PIEZAS (PAQ×pack, CJA×box, PZA×1)   unit_kind='piece'
 *   · producto de PESO   → units en KG     (KG×1, 500×.5, PAQ/CUB×gramaje) unit_kind='weight'
 * El reporte usa unit_kind: piece → cajas=units/factor_sale · weight → muestra kg.
 *
 * Modo --watch: cicla cada N segundos (default 60) con src+destino persistentes; en watch
 * la ventana default cae a 2 días (SALES_FACT_DAYS override) → cada ciclo re-deriva solo lo
 * reciente (barato) desde el mart fresco. Kepler-sales "al momento" sin re-arrancar el proceso.
 *
 *   node database/importers/kepler/import-sales-fact.js               # dry-run
 *   node database/importers/kepler/import-sales-fact.js --apply       # commit (ventana 13m)
 *   node database/importers/kepler/import-sales-fact.js --apply --watch=60   # loop live (2d/ciclo)
 */

const { Client } = require('pg');
const hb = require('../lib/cron-heartbeat');
const { productKind, buildModel, toCanonicalPriced } = require('./unit-normalization');

const M = '00000000-0000-0000-0000-00000000d01c';
const SRC = process.env.DATABASE_URL_KEPLER_CONSOLIDADO || 'postgresql://postgres:superoot@localhost:5433/kepler_consolidado';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const WATCH_ARG = process.argv.find((a) => a === '--watch' || a.startsWith('--watch='));
const WATCH_SEC = WATCH_ARG ? Math.max(15, Number(WATCH_ARG.split('=')[1] || 60)) : 0;
const BATCH = 2000;
const MONTHS = 13;
// Ventana refrescada. Default = 13 meses (nightly, refresco completo). El feed LIVE
// (intradía) pasa SALES_FACT_DAYS=N o corre con --watch (default 2d) para refrescar solo
// los últimos N días → UPSERT acotado, barato. Los días viejos ya cargados no se tocan.
const DAYS = process.env.SALES_FACT_DAYS ? parseInt(process.env.SALES_FACT_DAYS, 10) : (WATCH_SEC ? 2 : null);
const WIN = DAYS ? `current_date - interval '${DAYS} days'` : `current_date - interval '${MONTHS} months'`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sub-almacenes de RUTA de PH: Kepler los emite como '01-NNN' (empieza ~2026-06-29),
// pero la MISMA ruta ya vive como warehouse 'RUTA-NN' alimentado por Wincaja hasta
// 2026-06-27 (canal wincaja_ruta). Se traduce 01-NNN → RUTA-NN para que cada ruta quede
// en UN solo almacén con timeline continua (cutover natural: Wincaja <06-28, Kepler >=06-29,
// sin solape). Mapeo por número de ruta (verificado vía forma_pago). NO crear 01-NNN.
const ROUTE_MAP = { '01-001': 'RUTA-21', '01-002': 'RUTA-22', '01-003': 'RUTA-23', '01-004': 'RUTA-26', '01-005': 'RUTA-27', '01-006': 'RUTA-28' };
const mapAlmacen = (a) => ROUTE_MAP[a] || a;

/** Un ciclo completo: lee el mart, normaliza unidades, UPSERT a analytics.sales_daily.
 *  src/db persistentes. Devuelve stat {status, rows} para el heartbeat. */
async function runCycle(src, db) {
  console.log(`\n=== Fact de ventas → analytics.sales_daily (BULK, ${APPLY ? 'APPLY' : 'DRY-RUN'}, ventana ${DAYS ? DAYS + 'd (LIVE)' : MONTHS + 'm'}) ===\n`);

  // Lookups del destino + MODELO DE UNIDAD por producto (RS.3).
  const prods = (await db.query(
    `SELECT p.id, p.sku, p.markup_pct,
            upper(btrim(coalesce(p.unit_sale,''))) AS unit_sale, p.factor_sale,
            l.pack_size, l.box_size, l.unit_base, l.content
       FROM catalog.products p
       LEFT JOIN commercial.product_label_prices l ON l.product_id=p.id AND l.tenant_id=p.tenant_id
      WHERE p.tenant_id=$1 AND btrim(coalesce(p.sku,''))<>''`, [M])).rows;
  const skuTo = new Map();
  for (const p of prods) {
    skuTo.set(p.sku, { id: p.id, markup_pct: p.markup_pct, ...buildModel(p) });
  }
  // Escala de precios PROPIA de Kepler (kdii) por sku: c90 pieza / c91 paquete / c92 caja +
  // factores c81/c84. Se fusiona en el modelo para que toCanonicalPriced identifique el nivel de
  // cada línea por su PRECIO real (el label `unidad` de Kepler es inconsistente: escribe 'PAQ'
  // tanto para la pieza base como para un pack). Union de las sucursales de kepler_consolidado.
  const kschemasAll = (await src.query(
    `SELECT table_schema FROM information_schema.tables WHERE table_name='kdii' AND table_schema LIKE 'md\\_%'`)).rows.map((r) => r.table_schema);
  // Los esquemas md_* son foreign tables (postgres_fdw) sobre srv_mdNN. Si una sucursal
  // está caída (p.ej. Zamora/srv_md05), el UNION completo aborta con "could not connect to
  // server". SALTAMOS la caída: probamos cada esquema (con statement_timeout acotado para no
  // colgarnos en el connect) y unimos solo los accesibles. La sucursal omitida no aporta su
  // escala de precios kdii → sus SKUs caen al modelo del catálogo (degradación aceptable);
  // sus ventas ya viven en mart.ventas (tabla local, no FDW) y no se pierden.
  const kschemas = [];
  const kskipped = [];
  await src.query(`SET statement_timeout = '8000'`);
  for (const s of kschemasAll) {
    try { await src.query(`SELECT 1 FROM ${s}.kdii LIMIT 1`); kschemas.push(s); }
    catch (e) { kskipped.push(s); console.warn(`  ⚠️  omito ${s} (FDW no accesible): ${String(e.message || '').split('\n')[0]}`); }
  }
  await src.query(`SET statement_timeout = 0`);
  if (kskipped.length) console.warn(`  ⚠️  sucursales omitidas en escala kdii: ${kskipped.join(', ')} — corrida parcial (se completa cuando vuelvan).`);
  if (kschemas.length) {
    const union = kschemas.map((s) => `SELECT c1,c81,c84,c90,c91,c92 FROM ${s}.kdii`).join(' UNION ALL ');
    const ladder = (await src.query(
      `SELECT c1 AS sku, max(c90::numeric) p_pza, max(c91::numeric) p_paq, max(c92::numeric) p_caja,
              max(c81::numeric) c81, max(c84::numeric) c84 FROM (${union}) t GROUP BY c1`)).rows;
    let merged = 0;
    for (const k of ladder) {
      const m = skuTo.get(String(k.sku));
      if (!m) continue;
      m.pPza = Number(k.p_pza) || 0; m.pPaq = Number(k.p_paq) || 0; m.pCaja = Number(k.p_caja) || 0;
      m.c81 = Number(k.c81) > 1 ? Number(k.c81) : 0; m.c84 = Number(k.c84) > 1 ? Number(k.c84) : 0;
      merged++;
    }
    console.log(`  escala kdii: ${ladder.length} skus en kepler (${kschemas.length} sucursales) · ${merged} match con catálogo`);
  }
  const whs = (await db.query(`SELECT id, code FROM commercial.warehouses WHERE tenant_id=$1`, [M])).rows;
  const whTo = new Map(whs.map((w) => [w.code, w.id]));
  const nWeight = prods.filter((p) => productKind(p.unit_sale, p.unit_base) === 'weight').length;
  console.log(`  lookup destino: ${skuTo.size} products c/sku (${nWeight} de peso) · ${whTo.size} warehouses`);

  // Origen: agregado POR unidad de venta real (para poder convertir cada bucket).
  // PH ('01'): Wincaja manda `< 2026-07-01` (venta real ene–jun), Kepler desde jul 1
  // (Kepler recién tomó PH). Excluir el pre-julio de PH aquí cierra el solape de junio
  // con el feed Wincaja → cero doble conteo. Ver import-wincaja-analytics.js (PH_CUTOVER).
  const { rows: agg } = await src.query(
    `SELECT almacen, sku, channel, fecha, upper(btrim(coalesce(unidad,''))) AS unidad,
            sum(cantidad)::numeric        AS cant,
            round(sum(importe),2)::numeric AS revenue
       FROM mart.ventas_enriched
      WHERE fecha >= ${WIN}
        AND fecha <= current_date
        AND NOT (almacen = '01' AND fecha < DATE '2026-07-01')
      GROUP BY almacen, sku, channel, fecha, upper(btrim(coalesce(unidad,'')))`);
  // Tickets: aparte, SIN unidad, para no sobrecontar folios con varias unidades.
  const { rows: tk } = await src.query(
    `SELECT almacen, sku, channel, fecha, count(DISTINCT folio)::int AS tickets
       FROM mart.ventas_enriched
      WHERE fecha >= ${WIN}
        AND fecha <= current_date
        AND NOT (almacen = '01' AND fecha < DATE '2026-07-01')
      GROUP BY almacen, sku, channel, fecha`);
  const tkMap = new Map(tk.map((r) => [`${mapAlmacen(r.almacen)}|${r.sku}|${r.channel}|${r.fecha.toISOString().slice(0, 10)}`, r.tickets]));
  console.log(`  origen: ${agg.length} filas (almacen×sku×canal×día×unidad) · ${tk.length} grupos de tickets`);

  // Transform: convertir cada bucket de unidad → canónico y RE-AGREGAR por
  // (product, warehouse, channel, fecha). cost = revenue/(1+markup/100) al final.
  const acc = new Map();
  let noSku = 0, noWh = 0, unconv = 0;
  for (const r of agg) {
    const p = skuTo.get(r.sku);
    if (!p) { noSku++; continue; }
    const alm = mapAlmacen(r.almacen);
    const wid = whTo.get(alm);
    if (!wid) { noWh++; continue; }
    const cant = Number(r.cant);
    const unitPrice = cant !== 0 ? Number(r.revenue) / cant : 0;
    const conv = toCanonicalPriced(p, r.unidad, cant, unitPrice);
    if (!conv.ok) unconv++;
    const fecha = r.fecha.toISOString().slice(0, 10);
    const key = `${p.id}|${wid}|${r.channel}|${fecha}`;
    let a = acc.get(key);
    if (!a) {
      a = { pid: p.id, wid, channel: r.channel, fecha, sku: r.sku, almacen: alm,
            markup: p.markup_pct, units: 0, revenue: 0, kind: p.kind };
      acc.set(key, a);
    }
    a.units += conv.qty;
    a.revenue += Number(r.revenue);
  }
  const rows = []; let noMarkup = 0;
  const byChannel = {};
  for (const a of acc.values()) {
    const m = a.markup != null ? Number(a.markup) : null;
    const cost = m != null && m > -100 ? a.revenue / (1 + m / 100) : null;
    if (cost == null) noMarkup++;
    const tickets = tkMap.get(`${a.almacen}|${a.sku}|${a.channel}|${a.fecha}`) || 0;
    rows.push([a.pid, a.wid, a.channel, a.fecha,
      Math.round(a.units * 1000) / 1000, Math.round(a.revenue * 100) / 100, cost, tickets, a.kind]);
    const c = (byChannel[a.channel] ||= { filas: 0, revenue: 0 });
    c.filas++; c.revenue += a.revenue;
  }
  console.log(`  (sin markup → cost NULL: ${noMarkup} · líneas sin conversión limpia: ${unconv})`);
  console.log(`  a cargar: ${rows.length} (sin sku en catálogo: ${noSku}, sin warehouse: ${noWh})`);
  console.table(Object.fromEntries(Object.entries(byChannel).map(([k, v]) => [k, { filas: v.filas, revenue: Math.round(v.revenue) }])));

  if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); return { status: 'ok', rows: 0 }; }

  await db.query('BEGIN');
  await db.query(`SET LOCAL app.tenant_id = '${M}'`);
  await db.query(`CREATE TEMP TABLE stg_sf (product_id uuid, warehouse_id uuid, channel text, sale_date date, units numeric, revenue numeric, cost numeric, tickets int, unit_kind text) ON COMMIT DROP`);
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const vals = [], params = [];
    chunk.forEach((row, ri) => {
      const b = ri * 9;
      vals.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9})`);
      params.push(...row);
    });
    await db.query(`INSERT INTO stg_sf VALUES ${vals.join(',')}`, params);
  }
  // Refresco por UPSERT (sin DELETE → cero churn/bloat). Los canales wincaja_* NO se tocan.
  const up = await db.query(
    `INSERT INTO analytics.sales_daily AS sd
       (id, tenant_id, product_id, warehouse_id, channel, sale_date, units, revenue, cost, tickets, unit_kind, updated_at)
     SELECT gen_random_uuid(), $1, product_id, warehouse_id, channel, sale_date,
            sum(units), sum(revenue), sum(cost), sum(tickets), max(unit_kind), now()
       FROM stg_sf
      GROUP BY product_id, warehouse_id, channel, sale_date
     ON CONFLICT (tenant_id, product_id, warehouse_id, channel, sale_date)
     DO UPDATE SET units=EXCLUDED.units, revenue=EXCLUDED.revenue, cost=EXCLUDED.cost,
                   tickets=EXCLUDED.tickets, unit_kind=EXCLUDED.unit_kind, updated_at=now()
     WHERE (sd.units, sd.revenue, sd.cost, sd.tickets, sd.unit_kind)
           IS DISTINCT FROM
           (EXCLUDED.units, EXCLUDED.revenue, EXCLUDED.cost, EXCLUDED.tickets, EXCLUDED.unit_kind)`, [M]);
  await db.query('COMMIT');
  await db.query(`ANALYZE analytics.sales_daily`); // RS.12c — stats frescas → plan bueno en sell-out
  console.log(`\n[APPLY] COMMIT — ${up.rowCount} filas en analytics.sales_daily.`);
  return { status: 'ok', rows: up.rowCount };
}

(async () => {
  const src = new Client({ connectionString: SRC });
  const db = new Client({ connectionString: DST });
  await src.connect();
  await db.connect();
  if (WATCH_SEC) console.log(`\n=== sales-fact WATCH ${WATCH_SEC}s · Ctrl+C para salir ===`);
  try {
    let cycle = 0;
    do {
      cycle++;
      if (WATCH_SEC) console.log(`\n──── ciclo ${cycle} @ ${new Date().toLocaleTimeString()} ────`);
      let stat = { status: 'ok', rows: 0 };
      if (APPLY) await hb.begin('kepler_sales_fact', 'Kepler ventas (sales-fact)').catch(() => {});
      try {
        stat = await runCycle(src, db);
      } catch (e) {
        await db.query('ROLLBACK').catch(() => {});
        console.error('\nERROR (rollback):', e.message);
        stat = { status: 'error', error: e.message };
        if (!WATCH_SEC) process.exitCode = 1;
      }
      if (APPLY) await hb.end('kepler_sales_fact', stat).catch(() => {});
      if (WATCH_SEC) await sleep(WATCH_SEC * 1000);
    } while (WATCH_SEC);
  } finally {
    await src.end();
    await db.end();
  }
})();
