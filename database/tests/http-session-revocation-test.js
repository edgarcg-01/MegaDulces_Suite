/* eslint-disable no-console */
/**
 * HTTP smoke — revocación de sesión (`[ID.38]`), por la ruta de verdad.
 *
 * ── Qué se arregló y por qué hace falta comprobarlo así ─────────────────────
 * Hasta `[ID.38]` el JWT era **irrevocable en la práctica**: vivía 12 h (y hasta
 * 3650 días en una cuenta de dispositivo) y la única forma de matarlo era
 * `activo = false`, o sea apagar la cuenta entera. `identity.users` ya tenía
 * `password_changed_at` —el alta y cada reset la escriben desde `[AU.28]`— y
 * **no la leía nadie**: cambiarle la contraseña a alguien no cerraba su sesión.
 *
 * Esto se prueba por HTTP y no con regex sobre el fuente por la misma razón que
 * `[AU.32]`: un candado de autorización se pone verde con lógica falsa. Acá la
 * pregunta sólo tiene una forma honesta — **usar el token viejo contra la API y
 * ver qué contesta**.
 *
 * ── Qué ejerce ─────────────────────────────────────────────────────────────
 *   1. CONTROL POSITIVO: el token recién emitido de la víctima ABRE una ruta.
 *   2. `POST /users/:id/revoke-sessions` responde 2xx.
 *   3. ⭐ el MISMO token ahora da 401.
 *   4. ⭐ y la cuenta NO quedó apagada: vuelve a entrar con la MISMA contraseña.
 *      (Es la diferencia entera con desactivarla, que es lo que había antes.)
 *   5. NEGATIVA de permiso: sin `USUARIOS_PASSWORDS` la ruta da 403 aunque el
 *      usuario tenga `USUARIOS_GESTIONAR`.
 *   6. CONTROL POSITIVO de la negativa: ese MISMO token sí puede leer la ficha.
 *      Sin esto, un 403 a todo daría verde el punto 5.
 *   7. ⭐ cambiar la contraseña TAMBIÉN cierra las sesiones (el candado de
 *      `password_changed_at`, que existía y no se leía).
 *   8. queda asentado en `identity.user_events` como `sessions_revoked`.
 *
 * Los puntos 2-4 necesitan la columna `sessions_revoked_at`; si el destino no
 * tiene la migración se DECLARAN no medidos (no se fallan: un rojo permanente
 * enseña a ignorar el tablero). El punto 7 se mide igual, porque
 * `password_changed_at` existe desde `[ID.8]`.
 *
 * Self-contained: siembra sus roles y sus 3 cuentas, y limpia al final.
 * ⛔ NO corre contra producción (`assertSafeTarget`).
 * Requiere API en :3334. Si no está, declara NO MEDIDO (exit 2), no verde.
 *
 * Correr: node database/tests/http-session-revocation-test.js
 */

const BASE = `http://localhost:${process.env.TM_TEST_PORT || 3334}/api`;
const { Client } = require('pg');
try { require('dotenv').config(); } catch (e) { /* dotenv opcional */ }
require('./_lib/assert-safe-target').assertSafeTarget('http-session-revocation-test');

const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@127.0.0.1:5432/postgres_platform';
const M = '00000000-0000-0000-0000-00000000d01c';

const ROL_CON = 'rev_smoke_con_llave';
const ROL_SIN = 'rev_smoke_sin_llave';
const ADMIN_CON = 'rev_smoke_admin_con';
const ADMIN_SIN = 'rev_smoke_admin_sin';
const VICTIMA = 'rev_smoke_victima';
const CLAVE = 'rev_smoke_2026';

let ok = 0, fail = 0, sinMedir = 0;
const check = (t, cond, extra = '') => {
  if (cond) { ok++; console.log(`  ✅ ${t}`); }
  else { fail++; console.log(`  ❌ ${t}${extra ? ` — ${extra}` : ''}`); }
};
const declarar = (t, motivo) => { sinMedir++; console.log(`  ⓘ NO MEDIDO ${t} — ${motivo}`); };

async function req(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch (e) { /* puede venir vacío */ }
  return { status: r.status, json };
}

async function login(username, password) {
  const r = await req('POST', '/auth-mt/login', null, { tenant_slug: 'mega_dulces', username, password });
  return r.json?.access_token || null;
}

(async () => {
  try {
    const ping = await fetch(`${BASE}/health`).catch(() => null);
    if (!ping) throw new Error('sin respuesta');
  } catch (e) {
    declarar('la suite entera', `la API en ${BASE} no contesta: levantala con ENABLE_MULTITENANT=true`);
    console.log(`\nⓘ 0 ok, 0 fallos, ${sinMedir} no medido(s) — no es «pasó», es que no había con qué comprobarlo.`);
    process.exit(2);
  }

  const db = new Client({ connectionString: DST });
  await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;

  const limpiar = async () => {
    await q(
      `DELETE FROM identity.user_events WHERE user_id IN
         (SELECT id FROM identity.users WHERE tenant_id = $1 AND username = ANY($2))`,
      [M, [ADMIN_CON, ADMIN_SIN, VICTIMA]],
    );
    await q('DELETE FROM identity.users WHERE tenant_id = $1 AND username = ANY($2)', [
      M, [ADMIN_CON, ADMIN_SIN, VICTIMA],
    ]);
    await q('DELETE FROM identity.role_permissions WHERE tenant_id = $1 AND role_name = ANY($2)', [
      M, [ROL_CON, ROL_SIN],
    ]);
  };

  try {
    await limpiar();

    const conLlave = { USUARIOS_VER: true, USUARIOS_GESTIONAR: true, USUARIOS_PASSWORDS: true };
    const sinLlave = { USUARIOS_VER: true, USUARIOS_GESTIONAR: true };
    await q(
      `INSERT INTO identity.role_permissions (tenant_id, role_name, permissions)
       VALUES ($1,$2,$3::jsonb), ($1,$4,$5::jsonb)`,
      [M, ROL_CON, JSON.stringify(conLlave), ROL_SIN, JSON.stringify(sinLlave)],
    );

    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash(CLAVE, 10);
    await q(
      `INSERT INTO identity.users
         (tenant_id, username, nombre, password_hash, role_name, department_code, kind, status, must_change_password)
       VALUES ($1,$2,'Rev smoke admin con llave',$6,$3,'sistemas','interno','active',false),
              ($1,$4,'Rev smoke admin sin llave',$6,$5,'sistemas','interno','active',false)`,
      [M, ADMIN_CON, ROL_CON, ADMIN_SIN, ROL_SIN, hash],
    );
    // La víctima es una cuenta común: lo que se prueba es su SESIÓN, no sus permisos.
    await q(
      `INSERT INTO identity.users
         (tenant_id, username, nombre, password_hash, role_name, department_code, kind, status, must_change_password)
       VALUES ($1,$2,'Rev smoke victima',$3,$4,'cajas','interno','active',false)`,
      [M, VICTIMA, hash, ROL_SIN],
    );

    const idDe = async (u) =>
      (await q('SELECT id FROM identity.users WHERE tenant_id=$1 AND username=$2', [M, u]))[0].id;

    const tokCon = await login(ADMIN_CON, CLAVE);
    const tokSin = await login(ADMIN_SIN, CLAVE);
    if (!tokCon || !tokSin) {
      declarar('login de los administradores del smoke', 'la API no emitió token: ¿ENABLE_MULTITENANT?');
      throw new Error('__SIN_TOKEN__');
    }
    const idVictima = await idDe(VICTIMA);

    // ¿Este destino tiene la migración? Se pregunta al catálogo, no se supone.
    const cols = await q(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema='identity' AND table_name='users' AND column_name='sessions_revoked_at'`,
    );
    const tieneColumna = cols.length > 0;

    // ── 1. CONTROL POSITIVO: el token recién emitido sirve ─────────────────
    console.log('\n── El token de la víctima, recién emitido');
    const tokVictima = await login(VICTIMA, CLAVE);
    const r0 = await req('GET', '/users/me/context', tokVictima);
    check('CONTROL POSITIVO: con su token abre /users/me/context', r0.status === 200, `status ${r0.status}`);

    // ── 2-4. Revocar: el token muere, la cuenta NO ─────────────────────────
    console.log('\n── Revocar las sesiones (sin apagar la cuenta)');
    if (!tieneColumna) {
      declarar(
        'la revocación explícita (puntos 2-4)',
        'este destino no tiene identity.users.sessions_revoked_at: falta la migración [ID.38]. ' +
          'El candado de password_changed_at (punto 7) sí se mide abajo',
      );
    } else {
      const r1 = await req('POST', `/users/${idVictima}/revoke-sessions`, tokCon, { motivo: 'smoke' });
      check('POST /revoke-sessions responde 2xx', r1.status >= 200 && r1.status < 300,
        `status ${r1.status} ${JSON.stringify(r1.json)?.slice(0, 160)}`);
      check('y devuelve la marca de corte', !!r1.json?.sessions_revoked_at, JSON.stringify(r1.json)?.slice(0, 120));

      const r2 = await req('GET', '/users/me/context', tokVictima);
      check(
        '⭐ el MISMO token ahora da 401 (antes de [ID.38] seguía entrando 12 h)',
        r2.status === 401,
        `status ${r2.status}`,
      );

      const tokNuevo = await login(VICTIMA, CLAVE);
      const r3 = await req('GET', '/users/me/context', tokNuevo);
      check(
        '⭐ y la cuenta NO quedó apagada: entra de nuevo con la MISMA contraseña',
        !!tokNuevo && r3.status === 200,
        `token ${tokNuevo ? 'ok' : 'null'}, status ${r3.status}`,
      );
    }

    // ── 5-6. La llave: 403 sin ella, y control positivo con ella ───────────
    console.log('\n── Quién puede revocar');
    const r4 = await req('POST', `/users/${idVictima}/revoke-sessions`, tokSin, {});
    check(
      'NEGATIVA: sin USUARIOS_PASSWORDS responde 403, aunque tenga USUARIOS_GESTIONAR',
      r4.status === 403,
      `status ${r4.status}`,
    );
    const r5 = await req('GET', `/users/${idVictima}`, tokSin);
    check(
      'CONTROL POSITIVO: ese MISMO token sí lee la ficha (el 403 es del permiso, no de todo)',
      r5.status === 200,
      `status ${r5.status}`,
    );

    // ── 7. Cambiar la contraseña también cierra sesiones ───────────────────
    console.log('\n── Cambiar la contraseña cierra lo que estuviera abierto');
    const tokAntesDelReset = await login(VICTIMA, CLAVE);
    const rPre = await req('GET', '/users/me/context', tokAntesDelReset);
    check('CONTROL POSITIVO: el token previo al reset funciona', rPre.status === 200, `status ${rPre.status}`);

    const OTRA = 'RevSmoke-Otra-2026';
    const r6 = await req('PUT', `/users/${idVictima}`, tokCon, { password: OTRA });
    check('PUT /users/:id con password responde 2xx', r6.status >= 200 && r6.status < 300, `status ${r6.status}`);

    const r7 = await req('GET', '/users/me/context', tokAntesDelReset);
    check(
      '⭐ el token anterior al cambio de contraseña da 401 (password_changed_at por fin se lee)',
      r7.status === 401,
      `status ${r7.status} — si es 200, el candado de [ID.38] no está leyendo password_changed_at`,
    );
    const tokConOtra = await login(VICTIMA, OTRA);
    check('y con la contraseña nueva entra normalmente', !!tokConOtra);

    // ── 8. Bitácora ────────────────────────────────────────────────────────
    console.log('\n── Queda asentado');
    if (tieneColumna) {
      const ev = await q(
        `SELECT event FROM identity.user_events WHERE tenant_id=$1 AND user_id=$2 AND event='sessions_revoked'`,
        [M, idVictima],
      );
      check('identity.user_events tiene el asiento sessions_revoked', ev.length >= 1, `${ev.length} asiento(s)`);
    } else {
      declarar('el asiento en user_events', 'no se pudo revocar en este destino (sin la columna)');
    }
  } catch (e) {
    if (e.message !== '__SIN_TOKEN__') {
      fail++;
      console.log(`  ❌ excepción inesperada — ${e.message}`);
    }
  } finally {
    await limpiar().catch(() => undefined);
    await db.end().catch(() => undefined);
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${ok} ok, ${fail} fallo(s), ${sinMedir} no medido(s)`);
  process.exit(fail === 0 ? 0 : 1);
})();
