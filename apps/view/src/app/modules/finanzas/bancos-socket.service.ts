import { Injectable, signal, inject } from '@angular/core';
import { Subject } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../core/services/auth.service';

/** Un cambio en el tablero de Bancos (lo emite el backend al mutar). */
export interface BancosEvent {
  action: 'imported' | 'sheet_synced' | 'matched' | 'capture_new' | 'capture_validated' | 'capture_rejected';
  period: string | null;
  detail: string | null;
  count: number | null;
  actor: string | null;
  emitted_at: string;
}

/**
 * Fase CB (WS) — Cliente del namespace `/bancos`. La página `/finanzas/bancos` llama
 * `connect()` en su init y `disconnect()` al destruir; cuando el feed importa un estado
 * de cuenta, el cron sincroniza el Sheet, se corre la conciliación o entra/valida un
 * comprobante, el backend emite `bancos_changed` → el tablero se refresca al momento.
 * Path `/reports/socket.io` (mismo adapter que las alertas / comprobantes).
 */
@Injectable({ providedIn: 'root' })
export class BancosSocketService {
  private socket: Socket | null = null;
  private readonly auth = inject(AuthService);

  readonly connected = signal(false);
  readonly change$ = new Subject<BancosEvent>();

  connect(): void {
    if (this.socket?.connected) return;
    const token = this.auth.token();
    if (!token) return;
    this.socket = io(`${this.baseUrl()}/bancos`, {
      path: '/reports/socket.io',
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1500,
    });
    this.socket.on('connect', () => this.connected.set(true));
    this.socket.on('disconnect', () => this.connected.set(false));
    this.socket.on('bancos_changed', (e: BancosEvent) => this.change$.next(e));
  }

  disconnect(): void {
    if (!this.socket) return;
    this.socket.removeAllListeners();
    this.socket.disconnect();
    this.socket = null;
    this.connected.set(false);
  }

  private baseUrl(): string {
    const apiUrl = environment.apiUrl;
    return apiUrl.startsWith('http') ? apiUrl.replace(/\/api$/, '') : `${window.location.protocol}//${window.location.host}`;
  }
}
