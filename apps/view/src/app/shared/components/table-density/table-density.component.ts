import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { NgClass } from '@angular/common';
import { TooltipModule } from 'primeng/tooltip';
import { TableDensityService } from './table-density.service';

/**
 * `[RE.17.6]` — el interruptor de densidad de fila, para el header de una pantalla con tabla.
 * Dos estados, no tres: cómoda (40px, el default de Operations) y compacta (32px). Lo que
 * elige se recuerda entre pantallas — ver `TableDensityService`.
 *
 * Uso: `<app-table-density />` en el header, y en la tabla `[class.is-dense]="density.dense()"`.
 */
@Component({
  selector: 'app-table-density',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgClass, TooltipModule],
  template: `
    <button type="button" class="td-b" [class.on]="density.dense()" (click)="density.toggle()"
            [attr.aria-pressed]="density.dense()"
            [attr.aria-label]="density.dense() ? 'Filas compactas. Cambiar a cómodas' : 'Filas cómodas. Cambiar a compactas'"
            [pTooltip]="density.dense() ? 'Filas cómodas' : 'Filas compactas — entran más en pantalla'"
            tooltipPosition="bottom">
      <i class="pi" [ngClass]="density.dense() ? 'pi-bars' : 'pi-align-justify'" aria-hidden="true"></i>
    </button>
  `,
  styles: [`
    :host { display: inline-flex; }
    .td-b {
      display: inline-flex; align-items: center; justify-content: center;
      width: 1.85rem; height: 1.85rem;
      color: var(--text-muted); background: none; border: 0; border-radius: var(--r-sm, .5rem);
      cursor: pointer;
      transition: background var(--dur-micro, 120ms) var(--ease-out), color var(--dur-micro, 120ms) var(--ease-out);
    }
    .td-b:hover { background: var(--overlay-hover); color: var(--text-main); }
    .td-b.on { color: var(--action); background: var(--overlay-selected); }
    .td-b:focus-visible { outline: 2px solid var(--action); outline-offset: 1px; }
    .td-b .pi { font-size: .82rem; }
  `],
})
export class TableDensityComponent {
  readonly density = inject(TableDensityService);
}
