import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { CardModule } from 'primeng/card';
import { SkeletonModule } from 'primeng/skeleton';
import { ButtonModule } from 'primeng/button';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin } from 'rxjs';
import { PortalService, Order, OrderHistoryEntry } from '../portal.service';

@Component({
  selector: 'app-portal-order-detail',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    TableModule,
    TagModule,
    CardModule,
    SkeletonModule,
    ButtonModule,
  ],
  template: `
    <a routerLink="/portal/orders" class="back-link">
      <i class="pi pi-arrow-left"></i> Volver a mis pedidos
    </a>

    <p-skeleton *ngIf="loading()" height="400px"></p-skeleton>

    <ng-container *ngIf="!loading() && order() as o">
      <header class="detail-header">
        <h1>{{ o.code }}</h1>
        <p-tag [value]="o.status" [severity]="statusSeverity(o.status)"></p-tag>
      </header>
      <p class="meta">Creado {{ fmtDate(o.created_at) }}</p>

      <div class="grid">
        <p-card header="Líneas">
          <p-table [value]="o.lines || []" styleClass="p-datatable-sm">
            <ng-template pTemplate="header">
              <tr>
                <th>#</th>
                <th>Producto</th>
                <th class="tr">Qty</th>
                <th class="tr">Precio</th>
                <th class="tr">Total</th>
              </tr>
            </ng-template>
            <ng-template pTemplate="body" let-l>
              <tr>
                <td>{{ l.line_number }}</td>
                <td>{{ l.product_id.slice(0, 8) }}</td>
                <td class="tr">{{ l.quantity }}</td>
                <td class="tr money">{{ fmtMoney(l.unit_price) }}</td>
                <td class="tr money">{{ fmtMoney(l.line_total) }}</td>
              </tr>
            </ng-template>
          </p-table>

          <div class="totals">
            <div class="row"><span>Subtotal</span><b>{{ fmtMoney(o.subtotal) }}</b></div>
            <div class="row"><span>IVA</span><b>{{ fmtMoney(o.tax_total) }}</b></div>
            <div class="row total"><span>Total</span><b>{{ fmtMoney(o.total) }}</b></div>
            <div class="row pending" *ngIf="o.balance_due">
              <span>Saldo pendiente</span><b>{{ fmtMoney(o.balance_due) }}</b>
            </div>
          </div>
        </p-card>

        <p-card header="Historial">
          <ul class="timeline">
            <li *ngFor="let h of history()" class="timeline-item">
              <div class="dot" [class]="'dot-' + h.to_status"></div>
              <div class="content">
                <div class="transition">
                  <span class="from">{{ h.from_status || '—' }}</span>
                  <i class="pi pi-arrow-right"></i>
                  <span class="to">{{ h.to_status }}</span>
                </div>
                <div class="by">
                  por {{ h.changed_by_username || 'sistema' }} —
                  {{ fmtDateTime(h.changed_at) }}
                </div>
                <div class="reason" *ngIf="h.reason">{{ h.reason }}</div>
              </div>
            </li>
            <li *ngIf="history().length === 0" class="empty">Sin historial</li>
          </ul>
        </p-card>
      </div>
    </ng-container>
  `,
  styles: [
    `
      .back-link {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        margin-bottom: 1rem;
        color: var(--primary-color);
        text-decoration: none;
        font-size: 0.875rem;
      }
      .detail-header {
        display: flex;
        gap: 1rem;
        align-items: center;
        margin-bottom: 0.25rem;
      }
      .detail-header h1 { margin: 0; }
      .meta { color: var(--text-color-secondary); margin: 0 0 1.5rem; font-size: 0.875rem; }
      .grid {
        display: grid;
        grid-template-columns: 2fr 1fr;
        gap: 1.5rem;
      }
      .tr { text-align: right; }
      .money { font-variant-numeric: tabular-nums; font-weight: 600; }
      .totals { margin-top: 1.25rem; max-width: 280px; margin-left: auto; }
      .totals .row { display: flex; justify-content: space-between; padding: 0.25rem 0; }
      .totals .total { border-top: 2px solid var(--primary-color); padding-top: 0.5rem; margin-top: 0.5rem; font-size: 1.125rem; }
      .totals .pending { color: var(--orange-500, #f97316); }
      .timeline { list-style: none; padding: 0; margin: 0; }
      .timeline-item {
        display: flex;
        gap: 0.875rem;
        padding: 0.75rem 0;
        border-bottom: 1px solid var(--surface-100);
      }
      .timeline-item:last-child { border-bottom: none; }
      .dot {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        margin-top: 0.375rem;
        flex-shrink: 0;
        background: var(--primary-color);
      }
      .dot-draft { background: var(--orange-500, #f97316); }
      .dot-confirmed { background: var(--blue-500, #3b82f6); }
      .dot-fulfilled { background: var(--green-500, #22c55e); }
      .dot-cancelled { background: var(--red-500, #ef4444); }
      .transition { font-weight: 600; }
      .from { color: var(--text-color-secondary); }
      .by { font-size: 0.75rem; color: var(--text-color-secondary); margin-top: 0.125rem; }
      .reason { font-size: 0.8rem; margin-top: 0.25rem; font-style: italic; }
      .empty { color: var(--text-color-secondary); text-align: center; padding: 1rem; }
      @media (max-width: 900px) {
        .grid { grid-template-columns: 1fr; }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PortalOrderDetailComponent implements OnInit {
  private readonly api = inject(PortalService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  readonly loading = signal(true);
  readonly order = signal<Order | null>(null);
  readonly history = signal<OrderHistoryEntry[]>([]);

  ngOnInit(): void {
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) return;
    forkJoin({
      order: this.api.orderById(id),
      history: this.api.orderHistory(id),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ order, history }) => {
          this.order.set(order);
          this.history.set(history);
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
  fmtDateTime(s: string): string {
    return new Date(s).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' } as any);
  }
}
