import { Injectable, signal, inject } from '@angular/core';
import { Subject } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../core/services/auth.service';

export interface InventoryMonitorEvent {
  type: 'count' | 'session' | 'phase' | 'interruption';
  folio_id: string;
  at: string;
  [k: string]: any;
}

/**
 * Cliente WS del namespace /inventory: monitoreo en vivo de un folio para el
 * supervisor. Conecta on-demand, sigue un folio con `watch(folioId)` y emite
 * cada evento (conteo, jornada, fase, interrupción) por `event$`.
 *
 * Path `/reports/socket.io` (mismo io server del backend que /alerts).
 */
@Injectable({ providedIn: 'root' })
export class InventoryMonitorSocketService {
  private socket: Socket | null = null;
  private readonly auth = inject(AuthService);

  readonly connected = signal(false);
  readonly event$ = new Subject<InventoryMonitorEvent>();
  readonly lastEvent = signal<InventoryMonitorEvent | null>(null);

  connect(folioId: string): void {
    const token = this.auth.token();
    if (!token) return;
    if (this.socket?.connected) {
      this.socket.emit('watch', { folio_id: folioId });
      return;
    }

    this.socket = io(`${this.baseUrl()}/inventory`, {
      path: '/reports/socket.io',
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1500,
    });

    this.socket.on('connect', () => {
      this.connected.set(true);
      this.socket?.emit('watch', { folio_id: folioId });
    });
    this.socket.on('disconnect', () => this.connected.set(false));
    this.socket.on('inventory_event', (e: InventoryMonitorEvent) => {
      this.lastEvent.set(e);
      this.event$.next(e);
    });
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
    if (apiUrl.startsWith('http')) return apiUrl.replace(/\/api$/, '');
    return `${window.location.protocol}//${window.location.host}`;
  }
}
