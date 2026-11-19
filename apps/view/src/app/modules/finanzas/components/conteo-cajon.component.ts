import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, inject, input, model } from '@angular/core';
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
    <section class="cc" [attr.aria-label]="sentido() === 'entra' ? 'Conteo de lo que entra al cajón' : 'Conteo de lo que sale del cajón'">
      @if (sentido() === 'entra') {
        <!-- [LE.6.7] Al recibir no hay «cuadra» que exigir: se cuenta lo que llega y la pantalla lo compara. -->
        <p class="cc-veredicto" role="status">Cuenta lo que te entregan, por pieza: van <b class="cc-num" data-testid="cc-suma">{{ mx(suma()) }}</b>.</p>
      } @else {
      <p class="cc-veredicto" role="status" [class.cc-ok]="veredicto().ok" [class.cc-mal]="!veredicto().ok && hayAlgo()">
        @if (veredicto().ok) {
          <i class="pi pi-check" aria-hidden="true"></i> Cuadra: contaste {{ mx(total()) }}, lo que sale del cajón.
        } @else if (!hayAlgo()) {
          Sale del cajón <b class="cc-num">{{ mx(total()) }}</b>: cuenta las piezas que entregas.
        } @else {
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ texto() }}
        }
      </p>
      }

      <p class="cc-atajo" data-testid="cc-atajo"><kbd>↑</kbd><kbd>↓</kbd> o <kbd>Enter</kbd> entre piezas · al final, al siguiente campo</p>
      <div class="cc-grupos">
        @for (g of grupos(); track g.titulo) {
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
        @if (conMorralla()) {
        <div class="cc-fila cc-morralla">
          <label class="cc-den" for="cc-morralla">Morralla <span class="cc-dim">(menos de 50¢)</span></label>
          <p-inputnumber inputId="cc-morralla" mode="currency" currency="MXN" locale="es-MX" [min]="0" [max]="0.49"
                         ariaLabel="Morralla, menos de 50 centavos" [ngModel]="morralla()" (ngModelChange)="morralla.set($event)" inputStyleClass="cc-in" />
        </div>
        }
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
    .cc-atajo { margin: 0 0 var(--sp-2, .5rem); font-size: var(--fs-xs, .8rem); color: var(--text-muted); }
    .cc-atajo kbd { font-family: var(--font-mono); font-size: var(--fs-xs, .8rem); padding: 0 4px; margin: 0 1px;
      border: 1px solid var(--border-color); border-radius: 4px; background: var(--card-bg); }
    :host ::ng-deep .cc-in { width: 100%; text-align: right; font-variant-numeric: tabular-nums; }
  `],
})
export class ConteoCajonComponent {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /**
   * `[LE.6.11]` **Se cuenta sin mouse**, como en la reja de Captura (`moverEnReja`): `↓` o `Enter` a la
   * pieza siguiente, `↑` a la anterior, y desde la última al siguiente campo de la ventana (quién
   * recibe, o el botón). Se escucha en fase de CAPTURA porque `p-inputnumber` usa ↑ ↓ para sumar o
   * restar una pieza: con las manos en el efectivo, una flecha que cambia el número en vez de moverse
   * es un error que nadie ve.
   */
  constructor() {
    const el = this.host.nativeElement;
    const mover = (ev: KeyboardEvent): void => {
      if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(ev.key) || ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
      const campos = [...el.querySelectorAll<HTMLInputElement>('input.cc-in')];
      const i = campos.indexOf(ev.target as HTMLInputElement);
      if (i < 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      const dir = ev.key === 'ArrowUp' ? -1 : 1;
      if (campos[i + dir]) { campos[i + dir].focus(); campos[i + dir].select(); return; }
      if (dir === 1) this.siguienteCampo(el);
    };
    el.addEventListener('keydown', mover, true);
    inject(DestroyRef).onDestroy(() => el.removeEventListener('keydown', mover, true));
  }

  /**
   * El primer elemento enfocable DESPUÉS de este conteo, dentro de su ventana.
   *
   * `[LE.6.34]` Si la ventana marcó su botón primario con `data-conteo-siguiente` y está habilitado, va ahí:
   * en Reposición el siguiente en el DOM era «Volver», y el Enter siguiente tiraba el conteo.
   */
  private siguienteCampo(el: HTMLElement): void {
    const raiz = el.closest<HTMLElement>('.p-dialog') ?? document.body;
    const primario = raiz.querySelector<HTMLElement>('button[data-conteo-siguiente]:not([disabled]), [data-conteo-siguiente] button:not([disabled])');
    if (primario) { primario.focus(); return; }
    const todos = [...raiz.querySelectorAll<HTMLElement>('input:not([disabled]), button:not([disabled]), select, textarea, a[href], [tabindex="0"]')];
    const sig = todos.find((x) => !el.contains(x) && (el.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING));
    sig?.focus();
  }

  /** Lo que sale del cajón. */
  readonly total = input.required<number>();
  readonly piezas = model<Record<string, number>>({});
  readonly morralla = model<number | null>(null);

  /**
   * `[LE.2.13]` En la Ventanilla los billetes los entrega la máquina y se paga al medio peso: del
   * cajón sólo salen monedas y no hay morralla. Por omisión, todo (la hoja de gastos queda igual).
   */
  readonly conBilletes = input(true);
  readonly conMorralla = input(true);
  /**
   * `[LE.6.7]` `sale` (pagar, la hoja de gastos) exige que cuadre con `total`; `entra` (recibir un
   * cobro) sólo cuenta: lo que llegue de más o de menos lo compara y lo declara quien lo usa.
   */
  readonly sentido = input<'sale' | 'entra'>('sale');
  /** Lo contado, en pesos: sólo para mostrar (el servidor lo vuelve a valuar con `valorDePiezas`). */
  readonly suma = computed(() => this.grupos().flatMap((g) => g.piezas)
    .reduce((s, d) => s + d.valor * (Number(this.piezas()[d.key]) || 0), 0));

  readonly grupos = computed<ReadonlyArray<{ titulo: string; piezas: readonly Denominacion[] }>>(() => [
    ...(this.conBilletes() ? [{ titulo: 'Billetes', piezas: BILLETES_MXN }] : []),
    { titulo: 'Monedas', piezas: MONEDAS_MXN },
  ]);

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
