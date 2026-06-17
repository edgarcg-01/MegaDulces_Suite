import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { SkeletonModule } from 'primeng/skeleton';
import { environment } from '../../../../environments/environment';

/** Customer 360 (feature store, Fase M) — RFM + cadencia + lifecycle. */
export interface Customer360 {
  customer_id: string;
  orders_count: number;
  first_order_at: string | null;
  last_order_at: string | null;
  recency_days: number | null;
  frequency_90d: number;
  monetary_90d: number;
  aov: number;
  cadence_days: number | null;
  next_order_estimate: string | null;
  lifecycle_stage: string;
  computed_at: string;
}

/**
 * Panel de 360° del cliente — reusable en Command Center, Vendor, Pedidos.
 * Autocontenido: recibe `customerId` y resuelve el fetch + loading + empty.
 * `revenue30d` opcional muestra el chip "Ventas 30d" (lo pasa Command Center;
 * Vendor/Pedidos lo omiten). Pensado para ir dentro de un <app-side-peek>.
 */
@Component({
  selector: 'app-customer-360-panel',
  standalone: true,
  imports: [CommonModule, SkeletonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (loading()) {
      <div class="c3-loading">
        <p-skeleton height="64px" borderRadius="12px"></p-skeleton>
        <p-skeleton height="180px" borderRadius="12px"></p-skeleton>
      </div>
    } @else if (data()) {
      @let c = data()!;
      <div class="c3-top">
        <span class="c3-pill" [class]="lifecyclePillClass(c.lifecycle_stage)">
          {{ lifecycleLabel(c.lifecycle_stage) }}
        </span>
        @if (revenue30d() != null) {
          <span class="c3-rev">
            <span class="c3-rev-label">Ventas 30d</span>
            <b>{{ fmtMoney(revenue30d()) }}</b>
          </span>
        }
      </div>

      <div class="c3-grid">
        <div class="c3-metric">
          <span class="c3-label">Pedidos (histórico)</span>
          <span class="c3-val">{{ fmtNumber(c.orders_count) }}</span>
        </div>
        <div class="c3-metric">
          <span class="c3-label">Recencia</span>
          <span class="c3-val">{{ c.recency_days !== null ? fmtNumber(c.recency_days) + 'd' : '—' }}</span>
        </div>
        <div class="c3-metric">
          <span class="c3-label">Frecuencia 90d</span>
          <span class="c3-val">{{ fmtNumber(c.frequency_90d) }}</span>
        </div>
        <div class="c3-metric">
          <span class="c3-label">Monto 90d</span>
          <span class="c3-val">{{ fmtMoneyShort(c.monetary_90d) }}</span>
        </div>
        <div class="c3-metric">
          <span class="c3-label">Ticket prom.</span>
          <span class="c3-val">{{ fmtMoneyShort(c.aov) }}</span>
        </div>
        <div class="c3-metric">
          <span class="c3-label">Cadencia</span>
          <span class="c3-val">{{ c.cadence_days !== null ? 'c/' + fmtNumber(c.cadence_days) + 'd' : '—' }}</span>
        </div>
      </div>

      @if (c.next_order_estimate) {
        <div class="c3-next">
          <i class="pi pi-calendar" aria-hidden="true"></i>
          <span>Próximo pedido estimado: <b>{{ fmtDate(c.next_order_estimate) }}</b></span>
        </div>
      }

      <div class="c3-foot">
        Último pedido {{ fmtDate(c.last_order_at) }} · cliente desde {{ fmtDate(c.first_order_at) }}
      </div>
    } @else {
      <div class="c3-empty">
        <i class="pi pi-inbox" aria-hidden="true"></i>
        <span>Sin datos de 360° para este cliente todavía.</span>
      </div>
    }
  `,
  styles: [
    `
      .c3-loading {
        display: flex;
        flex-direction: column;
        gap: 1rem;
      }
      .c3-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        margin-bottom: 1.25rem;
      }
      .c3-pill {
        display: inline-flex;
        align-items: center;
        padding: 0.25rem 0.625rem;
        border-radius: var(--r-pill, 999px);
        font-size: var(--fs-micro, 0.6875rem);
        font-weight: var(--fw-bold, 700);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .c3-pill.is-active {
        background: var(--ok-soft-bg);
        color: var(--ok-soft-fg);
      }
      .c3-pill.is-info {
        background: var(--info-soft-bg);
        color: var(--info-soft-fg);
      }
      .c3-pill.is-warn {
        background: var(--warn-soft-bg);
        color: var(--warn-soft-fg);
      }
      .c3-pill.is-bad {
        background: var(--bad-soft-bg);
        color: var(--bad-soft-fg);
      }
      .c3-pill.is-neutral {
        background: var(--neutral-100);
        color: var(--text-muted);
      }
      .c3-rev {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
      }
      .c3-rev-label {
        font-size: var(--fs-xs, 0.75rem);
        color: var(--text-muted);
      }
      .c3-rev b {
        font-family: var(--font-mono);
        font-size: var(--fs-h3, 1rem);
        font-weight: var(--fw-bold, 700);
        color: var(--text-main);
        font-variant-numeric: tabular-nums;
      }
      .c3-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 1px;
        background: var(--border-color);
        border: 1px solid var(--border-color);
        border-radius: var(--r-md, 12px);
        overflow: hidden;
      }
      .c3-metric {
        background: var(--card-bg);
        padding: 0.875rem 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
      }
      .c3-label {
        font-size: var(--fs-micro, 0.6875rem);
        font-weight: var(--fw-bold, 700);
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-muted);
      }
      .c3-val {
        font-family: var(--font-mono);
        font-size: var(--fs-h3, 1rem);
        font-weight: var(--fw-bold, 700);
        color: var(--text-main);
        font-variant-numeric: tabular-nums;
      }
      .c3-next {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin-top: 1.25rem;
        padding: 0.75rem 1rem;
        border-radius: var(--r-md, 12px);
        background: var(--ember-soft);
        border: 1px solid var(--ember-border);
        font-size: var(--fs-sm, 0.8125rem);
        color: var(--text-main);
      }
      .c3-next b {
        font-family: var(--font-mono);
      }
      .c3-foot {
        margin-top: 1.25rem;
        font-size: var(--fs-xs, 0.75rem);
        color: var(--text-muted);
      }
      .c3-empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.5rem;
        padding: 2.5rem 1rem;
        color: var(--text-muted);
        text-align: center;
      }
      .c3-empty i {
        font-size: var(--fs-h2, 1.25rem);
        opacity: 0.5;
      }
    `,
  ],
})
export class Customer360PanelComponent {
  /** ID del cliente; al cambiar (no-null) dispara el fetch del 360°. */
  readonly customerId = input<string | null>(null);
  /** Ventas 30d opcional (chip de cabecera). Si es null, no se muestra. */
  readonly revenue30d = input<number | null>(null);

  readonly data = signal<Customer360 | null>(null);
  readonly loading = signal(false);

  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/intelligence`;
  private lastId: string | null = null;

  constructor() {
    effect(() => {
      const id = this.customerId();
      if (!id || id === this.lastId) return;
      this.lastId = id;
      this.fetch(id);
    });
  }

  private fetch(id: string): void {
    this.data.set(null);
    this.loading.set(true);
    this.http.get<Customer360>(`${this.base}/customer-360/${id}`).subscribe({
      next: (c) => {
        this.data.set(c);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  lifecyclePillClass(stage: string | null | undefined): string {
    switch (stage) {
      case 'vip':
      case 'active':
        return 'is-active';
      case 'new':
        return 'is-info';
      case 'at_risk':
        return 'is-warn';
      case 'churned':
      case 'lost':
        return 'is-bad';
      default:
        return 'is-neutral';
    }
  }

  lifecycleLabel(stage: string | null | undefined): string {
    const map: Record<string, string> = {
      vip: 'VIP',
      active: 'Activo',
      new: 'Nuevo',
      at_risk: 'En riesgo',
      churned: 'Perdido',
      lost: 'Perdido',
    };
    return (stage && map[stage]) || stage || '—';
  }

  fmtMoney(n: number | null | undefined): string {
    if (n === null || n === undefined) return '—';
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: 'MXN',
      maximumFractionDigits: 2,
    }).format(Number(n));
  }

  fmtMoneyShort(n: number | null | undefined): string {
    if (n === null || n === undefined) return '—';
    const v = Number(n);
    if (Math.abs(v) >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
    if (Math.abs(v) >= 1e3) return '$' + (v / 1e3).toFixed(2) + 'K';
    return '$' + v.toFixed(0);
  }

  fmtNumber(n: number | null | undefined, decimals = 0): string {
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
}
