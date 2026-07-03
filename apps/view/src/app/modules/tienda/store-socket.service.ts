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
export interface StoreBranchKpi { warehouse_code: string; warehouse_name: string; tickets: number; venta: number; last_ts: string; }
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

  snapshot(warehouse?: string) {
    const q = warehouse ? `?warehouse=${encodeURIComponent(warehouse)}` : '';
    return this.http.get<StoreSnapshot>(`${environment.apiUrl}/store/live/snapshot${q}`);
  }

  connect(): void {
    if (this.socket?.connected) return;
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
