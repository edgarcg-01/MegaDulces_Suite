import { Injectable, computed, inject, signal } from '@angular/core';
import { PermissionsService } from '../../core/services/permissions.service';
import { Permission } from '../../core/constants/permissions';
import { ArqueoDue, StoreSocketService } from './store-socket.service';

/**
 * SM.23 — "Haz tu arqueo": el aviso que le llega a la cajera esté donde esté.
 *
 * Hasta ahora el turno la esperaba en `/tienda/arqueo` y nada más. Si no abría esa
 * pantalla no se enteraba, y eso explica buena parte del 1% de cumplimiento: no es
 * que la gente se niegue a contar, es que **nada se lo pedía en el momento**. El
 * único aviso que salía solo era al supervisor, y recién a los 45 minutos — cuando
 * el efectivo ya se guardó y ella se fue a otra cosa.
 *
 * Vive en la raíz de la app, no en el módulo de arqueo, justamente porque el punto
 * es que aparezca aunque esté en otra pantalla.
 *
 * ── Dos canales, a propósito
 *
 * En pantalla: una barra fija que no se va sola. Un toast de 5 segundos en una caja
 * con clientes enfrente no lo ve nadie.
 *
 * Fuera de pantalla: notificación del navegador, **solo cuando la pestaña está
 * oculta**. Con la app a la vista la barra alcanza, y duplicar el aviso entrena a
 * ignorarlo. El permiso NO se pide al arrancar —un navegador que pregunta apenas
 * entrás se responde "bloquear" por reflejo— sino la primera vez que hay un arqueo
 * real que pedir, cuando la pregunta tiene contexto.
 */
@Injectable({ providedIn: 'root' })
export class ArqueoDueService {
  private readonly socket = inject(StoreSocketService);
  private readonly perms = inject(PermissionsService);

  /**
   * Todos los cortes que le faltan, no solo uno: una caja hace **dos cortes al
   * día** (mediodía y cierre) y en días largos más. Con un solo aviso, terminar el
   * primero apagaba la barra y el segundo quedaba invisible hasta el día siguiente.
   *
   * Se guardan con la hora en que llegó el aviso porque el backend los reemite
   * cada 5 min mientras sigan sin contar: el que deja de repetirse es el que ya se
   * contó, así que la lista se limpia sola sin que nadie avise "listo".
   */
  private readonly avisos = signal<Map<string, { a: ArqueoDue; visto: number }>>(new Map());
  /** Ventana de vigencia: 2 barridos y medio. Menos, y un barrido lento apaga la barra. */
  private static readonly VIGENCIA_MS = 13 * 60_000;

  /** Los vigentes, del más viejo al más nuevo — el primero es el que toca (SM.16). */
  readonly pendientes = computed(() => {
    const corte = Date.now() - ArqueoDueService.VIGENCIA_MS;
    return Array.from(this.avisos().values())
      .filter((x) => x.visto >= corte)
      .map((x) => x.a)
      .sort((p, q) => q.cerrado_hace_min - p.cerrado_hace_min);
  });
  readonly pendiente = computed(() => this.pendientes()[0] ?? null);
  readonly cuantos = computed(() => this.pendientes().length);
  readonly hay = computed(() => this.cuantos() > 0);

  private iniciado = false;
  /** Para no repetir la misma notificación de navegador en cada barrido (5 min). */
  private notificado = new Set<string>();

  /**
   * Arranca el canal si el usuario puede capturar arqueos. Idempotente: lo llama
   * el shell en cada boot y no debe abrir dos sockets.
   */
  iniciar(): void {
    if (this.iniciado) return;
    // `has()` ya devuelve true para los roles de plataforma, así que no hace falta
    // el chequeo de admin por separado.
    const puede = this.perms.has(Permission.STORE_ARQUEO_CAPTURAR);
    if (!puede) return;
    this.iniciado = true;
    this.socket.connect();
    this.socket.arqueoDue$.subscribe((a) => this.recibir(a));
  }

  private recibir(a: ArqueoDue): void {
    const m = new Map(this.avisos());
    m.set(this.llave(a), { a, visto: Date.now() });
    this.avisos.set(m);
    this.notificarNavegador(a);
  }

  /**
   * Saca un corte de la lista cuando ya se contó. Si quedan otros, la barra sigue
   * mostrando el siguiente en vez de apagarse — que es el caso de todos los días:
   * cuenta el de mediodía y todavía le falta el de cierre.
   */
  descartar(folio?: string): void {
    if (!folio) { this.avisos.set(new Map()); return; }
    const m = new Map(this.avisos());
    for (const [k, v] of m) if (v.a.folio === folio) m.delete(k);
    this.avisos.set(m);
  }

  private llave(a: ArqueoDue): string {
    return `${a.warehouse_code}:${a.caja}:${a.business_date}:${a.folio}`;
  }

  private notificarNavegador(a: ArqueoDue): void {
    if (typeof Notification === 'undefined') return;
    if (!document.hidden) return;                       // con la app a la vista, la barra alcanza
    const llave = this.llave(a);
    if (this.notificado.has(llave)) return;
    const lanzar = () => {
      try {
        this.notificado.add(llave);
        const n = new Notification('Haz tu arqueo', { body: a.message, tag: llave, requireInteraction: true });
        n.onclick = () => { window.focus(); n.close(); };
      } catch { /* el navegador puede negarlo sin avisar: queda la barra en pantalla */ }
    };
    if (Notification.permission === 'granted') lanzar();
    else if (Notification.permission === 'default') Notification.requestPermission().then((p) => { if (p === 'granted') lanzar(); });
  }
}
