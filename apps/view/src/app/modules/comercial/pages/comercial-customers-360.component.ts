import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { Subject, debounceTime, distinctUntilChanged } from 'rxjs';
import { ComercialService, ErpCustomerRow, ErpCustomerProduct } from '../comercial.service';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { CUSTOMERS_TABS } from '../customers-tabs';

/**
 * KV.3 — Customer 360 sobre venta real Kepler. Lista de clientes (analytics.erp_customers)
 * con su compra agregada 180d; expandir muestra qué productos compró (90/180d).
 * NO toca commercial.customers.
 */
@Component({
  selector: 'app-comercial-customers-360',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, InputTextModule, ToastModule, PageTabsComponent],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="customerTabs" />

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Clientes 360</h1>
          <p class="surf-page-sub">Qué compra cada cliente (venta real Kepler, 180 días)</p>
        </div>
        <div class="c3-actions">
          <span class="p-input-icon-left">
            <i class="pi pi-search"></i>
            <input pInputText type="text" placeholder="Buscar cliente…" [(ngModel)]="search" (ngModelChange)="search$.next($event)" />
          </span>
          <button pButton icon="pi pi-refresh" [text]="true" severity="secondary" size="small" (click)="load()" [loading]="loading()"></button>
        </div>
      </header>

      <p-table [value]="rows()" [loading]="loading()" dataKey="erp_code" styleClass="p-datatable-sm surf-table"
               [scrollable]="true" scrollHeight="flex" [paginator]="true" [rows]="25" [rowsPerPageOptions]="[25,50,100]">
        <ng-template pTemplate="header">
          <tr>
            <th scope="col" style="width:3rem"></th>
            <th scope="col">Cliente</th><th scope="col">Código</th><th scope="col">RFC</th><th scope="col">Ciudad</th>
            <th scope="col" class="c3-num">Productos</th><th scope="col" class="c3-num">Compra 180d</th><th scope="col">Última</th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-c let-expanded="expanded">
          <tr>
            <td>
              <button type="button" pButton [text]="true" size="small" [icon]="expanded ? 'pi pi-chevron-down' : 'pi pi-chevron-right'"
                      [pRowToggler]="c" (click)="onExpand(c)"></button>
            </td>
            <td class="c3-name">{{ c.name }}</td>
            <td class="c3-mono">{{ c.erp_code }}</td>
            <td class="c3-mono">{{ c.rfc || '—' }}</td>
            <td>{{ c.city || '—' }}</td>
            <td class="c3-num">{{ c.products }}</td>
            <td class="c3-num">{{ c.rev_180d | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
            <td>{{ c.last_purchase ? (c.last_purchase | date:'dd/MM/yy') : '—' }}</td>
          </tr>
        </ng-template>
        <ng-template pTemplate="rowexpansion" let-c>
          <tr>
            <td colspan="8" class="c3-detail">
              @if (productsLoading()) { <div class="c3-loading"><i class="pi pi-spin pi-spinner"></i> Cargando productos…</div> }
              @else {
                <p-table [value]="products()" styleClass="p-datatable-sm" [scrollable]="true" scrollHeight="320px">
                  <ng-template pTemplate="header">
                    <tr><th scope="col">SKU</th><th scope="col">Producto</th>
                      <th scope="col" class="c3-num">U. 90d</th><th scope="col" class="c3-num">$ 90d</th>
                      <th scope="col" class="c3-num">U. 180d</th><th scope="col" class="c3-num">$ 180d</th><th scope="col">Última</th></tr>
                  </ng-template>
                  <ng-template pTemplate="body" let-p>
                    <tr>
                      <td class="c3-mono">{{ p.sku }}</td>
                      <td class="c3-name">{{ p.product_name }}</td>
                      <td class="c3-num">{{ p.units_90d | number:'1.0-0' }}</td>
                      <td class="c3-num">{{ p.revenue_90d | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                      <td class="c3-num">{{ p.units_180d | number:'1.0-0' }}</td>
                      <td class="c3-num">{{ p.revenue_180d | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                      <td>{{ p.last_purchase_date ? (p.last_purchase_date | date:'dd/MM/yy') : '—' }}</td>
                    </tr>
                  </ng-template>
                  <ng-template pTemplate="emptymessage"><tr><td colspan="7" class="c3-muted">Sin compras.</td></tr></ng-template>
                </p-table>
              }
            </td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="8" class="comm-empty-cell">
            <div class="comm-empty"><div class="comm-empty-icon"><i class="pi pi-users" aria-hidden="true"></i></div>
              <h3>Sin clientes</h3><p>No hay clientes con venta real.</p></div>
          </td></tr>
        </ng-template>
      </p-table>
    </div>
  `,
  styles: [`
    .c3-actions { display: flex; gap: .5rem; align-items: center; }
    .c3-mono { font-family: var(--font-mono,monospace); }
    .c3-name { max-width: 260px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .c3-num { text-align: right; font-variant-numeric: tabular-nums; }
    .c3-detail { background: var(--surface-50,var(--c-surface-2)); padding: .75rem 1rem; }
    .c3-loading, .c3-muted { color: var(--text-muted,var(--c-text-2)); padding: .5rem; font-size: .85rem; }
  `],
})
export class ComercialCustomers360Component {
  readonly customerTabs = CUSTOMERS_TABS;
  private readonly svc = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  rows = signal<ErpCustomerRow[]>([]);
  loading = signal(false);
  search = '';
  search$ = new Subject<string>();
  products = signal<ErpCustomerProduct[]>([]);
  productsLoading = signal(false);

  constructor() {
    this.search$
      .pipe(debounceTime(250), distinctUntilChanged(), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.load());
    this.load();
  }

  load() {
    this.loading.set(true);
    this.svc.erpCustomers(this.search || undefined, 200)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.rows.set(r); this.loading.set(false); },
        error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error al cargar clientes' }); },
      });
  }

  onExpand(c: ErpCustomerRow) {
    this.products.set([]);
    this.productsLoading.set(true);
    this.svc.erpCustomerProducts(c.erp_code)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (p) => { this.products.set(p); this.productsLoading.set(false); },
        error: () => { this.productsLoading.set(false); this.toast.add({ severity: 'error', summary: 'Error al cargar productos' }); },
      });
  }
}
