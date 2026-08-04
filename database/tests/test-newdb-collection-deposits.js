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

    // ── 3b. Controles CC.3: cuenta propia + folio electrónico (dedup) ────────
    const hasCuenta = await knex.schema.withSchema('finance').hasColumn('collection_deposits', 'cuenta_propia');
    const hasRef = await knex.schema.withSchema('finance').hasColumn('collection_deposits', 'ref_norm');
    ok(hasCuenta, 'columna cuenta_propia existe');
    ok(hasRef, 'columna ref_norm (folio electrónico normalizado) existe');
    // Réplica de isOwnAccount: dígitos de la cuenta destino terminan en una cuenta propia.
    const tails = await knex('finance.bank_accounts').where({ tenant_id: T, kind: 'bank', active: true })
      .whereRaw(`account_label ~ '^[0-9]{3,}$'`).pluck('account_label');
    const isOwn = (dest) => { const d = String(dest || '').replace(/\D/g, ''); return d && tails.length ? tails.some((t) => t.length >= 3 && d.endsWith(t)) : null; };
    ok(tails.includes('3041'), 'seed CB tiene la cuenta BANORTE 3041');
    ok(isOwn('1326933041') === true, 'cuenta 1326933041 (ticket real) → cuenta propia (termina en 3041)');
    ok(isOwn('0009999999') === false, 'cuenta ajena → NO propia');

    // ── 4. Flujo attach → join → validar → rechazar → CHECK (rollback) ───────
    await knex.transaction(async (trx) => {
      const cobroMonto = Number(cobro.monto);
      const [row] = await trx('finance.collection_deposits').insert({
        tenant_id: T, sucursal: '00', folio: '0016926',
        cliente_code: cobro.cliente_code, cliente_nombre: cobro.cliente_nombre,
        cobro_date: cobro.cobro_date, cobro_monto: cobroMonto,
        files: JSON.stringify([{ role: 'deposito', url: 'http://x/y.jpg', public_id: 'x/y', kind: 'image' }]),
        ocr_monto: cobroMonto, ocr_banco: 'BANORTE', ocr_cuenta_dest: '1326933041',
        ocr_referencia: '28072026065731101001 60926', ocr_status: 'ok',
        monto_match: matches(cobroMonto, cobroMonto), cuenta_propia: isOwn('1326933041'), created_by: 'smoke',
      }).returning(['id', 'status', 'cuenta_propia', 'ref_norm']);
      ok(row.status === 'recibido', 'attach: nuevo comprobante → estado recibido');
      ok(row.cuenta_propia === true, 'attach: cuenta_propia=true (depósito a cuenta de la empresa)');
      ok(row.ref_norm === '2807202606573110100160926', 'ref_norm = folio electrónico solo dígitos (generada)');

      // Dedup determinista: misma referencia en OTRO cobro → se detecta.
      await trx('finance.collection_deposits').insert({
        tenant_id: T, sucursal: '00', folio: 'OTRO-999',
        files: JSON.stringify([{ role: 'deposito', url: 'http://x/z.jpg' }]),
        ocr_referencia: '2807-2026-0657-3110-1001-60926', ocr_status: 'ok', created_by: 'smoke',
      });
      const dupHit = await trx('finance.collection_deposits')
        .where('ref_norm', '2807202606573110100160926').whereNot('status', 'rechazado')
        .whereNot((qb) => qb.where('sucursal', '00').andWhere('folio', '0016926'))
        .distinct('sucursal', 'folio');
      ok(dupHit.length === 1 && dupHit[0].folio === 'OTRO-999', 'dedup: misma referencia en otro cobro detectada (pese a guiones/espacios)');

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

      // ── 4b. Three-way match: abono real en el estado de cuenta (CB) ─────────
      // Réplica de bankMatch: cuenta propia (label sufijo de la cuenta destino) +
      // monto (tol $1) + ventana de fechas. Sembramos un abono controlado y lo casamos.
      const ba = await trx('finance.bank_accounts').where({ tenant_id: T, kind: 'bank' })
        .whereRaw(`account_label = '3041'`).first('id');
      const [st] = await trx('finance.bank_statements').insert({
        tenant_id: T, bank_account_id: ba.id, period: '2026-07', source_file: 'smoke',
      }).returning(['id']);
      await trx('finance.bank_movements').insert({
        tenant_id: T, statement_id: st.id, bank_account_id: ba.id,
        movement_date: '2026-07-28', amount_in: 8874, amount_out: 0,
        concept: 'DEPOSITO EFECTIVO RUTA', client_uuid: 'smoke-abono-1',
      });
      // depósito sintético: cuenta 1326933041 (→3041), $8,874, 28-jul.
      const bankHit = await trx('finance.bank_movements as m')
        .join('finance.bank_accounts as a', 'a.id', 'm.bank_account_id')
        .where('m.tenant_id', T)
        .whereRaw('m.amount_in BETWEEN ? AND ?', [8873, 8875])
        .whereBetween('m.movement_date', ['2026-07-27', '2026-08-03'])
        .where('m.bank_account_id', ba.id)
        .select('m.id', trx.raw('m.amount_in::numeric amt'));
      ok(bankHit.length === 1 && Number(bankHit[0].amt) === 8874, 'bankMatch: abono $8,874 en BANORTE 3041 el 28-jul → CONFIRMADO');
      const noHit = await trx('finance.bank_movements as m')
        .where('m.tenant_id', T).where('m.bank_account_id', ba.id)
        .whereRaw('m.amount_in BETWEEN ? AND ?', [9999, 10001])
        .whereBetween('m.movement_date', ['2026-07-27', '2026-08-03']).select('m.id');
      ok(noHit.length === 0, 'bankMatch: monto sin abono correspondiente → sin_match');

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
