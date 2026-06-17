import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { ToastModule } from 'primeng/toast';
import { SkeletonModule } from 'primeng/skeleton';
import { DatePickerModule } from 'primeng/datepicker';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService } from 'primeng/api';
import { ComercialService, Order, OrderStatus } from '../comercial.service';
import { makeLazyLoad, makeDebouncedSearch } from '../../../shared/util';
import { OrderKpisComponent } from '../components/order-kpis.component';
import { OrderFiltersComponent } from '../components/order-filters.component';

type OrdersMode = 'pending' | 'history';

const PENDING_STATUS_FILTERS: { key: 'all' | OrderStatus; label: string }[] = [
  { key: 'pending_approval', label: 'Por aprobar' },
  { key: 'draft', label: 'Borradores' },
];

const HISTORY_STATUS_FILTERS: { key: 'all' | OrderStatus; label: string }[] = [
  { key: 'fulfilled', label: 'Entregados' },
  { key: 'confirmed', label: 'En curso' },
  { key: 'cancelled', label: 'Cancelados' },
];

const STATUS_FILTERS_BY_MODE: Record<OrdersMode, { key: 'all' | OrderStatus; label: string }[]> = {
  pending: PENDING_STATUS_FILTERS,
  history: HISTORY_STATUS_FILTERS,
};

const DEFAULT_STATUS_BY_MODE: Record<OrdersMode, OrderStatus> = {
  pending: 'pending_approval',
  history: 'fulfilled',
};

const DATE_PRESETS: { key: string; label: string; days: number | 'today' | 'all' }[] = [
  { key: 'today', label: 'Hoy', days: 'today' },
  { key: '7d', label: '7 días', days: 7 },
  { key: '30d', label: '30 días', days: 30 },
  { key: 'all', label: 'Todos', days: 'all' },
];

@Component({
  selector: 'app-comercial-orders',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    CardModule,
    TableModule,
    TagModule,
    SelectModule,
    ToastModule,
    SkeletonModule,
    DatePickerModule,
    InputTextModule,
    IconFieldModule,
    InputIconModule,
    TooltipModule,
    OrderKpisComponent,
    OrderFiltersComponent,
  ],
  providers: [MessageService],
  template: `
    <div class="surf-page co">
      <p-toast></p-toast>

      <!-- PAGE HEAD edge-to-edge -->
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>{{ mode === 'pending' ? 'Pedidos por aprobar' : 'Historial de pedidos' }}</h1>
          <p class="surf-page-sub">
            <b>{{ total() }}</b> pedido{{ total() === 1 ? '' : 's' }}
            <span class="co-divider" aria-hidden="true">·</span>
            {{ dateRangeLabel() }}
          </p>
        </div>

        <!-- Tab nav: separa la cola de aprobación del archivo histórico. -->
        <nav class="co-mode-tabs" role="tablist" aria-label="Vista de pedidos">
          <button
            type="button"
            class="co-mode-tab"
            [class.active]="mode === 'pending'"
            role="tab"
            [attr.aria-selected]="mode === 'pending'"
            (click)="switchMode('pending')"
          >
            <i class="pi pi-hourglass" aria-hidden="true"></i>
            <span>Por aprobar</span>
          </button>
          <button
            type="button"
            class="co-mode-tab"
            [class.active]="mode === 'history'"
            role="tab"
            [attr.aria-selected]="mode === 'history'"
            (click)="switchMode('history')"
          >
            <i class="pi pi-history" aria-hidden="true"></i>
            <span>Historial</span>
          </button>
        </nav>

        <div class="co-head-actions">
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

      <!-- SHEET 1: KPI STRIP ventana actual (adaptativo por modo) -->
      <app-order-kpis
        [loading]="loadingKpis()"
        [mode]="mode"
        [totalAmount]="totalAmount()"
        [total]="total()"
        [statusCounts]="statusCounts()"
      />

      <!-- SHEET 2: FILTERS — toolbar densa (extraída a app-order-filters, CV.3) -->
      <app-order-filters
        [filters]="filters()"
        [statusFilter]="statusFilter()"
        [statusCounts]="statusCounts()"
        [presets]="presets"
        [datePreset]="datePreset()"
        [fromDate]="fromDate"
        [toDate]="toDate"
        [folioSearch]="folioSearch"
        [hasActiveFilters]="hasActiveFilters()"
        (statusChange)="setStatus($any($event))"
        (presetChange)="setPreset($event)"
        (fromDateChange)="fromDate = $event; onDateManualChange()"
        (toDateChange)="toDate = $event; onDateManualChange()"
        (searchChange)="folioSearch = $event; onSearchChange($event)"
        (clearSearch)="clearSearch()"
        (resetFilters)="resetFilters()"
      />

      <!-- SHEET 3: TABLE flush, edge-to-edge -->
      <div class="sheet cols-12">
        <article class="cell cell-span-12 is-flush">
          <p-table
            [value]="visibleRows()"
            [loading]="loading()"
            [lazy]="true"
            [paginator]="true"
            [rows]="pageSize()"
            [totalRecords]="visibleTotal()"
            [first]="(page() - 1) * pageSize()"
            (onLazyLoad)="onLazyLoad($event)"
            responsiveLayout="scroll"
            styleClass="p-datatable-sm co-table"
            [rowHover]="true"
          >
            <ng-template pTemplate="header">
              <tr>
                <th>Folio</th>
                <th>Cliente</th>
                <th>Estado</th>
                <th>Entrega</th>
                <th class="comm-num">Total</th>
                <th>Fecha</th>
              </tr>
            </ng-template>
            <ng-template pTemplate="body" let-o>
              <tr (click)="goDetail(o)" (keydown.enter)="goDetail(o)" tabindex="0" role="button"
                  [attr.aria-label]="'Ver pedido ' + o.folio" class="comm-row-clickable">
                <td><code class="comm-code">{{ o.folio }}</code></td>
                <td>
                  <div class="comm-cell-strong">{{ o.customer_name || o.customer_id }}</div>
                  <div class="comm-muted is-small co-cell-meta">
                    <span *ngIf="o.route_name">
                      <i class="pi pi-directions" aria-hidden="true"></i>
                      {{ o.route_name }}
                    </span>
                    <span *ngIf="o.warehouse_name">
                      <i class="pi pi-box" aria-hidden="true"></i>
                      {{ o.warehouse_name }}
                    </span>
                    <span *ngIf="o.user_username">
                      <i class="pi pi-user" aria-hidden="true"></i>
                      {{ o.user_username }}
                    </span>
                  </div>
                </td>
                <td>
                  <span class="portal-status-pill" [class]="'is-' + o.status">
                    {{ statusLabel(o.status) }}
                  </span>
                </td>
                <td>
                  <span class="co-delivery">
                    <i [class]="o.delivery_type === 'long_trip' ? 'pi pi-globe' : 'pi pi-truck'" aria-hidden="true"></i>
                    {{ o.delivery_type === 'long_trip' ? 'Viaje largo' : 'Por ruta' }}
                  </span>
                </td>
                <td class="comm-num is-strong">{{ o.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td>
                  <span class="co-date">{{ o.created_at | date:'dd MMM · HH:mm' }}</span>
                </td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage">
              <tr>
                <td colspan="6" class="co-empty-cell">
                  <div class="co-empty">
                    <div class="co-empty-icon"><i [class]="emptyIcon()" aria-hidden="true"></i></div>
                    <h3>{{ emptyTitle() }}</h3>
                    <p>{{ emptyMessage() }}</p>
                    <button
                      *ngIf="hasActiveFilters()"
                      type="button"
                      pButton
                      icon="pi pi-refresh"
                      severity="secondary"
                      [outlined]="true"
                      size="small"
                      label="Limpiar filtros"
                      (click)="resetFilters()"
                    ></button>
                  </div>
                </td>
              </tr>
            </ng-template>
          </p-table>
        </article>
      </div>
    </div>
  `,
  styles: [`
    :host { display:block; }

    .co-head-actions { display:flex; gap:.5rem; align-items:center; }
    .co-divider { opacity: 0.4; }
    .co-mode-tabs {
      display: inline-flex;
      gap: .25rem;
      background: var(--c-surface-2);
      border: 1px solid var(--c-divider);
      border-radius: 10px;
      padding: 4px;
      margin: 0;
    }
    .co-mode-tab {
      display: inline-flex; align-items: center; gap: .45rem;
      padding: .5rem .95rem;
      border: 0; background: transparent;
      border-radius: 8px;
      font-size: var(--fs-body); font-weight: var(--fw-medium);
      color: var(--c-text-2);
      cursor: pointer;
      transition: background 120ms var(--ease-standard), color 120ms var(--ease-standard);
    }
    .co-mode-tab:hover { color: var(--c-text-1); }
    .co-mode-tab.active {
      background: var(--c-surface-1);
      color: var(--c-text-1);
      font-weight: var(--fw-bold);
    }
    .co-mode-tab i { font-size: .85rem; }
    .surf-page-sub b { font-weight: var(--fw-bold); color: var(--c-text-1); }

    /* ── DELIVERY chip neutral (sólo el icono cambia entre por_ruta y long_trip) ── */
    .co-delivery {
      display: inline-flex;
      align-items: center;
      gap: .35rem;
      font-size: var(--fs-sm);
      color: var(--c-text-1);
      white-space: nowrap;
    }
    .co-delivery i { font-size: var(--fs-xs); color: var(--c-text-3); }

    /* Cell meta — sub-línea bajo Cliente con ruta / almacén / vendedor */
    .co-cell-meta {
      display: inline-flex;
      align-items: center;
      gap: .75rem;
      margin-top: .15rem;
      flex-wrap: wrap;
    }
    .co-cell-meta span {
      display: inline-flex;
      align-items: center;
      gap: .3rem;
    }
    .co-cell-meta i { font-size: var(--fs-nano); color: var(--c-text-3); }
    .co-date { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-sm); color: var(--c-text-1); }

    /* ── EMPTY STATE inline en tabla ── */
    .co-empty-cell { padding: 0 !important; }
    .co-empty {
      text-align: center;
      padding: 3rem 1.5rem;
      max-width: 420px;
      margin: 0 auto;
    }
    .co-empty-icon {
      width: 56px;
      height: 56px;
      margin: 0 auto 1rem;
      border-radius: 14px;
      background: var(--c-surface-2);
      color: var(--c-text-2);
      display: grid;
      place-items: center;
      font-size: var(--fs-h1);
    }
    .co-empty h3 {
      margin: 0 0 .375rem;
      font-size: var(--fs-h3);
      font-weight: var(--fw-bold);
      color: var(--c-text-1);
    }
    .co-empty p {
      margin: 0 0 1rem;
      color: var(--c-text-2);
      font-size: var(--fs-sm);
      line-height: 1.4;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComercialOrdersComponent {
  private readonly api = inject(ComercialService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  /** 'pending' = pedidos que requieren acción del vendedor. 'history' = ya cerrados. */
  readonly modeSignal = signal<OrdersMode>(
    (this.route.snapshot.data?.['mode'] as OrdersMode) || 'pending',
  );
  /** Accesor compatible con código existente que usa `mode` como property. */
  get mode(): OrdersMode { return this.modeSignal(); }

  readonly rows = signal<Order[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly pageSize = signal(15);
  readonly loading = signal(false);
  readonly loadingKpis = signal(true);
  readonly statusFilter = signal<'all' | OrderStatus>(DEFAULT_STATUS_BY_MODE[this.modeSignal()]);
  readonly datePreset = signal<string>(this.modeSignal() === 'pending' ? 'all' : '30d');
  readonly statusCounts = signal<Record<string, number>>({});
  readonly totalAmount = signal(0);

  readonly filters = computed(() => STATUS_FILTERS_BY_MODE[this.modeSignal()]);
  readonly presets = DATE_PRESETS;

  fromDate: Date | null = null;
  toDate: Date | null = null;
  folioSearch = '';
  readonly folioSearchSignal = signal('');

  readonly visibleRows = computed(() => {
    const q = this.folioSearchSignal().trim().toUpperCase();
    if (!q) return this.rows();
    return this.rows().filter((o) => (o.folio || '').toUpperCase().includes(q));
  });
  readonly visibleTotal = computed(() => {
    const q = this.folioSearchSignal().trim();
    return q ? this.visibleRows().length : this.total();
  });

  readonly dateRangeLabel = computed(() => {
    const p = this.datePreset();
    const preset = DATE_PRESETS.find((x) => x.key === p);
    if (preset && p !== 'custom') return preset.label;
    const f = this.fromDate ? this.fmtMd(this.fromDate) : '—';
    const t = this.toDate ? this.fmtMd(this.toDate) : 'hoy';
    return `${f} → ${t}`;
  });

  constructor() {
    // Reaccionar a cambios de modo (Angular reusa la instancia del componente
    // cuando navegás entre /orders y /orders/history → necesitamos re-init).
    this.route.data.pipe(takeUntilDestroyed()).subscribe((d) => {
      const next = (d?.['mode'] as OrdersMode) || 'pending';
      if (next === this.modeSignal() && this.rows().length > 0) return;
      this.modeSignal.set(next);
      this.statusFilter.set(DEFAULT_STATUS_BY_MODE[next]);
      this.page.set(1);
      this.folioSearch = '';
      this.folioSearchSignal.set('');
      // En modo "pending" arrancamos sin rango (pedidos por aprobar suelen ser pocos
      // y la cola no debería ocultarse por una ventana de fechas). En "history" sí
      // limitamos a 30 días por default para que la lista no explote.
      this.applyPreset(next === 'pending' ? 'all' : '30d');
      this.loadCounts();
      this.load();
    });
  }

  private applyPreset(key: string): void {
    const p = DATE_PRESETS.find((x) => x.key === key);
    if (!p) return;
    const now = new Date();
    if (p.days === 'all') {
      this.fromDate = null;
      this.toDate = null;
    } else if (p.days === 'today') {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      this.fromDate = d;
      this.toDate = new Date(now);
    } else {
      const d = new Date(now);
      d.setDate(d.getDate() - p.days);
      d.setHours(0, 0, 0, 0);
      this.fromDate = d;
      this.toDate = new Date(now);
    }
    this.datePreset.set(key);
  }

  setPreset(key: string): void {
    this.applyPreset(key);
    this.page.set(1);
    this.load();
    this.loadCounts();
  }

  onDateManualChange(): void {
    this.datePreset.set('custom');
    this.page.set(1);
    this.load();
    this.loadCounts();
  }

  setStatus(s: 'all' | OrderStatus): void {
    this.statusFilter.set(s);
    this.page.set(1);
    this.load();
  }

  readonly onSearchChange = makeDebouncedSearch((v) => this.folioSearchSignal.set(v || ''), 180);

  clearSearch(): void {
    this.folioSearch = '';
    this.folioSearchSignal.set('');
  }

  resetFilters(): void {
    this.statusFilter.set('all');
    this.folioSearch = '';
    this.folioSearchSignal.set('');
    this.applyPreset('30d');
    this.page.set(1);
    this.load();
    this.loadCounts();
  }

  hasActiveFilters(): boolean {
    return this.statusFilter() !== 'all' || !!this.folioSearchSignal() || this.datePreset() !== 'all';
  }

  load(): void {
    this.loading.set(true);
    const s = this.statusFilter();
    this.api
      .listOrders({
        status: s === 'all' ? undefined : s,
        from: this.toIso(this.fromDate),
        to: this.toIso(this.toDate),
        page: this.page(),
        pageSize: this.pageSize(),
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.rows.set(r.data || []);
          this.total.set(r.pagination?.total || 0);
          this.totalAmount.set(r.total_amount || 0);
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
          this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar pedidos' });
        },
      });
  }

  /** Carga counts solo para los chips visibles en el modo actual. */
  loadCounts(): void {
    this.loadingKpis.set(true);
    this.api
      .orderCounts({
        from: this.toIso(this.fromDate),
        to: this.toIso(this.toDate),
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.statusCounts.set(r.counts || {});
          this.loadingKpis.set(false);
        },
        error: () => this.loadingKpis.set(false),
      });
  }

  /** Cambiar entre tabs "Pendientes" e "Historial". */
  switchMode(m: OrdersMode): void {
    if (m === this.mode) return;
    this.router.navigate(['/comercial/orders', ...(m === 'history' ? ['history'] : [])]);
  }

  readonly onLazyLoad = makeLazyLoad(this.page, this.pageSize, () => this.load());

  goDetail(o: Order): void {
    this.router.navigate(['/comercial/orders', o.id]);
  }

  statusLabel(s: OrderStatus): string {
    return {
      draft: 'Borrador',
      pending_approval: 'Pendiente',
      confirmed: 'Confirmado',
      fulfilled: 'Entregado',
      cancelled: 'Cancelado',
    }[s];
  }

  emptyIcon(): string {
    if (this.folioSearchSignal()) return 'pi pi-search';
    if (this.statusFilter() !== 'all') return 'pi pi-filter-slash';
    return 'pi pi-inbox';
  }
  emptyTitle(): string {
    if (this.folioSearchSignal()) return 'Sin resultados';
    if (this.statusFilter() !== 'all') return 'Sin pedidos en ese estado';
    return 'Sin pedidos';
  }
  emptyMessage(): string {
    if (this.folioSearchSignal()) return `No encontramos pedidos con folio "${this.folioSearchSignal()}".`;
    if (this.statusFilter() !== 'all') return 'No hay pedidos que coincidan con el filtro y rango actual.';
    return 'No hay pedidos en el rango de fechas seleccionado.';
  }

  private toIso(d: Date | null): string | undefined {
    if (!d) return undefined;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  private fmtMd(d: Date): string {
    return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' } as any);
  }
  private fmtMoney(n: number): string {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(n);
  }

  /** Formato compact ($706.42K / $5.76M) para headlines tipográficos. */
  fmtMoneyShort(n: number | undefined | null): string {
    if (n === null || n === undefined) return '—';
    const v = Number(n);
    if (Math.abs(v) >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
    if (Math.abs(v) >= 1e3) return '$' + (v / 1e3).toFixed(2) + 'K';
    return '$' + v.toFixed(0);
  }
}
