import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { pendientesDeLaGuia } from '@megadulces/contracts';
import { DeliveryGuide, Driver } from '../logistica.service';

export interface CostoEstimado {
  /** null = la guía está incompleta (EMB.22): se calculan al completarla en Guías. No es cero. */
  comisiones: number | null;
  viaticos: number | null;
  /** Gasto de Kepler ATRIBUIDO a esta guía. null = no se pudo medir (sin permiso o sin dato): no es cero. */
  gastos_kepler: number | null;
  total: number;
  /** El total no incluye todo: el gasto de Kepler no se pudo medir o la guía está incompleta. */
  incompleto: boolean;
  /** Costo como % del valor movido. null si el valor es cero. */
  pct_sobre_valor: number | null;
  /** Pesos de mercancía movidos por cada peso de costo. null si el costo es cero. */
  movido_por_peso: number | null;
}

const centavos = (v: unknown) => Math.round((Number(v) || 0) * 100);

/**
 * Costo estimado de un viaje al programarlo: comisiones + viáticos (de la guía de la Suite) +
 * el gasto de Kepler atribuido a la guía (CGU.4, prorrateado por canal y día).
 *
 * No publica MARGEN: el embarque de Kepler no trae costo de la mercancía por renglón, así que lo
 * único honesto es «cuánto cuesta mover» (lo mismo que hace la pantalla de costos por guía).
 */
export function costoEstimado(
  guia: Pick<DeliveryGuide, 'driver_commission' | 'helper1_commission' | 'helper2_commission' | 'per_diem_total' | 'driver_id' | 'departure_time' | 'arrival_time'> | null,
  gastosKepler: number | null,
  valor: number,
): CostoEstimado {
  // EMB.22 — una guía incompleta trae comisión y viáticos en 0 hasta que se completa: no se suman como $0.
  const sinCalcular = !!guia && pendientesDeLaGuia(guia).length > 0;
  const com = guia && !sinCalcular ? centavos(guia.driver_commission) + centavos(guia.helper1_commission) + centavos(guia.helper2_commission) : 0;
  const via = guia && !sinCalcular ? centavos(guia.per_diem_total) : 0;
  const kep = gastosKepler == null ? 0 : centavos(gastosKepler);
  const total = com + via + kep;
  return {
    comisiones: sinCalcular ? null : com / 100,
    viaticos: sinCalcular ? null : via / 100,
    gastos_kepler: gastosKepler == null ? null : kep / 100,
    total: total / 100,
    incompleto: gastosKepler == null || sinCalcular,
    pct_sobre_valor: valor > 0 ? Math.round((total / 100 / valor) * 10000) / 100 : null,
    movido_por_peso: total > 0 ? Math.round((valor / (total / 100)) * 100) / 100 : null,
  };
}

/**
 * EMB.12 — Tripulación, pago y costo estimado del viaje, en la hoja final del embarque.
 * La tripulación y el pago son de la Suite (Kepler sólo trae al chofer); el gasto atribuido
 * viene de Kepler por la pantalla de costos por guía.
 */
@Component({
  selector: 'app-kepler-costo',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="kc">
      <section class="kc-card" aria-labelledby="kc-pago">
        <h3 id="kc-pago">Tripulación y pago</h3>
        @if (guia(); as g) {
          @if (pendientes().length) {
            <p class="kc-hint is-warn">La guía <code>{{ g.number }}</code> está incompleta: falta {{ pendientes().join(' y ') }}. Se completa en la pestaña Guías; ahí se calculan la comisión y los viáticos.</p>
          } @else {
          <table class="kc-table">
            <tbody>
              <tr><th scope="row">Chofer · {{ nombre(g.driver_id) }}</th><td class="num">{{ g.driver_commission | currency:'MXN':'symbol-narrow':'1.2-2' }}</td></tr>
              @if (g.helper1_id) {
                <tr><th scope="row">Ayudante 1 · {{ nombre(g.helper1_id) }}</th><td class="num">{{ g.helper1_commission | currency:'MXN':'symbol-narrow':'1.2-2' }}</td></tr>
              }
              @if (g.helper2_id) {
                <tr><th scope="row">Ayudante 2 · {{ nombre(g.helper2_id) }}</th><td class="num">{{ g.helper2_commission | currency:'MXN':'symbol-narrow':'1.2-2' }}</td></tr>
              }
              <tr><th scope="row">Viáticos{{ g.overnight ? ' · con pernocta' : '' }}</th><td class="num">{{ g.per_diem_total | currency:'MXN':'symbol-narrow':'1.2-2' }}</td></tr>
            </tbody>
          </table>
          <p class="kc-hint">Guía de entrega <code>{{ g.number }}</code>.</p>
          }
        } @else {
          <p class="kc-hint">Este embarque no tiene guía de entrega.</p>
        }
      </section>

      <section class="kc-card" aria-labelledby="kc-costo">
        <h3 id="kc-costo">Costo estimado del viaje</h3>
        @let c = costo();
        <dl class="kc-dl">
          <dt>Comisiones</dt>
          <dd>@if (c.comisiones !== null) { {{ c.comisiones | currency:'MXN':'symbol-narrow':'1.2-2' }} } @else { <span class="kc-missing">Se calculan en Guías</span> }</dd>
          <dt>Viáticos</dt>
          <dd>@if (c.viaticos !== null) { {{ c.viaticos | currency:'MXN':'symbol-narrow':'1.2-2' }} } @else { <span class="kc-missing">Se calculan en Guías</span> }</dd>
          <dt>Gastos de Kepler atribuidos</dt>
          <dd>
            @if (c.gastos_kepler !== null) { {{ c.gastos_kepler | currency:'MXN':'symbol-narrow':'1.2-2' }} }
            @else { <span class="kc-missing">Sin medir</span> }
          </dd>
          <dt class="kc-total">Costo estimado</dt><dd class="kc-total">{{ c.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</dd>
        </dl>
        @if (c.gastos_kepler === null) {
          <p class="kc-hint is-warn">{{ motivoGastos() || 'El gasto de Kepler no se pudo leer: el total no lo incluye.' }}</p>
        }
        @if (c.comisiones === null) {
          <p class="kc-hint is-warn">El total todavía no incluye comisiones ni viáticos: la guía está incompleta.</p>
        }
        <div class="kc-kpis">
          <div><span>Costo sobre el valor</span><b>{{ c.pct_sobre_valor !== null ? (c.pct_sobre_valor | number:'1.2-2') + '%' : '—' }}</b></div>
          <div><span>Mercancía movida por $1</span><b>{{ c.movido_por_peso !== null ? (c.movido_por_peso | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }}</b></div>
        </div>
        <p class="kc-hint">Sin margen: Kepler no trae el costo de la mercancía en el embarque. El gasto de Kepler llega por canal y día y se reparte entre las guías de ese día.</p>
      </section>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .kc { display: grid; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); gap: 1rem; }
    .kc-card { background: var(--c-surface-1); border: 1px solid var(--c-divider); border-radius: var(--r-md); padding: 1rem; display: flex; flex-direction: column; gap: .6rem; }
    .kc-card h3 { margin: 0; font-size: var(--fs-h3); font-weight: var(--fw-bold); }
    .kc-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    .kc-table th { text-align: left; font-weight: var(--fw-medium); padding: .4rem 0; border-bottom: 1px solid var(--c-surface-2); }
    .kc-table td { padding: .4rem 0; border-bottom: 1px solid var(--c-surface-2); }
    .num, .kc-dl dd { text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .kc-dl { margin: 0; display: grid; grid-template-columns: 1fr auto; gap: .4rem .75rem; font-size: var(--fs-sm); }
    .kc-dl dt { color: var(--c-text-2); }
    .kc-dl dd { margin: 0; }
    .kc-total { font-weight: var(--fw-bold); color: var(--c-text-1); padding-top: .4rem; border-top: 1px solid var(--c-divider); }
    .kc-missing { font-family: inherit; color: var(--warn-soft-fg); }
    .kc-kpis { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .6rem; }
    .kc-kpis > div { background: var(--c-surface-0); border: 1px solid var(--c-divider); border-radius: var(--r-sm); padding: .5rem .6rem; display: flex; flex-direction: column; gap: .1rem; font-size: var(--fs-xs); color: var(--c-text-2); }
    .kc-kpis b { font-size: var(--fs-h3); color: var(--c-text-1); font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .kc-hint { margin: 0; font-size: var(--fs-xs); color: var(--c-text-2); }
    .kc-hint.is-warn { color: var(--warn-soft-fg); }
    .kc-hint code { font-family: var(--font-mono); }
  `],
})
export class KeplerCostoComponent {
  readonly guia = input<DeliveryGuide | null>(null);
  readonly personas = input<Driver[]>([]);
  readonly valor = input<number>(0);
  readonly gastosKepler = input<number | null>(null);
  readonly motivoGastos = input<string | null>(null);

  readonly costo = computed(() => costoEstimado(this.guia(), this.gastosKepler(), this.valor()));
  readonly pendientes = computed(() => {
    const g = this.guia();
    return g ? pendientesDeLaGuia(g) : [];
  });

  nombre(id: string | null | undefined): string {
    if (!id) return '—';
    return this.personas().find((p) => p.id === id)?.full_name ?? 'Persona sin nombre en el padrón';
  }
}
