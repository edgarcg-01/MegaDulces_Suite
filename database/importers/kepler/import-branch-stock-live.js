/* eslint-disable no-console */
/**
 * Stock VIVO multi-sucursal → commercial.stock, en MODO INCREMENTAL (delta-only).
 *
 * Reemplaza/generaliza import-ph-stock-live.js (que era PH solo + per-fila).
 * Lee kdil de cada sucursal (READ-ONLY platform_ro), y sube al destino SOLO las
 * filas cuyo stock cambió desde la última corrida (snapshot local en disco).
 *
 * POR QUÉ INCREMENTAL: la versión previa hacía full-refresh (subir las ~49k filas
 * + UPDATE todo a 0 + reinsert) CADA corrida. Desde la LAN el destino se alcanza
 * por el proxy PÚBLICO de Railway (trolley.proxy.rlwy.net) → Railway factura ese
 * tráfico como EGRESS de la DB. Full-refresh cada minuto = ~200GB/mes de egress +
 * bloat salvaje (tuplas muertas). Subiendo solo deltas, el tráfico es proporcional
 * a las ventas del intervalo (casi nada fuera de horario).
 *
 * Snapshot: JSON local key `code|product_id` → qty, escrito solo tras COMMIT. Si
 * falta (primera corrida) o se pasa --full, sube todo (self-heal). Corré --full
 * periódicamente (p.ej. 1×/día) para reconciliar cualquier deriva.
 *
 * Robusto a fallos parciales: si una sucursal no conecta, sus productos NO se
 * tocan (ni se ponen en 0) y el snapshot conserva su último estado conocido.
 *
 * Mapeo code→sucursal (prod usa 01/02/03 = las operativas):
 *   01 Padre Hidalgo (PH) ← md_01 · 02 La Piedad Abastos ← md_02 · 03 8ESQ ← md_03
 * Override con env STOCK_BRANCH_MAP (JSON [{code,url}]).
 *
 *   node database/importers/kepler/import-branch-stock-live.js          # dry-run
 *   node database/importers/kepler/import-branch-stock-live.js --apply  # commit (delta)
 *   node database/importers/kepler/import-branch-stock-live.js --apply --full  # reconcilia todo
 */

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const FULL = process.argv.includes('--full');
const BATCH = 1000;
const SNAP_PATH = process.env.STOCK_SNAPSHOT_PATH || path.join(__dirname, '.stock-live-snapshot.json');
const MAP = process.env.STOCK_BRANCH_MAP
  ? JSON.parse(process.env.STOCK_BRANCH_MAP)
  : [
      { code: '00', url: 'postgresql://platform_ro:kepler123@192.168.9.95:5432/md_00' },
      { code: '01', url: 'postgresql://platform_ro:kepler123@192.168.10.10:1977/md_01' },
      { code: '02', url: 'postgresql://platform_ro:kepler123@192.168.42.42:5432/md_02' },
      { code: '03', url: 'postgresql://platform_ro:kepler123@192.168.40.40:5432/md_03' },
      { code: '04', url: 'postgresql://platform_ro:kepler123@192.168.44.44:5432/md_04' },
      { code: '05', url: 'postgresql://platform_ro:kepler123@192.168.54.54:5432/md_05' },
    ];

function loadSnap() {
  try { return JSON.parse(fs.readFileSync(SNAP_PATH, 'utf8')); } catch { return {}; }
}
function saveSnap(obj) {
  fs.writeFileSync(SNAP_PATH, JSON.stringify(obj));
}

(async () => {
  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    console.log(`\n=== Stock vivo multi-sucursal → commercial.stock (${FULL ? 'FULL' : 'INCREMENTAL'}, ${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

    const prods = (await db.query(`SELECT id, sku FROM public.products WHERE tenant_id=$1 AND btrim(coalesce(sku,''))<>''`, [M])).rows;
    const skuToId = new Map(prods.map((p) => [p.sku, p.id]));
    console.log(`  catálogo prod con sku: ${skuToId.size}`);

    // ── 1. Leer todas las sucursales (LAN, gratis) → estado deseado agregado ──
    const desired = new Map(); // `${code}|${pid}` → qty (sumado por sub-ubicaciones, clamp 0)
    const syncedCodes = new Set(); // sucursales leídas OK esta corrida
    const summary = [];
    for (const m of MAP) {
      let src;
      try {
        src = new Client({ connectionString: m.url, connectionTimeoutMillis: 6000, statement_timeout: 30000 });
        await src.connect();
      } catch (e) { console.log(`  ⚠ ${m.code}: sin conexión (${e.message}) — skip`); continue; }
      try {
        // Existencia Kepler = inicial(c4) + entradas(c8) − salidas(c9). NO c9 solo.
        // GOTCHA: kdil arrastra RÉPLICAS de otras sucursales (md_03 trae filas c1='02')
        // → filtrar SIEMPRE por la sucursal propia (derivada del dbname md_XX).
        const suc = (m.url.match(/md_(\d{2})\b/) || [])[1];
        if (!suc) { console.log(`  ⚠ ${m.code}: no pude derivar sucursal de la URL — skip`); continue; }
        const stock = (await src.query(`SELECT c3 AS sku, (c4+c8-c9)::numeric AS qty FROM md.kdil WHERE c3 IS NOT NULL AND c1 = $1`, [suc])).rows;
        let matched = 0, unmatched = 0;
        for (const r of stock) {
          const pid = skuToId.get(r.sku);
          if (!pid) { unmatched++; continue; }
          const key = `${m.code}|${pid}`;
          desired.set(key, (desired.get(key) || 0) + Number(r.qty || 0));
          matched++;
        }
        syncedCodes.add(m.code);
        summary.push({ code: m.code, matched, unmatched });
      } finally { await src.end().catch(() => {}); }
    }
    for (const [k, v] of desired) if (v < 0) desired.set(k, 0); // clamp negativos a 0
    console.table(summary);

    if (!syncedCodes.size) { console.log('  ninguna sucursal respondió — nada que hacer.'); return; }

    // ── 2. Diff contra el snapshot local ──
    const snap = FULL ? {} : loadSnap();
    const changed = []; // [code, pid, qty]
    // upserts: la existencia deseada difiere de la última subida.
    for (const [key, qty] of desired) {
      if (Number(snap[key]) !== qty) { const [code, pid] = key.split('|'); changed.push([code, pid, qty]); }
    }
    // drops: producto que estaba (snapshot) y ya no aparece en Kepler → poner 0.
    // SOLO para sucursales leídas OK (evita borrar stock por un fallo de conexión).
    for (const key of Object.keys(snap)) {
      const [code, pid] = key.split('|');
      if (syncedCodes.has(code) && !desired.has(key) && Number(snap[key]) !== 0) changed.push([code, pid, 0]);
    }

    console.log(`  ${desired.size} filas vivas · ${changed.length} cambios a subir (${FULL ? 'FULL' : 'delta'})`);
    if (!changed.length) { console.log('  sin cambios — cero tráfico.'); return; }
    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); return; }

    // ── 3. Subir SOLO el diff + merge server-side ──
    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    await db.query(`CREATE TEMP TABLE stg_stock (code text, product_id uuid, quantity numeric) ON COMMIT DROP`);
    for (let i = 0; i < changed.length; i += BATCH) {
      const chunk = changed.slice(i, i + BATCH);
      const vals = [], params = [];
      chunk.forEach((row, ri) => { vals.push(`($${ri*3+1},$${ri*3+2},$${ri*3+3})`); params.push(row[0], row[1], row[2]); });
      await db.query(`INSERT INTO stg_stock (code, product_id, quantity) VALUES ${vals.join(',')}`, params);
    }
    // Cada (code, product_id) viene ya agregado y único desde JS → upsert directo.
    const up = await db.query(`
      INSERT INTO commercial.stock (id, tenant_id, warehouse_id, product_id, quantity, updated_at)
      SELECT gen_random_uuid(), $1, w.id, s.product_id, s.quantity, now()
      FROM stg_stock s
      JOIN commercial.warehouses w ON w.tenant_id=$1 AND w.code=s.code
      ON CONFLICT (tenant_id, warehouse_id, product_id) DO UPDATE SET quantity=EXCLUDED.quantity, updated_at=now()`, [M]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${up.rowCount} filas de stock actualizadas (delta).`);

    // ── 4. Persistir snapshot: conservar sucursales no sincronizadas + refrescar
    //    las sincronizadas con su estado deseado (los drops quedan fuera → DB en 0).
    const newSnap = {};
    for (const key of Object.keys(snap)) if (!syncedCodes.has(key.split('|')[0])) newSnap[key] = snap[key];
    for (const [key, qty] of desired) newSnap[key] = qty;
    saveSnap(newSnap);
    console.log(`  snapshot actualizado (${Object.keys(newSnap).length} filas) → ${SNAP_PATH}`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally { await db.end(); }
})();
