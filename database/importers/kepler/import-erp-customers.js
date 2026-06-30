/* eslint-disable no-console */
/**
 * KV.3 — Dim de clientes Kepler → analytics.erp_customers (refresco full).
 *
 * Lee md.kdud de las 6 sucursales (dedup por código normalizado), excluye los
 * "NO USAR/NO USUAR" (registros muertos del ERP). erp_code = c2 normalizado
 * (numéricos a 5 dígitos con lpad, igual que el historial). NO toca
 * commercial.customers (decisión del usuario).
 *
 *   node database/importers/kepler/import-erp-customers.js          # dry-run
 *   node database/importers/kepler/import-erp-customers.js --apply  # commit
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const MAP = process.env.STOCK_BRANCH_MAP
  ? JSON.parse(process.env.STOCK_BRANCH_MAP)
  : [
      'postgresql://platform_ro:kepler123@192.168.9.95:5432/md_00',
      'postgresql://platform_ro:kepler123@192.168.10.10:1977/md_01',
      'postgresql://platform_ro:kepler123@192.168.42.42:5432/md_02',
      'postgresql://platform_ro:kepler123@192.168.40.40:5432/md_03',
      'postgresql://platform_ro:kepler123@192.168.44.44:5432/md_04',
      'postgresql://platform_ro:kepler123@192.168.54.54:5432/md_05',
    ].map((url) => ({ url }));

const norm = (c) => {
  const s = String(c || '').trim();
  return /^[0-9]+$/.test(s) ? s.padStart(5, '0') : s;
};

(async () => {
  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    console.log(`\n=== Dim clientes Kepler → analytics.erp_customers (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

    const byCode = new Map();
    for (const b of MAP) {
      const src = new Client({ connectionString: b.url });
      try {
        await src.connect();
        const { rows } = await src.query(
          `SELECT c2 code, c3 name, c10 rfc, c6 city FROM md.kdud
            WHERE btrim(coalesce(c2,'')) <> '' AND c3 IS NOT NULL
              AND c3 NOT ILIKE 'NO USAR%' AND c3 NOT ILIKE 'NO USUAR%'`);
        for (const r of rows) byCode.set(norm(r.code), { name: String(r.name).trim(), rfc: r.rfc, city: r.city });
        console.log(`  ${b.url.split('@')[1]}: ${rows.length} clientes`);
      } catch (e) {
        console.log(`  ⚠ ${b.url.split('@')[1]} no disponible: ${e.message}`);
      } finally { await src.end().catch(() => {}); }
    }
    const rows = [...byCode.entries()].map(([code, v]) => [code, v.name, v.rfc, v.city]);
    console.log(`  total dedup: ${rows.length} clientes`);

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); return; }

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    await db.query(`TRUNCATE analytics.erp_customers`);
    for (let i = 0; i < rows.length; i += 1000) {
      const chunk = rows.slice(i, i + 1000);
      // 5 params por fila (tenant, code, name, rfc, city) + now()
      const vals = chunk.map((_, ri) => { const b = ri * 5; return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},now())`; });
      const params = []; chunk.forEach((row) => params.push(M, row[0], row[1], row[2], row[3]));
      await db.query(
        `INSERT INTO analytics.erp_customers (tenant_id, erp_code, name, rfc, city, computed_at) VALUES ${vals.join(',')}`, params);
    }
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${rows.length} clientes en erp_customers.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
