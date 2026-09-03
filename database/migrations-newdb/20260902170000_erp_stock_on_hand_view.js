/**
 * `analytics.v_erp_stock_on_hand` — la EXISTENCIA del ERP, derivada y NORMALIZADA a la unidad base.
 * Derivar-no-copiar sobre las tablas primarias, sin importer ni tabla espejo (ADR-052 en curso).
 *
 * ⚠️ LA COLUMNA SE LLAMA `qty_base_units`, NO `qty_pieces`, Y ES A PROPÓSITO. La unidad base la
 * declara Kepler (`kdii.c11`, expuesto en `analytics.v_supplier_cost_ladder.u1_label`), no nosotros:
 * para el azúcar `99029` es **500 g**, no una pieza (su `bf = 50` es el factor 500g→costal). Escribir
 * "pz" ahí es la misma mentira que RA-PRO.46 ya corrigió en el rótulo del workbook. Quien muestre
 * esta cantidad al usuario debe traer el rótulo de la escalera; quien la agregue en dinero debe usar
 * el costo del MISMO peldaño. Ver docs/UNIDADES_DE_MEDIDA.md y ERP_KEPLER §2.1.
 *
 * POR QUÉ EXISTE. Hasta hoy la existencia llegaba por 3 importers que COPIABAN a `commercial.stock`
 * (`import-branch-stock-live`, `import-wincaja-stock`, `import-cedis-stock-wincaja`), y el fact del
 * pedido leía esa copia. Dos daños medidos en prod (2026-09-02):
 *
 *   1. LA COPIA ENVEJECE Y MIENTE. El importer Kepler es delta contra un snapshot en disco
 *      (`.stock-live-snapshot.json`); cuando el snapshot se desincroniza, la fila queda con un
 *      valor fantasma para siempre. Contra el POS en vivo: `commercial.stock` acierta 91.0%
 *      (15,324 unidades de error) y esta vista 100.0% (3 unidades = ruido de timing, 22,090 SKUs).
 *      Ej. `88009` en `01`: POS 2485 · ODS 2487 · tabla 3547.
 *
 *   2. LA UNIDAD NO ESTABA NORMALIZADA — y eso costaba dinero. Kepler guarda la existencia en su
 *      UNIDAD BASE; Wincaja en su UNIDAD DE VENTA, que en multipack es el PAQUETE (y a veces la CAJA).
 *      `/compras/pedido` dividía todo por `bf` (piezas por caja) como si fueran piezas, así que
 *      sub-declaraba la existencia de Morelia 3×–144× → **$870,907 de sobre-pedido** sobre 493
 *      SKUs (MD-30 $748,713 · MD-32 $122,194). El parche anterior (`analytics.wincaja_product_box_factor`
 *      + su importer nightly) sólo cubría 184 productos y sólo se aplicaba en `criticalStock`/
 *      `summary` — los métodos de la vista "Existencia Crítica", que RA-PRO.17 fusionó y hoy
 *      redirige a `/compras/pedido`. La matriz que el comprador de verdad usa nunca lo tuvo.
 *
 * LA UNIDAD SE RESUELVE ACÁ, UNA VEZ. Fórmula universal, sin discriminador probabilístico:
 *
 *     unidades_base = existencia × (bf / factor_venta)
 *
 * donde `bf` = unidades base por caja (resolvedor canónico `analytics.v_product_box_factor`) y
 * `factor_venta` = unidades de venta por caja (nativo de `wincaja.articulos`). Cuando la unidad de
 * venta ES la unidad base, `factor_venta == bf` y el factor vale 1 (no-op) — por eso una sola expresión
 * sirve para los tres casos. Validado contra el DINERO (`wincaja.v_stock.costo_promedio` debe ser
 * el costo de UNA unidad de venta = `box_cost / factor_venta`, tolerancia 10%):
 *
 *     caso                                    │ SKUs  │ cuadra el costo
 *     ────────────────────────────────────────┼───────┼────────────────
 *     fv == bf  (factor 1, no-op)             │ 5,498 │ 95.4%
 *     fv <  bf  (multipack o caja)            │   472 │ 94.1%
 *     fv >  bf  (INCOHERENTE, no se normaliza)│    31 │ 19.4%
 *
 * Los 31 incoherentes (`fv > bf` no tiene sentido físico: no puede haber más unidades de venta que
 * unidades base en la caja) se dejan SIN normalizar y se DECLARAN en `unit_verified = false`. No se
 * dibujan: quien consuma la vista puede excluirlos o revisarlos, pero nadie los toma por buenos.
 * Regla del proyecto: si la fuente no alcanza para decidir, se declara (docs/ERP_KEPLER.md §5 r0).
 *
 * ALCANCE (idéntico al de los importers que reemplaza, para NO cambiar semántica de callado):
 *   • Kepler `01`–`06` ← `kepler_ods.kdil`, fresco por el carril hash del CDC (~min).
 *     Filtro `sucursal = c1` obligatorio: `kdil` arrastra RÉPLICAS de otras sucursales (`03` trae
 *     3 valores de `c1`) y sin él la existencia se duplica. `c2` (sub-almacén) tiene un solo valor
 *     por sucursal, así que no hay nada que agregar por ese lado.
 *   • Excluye los pseudo-SKUs contables `00001` VENTAS 0% / `00002` / `00022` TIEMPO AIRE: no son
 *     inventario físico e inflaban existencia y sobrestock.
 *   • Excluye la sucursal Kepler `00`, que es **OFICINAS, no el CEDIS** (cero líneas de mostrador
 *     `U-D-10`; 4,884 pseudo-SKUs contables). El CEDIS real es BPIRAPUATO y vive en WINCAJA →
 *     entra por la rama Wincaja, como ya lo hacía `import-cedis-stock-wincaja`. Ver ERP_KEPLER §2.3.
 *   • Wincaja `MD-30`/`MD-32`/`00` ← `wincaja.existencias` vía `wincaja.v_stock` (`source_dataset
 *     = 'actual'`). Sigue siendo la tabla primaria de esa fuente: Wincaja NO está en el ODS (schema
 *     aparte, réplica de la Fase WR). Su frescura hoy es de ~25 h para Morelia y ~7 h para el CEDIS
 *     — igual que la ruta que reemplaza, no peor; mejora cuando reviva el CDC de WR.
 *   • Excluye `RUTA-*` (inventario de camioneta), igual que `import-wincaja-stock`.
 *
 * `GREATEST(...,0)`: Kepler arroja existencias NEGATIVAS (más salidas que entradas+inicial). No hay
 * stock físico negativo. ⚠️ Y ojo: `kdil.c4` (existencia inicial) vale **0 en el 100% de las filas
 * de las 7 sucursales** — igual que `kdik.c4`, así que `kdik` no es alternativa. Es un bug de datos
 * de Kepler: la fórmula pierde el baseline del inventario físico, y un SKU con `c8 == c9` da 0
 * aunque tenga mercancía. Afecta IGUAL a cualquier ruta (el importer usaba la misma fórmula), así
 * que no es una regresión de esta vista — pero impide llegar al 100% real por cualquier vía.
 *
 * NO plega `commercial.product_aliases` a propósito: esto es "la existencia del ERP por almacén ×
 * producto", una sola responsabilidad. El consumidor plega (el fact ya lo hace con
 * `COALESCE(al.canonical_product_id, …)`). Hoy hay 1 alias activo.
 *
 * `security_invoker = true` → la RLS de `commercial.warehouses` / `catalog.products` aplica, así que
 * el tenant se filtra solo. `kepler_ods.*` no tiene tenant: el `tenant_id` de la vista sale del
 * almacén, que es quien lo sabe.
 */
exports.up = async function up(knex) {
  // Sin las tablas del ODS o de Wincaja la vista no compila. En un entorno que todavía no las tiene
  // (local recién creado), se salta: la migración es idempotente y el siguiente run la crea.
  const [{ ok }] = (await knex.raw(`
    SELECT (to_regclass('kepler_ods.kdil') IS NOT NULL
        AND to_regclass('wincaja.v_stock') IS NOT NULL
        AND to_regclass('analytics.v_product_box_factor') IS NOT NULL) AS ok`)).rows;
  if (!ok) {
    // eslint-disable-next-line no-console
    console.log('  ⚠ falta kepler_ods.kdil / wincaja.v_stock / v_product_box_factor — vista omitida');
    return;
  }

  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_erp_stock_on_hand WITH (security_invoker = true) AS
    -- ── KEPLER 01-06: la existencia ya viene en la UNIDAD BASE ──────────────────────
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
       AND w.kepler_code <> '00'          -- '00' es OFICINAS; el CEDIS real entra por Wincaja
       AND w.deleted_at IS NULL
      JOIN catalog.products pr
        ON pr.tenant_id = w.tenant_id
       AND pr.sku = btrim(k.c3)
       AND pr.deleted_at IS NULL
     WHERE k.sucursal = k.c1              -- anti-réplica: kdil arrastra filas de otras sucursales
       AND btrim(k.c3) <> ALL (ARRAY['00001', '00002', '00022'])
     GROUP BY w.tenant_id, w.id, w.code, pr.id, pr.sku

    UNION ALL

    -- ── WINCAJA MD-30/MD-32/00: existencia en UNIDAD DE VENTA → a UNIDAD BASE ───────
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
      -- OJO: sin backticks en estos comentarios — van DENTRO de un template literal de JS y lo
      -- cerrarían (trampa ya vivida en el repo).
      -- Se une por wincaja_source_branch, NO por v.warehouse_code: para el CEDIS la vista de
      -- Wincaja emite 'MD-00', un código que NO existe en commercial.warehouses (el nuestro es
      -- '00') => unir por código PERDIA el CEDIS entero, en silencio.
      -- kepler_code IS NULL es obligatorio: '06' Canindo conserva wincaja_source_branch = '50'
      -- RESIDUAL de cuando su POS era Wincaja, pero hoy es KEPLER (se lee del replica lógico
      -- kepler_md_06). Sin este gate, Canindo entraría por las DOS ramas y su existencia se
      -- duplicaría. Ver docs/ERP_KEPLER.md §2.3.
      JOIN commercial.warehouses w
        ON w.tenant_id = v.tenant_id
       AND w.wincaja_source_branch = v.source_branch
       AND w.kepler_code IS NULL
       AND w.deleted_at IS NULL
      JOIN catalog.products pr
        ON pr.tenant_id = v.tenant_id
       AND pr.sku = v.sku
       AND pr.deleted_at IS NULL
      -- factor_venta es POR SUCURSAL (cada Wincaja tiene su catálogo) → se une por source_branch.
      LEFT JOIN wincaja.articulos a
        ON a.tenant_id = v.tenant_id
       AND a.articulo = v.sku
       AND a.source_branch = v.source_branch
      LEFT JOIN analytics.v_product_box_factor bfx
        ON bfx.tenant_id = pr.tenant_id
       AND bfx.product_id = pr.id
      CROSS JOIN LATERAL (
        SELECT
          -- Sólo se normaliza cuando la relación es COHERENTE (fv <= bf, ambos > 0). Si no, factor 1
          -- y unit_verified = false: se declara, no se dibuja.
          CASE WHEN COALESCE(a.factor_venta, 0) > 0
                AND COALESCE(bfx.box_factor, 0) > 0
                AND a.factor_venta <= bfx.box_factor
               THEN (bfx.box_factor::numeric / a.factor_venta::numeric)
               ELSE 1::numeric END AS factor,
          (COALESCE(a.factor_venta, 0) > 0
             AND COALESCE(bfx.box_factor, 0) > 0
             AND a.factor_venta <= bfx.box_factor) AS verified
      ) f
     WHERE v.existencia IS NOT NULL
       AND v.warehouse_code NOT LIKE 'RUTA-%'   -- inventario de camioneta, fuera (igual que el feed)
     GROUP BY w.tenant_id, w.id, w.code, pr.id, pr.sku`);

  await knex.raw('GRANT SELECT ON analytics.v_erp_stock_on_hand TO app_runtime');

  await knex.raw(`COMMENT ON VIEW analytics.v_erp_stock_on_hand IS
    'Existencia del ERP por almacen x producto, NORMALIZADA a la UNIDAD BASE del ERP (qty_base_units; NO son piezas necesariamente: el azucar 99029 se mide en 500g. El rotulo lo declara Kepler en analytics.v_supplier_cost_ladder.u1_label). Kepler 01-06 desde kepler_ods.kdil (ya en unidad base); Wincaja MD-30/MD-32/00 desde wincaja.v_stock x (bf/factor_venta). unit_verified=false => la relacion bf/factor_venta es incoherente (fv>bf) y NO se normalizo. Derivar-no-copiar: reemplaza a import-branch-stock-live / import-wincaja-stock / import-cedis-stock-wincaja.'`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_erp_stock_on_hand');
};
