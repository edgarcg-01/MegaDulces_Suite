import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { TableModule } from 'primeng/table';
import { SkeletonModule } from 'primeng/skeleton';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SparklineComponent } from '../../../shared/components/charts/sparkline.component';
import {
  VentasGeneralesService, VgKpis, VgBreakdown, VgSeriesPoint, VgMetric, VgDimension,
  METRIC_LABEL, DIMENSION_LABEL, MONEY_METRICS,
} from '../ventas-generales.service';
import { SalesBlock } from './dashboard-spec';

/**
 * Fase VG — renderiza UN bloque del `spec` (kpi / breakdown / series) y se rellena solo
 * llamando al adaptador determinista. Auto-refetch al cambiar el bloque. Cada bloque maneja
 * su propio loading/empty/error → los bloques del tablero cargan en paralelo.
 */
@Component({
  selector: 'app-sales-block',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, RouterModule, TableModule, SkeletonModule, MetricStripComponent, SparklineComponent],
  template: `
    <div class="sb" [class.sb-boxed]="block().type !== 'kpi'">
      @if (block().type !== 'kpi') {
        <header class="sb-head">
          <h3 class="sb-title">{{ title() }}</h3>
          @if (!loading() && total() != null) { <span class="sb-total">Total: <b>{{ fmt(total()!) }}</b></span> }
          @if (deepLink(); as dl) { <a class="sb-deeplink" [routerLink]="dl.route"><i class="pi pi-arrow-up-right" aria-hidden="true"></i> {{ dl.label }}</a> }
        </header>
      }

      @if (loading()) {
        <div class="sb-skel">@for (i of skel; track i) { <p-skeleton height="1.7rem" /> }</div>
      } @else if (err()) {
        <div class="sb-err" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ err() }}</div>
      } @else if (block().type === 'kpi') {
        @if (kpis(); as k) {
          <app-metric-strip [items]="kpiItems(k)" ariaLabel="KPIs de venta de la red" />
          <p class="sb-coverage">Venta real 30d @if (k.coverage != null) { · cobertura de costo {{ k.coverage | number:'1.0-0' }}% } @if (k.updated_at) { · act. {{ k.updated_at | date:'dd/MM HH:mm' }} }</p>
        }
      } @else if (block().type === 'series') {
        @if (series().length) {
          <div class="sb-serie">
            <app-sparkline [data]="seriesValues()" [area]="true" color="var(--action)" [format]="money() ? 'currency' : 'number'" />
            <div class="sb-serie-foot"><span>{{ series()[0].day }}</span><span>{{ series()[series().length - 1].day }}</span></div>
          </div>
        } @else { <div class="sb-empty">Sin serie para el rango.</div> }
      } @else if (bd(); as b) {
        @if (b.rows.length) {
          <div class="sb-grid" [class.sb-grid-1]="viz() !== 'bars-table'">
            @if (viz() !== 'table') {
              <div class="sb-bars">
                @for (r of b.rows.slice(0, 12); track r.label) {
                  <div class="sb-bar-row">
                    <span class="sb-bar-label" [title]="r.label">{{ r.label }}</span>
                    <div class="sb-bar-track"><div class="sb-bar-fill" [style.width.%]="r.share || 0"></div></div>
                    <span class="sb-bar-val">{{ fmt(r.value) }}</span>
                  </div>
                }
              </div>
            }
            @if (viz() !== 'bars') {
              <p-table [value]="b.rows" styleClass="p-datatable-sm surf-table sb-table" [rowHover]="true" [scrollable]="true" scrollHeight="44vh"
                       [paginator]="b.rows.length > 25" [rows]="25">
                <ng-template #header>
                  <tr><th>{{ dimLabel() }}</th><th class="ta-r sb-w">{{ metricLabel() }}</th><th class="ta-r sb-w-sh">Part.</th></tr>
                </ng-template>
                <ng-template #body let-r>
                  <tr>
                    <td class="sb-td-label">{{ r.label }} @if (r.meta) { <span class="sb-faint">· {{ r.meta }}</span> }</td>
                    <td class="ta-r sb-num">{{ fmt(r.value) }}</td>
                    <td class="ta-r sb-num sb-faint">{{ (r.share || 0) | number:'1.1-1' }}%</td>
                  </tr>
                </ng-template>
              </p-table>
            }
          </div>
        } @else { <div class="sb-empty">Sin datos para esta combinación.</div> }
      }
    </div>
  `,
  styles: [`
    :host { display:block; }
    .sb-boxed { border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); padding:.85rem 1rem; height:100%; }
    .sb-head { display:flex; align-items:baseline; gap:1rem; margin-bottom:.7rem; }
    .sb-title { font-size:.95rem; font-weight:700; margin:0; }
    .sb-total { font-size:.82rem; color:var(--text-muted); } .sb-total b { color:var(--text-main); font-family:var(--font-mono); font-variant-numeric:tabular-nums; }
    .sb-deeplink { margin-left:auto; display:inline-flex; align-items:center; gap:.25rem; font-size:.8rem; color:var(--action); text-decoration:none; }
    .sb-deeplink:hover { text-decoration:underline; }
    app-metric-strip { display:block; }
    .sb-coverage { font-size:.74rem; color:var(--text-muted); margin:.3rem 0 0; }
    .sb-faint { color:var(--text-faint); }
    .sb-grid { display:grid; grid-template-columns:1fr 1.2fr; gap:1.2rem; align-items:start; }
    .sb-grid-1 { grid-template-columns:1fr; }
    @media (max-width:900px) { .sb-grid { grid-template-columns:1fr; } }
    .sb-bars { display:flex; flex-direction:column; gap:.5rem; }
    .sb-bar-row { display:grid; grid-template-columns:8rem 1fr auto; align-items:center; gap:.6rem; font-size:.8rem; }
    .sb-bar-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-muted); }
    .sb-bar-track { height:.55rem; background:var(--hover-bg); border-radius:var(--r-pill,999px); overflow:hidden; }
    .sb-bar-fill { height:100%; background:var(--action); border-radius:var(--r-pill,999px); transition:width 600ms cubic-bezier(.2,0,0,1); }
    @media (prefers-reduced-motion: reduce) { .sb-bar-fill { transition:none; } }
    .sb-bar-val { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .sb-table { font-size:.82rem; } .ta-r { text-align:right; } .sb-w { width:9rem; } .sb-w-sh { width:5rem; }
    .sb-num { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .sb-td-label { max-width:22rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .sb-serie app-sparkline { display:block; --spk-h:9rem; }
    .sb-serie-foot { display:flex; justify-content:space-between; font-size:.72rem; color:var(--text-faint); font-family:var(--font-mono); margin-top:.3rem; }
    .sb-skel { display:flex; flex-direction:column; gap:.45rem; padding:.3rem 0; }
    .sb-empty { color:var(--text-faint); padding:1.4rem; text-align:center; font-size:.85rem; }
    .sb-err { display:flex; align-items:center; gap:.5rem; font-size:.82rem; color:var(--bad-fg); padding:.6rem; }
  `],
})
export class SalesBlockComponent {
  private readonly svc = inject(VentasGeneralesService);

  readonly block = input.required<SalesBlock>();

  readonly loading = signal(false);
  readonly err = signal<string | null>(null);
  readonly kpis = signal<VgKpis | null>(null);
  readonly bd = signal<VgBreakdown | null>(null);
  readonly series = signal<VgSeriesPoint[]>([]);
  readonly skel = Array.from({ length: 6 });

  private readonly _metric = computed<VgMetric>(() => this.block().metric ?? 'ventas');
  private readonly _dim = computed<VgDimension>(() => this.block().dimension ?? 'canal');

  readonly title = computed(() => this.block().title ?? `${METRIC_LABEL[this._metric()]} por ${DIMENSION_LABEL[this._dim()]}`);
  readonly metricLabel = computed(() => METRIC_LABEL[this._metric()]);
  readonly dimLabel = computed(() => DIMENSION_LABEL[this._dim()]);
  readonly viz = computed(() => this.block().viz ?? 'bars-table');
  readonly money = computed(() => MONEY_METRICS.includes(this._metric()));
  readonly seriesValues = computed(() => this.series().map((p) => p.value));
  readonly total = computed(() => this.bd()?.total ?? null);

  readonly deepLink = computed<{ route: string; label: string } | null>(() => {
    if (this.block().type !== 'breakdown') return null;
    const d = this._dim();
    if (d === 'canal' || d === 'marca') return { route: '/comercial/sell-out', label: 'Sell-Out' };
    if (d === 'producto') return { route: '/comercial/salidas', label: 'Salidas' };
    if (d === 'cliente') return { route: '/comercial/customers', label: 'Clientes' };
    return null;
  });

  constructor() {
    // Auto-refetch cuando cambia el bloque (el constructor de la página lo reemplaza).
    effect(() => { const b = this.block(); this.load(b); });
  }

  private load(b: SalesBlock): void {
    this.loading.set(true); this.err.set(null);
    // Con rango explícito o filtros → endpoint semántico VG.1 (determinista, filtrable).
    // Sin alcance → endpoints probados (network/*, historical/*) por default.
    const scope = this.svc.hasScope({ from: b.from, to: b.to, filters: b.filters });
    const err = (msg: string) => { this.loading.set(false); this.err.set(msg); };

    if (b.type === 'kpi') {
      if (scope) {
        this.svc.query('ventas', 'canal', { from: b.from, to: b.to, filters: b.filters, limit: 1 }).subscribe({
          next: (r) => {
            const t = r.totals;
            this.kpis.set({
              revenue: t.revenue, margin: t.margin, margin_pct: t.revenue > 0 ? +((t.margin / t.revenue) * 100).toFixed(1) : 0,
              units: t.units, tickets: t.tickets, avg_ticket: t.avg_ticket, unique_customers: 0, coverage: r.coverage_pct, updated_at: null,
            });
            this.loading.set(false);
          },
          error: () => err('No se pudieron cargar los KPIs.'),
        });
      } else {
        this.svc.kpis().subscribe({ next: (k) => { this.kpis.set(k); this.loading.set(false); }, error: () => err('No se pudieron cargar los KPIs.') });
      }
    } else if (b.type === 'series') {
      const f = b.filters;
      const filtered = !!(f && (f.channel || f.warehouse_id || f.brand_id || f.category_id || f.sku || f.brand || f.category));
      const { from, to } = (b.from || b.to) ? { from: b.from, to: b.to } : this.rangeDates(b.range ?? '30d');
      if (filtered) {
        this.svc.query(b.metric ?? 'ventas', 'tiempo', { from, to, filters: b.filters, limit: 400 }).subscribe({
          next: (r) => { this.series.set(r.rows.map((x) => ({ day: x.label, value: x.value }))); this.loading.set(false); },
          error: () => err('No se pudo cargar la serie.'),
        });
      } else {
        this.svc.series(b.metric ?? 'ventas', from, to).subscribe({
          next: (s) => { this.series.set(s); this.loading.set(false); },
          error: () => err('No se pudo cargar la serie.'),
        });
      }
    } else {
      if (scope) {
        this.svc.query(b.metric ?? 'ventas', b.dimension ?? 'canal', { from: b.from, to: b.to, limit: b.limit ?? 20, filters: b.filters }).subscribe({
          next: (r) => { this.bd.set({ rows: r.rows.map((x) => ({ label: x.label, value: x.value, share: x.share })), total: r.total, coverage: r.coverage_pct }); this.loading.set(false); },
          error: () => err('No se pudo cargar el desglose.'),
        });
      } else {
        this.svc.breakdown(b.metric ?? 'ventas', b.dimension ?? 'canal', b.limit ?? 20).subscribe({
          next: (r) => { this.bd.set(r); this.loading.set(false); },
          error: () => err('No se pudo cargar el desglose.'),
        });
      }
    }
  }

  private rangeDates(range: string): { from?: string; to?: string } {
    const to = new Date(); const from = new Date(to);
    if (range === '90d') from.setDate(from.getDate() - 90);
    else if (range === '12m') from.setMonth(from.getMonth() - 12);
    else from.setDate(from.getDate() - 30);
    return { from: this.iso(from), to: this.iso(to) };
  }
  private iso(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  kpiItems(k: VgKpis): MetricStripItem[] {
    const items: MetricStripItem[] = [
      { label: 'Ventas', value: k.revenue, format: 'currency-short', tone: 'brand' },
      { label: 'Margen', value: k.margin, format: 'currency-short', tone: 'ok', sub: `${(k.margin_pct || 0).toFixed(1)}%` },
      { label: 'Unidades', value: k.units, format: 'number', tone: 'default' },
      { label: 'Tickets', value: k.tickets, format: 'number', tone: 'default' },
      { label: 'Ticket prom.', value: k.avg_ticket, format: 'currency', tone: 'default' },
    ];
    // "Clientes" solo cuando hay dato (los KPIs filtrados por VG.1 no lo traen).
    if (k.unique_customers > 0) items.push({ label: 'Clientes', value: k.unique_customers, format: 'number', tone: 'default' });
    return items;
  }

  fmt(v: number): string {
    if (this.money()) return (Number(v) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
    return (Number(v) || 0).toLocaleString('es-MX', { maximumFractionDigits: 0 });
  }
}
