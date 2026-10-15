import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TableModule } from 'primeng/table';
import type { IncomeChannel, IncomeForecastCell, IncomeForecastDay, IncomeForecastResponse } from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { CANALES, meses, origen, porEntrar, proyectado, semanas } from './presupuesto/presupuesto-ingresos';

const DIAS_SEMANA = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
const DOS_DIAS_SEG = 2 * 24 * 3600;

/**
 * `[PU.13]` **Ingresos · estimado — el ingreso por día, bancos y caja general, con lo real al lado.**
 *
 * La forma es la de la hoja de Finanzas: una fila por semana y, por cada día, dos columnas. Abre con
 * la respuesta (cuánto falta por entrar y cuánto da cada mes) y después la rejilla.
 *
 * Lo real llega del módulo de Bancos en el momento; lo que todavía no está cargado se muestra con el
 * estimado en cursiva y gris, y el total de cada mes suma las dos cosas. Página propia y no una pestaña
 * de `/presupuesto` por la misma razón que Tesorería (`[TES.15]`): aquel componente es enorme y lo
 * editan varias sesiones.
 */
@Component({
  selector: 'app-presupuesto-ingresos',
  standalone: true,
  imports: [CommonModule, RouterLink, TableModule, LoadStateComponent, MetricStripComponent, FreshnessPillComponent],
  template: `
    <div class="surf-page pi-page">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Ingresos · estimado</h1>
          <p class="surf-page-sub">Cuánto va a entrar cada día a bancos y a caja general, y cuánto entró de verdad.</p>
          @if (data(); as d) {
            <div class="pi-fresh">
              <app-freshness-pill measures="data" [since]="d.real_hasta.bancos" [staleAfterSec]="DOS_DIAS" label="bancos" />
              <app-freshness-pill measures="data" [since]="d.real_hasta.caja_general" [staleAfterSec]="DOS_DIAS" label="caja general" />
            </div>
          }
        </div>
        <a class="p-button p-button-sm p-button-text" routerLink="/presupuesto">
          <span class="pi pi-arrow-left" aria-hidden="true"></span>&nbsp;Presupuesto
        </a>
      </header>

      <app-load-state [loading]="cargando()" [error]="error()" [isEmpty]="vacio()"
                      emptyIcon="pi-calendar" emptyTitle="No hay estimado de ingresos vigente"
                      [emptyHint]="data()?.vacia_porque ?? null" (retry)="cargar()">
        @if (data(); as d) {
          <!-- La respuesta primero: lo que falta por entrar y el total de cada mes. -->
          <app-metric-strip [items]="kpis()" mode="strip" ariaLabel="Ingresos estimados" />

          <section class="pi-sec" aria-labelledby="pi-meses">
            <h2 id="pi-meses" class="pi-h2">Por mes</h2>
            <p class="pi-nota">«Real vs estimado» compara lo que entró contra lo que se estimó, sólo en los días que ya tienen los dos; mientras no haya ninguno queda en blanco.</p>
            <p-table [value]="meses()" dataKey="mes" size="small" [rowHover]="true"
                     selectionMode="single" [(selection)]="mesSel"
                     class="dt-matrix-ok surf-table surf-table--plain surf-table--frozen-first"
                     [tableStyle]="{ 'min-width': '60rem' }">
              <ng-template #header>
                <tr>
                  <th scope="col" rowspan="2" pFrozenColumn>Mes</th>
                  <th scope="colgroup" colspan="4" class="pi-grp">Bancos</th>
                  <th scope="colgroup" colspan="4" class="pi-grp">Caja general</th>
                  <th scope="col" rowspan="2" class="comm-num">Total</th>
                </tr>
                <tr>
                  @for (c of CANALES; track c) {
                    <th scope="col" class="comm-num">Ya entró</th>
                    <th scope="col" class="comm-num">Por entrar</th>
                    <th scope="col" class="comm-num">Total</th>
                    <th scope="col" class="comm-num">Real vs estimado</th>
                  }
                </tr>
              </ng-template>
              <ng-template #body let-m>
                <tr [pSelectableRow]="m">
                  <td pFrozenColumn class="pi-mes">{{ m.etiqueta }}</td>
                  @for (c of CANALES; track c) {
                    <td class="comm-num">{{ dinero(m.canal[c].real) }}</td>
                    <td class="comm-num pi-est">{{ dinero(m.canal[c].porEntrar) }}</td>
                    <td class="comm-num is-strong">{{ dinero(m.canal[c].proyectado) }}</td>
                    <td class="comm-num" [title]="desvioTip(m.canal[c].desvio)">{{ desvio(m.canal[c].desvio) }}</td>
                  }
                  <td class="comm-num is-strong">{{ dinero(m.total) }}</td>
                </tr>
              </ng-template>
            </p-table>
          </section>

          <section class="pi-sec" aria-labelledby="pi-semanas">
            <div class="pi-sec-head">
              <h2 id="pi-semanas" class="pi-h2">Por semana y día</h2>
              <p class="pi-leyenda">
                <span class="pi-real">1,234</span> ya entró ·
                <span class="pi-est">1,234</span> estimado ·
                <span class="pi-inh">inh.</span> día inhábil bancario ·
                vacío = fuera del periodo
              </p>
            </div>
            <p-table [value]="semanas()" dataKey="clave" size="small" [rowHover]="true"
                     selectionMode="single" [(selection)]="semanaSel"
                     class="dt-matrix-ok surf-table surf-table--plain surf-table--sticky surf-table--frozen-first"
                     [tableStyle]="{ 'min-width': '118rem' }">
              <ng-template #header>
                <tr>
                  <th scope="col" rowspan="2" pFrozenColumn>Semana</th>
                  @for (dn of DIAS_SEMANA; track dn) {
                    <th scope="colgroup" colspan="2" class="pi-grp">{{ dn }}</th>
                  }
                  <th scope="colgroup" colspan="3" class="pi-grp">Total semana</th>
                </tr>
                <tr>
                  @for (dn of DIAS_SEMANA; track dn) {
                    <th scope="col" class="comm-num">bancos</th>
                    <th scope="col" class="comm-num">caja</th>
                  }
                  <th scope="col" class="comm-num">bancos</th>
                  <th scope="col" class="comm-num">caja</th>
                  <th scope="col" class="comm-num">total</th>
                </tr>
              </ng-template>
              <ng-template #body let-s>
                <tr [pSelectableRow]="s">
                  <td pFrozenColumn class="pi-sem" [title]="s.desde + ' a ' + s.hasta">{{ s.etiqueta }}</td>
                  @for (d of s.dias; track $index) {
                    @if (d) {
                      @for (c of CANALES; track c) {
                        <td class="comm-num" [class.pi-est]="origenDe(d[c]) === 'estimado'" [title]="tip(d, c)">
                          {{ dinero(valor(d[c])) }}
                          @if (d.inhabil && c === 'bancos') { <span class="pi-inh">inh.</span> }
                        </td>
                      }
                    } @else {
                      <td class="comm-num pi-fuera"></td><td class="comm-num pi-fuera"></td>
                    }
                  }
                  <td class="comm-num is-strong">{{ dinero(s.total.bancos) }}</td>
                  <td class="comm-num is-strong">{{ dinero(s.total.caja_general) }}</td>
                  <td class="comm-num is-strong">{{ dinero(s.totalAmbos) }}</td>
                </tr>
              </ng-template>
            </p-table>
          </section>

          @if (d.version; as v) {
            <section class="pi-sec pi-metodo" aria-labelledby="pi-metodo">
              <h2 id="pi-metodo" class="pi-h2">Cómo se calculó</h2>
              <p class="pi-nota"><strong>{{ v.nombre }}</strong> · {{ v.metodo }}</p>
              <p class="pi-nota"><strong>Qué cuenta como real:</strong> {{ d.definicion_real }}</p>
              <p class="pi-nota">
                <span class="pi pi-info-circle" aria-hidden="true"></span>
                Bancos cargado hasta {{ d.real_hasta.bancos ?? 'sin datos' }}; caja general hasta
                {{ d.real_hasta.caja_general ?? 'sin datos' }}. Los días después de eso muestran el estimado
                (en cursiva) y se corrigen solos cuando Tesorería carga el estado de cuenta.
              </p>
            </section>
          }
        }
      </app-load-state>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .pi-page { gap: var(--sp-4); }
    .pi-fresh { display: flex; gap: var(--sp-2); flex-wrap: wrap; margin-top: var(--sp-2); }
    .pi-sec { display: flex; flex-direction: column; gap: var(--sp-2); }
    .pi-sec-head { display: flex; justify-content: space-between; align-items: baseline; gap: var(--sp-3); flex-wrap: wrap; }
    .pi-h2 { font-size: var(--fs-lg); font-weight: 700; margin: 0; color: var(--text-main); }
    .pi-grp { text-align: center; text-transform: capitalize; border-bottom: 1px solid var(--border-color); }
    .pi-mes, .pi-sem { text-transform: capitalize; white-space: nowrap; font-weight: 600; }
    /* El estimado no depende solo del color: va en cursiva, que se lee igual en Alto Contraste. */
    .pi-est { color: var(--text-muted); font-style: italic; }
    .pi-real { color: var(--text-main); }
    .pi-inh { font-size: var(--fs-nano); color: var(--warn-fg); margin-inline-start: var(--sp-1);
              border: 1px solid currentColor; border-radius: var(--r-sm); padding: 0 var(--sp-1); font-style: normal; }
    .pi-fuera { background: var(--overlay-hover); }
    .pi-leyenda { font-size: var(--fs-xs); color: var(--text-muted); margin: 0; }
    .pi-nota { font-size: var(--fs-xs); color: var(--text-muted); margin: 0; }
    .pi-metodo { border-top: 1px solid var(--border-color); padding-top: var(--sp-3); }
  `],
})
export class PresupuestoIngresosComponent {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);

  readonly CANALES = CANALES;
  readonly DIAS_SEMANA = DIAS_SEMANA;
  readonly DOS_DIAS = DOS_DIAS_SEG;

  readonly data = signal<IncomeForecastResponse | null>(null);
  /** Fila marcada con teclado o clic (sólo para recorrer la rejilla; no abre nada). */
  mesSel: unknown = null;
  semanaSel: unknown = null;
  readonly cargando = signal(true);
  readonly error = signal<string | null>(null);

  readonly vacio = computed(() => {
    const d = this.data();
    return !!d && (!d.version || d.dias.length === 0);
  });
  readonly semanas = computed(() => semanas(this.data()?.dias ?? []));
  readonly meses = computed(() => meses(this.data()?.dias ?? []));
  readonly kpis = computed<MetricStripItem[]>(() => {
    const d = this.data();
    const ms = this.meses();
    if (!d) return [];
    const falta = porEntrar(d.dias);
    const items: MetricStripItem[] = [
      falta !== null
        ? { label: `Por entrar al ${this.corta(d.version?.hasta ?? null)}`, value: falta, format: 'currency-short',
            state: 'derivado', method: 'Estimado vigente, sólo en los días todavía no cargados' }
        : { label: 'Por entrar', value: '—', format: 'text', state: 'no_medido', stateNote: 'Sin estimado' },
    ];
    for (const m of ms) {
      if (m.total === null) continue;
      const tieneReal = m.canal.bancos.real !== null || m.canal.caja_general.real !== null;
      const tieneEst = m.canal.bancos.porEntrar !== null || m.canal.caja_general.porEntrar !== null;
      items.push({
        label: m.etiqueta.charAt(0).toUpperCase() + m.etiqueta.slice(1),
        value: m.total,
        format: 'currency-short',
        state: tieneReal && tieneEst ? 'parcial' : tieneReal ? 'medido' : 'derivado',
        ...(tieneReal && tieneEst ? { stateNote: 'Lo que ya entró más lo estimado para los días sin cargar' } : {}),
        ...(!tieneReal ? { method: 'Estimado vigente' } : {}),
      });
    }
    return items;
  });

  constructor() {
    this.cargar();
  }

  cargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.http.get<IncomeForecastResponse>('/api/finance/budget/income-forecast')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (d) => { this.data.set(d); this.cargando.set(false); },
        // Un error de red no es un cero: se dice.
        error: () => { this.error.set('No llegó el estimado de ingresos. No es que dé cero: no se pudo leer.'); this.cargando.set(false); },
      });
  }

  valor(c: IncomeForecastCell): number | null { return proyectado(c); }
  origenDe(c: IncomeForecastCell) { return origen(c); }

  tip(d: IncomeForecastDay, c: IncomeChannel): string {
    const cell = d[c];
    const canal = c === 'bancos' ? 'Bancos' : 'Caja general';
    const partes = [`${canal} · ${d.fecha}`];
    if (cell.real !== null) partes.push(`entró ${this.dinero(cell.real)}`);
    else partes.push('todavía sin cargar');
    if (cell.estimado !== null) partes.push(`estimado ${this.dinero(cell.estimado)}`);
    if (d.inhabil) partes.push('día inhábil bancario');
    return partes.join(' · ');
  }

  desvio(dv: { pct: number } | null): string {
    if (!dv) return '—';
    const s = dv.pct >= 0 ? '+' : '−';
    return `${s}${Math.abs(dv.pct).toFixed(1)} %`;
  }
  desvioTip(dv: { real: number; estimado: number } | null): string {
    return dv ? `Real ${this.dinero(dv.real)} contra estimado ${this.dinero(dv.estimado)}, en los días que tienen los dos`
      : 'Todavía no hay días con real y estimado a la vez';
  }

  dinero(n: number | string | null): string {
    if (n === null || n === undefined) return '—';
    return Number(n).toLocaleString('es-MX', { maximumFractionDigits: 0 });
  }

  private corta(f: string | null): string {
    if (!f) return '—';
    const [, m, d] = f.split('-');
    const mes = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'][Number(m) - 1];
    return `${Number(d)}-${mes}`;
  }
}
