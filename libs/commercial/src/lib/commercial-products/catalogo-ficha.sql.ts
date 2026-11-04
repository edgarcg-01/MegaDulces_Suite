/**
 * Compras › Catálogo: las consultas de la ficha, en un archivo sin dependencias. Parámetros con `?` (knex).
 * ⚠️ Nada de `?` dentro de expresiones regulares: knex lo toma como binding.
 */

const N = (c: string) => `nullif(regexp_replace(${c}::text, '[^0-9.-]', '', 'g'), '')::numeric`;

/** ¿`product_label_prices` ya tiene grano por sucursal (`[NORM.3]`)? Sin él, el precio de una plaza no existe. */
export const LABEL_POR_SUCURSAL_SQL = `
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'commercial' AND table_name = 'product_label_prices'
                    AND column_name = 'sucursal') AS por_sucursal`;

/** Precios de etiqueta de varios productos en UNA sucursal. Parámetros: ids, sucursal. */
export const PRECIOS_SUCURSAL_SQL = `
  SELECT l.product_id::text AS product_id, l.unit_base, l.piece_price,
         l.wholesale_piece_price, l.wholesale_piece_min_qty,
         l.pack_size, l.pack_price, l.wholesale_pack_price, l.wholesale_pack_min_qty,
         l.box_size, l.box_price
    FROM commercial.product_label_prices l
   WHERE l.tenant_id = public.current_tenant_id() AND l.product_id = ANY(?::uuid[]) AND l.sucursal = ?`;

/** Precio base de UN producto en todas las sucursales (para el rango de la red). Parámetro: id. */
export const PRECIOS_RED_SQL = `
  SELECT l.sucursal, l.piece_price
    FROM commercial.product_label_prices l
   WHERE l.tenant_id = public.current_tenant_id() AND l.product_id = ?::uuid
     AND l.sucursal ~ '^[0-9]{2}$' AND l.sucursal <> '00'`;

/** Escalera de unidades de varios SKUs en UNA sucursal. Parámetros: skus, sucursal. */
export const ESCALERA_SQL = `
  SELECT v.sku, v.u1_label, v.u2_label, v.u3_label, v.f2_cap, v.f3_cap
    FROM analytics.v_kepler_unit_ladder v
   WHERE v.sku = ANY(?::text[]) AND v.sucursal = ?`;

/** Códigos de barras activos de varios SKUs (`catalog.product_barcodes` se liga por (tenant, sku)). Parámetro: skus. */
export const CODIGOS_SQL = `
  SELECT b.sku, btrim(b.barcode) AS barcode
    FROM catalog.product_barcodes b
   WHERE b.tenant_id = public.current_tenant_id() AND b.sku = ANY(?::text[])
     AND b.deleted_at IS NULL AND b.activo IS TRUE AND btrim(coalesce(b.barcode, '')) <> ''
   ORDER BY b.is_primary DESC NULLS LAST, b.barcode`;

/** Un producto con su proveedor. Parámetro: id. */
export const PRODUCTO_SQL = `
  SELECT p.id::text AS id, p.sku, p.nombre, p.description, p.barcode, p.activo,
         s.id::text AS proveedor_id, s.name AS proveedor
    FROM catalog.products p
    LEFT JOIN catalog.suppliers s ON s.id = p.supplier_id AND s.tenant_id = p.tenant_id
   WHERE p.tenant_id = public.current_tenant_id() AND p.id = ?::uuid AND p.deleted_at IS NULL`;

/**
 * Sucursales (kepler_code de 2 dígitos, sin el CEDIS `00`) y si su venta del PERIODO es medible: el corte a Kepler
 * cae en o antes del primer día del periodo (sin corte = no medible; antes del corte la venta está en Wincaja).
 * `[PF.23]` Devuelve el corte (`corte`, null si siempre estuvo en Kepler) para que la pantalla lo DIGA.
 * Parámetro: desde (YYYY-MM-DD).
 */
export const SUCURSALES_SQL = `
  SELECT w.kepler_code AS codigo, min(w.name) AS nombre,
         -- '-infinity' (03/04/05: siempre en Kepler) NO pasa por to_char: se compara como fecha.
         coalesce(min(x.cutover_date) <= ?::date, false) AS venta_medible,
         CASE WHEN min(x.cutover_date) IS NULL OR NOT isfinite(min(x.cutover_date)) THEN NULL
              ELSE to_char(min(x.cutover_date), 'YYYY-MM-DD') END AS corte,
         min(x.cutover_date) IS NULL AS sin_corte
    FROM commercial.warehouses w
    LEFT JOIN analytics.v_branch_erp_cutover x
      ON x.tenant_id = w.tenant_id AND x.kepler_code = w.kepler_code
   WHERE w.tenant_id = public.current_tenant_id() AND w.deleted_at IS NULL
     AND w.kepler_code ~ '^[0-9]{2}$' AND w.kepler_code <> '00'
   GROUP BY w.kepler_code
   ORDER BY w.kepler_code`;

/**
 * Venta del mes de UN producto por sucursal (`monto` con impuestos, `units` en unidad base), desde el corte
 * de Kepler de cada sucursal — mismo JOIN que `product-flow.sql.ts`. Desde el día 1 del mes en curso (México). Parámetro: id.
 */
export const VENTA_PERIODO_SQL = `
  SELECT k.source_branch AS sucursal, sum(k.monto) AS monto, sum(k.units) AS unidades,
         to_char(max(k.business_date) FILTER (WHERE k.units > 0), 'YYYY-MM-DD') AS ultima
    FROM analytics.mv_kepler_sales_daily k
    JOIN analytics.v_branch_erp_cutover x
      ON x.tenant_id = k.tenant_id AND x.kepler_code = k.source_branch AND k.business_date >= x.cutover_date
   WHERE k.tenant_id = public.current_tenant_id() AND k.product_id = ?::uuid
     AND k.business_date BETWEEN ?::date AND ?::date
   GROUP BY 1`;

/**
 * Las entradas de mercancía (XA20) que cuentan: renglón `kdm2` unido a su encabezado `kdm1`, sin canceladas,
 * almacén principal de la sucursal, con fecha, cantidad > 0 y unidad. Filtros copiados de `historial()` de
 * `standard-cost.service.ts`. `[PF.12.3]` UNA definición para la última entrada (lista y fichas de Sencillo y
 * Detallado) y para las compras de 90 días de Detallado (`COMPRAS_VENTANA_SQL`): cambia aquí o no cambia.
 * `predicadoSku` lleva el único `?`.
 */
export const ENTRADAS_XA20 = (predicadoSku: string) => `
    FROM kepler_ods.kdm2 l
    JOIN kepler_ods.kdm1 ap
      ON ap.sucursal = l.sucursal AND ap.c1 = l.c1 AND ap.c2 = l.c2 AND ap.c3 = l.c3
     AND ap.c4 = l.c4 AND ap.c6 = l.c6
   WHERE ${predicadoSku}
     AND l.c2 = 'X' AND l.c3 = 'A' AND btrim(l.c4::text) = '20'
     AND btrim(ap.c1::text) = ap.sucursal::text
     AND btrim(coalesce(ap.c43::text, '')) <> 'C'
     AND ap.c68 IS NOT NULL
     AND ${N('l.c9')} > 0
     AND NULLIF(btrim(l.c11::text), '') IS NOT NULL`;

/**
 * Lo que se lee de la entrada. `costo` = `kdm2.c12` CRUDO. `[PF.12.3]` `iva` = `c17` e `ieps` = `c18`, las tasas
 * del renglón; su SIGNO dice si `c12` trae el impuesto (negativa) o no (positiva o cero). Nadie publica `costo`
 * crudo: pasa por `costoSinImpuestos` (catalogo-ficha.ts).
 */
const COLUMNAS_ENTRADA = `
         btrim(ap.sucursal::text)               AS sucursal,
         to_char(ap.c68::date, 'YYYY-MM-DD')    AS fecha,
         NULLIF(upper(btrim(l.c11::text)), '')  AS unidad,
         ${N('l.c9')}                           AS cantidad,
         ${N('l.c12')}                          AS costo,
         ${N('l.c17')}                          AS iva,
         ${N('l.c18')}                          AS ieps`;

/**
 * La más nueva primero. `[PF.12.3]` El desempate (sucursal, renglón) es para que la lista y la ficha elijan
 * la MISMA entrada cuando dos empatan en fecha y folio (antes, cualquiera de las dos).
 */
const ORDEN_ENTRADA = 'ap.c68 DESC, ap.c6 DESC, ap.sucursal DESC, l.c7 DESC';

/**
 * `[PF.12.3]` La última entrada (XA20) de uno o VARIOS SKUs en UNA consulta, una por SKU. Es la ÚNICA consulta de
 * «última entrada»: la usan las listas Sencillo y Detallado (sólo los SKUs de la página, ≤ 200), la ficha
 * Sencillo y las compras de la ficha Detallado (con un SKU), así que las cuatro dicen lo mismo. Sustituye a la
 * `ULTIMA_ENTRADA_SQL` de un SKU (mismos filtros y orden). Parámetro: skus (recortados). Usa
 * `ix_kdm2_compra_sku` (btrim(c8), parcial X/A) donde existe.
 */
export const ULTIMAS_ENTRADAS_SQL = `
  SELECT DISTINCT ON (btrim(l.c8)) btrim(l.c8) AS sku, ${COLUMNAS_ENTRADA}
  ${ENTRADAS_XA20('btrim(l.c8) = ANY(?::text[])')}
   ORDER BY btrim(l.c8), ${ORDEN_ENTRADA}`;

/**
 * «Mostrar» de la lista: cuántos códigos de barras activos DISTINTOS tiene cada producto (el principal
 * `p.barcode` + `catalog.product_barcodes` activos por (tenant, sku)), con la misma regla que
 * `ordenarCodigos` + `CODIGOS_SQL`: recortados, sin vacíos, sin repetidos. Un renglón por producto
 * (agregado), así que el LEFT JOIN no duplica. Requiere `catalog.products` con alias `p`. Sin parámetros.
 */
export const N_CODIGOS_LATERAL_SQL = `
  LEFT JOIN LATERAL (
    SELECT count(DISTINCT z.c)::int AS n_codigos FROM (
      SELECT nullif(btrim(p.barcode), '') AS c
      UNION ALL
      SELECT btrim(b.barcode) FROM catalog.product_barcodes b
       WHERE b.tenant_id = p.tenant_id AND b.sku = p.sku AND b.deleted_at IS NULL AND b.activo IS TRUE
         AND btrim(coalesce(b.barcode, '')) <> ''
    ) z
  ) cc ON true`;

/**
 * «Mostrar › Alguna unidad sin precio», en SQL para poder filtrar y contar sobre TODA la búsqueda (la
 * lista es paginada). Repite la regla de `armarUnidades` + `algunaSinPrecio` (catalogo-ficha.ts):
 *  - base = u1 de la escalera, o la `unit_base` de la etiqueta; sin base → sin unidades → no cuenta.
 *  - la base sin `piece_price` > 0 → sin precio.
 *  - u2/u3 son peldaños sólo si hay u1, rótulo, factor > 1 y mayor que el peldaño anterior; su precio es
 *    `pack_price` si `pack_size` = factor, `box_price` si `box_size` = factor; si no hay (o ≤ 0) → sin precio.
 * Agregado con bool_or: un renglón por producto aunque hubiera filas repetidas. Requiere `p`.
 * Parámetros: sucursal (escalera), sucursal (precio). Sólo se usa si la tabla tiene grano por sucursal.
 *
 * `[PF.12.1]` `con_unidades` (aditiva: `sin_precio` y sus dos parámetros no cambian): el producto tiene base
 * —u1 de la escalera o `unit_base` de la etiqueta—, que es lo mismo que «`armarUnidades` devuelve algo».
 * La lista la usa para mandar al final lo que se pintaría «sin unidades».
 */
export const SIN_PRECIO_LATERAL_SQL = `
  LEFT JOIN LATERAL (
    SELECT coalesce(bool_or(CASE WHEN r.base IS NULL THEN false ELSE
        NOT coalesce(r.piece > 0, false)
        OR (r.f2ok AND NOT coalesce(CASE WHEN r.pack_size = r.f2 THEN r.pack_price WHEN r.box_size = r.f2 THEN r.box_price END > 0, false))
        OR (r.f3ok AND NOT coalesce(CASE WHEN r.pack_size = r.f3 THEN r.pack_price WHEN r.box_size = r.f3 THEN r.box_price END > 0, false))
      END), false) AS sin_precio,
      coalesce(bool_or(r.base IS NOT NULL), false) AS con_unidades
    FROM (
      SELECT t.*,
        (t.esc_ok AND t.u2 IS NOT NULL AND t.f2 > 1) AS f2ok,
        (t.esc_ok AND t.u3 IS NOT NULL AND t.f3 > 1
          AND t.f3 > CASE WHEN t.u2 IS NOT NULL AND t.f2 > 1 THEN t.f2 ELSE 1 END) AS f3ok
      FROM (
        SELECT coalesce(nullif(upper(btrim(e.u1_label)), ''), nullif(upper(btrim(l.unit_base)), '')) AS base,
               nullif(upper(btrim(e.u1_label)), '') IS NOT NULL AS esc_ok,
               nullif(upper(btrim(e.u2_label)), '') AS u2,
               nullif(upper(btrim(e.u3_label)), '') AS u3,
               ${N('e.f2_cap')} AS f2,
               ${N('e.f3_cap')} AS f3,
               ${N('l.piece_price')} AS piece,
               ${N('l.pack_size')} AS pack_size,
               ${N('l.pack_price')} AS pack_price,
               ${N('l.box_size')} AS box_size,
               ${N('l.box_price')} AS box_price
          FROM (SELECT 1) uno
          LEFT JOIN analytics.v_kepler_unit_ladder e ON e.sku = p.sku AND e.sucursal = ?
          LEFT JOIN commercial.product_label_prices l
            ON l.tenant_id = p.tenant_id AND l.product_id = p.id AND l.sucursal = ?
      ) t
    ) r
  ) sp ON true`;
