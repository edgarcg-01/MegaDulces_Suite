/**
 * `[VEC.2]` — De qué TIPO de ruta es un pedido.
 *
 * ── Por qué es una derivación y no una columna ──────────────────────────────────────────
 * La primera versión de este plan agregaba `commercial.orders.sales_route_id`. Medir lo tiró:
 *
 *   · `commercial.customers.sales_route` está poblada en **937 de 948 (98.8%)** y su TEXTO mapea
 *     **exacto** a `trade.catalogs.value` — es el mismo join que la cartera del vendedor ya hace
 *     (`vendor-cartera.sql.ts`).
 *   · De los 62 pedidos vivos en prod, **58 resuelven ruta** por esta vía y **0** apuntan a una
 *     ruta que no exista en el catálogo.
 *
 * Una columna nueva habría sido una **segunda materialización de algo ya derivable**, que es
 * justo lo que la regla principal del proyecto prohíbe. Además esto funciona **hacia atrás**:
 * los 58 pedidos que ya existen quedan clasificados sin backfill.
 *
 * ⛔ **NO uses `commercial.orders.route_id` para esto.** Es una trampa doble:
 *   1. Su FK apunta a **`logistics.routes`** (rutas de EMBARQUE: origen, destino, comisión de
 *      chofer), no a las rutas de venta. **0 de las 29** rutas de venta existen ahí.
 *   2. `createDraft` lo escribe como `customer.route_id`… que está **NULL en 948 de 948**
 *      clientes. O sea que hoy es código muerto, y el día que alguien pueble esa columna con un
 *      id de `trade.catalogs` el INSERT va a reventar contra la FK.
 *
 * ── La ruta del CLIENTE, no la del vendedor ─────────────────────────────────────────────
 * Decisión consciente. La ola agrupa mercancía para que salga por una ruta de reparto, y quien
 * define eso es el cliente que la recibe. En el flujo normal coinciden (la cartera del vendedor
 * ES "los clientes cuya `sales_route` es mi ruta de hoy"), pero divergen en dos casos reales:
 * cuando un supervisor toma el pedido, y cuando el vendedor usa "Clientes otras rutas"
 * (`[VS.1]`). En los dos, lo que manda para armar es a dónde va la mercancía.
 *
 * ⚠️ **Es derivación, no foto.** Si un cliente cambia de ruta, sus pedidos VIEJOS se releen con
 * la ruta nueva. Para la ola da igual (sólo mira pedidos abiertos del día), pero si alguna vez
 * hace falta reconstruir "por qué este pedido entró a esa ola" meses después, hay que sacar una
 * foto en ese momento — hoy no existe y se declara.
 */

/** Los valores de `trade.catalogs.route_kind`. Espejo del CHECK de la migración `20261006130000`. */
export type RouteKind = 'vecinal' | 'camion' | 'telemarketing' | 'mayoreo' | 'piso';

export const ROUTE_KINDS: readonly RouteKind[] = [
  'vecinal',
  'camion',
  'telemarketing',
  'mayoreo',
  'piso',
] as const;

/** Etiqueta de pantalla. Fuente única: una ruta nueva no sale como `'camion'` pelado. */
export const ROUTE_KIND_LABEL: Record<RouteKind, string> = {
  vecinal: 'Vecinal',
  camion: 'Camión',
  telemarketing: 'Telemarketing',
  mayoreo: 'Mayoreo',
  piso: 'Piso',
};

/** Lo que se muestra cuando NADIE declaró el tipo. No es 'Otro': es una ausencia con nombre. */
export const ROUTE_KIND_SIN_DECLARAR = 'Sin declarar';

export function routeKindLabel(k: string | null | undefined): string {
  return k && k in ROUTE_KIND_LABEL ? ROUTE_KIND_LABEL[k as RouteKind] : ROUTE_KIND_SIN_DECLARAR;
}

/**
 * Sub-select de UNA columna con la ruta del pedido, lista para la lista de selección.
 *
 * `customerAlias` = alias de `commercial.customers` en el query (default `c`).
 * `col` = qué traer: `'route_kind'` (el tipo) o `'value'` (el nombre de la ruta).
 *
 * Devuelve NULL cuando el cliente no tiene `sales_route` **o** cuando su ruta no está declarada.
 * Son dos ausencias distintas y el consumidor las separa con `routeKindMotivoSql`.
 */
export function orderRouteSql(customerAlias = 'c', col: 'route_kind' | 'value' = 'route_kind'): string {
  return `(SELECT tc.${col}
             FROM trade.catalogs tc
            WHERE tc.catalog_id = 'rutas'
              AND tc.deleted_at IS NULL
              AND tc.value = ${customerAlias}.sales_route
            LIMIT 1)`;
}

/**
 * Por qué no hay tipo de ruta, cuando no lo hay. **`NULL` no alcanza**: "el cliente no tiene ruta"
 * lo arregla quien captura el cliente, y "la ruta no está declarada" lo arregla Dirección. Si las
 * dos se ven igual, nadie sabe a quién llamar (ADR-056).
 */
export function routeKindMotivoSql(customerAlias = 'c'): string {
  return `(CASE
             WHEN ${customerAlias}.sales_route IS NULL           THEN 'cliente_sin_ruta'
             WHEN ${orderRouteSql(customerAlias, 'route_kind')} IS NULL THEN 'ruta_sin_declarar'
             ELSE NULL
           END)`;
}

/**
 * Fragmento para el WHERE: el pedido es de una ruta de alguno de estos tipos.
 *
 * ⚠️ Pasar una lista VACÍA devuelve `TRUE` (no filtra), nunca `FALSE`. Un filtro vacío que
 * borrara todo se lee en pantalla igual que "no hay pedidos", y esa confusión ya costó caro
 * en este proyecto.
 */
export function routeKindFilterSql(kinds: readonly string[], customerAlias = 'c'): string {
  if (!kinds.length) return 'TRUE';
  const lista = kinds.map((k) => `'${k.replace(/'/g, "''")}'`).join(',');
  return `${orderRouteSql(customerAlias, 'route_kind')} IN (${lista})`;
}
