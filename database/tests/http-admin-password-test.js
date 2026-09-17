/* eslint-disable no-console */
/**
 * HTTP smoke — el reset de contraseña, por la ruta de verdad (`[AU.32]`).
 *
 * ── Por qué existe este archivo ────────────────────────────────────────────
 *
 * `[AU.28]` y `[AU.31]` tocaron cómo se cambia una contraseña, y todo lo que las
 * verificaba eran **expresiones regulares sobre el código fuente**: «el archivo
 * contiene `assertCanChangePassword`», «el archivo contiene `kind ===
 * 'dispositivo'`». Un candado así se pone verde con lógica falsa, y se puso: la
 * primera versión de `esDispositivo()` miraba `token_ttl_days`, pasó el smoke, y
 * habría dejado las 8 etiqueteras afuera. El defecto lo encontró un humano
 * abriendo la pantalla.
 *
 * La regla del repo ya lo decía, en `libs/commercial/jest.config.ts`: **ADR-044,
 * «los servicios que tocan Postgres se prueban por HTTP»**, escrita después de
 * que un smoke que reimplementaba la lógica diera 17/17 con la ruta caída. Este
 * archivo la aplica.
 *
 * ── Qué ejerce ─────────────────────────────────────────────────────────────
 *
 *   1. `PUT /users/:id` con `password` cambia el hash de verdad.
 *   2. A una PERSONA le queda `must_change_password = true`: la eligió el admin.
 *   3. A un DISPOSITIVO le queda en `false`, aunque NO tenga `token_ttl_days` —
 *      que es el caso real de las 8 etiqueteras y el que el regex no veía.
 *   4. `password_changed_at` se mueve. Sin eso la fecha habla de la anterior.
 *   5. **Negativa**: sin `USUARIOS_PASSWORDS` la ruta responde 403 aunque el
 *      usuario tenga `USUARIOS_GESTIONAR`.
 *   6. **Control positivo**: ese MISMO usuario sí puede editar otro campo. Sin
 *      esto, un 403 a todo daría verde el punto 5.
 *   7. Y un PUT sin `password` no toca el hash: el campo vacío no es «ponela vacía».
 *
 * Self-contained: siembra sus roles y sus 2 cuentas, y limpia al final.
 * ⛔ NO corre contra producción (`assertSafeTarget`).
 * Requiere API en :3334. Si no está, declara NO MEDIDO (exit 2), no verde.
 *
 * Correr: node database/tests/http-admin-password-test.js
 */

const BASE = `http://localhost:${process.env.TM_TEST_PORT || 3334}/api`;
const { Client } = require('pg');
try { require('dotenv').config(); } catch (e) { /* dotenv opcional */ }
require('./_lib/assert-safe-target').assertSafeTarget('http-admin-password-test');

const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@127.0.0.1:5432/postgres_platform';
const M = '00000000-0000-0000-0000-00000000d01c';

const ROL_CON = 'pw_smoke_con_llave';
const ROL_SIN = 'pw_smoke_sin_llave';
const ADMIN_CON = 'pw_smoke_admin_con';
const ADMIN_SIN = 'pw_smoke_admin_sin';
const PERSONA = 'pw_smoke_persona';
const DISPOSITIVO = 'pw_smoke_device';
const CLAVE = 'pw_smoke_2026';

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
  // ── ¿Hay API? Si no, se declara. Un rojo permanente enseña a ignorar el tablero.
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
      [M, [ADMIN_CON, ADMIN_SIN, PERSONA, DISPOSITIVO]],
    );
    await q('DELETE FROM identity.users WHERE tenant_id = $1 AND username = ANY($2)', [
      M, [ADMIN_CON, ADMIN_SIN, PERSONA, DISPOSITIVO],
    ]);
    await q('DELETE FROM identity.role_permissions WHERE tenant_id = $1 AND role_name = ANY($2)', [
      M, [ROL_CON, ROL_SIN],
    ]);
  };

  try {
    await limpiar();

    // ── Siembra ───────────────────────────────────────────────────────────
    const conLlave = { USUARIOS_VER: true, USUARIOS_GESTIONAR: true, USUARIOS_PASSWORDS: true };
    const sinLlave = { USUARIOS_VER: true, USUARIOS_GESTIONAR: true };
    await q(
      `INSERT INTO identity.role_permissions (tenant_id, role_name, permissions)
       VALUES ($1,$2,$3::jsonb), ($1,$4,$5::jsonb)`,
      [M, ROL_CON, JSON.stringify(conLlave), ROL_SIN, JSON.stringify(sinLlave)],
    );

    // bcrypt de CLAVE, generado acá: el smoke no puede depender de un hash pegado.
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash(CLAVE, 10);
    await q(
      `INSERT INTO identity.users
         (tenant_id, username, nombre, password_hash, role_name, department_code, kind, status, must_change_password)
       VALUES ($1,$2,'PW smoke admin con llave',$6,$3,'sistemas','interno','active',false),
              ($1,$4,'PW smoke admin sin llave',$6,$5,'sistemas','interno','active',false)`,
      [M, ADMIN_CON, ROL_CON, ADMIN_SIN, ROL_SIN, hash],
    );
    await q(
      `INSERT INTO identity.users
         (tenant_id, username, nombre, password_hash, role_name, department_code, kind, status, must_change_password, token_ttl_days)
       VALUES ($1,$2,'PW smoke persona',$3,'cajero','cajas','interno','active',false,NULL)`,
      [M, PERSONA, hash],
    );

    /*
     * ⛔ El caso del DISPOSITIVO no se puede sembrar en cualquier destino, y eso
     * es en sí un hallazgo: `platform_test` tiene el CHECK `users_kind_valido`
     * SIN `'dispositivo'` —es una de sus 66 migraciones pendientes—. O sea que
     * el caso que de verdad importa, el de las 8 etiqueteras, **no es
     * ejercitable en dev**. Se pregunta al catálogo en vez de suponerlo, y si no
     * está se DECLARA: fallar dejaría un rojo permanente que enseña a ignorar el
     * tablero, y saltearlo en silencio lo daría por probado.
     */
    const { rows: chk } = await db.query(
      `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
        WHERE conrelid = 'identity.users'::regclass AND conname = 'users_kind_valido'`,
    );
    const soportaDispositivo = !chk.length || /'dispositivo'/.test(chk[0].d);
    if (soportaDispositivo) {
      await q(
        `INSERT INTO identity.users
           (tenant_id, username, nombre, password_hash, role_name, department_code, kind, status, must_change_password, token_ttl_days)
         VALUES ($1,$2,'PW smoke etiquetera',$3,'cajero','tienda','dispositivo','active',false,NULL)`,
        [M, DISPOSITIVO, hash],
      );
    }

    const idDe = async (u) => (await q('SELECT id FROM identity.users WHERE tenant_id=$1 AND username=$2', [M, u]))[0].id;
    const estado = async (u) =>
      (await q(
        `SELECT password_hash, must_change_password AS mcp, password_changed_at AS cambiada, kind
           FROM identity.users WHERE tenant_id=$1 AND username=$2`,
        [M, u],
      ))[0];

    const tokCon = await login(ADMIN_CON, CLAVE);
    const tokSin = await login(ADMIN_SIN, CLAVE);
    if (!tokCon || !tokSin) {
      declarar('login de los administradores del smoke', 'la API no emitió token: ¿ENABLE_MULTITENANT?');
      throw new Error('__SIN_TOKEN__');
    }

    const idPersona = await idDe(PERSONA);

    // ── 1 y 2. Persona: el hash cambia y le queda el cambio forzado ────────
    console.log('\n── Una PERSONA');
    const antesP = await estado(PERSONA);
    const r1 = await req('PUT', `/users/${idPersona}`, tokCon, { password: 'NuevaClave-2026' });
    const despP = await estado(PERSONA);
    check('PUT con password responde 2xx', r1.status >= 200 && r1.status < 300, `status ${r1.status} ${JSON.stringify(r1.json)?.slice(0, 120)}`);
    check('el hash cambió de verdad', antesP.password_hash !== despP.password_hash);
    check('y le queda must_change_password = true (la eligió el admin)', despP.mcp === true, `quedó ${despP.mcp}`);
    check(
      'password_changed_at se movió',
      !antesP.cambiada || (despP.cambiada && +new Date(despP.cambiada) > +new Date(antesP.cambiada)),
    );

    // ── 3. Dispositivo SIN ttl: el caso que el regex no veía ───────────────
    console.log('\n── Un DISPOSITIVO sin token_ttl_days (las 8 etiqueteras reales)');
    if (!soportaDispositivo) {
      declarar(
        'el caso del dispositivo',
        'este destino no admite kind=\'dispositivo\' en users_kind_valido (le falta la migración de [ID.31]). ' +
          '⚠️ Es el caso que motivó [AU.31] y acá NO se puede ejercer: correr este smoke contra un destino ' +
          'con el schema al día es lo único que lo cubre',
      );
    } else {
      const idDevice = await idDe(DISPOSITIVO);
      const antesD = await estado(DISPOSITIVO);
      const r2 = await req('PUT', `/users/${idDevice}`, tokCon, { password: 'NuevaClave-2026' });
      const despD = await estado(DISPOSITIVO);
      check('PUT con password responde 2xx', r2.status >= 200 && r2.status < 300, `status ${r2.status}`);
      check('el hash cambió', antesD.password_hash !== despD.password_hash);
      check(
        '⭐ y NO le fuerza el cambio, aunque token_ttl_days sea NULL',
        despD.mcp === false,
        `quedó ${despD.mcp} — con esto en true las 8 etiqueteras quedan afuera ([CH.1.10])`,
      );
    }

    // ── 5. NEGATIVA: sin la llave, 403 ────────────────────────────────────
    console.log('\n── Sin USUARIOS_PASSWORDS');
    const hashAntes = (await estado(PERSONA)).password_hash;
    const r3 = await req('PUT', `/users/${idPersona}`, tokSin, { password: 'OtraClave-2026' });
    check('la ruta responde 403', r3.status === 403, `status ${r3.status}`);
    check('y el hash NO se movió', (await estado(PERSONA)).password_hash === hashAntes);

    // ── 6. CONTROL POSITIVO: ese mismo token sí puede editar otra cosa ─────
    const r4 = await req('PUT', `/users/${idPersona}`, tokSin, { nombre: 'PW smoke persona (editada)' });
    check(
      'CONTROL: ese mismo usuario SÍ puede editar otro campo (el 403 no es a todo)',
      r4.status >= 200 && r4.status < 300,
      `status ${r4.status}`,
    );

    // ── 7. Un PUT sin password no toca el hash ────────────────────────────
    const hashPrev = (await estado(PERSONA)).password_hash;
    await req('PUT', `/users/${idPersona}`, tokCon, { nombre: 'PW smoke persona' });
    check('un PUT sin `password` deja el hash intacto', (await estado(PERSONA)).password_hash === hashPrev);
  } catch (e) {
    if (e.message !== '__SIN_TOKEN__') { fail++; console.log(`  ❌ ERROR: ${e.message}`); }
  } finally {
    await limpiar();
    await db.end();
  }

  const icono = fail === 0 ? (sinMedir ? 'ⓘ' : '✅') : '❌';
  console.log(`\n${icono} [AU.32] reset de contraseña por HTTP: ${ok} ok, ${fail} fallos, ${sinMedir} no medido(s)`);
  process.exit(fail === 0 ? (sinMedir ? 2 : 0) : 1);
})();
