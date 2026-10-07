/* eslint-disable no-console */
/**
 * [UN.2] El resolvedor por almacen aprende a leer la ESTRUCTURA DE UNIDADES de Kepler.
 *
 * Edgar (2026-09-15): *"cablealo"*, despues de exigir la formula en vez de un parche.
 *
 * `analytics.v_warehouse_box_factor` resolvia el factor de caja con esta precedencia:
 *
 *     wincaja.factor_venta  ->  v_product_box_factor  ->  mv_kepler_sold_rung  ->  1 (default)
 *
 * y cuando nada de eso sabia, publicaba **1 con fuente `default`/`none`**. Ese `default` es el
 * que el consenso descarta como "sin testigo", y es el guion que se ve en la columna UxC.
 *
 * Ahora entra un testigo mas, el ultimo de la fila: `analytics.v_kepler_unit_ladder` [UN.1], que
 * es la propia ficha del ERP decodificada (ver `docs/ERP_KEPLER.md` 2.1.1). Aporta DOS cosas que
 * ninguna otra fuente daba:
 *
 *   1. `derivado_del_costo` — el factor despejado de la ecuacion del propio Kepler
 *      `costo_peldano = costo_base x factor` (98.6% de cumplimiento; el factor derivado coincide
 *      con el capturado en 98.3% de 53,112 filas, mediana 1.00000). Sirve donde el factor NO se
 *      capturo pero el costo del peldano SI.
 *   2. `unidad_unica` — el producto NO tiene rotulo de Unidad Dos ni Tres, asi que su factor es
 *      **1 y eso es un DATO**, no ignorancia. La ficha lo dice al pie: "La facturacion es siempre
 *      sobre la unidad Base, Los inventarios estan en la unidad Base".
 *
 * ── LO QUE ESTE COMMIT NO HACE, A PROPOSITO ────────────────────────────────────────────────
 * ⛔ NO pisa ninguna fuente que hoy ya resuelva. La escalera entra SOLO donde el resultado previo
 * es 1, o sea donde hoy no sabemos nada. Medido antes de decidirlo: donde la cascada YA resuelve,
 * la escalera la contradice en 9 de 5,581 (etiquetera), 2 de 2,094 (kepler_c84), 29 de 106
 * (factor_sale) y **38 de 253 (override)**. Esas contradicciones se DECLARAN como hallazgo de
 * calidad; cambiar la precedencia del override es otra decision, con su propio antes/despues.
 *
 * ⛔ NO toca `base_label` ni `box_label`, que hoy salen de `v_supplier_cost_ladder`. La escalera
 * trae el rotulo del ERP por sucursal y es mejor fuente, pero eso mueve las unidades que se
 * imprimen en pantalla: va en su propio commit.
 *
 * ⚠️ El VALOR del factor cambia en muy pocos productos (los que hoy caen a `default` y la escalera
 * resuelve con factor > 1). Lo que si se mueve es el CONTEO DE LO DECLARADO: cientos de celdas
 * dejan de reportarse como "convertidas sin fuente" en `/almacen/existencia`
 * (`existencia.service.ts` cuenta `factor_source IN ('default','none')`) porque ahora tienen una.
 * Ese movimiento es el arreglo, no un efecto secundario.
 */

exports.up = async function up(knex) {
  const antes = (await knex.raw(`
    SELECT factor_source, count(*)::int AS filas,
           count(*) FILTER (WHERE box_factor > 1)::int AS con_factor
      FROM analytics.v_warehouse_box_factor
     GROUP BY 1 ORDER BY 2 DESC
  `)).rows;
  console.log('[UN.2] ANTES:', antes.map((r) => `${r.factor_source} ${r.filas}`).join(' · '));

  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_warehouse_box_factor AS
    WITH wh AS (
      SELECT w.tenant_id, w.id, w.code, w.kepler_code, w.wincaja_source_branch
        FROM commercial.warehouses w
       WHERE w.deleted_at IS NULL
         AND (w.kepler_code IS NOT NULL OR w.wincaja_source_branch IS NOT NULL)
    ),
    wcf AS (
      SELECT w.tenant_id, w.id AS warehouse_id, a.articulo AS sku,
             a.factor_venta AS fv, a.unidad_venta AS unidad
        FROM wh w
        JOIN wincaja.articulos a
          ON a.tenant_id = w.tenant_id
         AND a.source_branch = w.wincaja_source_branch
         AND a.source_dataset = 'actual'
       WHERE w.kepler_code IS NULL
         AND (a.factor_venta > 1 OR (a.factor_venta = 1 AND btrim(upper(a.unidad_venta)) = 'CJA'))
    ),
    base AS (
      SELECT w.tenant_id, w.id AS warehouse_id, w.code AS warehouse_code, w.kepler_code,
             p.id AS product_id, p.sku,
             -- lo que la cascada resolvia ANTES de esta migracion
             GREATEST(COALESCE(wcf.fv, bfx.box_factor, 1::numeric), 1::numeric) AS f_previo,
             wcf.fv AS wcf_fv, wcf.unidad AS wcf_unidad,
             bfx.source AS bfx_source, bfx.is_weight, bfx.is_master_suspect,
             sr.rung_max,
             kul.factor_caja AS kul_factor, kul.factor_source AS kul_source,
             lad.u3_label AS lad_u3, lad.u1_label AS lad_u1
        FROM wh w
        JOIN catalog.products p ON p.tenant_id = w.tenant_id AND p.deleted_at IS NULL
        LEFT JOIN analytics.v_product_box_factor bfx
               ON bfx.tenant_id = p.tenant_id AND bfx.product_id = p.id
        LEFT JOIN analytics.v_supplier_cost_ladder lad ON lad.sku = p.sku::text
        LEFT JOIN wcf ON wcf.warehouse_id = w.id AND wcf.sku = p.sku::text
        LEFT JOIN analytics.mv_kepler_sold_rung sr
               ON sr.sucursal = w.kepler_code AND sr.sku = p.sku::text
        -- [UN.2] el testigo nuevo: la ficha del ERP, al grano que le corresponde (sucursal x sku)
        LEFT JOIN analytics.v_kepler_unit_ladder kul
               ON kul.sucursal = w.kepler_code AND kul.sku = btrim(p.sku::text)
    )
    SELECT tenant_id, warehouse_id, warehouse_code, product_id, sku,
           CASE
             WHEN f_previo = 1 AND kepler_code IS NOT NULL AND rung_max > 1 THEN rung_max
             -- ⚠️ La escalera entra SOLO donde la cascada de producto no declaro nada. Un override
             -- humano que vale 1 esta DICIENDO "este producto no tiene caja", y eso es una
             -- decision, no un hueco: sin esta condicion la escalera se la llevaria por delante.
             WHEN f_previo = 1 AND kepler_code IS NOT NULL
                  AND COALESCE(bfx_source, 'default') = 'default' AND kul_factor > 1
               THEN kul_factor
             ELSE f_previo
           END AS box_factor,
           CASE
             WHEN f_previo = 1 AND kepler_code IS NOT NULL AND rung_max > 1
               THEN 'kepler_peldano_vendido'
             WHEN f_previo = 1 AND kepler_code IS NOT NULL
                  AND COALESCE(bfx_source, 'default') = 'default' AND kul_factor > 1
               THEN CASE WHEN kul_source = 'derivado_del_costo' THEN 'kepler_escalera_costo'
                         ELSE 'kepler_escalera' END
             WHEN f_previo = 1 AND kepler_code IS NOT NULL
                  AND COALESCE(bfx_source, 'default') = 'default' AND kul_source = 'unidad_unica'
               THEN 'kepler_unidad_unica'
             WHEN wcf_fv IS NOT NULL THEN 'wincaja_factor_venta'
             ELSE COALESCE(bfx_source, 'none')
           END AS factor_source,
           CASE WHEN kepler_code IS NOT NULL THEN 'kepler' ELSE 'wincaja' END AS erp,
           lad_u3 AS box_label,
           COALESCE(wcf_unidad, lad_u1) AS base_label,
           COALESCE(is_weight, false) AS is_weight,
           COALESCE(is_master_suspect, false) AS is_master_suspect
      FROM base
  `);

  await knex.raw('GRANT SELECT ON analytics.v_warehouse_box_factor TO app_runtime');

  const despues = (await knex.raw(`
    SELECT factor_source, count(*)::int AS filas,
           count(*) FILTER (WHERE box_factor > 1)::int AS con_factor
      FROM analytics.v_warehouse_box_factor
     GROUP BY 1 ORDER BY 2 DESC
  `)).rows;
  console.log('[UN.2] DESPUES:', despues.map((r) => `${r.factor_source} ${r.filas}`).join(' · '));

  const suma = (rows) => rows.reduce((a, r) => a + Number(r.filas), 0);
  if (suma(antes) !== suma(despues)) {
    throw new Error(`[UN.2] la vista cambio de tamano: ${suma(antes)} -> ${suma(despues)}. `
      + 'Un JOIN nuevo que abanica es el defecto mas caro de esta familia; revisar antes de seguir.');
  }

  // ⭐ Prueba negativa: ninguna fuente que YA resolvia puede haber cambiado de valor. Si esto se
  // pone rojo, la escalera se colo por delante de otra fuente y hay que revisar la precedencia.
  const [g] = (await knex.raw(`
    SELECT count(*)::int AS rompieron
      FROM analytics.v_warehouse_box_factor v
     WHERE v.factor_source IN ('kepler_escalera', 'kepler_escalera_costo', 'kepler_unidad_unica')
       AND EXISTS (
         SELECT 1 FROM analytics.v_product_box_factor b
          WHERE b.tenant_id = v.tenant_id AND b.product_id = v.product_id
            AND b.source <> 'default')
  `)).rows;
  console.log(`[UN.2] filas donde la escalera piso una fuente ya resuelta: ${g.rompieron}`);
  if (Number(g.rompieron) > 0) {
    throw new Error(`[UN.2] la escalera piso ${g.rompieron} filas que otra fuente ya resolvia. `
      + 'Este commit solo puede rellenar el hueco, nunca cambiar lo que ya tenia testigo.');
  }
};

exports.down = async function down(knex) {
  // Vuelve EXACTAMENTE a la definicion previa (sin el testigo de la escalera).
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_warehouse_box_factor AS
    WITH wh AS (
      SELECT w.tenant_id, w.id, w.code, w.kepler_code, w.wincaja_source_branch
        FROM commercial.warehouses w
       WHERE w.deleted_at IS NULL
         AND (w.kepler_code IS NOT NULL OR w.wincaja_source_branch IS NOT NULL)
    ),
    wcf AS (
      SELECT w.tenant_id, w.id AS warehouse_id, a.articulo AS sku,
             a.factor_venta AS fv, a.unidad_venta AS unidad
        FROM wh w
        JOIN wincaja.articulos a
          ON a.tenant_id = w.tenant_id
         AND a.source_branch = w.wincaja_source_branch
         AND a.source_dataset = 'actual'
       WHERE w.kepler_code IS NULL
         AND (a.factor_venta > 1 OR (a.factor_venta = 1 AND btrim(upper(a.unidad_venta)) = 'CJA'))
    )
    SELECT w.tenant_id, w.id AS warehouse_id, w.code AS warehouse_code,
           p.id AS product_id, p.sku,
           CASE WHEN GREATEST(COALESCE(wcf.fv, bfx.box_factor, 1::numeric), 1::numeric) = 1::numeric
                     AND w.kepler_code IS NOT NULL AND sr.rung_max > 1::numeric THEN sr.rung_max
                ELSE GREATEST(COALESCE(wcf.fv, bfx.box_factor, 1::numeric), 1::numeric) END AS box_factor,
           CASE WHEN GREATEST(COALESCE(wcf.fv, bfx.box_factor, 1::numeric), 1::numeric) = 1::numeric
                     AND w.kepler_code IS NOT NULL AND sr.rung_max > 1::numeric
                  THEN 'kepler_peldano_vendido'
                WHEN wcf.fv IS NOT NULL THEN 'wincaja_factor_venta'
                ELSE COALESCE(bfx.source, 'none') END AS factor_source,
           CASE WHEN w.kepler_code IS NOT NULL THEN 'kepler' ELSE 'wincaja' END AS erp,
           lad.u3_label AS box_label,
           COALESCE(wcf.unidad, lad.u1_label) AS base_label,
           COALESCE(bfx.is_weight, false) AS is_weight,
           COALESCE(bfx.is_master_suspect, false) AS is_master_suspect
      FROM wh w
      JOIN catalog.products p ON p.tenant_id = w.tenant_id AND p.deleted_at IS NULL
      LEFT JOIN analytics.v_product_box_factor bfx
             ON bfx.tenant_id = p.tenant_id AND bfx.product_id = p.id
      LEFT JOIN analytics.v_supplier_cost_ladder lad ON lad.sku = p.sku::text
      LEFT JOIN wcf ON wcf.warehouse_id = w.id AND wcf.sku = p.sku::text
      LEFT JOIN analytics.mv_kepler_sold_rung sr
             ON sr.sucursal = w.kepler_code AND sr.sku = p.sku::text
  `);
  await knex.raw('GRANT SELECT ON analytics.v_warehouse_box_factor TO app_runtime');
};
