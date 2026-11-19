import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService } from 'primeng/api';
import { ComercialService, StockRow, StockSummary, Warehouse } from '../comercial.service';
import { makeLazyLoad } from '../../../shared/util';
import { MetricCardComponent } from '../../../shared/components/metric-card/metric-card.component';
import { ProductSearchComponent, ProductHit } from '../components/product-search.component';

@Component({
  selector: 'app-comercial-inventory',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink, // enlace al censo físico (Existencia) desde el aviso de fuente
    FormsModule,
    ButtonModule,
    TableModule,
    TagModule,
    SelectModule,
    ToastModule,
    TooltipModule,
    MetricCardComponent,
    ProductSearchComponent,
  ],
  providers: [MessageService],
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
    
    
      <!-- PAGE HEAD -->
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Existencia y apartados</h1>
          <p class="surf-page-sub">
            <b>{{ total() }}</b> línea{{ total() === 1 ? '' : 's' }} de stock
            <span class="in-divider" aria-hidden="true">·</span>
            on-hand / reservado / disponible
          </p>
          <!-- [CANON.7.4a] Hasta el 2026-11-19 se llamaba «Ajustes de stock»: leía la copia «commercial.stock» del
               importer (acertaba 91 % contra el POS) y ajustaba ahí. Ahora la cantidad sale del ERP (ODS) y sólo se le
               agrega el apartado de los pedidos de la Suite. El ajuste de existencia se hace en Kepler (ADR-040). -->
          <p class="in-source-note">
            <i class="pi pi-info-circle" aria-hidden="true"></i>
            <span>
              La existencia sale del ERP (Kepler). <b>Reservado</b> es lo que apartan los pedidos de la app.
              El ajuste se hace en Kepler. Lotes y caducidades:
              <a routerLink="/almacen/inventory/existencia">Existencia</a>.
            </span>
          </p>
        </div>
        <div class="in-head-actions">
          <button pButton [text]="true" severity="secondary" size="small" (click)="load()" [loading]="loading()" pTooltip="Refrescar"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span></button>
        </div>
      </header>
    
      <!-- KPI BENTO — data-viz del total (independiente del paginado). [CANON.7.4a] Lo agrega el servidor sobre TODA
           la selección; antes se sumaban en el navegador las 500 filas a las que se topa el listado. -->
      @if (summary()) {
        <div class="surf-grid in-bento">
          <!-- HERO: valor del inventario disponible + barras por almacén -->
          <app-metric-card class="panel-col-6" [large]="true"
            label="Valor de inventario disponible" [value]="kpis().totalValue" format="currency"
            accent="var(--action)"
            [variant]="kpis().valueByWh.length > 1 ? 'bars' : 'plain'"
            [series]="kpis().valueByWh" [seriesLabels]="kpis().whLabels" [highlightLast]="false"
          [sub]="'al costo · ' + kpis().whCount + (kpis().whCount === 1 ? ' almacén' : ' almacenes') + (kpis().withoutCost ? ' · ' + kpis().withoutCost + ' con saldo sin costo' : '')"></app-metric-card>
          <app-metric-card class="panel-col-3"
            label="Unidades on-hand" [value]="kpis().totalUnits" format="number"
            accent="var(--chart-2)"
            [variant]="kpis().unitsByWh.length > 1 ? 'bars' : 'plain'"
            [series]="kpis().unitsByWh" [seriesLabels]="kpis().whLabels" [highlightLast]="false"
          sub="suma de todas las líneas"></app-metric-card>
          <app-metric-card class="panel-col-3"
            label="Líneas de stock" [value]="kpis().lines" format="number"
          accent="var(--chart-6)" sub="producto × almacén"></app-metric-card>
          <!-- Triada de salud del stock: % sobre el total de líneas -->
          <app-metric-card class="panel-col-4" variant="progress"
            label="Stock saludable" [value]="kpis().healthy" [goal]="kpis().lines" format="number"
          accent="var(--ok-fg)" sub="disponible ≥ 20"></app-metric-card>
          <app-metric-card class="panel-col-4" variant="progress"
            label="Stock crítico" [value]="kpis().critical" [goal]="kpis().lines" format="number"
          accent="var(--warn-fg)" sub="disponible &lt; 20"></app-metric-card>
          <app-metric-card class="panel-col-4" variant="progress"
            label="Sin stock" [value]="kpis().zero" [goal]="kpis().lines" format="number"
          accent="var(--bad-fg)" sub="requieren reabasto"></app-metric-card>
        </div>
      }
    
      <!-- FILTERS toolbar -->
      <div class="sheet cols-12">
        <article class="cell cell-span-12 is-flush in-filters-cell">
          <div class="in-toolbar">
            <div class="in-field">
              <i class="pi pi-warehouse in-field-icon" aria-hidden="true"></i>
              <p-select
                [options]="warehouseOptions()"
                [(ngModel)]="warehouseFilter"
                (onChange)="reload()"
                optionLabel="name"
                optionValue="id"
                styleClass="in-warehouse-select"
                appendTo="body"
              ></p-select>
            </div>
    
            <app-product-search class="in-product-search" (productSelected)="onProductSelected($event)"></app-product-search>
    
            <div class="in-toolbar-spacer"></div>
    
            @if (isSpecific()) {
              <button
                type="button"
                class="in-reset"
                (click)="clearFilter()"
                >
                <i class="pi pi-refresh" aria-hidden="true"></i>
                <span>Reset</span>
              </button>
            }
          </div>
        </article>
      </div>
    
      <!-- TABLA flush -->
      <div class="sheet cols-12">
        <article class="cell cell-span-12 is-flush">
          <p-table
            [value]="rows()"
            [loading]="loading()"
            [lazy]="true"
            [paginator]="true"
            [rows]="pageSize()"
            [totalRecords]="total()"
            [first]="(page() - 1) * pageSize()"
            [rowsPerPageOptions]="[25, 50, 100, 200]"
            (onLazyLoad)="onLazyLoad($event)"
           
            styleClass="p-datatable-sm surf-table surf-table--sticky surf-table--frozen-first"
            >
            <ng-template #header>
              <tr>
                <th scope="col">Almacén</th>
                <th scope="col">Producto</th>
                <th scope="col">SKU</th>
                <th scope="col">Ubic.</th>
                <th scope="col" class="comm-num">Costo</th>
                <th scope="col" class="comm-num">On hand</th>
                <th scope="col" class="comm-num">Reservado</th>
                <th scope="col" class="comm-num">Disponible</th>
                <th scope="col" class="comm-num">Valor disp.</th>
              </tr>
            </ng-template>
            <ng-template #body let-s>
              <tr [class.in-row-low]="s.available > 0 && s.available < 20" [class.in-row-zero]="s.available <= 0">
                <td>
                  <span class="in-warehouse-cell">
                    <i class="pi pi-warehouse" aria-hidden="true"></i>
                    {{ s.warehouse_name || s.warehouse_id }}
                  </span>
                </td>
                <td>
                  <div class="comm-cell-strong">{{ s.product_name || s.product_id }}</div>
                  @if (s.brand_name) {
                    <div class="comm-muted is-small">{{ s.brand_name }}</div>
                  }
                </td>
                <td>
                  @if (s.sku) {
                    <code class="comm-code">{{ s.sku }}</code>
                  }
                  @if (!s.sku) {
                    <span class="comm-muted">—</span>
                  }
                </td>
                <td>
                  @if (s.location) {
                    <code class="comm-code in-loc-code">{{ s.location }}</code>
                  }
                  @if (!s.location) {
                    <span class="comm-muted">—</span>
                  }
                </td>
                <td class="comm-num">
                  @if (s.cost_base != null) {
                    <span>{{ s.cost_base | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
                  }
                  @if (s.cost_base == null) {
                    <span class="comm-muted">—</span>
                  }
                </td>
                <!-- [CANON.7.4a] Con formato: la API manda texto con la escala de cada columna («1» del ERP, «0.000» del apartado). -->
                <td class="comm-num in-num-soft">{{ s.on_hand | number:'1.0-3' }}</td>
                <td class="comm-num in-num-soft">{{ s.reserved | number:'1.0-3' }}</td>
                <td class="comm-num in-avail-cell">
                  <span class="comm-pill no-dot in-avail-pill" [class]="stockPillClass(s.available)">
                    {{ s.available | number:'1.0-3' }}
                  </span>
                </td>
                <td class="comm-num">
                  @if (s.available_value) {
                    <span>{{ s.available_value | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
                  }
                  @if (!s.available_value) {
                    <span class="comm-muted">—</span>
                  }
                </td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr>
                <td colspan="9" class="comm-empty-cell">
                  <div class="comm-empty">
                    <div class="comm-empty-icon"><i class="pi pi-inbox" aria-hidden="true"></i></div>
                    <h3>Sin stock registrado</h3>
                    <p>{{ isSpecific() ? 'Este almacén no tiene productos con saldo.' : 'Aún no hay líneas de stock en el tenant.' }}</p>
                    @if (isSpecific()) {
                      <button type="button" pButton severity="secondary" [outlined]="true" size="small" (click)="clearFilter()"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Ver todos los almacenes</span></button>
                    }
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

    .in-bento { margin-bottom: 1rem; }

    .in-head-actions { display:flex; gap:.5rem; align-items:center; }
    .in-divider { opacity: 0.4; }
    /* Aviso de fuente: tono informativo, no de error — el dato sirve para lo que sirve. */
    .in-source-note {
      display: flex; gap: .45rem; align-items: flex-start; margin: .4rem 0 0; max-width: 68ch;
      font-size: .74rem; line-height: 1.45; color: var(--text-muted);
    }
    .in-source-note i { margin-top: .15rem; flex: none; opacity: .7; }
    .in-source-note a { color: var(--action, #c2410c); }
    .surf-page-sub b { font-weight: var(--fw-bold); color: var(--c-text-1); }

    /* ── FILTERS TOOLBAR ── */
    .in-filters-cell { display: flex; flex-direction: column; }
    .in-toolbar {
      display: flex;
      align-items: center;
      gap: .5rem;
      padding: .625rem .875rem;
      flex-wrap: wrap;
    }
    .in-toolbar-spacer { flex: 1; min-width: 0; }

    .in-field {
      display: inline-flex;
      align-items: center;
      height: 32px;
      min-width: 240px;
      background: var(--c-surface-1);
      border: 1px solid var(--c-divider);
      border-radius: 8px;
      padding: 0 .5rem;
      gap: .35rem;
      transition: border-color 120ms var(--ease-standard);
    }
    .in-field:focus-within {
      border-color: var(--c-text-1);
      box-shadow: 0 0 0 3px var(--c-focus-ring, rgba(0, 0, 0, 0.08));
    }
    .in-field-icon { color: var(--c-text-3); font-size: var(--fs-sm); flex-shrink: 0; }
    :host ::ng-deep .in-warehouse-select.p-select {
      flex: 1;
      border: none !important;
      background: transparent !important;
      box-shadow: none !important;
    }
    :host ::ng-deep .in-warehouse-select.p-select .p-select-label {
      padding: 0 !important;
      height: 28px !important;
      font-size: var(--fs-sm) !important;
      color: var(--c-text-1) !important;
      display: flex;
      align-items: center;
    }

    .in-reset {
      display: inline-flex;
      align-items: center;
      gap: .35rem;
      height: 32px;
      padding: 0 .75rem;
      background: transparent;
      border: 1px solid var(--c-divider);
      border-radius: 8px;
      color: var(--c-text-2);
      font-size: var(--fs-xs);
      font-weight: var(--fw-medium);
      cursor: pointer;
      transition: all 120ms var(--ease-standard);
    }
    .in-reset:hover {
      color: var(--c-text-1);
      border-color: var(--c-text-1);
      background: var(--c-surface-2);
    }

    /* ── ROW tinting: border-left sutil en vez de bg full-row ── */
    tr.in-row-low td:first-child,
    tr.in-row-zero td:first-child {
      position: relative;
    }
    tr.in-row-low td:first-child::before,
    tr.in-row-zero td:first-child::before {
      content: '';
      position: absolute;
      left: 0;
      top: 4px;
      bottom: 4px;
      width: 3px;
      border-radius: 2px;
    }
    tr.in-row-low td:first-child::before { background: var(--c-warn); }
    tr.in-row-zero td:first-child::before { background: var(--c-bad); }

    /* ── Warehouse cell: texto + icono ── */
    .in-warehouse-cell {
      display: inline-flex;
      align-items: center;
      gap: .4rem;
      font-size: var(--fs-sm);
      color: var(--c-text-1);
      white-space: nowrap;
    }
    .in-warehouse-cell i {
      color: var(--c-text-3);
      font-size: var(--fs-xs);
    }

    /* ── Numéricos: on_hand y reserved soft, available prominente ── */
    .in-num-soft { color: var(--c-text-2); font-variant-numeric: tabular-nums; }
    .in-loc-code { font-size: var(--fs-xs); padding: .1rem .35rem; letter-spacing: 0.04em; }
    .in-avail-cell { font-variant-numeric: tabular-nums; }
    .in-avail-pill {
      font-size: var(--fs-body);
      font-weight: var(--fw-bold);
      min-width: 48px;
      justify-content: center;
    }

  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComercialInventoryComponent {

  private readonly api = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly rows = signal<StockRow[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly pageSize = signal(25);
  readonly loading = signal(false);

  readonly ALL = '__all__';
  readonly warehouses = signal<Warehouse[]>([]);
  warehouseFilter: string = this.ALL;
  readonly warehouseOptions = computed<{ id: string; name: string }[]>(() => [
    { id: this.ALL, name: 'Todos los almacenes' },
    ...this.warehouses().map((w) => ({ id: w.id, name: w.name })),
  ]);

  /** True si hay un almacén concreto seleccionado (no "Todos"). */
  isSpecific(): boolean { return this.warehouseFilter !== this.ALL; }
  private whParam(): string | undefined { return this.isSpecific() ? this.warehouseFilter : undefined; }

  /** Filtro de producto del buscador inteligente (null = todos). */
  productFilter: string | null = null;
  onProductSelected(hit: ProductHit | null): void {
    this.productFilter = hit?.id ?? null;
    this.reload();
  }

  /** [CANON.7.4a] El resumen de TODA la selección, agregado en el servidor. Hasta el 2026-11-19 se sumaban aquí las
   *  filas de `listStock(pageSize: 9999)`, que el servidor topa a 500: en la red pintaba 500 líneas, $475,940 y
   *  «1 almacén» contra 33,530 líneas, $70.4 M y 9 almacenes. */
  readonly summary = signal<StockSummary | null>(null);
  readonly kpis = computed(() => {
    const su = this.summary();
    // Composición por almacén (para las micro-gráficas de barras con tooltip), del más valioso al menos.
    const wh = [...(su?.by_warehouse ?? [])].sort((a, b) => b.value - a.value);
    return {
      lines: su?.lines ?? 0,
      critical: su?.critical ?? 0,
      zero: su?.zero ?? 0,
      healthy: su?.healthy ?? 0,
      totalUnits: su?.units ?? 0,
      totalValue: su?.value ?? 0,
      withoutCost: su?.without_cost ?? 0,
      whCount: wh.length,
      whLabels: wh.map((w) => w.warehouse_name || w.warehouse_id),
      valueByWh: wh.map((w) => Math.round(w.value)),
      unitsByWh: wh.map((w) => Math.round(w.units)),
    };
  });

  constructor() {
    this.api.listWarehouses(true).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => this.warehouses.set(Array.isArray(r) ? r : []),
      error: () => this.warehouses.set([]),
    });
    this.load();
    this.loadSummary();
  }

  private loadSummary(): void {
    this.api.stockSummary({ warehouse_id: this.whParam() }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => this.summary.set(r),
      error: () => this.summary.set(null),
    });
  }

  load(): void {
    this.loading.set(true);
    this.api
      .listStock({
        warehouse_id: this.whParam(),
        product_id: this.productFilter || undefined,
        page: this.page(),
        pageSize: this.pageSize(),
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.rows.set(r.data || []);
          this.total.set(r.pagination?.total || 0);
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
          this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar inventario' });
        },
      });
  }

  reload(): void {
    this.page.set(1);
    this.load();
    this.loadSummary();
  }

  clearFilter(): void {
    this.warehouseFilter = this.ALL;
    this.reload();
  }

  /** Clase de comm-pill según disponibilidad. */
  stockPillClass(qty: number): string {
    if (qty <= 0) return 'is-bad';
    if (qty < 20) return 'is-warn';
    return 'is-active';
  }

  readonly onLazyLoad = makeLazyLoad(this.page, this.pageSize, () => this.load());
}
