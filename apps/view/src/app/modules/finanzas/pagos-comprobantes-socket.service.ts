import { Injectable, signal, inject } from '@angular/core';
import { Subject } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../core/services/auth.service';

/** Un cambio en un comprobante de pago (lo emite el backend al mutar). */
export interface PaymentProofEvent {
  action: 'attached' | 'validated' | 'rejected' | 'bank_matched' | 'bank_unmatched';
  sucursal: string;
  doc_prefix: string | null;
  folio: string;
  status: string | null;
  proveedor: string | null;
  monto: number | null;
  actor: string | null;
  emitted_at: string;
}

/**
 * Fase CC (extensión) — Cliente WS del namespace `/pagos-comprobantes`. La página
 * `/finanzas/pagos-comprobantes` llama `connect()` en su init y `disconnect()` al
 * destruir; cuando otro usuario adjunta / valida / rechaza / concilia un comprobante,
 * el backend emite `payment_proof_changed` → la tabla se refresca al momento.
 * Path `/reports/socket.io` (mismo adapter que las alertas).
 */
@Injectable({ providedIn: 'root' })
export class PagosComprobantesSocketService {
  private socket: Socket | null = null;
  private readonly auth = inject(AuthService);

  readonly connected = signal(false);
  readonly change$ = new Subject<PaymentProofEvent>();

  connect(): void {
    if (this.socket?.connected) return;
    const token = this.auth.token();
    if (!token) return;
    this.socket = io(`${this.baseUrl()}/pagos-comprobantes`, {
      path: '/reports/socket.io',
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1500,
    });
    this.socket.on('connect', () => this.connected.set(true));
    this.socket.on('disconnect', () => this.connected.set(false));
    this.socket.on('payment_proof_changed', (e: PaymentProofEvent) => this.change$.next(e));
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
