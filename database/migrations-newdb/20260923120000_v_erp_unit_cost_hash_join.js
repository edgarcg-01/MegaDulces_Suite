/**
 * [PERF.1] `analytics.v_erp_unit_cost` tardaba 42 s. Ahora tarda 1.5 s. Mismo número.
 *
 * ── Qué estaba pasando, medido en PROD el 2026-09-23 ─────────────────────────
 * La vista une *todos* los almacenes con *todos* los productos (16 x 11,343 =
 * 180,176 filas) porque su contrato es "preguntame por cualquier par y te doy un
 * costo". Eso es intencional y NO cambia acá.
 *
 * Lo que sí era un defecto: sobre ese cartesiano el planificador elegía un
 * MERGE JOIN por almacén y degradaba la igualdad de producto a filtro:
 *
 *     Merge Left Join   (actual time=292.639..42085.015 rows=180176)
 *       Merge Cond: (w.id = kc.warehouse_id)
 *       Join Filter: ((w.kepler_code IS NOT NULL) AND (kc.product_id = p.id))
 *       Rows Removed by Join Filter: 314,232,820          <-- 314 MILLONES
 *
 * Lo elegía porque estimaba 11,343 filas donde había 180,176 (16x corto): con esa
 * estimación el merge parece barato. Las dos fuentes de costo son VISTAS, así que
 * el planificador no tiene estadísticas de ellas y se equivoca para el lado caro.
 *
 * ── El arreglo ───────────────────────────────────────────────────────────────
 * Las dos fuentes pasan a CTEs MATERIALIZED. Eso las obliga a ejecutarse UNA vez,
 * con su cardinalidad real ya conocida (Kepler: 27,907 filas en 250 ms), y el
 * planificador arma una tabla hash en vez de mergear y filtrar 314 M de veces.
 *
 * NO cambia ni una columna de la lista de selección ni un predicado de negocio.
 * El único movimiento es que "wv.costo_promedio > 0" pasa del ON al WHERE de su
 * CTE: en un LEFT JOIN, filtrar el lado derecho antes de unir es equivalente.
 *
 * ── Verificado contra PROD ANTES de escribir esto ────────────────────────────
 *     filas        180,176  ==  180,176
 *     suma      9,065,650.8020  ==  9,065,650.8020    (costo_unitario)
 *     con costo    154,044  ==  154,044
 *     tiempo     42,670 ms  ->  1,539 ms               (27x)
 *
 * La consulta de /comercial/rentabilidad que disparó esto gastaba 44,330 ms, de
 * los cuales 44,026 eran esta vista y 380 ms TODO lo demás (ventas, marcas,
 * promociones, factor de caja).
 *
 * ── Alcance ──────────────────────────────────────────────────────────────────
 * La vista la leen rentabilidad, inventario, conteos, BI de almacén, analytics y
 * la vista analytics.v_abc_class. Todos se benefician sin tocar una línea de TS.
 *
 * ⚠️ Al recrear una vista hay que RE-APLICAR security_invoker y el GRANT: no se
 * heredan, y una migración de la Fase U ya los perdió en silencio. Por eso van
 * explícitos abajo, con aserción que rompe si se pierden.
 */

const SELECT_LIST = `
    w.tenant_id,
    w.id AS warehouse_id,
    w.code AS warehouse_code,
    CASE WHEN w.kepler_code IS NOT NULL THEN 'kepler'::text ELSE 'wincaja'::text END AS erp,
    p.id AS product_id,
    p.sku,
    CASE WHEN w.kepler_code IS NOT NULL THEN kc.costo_unitario ELSE wv.costo_promedio END AS costo_erp,
    p.cost_base AS costo_catalogo,
    NULLIF(
      CASE WHEN COALESCE(p.cost_with_tax, 0::numeric) > 0::numeric AND p.cost_with_tax < p.cost_base
           THEN p.cost_with_tax ELSE p.cost_base END, 0::numeric) AS costo_catalogo_ciego,
    COALESCE(
      CASE WHEN w.kepler_code IS NOT NULL THEN kc.costo_unitario ELSE wv.costo_promedio END,
      NULLIF(
        CASE WHEN COALESCE(p.cost_with_tax, 0::numeric) > 0::numeric AND p.cost_with_tax < p.cost_base
             THEN p.cost_with_tax ELSE p.cost_base END, 0::numeric)) AS costo_unitario,
    CASE
      WHEN w.kepler_code IS NOT NULL AND kc.costo_unitario > 0::numeric THEN 'kepler_kdik'::text
      WHEN w.kepler_code IS NULL AND wv.costo_promedio > 0::numeric THEN 'wincaja_costo_promedio'::text
      WHEN COALESCE(p.cost_with_tax, 0::numeric) > 0::numeric AND p.cost_with_tax < p.cost_base
        THEN 'catalogo_columnas_invertidas'::text
      WHEN COALESCE(p.cost_base, 0::numeric) > 0::numeric THEN 'catalogo_neto'::text
      ELSE 'sin_costo'::text
    END AS costo_source,
    CASE WHEN w.kepler_code IS NOT NULL THEN kc.costo_unitario ELSE wv.costo_promedio END > 0::numeric
      AS tiene_testigo,
    CASE
      WHEN COALESCE(p.cost_base, 0::numeric) > 0::numeric
       AND COALESCE(CASE WHEN w.kepler_code IS NOT NULL THEN kc.costo_unitario ELSE wv.costo_promedio END,
                    0::numeric) > 0::numeric
      THEN round(p.cost_base /
             CASE WHEN w.kepler_code IS NOT NULL THEN kc.costo_unitario ELSE wv.costo_promedio END, 4)
      ELSE NULL::numeric
    END AS razon,
    CASE
      WHEN COALESCE(CASE WHEN w.kepler_code IS NOT NULL THEN kc.costo_unitario ELSE wv.costo_promedio END,
                    0::numeric) <= 0::numeric THEN 'sin_testigo'::text
      WHEN COALESCE(p.cost_base, 0::numeric) <= 0::numeric THEN 'sin_costo_catalogo'::text
      WHEN abs(p.cost_base /
             CASE WHEN w.kepler_code IS NOT NULL THEN kc.costo_unitario ELSE wv.costo_promedio END
             - 1::numeric) <= 0.02 THEN 'confirmado'::text
      WHEN (p.cost_base /
             CASE WHEN w.kepler_code IS NOT NULL THEN kc.costo_unitario ELSE wv.costo_promedio END)
             >= 1.5 THEN 'contradicho_por_factor'::text
      WHEN (p.cost_base /
             CASE WHEN w.kepler_code IS NOT NULL THEN kc.costo_unitario ELSE wv.costo_promedio END)
             <= 0.667 THEN 'contradicho_por_factor'::text
      ELSE 'precio_movido'::text
    END AS veredicto
`;

/** El FROM de HOY: las dos fuentes referenciadas directo, sin cardinalidad conocida. */
const FROM_LENTO = `
  FROM commercial.warehouses w
    JOIN catalog.products p ON p.tenant_id = w.tenant_id AND p.deleted_at IS NULL
    LEFT JOIN analytics.v_kepler_unit_cost kc
           ON w.kepler_code IS NOT NULL AND kc.tenant_id = w.tenant_id
          AND kc.warehouse_id = w.id AND kc.product_id = p.id
    LEFT JOIN wincaja.v_stock wv
           ON w.kepler_code IS NULL AND wv.tenant_id = w.tenant_id
          AND wv.source_branch = w.wincaja_source_branch AND wv.sku = p.sku::text
          AND wv.costo_promedio > 0::numeric
  WHERE w.deleted_at IS NULL AND (w.kepler_code IS NOT NULL OR w.wincaja_source_branch IS NOT NULL)
`;

/** El CTE nuevo: mismas fuentes, materializadas para que el planificador hashee. */
const CTE_RAPIDO = `
WITH kc AS MATERIALIZED (
  SELECT tenant_id, warehouse_id, product_id, costo_unitario
    FROM analytics.v_kepler_unit_cost
), wv AS MATERIALIZED (
  SELECT tenant_id, source_branch, sku, costo_promedio
    FROM wincaja.v_stock
   WHERE costo_promedio > 0::numeric
)
`;

const FROM_RAPIDO = `
  FROM commercial.warehouses w
    JOIN catalog.products p ON p.tenant_id = w.tenant_id AND p.deleted_at IS NULL
    LEFT JOIN kc ON w.kepler_code IS NOT NULL AND kc.tenant_id = w.tenant_id
                AND kc.warehouse_id = w.id AND kc.product_id = p.id
    LEFT JOIN wv ON w.kepler_code IS NULL AND wv.tenant_id = w.tenant_id
                AND wv.source_branch = w.wincaja_source_branch AND wv.sku = p.sku::text
  WHERE w.deleted_at IS NULL AND (w.kepler_code IS NOT NULL OR w.wincaja_source_branch IS NOT NULL)
`;

async function recrear(knex, cte, from) {
  await knex.raw(
    'CREATE OR REPLACE VIEW analytics.v_erp_unit_cost AS ' + cte + ' SELECT ' + SELECT_LIST + from
  );
  // No se heredan al recrear. Van explícitos y después se asertan.
  await knex.raw('ALTER VIEW analytics.v_erp_unit_cost SET (security_invoker = true)');
  await knex.raw('GRANT SELECT ON analytics.v_erp_unit_cost TO app_runtime');

  const chk = await knex.raw(`
    SELECT COALESCE(array_to_string(c.reloptions, ','), '') LIKE '%security_invoker=true%' AS invoker,
           has_table_privilege('app_runtime', 'analytics.v_erp_unit_cost', 'SELECT') AS lee
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'analytics' AND c.relname = 'v_erp_unit_cost'`);
  const r = chk.rows[0];
  if (!r || !r.invoker) throw new Error('[PERF.1] la vista quedo SIN security_invoker');
  if (!r.lee) throw new Error('[PERF.1] app_runtime quedo SIN permiso de lectura');
}

exports.up = async function up(knex) {
  await recrear(knex, CTE_RAPIDO, FROM_RAPIDO);
};

exports.down = async function down(knex) {
  await recrear(knex, '', FROM_LENTO);
};
