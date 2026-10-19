import { Injectable, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, NavigationEnd, PRIMARY_OUTLET, Router, UrlTree } from '@angular/router';
import { filter } from 'rxjs/operators';
import { alCambiarEnOtraVentana, guardarPreferencia, leerPreferencia } from '../utils/cross-tab';

const CLAVE = 'mt.detallesAparte.v1';
/** `[MT.6]` Ancho del panel, en px. Vacio = sin tocar (manda el default del CSS). */
const CLAVE_ANCHO = 'mt.anchoPanel.v1';

/**
 * Dónde abre el detalle cuando hacés clic en un folio.
 *
 *  - 'aqui'    — como siempre: reemplaza la pantalla. El default.
 *  - 'lado'    — `[MT.5]` en el panel derecho, con la lista intacta a la izquierda.
 *  - 'ventana' — `[MT.3]` en otra ventana del navegador ('target="_blank"').
 */
export type ModoDetalle = 'aqui' | 'lado' | 'ventana';

const MODOS: readonly ModoDetalle[] = ['aqui', 'lado', 'ventana'];

/**
 * Multitarea: trabajar la Suite en varias ventanas (ADR-078).
 *
 * Son DOS cosas y conviene no confundirlas:
 *
 *  1. **La acción** — "abrir esta pantalla en otra ventana". No cambia nada de la
 *     app: si no la usás, todo se comporta igual que siempre.
 *  2. **La preferencia** — "abrir siempre los detalles aparte". Mientras está
 *     prendida, los enlaces de drill-down llevan 'target="_blank"' y el navegador
 *     los abre en una ventana nueva sin que haya que hacer Ctrl+clic.
 *
 * ── Por qué la preferencia es un 'target' y no lógica nuestra ─────────────────
 * 'RouterLink' ya deja pasar la navegación NATIVA cuando el 'target' es un string
 * distinto de '_self' (verificado en el fuente del router, no asumido). Así que
 * toda la preferencia es un atributo: cero interceptores de clic, cero
 * 'window.open' nuestro, cero trabajo en cada render. Es lo que hace que esto sea
 * imperceptible en rendimiento — el pedido explícito del usuario.
 *
 * ── Por qué se sincroniza entre ventanas ──────────────────────────────────────
 * Una preferencia de multitarea que NO llega a las otras ventanas es una
 * preferencia que miente: la prendés en una, mirás la otra y se comporta al
 * revés. Se escucha 'storage' ('core/utils/cross-tab'), que es exactamente el
 * mecanismo que la Suite no tenía (cero listeners, medido).
 */
@Injectable({ providedIn: 'root' })
export class MultitareaService {
  private readonly router = inject(Router);

  /** Dónde abre el detalle. Se persiste y se sincroniza entre ventanas. */
  private readonly _modo = signal<ModoDetalle>(leerModo());
  readonly modo = this._modo.asReadonly();

  /** Compatibilidad con `[MT.3]`: "aparte" es cualquiera de los dos modos que no reemplazan la pantalla. */
  readonly detallesAparte = computed(() => this._modo() !== 'aqui');

  /**
   * La ruta del ÁREA, que es el nivel donde vive el outlet `panel`. La registra
   * el layout al montarse; sin ella el modo 'lado' no puede armar el enlace y
   * **cae a 'aqui'** en vez de romperse: un enlace que no navega es peor que uno
   * que navega distinto.
   */
  private rutaArea: ActivatedRoute | null = null;
  registrarRutaDelArea(r: ActivatedRoute): void { this.rutaArea = r; }

  /**
   * `[MT.5]` **Kiosco**: la persona con una sola pantalla, sin chrome.
   *
   * Lo sabe el layout (lo deduce de cuántos items le quedan en el nav) y lo
   * necesita el panel, que vive en la raíz y no ve esa cuenta. Va acá y no en
   * un servicio nuevo porque es estado de la pantalla partida: el panel no se
   * abre donde no hay dónde abrirlo.
   *
   * ⚠️ El layout lo apaga al desmontarse. Sin eso, salir de un área en kiosco a
   * una pantalla sin layout dejaría el valor pegado y el panel no abriría más.
   */
  private readonly _kiosco = signal(false);
  readonly kiosco = this._kiosco.asReadonly();
  declararKiosco(v: boolean): void { this._kiosco.set(v); }

  /**
   * `[MT.6]` **Dónde quedó el divisor**, en píxeles de ancho del panel.
   *
   * `null` = sin tocar: manda el default del CSS (`clamp(24rem, 46%, 60rem)`).
   * Se guarda como preferencia y se sincroniza entre ventanas por el mismo
   * mecanismo que el modo — mover el divisor en una ventana y que la otra siga
   * en la mitad es la misma clase de mentira que `[MT.2]` vino a cerrar.
   *
   * ⚠️ Se guarda el PÍXEL, no el porcentaje: la persona acomoda el divisor para
   * que entre algo concreto (una tabla de 7 columnas), y eso es un ancho, no una
   * proporción. En una ventana más chica el `clamp` de abajo lo recorta.
   */
  private readonly _anchoPanel = signal<number | null>(leerAncho());
  readonly anchoPanel = this._anchoPanel.asReadonly();

  ponerAnchoPanel(px: number | null): void {
    this._anchoPanel.set(px);
    guardarPreferencia(CLAVE_ANCHO, px === null ? '' : String(Math.round(px)));
  }

  /**
   * Lo que se le pasa a '[target]' de un enlace de drill-down.
   *
   * 'undefined' y no '_self': con '_self' RouterLink igual entra por su camino,
   * pero el atributo queda escrito en el DOM sin necesidad. Sin valor, no hay
   * atributo y el enlace es un enlace normal del SPA.
   *
   * ⚠️ 'undefined', NO 'null': el input 'target' de RouterLink esta tipado
   * 'string | undefined'. Con null compila 'tsc --noEmit' y REVIENTA el
   * compilador de plantillas de Angular -- la mitad de la cobertura que el
   * chequeo de tipos suelto no da.
   */
  readonly target = computed<string | undefined>(() => (this._modo() === 'ventana' ? '_blank' : undefined));

  constructor() {
    // Otra ventana cambió la preferencia.
    alCambiarEnOtraVentana(CLAVE, (v) => this._modo.set(normalizar(v)));
    alCambiarEnOtraVentana(CLAVE_ANCHO, (v) => this._anchoPanel.set(aPx(v)));
    // El enlace al panel depende del primario, así que la memoria se vacía al navegar.
    this.router.events.pipe(filter((e) => e instanceof NavigationEnd)).subscribe(() => this.memoria.clear());
  }

  ponerModo(m: ModoDetalle): void {
    this._modo.set(m);
    guardarPreferencia(CLAVE, m);
    this.memoria.clear();
  }

  /**
   * `[MT.5]` El enlace de un drill-down, según el modo.
   *
   * En 'aqui' devuelve **los mismos comandos que recibió**, sin tocarlos: la
   * plantilla los arma con un literal que Angular memoiza, así que la
   * referencia no cambia entre ciclos y el binding no se recalcula. Ése es el
   * caso por default y tiene que costar cero.
   *
   * En 'lado' arma el árbol con el outlet `panel`, memoizado por (primario +
   * destino) — sin la memoria se construiría un `UrlTree` por fila y por ciclo
   * de detección.
   */
  private readonly memoria = new Map<string, UrlTree>();
  enlaceDetalle(comandos: readonly unknown[]): readonly unknown[] | UrlTree {
    if (this._modo() !== 'lado' || !this.rutaArea) return comandos;
    const clave = comandos.map(String).join('/');
    let arbol = this.memoria.get(clave);
    if (!arbol) {
      arbol = this.router.createUrlTree([{ outlets: { panel: segmentos(comandos) } }], { relativeTo: this.rutaArea });
      this.memoria.set(clave, arbol);
    }
    return arbol;
  }

  /**
   * `[MT.3]` Abre la pantalla actual aparte **donde dice la preferencia**.
   *
   * ⛔ Antes abría ventana SIEMPRE, y eso hacía mentir al menú: alguien elegía
   * «Abrirlo al lado (pantalla partida)», apretaba el botón y le saltaba una
   * pestaña igual. Reportado por Edgar el 2026-10-16. Una preferencia que el
   * botón de al lado ignora no es una preferencia, es un adorno.
   *
   *  - `'lado'`   → esta misma pantalla en el panel derecho, con la de la
   *                 izquierda intacta. Es el caso de comparar dos cortes del
   *                 mismo reporte sin perder el primero.
   *  - el resto   → otra ventana del navegador.
   *
   * ⚠️ `'aqui'` cae a ventana A PROPÓSITO: "reemplazar esta pantalla" no tiene
   * sentido cuando lo que se abre ES esta pantalla —el gesto no haría nada y un
   * botón que no hace nada se lee como roto—, y el botón existe justamente para
   * abrir aparte.
   */
  abrirEstaPantallaAparte(): void {
    if (this._modo() === 'lado' && this.rutaArea && this.alLado()) return;
    if (typeof window === 'undefined') return;
    // 'noopener' no es ceremonia: sin él la ventana nueva recibe 'window.opener'
    // y puede navegar a la que la abrió. Además le deja al navegador liberar el hilo.
    window.open(window.location.href, '_blank', 'noopener');
  }

  /**
   * Duplica la pantalla actual en el outlet `panel`. Devuelve `false` si no se
   * pudo armar el árbol, para que quien llama **caiga a la ventana** en vez de
   * quedarse sin hacer nada.
   *
   * ⚠️ Los query params se llevan a mano. `createUrlTree` NO los arrastra, y sin
   * ellos el panel abriría la pantalla **sin el filtro, la búsqueda ni el rango
   * de fechas** que la persona está mirando — o sea: no sería la misma pantalla,
   * que es lo único que este gesto promete.
   */
  private alLado(): boolean {
    const actual = this.router.parseUrl(this.router.url);
    const primario = caminoPrimario(actual);
    if (!primario) return false;
    const arbol = this.router.createUrlTree([{ outlets: { panel: segmentos([primario]) } }], {
      relativeTo: this.rutaArea,
      queryParams: actual.queryParams,
      fragment: actual.fragment ?? undefined,
    });
    void this.router.navigateByUrl(arbol);
    return true;
  }
}

/**
 * El camino de la rama PRIMARIA, sin los outlets auxiliares.
 *
 * ⚠️ `router.url` ya puede traer un panel abierto
 * (`/compras/(ordenes//panel:compras/ordenes/ID)`); meter eso tal cual dentro de
 * otro outlet anida el split dentro del split. Se recorre la rama primaria y se
 * deja el resto afuera.
 */
function caminoPrimario(arbol: UrlTree): string {
  const partes: string[] = [];
  let grupo = arbol.root;
  for (;;) {
    const hijo = grupo.children[PRIMARY_OUTLET];
    if (!hijo) break;
    partes.push(...hijo.segments.map((s) => s.path));
    grupo = hijo;
  }
  return partes.length ? '/' + partes.join('/') : '';
}

/**
 * Lee el ancho guardado. Vacio, ausente o basura caen a `null` = sin tocar.
 * ⚠️ `Number('')` es 0, no NaN: sin el corte explicito, borrar la preferencia
 * dejaria el panel con 0 px de ancho en vez de devolverle el default.
 */
function aPx(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function leerAncho(): number | null {
  return aPx(leerPreferencia(CLAVE_ANCHO));
}

/** Lee el modo guardado. El '1' es el formato viejo de `[MT.3]` (booleano). */
function leerModo(): ModoDetalle {
  return normalizar(leerPreferencia(CLAVE));
}

function normalizar(v: string | null): ModoDetalle {
  if (v === '1') return 'ventana'; // lo que guardó `[MT.3]` antes de que hubiera panel
  return (MODOS as readonly string[]).includes(v ?? '') ? (v as ModoDetalle) : 'aqui';
}

/**
 * Parte los comandos en SEGMENTOS de URL.
 *
 * ⚠️ No es cosmético. Dentro de un objeto de outlets, un comando de texto es
 * **un solo segmento**: `'/compras/requisiciones'` sale como
 * `panel:%2Fcompras%2Frequisiciones` —con las barras escapadas— y no matchea
 * ninguna ruta, así que el panel no abre. Lo destapó la prueba renderizada; el
 * candado sobre el fuente no lo habría visto nunca, porque en el fuente el
 * enlace se ve perfecto.
 */
function segmentos(comandos: readonly unknown[]): unknown[] {
  return comandos.flatMap((c) => (typeof c === 'string' ? c.split('/').filter(Boolean) : [c]));
}
