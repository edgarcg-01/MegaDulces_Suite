/**
 * ADR-052 — REVIERTE la normalización de unidad de `analytics.v_erp_stock_on_hand`.
 * La vista vuelve a servir la existencia **tal como la guarda cada fuente**, y el factor de caja
 * pasa a ser una columna INFORMATIVA para el display (`display_box_factor`), que es lo que
 * siempre debió ser.
 *
 * ═══ EL ERROR QUE ESTO CORRIGE (mío, 2026-09-02, vivo en prod unas horas) ═══
 *
 * Las migraciones 20260902170000 / 190000 convertían la existencia de Wincaja a "unidad base"
 * multiplicándola por `box_factor / factor_venta`. La premisa era que Kepler guarda piezas y
 * Wincaja paquetes, así que había que unificar. **La premisa estaba incompleta.**
 *
 * TESTIGO DECISIVO: la DEMANDA de Wincaja también está en unidad de venta. Comparando
 * `analytics.sales_daily.units` contra la venta cruda `wincaja.v_sales_daily.qty` (MD-30, 30 d):
 *
 *     SKUs multipack │ coinciden 1:1 │ coinciden ×factor │ razón mediana
 *     ───────────────┼───────────────┼───────────────────┼──────────────
 *              182   │      182      │         0         │     1.000
 *
 * El feed de ventas NO convierte. O sea existencia, demanda y `reorder_policy` (derivada de la
 * demanda) estaban **auto-consistentes por almacén**: Kepler todo en piezas, Wincaja todo en
 * unidad de venta. Convertir SÓLO la existencia rompió esa consistencia y dejó el pedido
 * comparando peras con manzanas — la existencia se veía `factor` veces más grande que su
 * demanda, así que el motor **dejaba de pedir**.
 *
 * Los "$2,336,485 menos de pedido" que la conversión parecía ahorrar NO eran un sobre-pedido
 * corregido: eran **sub-pedido inducido**. Evidencia: los multipack de MD-30/MD-32 pasaban a
 * mostrar 534 y 900 días de cobertura contra un punto de reorden de ~19 días (jamás pedirían),
 * cuando en su unidad nativa dan 12-15 días.
 *
 * El bug original de Wincaja era, como decía el análisis previo del repo, **SÓLO DE DISPLAY**:
 * mostrar la existencia cruda etiquetada como "cajas" dividiéndola por `bf` (piezas por caja)
 * cuando la unidad guardada es el paquete. Eso se arregla en la PRESENTACIÓN dividiendo por el
 * factor correcto — `display_box_factor` — no alterando el dato del que dependen los cálculos.
 *
 * ═══ LO QUE SIGUE SIENDO VÁLIDO DE ADR-052 ═══
 *
 * Derivar del ODS en vez de copiar a `commercial.stock` se sostiene y es la razón de ser de esta
 * vista: contra el POS en vivo la vista acierta 100.0% y la copia 91.0% (15,324 unidades de
 * error), porque el importer de la copia es delta contra un snapshot en disco que se
 * desincroniza y deja valores fantasma. Eso NO cambia: sólo se retira la conversión de unidad.
 *
 * ═══ CONTRATO NUEVO ═══
 *   `qty_stock_units`     existencia en la unidad NATIVA de la fuente (auto-consistente con la
 *                         demanda y con reorder_policy de ese mismo almacén). Reemplaza a
 *                         `qty_base_units`, cuyo nombre afirmaba una normalización que ya no ocurre.
 *   `display_box_factor`  unidades de stock por CAJA, sólo para mostrar cajas: `factor_venta`
 *                         cuando Wincaja declara multipack (`factor_venta > 1`), si no `box_factor`.
 *                         NO multiplica nada acá; lo usa quien presenta.
 *   `unit_source`         'kepler' | 'wincaja_multipack' | 'wincaja' — de dónde salió el factor.
 *
 * LECCIÓN DE MÉTODO (por qué me equivoqué): el testigo del COSTO confirmaba que la existencia de
 * Wincaja está en paquetes — y era cierto —, pero yo salté de ahí a "hay que convertirla" sin
 * verificar la unidad del OTRO lado de la resta. Antes de convertir una magnitud, hay que probar
 * la unidad de TODAS las que se comparan con ella, y contra la fuente cruda, no contra un
 * derivado. Ver docs/ERP_KEPLER.md §5 regla 0 y docs/UNIDADES_DE_MEDIDA.md.
 */
exports.up = async function up(knex) {
  const [{ ok }] = (await knex.raw(
    `SELECT to_regclass('analytics.v_erp_stock_on_hand') IS NOT NULL AS ok`)).rows;
  if (!ok) return;

  // Cambia la LISTA de columnas (qty_base_units -> qty_stock_units, + display_box_factor), así que
  // CREATE OR REPLACE no alcanza: hay que DROP. Es seguro porque los consumidores son importers
  // (leen en cada corrida, no tienen plan cacheado de larga vida) y el service se redeploya.
  await knex.raw('DROP VIEW IF EXISTS analytics.v_erp_stock_on_hand');
  await knex.raw(`
    CREATE VIEW analytics.v_erp_stock_on_hand WITH (security_invoker = true) AS
    -- ── KEPLER 01-06: existencia en PIEZAS (su unidad nativa) ────────────────────────
    SELECT w.tenant_id,
           w.id                                          AS warehouse_id,
           w.code                                        AS warehouse_code,
           pr.id                                         AS product_id,
           pr.sku,
           GREATEST(SUM(k.c4 + k.c8 - k.c9), 0)::numeric AS qty_stock_units,
           GREATEST(COALESCE(MAX(bfx.box_factor), 1), 1)::numeric AS display_box_factor,
           'kepler'::text                                AS unit_source,
           'kepler_ods'::text                            AS source
      FROM kepler_ods.kdil k
      JOIN commercial.warehouses w
        ON w.kepler_code = k.sucursal
       AND w.kepler_code <> '00'
       AND w.deleted_at IS NULL
      JOIN catalog.products pr
        ON pr.tenant_id = w.tenant_id
       AND pr.sku = btrim(k.c3)
       AND pr.deleted_at IS NULL
      LEFT JOIN analytics.v_product_box_factor bfx
        ON bfx.tenant_id = pr.tenant_id AND bfx.product_id = pr.id
     WHERE k.sucursal = k.c1
       AND btrim(k.c3) <> ALL (ARRAY['00001', '00002', '00022'])
     GROUP BY w.tenant_id, w.id, w.code, pr.id, pr.sku

    UNION ALL

    -- ── WINCAJA MD-30/MD-32/00: existencia en su UNIDAD DE VENTA (nativa) ────────────
    -- NO se convierte: la demanda de estos almacenes viene en la MISMA unidad (verificado
    -- 1:1 contra wincaja.v_sales_daily), asi que existencia/demanda/reorder_policy son
    -- auto-consistentes. Convertir solo la existencia rompia el pedido.
    -- Sin backticks en estos comentarios: van dentro de un template literal de JS.
    SELECT w.tenant_id,
           w.id                                          AS warehouse_id,
           w.code                                        AS warehouse_code,
           pr.id                                         AS product_id,
           pr.sku,
           GREATEST(SUM(v.existencia), 0)::numeric       AS qty_stock_units,
           -- Unidades de stock por CAJA, solo para MOSTRAR cajas. Si Wincaja declara multipack
           -- (factor_venta > 1) la unidad guardada es el paquete y caben factor_venta por caja;
           -- si no, la unidad es la misma que la de Kepler y aplica el resolvedor canonico.
           GREATEST(COALESCE(MAX(CASE WHEN a.factor_venta > 1 THEN a.factor_venta::numeric END),
                             MAX(bfx.box_factor), 1), 1)::numeric AS display_box_factor,
           CASE WHEN MAX(CASE WHEN a.factor_venta > 1 THEN 1 ELSE 0 END) = 1
                THEN 'wincaja_multipack' ELSE 'wincaja' END       AS unit_source,
           'wincaja'::text                               AS source
      FROM wincaja.v_stock v
      -- Se une por wincaja_source_branch (la vista de Wincaja emite 'MD-00' para el CEDIS y
      -- nuestro almacen es '00'), con kepler_code IS NULL para excluir a Canindo '06', que
      -- conserva un wincaja_source_branch='50' residual pero hoy es KEPLER.
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
        ON bfx.tenant_id = pr.tenant_id AND bfx.product_id = pr.id
     WHERE v.existencia IS NOT NULL
       AND v.warehouse_code NOT LIKE 'RUTA-%'
     GROUP BY w.tenant_id, w.id, w.code, pr.id, pr.sku`);

  await knex.raw('GRANT SELECT ON analytics.v_erp_stock_on_hand TO app_runtime');
  await knex.raw(`COMMENT ON VIEW analytics.v_erp_stock_on_hand IS
    'Existencia del ERP por almacen x producto, en la UNIDAD NATIVA de cada fuente (Kepler=piezas, Wincaja=unidad de venta). NO convierte: la demanda y reorder_policy de cada almacen vienen en esa misma unidad, y convertir solo la existencia rompe el pedido (verificado: sales_daily coincide 1:1 con wincaja.v_sales_daily en los multipack). display_box_factor = unidades de stock por caja, SOLO para mostrar. Derivar-no-copiar sobre kepler_ods + wincaja: contra el POS acierta 100.0% vs 91.0% de la copia commercial.stock.'`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_erp_stock_on_hand');
};
