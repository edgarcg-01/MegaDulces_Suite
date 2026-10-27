'use strict';
/**
 * `[OPS-AUD.11.1]` (ADR-104) — Los movimientos de tesorería se MANTIENEN por cambio, no se
 * recalculan con REFRESH. Paso 1 de 6: tabla + función + triggers + carga inicial.
 * **Ningún lector cambia todavía**: `analytics.kepler_bank_movements` y `mv_caja_movimientos`
 * siguen como están hasta que la paridad (paso 11.2) dé cero.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-27) ────────────────────────────────────────
 *  · `REFRESH mv_caja_movimientos`: 4,765 corridas en 27 h, 7.5 s c/u = 35,730 s — el 68 % de
 *    todo el costo de refrescar de la base.
 *  · `kepler_ods.kdm1`: ~130 cambios por hora (6,581 altas · 8,977 cambios · 34 bajas en ~5 días)
 *    contra ~175 refrescos por hora, cada uno recorriendo ~651 mil renglones.
 *  · `kepler_ods.kdb1`: 0 cambios en 5 días.
 *  · Cada movimiento depende sólo de SU renglón de kdm1 más el catálogo kdb1 (definición vigente:
 *    `20260924230000`): sin ventanas, saldos ni agregados.
 *
 * ── Qué crea ─────────────────────────────────────────────────────────────────────────────────
 *  · `analytics.bank_movement_legs`: una fila por pierna (banco, caja y puente), con la llave de
 *    origen de kdm1 (sucursal, c1..c6). La llave de negocio (sucursal, doc_tipo, folio,
 *    clave_banco, pierna) NO es única a propósito: no incluye c5, y un duplicado no puede
 *    romper la ingesta.
 *  · `analytics.kdm1_legs(kepler_ods.kdm1)`: LA regla, un renglón → sus piernas. Copia exacta de
 *    los CTE flj + legs de la vista vigente. La usan el trigger, la reconstrucción y el árbitro.
 *  · Triggers POR SENTENCIA con tablas de transición sobre kdm1 (alta, cambio, baja, TRUNCATE) y
 *    sobre kdb1 (sólo reconstruye si cambió el CONJUNTO de claves, que es lo único de kdb1 que
 *    decide qué renglón entra; nombre, cuenta y tipo se cruzan al leer).
 *  · `analytics.bank_movement_legs_errors`: el trigger NUNCA frena la ingesta. Si falla, deja
 *    pasar el kdm1 y registra aquí el error; el árbitro nocturno (11.6) corrige y lo declara.
 *  · `analytics.bank_movement_legs_rebuild()` y `analytics.bank_movement_legs_drift()`.
 *
 * ⚠️ Toma un candado sobre kdm1 al crear los triggers y hace la carga inicial en la misma
 *    transacción (la ingesta espera esos segundos). Se aplica FUERA DE HORARIO.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const M = '00000000-0000-0000-0000-00000000d01c';

// Las claves de kdb1 que cuentan: misma condición que el CTE kb de la vista vigente.
const CLAVES_KDB1 = `SELECT btrim(k.c1) FROM kepler_ods.kdb1 k WHERE btrim(coalesce(k.c1,'')) <> ''`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const fuentes = await knex.raw(`SELECT to_regclass('kepler_ods.kdm1') AS kdm1, to_regclass('kepler_ods.kdb1') AS kdb1`);
  if (!fuentes.rows[0].kdm1 || !fuentes.rows[0].kdb1) {
    // Sin ODS no hay nada que mantener (entorno sin ingesta). No se falla.
    console.log('[OPS-AUD.11.1] falta kepler_ods.kdm1 o kdb1 — se omite.');
    return;
  }

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS analytics.bank_movement_legs (
      id             bigserial PRIMARY KEY,
      tenant_id      uuid NOT NULL DEFAULT '${M}'::uuid,
      src_sucursal   text    NOT NULL,
      src_c1         text    NOT NULL,
      src_c2         text    NOT NULL,
      src_c3         text    NOT NULL,
      src_c4         numeric NOT NULL,
      src_c5         numeric NOT NULL,
      src_c6         text    NOT NULL,
      sucursal       text    NOT NULL,
      doc_tipo       text    NOT NULL,
      folio          text    NOT NULL,
      clave_banco    text    NOT NULL,
      flujo          text    NOT NULL,
      importe        numeric NOT NULL,
      signo          smallint,
      fecha_valor    date,
      fecha_captura  date,
      concepto       text,
      metodo         text,
      beneficiario   text,
      es_traspaso    boolean NOT NULL,
      contra_clave   text,
      pierna         text    NOT NULL,
      entidad_code   text,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now(),
      created_by     uuid,
      updated_by     uuid
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_bml_origen
    ON analytics.bank_movement_legs (src_sucursal, src_c1, src_c2, src_c3, src_c4, src_c5, src_c6)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_bml_clave_fecha
    ON analytics.bank_movement_legs (tenant_id, clave_banco, fecha_valor DESC)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_bml_documento
    ON analytics.bank_movement_legs (tenant_id, sucursal, doc_tipo, folio)`);
  await knex.raw(`COMMENT ON TABLE analytics.bank_movement_legs IS
    'ADR-104 — piernas de tesorería mantenidas por trigger desde kepler_ods.kdm1 (una fila por pierna). La regla vive en analytics.kdm1_legs(). Nombre, cuenta y tipo de la cuenta, account_label y complemento SAT NO se guardan: se cruzan al leer.'`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS analytics.bank_movement_legs_errors (
      id          bigserial PRIMARY KEY,
      tenant_id   uuid NOT NULL DEFAULT '${M}'::uuid,
      tabla       text NOT NULL,
      operacion   text NOT NULL,
      sqlstate    text,
      mensaje     text,
      filas       integer,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now(),
      created_by  uuid,
      updated_by  uuid
    )`);

  // ── LA regla: un renglón de kdm1 → sus piernas. Copia exacta de flj + legs (20260924230000).
  await knex.raw(`
    CREATE OR REPLACE FUNCTION analytics.kdm1_legs(d kepler_ods.kdm1)
    RETURNS TABLE (
      sucursal text, doc_tipo text, folio text, clave_banco text, flujo text, importe numeric,
      signo smallint, fecha_valor date, fecha_captura date, concepto text, metodo text,
      beneficiario text, es_traspaso boolean, contra_clave text, pierna text, entidad_code text)
    LANGUAGE sql STABLE AS $fn$
      WITH f AS (
        SELECT btrim(d.c1::text) AS suc,
               btrim(d.c2::text)||'-'||btrim(d.c3::text)||'-'||btrim(d.c4::text) AS dt,
               btrim(d.c6::text) AS folio, d.c9::date AS fval, d.c68::date AS fcap,
               round(coalesce(NULLIF(regexp_replace(d.c16::text,'[^0-9.-]','','g'),'')::numeric,0),2) AS importe,
               NULLIF(btrim(d.c24::text),'') AS concepto, NULLIF(btrim(d.c31::text),'') AS metodo,
               NULLIF(btrim(d.c32::text),'') AS beneficiario, btrim(d.c45::text) AS c45,
               NULLIF(btrim(d.c47::text),'') AS c47, NULLIF(btrim(d.c10::text),'') AS entidad,
               CASE btrim(d.c2::text)||'-'||btrim(d.c3::text)||'-'||btrim(d.c4::text)
                 WHEN 'U-A-5' THEN 'entrada' WHEN 'U-A-25' THEN 'entrada' WHEN 'X-A-45' THEN 'entrada'
                 WHEN 'X-D-26' THEN 'salida' WHEN 'X-D-25' THEN 'salida' WHEN 'X-D-60' THEN 'salida' WHEN 'X-D-10' THEN 'salida'
                 WHEN 'N-A-26' THEN 'traspaso'
                 ELSE CASE WHEN btrim(d.c31::text)='Cob' THEN 'entrada'
                           WHEN btrim(d.c31::text) IN ('Tra','Che','Ant') THEN 'salida' ELSE 'otro' END
               END AS flujo
         WHERE btrim(d.c1::text) = d.sucursal::text
           AND btrim(coalesce(d.c43::text,'')) <> 'C'
           AND btrim(d.c45::text) IN (${CLAVES_KDB1})
      )
      SELECT suc, dt, folio, c45, flujo, importe,
             (CASE WHEN flujo='traspaso' THEN -1 WHEN flujo='entrada' THEN 1 WHEN flujo='salida' THEN -1 ELSE NULL END)::smallint,
             fval, fcap, concepto, metodo, beneficiario,
             (flujo='traspaso'),
             CASE WHEN flujo='traspaso' THEN c47 ELSE NULL END,
             CASE WHEN flujo='traspaso' THEN 'origen' ELSE 'mov' END,
             entidad
        FROM f
      UNION ALL
      SELECT suc, dt, folio, c47, 'traspaso', importe, 1::smallint, fval, fcap, concepto, metodo,
             beneficiario, true, c45, 'destino', entidad
        FROM f
       WHERE flujo='traspaso' AND c47 IS NOT NULL AND c47 IN (${CLAVES_KDB1})
    $fn$`);

  // Reconstrucción completa. El prefiltro por c45 es exacto (la regla exige c45 en el catálogo)
  // y evita llamar la función por los ~600 mil renglones que no son de tesorería.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION analytics.bank_movement_legs_rebuild()
    RETURNS integer LANGUAGE plpgsql AS $fn$
    DECLARE n integer;
    BEGIN
      DELETE FROM analytics.bank_movement_legs;
      INSERT INTO analytics.bank_movement_legs
        (src_sucursal, src_c1, src_c2, src_c3, src_c4, src_c5, src_c6,
         sucursal, doc_tipo, folio, clave_banco, flujo, importe, signo, fecha_valor, fecha_captura,
         concepto, metodo, beneficiario, es_traspaso, contra_clave, pierna, entidad_code)
      SELECT d.sucursal, d.c1, d.c2, d.c3, d.c4, d.c5, d.c6, x.*
        FROM kepler_ods.kdm1 d
        CROSS JOIN LATERAL analytics.kdm1_legs(d) x
       WHERE btrim(d.c45::text) IN (${CLAVES_KDB1});
      GET DIAGNOSTICS n = ROW_COUNT;
      RETURN n;
    END $fn$`);

  // El árbitro: la tabla contra la regla aplicada a todo kdm1. faltan = la regla las da y la
  // tabla no; sobran = al revés. Cero y cero = el trigger no tiene huecos.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION analytics.bank_movement_legs_drift(OUT faltan bigint, OUT sobran bigint)
    LANGUAGE sql STABLE AS $fn$
      WITH regla AS (
        SELECT d.sucursal AS s0, d.c1 AS s1, d.c2 AS s2, d.c3 AS s3, d.c4 AS s4, d.c5 AS s5, d.c6 AS s6, x.*
          FROM kepler_ods.kdm1 d CROSS JOIN LATERAL analytics.kdm1_legs(d) x
         WHERE btrim(d.c45::text) IN (${CLAVES_KDB1})
      ), tabla AS (
        SELECT src_sucursal, src_c1, src_c2, src_c3, src_c4, src_c5, src_c6,
               sucursal, doc_tipo, folio, clave_banco, flujo, importe, signo, fecha_valor, fecha_captura,
               concepto, metodo, beneficiario, es_traspaso, contra_clave, pierna, entidad_code
          FROM analytics.bank_movement_legs
      )
      SELECT (SELECT count(*) FROM (SELECT * FROM regla EXCEPT ALL SELECT * FROM tabla) a),
             (SELECT count(*) FROM (SELECT * FROM tabla EXCEPT ALL SELECT * FROM regla) b)
    $fn$`);

  // ⛔ Los dos triggers son SECURITY DEFINER (dueño = quien aplica la migración) con search_path
  //    fijo y todo calificado por esquema. Sin eso corren con el rol de quien escribe kdm1: si ese
  //    rol no pudiera escribir en bank_movement_legs, fallaría también el registro del error
  //    dentro del EXCEPTION, y ESE error sí tumbaría la ingesta.
  // ── El trigger de kdm1. Por SENTENCIA: una ingesta de 500 renglones es UNA llamada.
  // Una fila que se reescribe idéntica (reconciliación) no toca la tabla: se compara contra la
  // vieja por llave. Cualquier error se atrapa: el kdm1 se escribe igual.
  // ⚠️ Cada operación tiene SU sentencia: en PL/pgSQL una sentencia que nombra old_rows falla al
  //    prepararse dentro de un trigger de alta (ahí esa tabla de transición no existe), aunque la
  //    rama no se ejecute.
  const COLS = `(src_sucursal, src_c1, src_c2, src_c3, src_c4, src_c5, src_c6,
             sucursal, doc_tipo, folio, clave_banco, flujo, importe, signo, fecha_valor, fecha_captura,
             concepto, metodo, beneficiario, es_traspaso, contra_clave, pierna, entidad_code)`;
  const MISMA_LLAVE = (a, b) => `${a}.sucursal = ${b}.sucursal AND ${a}.c1 = ${b}.c1 AND ${a}.c2 = ${b}.c2
               AND ${a}.c3 = ${b}.c3 AND ${a}.c4 = ${b}.c4 AND ${a}.c5 = ${b}.c5 AND ${a}.c6 = ${b}.c6`;
  const DE_ORIGEN = (a) => `l.src_sucursal = ${a}.sucursal AND l.src_c1 = ${a}.c1 AND l.src_c2 = ${a}.c2
               AND l.src_c3 = ${a}.c3 AND l.src_c4 = ${a}.c4 AND l.src_c5 = ${a}.c5 AND l.src_c6 = ${a}.c6`;
  await knex.raw(`
    CREATE OR REPLACE FUNCTION analytics.tg_kdm1_bank_movement_legs()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
    DECLARE v_state text; v_msg text;
    BEGIN
      BEGIN
        IF TG_OP = 'TRUNCATE' THEN
          DELETE FROM analytics.bank_movement_legs;
        ELSIF TG_OP = 'DELETE' THEN
          DELETE FROM analytics.bank_movement_legs l USING old_rows o WHERE ${DE_ORIGEN('o')};
        ELSIF TG_OP = 'INSERT' THEN
          INSERT INTO analytics.bank_movement_legs ${COLS}
          SELECT n.sucursal, n.c1, n.c2, n.c3, n.c4, n.c5, n.c6, x.*
            FROM new_rows n CROSS JOIN LATERAL analytics.kdm1_legs(n) x;
        ELSIF TG_OP = 'UPDATE' THEN
          -- Sólo los renglones que cambiaron de verdad (o cambiaron de llave).
          DELETE FROM analytics.bank_movement_legs l USING old_rows o
           WHERE ${DE_ORIGEN('o')}
             AND NOT EXISTS (SELECT 1 FROM new_rows n WHERE ${MISMA_LLAVE('n', 'o')} AND n IS NOT DISTINCT FROM o);
          INSERT INTO analytics.bank_movement_legs ${COLS}
          SELECT n.sucursal, n.c1, n.c2, n.c3, n.c4, n.c5, n.c6, x.*
            FROM new_rows n CROSS JOIN LATERAL analytics.kdm1_legs(n) x
           WHERE NOT EXISTS (SELECT 1 FROM old_rows o WHERE ${MISMA_LLAVE('o', 'n')} AND o IS NOT DISTINCT FROM n);
        END IF;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        INSERT INTO analytics.bank_movement_legs_errors (tabla, operacion, sqlstate, mensaje)
        VALUES (TG_TABLE_NAME, TG_OP, v_state, left(v_msg, 500));
      END;
      RETURN NULL;
    END $fn$`);

  // ── kdb1: sólo importa el CONJUNTO de claves. Si no cambió, no se hace nada (la reconciliación
  // de catálogos reescribe kdb1 cada 30 min y un statement trigger dispara aunque toque 0 filas).
  await knex.raw(`
    CREATE OR REPLACE FUNCTION analytics.tg_kdb1_bank_movement_legs()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
    DECLARE v_state text; v_msg text; cambio boolean := true;
    BEGIN
      BEGIN
        IF TG_OP = 'INSERT' THEN
          cambio := EXISTS (SELECT 1 FROM new_rows n WHERE btrim(coalesce(n.c1,'')) <> '');
        ELSIF TG_OP = 'DELETE' THEN
          cambio := EXISTS (SELECT 1 FROM old_rows o WHERE btrim(coalesce(o.c1,'')) <> '');
        ELSIF TG_OP = 'UPDATE' THEN
          cambio := EXISTS (
            (SELECT btrim(o.c1) FROM old_rows o WHERE btrim(coalesce(o.c1,'')) <> ''
             EXCEPT SELECT btrim(n.c1) FROM new_rows n WHERE btrim(coalesce(n.c1,'')) <> '')
            UNION ALL
            (SELECT btrim(n.c1) FROM new_rows n WHERE btrim(coalesce(n.c1,'')) <> ''
             EXCEPT SELECT btrim(o.c1) FROM old_rows o WHERE btrim(coalesce(o.c1,'')) <> ''));
        END IF;
        IF cambio THEN
          PERFORM analytics.bank_movement_legs_rebuild();
        END IF;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        INSERT INTO analytics.bank_movement_legs_errors (tabla, operacion, sqlstate, mensaje)
        VALUES (TG_TABLE_NAME, TG_OP, v_state, left(v_msg, 500));
      END;
      RETURN NULL;
    END $fn$`);

  const triggers = [
    ['kdm1', 'ins', 'INSERT', 'REFERENCING NEW TABLE AS new_rows'],
    ['kdm1', 'upd', 'UPDATE', 'REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows'],
    ['kdm1', 'del', 'DELETE', 'REFERENCING OLD TABLE AS old_rows'],
    ['kdm1', 'trn', 'TRUNCATE', ''],
    ['kdb1', 'ins', 'INSERT', 'REFERENCING NEW TABLE AS new_rows'],
    ['kdb1', 'upd', 'UPDATE', 'REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows'],
    ['kdb1', 'del', 'DELETE', 'REFERENCING OLD TABLE AS old_rows'],
    ['kdb1', 'trn', 'TRUNCATE', ''],
  ];
  for (const [tabla, sufijo, evento, refs] of triggers) {
    await knex.raw(`DROP TRIGGER IF EXISTS tg_bml_${sufijo} ON kepler_ods.${tabla}`);
    await knex.raw(`CREATE TRIGGER tg_bml_${sufijo} AFTER ${evento} ON kepler_ods.${tabla}
      ${refs} FOR EACH STATEMENT EXECUTE FUNCTION analytics.tg_${tabla}_bank_movement_legs()`);
  }

  // Carga inicial DESPUÉS de los triggers: con el candado ya tomado, nada cambia en medio.
  const r = await knex.raw(`SELECT analytics.bank_movement_legs_rebuild() AS n`);
  console.log(`[OPS-AUD.11.1] carga inicial: ${r.rows[0].n} piernas`);

  await knex.raw(`GRANT SELECT ON analytics.bank_movement_legs, analytics.bank_movement_legs_errors TO app_runtime`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  for (const tabla of ['kdm1', 'kdb1']) {
    const existe = await knex.raw(`SELECT to_regclass(?) AS r`, [`kepler_ods.${tabla}`]);
    if (!existe.rows[0].r) continue;
    for (const sufijo of ['ins', 'upd', 'del', 'trn']) {
      await knex.raw(`DROP TRIGGER IF EXISTS tg_bml_${sufijo} ON kepler_ods.${tabla}`);
    }
  }
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.tg_kdm1_bank_movement_legs()`);
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.tg_kdb1_bank_movement_legs()`);
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.bank_movement_legs_drift()`);
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.bank_movement_legs_rebuild()`);
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.kdm1_legs(kepler_ods.kdm1)`);
  await knex.raw(`DROP TABLE IF EXISTS analytics.bank_movement_legs_errors`);
  await knex.raw(`DROP TABLE IF EXISTS analytics.bank_movement_legs`);
};
