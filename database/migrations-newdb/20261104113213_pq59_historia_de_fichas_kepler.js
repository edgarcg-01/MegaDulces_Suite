'use strict';
/**
 * `[PQ.59]` — La historia de la ficha de Kepler: qué unidades, factores y costos tuvo cada producto
 * en cada sucursal, y desde cuándo. Se mantiene POR CAMBIO (trigger sobre `kepler_ods.kdii`), no
 * con un barrido.
 *
 * Por qué: Kepler NO guarda historia de la ficha (sólo la vigente) y cada renglón de venta, compra
 * o kardex quedó en la unidad que la ficha tenía al capturarse. Sin la ficha de ESA fecha, la
 * cantidad de un renglón viejo no se puede convertir con certeza, y las vistas convierten con la
 * de hoy (retroactivo). Lo de antes de hoy ya no se recupera; desde hoy, sí.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-04) ────────────────────────────────────────
 *  · Venta U-D asentada en una unidad que la ficha de HOY ya no tiene: ~12 % del importe en
 *    nov–dic 2025, 8 % ene–mar, 3.5 % abr–jun, 1.2 % jul–sep, 0.4 % oct-2026 (FASE_PQ §18.2).
 *  · `kepler_ods.kdii`: 86,081 fichas (sucursal × SKU), PK (sucursal, c1). Desde el último reinicio
 *    de estadísticas: 36 altas, 1,403 cambios, 1,344 bajas — poco movimiento; casi todo lo que la
 *    reconciliación reescribe llega idéntico.
 *
 * ── Qué crea ─────────────────────────────────────────────────────────────────────────────────
 *  · `analytics.kdii_ficha(kepler_ods.kdii)`: LA regla de qué se guarda de una ficha (rótulos de
 *    las tres unidades, sus factores c81/c84 y sus costos estándar c77/c78/c79). La usan el trigger
 *    y la carga inicial.
 *  · `analytics.kepler_ficha_history`: sólo altas. Una fila cuando la ficha de una sucursal NACE,
 *    CAMBIA en algo de lo de arriba o DESAPARECE. Una reescritura idéntica no deja fila (se compara
 *    contra la última fila guardada, no contra el renglón viejo: así una recarga tras un TRUNCATE
 *    tampoco ensucia).
 *  · `analytics.v_kepler_ficha_vigencia`: cada versión con su `vigente_desde` / `vigente_hasta`.
 *  · Triggers POR SENTENCIA sobre kdii (alta, cambio, baja). TRUNCATE no registra bajas: lo
 *    que vuelva a entrar se compara contra la historia y sólo deja fila si cambió.
 *  · `analytics.kepler_ficha_history_errors`: el trigger NUNCA frena la ingesta (ADR-104 §4).
 *
 * ⚠️ `vigente_desde` de las filas `inicial` es la fecha de esta migración, NO la fecha en que la
 *    ficha tomó ese valor: antes de hoy no se sabe. Se declara en la columna `operacion`.
 *
 * Toma un candado breve sobre kdii al crear los triggers (lock_timeout 5 s) y siembra ~86 mil
 * filas en la misma transacción.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const M = '00000000-0000-0000-0000-00000000d01c';

const TRIGGERS = [
  ['ins', 'INSERT', 'REFERENCING NEW TABLE AS new_rows'],
  ['upd', 'UPDATE', 'REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows'],
  ['del', 'DELETE', 'REFERENCING OLD TABLE AS old_rows'],
];

// Las columnas de la ficha que se versionan, en el orden de analytics.kdii_ficha().
const FICHA = 'u1, u2, f2, u3, f3, costo1, costo2, costo3';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const hay = await knex.raw(`SELECT to_regclass('kepler_ods.kdii') AS kdii`);
  if (!hay.rows[0].kdii) {
    // Sin ODS no hay ficha que versionar (entorno sin ingesta). No se falla.
    console.log('[PQ.59] falta kepler_ods.kdii — se omite.');
    return;
  }

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS analytics.kepler_ficha_history (
      id            bigserial PRIMARY KEY,
      tenant_id     uuid NOT NULL DEFAULT '${M}'::uuid,
      sucursal      text NOT NULL,
      sku           text NOT NULL,
      operacion     text NOT NULL CHECK (operacion IN ('inicial', 'alta', 'cambio', 'baja')),
      u1            text,
      u2            text,
      f2            numeric,
      u3            text,
      f3            numeric,
      costo1        numeric,
      costo2        numeric,
      costo3        numeric,
      -- clock_timestamp(), no now(): dos cambios de la misma ficha en UNA transacción de ingesta
      -- tienen que quedar en orden, y now() les daría la misma hora.
      observado_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      created_by    uuid,
      updated_by    uuid
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_kfh_llave
    ON analytics.kepler_ficha_history (sucursal, sku, observado_at DESC, id DESC)`);
  await knex.raw(`COMMENT ON TABLE analytics.kepler_ficha_history IS
    '[PQ.59] Historia de la ficha de Kepler (kdii) por sucursal: rótulos, factores c81/c84 y costos c77-c79. Sólo altas; una fila por nacimiento, cambio o baja. Mantenida por trigger. Las filas "inicial" fechan la migración, no el origen del valor.'`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS analytics.kepler_ficha_history_errors (
      id          bigserial PRIMARY KEY,
      tenant_id   uuid NOT NULL DEFAULT '${M}'::uuid,
      operacion   text NOT NULL,
      sqlstate    text,
      mensaje     text,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now(),
      created_by  uuid,
      updated_by  uuid
    )`);

  // ── LA regla: qué se guarda de una ficha. Misma lectura que v_kepler_unit_ladder (c77 es texto).
  await knex.raw(`
    CREATE OR REPLACE FUNCTION analytics.kdii_ficha(k kepler_ods.kdii,
      OUT sucursal text, OUT sku text,
      OUT u1 text, OUT u2 text, OUT f2 numeric, OUT u3 text, OUT f3 numeric,
      OUT costo1 numeric, OUT costo2 numeric, OUT costo3 numeric)
    LANGUAGE sql IMMUTABLE AS $fn$
      SELECT btrim(k.sucursal), btrim(k.c1),
             NULLIF(upper(btrim(k.c11)), ''), NULLIF(upper(btrim(k.c80)), ''), k.c81::numeric,
             NULLIF(upper(btrim(k.c83)), ''), k.c84::numeric,
             NULLIF(regexp_replace(k.c77::text, '[^0-9.]', '', 'g'), '')::numeric,
             k.c78::numeric, k.c79::numeric
    $fn$`);

  // ── El trigger. Por SENTENCIA. Cada operación con SU sentencia (en PL/pgSQL una sentencia que
  // nombra old_rows no se puede preparar en un trigger de alta). Compara contra la ÚLTIMA fila de
  // la historia de esa llave: una reescritura idéntica no deja rastro.
  // ⛔ SECURITY DEFINER + search_path fijo (ADR-104): si corriera con el rol de la ingesta y ese
  //    rol no pudiera escribir aquí, fallaría también el registro del error y tumbaría la ingesta.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION analytics.tg_kdii_ficha_history()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
    DECLARE v_state text; v_msg text;
    BEGIN
      BEGIN
        IF TG_OP = 'DELETE' THEN
          INSERT INTO analytics.kepler_ficha_history (sucursal, sku, operacion)
          SELECT o.sucursal, o.sku, 'baja'
            FROM (SELECT DISTINCT btrim(r.sucursal) AS sucursal, btrim(r.c1) AS sku FROM old_rows r) o
            JOIN LATERAL (SELECT h.operacion FROM analytics.kepler_ficha_history h
                           WHERE h.sucursal = o.sucursal AND h.sku = o.sku
                           ORDER BY h.observado_at DESC, h.id DESC LIMIT 1) u ON u.operacion <> 'baja'
           WHERE NOT EXISTS (SELECT 1 FROM kepler_ods.kdii k
                              WHERE btrim(k.sucursal) = o.sucursal AND btrim(k.c1) = o.sku);
        ELSIF TG_OP = 'INSERT' THEN
          INSERT INTO analytics.kepler_ficha_history (sucursal, sku, operacion, ${FICHA})
          SELECT f.sucursal, f.sku, CASE WHEN u.operacion IS NULL OR u.operacion = 'baja' THEN 'alta' ELSE 'cambio' END,
                 f.u1, f.u2, f.f2, f.u3, f.f3, f.costo1, f.costo2, f.costo3
            FROM new_rows n CROSS JOIN LATERAL analytics.kdii_ficha(n) f
            LEFT JOIN LATERAL (SELECT h.* FROM analytics.kepler_ficha_history h
                                WHERE h.sucursal = f.sucursal AND h.sku = f.sku
                                ORDER BY h.observado_at DESC, h.id DESC LIMIT 1) u ON true
           WHERE f.sku <> ''
             AND (u.id IS NULL OR u.operacion = 'baja'
                  OR (f.u1, f.u2, f.f2, f.u3, f.f3, f.costo1, f.costo2, f.costo3)
                     IS DISTINCT FROM (u.u1, u.u2, u.f2, u.u3, u.f3, u.costo1, u.costo2, u.costo3));
        ELSIF TG_OP = 'UPDATE' THEN
          INSERT INTO analytics.kepler_ficha_history (sucursal, sku, operacion, ${FICHA})
          SELECT f.sucursal, f.sku, CASE WHEN u.operacion IS NULL OR u.operacion = 'baja' THEN 'alta' ELSE 'cambio' END,
                 f.u1, f.u2, f.f2, f.u3, f.f3, f.costo1, f.costo2, f.costo3
            FROM new_rows n CROSS JOIN LATERAL analytics.kdii_ficha(n) f
            LEFT JOIN LATERAL (SELECT h.* FROM analytics.kepler_ficha_history h
                                WHERE h.sucursal = f.sucursal AND h.sku = f.sku
                                ORDER BY h.observado_at DESC, h.id DESC LIMIT 1) u ON true
           WHERE f.sku <> ''
             AND (u.id IS NULL OR u.operacion = 'baja'
                  OR (f.u1, f.u2, f.f2, f.u3, f.f3, f.costo1, f.costo2, f.costo3)
                     IS DISTINCT FROM (u.u1, u.u2, u.f2, u.u3, u.f3, u.costo1, u.costo2, u.costo3));
          -- Un cambio de llave (c1 o sucursal) deja huérfana la vieja: se da de baja.
          INSERT INTO analytics.kepler_ficha_history (sucursal, sku, operacion)
          SELECT o.sucursal, o.sku, 'baja'
            FROM (SELECT DISTINCT btrim(r.sucursal) AS sucursal, btrim(r.c1) AS sku FROM old_rows r) o
            JOIN LATERAL (SELECT h.operacion FROM analytics.kepler_ficha_history h
                           WHERE h.sucursal = o.sucursal AND h.sku = o.sku
                           ORDER BY h.observado_at DESC, h.id DESC LIMIT 1) u ON u.operacion <> 'baja'
           WHERE NOT EXISTS (SELECT 1 FROM kepler_ods.kdii k
                              WHERE btrim(k.sucursal) = o.sucursal AND btrim(k.c1) = o.sku);
        END IF;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        INSERT INTO analytics.kepler_ficha_history_errors (operacion, sqlstate, mensaje)
        VALUES (TG_OP, v_state, left(v_msg, 500));
      END;
      RETURN NULL;
    END $fn$`);

  for (const [sufijo, evento, refs] of TRIGGERS) {
    await knex.raw(`DROP TRIGGER IF EXISTS tg_kfh_${sufijo} ON kepler_ods.kdii`);
    await knex.raw(`CREATE TRIGGER tg_kfh_${sufijo} AFTER ${evento} ON kepler_ods.kdii
      ${refs} FOR EACH STATEMENT EXECUTE FUNCTION analytics.tg_kdii_ficha_history()`);
  }

  // Carga inicial DESPUÉS de los triggers (con el candado tomado nada cambia en medio). Sólo las
  // llaves que todavía no tienen historia: correrla dos veces no duplica.
  const r = await knex.raw(`
    INSERT INTO analytics.kepler_ficha_history (sucursal, sku, operacion, ${FICHA})
    SELECT f.sucursal, f.sku, 'inicial', f.u1, f.u2, f.f2, f.u3, f.f3, f.costo1, f.costo2, f.costo3
      FROM kepler_ods.kdii k CROSS JOIN LATERAL analytics.kdii_ficha(k) f
     WHERE f.sku <> ''
       AND NOT EXISTS (SELECT 1 FROM analytics.kepler_ficha_history h WHERE h.sucursal = f.sucursal AND h.sku = f.sku)`);
  console.log(`[PQ.59] carga inicial: ${r.rowCount} fichas`);

  // Cada versión con su vigencia. «hasta» abierto = la vigente.
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_kepler_ficha_vigencia AS
    SELECT h.tenant_id, h.sucursal, h.sku, h.operacion, h.u1, h.u2, h.f2, h.u3, h.f3,
           h.costo1, h.costo2, h.costo3,
           h.observado_at AS vigente_desde,
           lead(h.observado_at) OVER (PARTITION BY h.sucursal, h.sku ORDER BY h.observado_at, h.id) AS vigente_hasta,
           h.operacion = 'inicial' AS desde_es_la_migracion
      FROM analytics.kepler_ficha_history h`);

  await knex.raw(`GRANT SELECT ON analytics.kepler_ficha_history, analytics.kepler_ficha_history_errors,
                  analytics.v_kepler_ficha_vigencia TO app_runtime`);
  await knex.raw(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN
    GRANT SELECT ON analytics.kepler_ficha_history, analytics.v_kepler_ficha_vigencia TO dev_ro; END IF; END $$`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const hay = await knex.raw(`SELECT to_regclass('kepler_ods.kdii') AS kdii`);
  if (hay.rows[0].kdii) {
    for (const [sufijo] of TRIGGERS) await knex.raw(`DROP TRIGGER IF EXISTS tg_kfh_${sufijo} ON kepler_ods.kdii`);
  }
  await knex.raw('DROP VIEW IF EXISTS analytics.v_kepler_ficha_vigencia');
  await knex.raw('DROP FUNCTION IF EXISTS analytics.tg_kdii_ficha_history()');
  await knex.raw('DROP FUNCTION IF EXISTS analytics.kdii_ficha(kepler_ods.kdii)');
  await knex.raw('DROP TABLE IF EXISTS analytics.kepler_ficha_history_errors');
  await knex.raw('DROP TABLE IF EXISTS analytics.kepler_ficha_history');
};
