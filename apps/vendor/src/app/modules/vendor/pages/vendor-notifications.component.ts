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
import {
  VendorService,
  HomeCustomer,
  NbaDue,
  VendorOrder,
  SupervisorTask,
  SupervisorCoaching,
} from '../vendor.service';
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
        <p>Sin pendientes. Vas al día.</p>
      </div>
    </p-card>

    <ng-container *ngIf="!loading() && totalCount() > 0">
      <ng-container *ngIf="carga().length > 0">
        <div class="group">Para cargar</div>
        <button class="nrow" (click)="goCarga()">
          <span class="nic warn"><i class="pi pi-truck"></i></span>
          <span class="nb">
            <span class="nt">Cargá {{ carga().length }} {{ carga().length === 1 ? 'pedido' : 'pedidos' }} para {{ cargaLabel }}</span>
            <span class="nd">Verificá lo que subís al camión antes de salir.</span>
          </span>
          <i class="pi pi-chevron-right go"></i>
        </button>
      </ng-container>

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

      <ng-container *ngIf="supCoaching().length > 0 || supTasks().length > 0">
        <div class="group">De tu supervisor · IA</div>
        <button class="nrow" *ngFor="let c of supCoaching()" (click)="ackCoaching(c)">
          <span class="nic ai"><i class="pi pi-comment"></i></span>
          <span class="nb">
            <span class="nt">Coaching</span>
            <span class="nd">{{ c.message }}</span>
          </span>
          <span class="ack">Visto</span>
        </button>
        <button class="nrow" *ngFor="let t of supTasks()" (click)="ackTask(t)">
          <span class="nic warn"><i [class]="taskIcon(t.task_type)"></i></span>
          <span class="nb">
            <span class="nt">{{ t.title }}</span>
            <span class="nd">Tarea de campo · tocá para marcar hecha</span>
          </span>
          <span class="ack">Hecho</span>
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
        transition: transform 0.08s var(--ease, ease);
      }
      .nrow:not(.flat):active { transform: scale(0.99); }
      @media (prefers-reduced-motion: reduce) { .nrow { transition: none; } }
      .nrow.flat { cursor: default; }
      .nic { width: 2.35rem; height: 2.35rem; border-radius: 14px; display: grid; place-items: center; font-size: 1rem; flex-shrink: 0; color: #fff; }
      .nic.warn { background: var(--warn-fg); }
      .nic.ai { background: var(--ember-grad); }
      .nic.ok { background: var(--ok-fg); }
      .nb { flex: 1; min-width: 0; }
      .nt { display: block; font-weight: 700; font-size: 0.875rem; color: var(--text-main); }
      .nd { display: block; font-size: 0.8rem; color: var(--text-muted); margin-top: 1px; }
      .go { color: var(--text-faint); font-size: 0.85rem; flex-shrink: 0; }
      .ack { font-size: 0.72rem; font-weight: 700; color: var(--text-muted); flex-shrink: 0; padding: 0.2rem 0.55rem; border: 1px solid var(--border-color); border-radius: 999px; }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VendorNotificationsComponent implements OnInit {
  private readonly api = inject(VendorService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);

  readonly loading = signal(true);
  /** Todas las fuentes fallaron (sin red) — distinto de "vas al día" (estándar PWA §5). */
  readonly loadError = signal(false);
  readonly refreshing = signal(false);
  readonly preventa = signal<HomeCustomer[]>([]);
  readonly due = signal<NbaDue[]>([]);
  readonly todayOrders = signal<Order[]>([]);
  readonly carga = signal<VendorOrder[]>([]);
  readonly supCoaching = signal<SupervisorCoaching[]>([]);
  readonly supTasks = signal<SupervisorTask[]>([]);
  readonly cargaLabel = this.nextBusinessDayLabel();

  /** Formatter reutilizado — no instanciar Intl por fila (estándar PWA perf). */
  private readonly money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
  private static readonly SOURCES = 6;

  readonly totalCount = computed(
    () =>
      this.preventa().length +
      this.due().length +
      this.todayOrders().length +
      this.supCoaching().length +
      this.supTasks().length +
      (this.carga().length ? 1 : 0),
  );

  ngOnInit(): void {
    this.load();
  }

  load(silent = false): void {
    if (silent) this.refreshing.set(true);
    else this.loading.set(true);
    this.loadError.set(false);
    // Cuenta cuántas fuentes fallaron: si fallan TODAS = sin red (no "vas al día").
    let failures = 0;
    const guard =
      <T>(fb: T) =>
      (src: import('rxjs').Observable<T>) =>
        src.pipe(catchError(() => { failures++; return of(fb); }));
    forkJoin({
      home: this.api.home().pipe(guard<HomeCustomer[]>([])),
      due: this.api.nbaDue().pipe(guard<NbaDue[]>([])),
      today: this.api.myOrdersToday().pipe(guard<Order[]>([])),
      carga: this.api.cargaOrders().pipe(guard<VendorOrder[]>([])),
      coaching: this.api.mySupervisorCoaching().pipe(guard<SupervisorCoaching[]>([])),
      tasks: this.api.mySupervisorTasks().pipe(guard<SupervisorTask[]>([])),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ home, due, today, carga, coaching, tasks }) => {
          this.preventa.set(home.filter((c) => c.has_preventa_pending));
          this.due.set(due);
          this.todayOrders.set(today);
          const iso = this.nextBizIso();
          this.carga.set(carga.filter((o) => !o.requested_delivery_date || o.requested_delivery_date.slice(0, 10) === iso));
          this.supCoaching.set(coaching);
          this.supTasks.set(tasks);
          this.loadError.set(failures === VendorNotificationsComponent.SOURCES);
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

  /** Refresh manual: recarga el inbox sin blanquear la pantalla. */
  refresh(): void {
    if (this.refreshing()) return;
    this.load(true);
  }

  goPending(): void {
    this.router.navigate(['/vendor/pending']);
  }
  goReorder(d: NbaDue): void {
    this.router.navigate(['/vendor/take-order', d.customer_id], { queryParams: { mode: 'instante' } });
  }
  goCarga(): void {
    this.router.navigate(['/vendor/carga']);
  }

  /** Acuse optimista: lo saco del inbox y persisto en background (self-scoped en el backend). */
  ackCoaching(c: SupervisorCoaching): void {
    this.supCoaching.update((l) => l.filter((x) => x.id !== c.id));
    this.api
      .ackSupervisorCoaching(c.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ error: () => undefined });
  }
  ackTask(t: SupervisorTask): void {
    this.supTasks.update((l) => l.filter((x) => x.id !== t.id));
    this.api
      .ackSupervisorTask(t.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ error: () => undefined });
  }
  taskIcon(t: string): string {
    return t === 'visit'
      ? 'pi pi-map-marker'
      : t === 'recover'
        ? 'pi pi-shopping-cart'
        : t === 'reprioritize'
          ? 'pi pi-sort-alt-slash'
          : 'pi pi-camera';
  }

  /** ISO del próximo día hábil (domingo no hay reparto → sáb pasa a lun). */
  private nextBizIso(): string {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 1);
    if (d.getDay() === 0) d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  private nextBusinessDayLabel(): string {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 1);
    if (d.getDay() === 0) d.setDate(d.getDate() + 1);
    const tomorrow = new Date();
    tomorrow.setHours(0, 0, 0, 0);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    return iso(d) === iso(tomorrow) ? 'mañana' : `el ${d.toLocaleDateString('es-MX', { weekday: 'long' })}`;
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
