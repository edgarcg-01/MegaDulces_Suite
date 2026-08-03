/* eslint-disable no-console */
/**
 * CC (Comprobantes de Cobranza) — Smoke DB-direct del adjunto de depósito a un cobro.
 *
 * Verifica contra la DB real:
 *   1. Schema: analytics.erp_collections (espejo, sin RLS) + finance.collection_deposits
 *      (RLS FORZADO).
 *   2. Datos: el importer pobló los cobros UA0501 (incluye el cobro real 0016926
 *      = $51,049.27, forma_pago derivada 'deposito').
 *   3. Lógica monto_match (réplica del servicio): tolerancia $1.
 *   4. Flujo dentro de una trx con ROLLBACK (cero efecto real): attach → el JOIN de
 *      listCobros ve 1 comprobante + cuadre → validar → rechazar → CHECK de estado.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

const TOL = 1.0;
// Réplica EXACTA de CollectionDepositsService: |ocr - cobro| <= 1 → cuadra.
const matches = (ocr, cobro) => (ocr == null ? null : Math.abs(ocr - cobro) <= TOL);

(async () => {
  try {
    // ── 1. Schema ───────────────────────────────────────────────────────────
    const reg = await knex.raw(`SELECT to_regclass('analytics.erp_collections') a, to_regclass('finance.collection_deposits') f`);
    ok(!!reg.rows[0].a, 'analytics.erp_collections existe');
    ok(!!reg.rows[0].f, 'finance.collection_deposits existe');
    const rls = await knex.raw(`SELECT relforcerowsecurity FROM pg_class WHERE oid = 'finance.collection_deposits'::regclass`);
    ok(rls.rows[0]?.relforcerowsecurity === true, 'finance.collection_deposits con RLS FORZADO');

    // ── 2. Datos del importer ────────────────────────────────────────────────
    const [c] = await knex('analytics.erp_collections').where({ tenant_id: T }).count('* as n');
    ok(Number(c.n) > 20000, `erp_collections poblada (${c.n} cobros UA0501)`);
    const cobro = await knex('analytics.erp_collections').where({ tenant_id: T, sucursal: '00', folio: '0016926' })
      .first('cliente_code', 'cliente_nombre', 'cobro_date', knex.raw('monto::numeric AS monto'), 'forma_pago');
    ok(cobro && Math.abs(Number(cobro.monto) - 51049.27) < 0.01, 'cobro real 0016926 = $51,049.27 presente');
    ok(cobro && cobro.forma_pago === 'deposito', "forma_pago derivada del concepto = 'deposito'");

    // ── 3. Lógica de cuadre (monto_match) ────────────────────────────────────
    ok(matches(51049.27, 51049.27) === true, 'match exacto → cuadra');
    ok(matches(51049.77, 51049.27) === true, 'diferencia $0.50 → cuadra (dentro de tolerancia $1)');
    ok(matches(51000.00, 51049.27) === false, 'diferencia $49 → NO cuadra');
    ok(matches(null, 51049.27) === null, 'sin monto OCR → match null');

    // ── 4. Flujo attach → join → validar → rechazar → CHECK (rollback) ───────
    await knex.transaction(async (trx) => {
      const cobroMonto = Number(cobro.monto);
      const [row] = await trx('finance.collection_deposits').insert({
        tenant_id: T, sucursal: '00', folio: '0016926',
        cliente_code: cobro.cliente_code, cliente_nombre: cobro.cliente_nombre,
        cobro_date: cobro.cobro_date, cobro_monto: cobroMonto,
        files: JSON.stringify([{ role: 'deposito', url: 'http://x/y.jpg', public_id: 'x/y', kind: 'image' }]),
        ocr_monto: cobroMonto, ocr_banco: 'BANORTE', ocr_referencia: 'TEST123', ocr_status: 'ok',
        monto_match: matches(cobroMonto, cobroMonto), created_by: 'smoke',
      }).returning(['id', 'status']);
      ok(row.status === 'recibido', 'attach: nuevo comprobante → estado recibido');

      // Réplica del LEFT JOIN de listCobros.
      const j = await trx.raw(`
        SELECT COALESCE(d.n,0)::int deposits, d.last_status, COALESCE(d.any_match,false) any_match
        FROM analytics.erp_collections c
        LEFT JOIN (
          SELECT sucursal, folio, count(*) n,
                 (array_agg(status ORDER BY created_at DESC))[1] last_status,
                 bool_or(monto_match) any_match
          FROM finance.collection_deposits GROUP BY sucursal, folio
        ) d ON c.sucursal=d.sucursal AND c.folio=d.folio
        WHERE c.tenant_id=? AND c.sucursal='00' AND c.folio='0016926'`, [T]);
      ok(Number(j.rows[0].deposits) === 1, 'join listCobros: el cobro ahora muestra 1 comprobante');
      ok(j.rows[0].any_match === true, 'join: monto_match=true (OCR == cobro)');
      ok(j.rows[0].last_status === 'recibido', 'join: último estado = recibido');

      const [v] = await trx('finance.collection_deposits').where({ id: row.id }).whereIn('status', ['recibido', 'rechazado'])
        .update({ status: 'validado', validated_by: 'rev', validated_at: trx.fn.now() }).returning(['status']);
      ok(v.status === 'validado', 'validar: recibido → validado');

      const [rj] = await trx('finance.collection_deposits').where({ id: row.id }).whereIn('status', ['recibido', 'validado'])
        .update({ status: 'rechazado', motivo_rechazo: 'monto no cuadra', validated_by: 'rev' }).returning(['status']);
      ok(rj.status === 'rechazado', 'rechazar: validado → rechazado con motivo');

      let checkBad = false;
      try {
        await trx('finance.collection_deposits').insert({ tenant_id: T, sucursal: '00', folio: 'ZZZ', status: 'foo' });
      } catch (e) { checkBad = e.code === '23514'; }
      ok(checkBad, 'CHECK rechaza un status inválido');

      throw { __rollback: true };
    }).catch((e) => { if (!e || !e.__rollback) throw e; });

    const [after] = await knex('finance.collection_deposits').where({ sucursal: '00', folio: '0016926' }).count('* as n');
    ok(Number(after.n) === 0, 'rollback: 0 comprobantes persistidos (no ensucia la data real)');

    console.log(`\nCC collection-deposits: ${pass} ✓ / ${fail} ✗`);
    await knex.destroy();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('ERROR:', e.message);
    await knex.destroy().catch(() => {});
    process.exit(1);
  }
})();
