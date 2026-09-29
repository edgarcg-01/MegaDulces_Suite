import type { Knex } from 'knex';
import { vendorTodayRouteIdsSql } from './vendor-cartera.sql';

/**
 * `[VK.4]` Cartera gobernada por Kepler — sincroniza el ANCLA de los clientes de las rutas
 * de HOY del usuario que estén ligadas a un vendedor Kepler (`trade.catalogs.erp_vendor_code`).
 * Plan: docs/IMPLEMENTACION/FASES/FASE_VK_CARTERA_KEPLER.md
 *
 * Por qué un ancla y no leer la vista directo: 16 tablas (pedidos, visitas, pagos...) tienen FK a
 * `commercial.customers`. La fila ancla solo aporta el `id` y lo PROPIO (GPS, orden de visita,
 * WhatsApp); lo de Kepler (nombre, ruta, crédito, domicilio) se REFRESCA desde la vista en cada llamada:
 *
 *   1. Crea el ancla de los clientes de la vista que aún no la tienen.
 *   2. Refresca nombre / ruta / crédito / plazo / domicilio / RFC de los que ya la tienen (Kepler
 *      manda). `[VK.2.1]` Teléfono y correo: lo capturado en campo gana, Kepler solo llena huecos.
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
): Promise<ErpCarteraSync> {
  const routes: { id: string }[] = await trx('trade.catalogs as cat')
    .where('cat.catalog_id', 'rutas')
    .whereNull('cat.deleted_at')
    .whereNotNull('cat.erp_vendor_code')
    .whereRaw(`cat.id IN (${vendorTodayRouteIdsSql()})`, [userId])
    .select('cat.id');
  return syncErpCarteraForRoutes(trx, routes.map((r) => r.id));
}

export interface ErpCarteraSync {
  routes: number;
  created: number;
  refreshed: number;
  released: number;
}

/**
 * `[VK.4.1]` Lo mismo que `syncErpCarteraForToday`, pero para rutas dadas (ids de `catalogs`).
 * Lo usa la pantalla del supervisor (`dayPickState`): al abrirla, las rutas Kepler de TODO su
 * equipo quedan al día — no solo la de hoy —, así el conteo de clientes de cada opción es real y
 * "Buscar cliente" ya encuentra a los clientes de rutas que nadie ha abierto todavía.
 * Las rutas sin liga Kepler se ignoran (una consulta chica y regresa).
 */
export async function syncErpCarteraForRoutes(
  trx: Knex | Knex.Transaction,
  candidateRouteIds: string[],
): Promise<ErpCarteraSync> {
  const none = { routes: 0, created: 0, refreshed: 0, released: 0 };
  if (!candidateRouteIds.length) return none;
  const routes: { id: string; value: string }[] = await trx('trade.catalogs as cat')
    .where('cat.catalog_id', 'rutas')
    .whereNull('cat.deleted_at')
    .whereNotNull('cat.erp_vendor_code')
    .whereIn('cat.id', candidateRouteIds)
    .select('cat.id', 'cat.value');
  if (!routes.length) return none;

  const routeIds = routes.map((r) => r.id);
  const routeValues = routes.map((r) => r.value);
  // knex.raw expande un arreglo en '?, ?, ...': se arman los placeholders a mano.
  const idsPh = routeIds.map(() => '?').join(', ');
  const valuesPh = routeValues.map(() => '?').join(', ');

  // Domicilio de la ficha (kdud c4 calle / c5 colonia-ciudad / c6 estado / c27 CP) en la forma de
  // `AddressJsonb`. `source: 'kepler'` declara de dónde salió. Sin nada → NULL (no un objeto vacío).
  const ADDR = `NULLIF(jsonb_strip_nulls(jsonb_build_object(
      'street', v.direccion, 'neighborhood', v.ciudad, 'state', v.estado,
      'zip', CASE WHEN v.codigo_postal ~ '^[0-9]{5}$' THEN v.codigo_postal END,
      'source', 'kepler')), '{"source":"kepler"}'::jsonb)`;
  // Columnas acotadas (rfc varchar(13), phone 50, email 200): un dato sucio de Kepler NO debe
  // tumbar la sincronización de toda la ruta. RFC fuera de 12–13 caracteres = NULL.
  const RFC = `CASE WHEN length(v.rfc) BETWEEN 12 AND 13 THEN v.rfc END`;
  const TEL = `left(v.telefono, 50)`;
  const MAIL = `left(v.email, 200)`;

  // 1. Anclas nuevas. Código legible y estable: K<sucursal>-<clave Kepler> (ej. K04-10281).
  const created = await trx.raw(
    `INSERT INTO commercial.customers
       (tenant_id, code, name, credit_limit, payment_terms_days, sales_route,
        erp_source_branch, erp_customer_code, default_price_list_id, active,
        shipping_address, rfc, phone, email)
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
            true,
            ${ADDR},
            ${RFC},
            ${TEL},
            ${MAIL}
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

  // 2. Kepler manda en lo suyo (nombre, ruta, crédito, plazo, domicilio, RFC real). Teléfono y
  //    correo son al revés: Kepler solo los trae en el 2.4% y el vendedor los captura en campo,
  //    así que lo capturado GANA y Kepler solo llena el hueco. GPS, orden y WhatsApp no se tocan.
  const refreshed = await trx.raw(
    `UPDATE commercial.customers c
        SET name = left(v.nombre, 200),
            sales_route = v.route,
            credit_limit = COALESCE(v.limite_credito, 0),
            payment_terms_days = COALESCE(v.plazo_dias, 0)::int,
            shipping_address = ${ADDR},
            rfc = COALESCE(${RFC}, c.rfc),
            phone = COALESCE(NULLIF(c.phone, ''), ${TEL}),
            email = COALESCE(NULLIF(c.email, ''), ${MAIL}),
            updated_at = now()
       FROM analytics.v_route_cartera_erp v
      WHERE v.route_id IN (${idsPh})
        AND c.erp_source_branch = v.erp_source_branch
        AND c.erp_customer_code = v.erp_customer_code
        AND c.deleted_at IS NULL
        AND (c.name IS DISTINCT FROM left(v.nombre, 200)
          OR c.sales_route IS DISTINCT FROM v.route
          OR c.credit_limit IS DISTINCT FROM COALESCE(v.limite_credito, 0)
          OR c.payment_terms_days IS DISTINCT FROM COALESCE(v.plazo_dias, 0)::int
          OR c.shipping_address IS DISTINCT FROM ${ADDR}
          OR c.rfc IS DISTINCT FROM COALESCE(${RFC}, c.rfc)
          OR (NULLIF(c.phone, '') IS NULL AND v.telefono IS NOT NULL)
          OR (NULLIF(c.email, '') IS NULL AND v.email IS NOT NULL))`,
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
