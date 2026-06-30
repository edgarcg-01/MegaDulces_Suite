import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  input,
  model,
  output,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TypeHintDirective } from './type-hint.directive';

/**
 * Buscador único del portal — un solo componente para /home y /catalog.
 *  - mode="trigger": botón estilizado (home) que navega al catálogo; emite (activate).
 *  - mode="input":   input real (catalog) con toggle IA, limpiar e historial vía slots
 *    del padre. El valor es two-way (`[(value)]`).
 * El chrome (icono + placeholder typewriter + ⌘K) es idéntico en ambos: "el mismo buscador".
 */
@Component({
  selector: 'portal-search-bar',
  standalone: true,
  imports: [CommonModule, FormsModule, TypeHintDirective],
  template: `
    @if (mode() === 'trigger') {
      <button type="button" class="psb psb-trigger" (click)="activate.emit()" [attr.aria-label]="hintBase()">
        <i class="pi pi-search psb-icon" aria-hidden="true"></i>
        <span
          class="psb-placeholder"
          [typeHint]="hints()"
          [typeHintPrefix]="hintPrefix()"
          [typeHintBase]="hintBase()"
        >{{ hintBase() }}</span>
        @if (showKbd()) {
          <span class="psb-kbd" aria-hidden="true">⌘K</span>
        }
      </button>
    } @else {
      <div class="psb psb-input" [class.is-ai]="ai()">
        <i [class]="ai() ? 'pi pi-bolt psb-icon psb-icon-ai' : 'pi pi-search psb-icon'" aria-hidden="true"></i>
        <input
          #inputEl
          type="text"
          [ngModel]="value()"
          (ngModelChange)="value.set($event)"
          [typeHint]="hints()"
          [typeHintPrefix]="hintPrefix()"
          [typeHintBase]="hintBase()"
          [attr.aria-label]="hintBase()"
          autocomplete="off"
          autocapitalize="none"
          autocorrect="off"
          spellcheck="false"
        />
        @if (showClear() && value()) {
          <button type="button" class="psb-clear" (click)="clear.emit()" aria-label="Limpiar búsqueda">
            <i class="pi pi-times" aria-hidden="true"></i>
          </button>
        }
        @if (showAiToggle()) {
          <button
            type="button"
            class="psb-mode"
            [class.active]="ai()"
            (click)="toggleAi.emit()"
            [attr.aria-label]="ai() ? 'Búsqueda IA activa' : 'Activar búsqueda IA'"
          ><i class="pi pi-bolt" aria-hidden="true"></i> IA</button>
        }
      </div>
    }
  `,
  styles: [
    `
      :host { display: block; }

      .psb {
        width: 100%;
        display: flex;
        align-items: center;
        gap: 0.75rem;
        min-height: 52px;
        padding: 0 1.125rem;
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: var(--r-lg);
        box-shadow: var(--shadow-float);
        font-family: var(--font-body);
        transition: border-color 180ms var(--ease-standard), box-shadow 200ms var(--ease-standard),
          transform 200ms var(--ease-spring);
      }

      .psb-icon { font-size: var(--fs-h3); color: var(--brand-700); flex-shrink: 0; }
      .psb-icon-ai { color: var(--brand-700); }

      /* ── trigger (home): botón que navega ── */
      .psb-trigger { cursor: pointer; text-align: left; }
      .psb-trigger:hover {
        border-color: var(--brand-700);
        transform: translateY(-2px);
        box-shadow: var(--shadow-hover);
      }
      .psb-trigger:active { transform: translateY(0); }
      .psb-placeholder {
        flex: 1;
        min-width: 0;
        font-size: var(--fs-body);
        font-weight: 500;
        color: var(--text-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .psb-kbd {
        font-family: var(--font-mono);
        font-size: var(--fs-micro);
        font-weight: 700;
        padding: 0.25rem 0.5rem;
        background: var(--neutral-100);
        border: 1px solid var(--neutral-200);
        border-radius: var(--r-sm);
        color: var(--text-muted);
        flex-shrink: 0;
      }

      /* ── input (catalog): campo real ── */
      .psb-input:focus-within {
        border-color: var(--neutral-950);
        box-shadow: 0 0 0 3px var(--c-focus-ring, rgba(0, 0, 0, 0.08));
      }
      .psb-input input {
        flex: 1;
        min-width: 0;
        border: none;
        background: transparent;
        padding: 0.875rem 0;
        font-size: var(--fs-body);
        color: var(--text-main);
        outline: none;
      }
      /* iOS hace zoom al enfocar inputs <16px; en touch subimos a 16px. */
      @media (pointer: coarse) {
        .psb-input input { font-size: 16px; }
      }

      .psb-clear {
        flex-shrink: 0;
        background: var(--neutral-100);
        border: none;
        width: 28px;
        height: 28px;
        border-radius: var(--r-sm);
        color: var(--text-muted);
        cursor: pointer;
        display: grid;
        place-items: center;
      }
      .psb-clear:hover { color: var(--text-main); background: var(--neutral-200); }

      .psb-mode {
        flex-shrink: 0;
        background: transparent;
        border: 1px solid var(--border-color);
        color: var(--text-muted);
        font-size: var(--fs-xs);
        font-weight: 700;
        padding: 0.3rem 0.625rem;
        border-radius: var(--r-pill);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        transition: border-color 150ms var(--ease-standard), color 150ms var(--ease-standard),
          background-color 150ms var(--ease-standard);
      }
      .psb-mode:hover { border-color: var(--neutral-400); color: var(--text-main); }
      .psb-mode.active { background: var(--neutral-900); border-color: var(--neutral-900); color: #fff; }
      .psb-mode.active i { color: var(--brand-400); }

      /* Touch targets ≥44px (Ley de Fitts). */
      @media (pointer: coarse) {
        .psb-clear { width: 40px; height: 40px; }
        .psb-mode { padding: 0.5rem 0.85rem; }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PortalSearchBarComponent {
  readonly mode = input<'trigger' | 'input'>('input');
  readonly hints = input<string[]>([]);
  readonly hintPrefix = input<string>('Buscar ');
  readonly hintBase = input<string>('Buscar producto, marca o código…');
  readonly ai = input<boolean>(false);
  readonly showKbd = input<boolean>(false);
  readonly showClear = input<boolean>(false);
  readonly showAiToggle = input<boolean>(false);

  /** Valor del input (two-way). En trigger mode no se usa. */
  readonly value = model<string>('');

  readonly activate = output<void>();
  readonly clear = output<void>();
  readonly toggleAi = output<void>();

  @ViewChild('inputEl') private inputEl?: ElementRef<HTMLInputElement>;

  /** Enfoca el input (catalog, al llegar con ?focus=search). */
  focus(): void {
    this.inputEl?.nativeElement?.focus();
  }
}
