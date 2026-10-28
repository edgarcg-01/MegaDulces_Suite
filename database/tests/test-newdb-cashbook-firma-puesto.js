/* eslint-disable no-console */
/**
 * `[LE.4.9]` — En la caja firma un PUESTO (migración `20261027162407`): Jefe de Tesorería primero,
 * Dirección General como suplente. Contra una base REAL, como `app_runtime`:
 *
 *   · cada firma (autorizar, rechazar, cerrar la jornada, cerrar un hallazgo con nota) la rechaza
 *     la base si quien firma no tiene el puesto, está inactivo, es una cuenta de servicio, o el
 *     puesto perdió la responsabilidad — esperando el nombre exacto `cashbook_firma_por_puesto`;
 *   · los cuatro ojos siguen rechazando con SU nombre (el trigger no se adelanta);
 *   · cerrar un hallazgo con un asiento no pide puesto (la firma está en el asiento);
 *   · entrar o salir de un puesto que firma, o cambiar qué puestos firman, abre UNA alerta;
 *   · mutación: sin el trigger, alguien sin puesto autoriza — el trigger es lo que lo detiene.
 *
 * Todo en UNA transacción con rollback: cero efecto.
 * Uso: DATABASE_URL_NEW=… node database/tests/test-newdb-cashbook-firma-puesto.js
 */
const crypto = require('crypto');
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-cashbook-firma-puesto');

const uuid = () => crypto.randomUUID();
const TT = uuid();
const CLAVE = 'finanzas.caja_firma';
const CAJERA = uuid();      // registra y cuenta (puesto jefe_finanzas: NO firma)
const TESO = uuid();        // Jefe de Tesorería: principal
const DIR = uuid();         // Dirección General: suplente
const JEFE = uuid();        // otro de jefe_finanzas, con todo menos el puesto
const INACTIVO = uuid();    // Tesorería, pero dado de baja
const SERVICIO = uuid();    // Tesorería, pero cuenta de servicio
const SIN_FILA = uuid();    // ni siquiera existe en identity.users (un token de otro tenant, un superadmin de plataforma)
const ADMIN = uuid();       // quien cambia puestos en la pantalla de usuarios
const HOY = '2099-08-01';
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
const muestra = (err) => (err ? `${err.code} ${err.constraint || ''} ${err.message.slice(0, 80)}` : 'sin error');
const FIRMA = 'cashbook_firma_por_puesto';

const L = (account, amount, pieces) => ({ account, amount_minor: String(amount), ...(pieces ? { pieces } : {}) });
const asiento = (kind, lines) => ({ event_kind: kind, rule_version: 'test-1', value_at: AHORA,
  actor: { kind: 'persona', user_id: CAJERA }, lines, request_id: uuid() });

let hayRol = true;
async function comoApp(trx) {
  if (hayRol) await trx.raw('SET LOCAL ROLE app_runtime');
  await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TT]);
}
async function comoDueno(trx) {
  await trx.raw('RESET ROLE');
  await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TT]);
}

(async () => {
  console.log('\n🧪 [LE.4.9] En la caja firma un puesto — contra base real\n');
  const t = (await knex.raw(`SELECT to_regprocedure('cashbook._firma_de_caja(uuid, uuid)') AS fn`)).rows[0];
  if (!t.fn) {
    skip('la migración 20261027162407 (LE.4.9) no está aplicada en esta base');
    console.log(`\n${pass} ✓ / ${fail} ✗ / ${nomedido} NO MEDIDO`);
    await knex.destroy();
    process.exit(0);
  }
  hayRol = (await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime'`)).rows.length > 0;
  if (!hayRol) skip('no existe app_runtime: se prueba como superusuario');

  try {
    await knex.transaction(async (trx) => {
      // El andamio, sin alertas: las personas y qué puestos firman.
      await trx.raw(`SET LOCAL session_replication_role = replica`);
      const persona = (id, puesto, extra = {}) => trx.raw(`INSERT INTO identity.users
          (id, tenant_id, username, role_name, activo, kind, position_code, deleted_at, created_at, updated_at)
        VALUES (?, ?, ?, 'rol_prueba', ?, ?, ?, ?, now(), now())`,
      [id, TT, `u_${id.slice(0, 8)}`, extra.activo ?? true, extra.kind ?? 'interno', puesto, extra.deleted_at ?? null]);
      await persona(CAJERA, 'jefe_finanzas');
      await persona(TESO, 'tesoreria');
      await persona(DIR, 'direccion');
      await persona(JEFE, 'jefe_finanzas');
      await persona(INACTIVO, 'tesoreria', { activo: false });
      await persona(SERVICIO, 'tesoreria', { kind: 'servicio' });
      for (const [puesto, principal] of [['tesoreria', true], ['direccion', false]]) {
        await trx.raw(`INSERT INTO identity.position_responsibilities (id, tenant_id, position_code, responsibility_key, es_principal, created_at, updated_at)
          VALUES (gen_random_uuid(), ?, ?, ?, ?, now(), now())`, [TT, puesto, CLAVE, principal]);
      }
      await trx.raw(`SET LOCAL session_replication_role = origin`);
      await comoApp(trx);

      for (const c of [
        { code: 'CAJA', name: 'Caja', class: 'fisica', currency: 'MXN', tracks_pieces: true, allows_negative: false },
        { code: 'EGRESO', name: 'Egresos', class: 'contrapartida', currency: 'MXN', tracks_pieces: false, allows_negative: true },
        { code: 'APERTURA', name: 'Apertura', class: 'sistema', currency: 'MXN', tracks_pieces: false, allows_negative: true },
      ]) await trx.raw('SELECT cashbook.open_account(?::jsonb)', [JSON.stringify(c)]);
      await trx.raw('SELECT cashbook.open_day(?, ?)', [HOY, CAJERA]);
      const pedir = async (p) => (await trx.raw(`SELECT cashbook.create_request(?::jsonb, clock_timestamp() + interval '1 hour') AS id`,
        [JSON.stringify(p)])).rows[0].id;
      const autorizar = (req, quien) => trx.raw('SELECT cashbook.authorize_request(?, ?, NULL) AS id', [req, quien]);

      console.log('── 1. Quién firma: el puesto, activo, persona ──');
      ok((await trx.raw('SELECT cashbook._firma_de_caja(?, ?) AS f', [TT, TESO])).rows[0].f === 'principal', 'Jefe de Tesorería → principal');
      ok((await trx.raw('SELECT cashbook._firma_de_caja(?, ?) AS f', [TT, DIR])).rows[0].f === 'suplente', 'Dirección General → suplente');
      const apertura = await pedir(asiento('apertura', [L('CAJA', 100000, { 100: 10 }), L('APERTURA', -100000)]));
      for (const [quien, que] of [[SIN_FILA, 'una cuenta sin fila en identity (el superadmin que entra por god-mode)'],
        [JEFE, 'un puesto que no firma caja (Gerencia Administrativa y Financiera)'],
        [INACTIVO, 'Tesorería dado de baja'], [SERVICIO, 'Tesorería, pero cuenta de servicio (B14)']]) {
        const e = await intento(trx, () => autorizar(apertura, quien));
        ok(rechaza(e, FIRMA), `NEGATIVA: autoriza ${que} → ${FIRMA} (${muestra(e)})`);
      }
      const e0 = await intento(trx, () => autorizar(apertura, CAJERA));
      ok(rechaza(e0, 'cashbook_autoriza_quien_registra'), `quien registró sigue rechazado con SU nombre (${muestra(e0)})`);
      await autorizar(apertura, DIR);
      ok((await trx.raw('SELECT state, decided_by FROM cashbook.requests WHERE id = ?', [apertura])).rows[0].decided_by === DIR,
        'el suplente (Dirección General) autoriza');

      console.log('\n── 2. Rechazar también es firmar ──');
      const gasto = await pedir(asiento('ajuste', [L('CAJA', -10000, { 100: -1 }), L('EGRESO', 10000)]));
      const e1 = await intento(trx, () => trx.raw('SELECT cashbook.reject_request(?, ?, NULL, ?)', [gasto, JEFE, 'no procede']));
      ok(rechaza(e1, FIRMA), `NEGATIVA: rechaza alguien sin puesto (${muestra(e1)})`);
      await trx.raw('SELECT cashbook.reject_request(?, ?, NULL, ?)', [gasto, TESO, 'sin comprobante']);
      ok((await trx.raw('SELECT state FROM cashbook.requests WHERE id = ?', [gasto])).rows[0].state === 'rechazada', 'la principal rechaza con motivo');

      console.log('\n── 3. Un hallazgo: con nota firma el puesto; con asiento la firma ya está en el asiento ──');
      const contar = async (piezas) => (await trx.raw('SELECT cashbook.register_count(?::jsonb) AS r', [JSON.stringify({
        kind: 'cierre', source: 'persona', counted_by: CAJERA, counted_at: AHORA, blind: true, account: 'CAJA', pieces: piezas })])).rows[0].r;
      const f1 = (await contar({ 100: '9' })).finding_id;
      const f2 = (await contar({ 100: '11' })).finding_id;
      const cerrar = (id, entry, nota, autoriza) => trx.raw('SELECT cashbook.close_finding(?, ?, NULL, ?, ?, ?)', [id, CAJERA, entry, nota, autoriza]);
      let e = await intento(trx, () => cerrar(f1, null, 'se recontó', JEFE));
      ok(rechaza(e, FIRMA), `NEGATIVA: la nota la firma alguien sin puesto (${muestra(e)})`);
      e = await intento(trx, () => cerrar(f1, null, 'se recontó', CAJERA));
      ok(rechaza(e, 'cashbook_hallazgo_se_cierra_con_algo'), `la firma de quien cierra sigue rechazada con SU nombre (${muestra(e)})`);
      await cerrar(f1, null, 'el billete estaba en el sobre de la ruta 27', TESO);
      ok((await trx.raw('SELECT state FROM cashbook.findings WHERE id = ?', [f1])).rows[0].state === 'cerrado', 'con la firma de Tesorería, cerrado');
      const ajuste = await pedir(asiento('ajuste', [L('CAJA', 10000, { 100: 1 }), L('EGRESO', -10000)]));
      const eAj = (await autorizar(ajuste, TESO)).rows[0].id;
      await cerrar(f2, eAj, null, null);
      ok((await trx.raw('SELECT closing_entry_id FROM cashbook.findings WHERE id = ?', [f2])).rows[0].closing_entry_id === eAj,
        'con un asiento autorizado lo cierra la cajera: la firma ya está en el asiento');

      console.log('\n── 4. El cierre de la jornada ──');
      e = await intento(trx, () => trx.raw('SELECT cashbook.close_day(?, ?, NULL, ?, NULL)', [HOY, CAJERA, JEFE]));
      ok(rechaza(e, FIRMA), `NEGATIVA: autoriza el cierre alguien sin puesto (${muestra(e)})`);
      e = await intento(trx, () => trx.raw('SELECT cashbook.close_day(?, ?, NULL, ?, NULL)', [HOY, CAJERA, CAJERA]));
      ok(rechaza(e, 'cashbook_cierre_cuatro_ojos'), `la misma persona sigue rechazada con SU nombre (${muestra(e)})`);

      console.log('\n── 5. Mutación: sin el trigger, alguien sin puesto autoriza ──');
      await trx.raw('SAVEPOINT mut');
      await comoDueno(trx);
      await trx.raw('DROP TRIGGER trg_cashbook_firma_por_puesto ON cashbook.requests');
      await comoApp(trx);
      const m = await pedir(asiento('ajuste', [L('CAJA', -10000, { 100: -1 }), L('EGRESO', 10000)]));
      let paso = null;
      try { await autorizar(m, SIN_FILA); } catch (x) { paso = `${x.code} ${x.constraint || ''}`; }
      await trx.raw('ROLLBACK TO SAVEPOINT mut');
      await comoApp(trx);
      ok(paso === null, `sin el trigger la firma sin puesto PASA: el trigger es lo que la detiene (${paso || 'pasó'})`);

      console.log('\n── 6. Si el puesto pierde la responsabilidad, deja de firmar ──');
      await comoDueno(trx);
      await trx.raw(`UPDATE identity.position_responsibilities SET deleted_at = now() WHERE tenant_id = ? AND position_code = 'direccion'`, [TT]);
      await comoApp(trx);
      const otra = await pedir(asiento('ajuste', [L('CAJA', -10000, { 100: -1 }), L('EGRESO', 10000)]));
      e = await intento(trx, () => autorizar(otra, DIR));
      ok(rechaza(e, FIRMA), `NEGATIVA: Dirección sin la responsabilidad ya no autoriza (${muestra(e)})`);
      await trx.raw('SELECT cashbook.close_day(?, ?, NULL, ?, NULL)', [HOY, CAJERA, TESO]);
      ok((await trx.raw('SELECT state, authorized_by FROM cashbook.business_days WHERE business_date = ?', [HOY])).rows[0].authorized_by === TESO,
        'Tesorería autoriza el cierre');

      console.log('\n── 7. Alertas: entrar o salir de un puesto que firma, o cambiar qué puestos firman ──');
      const cuantas = async () => Number((await trx.raw(`SELECT count(*) AS n FROM cashbook.findings WHERE tenant_id = ? AND source = 'permiso'`, [TT])).rows[0].n);
      const ultima = async () => (await trx.raw(`SELECT created_by, detail FROM cashbook.findings WHERE tenant_id = ? AND source = 'permiso'
        ORDER BY opened_at DESC, id DESC LIMIT 1`, [TT])).rows[0];
      let n0 = await cuantas();
      await trx.raw(`UPDATE identity.users SET position_code = 'tesoreria', updated_by = ?, updated_at = now() WHERE id = ?`, [ADMIN, JEFE]);
      let a = await ultima();
      ok(await cuantas() === n0 + 1 && a.detail.despues.firma_caja === 'principal' && a.detail.usuario === JEFE && a.created_by === ADMIN,
        `pasar a alguien a Tesorería → una alerta, con quién lo hizo (${JSON.stringify(a && a.detail.despues)})`);
      n0 = await cuantas();
      await trx.raw(`UPDATE identity.users SET nombre = 'Otra', updated_at = now() WHERE id = ?`, [TESO]);
      ok(await cuantas() === n0, 'cambiarle el nombre a un firmante no alerta');
      await trx.raw(`UPDATE identity.users SET position_code = 'jefe_finanzas' WHERE id = ?`, [CAJERA]);
      ok(await cuantas() === n0, 'cambiar de puesto a quien no firma, a otro que no firma, no alerta');
      await trx.raw(`UPDATE identity.users SET activo = false, updated_at = now() WHERE id = ?`, [TESO]);
      a = await ultima();
      ok(await cuantas() === n0 + 1 && a.detail.antes.firma_caja === 'principal' && a.detail.despues.firma_caja === null,
        'dar de baja a la firmante (sin permisos de caja por rol) → una alerta de firma');
      n0 = await cuantas();
      await trx.raw(`INSERT INTO identity.position_responsibilities (id, tenant_id, position_code, responsibility_key, es_principal, created_by, created_at, updated_at)
        VALUES (gen_random_uuid(), ?, 'contabilidad', ?, false, ?, now(), now())`, [TT, CLAVE, ADMIN]);
      a = await ultima();
      ok(await cuantas() === n0 + 1 && a.detail.puesto === 'contabilidad' && a.created_by === ADMIN, 'darle la firma a otro puesto → una alerta');
      n0 = await cuantas();
      await trx.raw(`INSERT INTO identity.position_responsibilities (id, tenant_id, position_code, responsibility_key, es_principal, created_at, updated_at)
        VALUES (gen_random_uuid(), ?, 'contabilidad', 'finanzas.hallazgos', false, now(), now())`, [TT]);
      ok(await cuantas() === n0, 'otra responsabilidad cualquiera no alerta');
      await trx.raw(`UPDATE identity.position_responsibilities SET es_principal = true, updated_at = now()
        WHERE tenant_id = ? AND position_code = 'contabilidad' AND responsibility_key = ?`, [TT, CLAVE]);
      ok(await cuantas() === n0 + 1, 'cambiar quién va primero → una alerta');
      // Un firmante CON permisos de caja que deja de entrar: la alerta de LE.4.8 ya lo dice; una sola.
      n0 = await cuantas();
      await trx.raw(`INSERT INTO identity.user_permissions (tenant_id, user_id, permission_key, allow, granted_by, created_at, updated_at)
        VALUES (?, ?, 'FINANCE_CAJA_AUTORIZAR', true, ?, now(), now())`, [TT, JEFE, ADMIN]);
      ok(await cuantas() === n0 + 1, 'darle el permiso de caja → la alerta de LE.4.8');
      await trx.raw(`UPDATE identity.users SET activo = false, updated_at = now() WHERE id = ?`, [JEFE]);
      a = await ultima();
      ok(await cuantas() === n0 + 2 && a.detail.antes.puede_entrar === true,
        `dejar de entrar con permiso de caja Y firma → UNA alerta, no dos (${await cuantas() - n0 - 1})`);

      throw new Error('__rollback__');
    });
  } catch (e) {
    if (e.message !== '__rollback__') { fail++; console.error('  ✗ error inesperado:', e.message); }
  }
  console.log(`\n${pass} ✓ / ${fail} ✗ / ${nomedido} NO MEDIDO`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})();
