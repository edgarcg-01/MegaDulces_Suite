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

import type { Freshness } from './provenance.contract';

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
  /**
   * De cuándo es el dato (VP.2.3): la venta sale del ODS de Kepler, que alimenta el carril
   * `ods_live_hot`. `generated_at` sólo dice cuándo respondió el servidor.
   */
  freshness: Freshness;
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

/**
 * `[MCP.3.10]` Resumen de UN vendedor para «Asignar rutas»: su meta de la catorcena contra lo cobrado,
 * sus días de la catorcena y lo que ya tiene configurado (ruta, sucursal, clientes de su ruta).
 *
 * Los días se arman con el MISMO armado del tablero (`VisitMonitorService.buildDay`), uno por día,
 * así que «visitados» y «cobrado» de un día cuadran con lo que el tablero mostró ese día.
 */
export interface VendorSummaryDay {
  /** `YYYY-MM-DD`. */
  date: string;
  /** Códigos de ruta de ese día (ej. `1V003`); vacío = no tuvo ruta. */
  routes: string[];
  customers_total: number;
  customers_visited: number;
  /** Clientes con pedido ese día. */
  orders: number;
  /** Venta cobrada en Kepler ese día; `null` + motivo si no se pudo medir. */
  sales: BoardSales;
}

export interface VendorSummaryRoute {
  /** Valor de catálogo (ej. «1V003 PAULINA …»). */
  route: string;
  /** Código Kepler (ej. `1V003`) o `null` si la ruta no lo declara. */
  code: string | null;
  /** Sucursal de surtido de la ruta; `null` = sin asignar. */
  warehouse_name: string | null;
  /**
   * Clientes de la ruta (todos, sin filtrar por día de visita). Es la meta de visitas: el vendedor
   * debe visitar a los clientes de su ruta (decisión de David, 2026-10-22: se deriva, no se captura).
   */
  customers: number;
}

/**
 * Un día de la AGENDA semanal del vendedor (`public.daily_assignments`). Es la ruta que manda:
 * la app del vendedor arma su lista de clientes con la elección del día o, si no hay, con ésta
 * (`vendor-cartera.sql.ts`), y el tablero la lee igual. NO es `vendor_sales_routes`, que la app
 * del vendedor no usa.
 */
export interface VendorAgendaDay {
  /** ISO: 1 = lunes … 7 = domingo. */
  day_of_week: number;
  /** id de la fila de la agenda (para quitarla). */
  assignment_id: string;
  route_id: string;
  /** Valor de catálogo (ej. «1V003 PAULINA …»). */
  route: string;
}

/** Ruta que se le puede poner: del catálogo, de su zona y del tipo de ruta de quien consulta. */
export interface VendorRouteOption {
  id: string;
  route: string;
  /** Código Kepler (ej. `1V003`) o `null`. */
  code: string | null;
}

export interface VendorSummaryResponse {
  user_id: string;
  name: string;
  /** `YYYY-MM-DD` consultado (hora de México). */
  date: string;
  period: BoardPeriod;
  /** Meta de la catorcena en pesos; `null` = sin capturar. */
  target: number | null;
  /** Cobrado en Kepler desde el inicio de la catorcena hasta `date`. */
  sales_period: BoardSales;
  /** Avance contra la meta; `null` si falta meta o venta. */
  progress_pct: number | null;
  /** ¿Quien consulta puede capturar la meta? */
  can_set_targets: boolean;
  /** Las rutas de su agenda semanal (o, si no tiene agenda, las del último día de la catorcena que trabajó). */
  routes: VendorSummaryRoute[];
  /** Días de la catorcena hasta `date`, del más reciente al más viejo. */
  days: VendorSummaryDay[];
  /** Su agenda semanal, un renglón por día que tiene ruta (los días sin ruta no vienen). */
  agenda: VendorAgendaDay[];
  /** Rutas que se le pueden asignar (las mismas que acepta `POST /daily-assignments`). */
  route_options: VendorRouteOption[];
  /** De cuándo es la venta (VP.2.3). */
  freshness: Freshness;
}
