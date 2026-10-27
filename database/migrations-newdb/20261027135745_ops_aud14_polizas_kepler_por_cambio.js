'use strict';
/**
 * `[OPS-AUD.14]` (ADR-104, ampliado) — El reporte de pólizas de Kepler (`analytics.gl_polizas` y
 * `gl_poliza_lines`, `source='kepler'`) se MANTIENE desde el ODS por cambio, póliza por póliza.
 * Reemplaza a `import-kepler-polizas.js`, el cron de las 03:00 que leía cada sucursal directo.
 *
 * ── Lo que estaba mal, leído en el código y medido en prod (2026-10-27) ─────────────────────
 *  · El importer NUNCA borraba y la llave del renglón lleva la cuenta: cuando Contabilidad cambia
 *    la cuenta de un renglón (las correcciones del SUA, 762-001 → 601-015), el viejo se quedaba
 *    PARA SIEMPRE junto al nuevo, sumando dos veces.
 *  · `num_movto` era un contador en el orden en que llegaban las filas, y la consulta no tenía
 *    ORDER BY: podía cambiar de una noche a otra (la llave incluye num_movto → más duplicados).
 *  · Sólo recorría los últimos 6 meses: una corrección de hace 7 nunca llegaba.
 *  · La corrección se veía hasta el día siguiente (cron de las 03:00).
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 *  · `analytics.kepler_poliza_rebuild(tabla, claves)`: LA regla, con la misma transformación del
 *    importer (cuenta=c3 · C/A=c4 · importe=c5 · concepto=c6 · fecha=c2 · sucursal=c14 o la de la
 *    réplica · doc=c15||c16||c17||c18 · folio=c19 o 'S/F'; c5>0; guarda own-sucursal). Borra los
 *    renglones y la cabecera de esas pólizas y los rearma COMPLETOS desde el ODS. `num_movto` sale
 *    de un orden fijo (c10, cuenta, C/A, importe, concepto).
 *  · Triggers POR SENTENCIA en cada `kepler_ods.kdc2YYMM`: recalculan sólo las pólizas tocadas.
 *  · Event trigger: una tabla `kdc2YYMM` NUEVA (la crea la ingesta el día 1) recibe sus triggers
 *    en el mismo instante, sin cron.
 *  · Nunca frena la ingesta: el error se atrapa y queda en `analytics.gl_polizas_kepler_errors`.
 *  · ContPAQi (`source='contpaqi'`) NO se toca.
 *
 * ⛔ FRENO de la carga inicial (y de un TRUNCATE): sólo se reconstruye una sucursal×mes que TIENE
 *    filas en el ODS. Una que el ODS no trae (réplicas 06/07/08 sin ciertos meses, medido en seco
 *    el 2026-10-27) se queda como la dejó el importer: historia que no se puede reconstruir no se
 *    borra.
 *
 * ⚠️ Se aplica FUERA DE HORARIO y DESPUÉS de desplegar la imagen de ingesta que ya no corre
 *    `import-kepler-polizas` (si no, a las 03:00 el importer volvería a escribir encima).
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const M = '00000000-0000-0000-0000-00000000d01c';

// La llave de póliza de un renglón de kdc2 (alias de tabla `r`). Mismas expresiones que el importer.
const SUC = (r) => `coalesce(nullif(btrim(${r}.c14::text), ''), ${r}.sucursal)`;
const DOC = (r) => `coalesce(nullif(btrim(${r}.c15::text || ${r}.c16::text || lpad(trim_scale(${r}.c17)::text, 2, '0') || lpad(trim_scale(${r}.c18)::text, 2, '0')), ''), '0000')`;
const FOLIO = (r) => `coalesce(nullif(btrim(${r}.c19::text), ''), 'S/F')`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '10s'`);
  const hay = await knex.raw(`SELECT to_regclass('analytics.gl_poliza_lines') l, to_regclass('analytics.gl_polizas') h, to_regclass('kepler_ods.kdco') k`);
  if (!hay.rows[0].l || !hay.rows[0].h) {
    console.log('[OPS-AUD.14] faltan las tablas del reporte — se omite.');
    return;
  }

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS analytics.gl_polizas_kepler_errors (
      id          bigserial PRIMARY KEY,
      tenant_id   uuid NOT NULL DEFAULT '${M}'::uuid,
      tabla       text NOT NULL,
      operacion   text NOT NULL,
      sqlstate    text,
      mensaje     text,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now(),
      created_by  uuid,
      updated_by  uuid
    )`);

  // ── LA regla. p_claves NULL = todo el mes, con el FRENO (sólo las sucursales que el ODS trae).
  await knex.raw(`
    CREATE OR REPLACE FUNCTION analytics.kepler_poliza_rebuild(p_tabla text, p_claves jsonb)
    RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET timezone = 'America/Mexico_City' AS $fn$
    DECLARE
      y int; m int; am text; n int;
      src text; alcance text; alcance_sel text;
    BEGIN
      IF p_tabla !~ '^kdc2[0-9]{4}$' THEN RAISE EXCEPTION 'tabla de póliza inválida: %', p_tabla; END IF;
      y := 2000 + substr(p_tabla, 5, 2)::int;
      m := substr(p_tabla, 7, 2)::int;
      am := y::text || '-' || lpad(m::text, 2, '0');
      src := format($s$
        SELECT ${SUC('d')} AS suc, ${DOC('d')} AS doc, ${FOLIO('d')} AS folio,
               btrim(coalesce(d.c3::text, '')) AS cuenta, d.c4::text AS ca, round(d.c5::numeric, 2) AS importe,
               nullif(btrim(d.c6::text), '') AS concepto, d.c2::date AS fecha, d.c10 AS linea, d.sucursal AS rama
          FROM kepler_ods.%I d
         WHERE d.c5 > 0 AND d.c4 IN ('C', 'A')
           AND (d.c14 IS NULL OR btrim(d.c14::text) = '' OR btrim(d.c14::text) = d.sucursal)$s$, p_tabla);
      alcance := CASE WHEN p_claves IS NULL
        THEN '(x.sucursal) IN (SELECT DISTINCT suc FROM src)'
        ELSE '(x.sucursal, x.tipo_pol, x.folio) IN (SELECT s, d, f FROM jsonb_to_recordset($3) AS k(s text, d text, f text))' END;
      -- Del lado de la fuente: todo el mes, o sólo las pólizas tocadas.
      alcance_sel := CASE WHEN p_claves IS NULL THEN 'TRUE'
        ELSE '(x.suc, x.doc, x.folio) IN (SELECT s, d, f FROM jsonb_to_recordset($3) AS k(s text, d text, f text))' END;

      EXECUTE format('WITH src AS (%s) DELETE FROM analytics.gl_poliza_lines x
                       WHERE x.tenant_id = ''${M}'' AND x.source = ''kepler'' AND x.ejercicio = $1 AND x.periodo = $2 AND %s',
                     src, alcance) USING y, m, p_claves;
      EXECUTE format('WITH src AS (%s) DELETE FROM analytics.gl_polizas x
                       WHERE x.tenant_id = ''${M}'' AND x.source = ''kepler'' AND x.ejercicio = $1 AND x.periodo = $2 AND %s',
                     src, alcance) USING y, m, p_claves;

      EXECUTE format($q$
        WITH src AS (%s),
             sel AS (SELECT * FROM src x WHERE %s),
             cat AS (SELECT k.sucursal AS rama, btrim(k.c3::text) AS cod, nullif(btrim(min(k.c2::text)), '') AS nom
                       FROM kepler_ods.kdco k WHERE k.c3 IS NOT NULL GROUP BY 1, 2),
             num AS (SELECT sel.*, row_number() OVER (PARTITION BY suc, doc, folio
                                                       ORDER BY linea NULLS LAST, cuenta, ca, importe, concepto NULLS LAST) AS n
                       FROM sel)
        INSERT INTO analytics.gl_poliza_lines
          (tenant_id, source, sucursal, ejercicio, periodo, tipo_pol, folio, num_movto, cuenta, cuenta_nombre,
           cuenta_afectable, cuenta_mayor, familia, cargo_abono, importe, referencia, cfdi_uuid, sat_agrupador,
           anio_mes, computed_at, warehouse_id)
        SELECT '${M}', 'kepler', num.suc, $1, $2, num.doc, num.folio, num.n, num.cuenta, cat.nom,
               NULL, split_part(num.cuenta, '-', 1), left(num.cuenta, 1), num.ca, num.importe, num.concepto, NULL, NULL,
               $4, now(),
               (SELECT w.id FROM commercial.warehouses w
                 WHERE w.tenant_id = '${M}' AND w.code = num.suc AND w.deleted_at IS NULL LIMIT 1)
          FROM num LEFT JOIN cat ON cat.rama = num.rama AND cat.cod = num.cuenta$q$,
        src, alcance_sel) USING y, m, p_claves, am;
      GET DIAGNOSTICS n = ROW_COUNT;

      EXECUTE format($q$
        WITH src AS (%s),
             sel AS (SELECT * FROM src x WHERE %s),
             num AS (SELECT sel.*, row_number() OVER (PARTITION BY suc, doc, folio
                                                       ORDER BY linea NULLS LAST, cuenta, ca, importe, concepto NULLS LAST) AS n
                       FROM sel)
        INSERT INTO analytics.gl_polizas
          (tenant_id, source, sucursal, ejercicio, periodo, tipo_pol, folio, anio_mes, fecha, concepto,
           cargos, abonos, neto, num_lines, guid, tiene_doc_bancario, computed_at, warehouse_id)
        SELECT '${M}', 'kepler', suc, $1, $2, doc, folio, $4,
               (array_agg(fecha ORDER BY n))[1], (array_agg(concepto ORDER BY n))[1],
               coalesce(sum(importe) FILTER (WHERE ca = 'C'), 0), coalesce(sum(importe) FILTER (WHERE ca = 'A'), 0),
               coalesce(sum(importe) FILTER (WHERE ca = 'C'), 0) - coalesce(sum(importe) FILTER (WHERE ca = 'A'), 0),
               count(*), NULL, NULL, now(),
               (SELECT w.id FROM commercial.warehouses w
                 WHERE w.tenant_id = '${M}' AND w.code = num.suc AND w.deleted_at IS NULL LIMIT 1)
          FROM num GROUP BY suc, doc, folio$q$,
        src, alcance_sel) USING y, m, p_claves, am;
      RETURN n;
    END $fn$`);

  // ── El trigger de cada kdc2YYMM. Las llaves salen del renglón VIEJO y del NUEVO (una cuenta
  // cambiada o un renglón borrado también tienen que recalcular su póliza).
  const LLAVES = (t) => `SELECT DISTINCT ${SUC('r')} AS s, ${DOC('r')} AS d, ${FOLIO('r')} AS f FROM ${t} r`;
  await knex.raw(`
    CREATE OR REPLACE FUNCTION analytics.tg_kdc2_gl_polizas()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
    DECLARE v_state text; v_msg text; claves jsonb;
    BEGIN
      BEGIN
        IF TG_OP = 'TRUNCATE' THEN
          PERFORM analytics.kepler_poliza_rebuild(TG_TABLE_NAME, NULL);
          RETURN NULL;
        ELSIF TG_OP = 'INSERT' THEN
          SELECT jsonb_agg(to_jsonb(k)) INTO claves FROM (${LLAVES('new_rows')}) k;
        ELSIF TG_OP = 'DELETE' THEN
          SELECT jsonb_agg(to_jsonb(k)) INTO claves FROM (${LLAVES('old_rows')}) k;
        ELSE
          SELECT jsonb_agg(to_jsonb(k)) INTO claves FROM (${LLAVES('new_rows')} UNION ${LLAVES('old_rows')}) k;
        END IF;
        IF claves IS NOT NULL THEN
          PERFORM analytics.kepler_poliza_rebuild(TG_TABLE_NAME, claves);
        END IF;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        INSERT INTO analytics.gl_polizas_kepler_errors (tabla, operacion, sqlstate, mensaje)
        VALUES (TG_TABLE_NAME, TG_OP, v_state, left(v_msg, 500));
      END;
      RETURN NULL;
    END $fn$`);

  // ── Poner los 4 triggers en UNA tabla (lo usa la migración y el event trigger).
  await knex.raw(`
    CREATE OR REPLACE FUNCTION analytics.kdc2_gl_polizas_enganchar(p_tabla text)
    RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
    BEGIN
      IF p_tabla !~ '^kdc2[0-9]{4}$' THEN RETURN; END IF;
      IF EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'kepler_ods' AND c.relname = p_tabla AND t.tgname = 'tg_glk_ins') THEN RETURN; END IF;
      EXECUTE format('CREATE TRIGGER tg_glk_ins AFTER INSERT ON kepler_ods.%I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION analytics.tg_kdc2_gl_polizas()', p_tabla);
      EXECUTE format('CREATE TRIGGER tg_glk_upd AFTER UPDATE ON kepler_ods.%I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION analytics.tg_kdc2_gl_polizas()', p_tabla);
      EXECUTE format('CREATE TRIGGER tg_glk_del AFTER DELETE ON kepler_ods.%I REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION analytics.tg_kdc2_gl_polizas()', p_tabla);
      EXECUTE format('CREATE TRIGGER tg_glk_trn AFTER TRUNCATE ON kepler_ods.%I FOR EACH STATEMENT EXECUTE FUNCTION analytics.tg_kdc2_gl_polizas()', p_tabla);
    END $fn$`);

  // ── Event trigger: la tabla del mes nuevo se engancha sola. Con EXCEPTION: si fallara, la
  // ingesta que crea la tabla NO debe fallar.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION analytics.kdc2_gl_polizas_auto()
    RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
    DECLARE r record;
    BEGIN
      FOR r IN SELECT c.relname FROM pg_event_trigger_ddl_commands() d
                 JOIN pg_class c ON c.oid = d.objid JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE d.object_type = 'table' AND n.nspname = 'kepler_ods' AND c.relname ~ '^kdc2[0-9]{4}$' LOOP
        BEGIN
          PERFORM analytics.kdc2_gl_polizas_enganchar(r.relname);
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING 'kdc2_gl_polizas_auto: % sin trigger (%)', r.relname, SQLERRM;
        END;
      END LOOP;
    END $fn$`);
  await knex.raw(`DROP EVENT TRIGGER IF EXISTS kdc2_gl_polizas_auto`);
  await knex.raw(`CREATE EVENT TRIGGER kdc2_gl_polizas_auto ON ddl_command_end
    WHEN TAG IN ('CREATE TABLE', 'ALTER TABLE') EXECUTE FUNCTION analytics.kdc2_gl_polizas_auto()`);

  // ── El árbitro: lo que hay en el reporte contra la regla, por mes (con el mismo FRENO).
  await knex.raw(`
    CREATE OR REPLACE FUNCTION analytics.gl_polizas_kepler_drift(p_tabla text, OUT faltan bigint, OUT sobran bigint)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET timezone = 'America/Mexico_City' AS $fn$
    DECLARE y int := 2000 + substr(p_tabla, 5, 2)::int; m int := substr(p_tabla, 7, 2)::int;
    BEGIN
      EXECUTE format($q$
        WITH src AS (
          SELECT ${SUC('d')} AS suc, ${DOC('d')} AS doc, ${FOLIO('d')} AS folio,
                 btrim(coalesce(d.c3::text, '')) AS cuenta, d.c4::text AS ca, round(d.c5::numeric, 2) AS importe
            FROM kepler_ods.%I d
           WHERE d.c5 > 0 AND d.c4 IN ('C', 'A')
             AND (d.c14 IS NULL OR btrim(d.c14::text) = '' OR btrim(d.c14::text) = d.sucursal)),
        reporte AS (
          SELECT sucursal, tipo_pol, folio, cuenta, cargo_abono, importe FROM analytics.gl_poliza_lines
           WHERE tenant_id = '${M}' AND source = 'kepler' AND ejercicio = $1 AND periodo = $2
             AND sucursal IN (SELECT DISTINCT suc FROM src))
        SELECT (SELECT count(*) FROM (SELECT * FROM src EXCEPT ALL SELECT * FROM reporte) a),
               (SELECT count(*) FROM (SELECT * FROM reporte EXCEPT ALL SELECT * FROM src) b)$q$, p_tabla)
      INTO faltan, sobran USING y, m;
    END $fn$`);

  // ── Enganchar las tablas que ya existen y reconstruir cada mes (con el FRENO).
  const { rows } = await knex.raw(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                                    WHERE n.nspname = 'kepler_ods' AND c.relname ~ '^kdc2[0-9]{4}$' AND c.relkind = 'r' ORDER BY 1`);
  let total = 0;
  for (const { relname } of rows) {
    await knex.raw(`SELECT analytics.kdc2_gl_polizas_enganchar(?)`, [relname]);
    const r = await knex.raw(`SELECT analytics.kepler_poliza_rebuild(?, NULL) AS n`, [relname]);
    total += Number(r.rows[0].n || 0);
  }
  console.log(`[OPS-AUD.14] ${rows.length} tablas kdc2 enganchadas · ${total} renglones de póliza reconstruidos desde el ODS`);
  await knex.raw(`GRANT SELECT ON analytics.gl_polizas_kepler_errors TO app_runtime`);
};

/** Deshace EXACTAMENTE lo que hizo el `up` (los renglones reconstruidos se quedan: son el dato correcto). */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '10s'`);
  await knex.raw(`DROP EVENT TRIGGER IF EXISTS kdc2_gl_polizas_auto`);
  const { rows } = await knex.raw(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                                    WHERE n.nspname = 'kepler_ods' AND c.relname ~ '^kdc2[0-9]{4}$'`);
  for (const { relname } of rows) {
    for (const s of ['ins', 'upd', 'del', 'trn']) await knex.raw(`DROP TRIGGER IF EXISTS tg_glk_${s} ON kepler_ods."${relname}"`);
  }
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.kdc2_gl_polizas_auto()`);
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.kdc2_gl_polizas_enganchar(text)`);
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.tg_kdc2_gl_polizas()`);
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.gl_polizas_kepler_drift(text)`);
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.kepler_poliza_rebuild(text, jsonb)`);
  await knex.raw(`DROP TABLE IF EXISTS analytics.gl_polizas_kepler_errors`);
};
