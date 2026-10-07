/**
 * KE.4b — LA CLASE "C" TIENE QUE DECIR POR QUÉ ES C.
 *
 * En `analytics.v_abc_class` (KE.4) hay tres maneras distintas de terminar en clase **C**, y las
 * tres se veían iguales:
 *
 *   1. **`pareto`** — la legítima: el SKU mueve poco valor contra sus pares del mismo almacén.
 *   2. **`sin_demanda`** — el almacén no registra venta. Es el caso del **CEDIS `00`**, que no
 *      vende: **distribuye por traspaso**, y su reorden lo planea `import-network-reorder.js` con
 *      demanda dependiente. Sus **10,073 filas** salen C por construcción, no por bajo valor.
 *      Y también es el caso transitorio de la sucursal **`07`**, recién cableada: su venta ya
 *      existe pero `inventory_health` todavía trae 0 en sus 2,617 filas.
 *   3. **`sin_costo`** — hay demanda pero ningún ERP ni el catálogo dan costo, así que
 *      `annual_value` cae a 0 por ausencia. Medido: **167 filas**.
 *
 * Importa porque la clase no es decorativa: fija el **nivel de servicio** del reabasto y la
 * **cadencia del conteo cíclico** (A=30 d · B=90 d · C=365 d). Un CEDIS marcado C por no vender
 * se contaría una vez al año, y es el almacén con más capital de la red.
 *
 * ⚠️ `abc_class` sigue siendo `'C'` — los consumidores necesitan un valor y `abc_classification`
 * lo tiene `NOT NULL`. Lo que cambia es que **al lado viaja el motivo**, que es la regla de
 * ADR-056: el número se queda, la razón lo acompaña.
 *
 * ⚠️ Esta vista se re-crea entera porque `CREATE OR REPLACE VIEW` no admite insertar una columna
 * en medio, y hay que re-aplicar `security_invoker` y el `GRANT` (lección U.7).
 *
 * @param { import("knex").Knex } knex
 */

const SQL = `
CREATE OR REPLACE VIEW analytics.v_abc_class AS
WITH base AS (
  SELECT ih.tenant_id, ih.warehouse_id, ih.product_id,
         ih.avg_daily_units,
         (ih.avg_daily_units * 365 * COALESCE(uc.costo_unitario, 0))::numeric(16,2) AS annual_value,
         COALESCE(uc.costo_source, 'sin_costo')                                     AS costo_source,
         (uc.tiene_testigo IS TRUE)                                                 AS tiene_testigo
    FROM analytics.inventory_health ih
    LEFT JOIN analytics.v_erp_unit_cost uc
           ON uc.tenant_id = ih.tenant_id AND uc.warehouse_id = ih.warehouse_id
          AND uc.product_id = ih.product_id
), ranked AS (
  SELECT base.*,
         SUM(annual_value) OVER (PARTITION BY tenant_id, warehouse_id
                                 ORDER BY annual_value DESC, product_id
                                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum_value,
         NULLIF(SUM(annual_value) OVER (PARTITION BY tenant_id, warehouse_id), 0)  AS total_value,
         -- Demanda del ALMACEN entero: distingue "este SKU no mueve" de "este almacen no vende".
         SUM(avg_daily_units) OVER (PARTITION BY tenant_id, warehouse_id)          AS adu_almacen
    FROM base
)
SELECT tenant_id, warehouse_id, product_id,
       CASE WHEN total_value IS NULL                                  THEN 'C'
            WHEN (cum_value - annual_value) / total_value < 0.80       THEN 'A'
            WHEN (cum_value - annual_value) / total_value < 0.95       THEN 'B'
            ELSE 'C' END                                            AS abc_class,
       -- POR QUE cayo ahi. Sin esto, las tres C se leen igual y la del CEDIS -- que es el almacen
       -- con mas capital de la red -- manda su conteo ciclico a una vez al ano.
       CASE WHEN COALESCE(adu_almacen, 0) <= 0                        THEN 'sin_demanda'
            WHEN avg_daily_units > 0 AND COALESCE(annual_value, 0) = 0 THEN 'sin_costo'
            ELSE 'pareto' END                                       AS clase_motivo,
       annual_value,
       avg_daily_units,
       CASE WHEN total_value IS NULL THEN 1.0
            ELSE round(cum_value / total_value, 4) END              AS value_share,
       costo_source,
       tiene_testigo
  FROM ranked`;

exports.up = async function up(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_abc_class`);
  await knex.raw(SQL);
  await knex.raw(`ALTER VIEW analytics.v_abc_class SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_abc_class TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW analytics.v_abc_class IS
    'KE.4: la clase ABC DERIVADA (Pareto por almacen sobre inventory_health.avg_daily_units x v_erp_unit_cost.costo_unitario). Es vista y no tabla porque como tabla llegaba TARDE: el reorden la consumia 26 minutos antes de que se recalculara, todos los dias. KE.4b: clase_motivo distingue las TRES maneras de terminar en C -- pareto (legitima), sin_demanda (el CEDIS no vende, distribuye por traspaso) y sin_costo. UNICA definicion: commercial.abc_classification se puebla desde aca y import-computed-reorder.js la lee directo.'`);

  const meta = await knex.raw(
    `SELECT c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'analytics' AND c.relname = 'v_abc_class'`);
  const opts = (meta.rows[0] || {}).reloptions || [];
  if (!opts.some((x) => String(x).includes('security_invoker'))) {
    throw new Error('v_abc_class perdió security_invoker');
  }

  const d = (await knex.raw(`
    SELECT count(*)::int total,
           count(*) FILTER (WHERE abc_class = 'A')::int a,
           count(*) FILTER (WHERE abc_class = 'B')::int b,
           count(*) FILTER (WHERE clase_motivo = 'sin_demanda')::int sin_dem,
           count(*) FILTER (WHERE clase_motivo = 'sin_costo')::int sin_costo,
           count(*) FILTER (WHERE clase_motivo = 'pareto')::int pareto,
           count(*) FILTER (WHERE abc_class <> 'C' AND clase_motivo <> 'pareto')::int incoherente
      FROM analytics.v_abc_class`)).rows[0];

  // Un motivo distinto de `pareto` sólo puede terminar en C: si un `sin_demanda` saliera A, el
  // Pareto estaría ordenando sobre ceros.
  if (d.incoherente > 0) {
    throw new Error(`${d.incoherente} filas no son C y su motivo no es pareto: el Pareto ordena sobre ceros`);
  }
  if (d.b < 1 || d.a < 1) throw new Error('clase A o B en cero: la fuente de demanda está vacía');
  // Y el caso que esta migración existe para nombrar TIENE que aparecer — si no, es decorativa.
  if (d.sin_dem < 1) {
    throw new Error('ninguna fila sale `sin_demanda`: el CEDIS debería, y si no, el motivo no está midiendo');
  }
  console.log(`  [abc-motivo] pareto ${d.pareto.toLocaleString('en-US')}`
    + ` · sin_demanda ${d.sin_dem.toLocaleString('en-US')}`
    + ` · sin_costo ${d.sin_costo.toLocaleString('en-US')}`
    + ` (A ${d.a.toLocaleString('en-US')} · B ${d.b.toLocaleString('en-US')})`);
};

exports.down = async function down(knex) {
  // No se revierte a la versión sin motivo: seria volver a que las tres C se lean igual.
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_abc_class`);
};
