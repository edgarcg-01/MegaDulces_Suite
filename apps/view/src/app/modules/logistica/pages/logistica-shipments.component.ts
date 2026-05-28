import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { FormBuilder, FormGroup, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { TableModule } from 'primeng/table';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { DatePickerModule } from 'primeng/datepicker';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { TabsModule } from 'primeng/tabs';
import { TooltipModule } from 'primeng/tooltip';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { MessageService, ConfirmationService } from 'primeng/api';
import {
  LogisticaService, PendingOrder, Shipment, ShipmentStatus, ShipmentType, Vehicle,
} from '../logistica.service';
import { ShipmentFormDialogComponent } from '../components/shipment-form-dialog.component';

const STATUS_OPTIONS: { label: string; value: ShipmentStatus | '' }[] = [
  { label: 'Todos', value: '' },
  { label: 'Programado', value: 'programado' },
  { label: 'En ruta', value: 'en_ruta' },
  { label: 'Entregado', value: 'entregado' },
  { label: 'Cerrado', value: 'cerrado' },
  { label: 'Cancelado', value: 'cancelado' },
];
const TYPE_OPTIONS: { label: string; value: ShipmentType }[] = [
  { label: 'Entrega', value: 'entrega' },
  { label: 'Traspaso', value: 'traspaso' },
  { label: 'Recolección', value: 'recoleccion' },
];

type Severity = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';
function severityForStatus(s: ShipmentStatus): Severity {
  switch (s) {
    case 'programado': return 'info';
    case 'checklist_salida': return 'info';
    case 'en_ruta': return 'warn';
    case 'entregado': return 'success';
    case 'checklist_llegada': return 'success';
    case 'costos_pendientes': return 'warn';
    case 'cerrado': return 'secondary';
    case 'cancelado': return 'danger';
  }
}

@Component({
  selector: 'app-logistica-shipments',
  standalone: true,
  imports: [
    CommonModule, RouterLink, FormsModule, ReactiveFormsModule,
    ButtonModule, CardModule, TableModule, DialogModule,
    InputTextModule, InputNumberModule, DatePickerModule, SelectModule,
    TagModule, TabsModule, TooltipModule, ToastModule, ConfirmDialogModule,
    ShipmentFormDialogComponent,
  ],
  providers: [MessageService, ConfirmationService],
  template: `
    <p-toast></p-toast>
    <p-confirmDialog></p-confirmDialog>

    <div class="header-row">
      <div>
        <h2>Embarques</h2>
        <p class="muted">{{ page().total }} embarques registrados · {{ pendingOrders().length }} pedidos esperando programar.</p>
      </div>
      <div class="header-actions">
        <button pButton icon="pi pi-plus" label="Nuevo embarque" (click)="openCreate()"></button>
      </div>
    </div>

    <p-tabs value="shipments">
      <p-tablist>
        <p-tab value="shipments"><i class="pi pi-truck"></i> Embarques ({{ page().total }})</p-tab>
        <p-tab value="pending">
          <i class="pi pi-inbox"></i>
          Pendientes de programar
          <p-tag *ngIf="pendingOrders().length > 0" [value]="pendingOrders().length + ''" severity="warn" styleClass="ml-2"></p-tag>
        </p-tab>
      </p-tablist>
      <p-tabpanels>
        <!-- Tab 1: lista de embarques -->
        <p-tabpanel value="shipments">
          <div class="filter-row">
            <p-select [(ngModel)]="statusFilterValue" [options]="statusOptions" optionLabel="label" optionValue="value"
                      placeholder="Filtro" (onChange)="onFilterChange()" [showClear]="false"></p-select>
            <span class="muted small">Filtro: {{ statusFilter() || 'todos' }}</span>
          </div>
          <p-card>
            <p-table [value]="page().items" [loading]="loading()" responsiveLayout="scroll" styleClass="p-datatable-sm"
                     [paginator]="true" [rows]="page().pageSize" [totalRecords]="page().total" [lazy]="true"
                     (onLazyLoad)="onPageChange($event)">
              <ng-template pTemplate="header">
                <tr>
                  <th>Folio</th><th>Fecha</th><th>Tipo</th><th>Origen → Destino</th>
                  <th class="num">Cajas</th><th class="num">km</th><th>Estado</th><th></th>
                </tr>
              </ng-template>
              <ng-template pTemplate="body" let-s>
                <tr>
                  <td><code>{{ s.folio }}</code></td>
                  <td>{{ s.shipment_date | date:'shortDate' }}</td>
                  <td>{{ typeLabel(s.type) }}</td>
                  <td>{{ (s.origin || '—') + ' → ' + (s.destination || '—') }}</td>
                  <td class="num">{{ s.boxes_count }}</td>
                  <td class="num">{{ s.actual_km || '—' }}</td>
                  <td><p-tag [severity]="severity(s.status)" [value]="s.status"></p-tag></td>
                  <td class="actions">
                    <a pButton icon="pi pi-arrow-right" size="small" [text]="true" [routerLink]="['/logistica/shipments', s.id]"></a>
                    <button pButton *ngIf="s.status === 'programado'" icon="pi pi-send" size="small" severity="info" [text]="true"
                            pTooltip="Marcar en ruta" (click)="action(s, 'depart')"></button>
                    <button pButton *ngIf="s.status === 'en_ruta'" icon="pi pi-check" size="small" severity="success" [text]="true"
                            pTooltip="Marcar entregado" (click)="action(s, 'deliver')"></button>
                    <button pButton *ngIf="s.status === 'entregado'" icon="pi pi-lock" size="small" severity="secondary" [text]="true"
                            pTooltip="Cerrar" (click)="action(s, 'close')"></button>
                    <button pButton *ngIf="s.status === 'programado' || s.status === 'en_ruta'" icon="pi pi-times" size="small" severity="danger" [text]="true"
                            pTooltip="Cancelar" (click)="confirmCancel(s)"></button>
                  </td>
                </tr>
              </ng-template>
              <ng-template pTemplate="emptymessage">
                <tr><td colspan="8" class="muted">Sin embarques.</td></tr>
              </ng-template>
            </p-table>
          </p-card>
        </p-tabpanel>

        <!-- Tab 2: bandeja pedidos pendientes (J.7.1) -->
        <p-tabpanel value="pending">
          <div class="filter-row">
            <span class="muted small">
              Pedidos confirmed que aún no tienen embarque activo. Ordenados por fecha de confirmación (FIFO).
            </span>
            <button pButton icon="pi pi-refresh" label="Refrescar" size="small" severity="secondary" [text]="true"
                    (click)="loadPending()"></button>
          </div>
          <p-card>
            <p-table [value]="pendingOrders()" [loading]="loadingPending()" responsiveLayout="scroll" styleClass="p-datatable-sm">
              <ng-template pTemplate="header">
                <tr>
                  <th>Folio</th>
                  <th>Confirmado</th>
                  <th>Cliente</th>
                  <th>Almacén</th>
                  <th>Tipo entrega</th>
                  <th class="num">Total</th>
                  <th></th>
                </tr>
              </ng-template>
              <ng-template pTemplate="body" let-o>
                <tr>
                  <td><code>{{ o.code }}</code></td>
                  <td class="muted small">{{ o.confirmed_at | date:'short' }}</td>
                  <td>
                    <div class="strong">{{ o.customer_name || o.customer_id }}</div>
                    <div class="muted small" *ngIf="o.customer_code">{{ o.customer_code }}</div>
                  </td>
                  <td>{{ o.warehouse_name || '—' }}</td>
                  <td>
                    <p-tag
                      [severity]="o.delivery_type === 'long_trip' ? 'warn' : 'info'"
                      [value]="o.delivery_type === 'long_trip' ? 'Viaje largo' : 'Por ruta'"
                    ></p-tag>
                  </td>
                  <td class="num strong">\${{ o.total | number:'1.2-2' }}</td>
                  <td class="actions">
                    <button pButton icon="pi pi-plus" label="Crear embarque" size="small" severity="success"
                            (click)="openCreateForOrder(o)"></button>
                  </td>
                </tr>
              </ng-template>
              <ng-template pTemplate="emptymessage">
                <tr><td colspan="7" class="muted">
                  Sin pedidos pendientes. Logística al día 🎉
                </td></tr>
              </ng-template>
            </p-table>
          </p-card>
        </p-tabpanel>
      </p-tabpanels>
    </p-tabs>

    <!-- J.9.10 — Shipment Form rico (componente standalone) -->
    <app-shipment-form-dialog
      [visible]="dialogVisible"
      [prefilledOrderId]="prefilledOrderId()"
      (visibleChange)="dialogVisible = $event"
      (saved)="onShipmentCreated($event)"
    ></app-shipment-form-dialog>
  `,
  styles: [`
    :host { display:block; }
    .header-row { display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:1rem; gap:1rem; }
    .header-row h2 { margin:0 0 .25rem; font-size:1.25rem; }
    .header-actions { display:flex; gap:.75rem; align-items:center; }
    .muted { color: var(--text-color-secondary); font-size:.85rem; margin:0; }
    .num { font-variant-numeric: tabular-nums; text-align:right; }
    .actions { display:flex; gap:.25rem; justify-content:flex-end; }
    code { background: var(--surface-100); padding:.15rem .4rem; border-radius:4px; font-size:.85rem; font-weight: 600; }
    .form { display:flex; flex-direction:column; gap:.85rem; }
    .form label { display:flex; flex-direction:column; gap:.25rem; font-size:.85rem; color:var(--text-color-secondary); }
    .form em { color: var(--bad-fg); font-style:normal; }
    .row { display:grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    .row.three { grid-template-columns: 1fr 1fr 1fr; }
    .link-banner { display:flex; align-items:flex-start; gap:.5rem; background: var(--ok-soft-bg); color: var(--ok-soft-fg); padding:.6rem .8rem; border-radius:6px; font-size:.85rem; }
    .link-banner i { margin-top:.15rem; }
    /* J.7.1 — bandeja pendientes */
    .filter-row { display:flex; align-items:center; gap: 1rem; margin: .5rem 0; }
    .filter-row .small { font-size:.8rem; }
    .strong { font-weight: 600; }
    .small { font-size: .8rem; }
    :host ::ng-deep .ml-2 { margin-left: .5rem; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogisticaShipmentsComponent {
  private readonly api = inject(LogisticaService);
  private readonly fb = inject(FormBuilder);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);

  readonly page = signal<{ items: Shipment[]; total: number; pageSize: number; page: number }>({
    items: [], total: 0, pageSize: 25, page: 1,
  });
  readonly loading = signal(false);
  readonly saving = signal(false);

  readonly vehicles = signal<Vehicle[]>([]);
  readonly vehicleOptions = computed(() =>
    this.vehicles().map((v) => ({ label: `${v.plate} — ${v.model || ''}`, value: v.id })),
  );

  dialogVisible = false;
  /** Order_id pre-llenado para el form rico (J.9.10), via signal para reactividad. */
  readonly prefilledOrderId = signal<string | null>(null);
  statusFilterValue: ShipmentStatus | '' = '';
  readonly statusFilter = signal<ShipmentStatus | ''>('');
  readonly statusOptions = STATUS_OPTIONS;
  readonly typeOptions = TYPE_OPTIONS;

  // J.7.1 — bandeja de pedidos confirmed sin shipment activo
  readonly pendingOrders = signal<PendingOrder[]>([]);
  readonly loadingPending = signal(false);

  // El form inline fue reemplazado por <app-shipment-form-dialog> (J.9.10).
  // Lo dejamos undefined para no romper imports legacy, pero ya no se usa.
  form: any = null;

  private readonly route = inject(ActivatedRoute);

  constructor() {
    this.load(1);
    this.loadPending();
    this.api.listVehicles({ active: true }).subscribe((r) => this.vehicles.set(r || []));
    // Si entramos con ?order_id=X (link desde comercial-order-detail "Crear embarque"),
    // auto-abrir el dialog con order_id pre-llenado.
    this.route.queryParamMap.subscribe((q) => {
      const orderId = q.get('order_id');
      if (orderId) this.openCreate(orderId);
    });
  }

  /** J.7.1 — carga bandeja de pedidos confirmed pendientes de embarque. */
  loadPending() {
    this.loadingPending.set(true);
    this.api.listPendingOrders().subscribe({
      next: (r) => { this.pendingOrders.set(r || []); this.loadingPending.set(false); },
      error: () => { this.loadingPending.set(false); /* silencioso */ },
    });
  }

  /**
   * J.7.1 — Click "Crear embarque" en una fila de pendientes.
   * Pre-llena order_id + customer destination + cajas estimadas del order.
   */
  /**
   * J.7.1 — Click "Crear embarque" en una fila de pendientes.
   * Pre-llena order_id (el form rico J.9.10 hace el resto de pre-fill via su
   * propio effect sobre prefilledOrderId).
   */
  openCreateForOrder(o: PendingOrder) {
    this.openCreate(o.id);
  }

  load(page: number, pageSize = 25) {
    this.loading.set(true);
    const status = this.statusFilter() || undefined;
    this.api.listShipments({ status, page, pageSize }).subscribe({
      next: (r) => {
        this.page.set({ items: r.items, total: r.total, pageSize: r.pageSize, page: r.page });
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.toast.add({ severity:'error', summary:'Error', detail:'No se cargaron embarques' });
      },
    });
  }

  onPageChange(ev: any) {
    const page = Math.floor((ev.first || 0) / (ev.rows || 25)) + 1;
    this.load(page, ev.rows || 25);
  }
  onFilterChange() {
    this.statusFilter.set(this.statusFilterValue);
    this.load(1);
  }

  severity(s: ShipmentStatus): Severity { return severityForStatus(s); }
  typeLabel(t: ShipmentType): string {
    return TYPE_OPTIONS.find((o) => o.value === t)?.label || t;
  }

  /** J.9.10 — abre el form rico (componente standalone) con pre-fill opcional. */
  openCreate(prefilledOrderId?: string) {
    this.prefilledOrderId.set(prefilledOrderId || null);
    this.dialogVisible = true;
  }

  /** Handler cuando el form rico emite `saved` — refresca lista + pendientes. */
  onShipmentCreated(_s: Shipment): void {
    this.load(this.page().page);
    this.loadPending();
  }

  action(s: Shipment, kind: 'depart' | 'deliver' | 'close') {
    const fn = kind === 'depart' ? this.api.shipmentDepart(s.id)
            : kind === 'deliver' ? this.api.shipmentDeliver(s.id)
            : this.api.shipmentClose(s.id);
    fn.subscribe({
      next: () => {
        this.toast.add({ severity:'success', summary:`Embarque ${s.folio} actualizado` });
        this.load(this.page().page);
      },
      error: (err) => this.toast.add({ severity:'error', summary:'Error', detail: err?.error?.message || 'No se pudo' }),
    });
  }
  confirmCancel(s: Shipment) {
    this.confirm.confirm({
      message: `¿Cancelar embarque ${s.folio}? Esto liberará la unidad asignada.`,
      header: 'Confirmar', icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, cancelar', rejectLabel: 'Volver',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => this.api.shipmentCancel(s.id, 'Cancelado desde admin').subscribe({
        next: () => { this.toast.add({ severity:'info', summary:'Embarque cancelado' }); this.load(this.page().page); },
        error: (err) => this.toast.add({ severity:'error', summary:'Error', detail: err?.error?.message || 'No se pudo' }),
      }),
    });
  }
}
