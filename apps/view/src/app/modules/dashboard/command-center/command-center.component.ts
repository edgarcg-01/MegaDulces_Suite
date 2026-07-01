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

import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { Customer360PanelComponent } from '../../../shared/components/customer-360-panel/customer-360-panel.component';
import { CountUpDirective } from '../../../shared/directives/count-up.directive';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { ANALYTICS_TABS } from '../../comercial/analytics-tabs';
import {
  CommandCenterService,
  NetworkOverviewResponse,
  NetworkTopProductRow,
  NetworkDailyRow,
  NetworkChannelRow,
  ErpCustomerRow,
  SalesByBrandRow,
  LowStockResponse,
  InactiveCustomersResponse,
  RankingOutOfStockRow,
  ConversionSummary,
  ConversionDailyRow,
  ProductStockRow,
} from './command-center.service';

/** Shape mínimo para abrir el 360° de un cliente desde cualquier tabla. */
interface CustomerPeekRef {
  customer_id: string;
  name: string;
  code: string;
  revenue?: number;
}

/** Shape mínimo para abrir el peek de un producto desde cualquier tabla. */
interface ProductPeekRef {
  product_id: string;
  product_name: string;
  brand_name: string;
  units_sold?: number;
  revenue?: number;
  orders_count?: number;
}

@Component({
  selector: 'app-command-center',
  standalone: true,
  imports: [
    CommonModule,
    ButtonModule,
    SkeletonModule,
    ToastModule,
    TooltipModule,
    SidePeekComponent,
    Customer360PanelComponent,
    CountUpDirective,
    PageTabsComponent,
  ],
  providers: [MessageService],
  templateUrl: './command-center.component.html',
  styleUrls: ['./command-center.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CommandCenterComponent implements OnInit {
  readonly analyticsTabs = ANALYTICS_TABS;

  private readonly api = inject(CommandCenterService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  // Señales — TODO sobre VENTA REAL de la red (analytics.*, feeds Kepler),
  // excepto el pipeline B2B (netOverview.pipeline, de commercial.orders).
  readonly loading = signal(true);
  readonly refreshing = signal(false);
  readonly overview = signal<NetworkOverviewResponse | null>(null);
  readonly topProducts = signal<NetworkTopProductRow[]>([]);
  readonly salesByBrand = signal<SalesByBrandRow[]>([]);
  readonly netCustomers = signal<ErpCustomerRow[]>([]);
  readonly dailySeries = signal<NetworkDailyRow[]>([]);
  readonly lowStock = signal<LowStockResponse | null>(null);
  readonly inactiveCustomers = signal<InactiveCustomersResponse | null>(null);
  readonly rankingOOS = signal<RankingOutOfStockRow[]>([]);
  readonly conversion = signal<ConversionSummary | null>(null);
  readonly conversionSeries = signal<ConversionDailyRow[]>([]);
  readonly dueCount = signal<number | null>(null);

  // Reveal escalonado SOLO en el primer paint (nunca en refresh — DESIGN.md motion #5).
  readonly stagger = signal(false);
  private hasEntered = false;

  // ── Side-peek: drill-down 360° del cliente (Customer360PanelComponent) ──
  readonly peekOpen = signal(false);
  readonly peekRow = signal<CustomerPeekRef | null>(null);

  // ── Side-peek: drill-down de producto (stock por almacén) ──
  readonly prodOpen = signal(false);
  readonly prodRow = signal<ProductPeekRef | null>(null);
  readonly prodStock = signal<ProductStockRow[]>([]);
  readonly prodLoading = signal(false);

  /** Canales de venta ordenados por revenue (ruta/mostrador/preventa…). */
  readonly channels = computed<NetworkChannelRow[]>(() => this.overview()?.by_channel ?? []);

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

  /** Mini-barras (tickets/día) — venta real. */
  readonly ticketsBars = computed(() => this.bars(this.dailySeries().map((d) => d.tickets)));
  /** Mini-barras (unidades/día) — venta real. */
  readonly unitsBars = computed(() => this.bars(this.dailySeries().map((d) => d.units)));
  /** Mini-barras del Motor — ofertas/día, convertidas/día. */
  readonly offersBars = computed(() => this.bars(this.conversionSeries().map((d) => d.offers)));
  readonly convertedBars = computed(() => this.bars(this.conversionSeries().map((d) => d.converted)));
  readonly conversionSpark = computed(() => this.miniSpark(this.conversionSeries().map((d) => d.conversion_pct)));

  /** "En curso": composición del pipeline B2B (commercial.orders). */
  readonly pipelineStack = computed(() => {
    const o = this.overview()?.pipeline;
    if (!o) return null;
    const total = (o.confirmed || 0) + (o.draft || 0) + (o.cancelled || 0);
    if (total <= 0) return null;
    return {
      confirmedPct: ((o.confirmed || 0) / total) * 100,
      draftPct: ((o.draft || 0) / total) * 100,
      cancelledPct: ((o.cancelled || 0) / total) * 100,
    };
  });

  /** Sparkline línea para cards chicas (viewBox 100×28, stretch). */
  private miniSpark(values: number[]) {
    const n = values.length;
    if (n < 2) return null;
    const W = 100;
    const H = 28;
    const padY = 3;
    const max = Math.max(...values);
    const min = Math.min(...values, 0);
    const range = max - min || 1;
    const stepX = W / (n - 1);
    const pts = values.map((v, i) => ({
      x: i * stepX,
      y: padY + (H - 2 * padY) * (1 - (v - min) / range),
    }));
    const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const area = `${line} L${W},${H} L0,${H} Z`;
    return { W, H, line, area, last: pts[pts.length - 1] };
  }

  /** Geometría de un mini-bar chart. viewBox 100×28, stretch. */
  private bars(values: number[]) {
    const n = values.length;
    if (n < 2) return null;
    const W = 100;
    const H = 28;
    const gap = 1.2;
    const max = Math.max(...values, 1);
    const barW = (W - gap * (n - 1)) / n;
    const rects = values.map((v, i) => {
      const h = max > 0 ? (v / max) * H : 0;
      return { x: i * (barW + gap), y: H - h, w: barW, h };
    });
    return { W, H, rects };
  }

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
      // Venta real de la red — best-effort: si analytics.* está vacío/caído, no rompe.
      ov: this.api.networkOverview().pipe(catchError(() => of(null))),
      tp: this.api.networkTopProducts(8).pipe(catchError(() => of([] as NetworkTopProductRow[]))),
      sbb: this.api.networkSalesByBrand().pipe(catchError(() => of([] as SalesByBrandRow[]))),
      cust: this.api.erpCustomers(6).pipe(catchError(() => of([] as ErpCustomerRow[]))),
      ds: this.api.networkDailySeries(fromIso, toIso).pipe(catchError(() => of([] as NetworkDailyRow[]))),
      // Operacional (commercial.* / ERP FDW) — best-effort.
      ls: this.api.lowStock(200).pipe(catchError(() => of(null))),
      ic: this.api.inactiveCustomers(30, 5).pipe(catchError(() => of(null))),
      oos: this.api.rankingOutOfStock(10, 200).pipe(catchError(() => of([] as RankingOutOfStockRow[]))),
      // Motor de Inteligencia (Fase M) — best-effort.
      conv: this.api.conversionSummary(30).pipe(catchError(() => of(null))),
      convDaily: this.api.conversionDaily(30).pipe(catchError(() => of([] as ConversionDailyRow[]))),
      due: this.api.nbaDue(100).pipe(catchError(() => of([] as Array<{ customer_id: string }>))),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ ov, tp, sbb, cust, ds, ls, ic, oos, conv, convDaily, due }) => {
          this.overview.set(ov);
          this.topProducts.set(tp);
          this.salesByBrand.set(sbb);
          this.netCustomers.set(cust);
          this.dailySeries.set(ds);
          this.lowStock.set(ls);
          this.inactiveCustomers.set(ic);
          this.rankingOOS.set(oos);
          this.conversion.set(conv);
          this.conversionSeries.set(convDaily);
          this.dueCount.set(conv ? due.length : null);
          if (!this.hasEntered) {
            this.hasEntered = true;
            this.stagger.set(true);
            setTimeout(() => this.stagger.set(false), 1200);
          }
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

  /** Recarga los datos (los feeds Kepler corren server-side; acá solo re-fetch). */
  reload(): void {
    this.refreshing.set(true);
    this.loadAll();
    // loadAll pone loading; liberamos refreshing en el mismo microtask del subscribe.
    setTimeout(() => this.refreshing.set(false), 400);
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

  /** Formato MXN compact ($706.42K, $5.76M) para headlines. */
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

  /** Etiqueta amigable para el canal de venta. */
  channelLabel(c: string): string {
    const map: Record<string, string> = {
      ruta: 'Ruta',
      mostrador: 'Mostrador',
      contado: 'Mostrador',
      preventa: 'Preventa',
      autoventa: 'Autoventa',
      credito: 'Crédito',
      mayoreo: 'Mayoreo',
    };
    const k = (c || '').toLowerCase();
    return map[k] || (c ? c.charAt(0).toUpperCase() + c.slice(1) : '—');
  }

  /** Tono del badge ABC (A = núcleo, C = cola). */
  abcTone(cls: string | null): string {
    if (cls === 'A') return 'is-active';
    if (cls === 'B') return 'is-info';
    if (cls === 'C') return 'is-warn';
    return '';
  }

  /** Clase de comm-pill según disponibilidad. */
  stockPillClass(qty: number): string {
    if (qty < 50) return 'is-bad';
    if (qty < 200) return 'is-warn';
    return 'is-active';
  }

  topShareProduct(rev: number): number {
    const total = this.topProducts().reduce((s, r) => s + Number(r.revenue || 0), 0);
    if (total <= 0) return 0;
    return (Number(rev || 0) / total) * 100;
  }

  /** Abre el side-peek 360° del cliente (solo clientes B2B de commercial: inactivos). */
  openCustomer(row: CustomerPeekRef): void {
    this.peekRow.set(row);
    this.peekOpen.set(true);
  }

  /** Abre el side-peek de un producto con su stock por almacén. */
  openProduct(row: ProductPeekRef): void {
    this.prodRow.set(row);
    this.prodStock.set([]);
    this.prodLoading.set(true);
    this.prodOpen.set(true);
    this.api
      .productStock(row.product_id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.prodStock.set(r.data || []);
          this.prodLoading.set(false);
        },
        error: () => this.prodLoading.set(false),
      });
  }

  /** Total disponible sumando almacenes (header del peek de producto). */
  prodTotalAvailable(): number {
    return this.prodStock().reduce((s, r) => s + Number(r.available_quantity || 0), 0);
  }
}
