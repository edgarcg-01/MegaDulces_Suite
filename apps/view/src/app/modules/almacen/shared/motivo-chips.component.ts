import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MOTIVO_OTRO, NOTA_MOTIVO_MAX, errorDeMotivo, type MotivoOpcion } from '@megadulces/contracts';
import type { MotivoLinea } from './motivos-preventa';

/**
 * `[MCP.18]` «¿Por qué?» de un renglón que se quita o se deja con menos: el motivo en un toque (ya
 * viene marcado el de por omisión) y una nota opcional; con «Otro motivo» la nota es obligatoria.
 * Lo usan el surtidor (Surtir › Sucursal y Pedidos por surtir) y la caja (Revisión). El motivo lo
 * ven la vendedora y los otros roles en el mismo pedido.
 *
 * El estado lo tiene la pantalla (`valor`): este componente sólo lo pinta y avisa cada cambio.
 */
@Component({
  selector: 'app-motivo-chips',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mc" role="group" [attr.aria-label]="etiqueta()">
      <span class="mc-l" [id]="idBase() + '-l'">¿Por qué?</span>
      <div class="mc-chips" role="radiogroup" [attr.aria-labelledby]="idBase() + '-l'">
        @for (o of opciones(); track o.key) {
          <button type="button" role="radio" class="mc-chip" [class.mc-on]="valor().reason === o.key"
                  [attr.aria-checked]="valor().reason === o.key" (click)="elegir(o.key)">
            @if (valor().reason === o.key) { <i class="pi pi-check" aria-hidden="true"></i> }{{ o.label }}
          </button>
        }
      </div>
      @if (valor().reason === otro || conNota() || valor().note) {
        <label class="mc-l" [for]="idBase() + '-n'">{{ valor().reason === otro ? '¿Cuál fue el motivo?' : 'Nota (opcional)' }}</label>
        <input [id]="idBase() + '-n'" class="mc-in" type="text" [attr.maxlength]="max" autocomplete="off"
               [ngModel]="valor().note" (ngModelChange)="nota($event)" [attr.aria-invalid]="!!error()"
               [attr.aria-describedby]="error() ? idBase() + '-e' : null" />
        @if (error()) { <p class="mc-err" [id]="idBase() + '-e'">{{ error() }}</p> }
      } @else {
        <button type="button" class="mc-mas" (click)="conNota.set(true)">Agregar nota</button>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .mc { display: flex; flex-direction: column; gap: var(--sp-1); padding-top: var(--sp-2); }
    .mc-l { font-size: var(--fs-xs); font-weight: 700; color: var(--text-muted); }
    .mc-chips { display: flex; flex-wrap: wrap; gap: var(--sp-1); }
    .mc-chip {
      display: inline-flex; align-items: center; gap: var(--sp-1); min-height: var(--tap-min); padding: 0 var(--sp-3);
      border: 1px solid var(--border-color); border-radius: var(--r-pill); background: var(--card-bg);
      color: var(--text-main); font: inherit; font-size: var(--fs-sm); font-weight: 600; cursor: pointer;
    }
    .mc-chip.mc-on { border-color: var(--action); background: var(--overlay-selected); }
    .mc-chip:focus-visible, .mc-in:focus-visible, .mc-mas:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .mc-in {
      min-height: var(--tap-min); padding: 0 var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md);
      background: var(--card-bg); color: var(--text-main); font: inherit; font-size: var(--fs-sm);
    }
    .mc-in[aria-invalid='true'] { border-color: var(--bad-fg); }
    .mc-err { margin: 0; font-size: var(--fs-xs); color: var(--bad-fg); }
    .mc-mas {
      align-self: flex-start; min-height: var(--tap-min); padding: 0; border: none; background: none;
      color: var(--text-muted); font: inherit; font-size: var(--fs-xs); font-weight: 700; text-decoration: underline; cursor: pointer;
    }
  `],
})
export class MotivoChipsComponent {
  readonly opciones = input<readonly MotivoOpcion[]>([]);
  readonly valor = input.required<MotivoLinea>();
  /** Prefijo único de los `id` (uno por renglón). */
  readonly idBase = input.required<string>();
  /** Nombre del grupo para lectores de pantalla («Por qué faltó SALSA»). */
  readonly etiqueta = input('Motivo');
  readonly cambio = output<MotivoLinea>();

  readonly otro = MOTIVO_OTRO;
  readonly max = NOTA_MOTIVO_MAX;
  readonly conNota = signal(false);
  /** El mismo validador que el servidor. */
  readonly error = computed(() => errorDeMotivo(this.opciones(), { reason_code: this.valor().reason, note: this.valor().note }));

  elegir(key: string): void {
    this.cambio.emit({ reason: key, note: this.valor().note });
  }

  nota(texto: string): void {
    this.cambio.emit({ reason: this.valor().reason, note: String(texto ?? '') });
  }
}
