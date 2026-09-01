import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
// La aritmética vive aparte (`cantidad.util.ts`): es pura y se testea sin
// arrastrar Angular ni PrimeNG a la spec.
import { calcularTotal, describirDiferencia } from '../cantidad.util';

/**
 * Andén · captura de cantidad — **se cuenta por cajas, no por piezas**.
 *
 * El bodeguero no cuenta 480 mazapanes: cuenta 20 cajas de 24. Así que se piden
 * cajas completas y piezas sueltas por separado, el total sale solo, y la
 * diferencia contra Kepler se dice en el idioma correcto ("faltan 48 — 2 cajas",
 * no "faltan 48 pz").
 *
 * Reemplaza los botones −1 / +1, que convertían una corrección de 12 piezas en
 * 12 clics y 12 viajes al servidor. El chip **Llegó todo** resuelve de un toque
 * el caso normal, que es la mayoría.
 *
 * **Sobre `uxc` (piezas por caja):** viene de `catalog.product_barcodes.factor`.
 * Verificado contra la base: **sólo el 3.1 % de los SKU tiene código de caja**
 * (358 de 11,525) y 4,579 filas lo tienen en `null`. Cuando no hay dato, el campo
 * de cajas se deshabilita y se cuenta por piezas — sin inventar ni hardcodear un
 * factor, que metería cantidades falsas al inventario.
 */
@Component({
  selector: 'app-anden-cantidad',
  standalone: true,
  imports: [FormsModule, ButtonModule, InputTextModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ac">
      <div class="ac-grid">
        <label class="ac-f">
          <span>Cajas completas</span>
          <input pInputText type="text" inputmode="numeric" class="ac-num"
            [disabled]="!uxc()" [ngModel]="cajas()" (ngModelChange)="setCajas($event)"
            [placeholder]="uxc() ? '0' : 'sin dato'" />
          @if (uxc()) {
            <small class="ac-hint">× {{ uxc() }} pz</small>
          } @else {
            <small class="ac-hint ac-warn">este código no trae piezas por caja</small>
          }
        </label>

        <label class="ac-f">
          <span>Piezas sueltas</span>
          <input pInputText type="text" inputmode="numeric" class="ac-num"
            [ngModel]="sueltas()" (ngModelChange)="setSueltas($event)" placeholder="0" />
        </label>
      </div>

      <div class="ac-total">
        <div>
          <span class="ac-total-n">{{ total() }}</span>
          <span class="ac-total-u">piezas</span>
        </div>
        <span class="ac-diff" [class.ac-ok]="diff() === 0" [class.ac-bad]="diff() !== 0">
          {{ textoDiff() }}
        </span>
      </div>

      <div class="ac-acciones">
        <button pButton type="button" class="ac-todo" (click)="llegoTodo()">Llegó todo</button>
        <button pButton type="button" severity="secondary" [outlined]="true"
          [disabled]="total() === esperado() && total() === 0" (click)="confirmar.emit(total())">
          Confirmar cantidad
        </button>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .ac-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-3); }
    .ac-f { display: flex; flex-direction: column; gap: var(--sp-1); }
    .ac-f > span { font-size: var(--fs-xs); font-weight: var(--fw-medium); color: var(--text-muted); }
    .ac-num { min-height: 52px; font-size: var(--fs-h3); font-weight: var(--fw-bold); text-align: center; font-variant-numeric: tabular-nums; }
    .ac-hint { font-size: var(--fs-micro); color: var(--text-faint); }
    .ac-warn { color: var(--warn-fg, var(--text-muted)); }
    .ac-total {
      display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-2);
      margin-top: var(--sp-3); padding: var(--sp-2) var(--sp-3);
      background: var(--surface-ground); border-radius: var(--r-md);
    }
    .ac-total-n { font-size: var(--fs-h1); font-weight: var(--fw-black); font-variant-numeric: tabular-nums; }
    .ac-total-u { margin-left: var(--sp-1); font-size: var(--fs-xs); color: var(--text-muted); }
    .ac-diff { font-size: var(--fs-sm); font-weight: var(--fw-medium); }
    .ac-ok { color: var(--ok-soft-fg); }
    .ac-bad { color: var(--bad-fg); }
    .ac-acciones { display: flex; gap: var(--sp-2); margin-top: var(--sp-3); }
    .ac-acciones button { flex: 1; min-height: 48px; }
    .ac-todo { font-weight: var(--fw-bold); }
  `],
})
export class AndenCantidadComponent {
  readonly esperado = input.required<number>();
  readonly uxc = input<number | null>(null);
  readonly inicial = input<number>(0);

  readonly confirmar = output<number>();

  readonly cajas = signal(0);
  readonly sueltas = signal(0);

  readonly total = computed(() => calcularTotal(this.cajas(), this.sueltas(), this.uxc()));
  readonly diff = computed(() => this.total() - this.esperado());
  readonly textoDiff = computed(() => describirDiferencia(this.diff(), this.uxc()));

  private soloDigitos(v: unknown): number {
    const n = parseInt(String(v ?? '').replace(/\D/g, ''), 10);
    return Number.isFinite(n) ? n : 0;
  }

  setCajas(v: unknown): void { this.cajas.set(this.soloDigitos(v)); }
  setSueltas(v: unknown): void { this.sueltas.set(this.soloDigitos(v)); }

  /** Un toque para el caso normal: lo esperado llegó completo. */
  llegoTodo(): void {
    const f = this.uxc();
    const esp = this.esperado();
    if (f && f > 1 && esp % f === 0) {
      this.cajas.set(esp / f);
      this.sueltas.set(0);
    } else {
      this.cajas.set(0);
      this.sueltas.set(esp);
    }
    this.confirmar.emit(this.total());
  }
}
