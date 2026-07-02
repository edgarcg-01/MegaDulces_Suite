/* eslint-disable no-console */
/**
 * T.2/T.6 — Feed de MOVIMIENTOS que NO son venta (traspasos / consolidación) por
 * sucursal × tipo × destino × mes → Railway (analytics.transfers_monthly). Base del
 * apartado /logistica/traspasos. Mantiene estos docs FUERA de venta.
 *
 * Tipos (kind) y su doc Kepler (kdm1.c2/c3/c4):
 *   salida_cedis     = U/D/13 en CEDIS (md_00): SALIDA a un destino (dest_label del
 *                      catálogo kdud: P.V./TLMKT/RUTA). El flujo real CEDIS→sucursal.
 *   consolidacion    = U/D/6  (serie UD06, CONTADO, sin destino) — causaba el ×2 en venta
 *   recepcion        = U/A/50 ("Recepción Traspaso Suc") — lado receptor
 *   traspaso_salida  = N/D/6, N/D/25 (Salida Traspaso Sucursal/almacén)
 *   traspaso_entrada = N/A/6, N/A/25 (Entrada Traspaso Sucursal/almacén)
 *
 * `dest_label` solo para salida_cedis (destino real); '' en el resto. OJO: NO sumar
 * salida_cedis + recepcion (mismo bien contado 2 veces — son origen y lado receptor).
 *
 * Lee los 6 servidores Kepler de sucursal EN VIVO (192.168.x). Como purgan historia,
 * el upsert es ACUMULATIVO con GREATEST. Aditivo. NO usa mart.ventas ni toca ventas.
 *
 *   DST_URL=…railway node database/importers/kepler/import-transfers-monthly.js          # dry-run
 *   DST_URL=…             node database/importers/kepler/import-transfers-monthly.js --apply
 *   ... [--year 2026]
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
// --reset: borra las filas del tenant antes de insertar (base 100% limpia). Solo
// para corrida puntual; el nightly corre SIN --reset (UPSERT-acumulativo GREATEST).
const RESET = process.argv.includes('--reset');
const yi = process.argv.indexOf('--year');
const YEAR = yi !== -1 ? Number(process.argv[yi + 1]) : new Date().getFullYear();

const BRANCHES = process.env.SALES_BRANCH_MAP
  ? JSON.parse(process.env.SALES_BRANCH_MAP)
  : [
      { code: '00', host: '192.168.9.95', port: 5432, db: 'md_00' },
      { code: '01', host: '192.168.10.10', port: 1977, db: 'md_01' },
      { code: '02', host: '192.168.42.42', port: 5432, db: 'md_02' },
      { code: '03', host: '192.168.40.40', port: 5432, db: 'md_03' },
      { code: '04', host: '192.168.44.44', port: 5432, db: 'md_04' },
      { code: '05', host: '192.168.54.54', port: 5432, db: 'md_05' },
    ];

const KIND = `CASE
  WHEN h.c2='U' AND h.c3='D' AND h.c4=13 THEN 'salida_cedis'
  WHEN h.c2='U' AND h.c3='D' AND h.c4=6  THEN 'consolidacion'
  WHEN h.c2='U' AND h.c3='A' AND h.c4=50 THEN 'recepcion'
  WHEN h.c2='N' AND h.c3='D' AND h.c4 IN (6,25) THEN 'traspaso_salida'
  WHEN h.c2='N' AND h.c3='A' AND h.c4 IN (6,25) THEN 'traspaso_entrada'
END`;
const WHERE_TRANSFER = `(
  (h.c2='U' AND h.c3='D' AND h.c4=13) OR
  (h.c2='U' AND h.c3='D' AND h.c4=6) OR
  (h.c2='U' AND h.c3='A' AND h.c4=50) OR
  (h.c2='N' AND h.c4 IN (6,25))
)`;

(async () => {
  const db = new Client({
    connectionString: DST,
    ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false,
  });
  await db.connect();
  try {
    console.log(`\n=== TRASPASOS mensuales → analytics.transfers_monthly (${APPLY ? 'APPLY' : 'DRY-RUN'}, año ${YEAR}) ===\n`);

    await db.query(`CREATE SCHEMA IF NOT EXISTS analytics`);
    await db.query(`CREATE TABLE IF NOT EXISTS analytics.transfers_monthly (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      warehouse_id uuid NOT NULL, kind text NOT NULL, dest_label text NOT NULL DEFAULT '',
      month date NOT NULL, units numeric NOT NULL DEFAULT 0, value numeric NOT NULL DEFAULT 0,
      docs integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now())`);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_transfers_monthly ON analytics.transfers_monthly (tenant_id, warehouse_id, kind, dest_label, month)`);

    const whs = (await db.query(`SELECT id, code FROM commercial.warehouses WHERE tenant_id=$1`, [M])).rows;
    const whTo = new Map(whs.map((w) => [w.code, w.id]));
    console.log(`  lookup: ${whTo.size} warehouses`);

    const from = `${YEAR}-01-01`;
    const to = `${YEAR + 1}-01-01`;
    const all = []; // [warehouse_id, kind, dest_label, month, units, value, docs]

    for (const b of BRANCHES) {
      const wid = whTo.get(b.code);
      if (!wid) { console.log(`  ⚠️  sucursal ${b.code} sin warehouse en destino — skip`); continue; }
      const src = new Client({ host: b.host, port: b.port, database: b.db, user: 'platform_ro', password: 'kepler123', connectionTimeoutMillis: 8000, statement_timeout: 180000 });
      const t0 = Date.now();
      try {
        await src.connect();
        const DEST = `CASE WHEN h.c2='U' AND h.c3='D' AND h.c4=13 THEN coalesce(cat.c3, h.c10) ELSE '' END`;
        const CAT = `LEFT JOIN (SELECT DISTINCT ON (c2) c2, c3 FROM md.kdud ORDER BY c2) cat ON cat.c2 = h.c10`;
        const mkey = (m) => (m instanceof Date ? m.toISOString().slice(0, 10) : String(m));

        // A) VALOR + docs desde el HEADER (kdm1.c16). Correcto para todos los kinds,
        //    incl. U/D/13 (cuyo valor NO está en kdm2 sino en el header).
        const hq = await src.query(
          `SELECT ${KIND} AS kind, ${DEST} AS dest_label,
                  date_trunc('month', h.c9)::date AS mes,
                  count(DISTINCT h.c6) AS docs, sum(coalesce(h.c16,0))::numeric AS value
             FROM md.kdm1 h ${CAT}
            WHERE ${WHERE_TRANSFER} AND h.c9 >= $1 AND h.c9 < $2
            GROUP BY 1, 2, 3`, [from, to]);

        // B) UNIDADES desde kdm2 (donde haya líneas).
        const uq = await src.query(
          `SELECT ${KIND} AS kind, ${DEST} AS dest_label,
                  date_trunc('month', h.c9)::date AS mes, sum(coalesce(d.c9,0))::numeric AS units
             FROM md.kdm2 d
             JOIN md.kdm1 h ON h.c1=d.c1 AND h.c2=d.c2 AND h.c3=d.c3 AND h.c4=d.c4 AND h.c5=d.c5 AND h.c6=d.c6
             ${CAT}
            WHERE ${WHERE_TRANSFER} AND h.c9 >= $1 AND h.c9 < $2
              AND d.c8 NOT IN ('00001','00002') AND btrim(d.c8) <> ''
            GROUP BY 1, 2, 3`, [from, to]);

        const uMap = new Map(uq.rows.filter((r) => r.kind).map((r) => [`${r.kind}|${r.dest_label || ''}|${mkey(r.mes)}`, Number(r.units) || 0]));
        for (const r of hq.rows) {
          if (!r.kind) continue;
          const units = uMap.get(`${r.kind}|${r.dest_label || ''}|${mkey(r.mes)}`) || 0;
          all.push([wid, r.kind, r.dest_label || '', r.mes, units, Number(r.value) || 0, Number(r.docs) || 0]);
        }
        const val = hq.rows.reduce((a, r) => a + (Number(r.value) || 0), 0);
        const kinds = [...new Set(hq.rows.map((r) => r.kind).filter(Boolean))].join('/');
        console.log(`  ✅ ${b.db} (${b.code}): ${hq.rows.length} filas [${kinds || '-'}] · $${Math.round(val).toLocaleString()} (${Date.now() - t0}ms)`);
      } catch (e) {
        console.log(`  ❌ ${b.db} (${b.code}): ${e.message}`);
      } finally {
        try { await src.end(); } catch { /* noop */ }
      }
    }
    console.log(`\n  total a upsert: ${all.length} filas`);

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); return; }

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    if (RESET) {
      const del = await db.query(`DELETE FROM analytics.transfers_monthly WHERE tenant_id = $1`, [M]);
      console.log(`  [--reset] ${del.rowCount} filas previas borradas (base limpia, solo header).`);
    }
    const BATCH = 500;
    let upserts = 0;
    for (let i = 0; i < all.length; i += BATCH) {
      const chunk = all.slice(i, i + BATCH);
      const vals = chunk.map((_, ri) => { const b = ri * 8; return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8})`; });
      const params = []; chunk.forEach((row) => params.push(M, row[0], row[1], row[2], row[3], row[4], row[5], row[6]));
      const res = await db.query(
        `INSERT INTO analytics.transfers_monthly
           (tenant_id, warehouse_id, kind, dest_label, month, units, value, docs)
         VALUES ${vals.join(',')}
         ON CONFLICT (tenant_id, warehouse_id, kind, dest_label, month) DO UPDATE SET
           units = GREATEST(analytics.transfers_monthly.units, EXCLUDED.units),
           value = GREATEST(analytics.transfers_monthly.value, EXCLUDED.value),
           docs  = GREATEST(analytics.transfers_monthly.docs,  EXCLUDED.docs),
           updated_at = now()`, params);
      upserts += res.rowCount;
    }
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${upserts} filas upserted en analytics.transfers_monthly.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
