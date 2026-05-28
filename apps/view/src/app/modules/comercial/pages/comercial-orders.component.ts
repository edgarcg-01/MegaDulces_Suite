import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { ComercialService, Order, OrderStatus } from '../comercial.service';

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
  ],
  providers: [MessageService],
  template: `
    <p-toast></p-toast>

    <div class="header-row">
      <div>
        <h2>Pedidos</h2>
        <p class="muted">{{ total() }} pedidos. Filtros aplicados en servidor.</p>
      </div>
    </div>

    <p-card>
      <div class="filters">
        <label>
          Estado
          <p-select
            [options]="statusOptions"
            [(ngModel)]="statusFilter"
            (onChange)="reload()"
            placeholder="Todos"
            optionLabel="label"
            optionValue="value"
            [showClear]="true"
            styleClass="filter-select"
          ></p-select>
        </label>
      </div>

      <p-table
        [value]="rows()"
        [loading]="loading()"
        [lazy]="true"
        [paginator]="true"
        [rows]="pageSize()"
        [totalRecords]="total()"
        [first]="(page() - 1) * pageSize()"
        (onLazyLoad)="onLazyLoad($event)"
        responsiveLayout="scroll"
        styleClass="p-datatable-sm"
        [rowHover]="true"
      >
        <ng-template pTemplate="header">
          <tr>
            <th>Folio</th>
            <th>Cliente</th>
            <th>Almacén</th>
            <th>Estado</th>
            <th>Entrega</th>
            <th class="num">Total</th>
            <th>Fecha</th>
            <th>Vendedor</th>
            <th></th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-o>
          <tr (click)="goDetail(o)" class="row-clickable">
            <td><code>{{ o.folio }}</code></td>
            <td>{{ o.customer_name || o.customer_id }}</td>
            <td>{{ o.warehouse_name || '—' }}</td>
            <td>
              <p-tag [severity]="severity(o.status)" [value]="statusLabel(o.status)"></p-tag>
            </td>
            <td>
              <p-tag
                [severity]="o.delivery_type === 'long_trip' ? 'warn' : 'info'"
                [value]="o.delivery_type === 'long_trip' ? 'Viaje largo' : 'Por ruta'"
              ></p-tag>
            </td>
            <td class="num strong">{{ o.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
            <td>{{ o.created_at | date:'short' }}</td>
            <td>{{ o.user_username || '—' }}</td>
            <td class="actions">
              <button pButton icon="pi pi-eye" size="small" severity="secondary" [text]="true" (click)="$event.stopPropagation(); goDetail(o)"></button>
            </td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="9" class="muted">Sin pedidos en este filtro.</td></tr>
        </ng-template>
      </p-table>
    </p-card>
  `,
  styles: [`
    :host { display:block; }
    .header-row h2 { margin:0 0 .25rem; font-size:1.25rem; }
    .muted { color: var(--text-color-secondary); font-size:.85rem; margin:0 0 1rem; }
    .filters { display:flex; gap:1rem; align-items:flex-end; margin-bottom:1rem; flex-wrap:wrap; }
    .filters label { display:flex; flex-direction:column; gap:.25rem; font-size:.8rem; color:var(--text-color-secondary); }
    :host ::ng-deep .p-select.filter-select { min-width: 180px; }
    .num { text-align:right; }
    .num.strong { font-weight: 600; }
    .actions { display:flex; gap:.25rem; justify-content:flex-end; }
    .row-clickable { cursor: pointer; }
    code { background: var(--surface-100); padding:.15rem .4rem; border-radius:4px; font-size:.85rem; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComercialOrdersComponent {
  private readonly api = inject(ComercialService);
  private readonly router = inject(Router);
  private readonly toast = inject(MessageService);

  readonly rows = signal<Order[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly pageSize = signal(15);
  readonly loading = signal(false);
  statusFilter: OrderStatus | null = null;

  readonly statusOptions: { label: string; value: OrderStatus }[] = [
    { label: 'Borrador', value: 'draft' },
    { label: 'Confirmado', value: 'confirmed' },
    { label: 'Entregado', value: 'fulfilled' },
    { label: 'Cancelado', value: 'cancelled' },
  ];

  constructor() {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.api
      .listOrders({
        status: this.statusFilter || undefined,
        page: this.page(),
        pageSize: this.pageSize(),
      })
      .subscribe({
        next: (r) => {
          this.rows.set(r.data || []);
          this.total.set(r.pagination?.total || 0);
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
          this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar pedidos' });
        },
      });
  }

  reload(): void {
    this.page.set(1);
    this.load();
  }

  onLazyLoad(e: { first?: number | null; rows?: number | null }): void {
    const first = e.first ?? 0;
    const rows = e.rows ?? this.pageSize();
    this.page.set(Math.floor(first / rows) + 1);
    this.pageSize.set(rows);
    this.load();
  }

  goDetail(o: Order): void {
    this.router.navigate(['/comercial/orders', o.id]);
  }

  severity(s: OrderStatus): 'info' | 'success' | 'warn' | 'danger' {
    if (s === 'fulfilled') return 'success';
    if (s === 'confirmed') return 'info';
    if (s === 'cancelled') return 'danger';
    return 'warn';
  }
  statusLabel(s: OrderStatus): string {
    return { draft: 'Borrador', confirmed: 'Confirmado', fulfilled: 'Entregado', cancelled: 'Cancelado' }[s];
  }
}
