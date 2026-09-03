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
  const db = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false }); await db.connect();
  const DOC = "(c15||c16||lpad(c17::text,2,'0')||lpad(c18::text,2,'0'))";
  console.log(`\n=== CB.4.1 postings 102 (${APPLY ? 'APPLY' : 'DRY-RUN'}) — ${MONTHS} meses (${yms[yms.length - 1]}…${yms[0]}) ===`);
  const staged = [];
  const okCodes = [];
  const seen = new Map();
  // Cancelados de Kepler (kdm1.c43='C'): al cancelar, Kepler pone c16=0 en kdm1 pero NO borra la
  // póliza 102 de kdc2 → un cobro/pago cancelado sigue con su posting no-cero y se colaba al cuadre
  // de Bancos (1,092 docs/$22.5M medidos en prod). Se excluyen al leer y se barren los ya
  // materializados (delete-reconcile abajo). Match por (sucursal, pfx, folio): pfx = c2‖c3‖lpad(c4,2)
  // = left(doc_tipo,4) del kdc2 (UA05, XD26…). kdc2 no tiene c43 propio → hay que ir a kdm1.
  const cancelled = [];  // [code, pfx, folio]
  for (const b of MAP) {
    const src = new Client({ connectionString: b.url, connectionTimeoutMillis: 8000 });
    try { await src.connect(); } catch (e) { console.log(`  ⚠ ${b.code}: sin conexión — skip`); continue; }
    okCodes.push(b.code);
    let nb = 0, skip = 0;
    try {
      const canc = (await src.query(
        `SELECT btrim(c2::text)||btrim(c3::text)||lpad(btrim(c4::text),2,'0') pfx, btrim(c6::text) folio
           FROM md.kdm1 WHERE btrim(c1::text)=$1 AND btrim(coalesce(c43::text,''))='C'`, [b.code])).rows;
      const cset = new Set(canc.map(r => `${r.pfx}|${r.folio}`));
      for (const r of canc) cancelled.push([b.code, r.pfx, r.folio]);
      for (const t of tables) {
        if (!(await src.query(`SELECT to_regclass('md.${t.tbl}') r`)).rows[0].r) continue;
        const rows = (await src.query(
          `SELECT ${DOC} doc_tipo, coalesce(nullif(btrim(c19),''),'0') folio, coalesce(c10,0)::int linea,
                  c2::date fecha, c4 nat, c5::numeric imp, nullif(btrim(c6),'') c6, nullif(btrim(c7),'') c7
           FROM md.${t.tbl}
           WHERE split_part(c3,'-',1)='102' AND coalesce(c5,0)<>0
           ORDER BY doc_tipo, folio, linea, c5::numeric`)).rows;
        // Concentrador: SIN filtro de c14. El 102 está centralizado en md_00 (CEDIS); c14 sólo marca
        // la sucursal que ORIGINÓ el movimiento (00-06), no es réplica. Filtrar c14='00' perdía los
        // postings originados por sucursales (c14='02'/'03'…) que sí viven en este mismo ledger.
        for (const r of rows) {
          if (cset.has(`${String(r.doc_tipo).slice(0, 4)}|${r.folio}`)) { skip++; continue; } // cancelado en Kepler
          const key = `${b.code}|${t.ym}|${r.doc_tipo}|${r.folio}|${r.linea}|${r.nat}|${Number(r.imp) || 0}|${r.c6 || ''}`;
          const occ = (seen.get(key) || 0) + 1; seen.set(key, occ);
          const clientUuid = crypto.createHash('sha1').update(`${key}|${occ}`).digest('hex');
          staged.push([M, clientUuid, b.code, r.doc_tipo, r.folio, r.linea, r.fecha, t.ym, r.nat, Number(r.imp) || 0, r.c6, r.c7]);
          nb++;
        }
      }
      console.log(`  sucursal ${b.code}: ${nb} postings 102 (${skip} cancelados excluidos)`);
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
    // Delete-reconcile: barre las pólizas de docs cancelados que YA estaban materializadas (el
    // UPSERT no borra). Sin esto, lo que se importó antes de cancelarse se queda de fantasma.
    let delRc = 0;
    if (cancelled.length) {
      await db.query(`CREATE TEMP TABLE _canc (sucursal text, pfx text, folio text) ON COMMIT DROP`);
      for (let i = 0; i < cancelled.length; i += 1000) {
        const chunk = cancelled.slice(i, i + 1000);
        const vals = chunk.map((_, j) => `($${j * 3 + 1},$${j * 3 + 2},$${j * 3 + 3})`).join(',');
        await db.query(`INSERT INTO _canc VALUES ${vals}`, chunk.flat());
      }
      const dr = await db.query(
        `DELETE FROM analytics.bank_postings b USING _canc c
          WHERE b.tenant_id='${M}' AND b.sucursal=c.sucursal AND left(b.doc_tipo,4)=c.pfx AND b.folio=c.folio`);
      delRc = dr.rowCount;
    }
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${staged.length} postings upserted${delRc ? ` · ${delRc} cancelados barridos` : ''}.`);
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error('ERROR:', e.message); process.exitCode = 1; }
  finally { await db.end(); }
})().catch(e => { console.error(e); process.exit(1); });
