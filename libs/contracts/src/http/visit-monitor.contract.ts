/**
 * `[MCP.3.7]` Protocolo de visitas del vendedor — lo que ve el supervisor de ventas.
 *
 * Una fila por cliente de la ruta del día de cada vendedor (más los clientes que visitó fuera de su
 * ruta). El estado se DERIVA en el servidor al consultar: no se guarda en ningún lado.
 *
 *  - De `commercial.vendor_visits`: si abrió al cliente (llegada), cuándo, desde dónde y cómo cerró.
 *  - De `commercial.orders`: si le levantó pedido ese día (aunque no haya cerrado la visita).
 *  - De `public.route_location_pings` (el GPS que la app ya manda durante la jornada): si pasó a
 *    menos del radio de un cliente con ubicación.
 *
 * Lo que no se puede saber se DECLARA, nunca se cuenta como falta ni como cumplida:
 *  - `sin_ubicacion`: el cliente no tiene coordenadas → no se puede saber si pasó.
 *  - `sin_gps`: el celular del vendedor no mandó ubicación ese día → tampoco.
 *  - `pendiente`: la ruta sigue abierta → la falta se calcula al finalizarla.
 */

/** Estado de un cliente en el día. */
export type VisitMonitorStatus =
  /** Abrió al cliente y hubo pedido (o venta directa). */
  | 'con_pedido'
  /** Abrió al cliente y cerró la visita sin pedido, con motivo. */
  | 'sin_pedido'
  /** Abrió al cliente y no cerró la visita (ni pedido ni motivo). */
  | 'abierta'
  /** Falta: estuvo dentro del radio y no abrió al cliente. */
  | 'se_fue_sin_abrir'
  /** Falta: hubo GPS del vendedor todo el día y nunca entró al radio del cliente. */
  | 'no_paso'
  /** No medido: el cliente no tiene ubicación. */
  | 'sin_ubicacion'
  /** No medido: el vendedor no mandó GPS ese día. */
  | 'sin_gps'
  /** La ruta sigue abierta: todavía no se juzga. */
  | 'pendiente';

/** Motivos de no venta (espejo de `chk_vendor_visits_no_sale_reason`). */
export type VisitNoSaleReason = 'cerrado' | 'no_atendio' | 'con_inventario' | 'sin_recursos' | 'no_interesado' | 'otro';

export interface VisitMonitorRow {
  customer_id: string;
  code: string;
  name: string;
  /** `false` = lo visitó, pero no es de su ruta de ese día. */
  on_route: boolean;
  /** El cliente tiene coordenadas (hoy; si se le capturaron en la visita, ya cuentan). */
  has_location: boolean;
  status: VisitMonitorStatus;
  no_sale_reason: VisitNoSaleReason | null;
  /** Texto del vendedor (p. ej. el detalle de «otro»). */
  notes: string | null;
  /** ISO 8601: cuándo abrió al cliente. `null` si no lo abrió. */
  visited_at: string | null;
  /** ISO 8601: cuándo cerró la visita. */
  ended_at: string | null;
  /** Metros entre el celular al abrir y el cliente. `null` = sin GPS al abrir o cliente sin ubicación. */
  distance_m: number | null;
  /** Abrió al cliente fuera del radio (más lejos que `radius_m`). */
  far: boolean;
  /** Lo más cerca que pasó según el GPS del día. `null` = no medido. */
  nearest_m: number | null;
}

/** Conteos de un vendedor (o del total). `visitados = con_pedido + sin_pedido + abiertas`. */
export interface VisitMonitorCounts {
  clientes: number;
  visitados: number;
  con_pedido: number;
  sin_pedido: number;
  abiertas: number;
  /** `se_fue_sin_abrir + no_paso`. */
  faltas: number;
  se_fue_sin_abrir: number;
  no_paso: number;
  sin_ubicacion: number;
  sin_gps: number;
  pendientes: number;
  /** Abiertos fuera del radio (de los visitados). */
  lejos: number;
}

/** Cómo quedó el día de la ruta del vendedor. */
export type VisitMonitorDayState = 'sin_iniciar' | 'en_ruta' | 'finalizada';

export interface VisitMonitorVendor {
  user_id: string;
  name: string;
  /** Rutas de ese día (valor de catálogo, p. ej. «RUTA 27»). */
  routes: string[];
  /** `eleccion` = la escogió ese día; `agenda` = su agenda semanal VIGENTE (no la de esa fecha). */
  route_source: 'eleccion' | 'agenda' | 'ninguna';
  day_state: VisitMonitorDayState;
  started_at: string | null;
  finished_at: string | null;
  /** `true` = el día ya se juzga (ruta finalizada o fecha pasada). */
  closed: boolean;
  /** Puntos de GPS que mandó ese día (los que se usaron para medir). */
  gps_points: number;
  /** ISO 8601 del primer y último punto: entre esas horas hubo GPS (fuera de ellas, no se sabe). */
  gps_first_at: string | null;
  gps_last_at: string | null;
  counts: VisitMonitorCounts;
  rows: VisitMonitorRow[];
}

export interface VisitMonitorAlcance {
  tipo_ruta: 'vecinal' | null;
  etiqueta: string | null;
}

export interface VisitMonitorResponse {
  /** `YYYY-MM-DD` consultado (hora de México). */
  date: string;
  today: string;
  radius_m: number;
  /** Precisión máxima del GPS aceptada para medir cercanía. */
  max_accuracy_m: number;
  /** `equipo` = tú y tu gente; `todos` = god-mode. */
  scope: 'equipo' | 'todos';
  /**
   * Recorte por tipo de ruta. `tipo_ruta: 'vecinal'` = quien consulta tiene un puesto de Ruta
   * Vecinal y sólo ve rutas vecinales (y a quienes ese día tienen alguna). `null` = sin recorte.
   * `etiqueta` es el texto para la pantalla («Rutas vecinales»), `null` si no aplica.
   */
  alcance: VisitMonitorAlcance;
  /** A quién puedes filtrar. */
  vendor_options: { user_id: string; name: string }[];
  vendors: VisitMonitorVendor[];
  totals: VisitMonitorCounts;
}
