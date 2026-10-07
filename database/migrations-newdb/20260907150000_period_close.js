/**
 * [VP.4.1] `analytics.period_close` — la cifra OFICIAL de un mes, congelada (ADR-056).
 *
 * ── POR QUÉ ──────────────────────────────────────────────────────────────────────────────
 * Es la otra mitad de la queja que originó la fase VP: *"no hay una verdad absoluta"*. Medido el
 * 2026-09-05: grep de `period_close` / `cierre_mes` / `periodo_cerrado` / `frozen` en 578 migraciones
 * → **cero**. **No existe ninguna cifra oficial congelada.** Todo reporte se recalcula desde fuentes
 * vivas en cada request, y esas fuentes **se mueven hacia atrás**: `kepler_ods` recibe UPSERT, las
 * matvistas se re-materializan, los literales de dedup se editan. Cuando el número de enero cambia,
 * nadie puede decir cuánto valía antes ni por qué.
 *
 * ── LA DECISIÓN (Edgar, 2026-09-05): CONGELADO MANDA, LA DIFERENCIA SE DECLARA ───────────
 * Un mes cerrado se sirve del cierre, no del recálculo. Un comparador nocturno recalcula y, si
 * difiere, **lo declara** — no cambia el número en silencio. Es la única forma de que la empresa
 * deje de ver cifras que se mueven solas, y de que el equipo se entere el mismo día.
 *
 * ── LAS TRES COSAS QUE SE GUARDAN, Y POR QUÉ TRES ────────────────────────────────────────
 * Guardar sólo la cifra contesta *"cambió"* y deja *"por qué"* sin respuesta, que es la mitad cara.
 *
 *  1. `cifra` — el número, **con desglose por sucursal**. Un total puede cuadrar compensando errores
 *     opuestos (dos sucursales que se mueven al revés), así que el total solo no alcanza como
 *     testigo. Es la misma razón por la que `test-newdb-fact-vs-kepler` mira la MEDIANA por SKU y no
 *     únicamente el total.
 *  2. `definicion_hash` — el hash del SQL vigente de las vistas que producen la cifra. Distingue las
 *     dos causas posibles, que piden acciones opuestas: **la fuente se movió** (llegó dato nuevo o
 *     se corrigió el ERP → probablemente correcto, hay que re-cerrar) vs **la definición cambió**
 *     (alguien editó la vista → hay que revisar el cambio). Sin esto las dos se ven idénticas.
 *     El patrón es `daily_captures.config_version_id → scoring_config_versions`, que ya amarra la
 *     regla vigente al hecho — el mejor patrón del repo, aplicado a otro dominio.
 *  3. `watermarks` — hasta dónde había llegado cada fuente al cerrar. Cuando la cifra difiere y la
 *     definición NO cambió, esto dice **cuál** fuente avanzó.
 *
 * ── UNA DEFINICIÓN, DOS CONSUMIDORES ─────────────────────────────────────────────────────
 * El cierre y el comparador **tienen que calcular igual**, o el comparador reporta diferencias que
 * no existen. Por eso la cifra la produce UNA función SQL (`analytics.sellout_period_snapshot`) que
 * ambos llaman. Es la lección del dedup del sell-out, que llegó a estar escrito a mano en 11
 * archivos porque nadie lo centralizó a tiempo.
 *
 * ── POR QUÉ NO VIOLA §32 ─────────────────────────────────────────────────────────────────
 * `GOTCHAS.md` §32 prohíbe copiar una tabla y, sobre todo, **materializar un valor inventado**. Acá
 * cada columna tiene origen verificable —la cifra sale de la vista, el hash de `pg_get_viewdef`, los
 * watermarks de `cron_runs`— y §32 admite explícitamente tabla real para "histórico/snapshots". Un
 * cierre es justamente eso: la foto de un mes, que por definición no se puede derivar del presente.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  if (!(await knex.schema.withSchema('analytics').hasTable('period_close'))) {
    await knex.raw(`
      CREATE TABLE analytics.period_close (
        id               bigserial PRIMARY KEY,
        tenant_id        uuid        NOT NULL,
        superficie       text        NOT NULL,
        periodo          text        NOT NULL,
        cifra            jsonb       NOT NULL,
        definicion_hash  text        NOT NULL,
        definicion       jsonb       NOT NULL,
        watermarks       jsonb       NOT NULL,
        closed_by        text        NOT NULL,
        closed_at        timestamptz NOT NULL DEFAULT now(),
        -- Resultado del último recálculo. NULL = nadie lo ha vuelto a mirar desde que se cerró,
        -- que NO es lo mismo que "coincide": es la regla 3 de ADR-056 aplicada al propio cierre.
        last_check_at     timestamptz,
        last_check_status text,
        last_check_diff   jsonb,
        CONSTRAINT pc_periodo_forma  CHECK (periodo ~ '^[0-9]{4}-[0-9]{2}$'),
        CONSTRAINT pc_check_estado   CHECK (last_check_status IS NULL
                                       OR last_check_status IN ('coincide','difiere_fuente','difiere_definicion')),
        CONSTRAINT pc_unico          UNIQUE (tenant_id, superficie, periodo)
      )`);

    await knex.raw(`CREATE INDEX ix_pc_pendiente ON analytics.period_close
      (tenant_id, superficie, periodo) WHERE last_check_status IS DISTINCT FROM 'coincide'`);

    await knex.raw(`GRANT SELECT, INSERT, UPDATE ON analytics.period_close TO app_runtime`);
    await knex.raw(`GRANT USAGE, SELECT ON SEQUENCE analytics.period_close_id_seq TO app_runtime`);
    // UPDATE sí (el comparador escribe su veredicto), DELETE no: un cierre no se borra, se re-cierra
    // dejando constancia. Sin DELETE, "el número de enero" no puede desaparecer sin dejar rastro.

    await knex.raw(`COMMENT ON TABLE analytics.period_close IS
      'VP.4.1 (ADR-056) — cifra OFICIAL congelada de un mes por superficie. Un mes cerrado se sirve de acá, no del recálculo; un comparador recalcula y DECLARA la diferencia en last_check_*, nunca cambia el número en silencio. definicion_hash distingue "la fuente se movió" de "alguien editó la vista", que piden acciones opuestas.'`);
  }

  // ── La definición ÚNICA de la cifra del sell-out ──────────────────────────────────────
  // La llaman el cierre Y el comparador. Si cada uno calculara lo suyo, el comparador reportaría
  // diferencias inventadas — y nadie volvería a creerle. STABLE + sin efectos: es una lectura.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION analytics.sellout_period_snapshot(p_tenant uuid, p_periodo text)
    RETURNS jsonb AS $$
      WITH base AS (
        SELECT s.source_branch,
               sum(s.monto)::numeric(16,2) AS monto,
               sum(s.units)::numeric(16,3) AS unidades,
               count(*)::bigint            AS filas
          FROM analytics.v_sellout_daily s
         WHERE s.tenant_id = p_tenant
           AND to_char(s.business_date, 'YYYY-MM') = p_periodo
         GROUP BY s.source_branch
      )
      SELECT jsonb_build_object(
        'monto',     COALESCE(sum(monto), 0),
        'unidades',  COALESCE(sum(unidades), 0),
        'filas',     COALESCE(sum(filas), 0),
        -- El desglose es el testigo contra los errores que se compensan: dos sucursales moviéndose
        -- al revés dejan el total igual y esto no.
        'por_sucursal', COALESCE(jsonb_object_agg(source_branch,
            jsonb_build_object('monto', monto, 'unidades', unidades, 'filas', filas)), '{}'::jsonb)
      ) FROM base;
    $$ LANGUAGE sql STABLE;

    COMMENT ON FUNCTION analytics.sellout_period_snapshot(uuid, text) IS
    'VP.4.1 — la cifra del sell-out de un mes. UNA definición para el cierre y el comparador: si cada uno calculara lo suyo, el comparador reportaría diferencias inventadas.';
  `);

  // ── El hash de la DEFINICIÓN vigente ──────────────────────────────────────────────────
  // Sobre `pg_get_viewdef`, que devuelve el SQL como el servidor lo tiene: inmune a reformateos del
  // archivo de migración y sensible a cualquier cambio real de semántica.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION analytics.sellout_definicion()
    RETURNS jsonb AS $$
      SELECT jsonb_build_object(
        'objetos', jsonb_agg(o ORDER BY o),
        'sql_md5', md5(string_agg(pg_get_viewdef(o::regclass, true), E'\\n' ORDER BY o))
      )
      FROM unnest(ARRAY['analytics.v_sellout_daily','analytics.mv_sellout_monthly']) AS o;
    $$ LANGUAGE sql STABLE;

    COMMENT ON FUNCTION analytics.sellout_definicion() IS
    'VP.4.1 — huella del SQL vigente de las vistas del sell-out. Distingue "la fuente se movió" de "alguien editó la vista": dos causas que se ven iguales en la cifra y piden acciones opuestas.';
  `);

  // ── Los watermarks de las fuentes al momento de cerrar ────────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE FUNCTION analytics.sellout_watermarks(p_tenant uuid)
    RETURNS jsonb AS $$
      SELECT COALESCE(jsonb_object_agg(job_key, jsonb_build_object(
               'last_finish', last_finish, 'status', status, 'rows', rows_affected)), '{}'::jsonb)
        FROM analytics.cron_runs
       WHERE tenant_id = p_tenant
         AND job_key IN ('analytics_refresh_kepler','analytics_refresh_wincaja',
                         'analytics_refresh_sellout_monthly','ods_live_hot');
    $$ LANGUAGE sql STABLE;

    COMMENT ON FUNCTION analytics.sellout_watermarks(uuid) IS
    'VP.4.1 — hasta dónde había llegado cada fuente al cerrar. Cuando la cifra difiere y la definición NO cambió, esto dice CUÁL fuente avanzó.';
  `);

  // ── Cerrar un mes ─────────────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE FUNCTION analytics.cerrar_periodo(
      p_tenant uuid, p_superficie text, p_periodo text, p_por text DEFAULT NULL)
    RETURNS analytics.period_close AS $$
    DECLARE r analytics.period_close; d jsonb;
    BEGIN
      IF p_superficie <> 'sell_out' THEN
        RAISE EXCEPTION 'superficie % sin definición de cifra — agregarla antes de cerrarla', p_superficie;
      END IF;
      -- Cerrar el mes en curso congelaría una foto a medias que después "cambia" todos los días.
      IF p_periodo >= to_char((now() AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM') THEN
        RAISE EXCEPTION 'el periodo % no ha terminado — sólo se cierran meses cumplidos', p_periodo;
      END IF;
      d := analytics.sellout_definicion();
      INSERT INTO analytics.period_close
        (tenant_id, superficie, periodo, cifra, definicion_hash, definicion, watermarks, closed_by)
      VALUES (p_tenant, p_superficie, p_periodo,
              analytics.sellout_period_snapshot(p_tenant, p_periodo),
              d ->> 'sql_md5', d, analytics.sellout_watermarks(p_tenant),
              COALESCE(p_por, NULLIF(current_setting('app.actor', true), ''), current_user))
      -- Re-cerrar es legítimo (llegó dato que faltaba), pero deja constancia: se pisa la cifra y se
      -- LIMPIA el veredicto anterior, para que no quede un 'coincide' viejo hablando de otra cifra.
      ON CONFLICT (tenant_id, superficie, periodo) DO UPDATE SET
        cifra = EXCLUDED.cifra, definicion_hash = EXCLUDED.definicion_hash,
        definicion = EXCLUDED.definicion, watermarks = EXCLUDED.watermarks,
        closed_by = EXCLUDED.closed_by, closed_at = now(),
        last_check_at = NULL, last_check_status = NULL, last_check_diff = NULL
      RETURNING * INTO r;
      RETURN r;
    END;
    $$ LANGUAGE plpgsql;

    COMMENT ON FUNCTION analytics.cerrar_periodo(uuid, text, text, text) IS
    'VP.4.1 — congela la cifra oficial de un mes cumplido. Re-cerrar pisa la cifra y limpia el veredicto anterior (un "coincide" viejo hablaría de otra cifra).';
  `);

  // ── Comparar el cierre contra el recálculo de hoy ─────────────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE FUNCTION analytics.verificar_periodo(
      p_tenant uuid, p_superficie text, p_periodo text)
    RETURNS jsonb AS $$
    DECLARE
      r analytics.period_close; hoy jsonb; d jsonb; estado text; dif jsonb;
    BEGIN
      SELECT * INTO r FROM analytics.period_close
       WHERE tenant_id=p_tenant AND superficie=p_superficie AND periodo=p_periodo;
      IF NOT FOUND THEN RETURN jsonb_build_object('estado','sin_cierre','periodo',p_periodo); END IF;

      hoy := analytics.sellout_period_snapshot(p_tenant, p_periodo);
      d   := analytics.sellout_definicion();

      IF hoy = r.cifra THEN
        estado := 'coincide'; dif := NULL;
      ELSIF (d ->> 'sql_md5') IS DISTINCT FROM r.definicion_hash THEN
        -- Alguien editó la vista. La cifra "cambió" porque cambió la REGLA, no el dato: se revisa
        -- el cambio, no el ERP. Sin el hash esto se vería idéntico al caso de abajo.
        estado := 'difiere_definicion';
      ELSE
        -- Misma regla, otro resultado → se movió una fuente. Los watermarks dicen cuál.
        estado := 'difiere_fuente';
      END IF;

      IF estado <> 'coincide' THEN
        dif := jsonb_build_object(
          'cerrado', r.cifra, 'hoy', hoy,
          'delta_monto',    (hoy->>'monto')::numeric    - (r.cifra->>'monto')::numeric,
          'delta_unidades', (hoy->>'unidades')::numeric - (r.cifra->>'unidades')::numeric,
          'delta_filas',    (hoy->>'filas')::bigint     - (r.cifra->>'filas')::bigint,
          'definicion_al_cerrar', r.definicion, 'definicion_hoy', d,
          'watermarks_al_cerrar', r.watermarks, 'watermarks_hoy', analytics.sellout_watermarks(p_tenant));
      END IF;

      UPDATE analytics.period_close
         SET last_check_at = now(), last_check_status = estado, last_check_diff = dif
       WHERE id = r.id;

      RETURN jsonb_build_object('estado', estado, 'periodo', p_periodo, 'diff', dif);
    END;
    $$ LANGUAGE plpgsql;

    COMMENT ON FUNCTION analytics.verificar_periodo(uuid, text, text) IS
    'VP.4.1 — recalcula un mes cerrado y DECLARA la diferencia (nunca cambia el número). difiere_definicion = alguien editó la vista; difiere_fuente = se movió el dato. Dos causas que piden acciones opuestas.';
  `);
};

exports.down = async function (knex) {
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.verificar_periodo(uuid, text, text)`);
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.cerrar_periodo(uuid, text, text, text)`);
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.sellout_watermarks(uuid)`);
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.sellout_definicion()`);
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.sellout_period_snapshot(uuid, text)`);
  await knex.raw(`DROP TABLE IF EXISTS analytics.period_close`);
};
