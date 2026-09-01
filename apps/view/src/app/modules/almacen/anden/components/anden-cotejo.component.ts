import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { AndenLinea } from '../anden.state';
import { AndenCantidadComponent } from './anden-cantidad.component';
import { describirDiferencia } from '../cantidad.util';

/**
 * Andén · **Puerta 1 — Cotejo y acceso**. Corre contra el chofer.
 *
 * Una sola pregunta: ¿esto es lo que Kepler dijo que mandaban? Se coteja por
 * tarima —esperado contra recibido, faltantes, sobrantes— y se da acceso. La
 * mercancía entra a existencia **sin fecha, en el lote `NA`**, y el camión se va.
 *
 * Acá **nadie fotografía etiquetas**: cada segundo es andén ocupado. Todo lo
 * lento vive en la puerta 2.
 */
@Component({
  selector: 'app-anden-cotejo',
  standalone: true,
  imports: [DecimalPipe, ButtonModule, TagModule, AndenCantidadComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ct">
      <div class="ct-resumen">
        <div class="ct-kpi">
          <span class="ct-kpi-n">{{ cotejo().contados }}/{{ cotejo().lineas }}</span>
          <span class="ct-kpi-l">renglones contados</span>
        </div>
        <div class="ct-kpi">
          <span class="ct-kpi-n">{{ cotejo().recibido | number }}</span>
          <span class="ct-kpi-l">piezas recibidas</span>
        </div>
        <div class="ct-kpi">
          <span class="ct-kpi-n" [class.ct-bad]="cotejo().diff !== 0">{{ textoDiff() }}</span>
          <span class="ct-kpi-l">contra Kepler</span>
        </div>
      </div>

      <ul class="ct-lista">
        @for (l of lineas(); track l.id) {
          <li class="ct-item" [class.ct-abierta]="abiertaId() === l.id" [class.ct-lista-ok]="l.discrepancy_kind !== 'pending'">
            <button type="button" class="ct-cab" (click)="abrir(l)">
              <span class="ct-nombre">{{ nombre(l) }}</span>
              <span class="ct-cant">
                <strong>{{ l.received_qty | number }}</strong>
                <span class="ct-esp">de {{ l.expected_qty | number }}</span>
              </span>
              @if (l.discrepancy_kind !== 'pending') {
                <p-tag [value]="etiqueta(l)" [severity]="severidad(l)" />
              } @else {
                <span class="ct-pend">sin contar</span>
              }
            </button>

            @if (abiertaId() === l.id) {
              <div class="ct-captura">
                <app-anden-cantidad
                  [esperado]="+l.expected_qty"
                  [uxc]="l.uxc"
                  [inicial]="+l.received_qty"
                  (confirmar)="contar.emit({ linea: l, cantidad: $event })"
                />
              </div>
            }
          </li>
        }
      </ul>

      <div class="ct-pie">
        @if (!puedeDarAcceso()) {
          <p class="ct-aviso">Contá todos los renglones para poder dar acceso.</p>
        }
        <button pButton type="button" class="ct-acceso" [disabled]="!puedeDarAcceso()"
          [loading]="guardando()" (click)="darAcceso.emit()">
          Dar acceso · el camión se va
        </button>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .ct-resumen {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--sp-2);
      margin-bottom: var(--sp-4); padding: var(--sp-3);
      background: var(--surface-ground); border-radius: var(--r-md);
    }
    .ct-kpi { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .ct-kpi-n { font-size: var(--fs-h3); font-weight: var(--fw-bold); font-variant-numeric: tabular-nums; }
    .ct-kpi-l { font-size: var(--fs-micro); color: var(--text-muted); }
    .ct-bad { color: var(--bad-fg); }
    .ct-lista { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
    .ct-item { border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); overflow: hidden; }
    .ct-abierta { border-color: var(--action); box-shadow: 0 0 0 1px var(--action); }
    .ct-cab {
      display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: var(--sp-3);
      width: 100%; min-height: 56px; padding: var(--sp-2) var(--sp-3);
      background: none; border: 0; font: inherit; color: var(--text-main); text-align: left; cursor: pointer;
    }
    .ct-nombre { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: var(--fw-medium); }
    .ct-cant { font-variant-numeric: tabular-nums; white-space: nowrap; }
    .ct-esp { margin-left: var(--sp-1); font-size: var(--fs-xs); color: var(--text-muted); }
    .ct-pend { font-size: var(--fs-xs); color: var(--text-faint); }
    .ct-captura { padding: 0 var(--sp-3) var(--sp-3); border-top: 1px solid var(--border-color); padding-top: var(--sp-3); }
    .ct-pie { margin-top: var(--sp-4); }
    .ct-aviso { margin: 0 0 var(--sp-2); font-size: var(--fs-xs); color: var(--text-muted); }
    .ct-acceso { width: 100%; min-height: 56px; font-size: var(--fs-body); font-weight: var(--fw-bold); }
  `],
})
export class AndenCotejoComponent {
  readonly lineas = input.required<AndenLinea[]>();
  readonly cotejo = input.required<{ lineas: number; contados: number; esperado: number; recibido: number; diff: number }>();
  readonly puedeDarAcceso = input(false);
  readonly guardando = input(false);

  readonly contar = output<{ linea: AndenLinea; cantidad: number }>();
  readonly darAcceso = output<void>();
  readonly abrirLinea = output<AndenLinea>();

  readonly abiertaId = signal<string | null>(null);

  readonly textoDiff = computed(() => describirDiferencia(this.cotejo().diff, null));

  nombre(l: AndenLinea): string {
    return l.product_name || l.expected_name || l.sku || l.expected_sku || 'Sin nombre';
  }

  etiqueta(l: AndenLinea): string {
    const m: Record<string, string> = {
      ok: 'completo', faltante: 'faltante', sobrante: 'sobrante',
      dañado: 'dañado', producto_incorrecto: 'otro producto',
    };
    return m[l.discrepancy_kind] ?? l.discrepancy_kind;
  }

  severidad(l: AndenLinea): 'success' | 'warn' | 'danger' {
    if (l.discrepancy_kind === 'ok') return 'success';
    if (l.discrepancy_kind === 'sobrante') return 'warn';
    return 'danger';
  }

  abrir(l: AndenLinea): void {
    this.abiertaId.update((id) => (id === l.id ? null : l.id));
    this.abrirLinea.emit(l);
  }
}
