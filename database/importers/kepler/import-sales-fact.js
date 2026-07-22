/* eslint-disable no-console */
/**
 * KV.1 — Fact de VENTA REAL → analytics.sales_daily, MODO BULK.
 *
 * Fuente: mart.ventas_enriched (consolidación on-prem, 6 sucursales, con channel).
 * Agrega por (almacen, sku, channel, día) en ventana de 13 meses, resuelve
 * sku→product_id y almacen→warehouse_id contra el destino, calcula costo con
 * catalog.products.cost_base (costo actual; sale-time cost = refinamiento futuro),
 * carga staging temp y hace DELETE-ventana + INSERT server-side (atómico).
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
 *   node database/importers/kepler/import-sales-fact.js          # dry-run
 *   node database/importers/kepler/import-sales-fact.js --apply  # commit
 */

const { Client } = require('pg');
const { productKind, buildModel, toCanonical } = require('./unit-normalization');

const M = '00000000-0000-0000-0000-00000000d01c';
const SRC = process.env.DATABASE_URL_KEPLER_CONSOLIDADO || 'postgresql://postgres:superoot@localhost:5433/kepler_consolidado';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const BATCH = 2000;
const MONTHS = 13;
// Ventana refrescada. Default = 13 meses (nightly, refresco completo). El feed LIVE
// (intradía, cada pocos min) pasa SALES_FACT_DAYS=N para refrescar solo los últimos N
// días → DELETE+INSERT acotado, barato. Los días viejos ya cargados por el nightly no
// se tocan. WIN se usa idéntico en el filtro del origen y en el DELETE del destino.
const DAYS = process.env.SALES_FACT_DAYS ? parseInt(process.env.SALES_FACT_DAYS, 10) : null;
const WIN = DAYS ? `current_date - interval '${DAYS} days'` : `current_date - interval '${MONTHS} months'`;

// Sub-almacenes de RUTA de PH: Kepler los emite como '01-NNN' (empieza ~2026-06-29),
// pero la MISMA ruta ya vive como warehouse 'RUTA-NN' alimentado por Wincaja hasta
// 2026-06-27 (canal wincaja_ruta). Se traduce 01-NNN → RUTA-NN para que cada ruta quede
// en UN solo almacén con timeline continua (cutover natural: Wincaja <06-28, Kepler >=06-29,
// sin solape). Mapeo por número de ruta (verificado vía forma_pago). NO crear 01-NNN.
const ROUTE_MAP = { '01-001': 'RUTA-21', '01-002': 'RUTA-22', '01-003': 'RUTA-23', '01-004': 'RUTA-26', '01-005': 'RUTA-27', '01-006': 'RUTA-28' };
const mapAlmacen = (a) => ROUTE_MAP[a] || a;

(async () => {
  const src = new Client({ connectionString: SRC });
  const db = new Client({ connectionString: DST });
  await src.connect();
  await db.connect();
  try {
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
    const tkMap = new Map(tk.map((r) => [`${mapAlmacen(r.almacen)}|${r.sku}|${r.channel}|${r.fecha.toISOString().slice(0,10)}`, r.tickets]));
    console.log(`  origen: ${agg.length} filas (almacen×sku×canal×día×unidad) · ${tk.length} grupos de tickets`);

    // Transform: convertir cada bucket de unidad → canónico y RE-AGREGAR por
    // (product, warehouse, channel, fecha). cost = revenue/(1+markup/100) al final.
    const acc = new Map(); // key → { pid, wid, channel, fecha, sku, almacen, markup, units, revenue, kind }
    let noSku = 0, noWh = 0, unconv = 0;
    for (const r of agg) {
      const p = skuTo.get(r.sku);
      if (!p) { noSku++; continue; }
      const alm = mapAlmacen(r.almacen);
      const wid = whTo.get(alm);
      if (!wid) { noWh++; continue; }
      const conv = toCanonical(p, r.unidad, Number(r.cant));
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

    if (!APPLY) {
      console.log('\n[DRY-RUN] nada cambió.');
      return;
    }

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
    // Refresco por UPSERT (sin DELETE → cero churn/bloat, no reescribe la ventana entera):
    // actualiza en su lugar las filas existentes e inserta solo las combinaciones nuevas.
    // Agrupado por si hay sku duplicados que colapsan al mismo product_id.
    // Los canales wincaja_* NO se tocan (no vienen en este origen), así que quedan intactos
    // sin necesidad del scope explícito que tenía el viejo DELETE.
    // Nota: una combinación (product,warehouse,channel,día) que existía y desaparece del
    // origen (venta anulada/sku sin mapear) queda con su último valor — trade-off aceptado
    // para no borrar (raro en ventas; el nightly la re-cuadra si el origen la vuelve a traer).
    const up = await db.query(
      `INSERT INTO analytics.sales_daily
         (id, tenant_id, product_id, warehouse_id, channel, sale_date, units, revenue, cost, tickets, unit_kind, updated_at)
       SELECT gen_random_uuid(), $1, product_id, warehouse_id, channel, sale_date,
              sum(units), sum(revenue), sum(cost), sum(tickets), max(unit_kind), now()
         FROM stg_sf
        GROUP BY product_id, warehouse_id, channel, sale_date
       ON CONFLICT (tenant_id, product_id, warehouse_id, channel, sale_date)
       DO UPDATE SET units=EXCLUDED.units, revenue=EXCLUDED.revenue, cost=EXCLUDED.cost,
                     tickets=EXCLUDED.tickets, unit_kind=EXCLUDED.unit_kind, updated_at=now()`, [M]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${up.rowCount} filas en analytics.sales_daily.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await src.end();
    await db.end();
  }
})();
