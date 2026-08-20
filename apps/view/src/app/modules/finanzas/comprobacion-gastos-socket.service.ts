import { Injectable, signal, inject } from '@angular/core';
import { Subject } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../core/services/auth.service';

/** Un cambio en una comprobación de gasto (lo emite el backend al mutar). */
export interface ComprobacionGastoEvent {
  action: 'captured' | 'validated' | 'rejected' | 'correction_requested';
  sucursal: string | null;
  folio_gasto: string;
  status: string | null;
  proveedor: string | null;
  importe: number | null;
  actor: string | null;
  emitted_at: string;
}

/**
 * GX.8 (Fase 2) — Cliente WS del namespace `/comprobacion-gastos`. La bandeja del
 * autorizador (`/finanzas/comprobacion-gastos`) llama `connect()` en su init y
 * `disconnect()` al destruir; cuando un capturista sube un comprobante (o alguien
 * valida/rechaza/pide corrección), el backend emite `comprobacion_changed` → la
 * bandeja avisa (toast) y se refresca. Path `/reports/socket.io` (mismo adapter).
 */
@Injectable({ providedIn: 'root' })
export class ComprobacionGastosSocketService {
  private socket: Socket | null = null;
  private readonly auth = inject(AuthService);

  readonly connected = signal(false);
  readonly change$ = new Subject<ComprobacionGastoEvent>();

  connect(): void {
    if (this.socket?.connected) return;
    const token = this.auth.token();
    if (!token) return;
    this.socket = io(`${this.baseUrl()}/comprobacion-gastos`, {
      path: '/reports/socket.io',
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1500,
    });
    this.socket.on('connect', () => this.connected.set(true));
    this.socket.on('disconnect', () => this.connected.set(false));
    this.socket.on('comprobacion_changed', (e: ComprobacionGastoEvent) => this.change$.next(e));
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
