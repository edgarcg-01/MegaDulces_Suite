/* eslint-disable no-console */
/**
 * GX.6 — Vínculo solicitud↔gasto + hallazgos de solicitudes de gasto.
 *
 * `analytics.expense_requests` YA NO se escribe aquí: es una **VISTA** derive-no-copy sobre
 * `kepler_ods.kdm1` (XA1501) — mig 20260819160000. Este importer solo mantiene lo que la vista
 * no puede: el vínculo del gasto a su solicitud y los hallazgos.
 *
 * Lee de `kepler_ods.kdm1` (ODS replicado, LOCAL — ya no las 6 ramas remotas → sin timeout):
 *   - XA1501 "Expense request"    → solicitudes (folio c6, fecha c9, importe c16, solicitante c48,
 *     beneficiario c32, concepto c24, estado c43). Anti-réplica c1=sucursal.
 *   - XA1001 "Expense allocation" → el gasto que APLICA la solicitud (enlace c39 = folio solicitud).
 *
 * Puebla:
 *   - analytics.expense_documents.solicitud_tipo/folio  (referencia del gasto → su solicitud).
 *   - analytics.expense_findings tipo='solicitud_sin_aplicar' (solicitudes vencidas sin gasto).
 *
 * Idempotente. Reemplaza SOLO lo suyo (findings por tipo+sucursal; doc.solicitud_* por gasto).
 * Filtro de tenant explícito (kepler_ods sin RLS; expense_* con RLS → SET LOCAL app.tenant_id).
 *
 *   node database/importers/kepler/import-expense-requests.js            # dry-run
 *   node database/importers/kepler/import-expense-requests.js --apply    # commit
 */
const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const BATCH = 1000;
const TODAY = new Date().toISOString().slice(0, 10);

const norm = (s) => { const t = String(s || '').toUpperCase().replace(/\s+/g, ' ').trim(); return t || null; };

async function bulkInsert(db, table, cols, rows) {
  const N = cols.length;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const vals = [], params = [];
    chunk.forEach((row, ri) => {
      vals.push(`(${Array.from({ length: N }, (_, k) => `$${ri * N + k + 1}`).join(',')})`);
      params.push(...row);
    });
    await db.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${vals.join(',')}`, params);
  }
}

(async () => {
  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    console.log(`\n=== GX.6 — vínculo solicitud↔gasto + hallazgos (fuente: kepler_ods) (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);
    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    await db.query(`CREATE TEMP TABLE stg_link (sucursal text, gasto_folio text, sol_folio text) ON COMMIT DROP`);
    await db.query(`CREATE TEMP TABLE stg_reqfind (sucursal text, fecha date, doc_folio text, beneficiario text, importe numeric, nota text) ON COMMIT DROP`);

    // Gastos (XA1001): folio + solicitud ligada (c39). Set de solicitudes aplicadas por sucursal.
    const gastos = (await db.query(
      `SELECT sucursal::text AS suc, btrim(c6::text) AS gasto_folio, NULLIF(btrim(c39::text),'') AS sol_folio
         FROM kepler_ods.kdm1
        WHERE c2='X' AND c3='A' AND btrim(c4::text)='10' AND btrim(c5::text)='1' AND btrim(c1::text)=sucursal::text`,
    )).rows;
    const applied = new Set();       // `suc|folio`
    const linkStg = [];
    for (const g of gastos) {
      if (g.sol_folio) { applied.add(`${g.suc}|${g.sol_folio}`); linkStg.push([g.suc, g.gasto_folio, g.sol_folio]); }
    }

    // Solicitudes (XA1501) — solo para derivar los hallazgos (la tabla ahora es vista).
    const sols = (await db.query(
      `SELECT sucursal::text AS suc, btrim(c6::text) AS folio, c9::date AS fecha,
              c16::numeric AS importe, NULLIF(btrim(c48::text),'') AS solicitante,
              NULLIF(btrim(c32::text),'') AS beneficiario, NULLIF(btrim(c43::text),'') AS estado
         FROM kepler_ods.kdm1
        WHERE c2='X' AND c3='A' AND btrim(c4::text)='15' AND btrim(c5::text)='1'
          AND btrim(c1::text)=sucursal::text AND btrim(c6::text)<>''`,
    )).rows;

    const okCodes = [...new Set(sols.map((s) => s.suc))];
    const findStg = [];
    for (const s of sols) {
      const aplicada = applied.has(`${s.suc}|${s.folio}`);
      const fechaStr = s.fecha ? new Date(s.fecha).toISOString().slice(0, 10) : null;
      // Hallazgo: pedida/aprobada, vencida y sin gasto (excluye canceladas 'C' y fechas futuras).
      if (!aplicada && s.estado !== 'C' && fechaStr && fechaStr <= TODAY) {
        findStg.push([s.suc, s.fecha, s.folio, s.beneficiario, Number(s.importe) || 0,
          `Solicitud ${s.folio} de ${norm(s.solicitante) || '?'} sin aplicar (estado ${s.estado || '?'})`]);
      }
    }

    await bulkInsert(db, 'stg_link', ['sucursal', 'gasto_folio', 'sol_folio'], linkStg);
    await bulkInsert(db, 'stg_reqfind', ['sucursal', 'fecha', 'doc_folio', 'beneficiario', 'importe', 'nota'], findStg);
    console.log(`Leído del ODS: ${sols.length} solicitudes · ${linkStg.length} vínculos gasto→solicitud · ${findStg.length} sin aplicar`);

    if (!APPLY) { await db.query('ROLLBACK'); console.log('\n[DRY-RUN] ROLLBACK — nada cambió.'); return; }
    if (!okCodes.length) { await db.query('ROLLBACK'); console.log('\n[APPLY] ODS sin solicitudes — nada que hacer.'); return; }

    // Referencia del gasto → su solicitud (expense_documents.solicitud_*). RESTAURADO
    // 2026-08-19: `expense_documents` vuelve a ser TABLA contable (mig 20260819230000
    // revirtió la vista — rompía la conciliación fiscal por importe/fecha). El vínculo
    // se mantiene 100% aquí desde el c39 del ODS, sin tocar el monto contable.
    const upDoc = await db.query(`
      UPDATE analytics.expense_documents d
         SET solicitud_tipo='XA1501', solicitud_folio=l.sol_folio
        FROM stg_link l
       WHERE d.tenant_id=$1 AND d.sucursal=l.sucursal AND d.doc_tipo='XA1001' AND d.doc_folio=l.gasto_folio`, [M]);

    // Hallazgo solicitud_sin_aplicar (sin clave natural): set-level skip (cero churn si no cambió).
    const FP_R = `concat_ws('|', sucursal, coalesce(fecha::text,''), coalesce(doc_folio,''), coalesce(beneficiario,''), coalesce(importe::text,''), coalesce(nota,''))`;
    const { rows: cmpR } = await db.query(
      `SELECT (SELECT md5(coalesce(string_agg(fp, E'\\n' ORDER BY fp),'')) FROM (SELECT ${FP_R} fp FROM stg_reqfind) a)
            = (SELECT md5(coalesce(string_agg(fp, E'\\n' ORDER BY fp),'')) FROM (SELECT ${FP_R} fp FROM analytics.expense_findings
                 WHERE tenant_id=$1 AND tipo='solicitud_sin_aplicar' AND sucursal = ANY($2)) b) AS same`, [M, okCodes]);
    let upFindCount = 0;
    if (!cmpR[0].same) {
      await db.query(`DELETE FROM analytics.expense_findings WHERE tenant_id=$1 AND tipo='solicitud_sin_aplicar' AND sucursal = ANY($2)`, [M, okCodes]);
      const upFind = await db.query(`
        INSERT INTO analytics.expense_findings (tenant_id,tipo,sucursal,fecha,doc_tipo,doc_folio,beneficiario,importe,nota,computed_at)
        SELECT $1,'solicitud_sin_aplicar',sucursal,fecha,'XA1501',doc_folio,beneficiario,importe,nota,now() FROM stg_reqfind`, [M]);
      upFindCount = upFind.rowCount;
    }

    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — doc.solicitud actualizados: ${upDoc.rowCount} · hallazgos sin_aplicar: ${cmpR[0].same ? 'sin cambios' : upFindCount + ' reescritos'}`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
