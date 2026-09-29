/**
 * `[VR.SUP.1]` Ruta del día del supervisor: «¿qué ruta vas a trabajar hoy?».
 *
 * `GET/PUT/DELETE /commercial/vendor-routes/day-pick`. La elección vale sólo para HOY (fecha MX) y
 * manda sobre la agenda semanal (`daily_assignments`) en toda la cartera. Sólo se ofrecen rutas
 * del equipo del supervisor (`users.supervisor_id = él`) más las suyas.
 */

/** Quién recorre una ruta elegible. */
export interface DayPickVendor {
  username: string;
  /** Le toca hoy según su agenda. */
  today: boolean;
  /** Es el propio supervisor. */
  is_me: boolean;
}

/** Una ruta que el supervisor puede escoger para trabajar hoy. */
export interface DayPickOption {
  route_id: string;
  route: string;
  zone: string | null;
  /** Algún vendedor (o él) la tiene agendada hoy. */
  scheduled_today: boolean;
  /** Días ISO (1=lun..7=dom) en que alguien de su equipo la recorre. */
  days: number[];
  vendors: DayPickVendor[];
  customers: number;
}

/** La ruta escogida para hoy. */
export interface DayPickChoice {
  route_id: string;
  route: string;
}

/** Estado de «¿qué ruta vas a trabajar hoy?». */
export interface DayPickState {
  /** Tiene equipo a su cargo → se le ofrece escoger. */
  can_pick: boolean;
  /** Ruta escogida para hoy; null = trabaja su agenda normal. */
  current: DayPickChoice | null;
  /** Lo que su agenda semanal le pone hoy. */
  agenda_today: string[];
  options: DayPickOption[];
}

/** Respuesta de `DELETE day-pick`. */
export interface DayPickCleared {
  cleared: boolean;
}
