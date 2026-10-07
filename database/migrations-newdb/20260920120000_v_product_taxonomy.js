/**
 * `[TDA.A3]` **Tipo y Grupo del producto, DERIVADOS del ODS.** La taxonomía que el ERP
 * muestra en la ficha del artículo, disponible para analítica sin un importer y sin una
 * tabla nueva — la regla principal del proyecto aplicada tal cual.
 *
 * ── El decode, hecho con una sonda y no adivinando ─────────────────────────────────────
 * El negocio mostró la ficha de Kepler del SKU `70001` "LA ROSA MAZAPAN /30":
 *
 *     Línea  = DIST DE LA ROSA SA DE CV     Tipo = DULCES     Grupo = MAZAPAN CACAHUATE
 *
 * Con ese SKU como sonda se leyó su fila de `kepler_ods.kdii` y se buscó, tabla por tabla
 * entre las 129 chicas del ODS, cuál contenía esos dos textos:
 *
 *     kdii.c4 = '001' -> kepler_ods.kdie (c1=codigo, c2=nombre) = **TIPO**   -> 'DULCES'
 *     kdii.c5 = '132' -> kepler_ods.kdif (c1=codigo, c2=nombre) = **GRUPO**  -> 'MAZAPAN CACAHUATE'
 *     kdii.c6 = kdii.c8 = 'CD015' = el PROVEEDOR (la «Línea» de la ficha), que ya vive en
 *               `catalog.products.supplier_id` y NO se toca acá.
 *
 * ⛔ **`catalog.products.category_id` NO es esto y no se puede usar en su lugar.** Medido:
 * de 8,004 productos con categoría y proveedor, **3,051 (38 %) tienen la categoría con el
 * MISMO NOMBRE que el proveedor** — el catálogo de `catalog.categories` mezcla categorías
 * reales (CHOCOLATES, MAZAPANES) con razones sociales (FERRERO DE MEXICO, MONDELEZ),
 * nombres de producto (CAMISETA CLASICA COLOR) y hasta plazas (CAT LA PIEDAD). Y
 * `catalog.products.department` está **100 % en NULL** (14,794 de 14,794).
 *
 * ── Lo que la vista NO inventa ─────────────────────────────────────────────────────────
 * ⚠️ **Tipo y Grupo NO son una jerarquía.** Medido: de 241 grupos, **86 aparecen bajo más
 * de un tipo**. Son dos etiquetas del producto, no un árbol — así que no se puede armar un
 * drill-down «tipo → sus grupos» y presentarlo como si cada grupo colgara de uno solo.
 *
 * ⚠️ **`kdii` es por sucursal y el mismo SKU puede estar etiquetado distinto.** Medido:
 * 132 de 9,548 SKUs (1.4 %) discrepan en tipo entre plazas y 162 (1.7 %) en grupo. Se
 * resuelve **anclando al CEDIS (`sucursal='00'`)**, que tiene 9,546 de los 9,548 SKUs, y
 * cayendo a la plaza de código más bajo para los que falten. La vista **declara de cuál
 * sucursal salió** (`fuente_sucursal`) para que la discrepancia se pueda auditar en vez
 * de quedar escondida detrás de un `DISTINCT ON`.
 *
 * ⚠️ **`NO APLICA` es un valor real, no un hueco.** Pesa **$15.1M = 14.3 % de la venta de
 * 12 meses** (2,427 SKUs) en tipo, y $15.4M en grupo. Se deja pasar tal cual: convertirlo
 * en NULL escondería que uno de cada siete pesos está sin clasificar a propósito.
 *
 * Cobertura medida sobre la venta de 12 meses de tienda: **tipo 98.0 %, grupo 99.7 %**.
 *
 * @param { import("knex").Knex } knex
 */

const VIEW = `
CREATE OR REPLACE VIEW analytics.v_product_taxonomy AS
WITH base AS (
  SELECT btrim(k.c1)                      AS sku,
         k.sucursal,
         NULLIF(btrim(k.c4), '')          AS tipo_code,
         NULLIF(btrim(k.c5), '')          AS grupo_code,
         -- El CEDIS manda; si un SKU no está ahí, la plaza de código más bajo.
         row_number() OVER (PARTITION BY btrim(k.c1)
                            ORDER BY (k.sucursal <> '00'), k.sucursal) AS rk
    FROM kepler_ods.kdii k
   WHERE btrim(COALESCE(k.c1, '')) <> ''
)
SELECT b.sku,
       b.sucursal                          AS fuente_sucursal,
       b.tipo_code,
       NULLIF(btrim(e.c2), '')             AS tipo_nombre,
       b.grupo_code,
       NULLIF(btrim(f.c2), '')             AS grupo_nombre
  FROM base b
  -- Los catálogos también viven por sucursal: se leen los del CEDIS, que es el ancla.
  LEFT JOIN kepler_ods.kdie e ON btrim(e.c1) = b.tipo_code  AND e.sucursal = '00'
  LEFT JOIN kepler_ods.kdif f ON btrim(f.c1) = b.grupo_code AND f.sucursal = '00'
 WHERE b.rk = 1`;

exports.up = async function up(knex) {
  await knex.raw(VIEW);
  await knex.raw('GRANT SELECT ON analytics.v_product_taxonomy TO app_runtime');
  await knex.raw(`COMMENT ON VIEW analytics.v_product_taxonomy IS
    'derive-no-copy sobre kepler_ods.kdii + kdie (Tipo) + kdif (Grupo): la taxonomia que el ERP muestra en la ficha del articulo, por SKU. Decodificada con el SKU 70001 como sonda (kdii.c4->kdie, kdii.c5->kdif; kdii.c6 es el proveedor y vive en catalog.products.supplier_id). NO usar catalog.products.category_id en su lugar: 38% de sus categorias repiten el nombre del proveedor, y department esta 100% en NULL. Tipo y Grupo NO son jerarquia (86 de 241 grupos aparecen bajo mas de un tipo). kdii es por sucursal y 1.4-1.7% de los SKUs discrepan entre plazas: se ancla al CEDIS (00) y se declara la fuente en fuente_sucursal. NO APLICA es un valor real (14.3% de la venta), no un hueco.'`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_product_taxonomy');
};
