import { Injectable, signal, inject } from '@angular/core';
import { Subject } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../core/services/auth.service';
import { TrackerLive } from './logistica.service';

export interface FleetLivePayload {
  trackers: TrackerLive[];
  synced_at: string;
  positions: number;
}

/**
 * LT.8 — Cliente WS del namespace `/fleet`: recibe el snapshot de flota en vivo
 * apenas el poller del backend sincroniza con MagniTracking. La trazabilidad se
 * mueve "al momento" sin polling. Conecta on-demand (la página llama connect()
 * en su constructor y disconnect() al destruirse).
 *
 * Path = `/reports/socket.io` (mismo adapter que los demás gateways del backend).
 */
@Injectable({ providedIn: 'root' })
export class FleetTrackingSocketService {
  private socket: Socket | null = null;
  private readonly auth = inject(AuthService);

  readonly connected = signal(false);
  readonly lastAt = signal<string | null>(null);
  readonly live$ = new Subject<FleetLivePayload>();

  connect(): void {
    if (this.socket?.connected) return;
    const token = this.auth.token();
    if (!token) return;

    const baseUrl = this.urlForNamespace();
    this.socket = io(`${baseUrl}/fleet`, {
      path: '/reports/socket.io',
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 2000,
    });

    this.socket.on('connect', () => this.connected.set(true));
    this.socket.on('disconnect', () => this.connected.set(false));
    this.socket.on('auth_error', (e) => console.error('[FleetSocket] auth_error', e));
    this.socket.on('connect_error', (e) => console.error('[FleetSocket] connect_error', e.message));
    this.socket.on('fleet:live', (p: FleetLivePayload) => {
      this.lastAt.set(p?.synced_at ?? new Date().toISOString());
      this.live$.next(p);
    });
  }

  disconnect(): void {
    if (!this.socket) return;
    this.socket.removeAllListeners();
    this.socket.disconnect();
    this.socket = null;
    this.connected.set(false);
  }

  private urlForNamespace(): string {
    const apiUrl = environment.apiUrl;
    if (apiUrl.startsWith('http')) return apiUrl.replace(/\/api$/, '');
    return `${window.location.protocol}//${window.location.host}`;
  }
}
