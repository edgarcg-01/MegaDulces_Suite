import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { DatePipe } from '@angular/common';
import { TableModule } from 'primeng/table';
import type { SenalTorre } from '@megadulces/contracts';
import { TorreEstadoComponent } from './torre-estado.component';

/**
 * `[TOR.3]` «Atender»: la bandeja de las dos torres (una sola pieza, TOR.UI.4). Cada fila dice qué
 * pasa, por qué importa, desde cuándo y de quién es. «Sin dueño» se dice en rojo a propósito
 * (TOR.UI.3): una falla que nadie atiende no se normaliza.
 */
@Component({
  selector: 'app-torre-bandeja',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TableModule, DatePipe, TorreEstadoComponent],
  template: `
    <div class="dt-scope wrap">
      <p-table [value]="senales()" styleClass="surf-table surf-table--plain dt-stack" [tableStyle]="{ 'min-width': '46rem' }">
        <ng-template #header>
          <tr>
            <th>Qué</th>
            <th>Estado</th>
            <th>Desde</th>
            <th>Dueño</th>
            <th><span class="sr-only">Acción</span></th>
          </tr>
        </ng-template>
        <ng-template #body let-s>
          <tr [class.vista]="s.vista">
            <td class="dt-id" role="cell">
              <span class="que">{{ s.que }}</span>
              <span class="porque">{{ s.porque }}</span>
            </td>
            <td role="cell" data-label="Estado"><app-torre-estado [estado]="s.estado" [texto]="s.texto_estado" /></td>
            <td role="cell" data-label="Desde" class="mono">{{ s.desde ? (s.desde | date: 'dd/MM HH:mm') : '—' }}</td>
            <td role="cell" data-label="Dueño">
              @if (s.dueno) { {{ s.dueno }} } @else { <span class="sin-dueno">sin dueño</span> }
            </td>
            <td role="cell" class="acc">
              @if (s.alerta_id && !s.vista) {
                <button type="button" class="btn" (click)="visto.emit(s.alerta_id)">Marcar vista</button>
              } @else if (s.vista) {
                <span class="ya"><i class="pi pi-eye" aria-hidden="true"></i> vista</span>
              }
            </td>
          </tr>
        </ng-template>
        <ng-template #emptymessage>
          <tr><td colspan="5" class="vacio"><i class="pi pi-check-circle" aria-hidden="true"></i> Nada que atender.</td></tr>
        </ng-template>
      </p-table>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .wrap { border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--surface-card); overflow: hidden; }
    .que { display: block; font-weight: var(--fw-bold); color: var(--text-main); font-size: var(--fs-sm); }
    .porque { display: block; font-size: var(--fs-xs); color: var(--text-muted); }
    .mono { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--text-soft); white-space: nowrap; }
    .sin-dueno { color: var(--bad-soft-fg); font-weight: var(--fw-bold); font-size: var(--fs-sm); }
    .acc { text-align: right; }
    .btn { height: 32px; padding: 0 var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-sm);
           background: var(--surface-card); color: var(--text-main); font: inherit; font-size: var(--fs-sm); font-weight: var(--fw-bold); cursor: pointer; }
    .btn:hover { background: var(--surface-hover); }
    .btn:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; }
    .ya { font-size: var(--fs-xs); color: var(--text-muted); }
    .vista { opacity: .7; }
    .vacio { text-align: center; padding: var(--sp-4); color: var(--ok-soft-fg); font-size: var(--fs-sm); }
    @media (pointer: coarse) { .btn { height: 44px; } }
  `],
})
export class TorreBandejaComponent {
  readonly senales = input.required<SenalTorre[]>();
  /** Emite el id de la alerta a marcar como vista. */
  readonly visto = output<string>();
}
