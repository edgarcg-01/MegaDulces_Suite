/* eslint-disable no-console */
/**
 * GX.6 — Solicitudes de gasto (XA1501) → analytics.expense_requests + cadena.
 *
 * Lee de cada sucursal Kepler (READ-ONLY):
 *   - XA1501 "Expense request"    → cabecera de la solicitud (folio, fecha, importe,
 *     solicitante c48, beneficiario c32, concepto c24, estado c43, usuario c67).
 *   - XA1001 "Expense allocation" → el gasto que APLICA la solicitud (enlace c39 = folio solicitud).
 *
 * Puebla:
 *   - analytics.expense_requests  (todas las solicitudes, con flag `aplicada`).
 *   - analytics.expense_documents.solicitud_tipo/folio  (referencia del gasto → su solicitud).
 *   - analytics.expense_findings tipo='solicitud_sin_aplicar' (solicitudes vencidas sin gasto).
 *
 * Idempotente. Reemplaza SOLO lo suyo (requests por sucursal; findings por tipo+sucursal;
 * doc.solicitud_* por gasto). Nada de RLS: filtro de tenant explícito.
 *
 *   node database/importers/kepler/import-expense-requests.js            # dry-run
 *   node database/importers/kepler/import-expense-requests.js --apply    # commit
 */
const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const BATCH = 1000;
const DOCTYPE = "(c2||c3||lpad(c4::text,2,'0')||lpad(c5::text,2,'0'))";
const TODAY = new Date().toISOString().slice(0, 10);

const MAP = process.env.EXPENSES_BRANCH_MAP
  ? JSON.parse(process.env.EXPENSES_BRANCH_MAP)
  : [
      { code: '00', url: 'postgresql://platform_ro:kepler123@192.168.9.95:5432/md_00' },
      { code: '01', url: 'postgresql://platform_ro:kepler123@192.168.10.10:1977/md_01' },
      { code: '02', url: 'postgresql://platform_ro:kepler123@192.168.42.42:5432/md_02' },
      { code: '03', url: 'postgresql://platform_ro:kepler123@192.168.40.40:5432/md_03' },
      { code: '04', url: 'postgresql://platform_ro:kepler123@192.168.44.44:5432/md_04' },
      { code: '05', url: 'postgresql://platform_ro:kepler123@192.168.54.54:5432/md_05' },
    ];

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
    console.log(`\n=== Solicitudes de gasto (XA1501) → analytics.expense_requests (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);
    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    await db.query(`CREATE TEMP TABLE stg_req (sucursal text, folio text, fecha date, importe numeric, solicitante text, beneficiario text, concepto text, estado text, usuario text, aplicada boolean) ON COMMIT DROP`);
    await db.query(`CREATE TEMP TABLE stg_link (sucursal text, gasto_folio text, sol_folio text) ON COMMIT DROP`);
    await db.query(`CREATE TEMP TABLE stg_reqfind (sucursal text, fecha date, doc_folio text, beneficiario text, importe numeric, nota text) ON COMMIT DROP`);

    const okCodes = [];
    const summary = [];
    for (const b of MAP) {
      const src = new Client({ connectionString: b.url, connectionTimeoutMillis: 6000, query_timeout: 120000 });
      try { await src.connect(); } catch (e) { console.log(`  ⚠ sucursal ${b.code}: sin conexión — skip`); continue; }
      okCodes.push(b.code);
      try {
        // Gastos (XA1001): folio + solicitud ligada (c39). Set de solicitudes aplicadas.
        const gastos = (await src.query(
          `SELECT c6 AS gasto_folio, NULLIF(btrim(c39),'') AS sol_folio FROM md.kdm1 WHERE ${DOCTYPE}='XA1001'`,
        )).rows;
        const applied = new Set();
        const linkStg = [];
        for (const g of gastos) {
          if (g.sol_folio) { applied.add(g.sol_folio); linkStg.push([b.code, g.gasto_folio, g.sol_folio]); }
        }
        // Solicitudes (XA1501)
        const sols = (await src.query(
          `SELECT c6 AS folio, c9::date AS fecha, c16::numeric AS importe,
                  NULLIF(btrim(c48),'') AS solicitante, NULLIF(btrim(c32),'') AS beneficiario,
                  NULLIF(btrim(c24),'') AS concepto, NULLIF(btrim(c43),'') AS estado, NULLIF(btrim(c67),'') AS usuario
             FROM md.kdm1 WHERE ${DOCTYPE}='XA1501' AND c6 IS NOT NULL`,
        )).rows;
        const reqStg = [], findStg = [];
        for (const s of sols) {
          const folio = String(s.folio).trim();
          const aplicada = applied.has(folio);
          const estado = s.estado || null;
          reqStg.push([b.code, folio, s.fecha, Number(s.importe) || 0, norm(s.solicitante), s.beneficiario, s.concepto, estado, s.usuario, aplicada]);
          // Hallazgo: pedida/aprobada, vencida y sin gasto (excluye canceladas 'C').
          const fechaStr = s.fecha ? new Date(s.fecha).toISOString().slice(0, 10) : null;
          if (!aplicada && estado !== 'C' && fechaStr && fechaStr <= TODAY) {
            findStg.push([b.code, s.fecha, folio, s.beneficiario, Number(s.importe) || 0,
              `Solicitud ${folio} de ${norm(s.solicitante) || '?'} sin aplicar (estado ${estado || '?'})`]);
          }
        }
        await bulkInsert(db, 'stg_req', ['sucursal', 'folio', 'fecha', 'importe', 'solicitante', 'beneficiario', 'concepto', 'estado', 'usuario', 'aplicada'], reqStg);
        await bulkInsert(db, 'stg_link', ['sucursal', 'gasto_folio', 'sol_folio'], linkStg);
        await bulkInsert(db, 'stg_reqfind', ['sucursal', 'fecha', 'doc_folio', 'beneficiario', 'importe', 'nota'], findStg);
        summary.push({ code: b.code, solicitudes: reqStg.length, sin_aplicar: findStg.length });
      } catch (e) { console.log(`  ⚠ sucursal ${b.code}: ${e.message}`); }
      finally { await src.end(); }
    }
    console.table(summary);
    const totReq = (await db.query(`SELECT count(*)::int n FROM stg_req`)).rows[0].n;
    const totFind = (await db.query(`SELECT count(*)::int n, round(sum(importe),0) m FROM stg_reqfind`)).rows[0];
    console.log(`Staging: ${totReq} solicitudes · ${totFind.n} sin aplicar ($${Number(totFind.m || 0).toLocaleString('es-MX')})`);

    if (!APPLY) { await db.query('ROLLBACK'); console.log('\n[DRY-RUN] ROLLBACK — nada cambió.'); return; }
    if (!okCodes.length) { await db.query('ROLLBACK'); console.log('\n[APPLY] Ninguna sucursal conectó.'); return; }

    // expense_requests: reemplazo total por sucursal.
    await db.query(`DELETE FROM analytics.expense_requests WHERE tenant_id=$1 AND sucursal = ANY($2)`, [M, okCodes]);
    const upReq = await db.query(`
      INSERT INTO analytics.expense_requests
        (tenant_id,sucursal,folio,fecha,importe,solicitante,beneficiario,concepto,estado,usuario,aplicada,computed_at)
      SELECT $1,sucursal,folio,fecha,importe,solicitante,beneficiario,concepto,estado,usuario,aplicada,now() FROM stg_req
      ON CONFLICT (tenant_id,sucursal,folio) DO NOTHING`, [M]);

    // Referencia del gasto → su solicitud (expense_documents.solicitud_*).
    const upDoc = await db.query(`
      UPDATE analytics.expense_documents d
         SET solicitud_tipo='XA1501', solicitud_folio=l.sol_folio
        FROM stg_link l
       WHERE d.tenant_id=$1 AND d.sucursal=l.sucursal AND d.doc_tipo='XA1001' AND d.doc_folio=l.gasto_folio`, [M]);

    // Hallazgo solicitud_sin_aplicar: reemplaza SOLO su tipo (no toca iva_bug/prov_203/anticipo_107).
    await db.query(`DELETE FROM analytics.expense_findings WHERE tenant_id=$1 AND tipo='solicitud_sin_aplicar' AND sucursal = ANY($2)`, [M, okCodes]);
    const upFind = await db.query(`
      INSERT INTO analytics.expense_findings (tenant_id,tipo,sucursal,fecha,doc_tipo,doc_folio,beneficiario,importe,nota,computed_at)
      SELECT $1,'solicitud_sin_aplicar',sucursal,fecha,'XA1501',doc_folio,beneficiario,importe,nota,now() FROM stg_reqfind`, [M]);

    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — requests: ${upReq.rowCount} · doc.solicitud actualizados: ${upDoc.rowCount} · hallazgos sin_aplicar: ${upFind.rowCount}`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
