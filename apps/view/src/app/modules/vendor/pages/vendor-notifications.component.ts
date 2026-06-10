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
import { Router } from '@angular/router';
import { CardModule } from 'primeng/card';
import { SkeletonModule } from 'primeng/skeleton';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin, of, catchError } from 'rxjs';
import { VendorService, HomeCustomer, NbaDue } from '../vendor.service';
import { Order } from '../../portal/portal.service';

/**
 * Notificaciones del vendedor — inbox derivado (sin backend persistente todavía):
 * agrega lo accionable de endpoints existentes — preventa pendiente, clientes
 * para reordenar hoy (NBA) y pedidos de hoy. Cada fila lleva a la acción.
 */
@Component({
  selector: 'app-vendor-notifications',
  standalone: true,
  imports: [CommonModule, CardModule, SkeletonModule],
  template: `
    <h1 class="page-title">Notificaciones</h1>
    <p class="subtitle" *ngIf="!loading()">{{ totalCount() }} {{ totalCount() === 1 ? 'aviso' : 'avisos' }}</p>

    <p-skeleton *ngIf="loading()" height="400px"></p-skeleton>

    <p-card *ngIf="!loading() && totalCount() === 0">
      <div class="empty">
        <i class="pi pi-check-circle"></i>
        <p>Sin pendientes. ¡Vas al día! 🎉</p>
      </div>
    </p-card>

    <ng-container *ngIf="!loading() && totalCount() > 0">
      <ng-container *ngIf="preventa().length > 0">
        <div class="group">Requieren acción</div>
        <button class="nrow" *ngFor="let p of preventa()" (click)="goPending()">
          <span class="nic warn"><i class="pi pi-inbox"></i></span>
          <span class="nb">
            <span class="nt">Nueva preventa · {{ p.name }}</span>
            <span class="nd">Pidió {{ fmtMoney(p.pending_total) }} por el Portal. Revisá y aprobá.</span>
          </span>
          <i class="pi pi-chevron-right go"></i>
        </button>
      </ng-container>

      <ng-container *ngIf="due().length > 0">
        <div class="group">Para reordenar hoy · IA</div>
        <button class="nrow" *ngFor="let d of due()" (click)="goReorder(d)">
          <span class="nic ai"><i class="pi pi-sparkles"></i></span>
          <span class="nb">
            <span class="nt">{{ d.name || 'Cliente' }}</span>
            <span class="nd">{{ dueLabel(d) }}</span>
          </span>
          <i class="pi pi-chevron-right go"></i>
        </button>
      </ng-container>

      <ng-container *ngIf="todayOrders().length > 0">
        <div class="group">Hoy</div>
        <div class="nrow flat" *ngFor="let o of todayOrders()">
          <span class="nic ok"><i class="pi pi-check-circle"></i></span>
          <span class="nb">
            <span class="nt">Pedido {{ o.code }}</span>
            <span class="nd">{{ statusLabel(o.status) }} · {{ fmtMoney(o.total) }}</span>
          </span>
        </div>
      </ng-container>
    </ng-container>
  `,
  styles: [
    `
      .page-title { margin: 0 0 0.2rem; font-size: 1.5rem; font-weight: 800; letter-spacing: -0.02em; color: var(--text-main); }
      .subtitle { margin: 0 0 1rem; color: var(--text-muted); font-size: 0.875rem; }
      .empty { text-align: center; padding: 2rem 1rem; color: var(--text-muted); }
      .empty i { font-size: 2.5rem; display: block; margin-bottom: 0.5rem; color: var(--ok-fg); }
      .group { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-faint); margin: 1.1rem 0 0.5rem; }
      .nrow {
        display: flex; align-items: center; gap: 0.75rem; width: 100%; text-align: left;
        background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md, 12px);
        padding: 0.75rem; margin-bottom: 0.5rem; cursor: pointer;
      }
      .nrow.flat { cursor: default; }
      .nic { width: 2.35rem; height: 2.35rem; border-radius: 11px; display: grid; place-items: center; font-size: 1rem; flex-shrink: 0; color: #fff; }
      .nic.warn { background: var(--warn-fg); }
      .nic.ai { background: var(--ember-grad); }
      .nic.ok { background: var(--ok-fg); }
      .nb { flex: 1; min-width: 0; }
      .nt { display: block; font-weight: 700; font-size: 0.875rem; color: var(--text-main); }
      .nd { display: block; font-size: 0.8rem; color: var(--text-muted); margin-top: 1px; }
      .go { color: var(--text-faint); font-size: 0.85rem; flex-shrink: 0; }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VendorNotificationsComponent implements OnInit {
  private readonly api = inject(VendorService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);

  readonly loading = signal(true);
  readonly preventa = signal<HomeCustomer[]>([]);
  readonly due = signal<NbaDue[]>([]);
  readonly todayOrders = signal<Order[]>([]);

  readonly totalCount = computed(
    () => this.preventa().length + this.due().length + this.todayOrders().length,
  );

  ngOnInit(): void {
    forkJoin({
      home: this.api.home().pipe(catchError(() => of([] as HomeCustomer[]))),
      due: this.api.nbaDue().pipe(catchError(() => of([] as NbaDue[]))),
      today: this.api.myOrdersToday().pipe(catchError(() => of([] as Order[]))),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ home, due, today }) => {
          this.preventa.set(home.filter((c) => c.has_preventa_pending));
          this.due.set(due);
          this.todayOrders.set(today);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });
  }

  goPending(): void {
    this.router.navigate(['/vendor/pending']);
  }
  goReorder(d: NbaDue): void {
    this.router.navigate(['/vendor/take-order', d.customer_id], { queryParams: { mode: 'instante' } });
  }

  dueLabel(d: NbaDue): string {
    const cad = d.cadence_days ? `suele pedir cada ${d.cadence_days} días` : 'tiempo de reordenar';
    const over = d.days_overdue > 0 ? ` · ${d.days_overdue} días de atraso` : '';
    return cad + over;
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
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(n) || 0);
  }
}
