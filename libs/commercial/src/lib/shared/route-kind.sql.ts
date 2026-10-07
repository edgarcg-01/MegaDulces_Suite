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

// ⚠️ El tipo y sus etiquetas NO se declaran acá: viven en `libs/contracts`, porque el frontend
// los necesita igual. ADR-052 midió que un tipo de backend copiado a mano al front diverge a los
// tres días — y una etiqueta divergente no falla, sólo muestra la clave pelada en una pantalla.
export {
  ROUTE_KINDS,
  ROUTE_KIND_LABEL,
  ROUTE_KIND_SIN_DECLARAR,
  routeKindLabel,
  type RouteKind,
} from '@megadulces/contracts';

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

/**
 * `[SV.0]` — El CÓDIGO de la ruta, el que habla el ODS.
 *
 * ── El problema que esto resuelve ───────────────────────────────────────────────────────
 * Hay **dos vocabularios de ruta** en el sistema y nadie los había cruzado:
 *
 *   · El mundo de la app (`trade.catalogs.value`, `customers.sales_route`) guarda
 *     **tres formatos en el mismo campo**: 'RUTA 23', '1V001 CANDELARIA SALGADO MORALES'
 *     (código **y nombre del vendedor pegados**) y '502' pelado.
 *   · El mundo del ODS (`analytics.v_rd_route_daily.route_code`,
 *     `commercial.commission_route_config.route_code`, y el `scope_key` de una meta con
 *     `scope='route'`) habla sólo el código pelado: '23', '1V001', '502'.
 *
 * Medido contra prod el 2026-10-06: con el join directo `value = route_code` empata **1 de 19**
 * rutas. Con esta función, **19 de 19 y $0 de venta sin empatar**.
 *
 * ── Por qué es conservador a propósito ──────────────────────────────────────────────────
 * Resuelve SÓLO las cuatro formas que puede probar, y lo demás lo devuelve NULL para que el
 * consumidor lo declare. La tentación es "tomar el último número", y eso rompe: en el catálogo
 * real hay 'Ruta Vecinal Padre Hidalgo 1' y 'Ruta mayoreo 01', que esa regla mandaría a las
 * rutas 1 y 01 — **venta de otro supervisor atribuida al tuyo, sin un solo error en pantalla**.
 * Los 5 rótulos que quedan sin código (3 'Ruta Vecinal (plaza)', 'Ruta mayoreo 01' y
 * 'SUCURSAL PADRE HIDALGO MAYOREO') **no vendieron nada en 30 días**: son rótulos, no rutas.
 *
 * La cuarta regla pide 4+ dígitos para la forma 'codigo nombre' porque los únicos observados
 * son de 5 ('10001', '10002', '20005'). Si mañana aparece '21 JUAN PEREZ' NO se resuelve: se
 * declara. Es la respuesta correcta — y el candado lo ve, porque la cobertura baja.
 *
 * ⚠️ **No uses `\s` en estos regex.** Medido en `[VEC.1]` por tres caminos: esta base lo lee
 * como una letra 's'. Van espacios literales.
 *
 * ⚠️ **Dos filas del catálogo pueden dar el MISMO código**: hoy 'Ruta 501'/'RUTA 501' y
 * '502'/'RUTA 502'. Hoy no cuelga nadie de la fila gemela (medido: 0 y 0 · 1 y 0), así que no
 * hay doble conteo — pero lo habrá el día que alguien asigne un vendedor a 'RUTA 502'. Por eso
 * todo consumidor agrupa por CÓDIGO, nunca por fila del catálogo, y el candado lo vigila.
 */
export function routeCodeSql(valueExpr: string): string {
  return `(CASE
             WHEN btrim(${valueExpr}) ~ '^[0-9]+$'
               THEN btrim(${valueExpr})
             WHEN upper(btrim(${valueExpr})) ~ '^RUTA +[0-9]+$'
               THEN regexp_replace(upper(btrim(${valueExpr})), '^RUTA +', '')
             WHEN split_part(btrim(${valueExpr}), ' ', 1) ~ '^[0-9]+[A-Z][0-9]+$'
               THEN split_part(btrim(${valueExpr}), ' ', 1)
             WHEN split_part(btrim(${valueExpr}), ' ', 1) ~ '^[0-9]{4,}$'
               THEN split_part(btrim(${valueExpr}), ' ', 1)
             ELSE NULL
           END)`;
}

/**
 * `[SV.1]` — Las rutas de UN supervisor, en el vocabulario del ODS.
 *
 * ── Por qué el organigrama y no el mapa de comisiones ───────────────────────────────────
 * Los dos existen y los dos están a medias. Medido contra prod el 2026-10-06:
 *
 *   · `commercial.commission_route_config` tiene 13 rutas con `supervisor_nombre`, pero
 *     **`supervisor_user_id` está en 0 de 13** — o sea que no se puede resolver desde el
 *     usuario que inició sesión sin casar texto. De sus 3 nombres, **uno no tiene cuenta**.
 *     Y le faltan las **8 rutas vecinales**, que vendieron **$2.1M en 30 días**.
 *   · `identity.users.supervisor_id` es una FK real y cubre más: **22 reportes con ruta,
 *     19 rutas distintas**, vecinales incluidas.
 *
 * ⚠️ Devuelve un conjunto de CÓDIGOS, no de filas del catálogo: dos vendedores en
 * 'Ruta 501' y 'RUTA 501' son **una sola ruta**, y sumar las dos filas duplicaría su venta.
 *
 * ⚠️ Un supervisor sin reportes con ruta devuelve el conjunto VACÍO, y eso **no es lo mismo**
 * que "no tiene alcance": el consumidor tiene que distinguir "no le toca ninguna ruta" de
 * "nadie le declaró el equipo". Hoy es el caso de 3 de las 6 cuentas de supervisor.
 */
export function supervisorRouteCodesSql(supervisorIdParam = '?'): string {
  return `(SELECT array_agg(DISTINCT cod) FROM (
             SELECT ${routeCodeSql('tc.value')} AS cod
               FROM identity.users u
               JOIN trade.catalogs tc
                 ON tc.id = u.route_id
                AND tc.tenant_id = u.tenant_id
                AND tc.catalog_id = 'rutas'
                AND tc.deleted_at IS NULL
              WHERE u.supervisor_id = ${supervisorIdParam}
                AND u.deleted_at IS NULL
           ) s WHERE cod IS NOT NULL)`;
}
