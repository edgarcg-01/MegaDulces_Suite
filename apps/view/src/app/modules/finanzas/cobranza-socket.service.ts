import { Injectable, signal, inject } from '@angular/core';
import { Subject } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../core/services/auth.service';

/** Un cambio en un comprobante de cobranza (lo emite el backend al mutar). */
export interface CollectionDepositEvent {
  action: 'attached' | 'validated' | 'rejected' | 'bank_matched' | 'bank_unmatched';
  sucursal: string;
  folio: string;
  status: string | null;
  cliente: string | null;
  monto: number | null;
  actor: string | null;
  emitted_at: string;
}

/**
 * COMM-P1 (Fase CC) — Cliente WS del namespace `/cobranza`. La página
 * `/finanzas/cobranza` llama `connect()` en su init y `disconnect()` al destruir;
 * cuando otro usuario adjunta / valida / rechaza / concilia una ficha, el backend
 * emite `collection_deposit_changed` → la bandeja se refresca al momento.
 *
 * Existe para cerrar la asimetría con `/finanzas/pagos-comprobantes`, que ya tenía
 * su gateway: mismo flujo capturista→revisor, misma expectativa de tiempo real.
 * Path `/reports/socket.io` (mismo adapter que las alertas).
 */
@Injectable({ providedIn: 'root' })
export class CobranzaSocketService {
  private socket: Socket | null = null;
  private readonly auth = inject(AuthService);

  readonly connected = signal(false);
  readonly change$ = new Subject<CollectionDepositEvent>();

  connect(): void {
    // Idempotente por EXISTENCIA, no por estado. Con `?.connected` un segundo connect()
    // durante el handshake veia false, creaba OTRO socket y pisaba la referencia: el
    // primero quedaba huerfano, reconectando solo y fuera del alcance de disconnect().
    // Si el socket existe pero se cayo, se reabre el mismo en vez de crear otro.
    if (this.socket) { if (!this.socket.connected) this.socket.connect(); return; }
    const token = this.auth.token();
    if (!token) return;
    this.socket = io(`${this.baseUrl()}/cobranza`, {
      path: '/reports/socket.io',
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1500,
    });
    this.socket.on('connect', () => this.connected.set(true));
    this.socket.on('disconnect', () => this.connected.set(false));
    this.socket.on('collection_deposit_changed', (e: CollectionDepositEvent) => this.change$.next(e));
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
