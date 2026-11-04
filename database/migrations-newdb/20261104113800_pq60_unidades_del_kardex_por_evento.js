'use strict';
/**
 * `[PQ.60]` — En qué unidad está la existencia de Kepler: por almacén × producto, las unidades del
 * kardex DESDE EL ÚLTIMO CONTEO. Se mantiene POR CAMBIO (trigger sobre `kepler_ods.kdij`).
 *
 * Por qué: la existencia de Kepler (`kdil`) es la suma CRUDA del kardex sin convertir rótulos
 * (ERP_KEPLER §3.x). Si desde el último ajuste por conteo entraron o salieron renglones en más de
 * una unidad, el número de Kepler mezcla cajas, paquetes y piezas como si fueran lo mismo, y
 * ninguna conversión lo arregla: sólo un conteo (`N-?-30`). Casos: 48067 ZUKO (sale en PZA y en
 * PAQ en la misma sucursal); 97392 BON-BON (entró 708 «CJA» y un N-A-30 sumó 16,992 PAQ).
 *
 * «Desde el último conteo, o desde el primer movimiento si nunca hubo» NO depende de la fecha de
 * hoy: por eso se puede mantener por evento sin ningún barrido periódico.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-04) ────────────────────────────────────────
 *  · Almacén principal × producto con existencia (365 d): 21,474 celdas en una sola unidad = la
 *    base de la ficha ($66.0 M) · 137 en una unidad distinta ($0.65 M) · **549 mezcladas, 315
 *    productos ($1.6 M)** · 31 sin movimientos (FASE_PQ §18.2).
 *  · `kdij`: PK (sucursal, c1, c2, c3, …); el peor producto tiene 9,453 renglones por almacén
 *    (recalcular una llave es un recorrido corto del índice). Conteos: N-A-30 18,127 · N-D-30 10,763.
 *
 * ── Qué crea ─────────────────────────────────────────────────────────────────────────────────
 *  · `analytics.kardex_unit_state`: una fila por (sucursal, almacén, c2, sku) con la fecha del
 *    último conteo, las unidades movidas desde entonces (sin contar el renglón del conteo), el neto
 *    por unidad y el último movimiento.
 *  · `analytics.kardex_unit_state_de(...)`: LA regla para una llave. La usan el trigger y la carga.
 *  · Triggers POR SENTENCIA sobre kdij (alta, cambio, baja, TRUNCATE): recalculan sólo las llaves
 *    que tocó la sentencia. Nunca frenan la ingesta: el error va a `kardex_unit_state_errors`.
 *
 * ⛔ FUERA DE HORARIO: crear los triggers toma un candado sobre kdij y la carga inicial recorre el
 *    kardex entero (805 MB) en la misma transacción; la ingesta de kdij espera esos segundos.
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
  ['trn', 'TRUNCATE', ''],
];

// El cálculo, sobre un conjunto de renglones de kdij `k` ya filtrado a las llaves que importan.
// Un conteo es un ajuste N-A-30 / N-D-30. Lo de después del conteo (en el mismo instante o
// más tarde) sin el propio renglón del conteo.
const ESTADO = (filtro) => `
  WITH k AS (
    SELECT k.sucursal, k.c1, k.c2, btrim(k.c3) AS sku, k.c10, upper(btrim(k.c12)) AS u,
           k.c11::numeric * CASE WHEN k.c30 = 'E' THEN 1 ELSE -1 END AS q,
           (k.c4 = 'N' AND k.c6 = 30) AS es_conteo
      FROM kepler_ods.kdij k
     WHERE ${filtro}),
  c AS (SELECT sucursal, c1, c2, sku, max(c10) FILTER (WHERE es_conteo) AS ultimo_conteo, max(c10) AS ultimo_mov
          FROM k GROUP BY 1, 2, 3, 4),
  d AS (SELECT k.sucursal, k.c1, k.c2, k.sku, k.u, sum(k.q) AS neto, count(*) AS n
          FROM k JOIN c USING (sucursal, c1, c2, sku)
         WHERE NOT k.es_conteo AND (c.ultimo_conteo IS NULL OR k.c10 >= c.ultimo_conteo)
         GROUP BY 1, 2, 3, 4, 5)
  SELECT c.sucursal, c.c1 AS almacen, c.c2, c.sku, c.ultimo_conteo, c.ultimo_mov,
         COALESCE(array_agg(d.u ORDER BY d.u) FILTER (WHERE d.u IS NOT NULL), '{}') AS unidades,
         COALESCE(jsonb_object_agg(COALESCE(d.u, '?'), d.neto) FILTER (WHERE d.n IS NOT NULL), '{}'::jsonb) AS netos,
         COALESCE(sum(d.n), 0)::int AS movimientos
    FROM c LEFT JOIN d USING (sucursal, c1, c2, sku)
   GROUP BY c.sucursal, c.c1, c.c2, c.sku, c.ultimo_conteo, c.ultimo_mov`;

const COLS = 'sucursal, almacen, c2, sku, ultimo_conteo, ultimo_mov, unidades, netos, movimientos';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const hay = await knex.raw(`SELECT to_regclass('kepler_ods.kdij') AS kdij`);
  if (!hay.rows[0].kdij) {
    console.log('[PQ.60] falta kepler_ods.kdij — se omite.');
    return;
  }

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS analytics.kardex_unit_state (
      tenant_id      uuid NOT NULL DEFAULT '${M}'::uuid,
      sucursal       text NOT NULL,
      almacen        text NOT NULL,
      c2             numeric NOT NULL,
      sku            text NOT NULL,
      ultimo_conteo  timestamp,
      ultimo_mov     timestamp,
      unidades       text[] NOT NULL DEFAULT '{}',
      netos          jsonb  NOT NULL DEFAULT '{}'::jsonb,
      movimientos    integer NOT NULL DEFAULT 0,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now(),
      created_by     uuid,
      updated_by     uuid,
      PRIMARY KEY (sucursal, almacen, c2, sku)
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_kus_sku ON analytics.kardex_unit_state (sku)`);
  await knex.raw(`COMMENT ON TABLE analytics.kardex_unit_state IS
    '[PQ.60] Unidades (kdij.c12) del kardex desde el último conteo N-?-30, por almacén × producto. Más de una unidad = la existencia de Kepler mezcla rótulos. Mantenida por trigger sobre kepler_ods.kdij.'`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS analytics.kardex_unit_state_errors (
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

  // LA regla para un conjunto de llaves (las que tocó una sentencia). Recalcula y reemplaza.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION analytics.kardex_unit_state_recalcular(p_llaves jsonb)
    RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
    DECLARE n integer;
    BEGIN
      -- Sin tabla temporal: en una función SECURITY DEFINER el pg_temp de quien escribe se
      -- buscaría ANTES que el esquema fijo. Las llaves se leen del JSON en cada sentencia.
      DELETE FROM analytics.kardex_unit_state e
       USING jsonb_to_recordset(p_llaves) AS l(s text, a text, c2 numeric, k text)
       WHERE e.sucursal = l.s AND e.almacen = l.a AND e.c2 = l.c2 AND e.sku = btrim(l.k);
      INSERT INTO analytics.kardex_unit_state (${COLS})
      ${ESTADO(`(k.sucursal, k.c1, k.c2, k.c3) IN (SELECT l.s, l.a, l.c2, l.k FROM jsonb_to_recordset(p_llaves) AS l(s text, a text, c2 numeric, k text))`)};
      GET DIAGNOSTICS n = ROW_COUNT;
      RETURN n;
    END $fn$`);

  // ── El trigger. Por SENTENCIA; cada operación con su sentencia (old_rows no existe en un alta).
  // ⛔ SECURITY DEFINER + search_path fijo (ADR-104).
  const llaves = (t) => `(SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object('s', r.sucursal, 'a', r.c1, 'c2', r.c2, 'k', r.c3)), '[]'::jsonb) FROM ${t} r)`;
  await knex.raw(`
    CREATE OR REPLACE FUNCTION analytics.tg_kdij_unit_state()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
    DECLARE v_state text; v_msg text;
    BEGIN
      BEGIN
        IF TG_OP = 'TRUNCATE' THEN
          DELETE FROM analytics.kardex_unit_state;
        ELSIF TG_OP = 'INSERT' THEN
          PERFORM analytics.kardex_unit_state_recalcular(${llaves('new_rows')});
        ELSIF TG_OP = 'DELETE' THEN
          PERFORM analytics.kardex_unit_state_recalcular(${llaves('old_rows')});
        ELSIF TG_OP = 'UPDATE' THEN
          PERFORM analytics.kardex_unit_state_recalcular(${llaves('new_rows')} || ${llaves('old_rows')});
        END IF;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        INSERT INTO analytics.kardex_unit_state_errors (operacion, sqlstate, mensaje)
        VALUES (TG_OP, v_state, left(v_msg, 500));
      END;
      RETURN NULL;
    END $fn$`);

  for (const [sufijo, evento, refs] of TRIGGERS) {
    await knex.raw(`DROP TRIGGER IF EXISTS tg_kus_${sufijo} ON kepler_ods.kdij`);
    await knex.raw(`CREATE TRIGGER tg_kus_${sufijo} AFTER ${evento} ON kepler_ods.kdij
      ${refs} FOR EACH STATEMENT EXECUTE FUNCTION analytics.tg_kdij_unit_state()`);
  }

  // Carga inicial DESPUÉS de los triggers (con el candado tomado nada cambia en medio).
  await knex.raw('DELETE FROM analytics.kardex_unit_state');
  const r = await knex.raw(`INSERT INTO analytics.kardex_unit_state (${COLS}) ${ESTADO('true')}`);
  const mez = await knex.raw(`SELECT count(*) AS n FROM analytics.kardex_unit_state WHERE cardinality(unidades) > 1`);
  console.log(`[PQ.60] carga inicial: ${r.rowCount} almacén×producto · ${mez.rows[0].n} con más de una unidad desde su último conteo`);

  await knex.raw(`GRANT SELECT ON analytics.kardex_unit_state, analytics.kardex_unit_state_errors TO app_runtime`);
  await knex.raw(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN
    GRANT SELECT ON analytics.kardex_unit_state TO dev_ro; END IF; END $$`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const hay = await knex.raw(`SELECT to_regclass('kepler_ods.kdij') AS kdij`);
  if (hay.rows[0].kdij) {
    for (const [sufijo] of TRIGGERS) await knex.raw(`DROP TRIGGER IF EXISTS tg_kus_${sufijo} ON kepler_ods.kdij`);
  }
  await knex.raw('DROP FUNCTION IF EXISTS analytics.tg_kdij_unit_state()');
  await knex.raw('DROP FUNCTION IF EXISTS analytics.kardex_unit_state_recalcular(jsonb)');
  await knex.raw('DROP TABLE IF EXISTS analytics.kardex_unit_state_errors');
  await knex.raw('DROP TABLE IF EXISTS analytics.kardex_unit_state');
};
