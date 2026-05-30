import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnDestroy,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { SkeletonModule } from 'primeng/skeleton';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin } from 'rxjs';

import {
  CommandCenterService,
  OverviewResponse,
  TopCustomerRow,
  TopProductRow,
  SalesByBrandRow,
  LowStockResponse,
  InactiveCustomersResponse,
} from './command-center.service';
import { AlertsSocketService, CommercialAlert } from './alerts-socket.service';

@Component({
  selector: 'app-command-center',
  standalone: true,
  imports: [
    CommonModule,
    ButtonModule,
    SkeletonModule,
    ToastModule,
  ],
  providers: [MessageService],
  templateUrl: './command-center.component.html',
  styleUrls: ['./command-center.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CommandCenterComponent implements OnInit, OnDestroy {
  private readonly api = inject(CommandCenterService);
  private readonly alertsSocket = inject(AlertsSocketService);
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

  // Alerts realtime
  readonly wsConnected = this.alertsSocket.connected;
  readonly alertFeed = signal<CommercialAlert[]>([]);
  private readonly MAX_FEED = 20;

  ngOnInit(): void {
    this.loadAll();
    this.alertsSocket.connect();
    this.alertsSocket.alert$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((a) => this.handleAlert(a));
  }

  ngOnDestroy(): void {
    this.alertsSocket.disconnect();
  }

  private handleAlert(a: CommercialAlert): void {
    // Append al feed (most recent first, cap MAX_FEED)
    const cur = this.alertFeed();
    const next = [a, ...cur].slice(0, this.MAX_FEED);
    this.alertFeed.set(next);

    // Toast
    const severityMap: Record<string, 'success' | 'info' | 'warn' | 'error'> = {
      info: 'info',
      warn: 'warn',
      critical: 'error',
    };
    this.toast.add({
      severity: severityMap[a.severity] || 'info',
      summary: a.title,
      detail: a.message,
      life: a.severity === 'critical' ? 8000 : 4000,
    });
  }

  loadAll(): void {
    this.loading.set(true);
    forkJoin({
      ov: this.api.overview(),
      tc: this.api.topCustomers(5),
      tp: this.api.topProducts(5, 'revenue'),
      sbb: this.api.salesByBrand(),
      ls: this.api.lowStock(200),
      ic: this.api.inactiveCustomers(30, 5),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ ov, tc, tp, sbb, ls, ic }) => {
          this.overview.set(ov);
          this.topCustomers.set(tc);
          this.topProducts.set(tp);
          this.salesByBrand.set(sbb);
          this.lowStock.set(ls);
          this.inactiveCustomers.set(ic);
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

  alertSeverityTag(s: 'info' | 'warn' | 'critical'): 'info' | 'warn' | 'danger' {
    if (s === 'critical') return 'danger';
    if (s === 'warn') return 'warn';
    return 'info';
  }

  fmtTime(s: string): string {
    const d = new Date(s);
    return d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
}
