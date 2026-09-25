import { Injectable, signal, inject } from '@angular/core';
import { Subject } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../core/services/auth.service';

/** Aviso de que el espejo de CAOS cambió. Trae la FIRMA (conteo + max id + suma), no las filas. */
export interface CaosEvent {
  device: string | null;
  filas: number | null;
  max_id: number | null;
  firma?: string | null;
  datos_al: string | null;
  emitted_at: string;
}

/**
 * CS.2 — Cliente del namespace `/caos`. La pantalla del reporte llama `connect()` al entrar y
 * `disconnect()` al salir; cuando el feed trae un movimiento nuevo, el backend emite `caos_changed`
 * y el reporte se pone al día solo. Mismo patrón que `caja-socket.service` (CG.23.2).
 */
@Injectable({ providedIn: 'root' })
export class CaosSocketService {
  private socket: Socket | null = null;
  private readonly auth = inject(AuthService);

  readonly connected = signal(false);
  readonly change$ = new Subject<CaosEvent>();

  private users = 0;

  connect(): void {
    this.users++;
    // Idempotente por EXISTENCIA, no por estado (mismo defecto ya vivido en Bancos/caja).
    if (this.socket) { if (!this.socket.connected) this.socket.connect(); return; }
    const token = this.auth.token();
    if (!token) return;
    this.socket = io(`${this.baseUrl()}/caos`, {
      path: '/reports/socket.io',
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1500,
    });
    this.socket.on('connect', () => this.connected.set(true));
    this.socket.on('disconnect', () => this.connected.set(false));
    this.socket.on('auth_error', () => this.connected.set(false));
    this.socket.on('caos_changed', (e: CaosEvent) => this.change$.next(e));
  }

  disconnect(): void {
    this.users = Math.max(0, this.users - 1);
    if (this.users > 0) return;
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
