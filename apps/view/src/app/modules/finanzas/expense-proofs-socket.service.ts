import { Injectable, signal, inject } from '@angular/core';
import { Subject } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../core/services/auth.service';

/** Un cambio en una solicitud de autorización de gasto (lo emite el backend al mutar). */
export interface SolicitudGastoEvent {
  action: 'captured' | 'validated' | 'rejected';
  folio_solicitud: string;
  status: string | null;
  solicitante: string | null;
  importe: number | null;
  sucursal: string | null;
  actor: string | null;
  emitted_at: string;
}

/**
 * GX.7 — Cliente WS del namespace `/expense-proofs`. Calca al de comprobación de gastos,
 * que ya resolvía la misma necesidad en la otra mitad del ciclo: el capturista sube el
 * comprobante y el autorizador lo ve llegar sin refrescar.
 *
 * Las pantallas que lo usan llaman `connect()` al iniciar y `disconnect()` al destruir.
 * Path `/reports/socket.io` (mismo adapter que el resto).
 */
@Injectable({ providedIn: 'root' })
export class ExpenseProofsSocketService {
  private socket: Socket | null = null;
  private readonly auth = inject(AuthService);
  /** Cuántas pantallas lo están usando: el singleton lo comparten solicitudes y comprobaciones. */
  private refs = 0;

  readonly connected = signal(false);
  readonly change$ = new Subject<SolicitudGastoEvent>();

  connect(): void {
    this.refs++;
    // Idempotente por EXISTENCIA, no por estado: con `?.connected` un segundo connect()
    // durante el handshake veía false, creaba OTRO socket y dejaba el primero huérfano
    // reconectando solo, fuera del alcance de disconnect().
    if (this.socket) { if (!this.socket.connected) this.socket.connect(); return; }
    const token = this.auth.token();
    if (!token) { this.refs = Math.max(0, this.refs - 1); return; }
    this.socket = io(`${this.baseUrl()}/expense-proofs`, {
      path: '/reports/socket.io',
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1500,
    });
    this.socket.on('connect', () => this.connected.set(true));
    this.socket.on('disconnect', () => this.connected.set(false));
    this.socket.on('solicitud_changed', (e: SolicitudGastoEvent) => this.change$.next(e));
  }

  /** Libera UNA referencia; cierra de verdad solo cuando se va el último consumidor. */
  disconnect(): void {
    this.refs = Math.max(0, this.refs - 1);
    if (this.refs > 0 || !this.socket) return;
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
