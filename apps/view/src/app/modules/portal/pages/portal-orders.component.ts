import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule, CurrencyPipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { SkeletonModule } from 'primeng/skeleton';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { PortalService, Order } from '../portal.service';

type StatusFilter = 'all' | 'draft' | 'confirmed' | 'fulfilled' | 'cancelled';

interface FilterChip {
  key: StatusFilter;
  label: string;
}

@Component({
  selector: 'app-portal-orders',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    CurrencyPipe,
    ButtonModule,
    SkeletonModule,
  ],
  template: `
    <header class="portal-page-head">
      <div class="portal-page-head-text">
        <span class="portal-eyebrow">
          <i class="pi pi-history" aria-hidden="true"></i>
          Historial
        </span>
        <h1>Mis pedidos</h1>
        <p class="portal-page-sub" *ngIf="orders().length > 0">
          {{ orders().length }} pedido{{ orders().length === 1 ? '' : 's' }} en total
        </p>
      </div>
      <button
        type="button"
        class="portal-btn-primary"
        (click)="goCatalog()"
      >
        <i class="pi pi-plus" aria-hidden="true"></i>
        Nuevo pedido
      </button>
    </header>

    <p-skeleton *ngIf="loading()" height="400px"></p-skeleton>

    <!-- Empty -->
    <div *ngIf="!loading() && orders().length === 0" class="portal-empty">
      <div class="portal-empty-icon"><i class="pi pi-inbox" aria-hidden="true"></i></div>
      <h2>Sin pedidos aún</h2>
      <p>Cuando hagas tu primer pedido, lo verás acá.</p>
      <div class="portal-empty-actions">
        <button type="button" class="portal-btn-primary" (click)="goCatalog()">
          <i class="pi pi-arrow-right" aria-hidden="true"></i>
          Explorar catálogo
        </button>
      </div>
    </div>

    <!-- Filters + list -->
    <ng-container *ngIf="!loading() && orders().length > 0">
      <div class="po-filters" role="tablist" aria-label="Filtrar por estado">
        <button
          *ngFor="let f of filters"
          type="button"
          class="po-filter"
          [class.active]="statusFilter() === f.key"
          (click)="setFilter(f.key)"
          role="tab"
          [attr.aria-selected]="statusFilter() === f.key"
        >
          {{ f.label }}
          <span class="po-filter-count">{{ countByStatus(f.key) }}</span>
        </button>
      </div>

      <div *ngIf="visibleOrders().length === 0" class="po-no-match">
        <i [class]="emptyIcon()"></i>
        <p>{{ emptyMessage() }}</p>
        <button
          *ngIf="statusFilter() !== 'all'"
          type="button"
          class="po-no-match-btn"
          (click)="setFilter('all')"
        >
          <i class="pi pi-list"></i>
          Ver todos los pedidos
        </button>
      </div>

      <div class="po-list" *ngIf="visibleOrders().length > 0">
        <a
          *ngFor="let o of visibleOrders(); trackBy: trackByOrder"
          class="po-card"
          [class]="'po-card-status-' + o.status"
          [routerLink]="['/portal/orders', o.id]"
        >
          <div class="po-card-body">
            <div class="po-card-top">
              <span class="po-card-code">{{ o.code }}</span>
              <span class="portal-status-pill" [class]="'is-' + o.status">
                {{ statusLabel(o.status) }}
              </span>
            </div>
            <div class="po-card-date">
              <i class="pi pi-calendar"></i>
              {{ fmtDate(o.created_at) }}
            </div>
            <div class="po-card-amounts">
              <span class="po-amount-row">
                <span class="po-amount-label">Subtotal</span>
                <span>{{ +o.subtotal | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
              </span>
              <span class="po-amount-row">
                <span class="po-amount-label">IVA</span>
                <span>{{ +o.tax_total | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
              </span>
            </div>
          </div>

          <div class="po-card-total">
            <span class="po-total-label">Total</span>
            <b>{{ +o.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</b>
            <button
              *ngIf="o.status !== 'draft'"
              type="button"
              class="po-reorder"
              [disabled]="reorderingId() === o.id"
              (click)="reorder(o, $event)"
              [attr.aria-label]="'Repetir pedido ' + o.code"
            >
              <i [class]="reorderingId() === o.id ? 'pi pi-spin pi-spinner' : 'pi pi-replay'"></i>
              {{ reorderingId() === o.id ? 'Agregando…' : 'Repetir' }}
            </button>
          </div>
        </a>
      </div>
    </ng-container>
  `,
  styles: [
    `
      :host { display: block; }

      .po-filters {
        display: flex;
        gap: 0.375rem;
        margin-bottom: 1rem;
        overflow-x: auto;
        padding-bottom: 0.25rem;
      }
      .po-filters::-webkit-scrollbar { display: none; }
      .po-filter {
        flex-shrink: 0;
        background: var(--card-bg);
        border: 1.5px solid var(--border-color);
        border-radius: 999px;
        padding: 0.375rem 0.75rem;
        font-size: 0.8125rem;
        font-weight: 600;
        color: var(--text-muted);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        transition: all 150ms var(--ease-standard);
      }
      .po-filter:hover {
        border-color: var(--neutral-400);
        color: var(--text-main);
      }
      .po-filter.active {
        background: var(--neutral-900);
        border-color: var(--neutral-900);
        color: #fff;
      }
      .po-filter-count {
        background: var(--neutral-100);
        color: var(--text-muted);
        font-size: 0.7rem;
        font-weight: 700;
        padding: 0.1rem 0.45rem;
        border-radius: 999px;
        font-variant-numeric: tabular-nums;
      }
      .po-filter.active .po-filter-count {
        background: rgba(255,255,255,0.22);
        color: #fff;
      }

      .po-no-match {
        text-align: center;
        padding: 2.25rem 1rem;
        background: var(--card-bg);
        border: 1px dashed var(--border-color);
        border-radius: 12px;
        color: var(--text-muted);
      }
      .po-no-match i {
        font-size: 1.875rem;
        display: block;
        margin-bottom: 0.5rem;
        color: var(--text-faint);
      }
      .po-no-match p {
        margin: 0 0 1rem;
        font-size: 0.9375rem;
      }
      .po-no-match-btn {
        background: transparent;
        border: 1.5px solid var(--border-color);
        color: var(--text-main);
        font-weight: 600;
        font-size: 0.8125rem;
        padding: 0.5rem 0.875rem;
        border-radius: 10px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        transition: background-color 150ms var(--ease-standard), border-color 150ms var(--ease-standard);
      }
      .po-no-match-btn:hover {
        background: var(--neutral-100);
        border-color: var(--neutral-400);
      }

      .po-list {
        display: flex;
        flex-direction: column;
        gap: 0.625rem;
      }

      .po-card {
        position: relative;
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 1rem;
        align-items: center;
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: 14px;
        padding: 1rem 1rem 1rem 1.25rem;
        text-decoration: none;
        color: inherit;
        overflow: hidden;
        transition: border-color 150ms var(--ease-standard), transform 180ms var(--ease-standard), box-shadow 200ms var(--ease-standard);
      }
      .po-card::before {
        content: '';
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: 4px;
        background: var(--neutral-300);
      }
      .po-card-status-draft::before     { background: var(--warn-fg); }
      .po-card-status-confirmed::before { background: var(--info-fg); }
      .po-card-status-fulfilled::before { background: var(--ok-fg); }
      .po-card-status-cancelled::before { background: var(--bad-fg); }
      .po-card:hover {
        border-color: var(--neutral-300);
        transform: translateY(-2px);
        box-shadow: 0 12px 22px -10px rgba(0,0,0,0.1);
      }
      @media (max-width: 640px) {
        .po-card {
          grid-template-columns: 1fr;
          row-gap: 0.75rem;
        }
        .po-card-total {
          padding-top: 0.75rem;
          border-top: 1px solid var(--border-color);
          flex-direction: row !important;
          align-items: center !important;
          justify-content: space-between !important;
          text-align: left !important;
        }
      }

      .po-card-body {
        display: flex;
        flex-direction: column;
        gap: 0.375rem;
        min-width: 0;
      }
      .po-card-top {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        flex-wrap: wrap;
      }
      .po-card-code {
        font-weight: 800;
        font-size: 0.9375rem;
        color: var(--text-main);
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.01em;
      }
      .po-card-date {
        font-size: 0.75rem;
        color: var(--text-muted);
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
      }
      .po-card-amounts {
        display: flex;
        gap: 0.75rem;
        font-size: 0.75rem;
        color: var(--text-muted);
        margin-top: 0.125rem;
        font-variant-numeric: tabular-nums;
      }
      .po-amount-row {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
      }
      .po-amount-label {
        font-weight: 600;
        opacity: 0.7;
      }

      .po-card-total {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 0.125rem;
        text-align: right;
        min-width: 130px;
      }
      .po-total-label {
        font-size: 0.625rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        font-weight: 700;
        color: var(--text-faint);
      }
      .po-card-total b {
        font-size: 1.25rem;
        font-weight: 800;
        color: var(--text-main);
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.01em;
      }
      .po-card-arrow {
        font-size: 0.7rem;
        font-weight: 600;
        color: var(--text-faint);
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        margin-top: 0.125rem;
        transition: color 150ms var(--ease-standard), transform 150ms var(--ease-standard);
      }
      .po-card:hover .po-card-arrow {
        color: var(--text-main);
        transform: translateX(2px);
      }

      .po-reorder {
        margin-top: 0.5rem;
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0.4rem 0.75rem;
        border: 1.5px solid var(--action, var(--brand-700));
        background: transparent;
        color: var(--action, var(--brand-700));
        border-radius: 999px;
        font-family: var(--font-body);
        font-size: 0.75rem;
        font-weight: 700;
        cursor: pointer;
        transition: background-color 150ms var(--ease-standard), color 150ms var(--ease-standard);
      }
      .po-reorder:hover:not(:disabled) {
        background: var(--action, var(--brand-700));
        color: #fff;
      }
      .po-reorder:disabled { opacity: 0.6; cursor: progress; }
      .po-reorder i { font-size: 0.75rem; }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PortalOrdersComponent implements OnInit {
  private readonly api = inject(PortalService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly loading = signal(true);
  readonly orders = signal<Order[]>([]);
  readonly statusFilter = signal<StatusFilter>('all');

  readonly filters: FilterChip[] = [
    { key: 'all', label: 'Todos' },
    { key: 'draft', label: 'Borradores' },
    { key: 'confirmed', label: 'Confirmados' },
    { key: 'fulfilled', label: 'Entregados' },
    { key: 'cancelled', label: 'Cancelados' },
  ];

  readonly visibleOrders = computed(() => {
    const f = this.statusFilter();
    if (f === 'all') return this.orders();
    return this.orders().filter((o) => o.status === f);
  });

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

  setFilter(f: StatusFilter): void {
    this.statusFilter.set(f);
  }

  countByStatus(key: StatusFilter): number {
    if (key === 'all') return this.orders().length;
    return this.orders().filter((o) => o.status === key).length;
  }

  emptyIcon(): string {
    const m: Record<StatusFilter, string> = {
      all: 'pi pi-inbox',
      draft: 'pi pi-pencil',
      confirmed: 'pi pi-check-circle',
      fulfilled: 'pi pi-truck',
      cancelled: 'pi pi-times-circle',
    };
    return m[this.statusFilter()] || 'pi pi-inbox';
  }

  emptyMessage(): string {
    const m: Record<StatusFilter, string> = {
      all: 'No hay pedidos.',
      draft: 'No tenés borradores abiertos. Andá al catálogo para empezar uno.',
      confirmed: 'No hay pedidos confirmados esperando entrega.',
      fulfilled: 'Todavía no tenés pedidos entregados.',
      cancelled: 'No hay pedidos cancelados. ¡Buena noticia!',
    };
    return m[this.statusFilter()] || 'No hay pedidos en este estado.';
  }

  goCatalog(): void {
    this.router.navigateByUrl('/portal/catalog');
  }

  /** Pedido cuyo reorder está en vuelo (para spinner por-card). */
  readonly reorderingId = signal<string | null>(null);

  /**
   * Repetir en 1 tap desde la lista. El card es un <a> a /orders/:id, así que
   * frenamos la navegación para clonar el pedido al carrito y llevar al cart.
   */
  reorder(o: Order, ev: Event): void {
    ev.preventDefault();
    ev.stopPropagation();
    if (this.reorderingId()) return;
    this.reorderingId.set(o.id);
    this.api.reorder(o).subscribe({
      next: ({ added }) => {
        this.reorderingId.set(null);
        if (added > 0) this.router.navigate(['/portal/cart']);
      },
      error: () => this.reorderingId.set(null),
    });
  }

  trackByOrder = (_i: number, o: Order) => o.id;

  statusLabel(s: string): string {
    const m: Record<string, string> = {
      draft: 'Borrador',
      pending_approval: 'Esperando confirmación',
      confirmed: 'Confirmado',
      fulfilled: 'Entregado',
      cancelled: 'Cancelado',
    };
    return m[s] || s;
  }

  statusIcon(s: string): string {
    const m: Record<string, string> = {
      draft: 'pi pi-pencil',
      pending_approval: 'pi pi-hourglass',
      confirmed: 'pi pi-check',
      fulfilled: 'pi pi-truck',
      cancelled: 'pi pi-times',
    };
    return m[s] || 'pi pi-circle';
  }

  fmtDate(s: string): string {
    return new Date(s).toLocaleDateString('es-MX', { dateStyle: 'medium' } as any);
  }
}
