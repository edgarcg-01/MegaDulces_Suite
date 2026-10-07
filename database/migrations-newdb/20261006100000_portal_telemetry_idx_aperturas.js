/**
 * `[SN.40]` Un índice PARCIAL sobre las aperturas de puerta — el que necesita el primer lector
 * del registro de clics (`GET /telemetry/suite/mios`, la fila «Tus accesos» de la landing).
 *
 * ── POR QUÉ AHORA, MEDIDO ────────────────────────────────────────────────────────────────
 * Hoy la consulta tarda **8–14 ms** contra prod sin índice, porque la tabla son 5,117 filas y
 * un seq scan de eso es gratis. O sea que el índice NO lo justifica el presente — lo justifica
 * lo que ya está entrando:
 *
 *   · `web_vital` empezó a aterrizar el 2026-10-03 (`[DS.7]`) y el 2026-10-05 ya metió **894
 *     filas en un día**, contra 303 de `abrio_puerta`. Son 3 muestras por carga de pantalla.
 *   · A ~1,200 filas/día con retención de 90 días, el estado estacionario es **~108,000 filas**:
 *     21× lo de hoy. Y la consulta está en la ruta de carga de la landing, que es la primera
 *     pantalla que ve todo el mundo.
 *
 * ── POR QUÉ PARCIAL ──────────────────────────────────────────────────────────────────────
 * `WHERE name = 'abrio_puerta'` deja afuera justo la avalancha de `web_vital`: el índice sólo
 * cubre ~300 filas/día × 90 = ~27,000, en vez de las 108,000 de la tabla. Es más chico, se
 * mantiene más barato en cada INSERT (y acá los INSERT son el caso común: una fila por clic),
 * y el planificador lo elige igual porque la consulta trae ese literal.
 *
 * El orden `(user_id, created_at)` sirve a los tres tramos de la cascada: el tuyo es
 * `user_id = ?` y los de puesto/área son `user_id IN (...)`, misma columna de cabecera.
 *
 * ⚠️ `CONCURRENTLY` **no se puede acá**: knex corre cada migración dentro de una transacción y
 * `CREATE INDEX CONCURRENTLY` no lo admite. Un índice normal toma `SHARE` sobre la tabla y
 * bloquea los INSERT mientras se construye — sobre 5 mil filas son milisegundos, y lo único que
 * se frena entre tanto es telemetría, que es exactamente lo que puede esperar. Si esta migración
 * llegara a prod con la tabla ya en seis cifras, construirlo fuera de horario hábil.
 *
 * Aditiva e idempotente. No toca datos.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const tabla = await knex.raw(`SELECT to_regclass('commercial.portal_telemetry_events') AS t`);
  if (!tabla.rows[0]?.t) return; // entorno sin el módulo de telemetría

  // La tabla recibe inserts todo el tiempo: esperar poco y fallar es mejor que formar fila
  // detrás de otra sesión y frenar la ingesta de todos.
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_portal_tel_aperturas
        ON commercial.portal_telemetry_events (user_id, created_at DESC)
     WHERE name = 'abrio_puerta'`);

  await knex.raw(`
    COMMENT ON INDEX commercial.idx_portal_tel_aperturas IS
      '[SN.40] Sirve GET /telemetry/suite/mios. Parcial a proposito: deja afuera los web_vital, '
      'que son 3 por carga de pantalla y 3x el volumen de las aperturas.'`);
};

/**
 * Bajar un índice es seguro: la consulta vuelve a su seq scan, más lenta pero correcta.
 *
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS commercial.idx_portal_tel_aperturas`);
};
