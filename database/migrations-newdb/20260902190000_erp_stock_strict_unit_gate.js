/**
 * ADR-055 — endurece el gate de unidad de `analytics.v_erp_stock_on_hand`: sólo se normaliza
 * cuando el catálogo de Wincaja DECLARA una conversión real (`factor_venta > 1`).
 *
 * QUÉ ESTABA MAL. La versión de la migración 20260902170000 aplicaba el factor `bf / factor_venta`
 * siempre que `factor_venta <= bf`. Eso incluye `factor_venta = 1`, que NO es "la unidad de venta es
 * la caja": es el **valor por defecto de un campo sin configurar**. Con `fv = 1` el factor pasa a ser
 * `bf` entero, así que la existencia se multiplicaba por el empaque completo sin ninguna evidencia
 * de que estuviera en cajas.
 *
 * Medido en prod: **239 SKUs** tomaban factor por esa vía (MD-30 160 · MD-32 79 · CEDIS 7) contra
 * 738 que sí traen `factor_venta > 1` declarado. Caso testigo `44062 GALL CRACKETS MINI QUESO`
 * (`fv = 1`, `bf = 64`): la existencia pasaba de 536 a 34,320 unidades y, contra una demanda de 5
 * unidades/día, daba **6,864 días de cobertura**. No existe tal inventario.
 *
 * POR QUÉ EL CAMBIO ES CHICO EN LOS AGREGADOS (y por qué se hace igual). Juzgado por cobertura
 * mediana en días — el testigo de negocio, con las sucursales Kepler como referencia (34–80 d):
 *
 *     escenario                        │ MD-30 │ MD-32 │ absurdos (>365 d)
 *     ─────────────────────────────────┼───────┼───────┼──────────────────
 *     sin normalizar (cruda)           │  59 d │  77 d │  —
 *     factor con fv <= bf (antes)      │  66 d │  89 d │  491 / 667
 *     factor con fv >  bf (ahora)      │  64 d │  87 d │  462 / 648
 *
 * O sea: los tres caen dentro del rango de Kepler y la diferencia es de ~2 días de mediana. El
 * cambio NO se hace porque los números lo exijan, sino porque **una de las dos reglas infiere sin
 * evidencia y la otra no**. Regla del proyecto: si la fuente no alcanza para decidir, se declara —
 * no se dibuja (docs/ERP_KEPLER.md §5 regla 0).
 *
 * Los `fv = 1` pasan a `unit_verified = false` con `unit_factor = 1`: se sirven en la unidad CRUDA
 * de Wincaja y quedan marcados para que un consumidor pueda excluirlos o revisarlos. Es la misma
 * salida que ya tenían los `fv > bf` (incoherentes).
 *
 * ⚠️ DESALINEADO CONOCIDO QUE ESTA VISTA NO RESUELVE — `commercial.reorder_policy` de MD-30/MD-32
 * está en la unidad CRUDA de Wincaja, no en unidad base (medido: 233/245 y 208/210 SKUs multipack
 * con `source='computed'` tienen su `reorder_point` más cerca de la existencia cruda que de la
 * normalizada; ej. `44062` reorden 52 vs cruda 536 vs normalizada 34,320). La DEMANDA sí está en
 * unidad base, así que **el pedido (venta × cobertura − existencia − tránsito) es correcto**; lo que
 * queda incomparable son las columnas "Reorden"/"Máx" del workbook y cualquier bucket que compare
 * política contra existencia. `criticalStock`/`summary`/`worklist` NO están afectados hoy porque
 * siguen leyendo la copia cruda `commercial.stock` (siguen internamente consistentes) — y por eso
 * NO se pueden migrar a la vista hasta normalizar también la política (`import-computed-reorder`).
 */
exports.up = async function up(knex) {
  const [{ ok }] = (await knex.raw(
    `SELECT to_regclass('analytics.v_erp_stock_on_hand') IS NOT NULL AS ok`)).rows;
  if (!ok) {
    // eslint-disable-next-line no-console
    console.log('  ⚠ analytics.v_erp_stock_on_hand no existe — nada que endurecer');
    return;
  }
  // CREATE OR REPLACE (no DROP): la vista ya tiene consumidores y recrearla tiraría 0A000 por
  // cached plan. La firma no cambia — mismas columnas, mismos tipos, sólo la expresión del factor.
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_erp_stock_on_hand WITH (security_invoker = true) AS
    SELECT w.tenant_id,
           w.id                                              AS warehouse_id,
           w.code                                            AS warehouse_code,
           pr.id                                             AS product_id,
           pr.sku,
           GREATEST(SUM(k.c4 + k.c8 - k.c9), 0)::numeric     AS qty_base_units,
           1::numeric                                        AS unit_factor,
           'kepler_ods'::text                                AS source,
           true                                              AS unit_verified
      FROM kepler_ods.kdil k
      JOIN commercial.warehouses w
        ON w.kepler_code = k.sucursal
       AND w.kepler_code <> '00'
       AND w.deleted_at IS NULL
      JOIN catalog.products pr
        ON pr.tenant_id = w.tenant_id
       AND pr.sku = btrim(k.c3)
       AND pr.deleted_at IS NULL
     WHERE k.sucursal = k.c1
       AND btrim(k.c3) <> ALL (ARRAY['00001', '00002', '00022'])
     GROUP BY w.tenant_id, w.id, w.code, pr.id, pr.sku

    UNION ALL

    SELECT w.tenant_id,
           w.id                                              AS warehouse_id,
           w.code                                            AS warehouse_code,
           pr.id                                             AS product_id,
           pr.sku,
           GREATEST(SUM(v.existencia * f.factor), 0)::numeric AS qty_base_units,
           MAX(f.factor)                                     AS unit_factor,
           'wincaja'::text                                   AS source,
           bool_and(f.verified)                              AS unit_verified
      FROM wincaja.v_stock v
      -- Sin backticks en estos comentarios: van dentro de un template literal de JS.
      -- Se une por wincaja_source_branch (la vista de Wincaja emite 'MD-00' para el CEDIS y nuestro
      -- almacen es '00'), con kepler_code IS NULL para excluir a Canindo '06', que conserva un
      -- wincaja_source_branch='50' residual pero hoy es KEPLER.
      JOIN commercial.warehouses w
        ON w.tenant_id = v.tenant_id
       AND w.wincaja_source_branch = v.source_branch
       AND w.kepler_code IS NULL
       AND w.deleted_at IS NULL
      JOIN catalog.products pr
        ON pr.tenant_id = v.tenant_id
       AND pr.sku = v.sku
       AND pr.deleted_at IS NULL
      LEFT JOIN wincaja.articulos a
        ON a.tenant_id = v.tenant_id
       AND a.articulo = v.sku
       AND a.source_branch = v.source_branch
      LEFT JOIN analytics.v_product_box_factor bfx
        ON bfx.tenant_id = pr.tenant_id
       AND bfx.product_id = pr.id
      CROSS JOIN LATERAL (
        SELECT
          -- GATE ESTRICTO: factor_venta > 1 = el catalogo DECLARA una conversion (multipack).
          -- factor_venta = 1 es el DEFAULT de un campo sin configurar, no "la unidad de venta es la
          -- caja": normalizar ahi multiplicaba por el empaque entero sin evidencia (44062 daba 6,864
          -- dias de cobertura). Y factor_venta > box_factor es fisicamente imposible.
          CASE WHEN COALESCE(a.factor_venta, 0) > 1
                AND COALESCE(bfx.box_factor, 0) > 0
                AND a.factor_venta <= bfx.box_factor
               THEN (bfx.box_factor::numeric / a.factor_venta::numeric)
               ELSE 1::numeric END AS factor,
          (COALESCE(a.factor_venta, 0) > 1
             AND COALESCE(bfx.box_factor, 0) > 0
             AND a.factor_venta <= bfx.box_factor) AS verified
      ) f
     WHERE v.existencia IS NOT NULL
       AND v.warehouse_code NOT LIKE 'RUTA-%'
     GROUP BY w.tenant_id, w.id, w.code, pr.id, pr.sku`);

  await knex.raw('GRANT SELECT ON analytics.v_erp_stock_on_hand TO app_runtime');
};

exports.down = async function down() {
  // Sin rollback automatico: revertir al gate laxo re-introduciria la sobre-normalizacion de los
  // 239 SKUs con factor_venta = 1. Para volver atras, re-aplicar 20260902170000 a mano.
};
