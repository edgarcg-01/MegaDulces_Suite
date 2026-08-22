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
  viewChild,
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
  template: `
    <div class="sp-root" [class.is-open]="open()" [class.is-above-modals]="aboveModals()">
      <div class="sp-backdrop" (click)="close()" aria-hidden="true"></div>
      <aside
        #panel
        class="sp-panel"
        [style.--sp-w]="widthPx()"
        role="dialog"
        aria-modal="true"
        [attr.aria-label]="title()"
        tabindex="-1"
      >
        <header class="sp-head">
          <div class="sp-head-text">
            <h2 class="sp-title">{{ title() }}</h2>
            @if (subtitle()) {
              <p class="sp-sub">{{ subtitle() }}</p>
            }
          </div>
          <button type="button" class="sp-close" (click)="close()" aria-label="Cerrar">
            <i class="pi pi-times" aria-hidden="true"></i>
          </button>
        </header>
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
      .sp-body {
        flex: 1;
        overflow-y: auto;
        padding: 1.25rem;
      }
      @media (prefers-reduced-motion: reduce) {
        .sp-root,
        .sp-backdrop,
        .sp-panel {
          transition: none;
        }
      }
    `,
  ],
})
export class SidePeekComponent {
  readonly open = model(false);
  /** Apilar por encima de los diálogos de PrimeNG. Ver la nota de z-index en los estilos. */
  readonly aboveModals = input(false);
  /** Ancho del panel en px. Default 520 (detalle ligero). Subilo sólo si adentro va un
   *  documento que se tiene que poder leer (O.1). */
  readonly width = input(520);
  protected readonly widthPx = computed(() => `${this.width()}px`);
  readonly title = input('');
  readonly subtitle = input<string | null>(null);

  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');
  private readonly doc = inject(DOCUMENT);

  constructor() {
    effect(() => {
      const isOpen = this.open();
      this.doc.body.style.overflow = isOpen ? 'hidden' : '';
      if (isOpen) {
        queueMicrotask(() => this.panel()?.nativeElement.focus());
      }
    });
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.open()) this.close();
  }

  close(): void {
    this.open.set(false);
  }
}
