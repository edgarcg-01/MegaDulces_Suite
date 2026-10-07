import { Injectable, signal, inject } from '@angular/core';
import { Subject } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import { environment } from '../../../../environments/environment';
import { AuthService } from '../../../core/services/auth.service';

export type AlertType =
  | 'low_stock_critical'
  | 'large_order'
  | 'vip_inactive'
  | 'order_confirmed'
  | 'order_fulfilled'
  | 'test';

export interface CommercialAlert {
  type: AlertType;
  severity: 'info' | 'warn' | 'critical';
  title: string;
  message: string;
  data: any;
  emitted_at: string;
}

/**
 * Cliente WS para el namespace /alerts del backend.
 *
 * Conecta on-demand (no auto-connect global) — la página que necesita alertas
 * llama `.connect()` en su `ngOnInit` y `.disconnect()` en `ngOnDestroy`.
 *
 * El path es `/reports/socket.io` (mismo endpoint que ReportsGateway por
 * cómo está configurado el adapter en backend main.ts).
 */
@Injectable({ providedIn: 'root' })
export class AlertsSocketService {
  private socket: Socket | null = null;
  private readonly auth = inject(AuthService);

  readonly connected = signal(false);
  readonly lastAlert = signal<CommercialAlert | null>(null);
  readonly alert$ = new Subject<CommercialAlert>();

  connect(): void {
    if (this.socket?.connected) return;
    const token = this.auth.token();
    if (!token) {
      console.warn('[AlertsSocket] sin token, abort connect');
      return;
    }

    // Para /alerts namespace: URL = base + '/alerts'. Path se mantiene en
    // /reports/socket.io porque así está el adapter del backend.
    const baseUrl = this.urlForNamespace();
    this.socket = io(`${baseUrl}/alerts`, {
      path: '/reports/socket.io',
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1500,
    });

    this.socket.on('connect', () => {
      this.connected.set(true);
      console.log('[AlertsSocket] connected', this.socket?.id);
    });
    this.socket.on('disconnect', (reason) => {
      this.connected.set(false);
      console.log('[AlertsSocket] disconnect', reason);
    });
    this.socket.on('auth_error', (e) => {
      console.error('[AlertsSocket] auth_error', e);
    });
    this.socket.on('connect_error', (e) => {
      console.error('[AlertsSocket] connect_error', e.message);
    });
    this.socket.on('alert', (a: CommercialAlert) => {
      this.lastAlert.set(a);
      this.alert$.next(a);
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
    // environment.apiUrl es "http://localhost:3334/api" en local o "/api" en prod.
    // Para WS necesitamos el host base sin "/api".
    const apiUrl = environment.apiUrl;
    if (apiUrl.startsWith('http')) {
      // Quitar "/api" del final si lo tiene.
      return apiUrl.replace(/\/api$/, '');
    }
    // Path relativo en prod → usa hostname actual.
    return `${window.location.protocol}//${window.location.host}`;
  }
}
