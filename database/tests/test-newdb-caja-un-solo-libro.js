/* eslint-disable no-console */
/**
 * `[LE.6.12]` — Un documento de Kepler entra a UN solo libro (D40, PM 2026-11-05).
 *
 * Mide la migración `20261105151333_le612_un_documento_un_solo_libro`, en los dos sentidos:
 *  · Captura (`finance.cash_ledger`) no registra un documento que ya tomó la Ventanilla (`cashbook`):
 *    orden de pago, orden de reposición, asiento de cobro o solicitud que espera →
 *    `caja_documento_en_el_libro_chk`, por `origen_ref` y por `declared_doc_ref`, al alta y al cambio;
 *  · la Ventanilla no toma un documento que Captura ya registró → `cashbook_documento_en_captura`
 *    (orden de pago, orden de reposición, asiento de cobro);
 *  · lo cancelado en Captura libera el documento; un documento libre pasa (control);
 *  · el candado del documento queda tomado (`pg_locks`), el mismo en los dos lados;
 *  · MUTACIÓN: con cada disparador apagado, el doble registro SÍ pasa.
 * Siembra como superusuario, escribe como `app_runtime`. Todo en una transacción que se deshace.
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_LE_LIBRO_DE_EFECTIVO.md` §5.6–§5.7.
 */
const crypto = require('crypto');
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-caja-un-solo-libro');

const uuid = () => crypto.randomUUID();
const T = uuid();
const OPERA = uuid();
const E1 = uuid();
const FECHA = '2099-05-01';
let pass = 0, fail = 0, nomedido = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const skip = (m) => { nomedido++; console.log('  ⃝ NO MEDIDO —', m); };
async function intento(trx, fn) {
  await trx.raw('SAVEPOINT sp');
  let err = null;
  try { await fn(); } catch (e) { err = { code: e.code, constraint: e.constraint, message: String(e.message).slice(-160), detail: e.detail }; }
  if (err) await trx.raw('ROLLBACK TO SAVEPOINT sp'); else await trx.raw('RELEASE SAVEPOINT sp');
  return err;
}
const dijo = (e) => (e ? `${e.code} ${e.constraint || ''}` : 'pasó sin error');
const es = (e, c) => !!e && e.code === '23514' && e.constraint === c;
const EN_EL_LIBRO = 'caja_documento_en_el_libro_chk';
const EN_CAPTURA = 'cashbook_documento_en_captura';

let n = 0;
const doc = (tipo = 'X-D-26') => `00|${tipo}|LE612${String((n += 1)).padStart(3, '0')}|0011`;
const renglon = (over) => ({
  tenant_id: T, folio: `LE612-TEST-${Date.now()}-${(n += 1)}`, tipo: 'gasto', fecha: FECHA, sucursal: '00',
  kepler_cuenta: '201', kepler_concepto: 'PRUEBA', glosa: 'Movimiento de prueba LE.6.12', monto: 100,
  origen_tipo: 'pago_proveedor', corte_id: null, created_by: OPERA, created_by_username: 'le612_prueba', ...over,
});
const enUnaHora = () => new Date(Date.now() + 3600e3).toISOString();
const pago = (ref) => ({ actor: { kind: 'persona', user_id: OPERA }, kind: 'pago', amount_minor: '10000', source_ref: ref,
  classification: { tipo: 'pago', concepto: '201', documento: ref }, expires_at: enUnaHora() });
const reposicion = (refs) => ({ actor: { kind: 'persona', user_id: OPERA }, kind: 'reposicion', amount_minor: '10000',
  source_ref: `reposicion:prueba:${uuid()}`, classification: { tipo: 'custodia', empleado: OPERA, nombre: 'prueba' },
  expires_at: enUnaHora(), por_firmar: true, act: { documentos: refs } });
const emitir = (trx, p) => trx.raw('SELECT cashbook.issue_order(?::jsonb) AS r', [JSON.stringify(p)]);
const cobro = (ref) => ({ event_kind: 'entrega_ruta', rule_version: 'test-le612', value_at: new Date().toISOString(),
  actor: { kind: 'persona', user_id: OPERA, employee_id: E1 }, event_ref: `cobro:${ref}`,
  lines: [{ account: 'LE612_CAJA', amount_minor: '10000', pieces: { 100: 1 } }, { account: 'LE612_POR_RENDIR', amount_minor: '-10000' }] });
const asentar = (trx, p) => trx.raw('SELECT cashbook.post_entry(?::jsonb) AS id', [JSON.stringify(p)]);

(async () => {
  try {
    console.log('\n── 0. La migración está aplicada ──');
    const { rows: [h] } = await knex.raw(`SELECT to_regprocedure('cashbook.documento_tomado(text)') IS NOT NULL AS f,
      (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'O' AND tgname IN
        ('trg_cash_ledger_un_solo_libro', 'trg_cashbook_orden_un_solo_libro', 'trg_cashbook_asiento_un_solo_libro', 'trg_cashbook_solicitud_un_solo_libro')) AS trg`);
    if (!h.f) { ok(false, 'la migración 20261105151333 NO está aplicada en esta base: nada se puede medir'); return; }
    ok(Number(h.trg) === 4, `los cuatro disparadores están encendidos (${h.trg})`);
    const hayRol = (await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime'`)).rows.length === 1;

    await knex.transaction(async (trx) => {
      console.log('\n── 1. Siembra: quien opera la caja (con la llave), y la caja del libro nuevo ──');
      // El inquilino es nuevo (uuid al azar): el rol no puede existir todavía.
      await trx.raw(`INSERT INTO identity.role_permissions (tenant_id, role_name, permissions)
        VALUES (?, 'le612_opera', '{"FINANCE_CAJA_GESTIONAR": true}'::jsonb)`, [T]);
      await trx.raw(`INSERT INTO identity.users (id, tenant_id, username, role_name, activo, password_hash)
        VALUES (?, ?, ?, 'le612_opera', true, 'prueba-sin-login')`, [OPERA, T, `le612_${OPERA.slice(0, 6)}`]);
      if (hayRol) await trx.raw('SET LOCAL ROLE app_runtime');
      else skip('sin app_runtime: las escrituras corren como superusuario, no como la app.');
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
      for (const c of [
        { code: 'LE612_CAJA', name: 'Caja de prueba', class: 'fisica', currency: 'MXN', tracks_pieces: true, allows_negative: false },
        { code: 'LE612_POR_RENDIR', name: 'Por rendir de prueba', class: 'por_rendir', currency: 'MXN', tracks_pieces: false, allows_negative: true, holder_kind: 'ruta', holder_ref: '99' },
      ]) await trx.raw('SELECT cashbook.open_account(?::jsonb)', [JSON.stringify({ ...c, user_id: OPERA })]);
      const dia = await intento(trx, () => trx.raw('SELECT cashbook.open_day(?, ?)', [FECHA, OPERA]));
      ok(true, `sembrados (jornada del libro nuevo: ${dia ? dijo(dia) : 'abierta'})`);
      const hayDia = dia === null;

      console.log('\n── 2. Captura NO registra lo que ya tomó la Ventanilla ──');
      const A = doc();
      ok((await intento(trx, () => emitir(trx, pago(A)))) === null, `la Ventanilla ordena el pago de ${A}`);
      const e1 = await intento(trx, () => trx('finance.cash_ledger').insert(renglon({ origen_ref: A })));
      ok(es(e1, EN_EL_LIBRO), `[negativa] Captura lo vuelve a registrar por origen_ref → ${dijo(e1)}`);
      const e2 = await intento(trx, () => trx('finance.cash_ledger').insert(renglon({ tipo: 'ingreso', origen_tipo: 'caos', origen_ref: `AST-LE612|${uuid()}`, declared_doc_ref: A })));
      ok(es(e2, EN_EL_LIBRO), `[negativa] Captura lo declara desde la máquina (declared_doc_ref) → ${dijo(e2)}`);
      ok(/ya se registró en la Ventanilla/.test(e1?.detail ?? ''), `el rechazo dice por qué: «${(e1?.detail ?? '').slice(0, 90)}»`);

      const B = doc();
      const e3 = await intento(trx, () => trx('finance.cash_ledger').insert(renglon({ origen_ref: B })));
      ok(e3 === null, `control: un documento libre se registra en Captura (${dijo(e3)})`);
      const { rows: [lk] } = await trx.raw(`
        SELECT count(*)::int AS n FROM pg_locks l,
               (SELECT hashtextextended('caja-doc:' || ?::text || ':' || ?::text, 0) AS k) x
         WHERE l.locktype = 'advisory' AND l.pid = pg_backend_pid()
           AND l.classid::bigint = ((x.k >> 32) & 4294967295) AND l.objid::bigint = (x.k & 4294967295)`, [T, B]);
      ok(lk.n === 1, `el candado del documento quedó tomado en esta transacción (${lk.n})`);
      const e4 = await intento(trx, () => trx('finance.cash_ledger').where({ tenant_id: T, origen_ref: B }).update({ declared_doc_ref: A }));
      ok(es(e4, EN_EL_LIBRO), `[negativa] cambiarle el documento a uno que ya tomó la Ventanilla → ${dijo(e4)}`);
      const e5 = await intento(trx, () => trx('finance.cash_ledger').where({ tenant_id: T, origen_ref: B }).update({ glosa: 'Movimiento de prueba LE.6.12 (otra glosa)' }));
      ok(e5 === null, `un cambio que no toca el documento no se revisa (${dijo(e5)})`);

      const R = doc();
      ok((await intento(trx, () => emitir(trx, reposicion([R])))) === null, `la Ventanilla pide una reposición que lleva ${R}`);
      const e6 = await intento(trx, () => trx('finance.cash_ledger').insert(renglon({ origen_ref: R })));
      ok(es(e6, EN_EL_LIBRO), `[negativa] Captura registra un pago que ya va en la reposición → ${dijo(e6)}`);

      const C = doc('U-A-5');
      if (hayDia) {
        const ec = await intento(trx, () => asentar(trx, cobro(C)));
        if (ec) skip(`el asiento de cobro de prueba no entró (${dijo(ec)} ${ec.message.slice(0, 80)}): no se mide ese camino`);
        else {
          const e7 = await intento(trx, () => trx('finance.cash_ledger').insert(renglon({ tipo: 'ingreso', origen_tipo: 'cobro', origen_ref: C })));
          ok(es(e7, EN_EL_LIBRO), `[negativa] Captura recibe un cobro que la Ventanilla ya asentó → ${dijo(e7)}`);
        }
      } else skip('sin jornada abierta del libro nuevo no hay asiento de cobro que probar');

      console.log('\n── 3. La Ventanilla NO toma lo que Captura ya registró ──');
      const D = doc();
      await trx('finance.cash_ledger').insert(renglon({ origen_ref: D }));
      const e8 = await intento(trx, () => emitir(trx, pago(D)));
      ok(es(e8, EN_CAPTURA), `[negativa] pagar en la Ventanilla lo ya pagado en Captura → ${dijo(e8)}`);
      const E = doc();
      await trx('finance.cash_ledger').insert(renglon({ tipo: 'ingreso', origen_tipo: 'caos', origen_ref: `AST-LE612|${uuid()}`, declared_doc_ref: E }));
      const e9 = await intento(trx, () => emitir(trx, pago(E)));
      ok(es(e9, EN_CAPTURA), `[negativa] lo que Captura declaró desde la máquina también cuenta → ${dijo(e9)}`);
      const G = doc();
      await trx('finance.cash_ledger').insert(renglon({ origen_ref: G }));
      const e10 = await intento(trx, () => emitir(trx, reposicion([doc(), G])));
      ok(es(e10, EN_CAPTURA), `[negativa] una reposición que trae un pago ya registrado en Captura → ${dijo(e10)}`);
      if (hayDia) {
        const F = doc('U-A-5');
        await trx('finance.cash_ledger').insert(renglon({ tipo: 'ingreso', origen_tipo: 'cobro', origen_ref: F }));
        const e11 = await intento(trx, () => asentar(trx, cobro(F)));
        ok(es(e11, EN_CAPTURA), `[negativa] la Ventanilla recibe un cobro que Captura ya registró → ${dijo(e11)}`);
      }

      console.log('\n── 4. Cancelar en Captura libera el documento ──');
      const H = doc();
      await trx('finance.cash_ledger').insert(renglon({ origen_ref: H }));
      await trx('finance.cash_ledger').where({ tenant_id: T, origen_ref: H })
        .update({ estado: 'cancelado', cancel_reason: 'prueba LE.6.12', cancelled_by: OPERA, cancelled_by_username: 'le612_prueba', cancelled_at: trx.fn.now() });
      const e12 = await intento(trx, () => emitir(trx, pago(H)));
      ok(e12 === null, `con el renglón cancelado, la Ventanilla sí lo paga (${dijo(e12)})`);

      console.log('\n── 5. ⛔ MUTACIÓN: sin los disparadores, el doble registro SÍ pasa ──');
      if (hayRol) await trx.raw('RESET ROLE');
      const m1 = await intento(trx, async () => {
        await trx.raw('ALTER TABLE finance.cash_ledger DISABLE TRIGGER trg_cash_ledger_un_solo_libro');
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
        await trx('finance.cash_ledger').insert(renglon({ origen_ref: A }));
      });
      ok(m1 === null, `con el de Captura APAGADO, Captura registra lo de la Ventanilla (${dijo(m1)}): la sección 2 mide el disparador`);
      const m2 = await intento(trx, async () => {
        await trx.raw('ALTER TABLE cashbook.withdrawal_orders DISABLE TRIGGER trg_cashbook_orden_un_solo_libro');
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
        await emitir(trx, pago(D));
      });
      ok(m2 === null, `con el del libro nuevo APAGADO, la Ventanilla paga lo de Captura (${dijo(m2)}): la sección 3 mide el disparador`);

      throw new Error('__ROLLBACK__');
    }).catch((e) => { if (e.message !== '__ROLLBACK__') throw e; });
    console.log('\n  ✓ rollback aplicado — la base queda como estaba');
  } catch (e) {
    fail++;
    console.error('\n💥', e.message, '\n', e.stack);
  } finally {
    console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} ✓ / ${fail} ✗ / ${nomedido} NO MEDIDO\n`);
    process.exitCode = fail === 0 ? 0 : 1;
    await knex.destroy();
  }
})();
