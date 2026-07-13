import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { ChartModule } from 'primeng/chart';
import { AuthService } from '../../../core/services/auth.service';
import { ThemeService } from '../../../core/services/theme.service';
import { branchName } from '../../../core/constants/store-branches';
import { WeeklyService, WeeklyReport } from '../weekly.service';

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
  imports: [CommonModule, FormsModule, SelectModule, TableModule, ChartModule],
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
                    [ngModel]="weekSel()" (ngModelChange)="onWeek($event)" styleClass="wk-select" appendTo="body"></p-select>
        </label>
        <div class="wk-seg">
          <span class="wk-seg-lbl">Tendencia</span>
          @for (n of [8, 12, 26]; track n) {
            <button [class.active]="weeksN() === n" (click)="onWeeks(n)">{{ n }}</button>
          }
        </div>
      </div>

      @if (error()) {
        <div class="wk-banner"><i class="pi pi-exclamation-triangle"></i> No se pudo cargar el análisis. <button (click)="load()">Reintentar</button></div>
      }

      @if (rep(); as r) {
        <!-- KPIs semana ref vs anterior -->
        <div class="wk-kpis">
          <div class="wk-kpi">
            <span class="wk-kpi-lbl">Venta</span>
            <span class="wk-kpi-val">{{ money(r.kpis.revenue.cur) }}</span>
            <span class="wk-delta" [ngClass]="deltaCls(r.kpis.revenue.delta_pct)">{{ deltaTxt(r.kpis.revenue.delta_pct) }}</span>
          </div>
          <div class="wk-kpi">
            <span class="wk-kpi-lbl">Margen</span>
            <span class="wk-kpi-val">{{ money(r.kpis.margin.cur) }}</span>
            <span class="wk-delta" [ngClass]="deltaCls(r.kpis.margin.delta_pct)">{{ deltaTxt(r.kpis.margin.delta_pct) }}</span>
          </div>
          <div class="wk-kpi">
            <span class="wk-kpi-lbl">Unidades</span>
            <span class="wk-kpi-val">{{ num(r.kpis.units.cur) }}</span>
            <span class="wk-delta" [ngClass]="deltaCls(r.kpis.units.delta_pct)">{{ deltaTxt(r.kpis.units.delta_pct) }}</span>
          </div>
          <div class="wk-kpi">
            <span class="wk-kpi-lbl">Unidades oficiales</span>
            <span class="wk-kpi-val">{{ num(r.kpis.units_official.cur) }}</span>
            <span class="wk-delta" [ngClass]="deltaCls(r.kpis.units_official.delta_pct)">{{ deltaTxt(r.kpis.units_official.delta_pct) }}</span>
          </div>
        </div>
        <p class="wk-refnote muted">Semana <strong>{{ r.ref_week.label }}</strong> ({{ r.ref_week.start | date:'dd/MM' }}–{{ weekEnd(r.ref_week.start) | date:'dd/MM' }}) vs {{ r.prev_week.label }}. «Unidades oficiales» cuadra con el reporte mensual; «Unidades» sale del fact de venta.</p>

        <!-- Tendencia -->
        <div class="card-premium card-flat wk-panel">
          <div class="wk-panel-head">
            <h3 class="wk-card-title">Tendencia — últimas {{ r.weeks }} semanas</h3>
            <div class="wk-seg wk-seg-sm">
              <button [class.active]="metric() === 'revenue'" (click)="metric.set('revenue')">Venta $</button>
              <button [class.active]="metric() === 'units'" (click)="metric.set('units')">Unidades</button>
            </div>
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
    .wk-scope { display: inline-flex; align-items: center; gap: .35rem; font-size: .78rem; font-weight: 600; color: var(--action, #F05A28); margin-left: auto; }
    .wk-controls { display: flex; gap: 1rem; flex-wrap: wrap; align-items: center; margin-bottom: 1rem; }
    .wk-ctl { display: inline-flex; align-items: center; gap: .4rem; font-size: .78rem; color: var(--text-muted, #57534e); }
    .wk-seg { display: inline-flex; align-items: center; border: 1px solid var(--border-color, #e7e5e4); border-radius: var(--r-pill, 999px); overflow: hidden; }
    .wk-seg-lbl { font-size: .72rem; color: var(--text-muted, #78716c); padding: 0 .5rem 0 .7rem; }
    .wk-seg button { border: none; background: var(--card-bg, #fff); padding: .3rem .8rem; font-size: .78rem; cursor: pointer; color: var(--text-muted, #57534e); }
    .wk-seg button.active { background: var(--action, #F05A28); color: var(--action-ink, #fff); font-weight: 600; }
    .wk-seg-sm button { padding: .25rem .65rem; font-size: .74rem; }
    .wk-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: .75rem; margin-bottom: .5rem; }
    .wk-kpi { border: 1px solid var(--border-color, #e7e5e4); border-radius: var(--r-md, 10px); padding: .75rem .9rem; background: var(--card-bg, #fff); display: flex; flex-direction: column; gap: .15rem; }
    .wk-kpi-lbl { font-size: .66rem; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted, #78716c); }
    .wk-kpi-val { font-size: 1.3rem; font-weight: 800; font-variant-numeric: tabular-nums; }
    .wk-delta { font-size: .74rem; font-weight: 600; font-variant-numeric: tabular-nums; }
    .wk-delta.up { color: var(--ok-fg, #16a34a); } .wk-delta.down { color: var(--bad-fg, #dc2626); } .wk-delta.flat { color: var(--text-faint, #a8a29e); }
    .wk-refnote { font-size: .72rem; margin: 0 0 1rem; }
    .wk-panel { padding: 1rem; margin-bottom: 1rem; }
    .wk-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: .7rem; }
    .wk-card-title { margin: 0; font-size: .85rem; font-weight: 700; }
    .wk-chart { height: 280px; }
    .wk-table { font-variant-numeric: tabular-nums; }
    .wk-prod { display: block; font-weight: 500; } .wk-sku { display: block; font-size: .7rem; color: var(--text-muted, #78716c); font-family: var(--font-mono, ui-monospace, monospace); }
    .wk-banner { display: flex; align-items: center; gap: .5rem; background: color-mix(in srgb, var(--bad-fg, #dc2626) 8%, transparent); border: 1px solid color-mix(in srgb, var(--bad-fg, #dc2626) 30%, transparent); border-radius: var(--r-md, 10px); padding: .7rem .9rem; font-size: .82rem; margin-bottom: 1rem; }
    .wk-banner button { background: none; border: none; color: var(--action, #F05A28); font-weight: 600; cursor: pointer; }
    .wk-loading, .wk-empty { padding: 2rem; text-align: center; color: var(--text-muted, #78716c); font-size: .85rem; }
    .ta-r { text-align: right; } .strong { font-weight: 700; } .muted { color: var(--text-muted, #78716c); }
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
  readonly error = signal(false);
  readonly weeksN = signal(12);
  readonly weekSel = signal<string>('');
  readonly metric = signal<TrendMetric>('revenue');

  readonly weekOptions = computed(() => [...(this.rep()?.series ?? [])].reverse().map((s) => ({ label: s.label, week_start: s.week_start })));

  readonly chartData = computed(() => {
    const r = this.rep(); const m = this.metric();
    if (!r) return { labels: [], datasets: [] };
    const color = '#F05A28';
    return {
      labels: r.series.map((s) => s.label),
      datasets: [{
        label: m === 'revenue' ? 'Venta $' : 'Unidades',
        data: r.series.map((s) => (m === 'revenue' ? s.revenue : s.units)),
        borderColor: color,
        backgroundColor: 'rgba(240,90,40,.12)',
        tension: 0.3, fill: true, pointRadius: 2, borderWidth: 2,
      }],
    };
  });

  readonly chartOpts = computed(() => {
    const dark = this.theme.isMonochrome();
    const m = this.metric();
    const axis = dark ? '#B0A595' : '#57534E';
    const grid = dark ? 'rgba(255,255,255,.09)' : 'rgba(0,0,0,.08)';
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
