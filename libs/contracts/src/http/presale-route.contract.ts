/**
 * `[MCP.3.6]` Ruta del vendedor y surtido de la ruta como UN pedido global.
 *
 * El vendedor inicia su ruta, levanta pedidos y la finaliza. Al finalizar, al surtidor le llega UN
 * pedido global: el total de cada producto de todos los pedidos de esa ruta, con cuánto va para cada
 * cliente. El surtidor lo recolecta en una vuelta y lo reparte en una bolsa por cliente. Si no
 * alcanzó, se reparte con la regla fija de `commercial-picking/allocation.ts` (primero lo que se
 * entrega antes, luego lo que se confirmó antes, luego el folio) y a cada pedido se le quita lo que
 * no hubo, igual que en el surtido por pedido (`[MCP.3]`).
 *
 * Qué pedidos son de la ruta: los de preventa (`delivery_type='route'`, `confirmed`) que la persona
 * confirmó entre que inició y finalizó. Lo que confirma después de finalizar va a la tanda «fuera de
 * la ruta», que también es un pedido global. Sólo lo levantado SIN haber iniciado ruta llega suelto.
 */

/** `sin_iniciar` = hoy no hay ruta; `en_ruta` = iniciada; `finalizada` = cerrada por el vendedor. */
export type SellerRouteDayState = 'sin_iniciar' | 'en_ruta' | 'finalizada';

export interface SellerRouteDay {
  /** Id de `commercial.seller_route_days`; `null` si hoy no ha iniciado. */
  id: string | null;
  /** `YYYY-MM-DD` en hora de México. */
  work_date: string;
  state: SellerRouteDayState;
  /** ISO 8601. */
  started_at: string | null;
  /** ISO 8601. */
  finished_at: string | null;
  /**
   * Clientes DISTINTOS que la persona visitó dentro de la ventana de la ruta (inicio → fin, o
   * ahora si sigue en ruta), según `commercial.vendor_visits`. Es el dato principal al finalizar.
   */
  visited: number;
  /** Pedidos confirmados dentro de la ruta (hasta ahora, si sigue en ruta). */
  orders: number;
  /** Suma de sus totales. */
  total: number;
}

/** Estado de la ruta del lado del surtidor. */
export type RouteBatchState = 'en_ruta' | 'lista' | 'surtiendo' | 'surtida';

export interface RouteBatchPerson {
  user_id: string;
  name: string;
  /** ISO 8601. */
  at: string;
}

/**
 * `ruta` = lo levantado entre «Iniciar» y «Finalizar». `fuera_de_ruta` = lo levantado DESPUÉS de
 * finalizar: también llega como un solo pedido global (decisión de David, 2026-10-21); se cierra
 * cuando el surtidor empieza a recolectarlo y lo que llegue después abre otra tanda.
 */
export type RouteBatchKind = 'ruta' | 'fuera_de_ruta';

export interface RouteBatchRow {
  route_day_id: string;
  kind: RouteBatchKind;
  seller_name: string | null;
  work_date: string;
  state: RouteBatchState;
  /** ISO 8601. */
  started_at: string;
  /** ISO 8601; `null` mientras sigue en ruta. */
  finished_at: string | null;
  orders: number;
  /** Productos distintos en el pedido global. */
  products: number;
  /**
   * `[MCP.3.13]` Quién empezó / terminó la parte de TU sucursal (la ruta se surte por sucursal:
   * `commercial.seller_route_day_picks`). Una ruta surtida antes de ese cambio trae el dueño único
   * de siempre.
   */
  pick_started: RouteBatchPerson | null;
  pick_finished: RouteBatchPerson | null;
  /**
   * `[MCP.3.13]` Sucursales (etiqueta corta) que surten OTRAS partes de los pedidos agrupados de esta
   * ruta. `[]` = la ruta no trae pedidos agrupados con otras sucursales.
   */
  group_other_warehouses?: string[];
}

export interface RouteBatchInboxResponse {
  today: string;
  data: RouteBatchRow[];
  scope: 'todos' | 'propios' | 'ninguno';
}

/** Lo que le toca a un cliente de un producto, en la unidad en que se pidió. */
export interface RouteBatchClientShare {
  order_id: string;
  code: string;
  customer_name: string | null;
  qty: number;
  unit: string;
}

/** Un renglón del pedido global: un producto con su total y a quién le toca. */
export interface RouteBatchProduct {
  product_id: string;
  sku: string | null;
  barcode: string | null;
  product_name: string;
  /** Marca, para ordenar la vuelta mientras no hay ubicaciones dadas de alta. */
  brand: string | null;
  /**
   * Total en la unidad que se recolecta. Si todos los clientes lo pidieron en la misma unidad, es
   * esa (`3 CJA`); si no, se muestra en unidad base (`PZA`).
   */
  qty: number;
  unit: string;
  /** Piezas de unidad base por `unit`. */
  factor: number;
  /** Total en unidad base (`qty × factor`), para decir «= 90 piezas». */
  base_qty: number;
  clients: RouteBatchClientShare[];
}

export interface RouteBatchDetail {
  route: RouteBatchRow;
  /** Ordenado por marca y nombre: así se recorre el almacén. */
  products: RouteBatchProduct[];
}

export interface RouteBatchFinishRequest {
  /** Uno por cada producto del pedido global: cuánto se encontró, en la `unit` del producto. */
  products: Array<{ product_id: string; picked: number }>;
}

/** Una bolsa: lo que quedó en un pedido después de repartir. */
export interface RouteBatchBagLine {
  product_name: string;
  unit: string;
  ordered: number;
  picked: number;
}

export interface RouteBatchBag {
  order_id: string;
  code: string;
  customer_name: string | null;
  outcome: 'completo' | 'con_faltantes' | 'sin_mercancia';
  lines: RouteBatchBagLine[];
  total_before: number;
  total_after: number;
  /** `[MCP.3.13]` Igual que en `PresalePickInboxRow`: folio del principal del grupo; `null` = suelto. */
  group_code?: string | null;
  group_parts?: number | null;
  group_other_warehouses?: string[];
}

export interface RouteBatchFinishResponse {
  route_day_id: string;
  bags: RouteBatchBag[];
}
