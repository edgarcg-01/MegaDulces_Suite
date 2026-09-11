import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { SelectButtonModule } from 'primeng/selectbutton';
import { DatePickerModule } from 'primeng/datepicker';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ChartModule } from 'primeng/chart';
import { AuthService } from '../../../core/services/auth.service';
import { ThemeService } from '../../../core/services/theme.service';
import { branchName } from '../../../core/constants/store-branches';
import { WeeklyService, WeeklyReport, RangeReport } from '../weekly.service';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { MetricCardComponent } from '../../../shared/components/metric-card/metric-card.component';

type TrendMetric = 'revenue' | 'units';
type RangeMetric = 'revenue' | 'tickets' | 'units';
type Mode = 'rango' | 'semana';

/**
 * Proyecto Tienda — Análisis de venta (/tienda/analisis-semanal).
 *
 * Dos modos:
 *  - RANGO (default): rango de fechas libre + una matriz de palancas para el encargado.
 *    Cada COLUMNA es volumen arriba y su precio abajo — venta/margen, tickets/ticket
 *    promedio, partidas por ticket/valor por partida, unidades por ticket/valor unitario,
 *    clientes/venta por cliente; más serie diaria y top productos, todo vs el período
 *    previo del mismo tamaño.
 *  - SEMANA: la vista semanal clásica (ISO lun–dom) con tendencia N semanas.
 * Scopeado a la sucursal del usuario (backend fuerza warehouse_code). Superficie Operations.
 */
@Component({
  selector: 'app-tienda-weekly',
  standalone: true,
  imports: [CommonModule, FormsModule, SelectModule, SelectButtonModule, DatePickerModule, ButtonModule, TableModule, ChartModule, MetricStripComponent, MetricCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in wk-page">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Análisis de ventas</h1>
          <p class="surf-page-sub">Venta, tickets y cómo se compone cada ticket en tu sucursal. Elige un rango o mira por semana.</p>
        </div>
        @if (scopedWarehouse) { <span class="wk-scope"><i class="pi pi-map-marker"></i> {{ branchLabel() }}</span> }
      </header>

      <div class="wk-modebar">
        <p-selectbutton [options]="modeOptions" optionLabel="label" optionValue="value" [allowEmpty]="false"
                        [ngModel]="mode()" (ngModelChange)="onMode($event)" styleClass="sb-liquid" />
        @if (!scopedWarehouse && branchOpts().length) {
          <label class="wk-ctl wk-storefilter">Sucursal
            <p-select [options]="branchOpts()" optionLabel="label" optionValue="value"
                      [ngModel]="storeFilter()" (ngModelChange)="onStore($event)" styleClass="sel-liquid wk-select" appendTo="body"></p-select>
          </label>
        }
      </div>

      <!-- ============================ MODO RANGO ============================ -->
      @if (mode() === 'rango') {
        <div class="wk-controls">
          <p-selectbutton [options]="presetOptions" optionLabel="label" optionValue="value" [allowEmpty]="false"
                          [ngModel]="preset()" (ngModelChange)="onPreset($event)" styleClass="sb-liquid" />
          @if (preset() === 'custom') {
            <p-datepicker [(ngModel)]="customRange" selectionMode="range" [readonlyInput]="true" dateFormat="dd/mm/yy"
                          [showIcon]="true" [maxDate]="today" appendTo="body" (onSelect)="onCustom()" styleClass="wk-dp" placeholder="Elige el rango" />
          }
        </div>

        @if (error()) {
          <div class="wk-banner"><i class="pi pi-exclamation-triangle"></i> No se pudo cargar el análisis.
            <button pButton type="button" class="p-button-text p-button-sm" (click)="loadRange()"><span class="p-button-label">Reintentar</span></button></div>
        }

        @if (rangeRep(); as r) {
          <!--
            Matriz 5 × 2: cada COLUMNA es una palanca (arriba el volumen, abajo su
            precio), como la 3×2 de /tienda/live (TDA.P). El grid fluye por COLUMNA
            a propósito: así el DOM va de a pares y la pareja sobrevive los tres
            anchos (5 col → 3 col → lista), que con flujo por fila se rompía — al
            pasar a 2 columnas «Venta» dejaba de tener «Margen» debajo.

            OJO: acá adentro NO van acentos graves. El template es un template
            literal de JS y un backtick lo corta en seco; el compilador entonces
            reporta "Cannot find name 'tienda'" y no algo que suene a comilla.
          -->
          <div class="wk-kpi-matrix">
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
          <p class="wk-refnote muted">
            {{ r.period.from | date:'dd/MM/yy' }}–{{ r.period.to | date:'dd/MM/yy' }} ({{ r.period.days }} {{ r.period.days === 1 ? 'día' : 'días' }})
            vs {{ r.prev_period.from | date:'dd/MM/yy' }}–{{ r.prev_period.to | date:'dd/MM/yy' }}.
            Tickets y partidas salen del POS; venta, margen y unidades del fact de venta.
            «Partida» = renglón del ticket; «unidad» = pieza o kg vendido.
            «Valor unitario promedio» es venta ÷ unidades (misma fuente). «Valor por partida» y
            «Unidades por ticket» cruzan las dos fuentes, así que sólo se publican donde el POS cubre el período.
          </p>

          <div class="card-premium card-flat wk-panel">
            <div class="wk-panel-head">
              <h3 class="wk-card-title">Tendencia diaria</h3>
              <p-selectbutton [options]="rangeMetricOptions" optionLabel="label" optionValue="value" [allowEmpty]="false"
                              [ngModel]="rangeMetric()" (ngModelChange)="rangeMetric.set($event)" styleClass="sb-liquid sb-liquid-sm" />
            </div>
            @if (r.series.length) {
              <div class="wk-chart"><p-chart type="bar" [data]="rangeChartData()" [options]="rangeChartOpts()"></p-chart></div>
            } @else { <p class="wk-empty">Sin venta registrada en el rango.</p> }
          </div>

          @if (r.by_branch.length > 1) {
            <div class="card-premium card-flat wk-panel">
              <h3 class="wk-card-title">Por sucursal</h3>
              <p-table [value]="r.by_branch" styleClass="p-datatable-sm wk-table" [rowHover]="true">
                <ng-template #header><tr><th>Sucursal</th><th class="ta-r">Venta</th><th class="ta-r">Tickets</th><th class="ta-r">Ticket prom.</th><th class="ta-r">Margen</th><th class="ta-r">Unidades</th></tr></ng-template>
                <ng-template #body let-b>
                  <tr>
                    <td>{{ b.name || b.code }}</td>
                    <td class="ta-r strong">{{ money(b.revenue) }}</td>
                    <td class="ta-r">{{ num(b.tickets) }}</td>
                    <td class="ta-r">{{ money(b.avg_ticket) }}</td>
                    <td class="ta-r muted">{{ money(b.margin) }}</td>
                    <td class="ta-r">{{ num(b.units) }}</td>
                  </tr>
                </ng-template>
              </p-table>
            </div>
          }

          <div class="card-premium card-flat wk-panel">
            <h3 class="wk-card-title">Top productos del período</h3>
            <p-table [value]="r.by_product" styleClass="p-datatable-sm wk-table" [rowHover]="true" [scrollable]="true" scrollHeight="480px">
              <ng-template #header><tr><th>Producto</th><th>Marca</th><th class="ta-r">Venta</th><th class="ta-r">Margen</th><th class="ta-r">Unidades</th></tr></ng-template>
              <ng-template #body let-p>
                <tr>
                  <td><span class="wk-prod">{{ p.nombre }}</span><span class="wk-sku">{{ p.sku }}</span></td>
                  <td class="muted">{{ p.brand || '—' }}</td>
                  <td class="ta-r strong">{{ money(p.revenue) }}</td>
                  <td class="ta-r muted">{{ money(p.margin) }}</td>
                  <td class="ta-r">{{ num(p.units) }}</td>
                </tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="5" class="wk-empty">Sin venta en el rango.</td></tr></ng-template>
            </p-table>
          </div>
        } @else if (!error()) {
          <div class="wk-loading">Cargando análisis…</div>
        }
      }

      <!-- ============================ MODO SEMANA ============================ -->
      @if (mode() === 'semana') {
        <div class="wk-controls">
          <label class="wk-ctl">Semana
            <p-select [options]="weekOptions()" optionLabel="label" optionValue="week_start"
                      [ngModel]="weekSel()" (ngModelChange)="onWeek($event)" styleClass="sel-liquid wk-select" appendTo="body"></p-select>
          </label>
          <label class="wk-ctl">Tendencia
            <p-selectbutton [options]="weeksOptions" optionLabel="label" optionValue="value" [allowEmpty]="false"
                            [ngModel]="weeksN()" (ngModelChange)="onWeeks($event)" styleClass="sb-liquid" />
          </label>
        </div>

        @if (error()) {
          <div class="wk-banner"><i class="pi pi-exclamation-triangle"></i> No se pudo cargar el análisis.
            <button pButton type="button" class="p-button-text p-button-sm" (click)="load()"><span class="p-button-label">Reintentar</span></button></div>
        }

        @if (rep(); as r) {
          <app-metric-strip [items]="kpiItems(r)" ariaLabel="Resumen semanal" />
          <p class="wk-refnote muted">Semana <strong>{{ r.ref_week.label }}</strong> ({{ r.ref_week.start | date:'dd/MM' }}–{{ weekEnd(r.ref_week.start) | date:'dd/MM' }}) vs {{ r.prev_week.label }}. «Unidades oficiales» cuadra con el reporte mensual; «Unidades» sale del fact de venta.</p>

          <div class="card-premium card-flat wk-panel">
            <div class="wk-panel-head">
              <h3 class="wk-card-title">Tendencia — últimas {{ r.weeks }} semanas</h3>
              <p-selectbutton [options]="metricOptions" optionLabel="label" optionValue="value" [allowEmpty]="false"
                              [ngModel]="metric()" (ngModelChange)="metric.set($event)" styleClass="sb-liquid sb-liquid-sm" />
            </div>
            @if (r.series.length) {
              <div class="wk-chart"><p-chart type="line" [data]="chartData()" [options]="chartOpts()"></p-chart></div>
            } @else { <p class="wk-empty">Sin venta registrada en el rango.</p> }
          </div>

          @if (r.by_branch.length > 1) {
            <div class="card-premium card-flat wk-panel">
              <h3 class="wk-card-title">Por sucursal</h3>
              <p-table [value]="r.by_branch" styleClass="p-datatable-sm wk-table" [rowHover]="true">
                <ng-template #header><tr><th>Sucursal</th><th class="ta-r">Venta</th><th class="ta-r">Δ%</th><th class="ta-r">Margen</th><th class="ta-r">Unidades</th><th class="ta-r">Δ%</th></tr></ng-template>
                <ng-template #body let-b>
                  <tr>
                    <td>{{ b.name || b.code }}</td>
                    <td class="ta-r strong">{{ money(b.revenue) }}</td>
                    <td class="ta-r"><span [ngClass]="deltaCls(b.revenue_delta_pct)">{{ deltaTxt(b.revenue_delta_pct) }}</span></td>
                    <td class="ta-r muted">{{ money(b.margin) }}</td>
                    <td class="ta-r">{{ num(b.units) }}</td>
                    <td class="ta-r"><span [ngClass]="deltaCls(b.units_delta_pct)">{{ deltaTxt(b.units_delta_pct) }}</span></td>
                  </tr>
                </ng-template>
              </p-table>
            </div>
          }

          <div class="card-premium card-flat wk-panel">
            <h3 class="wk-card-title">Top productos de la semana</h3>
            <p-table [value]="r.by_product" styleClass="p-datatable-sm wk-table" [rowHover]="true" [scrollable]="true" scrollHeight="480px">
              <ng-template #header><tr><th>Producto</th><th>Marca</th><th class="ta-r">Venta</th><th class="ta-r">Δ% vs sem. ant.</th><th class="ta-r">Unidades</th></tr></ng-template>
              <ng-template #body let-p>
                <tr>
                  <td><span class="wk-prod">{{ p.nombre }}</span><span class="wk-sku">{{ p.sku }}</span></td>
                  <td class="muted">{{ p.brand || '—' }}</td>
                  <td class="ta-r strong">{{ money(p.revenue) }}</td>
                  <td class="ta-r"><span [ngClass]="deltaCls(p.revenue_delta_pct)">{{ deltaTxt(p.revenue_delta_pct) }}</span></td>
                  <td class="ta-r">{{ num(p.units) }}</td>
                </tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="5" class="wk-empty">Sin venta en la semana seleccionada.</td></tr></ng-template>
            </p-table>
          </div>
        } @else if (!error()) {
          <div class="wk-loading">Cargando análisis…</div>
        }
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .wk-scope { display: inline-flex; align-items: center; gap: .35rem; font-size: .78rem; font-weight: 600; color: var(--action); margin-left: auto; }
    .wk-modebar { display: flex; align-items: center; gap: 1.25rem; flex-wrap: wrap; margin-bottom: 1rem; }
    .wk-storefilter { margin-left: auto; }
    .wk-controls { display: flex; gap: 1rem; flex-wrap: wrap; align-items: center; margin-bottom: 1rem; }
    .wk-ctl { display: inline-flex; align-items: center; gap: .4rem; font-size: .78rem; color: var(--text-muted); }
    app-metric-strip { display:block; margin-bottom: .5rem; }
    /* Matriz de palancas: volumen arriba, su precio abajo. Flujo por COLUMNA (ver el
       comentario del template): 5×2 → 3×4 → lista, y la pareja queda junta en los tres. */
    .wk-kpi-matrix { display:grid; grid-auto-flow:column; grid-template-rows:repeat(2,auto);
                     grid-auto-columns:minmax(0,1fr); gap:.6rem; margin-bottom:.6rem; }
    @media (max-width:72rem) { .wk-kpi-matrix { grid-template-rows:repeat(4,auto); } }
    @media (max-width:38rem) { .wk-kpi-matrix { grid-auto-flow:row; grid-template-rows:none; grid-template-columns:1fr; } }
    .wk-refnote { font-size: .72rem; margin: 0 0 1rem; }
    .wk-panel { padding: 1rem; margin-bottom: 1rem; }
    .wk-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: .7rem; }
    .wk-card-title { margin: 0; font-size: .85rem; font-weight: 700; }
    .wk-chart { height: 280px; }
    .wk-table { font-variant-numeric: tabular-nums; }
    .wk-prod { display: block; font-weight: 500; } .wk-sku { display: block; font-size: .7rem; color: var(--text-muted); font-family: var(--font-mono, ui-monospace, monospace); }
    .wk-banner { display: flex; align-items: center; gap: .5rem; background: color-mix(in srgb, var(--bad-fg) 8%, transparent); border: 1px solid color-mix(in srgb, var(--bad-fg) 30%, transparent); border-radius: var(--r-md); padding: .7rem .9rem; font-size: .82rem; margin-bottom: 1rem; }
    .wk-loading, .wk-empty { padding: 2rem; text-align: center; color: var(--text-muted); font-size: .85rem; }
    .ta-r { text-align: right; } .strong { font-weight: 700; } .muted { color: var(--text-muted); }
  `],
})
export class TiendaWeeklyComponent implements OnInit {
  private readonly svc = inject(WeeklyService);
  private readonly auth = inject(AuthService);
  private readonly theme = inject(ThemeService);
  private readonly destroyRef = inject(DestroyRef);

  readonly scopedWarehouse = this.auth.user()?.warehouse_code || '';
  readonly branchLabel = computed(() => branchName(this.scopedWarehouse));

  readonly mode = signal<Mode>('rango');
  readonly modeOptions = [{ label: 'Rango', value: 'rango' as Mode }, { label: 'Semana', value: 'semana' as Mode }];
  readonly error = signal(false);
  readonly today = new Date();

  // ---------- filtro por sucursal (solo roles globales; encargado va scopeado) ----------
  readonly storeFilter = signal<string>(''); // '' = todas
  readonly branchOpts = signal<{ label: string; value: string }[]>([]);
  /** Solo repuebla el picker desde la respuesta "Todas" (lista completa), no desde una sucursal ya filtrada. */
  private captureBranchOpts(rows: { code: string; name: string }[]) {
    if (this.scopedWarehouse || this.storeFilter() || rows.length < 2) return;
    const opts = rows
      .map((b) => ({ label: b.name || b.code, value: b.code }))
      .sort((a, b) => a.label.localeCompare(b.label, 'es'));
    this.branchOpts.set([{ label: 'Todas las sucursales', value: '' }, ...opts]);
  }
  onStore(code: string) {
    this.storeFilter.set(code);
    if (this.mode() === 'rango') this.loadRange(); else this.load();
  }

  // ---------- RANGO ----------
  readonly rangeRep = signal<RangeReport | null>(null);
  readonly preset = signal<'7d' | '30d' | 'mes' | 'mes_prev' | 'custom'>('30d');
  customRange: Date[] | null = null;
  private rangeFrom = ''; private rangeTo = '';
  readonly rangeMetric = signal<RangeMetric>('revenue');
  readonly presetOptions = [
    { label: '7 días', value: '7d' }, { label: '30 días', value: '30d' },
    { label: 'Este mes', value: 'mes' }, { label: 'Mes pasado', value: 'mes_prev' },
    { label: 'Personalizado', value: 'custom' },
  ];
  readonly rangeMetricOptions = [
    { label: 'Venta $', value: 'revenue' as RangeMetric },
    { label: 'Tickets', value: 'tickets' as RangeMetric },
    { label: 'Unidades', value: 'units' as RangeMetric },
  ];

  /** Motivo único cuando una razón cruzada no se puede publicar (ver `RangeRatioKpi`). */
  readonly sinCobertura = 'el POS no cubre todo el período';

  /**
   * El margen en pesos sube y baja con el volumen; contra lo que se compara es el
   * **% de la venta**, así que va pegado al valor. Si no hubo venta no se inventa
   * un 0.0%: se dice que no hay contra qué medirlo.
   */
  margenSub(r: RangeReport): string {
    const p = r.kpis.margin_pct.cur;
    return p == null ? 'sin venta en el período' : `${p.toLocaleString('es-MX', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}% de la venta`;
  }

  /**
   * La cifra de clientes carga con QUÉ excluye y HASTA CUÁNDO alcanza su fuente.
   * La facturación se atrasa distinto que el fact de venta, y sin decirlo un feed
   * detenido se lee como "no vino nadie" en vez de "todavía no llegó el dato".
   */
  clientesSub(r: RangeReport): string {
    const base = 'con registro, sin mostrador ni televenta';
    const asOf = r.as_of?.customers;
    // Sólo se avisa cuando la fuente NO llega al final del período pedido: si llega,
    // el aviso sería ruido en todas las cargas.
    if (!asOf) return r.kpis.customers.cur > 0 ? base : 'sin facturación a nombre en el período';
    return asOf < r.period.to ? `${base} · hasta ${this.diaCorto(asOf)}` : base;
  }
  private diaCorto(iso: string): string {
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y.slice(2)}`;
  }

  readonly rangeChartData = computed(() => {
    const r = this.rangeRep(); const m = this.rangeMetric();
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
  private iso(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  private computePreset(p: string): { from: string; to: string } | null {
    const now = new Date();
    if (p === '7d') { const f = new Date(now); f.setDate(f.getDate() - 6); return { from: this.iso(f), to: this.iso(now) }; }
    if (p === '30d') { const f = new Date(now); f.setDate(f.getDate() - 29); return { from: this.iso(f), to: this.iso(now) }; }
    if (p === 'mes') { const f = new Date(now.getFullYear(), now.getMonth(), 1); return { from: this.iso(f), to: this.iso(now) }; }
    if (p === 'mes_prev') {
      const f = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const t = new Date(now.getFullYear(), now.getMonth(), 0); // último día del mes anterior
      return { from: this.iso(f), to: this.iso(t) };
    }
    return null; // custom
  }

  onMode(m: Mode) {
    this.mode.set(m);
    if (m === 'rango' && !this.rangeRep()) this.loadRange();
    if (m === 'semana' && !this.rep()) this.load();
  }
  onPreset(p: 'custom' | '7d' | '30d' | 'mes' | 'mes_prev') {
    this.preset.set(p);
    if (p === 'custom') { if (this.customRange?.length === 2) this.onCustom(); return; }
    const r = this.computePreset(p); if (r) { this.rangeFrom = r.from; this.rangeTo = r.to; this.loadRange(); }
  }
  onCustom() {
    if (!this.customRange || this.customRange.length < 2 || !this.customRange[1]) return;
    this.rangeFrom = this.iso(this.customRange[0]); this.rangeTo = this.iso(this.customRange[1]);
    this.loadRange();
  }
  loadRange() {
    if (!this.rangeFrom || !this.rangeTo) { const r = this.computePreset(this.preset()); if (r) { this.rangeFrom = r.from; this.rangeTo = r.to; } }
    if (!this.rangeFrom || !this.rangeTo) return;
    this.error.set(false); this.rangeRep.set(null);
    this.svc.range({ from: this.rangeFrom, to: this.rangeTo, warehouse_code: this.storeFilter() || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (r) => { this.rangeRep.set(r); this.captureBranchOpts(r.by_branch); }, error: () => { this.error.set(true); this.rangeRep.set(null); } });
  }

  // ---------- SEMANA (clásico) ----------
  readonly rep = signal<WeeklyReport | null>(null);
  readonly weeksN = signal(12);
  readonly weekSel = signal<string>('');
  readonly metric = signal<TrendMetric>('revenue');
  readonly weeksOptions = [{ label: '8', value: 8 }, { label: '12', value: 12 }, { label: '26', value: 26 }];
  readonly metricOptions = [{ label: 'Venta $', value: 'revenue' as TrendMetric }, { label: 'Unidades', value: 'units' as TrendMetric }];
  readonly weekOptions = computed(() => [...(this.rep()?.series ?? [])].reverse().map((s) => ({ label: s.label, week_start: s.week_start })));

  kpiItems(r: WeeklyReport): MetricStripItem[] {
    const k = r.kpis;
    return [
      { label: 'Venta', value: k.revenue.cur, format: 'currency', delta: k.revenue.delta_pct },
      { label: 'Margen', value: k.margin.cur, format: 'currency', delta: k.margin.delta_pct },
      { label: 'Unidades', value: k.units.cur, format: 'number', delta: k.units.delta_pct },
      { label: 'Unidades oficiales', value: k.units_official.cur, format: 'number', delta: k.units_official.delta_pct },
    ];
  }

  readonly chartData = computed(() => {
    const r = this.rep(); const m = this.metric();
    this.theme.isMonochrome();
    if (!r) return { labels: [], datasets: [] };
    const color = this.cssVar('--action', '#F05A28');
    return {
      labels: r.series.map((s) => s.label),
      datasets: [{
        label: m === 'revenue' ? 'Venta $' : 'Unidades',
        data: r.series.map((s) => (m === 'revenue' ? s.revenue : s.units)),
        borderColor: color, backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
        tension: 0.3, fill: true, pointRadius: 2, borderWidth: 2,
      }],
    };
  });
  readonly chartOpts = computed(() => {
    this.theme.isMonochrome();
    const m = this.metric();
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

  load() {
    this.error.set(false);
    this.svc.weekly({ week: this.weekSel() || undefined, weeks: this.weeksN(), warehouse_code: this.storeFilter() || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.rep.set(r); this.captureBranchOpts(r.by_branch); if (!this.weekSel()) this.weekSel.set(r.ref_week.start); },
        error: () => { this.error.set(true); this.rep.set(null); },
      });
  }
  onWeek(ws: string) { this.weekSel.set(ws); this.load(); }
  onWeeks(n: number) { this.weeksN.set(n); this.load(); }

  // ---------- shared ----------
  private cssVar(name: string, fallback: string): string {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }
  ngOnInit() { this.loadRange(); }

  weekEnd(mondayIso: string): Date { const d = new Date(mondayIso + 'T00:00:00'); d.setDate(d.getDate() + 6); return d; }
  deltaCls(p: number | null): string { return p == null ? 'flat' : p > 0 ? 'up' : p < 0 ? 'down' : 'flat'; }
  deltaTxt(p: number | null): string { return p == null ? '—' : (p > 0 ? '▲ +' : p < 0 ? '▼ ' : '') + p + '%'; }
  money(v: number): string { return (v || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  num(v: number): string { return Math.round(v || 0).toLocaleString('es-MX'); }
}
