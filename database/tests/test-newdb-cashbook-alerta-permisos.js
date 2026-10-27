/* eslint-disable no-console */
/**
 * `[LE.4.8]` — Cada cambio a quién puede tocar la caja abre un hallazgo del libro (migración
 * `20261027132017`, regla B21), contra una base REAL: los cuatro caminos de acceso (clave en el rol,
 * rol de la persona, permiso personal, entrar o no al sistema) alertan; lo que no cambia el acceso
 * no alerta; la alerta se escribe aunque la sesión no traiga tenant (una migración); la app no
 * puede fabricarla; y la cierra alguien que no hizo el cambio ni lo recibió.
 *
 * Los cambios de permisos se hacen como `postgres` (en la base de prueba las tablas de `identity`
 * vienen vacías del snapshot, sin grants); el cierre y la llamada directa, como `app_runtime`.
 * UNA transacción con rollback: cero efecto en la base.
 * Uso: DATABASE_URL_NEW=… DATABASE_URL_NEW_RUNTIME=… node database/tests/test-newdb-cashbook-alerta-permisos.js
 */
const crypto = require('crypto');
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-cashbook-alerta-permisos');

const uuid = () => crypto.randomUUID();
const TT = uuid();
const [ACTOR, REVISOR, BENEFICIARIA, OTRA] = [uuid(), uuid(), uuid(), uuid()];

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
const muestra = (err) => (err ? `${err.code} ${err.constraint || ''} ${err.message.slice(0, 120)}` : 'sin error');

(async () => {
  console.log('\n🧪 [LE.4.8] Alerta en cada cambio a permisos de caja — contra base real\n');
  const t = (await knex.raw(`SELECT to_regprocedure('cashbook.alerta_de_permiso()') AS fn`)).rows[0];
  if (!t.fn) {
    skip('la migración 20261027132017 (LE.4.8) no está aplicada en esta base');
    console.log(`\n${pass} ✓ / ${fail} ✗ / ${nomedido} NO MEDIDO`);
    await knex.destroy();
    process.exit(0);
  }
  const hayRol = (await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime'`)).rows.length > 0;

  try {
    await knex.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TT]);
      const alertas = async () => (await trx.raw(`SELECT id, created_by, detail FROM cashbook.findings
        WHERE tenant_id = ? AND source = 'permiso' ORDER BY created_at, id`, [TT])).rows;
      let antes = 0;
      const nuevas = async () => { const a = await alertas(); const n = a.slice(antes); antes = a.length; return n; };
      const rol = (nombre, permisos) => trx.raw(`INSERT INTO identity.role_permissions
          (id, tenant_id, role_name, permissions, kind, is_platform_admin, created_at, updated_at)
        VALUES (gen_random_uuid(), ?, ?, ?::jsonb, 'perfil', false, now(), now())`, [TT, nombre, JSON.stringify(permisos)]);
      const ponerClave = (nombre, clave, v) => trx.raw(`UPDATE identity.role_permissions
          SET permissions = jsonb_set(permissions, ARRAY[?::text], ?::jsonb, true) WHERE tenant_id = ? AND role_name = ?`,
        [clave, JSON.stringify(v), TT, nombre]);

      console.log('── 1. La clave de caja en un rol ──');
      await rol('cajera_prueba', { FINANCE_CAJA_VER: true, VENTAS_VER: true });
      let n = await nuevas();
      ok(n.length === 1 && n[0].detail.rol === 'cajera_prueba' && n[0].detail.despues.FINANCE_CAJA_VER === true
        && n[0].detail.operacion === 'INSERT' && n[0].created_by === null,
      `rol nuevo con FINANCE_CAJA_VER → 1 alerta, sin actor (la fila no lo dice) (${n.length})`);
      await rol('ventas_prueba', { VENTAS_VER: true });
      ok((await nuevas()).length === 0, 'rol nuevo SIN claves de caja → sin alerta');
      await ponerClave('cajera_prueba', 'VENTAS_EDITAR', true);
      ok((await nuevas()).length === 0, 'otra clave del mismo rol → sin alerta');
      await ponerClave('cajera_prueba', 'FINANCE_CAJA_VER', true);
      ok((await nuevas()).length === 0, 'volver a guardar el mismo permiso → sin alerta');
      await ponerClave('ventas_prueba', 'FINANCE_CAJA_AUTORIZAR', false);
      ok((await nuevas()).length === 0, 'escribir false donde no había clave → sin alerta (el acceso no cambia)');
      await ponerClave('ventas_prueba', 'FINANCE_CAJA_AUTORIZAR', true);
      n = await nuevas();
      ok(n.length === 1 && n[0].detail.antes && Object.keys(n[0].detail.antes).length === 0 && n[0].detail.despues.FINANCE_CAJA_AUTORIZAR === true,
        'dar AUTORIZAR a un rol → 1 alerta con antes vacío y después AUTORIZAR');
      await trx.raw(`UPDATE identity.role_permissions SET role_name = 'superadmin' WHERE tenant_id = ? AND role_name = 'cajera_prueba'`, [TT]);
      n = await nuevas();
      ok(n.length === 1 && n[0].detail.despues._todo_por_rol === true && n[0].detail.rol_antes === 'cajera_prueba',
        'renombrar un rol a superadmin (god-mode por nombre) → alerta');
      await trx.raw(`UPDATE identity.role_permissions SET role_name = 'cajera_prueba' WHERE tenant_id = ? AND role_name = 'superadmin'`, [TT]);
      await nuevas();

      console.log('── 2. El permiso personal ──');
      await trx.raw(`INSERT INTO identity.user_permissions (tenant_id, user_id, permission_key, allow, granted_by, created_at, updated_at)
        VALUES (?, ?, 'FINANCE_CAJA_AUTORIZAR', true, ?, now(), now())`, [TT, BENEFICIARIA, ACTOR]);
      n = await nuevas();
      ok(n.length === 1 && n[0].created_by === ACTOR && n[0].detail.usuario === BENEFICIARIA && n[0].detail.actor === ACTOR,
        'permiso personal de AUTORIZAR → alerta con quién lo dio y a quién');
      await trx.raw(`INSERT INTO identity.user_permissions (tenant_id, user_id, permission_key, allow, granted_by, created_at, updated_at)
        VALUES (?, ?, 'VENTAS_VER', true, ?, now(), now())`, [TT, BENEFICIARIA, ACTOR]);
      ok((await nuevas()).length === 0, 'permiso personal de otra cosa → sin alerta');
      await trx.raw(`UPDATE identity.user_permissions SET allow = false, granted_by = ?, updated_at = now() + interval '1 second'
        WHERE tenant_id = ? AND user_id = ? AND permission_key = 'FINANCE_CAJA_AUTORIZAR'`, [OTRA, TT, BENEFICIARIA]);
      n = await nuevas();
      ok(n.length === 1 && n[0].created_by === OTRA && n[0].detail.despues.FINANCE_CAJA_AUTORIZAR === false,
        'quitarlo → alerta, con quien lo quitó');
      await trx.raw(`UPDATE identity.user_permissions SET nota = 'sólo la nota'
        WHERE tenant_id = ? AND user_id = ? AND permission_key = 'FINANCE_CAJA_AUTORIZAR'`, [TT, BENEFICIARIA]);
      ok((await nuevas()).length === 0, 'cambiar sólo la nota → sin alerta');

      console.log('── 3. El rol de la persona y entrar al sistema ──');
      await trx.raw(`INSERT INTO identity.users (id, tenant_id, username, role_name, activo, created_at, updated_at)
        VALUES (?, ?, 'beneficiaria_prueba', 'rol_sin_caja', true, now(), now()), (?, ?, 'otra_prueba', 'sin_caja', true, now(), now())`,
      [BENEFICIARIA, TT, OTRA, TT]);
      await trx.raw(`INSERT INTO identity.user_roles (id, tenant_id, user_id, role_name, is_primary, created_at, updated_at, updated_by)
        VALUES (gen_random_uuid(), ?, ?, 'cajera_prueba', false, now(), now(), ?)`, [TT, OTRA, ACTOR]);
      n = await nuevas();
      ok(n.length === 1 && n[0].detail.usuario === OTRA && n[0].detail.rol === 'cajera_prueba' && n[0].created_by === ACTOR,
        'complemento que da caja → alerta con el rol, la persona y quién');
      await trx.raw(`INSERT INTO identity.user_roles (id, tenant_id, user_id, role_name, is_primary, created_at, updated_at)
        VALUES (gen_random_uuid(), ?, ?, 'rol_sin_caja', false, now(), now())`, [TT, OTRA]);
      ok((await nuevas()).length === 0, 'complemento sin caja → sin alerta');
      await trx.raw(`UPDATE identity.user_roles SET is_primary = true WHERE tenant_id = ? AND user_id = ? AND role_name = 'cajera_prueba'`, [TT, OTRA]);
      ok((await nuevas()).length === 0, 'marcarlo perfil base → sin alerta (lo que puede hacer no cambia)');
      await trx.raw(`UPDATE identity.users SET activo = false WHERE id = ?`, [OTRA]);
      n = await nuevas();
      ok(n.length === 1 && n[0].detail.username === 'otra_prueba' && n[0].detail.despues.puede_entrar === false,
        'desactivar a alguien con caja → alerta');
      await trx.raw(`UPDATE identity.users SET activo = false WHERE id = ?`, [BENEFICIARIA]);
      ok((await nuevas()).length === 0, 'desactivar a alguien sin caja → sin alerta');
      await trx.raw(`DELETE FROM identity.user_roles WHERE tenant_id = ? AND user_id = ? AND role_name = 'cajera_prueba'`, [TT, OTRA]);
      n = await nuevas();
      ok(n.length === 1 && n[0].detail.operacion === 'DELETE' && n[0].detail.antes.FINANCE_CAJA_VER === true,
        'quitar el rol que da caja → alerta');

      console.log('── 4. Sin tenant en la sesión (una migración) ──');
      await trx.raw(`SELECT set_config('app.tenant_id', '', true)`);
      await ponerClave('ventas_prueba', 'FINANCE_CAOS_VER', true);
      const sigue = (await trx.raw(`SELECT current_setting('app.tenant_id', true) AS t`)).rows[0].t;
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TT]);
      n = await nuevas();
      ok(n.length === 1 && n[0].detail.despues.FINANCE_CAOS_VER === true, 'la alerta se escribe con el tenant de la FILA');
      ok(sigue === '', `y la sesión queda sin tenant, como estaba (quedó «${sigue}»)`);

      console.log('── 5. Nadie fabrica ni cierra la suya ──');
      if (!hayRol) {
        skip('no existe app_runtime: la llamada directa y el cierre no se prueban con sus privilegios');
      } else {
        const app = async (fn) => intento(trx, async () => { await trx.raw('SET LOCAL ROLE app_runtime'); await fn(); });
        let e = await app(() => trx.raw(`SELECT cashbook._alerta_de_permiso(?, NULL, '{}'::jsonb)`, [TT]));
        ok(rechaza(e, 'cashbook_alerta_solo_por_trigger'), `llamar la alerta directo → cashbook_alerta_solo_por_trigger (${muestra(e)})`);
        e = await app(() => trx.raw(`INSERT INTO cashbook.findings (tenant_id, source, amount_minor) VALUES (?, 'permiso', 0)`, [TT]));
        ok(!!e && e.code === '42501', `escribir el hallazgo a mano → sin privilegio (${muestra(e)})`);

        const todas = await alertas();
        const delActor = todas.find((a) => a.created_by === ACTOR && a.detail.usuario === BENEFICIARIA);
        const cerrar = (id, quien, nota) => app(() => trx.raw('SELECT cashbook.close_finding(?, ?, NULL, NULL, ?, NULL)', [id, quien, nota]));
        e = await cerrar(delActor.id, ACTOR, 'yo lo di');
        ok(rechaza(e, 'cashbook_permiso_lo_revisa_otro'), `quien dio el permiso no cierra su alerta (${muestra(e)})`);
        e = await cerrar(delActor.id, BENEFICIARIA, 'me lo dieron');
        ok(rechaza(e, 'cashbook_permiso_lo_revisa_otro'), `quien lo recibió tampoco (${muestra(e)})`);
        e = await cerrar(delActor.id, REVISOR, '  ');
        ok(rechaza(e, 'cashbook_hallazgo_se_cierra_con_algo'), `sin nota no se cierra (${muestra(e)})`);
        e = null;
        await trx.raw('SET LOCAL ROLE app_runtime');
        try { await trx.raw('SELECT cashbook.close_finding(?, ?, NULL, NULL, ?, NULL)', [delActor.id, REVISOR, 'Visto: autorizado por Dirección el 27-oct']); }
        catch (x) { e = { code: x.code, constraint: x.constraint, message: String(x.message) }; }
        await trx.raw('RESET ROLE');
        const cerrado = (await trx.raw('SELECT state, closed_by, closing_authorized_by FROM cashbook.findings WHERE id = ?', [delActor.id])).rows[0];
        ok(!e && cerrado.state === 'cerrado' && cerrado.closed_by === REVISOR && cerrado.closing_authorized_by === null,
          `otra persona con nota → cerrada (${muestra(e)})`);
        e = await app(async () => {
          await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TT]);
          await trx.raw('SELECT cashbook.close_finding(?, ?, NULL, NULL, ?, NULL)', [delActor.id, REVISOR, 'otra vez']);
        });
        ok(rechaza(e, 'cashbook_estado_final'), `cerrada no se vuelve a cerrar (${muestra(e)})`);
        const otroOrigen = (await trx.raw(`INSERT INTO cashbook.findings (tenant_id, source, amount_minor, created_by)
          VALUES (?, 'otro', 500, ?) RETURNING id`, [TT, ACTOR])).rows[0].id;
        e = await cerrar(otroOrigen, REVISOR, 'una nota sola');
        ok(rechaza(e, 'cashbook_hallazgo_se_cierra_con_algo'), `un hallazgo de DINERO sigue pidiendo nota + otra firma (${muestra(e)})`);
      }
      throw new Error('__rollback__');
    });
  } catch (e) {
    if (e.message !== '__rollback__') { fail++; console.log('  ✗ error inesperado:', e.message); }
  }
  console.log(`\n${pass} ✓ / ${fail} ✗ / ${nomedido} NO MEDIDO`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})();
