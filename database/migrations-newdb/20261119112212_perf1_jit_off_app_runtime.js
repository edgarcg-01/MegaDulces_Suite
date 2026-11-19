'use strict';
/**
 * `[PERF.1]` · ADR-123 — **JIT apagado para `app_runtime`** (la API y el worker). Edgar, 2026-11-19: «apaguémoslo».
 *
 * A los volúmenes de esta suite la compilación JIT de Postgres casi nunca se amortiza: se enciende por el COSTO
 * ESTIMADO (`jit_above_cost` = 100 mil), y las vistas sobre Kepler se estiman caras aunque corran en milisegundos.
 * Hasta hoy se apagaba consulta por consulta con `SET LOCAL jit = off` (`[EX-PERF.1]`, `[AB.36]`, `[CANON.6.21]`,
 * `[GX.113]`): cada pantalla lenta lo redescubría por su cuenta.
 *
 * ── Lo medido antes (sólo lectura, `identity.pg_stat_statements` desde el 2026-11-01) ───────────────────────────
 *  · `app_runtime`: **13,399 s de compilación JIT** (~3.7 h) en 24,169 llamadas de 33 consultas distintas.
 *  · Tres consultas con ~2,750 llamadas cada una gastan **99–100 % de su tiempo compilando** (0.4–0.9 s que sin JIT
 *    son casi cero); el caso medido a mano, «Mis gastos» (`[GX.113]`): 2.8 s → 0.3 s.
 *  · Sólo **1** consulta de más de 5 s tiene JIT por debajo del 10 % de su ejecución: la única donde JIT podría
 *    estar ayudando. Se vigila después (ADR-123).
 *  · `postgres` (ingesta, migraciones) NO se toca: 2,127 s de JIT en el mismo periodo, y sus cargas son otras.
 *
 * Es un ajuste del ROL: aplica a cada sesión NUEVA. Las conexiones que el pool ya tiene abiertas conservan
 * `jit = on` hasta que se reciclen (o hasta el siguiente despliegue).
 *
 * ⚠️ No crea objetos de esquema: la compuerta del despliegue la clasifica NO_MEDIDO y frena hasta que se aplique.
 *    Se aplica en cuanto llega a `origin/main`.
 *
 * Idempotente (`ALTER ROLE … SET` reescribe el mismo valor).
 *
 * @param { import("knex").Knex } knex
 */

const leer = async (knex) => (await knex.raw(`
  SELECT s.setconfig::text AS cfg FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole
   WHERE r.rolname = 'app_runtime' AND s.setdatabase = 0`)).rows[0]?.cfg ?? '(sin ajustes)';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const existe = (await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime'`)).rows.length > 0;
  if (!existe) { console.log('[PERF.1] no existe el rol app_runtime: nada que hacer'); return; }
  await knex.raw(`ALTER ROLE app_runtime SET jit = off`);
  const cfg = await leer(knex);
  if (!/\bjit=off\b/.test(cfg)) throw new Error(`[PERF.1] el ajuste no quedó: ${cfg}`);
  console.log(`[PERF.1] app_runtime: ${cfg}`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: quita sólo el ajuste de `jit` del rol, los demás se quedan. */
exports.down = async function down(knex) {
  const existe = (await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime'`)).rows.length > 0;
  if (!existe) return;
  await knex.raw(`ALTER ROLE app_runtime RESET jit`);
  console.log(`[PERF.1] app_runtime: ${await leer(knex)}`);
};
