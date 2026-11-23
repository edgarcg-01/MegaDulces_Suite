'use strict';
/**
 * `[PQ.144]` — **La clasificación del producto que Kepler ya tiene: línea, tipo y grupo.**
 *
 * ── Para qué, y de dónde salió ──────────────────────────────────────────────────────────────
 *
 * El pedido de Autoabasto le propone a una sucursal cientos de renglones de una sentada, y la
 * operación nunca cierra un pedido así: medido el 2026-11-22 sobre 3,880 pedidos de sucursal
 * reales de 90 días, el pedido típico tiene **8 renglones**, nueve de cada diez no pasan de 72 y
 * el más grande de todos tiene **173**. Ninguno pasó de 200. Lo que la sucursal hace es **partir**:
 * 7 pedidos al día (hasta 20 los días cargados).
 *
 * Edgar, el 2026-11-22: *«yo agregaría el orden alfabético o por línea para segmentar más fácil,
 * así el almacenista generaría agrupaciones de familias y controlaría el tamaño de los pedidos»*.
 * El corte por **línea** es el que ordena ese trabajo: en Kepler la línea es el **fabricante**, y
 * en la bodega los productos de un mismo fabricante llegan y se acomodan juntos.
 *
 * ── Lo medido antes (sólo lectura, 2026-11-22) ──────────────────────────────────────────────
 *  · **Control contra la pantalla del ERP**: el SKU `63018` da `BIMBO SA DE CV / DULCES /
 *    CHOCOLATE GALLETA`, idéntico a lo que muestra `pv_cat_prod_pos.kpl`. El decode se verificó
 *    contra un hecho independiente, no contra sí mismo.
 *  · Morelia Abastos: **9,618 SKUs**, 9,580 con código de línea y **8,648 (89.9 %) con línea
 *    resoluble** → **970 (10.1 %) quedan sin línea**, y por eso la vista los DECLARA en vez de
 *    esconderlos (`sin_linea`). Una agrupación por un dato que no existe los haría desaparecer.
 *  · **456 líneas distintas**; la línea mediana tiene **6 SKUs** y nueve de cada diez no pasan de
 *    47 — o sea que en un pedido de 70 renglones entran unas diez líneas COMPLETAS, sin partir
 *    ninguna familia. ⚠️ **28 líneas pasan de 70 SKUs** (la mayor, 317): ésas no se parten, se
 *    avisan (decisión del 2026-11-22).
 *
 * ── Por qué VISTA y no importer, y por qué acá ──────────────────────────────────────────────
 *
 * Regla principal del proyecto: el dato sale del ODS, derivado, sin copiarlo. `kdii`, `kdig`,
 * `kdie` y `kdif` ya están replicados — esto es `derive-no-copy` puro: ninguna tabla, ningún
 * script que agendar, y la frescura es la del ODS.
 *
 * ⭐ **ADR-056 — un primitivo, un lugar.** Este join ya existía escrito a mano dentro de
 * `commercial-bi-almacen.service.ts` (verificado allí el 2026-09-15: `kdii.c3→kdig` 87.6 % de
 * match, `kdii.c4→kdie` 100 %, `kdii.c5→kdif` 99.5 %). Autoabasto lo necesita ahora; copiarlo
 * sería la segunda implementación de la misma pregunta. Vive acá y lo usan los dos.
 *
 * ⚠️ **El catálogo está replicado POR SUCURSAL** y la vista lo respeta: su grano es
 * `(tenant_id, sucursal, sku)`. No se asume que las nueve copias coincidan — quien necesite esa
 * afirmación la mide, no la hereda.
 *
 * Idempotente (`CREATE OR REPLACE`).
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_erp_product_lines
      WITH (security_invoker = true) AS
    SELECT w.tenant_id,
           btrim(i.sucursal)                                   AS suc_code,
           btrim(i.c1)                                         AS sku,
           btrim(i.c2)                                         AS nombre,
           -- Los códigos crudos, para poder volver al ERP sin adivinar.
           NULLIF(btrim(i.c3::text), '')                       AS linea_code,
           NULLIF(btrim(i.c4::text), '')                       AS tipo_code,
           NULLIF(btrim(i.c5::text), '')                       AS grupo_code,
           -- El nombre, cuando el catálogo lo resuelve.
           NULLIF(btrim(g.c2), '')                             AS linea,
           NULLIF(btrim(e.c2), '')                             AS tipo,
           NULLIF(btrim(f.c2), '')                             AS grupo,
           -- ⛔ Lo que no resuelve se DECLARA (ADR-056): 10.1 % de los SKUs de Morelia Abastos
           --    tienen código de línea y ese código no existe en el catálogo. Un consumidor que
           --    agrupe por línea tiene que darles su propio grupo, no perderlos.
           (NULLIF(btrim(g.c2), '') IS NULL)                    AS sin_linea
      FROM kepler_ods.kdii i
      JOIN commercial.warehouses w
        ON btrim(w.kepler_code) = btrim(i.sucursal)
       AND w.deleted_at IS NULL
      LEFT JOIN kepler_ods.kdig g
        ON btrim(g.sucursal) = btrim(i.sucursal) AND btrim(g.c1) = btrim(i.c3::text)
      LEFT JOIN kepler_ods.kdie e
        ON btrim(e.sucursal) = btrim(i.sucursal) AND btrim(e.c1) = btrim(i.c4::text)
      LEFT JOIN kepler_ods.kdif f
        ON btrim(f.sucursal) = btrim(i.sucursal) AND btrim(f.c1) = btrim(i.c5::text)
     WHERE btrim(coalesce(i.c1, '')) <> ''
  `);
  await knex.raw(`
    COMMENT ON VIEW analytics.v_erp_product_lines IS
      '[PQ.144] Clasificacion del producto en Kepler al grano (sucursal, sku): linea = FABRICANTE '
      '(kdii.c3 -> kdig), tipo = el canasto (c4 -> kdie), grupo = subcategoria (c5 -> kdif). '
      'derive-no-copy sobre kepler_ods. sin_linea = true cuando el codigo existe y el catalogo no '
      'lo resuelve: 10.1 por ciento en Morelia Abastos (medido 2026-11-22), y se declara en vez de '
      'esconderse. Grano por SUCURSAL a proposito: el catalogo esta replicado y no se asume consenso.'`);
  await knex.raw(`GRANT SELECT ON analytics.v_erp_product_lines TO app_runtime`);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_erp_product_lines`);
};
