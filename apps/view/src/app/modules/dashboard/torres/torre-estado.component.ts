import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { EstadoSenal } from '@megadulces/contracts';

/**
 * `[TOR.3]` La pastilla de estado de las torres. El color nunca va solo: cada estado lleva su
 * icono y su palabra. «No medido» es gris punteado y no se confunde con «al día».
 */
@Component({
  selector: 'app-torre-estado',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="chip" [class.ok]="estado() === 'ok'" [class.riesgo]="estado() === 'riesgo'"
          [class.falla]="estado() === 'falla'" [class.nm]="estado() === 'no_medido'">
      @switch (estado()) {
        @case ('ok') { <i class="pi pi-check" aria-hidden="true"></i> }
        @case ('riesgo') { <i class="pi pi-exclamation-triangle" aria-hidden="true"></i> }
        @case ('falla') { <i class="pi pi-times" aria-hidden="true"></i> }
        @default { <i class="pi pi-circle" aria-hidden="true"></i> }
      }
      {{ texto() }}
    </span>
  `,
  styles: [`
    :host { display: inline-block; }
    .chip { display: inline-flex; align-items: center; gap: var(--sp-1); padding: 2px var(--sp-2);
            border-radius: var(--r-pill); font-size: var(--fs-xs); font-weight: var(--fw-bold); white-space: nowrap;
            border: 1px solid transparent; }
    .chip i { font-size: var(--fs-micro); }
    .ok { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .riesgo { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .falla { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .nm { background: transparent; color: var(--text-muted); border: 1px dashed var(--border-color); }
  `],
})
export class TorreEstadoComponent {
  readonly estado = input.required<EstadoSenal>();
  readonly texto = input.required<string>();
}
