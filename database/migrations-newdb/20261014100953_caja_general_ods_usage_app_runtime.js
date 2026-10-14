/**
 * ⛔⛔ `[CG.158]` **`app_runtime` NUNCA tuvo `USAGE` sobre `caja_general_ods`. El espejo de Control
 * estuvo MUERTO para la aplicación desde el día uno.**
 *
 * Medido en prod el 2026-10-14, con el rol real con el que corre la API (5 conexiones vivas como
 * `app_runtime` en `pg_stat_activity`):
 *
 *     has_table_privilege('app_runtime','caja_general_ods.arqueo_movimientos','SELECT')  →  TRUE
 *     has_schema_privilege('app_runtime','caja_general_ods','USAGE')                     →  FALSE
 *     SET ROLE app_runtime; select ... → ERROR: permission denied for schema caja_general_ods
 *
 * ⛔ **Un privilegio de TABLA sin `USAGE` del schema no sirve, y `has_table_privilege` devuelve
 * `true` igual**: Postgres concede el objeto y niega el contenedor. Es exactamente la trampa de
 * `[CP.8.44]`, que costó un puente entero muerto en producción — repetida acá en otro schema. El
 * `USAGE` lo tienen `dev_ro`, `edgar` y `postgres`; o sea que **cualquier verificación hecha desde
 * una sesión de persona ve el schema sano y la aplicación no lo ve.**
 *
 * ── Los DOS damnificados, los dos medidos ───────────────────────────────────────────────────
 *
 * 1. ⛔ `sugerirFondo()` → **HTTP 500 reproducible**. `GET /cash-ledger/cortes/fondo-sugerido`
 *    revienta porque `fondoDeControl()` lee `arqueo_movimientos`. ⚠️ Y el chequeo de existencia
 *    **da falso verde**: `to_regclass()` es una consulta al catálogo y no necesita `USAGE`, así
 *    que la guarda pasa y la lectura explota una línea después.
 *    ⭐ La consecuencia de negocio: la pantalla pide *«declarar con cuánto arrancó la caja»*
 *    mientras el endpoint que lo respondería solo —leyendo los 901 arqueos de custodia que la
 *    empresa lleva desde 2013— está roto. Es justo lo que `[CG.125]` vino a evitar.
 *
 * 2. ⚠️ `CajaControlService.frescura()` reportaba **`unknown`** desde siempre. Su `catch` convierte
 *    cualquier falla en `at = null` con el motivo *«el carril puede no existir en este entorno»* —
 *    y el carril existe y está **sano**: `_ship_watermark` de `0 T Movimientos` marca
 *    `2026-10-13 17:19` y corrió hace **4 minutos**. Un `catch` que publica un motivo falso es el
 *    defecto de `[CP.8.39]`, donde «no existe la tabla» tapó un `42501` durante días.
 *
 * ⚠️ El historial SÍ se ve, y por eso nadie lo notó: `analytics.v_caja_control_cortes` devuelve
 * 2,069 filas como `app_runtime`. **Que una pantalla cargue no prueba que sus fuentes se lean.**
 *
 * ── Qué hace, y qué NO ──────────────────────────────────────────────────────────────────────
 *
 * Sólo `USAGE` del schema y `SELECT` de sus tablas: la aplicación **lee** el espejo de Control,
 * nunca lo escribe (lo alimenta el carril de ingesta). Sin `INSERT`, `UPDATE` ni `DELETE`.
 * Idempotente: `GRANT` sobre algo ya concedido es un no-op.
 *
 * ⚠️ El `ALTER DEFAULT PRIVILEGES` va atado al dueño del schema, porque los privilegios por
 * omisión se registran **por rol que crea**: sin eso, la próxima tabla que el carril agregue nace
 * sin permiso y el defecto vuelve, en silencio y sólo para la aplicación.
 */
exports.up = async function up(knex) {
  const existe = await knex.raw(
    `SELECT 1 FROM pg_namespace WHERE nspname = 'caja_general_ods'`,
  );
  if (!existe.rows.length) {
    // El espejo de Control no está en este destino (p. ej. una base de desarrollo limpia).
    // Se declara y se sale: conceder sobre un schema que no existe es un error, no un no-op.
    return;
  }

  const [{ rolname: duenio }] = (await knex.raw(
    `SELECT pg_get_userbyid(nspowner) AS rolname FROM pg_namespace WHERE nspname = 'caja_general_ods'`,
  )).rows;

  await knex.raw(`GRANT USAGE ON SCHEMA caja_general_ods TO app_runtime`);
  await knex.raw(`GRANT SELECT ON ALL TABLES IN SCHEMA caja_general_ods TO app_runtime`);
  await knex.raw(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${knex.client.wrapIdentifier(duenio)} IN SCHEMA caja_general_ods
       GRANT SELECT ON TABLES TO app_runtime`,
  );
};

exports.down = async function down(knex) {
  const existe = await knex.raw(
    `SELECT 1 FROM pg_namespace WHERE nspname = 'caja_general_ods'`,
  );
  if (!existe.rows.length) return;
  const [{ rolname: duenio }] = (await knex.raw(
    `SELECT pg_get_userbyid(nspowner) AS rolname FROM pg_namespace WHERE nspname = 'caja_general_ods'`,
  )).rows;
  await knex.raw(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${knex.client.wrapIdentifier(duenio)} IN SCHEMA caja_general_ods
       REVOKE SELECT ON TABLES FROM app_runtime`,
  );
  await knex.raw(`REVOKE SELECT ON ALL TABLES IN SCHEMA caja_general_ods FROM app_runtime`);
  await knex.raw(`REVOKE USAGE ON SCHEMA caja_general_ods FROM app_runtime`);
};
