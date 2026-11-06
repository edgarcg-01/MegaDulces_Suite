/**
 * `[NP.17]` La existencia de Kepler de los productos nuevos, leída DIRECTO de `kepler_ods.kdil`.
 *
 * Son las mismas reglas que la rama Kepler de `analytics.v_erp_stock_on_hand` (almacén principal
 * `sucursal = c1`, los SKU de servicio fuera, el `00` sólo desde su corte, piso en cero), sin el
 * factor de caja de `v_product_box_factor`: la vista lo calcula para TODO el catálogo en cada
 * consulta (~8,800 productos, dos veces) y esta pantalla no lo usa. Medido en prod 2026-10-09:
 * todos los productos nuevos 1.7–2.3 s → 134–163 ms; uno solo 1.1–1.35 s → 6–8 ms, con las 4,322
 * filas idénticas a la vista. El candado `test-newdb-new-products.js` compara las dos.
 *
 * Archivo aparte y sin dependencias para que la prueba de base de datos corra ESTE texto, no una copia.
 * Parámetros: `?::text[]` los SKU (entra por `kdil.c3`, que no trae espacios) y `?::uuid[]` los productos.
 */
export const EXISTENCIA_KEPLER_SQL = `
  SELECT pr.id AS product_id, w.code AS plaza, w.kepler_code AS sucursal,
         GREATEST(sum(k.c4 + k.c8 - k.c9), 0)::numeric AS cantidad,
         NULL::numeric AS factor, 'kepler' AS fuente
    FROM kepler_ods.kdil k
    JOIN commercial.warehouses w
      ON w.kepler_code = k.sucursal AND w.deleted_at IS NULL AND w.tenant_id = public.current_tenant_id()
    JOIN catalog.products pr
      ON pr.tenant_id = w.tenant_id AND pr.sku::text = btrim(k.c3) AND pr.deleted_at IS NULL
   WHERE k.sucursal = k.c1 AND k.c3 = ANY(?::text[]) AND pr.id = ANY(?::uuid[])
     AND btrim(k.c3) <> ALL (ARRAY['00001', '00002', '00022'])
     AND (w.kepler_code <> '00'
          OR GREATEST(k.c6, k.c7)::date >= (SELECT min(c.cutover_date) FROM analytics.v_branch_erp_cutover c
                                             WHERE c.kepler_code = '00'))
   GROUP BY pr.id, w.code, w.kepler_code`;

/** `[NP.6]` Los umbrales de los hitos en el registro `[CDRP.2]`, con la forma de `KpiUmbral`. RLS por tenant. */
export const LEER_UMBRALES_HITOS_SQL = `
  SELECT kpi_key, position_code, period, target::float8 AS target, warn_at::float8 AS warn_at,
         escalate_at::float8 AS escalate_at, direction, escalate_to, source, manual_lock,
         auto_tuned_at::text AS auto_tuned_at
    FROM analytics.kpi_thresholds
   WHERE tenant_id = public.current_tenant_id() AND deleted_at IS NULL
     AND kpi_key LIKE 'compras.productos_nuevos.%'`;

/**
 * `[NP.18]` (sin migración, 2026-11-04) Los renglones de COMPRA (`X-A-20`) de los documentos que ya trae la
 * historia, con sus tasas, para quitarles el impuesto en el SERVIDOR con `costoSinImpuestos` (`[PF.12.3]`):
 * en `kdm2` una tasa NEGATIVA (`c17` IVA, `c18` IEPS) quiere decir que `c13` trae el impuesto adentro.
 * La función de base `fn_new_products_movimientos` no se toca: devuelve `c13` crudo.
 *
 * Entra por DOCUMENTO (la plaza y el folio de cada entrada de la historia), con el índice parcial
 * `idx_kdm1_xa_doc (sucursal, btrim(c4), btrim(c6)) WHERE c2='X' AND c3='A'`, y del documento al renglón
 * por la llave de `kdm2`. Mismas condiciones que la rama de entradas de la función: almacén principal
 * (`c1 = sucursal`), sin cancelados (`c43 <> 'C'`), el SKU por `c8`.
 * Parámetros: `?::text[]` plazas, `?::text[]` folios (pares, misma posición), `?::date` desde y `?::date` hasta (la
 * primera y la última fecha de esas entradas: acota el peor plan a esa ventana, `ix_kdm1_compra_fecha`) y `?::text[]`
 * los SKU. Medido en la base local (213 documentos, 14 SKU): 2.3 ms. En prod NO MEDIDO.
 */
export const COMPRA_RENGLONES_SQL = `
  SELECT btrim(l.c8::text)                    AS sku,
         btrim(h.sucursal::text)              AS plaza,
         to_char(h.c9::date, 'YYYY-MM-DD')    AS fecha,
         btrim(h.c6::text)                    AS folio,
         round(coalesce(nullif(regexp_replace(l.c13::text, '[^0-9.-]', '', 'g'), '')::numeric, 0), 2) AS importe,
         nullif(regexp_replace(l.c17::text, '[^0-9.-]', '', 'g'), '')::numeric AS iva,
         nullif(regexp_replace(l.c18::text, '[^0-9.-]', '', 'g'), '')::numeric AS ieps
    FROM (SELECT DISTINCT d.plaza, d.folio FROM unnest(?::text[], ?::text[]) AS d(plaza, folio)) d
    JOIN kepler_ods.kdm1 h
      ON h.sucursal = d.plaza AND h.c2 = 'X' AND h.c3 = 'A' AND btrim(h.c4::text) = '20' AND btrim(h.c6) = d.folio
    JOIN kepler_ods.kdm2 l
      ON l.sucursal = h.sucursal AND l.c1 = h.c1 AND l.c2 = h.c2 AND l.c3 = h.c3
     AND l.c4 = h.c4 AND l.c5 = h.c5 AND l.c6 = h.c6
   WHERE btrim(h.c1::text) = h.sucursal::text
     AND btrim(coalesce(h.c43::text, '')) <> 'C'
     AND h.c9::date BETWEEN ?::date AND ?::date
     AND nullif(btrim(l.c8::text), '') = ANY(?::text[])`;
