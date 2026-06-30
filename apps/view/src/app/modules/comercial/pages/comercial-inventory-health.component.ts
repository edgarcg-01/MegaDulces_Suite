import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { ComercialService, InventoryHealthResponse, Warehouse } from '../comercial.service';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { ProductSearchComponent, ProductHit } from '../components/product-search.component';
import { ANALYTICS_TABS } from '../analytics-tabs';

/**
 * KV.5 — Salud de inventario: días de cobertura (stock ÷ velocidad de venta 90d)
 * y status (agotado/crítico/sano/sobrestock/muerto/nuevo). Venta real Kepler.
 */
@Component({
  selector: 'app-comercial-inventory-health',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, TagModule, SelectModule, ToastModule, PageTabsComponent, ProductSearchComponent],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="tabs" />

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Salud de inventario</h1>
          <p class="surf-page-sub">Días de cobertura (stock ÷ venta diaria 90d) y status por producto</p>
        </div>
        <div class="ih-actions">
          <p-select [options]="warehouseOptions()" [(ngModel)]="warehouseFilter" optionLabel="label" optionValue="value"
                    (onChange)="load()" styleClass="ih-wh"></p-select>
          <app-product-search (productSelected)="prodFilter.set($event)"></app-product-search>
          <button pButton icon="pi pi-refresh" [text]="true" severity="secondary" size="small" (click)="load()" [loading]="loading()"></button>
        </div>
      </header>

      <!-- KPIs por status (clic = filtra) -->
      <div class="ih-kpis">
        @for (s of statusKpis(); track s.key) {
          <button class="ih-kpi" [class.active]="statusFilter === s.key" (click)="toggleStatus(s.key)">
            <span class="ih-kpi-v" [style.color]="s.color">{{ s.n }}</span>
            <span class="ih-kpi-l">{{ s.label }}</span>
          </button>
        }
      </div>

      <p-table [value]="items()" [loading]="loading()" styleClass="p-datatable-sm surf-table"
               [scrollable]="true" scrollHeight="flex" [paginator]="true" [rows]="25" [rowsPerPageOptions]="[25,50,100,200]">
        <ng-template pTemplate="header">
          <tr>
            <th scope="col">Almacén</th><th scope="col">SKU</th><th scope="col">Producto</th><th scope="col">Marca</th>
            <th scope="col" class="ih-num">Existencia</th><th scope="col" class="ih-num">Venta/día</th>
            <th scope="col" class="ih-num">Días cob.</th><th scope="col">Status</th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-it>
          <tr>
            <td class="ih-mono">{{ it.warehouse_code }}</td>
            <td class="ih-mono">{{ it.sku }}</td>
            <td class="ih-name">{{ it.product_name }}</td>
            <td class="ih-name">{{ it.brand_name || '—' }}</td>
            <td class="ih-num">{{ it.on_hand | number:'1.0-0' }}</td>
            <td class="ih-num">{{ it.avg_daily_units | number:'1.0-2' }}</td>
            <td class="ih-num">{{ it.days_cover != null ? (it.days_cover | number:'1.0-0') : '—' }}</td>
            <td><p-tag [value]="it.status" [severity]="sev(it.status)"></p-tag></td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="8" class="comm-empty-cell">
            <div class="comm-empty"><div class="comm-empty-icon"><i class="pi pi-box" aria-hidden="true"></i></div>
              <h3>Sin datos</h3><p>Aún no se computó la salud de inventario.</p></div>
          </td></tr>
        </ng-template>
      </p-table>
    </div>
  `,
  styles: [`
    .ih-actions { display: flex; gap: .5rem; align-items: center; }
    :host ::ng-deep .ih-wh { min-width: 220px; }
    .ih-kpis { display: flex; flex-wrap: wrap; gap: .6rem; margin-bottom: 1rem; }
    .ih-kpi { background: var(--surface-card,var(--c-surface)); border: 1px solid var(--surface-200,var(--c-border)); border-radius: 12px; padding: .7rem 1.1rem; display: flex; flex-direction: column; cursor: pointer; min-width: 92px; transition: border-color .15s; }
    .ih-kpi:hover { border-color: var(--action,var(--c-text-2)); }
    .ih-kpi.active { border-color: var(--action); box-shadow: 0 0 0 1px var(--action) inset; }
    .ih-kpi-v { font-size: 1.5rem; font-weight: 700; font-variant-numeric: tabular-nums; }
    .ih-kpi-l { font-size: .72rem; color: var(--text-muted,var(--c-text-2)); text-transform: uppercase; letter-spacing: .03em; }
    .ih-mono { font-family: var(--font-mono,monospace); }
    .ih-name { max-width: 240px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ih-num { text-align: right; font-variant-numeric: tabular-nums; }
  `],
})
export class ComercialInventoryHealthComponent {
  readonly tabs = ANALYTICS_TABS;
  private readonly svc = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly ALL = '__all__';
  resp = signal<InventoryHealthResponse | null>(null);
  loading = signal(false);
  warehouseFilter = this.ALL;
  statusFilter: string | null = null;
  warehouses = signal<{ label: string; value: string }[]>([]);
  warehouseOptions = computed(() => [{ label: 'Todos los almacenes', value: this.ALL }, ...this.warehouses()]);

  isSpecific(): boolean { return this.warehouseFilter !== this.ALL; }
  private whParam(): string | undefined { return this.isSpecific() ? this.warehouseFilter : undefined; }

  /** Filtro de producto (client-side por SKU sobre las filas cargadas). */
  prodFilter = signal<ProductHit | null>(null);
  items = computed(() => {
    const all = this.resp()?.items ?? [];
    const f = this.prodFilter();
    if (!f) return all;
    return all.filter((r) => (f.sku ? r.sku === f.sku : r.product_name === f.label));
  });

  private readonly STATUS = [
    { key: 'agotado', label: 'Agotado', color: 'var(--bad-fg,#b91c1c)' },
    { key: 'critico', label: 'Crítico', color: 'var(--bad-fg,#b91c1c)' },
    { key: 'sano', label: 'Sano', color: 'var(--ok-fg,#15803d)' },
    { key: 'sobrestock', label: 'Sobrestock', color: 'var(--warn-fg,#b45309)' },
    { key: 'muerto', label: 'Muerto', color: 'var(--bad-fg,#b91c1c)' },
    { key: 'nuevo', label: 'Nuevo', color: 'var(--info-fg,#1d4ed8)' },
  ];

  statusKpis() {
    const map = new Map((this.resp()?.summary ?? []).map((s) => [s.status, s.n]));
    return this.STATUS.map((s) => ({ ...s, n: map.get(s.key) ?? 0 }));
  }

  constructor() {
    this.svc.listWarehouses()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (ws: Warehouse[]) => this.warehouses.set(ws.map((w) => ({ label: `${w.code} · ${w.name}`, value: w.id }))) });
    this.load();
  }

  sev(s: string): 'success' | 'warn' | 'danger' | 'info' {
    if (s === 'sano') return 'success';
    if (s === 'sobrestock') return 'warn';
    if (s === 'nuevo') return 'info';
    return 'danger';
  }

  toggleStatus(s: string) {
    this.statusFilter = this.statusFilter === s ? null : s;
    this.load();
  }

  load() {
    this.loading.set(true);
    this.svc.inventoryHealth(this.whParam(), this.statusFilter || undefined)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.resp.set(r); this.loading.set(false); },
        error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error al cargar salud de inventario' }); },
      });
  }
}
