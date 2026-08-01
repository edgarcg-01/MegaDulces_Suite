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
    // Guarda: si ninguna sucursal respondió, NO toques la tabla (evita vaciarla por un
    // outage de red — el TRUNCATE original sí la vaciaba en ese caso).
    if (!rows.length) { console.log('\n[APPLY] 0 clientes leídos (¿sucursales caídas?) — tabla intacta.'); return; }

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    // Refresco IDEMPOTENTE sin churn: staging TEMP → UPSERT solo-cambios → DELETE solo lo que
    // ya no viene. Antes: TRUNCATE+INSERT reescribía toda la tabla cada noche.
    await db.query(`CREATE TEMP TABLE stg_erpc (erp_code text, name text, rfc text, city text) ON COMMIT DROP`);
    for (let i = 0; i < rows.length; i += 1000) {
      const chunk = rows.slice(i, i + 1000);
      const vals = chunk.map((_, ri) => { const b = ri * 4; return `($${b+1},$${b+2},$${b+3},$${b+4})`; });
      const params = []; chunk.forEach((row) => params.push(row[0], row[1], row[2], row[3]));
      await db.query(`INSERT INTO stg_erpc (erp_code, name, rfc, city) VALUES ${vals.join(',')}`, params);
    }
    const up = await db.query(
      `INSERT INTO analytics.erp_customers AS t (tenant_id, erp_code, name, rfc, city, computed_at)
       SELECT $1, erp_code, name, rfc, city, now() FROM stg_erpc
       ON CONFLICT (tenant_id, erp_code) DO UPDATE SET
         name=EXCLUDED.name, rfc=EXCLUDED.rfc, city=EXCLUDED.city, computed_at=now()
       WHERE (t.name, t.rfc, t.city) IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.rfc, EXCLUDED.city)`, [M]);
    const del = await db.query(
      `DELETE FROM analytics.erp_customers t
        WHERE t.tenant_id=$1 AND NOT EXISTS (SELECT 1 FROM stg_erpc s WHERE s.erp_code=t.erp_code)`, [M]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${up.rowCount} escritas (nuevas/cambiadas) · ${del.rowCount} borradas · ${rows.length} en origen.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
