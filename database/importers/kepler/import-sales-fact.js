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

const M = '00000000-0000-0000-0000-00000000d01c';
const SRC = process.env.DATABASE_URL_KEPLER_CONSOLIDADO || 'postgresql://postgres:superoot@localhost:5433/kepler_consolidado';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const BATCH = 2000;
const MONTHS = 13;

// --- Modelo de unidades (RS.3) -------------------------------------------------
// Unidades de venta que representan PESO (no cuenta de piezas).
const WEIGHT_U = new Set(['KG', '1KG', '2KG', '3KG', '5KG', 'CUB', 'BTO', 'BULTO']);
// Etiqueta de unidad que es gramos numéricos ("500" = 500 g = 0.5 kg).
const gramsUnitKg = (u) => { const m = /^(\d+(?:\.\d+)?)$/.exec(u); return m ? Number(m[1]) / 1000 : null; };
// kg que representa una línea vendida en unidad `u` (solo para unidades de peso conocidas).
const kgFromUnit = (u) => {
  if (u === 'KG' || u === '1KG') return 1;
  if (u === '2KG') return 2; if (u === '3KG') return 3; if (u === '5KG') return 5;
  return gramsUnitKg(u);
};
// Gramaje del producto en kg (peso de UNA pieza/paquete/bulto) desde content ("9 kg",
// "560 g", "20 kg") o unit_base ("KG"→1, "500"→0.5). null si no se puede inferir.
function gramajeKg(content, unitBase) {
  const c = String(content || '').trim().toLowerCase();
  let m = /(\d+(?:[.,]\d+)?)\s*(kgs?|kilos?|k)\b/.exec(c);
  if (m) return Number(m[1].replace(',', '.'));
  m = /(\d+(?:[.,]\d+)?)\s*(g|gr|gramos?)\b/.exec(c);
  if (m) return Number(m[1].replace(',', '.')) / 1000;
  const ub = String(unitBase || '').trim().toUpperCase();
  if (ub === 'KG') return 1;
  const gb = /^(\d+(?:\.\d+)?)$/.exec(ub);
  if (gb) return Number(gb[1]) / 1000;
  return null;
}
// kind del producto SOLO desde el catálogo (estable, sin mirar ventas):
// peso si la unidad de venta o la unidad base lo indican; si no, pieza.
function productKind(unitSale, unitBase) {
  const us = String(unitSale || '').trim().toUpperCase();
  if (us === 'KGS' || us === 'KG') return 'weight';
  const ub = String(unitBase || '').trim().toUpperCase();
  if (WEIGHT_U.has(ub) || /^\d+(\.\d+)?$/.test(ub)) return 'weight';
  return 'piece';
}
// Convierte `cant` de la unidad `u` al canónico del producto. Devuelve
// { qty, ok }: ok=false si no se pudo convertir (se cuenta y se deja crudo).
function toCanonical(kind, u, cant, model) {
  if (kind === 'weight') {
    const k = kgFromUnit(u);
    if (k != null) return { qty: cant * k, ok: true };
    if (model.gk != null) return { qty: cant * model.gk, ok: true }; // PAQ/PZA/CUB/BTO → gramaje
    return { qty: cant, ok: false };
  }
  if (u === 'PZA' || u === 'PZ' || u === 'PIEZA') return { qty: cant, ok: true };
  if (u === 'PAQ') return { qty: cant * (model.packF || 1), ok: true };
  if (u === 'CJA') return { qty: cant * (model.boxF || 1), ok: true };
  // unidad de peso en un producto de pieza (raro) → sin conversión limpia
  return { qty: cant, ok: false };
}

(async () => {
  const src = new Client({ connectionString: SRC });
  const db = new Client({ connectionString: DST });
  await src.connect();
  await db.connect();
  try {
    console.log(`\n=== Fact de ventas → analytics.sales_daily (BULK, ${APPLY ? 'APPLY' : 'DRY-RUN'}, ${MONTHS}m) ===\n`);

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
      const kind = productKind(p.unit_sale, p.unit_base);
      const packF = Number(p.pack_size) > 1 ? Number(p.pack_size) : (Number(p.factor_sale) > 1 ? Number(p.factor_sale) : 1);
      const boxF = Number(p.box_size) > 1 ? Number(p.box_size) : (Number(p.factor_sale) > 1 ? Number(p.factor_sale) : 1);
      skuTo.set(p.sku, { id: p.id, markup_pct: p.markup_pct, kind, packF, boxF, gk: gramajeKg(p.content, p.unit_base) });
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
        WHERE fecha >= current_date - interval '${MONTHS} months'
          AND NOT (almacen = '01' AND fecha < DATE '2026-07-01')
        GROUP BY almacen, sku, channel, fecha, upper(btrim(coalesce(unidad,'')))`);
    // Tickets: aparte, SIN unidad, para no sobrecontar folios con varias unidades.
    const { rows: tk } = await src.query(
      `SELECT almacen, sku, channel, fecha, count(DISTINCT folio)::int AS tickets
         FROM mart.ventas_enriched
        WHERE fecha >= current_date - interval '${MONTHS} months'
          AND NOT (almacen = '01' AND fecha < DATE '2026-07-01')
        GROUP BY almacen, sku, channel, fecha`);
    const tkMap = new Map(tk.map((r) => [`${r.almacen}|${r.sku}|${r.channel}|${r.fecha.toISOString().slice(0,10)}`, r.tickets]));
    console.log(`  origen: ${agg.length} filas (almacen×sku×canal×día×unidad) · ${tk.length} grupos de tickets`);

    // Transform: convertir cada bucket de unidad → canónico y RE-AGREGAR por
    // (product, warehouse, channel, fecha). cost = revenue/(1+markup/100) al final.
    const acc = new Map(); // key → { pid, wid, channel, fecha, sku, almacen, markup, units, revenue, kind }
    let noSku = 0, noWh = 0, unconv = 0;
    for (const r of agg) {
      const p = skuTo.get(r.sku);
      if (!p) { noSku++; continue; }
      const wid = whTo.get(r.almacen);
      if (!wid) { noWh++; continue; }
      const conv = toCanonical(p.kind, r.unidad, Number(r.cant), p);
      if (!conv.ok) unconv++;
      const fecha = r.fecha.toISOString().slice(0, 10);
      const key = `${p.id}|${wid}|${r.channel}|${fecha}`;
      let a = acc.get(key);
      if (!a) {
        a = { pid: p.id, wid, channel: r.channel, fecha, sku: r.sku, almacen: r.almacen,
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
    // Refresco full de la ventana: borra + reinserta (agrupado por si hay sku
    // duplicados que colapsan al mismo product_id → evita violar el unique).
    // Scope del DELETE a canales KEPLER (NOT LIKE 'wincaja%'): este feed solo refresca
    // su propia venta. Sin esto borraba TODA la ventana incluyendo los canales wincaja_*
    // → si Kepler corría después de import-wincaja-analytics, dejaba a Wincaja en 0 hasta
    // el próximo sync (causa raíz del "sell-out no muestra Wincaja"). Ahora son independientes.
    await db.query(
      `DELETE FROM analytics.sales_daily WHERE tenant_id=$1 AND sale_date >= current_date - interval '${MONTHS} months' AND channel NOT LIKE 'wincaja%'`, [M]);
    const up = await db.query(
      `INSERT INTO analytics.sales_daily
         (id, tenant_id, product_id, warehouse_id, channel, sale_date, units, revenue, cost, tickets, unit_kind, updated_at)
       SELECT gen_random_uuid(), $1, product_id, warehouse_id, channel, sale_date,
              sum(units), sum(revenue), sum(cost), sum(tickets), max(unit_kind), now()
         FROM stg_sf
        GROUP BY product_id, warehouse_id, channel, sale_date`, [M]);
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
