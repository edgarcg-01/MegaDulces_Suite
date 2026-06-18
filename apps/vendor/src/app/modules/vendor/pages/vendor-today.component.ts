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
      <button
        type="button"
        class="hero-refresh"
        [class.spinning]="refreshing()"
        [disabled]="refreshing()"
        (click)="refresh()"
        aria-label="Actualizar mi día"
      >
        <i class="pi pi-refresh"></i>
      </button>
      <div class="hero-h">
        <div class="ey">Hoy · {{ todayLabel }}</div>
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

      <!-- Fallo de red (distinto de "sin pedidos hoy") -->
      <p-card *ngIf="!loading() && loadError() && orders().length === 0">
        <div class="empty">
          <i class="pi pi-cloud"></i>
          <p>No se pudo cargar tu día.</p>
          <button pButton label="Reintentar" icon="pi pi-refresh" severity="secondary" [text]="true" (click)="load()"></button>
        </div>
      </p-card>

      <p-card *ngIf="!loading() && !loadError() && orders().length === 0">
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
        margin: -1rem -1rem 0; padding: 1.3rem 1rem 1.4rem;
        background: var(--stone-50, #faf7f3);
        color: var(--text-main, #2b2622); position: relative; overflow: hidden; isolation: isolate;
        border-bottom: 1px solid var(--border-color, rgba(40,30,20,0.08));
      }
      .hero::before {
        content: ''; position: absolute; inset: -45% -15%; z-index: 0; pointer-events: none;
        background:
          radial-gradient(55% 75% at 18% 2%, rgba(255,255,255,0.9), transparent 60%),
          radial-gradient(50% 68% at 96% 112%, rgba(240,90,40,0.06), transparent 58%);
        animation: hero-drift 16s ease-in-out infinite alternate;
      }
      @keyframes hero-drift {
        from { transform: translate3d(-3%, -2%, 0) scale(1.04); }
        to   { transform: translate3d(4%, 3%, 0) scale(1.16); }
      }
      .hero-refresh { position: absolute; top: 1rem; right: 1rem; z-index: 2; width: 2.1rem; height: 2.1rem; border-radius: 50%; border: 1px solid var(--border-color); background: var(--card-bg); color: var(--text-muted); display: grid; place-items: center; cursor: pointer; transition: transform 0.08s var(--ease, ease); }
      .hero-refresh:active { transform: scale(0.92); } .hero-refresh:disabled { opacity: 0.6; }
      .hero-refresh i { font-size: 0.9rem; }
      .hero-refresh.spinning i { animation: today-spin 0.8s linear infinite; }
      @keyframes today-spin { to { transform: rotate(360deg); } }
      .hero-h { position: relative; z-index: 1; }
      .hero-h .ey { font-size: 0.66rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-muted); }
      .hero-h h1 { margin: 2px 0 0; font-size: 1.7rem; font-weight: 800; letter-spacing: -0.025em; line-height: 1.04; color: var(--text-main); }
      .kpis {
        display: flex; margin-top: 1.2rem; padding-top: 0.95rem; position: relative; z-index: 1;
        border-top: 1px solid var(--border-color, rgba(40,30,20,0.1));
      }
      .kpi { flex: 1; text-align: center; position: relative; }
      .kpi + .kpi::before { content: ''; position: absolute; left: 0; top: 52%; transform: translateY(-50%); height: 56%; width: 1px; background: var(--border-color, rgba(40,30,20,0.1)); }
      .kpi .v { font-family: var(--font-mono); font-weight: 700; font-size: 1.1rem; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; color: var(--text-main); }
      .kpi.hl .v { font-size: 1.28rem; }
      .kpi .l { font-size: 0.58rem; font-weight: 600; letter-spacing: 0.09em; text-transform: uppercase; color: var(--text-muted); margin-top: 0.2rem; }

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
      @media (prefers-reduced-motion: reduce) { .orow { transition: none; } .hero::before { animation: none; } .hero-refresh.spinning i { animation: none; } }
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
  /** Falló la carga (red) — distinto de "sin pedidos hoy" (estándar PWA §5). */
  readonly loadError = signal(false);
  readonly refreshing = signal(false);
  readonly orders = signal<Order[]>([]);

  /** Formatters/constante reutilizados — no instanciar Intl ni Date por CD. */
  private readonly money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
  private readonly timeFmt = new Intl.DateTimeFormat('es-MX', { hour: '2-digit', minute: '2-digit' });
  readonly todayLabel = new Date().toLocaleDateString('es-MX', { weekday: 'long' });

  readonly totalRevenue = computed(() =>
    this.orders()
      .filter((o) => o.status === 'fulfilled' || o.status === 'confirmed')
      .reduce((s, o) => s + Number(o.total), 0),
  );
  readonly fulfilledCount = computed(() => this.orders().filter((o) => o.status === 'fulfilled').length);

  ngOnInit(): void {
    this.load();
  }

  load(silent = false): void {
    if (silent) this.refreshing.set(true);
    else this.loading.set(true);
    this.loadError.set(false);
    this.api
      .myOrdersToday()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (orders) => {
          this.orders.set(orders);
          this.loading.set(false);
          this.refreshing.set(false);
        },
        error: () => {
          this.loading.set(false);
          this.refreshing.set(false);
          this.loadError.set(true);
        },
      });
  }

  /** Refresh manual: trae los pedidos del día sin blanquear la pantalla. */
  refresh(): void {
    if (this.refreshing()) return;
    this.load(true);
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
  fmtMoney(n: unknown): string {
    return this.money.format(Number(n) || 0);
  }
  fmtTime(s: string): string {
    const d = new Date(s);
    return isNaN(d.getTime()) ? '' : this.timeFmt.format(d);
  }
}
