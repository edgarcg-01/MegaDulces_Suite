/**
 * [OBS.6.1] — `analytics.v_feed_freshness`: **cuán viejo es cada feed**, en un solo lugar.
 *
 * ── POR QUÉ EXISTE ───────────────────────────────────────────────────────────────────────
 * El 2026-09-02 el carril de catálogos del ODS llevaba 6 días parado y la app publicaba precio,
 * costo, margen y reorden sin decir una palabra. La detección existía (`db-health`); lo que no
 * existía era que **el dato mismo declarara su edad** donde se consume.
 *
 * El obstáculo para eso era práctico: la frescura vive en DOS tablas con formas distintas, y
 * cada consumidor tenía que saber en cuál de las dos cae SU feed.
 *
 *   `analytics.cron_runs`        → carriles con latido propio (los shippers, el reconciliador,
 *                                  los scanners). Clave `job_key`, marca `last_finish`.
 *   `kepler_ods._sync_status`    → por TABLA del ODS. Clave `table_name`, marca `last_push_at`.
 *                                  Sin dimensión de sucursal (la anula `apply-handlers.js` a
 *                                  propósito para `kepler_ods`).
 *
 * Esta vista las unifica en un contrato único, sin copiar ninguna: es `derive-no-copy` sobre las
 * dos primarias (REGLA PRINCIPAL de CLAUDE.md — nada de un tercer lugar donde "también" está la
 * frescura, que es justo cómo se pudre).
 *
 * ── HECHOS, NO VEREDICTO (a propósito) ───────────────────────────────────────────────────
 * La vista devuelve EDAD. NO devuelve `stale`, y NO lleva umbrales.
 *
 * Los umbrales son **política de la app** y ya tienen dueño único: `CRON_JOBS` y `EXT_SOURCES`
 * en `apps/api/src/modules/db-health/db-health.service.ts`. Clavarlos también acá crearía dos
 * fuentes de verdad que se separan en silencio: alguien afloja el umbral en TS, la vista sigue
 * diciendo lo viejo, y el tablero y la pantalla se contradicen sin que nadie sepa cuál manda.
 * El veredicto lo emite quien tiene la política; la vista sólo aporta el hecho medido.
 *
 * `clase` SÍ viaja acá porque no es un umbral: es la naturaleza del feed (cada cuánto se espera
 * que se mueva), y se deriva del propio ritmo declarado, no de una opinión.
 *
 * ── CONTRATO ─────────────────────────────────────────────────────────────────────────────
 *   origen      'cron' (carril con latido) · 'ods_table' (tabla del ODS)
 *   feed        clave estable: `job_key` o `table_name`
 *   label       nombre legible (el `label` del carril; para tablas, el nombre de la tabla)
 *   status      estado reportado por el carril ('ok'|'running'|'error'); NULL en tablas del ODS,
 *               que no reportan estado — sólo su último empuje
 *   dato_al     timestamptz del último avance REAL
 *   edad_seg    segundos desde `dato_al`
 *   clase       'vivo' | 'horario' | 'nocturno' para carriles · **NULL para tablas del ODS**
 *   nota        `note`/`error` del carril, para que el consumidor pueda explicar sin otra query
 *
 * ⚠️ `dato_al` de un carril usa `COALESCE(last_finish, last_start)`: una pasada en curso todavía
 * no terminó, y tomar `last_start` como "dato al" haría ver fresco algo que aún no entregó nada.
 * Se prefiere el fin; el inicio es el respaldo para la primerísima pasada.
 *
 * ⚠️⚠️ LAS DOS LECTURAS DE UNA TABLA DEL ODS VIEJA (leer antes de usar `origen='ods_table'`)
 * `_sync_status.last_push_at` marca el último EMPUJE de esa tabla, no la última vez que se la
 * revisó. Un valor viejo admite dos lecturas OPUESTAS y la vista no puede distinguirlas:
 *
 *   (a) el carril está caído  → rezago real, es el incidente del 27-ago
 *   (b) la tabla no cambió    → frescura perfecta; el carril hash sólo empuja lo que difiere
 *
 * Medido en prod hoy, con los tres carriles sanos: `k95doc`, `kdrhfpag`, `kdmt` y compañía dan
 * ~334 h de "edad" y están al día — simplemente no se mueven. Marcarlas rezagadas sería un
 * falso positivo, y una bandeja con falsos positivos se deja de leer (pasó: 488 alertas, cero
 * reconocidas en cinco semanas).
 *
 * Por eso `clase` va **NULL** para `ods_table`: el ritmo esperado de una tabla del ERP no se
 * puede deducir de su nombre, y esta vista no inventa lo que no puede medir. Quien consuma una
 * tabla del ODS y quiera un veredicto debe anclarse al carril que la shipea (`ods_live_hot` /
 * `ods_live_mirror`), que sí tiene ritmo conocido — el carril prueba que se REVISÓ; la tabla
 * dice cuándo CAMBIÓ. Son preguntas distintas y hacen falta las dos.
 */
exports.up = async function up(knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);

  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_feed_freshness AS
    SELECT
      'cron'::text                                              AS origen,
      cr.job_key                                                AS feed,
      COALESCE(cr.label, cr.job_key)                            AS label,
      cr.status                                                 AS status,
      COALESCE(cr.last_finish, cr.last_start)                   AS dato_al,
      GREATEST(EXTRACT(EPOCH FROM (now() - COALESCE(cr.last_finish, cr.last_start))), 0)::bigint
                                                                AS edad_seg,
      -- Ritmo esperado, deducido de la familia del carril. Los shippers vivos del ODS y de
      -- Wincaja corren cada segundos/minutos; los importers de terceros, por hora; el resto es
      -- nocturno. NO es un umbral: es cada cuánto se espera que la fila se mueva.
      CASE
        WHEN cr.job_key LIKE 'ods_live%'  OR cr.job_key LIKE 'cdc_%'
          OR cr.job_key LIKE 'wincaja_replica%' OR cr.job_key = 'db_health_scan' THEN 'vivo'
        WHEN cr.job_key LIKE 'contpaqi_%' OR cr.job_key LIKE 'analytics_refresh%'
          OR cr.job_key LIKE '%_guardian'                                        THEN 'horario'
        ELSE 'nocturno'
      END                                                       AS clase,
      COALESCE(cr.note, cr.error)                               AS nota,
      cr.tenant_id                                              AS tenant_id
    FROM analytics.cron_runs cr

    UNION ALL

    SELECT
      'ods_table'::text                                         AS origen,
      ss.table_name                                             AS feed,
      ss.table_name                                             AS label,
      NULL::text                                                AS status,
      ss.last_push_at                                           AS dato_al,
      GREATEST(EXTRACT(EPOCH FROM (now() - ss.last_push_at)), 0)::bigint
                                                                AS edad_seg,
      -- NULL a propósito: ver "LAS DOS LECTURAS" arriba. Una tabla vieja puede estar rezagada
      -- o simplemente no haber cambiado, y la vista no puede distinguirlo sin mentir.
      NULL::text                                                AS clase,
      NULL::text                                                AS nota,
      NULL::uuid                                                AS tenant_id
    FROM kepler_ods._sync_status ss
  `);

  await knex.raw(`GRANT SELECT ON analytics.v_feed_freshness TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW analytics.v_feed_freshness IS
    'OBS.6.1 — edad por feed, unificando analytics.cron_runs y kepler_ods._sync_status. Devuelve HECHOS (edad), no veredicto: los umbrales viven en CRON_JOBS/EXT_SOURCES de db-health.service.ts, fuente unica.'`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_feed_freshness`);
};
