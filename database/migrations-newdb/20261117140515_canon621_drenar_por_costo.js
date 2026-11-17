'use strict';
/**
 * `[CANON.6.21]` Oleada 8b — **el que drena elige el recálculo completo cuando recalcular por llave cuesta MÁS que
 * él.** Hasta hoy decidía por el NÚMERO de SKUs (más de 800 → completo); el número no ve el costo.
 *
 * ── Lo medido antes (prod, sólo lectura, system_identifier 7688376744939610156, 2026-11-17) ──────────────────────
 *  · Encendido a las 13:28: en 25 min, corridas por llave de 3 a 160 SKUs, casi todas de 1 a 4 s, pero dos de 21 y
 *    33 s, MÁS que el completo (15–21 s). ~136 s de base, ~9 % de un núcleo, con `existencia-aux` todavía encima.
 *  · ⭐ El precio por llave cuesta según la historia de venta del SKU: la regla toma TODAS sus líneas de `kdm2` (no
 *    tiene fecha) y las cruza con `kdm1` para quedarse con 90 días. 34 SKUs medidos uno por uno:
 *      los 12 más vendidos (`lineas_pos` 4,600–6,800)   0.4–2.2 s cada uno
 *      8 de la posición ~200 (`lineas_pos` ~940)          80–190 ms
 *      8 de la posición ~1,500 (`lineas_pos` ~168)        17–41 ms
 *      sin ventas                                          ~12 ms
 *    → costo ≈ 12 ms + 0.1 ms por línea de `lineas_pos` (la suma de sus almacenes en `analytics.price_truth`), dentro
 *    de ~2× en los 34. Contar sus líneas en `kdm2` (índice `ix_kdm2_sku_venta`) costó hasta 1.5 s por SKU: tan caro
 *    como el trabajo que quería predecir. `price_truth` ya lo tiene y se lee por su índice de `sku`.
 *  · Lo fijo de una corrida (las otras tres tablas por llave, la toma de la cola, los DELETE): ~1 s (las corridas de
 *    3–6 SKUs tardaron 0.9–2.7 s).
 *
 * Lo que cambia, sólo en `analytics.drenar_existencia()`:
 *   · Entre el umbral y la corrida por llave, estima su costo: 1,000 ms + 12 ms por SKU + 0.1 ms por línea de
 *     `lineas_pos`. Si pasa lo que tardó el último recálculo completo (o 20 s si nunca hubo uno), recalcula TODO con
 *     motivo `costo`. Todo es correcto siempre: contiene a cualquier lista.
 *   · `analytics.existencia_corridas` gana `estimado_ms` y `referencia_ms`: cada corrida dice cuánto creyó que
 *     costaría y contra qué lo comparó. Es la calibración: la estimación se compara con `ms` en las de `cola`.
 *
 * El árbitro del sensor de Salud BD pasa a leer sólo el completo `primero_del_dia`: uno por `costo` o `marca_total`
 * cuenta también lo que estaba en la cola, que no es un hueco del evento.
 *
 * Sin candados sobre tablas de la ingesta. `ADD COLUMN` en `existencia_corridas` (sólo la escribe el que drena) sólo
 * si falta. Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
const { MAX_POR_LLAVE } = require('./20261114124213_canon621_price_truth_por_llave.js');

const INICIO_DEL_DIA = `(date_trunc('day', now() AT TIME ZONE 'America/Mexico_City') AT TIME ZONE 'America/Mexico_City')`;
/** El modelo de costo de una corrida por llave, en ms (medido arriba). */
const COSTO = { fijo: 1000, porSku: 12, porLinea: 0.1, sinReferencia: 20000 };

/**
 * `analytics.drenar_existencia()`. Con `porCosto = false` es LETRA POR LETRA la de 20261117094325 (el `down` la
 * restaura con esto y la prueba lo compara con `prosrc`); con `true`, la misma más la decisión por costo.
 */
function drenarSql(porCosto) {
  const declara = porCosto ? '\n            v_estimado integer; v_referencia integer;' : '';
  const decide = porCosto
    ? `
          -- ⭐ El costo, no el número: el precio por llave cuesta según la historia de venta de cada SKU (los más
          -- vendidos ~1 s, uno sin ventas ~12 ms). Si recalcular por llave cuesta más que todo, se recalcula todo.
          SELECT round(${COSTO.fijo} + ${COSTO.porSku} * cardinality(v_skus) + ${COSTO.porLinea} * COALESCE(sum(p.lineas_pos), 0))::integer
            INTO v_estimado FROM analytics.price_truth p WHERE p.sku = ANY (v_skus);
          SELECT c.ms INTO v_referencia FROM analytics.existencia_corridas c
           WHERE c.modo = 'completo' AND c.ms IS NOT NULL ORDER BY c.id DESC LIMIT 1;
          v_referencia := COALESCE(v_referencia, ${COSTO.sinReferencia});
          v_motivo := CASE WHEN v_estimado > v_referencia THEN 'costo' ELSE 'cola' END;`
    : `
          v_motivo := 'cola';`;
  const columnas = porCosto ? ', estimado_ms, referencia_ms' : '';
  const valores = porCosto ? ', v_estimado, v_referencia' : '';
  return `
    CREATE OR REPLACE FUNCTION analytics.drenar_existencia()
    RETURNS TABLE (modo text, motivo text, marcas integer, llaves integer, objeto text, insertadas integer,
                   actualizadas integer, borradas integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    SET jit = off
    AS $fn$
    #variable_conflict use_column
    DECLARE v_t0 timestamptz := clock_timestamp(); v_hasta bigint; v_marcas integer := 0; v_todo boolean := false;
            v_skus text[]; v_modo text; v_motivo text; v_res jsonb := '[]'::jsonb; r record; v_state text; v_msg text;${declara}
    BEGIN
      -- Uno a la vez; si otro ya recalcula, no se espera: lo que quede en la cola lo toma la siguiente corrida.
      IF NOT pg_try_advisory_xact_lock(hashtext('analytics.recalcular_existencia')) THEN
        modo := 'ocupado'; RETURN NEXT; RETURN;
      END IF;
      BEGIN
        -- Hasta el último id visible. Lo que se confirme después (aunque tenga un id menor) se queda para la siguiente.
        SELECT max(s.id) INTO v_hasta FROM analytics.llaves_sucias s;
        WITH t AS (DELETE FROM analytics.llaves_sucias s WHERE s.id <= v_hasta RETURNING s.sku)
        SELECT count(*)::integer, COALESCE(bool_or(t.sku = '*'), false), array_agg(DISTINCT t.sku) FILTER (WHERE t.sku <> '*')
          INTO v_marcas, v_todo, v_skus FROM t;
        IF v_todo THEN
          v_motivo := 'marca_total';
        ELSIF NOT EXISTS (SELECT 1 FROM analytics.existencia_corridas c
                           WHERE c.modo = 'completo' AND c.created_at >= ${INICIO_DEL_DIA}) THEN
          v_motivo := 'primero_del_dia';
        ELSIF v_marcas = 0 THEN
          modo := 'vacio'; RETURN NEXT; RETURN;
        ELSIF cardinality(v_skus) > ${MAX_POR_LLAVE} THEN
          v_motivo := 'umbral';
        ELSE${decide}
        END IF;
        v_modo := CASE WHEN v_motivo = 'cola' THEN 'llave' ELSE 'completo' END;
        FOR r IN SELECT * FROM analytics.recalcular_existencia(CASE WHEN v_modo = 'llave' THEN v_skus END) LOOP
          v_res := v_res || jsonb_build_object('objeto', r.objeto, 'insertadas', r.insertadas,
                                               'actualizadas', r.actualizadas, 'borradas', r.borradas);
          modo := v_modo; motivo := v_motivo; marcas := v_marcas; llaves := COALESCE(cardinality(v_skus), 0);
          objeto := r.objeto; insertadas := r.insertadas; actualizadas := r.actualizadas; borradas := r.borradas;
          RETURN NEXT;
        END LOOP;
        INSERT INTO analytics.existencia_corridas (modo, motivo, marcas, llaves, resultado, ms${columnas})
        VALUES (v_modo, v_motivo, v_marcas, COALESCE(cardinality(v_skus), 0), v_res,
                (extract(epoch FROM clock_timestamp() - v_t0) * 1000)::integer${valores});
      EXCEPTION WHEN OTHERS THEN
        -- Se deshace la toma de la cola (las marcas siguen ahí) y la falla queda escrita.
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        INSERT INTO analytics.existencia_corridas (modo, motivo, marcas, llaves, mensaje, ms)
        VALUES ('error', v_motivo, v_marcas, COALESCE(cardinality(v_skus), 0), v_state || ' ' || left(v_msg, 500),
                (extract(epoch FROM clock_timestamp() - v_t0) * 1000)::integer);
        modo := 'error'; motivo := v_motivo; marcas := v_marcas; llaves := COALESCE(cardinality(v_skus), 0);
        objeto := NULL; insertadas := NULL; actualizadas := NULL; borradas := NULL;
        RETURN NEXT;
      END;
    END
    $fn$`;
}

const COMENTARIO_ANTERIOR = `'[CANON.6.21] Toma la cola analytics.llaves_sucias, quita repetidos y llama a recalcular_existencia: por llave, o '
    'todo si hay ''*'', si pasan del umbral o si es la primera corrida del día (hora de México). ocupado = otro recalcula; '
    'vacio = nada que hacer; error = la cola quedó intacta y la falla está en analytics.existencia_corridas.'`;
const COMENTARIO = `'[CANON.6.21] Toma la cola analytics.llaves_sucias, quita repetidos y llama a recalcular_existencia: por llave, o '
    'todo si hay ''*'', si pasan del umbral, si recalcular por llave costaría más que el último completo (motivo costo: '
    '${COSTO.fijo} ms + ${COSTO.porSku} ms por SKU + ${COSTO.porLinea} ms por línea de price_truth.lineas_pos) o si es la primera corrida '
    'del día (hora de México). ocupado = otro recalcula; vacio = nada que hacer; error = la cola quedó intacta y la falla '
    'está en analytics.existencia_corridas.'`;
const COLUMNAS = [
  ['estimado_ms', 'lo que el que drena estimó que costaría recalcular por llave (corridas de cola o costo)'],
  ['referencia_ms', 'contra qué lo comparó: lo que tardó el último recálculo completo'],
];

async function hayColumna(knex, col) {
  const { rows } = await knex.raw(`SELECT 1 FROM pg_attribute WHERE attrelid = 'analytics.existencia_corridas'::regclass
    AND attname = '${col}' AND NOT attisdropped`);
  return rows.length > 0;
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows: [f] } = await knex.raw(`SELECT to_regprocedure('analytics.drenar_existencia()') IS NOT NULL AS hay`);
  if (!f.hay) throw new Error('[CANON.6.21] falta analytics.drenar_existencia(): primero la migración 20261117094325');
  for (const [col, que] of COLUMNAS) {
    if (!(await hayColumna(knex, col))) await knex.raw(`ALTER TABLE analytics.existencia_corridas ADD COLUMN ${col} integer`);
    await knex.raw(`COMMENT ON COLUMN analytics.existencia_corridas.${col} IS '[CANON.6.21] ${que}'`);
  }
  // CREATE OR REPLACE conserva dueño y permisos (EXECUTE de app_runtime): no hace falta volver a darlos.
  await knex.raw(drenarSql(true));
  await knex.raw(`COMMENT ON FUNCTION analytics.drenar_existencia() IS
    ${COMENTARIO}`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: la función de 20261117094325 letra por letra y sin las dos columnas. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(drenarSql(false));
  await knex.raw(`COMMENT ON FUNCTION analytics.drenar_existencia() IS
    ${COMENTARIO_ANTERIOR}`);
  for (const [col] of COLUMNAS) {
    if (await hayColumna(knex, col)) await knex.raw(`ALTER TABLE analytics.existencia_corridas DROP COLUMN ${col}`);
  }
};

exports.drenarSql = drenarSql;
exports.COSTO = COSTO;
