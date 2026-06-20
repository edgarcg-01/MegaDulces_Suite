/**
 * Cartera del vendedor = los clientes que visita HOY.
 *
 * Dos condiciones combinadas:
 *  1. `customers.visit_days` contiene el ISODOW de hoy (TZ MX) — O está vacío/NULL.
 *     visit_days es un refinamiento OPCIONAL: si está poblado filtra por día; si
 *     el cliente NO tiene días configurados, entra siempre que su ruta sea la del
 *     día (antes {}/NULL lo excluía, lo que dejaba la cartera casi vacía porque la
 *     mayoría de clientes nunca tuvo visit_days cargado).
 *  2. La ruta del cliente (`sales_route`) está asignada al vendedor para hoy en
 *     trade (`daily_assignments` → vista `catalogs` catalog_id='rutas', cuyo
 *     `value` "RUTA 27" mapea EXACTO a `sales_route`). day_of_week también ISO.
 *
 * ISODOW (1=lun..7=dom), NO `DOW` (0=domingo), para coincidir con la convención
 * del front (daily-assignments) y con la columna visit_day.
 *
 * Fragmento para `.whereRaw(sql, [userId])`. `customerAlias` = alias de
 * commercial.customers en el query (default 'c').
 */
export function vendorTodayRouteExistsSql(customerAlias = 'c'): string {
  return `(
    (
      ${customerAlias}.visit_days IS NULL
      OR cardinality(${customerAlias}.visit_days) = 0
      OR ${customerAlias}.visit_days @> ARRAY[EXTRACT(ISODOW FROM (now() AT TIME ZONE 'America/Mexico_City'))::smallint]
    )
    AND EXISTS (
      SELECT 1
      FROM public.daily_assignments da
      JOIN public.catalogs cat
        ON cat.id = da.route_id AND cat.catalog_id = 'rutas' AND cat.deleted_at IS NULL
      WHERE da.user_id = ?
        AND cat.value = ${customerAlias}.sales_route
        AND da.day_of_week = EXTRACT(ISODOW FROM (now() AT TIME ZONE 'America/Mexico_City'))::int
    )
  )`;
}
