import { Injectable, signal, inject } from '@angular/core';
import { Subject } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import { io, Socket } from 'socket.io-client';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../core/services/auth.service';

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
export interface StoreBranchKpi { warehouse_code: string; warehouse_name: string; tickets: number; venta: number; last_ts: string; }
export interface OpenCaja {
  rank: number;
  warehouse_code: string; warehouse_name?: string; caja: string;
  cajero: string | null; cajero_nombre: string | null; abrio: string;
  tickets: number; venta: number; last_ticket: string | null; idle_min: number | null; cobrando: boolean;
  /** `arrastrada` = abrió un día anterior y nadie la cerró. Es una incidencia, no actividad de hoy. */
  desde_dia?: string; dias_abierta?: number; arrastrada?: boolean;
}
export interface OpenCajasResponse {
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
  totals: { tickets: number; venta: number; avg_ticket: number };
  by_branch: StoreBranchKpi[];
  hourly: { hora: number; tickets: number; venta: number }[];
  recent: LiveTicket[];
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

  snapshot(warehouse?: string) {
    const q = warehouse ? `?warehouse=${encodeURIComponent(warehouse)}` : '';
    return this.http.get<StoreSnapshot>(`${environment.apiUrl}/store/live/snapshot${q}`);
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
