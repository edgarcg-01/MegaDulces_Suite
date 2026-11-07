/**
 * `[MV]` Monitoreo vecinal — lo que hace cada persona de la preventa (Comercial › Ruta y vendedores).
 *
 * Primera entrega: SURTIDORES y CAJERAS, cuyo registro es completo (`commercial.presale_picks`: quién
 * tomó, terminó y revisó cada pedido, con su reporte y su revisión). Los vendedores se arman sobre el
 * tablero del supervisor (`[MCP.3.9]`) y el monitoreo de visitas (`[MCP.3.7]`), que ya existen.
 *
 * Lo que no se registra se DECLARA (`null` / `unmeasured`), nunca se dibuja como cero:
 *  · cuánto tardó la cajera en revisar (no se guarda cuándo EMPEZÓ a revisar, sólo cuándo terminó);
 *  · el SKU de los renglones de revisiones anteriores a `[MV.1]` (la revisión no lo guardaba).
 */

/** El periodo consultado, en días de México. `days` = días con actividad (lunes a sábado). */
export interface VecinalMonitorPeriod {
  from: string;
  to: string;
  days: number;
}

/** Un producto de un pedido, como lo dejó cada etapa. Cantidades en la unidad en que se capturó. */
export interface VecinalMonitorLine {
  product_name: string;
  sku: string | null;
  unit: string;
  /** Lo que pidió el vendedor. */
  ordered: number;
  /** Lo que surtió el surtidor. */
  picked: number;
  /** Cómo quedó tras la revisión en caja; `null` = no se ha revisado. */
  final: number | null;
  /** El surtidor lo cambió por otro producto (`[MCP.13]`). */
  substitute: { product_name: string; sku: string | null; quantity: number; unit: string } | null;
  /** El renglón ES el sustituto de otro. */
  substitutes_for: string | null;
}

// ── Surtidores ──

export interface VecinalPickerRow {
  user_id: string;
  name: string;
  /** Pedidos que empezó a surtir en el periodo. */
  taken: number;
  finished: number;
  in_progress: number;
  /** Promedio de minutos por pedido terminado; `null` sin terminados. */
  avg_minutes: number | null;
  slowest: { code: string; minutes: number } | null;
  with_shortage: number;
  /** Pedidos donde cambió algún producto por otro. */
  substituted: number;
  /** Pedidos que la caja ajustó después (completó o quitó). */
  adjusted_by_cashier: number;
  first_at: string | null;
  last_at: string | null;
}

export interface VecinalPickerOrder {
  order_id: string;
  code: string;
  customer_name: string | null;
  seller_name: string | null;
  started_at: string;
  finished_at: string | null;
  minutes: number | null;
  outcome: 'completo' | 'con_faltantes' | null;
  adjusted_by_cashier: boolean;
  lines: VecinalMonitorLine[];
}

export interface VecinalPickersResponse {
  period: VecinalMonitorPeriod;
  scope: 'todos' | 'propios' | 'ninguno';
  rows: VecinalPickerRow[];
}

// ── Cajeras ──

export interface VecinalCashierRow {
  user_id: string;
  name: string;
  reviewed: number;
  /** Minutos promedio entre que el surtidor terminó y la cajera revisó. */
  avg_wait_minutes: number | null;
  /** ⚠️ NO se mide: no se guarda cuándo empezó a revisar. Siempre `null` (se declara en pantalla). */
  avg_review_minutes: null;
  /** Productos que completó con el surtidor / que quitó porque no hubo. */
  completed_lines: number;
  removed_lines: number;
  /** Lo que debió cobrarse: la suma del total de cada pedido como lo dejó la revisión (con IVA). */
  should_charge: number;
  /** Cuánto movió la revisión el total (después − antes). */
  delta: number;
  first_at: string | null;
  last_at: string | null;
}

export interface VecinalCashierOrder {
  order_id: string;
  code: string;
  customer_name: string | null;
  picker_name: string | null;
  finished_at: string;
  /** `null` = todavía por revisar. */
  reviewed_at: string | null;
  wait_minutes: number | null;
  total_before: number | null;
  /** Lo que debió cobrarse (total tras la revisión). Si no se ha revisado, el total del pedido hoy. */
  should_charge: number;
  lines: VecinalMonitorLine[];
}

export interface VecinalCashiersResponse {
  period: VecinalMonitorPeriod;
  scope: 'todos' | 'propios' | 'ninguno';
  rows: VecinalCashierRow[];
  /** Lo que espera revisión en el alcance, hoy (no depende del periodo). */
  pending: { count: number; should_charge: number; oldest_finished_at: string | null };
}

/** El detalle de una persona: sus pedidos del periodo, del más nuevo al más viejo. */
export interface VecinalOrdersResponse<T> {
  period: VecinalMonitorPeriod;
  total: number;
  /** Se cortó en el tope: la pantalla lo dice («se muestran N de total»). */
  truncated: boolean;
  data: T[];
}

// ── Vendedores ──
//
// Dos ventas, a propósito (decisión de David, 2026-11-05):
//  · LEVANTADO = los pedidos que el vendedor capturó en la app (`commercial.orders`, con IVA): qué
//    le vendió a cada cliente, producto por producto;
//  · COBRADO = la venta cobrada en Kepler (`analytics.v_kepler_vecinal_sales_docs`), atribuida a la
//    RUTA del día, la misma fuente y la misma regla del tablero del supervisor (`[MCP.3.9]`). La meta
//    se mide contra ésta, para que el avance cuadre con el tablero.

export interface VecinalVendorRow {
  user_id: string;
  name: string;
  /** Rutas vecinales que tuvo en el periodo (nombre de catálogo). */
  routes: string[];
  /** Días del periodo en que tuvo ruta vecinal. */
  days_on_route: number;
  /** Sólo si el periodo es UN día: cómo va su ruta ese día. `null` en periodos largos. */
  day_state: 'sin_iniciar' | 'en_ruta' | 'finalizada' | null;
  route_started_at: string | null;
  route_finished_at: string | null;
  /** Clientes de su ruta ese día. Sólo en periodos de UN día (`null` en largos: no se suma). */
  planned_customers: number | null;
  /** Visitas abiertas en el periodo (una por cliente y día). */
  visits: number;
  with_order: number;
  no_sale_with_reason: number;
  no_sale_without_reason: number;
  /** Visitas que nunca se cerraron (no se sabe cuánto duraron). */
  open_visits: number;
  /** Minutos promedio con el cliente, de las visitas cerradas. `null` sin cerradas. */
  avg_visit_minutes: number | null;
  orders: number;
  /** Lo levantado en la app (con IVA). */
  ordered_total: number;
  /** Lo cobrado en Kepler; `null` + motivo si no se pudo medir. */
  charged: number | null;
  charged_unmeasured_reason: string | null;
  /** Meta del periodo: la de cada catorcena, en proporción a los días con actividad del periodo. */
  target: number | null;
  progress_pct: number | null;
  gps_points: number;
  gps_last_at: string | null;
  first_at: string | null;
  last_at: string | null;
}

export interface VecinalVendorsResponse {
  period: VecinalMonitorPeriod;
  scope: 'todos' | 'propios' | 'ninguno';
  /** Las rutas vecinales para el selector (las que tuvieron vendedor en el periodo). */
  route_options: string[];
  rows: VecinalVendorRow[];
}

export interface VecinalVendorOrderLine {
  product_name: string;
  sku: string | null;
  unit: string;
  quantity: number;
  line_total: number;
}

export interface VecinalVendorVisit {
  customer_id: string | null;
  customer_code: string | null;
  customer_name: string | null;
  /** Día (México) de la visita. */
  date: string;
  /** `sin_visita` = le levantó pedido sin abrir la visita. */
  status: 'con_pedido' | 'sin_pedido' | 'abierta' | 'sin_visita';
  visited_at: string | null;
  ended_at: string | null;
  minutes: number | null;
  no_sale_reason: string | null;
  notes: string | null;
  latitude: number | null;
  longitude: number | null;
  orders: Array<{ order_id: string; code: string; total: number; created_at: string; lines: VecinalVendorOrderLine[] }>;
  ordered_total: number;
  /** Lo que Kepler le cobró a ese cliente ese día (`null` = no se pudo leer la fuente). */
  charged: number | null;
}

export interface VecinalVendorDetail {
  period: VecinalMonitorPeriod;
  user_id: string;
  name: string;
  target: number | null;
  charged: number | null;
  charged_unmeasured_reason: string | null;
  ordered_total: number;
  total_visits: number;
  /** Se cortó en el tope: la pantalla lo dice. */
  truncated: boolean;
  visits: VecinalVendorVisit[];
  /** El recorrido: puntos de ubicación (sólo con la app abierta). */
  gps: { total: number; truncated: boolean; points: Array<{ lat: number; lng: number; at: string; accuracy_m: number | null }> };
}
