/**
 * `[MCP.3.9]` Tablero del supervisor de ventas: sus vendedores, desglosados.
 *
 * Pedido de David (2026-10-22) sobre «Cartera de ventas»: quitar todo lo demás y mostrar, por cada
 * vendedor de SU equipo y SU tipo de ruta (el supervisor de Ruta Vecinal sólo ve vecinales; el de
 * Ruta Directa, sólo las que no son vecinales):
 *  · a qué hora inició y terminó su ruta;
 *  · qué clientes de su ruta ya visitó y cuáles no;
 *  · su venta COBRADA EN KEPLER (sólo esa: decisión de David) — del día y de la catorcena;
 *  · su META de la catorcena, que captura el supervisor en pesos por vendedor, y el avance.
 *
 * La catorcena son DOS semanas de nómina seguidas, sábado → viernes (la nómina de ContPAQi es
 * semanal sáb→vie). El sábado de arranque vive en una sola constante del servidor y se declara en
 * la respuesta (`period`), para que nadie tenga que adivinarlo.
 *
 * Lo que no se pudo medir se DECLARA (`null` + motivo), nunca se dibuja como $0.
 */

/** Tipo de ruta que ve quien consulta. `null` = todas (superadmin, admin). */
export type BoardRouteScope = 'vecinal' | 'directa' | null;

export interface BoardPeriod {
  /** `YYYY-MM-DD` (sábado). */
  start: string;
  /** `YYYY-MM-DD` (viernes, 13 días después). */
  end: string;
  /** Días transcurridos de la catorcena hasta la fecha consultada (1–14). */
  day: number;
}

export interface BoardCustomer {
  customer_id: string;
  name: string;
  code: string | null;
  /** ISO 8601 de la visita; `null` = no lo visitó. */
  visited_at: string | null;
  /** Resultado de la visita: con_pedido | sin_pedido | abierta; `null` si no lo visitó. */
  result: 'con_pedido' | 'sin_pedido' | 'abierta' | null;
  /** Motivo de «no pidió nada», si lo hay. */
  reason: string | null;
}

export interface BoardSales {
  /** Venta cobrada en Kepler (con impuestos), en pesos. `null` = no se pudo medir. */
  amount: number | null;
  /** Tickets/documentos cobrados. */
  tickets: number | null;
  /** Por qué no se midió (`null` si se midió). */
  unmeasured_reason: string | null;
}

export interface BoardVendor {
  user_id: string;
  name: string;
  /** Códigos de ruta del día (ej. `1V003`). */
  routes: string[];
  day_state: 'sin_iniciar' | 'en_ruta' | 'finalizada';
  /** ISO 8601. */
  started_at: string | null;
  /** ISO 8601. */
  finished_at: string | null;
  customers_total: number;
  customers_visited: number;
  /** Visitados primero (por hora), luego los no visitados (en el orden de la ruta). */
  customers: BoardCustomer[];
  /** Venta cobrada en Kepler el día consultado. */
  sales_day: BoardSales;
  /** Venta cobrada en Kepler desde el inicio de la catorcena hasta el día consultado. */
  sales_period: BoardSales;
  /** Meta de la catorcena en pesos. `null` = nadie la ha capturado. */
  target: number | null;
  /** Avance contra la meta, 0–100+ (puede pasar de 100). `null` si falta meta o venta. */
  progress_pct: number | null;
}

export interface SupervisorBoardResponse {
  /** `YYYY-MM-DD` consultado (hora de México). */
  date: string;
  period: BoardPeriod;
  scope: BoardRouteScope;
  /** Etiqueta de pantalla del alcance («Rutas vecinales», «Ruta directa») o `null`. */
  scope_label: string | null;
  /** ¿Quien consulta puede capturar metas? */
  can_set_targets: boolean;
  vendors: BoardVendor[];
  totals: {
    vendors: number;
    customers_total: number;
    customers_visited: number;
    sales_day: number | null;
    sales_period: number | null;
    target: number | null;
  };
  /** ISO 8601: cuándo se armó la respuesta. */
  generated_at: string;
}

export interface SetVendorTargetRequest {
  user_id: string;
  /** `YYYY-MM-DD`: sábado de inicio de la catorcena. */
  period_start: string;
  /** Pesos. `null` borra la meta. */
  amount: number | null;
}

export interface SetVendorTargetResponse {
  user_id: string;
  period_start: string;
  amount: number | null;
}
