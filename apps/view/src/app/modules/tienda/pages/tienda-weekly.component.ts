import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { SelectButtonModule } from 'primeng/selectbutton';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ChartModule } from 'primeng/chart';
import { AuthService } from '../../../core/services/auth.service';
import { ThemeService } from '../../../core/services/theme.service';
import { branchName } from '../../../core/constants/store-branches';
import { WeeklyService, WeeklyReport } from '../weekly.service';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';

type TrendMetric = 'revenue' | 'units';

/**
 * Proyecto Tienda — Análisis SEMANAL de venta (/tienda/analisis-semanal).
 *
 * Semana ISO (lun–dom). KPIs semana vs anterior (venta $ / margen / unidades +
 * unidades oficiales), tendencia N semanas (gráfica), desglose por sucursal y por
 * producto. Scopeado a la sucursal del usuario (backend fuerza warehouse_code).
 * Superficie Operations, PrimeNG, dark-safe.
 */
@Component({
  selector: 'app-tienda-weekly',
  standalone: true,
  imports: [CommonModule, FormsModule, SelectModule, SelectButtonModule, ButtonModule, TableModule, ChartModule, MetricStripComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in wk-page">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Análisis semanal</h1>
          <p class="surf-page-sub">Venta por semana (lunes a domingo): esta semana vs la anterior, tendencia y desglose por sucursal y producto.</p>
        </div>
        @if (scopedWarehouse) { <span class="wk-scope"><i class="pi pi-map-marker"></i> {{ branchLabel() }}</span> }
      </header>

      <!-- Controles -->
      <div class="wk-controls">
        <label class="wk-ctl">Semana
          <p-select [options]="weekOptions()" optionLabel="label" optionValue="week_start"
                    [ngModel]="weekSel()" (ngModelChange)="onWeek($event)" styleClass="sel-liquid wk-select" appendTo="body"></p-select>
        </label>
        <label class="wk-ctl">Tendencia
          <p-selectButton [options]="weeksOptions" optionLabel="label" optionValue="value" [allowEmpty]="false"
                          [ngModel]="weeksN()" (ngModelChange)="onWeeks($event)" styleClass="sb-liquid" />
        </label>
      </div>

      @if (error()) {
        <div class="wk-banner"><i class="pi pi-exclamation-triangle"></i> No se pudo cargar el análisis.
          <button pButton type="button" label="Reintentar" class="p-button-text p-button-sm" (click)="load()"></button></div>
      }

      @if (rep(); as r) {
        <!-- KPIs semana ref vs anterior -->
        <app-metric-strip [items]="kpiItems(r)" ariaLabel="Resumen semanal" />
        <p class="wk-refnote muted">Semana <strong>{{ r.ref_week.label }}</strong> ({{ r.ref_week.start | date:'dd/MM' }}–{{ weekEnd(r.ref_week.start) | date:'dd/MM' }}) vs {{ r.prev_week.label }}. «Unidades oficiales» cuadra con el reporte mensual; «Unidades» sale del fact de venta.</p>

        <!-- Tendencia -->
        <div class="card-premium card-flat wk-panel">
          <div class="wk-panel-head">
            <h3 class="wk-card-title">Tendencia — últimas {{ r.weeks }} semanas</h3>
            <p-selectButton [options]="metricOptions" optionLabel="label" optionValue="value" [allowEmpty]="false"
                            [ngModel]="metric()" (ngModelChange)="metric.set($event)" styleClass="sb-liquid sb-liquid-sm" />
          </div>
          @if (r.series.length) {
            <div class="wk-chart"><p-chart type="line" [data]="chartData()" [options]="chartOpts()"></p-chart></div>
          } @else {
            <p class="wk-empty">Sin venta registrada en el rango.</p>
          }
        </div>

        <!-- Por sucursal (solo si el usuario ve más de una) -->
        @if (r.by_branch.length > 1) {
          <div class="card-premium card-flat wk-panel">
            <h3 class="wk-card-title">Por sucursal</h3>
            <p-table [value]="r.by_branch" styleClass="p-datatable-sm wk-table" [rowHover]="true">
              <ng-template pTemplate="header"><tr><th>Sucursal</th><th class="ta-r">Venta</th><th class="ta-r">Δ%</th><th class="ta-r">Margen</th><th class="ta-r">Unidades</th><th class="ta-r">Δ%</th></tr></ng-template>
              <ng-template pTemplate="body" let-b>
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

        <!-- Top productos -->
        <div class="card-premium card-flat wk-panel">
          <h3 class="wk-card-title">Top productos de la semana</h3>
          <p-table [value]="r.by_product" styleClass="p-datatable-sm wk-table" [rowHover]="true" [scrollable]="true" scrollHeight="480px">
            <ng-template pTemplate="header"><tr><th>Producto</th><th>Marca</th><th class="ta-r">Venta</th><th class="ta-r">Δ% vs sem. ant.</th><th class="ta-r">Unidades</th></tr></ng-template>
            <ng-template pTemplate="body" let-p>
              <tr>
                <td><span class="wk-prod">{{ p.nombre }}</span><span class="wk-sku">{{ p.sku }}</span></td>
                <td class="muted">{{ p.brand || '—' }}</td>
                <td class="ta-r strong">{{ money(p.revenue) }}</td>
                <td class="ta-r"><span [ngClass]="deltaCls(p.revenue_delta_pct)">{{ deltaTxt(p.revenue_delta_pct) }}</span></td>
                <td class="ta-r">{{ num(p.units) }}</td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage"><tr><td colspan="5" class="wk-empty">Sin venta en la semana seleccionada.</td></tr></ng-template>
          </p-table>
        </div>
      } @else if (!error()) {
        <div class="wk-loading">Cargando análisis…</div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .wk-scope { display: inline-flex; align-items: center; gap: .35rem; font-size: .78rem; font-weight: 600; color: var(--action); margin-left: auto; }
    .wk-controls { display: flex; gap: 1rem; flex-wrap: wrap; align-items: center; margin-bottom: 1rem; }
    .wk-ctl { display: inline-flex; align-items: center; gap: .4rem; font-size: .78rem; color: var(--text-muted); }
    app-metric-strip { display:block; margin-bottom: .5rem; }
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

  readonly rep = signal<WeeklyReport | null>(null);

  kpiItems(r: WeeklyReport): MetricStripItem[] {
    const k = r.kpis;
    return [
      { label: 'Venta', value: k.revenue.cur, format: 'currency', delta: k.revenue.delta_pct },
      { label: 'Margen', value: k.margin.cur, format: 'currency', delta: k.margin.delta_pct },
      { label: 'Unidades', value: k.units.cur, delta: k.units.delta_pct },
      { label: 'Unidades oficiales', value: k.units_official.cur, delta: k.units_official.delta_pct },
    ];
  }
  readonly error = signal(false);
  readonly weeksN = signal(12);
  readonly weekSel = signal<string>('');
  readonly metric = signal<TrendMetric>('revenue');

  readonly weeksOptions = [
    { label: '8', value: 8 }, { label: '12', value: 12 }, { label: '26', value: 26 },
  ];
  readonly metricOptions = [
    { label: 'Venta $', value: 'revenue' as TrendMetric }, { label: 'Unidades', value: 'units' as TrendMetric },
  ];

  readonly weekOptions = computed(() => [...(this.rep()?.series ?? [])].reverse().map((s) => ({ label: s.label, week_start: s.week_start })));

  readonly chartData = computed(() => {
    const r = this.rep(); const m = this.metric();
    this.theme.isMonochrome(); // re-derivar al cambiar de tema
    if (!r) return { labels: [], datasets: [] };
    // Data-viz (§5 exento): color de la serie desde el token de acción para que flipe con el tema.
    const color = this.cssVar('--action', '#F05A28');
    return {
      labels: r.series.map((s) => s.label),
      datasets: [{
        label: m === 'revenue' ? 'Venta $' : 'Unidades',
        data: r.series.map((s) => (m === 'revenue' ? s.revenue : s.units)),
        borderColor: color,
        backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
        tension: 0.3, fill: true, pointRadius: 2, borderWidth: 2,
      }],
    };
  });

  /** Lee un token CSS resuelto (para Chart.js, que no entiende var()). */
  private cssVar(name: string, fallback: string): string {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  readonly chartOpts = computed(() => {
    this.theme.isMonochrome(); // re-derivar al cambiar de tema
    const m = this.metric();
    // Ejes/grid desde tokens resueltos → flipan solos con el tema (sin hex por modo).
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

  ngOnInit() { this.load(); }

  load() {
    this.error.set(false);
    this.svc.weekly({ week: this.weekSel() || undefined, weeks: this.weeksN() })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.rep.set(r); if (!this.weekSel()) this.weekSel.set(r.ref_week.start); },
        error: () => { this.error.set(true); this.rep.set(null); },
      });
  }

  onWeek(ws: string) { this.weekSel.set(ws); this.load(); }
  onWeeks(n: number) { this.weeksN.set(n); this.load(); }

  weekEnd(mondayIso: string): Date { const d = new Date(mondayIso + 'T00:00:00'); d.setDate(d.getDate() + 6); return d; }
  deltaCls(p: number | null): string { return p == null ? 'flat' : p > 0 ? 'up' : p < 0 ? 'down' : 'flat'; }
  deltaTxt(p: number | null): string { return p == null ? '—' : (p > 0 ? '▲ +' : p < 0 ? '▼ ' : '') + p + '%'; }
  money(v: number): string { return (v || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  num(v: number): string { return Math.round(v || 0).toLocaleString('es-MX'); }
}
