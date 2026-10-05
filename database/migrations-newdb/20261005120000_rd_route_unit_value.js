'use strict';
/**
 * `[RD.26]` — **El costo y el precio de cada producto en una ruta, leídos de Kepler.**
 *
 * ── El defecto que corrige, medido en prod el 2026-10-05 ──────────────────────────────────
 *
 * La pantalla publicaba el inventario del camión en dos valuaciones, y en **10 de 11 rutas**
 * «lo que costó» salía **MÁS CARO** que «lo que vale al cliente». Es imposible: si la mercancía
 * costó $24,462, venderla no puede dar $17,794.
 *
 * ⛔ **No era un error de cálculo: las dos columnas sumaban UNIVERSOS DISTINTOS.** Cada una se
 * valuaba con el unitario que salía del propio movimiento de la ruta:
 *
 *   · un par con carga y **sin venta** tiene costo pero no precio → entra al COSTO, se cae del PRECIO
 *   · un par con venta y **sin carga** (lo que vendió de más) tiene precio pero no costo → al revés
 *
 * Medido: **631 pares sin costo** y **242 sin precio** sobre 8,560. Los «sin carga» son justamente
 * los negativos, así que la columna de precio arrastraba minusvalías que la de costo no podía
 * valuar. Restringido al universo común, la inversión cae de **10/11 a 3/11** — y esas tres son
 * rutas con saldo negativo, donde invertirse es lo correcto.
 *
 * ── ⭐ La fuente: Kepler YA lo tiene, por peldaño. No se reconstruye nada ──────────────────
 *
 * La ficha del producto (`kepler_ods.kdii`) guarda la escalera completa — verificado contra la
 * pantalla del ERP para el SKU `40503`, número por número:
 *
 *   | peldaño | unidad      | costo        | precio de venta |
 *   |---------|-------------|--------------|-----------------|
 *   | base    | `c11` PZA   | `c77` 10.85  | `c90`  15.73    |
 *   | dos     | `c80` PZA   | `c78` 10.85  | `c91`  15.73    |
 *   | tres    | `c83` CJA   | `c79` 130.22 | `c92` 173.71    |
 *
 * ⛔ **El PV NO se calcula con `costo × (1+margen) × (1+impuesto)`.** Esa fórmula describe bien
 * al ERP (`[CE]` la verificó al 99.24 %), pero acá sobra: el precio **está guardado**. Aplicarla
 * sería reconstruir un dato que ya existe, y meter el error de los tres factores donde hay cero.
 *
 * ⛔ Tampoco se promedia entre rutas ni se saca mediana de nada. Las dos vías son hechos leídos:
 *
 *   1. `ruta`   — lo que ESTA ruta pagó y cobró, de sus propios documentos (embarque y ticket).
 *   2. `kepler` — la ficha del producto en SU sucursal, al peldaño que corresponde.
 *
 * Cada fila declara por cuál salió (`origen_costo` / `origen_precio`). Lo que no cae en ninguna
 * queda **NULL con su motivo**, nunca con el valor del peldaño vecino.
 *
 * ⚠️ **La ficha se une por (sku, UNIDAD), nunca sólo por sku.** El mismo producto cuesta $10.85
 * en pieza y $130.22 en caja de 12: unir sólo por SKU metería el costo de la caja en un renglón
 * de piezas — el disparate de 12× que `[CE]` ya documentó.
 *
 * ⛔ Vista, no tabla: se deriva del ledger y del ODS (derive-no-copy). `security_invoker` para
 * que respete el RLS de quien consulta.
 */

const VIEW = 'analytics.v_rd_route_unit_value';

exports.up = async function up(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VIEW}`);
  await knex.raw(`
    CREATE OR REPLACE VIEW ${VIEW}
      WITH (security_invoker = true) AS
    WITH base AS (
      SELECT l.tenant_id, l.route_no, i.suc_emisor, l.sku, l.unidad,
             sum(l.qty)       FILTER (WHERE l.clase = 'carga') AS carga_qty,
             sum(l.costo_doc) FILTER (WHERE l.clase = 'carga') AS carga_imp,
             sum(l.qty)       FILTER (WHERE l.clase = 'venta') AS venta_qty,
             sum(l.venta_doc) FILTER (WHERE l.clase = 'venta') AS venta_imp
        FROM analytics.mv_rd_route_ledger l
        JOIN analytics.mv_rd_route_identity i
          ON i.tenant_id = l.tenant_id AND i.route_no = l.route_no
       GROUP BY 1,2,3,4,5
    ), escalera AS (
      -- La ficha del producto, UNA FILA POR PELDANO. Sale tal cual del ERP: el costo y el
      -- precio estan guardados, no se derivan. Verificado contra la pantalla de Kepler.
      -- ⚠️ c77 llega como TEXTO y c78/c79/c90/c91/c92 como numeric: el ODS espeja los tipos
      -- del origen y en esta tabla no son uniformes. Castear de mas rompe; castear de menos
      -- tambien ("operator does not exist: text = integer"). Se trata columna por columna.
      SELECT k.sucursal, btrim(k.c1) AS sku, btrim(k.c11) AS unidad,
             nullif(nullif(btrim(k.c77), ''), '0')::numeric AS costo,
             nullif(k.c90, 0) AS precio, 'base' AS peldano
        FROM kepler_ods.kdii k WHERE btrim(coalesce(k.c11, '')) <> ''
      UNION ALL
      SELECT k.sucursal, btrim(k.c1), btrim(k.c80),
             nullif(k.c78, 0), nullif(k.c91, 0), 'dos'
        FROM kepler_ods.kdii k
       WHERE btrim(coalesce(k.c80, '')) <> ''
         AND btrim(coalesce(k.c80, '')) <> btrim(coalesce(k.c11, ''))
      UNION ALL
      SELECT k.sucursal, btrim(k.c1), btrim(k.c83),
             nullif(k.c79, 0), nullif(k.c92, 0), 'tres'
        FROM kepler_ods.kdii k
       WHERE btrim(coalesce(k.c83, '')) <> ''
         AND btrim(coalesce(k.c83, '')) <> btrim(coalesce(k.c11, ''))
         AND btrim(coalesce(k.c83, '')) <> btrim(coalesce(k.c80, ''))
    ), f AS (
      -- Un peldano puede repetirse si la ficha declara la misma unidad dos veces (medido: pasa,
      -- base y dos suelen ser la misma). Se toma el maximo para que el JOIN no multiplique filas
      -- y para no elegir un NULL cuando una de las dos copias si trae el dato.
      SELECT sucursal, sku, unidad, max(costo) AS costo, max(precio) AS precio
        FROM escalera GROUP BY 1,2,3
    )
    SELECT b.tenant_id, b.route_no, b.sku, b.unidad,
           b.carga_qty, b.carga_imp, b.venta_qty, b.venta_imp,
           coalesce(b.carga_qty, 0) - coalesce(b.venta_qty, 0) AS saldo_qty,

           coalesce(b.carga_imp / nullif(b.carga_qty, 0), f.costo)  AS costo_u,
           CASE WHEN b.carga_imp / nullif(b.carga_qty, 0) IS NOT NULL THEN 'ruta'
                WHEN f.costo  IS NOT NULL THEN 'kepler'
                ELSE NULL END                                       AS origen_costo,

           coalesce(b.venta_imp / nullif(b.venta_qty, 0), f.precio) AS precio_u,
           CASE WHEN b.venta_imp / nullif(b.venta_qty, 0) IS NOT NULL THEN 'ruta'
                WHEN f.precio IS NOT NULL THEN 'kepler'
                ELSE NULL END                                       AS origen_precio
      FROM base b
      LEFT JOIN f ON f.sucursal = b.suc_emisor AND f.sku = b.sku AND f.unidad = b.unidad
  `);
  await knex.raw(`GRANT SELECT ON ${VIEW} TO app_runtime`);
  await knex.raw(`
    COMMENT ON VIEW ${VIEW} IS $$[RD.26] Costo y precio de cada producto en cada ruta, por dos
    vias leidas -- lo que la ruta pago y cobro, o la ficha de Kepler (kdii) al peldano que
    corresponde -- y cada fila declara por cual salio. Existe porque valuar cada columna con su
    propio unitario hacia que las dos sumaran universos distintos: 10 de 11 rutas publicaban un
    inventario que costaba MAS de lo que vale al cliente. El precio NO se reconstruye con la
    formula del margen: esta guardado en c90/c91/c92. La ficha se une por (sku, UNIDAD), nunca
    solo por sku. VISTA derive-no-copy, security_invoker.$$`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VIEW}`);
};
