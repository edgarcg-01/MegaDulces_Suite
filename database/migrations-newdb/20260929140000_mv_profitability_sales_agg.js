'use strict';
/**
 * `[MR.8.5b]` — **La ventana de 12 meses de `/comercial/rentabilidad` baja de ~2.2 s a ~200 ms.**
 *
 * ── Qué quedaba pendiente y por qué ─────────────────────────────────────────────────────────
 * `[MR.8.5]` bajó 30 d de 4,726 ms a ~432 ms y 90 d a ~727 ms materializando `v_erp_unit_cost` y
 * dejando de ejecutar el desglose tres veces. Pero **365 d quedó en ~2,253 ms**, y ahí el costo
 * ya no es el costo unitario sino el propio fact: agregar **2,808,558 filas** de
 * `analytics.mv_sales_blended` cuesta **2,044 ms**.
 *
 * ⛔ **Un índice NO lo arregla, y eso está medido.** El plan elige `ix_mv_sales_blended_channel`
 * en lugar del cubridor `ix_mv_sales_blended_cover2` porque ese `INCLUDE` no trae `unit_kind`, y
 * la consulta lo pide. Quitando esa columna, la misma consulta baja de **2,230 ms a 1,374 ms**:
 * arreglar el índice ganaría ~856 ms y **seguiría arriba del gate de 1 s**. Agregar 2.8 M filas
 * no baja del segundo por más índice que se le ponga. La única palanca es no agregarlas en vivo.
 *
 * ── ⭐ Por qué esto NO es «un segundo linaje del margen» ────────────────────────────────────
 * Ésa era la objeción que mantuvo este rollup fuera de `[MR.8.5]`, y se resuelve con aritmética,
 * no con confianza:
 *
 * El grano del rollup es `(producto × almacén × canal × unit_kind)` — **exactamente las mismas
 * dimensiones que el fact**, sólo sin el día. Y los cinco agregados que guarda son **aditivos**:
 * `SUM` de `SUM` es `SUM`, y los `FILTER (WHERE cost IS NOT NULL)` también suman. Así que
 * re-agregar el rollup a cualquier grano más grueso devuelve **el mismo número, al centavo**, que
 * agregar el fact. No es una aproximación ni un resumen: es la misma cuenta, hecha una vez.
 *
 * `MAX(unit_kind)` sigue funcionando porque `unit_kind` está EN el grano: el máximo sobre los
 * valores del grano es el mismo máximo.
 *
 * Y aun así **no se asume**: la compuerta 3 de abajo compara rollup contra fact vivo en las tres
 * ventanas y revienta si difieren más de un centavo.
 *
 * ── Lo que sí cambia, y hay que saberlo ─────────────────────────────────────────────────────
 * La **frescura**. El rollup es tan fresco como su último `REFRESH` (cada 15 min), mientras el
 * fact es de lectura directa. Para esta pantalla no mueve nada — `data_as_of` ya declara que la
 * venta llega hasta el último día CERRADO del fact, no hasta el minuto — pero es la diferencia
 * real y va escrita en el `COMMENT`.
 *
 * ⚠️ `CURRENT_DATE` dentro del cuerpo se evalúa **en el REFRESH**, no en la creación. Es lo que
 * hace que la ventana sea móvil, y también significa que si el refresco se cae un día, la ventana
 * queda anclada al día anterior. Lo vigila el carril `analytics_refresh` (warnH 1 / critH 3).
 *
 * ⛔ **Las ventanas viven en DOS lados** (acá y en `WINDOWS` del servicio). Si divergen, el
 * servicio **no da un número malo**: no encuentra fila para esa ventana y cae al fact en vivo —
 * degrada a lento, nunca a incorrecto. Está escrito así a propósito.
 *
 * Aditiva. No toca ningún objeto existente.
 *
 * @param { import("knex").Knex } knex
 */

/** Las ventanas que la pantalla ofrece. Espejo de `WINDOWS` en `commercial-profitability.service.ts`. */
const VENTANAS = [30, 90, 365];

const CUERPO = `
  SELECT v.dias::int                                            AS window_days,
         sd.tenant_id,
         sd.product_id,
         sd.warehouse_id,
         sd.channel,
         sd.unit_kind,
         SUM(sd.revenue)                                        AS revenue,
         -- La venta que SI trae costo: el denominador honesto del margen (ADR-051).
         SUM(sd.revenue) FILTER (WHERE sd.cost IS NOT NULL)     AS revenue_costed,
         SUM(sd.cost)                                           AS cost,
         SUM(sd.units)                                          AS units,
         SUM(sd.units)   FILTER (WHERE sd.cost IS NOT NULL)     AS units_costed
    FROM (VALUES ${VENTANAS.map((d) => `(${d})`).join(', ')}) v(dias)
    JOIN analytics.mv_sales_blended sd
      ON sd.sale_date >= CURRENT_DATE - v.dias
   GROUP BY 1, 2, 3, 4, 5, 6`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_profitability_sales_agg`);
  await knex.raw(`CREATE MATERIALIZED VIEW analytics.mv_profitability_sales_agg AS ${CUERPO} WITH DATA`);

  // UNIQUE -> habilita REFRESH CONCURRENTLY. Sin el, cada refresco deja la pantalla leyendo
  // vacio 15 veces por hora. Verificado en prod: las cuatro columnas del grano no tienen NULL
  // (0 de 2,808,558 filas a 365d), asi que el UNIQUE no deja pasar duplicados por NULL.
  await knex.raw(`
    CREATE UNIQUE INDEX ux_mv_profitability_sales_agg
        ON analytics.mv_profitability_sales_agg
           (window_days, tenant_id, product_id, warehouse_id, channel, unit_kind)`);
  // El camino caliente: la pantalla siempre entra por (ventana, tenant) y agrupa por producto.
  await knex.raw(`
    CREATE INDEX ix_mv_profitability_sales_agg_lectura
        ON analytics.mv_profitability_sales_agg (window_days, tenant_id, product_id)
     INCLUDE (warehouse_id, channel, unit_kind, revenue, revenue_costed, cost, units, units_costed)`);
  await knex.raw(`GRANT SELECT ON analytics.mv_profitability_sales_agg TO app_runtime`);

  // ── Compuertas ────────────────────────────────────────────────────────────────────────────
  const [{ filas }] = (
    await knex.raw(`SELECT COUNT(*)::int filas FROM analytics.mv_profitability_sales_agg`)
  ).rows;
  console.log(`  · [MR.8.5b] rollup poblado: ${filas} filas (se midieron ~215,588).`);

  // (1) NO puede nacer vacia. `mv_sales_blended` no tiene RLS, pero si alguna vez la gana, un
  //     rol sin BYPASSRLS dejaria esto en cero y el sensor lo veria "poblado y fresco".
  if (!(Number(filas) > 50000)) {
    throw new Error(
      `[MR.8.5b] el rollup quedo con ${filas} filas (se esperaban ~215,000). ` +
        'Si dio 0, el fact no devolvio nada al materializar — revisar RLS del rol que refresca.',
    );
  }

  // (2) y (3) PARIDAD CONTRA EL FACT VIVO, ventana por ventana. Esta es la compuerta que
  //     justifica que el rollup exista: si re-agregarlo no da el MISMO numero que agregar el
  //     fact, entonces si seria un segundo linaje y hay que tirarlo.
  for (const d of VENTANAS) {
    const [p] = (
      await knex.raw(
        `SELECT ROUND(ABS(r.rev - f.rev), 4) d_rev,
                ROUND(ABS(r.revc - f.revc), 4) d_revc,
                ROUND(ABS(r.cost - f.cost), 4) d_cost,
                r.rev::numeric AS rollup_rev
           FROM (SELECT COALESCE(SUM(revenue),0) rev, COALESCE(SUM(revenue_costed),0) revc,
                        COALESCE(SUM(cost),0) cost
                   FROM analytics.mv_profitability_sales_agg WHERE window_days = ?) r,
                (SELECT COALESCE(SUM(revenue),0) rev,
                        COALESCE(SUM(revenue) FILTER (WHERE cost IS NOT NULL),0) revc,
                        COALESCE(SUM(cost),0) cost
                   FROM analytics.mv_sales_blended
                  WHERE sale_date >= CURRENT_DATE - ?::int) f`,
        [d, d],
      )
    ).rows;
    const peor = Math.max(Number(p.d_rev), Number(p.d_revc), Number(p.d_cost));
    console.log(
      `  · [MR.8.5b] paridad ${d}d: venta $${Math.round(Number(p.rollup_rev)).toLocaleString('es-MX')} · ` +
        `peor delta ${peor}`,
    );
    if (!(peor <= 0.01)) {
      throw new Error(
        `[MR.8.5b] el rollup NO cuadra con el fact en ${d}d (delta ${peor}). ` +
          'Re-agregarlo tiene que dar el MISMO numero al centavo: si no, es un segundo linaje del margen.',
      );
    }
  }
  console.log('  ✓ [MR.8.5b] el rollup reproduce el fact al centavo en las 3 ventanas.');

  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_profitability_sales_agg IS
    $$[MR.8.5b] Pre-agregado de analytics.mv_sales_blended para /comercial/rentabilidad. NO es un
    segundo linaje: el grano son las MISMAS dimensiones del fact sin el dia, y los cinco agregados
    son aditivos (SUM de SUM es SUM; los FILTER tambien suman), asi que re-agregarlo a cualquier
    grano mas grueso devuelve el mismo numero AL CENTAVO. La migracion lo comprueba en las 3
    ventanas y revienta si difiere mas de un centavo.

    Existe porque agregar 2,808,558 filas del fact en vivo cuesta 2,044 ms y el gate es 1 s. Un
    indice no alcanza: medido, arreglar el INCLUDE de cover2 (le falta unit_kind) ganaria ~856 ms
    y seguiria arriba del segundo.

    LO QUE SI CAMBIA: la frescura. Esto es tan fresco como su ultimo REFRESH (15 min); el fact se
    lee directo. Para esta pantalla no mueve nada -- data_as_of ya declara que la venta llega al
    ultimo dia CERRADO -- pero es la diferencia real.

    ⚠️ CURRENT_DATE se evalua en el REFRESH, no al crear: por eso la ventana es movil, y por eso
    si el refresco se cae un dia la ventana queda anclada a ayer. Lo vigila analytics_refresh.

    ⛔ Las ventanas (30/90/365) viven aca y en WINDOWS del servicio. Si divergen, el servicio NO
    da un numero malo: no encuentra fila y cae al fact en vivo. Degrada a lento, nunca a falso.

    NO lleva security_invoker: es propiedad de vistas, no de matviews.$$`);

  console.log('  ✓ [MR.8.5b] el refresco va en el array de 15 min (carril analytics_refresh, ya con umbral).');
};

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_profitability_sales_agg`);
  console.log('  ✓ [MR.8.5b] down: rollup removido. El servicio cae solo al fact en vivo.');
};
