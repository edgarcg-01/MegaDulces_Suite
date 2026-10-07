/* eslint-disable no-console */
/**
 * GX.8 — Smoke DB-directo de la Comprobación de Gastos (2ª etapa del ciclo).
 * Verifica contra la DB real:
 *   1. Schema: finance.expense_comprobaciones (RLS FORZADO).
 *   2. Fuente del autocomplete: analytics.expense_documents tiene gastos XA1001.
 *   3. Flujo attach → statusByGasto/Solicitud → validar → rechazar → CHECK, rollback.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

(async () => {
  try {
    // ── 1. Schema ──────────────────────────────────────────────────────────
    const reg = await knex.raw(`SELECT to_regclass('finance.expense_comprobaciones') ec`);
    ok(!!reg.rows[0].ec, 'finance.expense_comprobaciones existe');
    const rls = await knex.raw(`SELECT relforcerowsecurity f FROM pg_class WHERE oid='finance.expense_comprobaciones'::regclass`);
    ok(rls.rows[0]?.f === true, 'expense_comprobaciones con RLS FORZADO');

    // ── 2. Fuente del autocomplete (gastos XA1001) ─────────────────────────
    const [g] = await knex('analytics.expense_documents').where({ tenant_id: T, doc_tipo: 'XA1001' }).count('* as n');
    ok(Number(g.n) > 0, `analytics.expense_documents tiene gastos XA1001 (${g.n}) para el autocomplete`);
    const gasto = await knex('analytics.expense_documents')
      .where({ tenant_id: T, doc_tipo: 'XA1001' })
      .whereNotNull('doc_folio')
      .first('sucursal', 'doc_folio', 'beneficiario', 'solicitud_folio', knex.raw('importe::numeric AS importe'));
    ok(!!gasto && !!gasto.doc_folio, `gasto de muestra: folio ${gasto && gasto.doc_folio}`);
    // searchGastos replica: ilike sobre doc_folio/beneficiario
    const term = String(gasto.doc_folio).slice(0, 3);
    const found = await knex('analytics.expense_documents')
      .where({ tenant_id: T, doc_tipo: 'XA1001' })
      .andWhere((w) => w.whereILike('doc_folio', `%${term}%`).orWhereILike('beneficiario', `%${term}%`))
      .limit(5).select('doc_folio');
    ok(found.length > 0, `searchGastos ('${term}') devuelve ${found.length} gasto(s)`);

    // ── 3. Flujo attach → status → validar → rechazar → CHECK (rollback) ────
    await knex.transaction(async (trx) => {
      const [row] = await trx('finance.expense_comprobaciones').insert({
        tenant_id: T, solicitante: 'smoke', departamento: 'TESORERIA', departamento_code: '1-09-07',
        folio_gasto: gasto.doc_folio, folio_solicitud: gasto.solicitud_folio || null,
        fecha_comprobacion: '2026-08-03', folio_comprobacion: '9999',
        proveedor: gasto.beneficiario || 'PROVEEDOR X', importe: Number(gasto.importe) || 0,
        files: JSON.stringify([{ role: 'comprobacion', url: 'http://x/c.pdf', public_id: 'x/c', kind: 'pdf' }]),
        created_by: 'smoke',
      }).returning(['id', 'folio_gasto', 'folio_solicitud', 'status']);
      ok(row.status === 'recibida', 'attach: nueva comprobación → recibida');

      // statusByGasto replica (último estado por folio_gasto)
      const sg = await trx.raw(`
        SELECT status FROM (
          SELECT folio_gasto, status, row_number() OVER (PARTITION BY folio_gasto ORDER BY created_at DESC) rn
          FROM finance.expense_comprobaciones WHERE folio_gasto=?
        ) x WHERE rn=1`, [gasto.doc_folio]);
      ok(sg.rows[0]?.status === 'recibida', 'statusByGasto: folio_gasto → recibida');

      const [v] = await trx('finance.expense_comprobaciones').where({ id: row.id }).whereIn('status', ['recibida', 'rechazada'])
        .update({ status: 'validada', validated_by: 'rev', validated_at: trx.fn.now() }).returning(['status']);
      ok(v.status === 'validada', 'validar: recibida → validada');

      const [rj] = await trx('finance.expense_comprobaciones').where({ id: row.id }).whereIn('status', ['recibida', 'validada'])
        .update({ status: 'rechazada', motivo_rechazo: 'x' }).returning(['status']);
      ok(rj.status === 'rechazada', 'rechazar: validada → rechazada');

      let bad = false;
      try { await trx('finance.expense_comprobaciones').insert({ tenant_id: T, solicitante: 'x', departamento: 'x', folio_gasto: 'Z', proveedor: 'x', status: 'foo' }); }
      catch (e) { bad = e.code === '23514'; }
      ok(bad, 'CHECK rechaza un status inválido');

      throw { __rollback: true };
    }).catch((e) => { if (!e || !e.__rollback) throw e; });

    const [after] = await knex('finance.expense_comprobaciones').where({ folio_comprobacion: '9999', solicitante: 'smoke' }).count('* as n');
    ok(Number(after.n) === 0, 'rollback: 0 comprobaciones persistidas (no ensucia data real)');

    console.log(`\nGX.8 expense-comprobaciones: ${pass} ✓ / ${fail} ✗`);
    await knex.destroy();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('ERROR:', e.message);
    await knex.destroy().catch(() => {});
    process.exit(1);
  }
})();
