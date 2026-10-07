'use strict';
/**
 * `[SN.36b]` — **La foto diaria de cartera llevaba un mes fallando por un GRANT que faltaba.**
 *
 * ── Cómo apareció ───────────────────────────────────────────────────────────────────────────
 * Buscando de dónde sacar el bloque de cartera de Crédito y Cobranza. Medido en prod el
 * 2026-09-22 (solo lectura):
 *
 *   · `analytics.customer_receivable_snapshots` tiene **0 filas**.
 *   · `analytics.cron_runs` dice `job_key='cxc_snapshot'` → **`status: 'error'`**, `rows_affected: 0`,
 *     `duration_ms: 48682`, con el `INSERT` entero en el campo `error`.
 *   · Y el detector de la MISMA corrida sí funciona: 680 hallazgos `cxc_cliente_vencido` con
 *     `last_seen` de hoy. O sea que no es la consulta ni la conexión: es sólo la escritura.
 *   · `has_table_privilege('app_runtime', 'analytics.customer_receivable_snapshots', 'INSERT')`
 *     devuelve **`false`**. Sobre `finance.findings`, `true` — por eso una mitad del job vive y la
 *     otra muere.
 *
 * La migración que creó la tabla (`20260822120000`, Fase CXC.12) escribió
 * `GRANT SELECT ... TO app_runtime` y nada más, mientras su escritor —el `@Cron` de las 08:30 MX—
 * corre justamente como `app_runtime`. La tabla nació de sólo lectura para el único proceso que
 * tenía que escribirla.
 *
 * ⭐ Es la misma familia que `GOTCHAS.md` §33 (CV.17, el `UPDATE` de `ultimo_login` que tiró
 * producción): **saber de dónde LEE un proceso no es saber qué ESCRIBE.** Un `GRANT SELECT` se
 * lee como «ya le di acceso a la tabla».
 *
 * ⚠️ **Lo que sí funcionó fue el latido.** `[CDRP.4]` le puso a este job un renglón en
 * `analytics.cron_runs` con la regla dura de que **cero filas fotografiadas es `error`, no éxito
 * silencioso**. Sin él, el `.catch(e => logger.warn(...))` de `scanAll` seguiría tragándose esto y
 * la única señal sería una tabla vacía que nadie mira. La falla llevaba un mes; el latido la hizo
 * legible el mismo día que alguien preguntó.
 *
 * ⛔ Lo que esta migración **no** hace: no reconstruye el histórico. La vista es de saldos
 * ACTUALES, así que no hay pasado que fotografiar — estampar el saldo de hoy en fechas viejas
 * fabricaría una tendencia plana. La serie nace con un punto, el de la próxima corrida.
 *
 * Aditiva e idempotente (`GRANT` sobre un privilegio que ya está es un no-op).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  const [{ existe }] = (
    await knex.raw(`SELECT to_regclass('analytics.customer_receivable_snapshots') IS NOT NULL existe`)
  ).rows;
  if (!existe) {
    console.log('  [SN.36b] ⚠️ la tabla no existe en esta base — nada que otorgar');
    return;
  }
  // DELETE no: el escritor es un UPSERT por (tenant, día, sucursal) y no borra nunca. Dar de más
  // sería ampliar la superficie de un rol compartido por toda la app (GOTCHAS §24).
  await knex.raw(
    `GRANT INSERT, UPDATE ON analytics.customer_receivable_snapshots TO app_runtime`,
  );
  const [{ ins, upd }] = (
    await knex.raw(`SELECT
        has_table_privilege('app_runtime','analytics.customer_receivable_snapshots','INSERT') ins,
        has_table_privilege('app_runtime','analytics.customer_receivable_snapshots','UPDATE') upd`)
  ).rows;
  console.log(`  [SN.36b] app_runtime → INSERT=${ins} UPDATE=${upd} sobre la foto de cartera`);
  if (!ins || !upd) throw new Error('[SN.36b] el GRANT no quedó: se verificó y sigue en false');
};

exports.down = async function down(knex) {
  await knex.raw(
    `REVOKE INSERT, UPDATE ON analytics.customer_receivable_snapshots FROM app_runtime`,
  );
};
