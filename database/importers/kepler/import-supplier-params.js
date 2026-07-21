/* eslint-disable no-console */
/**
 * RA-PRO.10 — Deriva los PARÁMETROS DE PEDIDO por proveedor (catalog.suppliers) desde el histórico
 * de compras en analytics.stock_movements, y rellena /compras/proveedores sin captura manual.
 *
 * PROBLEMA que resuelve: los params (cadencia override / colchón / mínimo $/cajas) estaban vacíos.
 * Capturarlos a mano en ~300 proveedores es inviable.
 *
 * FÓRMULA (validada contra GONAC = 13d/7d/$214k, que coincide con el ajuste manual real):
 *   1. "Orden" = recibo de compra (X-A-40 / WIN_C). Se agrupan recibos a ≤MERGE_GAP días en un
 *      EPISODIO (una orden; corrige las entregas partidas que inflan la frecuencia a ~1/día).
 *   2. Se clusteriza POR (proveedor × almacén) — NO por proveedor, que sumaría toda la red y
 *      sobrestima el pedido (GONAC salía $613k de red vs $214k real de una sucursal).
 *   3. El proveedor toma su ALMACÉN DE MAYOR VOLUMEN como representativo (su punto de compra real).
 *   4. cadence_days_override = mediana del gap entre episodios, acotado [3,45].
 *      colchon_days        = stddev de los gaps (o 40% de cadencia), acotado [1,14].
 *      min_order_amount    = pedido típico $  (promedio de episodios ≥ mediana → sin migajas).
 *      min_order_boxes     = pedido típico en cajas (piezas/caja = factor_sale; factor_purchase roto).
 *   Requiere ≥3 episodios en el almacén principal (≥2 gaps para una mediana estable).
 *
 * IDEMPOTENTE + NO PISA CAPTURA MANUAL: cada columna se llena con COALESCE(existente, derivado),
 * así que solo rellena los NULL. Re-correrlo completa lo que falte sin borrar lo ajustado a mano.
 * lead_time_days NO se deriva (Kepler no lo codifica; queda manual, RA-PRO.3).
 *
 *   node database/importers/kepler/import-supplier-params.js          # dry-run (ROLLBACK)
 *   node database/importers/kepler/import-supplier-params.js --apply  # commit
 *
 * Env: DATABASE_URL_NEW (destino).
 */
const { Client } = require('pg');

const M = process.env.WINCAJA_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const SSL = /@(localhost|127\.0\.0\.1|192\.168\.)/.test(DST) ? false : { rejectUnauthorized: false };

const MERGE_GAP = Number(process.env.RA10_MERGE_GAP || 3);   // recibos a ≤N días = mismo pedido
const MONTHS = Number(process.env.RA10_MONTHS || 18);        // ventana de historia
const MIN_EPISODES = Number(process.env.RA10_MIN_EPISODES || 3);
const CAD_LO = 3, CAD_HI = 45, COLC_LO = 1, COLC_HI = 14;
const DAY = 86400000;

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

(async () => {
  const db = new Client({ connectionString: DST, ssl: SSL });
  await db.connect();
  console.log(`\n=== RA-PRO.10: derivar params de pedido por proveedor (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`);
  console.log(`  target ${DST.split('@')[1] || DST} · merge=${MERGE_GAP}d · ventana=${MONTHS}m · min_episodios=${MIN_EPISODES}\n`);
  try {
    // uxc canónico (piezas/caja): factor_sale si >1, si no box_size de la etiquetera, si no 1.
    // Mismo criterio que analytics.sales_boxes_monthly → cajas consistentes en toda la app.
    const { rows } = await db.query(`
      SELECT pr.supplier_id AS sid, m.warehouse_id AS wid, m.doc_date::date AS d,
             sum(m.qty * m.unit_cost) AS amount,
             sum(m.qty / GREATEST(CASE WHEN pr.factor_sale > 1 THEN pr.factor_sale
                                       WHEN lbl.bs > 1 THEN lbl.bs ELSE 1 END, 1)) AS cajas,
             sum(m.qty) AS pz
        FROM analytics.stock_movements m
        JOIN catalog.products pr ON pr.tenant_id=m.tenant_id AND pr.id=m.product_id
        LEFT JOIN (SELECT tenant_id, product_id, max(box_size) bs FROM commercial.product_label_prices GROUP BY tenant_id, product_id) lbl
          ON lbl.tenant_id=pr.tenant_id AND lbl.product_id=pr.id
       WHERE m.tenant_id=$1 AND m.movement_kind='entrada'
         AND ((m.genero='X' AND m.doc_type='40') OR m.doc_code='WIN_C')
         AND pr.supplier_id IS NOT NULL AND m.doc_date >= CURRENT_DATE - ($2 || ' months')::interval
       GROUP BY pr.supplier_id, m.warehouse_id, m.doc_date::date
       ORDER BY pr.supplier_id, m.warehouse_id, m.doc_date::date`, [M, String(MONTHS)]);

    // Cluster por (proveedor × almacén) en episodios
    const sw = new Map();
    for (const x of rows) { const k = `${x.sid}|${x.wid}`; if (!sw.has(k)) sw.set(k, { sid: x.sid, recs: [] }); sw.get(k).recs.push({ d: new Date(x.d), amount: +x.amount || 0, cajas: +x.cajas || 0, pz: +x.pz || 0 }); }
    const avgBig = (arr) => { const m = median(arr) ?? 0; const big = arr.filter((v) => v >= m); return big.length ? big.reduce((a, b) => a + b, 0) / big.length : m; };
    const perSup = new Map();
    for (const { sid, recs } of sw.values()) {
      const eps = []; let cur = null;
      for (const x of recs) { if (cur && (x.d - cur.end) / DAY <= MERGE_GAP) { cur.end = x.d; cur.amount += x.amount; cur.cajas += x.cajas; cur.pz += x.pz; } else { cur = { start: x.d, end: x.d, amount: x.amount, cajas: x.cajas, pz: x.pz }; eps.push(cur); } }
      if (eps.length < MIN_EPISODES) continue;
      const gaps = []; for (let i = 1; i < eps.length; i++) gaps.push((eps[i].start - eps[i - 1].start) / DAY);
      const mean = gaps.reduce((a, b) => a + b, 0) / (gaps.length || 1);
      const gapSd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / (gaps.length || 1));
      const rep = {
        cadence: median(gaps), gapSd,
        typicalAmt: avgBig(eps.map((e) => e.amount).filter((a) => a > 0)),
        typicalCaj: avgBig(eps.map((e) => e.cajas).filter((c) => c > 0)),
        typicalPz: avgBig(eps.map((e) => e.pz).filter((p) => p > 0)),
        volume: eps.reduce((a, e) => a + e.amount, 0),
      };
      if (!perSup.has(sid)) perSup.set(sid, []); perSup.get(sid).push(rep);
    }

    const derived = [];
    let boxesSkipped = 0;
    for (const [sid, whs] of perSup) {
      const top = whs.sort((a, b) => b.volume - a.volume)[0];
      if (top.cadence == null) continue;
      // factor efectivo del proveedor (piezas/caja real); si ≈1, factor_sale falta → cajas = piezas (basura) → no llenar min_order_boxes
      const effFactor = top.typicalCaj > 0 ? top.typicalPz / top.typicalCaj : 1;
      const minCaj = effFactor >= 1.5 ? Math.max(1, Math.round(top.typicalCaj)) : null;
      if (minCaj == null) boxesSkipped++;
      derived.push({
        sid,
        cadence: clamp(Math.round(top.cadence), CAD_LO, CAD_HI),
        colchon: clamp(Math.round(top.gapSd || top.cadence * 0.4), COLC_LO, COLC_HI),
        minAmt: Math.round(top.typicalAmt),
        minCaj,
      });
    }
    console.log(`  (min_order_boxes omitido en ${boxesSkipped} por factor_sale ausente → cajas poco confiables)`);
    console.log(`  proveedores con params derivables: ${derived.length}`);

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    let filledCad = 0, filledColc = 0, filledA = 0, filledB = 0, touched = 0;
    for (const d of derived) {
      const res = await db.query(`
        UPDATE catalog.suppliers SET
          cadence_days_override = COALESCE(cadence_days_override, $2),
          colchon_days          = COALESCE(colchon_days, $3),
          min_order_amount      = COALESCE(min_order_amount, $4),
          min_order_boxes       = COALESCE(min_order_boxes, $5),
          updated_at = now()
        WHERE tenant_id=$1 AND id=$6 AND deleted_at IS NULL
          AND (cadence_days_override IS NULL OR colchon_days IS NULL OR min_order_amount IS NULL OR min_order_boxes IS NULL)
        RETURNING cadence_days_override, colchon_days, min_order_amount, min_order_boxes`,
        [M, d.cadence, d.colchon, d.minAmt, d.minCaj, d.sid]);
      if (res.rowCount) touched++;
    }
    // Conteo de columnas que quedaron llenas por el proceso (aprox: cuántos NULL había)
    const cov = (await db.query(`
      SELECT count(*) FILTER (WHERE cadence_days_override IS NOT NULL) cad,
             count(*) FILTER (WHERE colchon_days IS NOT NULL) colc,
             count(*) FILTER (WHERE min_order_amount IS NOT NULL) mina,
             count(*) FILTER (WHERE min_order_boxes IS NOT NULL) minb,
             count(*) total
        FROM catalog.suppliers WHERE tenant_id=$1 AND deleted_at IS NULL`, [M])).rows[0];
    console.log(`  proveedores actualizados: ${touched}`);
    console.log(`  cobertura ahora → cadencia ${cov.cad}/${cov.total} · colchón ${cov.colc} · mín$ ${cov.mina} · mínCajas ${cov.minb}`);

    // Muestra
    const sample = await db.query(`
      SELECT code, name, cadence_days_override cad, colchon_days colc, min_order_amount mina, min_order_boxes minb
        FROM catalog.suppliers WHERE tenant_id=$1 AND deleted_at IS NULL AND cadence_days_override IS NOT NULL
       ORDER BY min_order_amount DESC NULLS LAST LIMIT 10`, [M]);
    console.log('\n  Muestra (top por mín $):');
    sample.rows.forEach((r) => console.log(`    ${(r.code || '').padEnd(6)} cad ${String(r.cad).padStart(2)}d · colc ${String(r.colc).padStart(2)}d · mín $${Number(r.mina || 0).toLocaleString().padStart(10)} / ${String(r.minb).padStart(5)} cajas · ${(r.name || '').slice(0, 28)}`));

    if (APPLY) { await db.query('COMMIT'); console.log('\n[APPLY] COMMIT.'); }
    else { await db.query('ROLLBACK'); console.log('\n[DRY-RUN] ROLLBACK — usar --apply para aplicar.'); }
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
