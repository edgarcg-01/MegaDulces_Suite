import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  effect,
  inject,
  input,
  model,
  viewChild,
} from '@angular/core';
import { CommonModule, DOCUMENT } from '@angular/common';

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
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sp-root" [class.is-open]="open()">
      <div class="sp-backdrop" (click)="close()" aria-hidden="true"></div>
      <aside
        #panel
        class="sp-panel"
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
      .sp-root {
        position: fixed;
        inset: 0;
        z-index: 1200;
        visibility: hidden;
        pointer-events: none;
      }
      .sp-root.is-open {
        visibility: visible;
        pointer-events: auto;
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
        width: min(520px, 100vw);
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
