import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { TimelineModule } from 'primeng/timeline';
import { MessageService, ConfirmationService } from 'primeng/api';
import { ComercialService, OrderDetail, OrderHistoryEntry, OrderStatus } from '../comercial.service';
import { LogisticaService, Shipment, ShipmentStatus } from '../../logistica/logistica.service';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';

@Component({
  selector: 'app-comercial-order-detail',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    ButtonModule,
    CardModule,
    TableModule,
    TagModule,
    ToastModule,
    ConfirmDialogModule,
    TimelineModule,
  ],
  providers: [MessageService, ConfirmationService],
  template: `
    <p-toast></p-toast>
    <p-confirmDialog></p-confirmDialog>

    <div class="topbar">
      <button pButton icon="pi pi-arrow-left" label="Volver" severity="secondary" [text]="true" (click)="back()"></button>
    </div>

    <ng-container *ngIf="order() as o">
      <div class="hero">
        <div>
          <h2><code>{{ o.folio }}</code></h2>
          <p class="muted">Creado {{ o.created_at | date:'medium' }} por <strong>{{ o.user_username || '—' }}</strong></p>
        </div>
        <div class="hero-tags">
          <p-tag
            [severity]="o.delivery_type === 'long_trip' ? 'warn' : 'info'"
            [value]="o.delivery_type === 'long_trip' ? 'Viaje largo' : 'Por ruta'"
            [icon]="o.delivery_type === 'long_trip' ? 'pi pi-globe' : 'pi pi-truck'"
          ></p-tag>
          <p-tag [severity]="severity(o.status)" [value]="statusLabel(o.status)" styleClass="status-tag"></p-tag>
        </div>
      </div>

      <div class="grid">
        <p-card header="Cliente" styleClass="info-card">
          <div class="strong">{{ o.customer_name || o.customer_id }}</div>
        </p-card>
        <p-card header="Almacén" styleClass="info-card">
          <div class="strong">{{ o.warehouse_name || '—' }}</div>
        </p-card>
        <p-card header="Total" styleClass="info-card">
          <div class="strong big">{{ o.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</div>
          <div class="muted small" *ngIf="o.discount_total">Descuento: {{ o.discount_total | currency:'MXN':'symbol-narrow':'1.2-2' }}</div>
        </p-card>
      </div>

      <p-card header="Líneas">
        <p-table [value]="o.lines" responsiveLayout="scroll" styleClass="p-datatable-sm">
          <ng-template pTemplate="header">
            <tr>
              <th>Producto</th>
              <th class="num">Cantidad</th>
              <th class="num">Precio unit</th>
              <th class="num">Desc%</th>
              <th class="num">Total línea</th>
            </tr>
          </ng-template>
          <ng-template pTemplate="body" let-l>
            <tr>
              <td>
                <div class="strong">{{ l.product_name || l.product_id }}</div>
                <div class="muted small" *ngIf="l.brand_name">{{ l.brand_name }}</div>
              </td>
              <td class="num">{{ l.quantity }}</td>
              <td class="num">{{ l.unit_price | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
              <td class="num">{{ (l.discount_percent * 100) | number:'1.0-1' }}%</td>
              <td class="num strong">{{ l.line_total | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
            </tr>
          </ng-template>
          <ng-template pTemplate="emptymessage">
            <tr><td colspan="5" class="muted">Sin líneas en este pedido.</td></tr>
          </ng-template>
        </p-table>
      </p-card>

      <div class="action-bar" *ngIf="o.status === 'draft' || o.status === 'confirmed'">
        <button pButton *ngIf="o.status === 'draft'" label="Confirmar pedido" icon="pi pi-check"
                [loading]="actioning()"
                (click)="confirmTransition('confirm', o)"></button>
        <button pButton *ngIf="o.status === 'confirmed'" label="Marcar entregado" icon="pi pi-truck"
                [loading]="actioning()"
                severity="success"
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
              <span class="muted small" *ngIf="shipments().length"> · {{ shipments().length }} asociados</span>
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
              <td><code>{{ s.folio }}</code></td>
              <td>{{ s.shipment_date | date:'shortDate' }}</td>
              <td>{{ s.type }}</td>
              <td class="muted">{{ (s.origin || '—') + ' → ' + (s.destination || '—') }}</td>
              <td><p-tag [severity]="sevShip(s.status)" [value]="s.status"></p-tag></td>
              <td class="actions">
                <a pButton icon="pi pi-arrow-right" size="small" [text]="true"
                   [routerLink]="['/logistica/shipments', s.id]" pTooltip="Ver embarque"></a>
              </td>
            </tr>
          </ng-template>
          <ng-template pTemplate="emptymessage">
            <tr><td colspan="6" class="muted">
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
                <span class="muted small" *ngIf="event.from_status">desde {{ statusLabel(event.from_status) }}</span>
                <span class="muted small" *ngIf="!event.from_status">creación</span>
              </div>
              <div class="event-meta">
                <span><i class="pi pi-user"></i> {{ event.changed_by_username }}</span>
                <span><i class="pi pi-clock"></i> {{ event.created_at | date:'medium' }}</span>
              </div>
              <div *ngIf="event.reason" class="event-reason">{{ event.reason }}</div>
            </div>
          </ng-template>
        </p-timeline>
        <div *ngIf="history().length === 0" class="muted">Sin historial registrado.</div>
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
    .hero { display:flex; justify-content:space-between; align-items:center; margin-bottom:1.25rem; }
    .hero h2 { margin:0 0 .25rem; font-size:1.5rem; }
    .muted { color: var(--text-color-secondary); }
    .muted.small { font-size:.8rem; }
    .strong { font-weight: 600; }
    .big { font-size: 1.5rem; }
    .grid { display:grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap:1rem; margin-bottom:1.25rem; }
    /* styleClass aplica la clase AL .p-card, no a un descendiente. */
    :host ::ng-deep .p-card.info-card .p-card-body { padding: 1rem 1.25rem; }
    .num { text-align: right; }
    code { background: var(--surface-100); padding:.2rem .5rem; border-radius:4px; }
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
    .actions { display:flex; justify-content:flex-end; gap:.25rem; }
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

  readonly order = signal<OrderDetail | null>(null);
  readonly history = signal<OrderHistoryEntry[]>([]);
  readonly loading = signal(true);
  readonly actioning = signal(false);
  readonly shipments = signal<Shipment[]>([]);
  readonly loadingShipments = signal(false);

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
    this.api.getOrder(id).subscribe({
      next: (o) => {
        this.order.set(o);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar el pedido' });
      },
    });
    this.api.getOrderHistory(id).subscribe({
      next: (h) => this.history.set(h.data || []),
      error: () => this.history.set([]),
    });
    if (this.canSeeLogistics()) {
      this.loadingShipments.set(true);
      this.logistica.listShipments({ order_id: id, pageSize: 100 }).subscribe({
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

  confirmTransition(action: 'confirm' | 'fulfill' | 'cancel', o: OrderDetail): void {
    const msg = {
      confirm: `¿Confirmar pedido ${o.folio}? Esto reserva el stock.`,
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

  private runTransition(action: 'confirm' | 'fulfill' | 'cancel', id: string): void {
    this.actioning.set(true);
    const obs =
      action === 'confirm'
        ? this.api.confirmOrder(id)
        : action === 'fulfill'
        ? this.api.fulfillOrder(id)
        : this.api.cancelOrder(id);
    obs.subscribe({
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
    if (s === 'cancelled') return 'danger';
    return 'warn';
  }
  statusLabel(s: OrderStatus | null): string {
    if (!s) return 'inicial';
    return { draft: 'Borrador', confirmed: 'Confirmado', fulfilled: 'Entregado', cancelled: 'Cancelado' }[s];
  }
}
