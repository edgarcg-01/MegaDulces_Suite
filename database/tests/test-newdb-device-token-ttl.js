/* eslint-disable no-console */
'use strict';
/**
 * `[CH.1.5]` — El token de una cuenta de DISPOSITIVO vive lo que dice su fila, y
 * sigue siendo revocable.
 *
 * Esto es lo que hay que poder afirmar antes de dejar un JWT de un año en una pantalla
 * de piso, y cada afirmación va con su prueba negativa (ADR-056: un gate sin prueba
 * negativa es una intención):
 *
 *   1. **La cuenta de dispositivo recibe su TTL** — 365 d, no las 12 h globales.
 *   2. **Y NADIE MÁS.** Es la negativa que importa: si el TTL se hubiera subido global
 *      (`JWT_EXPIRES_IN`) el punto 1 pasaría igual y todos los admin tendrían un token
 *      de un año. Así que se firma también una cuenta normal y se exige que siga en 12 h.
 *   3. **Un valor inválido cae al default, nunca a un token sin `exp`.** `{}` y
 *      `{ expiresIn: undefined }` se ven igual en el código y hacen lo contrario: Nest
 *      mergea `{...signOptions, ...options}`, así que la clave en `undefined` BORRA la
 *      expiración del merge y emite un token eterno para todo el mundo.
 *   4. **La DB rechaza un TTL de 0** (CHECK), que daría un login que "funciona" y
 *      entrega un token ya expirado.
 *   5. **Desactivar sigue revocando.** Es la única razón por la que un token largo es
 *      defendible: se ejercita el `isUserActive` REAL de `PermissionsCacheService`
 *      —el que consulta `jwt-auth.guard` en cada request— sobre una cuenta activa y
 *      sobre la misma cuenta desactivada.
 *
 * ── Sin API ──────────────────────────────────────────────────────────────────
 * No necesita el server levantado: carga los `.ts` REALES vía ts-node (`token-ttl.ts` y
 * `permissions-cache.service.ts`) y firma con `jsonwebtoken` reproduciendo el merge de
 * `JwtModule`. Cargar el archivo real y no una copia es deliberado: una copia se
 * desincroniza y el test se queda verde midiendo código que ya nadie corre.
 *
 * Self-contained: siembra rol + 2 usuarios y limpia al final.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const { Client } = require('pg');
// Hace INSERT/DELETE en `identity.users` y `identity.role_permissions`: no puede
// correr contra prod.
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-device-token-ttl');

// `skipProject`: sin esto ts-node toma el tsconfig del monorepo (paths, rootDir de Nx)
// y falla con TS5011 antes de compilar.
require('ts-node').register({
  transpileOnly: true, skipProject: true,
  compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node', ignoreDeprecations: '6.0' },
});
const { tokenSignOptions, MAX_TOKEN_TTL_DAYS } =
  require(path.resolve(__dirname, '../../libs/platform-core/src/lib/auth/token-ttl.ts'));
const { PermissionsCacheService } =
  require(path.resolve(__dirname, '../../libs/platform-core/src/lib/ability/permissions-cache.service.ts'));

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const DST = process.env.DATABASE_URL_NEW;
const M = '00000000-0000-0000-0000-00000000d01c';
const ROL = 'checador_kiosco_smoke';
const KIOSCO = 'checador.smoke';
const PERSONA = 'persona.smoke';
const TTL_DISPOSITIVO = 365;
const DIA = 24 * 60 * 60;
/** El default del módulo (`tenant.module.ts`), reproducido tal cual. */
const TTL_GLOBAL = process.env.JWT_EXPIRES_IN || '12h';
const SECRETO = 'secreto-de-prueba-no-es-el-de-produccion';

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, det) => {
  if (cond) { console.log(`  OK   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${det ? ' — ' + det : ''}`); fail++; failures.push(name); }
};
const nomedido = (name, why) => console.log(`  NO MEDIDO  ${name} — ${why}`);

/** Firma como lo hace `AuthMtService`: merge del default del módulo con lo de la cuenta. */
function firmar(ttlDeLaCuenta) {
  const opts = { ...{ expiresIn: TTL_GLOBAL, algorithm: 'HS256' }, ...tokenSignOptions(ttlDeLaCuenta) };
  const token = jwt.sign({ sub: 'x', tenant_id: M }, SECRETO, opts);
  return jwt.decode(token);
}
const vida = (payload) => (payload.exp == null ? null : payload.exp - payload.iat);

async function cleanup(pg) {
  await pg.query(`DELETE FROM identity.users WHERE tenant_id=$1 AND username = ANY($2)`, [M, [KIOSCO, PERSONA]]).catch(() => {});
  await pg.query(`DELETE FROM identity.role_scopes WHERE tenant_id=$1 AND role_name=$2`, [M, ROL]).catch(() => {});
  await pg.query(`DELETE FROM identity.role_permissions WHERE tenant_id=$1 AND role_name=$2`, [M, ROL]).catch(() => {});
}

(async () => {
  const pg = new Client({ connectionString: DST, ssl: /rlwy|proxy|railway/.test(DST) ? { rejectUnauthorized: false } : false });
  await pg.connect();
  await cleanup(pg); // idempotente

  console.log('\n── 1. La firma: el TTL sale de la CUENTA ──────────────────────────────');
  const kiosco = firmar(TTL_DISPOSITIVO);
  check(`cuenta de dispositivo: token de ${TTL_DISPOSITIVO} días`,
    vida(kiosco) === TTL_DISPOSITIVO * DIA, `vivió ${vida(kiosco)}s`);

  // La negativa que sostiene todo: si alguien "arreglara" esto subiendo JWT_EXPIRES_IN,
  // el caso de arriba pasaría igual y los admin tendrían un token de un año.
  const persona = firmar(null);
  check('cuenta normal (TTL null): sigue en el default global de 12h',
    vida(persona) === 12 * 60 * 60, `vivió ${vida(persona)}s (default declarado: ${TTL_GLOBAL})`);
  check('el dispositivo y la persona NO reciben la misma vida',
    vida(kiosco) !== vida(persona), `${vida(kiosco)} vs ${vida(persona)}`);

  console.log('\n── 2. Ningún camino emite un token SIN expiración ─────────────────────');
  for (const malo of [0, -5, 'abc', NaN, '', undefined]) {
    const p = firmar(malo);
    check(`TTL inválido (${JSON.stringify(malo)}) → cae al default, con exp`,
      vida(p) === 12 * 60 * 60, `vivió ${vida(p)}s`);
  }
  check('el helper devuelve {} (no {expiresIn: undefined}) cuando no hay TTL',
    !('expiresIn' in tokenSignOptions(null)),
    `devolvió ${JSON.stringify(tokenSignOptions(null))} — con la clave presente en undefined, Nest borra la expiración del merge`);
  check(`el techo acota a ${MAX_TOKEN_TTL_DAYS} días`,
    vida(firmar(99999)) === MAX_TOKEN_TTL_DAYS * DIA, `vivió ${vida(firmar(99999))}s`);

  console.log('\n── 3. La DB: el CHECK rechaza un TTL que no sirve ─────────────────────');
  const { rows: col } = await pg.query(
    `SELECT count(*)::int n FROM information_schema.columns
      WHERE table_schema='identity' AND table_name='users' AND column_name='token_ttl_days'`);
  if (!col[0].n) {
    nomedido('columna token_ttl_days', 'la migración 20260909130000 no está aplicada en este destino');
  } else {
    check('identity.users.token_ttl_days existe', true);

    // Rol + las dos cuentas.
    await pg.query(
      `INSERT INTO identity.role_permissions (tenant_id, role_name, permissions)
       VALUES ($1,$2,$3::jsonb) ON CONFLICT (tenant_id, role_name) DO UPDATE SET permissions=EXCLUDED.permissions`,
      [M, ROL, JSON.stringify({ HR_ATTENDANCE_CHECAR: true })]);
    const hash = await bcrypt.hash('no-se-usa-en-este-test', 10);
    const ins = async (username, ttl) => (await pg.query(
      `INSERT INTO identity.users (tenant_id, username, password_hash, nombre, role_name, activo, kind, token_ttl_days)
       VALUES ($1,$2,$3,$2,$4,true,'interno',$5) RETURNING id`,
      [M, username, hash, ROL, ttl])).rows[0].id;

    const idKiosco = await ins(KIOSCO, TTL_DISPOSITIVO);
    const idPersona = await ins(PERSONA, null);
    const { rows: leido } = await pg.query(
      `SELECT username, token_ttl_days FROM identity.users WHERE tenant_id=$1 AND username=ANY($2) ORDER BY username`,
      [M, [KIOSCO, PERSONA]]);
    const map = Object.fromEntries(leido.map((r) => [r.username, r.token_ttl_days]));
    check('la cuenta de kiosco quedó con su TTL en DB', Number(map[KIOSCO]) === TTL_DISPOSITIVO, JSON.stringify(map));
    check('la cuenta de persona quedó en NULL (default global)', map[PERSONA] === null, JSON.stringify(map));

    // Prueba negativa del CHECK: 0 días = token ya expirado = login que "funciona" y
    // no sirve. Si el CHECK no estuviera, esto pasaría y nadie lo notaría hasta el kiosco.
    let rechazo = null;
    try {
      await pg.query(`UPDATE identity.users SET token_ttl_days = 0 WHERE tenant_id=$1 AND username=$2`, [M, KIOSCO]);
      rechazo = false;
    } catch (e) { rechazo = /token_ttl_days_rango|check constraint/i.test(e.message); }
    check('la DB rechaza token_ttl_days = 0', rechazo === true, rechazo === false ? 'lo aceptó' : 'falló por otro motivo');

    console.log('\n── 4. Un token largo NO es un token irrevocable ───────────────────────');
    // `isUserActive` es lo que `jwt-auth.guard` consulta en CADA request desde
    // `[AUTHZ-HARD.2]`. Se usa el servicio REAL. Entre mediciones se llama a su
    // `invalidateUser` —su propia API— porque el TTL de 30s es lo que acota la
    // LATENCIA de la revocación; acá se mide el MECANISMO, no el cache.
    const kx = require('knex')({ client: 'pg', connection: DST });
    try {
      const cache = new PermissionsCacheService(kx);
      const activoAntes = await cache.isUserActive(idKiosco, M);
      check('cuenta activa → el guard la deja pasar', activoAntes === true);

      await pg.query(`UPDATE identity.users SET activo=false WHERE tenant_id=$1 AND id=$2`, [M, idKiosco]);
      cache.invalidateUser(idKiosco, M);
      const activoDespues = await cache.isUserActive(idKiosco, M);
      check('cuenta desactivada → el guard la rebota (token de 365d incluido)', activoDespues === false);

      // Y que apagar UNA no apaga a las demás: es la razón de una cuenta por dispositivo.
      const vecina = await cache.isUserActive(idPersona, M);
      check('desactivar un kiosco no toca a la cuenta vecina', vecina === true);

      // El cache es fail-OPEN ante error de DB (a propósito, para no tumbar la app por
      // un hipo). Vale la pena tenerlo dicho: significa que la revocación depende de que
      // la DB conteste, no de que el token expire.
      const inexistente = await cache.isUserActive('00000000-0000-0000-0000-000000000000', M);
      check('un usuario que no existe para el tenant tampoco pasa', inexistente === false);
    } finally {
      await kx.destroy();
    }
  }

  await cleanup(pg);
  await pg.end();

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} OK · ${fail} FAIL`);
  if (failures.length) console.log('   Fallaron: ' + failures.join(' · '));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\n💥', e.message); process.exit(1); });
