/**
 * U.10.1 — Wincaja se audita con la vara de Wincaja. Primera auditoría que no toca Kepler.
 *
 * ── Por qué existe ────────────────────────────────────────────────────────────────────────
 * Edgar: *"wincaja usa sus unidades en sus sucursales, y kepler en sus sucursales. ninguno
 * debería tener unidades incorrectas."* Hasta hoy **los tres chequeos de unidad de Wincaja que
 * existían usaban un lado de Kepler**:
 *   · `20260902170000` comparaba `costo_promedio` (Wincaja) contra `box_cost / factor_venta` (Kepler)
 *   · `v_unit_rung_audit` usa `caja_cost`, que sale de `replenishment_plan` (Kepler)
 *   · `import-wincaja-caja-factor.js` usa `c84`, `c81` y `cost_with_tax` (los tres de Kepler)
 * Juzgar a un ERP con la vara del otro es justo lo que produce la categoría "por convertir".
 *
 * ── Lo que la medición dice de Wincaja (prod, 2026-09-07) ─────────────────────────────────
 * Wincaja está LIMPIO por dentro, y eso hay que decirlo antes que nada:
 *   · cada artículo tiene UNA sola unidad de venta: **0 de 46,577** con más de una
 *   · el mismo SKU con la misma unidad en las 3 ramas vivas: **0 discrepancias de 15,535**
 *   · `factor_venta` coincide entre ramas en **15,522 / 15,535 (99.92%)**
 * No hay ambigüedad de unidad en Wincaja. Hay UN defecto, y es de captura.
 *
 * ── El defecto, y la regla que lo detecta sin salir de Wincaja ⭐ ──────────────────────────
 * `unidad_compra = 'CJA'` con `factor_venta <= 1` es **incoherente por sí solo**: Wincaja declara
 * que el artículo se COMPRA por caja y a la vez que en una caja cabe una sola unidad de venta.
 * No se puede comprar una caja de una pieza. No hace falta ningún dato de Kepler para verlo.
 *
 *     1,273 SKUs · 300 celdas con existencia · $1,508,388 a costo de Wincaja
 *
 * El resto del catálogo se explica solo, y cada rama es una AFIRMACIÓN, no una duda:
 *     13,306  factor_venta > 1                  -> sano
 *        197  unidad_venta = CJA                -> la unidad YA es la caja, divisor 1 correcto
 *        165  unidad_venta = KGS                -> peso, no se divide
 *
 * ── ⚠️ El testigo de dinero que PROBÉ Y NO FUNCIONA (para que nadie lo reintente) ──────────
 * La hipótesis era: `precios.margen_utilidad` es una declaración explícita del operador, así que
 * el margen implícito (`precio` vs `costo_promedio`) debería cuadrar donde la unidad está bien y
 * desviarse por un factor entero donde está mal. **Medido: no discrimina.**
 *   · `margen_utilidad` viene en PORCENTAJE (promedio 21.3), no en fracción — y es sobre COSTO
 *     (cuadra 43.9% dentro de 1 punto, contra 3.5% si se lee sobre venta)
 *   · pero cuadra en **41.8% de los `sano` contra 51.9% de los `caja_sin_capturar`**: está
 *     INVERTIDO respecto de lo que la hipótesis predecía
 * Es un margen configurado (objetivo), no un invariante vivo: `costo_promedio` se mueve con cada
 * compra y el margen no se recaptura. **Queda descartado como testigo**, medido, no supuesto.
 *
 * ── El límite estructural, declarado ──────────────────────────────────────────────────────
 * Wincaja **no tiene rótulo `PAQ`**: un multipack vendido por paquete se rotula `PZA` igual que
 * una pieza suelta (censo: PZA 15,154 · CJA 197 · KGS 165 · SER 11). La única señal que los
 * separa es si `factor_venta` vale `f3` o `f3/f2`, y `f2`/`f3` viven en Kepler. Por eso esta
 * vista NO clasifica pieza-vs-paquete: dice si el factor está capturado y es coherente, que es
 * lo que sí se puede afirmar sin salir de Wincaja.
 *
 * ⚠️ `source_dataset = 'actual'` es OBLIGATORIO y `kepler_code IS NULL` también: la rama `50`
 * (Canindo) sigue en `wincaja.articulos` pero hoy su POS es Kepler.
 *
 * SIN BACKTICKS en los comentarios SQL: van dentro de un template literal de JS.
 *
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function up(knex) {
  const ok = (await knex.raw(`SELECT to_regclass('wincaja.articulos') AS a,
                                     to_regclass('wincaja.existencias') AS e`)).rows[0];
  if (!ok?.a || !ok?.e) {
    console.log('  [U.10.1] schema wincaja ausente — no-op (local sin réplica).');
    return;
  }

  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_wincaja_unit_audit AS
    SELECT
      w.tenant_id,
      a.source_branch,
      w.id                                                AS warehouse_id,
      w.code                                              AS warehouse_code,
      a.articulo                                          AS sku,
      pr.id                                               AS product_id,
      a.nombre,
      upper(btrim(coalesce(a.unidad_venta,  '')))         AS unidad_venta,
      upper(btrim(coalesce(a.unidad_compra, '')))         AS unidad_compra,
      COALESCE(a.factor_venta, 0)::numeric                AS factor_venta,
      COALESCE(e.existencia, 0)::numeric                  AS existencia,
      e.costo_promedio,
      round((COALESCE(e.existencia,0) * COALESCE(e.costo_promedio,0))::numeric, 2) AS valor,
      e.fecha_ult_venta,
      -- ── El veredicto. Cada rama es una AFIRMACION sobre lo que Wincaja declara de si misma;
      -- ninguna consulta a Kepler. Precedencia: primero lo incoherente, despues lo afirmativo.
      CASE
        -- ⭐ EL DEFECTO: se compra por caja y a la vez cabe una sola unidad en la caja.
        WHEN upper(btrim(coalesce(a.unidad_compra,''))) = 'CJA'
         AND COALESCE(a.factor_venta,0) <= 1
         AND upper(btrim(coalesce(a.unidad_venta,''))) <> 'CJA'   THEN 'caja_sin_capturar'
        WHEN upper(btrim(coalesce(a.unidad_venta,''))) = 'CJA'    THEN 'unidad_es_caja'
        WHEN upper(btrim(coalesce(a.unidad_venta,''))) = 'KGS'    THEN 'peso'
        WHEN upper(btrim(coalesce(a.unidad_venta,''))) = 'SER'    THEN 'servicio'
        WHEN COALESCE(a.factor_venta,0) > 1                       THEN 'sano'
        -- Se compra suelto y se vende suelto: el divisor 1 es correcto, no es una ausencia.
        ELSE                                                           'sin_caja'
      END                                                 AS veredicto,
      -- El divisor que Wincaja SOSTIENE. NULL cuando la propia Wincaja se contradice: no se
      -- rellena con 1, porque un 1 ahi se leeria como "va uno por caja" (ADR-056).
      CASE
        WHEN upper(btrim(coalesce(a.unidad_compra,''))) = 'CJA'
         AND COALESCE(a.factor_venta,0) <= 1
         AND upper(btrim(coalesce(a.unidad_venta,''))) <> 'CJA'   THEN NULL
        WHEN upper(btrim(coalesce(a.unidad_venta,''))) IN ('CJA','KGS','SER') THEN 1::numeric
        WHEN COALESCE(a.factor_venta,0) > 1                       THEN a.factor_venta::numeric
        ELSE                                                           1::numeric
      END                                                 AS divisor_wincaja
      FROM wincaja.articulos a
      JOIN commercial.warehouses w
        ON w.tenant_id = a.tenant_id
       AND w.wincaja_source_branch = a.source_branch
       AND w.kepler_code IS NULL          -- Canindo conserva la rama 50 pero hoy es KEPLER
       AND w.deleted_at IS NULL
      LEFT JOIN wincaja.existencias e
        ON e.tenant_id = a.tenant_id AND e.source_branch = a.source_branch
       AND e.articulo = a.articulo AND e.source_dataset = 'actual'
      LEFT JOIN catalog.products pr
        ON pr.tenant_id = a.tenant_id AND pr.sku = a.articulo AND pr.deleted_at IS NULL
     WHERE a.source_dataset = 'actual'
  `);

  await knex.raw('ALTER VIEW analytics.v_wincaja_unit_audit SET (security_invoker = true)');
  await knex.raw('GRANT SELECT ON analytics.v_wincaja_unit_audit TO app_runtime');
  await knex.raw(`COMMENT ON VIEW analytics.v_wincaja_unit_audit IS
    'U.10.1 - Auditoria de la unidad de Wincaja hecha SOLO con datos de Wincaja (primera que no toca Kepler). El defecto real es caja_sin_capturar: unidad_compra=CJA con factor_venta<=1 es incoherente por si solo (no se compra una caja de una pieza). divisor_wincaja es NULL ahi, nunca 1 de relleno. NO clasifica pieza-vs-paquete: Wincaja no tiene rotulo PAQ y separarlos exige f2/f3 de Kepler. Testigo de margen (precios.margen_utilidad) PROBADO Y DESCARTADO: no discrimina (41.8% en sanos vs 51.9% en defectuosos).'`);

  const v = (await knex.raw(`
    SELECT veredicto, count(*)::int celdas, count(DISTINCT sku)::int skus,
           count(*) FILTER (WHERE existencia > 0)::int con_exist,
           round(sum(valor) FILTER (WHERE existencia > 0)::numeric, 0) valor
      FROM analytics.v_wincaja_unit_audit WHERE tenant_id = '${M}'::uuid
     GROUP BY 1 ORDER BY skus DESC`)).rows;
  for (const r of v) {
    console.log(`  ${String(r.veredicto).padEnd(20)} skus=${String(r.skus).padStart(6)} celdas=${String(r.celdas).padStart(6)}`
      + ` conExist=${String(r.con_exist).padStart(5)} valor=$${Number(r.valor || 0).toLocaleString('en-US')}`);
  }
  const malo = v.find((r) => r.veredicto === 'caja_sin_capturar');
  if (!malo || malo.skus === 0) {
    throw new Error('caja_sin_capturar = 0: se midieron 1,273 SKUs; el detector se rompió');
  }
  const relleno = (await knex.raw(`
    SELECT count(*)::int n FROM analytics.v_wincaja_unit_audit
     WHERE tenant_id = '${M}'::uuid AND veredicto = 'caja_sin_capturar' AND divisor_wincaja IS NOT NULL`)).rows[0];
  if (relleno.n !== 0) throw new Error(`${relleno.n} celdas incoherentes viajan con divisor de relleno`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_wincaja_unit_audit');
};
