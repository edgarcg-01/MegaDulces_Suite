/* eslint-disable no-console */
/**
 * `[LE.1.12]` — El libro de efectivo de partida doble (`cashbook`, migración `20261027111930`) contra
 * una base REAL: cada invariante con su violación (esperando el nombre exacto), las mutaciones que
 * prueban QUÉ lo detiene, la cadena de hashes, y dos cajeros a la vez.
 *
 *   · escribe como `app_runtime` (el rol de prod), que no tiene INSERT/UPDATE/DELETE en el libro;
 *   · las secciones 1–9 corren en UNA transacción con rollback: cero efecto;
 *   · la 10 (concurrencia) necesita confirmar: usa un TENANT AL AZAR por corrida. El libro es
 *     inmutable por diseño, así que esas filas se quedan en la base de prueba (nunca en prod: guardia).
 *
 * Uso: DATABASE_URL_NEW=… DATABASE_URL_NEW_RUNTIME=… node database/tests/test-newdb-cashbook-libro.js [--rendimiento]
 */
const crypto = require('crypto');
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-cashbook-libro');

const uuid = () => crypto.randomUUID();
const TT = uuid();          // tenant de las secciones con rollback
const TC = uuid();          // tenant de la concurrencia (se confirma)
const [U1, U2, U3] = [uuid(), uuid(), uuid()];   // cajera, quien autoriza, un tercero
const [E1, E2] = [uuid(), uuid()];               // sus empleados (U3 es OTRO usuario del empleado E1)
const HOY = '2099-04-02';

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
const sinPermiso = (err) => !!err && err.code === '42501';
const muestra = (err) => (err ? `${err.code} ${err.constraint || ''} ${err.message.slice(0, 60)}` : 'sin error');

const L = (account, amount, pieces) => ({ account, amount_minor: String(amount), ...(pieces ? { pieces } : {}) });
const asiento = (kind, lines, extra = {}) => ({
  event_kind: kind, rule_version: 'test-1', value_at: new Date().toISOString(),
  actor: { kind: 'persona', user_id: U1, employee_id: E1 }, lines, ...extra,
});
const post = async (trx, p) => (await trx.raw('SELECT cashbook.post_entry(?::jsonb) AS id', [JSON.stringify(p)])).rows[0].id;
const pedir = async (trx, p, vence = '1 hour') => (await trx.raw(
  `SELECT cashbook.create_request(?::jsonb, clock_timestamp() + ?::interval) AS id`, [JSON.stringify(p), vence])).rows[0].id;
const autorizar = async (trx, req, user, emp) => (await trx.raw('SELECT cashbook.authorize_request(?, ?, ?) AS id', [req, user, emp])).rows[0].id;
const saldo = async (trx, code) => Number((await trx.raw(
  `SELECT balance_minor FROM cashbook.v_saldos WHERE code = ?`, [code])).rows[0].balance_minor);
const piezas = async (trx, code, k) => Number(((await trx.raw(
  `SELECT pieces FROM cashbook.v_saldos_piezas WHERE code = ? AND denom_key = ?`, [code, k])).rows[0] || { pieces: 0 }).pieces);
const conPeticion = (p) => ({ ...p, request_id: uuid(), request_hash: crypto.createHash('sha256').update(JSON.stringify(p.lines)).digest('hex') });

const CUENTAS = [
  { code: 'CAJA', name: 'Caja', class: 'fisica', currency: 'MXN', tracks_pieces: true, allows_negative: false },
  { code: 'BOVEDA', name: 'Bóveda', class: 'fisica', currency: 'MXN', tracks_pieces: true, allows_negative: false },
  { code: 'CAJA_USD', name: 'Caja USD', class: 'fisica', currency: 'USD', tracks_pieces: true, allows_negative: false },
  { code: 'CUSTODIA_E1', name: 'Custodia', class: 'custodia', currency: 'MXN', tracks_pieces: false, allows_negative: false, holder_kind: 'empleado', holder_ref: 'E1' },
  { code: 'POR_RENDIR_R27', name: 'Por rendir ruta 27', class: 'por_rendir', currency: 'MXN', tracks_pieces: false, allows_negative: true, holder_kind: 'ruta', holder_ref: '27' },
  { code: 'COBRANZA', name: 'Cobranza', class: 'contrapartida', currency: 'MXN', tracks_pieces: false, allows_negative: true },
  { code: 'EGRESO', name: 'Egresos', class: 'contrapartida', currency: 'MXN', tracks_pieces: false, allows_negative: true },
  { code: 'APERTURA', name: 'Apertura', class: 'sistema', currency: 'MXN', tracks_pieces: false, allows_negative: true },
];

async function comoApp(trx, tenant) {
  if (hayRol) await trx.raw('SET LOCAL ROLE app_runtime');
  await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [tenant]);
}
async function comoDueno(trx) { await trx.raw('RESET ROLE'); }
let hayRol = true;

async function preparar(trx, tenant) {
  for (const c of CUENTAS) await trx.raw('SELECT cashbook.open_account(?::jsonb)', [JSON.stringify({ ...c, user_id: U1 })]);
  await trx.raw('SELECT cashbook.open_day(?, ?)', [HOY, U1]);
  // Apertura: 200 × $500 en la bóveda y 10 × $100 en la caja, autorizada por otra persona.
  const req = await pedir(trx, conPeticion(asiento('apertura', [
    L('BOVEDA', 10000000, { 500: 200 }), L('CAJA', 100000, { 100: 10 }), L('APERTURA', -10100000)])));
  return autorizar(trx, req, U2, E2);
  void tenant;
}

(async () => {
  console.log('\n🧪 [LE.1] El libro de efectivo de partida doble — contra base real\n');
  const t = (await knex.raw(`SELECT to_regprocedure('cashbook.post_entry(jsonb)') AS fn`)).rows[0];
  if (!t.fn) {
    skip('la migración 20261027111930 (LE.1) no está aplicada en esta base');
    console.log(`\n${pass} ✓ / ${fail} ✗ / ${nomedido} NO MEDIDO`);
    await knex.destroy();
    process.exit(0);
  }
  hayRol = (await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime'`)).rows.length > 0;
  if (!hayRol) skip('no existe app_runtime: los privilegios no se prueban');
  const hayDdl = (await knex.raw(`SELECT 1 FROM pg_event_trigger WHERE evtname = 'cashbook_ddl_fin'`)).rows.length > 0;

  try {
    await knex.transaction(async (trx) => {
      await comoApp(trx, TT);

      console.log('── 1. La app no escribe tablas del libro: sólo llama funciones (B39) ──');
      ok(sinPermiso(await intento(trx, () => trx('cashbook.entries').insert({ tenant_id: TT, seq: 1, business_date: HOY, value_at: new Date(), event_kind: 'x', rule_version: 'x', actor_kind: 'persona', created_by: U1, prev_hash: 'GENESIS' }))),
        'INSERT directo en cashbook.entries → permiso denegado');
      ok(sinPermiso(await intento(trx, () => trx.raw(`UPDATE cashbook.account_balances SET balance_minor = 0`))), 'UPDATE de saldos → permiso denegado');
      ok(sinPermiso(await intento(trx, () => trx.raw(`SELECT cashbook._post('{}'::jsonb, NULL, NULL, NULL)`))), 'la función interna _post → permiso denegado');
      ok(sinPermiso(await intento(trx, () => trx.raw(`TRUNCATE cashbook.entry_pieces`))), 'TRUNCATE → permiso denegado');
      ok(sinPermiso(await intento(trx, () => trx.raw(`SELECT * FROM cashbook.ddl_audit`))), 'la bitácora de DDL no la lee la app');

      console.log('\n── 2. Sin tenant no hay libro ──');
      await trx.raw(`SELECT set_config('app.tenant_id', '', true)`);
      ok(rechaza(await intento(trx, () => post(trx, asiento('gasto', []))), 'cashbook_sin_tenant'), 'sin app.tenant_id → cashbook_sin_tenant (nunca cero filas en silencio)');
      await comoApp(trx, TT);

      console.log('\n── 3. Cuentas, jornada y apertura con cuatro ojos ──');
      ok(rechaza(await intento(trx, () => trx.raw('SELECT cashbook.open_account(?::jsonb)', [JSON.stringify({ code: 'MALA', name: 'x', class: 'fisica', currency: 'MXN', tracks_pieces: true, allows_negative: true })])), 'cashbook_cuenta_fisica_no_negativa'),
        'una cuenta física que admite negativo no se abre');
      for (const c of CUENTAS) await trx.raw('SELECT cashbook.open_account(?::jsonb)', [JSON.stringify({ ...c, user_id: U1 })]);
      ok(rechaza(await intento(trx, () => post(trx, asiento('gasto', [L('EGRESO', 100), L('POR_RENDIR_R27', -100)]))), 'cashbook_sin_jornada_abierta'), 'sin jornada abierta no se registra');
      await trx.raw('SELECT cashbook.open_day(?, ?)', [HOY, U1]);
      ok(rechaza(await intento(trx, () => trx.raw('SELECT cashbook.open_day(?, ?)', ['2099-04-03', U1])), 'cashbook_ya_hay_jornada_abierta'), 'una sola jornada abierta (B20)');

      const lineasApertura = [L('BOVEDA', 10000000, { 500: 200 }), L('CAJA', 100000, { 100: 10 }), L('APERTURA', -10100000)];
      ok(rechaza(await intento(trx, () => post(trx, asiento('apertura', lineasApertura))), 'cashbook_requiere_autorizacion'), 'la apertura sin autorización → se rechaza (B10)');
      const reqA = await pedir(trx, conPeticion(asiento('apertura', lineasApertura)));
      ok(rechaza(await intento(trx, () => autorizar(trx, reqA, U1, E1)), 'cashbook_autoriza_quien_registra'), 'quien registró no autoriza lo suyo');
      ok(rechaza(await intento(trx, () => autorizar(trx, reqA, U3, E1)), 'cashbook_autoriza_quien_registra'), 'OTRO usuario del MISMO empleado tampoco (B43)');
      const eA = await autorizar(trx, reqA, U2, E2);
      ok(!!eA && (await saldo(trx, 'BOVEDA')) === 10000000 && (await piezas(trx, 'BOVEDA', '500')) === 200, 'autorizada por otra persona: bóveda 200 × $500');
      ok(rechaza(await intento(trx, () => autorizar(trx, reqA, U2, E2)), 'cashbook_solicitud_no_pendiente'), 'no se autoriza dos veces');
      const seqApertura = Number((await trx.raw(`SELECT seq FROM cashbook.entries WHERE id = ?`, [eA])).rows[0].seq);

      console.log('\n── 4. Un retiro de la máquina a la caja, y cada forma de equivocarse ──');
      const eR = await post(trx, asiento('retiro_caos', [L('BOVEDA', -2500000, { 500: -50 }), L('CAJA', 2500000, { 500: 50 })]));
      ok(!!eR && (await saldo(trx, 'CAJA')) === 2600000 && (await piezas(trx, 'CAJA', '500')) === 50, 'retiro 50 × $500: la caja recibe exactamente esas piezas');
      const casos = [
        ['cashbook_no_cuadra', 'no suma cero', [L('POR_RENDIR_R27', 100), L('COBRANZA', -90)]],
        ['cashbook_asiento_minimo', 'una sola línea', [L('POR_RENDIR_R27', 100)]],
        ['cashbook_linea_no_cero', 'línea en cero', [L('POR_RENDIR_R27', 0), L('COBRANZA', 0)]],
        ['cashbook_monto_invalido', 'pesos con decimales en vez de centavos', [L('POR_RENDIR_R27', '12.50'), L('COBRANZA', '-12.50')]],
        ['cashbook_piezas_no_suman', 'piezas que no suman la línea', [L('CAJA', -50000, { 100: -4 }), L('EGRESO', 50000)]],
        ['cashbook_cuenta_exige_piezas', 'importe tecleado en la caja, sin piezas (B16)', [L('CAJA', -50000), L('EGRESO', 50000)]],
        ['cashbook_cuenta_sin_desglose', 'piezas en una cuenta sin desglose', [L('EGRESO', 50000, { 500: 1 }), L('CAJA', -50000, { 500: -1 })]],
        ['cashbook_denominacion_fuera_de_catalogo', 'un billete de $300', [L('CAJA', 30000, { 300: 1 }), L('POR_RENDIR_R27', -30000)]],
        ['cashbook_piezas_no_cuadran', 'un $500 sale de la bóveda y entran cinco $100 a la caja', [L('BOVEDA', -50000, { 500: -1 }), L('CAJA', 50000, { 100: 5 })]],
        ['cashbook_no_cuadra', 'dólares contra pesos sin cuenta puente', [L('CAJA_USD', 10000, { 100: 1 }), L('POR_RENDIR_R27', -10000)]],
        ['cashbook_piezas_no_negativas', 'sacar más billetes de los que hay', [L('CAJA', -3000000, { 500: -60 }), L('EGRESO', 3000000)]],
        ['cashbook_saldo_no_negativo', 'una custodia en negativo', [L('CUSTODIA_E1', -100), L('EGRESO', 100)]],
      ];
      for (const [nombre, que, lines] of casos) {
        const e = await intento(trx, () => post(trx, asiento('gasto', lines)));
        ok(rechaza(e, nombre), `NEGATIVA: ${que} → ${nombre} (${muestra(e)})`);
      }
      const fut = await intento(trx, () => post(trx, asiento('gasto', [L('EGRESO', 100), L('POR_RENDIR_R27', -100)], { value_at: '2199-01-01T00:00:00Z' })));
      ok(rechaza(fut, 'cashbook_fecha_futura'), 'NEGATIVA: fecha valor en el futuro');
      ok(rechaza(await intento(trx, () => post(trx, asiento('gasto', [L('EGRESO', 100), L('POR_RENDIR_R27', -100)], { business_date: '2099-04-01' }))), 'cashbook_jornada_cerrada'),
        'NEGATIVA: registrar en otro día que el abierto (el ajuste va al día abierto, B7)');
      ok(rechaza(await intento(trx, () => post(trx, asiento('gasto', [L('EGRESO', 100), L('POR_RENDIR_R27', -100)], { actor: { kind: 'persona' } }))), 'cashbook_asiento_actor'), 'NEGATIVA: una persona sin usuario');
      ok(rechaza(await intento(trx, () => post(trx, asiento('Gasto!', [L('EGRESO', 100), L('POR_RENDIR_R27', -100)]))), 'cashbook_evento_invalido'), 'NEGATIVA: tipo de evento fuera de forma');
      ok(rechaza(await intento(trx, () => post(trx, asiento('faltante', [L('EGRESO', 100), L('POR_RENDIR_R27', -100)], { actor: { kind: 'servicio', service: 'cron' } }))), 'cashbook_requiere_autorizacion'),
        'NEGATIVA: un proceso no registra un faltante (siempre cuatro ojos)');
      // La caja da cinco $100 (tiene diez) y recibe un $500 de la bóveda (tiene 150).
      const cambio = await intento(trx, () => post(trx, asiento('cambio', [
        L('CAJA', -50000, { 100: -5 }), L('BOVEDA', 50000, { 100: 5 }), L('BOVEDA', -50000, { 500: -1 }), L('CAJA', 50000, { 500: 1 })])));
      ok(!cambio, `un cambio de billetes (suma $0, cada pieza conservada) sí entra (${muestra(cambio)})`);

      console.log('\n── 5. Un hecho, un registro (B3, B42) ──');
      const pR = conPeticion(asiento('gasto', [L('EGRESO', 777), L('POR_RENDIR_R27', -777)]));
      const id1 = await post(trx, pR);
      const id2 = await post(trx, pR);
      const nR = Number((await trx.raw(`SELECT count(*) n FROM cashbook.entries WHERE request_id = ?`, [pR.request_id])).rows[0].n);
      ok(id1 === id2 && nR === 1, 'el reintento idéntico devuelve el MISMO asiento, no otro');
      ok(rechaza(await intento(trx, () => post(trx, { ...pR, lines: [L('EGRESO', 778), L('POR_RENDIR_R27', -778)] })), 'cashbook_peticion_reusada'),
        'NEGATIVA: el mismo request_id con otro contenido → rechazado (no se pierde en silencio)');
      const hecho = (h, v = 1) => asiento('cobro_kepler', [L('POR_RENDIR_R27', 2100000), L('COBRANZA', -2100000)],
        { actor: { kind: 'servicio', service: 'feed-kepler' }, event_ref: '01|U-A-5|0000024', event_version: v, event_hash: h });
      const h1 = await post(trx, hecho('h1'));
      ok(h1 === await post(trx, hecho('h1')), 'el mismo hecho externo dos veces → un solo asiento');
      ok(rechaza(await intento(trx, () => post(trx, hecho('h2'))), 'cashbook_evento_cambio'), 'NEGATIVA: el hecho cambió → no se edita, se pide versión nueva');
      ok(rechaza(await intento(trx, () => post(trx, hecho('h2', 2))), 'cashbook_version_sin_reversa'), 'NEGATIVA: la versión 2 sin reversa de la 1 → rechazada');

      console.log('\n── 6. Reversas ──');
      const rev = (entry, reason) => conPeticion({ reverses_entry_id: entry, reason, actor: { kind: 'persona', user_id: U1, employee_id: E1 }, lines: [] });
      ok(rechaza(await intento(trx, () => pedir(trx, rev(eR, ''))), 'cashbook_reversa_con_motivo'), 'NEGATIVA: una reversa sin motivo no se pide');
      const reqRev = await pedir(trx, { ...rev(eR, 'el retiro se capturó dos veces'), request_hash: 'r1' });
      const eRev = await autorizar(trx, reqRev, U2, E2);
      ok(!!eRev && (await saldo(trx, 'BOVEDA')) === 10000000 && (await piezas(trx, 'CAJA', '500')) === 0, 'la reversa deja bóveda y caja como antes, pieza por pieza');
      const r2 = await pedir(trx, { ...rev(eR, 'otra vez'), request_hash: 'r2' });
      ok(rechaza(await intento(trx, () => autorizar(trx, r2, U2, E2)), 'cashbook_asiento_una_reversa'), 'NEGATIVA: un asiento tiene una sola reversa');
      const r3 = await pedir(trx, { ...rev(eRev, 'deshacer la reversa'), request_hash: 'r3' });
      ok(rechaza(await intento(trx, () => autorizar(trx, r3, U2, E2)), 'cashbook_reversa_de_reversa'), 'NEGATIVA: no se revierte una reversa (se registra de nuevo)');
      const r4 = await pedir(trx, { ...rev(h1, 'Kepler canceló el cobro y lo volvió a emitir'), request_hash: 'r4' });
      await autorizar(trx, r4, U2, E2);
      const v2 = await intento(trx, () => post(trx, hecho('h2', 2)));
      ok(!v2, `con la reversa de la versión 1, la versión 2 del hecho sí entra (${muestra(v2)})`);

      console.log('\n── 7. Solicitudes: vencen, se rechazan con motivo y no cambian después ──');
      ok(rechaza(await intento(trx, () => pedir(trx, conPeticion(asiento('ajuste', [L('EGRESO', 1), L('POR_RENDIR_R27', -1)])), '-1 minute')), 'cashbook_solicitud_sin_plazo'), 'NEGATIVA: una solicitud sin plazo (B45)');
      const rv = await pedir(trx, conPeticion(asiento('ajuste', [L('EGRESO', 1), L('POR_RENDIR_R27', -1)])), '50 milliseconds');
      await trx.raw('SELECT pg_sleep(0.1)');
      ok(rechaza(await intento(trx, () => autorizar(trx, rv, U2, E2)), 'cashbook_solicitud_vencida'), 'NEGATIVA: vencida no se autoriza tarde');
      ok(Number((await trx.raw('SELECT cashbook.expire_requests() n')).rows[0].n) >= 1, 'el barrido marca las vencidas');
      const rr = await pedir(trx, conPeticion(asiento('ajuste', [L('EGRESO', 2), L('POR_RENDIR_R27', -2)])));
      ok(rechaza(await intento(trx, () => trx.raw('SELECT cashbook.reject_request(?, ?, ?, ?)', [rr, U2, E2, ' '])), 'cashbook_solicitud_rechazo_con_motivo'), 'NEGATIVA: rechazar sin motivo');
      await trx.raw('SELECT cashbook.reject_request(?, ?, ?, ?)', [rr, U2, E2, 'no hay comprobante']);
      await comoDueno(trx);
      ok(rechaza(await intento(trx, () => trx.raw(`UPDATE cashbook.requests SET state = 'pendiente', decided_at = NULL, decided_by = NULL WHERE id = ?`, [rr])), 'cashbook_estado_final'),
        'NEGATIVA: ni el dueño revive una solicitud decidida');

      console.log('\n── 8. Inmutable, también para el dueño (B2) ──');
      ok(rechaza(await intento(trx, () => trx.raw(`UPDATE cashbook.entries SET reason = 'retoque' WHERE id = ?`, [eA])), 'cashbook_inmutable'), 'UPDATE de un asiento → rechazado');
      const del = await intento(trx, () => trx.raw(`DELETE FROM cashbook.entry_lines WHERE entry_id = ?`, [eA]));
      ok(rechaza(del, 'cashbook_inmutable'), `DELETE de líneas → rechazado (${muestra(del)})`);
      ok(rechaza(await intento(trx, () => trx.raw(`TRUNCATE cashbook.entry_pieces`)), 'cashbook_inmutable'), 'TRUNCATE → rechazado');
      ok(rechaza(await intento(trx, () => trx.raw(`INSERT INTO cashbook.entry_lines (tenant_id, entry_id, line_no, account_id, currency, amount_minor)
          SELECT tenant_id, entry_id, 99, account_id, currency, 1 FROM cashbook.entry_lines WHERE entry_id = ? LIMIT 1`, [eA])), 'cashbook_inmutable'),
        'una línea más en un asiento sellado → rechazada');
      ok(rechaza(await intento(trx, () => trx.raw(`UPDATE cashbook.accounts SET class = 'sistema' WHERE tenant_id = ? AND code = 'CAJA'`, [TT])), 'cashbook_cuenta_estable'), 'una cuenta no cambia de clase');
      // La segunda línea de defensa: un asiento metido por fuera de _post, al confirmar.
      const directo = async (hash, montos) => {
        const cta = (await trx.raw(`SELECT id FROM cashbook.accounts WHERE tenant_id = ? AND code = 'EGRESO'`, [TT])).rows[0].id;
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TT]);
        const [e] = (await trx.raw(`INSERT INTO cashbook.entries (tenant_id, seq, business_date, value_at, event_kind, rule_version, actor_kind, created_by, prev_hash)
            VALUES (?, 9000 + (random() * 999)::int, ?, now(), 'directo', 'x', 'persona', ?, 'x') RETURNING id`, [TT, HOY, U1])).rows;
        let i = 0;
        for (const m of montos) await trx.raw(`INSERT INTO cashbook.entry_lines (tenant_id, entry_id, line_no, account_id, currency, amount_minor) VALUES (?, ?, ?, ?, 'MXN', ?)`, [TT, e.id, ++i, cta, m]);
        // El sello va DESPUÉS de las líneas (como en _post): con el sello puesto ya no entran líneas.
        if (hash) await trx.raw(`UPDATE cashbook.entries SET hash = ? WHERE id = ?`, [hash, e.id]);
        await trx.raw('SET CONSTRAINTS cashbook.trg_cashbook_asiento_cuadra IMMEDIATE');
      };
      ok(rechaza(await intento(trx, () => directo(null, [100, -100])), 'cashbook_asiento_sin_sello'), 'un asiento sin sello no se confirma');
      ok(rechaza(await intento(trx, () => directo('x', [100, -90])), 'cashbook_no_cuadra'), 'un asiento que no cuadra, metido por fuera de la función, no se confirma');

      console.log('\n── 9. Cadena, saldos y cierre ──');
      await comoApp(trx, TT);
      ok((await trx.raw('SELECT * FROM cashbook.verify_chain()')).rows.length === 0, 'verify_chain: la cadena está íntegra');
      ok((await trx.raw('SELECT * FROM cashbook.v_descuadre_interno')).rows.length === 0, 'cabecera = suma de líneas en cada cuenta y denominación (I10)');
      const enApertura = (await trx.raw(`SELECT balance_minor FROM cashbook.balances_at(?) WHERE code = 'BOVEDA'`, [seqApertura])).rows[0];
      ok(enApertura && Number(enApertura.balance_minor) === 10000000, 'el saldo HASTA el asiento de apertura es el de la apertura (B40)');
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [uuid()]);
      ok(Number((await trx.raw(`SELECT count(*) n FROM cashbook.v_saldos`)).rows[0].n) === 0, 'otro tenant no ve ninguna cuenta (RLS)');
      await comoApp(trx, TT);
      ok(rechaza(await intento(trx, () => trx.raw('SELECT cashbook.close_day(?, ?, ?, ?, ?)', [HOY, U1, E1, U1, E1])), 'cashbook_cierre_cuatro_ojos'), 'NEGATIVA: cierra y autoriza la misma persona');
      await trx.raw('SELECT cashbook.close_day(?, ?, ?, ?, ?)', [HOY, U1, E1, U2, E2]);
      const dia = (await trx.raw(`SELECT d.closing_seq, c.last_seq FROM cashbook.business_days d JOIN cashbook.seq_counters c ON c.tenant_id = d.tenant_id WHERE d.business_date = ?`, [HOY])).rows[0];
      ok(dia && Number(dia.closing_seq) === Number(dia.last_seq), 'el cierre guarda hasta qué asiento cuenta');
      ok(rechaza(await intento(trx, () => post(trx, asiento('gasto', [L('EGRESO', 5), L('POR_RENDIR_R27', -5)]))), 'cashbook_sin_jornada_abierta'), 'NEGATIVA: un día cerrado no recibe asientos');
      ok(rechaza(await intento(trx, () => trx.raw('SELECT cashbook.open_day(?, ?)', ['2099-04-01', U1])), 'cashbook_jornada_anterior'), 'NEGATIVA: no se reabre un día anterior');
      await comoDueno(trx);
      ok(rechaza(await intento(trx, () => trx.raw(`UPDATE cashbook.business_days SET state = 'abierta' WHERE tenant_id = ? AND business_date = ?`, [TT, HOY])), 'cashbook_estado_final'), 'NEGATIVA: ni el dueño reabre una jornada cerrada');

      console.log('\n── 10. Alteración por fuera y mutaciones: qué detiene a cada cosa ──');
      await trx.raw('ALTER TABLE cashbook.entry_lines DISABLE TRIGGER trg_cashbook_lines_inmutable');
      await trx.raw(`UPDATE cashbook.entry_lines SET amount_minor = amount_minor + 100 WHERE entry_id = ? AND line_no = 1`, [eA]);
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TT]);
      const rotos = (await trx.raw('SELECT * FROM cashbook.verify_chain()')).rows;
      ok(rotos.some((r) => /contenido alterado/.test(r.problema)), `verify_chain DETECTA la línea alterada por el dueño (${rotos.length} problema/s)`);
      ok((await trx.raw('SELECT * FROM cashbook.v_descuadre_interno')).rows.length > 0, 'v_descuadre_interno también la ve');
      if (hayDdl) {
        const ddl = (await trx.raw(`SELECT command_tag, object_identity FROM cashbook.ddl_audit WHERE object_identity = 'cashbook.entry_lines'`)).rows;
        ok(ddl.some((r) => r.command_tag === 'ALTER TABLE'), 'quitar el candado quedó en la bitácora de DDL (B21)');
      } else {
        skip('sin event trigger (no superusuario): la bitácora de DDL no se prueba');
      }
      // Se deshace la alteración: si no, el chequeo diferido (con razón) la atrapa al confirmar.
      await trx.raw(`UPDATE cashbook.entry_lines SET amount_minor = amount_minor - 100 WHERE entry_id = ? AND line_no = 1`, [eA]);
      await trx.raw('ALTER TABLE cashbook.entry_lines ENABLE TRIGGER trg_cashbook_lines_inmutable');
      const ddlIm = await intento(trx, () => trx.raw('SET CONSTRAINTS ALL IMMEDIATE'));
      ok(!ddlIm, `con la alteración deshecha, todo asiento de esta transacción cuadra al confirmar (${muestra(ddlIm)})`);
      // Mutaciones: sin el control, la violación pasa → el control es lo que la detiene.
      await trx.raw('ALTER TABLE cashbook.account_balances DROP CONSTRAINT cashbook_saldo_no_negativo');
      await trx.raw('SELECT cashbook.open_day(?, ?)', ['2099-04-03', U1]);
      await comoApp(trx, TT);
      const m1 = await intento(trx, () => post(trx, asiento('gasto', [L('CUSTODIA_E1', -100), L('EGRESO', 100)])));
      ok(!m1, 'MUTACIÓN: sin cashbook_saldo_no_negativo la custodia SÍ queda en negativo');
      await comoDueno(trx);
      await trx.raw('SET CONSTRAINTS ALL IMMEDIATE');   // descarga los diferidos pendientes antes de alterar la tabla
      await trx.raw('ALTER TABLE cashbook.entries DISABLE TRIGGER trg_cashbook_entries_inmutable');
      const m2 = await intento(trx, () => trx.raw(`UPDATE cashbook.entries SET reason = 'retoque' WHERE id = ?`, [eA]));
      ok(!m2, 'MUTACIÓN: sin trg_cashbook_entries_inmutable el UPDATE SÍ pasa');
      await trx.raw('ALTER TABLE cashbook.entries ENABLE TRIGGER trg_cashbook_entries_inmutable');
      await trx.raw('ALTER TABLE cashbook.entries DISABLE TRIGGER trg_cashbook_asiento_cuadra');
      const m3 = await intento(trx, async () => {
        const cta = (await trx.raw(`SELECT id FROM cashbook.accounts WHERE tenant_id = ? AND code = 'EGRESO'`, [TT])).rows[0].id;
        const [e] = (await trx.raw(`INSERT INTO cashbook.entries (tenant_id, seq, business_date, value_at, event_kind, rule_version, actor_kind, created_by, prev_hash, hash)
            VALUES (?, 8888, '2099-04-03', now(), 'directo', 'x', 'persona', ?, 'x', NULL) RETURNING id`, [TT, U1])).rows;
        await trx.raw(`INSERT INTO cashbook.entry_lines (tenant_id, entry_id, line_no, account_id, currency, amount_minor) VALUES (?, ?, 1, ?, 'MXN', 100)`, [TT, e.id, cta]);
        await trx.raw(`UPDATE cashbook.entries SET hash = 'x' WHERE id = ?`, [e.id]);
        await trx.raw('SET CONSTRAINTS ALL IMMEDIATE');
      });
      ok(!m3, `MUTACIÓN: sin trg_cashbook_asiento_cuadra un asiento de una línea SÍ se confirma (${muestra(m3)})`);
      if (hayRol) {
        await trx.raw('GRANT INSERT ON cashbook.business_days TO app_runtime');
        await comoApp(trx, TT);
        const m4 = await intento(trx, () => trx.raw(`INSERT INTO cashbook.business_days (tenant_id, business_date, state, opened_by) VALUES (?, '2099-05-01', 'cerrada', ?)`, [TT, U1]));
        ok(m4 && !sinPermiso(m4), `MUTACIÓN: con GRANT INSERT la app ya llega a la tabla (${muestra(m4)}): el privilegio es la primera barrera`);
      }

      throw new Error('__rollback__');
    });
  } catch (e) {
    if (e.message !== '__rollback__') { fail++; console.log('  💥', e.message); }
  }

  await concurrencia();
  if (process.argv.includes('--rendimiento')) await rendimiento();

  console.log(`\n${pass} ✓ / ${fail} ✗ / ${nomedido} NO MEDIDO`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})();

// ── 11. Dos cajeros a la vez (B35) — confirma, con su propio tenant ──────────────────────────
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
async function abrir(tenant) {
  const t = await knex.transaction();
  await comoApp(t, tenant);
  await t.raw(`SET LOCAL statement_timeout = '15s'`);
  return t;
}
async function confirmado(tenant, fn) {
  const t = await abrir(tenant);
  try { const r = await fn(t); await t.commit(); return r; } catch (e) { await t.rollback().catch(() => undefined); throw e; }
}

async function concurrencia() {
  console.log('\n── 11. Dos cajeros sacan de la misma caja a la vez ──');
  try {
    await confirmado(TC, (t) => preparar(t, TC));
    const gasto = (n) => asiento('gasto', [L('CAJA', -n * 10000, { 100: -n }), L('EGRESO', n * 10000)]);
    const t1 = await abrir(TC);
    const t2 = await abrir(TC);
    const r2 = { listo: false, err: null };
    await post(t1, gasto(6));
    const p2 = post(t2, gasto(6)).then(() => { r2.listo = true; }, (e) => { r2.listo = true; r2.err = e; });
    await espera(400);
    const espero = !r2.listo;
    await t1.commit();
    await p2;
    if (r2.err) await t2.rollback(); else await t2.commit();
    ok(espero, 'el segundo ESPERÓ al primero (un candado por libro)');
    ok(!!r2.err && r2.err.constraint === 'cashbook_piezas_no_negativas', `el segundo ve el saldo del primero y no saca billetes que ya no están (${r2.err ? r2.err.constraint : 'pasó'})`);
    const caja = await confirmado(TC, (t) => saldo(t, 'CAJA'));
    ok(caja === 40000, `la caja queda en $400.00 exactos (${caja / 100})`);

    // Ráfaga: 40 asientos desde 8 conexiones → consecutivo sin huecos y cadena íntegra.
    const antes = await confirmado(TC, async (t) => Number((await t.raw('SELECT last_seq FROM cashbook.seq_counters')).rows[0].last_seq));
    await Promise.all(Array.from({ length: 40 }, (_, i) => confirmado(TC, (t) => post(t,
      asiento('cobro_kepler', [L('POR_RENDIR_R27', 100 + i), L('COBRANZA', -(100 + i))])))));
    const fin = await confirmado(TC, async (t) => ({
      seq: Number((await t.raw('SELECT last_seq FROM cashbook.seq_counters')).rows[0].last_seq),
      huecos: (await t.raw('SELECT * FROM cashbook.verify_chain()')).rows,
      descuadre: (await t.raw('SELECT * FROM cashbook.v_descuadre_interno')).rows.length,
    }));
    ok(fin.seq === antes + 40 && fin.huecos.length === 0, `40 asientos en paralelo: consecutivo ${antes + 1}…${fin.seq} sin huecos y cadena íntegra`);
    ok(fin.descuadre === 0, 'y las cabeceras siguen siendo la suma de las líneas');
  } catch (e) {
    fail++; console.log('  💥', e.message);
  }
}

async function rendimiento() {
  console.log('\n── 12. Rendimiento (--rendimiento): 2,000 asientos uno tras otro ──');
  const T = uuid();
  await confirmado(T, (t) => preparar(t, T));
  const tiempos = [];
  for (let i = 0; i < 2000; i++) {
    const t0 = process.hrtime.bigint();
    await confirmado(T, (t) => post(t, asiento('cobro_kepler', [L('POR_RENDIR_R27', 100), L('COBRANZA', -100)])));
    tiempos.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  tiempos.sort((a, b) => a - b);
  const p95 = tiempos[Math.floor(tiempos.length * 0.95)];
  const t0 = process.hrtime.bigint();
  await confirmado(T, (t) => t.raw('SELECT * FROM cashbook.v_saldos'));
  const lectura = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`    post_entry p50 ${tiempos[1000].toFixed(1)} ms · p95 ${p95.toFixed(1)} ms · lectura de saldos ${lectura.toFixed(1)} ms (incluye ida y vuelta)`);
  ok(p95 < 20, `post_entry p95 < 20 ms (${p95.toFixed(1)})`);
  ok(lectura < 50, `saldos < 50 ms (${lectura.toFixed(1)})`);
}
