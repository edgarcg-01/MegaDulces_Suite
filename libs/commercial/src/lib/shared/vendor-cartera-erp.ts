import type { Knex } from 'knex';
import { vendorTodayRouteIdsSql } from './vendor-cartera.sql';

/**
 * `[VK.4]` Cartera gobernada por Kepler — sincroniza el ANCLA de los clientes de las rutas
 * de HOY del usuario que estén ligadas a un vendedor Kepler (`trade.catalogs.erp_vendor_code`).
 * Plan: docs/IMPLEMENTACION/FASES/FASE_VK_CARTERA_KEPLER.md
 *
 * Por qué un ancla y no leer la vista directo: 16 tablas (pedidos, visitas, pagos...) tienen FK a
 * `commercial.customers`. La fila ancla solo aporta el `id` y lo PROPIO (GPS, orden de visita,
 * WhatsApp); lo de Kepler (nombre, ruta, crédito) se REFRESCA desde la vista en cada llamada:
 *
 *   1. Crea el ancla de los clientes de la vista que aún no la tienen.
 *   2. Refresca nombre / ruta / crédito / plazo de los que ya la tienen (Kepler manda).
 *   3. Suelta (`sales_route = NULL`) a los que Kepler sacó de la ruta: dejan de salir en
 *      "Mi ruta" pero conservan su historia.
 *
 * No es un importer: no se agenda ni se re-corre. Corre al abrir la ruta, sobre la vista viva
 * (`analytics.v_route_cartera_erp`), y es idempotente — dos teléfonos a la vez no duplican
 * (`ON CONFLICT DO NOTHING` sobre `ux_customers_erp_link`).
 *
 * Para rutas manuales (sin liga Kepler) no hace nada: una sola consulta chica y regresa.
 * Debe correr dentro de `tk.run` (RLS del tenant).
 */
export async function syncErpCarteraForToday(
  trx: Knex | Knex.Transaction,
  userId: string,
): Promise<{ routes: number; created: number; refreshed: number; released: number }> {
  const routes: { id: string; value: string }[] = await trx('trade.catalogs as cat')
    .where('cat.catalog_id', 'rutas')
    .whereNull('cat.deleted_at')
    .whereNotNull('cat.erp_vendor_code')
    .whereRaw(`cat.id IN (${vendorTodayRouteIdsSql()})`, [userId])
    .select('cat.id', 'cat.value');
  if (!routes.length) return { routes: 0, created: 0, refreshed: 0, released: 0 };

  const routeIds = routes.map((r) => r.id);
  const routeValues = routes.map((r) => r.value);
  // knex.raw expande un arreglo en '?, ?, ...': se arman los placeholders a mano.
  const idsPh = routeIds.map(() => '?').join(', ');
  const valuesPh = routeValues.map(() => '?').join(', ');

  // 1. Anclas nuevas. Código legible y estable: K<sucursal>-<clave Kepler> (ej. K04-10281).
  const created = await trx.raw(
    `INSERT INTO commercial.customers
       (tenant_id, code, name, credit_limit, payment_terms_days, sales_route,
        erp_source_branch, erp_customer_code, default_price_list_id, active)
     SELECT public.current_tenant_id(),
            'K' || v.erp_source_branch || '-' || v.erp_customer_code,
            left(v.nombre, 200),
            COALESCE(v.limite_credito, 0),
            COALESCE(v.plazo_dias, 0)::int,
            v.route,
            v.erp_source_branch,
            v.erp_customer_code,
            (SELECT pl.id FROM commercial.price_lists pl
              WHERE pl.is_default AND pl.active AND pl.deleted_at IS NULL LIMIT 1),
            true
       FROM analytics.v_route_cartera_erp v
      WHERE v.route_id IN (${idsPh})
        AND NOT EXISTS (
          SELECT 1 FROM commercial.customers c
           WHERE c.erp_source_branch = v.erp_source_branch
             AND c.erp_customer_code = v.erp_customer_code
             AND c.deleted_at IS NULL)
     ON CONFLICT DO NOTHING`,
    routeIds,
  );

  // 2. Kepler manda: refresca lo que es suyo.
  const refreshed = await trx.raw(
    `UPDATE commercial.customers c
        SET name = left(v.nombre, 200),
            sales_route = v.route,
            credit_limit = COALESCE(v.limite_credito, 0),
            payment_terms_days = COALESCE(v.plazo_dias, 0)::int,
            updated_at = now()
       FROM analytics.v_route_cartera_erp v
      WHERE v.route_id IN (${idsPh})
        AND c.erp_source_branch = v.erp_source_branch
        AND c.erp_customer_code = v.erp_customer_code
        AND c.deleted_at IS NULL
        AND (c.name IS DISTINCT FROM left(v.nombre, 200)
          OR c.sales_route IS DISTINCT FROM v.route
          OR c.credit_limit IS DISTINCT FROM COALESCE(v.limite_credito, 0)
          OR c.payment_terms_days IS DISTINCT FROM COALESCE(v.plazo_dias, 0)::int)`,
    routeIds,
  );

  // 3. Los que Kepler sacó de estas rutas: se sueltan de la ruta (no se borran).
  const released = await trx.raw(
    `UPDATE commercial.customers c
        SET sales_route = NULL, updated_at = now()
      WHERE c.erp_customer_code IS NOT NULL
        AND c.deleted_at IS NULL
        AND c.sales_route IN (${valuesPh})
        AND NOT EXISTS (
          SELECT 1 FROM analytics.v_route_cartera_erp v
           WHERE v.route_id IN (${idsPh})
             AND v.erp_source_branch = c.erp_source_branch
             AND v.erp_customer_code = c.erp_customer_code)`,
    [...routeValues, ...routeIds],
  );

  return {
    routes: routes.length,
    created: created.rowCount ?? 0,
    refreshed: refreshed.rowCount ?? 0,
    released: released.rowCount ?? 0,
  };
}

/** `[VK.4]` ¿Esta ruta (por nombre) la gobierna Kepler? — las altas manuales no aplican ahí. */
export async function isErpGovernedRoute(trx: Knex | Knex.Transaction, routeValue: string): Promise<boolean> {
  // upper(): createCustomer normaliza la ruta a MAYÚSCULAS y el catálogo guarda mixto.
  const row = await trx('trade.catalogs')
    .where({ catalog_id: 'rutas' })
    .whereRaw('upper(value) = upper(?)', [routeValue])
    .whereNull('deleted_at')
    .whereNotNull('erp_vendor_code')
    .first('id');
  return !!row;
}
