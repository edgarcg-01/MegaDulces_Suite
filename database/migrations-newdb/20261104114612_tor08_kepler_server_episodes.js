'use strict';
/**
 * `[TOR.0.8]` — **Las caídas de cada servidor Kepler, como episodios.** Vista `derive-no-copy`
 * sobre la bitácora de `store_poller` (`analytics.cron_run_log`), que se conecta a los 9
 * servidores cada ~25 s y anota cada lectura fallida con la sucursal y el motivo — pero en UN
 * texto para todos («07 Morelia Madero: timeout expired · 08 Morelia Abastos: …»). Nadie podía
 * contestar «¿cuántas veces se cayó Madero este mes y cuánto duró?».
 *
 * Un episodio = fallas seguidas de la misma sucursal a menos de 5 min una de otra. `tipo`:
 * `inalcanzable` (red o servidor apagado) si alguna falla del episodio lo fue; si no, `lento`
 * (timeout: vivo pero saturado, o red lenta) u `otro`. Son fallas distintas y se dicen distinto.
 *
 * ── Lo medido antes (sólo lectura, prod 7688376744939610156, 2026-11-04, 30 días) ──────────
 *  · 8,305 corridas fallidas; 8,236 fallas por sucursal (una corrida puede traer varias, y
 *    algunas fallan sin sucursal: el push al API). 402 episodios; 16 de 10 min o más.
 *  · El peor: Morelia Madero, 19-oct 09:32 → 20-oct 16:11 MX (lento). Morelia Abastos
 *    inalcanzable 15-oct 21:00 → 16-oct 08:13.
 *  · Sin acotar, sobre todo el historial: 364 ms y creciendo (la bitácora guarda 180 días) →
 *    la vista se acota a 35 días ADENTRO.
 *
 * Aditiva: nadie la lee todavía (la consume la torre de Sistemas, `[TOR.2.1]`). Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const VISTA = `
CREATE OR REPLACE VIEW analytics.v_kepler_server_episodes AS
WITH f AS (
  SELECT l.tenant_id, l.finished_at AS en, m[1] AS sucursal,
         CASE WHEN m[2] ~* 'EHOSTUNREACH|ECONNREFUSED|ENETUNREACH|ENOTFOUND|EAI_AGAIN' THEN 'inalcanzable'
              WHEN m[2] ~* 'timeout|timed out|ETIMEDOUT' THEN 'lento' ELSE 'otro' END AS tipo,
         btrim(m[2]) AS motivo
    FROM analytics.cron_run_log l
    CROSS JOIN LATERAL regexp_matches(l.error, '(?:^| · )([0-9]{2}) [^:·]+: ([^·]*)', 'g') AS m
   WHERE l.job_key = 'store_poller' AND l.status <> 'ok' AND l.error IS NOT NULL
     -- Acotada ADENTRO: las ventanas no dejan empujar el filtro de quien lee, y la bitácora guarda
     -- 180 días (sobre todo el historial ya tardaba 364 ms, y crece). 35 días cubren el mes.
     AND l.finished_at > now() - interval '35 days'
), g AS (
  SELECT f.*, CASE WHEN en - lag(en) OVER (PARTITION BY tenant_id, sucursal ORDER BY en) < interval '5 min'
                   THEN 0 ELSE 1 END AS nuevo
    FROM f
), e AS (
  SELECT g.*, sum(nuevo) OVER (PARTITION BY tenant_id, sucursal ORDER BY en) AS episodio FROM g
)
SELECT tenant_id, sucursal,
       min(en) AS desde, max(en) AS hasta,
       round(extract(epoch FROM max(en) - min(en)) / 60.0, 1) AS minutos,
       count(*)::int AS fallas,
       CASE WHEN bool_or(tipo = 'inalcanzable') THEN 'inalcanzable'
            WHEN bool_or(tipo = 'lento') THEN 'lento' ELSE 'otro' END AS tipo,
       (array_agg(motivo ORDER BY en DESC))[1] AS ultimo_motivo
  FROM e
 GROUP BY tenant_id, sucursal, episodio`;

async function otorgar(knex) {
  // Mismo patrón que las vistas de analytics recientes; con guarda por si el rol no existe (CI).
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        GRANT SELECT ON analytics.v_kepler_server_episodes TO app_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN
        GRANT SELECT ON analytics.v_kepler_server_episodes TO dev_ro;
      END IF;
    END $$`);
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(VISTA);
  await knex.raw(`COMMENT ON VIEW analytics.v_kepler_server_episodes IS
    '[TOR.0.8] Caídas de cada servidor Kepler como episodios (fallas a < 5 min), derivadas de la bitácora de store_poller. tipo: inalcanzable | lento | otro.'`);
  await otorgar(knex);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_kepler_server_episodes`);
};
