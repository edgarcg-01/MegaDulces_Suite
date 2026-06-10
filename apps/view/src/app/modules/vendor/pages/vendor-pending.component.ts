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
import { CardModule } from 'primeng/card';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { SkeletonModule } from 'primeng/skeleton';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ConfirmationService, MessageService } from 'primeng/api';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { VendorService, VendorOrder } from '../vendor.service';
import { OrderLine } from '../../portal/portal.service';

/**
 * Apartado "Por entregar": pedidos pendientes de la cartera del vendedor
 * (preventa del Portal B2B + de campo) en pending_approval / confirmed.
 *  - pending_approval → el vendedor APRUEBA (pasa a confirmed / listo para entregar).
 *  - confirmed        → el vendedor marca ENTREGADO (fulfill, consume stock).
 * Cada card expande sus líneas bajo demanda. Toasts en el p-toast del shell.
 */
@Component({
  selector: 'app-vendor-pending',
  standalone: true,
  imports: [
    CommonModule,
    CardModule,
    TagModule,
    ButtonModule,
    SkeletonModule,
    ConfirmDialogModule,
  ],
  providers: [ConfirmationService],
  template: `
    <p-confirmDialog></p-confirmDialog>

    <h1 class="page-title">Por entregar</h1>
    <p class="subtitle" *ngIf="!loading()">
      {{ toApprove().length }} por aprobar · {{ toDeliver().length }} por entregar
    </p>

    <p-skeleton *ngIf="loading()" height="400px"></p-skeleton>

    <p-card *ngIf="!loading() && orders().length === 0">
      <div class="empty">
        <i class="pi pi-check-circle"></i>
        <p>No tenés pedidos pendientes en tu cartera.</p>
      </div>
    </p-card>

    <ng-container *ngIf="!loading() && orders().length > 0">
      <ng-container
        *ngTemplateOutlet="section; context: { title: 'Por aprobar', list: toApprove(), kind: 'approve' }"
      ></ng-container>
      <ng-container
        *ngTemplateOutlet="section; context: { title: 'Listos para entregar', list: toDeliver(), kind: 'deliver' }"
      ></ng-container>
    </ng-container>

    <ng-template #section let-title="title" let-list="list" let-kind="kind">
      <div *ngIf="list.length > 0" class="section">
        <h2 class="section-title">{{ title }}</h2>
        <div class="order-list">
          <p-card *ngFor="let o of list" styleClass="order-card">
            <div class="order-head" (click)="toggle(o)">
              <div class="info">
                <div class="customer">{{ o.customer_name || '—' }}</div>
                <div class="sub">
                  <span class="folio">{{ o.folio || o.code }}</span>
                  <span class="time">{{ fmtTime(o.created_at) }}</span>
                </div>
              </div>
              <div class="right">
                <p-tag
                  [value]="o.is_preventa ? 'Preventa' : 'Campo'"
                  [severity]="o.is_preventa ? 'info' : 'secondary'"
                  styleClass="origin-tag"
                ></p-tag>
                <div class="total">{{ fmtMoney(o.total) }}</div>
              </div>
              <i class="pi chevron" [ngClass]="isOpen(o.id) ? 'pi-chevron-up' : 'pi-chevron-down'"></i>
            </div>

            <div class="lines" *ngIf="isOpen(o.id)">
              <p-skeleton *ngIf="linesLoading().has(o.id)" height="60px"></p-skeleton>
              <ng-container *ngIf="!linesLoading().has(o.id)">
                <div class="line" *ngFor="let l of linesOf(o.id)">
                  <span class="qty">{{ l.quantity }}×</span>
                  <span class="pname">{{ l.product_name || l.product_id }}</span>
                  <span class="ltotal">{{ fmtMoney(l.line_total) }}</span>
                </div>
                <div class="line empty-line" *ngIf="linesOf(o.id).length === 0">Sin líneas.</div>
              </ng-container>
            </div>

            <div class="actions">
              <button
                *ngIf="kind === 'approve'"
                pButton
                label="Aprobar"
                icon="pi pi-check"
                size="small"
                [loading]="processing().has(o.id)"
                (click)="askApprove(o)"
              ></button>
              <button
                *ngIf="kind === 'deliver'"
                pButton
                label="Marcar entregado"
                icon="pi pi-truck"
                severity="success"
                size="small"
                [loading]="processing().has(o.id)"
                (click)="askFulfill(o)"
              ></button>
            </div>
          </p-card>
        </div>
      </div>
    </ng-template>
  `,
  styles: [
    `
      .page-title { margin: 0 0 0.25rem; font-size: 1.5rem; color: var(--text-main); }
      .subtitle { margin: 0 0 1rem; color: var(--text-muted); font-size: 0.875rem; }
      .empty { text-align: center; padding: 1.5rem 1rem; color: var(--text-muted); }
      .empty i { font-size: 2.5rem; display: block; margin-bottom: 0.5rem; color: var(--ok-fg); }
      .section { margin-bottom: 1.25rem; }
      .section-title {
        margin: 0 0 0.5rem;
        font-size: 0.8rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-muted);
      }
      .order-list { display: flex; flex-direction: column; gap: 0.5rem; }
      :host ::ng-deep .p-card.order-card {
        background: var(--card-bg);
        border: 1px solid var(--border-color);
      }
      :host ::ng-deep .p-card.order-card .p-card-body { padding: 0.75rem 0.875rem; }
      :host ::ng-deep .p-card.order-card .p-card-content { padding: 0; }
      :host ::ng-deep .origin-tag .p-tag { font-size: 0.65rem; }
      .order-head { display: flex; align-items: center; gap: 0.75rem; cursor: pointer; }
      .info { flex: 1; min-width: 0; }
      .customer {
        font-weight: 600;
        color: var(--text-main);
        line-height: 1.2;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .sub { display: flex; gap: 0.625rem; font-size: 0.75rem; color: var(--text-muted); margin-top: 0.125rem; }
      .folio { font-weight: 600; }
      .right { display: flex; flex-direction: column; align-items: flex-end; gap: 0.25rem; flex-shrink: 0; }
      .total { font-weight: 700; font-variant-numeric: tabular-nums; color: var(--text-main); }
      .chevron { color: var(--text-muted); font-size: 0.85rem; flex-shrink: 0; }
      .lines {
        margin-top: 0.625rem;
        padding-top: 0.625rem;
        border-top: 1px dashed var(--border-color);
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
      }
      .line { display: flex; gap: 0.5rem; font-size: 0.8rem; color: var(--text-main); align-items: baseline; }
      .line .qty { font-weight: 700; color: var(--brand-700); min-width: 2.25rem; }
      .line .pname { flex: 1; min-width: 0; }
      .line .ltotal { font-variant-numeric: tabular-nums; color: var(--text-muted); }
      .empty-line { color: var(--text-muted); font-style: italic; }
      .actions { margin-top: 0.75rem; display: flex; justify-content: flex-end; }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VendorPendingComponent implements OnInit {
  private readonly api = inject(VendorService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly confirmSvc = inject(ConfirmationService);
  private readonly toast = inject(MessageService);

  readonly loading = signal(true);
  readonly orders = signal<VendorOrder[]>([]);

  readonly toApprove = computed(() => this.orders().filter((o) => o.status === 'pending_approval'));
  readonly toDeliver = computed(() => this.orders().filter((o) => o.status === 'confirmed'));

  readonly open = signal<Set<string>>(new Set());
  readonly linesById = signal<Record<string, OrderLine[]>>({});
  readonly linesLoading = signal<Set<string>>(new Set());
  readonly processing = signal<Set<string>>(new Set());

  ngOnInit(): void {
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.api
      .pendingDeliveries()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (list) => {
          this.orders.set(list);
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
          this.toast.add({ severity: 'error', summary: 'No se pudo cargar los pendientes' });
        },
      });
  }

  isOpen(id: string): boolean {
    return this.open().has(id);
  }
  linesOf(id: string): OrderLine[] {
    return this.linesById()[id] || [];
  }

  toggle(o: VendorOrder): void {
    const next = new Set(this.open());
    if (next.has(o.id)) {
      next.delete(o.id);
      this.open.set(next);
      return;
    }
    next.add(o.id);
    this.open.set(next);
    if (this.linesById()[o.id]) return; // ya cacheado

    const loading = new Set(this.linesLoading());
    loading.add(o.id);
    this.linesLoading.set(loading);
    this.api
      .orderById(o.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (full) => {
          this.linesById.set({ ...this.linesById(), [o.id]: full?.lines || [] });
          this.clearLoading(o.id);
        },
        error: () => {
          this.linesById.set({ ...this.linesById(), [o.id]: [] });
          this.clearLoading(o.id);
        },
      });
  }

  askApprove(o: VendorOrder): void {
    this.confirmSvc.confirm({
      header: 'Aprobar pedido',
      message: `¿Aprobar ${o.folio || o.code} de ${o.customer_name || 'este cliente'}? Quedará listo para entregar.`,
      icon: 'pi pi-check-circle',
      acceptLabel: 'Aprobar',
      rejectLabel: 'Cancelar',
      accept: () => this.run(o, this.api.approve(o.id), 'Pedido aprobado'),
    });
  }

  askFulfill(o: VendorOrder): void {
    this.confirmSvc.confirm({
      header: 'Marcar entregado',
      message: `¿Confirmás la entrega de ${o.folio || o.code} a ${o.customer_name || 'este cliente'}? Se descuenta del inventario.`,
      icon: 'pi pi-truck',
      acceptLabel: 'Entregar',
      rejectLabel: 'Cancelar',
      accept: () => this.run(o, this.api.fulfill(o.id), 'Pedido entregado'),
    });
  }

  private run(o: VendorOrder, op: ReturnType<VendorService['approve']>, okMsg: string): void {
    const busy = new Set(this.processing());
    busy.add(o.id);
    this.processing.set(busy);
    op.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.toast.add({ severity: 'success', summary: okMsg, detail: o.folio || o.code });
        this.clearProcessing(o.id);
        this.reload();
      },
      error: (e) => {
        this.clearProcessing(o.id);
        this.toast.add({
          severity: 'error',
          summary: 'No se pudo completar',
          detail: e?.error?.message || 'Intentá de nuevo.',
        });
      },
    });
  }

  private clearLoading(id: string): void {
    const s = new Set(this.linesLoading());
    s.delete(id);
    this.linesLoading.set(s);
  }
  private clearProcessing(id: string): void {
    const s = new Set(this.processing());
    s.delete(id);
    this.processing.set(s);
  }

  fmtMoney(n: unknown): string {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(n) || 0);
  }
  fmtTime(s: string): string {
    return new Date(s).toLocaleString('es-MX', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}
