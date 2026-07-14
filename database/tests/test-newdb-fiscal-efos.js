/* eslint-disable no-console */
/**
 * FISCAL.0/1 — Smoke del motor de listas SAT + validación de RFC.
 * Verifica schema + RLS + cruce (expense_documents × sat_list_rfcs) + idempotencia
 * + triage preservado + validación estructural de RFC.
 * DB-direct, en UNA transacción con ROLLBACK (no persiste).
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';
const RFC_EFOS = 'AAA010101AAA';   // proveedor "en lista"
const RFC_BAD = 'RFC-INVALIDO@@';  // formato inválido
const HASH = 'smoke_list_hash_0001';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

const CROSS_SQL = `
  WITH agg AS (
    SELECT upper(trim(ed.rfc)) AS rfc, count(*) AS doc_count,
           coalesce(sum(ed.importe),0) AS importe_total, coalesce(sum(ed.iva),0) AS iva_total,
           min(ed.fecha) AS primera_fecha, max(ed.fecha) AS ultima_fecha
      FROM analytics.expense_documents ed
     WHERE ed.tenant_id = ? AND ed.rfc IS NOT NULL AND btrim(ed.rfc) <> ''
     GROUP BY upper(trim(ed.rfc))
  )
  INSERT INTO fiscal.sat_list_matches
    (tenant_id, lista, rfc, nombre, situacion, doc_count, importe_total, iva_total, primera_fecha, ultima_fecha, list_hash, updated_at)
  SELECT ?, e.lista, e.rfc, e.nombre, e.situacion, a.doc_count, a.importe_total, a.iva_total, a.primera_fecha, a.ultima_fecha, ?, now()
    FROM fiscal.sat_list_rfcs e JOIN agg a ON a.rfc = e.rfc WHERE e.lista = ?
  ON CONFLICT (tenant_id, lista, rfc) DO UPDATE
    SET situacion=EXCLUDED.situacion, doc_count=EXCLUDED.doc_count, importe_total=EXCLUDED.importe_total,
        iva_total=EXCLUDED.iva_total, list_hash=EXCLUDED.list_hash, updated_at=now()
  RETURNING (xmax = 0) AS es_nuevo`;

(async () => {
  try {
    await knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${T}'`);

      // 1. Schema
      const tbls = (await trx.raw(`select table_name from information_schema.tables where table_schema='fiscal'`)).rows.map(r => r.table_name);
      ok(tbls.includes('sat_list_rfcs'), 'tabla fiscal.sat_list_rfcs');
      ok(tbls.includes('sat_list_matches'), 'tabla fiscal.sat_list_matches');
      ok(tbls.includes('rfc_issues'), 'tabla fiscal.rfc_issues');
      for (const t of ['sat_list_matches', 'rfc_issues']) {
        const rls = (await trx.raw(`select relforcerowsecurity f from pg_class where relname='${t}' and relnamespace='fiscal'::regnamespace`)).rows[0];
        ok(rls && rls.f === true, `RLS FORZADO en fiscal.${t}`);
      }

      // 2. Datos: 2 documentos (uno con RFC en lista, uno con RFC inválido) + lista negra
      await trx('analytics.expense_documents').insert([
        { tenant_id: T, sucursal: '00', doc_tipo: 'SMOKE', doc_folio: 'F-1', fecha: '2026-01-15', beneficiario: 'PROV EFOS', rfc: RFC_EFOS, importe: 1160, iva: 160 },
        { tenant_id: T, sucursal: '00', doc_tipo: 'SMOKE', doc_folio: 'F-2', fecha: '2026-01-16', beneficiario: 'PROV RARO', rfc: RFC_BAD, importe: 500, iva: 0 },
      ]).onConflict(['tenant_id', 'sucursal', 'doc_tipo', 'doc_folio']).merge();
      await trx('fiscal.sat_list_rfcs').insert({
        lista: '69B', rfc: RFC_EFOS, nombre: 'PROV EFOS SA', situacion: 'Definitivo', list_hash: HASH,
      }).onConflict(['lista', 'rfc']).merge();

      // 3. Cruce → 1 match nuevo
      const r1 = await trx.raw(CROSS_SQL, [T, T, HASH, '69B']);
      ok(r1.rows.length === 1 && r1.rows[0].es_nuevo === true, 'cruce 69B detecta 1 proveedor (nuevo)');
      const m = await trx('fiscal.sat_list_matches').where({ tenant_id: T, lista: '69B', rfc: RFC_EFOS }).first();
      ok(m && Number(m.importe_total) === 1160 && m.situacion === 'Definitivo', `match importe=1160 situación=Definitivo`);

      // 4. Idempotencia + triage preservado
      await trx('fiscal.sat_list_matches').where({ tenant_id: T, lista: '69B', rfc: RFC_EFOS }).update({ estado: 'descartado' });
      const r2 = await trx.raw(CROSS_SQL, [T, T, HASH, '69B']);
      ok(r2.rows.length === 1 && r2.rows[0].es_nuevo === false, 'segundo cruce = UPSERT (no nuevo)');
      const m2 = await trx('fiscal.sat_list_matches').where({ tenant_id: T, lista: '69B', rfc: RFC_EFOS }).first();
      ok(m2 && m2.estado === 'descartado', 'triage PRESERVADO tras re-cruce');

      // 5. Validación de RFC estructural → RFC_BAD debe caer como formato_invalido
      const bad = (await trx.raw(
        `SELECT upper(trim(rfc)) rfc FROM analytics.expense_documents
          WHERE tenant_id=? AND rfc IS NOT NULL AND upper(trim(rfc)) !~ '^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$'`, [T])).rows;
      ok(bad.some(r => r.rfc === RFC_BAD), 'validación RFC detecta formato_invalido (RFC-INVALIDO@@)');

      throw new Error('__ROLLBACK__');
    });
  } catch (e) {
    if (e.message !== '__ROLLBACK__') { console.error('ERROR:', e.message); fail++; }
  } finally { await knex.destroy(); }

  console.log(`\nFISCAL.0/1 listas SAT + RFC smoke: ${pass} OK, ${fail} fallidos`);
  process.exit(fail === 0 ? 0 : 1);
})();
