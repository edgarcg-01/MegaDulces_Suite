/* eslint-disable no-console */
/**
 * CB.4.1 — Postings del 102 de Kepler → analytics.bank_postings (para matching
 * por-transacción banco↔Kepler). Lee kdc2YYMM donde c3 LIKE '102%' (CEDIS md_00
 * centraliza el 102; las sucursales replican → solo CEDIS por default). UPSERT.
 *
 *   node database/importers/kepler/import-bank-postings.js             # dry-run (12m)
 *   node database/importers/kepler/import-bank-postings.js --apply
 *   ... --months 19
 */
const { Client } = require('pg');
const crypto = require('node:crypto');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const BATCH = 1000;
function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def; }
const MONTHS = Math.max(1, Math.min(36, Number(arg('months', 12))));

// CEDIS centraliza el 102 (igual que import-sales-by-channel). Override con EXPENSES_BRANCH_MAP.
const MAP = process.env.EXPENSES_BRANCH_MAP ? JSON.parse(process.env.EXPENSES_BRANCH_MAP)
  : [{ code: '00', url: 'postgresql://platform_ro:kepler123@192.168.9.95:5432/md_00' }];

function monthWindow(n) {
  const now = new Date(); const t = []; let y = now.getFullYear(), m = now.getMonth() + 1;
  for (let i = 0; i < n; i++) { t.push({ tbl: `kdc2${String(y % 100).padStart(2, '0')}${String(m).padStart(2, '0')}`, ym: `${y}-${String(m).padStart(2, '0')}` }); m--; if (m === 0) { m = 12; y--; } }
  return t;
}

async function bulkUpsert(db, rows) {
  const cols = ['tenant_id', 'client_uuid', 'sucursal', 'doc_tipo', 'folio', 'linea', 'fecha', 'anio_mes', 'cargo_abono', 'importe', 'contraparte', 'forma'];
  const N = cols.length;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const vals = [], params = [];
    chunk.forEach((r, ri) => { vals.push(`(${Array.from({ length: N }, (_, k) => `$${ri * N + k + 1}`).join(',')})`); params.push(...r); });
    await db.query(
      `INSERT INTO analytics.bank_postings (${cols.join(',')}) VALUES ${vals.join(',')}
       ON CONFLICT (tenant_id,client_uuid) DO UPDATE SET
         sucursal=EXCLUDED.sucursal, doc_tipo=EXCLUDED.doc_tipo, folio=EXCLUDED.folio, linea=EXCLUDED.linea,
         fecha=EXCLUDED.fecha, anio_mes=EXCLUDED.anio_mes, cargo_abono=EXCLUDED.cargo_abono,
         importe=EXCLUDED.importe, contraparte=EXCLUDED.contraparte, forma=EXCLUDED.forma, computed_at=now()`,
      params);
  }
}

(async () => {
  const tables = monthWindow(MONTHS);
  const yms = tables.map(t => t.ym);
  const db = new Client({ connectionString: DST }); await db.connect();
  const DOC = "(c15||c16||lpad(c17::text,2,'0')||lpad(c18::text,2,'0'))";
  console.log(`\n=== CB.4.1 postings 102 (${APPLY ? 'APPLY' : 'DRY-RUN'}) — ${MONTHS} meses (${yms[yms.length - 1]}…${yms[0]}) ===`);
  const staged = [];
  const okCodes = [];
  const seen = new Map();
  for (const b of MAP) {
    const src = new Client({ connectionString: b.url, connectionTimeoutMillis: 8000 });
    try { await src.connect(); } catch (e) { console.log(`  ⚠ ${b.code}: sin conexión — skip`); continue; }
    okCodes.push(b.code);
    let nb = 0;
    try {
      for (const t of tables) {
        if (!(await src.query(`SELECT to_regclass('md.${t.tbl}') r`)).rows[0].r) continue;
        const rows = (await src.query(
          `SELECT ${DOC} doc_tipo, coalesce(nullif(btrim(c19),''),'0') folio, coalesce(c10,0)::int linea,
                  c2::date fecha, c4 nat, c5::numeric imp, nullif(btrim(c6),'') c6, nullif(btrim(c7),'') c7
           FROM md.${t.tbl}
           WHERE split_part(c3,'-',1)='102' AND coalesce(c5,0)<>0
             AND (c14 IS NULL OR btrim(c14)='' OR btrim(c14)=$1)
           ORDER BY doc_tipo, folio, linea, c5::numeric`, [b.code])).rows;
        for (const r of rows) {
          const key = `${b.code}|${t.ym}|${r.doc_tipo}|${r.folio}|${r.linea}|${r.nat}|${Number(r.imp) || 0}|${r.c6 || ''}`;
          const occ = (seen.get(key) || 0) + 1; seen.set(key, occ);
          const clientUuid = crypto.createHash('sha1').update(`${key}|${occ}`).digest('hex');
          staged.push([M, clientUuid, b.code, r.doc_tipo, r.folio, r.linea, r.fecha, t.ym, r.nat, Number(r.imp) || 0, r.c6, r.c7]);
          nb++;
        }
      }
      console.log(`  sucursal ${b.code}: ${nb} postings 102`);
    } catch (e) { console.log(`  ⚠ ${b.code}: ${e.message}`); }
    finally { await src.end(); }
  }
  const abonos = staged.filter(r => r[8] === 'A'), cargos = staged.filter(r => r[8] === 'C');
  const sum = a => a.reduce((s, r) => s + r[9], 0);
  console.log(`\n  Total: ${staged.length} postings · abonos(salida) ${abonos.length} $${Math.round(sum(abonos)).toLocaleString()} · cargos(entrada) ${cargos.length} $${Math.round(sum(cargos)).toLocaleString()}`);

  if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); await db.end(); return; }
  if (!okCodes.length) { console.log('sin sucursales — nada.'); await db.end(); return; }
  try {
    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    await bulkUpsert(db, staged);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${staged.length} postings upserted.`);
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error('ERROR:', e.message); process.exitCode = 1; }
  finally { await db.end(); }
})().catch(e => { console.error(e); process.exit(1); });
