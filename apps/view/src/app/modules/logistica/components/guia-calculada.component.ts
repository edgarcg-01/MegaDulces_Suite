import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  COMIDAS_VIATICO, ComidaViatico, ETIQUETA_COMIDA, PersonaGuia, TarifasViatico, ViaticosDeLaGuia,
} from '@megadulces/contracts';

export interface ComisionesDeLaGuia {
  driver_commission: number;
  helper1_commission: number;
  helper2_commission: number;
}

export interface PersonaDeLaGuia {
  key: PersonaGuia;
  /** «Chofer», «Ayudante 1»… */
  rol: string;
  /** El nombre de quien va, si ya se eligió. */
  nombre: string | null;
}

const LLAVE_COMISION: Record<PersonaGuia, keyof ComisionesDeLaGuia> = {
  driver: 'driver_commission', helper1: 'helper1_commission', helper2: 'helper2_commission',
};

/**
 * EMB.19 — Comisión y viáticos de la guía, CALCULADOS y de sólo lectura: una fila por persona
 * que va. No hay nada que teclear aquí — la comisión sale de la tarifa de la ruta y los viáticos
 * del horario (regla de la beta). Mientras falte algo para calcular, se pinta «—», nunca un $0
 * que parezca un monto real: lo que falta lo dice la lista de faltantes de quien lo usa.
 */
@Component({
  selector: 'app-guia-calculada',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let v = viaticos();
    @let k = comisiones();
    <div class="gc dt-scope">
      <table class="gc-table dt-stack">
        <caption class="sr-only">Comisión y viáticos calculados por persona</caption>
        <thead>
          <tr>
            <th scope="col">Persona</th>
            <th scope="col" class="num">Comisión</th>
            @for (m of comidas; track m) {
              <th scope="col" class="gc-c">{{ etiqueta(m) }}@if (tarifa(m) > 0) {<span class="gc-rate">{{ tarifa(m) | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>}</th>
            }
            <th scope="col" class="num">Viáticos</th>
          </tr>
        </thead>
        <tbody>
          @for (p of personas(); track p.key) {
            <tr>
              <th scope="row" role="rowheader" data-label="Persona" class="dt-id">
                {{ p.rol }} @if (p.nombre) {<span class="gc-sub">{{ p.nombre }}</span>}
              </th>
              <td data-label="Comisión" role="cell" class="num dt-num">{{ k ? (comision(k, p.key) | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }}</td>
              @for (m of comidas; track m) {
                <td [attr.data-label]="etiqueta(m)" role="cell" class="gc-c">
                  @if (!v) { — }
                  @else if (v[p.key][m]) { <i class="pi pi-check" aria-hidden="true"></i><span class="sr-only">Sí</span> }
                  @else { <span aria-hidden="true">—</span><span class="sr-only">No</span> }
                </td>
              }
              <td data-label="Viáticos" role="cell" class="num dt-num">{{ v ? (v[p.key].subtotal | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }}</td>
            </tr>
          }
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Total</th>
            <td class="num">{{ k ? (totalComision() | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }}</td>
            <td [attr.colspan]="comidas.length"></td>
            <td class="num">{{ v ? (v.total | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .gc { overflow-x: auto; border-radius: var(--r-sm); background: var(--c-surface-2); }
    .gc-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    .gc-table th, .gc-table td { padding: .4rem .6rem; text-align: left; }
    .gc-table thead th { font-size: var(--fs-micro); font-weight: var(--fw-medium); text-transform: uppercase; letter-spacing: .04em; color: var(--c-text-2); border-bottom: 1px solid var(--c-divider); }
    .gc-table tbody th { font-weight: var(--fw-medium); }
    .gc-table td { border-bottom: 1px solid var(--c-divider); color: var(--c-text-1); }
    .gc-table .num { text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .gc-table .gc-c { text-align: center; }
    .gc-table tfoot th, .gc-table tfoot td { font-weight: var(--fw-bold); border-bottom: 0; }
    .gc-rate { display: block; font-family: var(--font-mono); text-transform: none; letter-spacing: 0; }
    .gc-sub { display: block; font-size: var(--fs-xs); font-weight: var(--fw-regular); color: var(--c-text-2); }
  `],
})
export class GuiaCalculadaComponent {
  /** Quién va, en orden. Las que no van no se pintan. */
  readonly personas = input.required<PersonaDeLaGuia[]>();
  /** null = falta algo para calcular la comisión. */
  readonly comisiones = input<ComisionesDeLaGuia | null>(null);
  /** null = falta algo para calcular los viáticos. */
  readonly viaticos = input<ViaticosDeLaGuia | null>(null);
  readonly tarifas = input<TarifasViatico | null>(null);

  readonly comidas = COMIDAS_VIATICO;

  readonly totalComision = computed(() => {
    const k = this.comisiones();
    if (!k) return 0;
    return this.personas().reduce((t, p) => t + Math.round(k[LLAVE_COMISION[p.key]] * 100), 0) / 100;
  });

  etiqueta(m: ComidaViatico): string { return ETIQUETA_COMIDA[m]; }

  comision(k: ComisionesDeLaGuia, p: PersonaGuia): number { return k[LLAVE_COMISION[p]]; }

  /** La tarifa de la comida; 0 = no configurada (si toca, lo dice la lista de faltantes, no el encabezado). */
  tarifa(m: ComidaViatico): number { return this.tarifas()?.[m] ?? 0; }
}
