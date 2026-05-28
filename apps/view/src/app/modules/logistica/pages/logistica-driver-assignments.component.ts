import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { LogisticaService, Shipment, ShipmentStatus } from '../logistica.service';
import { DeliveryWizardComponent } from '../components/delivery-wizard.component';

type Severity = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';

/**
 * J.9.7 — Driver Assignments / "Mis entregas".
 *
 * Migrado del repo `_imported/logistica/.../features/driver-assignments/`.
 *
 * Mobile-first: cards en móvil (<= 600px), tabla en desktop. Integra
 * DeliveryWizardComponent que se abre al tap en una shipment.
 *
 * Consume `GET /logistics/shipments/my-driver` (filtra por driver_id del
 * JWT user vía lookup logistics.drivers.user_id).
 */
@Component({
  selector: 'app-logistica-driver-assignments',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    ButtonModule, CardModule, TableModule, TagModule, SelectModule, ToastModule,
    DeliveryWizardComponent,
  ],
  providers: [MessageService],
  template: `
    <p-toast></p-toast>

    <div class="header-row">
      <div>
        <h2>Mis entregas</h2>
        <p class="muted">Shipments asignados a vos como chofer o ayudante.</p>
      </div>
      <div class="filter-bar">
        <p-select
          [(ngModel)]="statusFilter"
          [options]="filterOptions"
          optionLabel="label"
          optionValue="value"
          (onChange)="reload()"
          [showClear]="true"
          placeholder="Estado"
          styleClass="filter-select"
        ></p-select>
        <button pButton icon="pi pi-refresh" label="Refrescar" severity="secondary" (click)="reload()" [loading]="loading()"></button>
      </div>
    </div>

    <!-- Empty state -->
    <p-card *ngIf="!loading() && shipments().length === 0">
      <div class="empty-state">
        <i class="pi pi-truck"></i>
        <h3>Sin entregas pendientes</h3>
        <p class="muted">No tenés shipments asignados con los filtros actuales.</p>
      </div>
    </p-card>

    <!-- ──────────── MOBILE: cards (visible <=600px) ──────────── -->
    <div class="cards-mobile" *ngIf="shipments().length > 0">
      <div *ngFor="let s of shipments()" class="ship-card" (click)="openWizard(s)">
        <div class="ship-row1">
          <div class="ship-folio"><code>{{ s.folio }}</code></div>
          <p-tag [severity]="statusSeverity(s.status)" [value]="statusLabel(s.status)"></p-tag>
        </div>
        <div class="ship-row2">
          <strong>{{ s.customer_name || s.order_code || '—' }}</strong>
          <span class="muted small">{{ s.shipment_date | date:'mediumDate' }}</span>
        </div>
        <div class="ship-row3 muted small">
          <span><i class="pi pi-arrow-right-arrow-left"></i> {{ s.origin || '—' }} → {{ s.destination || '—' }}</span>
        </div>
        <div class="ship-row4 muted small" *ngIf="s.vehicle_plate">
          <i class="pi pi-truck"></i> {{ s.vehicle_plate }} {{ s.vehicle_model ? '· ' + s.vehicle_model : '' }}
        </div>
        <button pButton class="ship-action" [label]="actionLabel(s.status)" [icon]="actionIcon(s.status)" (click)="$event.stopPropagation(); openWizard(s)"></button>
      </div>
    </div>

    <!-- ──────────── DESKTOP: table (visible >600px) ──────────── -->
    <p-card class="table-desktop" *ngIf="shipments().length > 0">
      <p-table [value]="shipments()" [loading]="loading()" responsiveLayout="scroll" styleClass="p-datatable-sm" [paginator]="true" [rows]="10">
        <ng-template pTemplate="header">
          <tr>
            <th>Folio</th>
            <th>Fecha</th>
            <th>Cliente / Pedido</th>
            <th>Ruta</th>
            <th>Vehículo</th>
            <th>Estado</th>
            <th></th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-s>
          <tr>
            <td><code>{{ s.folio }}</code></td>
            <td>{{ s.shipment_date | date:'mediumDate' }}</td>
            <td><strong>{{ s.customer_name || s.order_code || '—' }}</strong></td>
            <td class="small">{{ s.origin || '—' }} → {{ s.destination || '—' }}</td>
            <td>
              <span *ngIf="s.vehicle_plate">{{ s.vehicle_plate }}</span>
              <span *ngIf="!s.vehicle_plate" class="muted">—</span>
            </td>
            <td><p-tag [severity]="statusSeverity(s.status)" [value]="statusLabel(s.status)"></p-tag></td>
            <td class="actions">
              <button pButton [label]="actionLabel(s.status)" [icon]="actionIcon(s.status)" size="small" (click)="openWizard(s)"></button>
            </td>
          </tr>
        </ng-template>
      </p-table>
    </p-card>

    <!-- Wizard -->
    <app-delivery-wizard
      [visible]="wizardOpen()"
      [shipmentId]="selectedId()"
      (visibleChange)="onWizardVisibleChange($event)"
      (completed)="onDeliveryCompleted()"
      (statusChanged)="onStatusChanged($event)"
    ></app-delivery-wizard>
  `,
  styles: [`
    :host { display:block; }

    .header-row { display:flex; justify-content:space-between; align-items:flex-end; gap:1rem; flex-wrap:wrap; margin-bottom:1rem; }
    .header-row h2 { margin:0 0 .25rem; font-size:1.25rem; }
    .muted { color: var(--text-color-secondary); font-size:.85rem; margin:0; }
    .small { font-size:.75rem; }
    .filter-bar { display:flex; gap:.5rem; align-items:center; flex-wrap:wrap; }
    :host ::ng-deep .filter-select { min-width: 180px; }
    .actions { display:flex; gap:.25rem; justify-content:flex-end; }
    code { background: var(--surface-100); padding:.1rem .35rem; border-radius:3px; font-size:.85rem; }

    .empty-state { text-align:center; padding: 3rem 1rem; }
    .empty-state i { font-size: 3rem; color: var(--text-color-secondary); margin-bottom:1rem; display:block; }
    .empty-state h3 { margin: 0 0 .5rem; font-weight: 600; }

    /* Mobile cards */
    .cards-mobile { display:none; flex-direction:column; gap:.75rem; }
    .ship-card {
      background: var(--surface-card, var(--surface-50));
      border-left: 4px solid var(--primary-color);
      border-radius: 10px;
      padding: 1rem;
      cursor: pointer;
      transition: transform .15s, box-shadow .15s;
    }
    .ship-card:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,.1); }
    .ship-row1 { display:flex; justify-content:space-between; align-items:center; margin-bottom:.5rem; }
    .ship-folio code { background: transparent; padding: 0; font-weight: 700; font-size:.95rem; }
    .ship-row2 { display:flex; justify-content:space-between; align-items:center; margin-bottom:.25rem; }
    .ship-row3, .ship-row4 { margin-bottom:.25rem; }
    .ship-action { margin-top:.75rem; width: 100%; }

    /* Responsive: mobile <=600px = cards, >600px = table */
    @media (max-width: 600px) {
      .cards-mobile { display: flex; }
      .table-desktop { display: none; }
    }
    @media (min-width: 601px) {
      .cards-mobile { display: none; }
      .table-desktop { display: block; }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogisticaDriverAssignmentsComponent {
  private readonly api = inject(LogisticaService);
  private readonly toast = inject(MessageService);

  readonly shipments = signal<Shipment[]>([]);
  readonly loading = signal(false);
  readonly wizardOpen = signal(false);
  readonly selectedId = signal<string | null>(null);

  statusFilter: ShipmentStatus | null = null;

  readonly filterOptions: { label: string; value: ShipmentStatus | null }[] = [
    { label: 'Todos los activos', value: null },
    { label: 'Programado', value: 'programado' },
    { label: 'Checklist salida', value: 'checklist_salida' },
    { label: 'En ruta', value: 'en_ruta' },
    { label: 'Entregado', value: 'entregado' },
    { label: 'Checklist llegada', value: 'checklist_llegada' },
    { label: 'Costos pendientes', value: 'costos_pendientes' },
  ];

  constructor() {
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.api.listMyDriverShipments({ status: this.statusFilter || undefined }).subscribe({
      next: (list) => { this.shipments.set(list || []); this.loading.set(false); },
      error: () => {
        this.loading.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se cargaron las entregas' });
      },
    });
  }

  openWizard(s: Shipment): void {
    this.selectedId.set(s.id);
    this.wizardOpen.set(true);
  }

  onWizardVisibleChange(visible: boolean): void {
    this.wizardOpen.set(visible);
    if (!visible) {
      // Refrescar tras cerrar wizard (puede haber cambiado status)
      this.reload();
    }
  }

  onDeliveryCompleted(): void {
    this.toast.add({ severity: 'success', summary: 'Entrega completada', detail: 'El embarque fue cerrado.' });
  }

  onStatusChanged(_status: ShipmentStatus): void {
    // Trigger reload lazy — el reload() ocurre cuando se cierra el wizard
  }

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

  statusSeverity(s: ShipmentStatus): Severity {
    if (s === 'cerrado') return 'success';
    if (s === 'cancelado') return 'danger';
    if (s === 'en_ruta' || s === 'costos_pendientes') return 'warn';
    if (s === 'entregado' || s === 'checklist_llegada') return 'success';
    return 'info';
  }

  /** Botón contextual según status: "Iniciar viaje" / "Marcar llegada" / "Cerrar entrega" / "Ver". */
  actionLabel(s: ShipmentStatus): string {
    if (s === 'programado') return 'Iniciar viaje';
    if (s === 'checklist_salida') return 'Salir a ruta';
    if (s === 'en_ruta') return 'Marcar llegada';
    if (s === 'entregado') return 'Subir fotos';
    if (s === 'checklist_llegada' || s === 'costos_pendientes') return 'Cerrar entrega';
    return 'Ver detalle';
  }

  actionIcon(s: ShipmentStatus): string {
    if (s === 'programado' || s === 'checklist_salida') return 'pi pi-play';
    if (s === 'en_ruta') return 'pi pi-map-marker';
    if (s === 'entregado') return 'pi pi-camera';
    return 'pi pi-check';
  }
}
