import { Injectable, signal, inject } from '@angular/core';
import { Subject } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../core/services/auth.service';

/**
 * Lo que cambió en la caja. **No trae los movimientos**: trae la FIRMA del corte, para que la
 * pantalla sepa si lo que está mostrando ya está viejo sin traerse la lista de nuevo.
 */
export interface CajaEvent {
  /** `feed` = llegó movimiento de Kepler · `libro` = alguien guardó/confirmó acá. */
  origen: 'feed' | 'libro';
  filas: number | null;
  max_folio: string | null;
  max_captura: string | null;
  /** Firma completa del corte. Si no cambió, no hay nada que volver a pedir. */
  firma?: string | null;
  /** Cuándo se refrescó la fuente (no cuándo se emitió esto). */
  datos_al: string | null;
  emitted_at: string;
}

/**
 * CG.23.2 — Cliente del namespace `/caja`.
 *
 * La pantalla de Caja General llama `connect()` al entrar y `disconnect()` al salir. Cuando el
 * carril del ODS trae un movimiento nuevo de Kepler y el matview se refresca, el backend emite
 * `caja_changed` y la bandeja se pone al día sola, sin recargar.
 *
 * ⚠️ Esto **no reemplaza** al repaso lento de la pantalla, lo complementa. `NOTIFY` no se
 * persiste y un socket caído no deja rastro: si esto fuera el único camino, una desconexión de
 * tres segundos sería un movimiento que no aparece nunca y nadie se enteraría. El socket es el
 * camino rápido; el repaso es el que garantiza.
 *
 * ⭐ `[CG.201]` **La firma por teléfono ya NO viaja por acá.** Era un emparejamiento por socket
 * (`[CG.68]`–`[CG.196]`) cuyo estado vivía en la memoria del socket de la PC y se perdía con cada
 * despliegue. Hoy el pedido es una fila y se habla por HTTP (`caja-firma-api.service.ts`); de este
 * canal sólo queda `firmaLista$`, que adelanta el repaso de la PC — con la misma regla de arriba:
 * el socket adelanta, el repaso garantiza.
 */
@Injectable({ providedIn: 'root' })
export class CajaSocketService {
  private socket: Socket | null = null;
  private readonly auth = inject(AuthService);

  readonly connected = signal(false);

  /**
   * ⛔⛔ **`connected` vale `false` por DOS motivos distintos y eso ya mintió en pantalla.**
   *
   * Nace en `false` y recién pasa a `true` en el evento `connect`, así que durante todo el
   * handshake "todavía no" y "no se pudo" se ven iguales. Es la misma regla que esta pantalla ya
   * aplica a los datos (ADR-056): una ausencia no se pinta como la otra. Acá la ausencia es la
   * conexión.
   *
   * `connected` SE QUEDA —lo leen otros consumidores y significa exactamente "se puede emitir"—
   * y este estado lo acompaña con el porqué.
   */
  readonly estado = signal<'sin_iniciar' | 'conectando' | 'vivo' | 'caido'>('sin_iniciar');

  readonly change$ = new Subject<CajaEvent>();

  /** `[CG.201]` El teléfono tomó o firmó el pedido `id`: que la PC repase ya. Sólo el id. */
  readonly firmaLista$ = new Subject<{ id: string }>();

  /** Cuántas pantallas montadas lo usan: la última en irse cierra el socket. */
  private users = 0;

  connect(): void {
    this.users++;
    // Idempotente por EXISTENCIA, no por estado: con `?.connected` un segundo connect() durante
    // el handshake ve false, crea OTRO socket y pisa la referencia — el primero queda huérfano,
    // reconectando solo y fuera del alcance de disconnect(). (Mismo defecto ya vivido en Bancos.)
    if (this.socket) {
      if (!this.socket.connected) { this.estado.set('conectando'); this.socket.connect(); }
      return;
    }
    const token = this.auth.token();
    // ⚠️ Sin credencial no se intenta siquiera, y eso NO es "conectando": es que no se puede.
    if (!token) { this.estado.set('caido'); return; }
    this.estado.set('conectando');
    this.socket = io(`${this.baseUrl()}/caja`, {
      path: '/reports/socket.io',
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1500,
    });
    this.socket.on('connect', () => { this.connected.set(true); this.estado.set('vivo'); });
    this.socket.on('disconnect', () => { this.connected.set(false); this.estado.set('caido'); });
    this.socket.on('auth_error', () => { this.connected.set(false); this.estado.set('caido'); });
    this.socket.on('caja_changed', (e: CajaEvent) => this.change$.next(e));
    this.socket.on('firma:lista', (e: { id: string }) => this.firmaLista$.next(e));
  }

  disconnect(): void {
    this.users = Math.max(0, this.users - 1);
    if (this.users > 0) return;
    if (!this.socket) return;
    this.socket.removeAllListeners();
    this.socket.disconnect();
    this.socket = null;
    this.connected.set(false);
    // Cerrar a propósito no es caerse: vuelve al estado de arranque, o la próxima pantalla que
    // monte arrancaría mostrando una falla que no ocurrió.
    this.estado.set('sin_iniciar');
  }

  private baseUrl(): string {
    const apiUrl = environment.apiUrl;
    return apiUrl.startsWith('http') ? apiUrl.replace(/\/api$/, '') : `${window.location.protocol}//${window.location.host}`;
  }
}
