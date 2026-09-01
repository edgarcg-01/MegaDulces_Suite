import { ChangeDetectionStrategy, Component, computed, effect, input, output, signal, viewChild } from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { AndenLinea } from '../anden.state';
import { ScanFieldComponent } from './scan-field.component';

export interface UbicadoConfirmado {
  linea: AndenLinea;
  cantidad: number;
  binCode: string;
}

/**
 * Andén · **Ubicación** — le da rack a la mercancía que ya está en existencia.
 *
 * Es cola **hermana** de Caducidad, no su continuación: fechar y acomodar los
 * pueden hacer dos personas distintas en momentos distintos, y encadenarlos
 * obligaba a que quien fecha también acomode.
 *
 * **El rack viene precargado** desde `pick-suggestion` — donde ya vive el SKU — y
 * sólo se escanea cuando va a otro lado. Escanear, no buscar en un select: la
 * etiqueta del rack está pegada al rack.
 */
@Component({
  selector: 'app-anden-ubicacion',
  standalone: true,
  imports: [ButtonModule, ScanFieldComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ub">
      <header class="ub-hd">
        <div>
          <h3 class="ub-nm">{{ nombre() }}</h3>
          <p class="ub-sk">{{ linea().sku || linea().expected_sku || '—' }} · <b>{{ linea().contado }} pz</b> por acomodar</p>
        </div>
        <button type="button" class="ub-back" (click)="volver.emit()">← Lista</button>
      </header>

      <p class="ub-nota">
        @if (linea().binSugerido) {
          Este SKU ya vive en <b>{{ linea().binSugerido }}</b>. Viene precargado; escaneá el rack si va a otro lado.
        } @else {
          Sin ubicación previa para este SKU. Escaneá el rack donde lo vas a dejar.
        }
      </p>

      <!-- Misma barra que las listas. El Enter de la pistola acomoda directo:
           escanear el rack y confirmar son un solo gesto. -->
      <app-scan-field
        #scan
        etiqueta="Rack"
        placeholder="Escaneá el rack"
        [valor]="bin()"
        [conCamara]="true"
        (valorChange)="bin.set($event)"
        (enter)="emitir()"
        (sinCamara)="sinCamara.emit($event)"
      />

      <button pButton type="button" class="ub-go" [loading]="guardando()"
        [disabled]="!bin().trim() || guardando()" (click)="emitir()">
        {{ bin().trim() ? 'Acomodar en ' + bin().trim() : 'Falta el rack' }}
      </button>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .ub { display: flex; flex-direction: column; gap: var(--sp-3); }
    .ub-hd { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--sp-2); }
    .ub-nm { margin: 0; font-size: var(--fs-h3); font-weight: var(--fw-bold); line-height: 1.2; text-wrap: balance; }
    .ub-sk { margin: 2px 0 0; font-size: var(--fs-xs); color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .ub-back {
      flex: 0 0 auto; min-height: 36px; padding: 0 var(--sp-2);
      background: none; border: 1px solid var(--border-color); border-radius: var(--r-sm);
      color: var(--text-muted); font: inherit; font-size: var(--fs-xs); cursor: pointer;
    }
    .ub-nota {
      margin: 0; padding: var(--sp-2) var(--sp-3);
      background: var(--card-bg); border: 1px solid var(--border-color);
      border-left: 3px solid var(--action); border-radius: var(--r-sm);
      font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.4;
    }
    .ub-nota b { color: var(--text-main); }
    .ub-go { width: 100%; min-height: 54px; font-size: var(--fs-body); font-weight: var(--fw-bold); }
  `],
})
export class AndenUbicacionComponent {
  readonly linea = input.required<AndenLinea>();
  readonly guardando = input(false);

  readonly confirmar = output<UbicadoConfirmado>();
  readonly sinCamara = output<string>();
  readonly volver = output<void>();

  readonly bin = signal('');
  private readonly scan = viewChild<ScanFieldComponent>('scan');

  readonly nombre = computed(() => {
    const l = this.linea();
    return l.product_name || l.expected_name || l.sku || l.expected_sku || 'Sin nombre';
  });

  constructor() {
    // El rack sugerido se precarga al abrir cada renglón — incluido el siguiente
    // cuando se encadena, que es donde se gana el toque.
    effect(() => {
      const l = this.linea();
      this.bin.set(l.ubicado || l.binSugerido || '');
    });
  }

  /** El padre la llama tras guardar: la pistola tiene que poder disparar de nuevo. */
  enfocar(): void { this.scan()?.enfocar(); }

  emitir(): void {
    const b = this.bin().trim();
    if (!b) return;
    this.confirmar.emit({ linea: this.linea(), cantidad: Number(this.linea().contado) || 0, binCode: b });
  }
}
