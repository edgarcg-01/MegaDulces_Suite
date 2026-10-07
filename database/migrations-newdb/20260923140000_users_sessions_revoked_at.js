'use strict';
/**
 * `[ID.38]` — `identity.users.sessions_revoked_at`: cerrar las sesiones de una
 * cuenta **sin apagar la cuenta**.
 *
 * ── El hueco, escrito por el propio repo ─────────────────────────────────────
 * `20260909130000_users_token_ttl_days.js` lo dejó declarado en su encabezado:
 *
 *   «Un token filtrado sigue sirviendo hasta que alguien desactiva esa cuenta.
 *    No hay revocación individual de token ni rotación: eso pide una tabla de
 *    tokens de dispositivo o, más barato, un candado `iat < password_changed_at`
 *    — la columna ya existe y nadie la lee todavía.»
 *
 * Esta migración es la mitad de datos de ese candado. La otra mitad
 * (`jwt-auth.guard` leyéndolo) va en el mismo commit.
 *
 * ── Por qué `password_changed_at` sola no alcanza ────────────────────────────
 * Porque obliga a cambiar la contraseña para cerrar una sesión, y hay un caso
 * donde eso es justo lo que no se puede hacer: las **18 cuentas
 * `kind='dispositivo'`** (8 etiqueteras, 2 checadores, 2 verificadores, 6 de
 * ruta). Son pantallas desatendidas con `token_ttl_days` largo; si a una se le
 * filtra el token, hoy la única salida es `activo = false`, que apaga la
 * pantalla entera. Con esta columna se invalida lo emitido y la cuenta sigue
 * trabajando: entra de nuevo y listo.
 *
 * El corte efectivo es `GREATEST(password_changed_at, sessions_revoked_at)`, así
 * que cambiar la contraseña sigue cerrando sesiones — ahora de verdad, porque
 * antes la columna se escribía y **nadie la leía**.
 *
 * ── Qué NO es ────────────────────────────────────────────────────────────────
 * No es revocación POR TOKEN: corta **todas** las sesiones de esa cuenta a la
 * vez. Un token por dispositivo sigue pidiendo la tabla de tokens que el
 * encabezado citado propone; esto es la versión barata que cubre el caso real
 * («se filtró, cerrá todo») sin inventar infraestructura.
 *
 * ── Impacto del despliegue: medido, no supuesto ──────────────────────────────
 * La columna nace en `NULL` para todos, así que por sí sola no expulsa a nadie.
 * Lo que sí empieza a aplicar es `password_changed_at`, que ya tenía datos. Se
 * midió en prod antes de escribir esto (2026-09-23):
 *
 *     usuarios activos con password_changed_at .............. 17
 *     de ésos, con último login ANTERIOR al cambio .......... 0   ← a quién echaría
 *     de ésos, que nunca entraron ........................... 2   (no tienen token)
 *
 * O sea: **cero sesiones vivas se cierran por encender el candado.**
 *
 * ── ⚠️ `lock_timeout` primero (GOTCHAS §38) ─────────────────────────────────
 * `identity.users` la lee TODO request (`[AUTHZ-HARD.2]`). Un `ALTER TABLE` pide
 * ACCESS EXCLUSIVE y, en Postgres, una petición de lock que espera **encola
 * detrás de sí a todo el que venga después**: un ALTER que espera no es lento,
 * es una caída del login. Ya pasó con la migración del TTL, encolada detrás del
 * respaldo diario. Con `lock_timeout` falla en 3 s, limpia, y se reintenta.
 * **Mientras corre el respaldo (17:00, 15.9 GB) no se aplica DDL en prod.**
 *
 * `SET LOCAL` porque knex corre cada migración dentro de su transacción: muere
 * con ella y no le cambia el `lock_timeout` a la sesión de nadie más.
 *
 * Aditiva e idempotente. No toca permisos. No requiere re-login.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'identity.users';
const COL = 'sessions_revoked_at';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);

  const existe = await knex.schema.withSchema('identity').hasColumn('users', COL);
  if (!existe) {
    await knex.raw(`ALTER TABLE ${TABLA} ADD COLUMN ${COL} timestamptz`);
    console.log(`  ✓ ${TABLA}.${COL} agregada.`);
  } else {
    console.log(`  ~ ${TABLA}.${COL} ya existía.`);
  }

  await knex.raw(`
    COMMENT ON COLUMN ${TABLA}.${COL} IS
      '[ID.38] Corte de sesiones de ESTA cuenta: todo JWT emitido antes (iat) deja de valer. '
      'NULL = sin corte. El corte efectivo que lee jwt-auth.guard es '
      'GREATEST(password_changed_at, sessions_revoked_at), con cache de 30s. '
      'Existe para las cuentas de dispositivo (kiosco/etiquetera): permite invalidar un token '
      'filtrado SIN apagar la pantalla con activo=false. No es revocacion por token: corta todas.'
  `);

  // ── Gate ───────────────────────────────────────────────────────────────────
  // Que la columna esté, y que NADIE quede revocado por el solo hecho de aplicar
  // esto. Un despliegue que cierra sesiones en silencio es el modo de falla que
  // el encabezado promete que no pasa: acá se comprueba en vez de prometerse.
  const { rows: col } = await knex.raw(
    `SELECT is_nullable, data_type FROM information_schema.columns
      WHERE table_schema='identity' AND table_name='users' AND column_name=?`,
    [COL],
  );
  if (!col.length) throw new Error(`${TABLA}.${COL} no quedó creada.`);
  if (col[0].is_nullable !== 'YES') {
    throw new Error(`${TABLA}.${COL} tiene que ser nullable: NULL es "sin corte".`);
  }

  const { rows: revocados } = await knex.raw(
    `SELECT count(*)::int n FROM ${TABLA} WHERE ${COL} IS NOT NULL`,
  );
  if (revocados[0].n > 0) {
    throw new Error(
      `La migración dejó ${revocados[0].n} cuenta(s) con corte de sesión. Nace en NULL para todos.`,
    );
  }

  // Lo que SÍ empieza a aplicar es `password_changed_at`. Se reporta el número
  // real del entorno donde corre: si acá sale > 0, esas personas van a tener que
  // volver a entrar, y hay que saberlo ANTES y no por un ticket de soporte.
  const { rows: afectados } = await knex.raw(`
    SELECT count(*)::int n FROM ${TABLA}
     WHERE activo AND deleted_at IS NULL
       AND password_changed_at IS NOT NULL
       AND last_login_at IS NOT NULL
       AND last_login_at < password_changed_at
  `);
  console.log(
    afectados[0].n === 0
      ? '  ✓ [ID.38] ninguna sesión viva se cierra al encender el candado (medido en esta DB).'
      : `  ! [ID.38] ${afectados[0].n} cuenta(s) entraron ANTES de su último cambio de contraseña: van a tener que volver a entrar.`,
  );
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);
  const existe = await knex.schema.withSchema('identity').hasColumn('users', COL);
  if (existe) {
    await knex.raw(`ALTER TABLE ${TABLA} DROP COLUMN ${COL}`);
  }
};
