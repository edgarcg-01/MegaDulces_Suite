/* eslint-disable no-console */
/**
 * `[LE.1.9]` — Conteos, hallazgos y la cola de excepciones del libro de efectivo (migración
 * `20261027120749`) contra una base REAL: un conteo se compara contra el saldo hasta un asiento,
 * toda diferencia abre un hallazgo con monto, un hallazgo sólo se cierra con un asiento o con la
 * firma de OTRA persona, y el cierre de jornada no deja pasar ni un descuadre interno ni un
 * Suspenso sin explicar.
 *
 * Escribe como `app_runtime`, en UNA transacción con rollback: cero efecto en la base.
 * Uso: DATABASE_URL_NEW=… DATABASE_URL_NEW_RUNTIME=… node database/tests/test-newdb-cashbook-conteos.js
 */
const crypto = require('crypto');
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-cashbook-conteos');

const uuid = () => crypto.randomUUID();
const TT = uuid();
const [U1, U2, U3] = [uuid(), uuid(), uuid()];
const HOY = '2099-06-01';
const AHORA = new Date(Date.now() - 60000).toISOString();

let pass = 0, fail = 0, nomedido = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const skip = (m) => { nomedido++; console.log('  ⃝ NO MEDIDO —', m); };
async function intento(trx, fn) {
  await trx.raw('SAVEPOINT sp');
  let err = null;
  try { await fn(); } catch (e) { err = { code: e.code, constraint: e.constraint, message: String(e.message) }; }
  await trx.raw('ROLLBACK TO SAVEPOINT sp');
  return err;
}
const rechaza = (err, nombre) => !!err && err.code === '23514' && err.constraint === nombre;
const muestra = (err) => (err ? `${err.code} ${err.constraint || ''}` : 'sin error');

const L = (account, amount, pieces) => ({ account, amount_minor: String(amount), ...(pieces ? { pieces } : {}) });
const asiento = (kind, lines, extra = {}) => ({ event_kind: kind, rule_version: 'test-1', value_at: AHORA,
  actor: { kind: 'persona', user_id: U1 }, lines, ...extra });
const contar = async (trx, p) => (await trx.raw('SELECT cashbook.register_count(?::jsonb) AS r', [JSON.stringify({
  kind: 'cierre', source: 'persona', counted_by: U3, counted_at: AHORA, blind: true, ...p })])).rows[0].r;

let hayRol = true;
async function comoApp(trx) {
  if (hayRol) await trx.raw('SET LOCAL ROLE app_runtime');
  await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TT]);
}

(async () => {
  console.log('\n🧪 [LE.1.9] Conteos, hallazgos y excepciones del libro — contra base real\n');
  const t = (await knex.raw(`SELECT to_regprocedure('cashbook.register_count(jsonb)') AS fn`)).rows[0];
  if (!t.fn) {
    skip('la migración 20261027120749 (LE.1.9) no está aplicada en esta base');
    console.log(`\n${pass} ✓ / ${fail} ✗ / ${nomedido} NO MEDIDO`);
    await knex.destroy();
    process.exit(0);
  }
  hayRol = (await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime'`)).rows.length > 0;
  if (!hayRol) skip('no existe app_runtime: los privilegios no se prueban');

  try {
    await knex.transaction(async (trx) => {
      await comoApp(trx);
      for (const c of [
        { code: 'CAJA', name: 'Caja', class: 'fisica', currency: 'MXN', tracks_pieces: true, allows_negative: false },
        { code: 'BOVEDA', name: 'Bóveda', class: 'fisica', currency: 'MXN', tracks_pieces: true, allows_negative: false },
        { code: 'EGRESO', name: 'Egresos', class: 'contrapartida', currency: 'MXN', tracks_pieces: false, allows_negative: true },
        { code: 'APERTURA', name: 'Apertura', class: 'sistema', currency: 'MXN', tracks_pieces: false, allows_negative: true },
        { code: 'SUSPENSO_MXN', name: 'Suspenso', class: 'sistema', currency: 'MXN', tracks_pieces: false, allows_negative: true },
      ]) await trx.raw('SELECT cashbook.open_account(?::jsonb)', [JSON.stringify(c)]);
      await trx.raw('SELECT cashbook.open_day(?, ?)', [HOY, U1]);
      const req = (await trx.raw(`SELECT cashbook.create_request(?::jsonb, clock_timestamp() + interval '1 hour') AS id`, [JSON.stringify(
        { ...asiento('apertura', [L('BOVEDA', 10000000, { 500: 200 }), L('CAJA', 100000, { 100: 10 }), L('APERTURA', -10100000)]), request_id: uuid() })])).rows[0].id;
      await trx.raw('SELECT cashbook.authorize_request(?, ?, NULL)', [req, U2]);

      console.log('── 1. Un conteo se compara contra el saldo hasta el último asiento ──');
      const c1 = await contar(trx, { account: 'CAJA', pieces: { 100: '10' } });
      const seq = Number((await trx.raw('SELECT last_seq FROM cashbook.seq_counters')).rows[0].last_seq);
      ok(c1.difference_minor === '0' && !c1.finding_id && Number(c1.upto_seq) === seq, 'arqueo ciego que cuadra: diferencia 0, sin hallazgo, hasta el asiento vigente');
      const c2 = await contar(trx, { account: 'CAJA', pieces: { 100: '9' } });
      const f2 = (await trx.raw('SELECT * FROM cashbook.findings WHERE id = ?', [c2.finding_id])).rows[0];
      ok(c2.difference_minor === '-10000' && f2 && Number(f2.amount_minor) === -10000 && f2.detail.piezas['100'] === '-1',
        'falta un billete de $100: hallazgo de −$100.00 con la denominación que falta');
      const c3 = await contar(trx, { account: 'CAJA', pieces: { 100: '10', 50: '1' } });
      ok(c3.difference_minor === '5000' && !!c3.finding_id, 'sobra un billete de $50 que el libro no esperaba: hallazgo de +$50.00');

      console.log('\n── 2. Lo que un conteo no puede ser ──');
      const casos = [
        ['cashbook_cuenta_sin_desglose', 'contar una cuenta que no lleva piezas', { account: 'EGRESO', pieces: { 100: '1' } }],
        ['cashbook_denominacion_fuera_de_catalogo', 'un billete de $300', { account: 'CAJA', pieces: { 300: '1' } }],
        ['cashbook_pieza_invalida', 'piezas negativas', { account: 'CAJA', pieces: { 100: '-1' } }],
        ['cashbook_conteo_sin_piezas', 'un importe en vez de piezas (B16)', { account: 'CAJA', pieces: undefined, total: '1000' }],
        ['cashbook_fecha_futura', 'contado en el futuro', { account: 'CAJA', pieces: { 100: '10' }, counted_at: '2199-01-01T00:00:00Z' }],
        ['cashbook_conteo_sorpresa_con_testigo', 'un arqueo sorpresa sin testigo', { account: 'CAJA', pieces: { 100: '10' }, kind: 'sorpresa' }],
        ['cashbook_conteo_sorpresa_con_testigo', 'un arqueo sorpresa donde el testigo es quien cuenta', { account: 'CAJA', pieces: { 100: '10' }, kind: 'sorpresa', witness_by: U3 }],
      ];
      for (const [nombre, que, p] of casos) {
        const e = await intento(trx, () => contar(trx, p));
        ok(rechaza(e, nombre), `NEGATIVA: ${que} → ${nombre} (${muestra(e)})`);
      }
      ok(!(await intento(trx, () => contar(trx, { account: 'CAJA', pieces: { 100: '10' }, kind: 'sorpresa', witness_by: U2 }))), 'un arqueo sorpresa con un testigo distinto sí se registra');

      console.log('\n── 3. La máquina cuenta una vez por lectura; el conteo no se corrige ──');
      const m1 = await contar(trx, { account: 'BOVEDA', source: 'maquina', kind: 'maquina', counted_by: null, service: 'caos-live', source_ref: 'caos:count:1', pieces: { 500: '200' } });
      const m2 = await contar(trx, { account: 'BOVEDA', source: 'maquina', kind: 'maquina', counted_by: null, service: 'caos-live', source_ref: 'caos:count:1', pieces: { 500: '200' } });
      ok(m1.count_id === m2.count_id && m2.repetido === true, 'la misma lectura de la máquina dos veces → un solo conteo');
      ok(m1.difference_minor === '0', 'la bóveda del libro = lo que la máquina cuenta');
      await trx.raw('RESET ROLE');
      ok(rechaza(await intento(trx, () => trx.raw(`UPDATE cashbook.counts SET total_minor = 0 WHERE id = ?`, [c2.count_id])), 'cashbook_inmutable'), 'ni el dueño corrige un conteo');
      ok(rechaza(await intento(trx, () => trx.raw(`UPDATE cashbook.count_pieces SET counted = 10 WHERE count_id = ?`, [c2.count_id])), 'cashbook_inmutable'), 'ni sus piezas');
      await comoApp(trx);

      console.log('\n── 4. Un hallazgo se cierra con un asiento o con la firma de OTRA persona ──');
      const cerrar = (id, entry, note, autoriza) => trx.raw('SELECT cashbook.close_finding(?, ?, NULL, ?, ?, ?)', [id, U1, entry, note, autoriza]);
      ok(rechaza(await intento(trx, () => cerrar(c3.finding_id, null, '', null)), 'cashbook_hallazgo_se_cierra_con_algo'), 'NEGATIVA: sin asiento y sin nota → no se cierra');
      ok(rechaza(await intento(trx, () => cerrar(c3.finding_id, null, 'se contó mal', U1)), 'cashbook_hallazgo_se_cierra_con_algo'), 'NEGATIVA: la nota la autoriza quien cierra → no se cierra');
      await cerrar(c3.finding_id, null, 'el $50 era de la morralla de otro día; se recontó', U2);
      ok((await trx.raw('SELECT state FROM cashbook.findings WHERE id = ?', [c3.finding_id])).rows[0].state === 'cerrado', 'con la nota firmada por otra persona, se cierra');
      ok(rechaza(await intento(trx, () => cerrar(c3.finding_id, null, 'otra vez', U2)), 'cashbook_estado_final'), 'NEGATIVA: un hallazgo cerrado no se vuelve a cerrar');
      const reqF = (await trx.raw(`SELECT cashbook.create_request(?::jsonb, clock_timestamp() + interval '1 hour') AS id`, [JSON.stringify(
        { ...asiento('faltante', [L('EGRESO', 10000), L('CAJA', -10000, { 100: '-1' })]), request_id: uuid() })])).rows[0].id;
      const eF = (await trx.raw('SELECT cashbook.authorize_request(?, ?, NULL) AS id', [reqF, U2])).rows[0].id;
      await cerrar(c2.finding_id, eF, null, null);
      ok((await trx.raw('SELECT closing_entry_id FROM cashbook.findings WHERE id = ?', [c2.finding_id])).rows[0].closing_entry_id === eF, 'el faltante autorizado cierra el hallazgo del conteo');
      await trx.raw('RESET ROLE');
      ok(rechaza(await intento(trx, () => trx.raw(`UPDATE cashbook.findings SET state = 'abierto', closed_at = NULL, closed_by = NULL WHERE id = ?`, [c2.finding_id])), 'cashbook_estado_final'),
        'NEGATIVA: ni el dueño reabre un hallazgo cerrado');
      await comoApp(trx);

      console.log('\n── 5. La cola de excepciones: una vez por hecho, se resuelve con algo ──');
      const q = { source: 'caos', event_ref: 'caos:AST:1478', reason: 'el total no coincide con su desglose', payload: { total: '20.00' } };
      const q1 = (await trx.raw('SELECT cashbook.enqueue_external(?::jsonb) AS id', [JSON.stringify(q)])).rows[0].id;
      const q2 = (await trx.raw('SELECT cashbook.enqueue_external(?::jsonb) AS id', [JSON.stringify(q)])).rows[0].id;
      ok(q1 === q2, 'el mismo hecho dos veces → una sola excepción (nunca se pierde, nunca se duplica)');
      ok(rechaza(await intento(trx, () => trx.raw('SELECT cashbook.resolve_external(?, ?, NULL, ?)', [q1, U1, ' '])), 'cashbook_excepcion_resuelta'), 'NEGATIVA: resolver sin asiento ni nota');
      await trx.raw('SELECT cashbook.resolve_external(?, ?, NULL, ?)', [q1, U1, 'la máquina confirmó el desglose; se registra aparte']);
      ok(rechaza(await intento(trx, () => trx.raw('SELECT cashbook.resolve_external(?, ?, NULL, ?)', [q1, U1, 'x'])), 'cashbook_estado_final'), 'NEGATIVA: no se resuelve dos veces');

      console.log('\n── 6. El cierre: Suspenso sin explicar abre un hallazgo; un descuadre interno no deja cerrar ──');
      await trx.raw('SELECT cashbook.post_entry(?::jsonb)', [JSON.stringify(asiento('retiro_caos', [L('BOVEDA', -50000, { 500: '-1' }), L('SUSPENSO_MXN', 50000)]))]);
      await trx.raw('RESET ROLE');
      await trx.raw('ALTER TABLE cashbook.account_balances DISABLE TRIGGER USER');
      await trx.raw(`UPDATE cashbook.account_balances b SET balance_minor = balance_minor + 1 FROM cashbook.accounts a WHERE a.id = b.account_id AND a.tenant_id = ? AND a.code = 'EGRESO'`, [TT]);
      await comoApp(trx);
      ok(rechaza(await intento(trx, () => trx.raw('SELECT cashbook.close_day(?, ?, NULL, ?, NULL)', [HOY, U1, U2])), 'cashbook_descuadre_interno'), 'NEGATIVA: con la cabecera alterada la jornada NO cierra (I10)');
      await trx.raw('RESET ROLE');
      await trx.raw(`UPDATE cashbook.account_balances b SET balance_minor = balance_minor - 1 FROM cashbook.accounts a WHERE a.id = b.account_id AND a.tenant_id = ? AND a.code = 'EGRESO'`, [TT]);
      await trx.raw('ALTER TABLE cashbook.account_balances ENABLE TRIGGER USER');
      await comoApp(trx);
      await trx.raw('SELECT cashbook.close_day(?, ?, NULL, ?, NULL)', [HOY, U1, U2]);
      const fs = (await trx.raw(`SELECT amount_minor FROM cashbook.findings WHERE source = 'cierre' AND business_date = ?`, [HOY])).rows;
      ok(fs.length === 1 && Number(fs[0].amount_minor) === 50000, 'el Suspenso de $500.00 al cierre quedó como hallazgo (B46)');
      // Los dos de conteo ya se cerraron en §4: abierto queda sólo el del Suspenso.
      const ab = (await trx.raw('SELECT source, account_code, dias_abierto FROM cashbook.v_hallazgos_abiertos')).rows;
      ok(ab.length === 1 && ab[0].source === 'cierre' && ab[0].account_code === 'SUSPENSO_MXN' && Number(ab[0].dias_abierto) === 0,
        `la bandeja de hallazgos abiertos muestra el del Suspenso con su antigüedad (${JSON.stringify(ab)})`);

      console.log('\n── 7. La app no escribe estas tablas; y la mutación del candado del conteo ──');
      if (hayRol) {
        const e = await intento(trx, () => trx('cashbook.findings').insert({ tenant_id: TT, source: 'otro', amount_minor: 1 }));
        ok(!!e && e.code === '42501', `INSERT directo en hallazgos → permiso denegado (${muestra(e)})`);
      }
      await trx.raw('RESET ROLE');
      await trx.raw('ALTER TABLE cashbook.counts DISABLE TRIGGER trg_cashbook_conteos_inmutable');
      ok(!(await intento(trx, () => trx.raw(`UPDATE cashbook.counts SET total_minor = 0 WHERE id = ?`, [c2.count_id]))), 'MUTACIÓN: sin el trigger el conteo SÍ se corrige: el trigger es el candado');

      throw new Error('__rollback__');
    });
  } catch (e) {
    if (e.message !== '__rollback__') { fail++; console.log('  💥', e.message); }
  }
  console.log(`\n${pass} ✓ / ${fail} ✗ / ${nomedido} NO MEDIDO`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})();
