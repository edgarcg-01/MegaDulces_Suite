import { Injectable, signal, inject } from '@angular/core';
import { Subject } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../core/services/auth.service';

export interface NewReceiptsEvent {
  count: number;
  sample: { sucursal: string; folio: string; proveedor: string | null }[];
  emitted_at: string;
}

/**
 * RE.10 — Cliente WS del namespace `/goods-receipts`. La página `/compras/entradas`
 * llama `connect()` en su init y `disconnect()` al destruir; cuando el watcher del
 * backend detecta órdenes nuevas emite `new_receipts` → pill "N nuevas — actualizar".
 * Path `/reports/socket.io` (mismo adapter que las alertas).
 */
@Injectable({ providedIn: 'root' })
export class GoodsReceiptsSocketService {
  private socket: Socket | null = null;
  private readonly auth = inject(AuthService);

  readonly connected = signal(false);
  readonly newReceipts$ = new Subject<NewReceiptsEvent>();

  connect(): void {
    if (this.socket?.connected) return;
    const token = this.auth.token();
    if (!token) return;
    this.socket = io(`${this.baseUrl()}/goods-receipts`, {
      path: '/reports/socket.io',
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1500,
    });
    this.socket.on('connect', () => this.connected.set(true));
    this.socket.on('disconnect', () => this.connected.set(false));
    this.socket.on('new_receipts', (e: NewReceiptsEvent) => this.newReceipts$.next(e));
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
