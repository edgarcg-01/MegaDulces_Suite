'use strict';
/**
 * [IC.4] analytics.v_count_priority_score — qué contar primero.
 *
 * Las CUATRO señales que pidió Edgar (decisión D2), combinadas en un score por
 * (almacén, producto). Alimenta el ritmo "por productos top".
 *
 *   1. CLASE ABC        — dónde está el dinero que rota (commercial.abc_classification)
 *   2. VENTA RECIENTE   — lo que se mueve hoy (analytics.inventory_health.avg_daily_units)
 *   3. INVENTARIO PARADO— dinero quieto: mucho on_hand y poca venta
 *   4. DESCUADRE HISTÓRICO — lo que siempre falla (IC.3, v_sku_count_variance_history)
 *
 * ── ⛔ EL PROBLEMA QUE DEFINE EL DISEÑO: la 4ª señal NO EXISTE en medio catálogo ────────
 *
 * `tasa_descuadre` es NULL donde hay menos de 2 conteos, y eso es la mitad de las filas: la
 * sucursal 02 tiene 7 conteos pero la 01 y la 06 tienen UNO, y la 07 y la 08 ninguno.
 *
 * Si la señal ausente se contara como CERO, los almacenes sin historia saldrían
 * sistemáticamente más abajo — y el top terminaría ignorando justo las plazas que nunca se
 * han contado, que son las que más lo necesitan. Es el "default plausible" otra vez, esta vez
 * disfrazado de score.
 *
 * Por eso el score se calcula como **promedio ponderado sobre las señales DISPONIBLES**, con
 * los pesos renormalizados fila por fila, y `senales_usadas` dice cuántas de las 4 entraron.
 * Un score de 3 señales y uno de 4 no son directamente comparables, y la columna obliga a
 * saberlo en vez de esconderlo detrás de un número único.
 *
 * ── Por qué percentiles y no valores crudos ────────────────────────────────────────────
 *
 * Las cuatro señales viven en escalas incomparables (una clase, unidades/día, pesos, una
 * proporción). Se normalizan a percentil DENTRO de cada almacén: así el score responde
 * "cuánto importa este SKU **en este almacén**", que es la pregunta de quien arma la ruta de
 * conteo, y no queda dominado por el almacén más grande.
 *
 * Los pesos son CONSTANTES VISIBLES, no magia: se leen en el SQL y se pueden discutir.
 */

const PESOS = { abc: 0.30, venta: 0.25, parado: 0.20, descuadre: 0.25 };

exports.up = async function up(knex) {
  const [{ hay }] = (await knex.raw(
    `SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'analytics') AS hay`)).rows;
  if (!hay) await knex.raw('CREATE SCHEMA analytics');

  const [{ ok }] = (await knex.raw(`
    SELECT (to_regclass('commercial.abc_classification') IS NOT NULL
        AND to_regclass('analytics.inventory_health') IS NOT NULL
        AND to_regclass('analytics.v_sku_count_variance_history') IS NOT NULL) AS ok`)).rows;
  if (!ok) {
    // eslint-disable-next-line no-console
    console.log('  faltan abc_classification / inventory_health / v_sku_count_variance_history — vista omitida');
    return;
  }

  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_count_priority_score
      WITH (security_invoker = true) AS
    WITH base AS (
      SELECT a.tenant_id, a.warehouse_id, a.product_id,
             a.abc_class,
             a.annual_value,
             ih.avg_daily_units,
             ih.on_hand,
             -- Dinero parado: lo que vale lo que hay, penalizado por lo poco que rota.
             -- Sin venta la cobertura es infinita, asi que se topa en 365 dias.
             (coalesce(ih.on_hand, 0) * coalesce(NULLIF(ih.avg_daily_units, 0), 0.0001))
               AS _unused,
             CASE WHEN coalesce(ih.avg_daily_units, 0) > 0
                  THEN LEAST(coalesce(ih.on_hand, 0) / ih.avg_daily_units, 365)
                  ELSE 365 END AS dias_cobertura,
             h.tasa_descuadre,
             h.veces_contado,
             h.pesos_abs AS descuadre_pesos
        FROM commercial.abc_classification a
        LEFT JOIN analytics.inventory_health ih
          ON ih.tenant_id = a.tenant_id AND ih.warehouse_id = a.warehouse_id
         AND ih.product_id = a.product_id
        LEFT JOIN analytics.v_sku_count_variance_history h
          ON h.tenant_id = a.tenant_id AND h.warehouse_id = a.warehouse_id
         AND h.product_id = a.product_id
    ),
    pct AS (
      -- Percentil DENTRO del almacén. percent_rank da 0..1 y no se rompe con outliers.
      SELECT b.*,
             percent_rank() OVER (PARTITION BY b.warehouse_id ORDER BY coalesce(b.annual_value, 0))
               AS p_abc_valor,
             percent_rank() OVER (PARTITION BY b.warehouse_id ORDER BY coalesce(b.avg_daily_units, 0))
               AS p_venta,
             percent_rank() OVER (PARTITION BY b.warehouse_id
               ORDER BY coalesce(b.on_hand, 0) * b.dias_cobertura) AS p_parado
        FROM base b
    )
    SELECT p.tenant_id, p.warehouse_id, p.product_id,
           p.abc_class, p.annual_value, p.avg_daily_units, p.on_hand,
           round(p.dias_cobertura, 1) AS dias_cobertura,
           p.tasa_descuadre, p.veces_contado, p.descuadre_pesos,

           -- Las cuatro señales, expuestas: un score que no deja ver sus componentes no se
           -- puede auditar, y nadie confía en lo que no puede revisar.
           round(p.p_abc_valor::numeric, 4)  AS s_abc,
           round(p.p_venta::numeric, 4)      AS s_venta,
           round(p.p_parado::numeric, 4)     AS s_parado,
           p.tasa_descuadre                  AS s_descuadre,

           -- Cuántas de las 4 entraron. El descuadre es la única que puede faltar hoy.
           (3 + (CASE WHEN p.tasa_descuadre IS NOT NULL THEN 1 ELSE 0 END))::int AS senales_usadas,

           -- ⛔ Promedio ponderado sobre las señales DISPONIBLES: los pesos se renormalizan
           -- fila por fila. Contar la señal ausente como 0 hundiría a los almacenes sin
           -- historia de conteo, que son justo los que más falta les hace.
           round((
             (${PESOS.abc}    * p.p_abc_valor
            + ${PESOS.venta}  * p.p_venta
            + ${PESOS.parado} * p.p_parado
            + CASE WHEN p.tasa_descuadre IS NOT NULL
                   THEN ${PESOS.descuadre} * p.tasa_descuadre ELSE 0 END)
             / (${PESOS.abc} + ${PESOS.venta} + ${PESOS.parado}
                + CASE WHEN p.tasa_descuadre IS NOT NULL THEN ${PESOS.descuadre} ELSE 0 END)
           )::numeric, 4) AS score,

           -- ⛔ Un score bajo por FALTA DE DATOS no es "baja prioridad": es "no se sabe".
           -- El CEDIS tiene 10,106 SKUs clasificados y casi ningun dato de venta ni de
           -- existencia, asi que sus tres senales dan ~0 y el score cae a 0.006. Publicarlo
           -- como prioridad baja seria decir que ese almacen no hace falta contarlo, cuando
           -- lo que pasa es que no hay con que juzgarlo -- y es el unico que NUNCA se conto.
           CASE
             WHEN coalesce(p.annual_value, 0) = 0
              AND coalesce(p.avg_daily_units, 0) = 0
              AND coalesce(p.on_hand, 0) = 0          THEN 'sin_datos'
             WHEN p.tasa_descuadre IS NULL            THEN 'sin_historia_de_conteo'
           END AS score_salvedad
      FROM pct p
  `);

  await knex.raw('GRANT SELECT ON analytics.v_count_priority_score TO app_runtime');

  await knex.raw(`COMMENT ON VIEW analytics.v_count_priority_score IS
    'IC.4 - Prioridad de conteo por (almacen, producto) con las 4 senales de la decision D2: clase ABC, venta reciente, inventario parado y descuadre historico. Cada senal se normaliza a PERCENTIL DENTRO DEL ALMACEN (escalas incomparables; y asi el score responde cuanto importa el SKU en SU almacen, no queda dominado por el almacen mas grande). El score es un promedio ponderado sobre las senales DISPONIBLES, con los pesos renormalizados fila por fila: la 4a senal es NULL donde hay menos de 2 conteos, que es la mitad del catalogo, y contarla como CERO hundiria a los almacenes sin historia -- justo los que mas falta les hace contar. senales_usadas dice cuantas entraron y score_salvedad marca las filas sin historia. Las 4 componentes se exponen: un score que no deja ver sus partes no se puede auditar.'`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_count_priority_score');
};
