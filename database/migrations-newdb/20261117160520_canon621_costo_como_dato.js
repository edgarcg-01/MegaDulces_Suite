'use strict';
/**
 * `[CANON.6.21]` Oleada 8b — **el modelo de costo del que drena pasa a ser DATO, calibrado con prod.**
 *
 * 20261117140515 decidió «completo por costo» con constantes escritas en la función (1,000 ms + 12 ms por SKU + 0.1 ms
 * por línea de `price_truth.lineas_pos`), sacadas de medir SKUs uno por uno.
 *
 * ── Lo medido después (prod, sólo lectura, system_identifier 7688376744939610156, 2026-11-17) ──────────────────────
 *  · En sus primeras 30 corridas por llave, el estimado contra lo real tuvo mediana de 1.8×: SOBREESTIMA. Medidos uno
 *    por uno, los SKUs no comparten el trabajo que sí comparten en un lote.
 *  · Ajuste de mínimos cuadrados con esas 30 (ms contra SKUs y líneas): 335 ms + 40 ms por SKU + 0.027 ms por línea,
 *    r² 0.54 (la carga de `md`, 10 sobre 8 núcleos, mete ruido: real/predicho p10 0.54, p50 0.91, p90 2.06).
 *  · Con el modelo viejo, 4 de las primeras 13 corridas con espera de 2 min se fueron a completo (13–18 s) cuando por
 *    llave habrían costado más o menos la mitad.
 *
 * Lo que cambia:
 *   · `analytics.existencia_costo`: UN renglón con las cuatro constantes (fijo, por SKU, por línea, y la referencia
 *     cuando nunca hubo un completo), sembrado con el ajuste de arriba. Recalibrar es un UPDATE, no una migración:
 *     la corrida guarda `estimado_ms` junto a `ms` para eso.
 *   · `drenar_existencia()` lee ese renglón. Sin renglón usa los mismos valores sembrados: la falta de calibración
 *     nunca hace fallar al que drena (fallar deja la cola intacta, y la cola atorada pone el sensor en crítico).
 *
 * ⭐ Tabla NUEVA y no columnas en `analytics.existencia_por_evento`: ésa la leen los disparadores en CADA escritura de
 *    la ingesta, y un ALTER sobre ella esperaría a las transacciones de la ingesta y frenaría las siguientes. Aquí no se
 *    toma candado sobre nada que ya exista; reemplazar la función no toca tablas. Puede ir en horario.
 *
 * El resto de la función es LETRA POR LETRA el de 20261117140515 (se arma reemplazando sólo la estimación sobre el
 * texto de aquélla). El `down()` la regresa tal cual y quita la tabla. Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
const ANTERIOR = require('./20261117140515_canon621_drenar_por_costo.js');

const M = '00000000-0000-0000-0000-00000000d01c';
/** El ajuste con 30 corridas de prod; también es lo que usa la función si no hay renglón. */
const CALIBRADO = { fijo: 335, porSku: 40, porLinea: 0.027, sinReferencia: 20000 };
const C = ANTERIOR.COSTO;

const uno = (t, a, b) => {
  const n = t.split(a).length - 1;
  if (n !== 1) throw new Error(`[CANON.6.21] la función de 20261117140515 nombra ${n} veces «${a.slice(0, 60)}…» (se esperaba 1)`);
  return t.replace(a, b);
};

/** La función de 20261117140515 con la estimación leída del renglón. */
function drenarConDato() {
  let f = ANTERIOR.drenarSql(true);
  f = uno(f, '\n            v_estimado integer; v_referencia integer;',
    '\n            v_estimado integer; v_referencia integer; v_fijo numeric; v_por_sku numeric; v_por_linea numeric; v_sin_ref numeric;');
  f = uno(f, `          SELECT round(${C.fijo} + ${C.porSku} * cardinality(v_skus) + ${C.porLinea} * COALESCE(sum(p.lineas_pos), 0))::integer
            INTO v_estimado FROM analytics.price_truth p WHERE p.sku = ANY (v_skus);`,
  `          -- Las constantes son DATO (analytics.existencia_costo, migración 20261117160520): se recalibran con un UPDATE.
          SELECT k.fijo_ms, k.por_sku_ms, k.por_linea_ms, k.sin_referencia_ms INTO v_fijo, v_por_sku, v_por_linea, v_sin_ref
            FROM analytics.existencia_costo k ORDER BY k.tenant_id LIMIT 1;
          SELECT round(COALESCE(v_fijo, ${CALIBRADO.fijo}) + COALESCE(v_por_sku, ${CALIBRADO.porSku}) * cardinality(v_skus)
                       + COALESCE(v_por_linea, ${CALIBRADO.porLinea}) * COALESCE(sum(p.lineas_pos), 0))::integer
            INTO v_estimado FROM analytics.price_truth p WHERE p.sku = ANY (v_skus);`);
  f = uno(f, `v_referencia := COALESCE(v_referencia, ${C.sinReferencia});`,
    `v_referencia := COALESCE(v_referencia, round(COALESCE(v_sin_ref, ${CALIBRADO.sinReferencia}))::integer);`);
  return f;
}

const COMENTARIO_ANTERIOR = `'[CANON.6.21] Toma la cola analytics.llaves_sucias, quita repetidos y llama a recalcular_existencia: por llave, o '
    'todo si hay ''*'', si pasan del umbral, si recalcular por llave costaría más que el último completo (motivo costo: '
    '${C.fijo} ms + ${C.porSku} ms por SKU + ${C.porLinea} ms por línea de price_truth.lineas_pos) o si es la primera corrida '
    'del día (hora de México). ocupado = otro recalcula; vacio = nada que hacer; error = la cola quedó intacta y la falla '
    'está en analytics.existencia_corridas.'`;
const COMENTARIO = `'[CANON.6.21] Toma la cola analytics.llaves_sucias, quita repetidos y llama a recalcular_existencia: por llave, o '
    'todo si hay ''*'', si pasan del umbral, si recalcular por llave costaría más que el último completo (motivo costo; el '
    'modelo es DATO en analytics.existencia_costo) o si es la primera corrida del día (hora de México). ocupado = otro '
    'recalcula; vacio = nada que hacer; error = la cola quedó intacta y la falla está en analytics.existencia_corridas.'`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows: [f] } = await knex.raw(`SELECT to_regprocedure('analytics.drenar_existencia()') IS NOT NULL AS hay`);
  if (!f.hay) throw new Error('[CANON.6.21] falta analytics.drenar_existencia(): primero 20261117094325 y 20261117140515');
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS analytics.existencia_costo (
      tenant_id          uuid PRIMARY KEY DEFAULT '${M}'::uuid,
      fijo_ms            numeric NOT NULL CHECK (fijo_ms >= 0),
      por_sku_ms         numeric NOT NULL CHECK (por_sku_ms >= 0),
      por_linea_ms       numeric NOT NULL CHECK (por_linea_ms >= 0),
      sin_referencia_ms  numeric NOT NULL CHECK (sin_referencia_ms > 0),
      nota               text,
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now(),
      updated_by         text
    )`);
  await knex.raw(`COMMENT ON TABLE analytics.existencia_costo IS
    '[CANON.6.21] El modelo con que analytics.drenar_existencia estima lo que costaría una corrida por llave: fijo + por '
    'SKU × SKUs + por línea × suma de price_truth.lineas_pos. Si pasa lo que tardó el último completo, recalcula todo '
    '(motivo costo). Se recalibra con un UPDATE comparando estimado_ms con ms en analytics.existencia_corridas. Sin renglón, '
    'la función usa los valores sembrados por 20261117160520.'`);
  await knex.raw(`INSERT INTO analytics.existencia_costo (tenant_id, fijo_ms, por_sku_ms, por_linea_ms, sin_referencia_ms, nota, updated_by)
    VALUES ('${M}', ${CALIBRADO.fijo}, ${CALIBRADO.porSku}, ${CALIBRADO.porLinea}, ${CALIBRADO.sinReferencia},
      'Calibrado el 2026-11-17 con 30 corridas por llave de prod (mínimos cuadrados, r² 0.54): ms ≈ 335 + 40 por SKU + 0.027 por línea. El modelo anterior sobreestimaba 1.8×.',
      'migración 20261117160520')
    ON CONFLICT (tenant_id) DO NOTHING`);
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN GRANT SELECT ON analytics.existencia_costo TO app_runtime; END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN GRANT SELECT ON analytics.existencia_costo TO dev_ro; END IF;
    END $$`);
  // CREATE OR REPLACE conserva dueño y permisos (EXECUTE de app_runtime).
  await knex.raw(drenarConDato());
  await knex.raw(`COMMENT ON FUNCTION analytics.drenar_existencia() IS
    ${COMENTARIO}`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: la función y el comentario de 20261117140515 letra por letra, sin la tabla. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(ANTERIOR.drenarSql(true));
  await knex.raw(`COMMENT ON FUNCTION analytics.drenar_existencia() IS
    ${COMENTARIO_ANTERIOR}`);
  await knex.raw(`DROP TABLE IF EXISTS analytics.existencia_costo`);
};

exports.CALIBRADO = CALIBRADO;
exports.drenarConDato = drenarConDato;
