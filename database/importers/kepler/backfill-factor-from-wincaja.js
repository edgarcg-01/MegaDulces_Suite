/* eslint-disable no-console */
/**
 * RS.3c — Backfill de catalog.products.factor_sale desde Wincaja (unidades por caja),
 * SOLO alta confianza. Wincaja (articulos.factor_venta) valida/rellena a Kepler:
 *   A) VACÍOS: Kepler factor_sale<=1 y Wincaja>1, corroborado por 2ª fuente Kepler
 *      (factor_win == box_size de etiqueta) o por la pista "/N" del nombre.
 *   B) DIFIEREN-Kepler-mal: ambos>1, difieren, y Wincaja == box_size (Kepler traía el máster).
 * Idempotente. Los plausibles-sin-2ª-fuente y los ambiguos NO se tocan.
 *   node database/importers/kepler/backfill-factor-from-wincaja.js          # dry-run
 *   node database/importers/kepler/backfill-factor-from-wincaja.js --apply
 */
const { Client } = require('pg');
const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const packHint = (name) => { const m = String(name || '').match(/\/\s*(\d{1,3})(?!\d)/g); if (!m) return null; const n = m.map((x) => parseInt(x.replace(/[^\d]/g, ''), 10)).filter((v) => v > 1); return n.length ? n[n.length - 1] : null; };

(async () => {
  const c = new Client({ connectionString: DST }); await c.connect();
  try {
    const rows = (await c.query(`
      WITH aw AS (SELECT DISTINCT ON (articulo) articulo sku, upper(btrim(coalesce(unidad_venta,''))) uv_win, factor_venta::numeric fac_win
                    FROM wincaja.articulos WHERE tenant_id=$1 ORDER BY articulo, source_dataset DESC)
      SELECT p.id, p.sku, p.nombre, coalesce(p.factor_sale,0)::numeric fac_kep,
             l.box_size::numeric box_size, aw.fac_win
        FROM catalog.products p JOIN aw ON aw.sku=p.sku
        LEFT JOIN commercial.product_label_prices l ON l.product_id=p.id AND l.tenant_id=p.tenant_id
       WHERE p.tenant_id=$1 AND p.deleted_at IS NULL AND aw.fac_win>1`, [M])).rows;

    const fixes = [];
    for (const r of rows) {
      const box = Number(r.box_size) || 0, win = Number(r.fac_win), kep = Number(r.fac_kep);
      const hint = packHint(r.nombre);
      const corrob = (box > 1 && box === win) || (hint && hint === win);
      let take = false, reason = '';
      if (kep <= 1 && corrob) { take = true; reason = box === win ? 'vacío→box' : 'vacío→nombre'; }      // A
      else if (kep > 1 && kep !== win && box > 1 && box === win) { take = true; reason = 'difiere→box'; } // B
      if (take && win !== kep) fixes.push({ id: r.id, sku: r.sku, from: kep, to: win, reason, nombre: r.nombre });
    }
    const byReason = fixes.reduce((a, f) => { a[f.reason] = (a[f.reason] || 0) + 1; return a; }, {});
    console.log(`\n=== Backfill factor_sale desde Wincaja (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`);
    console.log(`  correcciones alta confianza: ${fixes.length}`, byReason);
    console.table(fixes.slice(0, 12).map((f) => ({ sku: f.sku, from: f.from, to: f.to, reason: f.reason, nombre: f.nombre.slice(0, 34) })));

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); return; }
    await c.query('BEGIN'); await c.query(`SET LOCAL app.tenant_id='${M}'`);
    let n = 0;
    for (const f of fixes) {
      const r = await c.query(`UPDATE catalog.products SET factor_sale=$2, updated_at=now() WHERE id=$1 AND tenant_id=$3 AND coalesce(factor_sale,0)<>$2`, [f.id, f.to, M]);
      n += r.rowCount;
    }
    await c.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${n} factor_sale corregidos.`);
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('ERR', e.message); process.exitCode = 1; }
  finally { await c.end(); }
})();
