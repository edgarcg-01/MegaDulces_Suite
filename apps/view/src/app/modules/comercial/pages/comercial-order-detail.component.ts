import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { TimelineModule } from 'primeng/timeline';
import { InputNumberModule } from 'primeng/inputnumber';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService, ConfirmationService } from 'primeng/api';
import { ComercialService, OrderDetail, OrderHistoryEntry, OrderLine, OrderStatus } from '../comercial.service';
import { LogisticaService, Shipment, ShipmentStatus } from '../../logistica/logistica.service';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';

@Component({
  selector: 'app-comercial-order-detail',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    ButtonModule,
    CardModule,
    TableModule,
    TagModule,
    ToastModule,
    ConfirmDialogModule,
    TimelineModule,
    InputNumberModule,
    TooltipModule,
  ],
  providers: [MessageService, ConfirmationService],
  template: `
    <p-toast></p-toast>
    <p-confirmDialog></p-confirmDialog>

    <div class="topbar">
      <button pButton icon="pi pi-arrow-left" label="Volver" severity="secondary" [text]="true" (click)="back()"></button>
    </div>

    <ng-container *ngIf="order() as o">
      <div class="comm-page-head">
        <div class="comm-page-head-text">
          <h2><code class="comm-code">{{ o.folio }}</code></h2>
          <p class="comm-page-sub">Creado {{ o.created_at | date:'medium' }} por <strong>{{ o.user_username || '—' }}</strong></p>
        </div>
        <div class="hero-tags">
          <p-tag
            *ngIf="o.route_name"
            severity="contrast"
            [value]="o.route_name"
            icon="pi pi-directions"
            pTooltip="Ruta de reparto asignada al cliente"
          ></p-tag>
          <p-tag
            severity="secondary"
            [value]="o.delivery_type === 'long_trip' ? 'Viaje largo' : 'Por ruta'"
            [icon]="o.delivery_type === 'long_trip' ? 'pi pi-globe' : 'pi pi-truck'"
          ></p-tag>
          <p-tag [severity]="severity(o.status)" [value]="statusLabel(o.status)" styleClass="status-tag"></p-tag>
        </div>
      </div>

      <div class="grid">
        <article class="comm-stat-card">
          <span class="comm-stat-label">Cliente</span>
          <span class="comm-stat-value">{{ o.customer_name || o.customer_id }}</span>
        </article>
        <article class="comm-stat-card">
          <span class="comm-stat-label">Almacén</span>
          <span class="comm-stat-value">{{ o.warehouse_name || '—' }}</span>
        </article>
        <article class="comm-stat-card">
          <span class="comm-stat-label">Total</span>
          <span class="comm-stat-value is-big">{{ o.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
          <span class="comm-stat-sub" *ngIf="o.discount_total">Descuento: {{ o.discount_total | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
        </article>
      </div>

      <p-card header="Líneas">
        <div class="lines-banner" *ngIf="o.status === 'pending_approval'">
          <i class="pi pi-info-circle"></i>
          <span>
            Revisá producto por producto. Ajustá la cantidad según stock disponible,
            o eliminá la línea si no se puede surtir. Cuando todo esté listo, aprobá el pedido.
          </span>
        </div>
        <p-table [value]="o.lines" responsiveLayout="scroll" styleClass="p-datatable-sm">
          <ng-template pTemplate="header">
            <tr>
              <th>Producto</th>
              <th class="comm-num">Cantidad pedida</th>
              <th class="comm-num">Stock disponible</th>
              <th class="comm-num" *ngIf="o.status === 'pending_approval'">Cantidad a aprobar</th>
              <th class="comm-num">Precio unit</th>
              <th class="comm-num">Desc%</th>
              <th class="comm-num">Total línea</th>
              <th *ngIf="o.status === 'pending_approval'"></th>
            </tr>
          </ng-template>
          <ng-template pTemplate="body" let-l>
            <tr [class.line-shortfall]="lineShortfall(l, o)">
              <td>
                <div class="comm-cell-strong">{{ l.product_name || l.product_id }}</div>
                <div class="comm-muted is-small" *ngIf="l.brand_name">{{ l.brand_name }}</div>
              </td>
              <td class="comm-num">
                <strong>{{ requestedQty(l) }}</strong>
                <div class="comm-muted is-small" *ngIf="o.status === 'pending_approval' && Number(l.quantity) < requestedQty(l)">
                  recortado a {{ l.quantity }}
                </div>
              </td>
              <td class="comm-num">
                <span class="stock-chip" [class.is-short]="lineShortfall(l, o)">
                  {{ stockAvailableNum(l) }}
                </span>
              </td>
              <td class="comm-num" *ngIf="o.status === 'pending_approval'">
                <div class="qty-edit">
                  <p-inputNumber
                    [ngModel]="l.quantity"
                    (onBlur)="onLineQtyBlur(l, $any($event).target?.value, o)"
                    (onKeyDown)="$any($event).key === 'Enter' && $any($event).target.blur()"
                    [min]="1"
                    [max]="approvableMax(l)"
                    [showButtons]="true"
                    buttonLayout="horizontal"
                    spinnerMode="horizontal"
                    incrementButtonIcon="pi pi-plus"
                    decrementButtonIcon="pi pi-minus"
                    inputStyleClass="qty-input"
                    [disabled]="savingLineId() === l.id"
                  ></p-inputNumber>
                  <i *ngIf="savingLineId() === l.id" class="pi pi-spin pi-spinner saving-spinner"></i>
                </div>
                <div class="comm-muted is-small">
                  tope: {{ approvableMax(l) }} / {{ requestedQty(l) }}
                </div>
              </td>
              <td class="comm-num">{{ l.unit_price | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
              <td class="comm-num">{{ (l.discount_percent * 100) | number:'1.0-1' }}%</td>
              <td class="comm-num is-strong">{{ l.line_total | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
              <td *ngIf="o.status === 'pending_approval'" class="comm-actions">
                <button pButton icon="pi pi-trash"
                        size="small" severity="secondary" [text]="true"
                        [disabled]="savingLineId() === l.id"
                        (click)="confirmRemoveLine(l, o)"
                        pTooltip="Quitar línea (libera reserva)"></button>
              </td>
            </tr>
          </ng-template>
          <ng-template pTemplate="emptymessage">
            <tr><td [attr.colspan]="o.status === 'pending_approval' ? 8 : 6" class="comm-muted">Sin líneas en este pedido.</td></tr>
          </ng-template>
        </p-table>
      </p-card>

      <div class="action-bar" *ngIf="o.status === 'draft' || o.status === 'pending_approval' || o.status === 'confirmed'">
        <button pButton *ngIf="o.status === 'draft'" label="Confirmar pedido" icon="pi pi-check"
                [loading]="actioning()"
                severity="contrast"
                (click)="confirmTransition('confirm', o)"></button>
        <button pButton *ngIf="o.status === 'pending_approval'" label="Aprobar pedido" icon="pi pi-check-circle"
                [loading]="actioning()"
                severity="contrast"
                (click)="confirmTransition('approve', o)"></button>
        <button pButton *ngIf="o.status === 'confirmed'" label="Marcar entregado" icon="pi pi-truck"
                [loading]="actioning()"
                severity="contrast"
                (click)="confirmTransition('fulfill', o)"></button>
        <button pButton label="Cancelar pedido" icon="pi pi-times"
                [loading]="actioning()"
                severity="danger" [outlined]="true"
                (click)="confirmTransition('cancel', o)"></button>
      </div>

      <!-- Logística: embarques asociados (solo si user tiene LOGISTICS_SHIPMENTS_VER) -->
      <p-card *ngIf="canSeeLogistics()" styleClass="logistics-card">
        <ng-template pTemplate="header">
          <div class="logistics-header">
            <div>
              <i class="pi pi-truck"></i>
              <strong>Embarques de logística</strong>
              <span class="comm-muted is-small" *ngIf="shipments().length"> · {{ shipments().length }} asociados</span>
            </div>
            <button pButton *ngIf="canCreateShipment(o)" icon="pi pi-plus" label="Crear embarque"
                    size="small"
                    [routerLink]="['/logistica/shipments']"
                    [queryParams]="{ order_id: o.id }"></button>
          </div>
        </ng-template>
        <p-table [value]="shipments()" [loading]="loadingShipments()" responsiveLayout="scroll" styleClass="p-datatable-sm">
          <ng-template pTemplate="header">
            <tr>
              <th>Folio</th>
              <th>Fecha</th>
              <th>Tipo</th>
              <th>Origen → Destino</th>
              <th>Estado</th>
              <th></th>
            </tr>
          </ng-template>
          <ng-template pTemplate="body" let-s>
            <tr>
              <td><code class="comm-code">{{ s.folio }}</code></td>
              <td>{{ s.shipment_date | date:'shortDate' }}</td>
              <td>{{ s.type }}</td>
              <td class="comm-muted">{{ (s.origin || '—') + ' → ' + (s.destination || '—') }}</td>
              <td><p-tag [severity]="sevShip(s.status)" [value]="s.status"></p-tag></td>
              <td class="comm-actions">
                <a pButton icon="pi pi-arrow-right" size="small" [text]="true"
                   [routerLink]="['/logistica/shipments', s.id]" pTooltip="Ver embarque"></a>
              </td>
            </tr>
          </ng-template>
          <ng-template pTemplate="emptymessage">
            <tr><td colspan="6" class="comm-muted">
              {{ canCreateShipment(o) ? 'Sin embarques. Crear uno para enviar este pedido.' : 'Sin embarques registrados.' }}
            </td></tr>
          </ng-template>
        </p-table>
      </p-card>

      <p-card header="Historial de cambios" styleClass="history-card">
        <p-timeline [value]="history()" align="left" styleClass="status-timeline">
          <ng-template pTemplate="content" let-event>
            <div class="event">
              <div class="event-headline">
                <p-tag [severity]="severity(event.to_status)" [value]="statusLabel(event.to_status)"></p-tag>
                <span class="comm-muted is-small" *ngIf="event.from_status">desde {{ statusLabel(event.from_status) }}</span>
                <span class="comm-muted is-small" *ngIf="!event.from_status">creación</span>
              </div>
              <div class="event-meta">
                <span><i class="pi pi-user"></i> {{ event.changed_by_username }}</span>
                <span><i class="pi pi-clock"></i> {{ event.created_at | date:'medium' }}</span>
              </div>
              <div *ngIf="event.reason" class="event-reason">{{ event.reason }}</div>
            </div>
          </ng-template>
        </p-timeline>
        <div *ngIf="history().length === 0" class="comm-muted">Sin historial registrado.</div>
      </p-card>
    </ng-container>

    <ng-container *ngIf="!order() && !loading()">
      <div class="empty">
        <i class="pi pi-exclamation-circle"></i>
        <p>Pedido no encontrado.</p>
        <button pButton label="Volver" (click)="back()"></button>
      </div>
    </ng-container>
  `,
  styles: [`
    :host { display:block; }
    .topbar { margin-bottom: .5rem; }
    .comm-page-head h2 { font-size: 1.5rem; }
    .big { font-size: 1.5rem; }
    .grid { display:grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap:.75rem; margin-bottom:1.25rem; }
    @media (max-width: 720px) { .grid { grid-template-columns: 1fr; } }
    .action-bar { display:flex; gap:.75rem; margin: 1rem 0 1.25rem; }
    :host ::ng-deep .status-timeline { padding: .25rem 0; }
    .event { padding:.5rem 0; }
    .event-headline { display:flex; align-items:center; gap:.75rem; margin-bottom:.25rem; }
    .event-meta { display:flex; gap:1rem; font-size:.8rem; color:var(--text-color-secondary); }
    .event-meta i { margin-right:.25rem; }
    .event-reason { margin-top:.25rem; font-size:.85rem; font-style:italic; }
    .empty { text-align: center; padding: 3rem 1rem; color: var(--text-color-secondary); }
    .empty i { font-size: 3rem; display:block; margin-bottom:.5rem; }
    .hero-tags { display:flex; flex-direction:column; align-items:flex-end; gap:.4rem; }
    :host ::ng-deep .p-card.logistics-card { margin-top: 1.25rem; }
    .logistics-header { display:flex; justify-content:space-between; align-items:center; padding: 0 1rem; }
    .logistics-header i { margin-right: .35rem; color: var(--primary-color); }
    .lines-banner { display:flex; gap:.5rem; align-items:flex-start; background: var(--info-soft-bg); color: var(--info-soft-fg); padding:.6rem .8rem; border-radius:6px; font-size:.85rem; margin-bottom:.75rem; }
    .lines-banner i { margin-top:.15rem; }
    .qty-edit { display:inline-flex; align-items:center; gap:.4rem; justify-content:flex-end; }
    :host ::ng-deep .qty-edit .qty-input { width: 4.5rem; text-align:right; }
    .saving-spinner { color: var(--primary-color); font-size:.85rem; }
    .stock-chip { display:inline-block; padding:.15rem .55rem; border-radius:999px; background: var(--surface-100); font-weight:500; font-size:.82rem; }
    .stock-chip.is-short { background: var(--bad-soft-bg); color: var(--bad-soft-fg); font-weight:600; }
    tr.line-shortfall { background: var(--bad-soft-bg); }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComercialOrderDetailComponent {
  private readonly api = inject(ComercialService);
  private readonly logistica = inject(LogisticaService);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);
  private readonly destroyRef = inject(DestroyRef);

  readonly order = signal<OrderDetail | null>(null);
  readonly history = signal<OrderHistoryEntry[]>([]);
  readonly loading = signal(true);
  readonly actioning = signal(false);
  readonly shipments = signal<Shipment[]>([]);
  readonly loadingShipments = signal(false);
  readonly savingLineId = signal<string | null>(null);

  /** Helper para usar Number() en el template. */
  readonly Number = Number;

  stockAvailableNum(l: OrderLine): number {
    return Number(l.stock_available ?? 0);
  }

  /** Cantidad original que pidió el cliente (snapshot al confirmar). */
  requestedQty(l: OrderLine): number {
    return Number(l.requested_quantity ?? l.quantity ?? 0);
  }

  /**
   * Tope al que se puede aprobar la línea: nunca más de lo que pidió el cliente
   * ni más de lo que hay disponible. Si la línea ya está por encima de uno de
   * los dos (data legacy), se mantiene el valor actual como piso para no
   * bloquear el input.
   */
  approvableMax(l: OrderLine): number {
    const cap = Math.min(this.requestedQty(l), this.stockAvailableNum(l));
    const qty = Number(l.quantity) || 0;
    return Math.max(cap, qty);
  }

  /** True si la cantidad aprobada excede el stock disponible (alerta visual). */
  lineShortfall(l: OrderLine, o: OrderDetail): boolean {
    if (o.status !== 'pending_approval') return false;
    return Number(l.quantity) > this.stockAvailableNum(l);
  }

  onLineQtyBlur(l: OrderLine, raw: any, o: OrderDetail): void {
    const next = Math.max(1, Number(raw) || 0);
    if (next === Number(l.quantity)) return;
    this.savingLineId.set(l.id);
    this.api.updateOrderLine(o.id, l.id, { quantity: next }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.savingLineId.set(null);
        this.toast.add({ severity: 'success', summary: 'Cantidad actualizada', life: 1800 });
        this.load(o.id);
      },
      error: (err) => {
        this.savingLineId.set(null);
        const detail = err?.error?.message || 'No se pudo actualizar la línea';
        this.toast.add({ severity: 'error', summary: 'Error', detail, life: 6000 });
        this.load(o.id);
      },
    });
  }

  confirmRemoveLine(l: OrderLine, o: OrderDetail): void {
    this.confirm.confirm({
      message: `¿Quitar "${l.product_name || l.product_id}" del pedido? Libera la reserva de stock.`,
      header: 'Quitar línea',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, quitar',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => {
        this.savingLineId.set(l.id);
        this.api.removeOrderLine(o.id, l.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
          next: () => {
            this.savingLineId.set(null);
            this.toast.add({ severity: 'success', summary: 'Línea quitada' });
            this.load(o.id);
          },
          error: (err) => {
            this.savingLineId.set(null);
            const detail = err?.error?.message || 'No se pudo quitar la línea';
            this.toast.add({ severity: 'error', summary: 'Error', detail });
          },
        });
      },
    });
  }

  readonly canSeeLogistics = computed(() => {
    const perms = this.auth.user()?.permissions || {};
    return perms[Permission.LOGISTICS_SHIPMENTS_VER] === true;
  });
  private readonly canManageLogistics = computed(() => {
    const perms = this.auth.user()?.permissions || {};
    return perms[Permission.LOGISTICS_SHIPMENTS_GESTIONAR] === true;
  });

  constructor() {
    const id = this.route.snapshot.paramMap.get('id');
    if (id) this.load(id);
  }

  load(id: string): void {
    this.loading.set(true);
    this.api.getOrder(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (o) => {
        this.order.set(o);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar el pedido' });
      },
    });
    this.api.getOrderHistory(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (h) => this.history.set(h.data || []),
      error: () => this.history.set([]),
    });
    if (this.canSeeLogistics()) {
      this.loadingShipments.set(true);
      this.logistica.listShipments({ order_id: id, pageSize: 100 }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => { this.shipments.set(r.items || []); this.loadingShipments.set(false); },
        error: () => { this.loadingShipments.set(false); /* silencioso: no romper la página */ },
      });
    }
  }

  /**
   * Solo permite crear embarques mientras el pedido esté `confirmed`. En `draft`
   * no tiene sentido (stock no reservado todavía) y en `fulfilled`/`cancelled`
   * tampoco. Requiere LOGISTICS_SHIPMENTS_GESTIONAR.
   */
  canCreateShipment(o: OrderDetail): boolean {
    return this.canManageLogistics() && o.status === 'confirmed';
  }

  sevShip(s: ShipmentStatus): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    return s === 'programado' ? 'info'
         : s === 'en_ruta'    ? 'warn'
         : s === 'entregado'  ? 'success'
         : s === 'cerrado'    ? 'secondary'
         : 'danger';
  }

  back(): void {
    this.router.navigate(['/comercial/orders']);
  }

  confirmTransition(action: 'confirm' | 'approve' | 'fulfill' | 'cancel', o: OrderDetail): void {
    const msg = {
      confirm: `¿Confirmar pedido ${o.folio}? Esto reserva el stock.`,
      approve: `¿Aprobar pedido ${o.folio}? Pasa a 'confirmed' y notifica al cliente.`,
      fulfill: `¿Marcar pedido ${o.folio} como entregado? Esto consume el stock reservado.`,
      cancel: `¿Cancelar pedido ${o.folio}? Esta acción libera reservas.`,
    }[action];
    const acceptCls = action === 'cancel' ? 'p-button-danger' : '';
    this.confirm.confirm({
      message: msg,
      header: 'Confirmar',
      icon: 'pi pi-question-circle',
      acceptLabel: 'Sí, continuar',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: acceptCls,
      accept: () => this.runTransition(action, o.id),
    });
  }

  private runTransition(action: 'confirm' | 'approve' | 'fulfill' | 'cancel', id: string): void {
    this.actioning.set(true);
    const obs =
      action === 'confirm'
        ? this.api.confirmOrder(id)
        : action === 'approve'
        ? this.api.approveOrder(id)
        : action === 'fulfill'
        ? this.api.fulfillOrder(id)
        : this.api.cancelOrder(id);
    obs.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.actioning.set(false);
        this.toast.add({ severity: 'success', summary: 'Pedido actualizado' });
        this.load(id);
      },
      error: (err) => {
        this.actioning.set(false);
        const detail = err?.error?.message || 'No se pudo aplicar el cambio';
        this.toast.add({ severity: 'error', summary: 'Error', detail });
      },
    });
  }

  severity(s: OrderStatus | null): 'info' | 'success' | 'warn' | 'danger' {
    if (s === 'fulfilled') return 'success';
    if (s === 'confirmed') return 'info';
    if (s === 'pending_approval') return 'warn';
    if (s === 'cancelled') return 'danger';
    return 'warn';
  }
  statusLabel(s: OrderStatus | null): string {
    if (!s) return 'inicial';
    return {
      draft: 'Borrador',
      pending_approval: 'Pendiente',
      confirmed: 'Confirmado',
      fulfilled: 'Entregado',
      cancelled: 'Cancelado',
    }[s];
  }
}
