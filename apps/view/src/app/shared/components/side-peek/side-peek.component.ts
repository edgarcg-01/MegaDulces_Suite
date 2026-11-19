import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  input,
  model,
  signal,
  viewChild,
  afterNextRender,
  Injector,
  DOCUMENT
} from '@angular/core';


/**
 * Side-peek drawer — organismo canónico de detalle (DESIGN.md regla #8).
 * Overlay = sombra + borde (regla de elevación). Slide desde la derecha ~520px, 250ms.
 * Ver/editar un registro sin perder el contexto de la lista. Reusable en CRM/Inventario/Pedidos.
 *
 * Uso:
 *   <app-side-peek [open]="peekOpen()" (openChange)="peekOpen.set($event)"
 *                  title="Cliente" subtitle="ABARROTES X · ABC-001">
 *     ...contenido proyectado...
 *   </app-side-peek>
 */
@Component({
  selector: 'app-side-peek',
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // `[CGA-A.65]` El título se pasa como atributo (`title="Reposición"`) y Angular lo deja TAMBIÉN en el
  // elemento: el navegador pintaba su globo nativo encima de toda la ventana, tapando cifras (captura
  // de Edgar, 2026-10-29: «Reposición» sobre «2 documentos siguen en la cola»). El título ya va en el h2.
  host: { '[attr.title]': 'null' },
  template: `
    <div class="sp-root" [class.is-open]="open()" [class.is-above-modals]="aboveModals()"
         [class.is-window]="mode() === 'window'" [class.is-izq]="lado() === 'izquierda'">
      <div class="sp-backdrop" (click)="pedirCierre()" aria-hidden="true"></div>
      <aside
        #panel
        class="sp-panel"
        [style.--sp-w]="widthPx()"
        role="dialog"
        aria-modal="true"
        [attr.aria-label]="title()"
        tabindex="-1"
        (keydown.tab)="atraparTab($event, false)"
        (keydown.shift.tab)="atraparTab($event, true)"
      >
        <header class="sp-head">
          <div class="sp-head-text">
            <h2 class="sp-title">{{ title() }}</h2>
            @if (subtitle()) {
              <p class="sp-sub">{{ subtitle() }}</p>
            }
          </div>
          <button type="button" class="sp-close" (click)="pedirCierre()" aria-label="Cerrar">
            <i class="pi pi-times" aria-hidden="true"></i>
          </button>
        </header>
        <!-- [LE.6.34] Con algo capturado, cerrar PREGUNTA (modern-web-guidance «dialog»: confirmación explícita
             en formularios con cambios). El foco cae en «seguir»: un segundo Esc o Enter no descarta nada. -->
        @if (confirmando()) {
          <div class="sp-confirma" role="alertdialog" aria-labelledby="sp-confirma-t" aria-describedby="sp-confirma-d"
               data-testid="sp-confirma">
            <p class="sp-confirma-t" id="sp-confirma-t">¿Descartar lo que capturaste?</p>
            <p class="sp-confirma-d" id="sp-confirma-d">{{ textoDescartar() }}</p>
            <div class="sp-confirma-acc">
              <button #btnSeguir type="button" class="sp-btn sp-btn--main" (click)="seguir()" data-testid="sp-seguir">{{ textoSeguir() }}</button>
              <button type="button" class="sp-btn sp-btn--bad" (click)="descartar()" data-testid="sp-descartar">Descartar y cerrar</button>
            </div>
          </div>
        }
        <div class="sp-body">
          <ng-content></ng-content>
        </div>
      </aside>
    </div>
  `,
  styles: [
    `
      /* z-index POR DEBAJO de la capa de overlays de PrimeNG (overlay/menu: 1000,
         modal/tooltip: 1100 — defaults verificados en primeng-config.mjs).

         Este drawer lo dibujamos a mano, así que PrimeNG no lo conoce ni lo mete en
         su pila de apilado. Con 1200, el panel de un p-select montado en <body>
         salía en 1000 y quedaba DETRÁS del drawer: el desplegable abría y no se
         veía. Todo lo que se lanza desde adentro (desplegables, tooltips, diálogos
         de confirmación) tiene que poder taparlo. Sigue sobrado por encima del
         chrome de la app, que no pasa de 30. NO subirlo sin resolver eso primero. */
      /* CERRADO = no existe. Ni para el puntero ni para el lector de pantalla.
         .sp-root es una capa fija a pantalla completa (inset: 0) y el backdrop queda en
         opacity: 0 — invisible, pero se come TODOS los clics de la página si no se apaga
         acá. Estas dos declaraciones vivían en .sp-root y el commit 6b4146c9 (2026-08-20)
         las dejó dentro del bloque nuevo .is-above-modals al insertarlo, o sea el default
         quedó roto. Resultado: 8 de las 10 pantallas con side-peek se veían pintadas y no
         respondían a nada ("se queda congelado"). El Centro de control monta DOS, así que
         eran dos capas. NO mover de acá. */
      .sp-root {
        position: fixed;
        inset: 0;
        z-index: 900;
        visibility: hidden;
        pointer-events: none;
        /* La visibilidad espera a que termine el slide-out; si no, el panel se corta de golpe. */
        transition: visibility 0s linear 250ms;
      }
      /* Se abre DESDE un diálogo (aboveModals): tiene que taparlo, no quedar debajo.
         Va acá adentro y no como override desde afuera: un
         ":host ::ng-deep .sp-root" de otro componente compila con la MISMA
         especificidad que ".sp-root" de esta hoja, así que quién gana depende del
         orden en el bundle — el cajón salía arriba o abajo según el día. Con la
         clase propia la regla es local y determinista. Solo activarlo cuando adentro
         del cajón NO haya overlays de PrimeNG (select, tooltip, confirm): esos
         nacen en 1000/1100 y quedarían tapados. */
      .sp-root.is-above-modals {
        z-index: 1200;
      }
      .sp-root.is-open {
        visibility: visible;
        pointer-events: auto;
        transition-delay: 0s;
      }
      .sp-backdrop {
        position: absolute;
        inset: 0;
        background: rgba(16, 13, 9, 0.45);
        opacity: 0;
        transition: opacity 250ms var(--ease-out, cubic-bezier(0.23, 1, 0.32, 1));
      }
      .sp-root.is-open .sp-backdrop {
        opacity: 1;
      }
      .sp-panel {
        position: absolute;
        top: 0;
        right: 0;
        height: 100%;
        /* 520px es el detalle ligero (regla #8). Un expediente que incluye el DOCUMENTO
           necesita más: DESIGN.md O.1 prohíbe leer un documento financiero extenso en un
           overlay apretado, así que quien muestra uno sube el ancho por input. */
        width: min(var(--sp-w, 520px), 100vw);
        background: var(--card-bg);
        border-left: 1px solid var(--border-color);
        box-shadow: -8px 0 30px -12px rgba(0, 0, 0, 0.25);
        display: flex;
        flex-direction: column;
        transform: translateX(100%);
        transition: transform 250ms var(--ease-drawer, cubic-bezier(0.32, 0.72, 0, 1));
      }
      .sp-root.is-open .sp-panel {
        transform: translateX(0);
      }
      /* ── Variante IZQUIERDA ───────────────────────────────────────────────────────────
         Aditiva: lado nace en 'derecha', así que las 31 pantallas que ya montan este
         cajón no cambian una sola regla.

         Existe porque en Caja General la lista ocupa la pantalla entera y el arqueo entra
         al lado: con el cajón a la derecha, el panel tapa la columna del IMPORTE —la cifra
         contra la que se está contando— justo mientras se cuenta. A la izquierda tapa la
         fecha, que ya se leyó.

         ⚠️ La regla de ABIERTO lleva las dos clases a propósito. .sp-root.is-open
         .sp-panel y .sp-root.is-izq .sp-panel tienen la MISMA especificidad, así que
         quién gana dependería del orden en el bundle — exactamente el defecto que la nota
         de is-above-modals documenta más arriba, y que hizo que el cajón saliera arriba o
         abajo según el día. Con .is-izq.is-open la regla es determinista. */
      .sp-root.is-izq .sp-panel {
        right: auto;
        left: 0;
        border-left: none;
        border-right: 1px solid var(--border-color);
        box-shadow: 8px 0 30px -12px rgba(0, 0, 0, 0.25);
        transform: translateX(-100%);
      }
      .sp-root.is-izq.is-open .sp-panel {
        transform: translateX(0);
      }
      .sp-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 1rem;
        padding: 1rem 1.25rem;
        border-bottom: 1px solid var(--border-color);
        flex-shrink: 0;
      }
      .sp-head-text {
        min-width: 0;
      }
      .sp-title {
        margin: 0;
        font-size: var(--fs-h3, 1rem);
        font-weight: var(--fw-bold, 700);
        letter-spacing: -0.01em;
        color: var(--text-main);
        line-height: 1.2;
      }
      .sp-sub {
        margin: 0.25rem 0 0;
        font-size: var(--fs-xs, 0.75rem);
        color: var(--text-muted);
        line-height: 1.3;
      }
      .sp-close {
        flex-shrink: 0;
        width: 36px;
        height: 36px;
        display: grid;
        place-items: center;
        border: none;
        border-radius: var(--r-sm, 8px);
        background: transparent;
        color: var(--text-muted);
        cursor: pointer;
        transition: background-color 120ms var(--ease-out, ease);
      }
      .sp-close:hover {
        background: var(--hover-bg);
        color: var(--text-main);
      }
      .sp-close:focus-visible {
        outline: 2px solid var(--action);
        outline-offset: 2px;
      }
      .sp-confirma {
        flex-shrink: 0;
        padding: 0.75rem 1.25rem;
        border-bottom: 1px solid var(--border-color);
        background: var(--warn-soft-bg);
        color: var(--text-main);
      }
      .sp-confirma-t { margin: 0; font-weight: var(--fw-bold, 700); font-size: var(--fs-sm, 0.875rem); }
      .sp-confirma-d { margin: 0.25rem 0 0.5rem; font-size: var(--fs-sm, 0.875rem); }
      .sp-confirma-acc { display: flex; gap: 0.5rem; flex-wrap: wrap; }
      .sp-btn {
        min-height: 36px;
        padding: 0 0.875rem;
        border-radius: var(--r-sm, 8px);
        font: inherit;
        font-size: var(--fs-sm, 0.875rem);
        cursor: pointer;
      }
      @media (pointer: coarse) { .sp-btn, .sp-close { min-height: 44px; min-width: 44px; } }
      .sp-btn--main { border: 1px solid var(--action); background: var(--action); color: var(--action-contrast, #fff); }
      .sp-btn--bad { border: 1px solid var(--border-color); background: var(--card-bg); color: var(--bad-soft-fg, var(--text-main)); }
      .sp-btn:focus-visible { outline: 2px solid var(--focus-ring, var(--action)); outline-offset: 2px; }
      .sp-body {
        flex: 1;
        overflow-y: auto;
        overscroll-behavior: contain;
        padding: 1.25rem;
      }
      /* ── Modo VENTANA ──────────────────────────────────────────────────────────────────
         Mismo organismo, otra forma. Existe porque hay detalles que NO caben en 520px: el
         de venta por ruta trae nueve metricas y una tabla de productos, y en el cajon la
         tabla salia con el nombre partido en tres renglones.

         Se sacrifica a proposito lo que el cajon da -ver el detalle SIN perder la lista- a
         cambio de poder leer el contenido. Por eso es un modo y no el default: las otras
         pantallas, que muestran un registro, siguen con el cajon.

         Lo que NO cambia: role=dialog, aria-modal, Esc, clic en el fondo, bloqueo de scroll
         y foco al abrir. Son del organismo, no del modo. */
      .sp-root.is-window {
        display: grid;
        place-items: center;
        padding: var(--space-4, 1rem);
      }
      .sp-root.is-window .sp-panel {
        position: relative;
        top: auto;
        right: auto;
        width: min(var(--sp-w, 1180px), 100%);
        /* Alto por contenido pero con techo: una ventana que crece hasta tapar la pantalla
           deja de leerse como ventana. El cuerpo scrollea solo (.sp-body ya es flex:1). */
        height: auto;
        max-height: min(88vh, 900px);
        border: 1px solid var(--border-color);
        border-radius: var(--r-lg, 14px);
        box-shadow: 0 24px 60px -20px rgba(0, 0, 0, 0.35);
        /* Entra con escala y no con deslizamiento: el deslizamiento lateral dice "esto viene
           del borde", y esta no viene del borde. */
        transform: translateY(8px) scale(0.98);
        opacity: 0;
        transition:
          transform 200ms var(--ease-emphasized, cubic-bezier(0.2, 0, 0, 1)),
          opacity 150ms var(--ease-out, ease);
      }
      .sp-root.is-window.is-open .sp-panel {
        transform: translateY(0) scale(1);
        opacity: 1;
      }
      /* En pantalla chica la ventana ocupa casi todo: a 1180px de ancho pedido sobre 390px
         de pantalla, lo que se gana en una no se puede perder en la otra. */
      @container (max-width: 53.75rem) {
        .sp-root.is-window {
          padding: 0;
        }
        .sp-root.is-window .sp-panel {
          width: 100%;
          max-height: 100%;
          height: 100%;
          border-radius: 0;
          border: none;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .sp-root,
        .sp-backdrop,
        .sp-panel {
          transition: none;
        }
        /* Sin animacion, pero visible: sin esto la ventana se queda en opacity 0. */
        .sp-root.is-window .sp-panel {
          transform: none;
          opacity: 1;
        }
      }
    `,
  ],
})
export class SidePeekComponent {
  readonly open = model(false);
  /** Apilar por encima de los diálogos de PrimeNG. Ver la nota de z-index en los estilos. */
  readonly aboveModals = input(false);
  /**
   * `drawer` (default) = cajón lateral, el patrón canónico: ver el detalle **sin perder la
   * lista** (DESIGN.md §datos densos 8).
   *
   * `window` = ventana centrada. ⚠️ **Es una desviación consciente de esa regla**, no el
   * camino fácil: se usa cuando el detalle no cabe en un cajón y la lista pasa a segundo
   * plano. El caso que lo justificó: venta por ruta, con nueve métricas y una tabla de
   * productos que en 520px salía con el nombre partido en tres renglones.
   *
   * Si el detalle es un registro, va `drawer`. Elegir `window` porque "se ve más grande"
   * cambia el patrón de toda una superficie por una pantalla.
   */
  readonly mode = input<'drawer' | 'window'>('drawer');
  /**
   * De qué borde entra el cajón. `derecha` es el default y **no se cambia por gusto**: es
   * la convención de toda la superficie, y un cajón que entra por donde no se espera se
   * siente como otra pantalla.
   *
   * `izquierda` se justifica cuando el panel taparía la columna que la persona está
   * leyendo mientras lo usa. El caso que lo trajo: Caja General, donde la lista ocupa la
   * pantalla y el arqueo entra al lado — con el cajón a la derecha tapa el IMPORTE, que es
   * la cifra contra la que se cuenta el efectivo. Sin efecto en `window`, que va centrada.
   */
  readonly lado = input<'derecha' | 'izquierda'>('derecha');
  /** Ancho del panel en px. `0` = el que corresponde al modo (520 cajón / 1180 ventana).
   *  Subilo sólo si adentro va un documento que se tiene que poder leer (O.1). */
  readonly width = input(0);
  protected readonly widthPx = computed(() => {
    const w = this.width();
    if (w > 0) return `${w}px`;
    return this.mode() === 'window' ? '1180px' : '520px';
  });
  readonly title = input('');
  readonly subtitle = input<string | null>(null);

  /**
   * ⭐ `[LE.6.34]` **Hay algo capturado adentro**: cerrar (Esc, X, clic en el fondo) PREGUNTA antes de
   * descartarlo. Auditoría del 2026-11-18: el arqueo de Caja General se cerraba con un Esc y al reabrir
   * las piezas contadas, la firma y el documento volvían a cero. Aditivo: sin el input, nada cambia.
   */
  readonly sucio = input(false);
  /** Qué se pierde, en palabras de la pantalla. */
  readonly textoDescartar = input('Se pierde lo que tecleaste y no se guardó.');
  readonly textoSeguir = input('Seguir aquí');
  protected readonly confirmando = signal(false);

  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');
  private readonly seguirBtn = viewChild<ElementRef<HTMLButtonElement>>('btnSeguir');
  private readonly doc = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  /** Quién tenía el foco al abrir: ahí regresa al cerrar (guía «accessibility» §5). */
  private focoPrevio: HTMLElement | null = null;

  constructor() {
    effect(() => {
      const isOpen = this.open();
      this.doc.body.style.overflow = isOpen ? 'hidden' : '';
      if (isOpen) {
        const activo = this.doc.activeElement as HTMLElement | null;
        if (activo && activo !== this.doc.body && !this.panel()?.nativeElement.contains(activo)) this.focoPrevio = activo;
        queueMicrotask(() => this.panel()?.nativeElement.focus());
      } else {
        this.confirmando.set(false);
        const previo = this.focoPrevio;
        this.focoPrevio = null;
        // Sólo si nadie más movió el foco (quien cierra puede mandarlo a otro lado a propósito).
        queueMicrotask(() => {
          const activo = this.doc.activeElement;
          const perdido = !activo || activo === this.doc.body || !!this.panel()?.nativeElement.contains(activo);
          if (perdido && previo?.isConnected) previo.focus();
        });
      }
    });
  }

  /**
   * ⛔ `[LE.6.34]` Esc cierra SÓLO la capa de arriba. Antes cerraba el cajón siempre: PrimeNG escucha Esc en
   * `document` sin detenerlo, así que un Esc en «¿Guardas este movimiento?» (o en el calendario, o en un
   * desplegable) cerraba esa capa Y el cajón de abajo, con el conteo adentro.
   */
  @HostListener('document:keydown.escape', ['$event'])
  onEscape(evento?: Event): void {
    const ev = evento as KeyboardEvent | undefined;
    if (!this.open()) return;
    if (this.confirmando()) { this.seguir(); ev?.preventDefault(); return; }
    if (ev && this.escPerteneceAOtraCapa(ev)) return;
    this.pedirCierre();
  }

  /** ¿El Esc es de una capa que está ENCIMA de este cajón (un diálogo, un desplegable, un calendario)? */
  private escPerteneceAOtraCapa(ev: KeyboardEvent): boolean {
    if (ev.defaultPrevented) return true;
    const panel = this.panel()?.nativeElement;
    const destino = ev.target instanceof Element ? ev.target : null;
    const capa = destino?.closest('.p-dialog, .p-overlay, .p-datepicker-panel, .p-select-overlay, .p-autocomplete-overlay, [role="listbox"], [role="menu"]');
    if (capa && !panel?.contains(capa)) return true;
    // Un diálogo modal abierto ENCIMA (este cajón no está sobre los modales): el Esc es suyo.
    return !this.aboveModals() && !!this.doc.querySelector('.p-dialog-mask');
  }

  /**
   * `[LE.6.34]` El panel es `aria-modal`: Tab da la vuelta DENTRO de él en vez de salir a la página de atrás
   * (guía «accessibility» §12). Sólo actúa en los bordes —del último al primero y al revés—, así que no toca el
   * recorrido normal ni los desplegables de PrimeNG que se montan en `body` (ésos manejan su propio teclado).
   */
  atraparTab(evento: Event, haciaAtras: boolean): void {
    const panel = this.panel()?.nativeElement;
    if (!panel || !this.open()) return;
    const enfocables = Array.from(panel.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter((el) => !el.closest('[hidden], [inert]') && el.getClientRects().length > 0);
    if (!enfocables.length) return;
    const primero = enfocables[0];
    const ultimo = enfocables[enfocables.length - 1];
    const activo = this.doc.activeElement;
    if (!haciaAtras && (activo === ultimo || activo === panel)) { evento.preventDefault(); primero.focus(); }
    else if (haciaAtras && (activo === primero || activo === panel)) { evento.preventDefault(); ultimo.focus(); }
  }

  /** Cerrar desde la persona: si hay algo capturado, primero pregunta. */
  pedirCierre(): void {
    if (this.sucio()) {
      this.confirmando.set(true);
      afterNextRender(() => this.seguirBtn()?.nativeElement.focus(), { injector: this.injector });
      return;
    }
    this.close();
  }

  seguir(): void {
    this.confirmando.set(false);
    queueMicrotask(() => this.panel()?.nativeElement.focus());
  }

  descartar(): void {
    this.confirmando.set(false);
    this.close();
  }

  close(): void {
    this.open.set(false);
  }
}
