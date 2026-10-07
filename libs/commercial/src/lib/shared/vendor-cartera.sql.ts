/**
 * Cartera del vendedor = los clientes que visita HOY.
 *
 * Dos condiciones combinadas:
 *  1. `customers.visit_days` contiene el ISODOW de hoy (TZ MX) — O está vacío/NULL.
 *     visit_days es un refinamiento OPCIONAL: si está poblado filtra por día; si
 *     el cliente NO tiene días configurados, entra siempre que su ruta sea la del
 *     día (antes {}/NULL lo excluía, lo que dejaba la cartera casi vacía porque la
 *     mayoría de clientes nunca tuvo visit_days cargado).
 *  2. La ruta del cliente (`sales_route`) es la ruta del usuario para hoy (vista
 *     `catalogs` catalog_id='rutas', cuyo `value` "RUTA 27" mapea EXACTO a
 *     `sales_route`). La ruta de hoy se resuelve así:
 *       a. `[VR.SUP.1]` Si el usuario ESCOGIÓ ruta para hoy
 *          (`commercial.vendor_route_day_picks`, lo usa el supervisor de ventas), manda
 *          esa y SOLO esa — reemplaza su agenda de hoy, no se suma.
 *       b. Si no escogió, su agenda semanal de trade (`daily_assignments`,
 *          day_of_week ISO).
 *     La elección del supervisor no toca la agenda del vendedor dueño: ambos la ven.
 *     El filtro de visit_days aplica igual en los dos casos, para que supervisor y
 *     vendedor vean la MISMA lista de esa ruta.
 *
 * ISODOW (1=lun..7=dom), NO `DOW` (0=domingo), para coincidir con la convención
 * del front (daily-assignments) y con la columna visit_day.
 *
 * Fragmento para `.whereRaw(sql, [userId])` — UN solo binding (el userId se reusa
 * vía el sub-select `me`), así los callers existentes no cambian. `customerAlias` =
 * alias de commercial.customers en el query (default 'c').
 *
 * ⚠️ Depende de la migración 20260928200000_vendor_route_day_picks: si el código
 * llega antes que la tabla, TODA la cartera falla. Aplicar la migración primero.
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
      FROM (
        SELECT ?::uuid AS uid,
               (now() AT TIME ZONE 'America/Mexico_City')::date AS d,
               EXTRACT(ISODOW FROM (now() AT TIME ZONE 'America/Mexico_City'))::int AS dow
      ) me
      LEFT JOIN LATERAL (
        SELECT p.route_id
        FROM commercial.vendor_route_day_picks p
        WHERE p.user_id = me.uid AND p.work_date = me.d AND p.deleted_at IS NULL
        LIMIT 1
      ) pick ON true
      JOIN public.catalogs cat
        ON cat.catalog_id = 'rutas' AND cat.deleted_at IS NULL
       AND cat.value = ${customerAlias}.sales_route
      WHERE
        (pick.route_id IS NOT NULL AND cat.id = pick.route_id)
        OR (
          pick.route_id IS NULL
          AND EXISTS (
            SELECT 1 FROM public.daily_assignments da
            WHERE da.user_id = me.uid
              AND da.route_id = cat.id
              AND da.day_of_week = me.dow
          )
        )
    )
  )`;
}

/**
 * `[VR.SUP.1]` Rutas (ids de `catalogs`) que el usuario trabaja HOY, con la misma
 * precedencia que `vendorTodayRouteExistsSql`: la elegida manda; si no hay, su agenda.
 * Sub-query de una columna `route_id`, para `whereRaw('x.route_id IN (' + sql + ')', [userId])`.
 */
export function vendorTodayRouteIdsSql(): string {
  return `
    WITH me AS (
      SELECT ?::uuid AS uid,
             (now() AT TIME ZONE 'America/Mexico_City')::date AS d,
             EXTRACT(ISODOW FROM (now() AT TIME ZONE 'America/Mexico_City'))::int AS dow
    ), pick AS (
      SELECT p.route_id FROM commercial.vendor_route_day_picks p, me
      WHERE p.user_id = me.uid AND p.work_date = me.d AND p.deleted_at IS NULL
    )
    SELECT route_id FROM pick
    UNION
    SELECT da.route_id FROM public.daily_assignments da, me
    WHERE da.user_id = me.uid AND da.day_of_week = me.dow
      AND NOT EXISTS (SELECT 1 FROM pick)`;
}
