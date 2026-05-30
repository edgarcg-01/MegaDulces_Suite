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
import { TooltipModule } from 'primeng/tooltip';
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
    ButtonModule, CardModule, TableModule, TagModule, SelectModule, TooltipModule, ToastModule,
    DeliveryWizardComponent,
  ],
  providers: [MessageService],
  template: `
    <div class="surf-page da">
      <p-toast></p-toast>

      <!-- PAGE HEAD -->
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Mis entregas</h1>
          <p class="surf-page-sub">
            <b>{{ shipments().length }}</b> shipment{{ shipments().length === 1 ? '' : 's' }} asignado{{ shipments().length === 1 ? '' : 's' }}
            <span class="da-divider" aria-hidden="true">·</span>
            como chofer o ayudante
          </p>
        </div>
        <div class="da-head-actions">
          <button
            pButton
            icon="pi pi-refresh"
            [text]="true"
            severity="secondary"
            size="small"
            (click)="reload()"
            [loading]="loading()"
            pTooltip="Refrescar"
          ></button>
        </div>
      </header>

      <!-- FILTERS toolbar -->
      <div class="sheet cols-12">
        <article class="cell cell-span-12 is-flush da-filters-cell">
          <div class="da-toolbar">
            <div class="da-field">
              <i class="pi pi-filter da-field-icon" aria-hidden="true"></i>
              <p-select
                [(ngModel)]="statusFilter"
                [options]="filterOptions"
                optionLabel="label"
                optionValue="value"
                (onChange)="reload()"
                [showClear]="true"
                placeholder="Todos los estados"
                styleClass="da-status-select"
                appendTo="body"
              ></p-select>
            </div>

            <div class="da-toolbar-spacer"></div>

            <button
              *ngIf="statusFilter"
              type="button"
              class="da-reset"
              (click)="clearFilter()"
            >
              <i class="pi pi-refresh" aria-hidden="true"></i>
              <span>Reset</span>
            </button>
          </div>
        </article>
      </div>

      <!-- ──────────── MOBILE: cards (visible <=600px) ──────────── -->
      <div class="da-cards-mobile" *ngIf="shipments().length > 0">
        <article
          *ngFor="let s of shipments()"
          class="da-card"
          [class]="'is-' + statusPillClass(s.status).replace('is-', '')"
          (click)="openWizard(s)"
          role="button"
          tabindex="0"
        >
          <header class="da-card-head">
            <code class="comm-code">{{ s.folio }}</code>
            <span class="comm-pill" [class]="statusPillClass(s.status)">
              {{ statusLabel(s.status) }}
            </span>
          </header>
          <div class="da-card-customer">
            <span class="da-card-name">{{ s.customer_name || s.order_code || '—' }}</span>
            <span class="comm-muted is-small">{{ s.shipment_date | date:'dd MMM' }}</span>
          </div>
          <div class="da-card-row">
            <i class="pi pi-map-marker" aria-hidden="true"></i>
            <span>{{ s.origin || '—' }} → {{ s.destination || '—' }}</span>
          </div>
          <div class="da-card-row" *ngIf="s.vehicle_plate">
            <i class="pi pi-truck" aria-hidden="true"></i>
            <span>{{ s.vehicle_plate }}{{ s.vehicle_model ? ' · ' + s.vehicle_model : '' }}</span>
          </div>
          <button
            pButton
            class="da-card-action"
            [label]="actionLabel(s.status)"
            [icon]="actionIcon(s.status)"
            size="small"
            (click)="$event.stopPropagation(); openWizard(s)"
          ></button>
        </article>
      </div>

      <!-- ──────────── DESKTOP: tabla flush ──────────── -->
      <div class="sheet cols-12 da-table-desktop" *ngIf="shipments().length > 0">
        <article class="cell cell-span-12 is-flush">
          <p-table [value]="shipments()" [loading]="loading()" responsiveLayout="scroll" styleClass="p-datatable-sm"
                   [paginator]="true" [rows]="10">
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
              <tr (click)="openWizard(s)" class="comm-row-clickable">
                <td><code class="comm-code">{{ s.folio }}</code></td>
                <td>{{ s.shipment_date | date:'dd MMM' }}</td>
                <td class="comm-cell-strong">{{ s.customer_name || s.order_code || '—' }}</td>
                <td class="comm-muted is-small">{{ s.origin || '—' }} → {{ s.destination || '—' }}</td>
                <td>
                  <span *ngIf="s.vehicle_plate">{{ s.vehicle_plate }}</span>
                  <span *ngIf="!s.vehicle_plate" class="comm-muted">—</span>
                </td>
                <td>
                  <span class="comm-pill" [class]="statusPillClass(s.status)">
                    {{ statusLabel(s.status) }}
                  </span>
                </td>
                <td class="comm-actions" (click)="$event.stopPropagation()">
                  <button pButton [label]="actionLabel(s.status)" [icon]="actionIcon(s.status)"
                          size="small" (click)="openWizard(s)"></button>
                </td>
              </tr>
            </ng-template>
          </p-table>
        </article>
      </div>

      <!-- Empty state -->
      <div *ngIf="!loading() && shipments().length === 0" class="da-empty-wrap">
        <div class="da-empty">
          <div class="da-empty-icon"><i class="pi pi-truck" aria-hidden="true"></i></div>
          <h3>Sin entregas pendientes</h3>
          <p>{{ statusFilter ? 'No hay shipments en este estado.' : 'No tenés shipments asignados todavía.' }}</p>
          <button
            *ngIf="statusFilter"
            type="button"
            pButton
            icon="pi pi-refresh"
            severity="secondary"
            [outlined]="true"
            size="small"
            label="Limpiar filtro"
            (click)="clearFilter()"
          ></button>
        </div>
      </div>

      <!-- Wizard -->
      <app-delivery-wizard
        [visible]="wizardOpen()"
        [shipmentId]="selectedId()"
        (visibleChange)="onWizardVisibleChange($event)"
        (completed)="onDeliveryCompleted()"
        (statusChanged)="onStatusChanged($event)"
      ></app-delivery-wizard>
    </div>
  `,
  styles: [`
    :host { display:block; }

    .da-head-actions { display:flex; gap:.5rem; align-items:center; }
    .da-divider { opacity: 0.4; }
    .surf-page-sub b { font-weight: var(--fw-bold); color: var(--c-text-1); }

    /* ── FILTERS TOOLBAR ── */
    .da-filters-cell { display: flex; flex-direction: column; }
    .da-toolbar {
      display: flex;
      align-items: center;
      gap: .5rem;
      padding: .625rem .875rem;
      flex-wrap: wrap;
    }
    .da-toolbar-spacer { flex: 1; min-width: 0; }

    .da-field {
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
    .da-field:focus-within {
      border-color: var(--c-text-1);
      box-shadow: 0 0 0 3px rgba(248, 180, 0, 0.15);
    }
    .da-field-icon { color: var(--c-text-3); font-size: var(--fs-sm); flex-shrink: 0; }
    :host ::ng-deep .da-status-select.p-select {
      flex: 1;
      border: none !important;
      background: transparent !important;
      box-shadow: none !important;
    }
    :host ::ng-deep .da-status-select.p-select .p-select-label {
      padding: 0 !important;
      height: 28px !important;
      font-size: var(--fs-sm) !important;
      color: var(--c-text-1) !important;
      display: flex;
      align-items: center;
    }

    .da-reset {
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
    .da-reset:hover {
      color: var(--c-bad);
      border-color: var(--c-bad);
      background: rgba(220, 38, 38, 0.06);
    }

    /* ── MOBILE CARDS — stripe semántico izquierdo por status ── */
    .da-cards-mobile { display: none; flex-direction: column; gap: .625rem; }
    .da-card {
      position: relative;
      background: var(--c-surface-1);
      border: 1px solid var(--c-divider);
      border-radius: 10px;
      padding: .875rem 1rem;
      cursor: pointer;
      transition: border-color 120ms var(--ease-standard), box-shadow 200ms var(--ease-standard), transform 180ms var(--ease-standard);
    }
    .da-card::before {
      content: '';
      position: absolute;
      left: 0;
      top: 12px;
      bottom: 12px;
      width: 3px;
      border-radius: 2px;
      background: var(--c-text-3);
    }
    .da-card.is-info::before    { background: var(--c-info); }
    .da-card.is-warn::before    { background: var(--c-warn); }
    .da-card.is-ok::before      { background: var(--c-ok); }
    .da-card.is-bad::before     { background: var(--c-bad); }
    .da-card.is-neutral::before { background: var(--c-text-3); }
    .da-card:hover {
      border-color: var(--c-text-3);
      box-shadow: 0 4px 12px rgba(0,0,0,.06);
      transform: translateY(-1px);
    }
    .da-card:focus-visible {
      outline: 2px solid var(--c-accent);
      outline-offset: 2px;
    }

    .da-card-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: .5rem;
      margin-bottom: .5rem;
    }
    .da-card-customer {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: .5rem;
      margin-bottom: .4rem;
    }
    .da-card-name {
      font-size: var(--fs-body);
      font-weight: var(--fw-bold);
      color: var(--c-text-1);
    }
    .da-card-row {
      display: flex;
      align-items: center;
      gap: .4rem;
      font-size: var(--fs-xs);
      color: var(--c-text-2);
      margin-bottom: .25rem;
    }
    .da-card-row i {
      color: var(--c-text-3);
      font-size: var(--fs-xs);
    }
    .da-card-action {
      margin-top: .75rem;
      width: 100%;
    }

    /* ── EMPTY STATE ── */
    .da-empty-wrap {
      display: flex;
      justify-content: center;
    }
    .da-empty {
      text-align: center;
      padding: 3rem 1.5rem;
      max-width: 420px;
      background: var(--c-surface-1);
      border: 1px dashed var(--c-divider);
      border-radius: 14px;
      width: 100%;
    }
    .da-empty-icon {
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
    .da-empty h3 {
      margin: 0 0 .375rem;
      font-size: var(--fs-h3);
      font-weight: var(--fw-bold);
      color: var(--c-text-1);
    }
    .da-empty p {
      margin: 0 0 1rem;
      color: var(--c-text-2);
      font-size: var(--fs-sm);
      line-height: 1.4;
    }

    /* ── RESPONSIVE: mobile <=600px cards, >600px tabla ── */
    @media (max-width: 600px) {
      .da-cards-mobile { display: flex; }
      .da-table-desktop { display: none; }
    }
    @media (min-width: 601px) {
      .da-cards-mobile { display: none; }
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

  clearFilter(): void {
    this.statusFilter = null;
    this.reload();
  }

  /** Clase de comm-pill semántica por estado de embarque. */
  statusPillClass(s: ShipmentStatus): string {
    if (s === 'programado' || s === 'checklist_salida') return 'is-info';
    if (s === 'en_ruta' || s === 'costos_pendientes') return 'is-warn';
    if (s === 'entregado' || s === 'checklist_llegada') return 'is-ok';
    if (s === 'cerrado') return 'is-neutral';
    return 'is-bad';
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
