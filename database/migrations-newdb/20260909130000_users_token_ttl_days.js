'use strict';
/**
 * `[CH.1.1]` — `identity.users.token_ttl_days`: la vida del token se decide POR CUENTA.
 *
 * ── El problema concreto ─────────────────────────────────────────────────────
 * Un kiosco (checador de asistencia, verificador de precios, etiquetera) es una
 * pantalla que se prende una vez y se queda prendida. Con el TTL global de 12 h
 * (`JWT_EXPIRES_IN`, `libs/platform-core/.../tenant.module.ts`) alguien tiene que ir
 * a teclear la contraseña cada mañana, y el día que nadie va, el kiosco muestra la
 * pantalla de login en vez de su trabajo.
 *
 * ── Por qué una columna y no subir el TTL global ──────────────────────────────
 * Subir `JWT_EXPIRES_IN` le alarga el token a TODOS — incluidos los admin, que son
 * justo las cuentas donde un token largo duele más. Esto es lo contrario: el default
 * global no se toca (`NULL` = 12 h) y la excepción se declara en la fila de la cuenta
 * que la necesita, donde se puede ver, auditar y quitar con un UPDATE.
 *
 * ── Por qué un token largo acá NO es un token irrevocable ────────────────────
 * `[AUTHZ-HARD.2]` (jwt-auth.guard.ts) relee `identity.users` en CADA request con un
 * cache de 30 s: `activo = false` o `deleted_at` mata el token en ≤30 s, sin esperar
 * su expiración. Y `PermissionsCacheService` relee los permisos de la DB por request,
 * así que el mapa que viaja en el JWT es sólo el snapshot que gatea la UI — un token
 * viejo NO conserva privilegios viejos del lado del servidor.
 *
 * Eso es lo que hace defendible la vida larga, y es también la razón por la que va
 * **una cuenta por dispositivo**: revocar es por cuenta, así que apagar un kiosco
 * comprometido no puede implicar apagar los otros ocho.
 *
 * ── Lo que esta columna NO resuelve (declarado, no disimulado) ───────────────
 * Un token filtrado sigue sirviendo hasta que alguien desactiva esa cuenta. No hay
 * revocación individual de token ni rotación: eso pide una tabla de tokens de
 * dispositivo (opción C del análisis) o, más barato, un candado
 * `iat < password_changed_at` — la columna ya existe y nadie la lee todavía.
 *
 * Aditiva e idempotente. Nadie recibe un TTL distinto por esta migración: sólo
 * habilita que se le pueda dar (el rol y las cuentas van en las siguientes).
 *
 * ── ⚠️ POR QUÉ EMPIEZA CON `lock_timeout` (incidente del 2026-09-09) ─────────
 * `identity.users` es la tabla que TODO request lee: `[AUTHZ-HARD.2]` consulta
 * `select activo, deleted_at ... where id = $1` en cada llamada. Un `ALTER TABLE`
 * pide **ACCESS EXCLUSIVE**, y en Postgres una petición de lock que espera **encola
 * detrás de sí a todo el que venga después**. Así que un ALTER que se queda esperando
 * no es lento: es una caída del login.
 *
 * Pasó, en prod, con esta misma migración: quedó encolada detrás de una transacción
 * larga del feed del ODS (un `COPY kepler_ods.kdmx_25 TO stdout` cuya sesión ya había
 * tocado `identity.users`), y detrás del ALTER se apilaron el `isUserActive` del guard
 * y una consulta comercial. Se canceló la migración (`pg_cancel_backend` sobre el
 * propio pid, sin tocar ninguna otra sesión) y la cola drenó sola.
 *
 * El tamaño de la tabla NUNCA fue el riesgo — son ~150 filas y `ADD COLUMN` nullable
 * es metadata-only. El riesgo es **quién más tiene la tabla tomada**. Con
 * `lock_timeout` la migración falla en 3 s, limpia y sin encolar a nadie; se reintenta
 * cuando el feed no esté en medio de una transacción larga. Es la diferencia entre un
 * reintento y un incidente.
 *
 * `SET LOCAL` porque knex corre cada migración dentro de su transacción: muere con
 * ella y no le cambia el `lock_timeout` a la sesión de nadie más.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'identity.users';
const COL = 'token_ttl_days';

exports.up = async function up(knex) {
  // Ver el encabezado: sin esto, un ALTER que espera encola detrás de sí a todo el que
  // lea `identity.users` — o sea, al login entero. Falla en 3s y se reintenta.
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);

  const existe = await knex.schema.withSchema('identity').hasColumn('users', COL);
  if (!existe) {
    await knex.raw(`ALTER TABLE ${TABLA} ADD COLUMN ${COL} integer`);
    console.log(`  ✓ ${TABLA}.${COL} agregada.`);
  } else {
    console.log(`  ~ ${TABLA}.${COL} ya existía.`);
  }

  // El rango es la guarda: un 0 o un negativo daría un token ya expirado (login que
  // "funciona" y no sirve para nada), y el techo de 10 años evita el dedazo de 36500.
  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'identity.users'::regclass AND conname = 'users_token_ttl_days_rango'
      ) THEN
        ALTER TABLE identity.users
          ADD CONSTRAINT users_token_ttl_days_rango
          CHECK (${COL} IS NULL OR (${COL} >= 1 AND ${COL} <= 3650));
      END IF;
    END $$;
  `);

  await knex.raw(`
    COMMENT ON COLUMN ${TABLA}.${COL} IS
      'Vida del JWT de ESTA cuenta, en días. NULL = el default global (JWT_EXPIRES_IN, hoy 12h). '
      'Se usa en cuentas de DISPOSITIVO (kiosco de checador/verificador): pantallas desatendidas '
      'donde el login diario es el modo de falla. Revocación: activo=false mata el token en <=30s '
      'via [AUTHZ-HARD.2]; los permisos se releen de DB por request, no se congelan en el token.'
  `);

  // Gate: la columna tiene que estar y el CHECK tiene que rechazar un 0. Un rango que
  // no rechaza nada es un comentario, no una guarda — se rompe a propósito una vez.
  const { rows: col } = await knex.raw(
    `SELECT data_type FROM information_schema.columns
      WHERE table_schema='identity' AND table_name='users' AND column_name=?`,
    [COL],
  );
  if (!col.length) throw new Error(`${TABLA}.${COL} no quedó creada.`);

  let rechazo = false;
  try {
    await knex.transaction(async (trx) => {
      await trx.raw(`UPDATE ${TABLA} SET ${COL} = 0 WHERE id = (SELECT id FROM ${TABLA} LIMIT 1)`);
      throw new Error('__ROLLBACK__');
    });
  } catch (e) {
    if (e.message === '__ROLLBACK__') rechazo = false;
    else rechazo = /users_token_ttl_days_rango|check constraint/i.test(e.message);
  }
  const { rows: hay } = await knex.raw(`SELECT count(*)::int n FROM ${TABLA}`);
  if (hay[0].n === 0) {
    console.log('  ! prueba negativa NO MEDIDA: la tabla está vacía, no había fila con la que romperlo.');
  } else if (!rechazo) {
    throw new Error('El CHECK users_token_ttl_days_rango NO rechazó un TTL de 0 días.');
  } else {
    console.log('  ✓ prueba negativa: un TTL de 0 días es rechazado por el CHECK.');
  }
};

exports.down = async function down(knex) {
  // Se quita el CHECK y la columna: es aditiva y nadie depende de ella si no hay
  // cuentas de dispositivo. Si las hay, vuelven al TTL global (12h) — que es
  // degradar el kiosco, no romperlo.
  await knex.raw(`ALTER TABLE ${TABLA} DROP CONSTRAINT IF EXISTS users_token_ttl_days_rango`);
  const existe = await knex.schema.withSchema('identity').hasColumn('users', COL);
  if (existe) await knex.raw(`ALTER TABLE ${TABLA} DROP COLUMN ${COL}`);
  console.log(`  ${TABLA}.${COL} retirada; las cuentas de dispositivo vuelven al TTL global.`);
};
