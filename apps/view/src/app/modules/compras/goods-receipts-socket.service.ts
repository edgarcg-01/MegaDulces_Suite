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
 * RE.10 — Cliente WS del namespace `/goods-receipts`. Cuando el watcher del backend detecta
 * órdenes nuevas emite `new_receipts` → píldora "N nuevas — actualizar". Path
 * `/reports/socket.io` (mismo adapter que las alertas).
 *
 * `[RE.28.3]` Lo consumen **dos** pantallas, y el docstring decía sólo `/compras/entradas`
 * cuando en realidad ahí no estaba: RE.13 partió las pantallas y el aviso se quedó del lado del
 * auditor, que es a quien menos le sirve —no tiene papel que subir—. Ahora también lo escucha la
 * worklist del capturista, que es quien está frente a la pantalla mientras llega la mercancía.
 *
 * ⚠️ El servicio es `providedIn: 'root'` y `disconnect()` **destruye el socket y todos sus
 * listeners**, así que sirve a una pantalla a la vez. Hoy alcanza porque las dos viven en rutas
 * distintas y el router destruye la vieja antes de crear la nueva (`deactivate` → `activate`):
 * la secuencia es disconnect → connect. Si alguna vez las dos conviven —un split, un modal sobre
 * la otra— la que se cierre le corta el aviso a la que queda, y entonces esto necesita un
 * contador de suscriptores.
 */
@Injectable({ providedIn: 'root' })
export class GoodsReceiptsSocketService {
  private socket: Socket | null = null;
  private readonly auth = inject(AuthService);

  readonly connected = signal(false);
  readonly newReceipts$ = new Subject<NewReceiptsEvent>();

  connect(): void {
    // Idempotente por EXISTENCIA, no por estado. Con `?.connected` un segundo connect()
    // durante el handshake veia false, creaba OTRO socket y pisaba la referencia: el
    // primero quedaba huerfano, reconectando solo y fuera del alcance de disconnect().
    // Si el socket existe pero se cayo, se reabre el mismo en vez de crear otro.
    if (this.socket) { if (!this.socket.connected) this.socket.connect(); return; }
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
