import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { SkeletonModule } from 'primeng/skeleton';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService } from 'primeng/api';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';

import {
  CommandCenterService,
  OverviewResponse,
  TopCustomerRow,
  TopProductRow,
  SalesByBrandRow,
  LowStockResponse,
  InactiveCustomersResponse,
  DailySeriesRow,
  RankingOutOfStockRow,
  ConversionSummary,
} from './command-center.service';

@Component({
  selector: 'app-command-center',
  standalone: true,
  imports: [
    CommonModule,
    ButtonModule,
    SkeletonModule,
    ToastModule,
    TooltipModule,
  ],
  providers: [MessageService],
  templateUrl: './command-center.component.html',
  styleUrls: ['./command-center.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CommandCenterComponent implements OnInit {
  private readonly api = inject(CommandCenterService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  // Signals para reactividad
  readonly loading = signal(true);
  readonly refreshing = signal(false);
  readonly overview = signal<OverviewResponse | null>(null);
  readonly topCustomers = signal<TopCustomerRow[]>([]);
  readonly topProducts = signal<TopProductRow[]>([]);
  readonly salesByBrand = signal<SalesByBrandRow[]>([]);
  readonly lowStock = signal<LowStockResponse | null>(null);
  readonly inactiveCustomers = signal<InactiveCustomersResponse | null>(null);
  readonly dailySeries = signal<DailySeriesRow[]>([]);
  readonly rankingOOS = signal<RankingOutOfStockRow[]>([]);
  readonly conversion = signal<ConversionSummary | null>(null);
  readonly dueCount = signal<number | null>(null);

  readonly revenueSpark = computed(() => {
    const series = this.dailySeries();
    if (series.length < 2) return null;
    const W = 280;
    const H = 64;
    const padX = 4;
    const padY = 6;
    const values = series.map((d) => d.revenue);
    const max = Math.max(...values, 1);
    const min = Math.min(...values, 0);
    const range = max - min || 1;
    const n = series.length;
    const stepX = (W - 2 * padX) / Math.max(n - 1, 1);
    const points = series.map((d, i) => {
      const x = padX + i * stepX;
      const y = padY + (H - 2 * padY) * (1 - (d.revenue - min) / range);
      return { x, y, v: d.revenue, day: d.day };
    });
    const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const area = `${line} L${points[points.length - 1].x.toFixed(1)},${H - padY} L${points[0].x.toFixed(1)},${H - padY} Z`;
    return { W, H, line, area, points, last: points[points.length - 1] };
  });

  readonly revenueDelta = computed(() => {
    const series = this.dailySeries();
    if (series.length < 4) return null;
    const mid = Math.floor(series.length / 2);
    const first = series.slice(0, mid).reduce((s, d) => s + d.revenue, 0);
    const second = series.slice(mid).reduce((s, d) => s + d.revenue, 0);
    if (first === 0) return null;
    const pct = ((second - first) / first) * 100;
    return { pct, direction: pct >= 0 ? 'up' : 'down' as 'up' | 'down' };
  });

  ngOnInit(): void {
    this.loadAll();
  }

  loadAll(): void {
    this.loading.set(true);
    const today = new Date();
    const from = new Date(today.getTime() - 29 * 86400_000);
    const fromIso = from.toISOString().slice(0, 10);
    const toIso = today.toISOString().slice(0, 10);

    forkJoin({
      ov: this.api.overview(),
      tc: this.api.topCustomers(5),
      tp: this.api.topProducts(5, 'revenue'),
      sbb: this.api.salesByBrand(),
      ls: this.api.lowStock(200),
      ic: this.api.inactiveCustomers(30, 5),
      ds: this.api.dailySeries(fromIso, toIso),
      // ranking-out-of-stock: FDW a Mega_Dulces. catchError para no romper
      // el dashboard entero si la conexión al ERP está caída.
      oos: this.api.rankingOutOfStock(10, 200).pipe(catchError(() => of([] as RankingOutOfStockRow[]))),
      // Motor de Inteligencia (Fase M): best-effort — si no está disponible, no rompe el dashboard.
      conv: this.api.conversionSummary(30).pipe(catchError(() => of(null))),
      due: this.api.nbaDue(100).pipe(catchError(() => of([] as Array<{ customer_id: string }>))),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ ov, tc, tp, sbb, ls, ic, ds, oos, conv, due }) => {
          this.overview.set(ov);
          this.topCustomers.set(tc);
          this.topProducts.set(tp);
          this.salesByBrand.set(sbb);
          this.lowStock.set(ls);
          this.inactiveCustomers.set(ic);
          this.dailySeries.set(ds);
          this.rankingOOS.set(oos);
          this.conversion.set(conv);
          this.dueCount.set(conv ? due.length : null);
          this.loading.set(false);
        },
        error: (err) => {
          this.loading.set(false);
          this.toast.add({
            severity: 'error',
            summary: 'Error cargando Command Center',
            detail: err.message || 'No se pudo conectar al backend',
          });
        },
      });
  }

  refreshMvs(): void {
    this.refreshing.set(true);
    this.api
      .refresh()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          const totalMs = r.results.reduce((s, x) => s + (x.ms || 0), 0);
          this.toast.add({
            severity: 'success',
            summary: 'MVs refrescadas',
            detail: `${r.results.length} vistas en ${totalMs}ms`,
          });
          this.refreshing.set(false);
          this.loadAll();
        },
        error: (err) => {
          this.refreshing.set(false);
          this.toast.add({
            severity: 'error',
            summary: 'Refresh falló',
            detail: err.message,
          });
        },
      });
  }

  /** Formato MXN con separadores de miles. */
  fmtMoney(n: number | undefined | null): string {
    if (n === null || n === undefined) return '—';
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: 'MXN',
      maximumFractionDigits: 2,
    }).format(Number(n));
  }

  /** Formato MXN compact ($706.42K, $5.76M) para headlines tipográficos. */
  fmtMoneyShort(n: number | undefined | null): string {
    if (n === null || n === undefined) return '—';
    const v = Number(n);
    if (Math.abs(v) >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
    if (Math.abs(v) >= 1e3) return '$' + (v / 1e3).toFixed(2) + 'K';
    return '$' + v.toFixed(0);
  }

  fmtNumber(n: number | undefined | null, decimals = 0): string {
    if (n === null || n === undefined) return '—';
    return new Intl.NumberFormat('es-MX', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(Number(n));
  }

  fmtDate(s: string | null | undefined): string {
    if (!s) return '—';
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    return d.toLocaleDateString('es-MX', { year: 'numeric', month: 'short', day: '2-digit' });
  }

  /** Severity para color del tag low-stock. */
  stockSeverity(qty: number): 'danger' | 'warn' | 'success' {
    if (qty < 50) return 'danger';
    if (qty < 200) return 'warn';
    return 'success';
  }

  /** Clase de comm-pill según disponibilidad. */
  stockPillClass(qty: number): string {
    if (qty < 50) return 'is-bad';
    if (qty < 200) return 'is-warn';
    return 'is-active';
  }

  daysSeverityClass(days: number | null): string {
    if (days === null) return 'is-bad';
    if (days > 90) return 'is-bad';
    if (days > 60) return 'is-warn';
    if (days > 30) return 'is-info';
    return '';
  }

  topShareCustomer(rev: number): number {
    const total = this.topCustomers().reduce((s, r) => s + Number(r.revenue || 0), 0);
    if (total <= 0) return 0;
    return (Number(rev || 0) / total) * 100;
  }

  topShareProduct(rev: number): number {
    const total = this.topProducts().reduce((s, r) => s + Number(r.revenue || 0), 0);
    if (total <= 0) return 0;
    return (Number(rev || 0) / total) * 100;
  }
}
