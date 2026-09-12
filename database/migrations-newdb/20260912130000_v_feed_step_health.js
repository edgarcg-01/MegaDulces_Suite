/**
 * [VL.6.4] — `analytics.v_feed_step_health`: **qué hace cada PASO** de un carril de feeds.
 *
 * ── POR QUÉ EXISTE ───────────────────────────────────────────────────────────────────────
 * El carril `nightly` tiene **53 pasos** y **un solo latido**, y ese latido sólo se pone en
 * `error` si fallan los 53 (`run-prod-feeds.js`: `failed === total`). La consecuencia es que un
 * paso que hace meses no escribe una fila se ve EXACTAMENTE IGUAL que uno crítico. De ahí que
 * sean 53 y no 20: agregar un paso al nocturno es gratis e invisible, y sacarlo exige una
 * evidencia que nadie tenía con qué producir.
 *
 * Auditado el 2026-09-11: 12 de los 53 también corren en otro carril, 2 son backfills de una
 * migración de hace un mes con el 38% de sus tablas objetivo ya convertidas en vistas, y uno
 * (`import-sales-by-vendor-monthly`) estaba documentado como HUÉRFANO hasta que lo metieron
 * acá. El nocturno es el cajón de sastre: el destino por defecto de lo que nadie ubicó.
 *
 * ── LO QUE ESTA VISTA NO HACE (y por qué) ────────────────────────────────────────────────
 * **No invierte el criterio del latido.** Lo obvio sería poner el carril en `error` si falla
 * CUALQUIER paso — y es mala idea; el autor ya lo había pensado y lo dejó escrito: una falla
 * parcial queda en `ok` *"sin disparar alarma crítica por ruido"*. Con 6 pasos fallando en una
 * noche normal, invertirlo dejaría `feed_nightly` rojo casi siempre, y una alarma que grita
 * todos los días enseña a ignorar el tablero (ya pasó: 488 alertas, cero reconocidas en cinco
 * semanas). El problema real no es el umbral: es que **un lote de 53 pasos no se puede resumir
 * en un booleano**. Esta vista agrega el grano que faltaba, no cambia el veredicto del carril.
 *
 * **No adivina cuántas filas escribió un paso.** El orquestador los corre como subprocesos:
 * conoce duración y código de salida, no filas. Sacarle un entero al texto de salida con un
 * regex daría números equivocados y un número equivocado en una columna que se llama «filas»
 * es peor que un hueco (ADR-056). Lo que hay es `ultimo_resumen`: la última línea que imprimió
 * el propio importer, TEXTUAL. Es una cita, no una medición.
 *
 * ── CONTRATO ─────────────────────────────────────────────────────────────────────────────
 *   carril               'feed_nightly', 'feed_intraday', …
 *   paso                 'import-margin.js', 'repoint-catalog-prices.js --gap-fill-only', …
 *   corridas / fallas    en la ventana (30 d)
 *   ultima_corrida       última vez que se INTENTÓ
 *   ultima_ok            última vez que salió con código 0 · NULL = ninguna en la ventana
 *   horas_sin_ok         NULL si nunca hubo un ok en la ventana (no 0: es "no medido")
 *   seg_p50 / seg_max    duración
 *   resumenes_distintos  ⭐ cuántos textos de cierre DISTINTOS produjo en la ventana.
 *                        **1** sobre 30 corridas = su propio resumen nunca cambió. No es
 *                        prueba de que no haga nada (`COMMIT — 0 filas` es constante, pero
 *                        también lo sería un paso legítimamente idempotente), pero es la
 *                        señal de poda más filosa que se puede computar sin tocar 53 importers.
 *   ultimo_resumen       la cita textual de arriba
 *   veredicto            'ok' | 'intermitente' | 'nunca_ok' — derivado SÓLO de códigos de
 *                        salida. No se clasifica sobre el texto: sería adivinar.
 *
 * ⚠️ **UNA FILA AUSENTE NO ES UN PASO SANO.** La vista sólo puede mostrar lo que corrió al
 * menos una vez en la ventana; el catálogo de pasos vive en `run-prod-feeds.js`, no en la BD.
 * Después de la primera corrida de cada carril el padrón queda completo (se registra todo paso
 * INTENTADO, falle o no). Un paso que se retiró de la lista NO desaparece de golpe: se queda
 * con `ultima_corrida` envejeciendo, que es justamente como se nota. Pero en una ventana sin
 * corridas del carril, la respuesta correcta es "no hay datos", no "todo bien".
 *
 * ⚠️ Se distinguen del latido del CARRIL por la barra en `job_key` (`feed_nightly` vs
 * `feed_nightly/import-margin.js`). Ningún `job_key` de carril lleva barra — y por eso el
 * `LIKE '%/%'` alcanza. Si algún día se nombra un carril con barra, esto se rompe en silencio.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);

  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_feed_step_health AS
    WITH pasos AS (
      SELECT
        tenant_id,
        split_part(job_key, '/', 1)                              AS carril,
        substring(job_key FROM position('/' IN job_key) + 1)     AS paso,
        status, finished_at, duration_ms, note
        FROM analytics.cron_run_log
       WHERE job_key LIKE '%/%'                       -- sólo PASOS; los carriles no llevan barra
         AND finished_at >= now() - interval '30 days'
    )
    SELECT
      tenant_id,
      carril,
      paso,
      count(*)::int                                              AS corridas,
      count(*) FILTER (WHERE status = 'error')::int              AS fallas,
      max(finished_at)                                           AS ultima_corrida,
      max(finished_at) FILTER (WHERE status = 'ok')              AS ultima_ok,
      -- NULL, no 0, cuando nunca hubo un ok: es "no medido", no "recién funcionó" (ADR-056).
      -- ATENCION: el cast a numeric NO es decorativo. round(x, 1) solo existe para numeric, y
      -- percentile_cont y EXTRACT devuelven double precision aca, asi que sin el cast la vista
      -- ni siquiera se crea: "function round(double precision, integer) does not exist".
      -- (Sin acentos graves aca adentro: cierran el template literal de JS. Quinta vez.)
      round((EXTRACT(EPOCH FROM (now() - max(finished_at) FILTER (WHERE status = 'ok'))) / 3600.0)::numeric, 1)
                                                                 AS horas_sin_ok,
      round(((percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)) / 1000.0)::numeric, 1)
                                                                 AS seg_p50,
      round((max(duration_ms) / 1000.0)::numeric, 1)             AS seg_max,
      count(DISTINCT note)::int                                  AS resumenes_distintos,
      (array_agg(note ORDER BY finished_at DESC))[1]             AS ultimo_resumen,
      CASE
        WHEN count(*) FILTER (WHERE status = 'ok') = 0 THEN 'nunca_ok'
        WHEN count(*) FILTER (WHERE status = 'error') > 0 THEN 'intermitente'
        ELSE 'ok'
      END                                                        AS veredicto
      FROM pasos
     GROUP BY tenant_id, carril, paso
  `);

  await knex.raw(`GRANT SELECT ON analytics.v_feed_step_health TO app_runtime`);

  await knex.raw(`COMMENT ON VIEW analytics.v_feed_step_health IS
    'VL.6.4 — contabilidad por PASO de los carriles de feeds (ventana 30d) sobre analytics.cron_run_log. Existe porque feed_nightly es UN latido para 53 pasos y solo se pone rojo si fallan los 53: un paso muerto se ve igual que uno critico. NO estima filas escritas (el orquestador no las conoce) — ultimo_resumen es la ultima linea del propio importer, textual. Una fila ausente NO es un paso sano: el padron de pasos vive en run-prod-feeds.js, no en la BD.'`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_feed_step_health`);
};
