import { Injectable, signal, inject } from '@angular/core';
import { Subject } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../core/services/auth.service';
import type { ContextoFirma, FirmaRecibida } from '@megadulces/contracts';

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
 */
// `[CG.68]` El contrato de la firma vive en libs/contracts: lo comparten el servidor y esta
// pantalla. Reexportado para que quien usa este servicio no tenga que saber de dos lugares.
export type { ContextoFirma, FirmaRecibida } from '@megadulces/contracts';

@Injectable({ providedIn: 'root' })
export class CajaSocketService {
  private socket: Socket | null = null;
  private readonly auth = inject(AuthService);

  readonly connected = signal(false);
  readonly change$ = new Subject<CajaEvent>();

  /** `[CG.68]` El teléfono tecleó el código y ya está del otro lado. */
  readonly firmaTomada$ = new Subject<{ codigo: string; por: string | null }>();
  /** `[CG.68]` Llegó la firma. */
  readonly firmaRecibida$ = new Subject<FirmaRecibida>();
  /** `[CG.68]` Se cayó una de las dos puntas: no hay firma en camino. */
  readonly firmaCortada$ = new Subject<{ codigo: string }>();

  /** Cuántas pantallas montadas lo usan: la última en irse cierra el socket. */
  private users = 0;

  connect(): void {
    this.users++;
    // Idempotente por EXISTENCIA, no por estado: con `?.connected` un segundo connect() durante
    // el handshake ve false, crea OTRO socket y pisa la referencia — el primero queda huérfano,
    // reconectando solo y fuera del alcance de disconnect(). (Mismo defecto ya vivido en Bancos.)
    if (this.socket) { if (!this.socket.connected) this.socket.connect(); return; }
    const token = this.auth.token();
    if (!token) return;
    this.socket = io(`${this.baseUrl()}/caja`, {
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
    this.socket.on('caja_changed', (e: CajaEvent) => this.change$.next(e));
    // `[CG.68]` Los tres avisos del emparejamiento PC ↔ teléfono.
    this.socket.on('firma:tomada', (e: { codigo: string; por: string | null }) => this.firmaTomada$.next(e));
    this.socket.on('firma:recibida', (e: FirmaRecibida) => this.firmaRecibida$.next(e));
    this.socket.on('firma:cortada', (e: { codigo: string }) => this.firmaCortada$.next(e));
  }

  // ══ `[CG.68]` LA FIRMA DESDE EL TELÉFONO DEL MOSTRADOR ══════════════════════════════════
  //
  // Edgar: *"si esto lo estoy usando en pc, ¿cómo hago que esto se envíe a mi teléfono para que
  // se firme?"*. La PC pide un código, el teléfono lo teclea, y el PNG viaja por una room que es
  // de los dos — nunca por la del tenant, que tiene todas las cajas de la empresa adentro.

  /**
   * ⚠️ Con PLAZO. `emit` con confirmación espera para siempre si el servidor no contesta, y eso
   * deja un botón girando sin fin: el cajero no sabe si el código salió o si tiene que insistir.
   * Un socket mudo es una respuesta: `sin_respuesta`.
   */
  private pedir<T>(ev: string, cuerpo: unknown, plazoMs = 8000): Promise<T | { ok: false; error: 'sin_conexion' | 'sin_respuesta' }> {
    const s = this.socket;
    if (!s || !s.connected) return Promise.resolve({ ok: false as const, error: 'sin_conexion' as const });
    return new Promise((resolver) => {
      let contestado = false;
      const reloj = setTimeout(() => {
        if (!contestado) { contestado = true; resolver({ ok: false as const, error: 'sin_respuesta' as const }); }
      }, plazoMs);
      s.emit(ev, cuerpo, (r: T) => {
        if (contestado) return;
        contestado = true;
        clearTimeout(reloj);
        resolver(r);
      });
    });
  }

  /** La PC pide el código. Exige permiso de GESTIONAR del lado del servidor. */
  abrirFirma(ctx: ContextoFirma) {
    return this.pedir<{ ok: boolean; codigo?: string; vida_ms?: number; error?: string }>('firma:abrir', ctx);
  }

  /** El teléfono teclea el código. Con VER alcanza: aportar evidencia no es escribir el libro. */
  /** La PC cancela: suelta el codigo en vez de dejarlo reclamable los 3 minutos. */
  cerrarFirma() {
    return this.pedir<{ ok: boolean }>('firma:cerrar', {});
  }

  tomarFirma(codigo: string) {
    return this.pedir<{ ok: boolean; ctx?: ContextoFirma; error?: string }>('firma:tomar', { codigo });
  }

  /** El teléfono entrega la firma. El servidor la valida otra vez antes de repartirla. */
  enviarFirma(codigo: string, png: string, nombre: string | null) {
    return this.pedir<{ ok: boolean; error?: string }>('firma:enviar', { codigo, png, nombre });
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
