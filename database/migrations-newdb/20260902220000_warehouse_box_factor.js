/**
 * ADR-055 — LA CANTIDAD SE MUESTRA EN LA UNIDAD MÁS GRANDE (la caja), y el divisor
 * es el del ERP QUE MANDA EN ESE ALMACÉN.
 *
 * ── El defecto que cierra ──────────────────────────────────────────────────────────────────
 * Kepler guarda la existencia en su unidad BASE (la pieza). Wincaja la guarda en SU unidad de
 * venta, que en los multipack es el PAQUETE. Hasta hoy toda la pantalla dividía por un único
 * factor por PRODUCTO (`analytics.v_product_box_factor.box_factor` = unidades base por caja), así
 * que en los almacenes de Wincaja la existencia salía dividida entre 140 cuando debía dividirse
 * entre 14 → se veía ~10 veces más chica de lo que es.
 *
 * Y no es sólo cosmético: `analytics.product_demand.daily_pieces` SÍ normaliza la demanda de
 * Wincaja a piezas (medido: 159 de 166 multipack de MD-30 con razón ≈ f2 contra
 * `analytics.sales_daily`, $1.79M de venta 30d), mientras `replenishment_plan.stock_pz` se queda
 * en paquetes. El motor comparaba PIEZAS de demanda contra PAQUETES de existencia y pedía de más.
 *
 * Medido en prod 2026-09-02 (368 filas por almacén, de ~9,800; las cifras se mueven un poco en
 * cada refresco del fact, la magnitud no):
 *   · sobre-pedido del workbook   $12,570,980 → $11,704,175   =  −$866,805
 *   · inventario que no se veía   $63,247,108 → $65,931,933   =  +$2,684,825
 *   · purchaseSuggestion          $ 7,139,115 → $ 6,778,956   =  −$360,159
 *   · las 6 sucursales Kepler: sin cambio, ni un peso.
 *
 * ── Por qué `factor_venta` es el divisor correcto para Wincaja ─────────────────────────────
 * `wincaja.articulos.factor_venta` está definido como "cuántas de MIS unidades de venta hacen una
 * caja", así que sirve igual venda piezas o paquetes — no hace falta clasificar el SKU.
 * Verificado con tres testigos independientes:
 *   1. DINERO (crudo, no derivado): en la sucursal 30 el precio realmente cobrado por unidad
 *      (`wincaja.v_sales_daily`) × factor_venta cae a ±11% del precio de caja del ODS
 *      (`p3`): 42029 $115.54×14=$1,617 vs $1,701 · 08057 $119.20×28=$3,338 vs $3,521.
 *   2. LA ESCALERA del ODS: factor_venta = f3/f2 en 355 SKUs (multipack) y = f3 en 1,818
 *      (venden la unidad base) — las dos formas son consistentes con la definición.
 *   3. CONCORDANCIA con el resolvedor canónico donde NO debe haber diferencia: en las 5,475
 *      filas de los casos "sin escalera" y "misma unidad", `factor_venta` y `box_factor` dan el
 *      mismo valuado con Δ < 0.1% ($9,573 y −$140). Divergen sólo en los 348 multipack (+$2.63M),
 *      que es exactamente el defecto. Dos fuentes independientes que coinciden donde deben y
 *      difieren donde debe: eso es lo que autoriza a usarla.
 *
 * ⚠️ ESTO ES UN DIVISOR DE PRESENTACIÓN. NO convierte el dato base. Ya se intentó normalizar la
 * existencia cruda (mig 20260902200000) y rompió el pedido, porque `inventory_health` y
 * `reorder_policy` se derivan de `analytics.sales_daily`, que SÍ está en la unidad nativa de
 * Wincaja. Regla: cada almacén conserva su unidad nativa; lo que se unifica es CÓMO SE MUESTRA.
 */
exports.up = async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_warehouse_box_factor WITH (security_invoker = true) AS
    WITH wh AS (
      SELECT tenant_id, id, code, kepler_code, wincaja_source_branch
        FROM commercial.warehouses
       WHERE deleted_at IS NULL
         AND (kepler_code IS NOT NULL OR wincaja_source_branch IS NOT NULL)
    ), wcf AS (
      -- Driven desde los almacenes (3 sucursales), NO desde articulos: la tabla trae ~275k filas
      -- con factor_venta>1 repartidas entre decenas de source_branch (rutas incluidas) y agregarla
      -- entera costaba 545 ms. Con el join por el prefijo del PK
      -- (tenant_id, source_branch, source_dataset) la vista completa baja a 140 ms.
      -- source_dataset='actual' ES OBLIGATORIO: articulos guarda tambien 'concentrada'.
      SELECT w.tenant_id, w.id AS warehouse_id, a.articulo AS sku,
             a.factor_venta::numeric AS fv, a.unidad_venta AS unidad
        FROM wh w
        JOIN wincaja.articulos a
          ON a.tenant_id = w.tenant_id
         AND a.source_branch = w.wincaja_source_branch
         AND a.source_dataset = 'actual'
       WHERE w.kepler_code IS NULL AND a.factor_venta > 1
    )
    SELECT w.tenant_id,
           w.id                       AS warehouse_id,
           w.code                     AS warehouse_code,
           p.id                       AS product_id,
           p.sku,
           -- Unidades NATIVAS de este almacen por CAJA. Es el divisor para mostrar cantidades.
           GREATEST(COALESCE(wcf.fv, bfx.box_factor, 1), 1)::numeric AS box_factor,
           CASE WHEN wcf.fv IS NOT NULL THEN 'wincaja_factor_venta'
                ELSE COALESCE(bfx.source, 'none') END                AS factor_source,
           CASE WHEN w.kepler_code IS NOT NULL THEN 'kepler' ELSE 'wincaja' END AS erp,
           -- Rotulo del peldano MAS GRANDE que declara el ERP (kdii.c83 via la escalera del ODS).
           -- Sin escalera se deja NULL: la pantalla dice "caja" generico, no se inventa un rotulo.
           lad.u3_label                                              AS box_label,
           -- Rotulo de la unidad NATIVA del almacen: la de Wincaja donde manda Wincaja, la base
           -- del ERP donde manda Kepler.
           COALESCE(wcf.unidad, lad.u1_label)                        AS base_label,
           COALESCE(bfx.is_weight, false)                            AS is_weight,
           COALESCE(bfx.is_master_suspect, false)                    AS is_master_suspect
      FROM wh w
      JOIN catalog.products p ON p.tenant_id = w.tenant_id AND p.deleted_at IS NULL
      LEFT JOIN analytics.v_product_box_factor bfx
        ON bfx.tenant_id = p.tenant_id AND bfx.product_id = p.id
      LEFT JOIN analytics.v_supplier_cost_ladder lad ON lad.sku = p.sku
      LEFT JOIN wcf ON wcf.warehouse_id = w.id AND wcf.sku = p.sku`);

  await knex.raw('GRANT SELECT ON analytics.v_warehouse_box_factor TO app_runtime');

  // El fact del reabasto se lleva el divisor resuelto para que el camino de lectura no pague el
  // join (la pantalla lo consulta por pagina, muchas veces). La REGLA sigue viviendo en la vista:
  // el importer la LEE, no la reimplementa.
  if (!(await knex.schema.withSchema('analytics').hasColumn('replenishment_plan', 'display_bf'))) {
    await knex.schema.withSchema('analytics').alterTable('replenishment_plan', (t) => {
      t.decimal('display_bf', 14, 4).nullable()
        .comment('Unidades nativas del almacen por CAJA (divisor de presentacion). Viene de analytics.v_warehouse_box_factor. NO es bf: en los almacenes de Wincaja la existencia esta en unidad de venta.');
    });
  }
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_warehouse_box_factor');
  if (await knex.schema.withSchema('analytics').hasColumn('replenishment_plan', 'display_bf')) {
    await knex.schema.withSchema('analytics').alterTable('replenishment_plan', (t) => t.dropColumn('display_bf'));
  }
};
