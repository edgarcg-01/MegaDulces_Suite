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

  /**
   * ⛔⛔ **`connected` vale `false` por DOS motivos distintos y eso ya mintió en pantalla.**
   *
   * Nace en `false` y recién pasa a `true` en el evento `connect`, así que durante todo el
   * handshake "todavía no" y "no se pudo" se ven iguales. En `/finanzas/caja-general/firma`
   * —el teléfono que se le pasa a quien recibe el efectivo— eso costaba dos cosas a la vez: un
   * aviso ámbar *"revisá la red del teléfono"* apenas se escaneaba el QR, y, si la persona
   * tocaba Continuar antes de que abriera el canal, un `sin_conexion` que el traductor de
   * errores convierte en *"El QR venció (dura 3 minutos)"* — falso, y encima manda a buscar el
   * problema donde no está.
   *
   * Es la misma regla que esta pantalla ya aplica a los datos (ADR-056): una ausencia no se
   * pinta como la otra. Acá la ausencia es la conexión.
   *
   * `connected` SE QUEDA —lo leen otros consumidores y significa exactamente "se puede emitir"—
   * y este estado lo acompaña con el porqué.
   */
  readonly estado = signal<'sin_iniciar' | 'conectando' | 'vivo' | 'caido'>('sin_iniciar');

  /**
   * ⭐ `[CG.203]` **Por qué está `caido`**, que es lo que la persona necesita para saber qué hacer.
   *
   * `caido` juntaba tres causas con tres arreglos distintos, y el teléfono de la firma decía para
   * las tres *«revisa la red del teléfono»*:
   *
   *   · `sin_credencial`        — ni pase ni sesión (se tecleó el código en un teléfono sin
   *                               cuenta). La red está bien: lo que falta es escanear el QR.
   *   · `sesion_rechazada`      — la sesión que el teléfono guardaba ya venció.
   *   · `pase_rechazado`        — el pase del QR venció o no es un pase. Hace falta otro QR.
   *   · `red`                   — se cortó la conexión. Ésta sí es la red.
   *
   * `null` mientras no esté caído.
   */
  readonly motivoCaida = signal<'sin_credencial' | 'sesion_rechazada' | 'pase_rechazado' | 'red' | null>(null);

  readonly change$ = new Subject<CajaEvent>();

  /** `[CG.68]` El teléfono tecleó el código y ya está del otro lado. */
  readonly firmaTomada$ = new Subject<{ codigo: string; por: string | null }>();
  /** `[CG.68]` Llegó la firma. */
  readonly firmaRecibida$ = new Subject<FirmaRecibida>();
  /**
   * `[CG.68]` Se cayó **la PC**: no hay firma en camino y el emparejamiento ya no existe.
   *
   * ⚠️ `[CG.196]` Antes esto también llegaba cuando se caía el TELÉFONO, y la PC lo trataba igual
   * —desarmaba el emparejamiento—, así que bloquear el teléfono perdía la firma. Ese caso ahora
   * viaja por `firmaTelefonoSalio$`.
   */
  readonly firmaCortada$ = new Subject<{ codigo: string }>();
  /**
   * ⭐ `[CG.196]` El teléfono se desconectó (se bloqueó la pantalla, se fue el wifi) **y el
   * emparejamiento sigue vivo**: la marca vive en el socket de la PC. El mismo teléfono puede
   * volver y reclamar el mismo código, así que esto NO desarma nada — sólo se dice.
   */
  readonly firmaTelefonoSalio$ = new Subject<{ codigo: string }>();

  /** Cuántas pantallas montadas lo usan: la última en irse cierra el socket. */
  private users = 0;

  /**
   * `[CG.84]` Con qué credencial está abierto el socket. Hace falta porque los dos modos no son
   * intercambiables: un socket de sesión tiene al usuario adentro y está en la room del tenant;
   * uno de pase es un invitado atado a un solo código. Reusar uno por el otro daría permisos de
   * más o de menos, en silencio.
   */
  private modo: 'sesion' | 'pase' | null = null;

  /**
   * @param pase `[CG.84]` El pase del QR. Con pase NO hace falta sesión: es el modo del teléfono
   * que alguien agarra para firmar un recibo y que no tiene por qué ser un usuario del sistema.
   */
  connect(pase?: string | null): void {
    this.users++;
    const modoPedido: 'sesion' | 'pase' = pase ? 'pase' : 'sesion';
    // ⚠️ Si ya hay socket pero con la OTRA credencial, no se reusa: se cierra y se abre de nuevo.
    // Reusarlo dejaría al teléfono hablando con los permisos del cajero, o al cajero con los de
    // un invitado — y las dos equivocaciones son mudas.
    if (this.socket && this.modo !== modoPedido) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
      this.connected.set(false);
    }
    // Idempotente por EXISTENCIA, no por estado: con `?.connected` un segundo connect() durante
    // el handshake ve false, crea OTRO socket y pisa la referencia — el primero queda huérfano,
    // reconectando solo y fuera del alcance de disconnect(). (Mismo defecto ya vivido en Bancos.)
    if (this.socket) {
      if (!this.socket.connected) { this.motivoCaida.set(null); this.estado.set('conectando'); this.socket.connect(); }
      return;
    }
    const token = pase ? null : this.auth.token();
    // ⚠️ Sin credencial no se intenta siquiera, y eso NO es "conectando": es que no se puede.
    // Antes volvía en silencio y el estado quedaba en el `false` inicial, indistinguible de un
    // handshake en curso que nunca iba a terminar.
    if (!pase && !token) { this.motivoCaida.set('sin_credencial'); this.estado.set('caido'); return; }
    this.motivoCaida.set(null);
    this.estado.set('conectando');
    this.modo = modoPedido;
    this.socket = io(`${this.baseUrl()}/caja`, {
      path: '/reports/socket.io',
      auth: pase ? { pase } : { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1500,
    });
    this.socket.on('connect', () => { this.connected.set(true); this.motivoCaida.set(null); this.estado.set('vivo'); });
    // ⚠️ `[CG.203]` El servidor manda `auth_error` y RECIÉN DESPUÉS corta, así que el `disconnect`
    // llega segundo: si pisara el motivo, toda credencial rechazada se leería como «la red».
    this.socket.on('disconnect', () => {
      this.connected.set(false);
      if (this.motivoCaida() === null) this.motivoCaida.set('red');
      this.estado.set('caido');
    });
    this.socket.on('auth_error', () => {
      this.connected.set(false);
      this.motivoCaida.set(modoPedido === 'pase' ? 'pase_rechazado' : 'sesion_rechazada');
      this.estado.set('caido');
    });
    this.socket.on('caja_changed', (e: CajaEvent) => this.change$.next(e));
    // `[CG.68]` Los tres avisos del emparejamiento PC ↔ teléfono.
    this.socket.on('firma:tomada', (e: { codigo: string; por: string | null }) => this.firmaTomada$.next(e));
    this.socket.on('firma:recibida', (e: FirmaRecibida) => this.firmaRecibida$.next(e));
    this.socket.on('firma:cortada', (e: { codigo: string }) => this.firmaCortada$.next(e));
    // `[CG.196]` El teléfono se fue pero la firma sigue abierta: evento propio, reacción propia.
    this.socket.on('firma:telefono_salio', (e: { codigo: string }) => this.firmaTelefonoSalio$.next(e));
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

  /**
   * La PC pide el código. Exige permiso de GESTIONAR del lado del servidor.
   *
   * `[CG.84]` Devuelve además el **pase**, que es lo que va adentro del QR: con él el teléfono
   * entra sin iniciar sesión y ya con su código puesto.
   */
  abrirFirma(ctx: ContextoFirma) {
    return this.pedir<{ ok: boolean; codigo?: string; pase?: string; vida_ms?: number; error?: string }>('firma:abrir', ctx);
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
    this.modo = null;   // `[CG.84]` si no se limpia, el próximo connect() cree que sigue el modo viejo
    this.connected.set(false);
    // Cerrar a propósito no es caerse: vuelve al estado de arranque, o la próxima pantalla que
    // monte arrancaría mostrando una falla que no ocurrió.
    this.motivoCaida.set(null);
    this.estado.set('sin_iniciar');
  }

  private baseUrl(): string {
    const apiUrl = environment.apiUrl;
    return apiUrl.startsWith('http') ? apiUrl.replace(/\/api$/, '') : `${window.location.protocol}//${window.location.host}`;
  }
}
