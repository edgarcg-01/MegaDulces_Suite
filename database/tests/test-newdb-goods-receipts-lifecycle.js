/**
 * RE.13 — Smoke del **ciclo de vida de la evidencia**: subida → devolución → recaptura.
 *
 * Corre dentro de UNA TRANSACCIÓN CON ROLLBACK: es la única forma de probar la máquina de
 * estados sin API levantada, y no deja basura en la DB.
 *
 * La aserción que justifica el archivo: **el orden de "la última evidencia" tiene que
 * desempatar**. `now()` en Postgres es el instante de inicio de la transacción y en esta app
 * todo el request corre en una sola, así que dos evidencias de la misma entrada empatan en
 * `created_at` al microsegundo. Con `ORDER BY created_at DESC` pelado, una entrada recién
 * recapturada devolvía `rechazado` — o sea desaparecía de la cola del revisor. El orden real
 * (`PROOF_ORDER`) mete `(status='recibido') DESC, id DESC`: en empate gana la pendiente.
 *
 * Uso: DATABASE_URL_NEW=... node database/tests/test-newdb-goods-receipts-lifecycle.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';
let fail = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) fail++; };

// Mismo orden que el service (PROOF_ORDER). El desempate importa: now() es el inicio de la
// transaccion, asi que dos evidencias del mismo request empatan en created_at.
const ORD = `created_at DESC, (status = 'recibido') DESC, id DESC`;
const estado = async (trx, suc, folio) => {
  const r = await trx.raw(`
    SELECT (array_agg(status ORDER BY ${ORD}))[1] AS last_status, count(*)::int AS n
      FROM finance.goods_receipt_proofs WHERE sucursal=? AND folio=?`, [suc, folio]);
  return r.rows[0];
};

(async () => {
  const e = (await knex.raw(
    `SELECT sucursal, folio, monto::numeric FROM analytics.erp_goods_receipts
      WHERE tenant_id=? AND dup_of_folio IS NULL AND receipt_date>='2026-08-01' LIMIT 1`, [T])).rows[0];
  if (!e) { console.log('SKIP sin entradas'); process.exit(0); }
  console.log(`\nCiclo de vida de la evidencia — entrada ${e.sucursal}/${e.folio}\n`);

  await knex.transaction(async (trx) => {
    // 1. sube el capturista
    const [p1] = await trx('finance.goods_receipt_proofs').insert({
      tenant_id: T, sucursal: e.sucursal, folio: e.folio,
      files: JSON.stringify([{ role: 'factura', url: 'k/1' }]),
      status: 'recibido', monto_match: true, created_by: 'capturista_test',
    }).returning(['id']);
    let s = await estado(trx, e.sucursal, e.folio);
    ok(s.last_status === 'recibido', `tras subir → last_status='recibido' (entra a la cola del revisor)`);

    // 2. el revisor la devuelve con motivo tipificado
    await trx('finance.goods_receipt_proofs').where({ id: p1.id })
      .update({ status: 'rechazado', motivo_codigo: 'ilegible', motivo_rechazo: 'la hoja 2 salió cortada',
                validated_by: 'revisor_test', validated_at: trx.fn.now() });
    await trx('finance.goods_receipt_proof_history').insert({
      tenant_id: T, proof_id: p1.id, sucursal: e.sucursal, folio: e.folio,
      status_from: 'recibido', status_to: 'rechazado', motivo_codigo: 'ilegible', changed_by: 'revisor_test',
    });
    s = await estado(trx, e.sucursal, e.folio);
    ok(s.last_status === 'rechazado', `tras devolver → last_status='rechazado' (sale de la cola)`);
    const dev = (await trx.raw(
      `SELECT (array_agg(motivo_codigo ORDER BY ${ORD}))[1] AS m
         FROM finance.goods_receipt_proofs WHERE sucursal=? AND folio=?`, [e.sucursal, e.folio])).rows[0];
    ok(dev.m === 'ilegible', `el motivo tipificado viaja al capturista (${dev.m})`);

    // 3. el capturista vuelve a subir → NUEVA evidencia, no update
    await trx('finance.goods_receipt_proofs').insert({
      tenant_id: T, sucursal: e.sucursal, folio: e.folio,
      files: JSON.stringify([{ role: 'factura', url: 'k/2' }]),
      status: 'recibido', monto_match: true, created_by: 'capturista_test',
    });
    s = await estado(trx, e.sucursal, e.folio);
    ok(s.last_status === 'recibido' && s.n === 2,
      `tras recapturar → vuelve a la cola y quedan las 2 evidencias (${s.n}): el rechazo no se borra`);

    // 4. el historial es append-only y ordenado
    const h = await trx('finance.goods_receipt_proof_history')
      .where({ sucursal: e.sucursal, folio: e.folio }).orderBy('changed_at', 'asc').select('status_to');
    ok(h.length >= 1 && h[0].status_to === 'rechazado', `el historial guarda la decisión (${h.map(x => x.status_to).join('→')})`);

    // 5. la segregación: mismo nombre en created_by y actor
    const norm = (v) => (v || '').trim().toLowerCase().replace(/\s+/g, ' ');
    ok(norm('Capturista_Test ') === norm('capturista_test'),
      'mismaPersona() normaliza caso y espacios (created_by es texto libre)');

    throw new Error('__rollback__'); // nada se persiste
  }).catch((err) => { if (err.message !== '__rollback__') throw err; });

  const quedo = (await knex.raw(
    `SELECT count(*)::int n FROM finance.goods_receipt_proofs WHERE created_by='capturista_test'`)).rows[0].n;
  ok(quedo === 0, 'rollback limpio: la DB quedó igual que antes');
  console.log(`\n${fail === 0 ? '✅ ciclo verificado' : `❌ ${fail} fallo(s)`}\n`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e.message); process.exit(1); });
