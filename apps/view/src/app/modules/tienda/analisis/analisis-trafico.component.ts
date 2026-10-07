import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { SelectButtonModule } from 'primeng/selectbutton';
import { TableModule } from 'primeng/table';
import { ChartModule } from 'primeng/chart';
import { ThemeService } from '../../../core/services/theme.service';
import { MetricCardComponent } from '../../../shared/components/metric-card/metric-card.component';
import { RangeReport } from '../weekly.service';
import { AnalisisStateService } from './analisis-state.service';
import { AnalisisCascadaComponent } from './analisis-cascada.component';

type RangeMetric = 'revenue' | 'tickets' | 'units';

/**
 * `[TDA.A1]` Sección **Tráfico** de `/tienda/analisis-semanal` (la que abre por default).
 *
 * Dos bloques, en este orden:
 *  1. LA FOTOGRAFÍA — la matriz de palancas del período elegido (volumen arriba, su
 *     precio abajo), su tendencia diaria y el desglose por sucursal. Es lo que ya vivía
 *     en la pantalla antes de partirla en secciones; las métricas no se tocaron.
 *  2. LA CASCADA — el mismo rango partido en el grano que se elija. Ver
 *     `AnalisisCascadaComponent`.
 *
 * Lo que se fue de acá: el top de productos, que ahora vive en «Productos y
 * proveedores». Por eso esta sección pide el rango SIN productos.
 *
 * Lo que se fue del módulo: el switch «Rango / Semana». La cascada con grano Semana
 * hace lo mismo y con el juego completo de indicadores, así que tener las dos era
 * tener dos formas de mirar la misma semana que podían no coincidir.
 *
 * OJO: acá adentro NO van acentos graves (template literal de JS).
 */
@Component({
  selector: 'app-tienda-analisis-trafico',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, SelectButtonModule, TableModule, ChartModule,
    MetricCardComponent, AnalisisCascadaComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (st.rangeError()) {
      <div class="tf-banner">
        <i class="pi pi-exclamation-triangle"></i> No se pudo cargar el análisis.
        <button pButton type="button" class="p-button-text p-button-sm" (click)="st.loadRange()">
          <span class="p-button-label">Reintentar</span>
        </button>
      </div>
    }

    @if (st.rangeRep(); as r) {
      <!--
        Matriz 5 × 2: cada COLUMNA es una palanca (arriba el volumen, abajo su precio),
        como la 3×2 de /tienda/live (TDA.P). El grid fluye por COLUMNA a propósito: así
        el DOM va de a pares y la pareja sobrevive los tres anchos (5 col → 3 col →
        lista), que con flujo por fila se rompía — al pasar a 2 columnas «Venta» dejaba
        de tener «Margen» debajo.
      -->
      <div class="tf-kpi-matrix">
        <app-metric-card label="Venta" [value]="r.kpis.revenue.cur" format="currency"
          tone="brand" [delta]="r.kpis.revenue.delta_pct" sub="lo que entró en el período"></app-metric-card>
        <app-metric-card label="Margen" [value]="r.kpis.margin.cur" format="currency"
          [delta]="r.kpis.margin.delta_pct" [sub]="margenSub(r)"></app-metric-card>

        <app-metric-card label="Tickets" [value]="r.kpis.tickets.cur" format="number"
          [accent]="'var(--chart-1)'" [delta]="r.kpis.tickets.delta_pct" sub="cuántas veces se cobró"></app-metric-card>
        <app-metric-card label="Ticket promedio" [value]="r.kpis.avg_ticket.cur" format="currency"
          [accent]="'var(--chart-4)'" [delta]="r.kpis.avg_ticket.delta_pct" sub="partidas × valor por partida"></app-metric-card>

        <app-metric-card label="Partidas por ticket" [value]="r.kpis.basket.cur" format="number" [decimals]="2"
          [accent]="'var(--chart-2)'" [delta]="r.kpis.basket.delta_pct" sub="renglones distintos por venta"></app-metric-card>
        @if (r.kpis.avg_line.cur !== null) {
          <app-metric-card label="Valor por partida" [value]="r.kpis.avg_line.cur!" format="currency" [decimals]="2"
            [accent]="'var(--chart-3)'" [delta]="r.kpis.avg_line.delta_pct" sub="cuánto deja cada renglón"></app-metric-card>
        } @else {
          <app-metric-card label="Valor por partida" format="text" valueText="—"
            [accent]="'var(--chart-3)'" [sub]="sinCobertura"></app-metric-card>
        }

        @if (r.kpis.units_per_ticket.cur !== null) {
          <app-metric-card label="Unidades por ticket" [value]="r.kpis.units_per_ticket.cur!" format="number" [decimals]="1"
            [accent]="'var(--chart-5)'" [delta]="r.kpis.units_per_ticket.delta_pct" sub="piezas o kg por venta"></app-metric-card>
        } @else {
          <app-metric-card label="Unidades por ticket" format="text" valueText="—"
            [accent]="'var(--chart-5)'" [sub]="sinCobertura"></app-metric-card>
        }
        @if (r.kpis.avg_unit.cur !== null) {
          <app-metric-card label="Valor unitario promedio" [value]="r.kpis.avg_unit.cur!" format="currency" [decimals]="2"
            [accent]="'var(--chart-6)'" [delta]="r.kpis.avg_unit.delta_pct" sub="cuánto vale cada pieza o kg"></app-metric-card>
        } @else {
          <app-metric-card label="Valor unitario promedio" format="text" valueText="—"
            [accent]="'var(--chart-6)'" sub="no hubo venta en el período"></app-metric-card>
        }

        <app-metric-card label="Clientes" [value]="r.kpis.customers.cur" format="number"
          [accent]="'var(--chart-7)'" [delta]="r.kpis.customers.delta_pct" [sub]="clientesSub(r)"></app-metric-card>
        @if (r.kpis.revenue_per_customer.cur !== null) {
          <app-metric-card label="Venta por cliente" [value]="r.kpis.revenue_per_customer.cur!" format="currency"
            [accent]="'var(--chart-7)'" [delta]="r.kpis.revenue_per_customer.delta_pct"
            sub="promedio de lo que compró cada uno"></app-metric-card>
        } @else {
          <app-metric-card label="Venta por cliente" format="text" valueText="—"
            [accent]="'var(--chart-7)'" sub="ningún cliente con registro en el período"></app-metric-card>
        }
      </div>

      <p class="tf-refnote tf-muted">
        {{ r.period.from | date: 'dd/MM/yy' }}–{{ r.period.to | date: 'dd/MM/yy' }} ({{ r.period.days }} {{ r.period.days === 1 ? 'día' : 'días' }})
        vs {{ r.prev_period.from | date: 'dd/MM/yy' }}–{{ r.prev_period.to | date: 'dd/MM/yy' }}.
        Tickets y partidas salen del POS; venta, margen y unidades del fact de venta.
        «Partida» = renglón del ticket; «unidad» = pieza o kg vendido.
        «Valor unitario promedio» es venta ÷ unidades (misma fuente). «Valor por partida» y
        «Unidades por ticket» cruzan las dos fuentes, así que sólo se publican donde el POS cubre el período.
      </p>

      <div class="card-premium card-flat tf-panel">
        <div class="tf-panel-head">
          <h3 class="tf-card-title">Tendencia diaria</h3>
          <p-selectbutton [options]="rangeMetricOptions" optionLabel="label" optionValue="value" [allowEmpty]="false"
                          [ngModel]="rangeMetric()" (ngModelChange)="rangeMetric.set($event)" styleClass="sb-liquid sb-liquid-sm" />
        </div>
        @if (r.series.length) {
          <div class="tf-chart"><p-chart type="bar" [data]="rangeChartData()" [options]="rangeChartOpts()"></p-chart></div>
        } @else {
          <p class="tf-empty">Sin venta registrada en el rango.</p>
        }
      </div>

      @if (r.by_branch.length > 1) {
        <div class="card-premium card-flat tf-panel">
          <h3 class="tf-card-title">Por sucursal</h3>
          <p-table [value]="r.by_branch" styleClass="p-datatable-sm tf-table" [rowHover]="true">
            <ng-template #header>
              <tr><th>Sucursal</th><th class="ta-r">Venta</th><th class="ta-r">Tickets</th><th class="ta-r">Ticket prom.</th><th class="ta-r">Margen</th><th class="ta-r">Unidades</th></tr>
            </ng-template>
            <ng-template #body let-b>
              <tr>
                <td>{{ b.name || b.code }}</td>
                <td class="ta-r strong">{{ money(b.revenue) }}</td>
                <td class="ta-r">{{ num(b.tickets) }}</td>
                <td class="ta-r">{{ b.tickets > 0 ? money(b.avg_ticket) : '—' }}</td>
                <td class="ta-r tf-muted">{{ money(b.margin) }}</td>
                <td class="ta-r">{{ num(b.units) }}</td>
              </tr>
            </ng-template>
          </p-table>
        </div>
      }
    } @else if (!st.rangeError()) {
      <div class="tf-loading">Cargando el análisis…</div>
    }

    <app-analisis-cascada />
  `,
  styles: [
    `
      :host { display: block; }
      /* Matriz de palancas: volumen arriba, su precio abajo. Flujo por COLUMNA (ver el
         comentario del template): 5×2 → 3×4 → lista, y la pareja queda junta en los tres. */
      .tf-kpi-matrix { display: grid; grid-auto-flow: column; grid-template-rows: repeat(2, auto);
                       grid-auto-columns: minmax(0, 1fr); gap: .6rem; margin-bottom: .6rem; }
      @media (max-width: 72rem) { .tf-kpi-matrix { grid-template-rows: repeat(4, auto); } }
      @media (max-width: 38rem) { .tf-kpi-matrix { grid-auto-flow: row; grid-template-rows: none; grid-template-columns: 1fr; } }
      .tf-refnote { font-size: .72rem; margin: 0 0 1rem; }
      .tf-panel { padding: 1rem; margin-bottom: 1rem; }
      .tf-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: .7rem; }
      .tf-card-title { margin: 0; font-size: .85rem; font-weight: 700; }
      .tf-chart { height: 280px; }
      .tf-table { font-variant-numeric: tabular-nums; }
      .tf-banner { display: flex; align-items: center; gap: .5rem; background: color-mix(in srgb, var(--bad-fg) 8%, transparent);
                   border: 1px solid color-mix(in srgb, var(--bad-fg) 30%, transparent); border-radius: var(--r-md);
                   padding: .7rem .9rem; font-size: .82rem; margin-bottom: 1rem; }
      .tf-loading, .tf-empty { padding: 2rem; text-align: center; color: var(--text-muted); font-size: .85rem; }
      .ta-r { text-align: right; } .strong { font-weight: 700; } .tf-muted { color: var(--text-muted); }
    `,
  ],
})
export class TiendaAnalisisTraficoComponent implements OnInit {
  protected readonly st = inject(AnalisisStateService);
  private readonly theme = inject(ThemeService);

  readonly rangeMetric = signal<RangeMetric>('revenue');
  readonly rangeMetricOptions = [
    { label: 'Venta $', value: 'revenue' as RangeMetric },
    { label: 'Tickets', value: 'tickets' as RangeMetric },
    { label: 'Unidades', value: 'units' as RangeMetric },
  ];

  /** Motivo único cuando una razón cruzada no se puede publicar (ver `RangeRatioKpi`). */
  readonly sinCobertura = 'el POS no cubre todo el período';

  ngOnInit(): void {
    /**
     * `[TDA.A2]` Tráfico es SIEMPRE la tienda completa. La línea que se haya elegido en
     * «Productos y proveedores» se suelta al entrar acá: las dos pestañas comparten una
     * sola cascada, y si la selección sobreviviera, esta pantalla mostraría la evolución
     * de una línea bajo un encabezado que dice «Tráfico» y bajo tarjetas que son de toda
     * la tienda. Nadie vería la contradicción hasta sumar dos números que no cuadran.
     */
    this.st.limpiarAlcanceSalvo(null);
    // Sin productos: esa tabla se mudó a su propia pestaña y es la consulta cara.
    this.st.need('range', 'breakdown');
  }

  /**
   * El margen en pesos sube y baja con el volumen; contra lo que se compara es el
   * **% de la venta**, así que va pegado al valor. Si no hubo venta no se inventa un
   * 0.0%: se dice que no hay contra qué medirlo.
   */
  margenSub(r: RangeReport): string {
    const p = r.kpis.margin_pct.cur;
    return p == null
      ? 'sin venta en el período'
      : `${p.toLocaleString('es-MX', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}% de la venta`;
  }

  /**
   * La cifra de clientes carga con QUÉ excluye y HASTA CUÁNDO alcanza su fuente. La
   * facturación se atrasa distinto que el fact de venta, y sin decirlo un feed detenido
   * se lee como "no vino nadie" en vez de "todavía no llegó el dato".
   */
  clientesSub(r: RangeReport): string {
    const base = 'con registro, sin mostrador ni televenta';
    const asOf = r.as_of?.customers;
    if (!asOf) return r.kpis.customers.cur > 0 ? base : 'sin facturación a nombre en el período';
    return asOf < r.period.to ? `${base} · hasta ${this.diaCorto(asOf)}` : base;
  }
  private diaCorto(iso: string): string {
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y.slice(2)}`;
  }

  readonly rangeChartData = computed(() => {
    const r = this.st.rangeRep();
    const m = this.rangeMetric();
    this.theme.isMonochrome();
    if (!r) return { labels: [], datasets: [] };
    const color = this.cssVar('--action', '#F05A28');
    const pick = (s: RangeReport['series'][number]) => (m === 'revenue' ? s.revenue : m === 'tickets' ? s.tickets : s.units);
    return {
      labels: r.series.map((s) => this.dayLabel(s.date)),
      datasets: [{
        label: m === 'revenue' ? 'Venta $' : m === 'tickets' ? 'Tickets' : 'Unidades',
        data: r.series.map(pick),
        backgroundColor: `color-mix(in srgb, ${color} 65%, transparent)`,
        borderColor: color, borderWidth: 1, borderRadius: 3,
      }],
    };
  });

  readonly rangeChartOpts = computed(() => {
    this.theme.isMonochrome();
    const m = this.rangeMetric();
    const axis = this.cssVar('--text-muted', '#57534E');
    const grid = this.cssVar('--border-color', 'rgba(0,0,0,.08)');
    const fmt = (v: number) => (m === 'revenue' ? '$' + Number(v).toLocaleString('es-MX') : Number(v).toLocaleString('es-MX'));
    return {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: axis, maxRotation: 0, autoSkip: true }, grid: { display: false } },
        y: { ticks: { color: axis, callback: (v: number) => fmt(v) }, grid: { color: grid } },
      },
    };
  });

  private dayLabel(iso: string): string {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
  }
  private cssVar(name: string, fallback: string): string {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  money(v: number): string { return (v || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  num(v: number): string { return Math.round(v || 0).toLocaleString('es-MX'); }
}
