import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { ChartModule } from 'primeng/chart';
import { SkeletonModule } from 'primeng/skeleton';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService } from 'primeng/api';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, forkJoin, of } from 'rxjs';
import {
  CommandCenterService,
  HistoricalByZonaRow,
  HistoricalDailyRow,
  HistoricalMarginRow,
  HistoricalRankingRow,
  HistoricalTopProductRow,
} from '../command-center/command-center.service';
import { getChartTokens } from '../../../shared/theme/chart-theme';
import { ThemeService } from '../../../core/services/theme.service';

interface DatePreset { key: string; label: string; days: number; }

const PRESETS: DatePreset[] = [
  { key: '7d',  label: '7 días',   days: 7  },
  { key: '30d', label: '30 días',  days: 30 },
  { key: '90d', label: '90 días',  days: 90 },
];

@Component({
  selector: 'app-historical-analytics',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    ChartModule,
    SkeletonModule,
    SelectModule,
    TableModule,
    ToastModule,
    TooltipModule,
  ],
  providers: [MessageService],
  template: `
    <div class="surf-page ha">
      <p-toast></p-toast>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Ventas históricas — ERP</h1>
          <p class="surf-page-sub">
            <span class="ha-source-pill">
              <i class="pi pi-database" aria-hidden="true"></i>
              Mega_Dulces · live (FDW)
            </span>
            <span class="ha-divider" aria-hidden="true">·</span>
            {{ rangeLabel() }}
            <span *ngIf="zonaFilter()" class="ha-divider" aria-hidden="true">·</span>
            <span *ngIf="zonaFilter()">zona {{ zonaFilter() }}</span>
          </p>
        </div>
        <div class="ha-head-actions">
          <button
            pButton
            icon="pi pi-refresh"
            [text]="true"
            severity="secondary"
            size="small"
            (click)="load()"
            [loading]="loading()"
            pTooltip="Refrescar"
          ></button>
        </div>
      </header>

      <!-- TOOLBAR: presets + zona filter -->
      <div class="sheet cols-12">
        <article class="cell cell-span-12 is-flush ha-filters-cell">
          <div class="ha-toolbar">
            <div class="ha-segment" role="group" aria-label="Rango">
              <button
                *ngFor="let p of presets"
                type="button"
                class="ha-seg-btn"
                [class.active]="preset() === p.key"
                (click)="setPreset(p.key)"
              >{{ p.label }}</button>
            </div>

            <div class="ha-field">
              <p-select
                [options]="zonaOptions()"
                [ngModel]="zonaFilter()"
                (onChange)="setZona($event.value)"
                optionLabel="label"
                optionValue="value"
                [showClear]="true"
                placeholder="Todas las zonas"
                styleClass="ha-zone-select"
                appendTo="body"
              ></p-select>
            </div>

            <div class="ha-toolbar-spacer"></div>
          </div>
        </article>
      </div>

      <!-- KPIs -->
      <p-skeleton *ngIf="loading()" height="120px"></p-skeleton>
      <div *ngIf="!loading()" class="sheet cols-12">
        <article class="cell cell-span-3">
          <span class="cell-icon is-accent" aria-hidden="true"><i class="pi pi-dollar"></i></span>
          <span class="cell-label">Revenue</span>
          <span class="cell-value is-headline">{{ fmtMoneyShort(totals().revenue) }}</span>
          <span class="cell-sub">{{ fmtNumber(totals().lines) }} líneas</span>
        </article>
        <article class="cell cell-span-3">
          <span class="cell-icon is-info" aria-hidden="true"><i class="pi pi-box"></i></span>
          <span class="cell-label">Unidades</span>
          <span class="cell-value">{{ fmtNumber(totals().units, 0) }}</span>
          <span class="cell-sub">Vendidas en período</span>
        </article>
        <article class="cell cell-span-3">
          <span class="cell-icon is-ok" aria-hidden="true"><i class="pi pi-chart-line"></i></span>
          <span class="cell-label">Margen</span>
          <span class="cell-value">{{ fmtMoneyShort(totals().margin) }}</span>
          <span class="cell-sub">{{ fmtNumber(marginPct(), 1) }}% sobre revenue</span>
        </article>
        <article class="cell cell-span-3">
          <span class="cell-icon" aria-hidden="true"><i class="pi pi-users"></i></span>
          <span class="cell-label">Tickets</span>
          <span class="cell-value">{{ fmtNumber(zonaTotals().tickets) }}</span>
          <span class="cell-sub">{{ fmtNumber(zonaTotals().unique_customers) }} clientes únicos</span>
        </article>
      </div>

      <!-- Daily chart -->
      <div *ngIf="!loading() && daily().length > 0" class="sheet cols-12">
        <article class="cell cell-span-12 is-flush">
          <div class="cell-head">
            <span class="cell-label">Revenue diario</span>
            <span class="comm-muted is-small">{{ daily().length }} días con ventas</span>
          </div>
          <div class="ha-chart-wrap">
            <p-chart type="bar" [data]="chartData()" [options]="chartOptions()" height="280px"></p-chart>
          </div>
        </article>
      </div>

      <!-- Top productos + by zona -->
      <div *ngIf="!loading()" class="sheet cols-12">
        <article class="cell cell-span-6 is-flush">
          <div class="cell-head ha-top-head">
            <span class="cell-label">Top productos · revenue</span>
            <div class="ha-source-toggle" role="tablist" aria-label="Fuente del ranking">
              <button
                type="button"
                class="ha-toggle-btn"
                [class.active]="topSource() === 'period'"
                role="tab"
                [attr.aria-selected]="topSource() === 'period'"
                (click)="topSource.set('period')"
                pTooltip="Ventas calculadas en el rango seleccionado"
                tooltipPosition="top"
              >Período</button>
              <button
                type="button"
                class="ha-toggle-btn"
                [class.active]="topSource() === 'erp'"
                role="tab"
                [attr.aria-selected]="topSource() === 'erp'"
                (click)="topSource.set('erp')"
                pTooltip="Ranking pre-calculado por el ERP (ventana propia)"
                tooltipPosition="top"
              >ERP all-time</button>
            </div>
          </div>
          <div class="data-table-wrap" *ngIf="topSource() === 'period'">
            <table class="data-table">
              <thead>
                <tr>
                  <th style="width:36px">#</th>
                  <th>Producto</th>
                  <th class="num">Units</th>
                  <th class="num">Revenue</th>
                </tr>
              </thead>
              <tbody>
                <tr *ngFor="let p of topProducts(); let i = index">
                  <td><span class="cc-rank-badge">{{ i + 1 }}</span></td>
                  <td>
                    <div class="strong">{{ p.producto }}</div>
                    <div class="muted small">{{ p.subfamilia || '—' }}</div>
                  </td>
                  <td class="num">{{ fmtNumber(p.units, 0) }}</td>
                  <td class="num strong">{{ fmtMoney(p.revenue) }}</td>
                </tr>
                <tr *ngIf="topProducts().length === 0">
                  <td colspan="4" class="cc-table-empty">
                    <i class="pi pi-box"></i>Sin ventas en el período
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="data-table-wrap" *ngIf="topSource() === 'erp'">
            <table class="data-table">
              <thead>
                <tr>
                  <th style="width:36px">#</th>
                  <th>Producto</th>
                  <th class="num">Cajas</th>
                  <th class="num">Piezas</th>
                  <th class="num">Revenue</th>
                </tr>
              </thead>
              <tbody>
                <tr *ngFor="let p of rankingErp()">
                  <td><span class="cc-rank-badge">{{ p.posicion }}</span></td>
                  <td>
                    <div class="strong">{{ p.nombre }}</div>
                    <div class="muted small"><code class="comm-code">{{ p.articulo }}</code></div>
                  </td>
                  <td class="num">{{ fmtNumber(p.total_cajas, 0) }}</td>
                  <td class="num">{{ fmtNumber(p.total_piezas_totales, 0) }}</td>
                  <td class="num strong">{{ fmtMoney(p.total_venta) }}</td>
                </tr>
                <tr *ngIf="rankingErp().length === 0">
                  <td colspan="5" class="cc-table-empty">
                    <i class="pi pi-database"></i>Ranking ERP no disponible
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </article>

        <article class="cell cell-span-6 is-flush">
          <div class="cell-head">
            <span class="cell-label">Por zona / sucursal</span>
            <span class="comm-muted is-small">{{ byZona().length }}</span>
          </div>
          <div class="data-table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Sucursal</th>
                  <th class="num">Tickets</th>
                  <th class="num">Clientes</th>
                  <th class="num">Revenue</th>
                </tr>
              </thead>
              <tbody>
                <tr *ngFor="let z of byZona()">
                  <td>
                    <div class="strong">{{ z.almacen }}</div>
                    <div class="muted small">{{ z.zona }}</div>
                  </td>
                  <td class="num">{{ fmtNumber(z.tickets) }}</td>
                  <td class="num">{{ fmtNumber(z.unique_customers) }}</td>
                  <td class="num strong">{{ fmtMoney(z.revenue) }}</td>
                </tr>
                <tr *ngIf="byZona().length === 0">
                  <td colspan="4" class="cc-table-empty">
                    <i class="pi pi-map-marker"></i>Sin data por zona
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </article>
      </div>

      <!-- Margen por categoría — joinea ventas (FDW) ↔ products.cost_base -->
      <div *ngIf="!loading()" class="sheet cols-12">
        <article class="cell cell-span-12 is-flush">
          <div class="cell-head ha-margin-head">
            <span class="cell-label">Margen por categoría</span>
            <div class="ha-margin-summary" *ngIf="marginByCat().length > 0">
              <span class="ha-margin-mini">
                <span class="comm-muted is-small">Revenue total</span>
                <strong>{{ fmtMoneyShort(marginTotals().revenue) }}</strong>
              </span>
              <span class="ha-margin-mini">
                <span class="comm-muted is-small">Costo</span>
                <strong>{{ fmtMoneyShort(marginTotals().cost) }}</strong>
              </span>
              <span class="ha-margin-mini">
                <span class="comm-muted is-small">Margen</span>
                <strong [class]="marginClass(marginTotals().margin_pct)">
                  {{ fmtMoneyShort(marginTotals().margin) }}
                  <span class="ha-margin-pct">({{ fmtNumber(marginTotals().margin_pct, 1) }}%)</span>
                </strong>
              </span>
            </div>
          </div>
          <div class="data-table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Categoría</th>
                  <th class="num">SKUs</th>
                  <th class="num">Unidades</th>
                  <th class="num">Revenue</th>
                  <th class="num">Costo</th>
                  <th class="num">Margen $</th>
                  <th class="num">Margen %</th>
                </tr>
              </thead>
              <tbody>
                <tr *ngFor="let m of marginByCat()">
                  <td><div class="strong">{{ m.category }}</div></td>
                  <td class="num">{{ fmtNumber(m.products) }}</td>
                  <td class="num">{{ fmtNumber(m.units, 0) }}</td>
                  <td class="num strong">{{ fmtMoney(m.revenue) }}</td>
                  <td class="num">{{ fmtMoney(m.cost) }}</td>
                  <td class="num strong" [class]="marginClass(m.margin_pct)">{{ fmtMoney(m.margin) }}</td>
                  <td class="num" [class]="marginClass(m.margin_pct)">
                    <span *ngIf="m.margin_pct != null">{{ fmtNumber(m.margin_pct, 1) }}%</span>
                    <span *ngIf="m.margin_pct == null" class="comm-muted">—</span>
                  </td>
                </tr>
                <tr *ngIf="marginByCat().length === 0">
                  <td colspan="7" class="cc-table-empty">
                    <i class="pi pi-percentage"></i>Sin data de margen en el período
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </article>
      </div>
    </div>
  `,
  styles: [`
    :host { display:block; }

    .ha-source-pill {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.2rem 0.55rem;
      border-radius: 999px;
      background: var(--c-surface-2);
      color: var(--c-text-2);
      font-size: var(--fs-micro);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-weight: var(--fw-bold);
    }
    .ha-source-pill i { font-size: 0.7rem; }
    .ha-divider { opacity: 0.4; }

    .ha-head-actions { display:flex; gap:.5rem; align-items:center; }

    .ha-filters-cell { display:flex; flex-direction:column; }
    .ha-toolbar {
      display:flex; align-items:center; gap:.5rem;
      padding:.625rem .875rem;
      flex-wrap:wrap;
    }
    .ha-toolbar-spacer { flex:1; min-width:0; }

    .ha-segment {
      display:inline-flex; align-items:stretch;
      height:32px;
      background:var(--c-surface-2);
      border:1px solid var(--c-divider);
      border-radius:8px;
      padding:2px; gap:2px;
    }
    .ha-seg-btn {
      background:transparent; border:none;
      padding:0 .65rem;
      font-size:var(--fs-xs); font-weight:var(--fw-medium);
      color:var(--c-text-2);
      cursor:pointer; border-radius:6px;
      transition:all 100ms var(--ease-standard);
      white-space:nowrap;
    }
    .ha-seg-btn:hover { color:var(--c-text-1); }
    .ha-seg-btn.active {
      background:var(--c-surface-1);
      color:var(--c-text-1);
      box-shadow:0 1px 2px rgba(0,0,0,.08);
      font-weight:var(--fw-bold);
    }

    .ha-field { display:inline-flex; align-items:center; }
    :host ::ng-deep .ha-zone-select { min-width: 220px; }

    .ha-chart-wrap {
      padding: 1rem 1.25rem 1.25rem;
    }

    .cc-rank-badge {
      display: inline-grid;
      place-items: center;
      width: 22px; height: 22px;
      border-radius: 50%;
      background: var(--c-surface-2);
      color: var(--c-text-2);
      font-size: var(--fs-nano);
      font-weight: var(--fw-bold);
      font-variant-numeric: tabular-nums;
    }

    /* ── Margen por categoría: header + summary inline ── */
    .ha-margin-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      flex-wrap: wrap;
    }
    .ha-margin-summary {
      display: inline-flex;
      gap: 1.25rem;
      align-items: center;
    }
    .ha-margin-mini {
      display: inline-flex;
      flex-direction: column;
      gap: 0.1rem;
      font-variant-numeric: tabular-nums;
    }
    .ha-margin-mini strong { font-weight: var(--fw-bold); color: var(--c-text-1); }
    .ha-margin-pct { font-weight: var(--fw-medium); font-size: var(--fs-sm); margin-left: 0.25rem; }

    .is-margin-good { color: var(--c-ok) !important; }
    .is-margin-warn { color: var(--c-warn) !important; }
    .is-margin-bad  { color: var(--c-bad)  !important; font-weight: var(--fw-bold); }

    /* ── Top source toggle (Período vs ERP) ── */
    .ha-top-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
    }
    .ha-source-toggle {
      display: inline-flex;
      align-items: stretch;
      height: 28px;
      background: var(--c-surface-2);
      border: 1px solid var(--c-divider);
      border-radius: 7px;
      padding: 2px;
      gap: 2px;
    }
    .ha-toggle-btn {
      background: transparent;
      border: none;
      padding: 0 0.65rem;
      font-size: var(--fs-nano);
      font-weight: var(--fw-medium);
      color: var(--c-text-2);
      cursor: pointer;
      border-radius: 5px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      transition: all 100ms var(--ease-standard);
      white-space: nowrap;
    }
    .ha-toggle-btn:hover { color: var(--c-text-1); }
    .ha-toggle-btn.active {
      background: var(--c-surface-1);
      color: var(--c-text-1);
      box-shadow: 0 1px 2px rgba(0,0,0,.08);
      font-weight: var(--fw-bold);
    }

    .cc-table-empty {
      text-align: center !important;
      color: var(--c-text-2) !important;
      padding: 2rem 1rem !important;
      display: flex !important;
      align-items: center; justify-content: center;
      gap: 0.45rem;
      font-size: var(--fs-sm);
      border-bottom: none !important;
    }
    .cc-table-empty i { font-size: 1rem; opacity: 0.6; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HistoricalAnalyticsComponent {
  private readonly api = inject(CommandCenterService);
  private readonly toast = inject(MessageService);
  private readonly theme = inject(ThemeService);
  private readonly destroyRef = inject(DestroyRef);

  readonly loading = signal(true);
  readonly preset = signal<string>('30d');
  readonly zonaFilter = signal<string | null>(null);

  readonly daily = signal<HistoricalDailyRow[]>([]);
  readonly topProducts = signal<HistoricalTopProductRow[]>([]);
  readonly byZona = signal<HistoricalByZonaRow[]>([]);
  readonly rankingErp = signal<HistoricalRankingRow[]>([]);
  readonly marginByCat = signal<HistoricalMarginRow[]>([]);

  readonly marginTotals = computed(() => {
    const list = this.marginByCat();
    const revenue = list.reduce((s, r) => s + (r.revenue || 0), 0);
    const cost = list.reduce((s, r) => s + (r.cost || 0), 0);
    return {
      revenue,
      cost,
      margin: revenue - cost,
      margin_pct: revenue > 0 ? ((revenue - cost) / revenue) * 100 : 0,
    };
  });

  /** 'period' = top calculado de ventas en el rango actual.
   *  'erp' = top pre-calculado por el ERP (ranking_productos) — usualmente all-time. */
  readonly topSource = signal<'period' | 'erp'>('period');

  readonly presets = PRESETS;

  /** Opciones del select de zona, derivadas del último by-zona load. */
  readonly zonaOptions = computed(() => {
    const seen = new Set<string>();
    const opts: { label: string; value: string }[] = [];
    for (const z of this.byZona()) {
      if (z.zona && !seen.has(z.zona)) {
        seen.add(z.zona);
        opts.push({ label: z.zona, value: z.zona });
      }
    }
    return opts.sort((a, b) => a.label.localeCompare(b.label, 'es'));
  });

  readonly totals = computed(() => {
    const list = this.daily();
    return {
      revenue: list.reduce((s, r) => s + (r.revenue || 0), 0),
      units: list.reduce((s, r) => s + (r.units || 0), 0),
      cost: list.reduce((s, r) => s + (r.cost || 0), 0),
      margin: list.reduce((s, r) => s + (r.margin || 0), 0),
      lines: list.reduce((s, r) => s + (r.lines || 0), 0),
    };
  });

  readonly marginPct = computed(() => {
    const t = this.totals();
    if (!t.revenue) return 0;
    return (t.margin / t.revenue) * 100;
  });

  readonly zonaTotals = computed(() => {
    const list = this.byZona();
    return {
      tickets: list.reduce((s, r) => s + (r.tickets || 0), 0),
      unique_customers: list.reduce((s, r) => s + (r.unique_customers || 0), 0),
    };
  });

  readonly rangeLabel = computed(() => {
    const p = this.presets.find((x) => x.key === this.preset());
    return p ? `Últimos ${p.label}` : '—';
  });

  readonly chartData = computed(() => {
    const tk = getChartTokens();
    const labels = this.daily().map((r) => this.shortDay(r.day));
    return {
      labels,
      datasets: [
        {
          label: 'Revenue MXN',
          data: this.daily().map((r) => r.revenue),
          backgroundColor: tk.brand400 + 'CC',
          borderColor: tk.brand700,
          borderWidth: 1,
          borderRadius: 4,
        },
      ],
    };
  });

  readonly chartOptions = computed(() => {
    const tk = getChartTokens();
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx: any) => 'Revenue: ' + new Intl.NumberFormat('es-MX', {
              style: 'currency', currency: 'MXN', maximumFractionDigits: 0,
            }).format(ctx.parsed.y),
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: tk.chartAxis } },
        y: {
          grid: { color: tk.chartGrid },
          ticks: {
            color: tk.chartAxis,
            callback: (v: any) => '$' + (v >= 1e6 ? (v/1e6).toFixed(1)+'M' : v >= 1e3 ? (v/1e3).toFixed(0)+'K' : v),
          },
        },
      },
    };
  });

  constructor() {
    // Load inicial. Reactividad por filter cambia disparada manualmente desde
    // los setters — NO usar effect() acá porque load() escribe signals
    // (loading, daily, etc.) y effect() lo prohíbe por default (NG0600).
    this.load();
  }

  setPreset(key: string): void {
    if (this.preset() === key) return;
    this.preset.set(key);
    this.load();
  }

  setZona(value: string | null): void {
    const next = value || null;
    if (this.zonaFilter() === next) return;
    this.zonaFilter.set(next);
    this.load();
  }

  load(): void {
    this.loading.set(true);
    const { from, to } = this.dateRange();
    const zona = this.zonaFilter() || undefined;

    forkJoin({
      daily: this.api.historicalDaily({ from, to, zona }).pipe(catchError(() => of([]))),
      top: this.api.historicalTopProducts({ from, to, zona, limit: 20 }).pipe(catchError(() => of([]))),
      // by-zona NO filtra por zona — siempre traemos el desglose completo para el select.
      zonas: this.api.historicalByZona(from, to).pipe(catchError(() => of([]))),
      // Ranking ERP no depende del rango — pero lo cargamos en paralelo para
      // que el toggle 'period'/'erp' sea instantáneo (sin re-fetch).
      ranking: this.api.historicalRanking(20).pipe(catchError(() => of([]))),
      // Margen por categoría: depende del rango (recalcula en cada load).
      margin: this.api.historicalMarginByCategory({ from, to, limit: 15 })
        .pipe(catchError(() => of([]))),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ daily, top, zonas, ranking, margin }) => {
          this.daily.set(daily);
          this.topProducts.set(top);
          this.byZona.set(zonas);
          this.rankingErp.set(ranking);
          this.marginByCat.set(margin);
          this.loading.set(false);
        },
        error: (err) => {
          this.loading.set(false);
          this.toast.add({
            severity: 'error',
            summary: 'Error cargando ventas históricas',
            detail: err?.message || 'No se pudo conectar al ERP via FDW',
          });
        },
      });
  }

  private dateRange(): { from: string; to: string } {
    const p = this.presets.find((x) => x.key === this.preset()) || this.presets[1];
    const today = new Date();
    const from = new Date(today.getTime() - (p.days - 1) * 86400_000);
    return {
      from: from.toISOString().slice(0, 10),
      to: today.toISOString().slice(0, 10),
    };
  }

  private shortDay(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
  }

  fmtMoney(n: number | null | undefined): string {
    if (n === null || n === undefined) return '—';
    return new Intl.NumberFormat('es-MX', {
      style: 'currency', currency: 'MXN', maximumFractionDigits: 2,
    }).format(Number(n));
  }

  fmtMoneyShort(n: number | null | undefined): string {
    if (n === null || n === undefined) return '—';
    const v = Number(n);
    if (Math.abs(v) >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
    if (Math.abs(v) >= 1e3) return '$' + (v / 1e3).toFixed(2) + 'K';
    return '$' + v.toFixed(0);
  }

  fmtNumber(n: number | null | undefined, decimals = 0): string {
    if (n === null || n === undefined) return '—';
    return new Intl.NumberFormat('es-MX', {
      minimumFractionDigits: decimals, maximumFractionDigits: decimals,
    }).format(Number(n));
  }

  /**
   * Clase CSS para colorear margen %:
   *   ≥20% → good (verde)
   *   5-20% → warn (amarillo)
   *   <5% o negativo → bad (rojo)
   *   null → muted
   */
  marginClass(pct: number | null | undefined): string {
    if (pct == null) return '';
    if (pct >= 20) return 'is-margin-good';
    if (pct >= 5) return 'is-margin-warn';
    return 'is-margin-bad';
  }
}
