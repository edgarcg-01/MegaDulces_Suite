/* eslint-disable no-console */
/**
 * CB.4.1 — Postings del 102 → analytics.bank_postings (matching por-transacción banco↔Kepler).
 *
 * DERIVA del ODS (`kepler_ods.kdc2YYMM`), NO de la rama. Antes leía `192.168.9.95/md_00` directo
 * —que es la copia de PRUEBA/stale (Fase CA)— y perdía ~2,200 postings + 1,941 originados por
 * sucursales. Ahora una sola conexión (DST) = fresco + completo + sin import ajeno.
 *
 * CONCENTRADOR: el 102 vive centralizado en el ledger del CEDIS; `c14` sólo marca la sucursal que
 * ORIGINÓ el movimiento (00-06), NO es réplica → se incluyen TODAS (sin filtro c14). `sucursal`
 * queda en '00' (es el ledger consolidado); el origen no se separa (el cuadre casa por cuenta+monto).
 *
 * Cancelados: `kdm1.c43='C'` pone `c16=0` pero NO borra la póliza 102 → el `c5<>0` tira los ceros
 * (mecanismo primario, cubre todas las sucursales) y el delta contra kdm1 suc 00 es el respaldo.
 *
 *   node database/importers/kepler/import-bank-postings.js               # dry-run (12m)
 *   node database/importers/kepler/import-bank-postings.js --apply
 *   node database/importers/kepler/import-bank-postings.js --apply --reset   # limpia+recarga (repoint)
 *   ... --months 19
 * Env: DATABASE_URL_NEW (trae kepler_ods).
 */
const { Client } = require('pg');
const crypto = require('node:crypto');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const RESET = process.argv.includes('--reset');
const BATCH = 1000;
function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def; }
const MONTHS = Math.max(1, Math.min(36, Number(arg('months', 12))));

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
  const db = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false, statement_timeout: 180000 }); await db.connect();
  const DOC = "(c15||c16||lpad(c17::text,2,'0')||lpad(c18::text,2,'0'))";
  console.log(`\n=== CB.4.1 postings 102 desde ODS (${APPLY ? (RESET ? 'APPLY+RESET' : 'APPLY') : 'DRY-RUN'}) — ${MONTHS} meses (${yms[yms.length - 1]}…${yms[0]}) ===`);

  // Guard: si el ODS aún no trae kdc2 → SKIP (no se escribe nada).
  const hasKdc = (await db.query(`SELECT to_regclass('kepler_ods.${tables[0].tbl}') r`)).rows[0].r
    || (await db.query(`SELECT to_regclass('kepler_ods.${tables[1] ? tables[1].tbl : tables[0].tbl}') r`)).rows[0].r;
  if (!hasKdc) { console.error(`\n[SKIP] kepler_ods.kdc2* no existe todavía — falta que la réplica ODS lo incluya. No se escribe nada.`); await db.end(); return; }

  // Cancelados del CEDIS (kdm1 c43='C', suc 00): respaldo del c5<>0. (pfx = c2‖c3‖lpad(c4,2) = left(doc_tipo,4).)
  const canc = (await db.query(
    `SELECT DISTINCT btrim(c2::text)||btrim(c3::text)||lpad(btrim(c4::text),2,'0') pfx, btrim(c6::text) folio
       FROM kepler_ods.kdm1 WHERE btrim(c1::text)='00' AND sucursal='00' AND btrim(coalesce(c43::text,''))='C'`)).rows;
  const cset = new Set(canc.map(r => `${r.pfx}|${r.folio}`));

  const staged = [];
  const seen = new Map();
  let skip = 0;
  for (const t of tables) {
    if (!(await db.query(`SELECT to_regclass('kepler_ods.${t.tbl}') r`)).rows[0].r) continue;
    // Concentrador: SIN filtro c14 (todas las sucursales viven en este ledger; c14 = origen, no réplica).
    const rows = (await db.query(
      `SELECT ${DOC} doc_tipo, coalesce(nullif(btrim(c19),''),'0') folio, coalesce(c10,0)::int linea,
              c2::date fecha, c4 nat, c5::numeric imp, nullif(btrim(c6),'') c6, nullif(btrim(c7),'') c7
         FROM kepler_ods.${t.tbl}
        WHERE split_part(c3,'-',1)='102' AND coalesce(c5,0)<>0
        ORDER BY doc_tipo, folio, linea, c5::numeric`)).rows;
    for (const r of rows) {
      if (cset.has(`${String(r.doc_tipo).slice(0, 4)}|${r.folio}`)) { skip++; continue; } // cancelado (respaldo)
      const key = `00|${t.ym}|${r.doc_tipo}|${r.folio}|${r.linea}|${r.nat}|${Number(r.imp) || 0}|${r.c6 || ''}`;
      const occ = (seen.get(key) || 0) + 1; seen.set(key, occ);
      const clientUuid = crypto.createHash('sha1').update(`${key}|${occ}`).digest('hex');
      staged.push([M, clientUuid, '00', r.doc_tipo, r.folio, r.linea, r.fecha, t.ym, r.nat, Number(r.imp) || 0, r.c6, r.c7]);
    }
  }
  const abonos = staged.filter(r => r[8] === 'A'), cargos = staged.filter(r => r[8] === 'C');
  const sum = a => a.reduce((s, r) => s + r[9], 0);
  console.log(`  ${staged.length} postings 102 (${skip} cancelados excluidos)`);
  console.log(`  abonos(salida) ${abonos.length} $${Math.round(sum(abonos)).toLocaleString()} · cargos(entrada) ${cargos.length} $${Math.round(sum(cargos)).toLocaleString()}`);

  if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); await db.end(); return; }
  if (!staged.length) { console.log('\n[APPLY] 0 postings (¿ODS sin kdc2?) — tabla intacta.'); await db.end(); return; }
  try {
    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    if (RESET) { const d = await db.query(`DELETE FROM analytics.bank_postings WHERE tenant_id=$1`, [M]); console.log(`  [RESET] ${d.rowCount} filas previas borradas (repoint de fuente).`); }
    await bulkUpsert(db, staged);
    // Delete-reconcile: barre pólizas de docs cancelados ya materializadas (el UPSERT no borra).
    let delRc = 0;
    if (canc.length) {
      await db.query(`CREATE TEMP TABLE _canc (pfx text, folio text) ON COMMIT DROP`);
      for (let i = 0; i < canc.length; i += 1000) {
        const chunk = canc.slice(i, i + 1000);
        const vals = chunk.map((_, j) => `($${j * 2 + 1},$${j * 2 + 2})`).join(',');
        await db.query(`INSERT INTO _canc VALUES ${vals}`, chunk.flatMap(r => [r.pfx, r.folio]));
      }
      const dr = await db.query(
        `DELETE FROM analytics.bank_postings b USING _canc c
          WHERE b.tenant_id='${M}' AND b.sucursal='00' AND left(b.doc_tipo,4)=c.pfx AND b.folio=c.folio`);
      delRc = dr.rowCount;
    }
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${staged.length} postings upserted${delRc ? ` · ${delRc} cancelados barridos` : ''}.`);
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error('ERROR:', e.message); process.exitCode = 1; }
  finally { await db.end(); }
})().catch(e => { console.error(e); process.exit(1); });
