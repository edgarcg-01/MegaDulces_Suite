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
