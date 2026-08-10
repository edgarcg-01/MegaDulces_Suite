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
const SNAP_PATH = process.env.STOCK_SNAPSHOT_PATH || path.join(__dirname, '.stock-live-snapshot.json');
const MAP = process.env.STOCK_BRANCH_MAP
  ? JSON.parse(process.env.STOCK_BRANCH_MAP)
  : [
      // RA-PRO.24 — el CEDIS '00' YA NO se surte de Kepler md_00 (cargaba pseudo-SKUs
      // contables 00001/00022 que inflaban el hub). Su existencia física viene de Wincaja
      // Irapuato vía import-cedis-stock-wincaja.js. NO reactivar '00' aquí sin coordinar.
      // { code: '00', url: 'postgresql://platform_ro:kepler123@192.168.9.95:5432/md_00' },
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
        // RA-PRO.24 — excluir pseudo-SKUs de SERVICIO/contables (no inventario físico):
        // 00001 VENTAS AL 0%, 00002, 00022 TIEMPO AIRE. Inflaban stock/sobrestock en todas las sucursales.
        // RA-PRO.37 — GREATEST(...,0): Kepler arroja existencias NEGATIVAS (anomalía contable: más
        // salidas que entradas+inicial). No existe stock físico negativo y el CHECK quantity>=reserved
        // las rechaza (rompía el --full completo). Piso a 0 = comportamiento correcto.
        const stock = (await src.query(`SELECT c3 AS sku, GREATEST(c4+c8-c9, 0)::numeric AS qty FROM md.kdil WHERE c3 IS NOT NULL AND c1 = $1 AND c3 <> ALL(ARRAY['00001','00002','00022'])`, [suc])).rows;
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

    // ── 3. Aplicar SOLO el diff via SINK (una sola fuente de SQL: lib/apply-handlers) ──
    //   FEEDS_SINK=pg (default): escribe con este Client por el proxy público (histórico).
    //   FEEDS_SINK=http        : empuja el changeset a services/feeds-ingest (ingress gratis).
    // Cada (code, product_id) viene ya agregado y único desde JS. Los drops (qty=0) que
    // refieren un product_id borrado del catálogo los filtra el JOIN a products en el handler.
    const sink = require('../lib/sink');
    const rows = changed.map(([code, product_id, quantity]) => ({ code, product_id, quantity }));
    const r = await sink.ship('stock-delta', { rows, tenantId: M, client: db });
    console.log(`\n[APPLY·${r.mode}] ${r.rowCount} filas de stock actualizadas (delta)${r.ms != null ? ` · ${r.ms}ms` : ''}.`);

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
