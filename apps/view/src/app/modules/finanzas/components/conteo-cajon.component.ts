import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { InputNumberModule } from 'primeng/inputnumber';
import { BILLETES_MXN, MONEDAS_MXN, revisarConteoCajon, type ConteoCajonHoja, type Denominacion } from '@megadulces/contracts';
import { money } from '../pages/finanzas-format';

/**
 * ⭐ `[CGA-A.65]` **Contar lo que sale del cajón.** Edgar, 2026-10-30, después de pagar HG-1 con el
 * cajón sin que nada le pidiera contar: *«cuando sea de cajón que se haga un arqueo»*.
 *
 * Se teclean PIEZAS, no importes: el importe se deriva y se compara solo contra lo que sale. La regla
 * es la del contrato (`revisarConteoCajon`), la misma que aplica el servidor y, debajo, la base.
 *
 * Las cinco preguntas (`diseno` §0b):
 * 1. Qué ve y en qué orden: lo que sale del cajón y el veredicto («cuadra» / «faltan $X») arriba;
 *    abajo las piezas, billetes de mayor a menor, monedas y la morralla.
 * 2. Qué no: dólares, ni importes por teclear (se derivan).
 * 3. Accesibilidad: cada campo dice «Piezas de $1,000»; el veredicto es `role="status"` y lo dice
 *    en palabras, no sólo en color.
 * 4. Ligado a: el corte del día (el cajón espera esto de menos) y la hoja que se paga.
 * 5. Quién lo ve: quien paga la hoja con el cajón (no quien la aprobó: lo exige el servidor).
 *
 * Jerarquía (Q.5): primario = el veredicto; secundario = las piezas; terciario = el subtotal por pieza.
 */
@Component({
  selector: 'app-conteo-cajon',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, InputNumberModule],
  template: `
    <section class="cc" aria-label="Conteo de lo que sale del cajón">
      <p class="cc-veredicto" role="status" [class.cc-ok]="veredicto().ok" [class.cc-mal]="!veredicto().ok && hayAlgo()">
        @if (veredicto().ok) {
          <i class="pi pi-check" aria-hidden="true"></i> Cuadra: contaste {{ mx(total()) }}, lo que sale del cajón.
        } @else if (!hayAlgo()) {
          Sale del cajón <b class="cc-num">{{ mx(total()) }}</b>: cuenta las piezas que entregas.
        } @else {
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ texto() }}
        }
      </p>

      <div class="cc-grupos">
        @for (g of grupos; track g.titulo) {
          <fieldset class="cc-grupo">
            <legend class="cc-lbl">{{ g.titulo }}</legend>
            @for (d of g.piezas; track d.key) {
              <div class="cc-fila">
                <label class="cc-den" [for]="'cc-' + d.key">{{ d.label }}</label>
                <p-inputnumber [inputId]="'cc-' + d.key" [min]="0" [useGrouping]="false" [ariaLabel]="'Piezas de ' + nombre(d)"
                               [ngModel]="piezas()[d.key] ?? null" (ngModelChange)="poner(d.key, $event)" inputStyleClass="cc-in" />
                <span class="cc-sub cc-num">{{ (piezas()[d.key] ?? 0) > 0 ? mx((piezas()[d.key] ?? 0) * d.valor) : '' }}</span>
              </div>
            }
          </fieldset>
        }
        <div class="cc-fila cc-morralla">
          <label class="cc-den" for="cc-morralla">Morralla <span class="cc-dim">(menos de 50¢)</span></label>
          <p-inputnumber inputId="cc-morralla" mode="currency" currency="MXN" locale="es-MX" [min]="0" [max]="0.49"
                         ariaLabel="Morralla, menos de 50 centavos" [ngModel]="morralla()" (ngModelChange)="morralla.set($event)" inputStyleClass="cc-in" />
        </div>
      </div>
    </section>
  `,
  styles: [`
    :host { display: block; }
    .cc-veredicto { margin: 0 0 var(--sp-3, .75rem); font-size: var(--fs-body, 1rem); }
    .cc-ok { color: var(--text-main); }
    .cc-ok .pi { color: var(--ok-fg); }
    .cc-mal { color: var(--bad-fg); }
    .cc-grupos { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: var(--sp-2, .5rem) var(--sp-6, 1.5rem); }
    .cc-grupo { border: 0; margin: 0; padding: 0; display: grid; gap: var(--sp-1, .25rem); }
    .cc-lbl { font-size: var(--fs-xs, .8rem); color: var(--text-muted); padding: 0; margin-bottom: var(--sp-1, .25rem); }
    .cc-fila { display: grid; grid-template-columns: 4.5rem 6rem 1fr; gap: var(--sp-2, .5rem); align-items: center; }
    .cc-morralla { grid-template-columns: 4.5rem 8rem; }
    .cc-den { font-size: var(--fs-sm, .875rem); }
    .cc-sub { font-size: var(--fs-xs, .8rem); color: var(--text-muted); text-align: right; }
    .cc-dim { color: var(--text-muted); font-size: var(--fs-xs, .8rem); }
    .cc-num { font-variant-numeric: tabular-nums; }
    :host ::ng-deep .cc-in { width: 100%; text-align: right; font-variant-numeric: tabular-nums; }
  `],
})
export class ConteoCajonComponent {
  /** Lo que sale del cajón. */
  readonly total = input.required<number>();
  readonly piezas = model<Record<string, number>>({});
  readonly morralla = model<number | null>(null);

  readonly grupos: ReadonlyArray<{ titulo: string; piezas: readonly Denominacion[] }> = [
    { titulo: 'Billetes', piezas: BILLETES_MXN },
    { titulo: 'Monedas', piezas: MONEDAS_MXN },
  ];

  readonly conteo = computed<ConteoCajonHoja>(() => ({ piezas: this.piezas(), morralla: Number(this.morralla() ?? 0) }));
  readonly veredicto = computed(() => revisarConteoCajon(this.conteo(), this.total()));
  readonly hayAlgo = computed(() => Object.values(this.piezas()).some((n) => Number(n) > 0) || Number(this.morralla() ?? 0) > 0);
  readonly texto = computed(() => { const v = this.veredicto(); return v.ok ? '' : v.texto; });

  protected readonly mx = (v: number): string => money(Number(v) || 0);

  nombre(d: Denominacion): string {
    return d.key === '20m' ? '$20 en moneda' : d.familia === 'moneda' ? `${d.label} en moneda` : d.label;
  }

  poner(key: string, n: number | null): void {
    this.piezas.update((p) => {
      const x = { ...p };
      if (n == null || !(Number(n) > 0)) delete x[key]; else x[key] = Math.trunc(Number(n));
      return x;
    });
  }
}
