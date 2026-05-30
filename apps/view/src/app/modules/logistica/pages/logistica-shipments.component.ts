import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { forkJoin } from 'rxjs';
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
import { SkeletonModule } from 'primeng/skeleton';
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
    CommonModule, FormsModule, ReactiveFormsModule,
    ButtonModule, CardModule, TableModule, DialogModule,
    InputTextModule, InputNumberModule, DatePickerModule, SelectModule,
    TagModule, SkeletonModule, TooltipModule, ToastModule, ConfirmDialogModule,
    ShipmentFormDialogComponent,
  ],
  providers: [MessageService, ConfirmationService],
  template: `
    <div class="surf-page sh">
      <p-toast></p-toast>
      <p-confirmDialog></p-confirmDialog>

      <!-- PAGE HEAD -->
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Embarques</h1>
          <p class="surf-page-sub">
            <b>{{ page().total }}</b> registrado{{ page().total === 1 ? '' : 's' }}
            <span class="sh-divider" aria-hidden="true">·</span>
            <b>{{ pendingOrders().length }}</b> pedido{{ pendingOrders().length === 1 ? '' : 's' }} esperando programar
          </p>
        </div>
        <div class="sh-head-actions">
          <button
            pButton
            icon="pi pi-refresh"
            [text]="true"
            severity="secondary"
            size="small"
            (click)="reloadCurrent()"
            [loading]="loading() || loadingPending() || loadingStats()"
            pTooltip="Refrescar"
          ></button>
          <button
            pButton
            icon="pi pi-plus"
            label="Nuevo embarque"
            size="small"
            (click)="openCreate()"
          ></button>
        </div>
      </header>

      <!-- KPI STRIP -->
      <p-skeleton *ngIf="loadingStats()" height="120px"></p-skeleton>
      <div *ngIf="!loadingStats() && stats() as st" class="sheet cols-12">
        <article class="cell cell-span-3">
          <span class="cell-icon is-accent" aria-hidden="true">
            <i class="pi pi-truck"></i>
          </span>
          <span class="cell-label">Total embarques</span>
          <span class="cell-value is-headline">{{ st.total }}</span>
          <span class="cell-sub">registrados en el tenant</span>
        </article>

        <article class="cell cell-span-3">
          <span class="cell-icon is-warn" aria-hidden="true">
            <i class="pi pi-send"></i>
          </span>
          <span class="cell-label">En ruta</span>
          <span class="cell-value">{{ st.enRuta }}</span>
          <span class="cell-sub">en tránsito</span>
        </article>

        <article class="cell cell-span-3">
          <span class="cell-icon is-ok" aria-hidden="true">
            <i class="pi pi-check-circle"></i>
          </span>
          <span class="cell-label">Entregados</span>
          <span class="cell-value">{{ st.entregados }}</span>
          <span class="cell-sub">completados</span>
        </article>

        <article class="cell cell-span-3">
          <span class="cell-icon is-info" aria-hidden="true">
            <i class="pi pi-inbox"></i>
          </span>
          <span class="cell-label">Pendientes</span>
          <span class="cell-value">{{ pendingOrders().length }}</span>
          <span class="cell-sub">esperando programar</span>
        </article>
      </div>

      <!-- MODE TABS sheet propio -->
      <div class="sheet cols-12">
        <article class="cell cell-span-12 is-flush sh-tabs-cell">
          <nav class="sh-mode-tabs" role="tablist" aria-label="Vista de embarques">
            <button
              type="button"
              class="sh-mode-tab"
              [class.active]="mode() === 'shipments'"
              role="tab"
              [attr.aria-selected]="mode() === 'shipments'"
              (click)="setMode('shipments')"
            >
              <i class="pi pi-truck" aria-hidden="true"></i>
              <span>Embarques</span>
              <span class="sh-mode-count">{{ page().total }}</span>
            </button>
            <button
              type="button"
              class="sh-mode-tab"
              [class.active]="mode() === 'pending'"
              role="tab"
              [attr.aria-selected]="mode() === 'pending'"
              (click)="setMode('pending')"
            >
              <i class="pi pi-inbox" aria-hidden="true"></i>
              <span>Pendientes</span>
              <span class="sh-mode-count is-warn" *ngIf="pendingOrders().length > 0">
                {{ pendingOrders().length }}
              </span>
            </button>
          </nav>
        </article>
      </div>

      <!-- ── MODE: SHIPMENTS ── -->
      <ng-container *ngIf="mode() === 'shipments'">
        <!-- Filter toolbar -->
        <div class="sheet cols-12">
          <article class="cell cell-span-12 is-flush sh-filters-cell">
            <div class="sh-toolbar">
              <div class="sh-field">
                <i class="pi pi-filter sh-field-icon" aria-hidden="true"></i>
                <p-select
                  [(ngModel)]="statusFilterValue"
                  [options]="statusOptions"
                  optionLabel="label"
                  optionValue="value"
                  (onChange)="onFilterChange()"
                  [showClear]="false"
                  placeholder="Todos los estados"
                  styleClass="sh-status-select"
                  appendTo="body"
                ></p-select>
              </div>

              <div class="sh-toolbar-spacer"></div>

              <button
                *ngIf="statusFilterValue"
                type="button"
                class="sh-reset"
                (click)="clearFilter()"
              >
                <i class="pi pi-refresh" aria-hidden="true"></i>
                <span>Reset</span>
              </button>
            </div>
          </article>
        </div>

        <!-- Tabla flush -->
        <div class="sheet cols-12">
          <article class="cell cell-span-12 is-flush">
            <p-table [value]="page().items" [loading]="loading()" responsiveLayout="scroll" styleClass="p-datatable-sm"
                     [paginator]="true" [rows]="page().pageSize" [totalRecords]="page().total" [lazy]="true"
                     (onLazyLoad)="onPageChange($event)">
              <ng-template pTemplate="header">
                <tr>
                  <th>Folio</th>
                  <th>Fecha</th>
                  <th>Tipo</th>
                  <th>Origen → Destino</th>
                  <th class="comm-num">Cajas</th>
                  <th class="comm-num">km</th>
                  <th>Estado</th>
                  <th></th>
                </tr>
              </ng-template>
              <ng-template pTemplate="body" let-s>
                <tr (click)="goDetail(s)" class="comm-row-clickable">
                  <td><code class="comm-code">{{ s.folio }}</code></td>
                  <td>{{ s.shipment_date | date:'dd MMM' }}</td>
                  <td>{{ typeLabel(s.type) }}</td>
                  <td class="comm-cell-strong">{{ (s.origin || '—') + ' → ' + (s.destination || '—') }}</td>
                  <td class="comm-num">{{ s.boxes_count }}</td>
                  <td class="comm-num">{{ s.actual_km || '—' }}</td>
                  <td>
                    <span class="comm-pill" [class]="statusPillClass(s.status)">
                      {{ statusLabel(s.status) }}
                    </span>
                  </td>
                  <td class="comm-actions" (click)="$event.stopPropagation()">
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
                <tr>
                  <td colspan="8" class="sh-empty-cell">
                    <div class="sh-empty">
                      <div class="sh-empty-icon"><i class="pi pi-truck" aria-hidden="true"></i></div>
                      <h3>Sin embarques</h3>
                      <p>{{ statusFilterValue ? 'No hay embarques en este estado.' : 'Creá tu primer embarque para empezar a operar.' }}</p>
                      <button
                        type="button"
                        pButton
                        [icon]="statusFilterValue ? 'pi pi-refresh' : 'pi pi-plus'"
                        severity="primary"
                        size="small"
                        [label]="statusFilterValue ? 'Limpiar filtro' : 'Nuevo embarque'"
                        (click)="statusFilterValue ? clearFilter() : openCreate()"
                      ></button>
                    </div>
                  </td>
                </tr>
              </ng-template>
            </p-table>
          </article>
        </div>
      </ng-container>

      <!-- ── MODE: PENDING ── -->
      <ng-container *ngIf="mode() === 'pending'">
        <!-- Tabla pendientes flush -->
        <div class="sheet cols-12">
          <article class="cell cell-span-12 is-flush">
            <p-table [value]="pendingOrders()" [loading]="loadingPending()" responsiveLayout="scroll" styleClass="p-datatable-sm">
              <ng-template pTemplate="header">
                <tr>
                  <th>Folio</th>
                  <th>Confirmado</th>
                  <th>Cliente</th>
                  <th>Almacén</th>
                  <th>Entrega</th>
                  <th class="comm-num">Total</th>
                  <th></th>
                </tr>
              </ng-template>
              <ng-template pTemplate="body" let-o>
                <tr>
                  <td><code class="comm-code">{{ o.code }}</code></td>
                  <td>
                    <div>{{ o.confirmed_at | date:'dd MMM' }}</div>
                    <div class="comm-muted is-small">{{ o.confirmed_at | date:'HH:mm' }}</div>
                  </td>
                  <td>
                    <div class="comm-cell-strong">{{ o.customer_name || o.customer_id }}</div>
                    <div class="comm-muted is-small" *ngIf="o.customer_code">{{ o.customer_code }}</div>
                  </td>
                  <td>{{ o.warehouse_name || '—' }}</td>
                  <td>
                    <span class="sh-delivery" [class.is-long]="o.delivery_type === 'long_trip'">
                      <i [class]="o.delivery_type === 'long_trip' ? 'pi pi-globe' : 'pi pi-truck'" aria-hidden="true"></i>
                      {{ o.delivery_type === 'long_trip' ? 'Viaje largo' : 'Por ruta' }}
                    </span>
                  </td>
                  <td class="comm-num is-strong">{{ o.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  <td class="comm-actions">
                    <button pButton icon="pi pi-plus" label="Crear" size="small" severity="primary"
                            (click)="openCreateForOrder(o)" pTooltip="Crear embarque"></button>
                  </td>
                </tr>
              </ng-template>
              <ng-template pTemplate="emptymessage">
                <tr>
                  <td colspan="7" class="sh-empty-cell">
                    <div class="sh-empty">
                      <div class="sh-empty-icon is-ok"><i class="pi pi-check" aria-hidden="true"></i></div>
                      <h3>Logística al día</h3>
                      <p>No hay pedidos confirmados esperando programación.</p>
                    </div>
                  </td>
                </tr>
              </ng-template>
            </p-table>
          </article>
        </div>
      </ng-container>

      <!-- J.9.10 — Shipment Form rico -->
      <app-shipment-form-dialog
        [visible]="dialogVisible"
        [prefilledOrderId]="prefilledOrderId()"
        (visibleChange)="dialogVisible = $event"
        (saved)="onShipmentCreated($event)"
      ></app-shipment-form-dialog>
    </div>
  `,
  styles: [`
    :host { display:block; }

    .sh-head-actions { display:flex; gap:.5rem; align-items:center; }
    .sh-divider { opacity: 0.4; }
    .surf-page-sub b { font-weight: var(--fw-bold); color: var(--c-text-1); }

    /* ── MODE TABS sheet propio (entre KPI y filtros) ── */
    .sh-tabs-cell {
      display: flex;
      padding: .5rem .75rem;
    }
    .sh-mode-tabs {
      display: inline-flex;
      gap: .25rem;
      padding: 3px;
      background: var(--c-surface-2);
      border: 1px solid var(--c-divider);
      border-radius: 10px;
    }
    .sh-mode-tab {
      display: inline-flex;
      align-items: center;
      gap: .4rem;
      background: transparent;
      border: none;
      padding: .4rem .75rem;
      font-size: var(--fs-sm);
      font-weight: var(--fw-medium);
      color: var(--c-text-2);
      cursor: pointer;
      border-radius: 7px;
      transition: all 120ms var(--ease-standard);
      white-space: nowrap;
    }
    .sh-mode-tab:hover { color: var(--c-text-1); }
    .sh-mode-tab.active {
      background: var(--c-surface-1);
      color: var(--c-text-1);
      box-shadow: 0 1px 2px rgba(0,0,0,.08);
      font-weight: var(--fw-bold);
    }
    .sh-mode-tab i { font-size: var(--fs-sm); }
    .sh-mode-count {
      background: var(--c-surface-1);
      color: var(--c-text-2);
      border: 1px solid var(--c-divider);
      font-size: var(--fs-micro);
      font-weight: var(--fw-bold);
      padding: .05rem .4rem;
      border-radius: 999px;
      font-variant-numeric: tabular-nums;
      min-width: 18px;
      text-align: center;
    }
    .sh-mode-tab.active .sh-mode-count {
      background: var(--c-surface-2);
      border-color: var(--c-divider);
    }
    .sh-mode-count.is-warn {
      background: rgba(245, 158, 11, 0.12);
      color: var(--c-warn);
      border-color: transparent;
    }

    /* ── TOOLBAR (filter cell) ── */
    .sh-filters-cell { display: flex; flex-direction: column; }
    .sh-toolbar {
      display: flex;
      align-items: center;
      gap: .5rem;
      padding: .625rem .875rem;
      flex-wrap: wrap;
    }
    .sh-toolbar-spacer { flex: 1; min-width: 0; }

    .sh-field {
      display: inline-flex;
      align-items: center;
      height: 32px;
      min-width: 220px;
      background: var(--c-surface-1);
      border: 1px solid var(--c-divider);
      border-radius: 8px;
      padding: 0 .5rem;
      gap: .35rem;
      transition: border-color 120ms var(--ease-standard);
    }
    .sh-field:focus-within {
      border-color: var(--c-text-1);
      box-shadow: 0 0 0 3px rgba(248, 180, 0, 0.15);
    }
    .sh-field-icon { color: var(--c-text-3); font-size: var(--fs-sm); flex-shrink: 0; }
    :host ::ng-deep .sh-status-select.p-select {
      flex: 1;
      border: none !important;
      background: transparent !important;
      box-shadow: none !important;
    }
    :host ::ng-deep .sh-status-select.p-select .p-select-label {
      padding: 0 !important;
      height: 28px !important;
      font-size: var(--fs-sm) !important;
      color: var(--c-text-1) !important;
      display: flex;
      align-items: center;
    }

    .sh-reset {
      display: inline-flex;
      align-items: center;
      gap: .35rem;
      height: 32px;
      padding: 0 .75rem;
      background: transparent;
      border: 1px solid var(--c-divider);
      border-radius: 8px;
      color: var(--c-text-2);
      font-size: var(--fs-xs);
      font-weight: var(--fw-medium);
      cursor: pointer;
      transition: all 120ms var(--ease-standard);
    }
    .sh-reset:hover {
      color: var(--c-bad);
      border-color: var(--c-bad);
      background: rgba(220, 38, 38, 0.06);
    }

    /* ── DELIVERY PILL (consistente con comercial-orders) ── */
    .sh-delivery {
      display: inline-flex;
      align-items: center;
      gap: .35rem;
      padding: .15rem .55rem;
      border-radius: 6px;
      background: var(--c-surface-2);
      color: var(--c-text-1);
      font-size: var(--fs-xs);
      font-weight: var(--fw-medium);
      white-space: nowrap;
    }
    .sh-delivery i { font-size: var(--fs-xs); color: var(--c-text-2); }
    .sh-delivery.is-long {
      background: var(--warn-soft-bg);
      color: var(--warn-soft-fg, var(--c-warn));
    }
    .sh-delivery.is-long i { color: var(--c-warn); }

    /* ── EMPTY STATE ── */
    .sh-empty-cell { padding: 0 !important; }
    .sh-empty {
      text-align: center;
      padding: 3rem 1.5rem;
      max-width: 420px;
      margin: 0 auto;
    }
    .sh-empty-icon {
      width: 56px;
      height: 56px;
      margin: 0 auto 1rem;
      border-radius: 14px;
      background: var(--c-surface-2);
      color: var(--c-text-2);
      display: grid;
      place-items: center;
      font-size: 1.5rem;
    }
    .sh-empty-icon.is-ok {
      background: rgba(22, 163, 74, 0.10);
      color: var(--c-ok);
    }
    .sh-empty h3 {
      margin: 0 0 .375rem;
      font-size: var(--fs-h3);
      font-weight: var(--fw-bold);
      color: var(--c-text-1);
    }
    .sh-empty p {
      margin: 0 0 1rem;
      color: var(--c-text-2);
      font-size: var(--fs-sm);
      line-height: 1.4;
    }
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
  readonly mode = signal<'shipments' | 'pending'>('shipments');

  // KPI strip stats (fetch paralelo con forkJoin)
  readonly loadingStats = signal(true);
  readonly stats = signal<{ total: number; enRuta: number; entregados: number; cancelados: number } | null>(null);

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
  private readonly router = inject(Router);

  constructor() {
    this.load(1);
    this.loadPending();
    this.loadStats();
    this.api.listVehicles({ active: true }).subscribe((r) => this.vehicles.set(r || []));
    // Si entramos con ?order_id=X (link desde comercial-order-detail "Crear embarque"),
    // auto-abrir el dialog con order_id pre-llenado.
    this.route.queryParamMap.subscribe((q) => {
      const orderId = q.get('order_id');
      if (orderId) this.openCreate(orderId);
    });
  }

  /** Counts paralelos por estado para el KPI strip. */
  loadStats() {
    this.loadingStats.set(true);
    forkJoin({
      total:       this.api.listShipments({ pageSize: 1 }),
      enRuta:      this.api.listShipments({ status: 'en_ruta', pageSize: 1 }),
      entregados:  this.api.listShipments({ status: 'entregado', pageSize: 1 }),
      cancelados:  this.api.listShipments({ status: 'cancelado', pageSize: 1 }),
    }).subscribe({
      next: (r) => {
        this.stats.set({
          total:      r.total?.total || 0,
          enRuta:     r.enRuta?.total || 0,
          entregados: r.entregados?.total || 0,
          cancelados: r.cancelados?.total || 0,
        });
        this.loadingStats.set(false);
      },
      error: () => this.loadingStats.set(false),
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

  clearFilter() {
    this.statusFilterValue = '';
    this.statusFilter.set('');
    this.load(1);
  }

  setMode(m: 'shipments' | 'pending') {
    if (this.mode() === m) return;
    this.mode.set(m);
    if (m === 'pending') this.loadPending();
  }

  /** Refresca lo visible + recalcula stats. */
  reloadCurrent() {
    this.loadStats();
    if (this.mode() === 'shipments') this.load(this.page().page);
    else this.loadPending();
  }

  goDetail(s: Shipment) {
    this.router.navigate(['/logistica/shipments', s.id]);
  }

  severity(s: ShipmentStatus): Severity { return severityForStatus(s); }
  typeLabel(t: ShipmentType): string {
    return TYPE_OPTIONS.find((o) => o.value === t)?.label || t;
  }

  /** Clase de comm-pill semántica por estado de embarque. */
  statusPillClass(s: ShipmentStatus): string {
    switch (s) {
      case 'programado':
      case 'checklist_salida':
        return 'is-info';
      case 'en_ruta':
      case 'costos_pendientes':
        return 'is-warn';
      case 'entregado':
      case 'checklist_llegada':
        return 'is-ok';
      case 'cerrado':
        return 'is-neutral';
      case 'cancelado':
        return 'is-bad';
    }
  }

  /** Label legible de estado (reemplaza al raw value `programado` etc.). */
  statusLabel(s: ShipmentStatus): string {
    const map: Record<ShipmentStatus, string> = {
      programado: 'Programado',
      checklist_salida: 'Checklist salida',
      en_ruta: 'En ruta',
      entregado: 'Entregado',
      checklist_llegada: 'Checklist llegada',
      costos_pendientes: 'Costos pendientes',
      cerrado: 'Cerrado',
      cancelado: 'Cancelado',
    };
    return map[s] || s;
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
