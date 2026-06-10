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
import { Router, RouterLink } from '@angular/router';
import { CardModule } from 'primeng/card';
import { TagModule } from 'primeng/tag';
import { SkeletonModule } from 'primeng/skeleton';
import { ButtonModule } from 'primeng/button';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { VendorService } from '../vendor.service';
import { Order } from '../../portal/portal.service';

@Component({
  selector: 'app-vendor-today',
  standalone: true,
  imports: [CommonModule, RouterLink, CardModule, TagModule, SkeletonModule, ButtonModule],
  template: `
    <h1 class="page-title">Mi día</h1>
    <p class="subtitle">Pedidos tomados hoy</p>

    <div class="kpis" *ngIf="!loading()">
      <p-card styleClass="kpi-card">
        <div class="kpi-content">
          <div class="value">{{ orders().length }}</div>
          <div class="label">Pedidos</div>
        </div>
      </p-card>
      <p-card styleClass="kpi-card">
        <div class="kpi-content">
          <div class="value">{{ fmtMoney(totalRevenue()) }}</div>
          <div class="label">Ventas</div>
        </div>
      </p-card>
      <p-card styleClass="kpi-card">
        <div class="kpi-content">
          <div class="value">{{ fulfilledCount() }}</div>
          <div class="label">Entregados</div>
        </div>
      </p-card>
    </div>

    <p-skeleton *ngIf="loading()" height="400px"></p-skeleton>

    <p-card *ngIf="!loading() && orders().length === 0">
      <div class="empty">
        <i class="pi pi-calendar"></i>
        <p>Aún no has tomado pedidos hoy.</p>
        <a
          pButton
          label="Tomar un pedido"
          icon="pi pi-arrow-right"
          severity="secondary"
          [text]="true"
          routerLink="/vendor/new-order"
        ></a>
      </div>
    </p-card>

    <div *ngIf="!loading() && orders().length > 0" class="order-list">
      <p-card
        *ngFor="let o of orders()"
        styleClass="order-card"
        (click)="goToOrder(o)"
      >
        <div class="order-row">
          <div class="info">
            <div class="code">{{ o.code }}</div>
            <div class="time">{{ fmtTime(o.created_at) }}</div>
          </div>
          <div class="totals">
            <p-tag [value]="o.status" [severity]="statusSeverity(o.status)"></p-tag>
            <div class="total">{{ fmtMoney(o.total) }}</div>
          </div>
        </div>
      </p-card>
    </div>
  `,
  styles: [
    `
      .page-title { margin: 0 0 0.25rem; font-size: 1.5rem; color: var(--text-main); }
      .subtitle { margin: 0 0 1rem; color: var(--text-muted); font-size: 0.875rem; }
      .kpis {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 0.5rem;
        margin-bottom: 1rem;
      }
      :host ::ng-deep .p-card.kpi-card {
        background: var(--card-bg);
        border: 1px solid var(--border-color);
      }
      :host ::ng-deep .p-card.kpi-card .p-card-body { padding: 0.75rem; }
      :host ::ng-deep .p-card.kpi-card .p-card-content { padding: 0; }
      .kpi-content { text-align: center; }
      .kpi-content .value {
        font-size: 1.25rem;
        font-weight: 700;
        color: var(--text-main);
      }
      .kpi-content .label {
        font-size: 0.7rem;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .empty {
        text-align: center;
        padding: 1.5rem 1rem;
        color: var(--text-muted);
      }
      .empty i { font-size: 2.5rem; display: block; margin-bottom: 0.5rem; }
      .empty p { margin: 0 0 1rem; }
      .order-list {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      :host ::ng-deep .p-card.order-card {
        cursor: pointer;
        transition: box-shadow 0.15s;
        background: var(--card-bg);
        border: 1px solid var(--border-color);
      }
      :host ::ng-deep .p-card.order-card:hover { box-shadow: 0 4px 8px rgba(0,0,0,0.08); }
      :host ::ng-deep .p-card.order-card .p-card-body { padding: 0.875rem; }
      :host ::ng-deep .p-card.order-card .p-card-content { padding: 0; }
      .order-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 1rem;
      }
      .info { min-width: 0; }
      .code { font-weight: 700; color: var(--text-main); }
      .time { font-size: 0.75rem; color: var(--text-muted); }
      .totals {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 0.25rem;
      }
      .total {
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        color: var(--text-main);
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VendorTodayComponent implements OnInit {
  private readonly api = inject(VendorService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);

  readonly loading = signal(true);
  readonly orders = signal<Order[]>([]);

  readonly totalRevenue = computed(() =>
    this.orders()
      .filter((o) => o.status === 'fulfilled' || o.status === 'confirmed')
      .reduce((s, o) => s + Number(o.total), 0),
  );
  readonly fulfilledCount = computed(
    () => this.orders().filter((o) => o.status === 'fulfilled').length,
  );

  ngOnInit(): void {
    this.api
      .myOrdersToday()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (orders) => {
          this.orders.set(orders);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });
  }

  goToOrder(o: Order): void {
    this.router.navigate(['/vendor/take-order', o.customer_id]);
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
  fmtTime(s: string): string {
    return new Date(s).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  }
}
