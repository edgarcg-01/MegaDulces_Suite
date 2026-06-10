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
import { SkeletonModule } from 'primeng/skeleton';
import { ButtonModule } from 'primeng/button';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { VendorService } from '../vendor.service';
import { Order } from '../../portal/portal.service';

/** Mi día — resumen del día del vendedor (rediseño Mercado): mini-hero con KPIs + lista de pedidos. */
@Component({
  selector: 'app-vendor-today',
  standalone: true,
  imports: [CommonModule, RouterLink, CardModule, SkeletonModule, ButtonModule],
  template: `
    <section class="hero" *ngIf="!loading()">
      <div class="hero-h">
        <div class="ey">Hoy · {{ todayLabel() }}</div>
        <h1>Mi día</h1>
      </div>
      <div class="kpis">
        <div class="kpi"><div class="v">{{ orders().length }}</div><div class="l">Pedidos</div></div>
        <div class="kpi hl"><div class="v">{{ fmtMoney(totalRevenue()) }}</div><div class="l">Vendido</div></div>
        <div class="kpi"><div class="v">{{ fulfilledCount() }}</div><div class="l">Entregados</div></div>
      </div>
    </section>

    <div class="body-pad">
      <p-skeleton *ngIf="loading()" height="400px"></p-skeleton>

      <p-card *ngIf="!loading() && orders().length === 0">
        <div class="empty">
          <i class="pi pi-calendar"></i>
          <p>Aún no tomaste pedidos hoy.</p>
          <a pButton label="Tomar un pedido" icon="pi pi-arrow-right" severity="secondary" [text]="true" routerLink="/vendor/route-home"></a>
        </div>
      </p-card>

      <div *ngIf="!loading() && orders().length > 0" class="list">
        <div class="seclab">Pedidos de hoy</div>
        <button class="orow" *ngFor="let o of orders()" (click)="goToOrder(o)">
          <span class="oc">
            <span class="code">{{ o.code }}</span>
            <span class="time">{{ fmtTime(o.created_at) }}</span>
          </span>
          <span class="oright">
            <span class="chip" [ngClass]="statusClass(o.status)">{{ statusLabel(o.status) }}</span>
            <span class="total">{{ fmtMoney(o.total) }}</span>
          </span>
        </button>
      </div>
    </div>
  `,
  styles: [
    `
      :host { display: block; }
      .hero {
        margin: -1rem -1rem 0; padding: 1.1rem 1rem 1.25rem;
        background: var(--v-hero-grad, linear-gradient(160deg, #F8B400 -10%, #F68F1E 55%, #C53E15 125%));
        color: #fff; position: relative; overflow: hidden;
      }
      .hero::after { content: ''; position: absolute; right: -40px; top: -30px; width: 160px; height: 160px; border-radius: 50%; background: rgba(255,255,255,0.12); }
      .hero-h { position: relative; z-index: 2; }
      .hero-h .ey { font-size: 0.7rem; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; opacity: 0.85; }
      .hero-h h1 { margin: 1px 0 0; font-size: 1.5rem; font-weight: 800; letter-spacing: -0.02em; }
      .kpis { display: flex; margin-top: 1rem; background: rgba(255,255,255,0.14); border-radius: var(--r-md, 12px); padding: 4px; position: relative; z-index: 2; }
      .kpi { flex: 1; text-align: center; padding: 0.45rem 0.25rem; border-radius: 12px; }
      .kpi.hl { background: rgba(255,255,255,0.18); }
      .kpi .v { font-family: var(--font-mono); font-weight: 700; font-size: 1rem; font-variant-numeric: tabular-nums; }
      .kpi .l { font-size: 0.62rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; opacity: 0.82; }

      .body-pad { padding-top: 0.875rem; }
      .empty { text-align: center; padding: 1.5rem 1rem; color: var(--text-muted); }
      .empty i { font-size: 2.5rem; display: block; margin-bottom: 0.5rem; color: var(--text-faint); }
      .empty p { margin: 0 0 1rem; }
      .seclab { font-size: 0.7rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-faint); margin: 0 0 0.5rem; }
      .list { display: flex; flex-direction: column; gap: 0.5rem; }
      .orow {
        display: flex; align-items: center; justify-content: space-between; gap: 1rem; width: 100%; text-align: left;
        background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-lg, 16px);
        padding: 0.8rem 0.9rem; cursor: pointer; box-shadow: 0 1px 2px rgba(16,13,9,0.05);
        transition: transform 0.08s var(--ease, ease);
      }
      .orow:active { transform: scale(0.99); }
      @media (prefers-reduced-motion: reduce) { .orow { transition: none; } }
      .oc { min-width: 0; }
      .code { display: block; font-family: var(--font-mono); font-weight: 700; color: var(--text-main); }
      .time { font-size: 0.75rem; color: var(--text-muted); }
      .oright { display: flex; flex-direction: column; align-items: flex-end; gap: 0.3rem; flex-shrink: 0; }
      .total { font-family: var(--font-mono); font-weight: 700; font-variant-numeric: tabular-nums; color: var(--text-main); }
      .chip { font-size: 0.68rem; font-weight: 600; padding: 0.12rem 0.5rem; border-radius: var(--r-pill, 999px); }
      .chip.ok { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
      .chip.info { background: var(--info-soft-bg); color: var(--info-soft-fg); }
      .chip.warn { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
      .chip.bad { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
      .chip.muted { background: var(--stone-100); color: var(--stone-600); }
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
  readonly fulfilledCount = computed(() => this.orders().filter((o) => o.status === 'fulfilled').length);

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

  statusClass(s: string): 'ok' | 'info' | 'warn' | 'bad' | 'muted' {
    switch (s) {
      case 'fulfilled': return 'ok';
      case 'confirmed': return 'info';
      case 'pending_approval': return 'warn';
      case 'cancelled': return 'bad';
      default: return 'muted';
    }
  }
  statusLabel(s: string): string {
    switch (s) {
      case 'fulfilled': return 'Entregado';
      case 'confirmed': return 'Confirmado';
      case 'pending_approval': return 'Por aprobar';
      case 'draft': return 'Borrador';
      case 'cancelled': return 'Cancelado';
      default: return s;
    }
  }
  todayLabel(): string {
    return new Date().toLocaleDateString('es-MX', { weekday: 'long' });
  }
  fmtMoney(n: unknown): string {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(n) || 0);
  }
  fmtTime(s: string): string {
    return new Date(s).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  }
}
