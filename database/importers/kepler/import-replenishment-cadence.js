/* eslint-disable no-console */
/**
 * RA-PRO.8 — Deriva CANAL + CADENCIA de reabasto por (almacén × proveedor) desde el
 * histórico `analytics.stock_movements` → `commercial.replenishment_channel`.
 * Ver reference_kepler_supply_network_topology.
 *
 * Señales (movement_kind='entrada'):
 *   compra   = (genero='X' AND doc_type='40')  [Orden de entrada X-A-40]  OR  doc_code='WIN_C'  [Wincaja]
 *   traspaso = (doc_type='50' AND doc_code='TrsfRcv')  [Recepción de traspaso U-A-50]
 *   (se excluyen ajustes WIN_E, devoluciones WIN_D, inventario físico PhysInvIn)
 *
 * Lógica:
 *   1. Topología: fija warehouses.source_warehouse_id de los spokes confirmados (solo si está NULL).
 *   2. Canal dominante por (almacén×proveedor) = el que más días de entrega tiene en la VENTANA RECIENTE
 *      (evita que el histórico pre-switch contamine; ej. La Piedad cambió compra→traspaso en abr-2026).
 *   3. Cadencia = mediana del gap entre días de entrega:
 *        · compra   → per (almacén×proveedor), ventana larga (estabilidad).
 *        · traspaso → per ALMACÉN (todos los proveedores viajan en el mismo camión ~3d); source = el hub.
 *   4. next_due = last_delivery + cadencia. Banda: ≤7 rápida · ≤14 promedio · >14 mal_abasto (informativa;
 *      el detector real cruza con rotación).
 *
 * UPSERT idempotente; NUNCA pisa filas cadence_source='manual' (override de coordinadora/analistas).
 *
 *   node database/importers/kepler/import-replenishment-cadence.js          # dry-run (ROLLBACK)
 *   node database/importers/kepler/import-replenishment-cadence.js --apply  # commit
 */

const { Client } = require('pg');

const M = process.env.WINCAJA_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const SSL = /@(localhost|127\.0\.0\.1|192\.168\.)/.test(DST) ? false : { rejectUnauthorized: false };

const CLASS_WIN = Number(process.env.RA8_CLASS_WINDOW || 120); // clasificación de canal (reciente)
const PURCH_WIN = Number(process.env.RA8_PURCH_WINDOW || 365); // cadencia de compra (estabilidad)
const TRSF_WIN = Number(process.env.RA8_TRSF_WINDOW || 120);   // cadencia de traspaso (ritmo actual)
const MIN_GAPS = Number(process.env.RA8_MIN_GAPS || 2);        // ≥2 gaps (≥3 entregas) para una mediana

// Spokes confirmados con datos → hub. Solo se aplica si source_warehouse_id está NULL (respeta override).
const TOPOLOGY = { '02': '01', '03': '01', '04': '01', '05': 'MD-50' };

const PURCH = `((sm.genero='X' AND sm.doc_type='40') OR sm.doc_code='WIN_C')`;
const TRSF = `(sm.doc_type='50' AND sm.doc_code='TrsfRcv')`;
const REALWH = `w.deleted_at IS NULL AND w.kind<>'truck' AND w.code !~ '^(INV|TEAMWH|EXPALERT|SOLDEXP|TRUCK)'`;

(async () => {
  const db = new Client({ connectionString: DST, ssl: SSL });
  await db.connect();
  try {
    console.log(`\n=== RA-PRO.8: canal + cadencia de reabasto (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`);
    console.log(`  ventanas: clasif=${CLASS_WIN}d compra=${PURCH_WIN}d traspaso=${TRSF_WIN}d · min_gaps=${MIN_GAPS}\n`);

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);

    // ── 1. Topología (source_warehouse_id de spokes, solo si NULL) ──────────
    let topoSet = 0;
    for (const [spoke, hub] of Object.entries(TOPOLOGY)) {
      const r = await db.query(
        `UPDATE commercial.warehouses spoke
            SET source_warehouse_id = hub.id, updated_at = now()
           FROM commercial.warehouses hub
          WHERE spoke.tenant_id=$1 AND hub.tenant_id=$1 AND spoke.code=$2 AND hub.code=$3
            AND spoke.deleted_at IS NULL AND spoke.source_warehouse_id IS NULL`, [M, spoke, hub]);
      if (r.rowCount) { topoSet += r.rowCount; console.log(`  topología: ${spoke} ← ${hub} (fijado)`); }
    }
    if (!topoSet) console.log('  topología: sin cambios (ya configurada o spokes inexistentes)');

    // ── 2-4. Deriva canal+cadencia y UPSERT ────────────────────────────────
    const derive = `
      WITH recent AS (
        SELECT DISTINCT w.id AS warehouse_id, p.supplier_id,
               CASE WHEN ${PURCH} THEN 'purchase' WHEN ${TRSF} THEN 'transfer' END AS channel, sm.doc_date
          FROM analytics.stock_movements sm
          JOIN catalog.products p ON p.tenant_id=sm.tenant_id AND p.id=sm.product_id
          JOIN commercial.warehouses w ON w.tenant_id=sm.tenant_id AND w.id=sm.warehouse_id
         WHERE sm.tenant_id=$1 AND sm.movement_kind='entrada' AND (${PURCH} OR ${TRSF})
           AND sm.doc_date >= CURRENT_DATE - ${CLASS_WIN} AND ${REALWH} AND p.supplier_id IS NOT NULL
      ), dom AS (
        SELECT warehouse_id, supplier_id, channel,
               row_number() OVER (PARTITION BY warehouse_id, supplier_id ORDER BY count(*) DESC, channel) rn
          FROM recent GROUP BY warehouse_id, supplier_id, channel
      ), chan AS (SELECT warehouse_id, supplier_id, channel FROM dom WHERE rn=1),
      pdays AS (
        SELECT DISTINCT w.id AS warehouse_id, p.supplier_id, sm.doc_date
          FROM analytics.stock_movements sm
          JOIN catalog.products p ON p.tenant_id=sm.tenant_id AND p.id=sm.product_id
          JOIN commercial.warehouses w ON w.tenant_id=sm.tenant_id AND w.id=sm.warehouse_id
         WHERE sm.tenant_id=$1 AND sm.movement_kind='entrada' AND ${PURCH}
           AND sm.doc_date >= CURRENT_DATE - ${PURCH_WIN} AND ${REALWH} AND p.supplier_id IS NOT NULL
      ), pgap AS (
        SELECT warehouse_id, supplier_id, doc_date,
               (doc_date - LAG(doc_date) OVER (PARTITION BY warehouse_id, supplier_id ORDER BY doc_date))::int gap
          FROM pdays
      ), pcad AS (
        SELECT warehouse_id, supplier_id, count(*)::int n_days, max(doc_date) last_day,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) FILTER (WHERE gap IS NOT NULL) med,
               avg(gap) FILTER (WHERE gap IS NOT NULL) avgg,
               min(gap) FILTER (WHERE gap IS NOT NULL) mng, max(gap) FILTER (WHERE gap IS NOT NULL) mxg,
               count(*) FILTER (WHERE gap IS NOT NULL) ngaps
          FROM pgap GROUP BY warehouse_id, supplier_id
      ), tdays AS (
        SELECT DISTINCT w.id AS warehouse_id, sm.doc_date
          FROM analytics.stock_movements sm
          JOIN commercial.warehouses w ON w.tenant_id=sm.tenant_id AND w.id=sm.warehouse_id
         WHERE sm.tenant_id=$1 AND sm.movement_kind='entrada' AND ${TRSF}
           AND sm.doc_date >= CURRENT_DATE - ${TRSF_WIN} AND ${REALWH}
      ), tgap AS (
        SELECT warehouse_id, doc_date,
               (doc_date - LAG(doc_date) OVER (PARTITION BY warehouse_id ORDER BY doc_date))::int gap FROM tdays
      ), tcad AS (
        SELECT warehouse_id, count(*)::int n_days, max(doc_date) last_day,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) FILTER (WHERE gap IS NOT NULL) med,
               avg(gap) FILTER (WHERE gap IS NOT NULL) avgg,
               min(gap) FILTER (WHERE gap IS NOT NULL) mng, max(gap) FILTER (WHERE gap IS NOT NULL) mxg,
               count(*) FILTER (WHERE gap IS NOT NULL) ngaps
          FROM tgap GROUP BY warehouse_id
      ), derived AS (
        SELECT c.warehouse_id, c.supplier_id, c.channel AS via,
               CASE WHEN c.channel='transfer' THEN w.source_warehouse_id END AS source_warehouse_id,
               CASE WHEN c.channel='purchase' THEN pc.med  ELSE tc.med  END AS cadence_days,
               CASE WHEN c.channel='purchase' THEN pc.avgg ELSE tc.avgg END AS avg_gap,
               CASE WHEN c.channel='purchase' THEN pc.mng  ELSE tc.mng  END AS min_gap,
               CASE WHEN c.channel='purchase' THEN pc.mxg  ELSE tc.mxg  END AS max_gap,
               CASE WHEN c.channel='purchase' THEN pc.ngaps ELSE tc.ngaps END AS ngaps,
               CASE WHEN c.channel='purchase' THEN pc.n_days ELSE tc.n_days END AS n_deliveries,
               CASE WHEN c.channel='purchase' THEN pc.last_day ELSE tc.last_day END AS last_delivery_date,
               s.lead_time_days
          FROM chan c
          JOIN commercial.warehouses w ON w.tenant_id=$1 AND w.id=c.warehouse_id
          LEFT JOIN catalog.suppliers s ON s.tenant_id=$1 AND s.id=c.supplier_id
          LEFT JOIN pcad pc ON pc.warehouse_id=c.warehouse_id AND pc.supplier_id=c.supplier_id
          LEFT JOIN tcad tc ON tc.warehouse_id=c.warehouse_id
      )
      SELECT warehouse_id, supplier_id, via, source_warehouse_id,
             CASE WHEN ngaps >= ${MIN_GAPS} THEN round(cadence_days::numeric,1) END AS cadence_days,
             CASE WHEN ngaps >= ${MIN_GAPS} THEN round(avg_gap::numeric,1) END AS avg_gap,
             CASE WHEN ngaps >= ${MIN_GAPS} THEN min_gap END AS min_gap,
             CASE WHEN ngaps >= ${MIN_GAPS} THEN max_gap END AS max_gap,
             COALESCE(n_deliveries,0) AS n_deliveries, last_delivery_date, lead_time_days
        FROM derived`;

    const ins = await db.query(
      `INSERT INTO commercial.replenishment_channel
         (id, tenant_id, warehouse_id, supplier_id, via, source_warehouse_id, cadence_days, cadence_source,
          avg_gap_days, min_gap_days, max_gap_days, n_deliveries, last_delivery_date, next_due_date,
          lead_time_days, health_band, computed_at, updated_at)
       SELECT gen_random_uuid(), $1, d.warehouse_id, d.supplier_id, d.via, d.source_warehouse_id,
              d.cadence_days, 'derived', d.avg_gap, d.min_gap, d.max_gap, d.n_deliveries, d.last_delivery_date,
              CASE WHEN d.cadence_days IS NOT NULL AND d.last_delivery_date IS NOT NULL
                   THEN d.last_delivery_date + ceil(d.cadence_days)::int END,
              d.lead_time_days,
              CASE WHEN d.cadence_days IS NULL THEN NULL WHEN d.cadence_days<=7 THEN 'rapida'
                   WHEN d.cadence_days<=14 THEN 'promedio' ELSE 'mal_abasto' END,
              now(), now()
         FROM (${derive}) d
       ON CONFLICT (tenant_id, warehouse_id, supplier_id) DO UPDATE
         SET via=EXCLUDED.via, source_warehouse_id=EXCLUDED.source_warehouse_id, cadence_days=EXCLUDED.cadence_days,
             avg_gap_days=EXCLUDED.avg_gap_days, min_gap_days=EXCLUDED.min_gap_days, max_gap_days=EXCLUDED.max_gap_days,
             n_deliveries=EXCLUDED.n_deliveries, last_delivery_date=EXCLUDED.last_delivery_date,
             next_due_date=EXCLUDED.next_due_date, health_band=EXCLUDED.health_band, computed_at=now(), updated_at=now()
         WHERE commercial.replenishment_channel.cadence_source='derived'`, [M]);
    console.log(`  filas replenishment_channel (insert+update derived): ${ins.rowCount}`);

    // ── Resumen (dentro de la tx: visible aún en dry-run) ───────────────────
    const { rows: sum } = await db.query(
      `SELECT via, count(*)::int n,
              count(*) FILTER (WHERE cadence_days IS NOT NULL)::int con_cad,
              count(*) FILTER (WHERE health_band='rapida')::int rapida,
              count(*) FILTER (WHERE health_band='promedio')::int promedio,
              count(*) FILTER (WHERE health_band='mal_abasto')::int mal
         FROM commercial.replenishment_channel WHERE tenant_id=$1 GROUP BY via ORDER BY via`, [M]);
    console.log('\n  Canal        pares  con_cadencia  rápida  promedio  mal_abasto');
    for (const s of sum) console.log(`   ${s.via.padEnd(10)} ${String(s.n).padStart(5)} ${String(s.con_cad).padStart(12)} ${String(s.rapida).padStart(7)} ${String(s.promedio).padStart(9)} ${String(s.mal).padStart(10)}`);

    const { rows: byWh } = await db.query(
      `SELECT w.code, rc.via, count(*)::int n, round(avg(rc.cadence_days)::numeric,1) cad_prom
         FROM commercial.replenishment_channel rc
         JOIN commercial.warehouses w ON w.tenant_id=rc.tenant_id AND w.id=rc.warehouse_id
        WHERE rc.tenant_id=$1 GROUP BY w.code, rc.via ORDER BY w.code, rc.via`, [M]);
    console.log('\n  Por almacén:');
    for (const r of byWh) console.log(`   ${r.code.padEnd(7)} ${r.via.padEnd(9)} pares=${String(r.n).padStart(4)} cad_prom=${r.cad_prom ?? '—'}d`);

    // muestra de "qué toca hoy/pronto" (next_due más próximo)
    const { rows: due } = await db.query(
      `SELECT w.code, s.name, rc.via, rc.cadence_days, rc.last_delivery_date, rc.next_due_date
         FROM commercial.replenishment_channel rc
         JOIN commercial.warehouses w ON w.tenant_id=rc.tenant_id AND w.id=rc.warehouse_id
         LEFT JOIN catalog.suppliers s ON s.tenant_id=rc.tenant_id AND s.id=rc.supplier_id
        WHERE rc.tenant_id=$1 AND rc.next_due_date IS NOT NULL
        ORDER BY rc.next_due_date ASC LIMIT 8`, [M]);
    console.log('\n  Muestra "próximos a tocar" (next_due):');
    for (const r of due) console.log(`   ${String(r.next_due_date?.toISOString?.().slice(0,10))} ${r.code.padEnd(6)} ${String(r.name||'').slice(0,26).padEnd(26)} ${r.via} cad=${r.cadence_days}d (últ ${r.last_delivery_date?.toISOString?.().slice(0,10)})`);

    if (!APPLY) { await db.query('ROLLBACK'); console.log('\n[DRY-RUN] ROLLBACK — nada cambió.'); }
    else { await db.query('COMMIT'); console.log('\n[APPLY] COMMIT.'); }
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally { await db.end(); }
})();
