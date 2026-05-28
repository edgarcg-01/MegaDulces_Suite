import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SkeletonModule } from 'primeng/skeleton';
import { CardModule } from 'primeng/card';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { PortalService, Order } from '../portal.service';

@Component({
  selector: 'app-portal-orders',
  standalone: true,
  imports: [CommonModule, RouterLink, TableModule, TagModule, SkeletonModule, CardModule],
  template: `
    <h1 class="page-title">Mis pedidos</h1>
    <p-skeleton *ngIf="loading()" height="400px"></p-skeleton>

    <p-card *ngIf="!loading() && orders().length === 0">
      <div class="empty">
        <i class="pi pi-inbox"></i>
        <p>Aún no has realizado pedidos.</p>
      </div>
    </p-card>

    <p-table
      *ngIf="!loading() && orders().length > 0"
      [value]="orders()"
      styleClass="p-datatable-sm"
    >
      <ng-template pTemplate="header">
        <tr>
          <th>Código</th>
          <th>Estado</th>
          <th>Fecha</th>
          <th class="tr">Subtotal</th>
          <th class="tr">IVA</th>
          <th class="tr">Total</th>
          <th></th>
        </tr>
      </ng-template>
      <ng-template pTemplate="body" let-o>
        <tr>
          <td><b>{{ o.code }}</b></td>
          <td>
            <p-tag [value]="o.status" [severity]="statusSeverity(o.status)"></p-tag>
          </td>
          <td>{{ fmtDate(o.created_at) }}</td>
          <td class="tr money">{{ fmtMoney(o.subtotal) }}</td>
          <td class="tr money">{{ fmtMoney(o.tax_total) }}</td>
          <td class="tr money total">{{ fmtMoney(o.total) }}</td>
          <td class="tr">
            <a
              [routerLink]="['/portal/orders', o.id]"
              class="pi pi-arrow-right"
              title="Ver detalle"
            ></a>
          </td>
        </tr>
      </ng-template>
    </p-table>
  `,
  styles: [
    `
      .page-title { margin: 0 0 1rem; }
      .empty { text-align: center; padding: 2rem; color: var(--text-color-secondary); }
      .empty i { font-size: 3rem; display: block; margin-bottom: 1rem; }
      .tr { text-align: right; }
      .money { font-variant-numeric: tabular-nums; }
      .total { font-weight: 700; }
      a.pi { color: var(--primary-color); text-decoration: none; padding: 0.25rem; }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PortalOrdersComponent implements OnInit {
  private readonly api = inject(PortalService);
  private readonly destroyRef = inject(DestroyRef);

  readonly loading = signal(true);
  readonly orders = signal<Order[]>([]);

  ngOnInit(): void {
    this.api
      .myOrders({ pageSize: 100 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.orders.set(r.data || []);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });
  }

  statusSeverity(s: string): 'info' | 'warn' | 'success' | 'danger' | 'secondary' {
    switch (s) {
      case 'fulfilled': return 'success';
      case 'confirmed': return 'info';
      case 'draft': return 'warn';
      case 'cancelled': return 'danger';
      default: return 'secondary';
    }
  }

  fmtMoney(n: any): string {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(n) || 0);
  }
  fmtDate(s: string): string {
    return new Date(s).toLocaleDateString('es-MX', { dateStyle: 'medium' } as any);
  }
}
