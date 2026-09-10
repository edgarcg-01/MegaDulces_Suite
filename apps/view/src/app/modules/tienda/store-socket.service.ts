import { Injectable, signal, inject } from '@angular/core';
import { Subject } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import { io, Socket } from 'socket.io-client';
import { environment } from '../../../environments/environment';
import type { Freshness, LabelPricesChanged } from '@megadulces/contracts';
import { AuthService } from '../../core/services/auth.service';

// `[TDA.1]` Se reexporta para que la pantalla lo importe de acá (junto al servicio que lo emite) en
// vez de tener que conocer el paquete de contratos.
export type { LabelPricesChanged } from '@megadulces/contracts';

export interface LiveTicketItem { sku: string; nombre: string; cant: number; importe: number; }
export interface LiveTicket {
  warehouse_code: string; warehouse_name?: string; serie: string; folio: string;
  ticket_ts: string; total: number; forma_pago?: string; items: LiveTicketItem[];
}
export interface StoreAlert {
  type: string; severity: 'info' | 'warn' | 'critical';
  title: string; message: string; data: any; emitted_at: string;
}
/** Aviso dirigido: Kepler cerró TU caja y falta contar. Sin montos (SM.10). */
export interface ArqueoDue {
  type: 'arqueo_due'; severity: 'info' | 'warn';
  title: string; message: string; route: string;
  cajero_code: string; warehouse_code: string; caja: string;
  business_date: string; folio: string;
  hora_cierre?: string | null; cerrado_hace_min: number; vencido: boolean;
  /** `retiro` = sangría con el turno abierto · `cierre` = corte del cajón. */
  motivo?: 'cierre' | 'retiro';
}
/**
 * TDA.P — palancas de la política comercial, calculadas en el servidor sobre TODOS
 * los renglones del día (no sobre el ticker del navegador, que va topado).
 *
 *   Venta = Tickets × (Partidas/ticket) × (Valor/partida)   ← exacto
 *   Venta = Tickets × (Unidades/ticket) × (Valor/unidad)    ← peldaño resuelto por precio
 *
 * `units`/`amount_per_unit` llegan **`null`** cuando el peldaño no se pudo resolver —
 * nunca 0. Un cero se lee como "no vendió"; el null se lee como "no lo sé", que es lo
 * que de verdad pasa (ADR-056).
 */
export interface StoreLineLevers {
  lines: number;
  amount: number;
  amount_per_line: number;
  units: number | null;
  amount_per_unit: number | null;
  unresolved_lines: number;
  coverage_pct: number;
  method: 'peldano_por_precio' | 'no_medido' | 'sin_datos' | 'sin_alcance' | 'escalera_no_disponible';
}
export interface StoreBranchKpi {
  warehouse_code: string; warehouse_name: string; tickets: number; venta: number; last_ts: string;
  lines?: StoreLineLevers | null;
}

/**
 * TDA.R — ritmo de referencia (7 y 30 días) contra el que se compara el día en curso.
 * Sale del ODS, no del buffer del monitor (que se limpia a los 3 días).
 *
 * Todas las razones son `null` si la ventana no juntó días suficientes: `days_used`
 * dice cuántos se pudieron usar y `method` por qué. Un promedio de 1 día NO es "el
 * ritmo de la semana", y publicarlo como tal es peor que no tenerlo.
 */
export interface StoreRhythmWindow {
  window_days: number;
  days_used: number;
  days_missing: number;
  days_partial: number;
  median_tickets: number;
  tickets_per_day: number | null;
  lines_per_ticket: number | null;
  amount_per_line: number | null;
  amount_per_ticket: number | null;
  units_per_ticket: number | null;
  amount_per_unit: number | null;
  coverage_pct: number;
  method: 'ods_u_d_10' | 'ventana_incompleta' | 'sin_datos' | 'sin_alcance' | 'ods_no_disponible';
}
/**
 * Ritmo del MISMO día de la semana (los últimos 4 miércoles si hoy es miércoles).
 * En retail el calendario pesa: un sábado no se parece a un martes, así que el
 * promedio de 30 días mezcla los dos y mueve el "vs." por razones que no son la
 * operación. `dow` es 0=domingo (calculado en hora MX, no la del navegador).
 */
export interface StoreRhythmDow extends StoreRhythmWindow {
  dow: number;
  occurrences: number;
}
/** Punto de la curva horaria de referencia (promedio de los días utilizables). */
export interface RhythmHourPoint { hora: number; venta: number; tickets: number; }
export interface StoreRhythm {
  week: StoreRhythmWindow;
  month: StoreRhythmWindow;
  dow: StoreRhythmDow;
  /**
   * Curva de venta por hora de cada ritmo, para superponer sobre la de hoy. `null`
   * cuando ese ritmo no tiene días suficientes. Ojo: a diferencia de las razones, va
   * SIN recorte a la hora actual — se quiere ver también lo que falta del día.
   */
  hourly?: { dow: RhythmHourPoint[] | null; week: RhythmHourPoint[] | null; month: RhythmHourPoint[] | null };
  generated_at: string;
}
export interface OpenCaja {
  rank: number;
  warehouse_code: string; warehouse_name?: string; caja: string;
  cajero: string | null; cajero_nombre: string | null; abrio: string;
  tickets: number; venta: number; last_ticket: string | null; idle_min: number | null; cobrando: boolean;
  /** `arrastrada` = abrió un día anterior y nadie la cerró. Es una incidencia, no actividad de hoy. */
  desde_dia?: string; dias_abierta?: number; arrastrada?: boolean;
}
export interface OpenCajasResponse {
  /**
   * [VP.2.2] Procedencia en el vocabulario común (`@megadulces/contracts`). El campo `feed` de más
   * abajo dice lo MISMO con más detalle de dominio y sigue siendo el que pinta la pantalla; los dos
   * salen del mismo cálculo en el emisor, así que no pueden discrepar.
   */
  freshness: Freshness;
  generated_at: string; cajas_abiertas: number; cobrando_ahora: number; arrastradas?: number;
  open_cajas: OpenCaja[];
  cajeros_sin_sesion: { warehouse_code: string; cajero: string; tickets: number; venta: number; last_ticket: string }[];
  /**
   * Salud del feed. "0 cajas abiertas" tiene dos causas opuestas —la tienda está
   * cerrada, o dejamos de recibir datos de Kepler— y sin esto se ven igual.
   * `al`/`minutos` = cuándo corrió el importer · `ultimo_dia` = de qué día son
   * los datos · `sospechoso` = el cero no es de fiar.
   */
  feed?: { al: string | null; minutos: number | null; ultimo_dia: string | null; hoy: string | null; sospechoso: boolean; atrasado: boolean };
}
export interface StoreSnapshot {
  generated_at: string;
  /** [VP.2.2] Cuándo llegó el último ticket — "cero tickets" no distingue tienda tranquila de feed muerto. */
  freshness: Freshness;
  totals: { tickets: number; venta: number; avg_ticket: number };
  by_branch: StoreBranchKpi[];
  hourly: { hora: number; tickets: number; venta: number }[];
  recent: LiveTicket[];
  /** TDA.P — partidas/unidades de la red. Ausente si el backend es viejo. */
  lines?: StoreLineLevers;
  sockets: any;
}

/**
 * Cliente WS del proyecto Tienda (namespace /store, path /reports/socket.io).
 * Conecta on-demand; el componente llama connect()/disconnect() en su ciclo.
 */
@Injectable({ providedIn: 'root' })
export class StoreSocketService {
  private socket: Socket | null = null;
  private readonly auth = inject(AuthService);
  private readonly http = inject(HttpClient);

  readonly connected = signal(false);
  readonly ticket$ = new Subject<LiveTicket>();
  readonly alert$ = new Subject<StoreAlert>();
  /**
   * SM.23 — "Haz tu arqueo". Llega por el room PERSONAL de la cajera, así que si
   * este evento entra es porque le toca a ELLA. No trae montos a propósito.
   */
  readonly arqueoDue$ = new Subject<ArqueoDue>();
  /**
   * `[TDA.1]` — Cambió el precio de etiqueta de estos productos en Kepler.
   *
   * Va al room de TODO el tenant, no al de una sucursal: el precio de etiqueta es una fila por
   * producto para toda la red. Es un AVISO — el precio nuevo se sigue pidiendo por HTTP.
   */
  readonly labelPricesChanged$ = new Subject<LabelPricesChanged>();

  snapshot(warehouse?: string) {
    const q = warehouse ? `?warehouse=${encodeURIComponent(warehouse)}` : '';
    return this.http.get<StoreSnapshot>(`${environment.apiUrl}/store/live/snapshot${q}`);
  }

  /**
   * TDA.R — ritmo semanal/mensual. Llamada aparte del snapshot: sale del ODS y la
   * ventana de 30 días tarda segundos, así que los KPIs pintan primero y el delta
   * aparece encima cuando llega.
   */
  rhythm(warehouse?: string) {
    const q = warehouse ? `?warehouse=${encodeURIComponent(warehouse)}` : '';
    return this.http.get<StoreRhythm>(`${environment.apiUrl}/store/live/rhythm${q}`);
  }

  /** SM.10 — cajas abiertas ahora + quién está cobrando. */
  openCajas(warehouse?: string) {
    const q = warehouse ? `?warehouse=${encodeURIComponent(warehouse)}` : '';
    return this.http.get<OpenCajasResponse>(`${environment.apiUrl}/store/live/open-cajas${q}`);
  }

  connect(): void {
    // Idempotente por EXISTENCIA, no por estado. Con `?.connected` un segundo connect()
    // durante el handshake veia false, creaba OTRO socket y pisaba la referencia: el
    // primero quedaba huerfano, reconectando solo y fuera del alcance de disconnect().
    // Si el socket existe pero se cayo, se reabre el mismo en vez de crear otro.
    if (this.socket) { if (!this.socket.connected) this.socket.connect(); return; }
    const token = this.auth.token();
    if (!token) { console.warn('[StoreSocket] sin token'); return; }
    this.socket = io(`${this.wsBase()}/store`, {
      path: '/reports/socket.io',
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true, reconnectionAttempts: 10, reconnectionDelay: 1500,
    });
    this.socket.on('connect', () => this.connected.set(true));
    this.socket.on('disconnect', () => this.connected.set(false));
    this.socket.on('auth_error', (e) => console.error('[StoreSocket] auth_error', e));
    this.socket.on('connect_error', (e) => console.error('[StoreSocket] connect_error', e.message));
    this.socket.on('ticket', (t: LiveTicket) => this.ticket$.next(t));
    this.socket.on('alert', (a: StoreAlert) => this.alert$.next(a));
    this.socket.on('arqueo_due', (a: ArqueoDue) => this.arqueoDue$.next(a));
    this.socket.on('label_prices_changed', (p: LabelPricesChanged) => this.labelPricesChanged$.next(p));
  }

  disconnect(): void {
    if (!this.socket) return;
    this.socket.removeAllListeners();
    this.socket.disconnect();
    this.socket = null;
    this.connected.set(false);
  }

  private wsBase(): string {
    const u = environment.apiUrl;
    return u.startsWith('http') ? u.replace(/\/api$/, '') : `${window.location.protocol}//${window.location.host}`;
  }
}
