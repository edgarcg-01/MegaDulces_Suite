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
import { CheckboxModule } from 'primeng/checkbox';
import { SelectModule } from 'primeng/select';
import { AutoCompleteModule } from 'primeng/autocomplete';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { MessageService, ConfirmationService } from 'primeng/api';
import {
  CartaPorteDocument, CartaPorteGap, ShipmentEta, CustomerLite, OrderLite,
  DeliveryGuide, Driver, GuideRecipient, LogisticaService, Shipment, ShipmentExpense, Vehicle,
} from '../logistica.service';

type Severity = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';

@Component({
  selector: 'app-logistica-shipment-detail',
  standalone: true,
  imports: [
    CommonModule, RouterLink, FormsModule, ReactiveFormsModule,
    ButtonModule, CardModule, TableModule, DialogModule,
    InputTextModule, InputNumberModule, CheckboxModule, SelectModule, AutoCompleteModule,
    TagModule, TooltipModule, ToastModule, ConfirmDialogModule,
  ],
  providers: [MessageService, ConfirmationService],
  template: `
    <div class="surf-page shd">
      <p-toast></p-toast>
      <p-confirmDialog></p-confirmDialog>

      <ng-container *ngIf="shipment() as s">
        <!-- BACK LINK -->
        <a routerLink="/logistica/shipments" class="shd-back">
          <i class="pi pi-arrow-left" aria-hidden="true"></i> Volver a embarques
        </a>

        <!-- PAGE HEAD -->
        <header class="surf-page-head">
          <div class="surf-page-head-text">
            <span class="shd-eyebrow">
              <i class="pi pi-truck" aria-hidden="true"></i>
              Embarque
            </span>
            <h1><code class="comm-code">{{ s.folio }}</code></h1>
            <p class="surf-page-sub">
              {{ s.shipment_date | date:'dd MMM yyyy' }}
              <span class="shd-divider" aria-hidden="true">·</span>
              {{ s.origin || '—' }} → {{ s.destination || '—' }}
            </p>
          </div>
          <div class="shd-head-actions">
            <span class="comm-pill" [class]="statusPillClass(s.status)">
              {{ statusLabel(s.status) }}
            </span>
            <a pButton icon="pi pi-check-square" label="Checklists" severity="secondary" size="small"
               [routerLink]="['/logistica/shipments', s.id, 'checklists']"></a>
            <a pButton icon="pi pi-camera" label="Fotos" severity="secondary" size="small"
               [routerLink]="['/logistica/shipments', s.id, 'photos']"></a>
            <button pButton icon="pi pi-file-pdf" label="PDF" severity="secondary" size="small"
                    (click)="downloadPdf(s.id)"></button>
          </div>
        </header>

        <!-- MODE TABS -->
        <div class="sheet cols-12">
          <article class="cell cell-span-12 is-flush shd-tabs-cell">
            <nav class="shd-mode-tabs" role="tablist" aria-label="Secciones del embarque">
              <button
                type="button"
                class="shd-mode-tab"
                [class.active]="tab() === 'info'"
                role="tab"
                [attr.aria-selected]="tab() === 'info'"
                (click)="setTab('info')"
              >
                <i class="pi pi-info-circle" aria-hidden="true"></i>
                <span>Información</span>
              </button>
              <button
                type="button"
                class="shd-mode-tab"
                [class.active]="tab() === 'guides'"
                role="tab"
                [attr.aria-selected]="tab() === 'guides'"
                (click)="setTab('guides')"
              >
                <i class="pi pi-file-edit" aria-hidden="true"></i>
                <span>Guías</span>
                <span class="shd-tab-count">{{ guides().length }}</span>
              </button>
              <button
                type="button"
                class="shd-mode-tab"
                [class.active]="tab() === 'expenses'"
                role="tab"
                [attr.aria-selected]="tab() === 'expenses'"
                (click)="setTab('expenses')"
              >
                <i class="pi pi-money-bill" aria-hidden="true"></i>
                <span>Costos</span>
              </button>
              <button
                type="button"
                class="shd-mode-tab"
                [class.active]="tab() === 'cartaporte'"
                role="tab"
                [attr.aria-selected]="tab() === 'cartaporte'"
                (click)="setTab('cartaporte')"
              >
                <i class="pi pi-file-check" aria-hidden="true"></i>
                <span>Carta Porte</span>
              </button>
            </nav>
          </article>
        </div>

        <!-- ── TAB INFO ── -->
        <ng-container *ngIf="tab() === 'info'">
          <div class="sheet cols-12">
            <article class="cell cell-span-3">
              <span class="cell-label">Tipo</span>
              <span class="cell-value is-small">{{ s.type }}</span>
            </article>
            <article class="cell cell-span-3">
              <span class="cell-label">Cajas</span>
              <span class="cell-value is-medium">{{ s.boxes_count }}</span>
            </article>
            <article class="cell cell-span-3">
              <span class="cell-label">Peso (kg)</span>
              <span class="cell-value is-medium">{{ s.total_weight_kg }}</span>
            </article>
            <article class="cell cell-span-3">
              <span class="cell-label">Km recorridos</span>
              <span class="cell-value is-medium">{{ s.actual_km || '—' }}</span>
            </article>

            <article class="cell cell-span-3">
              <span class="cell-icon" aria-hidden="true"><i class="pi pi-dollar"></i></span>
              <span class="cell-label">Valor carga</span>
              <span class="cell-value is-medium">{{ s.cargo_value | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
            </article>
            <article class="cell cell-span-3">
              <span class="cell-icon" aria-hidden="true"><i class="pi pi-wallet"></i></span>
              <span class="cell-label">Flete cobrado</span>
              <span class="cell-value is-medium">{{ s.freight_revenue | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
            </article>
            <article class="cell cell-span-3">
              <span class="cell-label">Salida</span>
              <span class="cell-value is-small">{{ s.departure_at ? (s.departure_at | date:'short') : '—' }}</span>
            </article>
            <article class="cell cell-span-3">
              <span class="cell-label">Llegada</span>
              <span class="cell-value is-small">{{ s.arrival_at ? (s.arrival_at | date:'short') : '—' }}</span>
            </article>
          </div>

          <!-- Notas (conditional) -->
          <div *ngIf="s.notes" class="sheet cols-12">
            <article class="cell cell-span-12">
              <span class="cell-label">Notas</span>
              <p class="shd-notes">{{ s.notes }}</p>
            </article>
          </div>

          <!-- Action: editar metrics -->
          <div class="shd-info-actions" *ngIf="s.status !== 'cerrado' && s.status !== 'cancelado'">
            <button pButton icon="pi pi-pencil" label="Editar km / flete"
                    size="small" severity="secondary" [outlined]="true"
                    (click)="openEditMetrics()"></button>
          </div>
        </ng-container>

        <!-- ── TAB GUÍAS ── -->
        <ng-container *ngIf="tab() === 'guides'">
          <div class="sheet cols-12" *ngIf="canAddGuide()">
            <article class="cell cell-span-12 is-flush shd-cta-cell">
              <span class="comm-muted is-small">
                Asigná chofer + ayudantes + destinatarios por cada guía de reparto.
              </span>
              <div class="shd-cta-actions">
                <button pButton icon="pi pi-compass" label="Optimizar ruta" size="small"
                        severity="secondary" [outlined]="true" [loading]="optimizing()"
                        [disabled]="!guides().length" (click)="optimizeRoute()"
                        pTooltip="Ordena las paradas por cercanía (menos km)"></button>
                <button pButton icon="pi pi-plus" label="Nueva guía" size="small"
                        (click)="openCreateGuide()"></button>
              </div>
            </article>
          </div>

          <div class="sheet cols-12">
            <article class="cell cell-span-12 is-flush">
              <p-table [value]="guides()" responsiveLayout="scroll" styleClass="p-datatable-sm">
                <ng-template pTemplate="header">
                  <tr>
                    <th>Número</th>
                    <th>Chofer</th>
                    <th class="comm-num">Comisiones</th>
                    <th class="comm-num">Viáticos</th>
                    <th>Estado</th>
                    <th></th>
                  </tr>
                </ng-template>
                <ng-template pTemplate="body" let-g>
                  <tr>
                    <td><code class="comm-code">{{ g.number }}</code></td>
                    <td class="comm-cell-strong">{{ driverName(g.driver_id) || '—' }}</td>
                    <td class="comm-num">
                      {{ (g.driver_commission + g.helper1_commission + g.helper2_commission) | currency:'MXN':'symbol-narrow':'1.2-2' }}
                    </td>
                    <td class="comm-num">{{ g.per_diem_total | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                    <td>
                      <span class="comm-pill" [class]="guidePillClass(g.status)">
                        {{ guideLabel(g.status) }}
                      </span>
                    </td>
                    <td class="comm-actions">
                      <button pButton icon="pi pi-eye" size="small" severity="secondary"
                              [text]="true" (click)="openGuideDetail(g)" pTooltip="Ver destinatarios"></button>
                    </td>
                  </tr>
                </ng-template>
                <ng-template pTemplate="emptymessage">
                  <tr>
                    <td colspan="6" class="shd-empty-cell">
                      <div class="shd-empty">
                        <div class="shd-empty-icon"><i class="pi pi-file-edit" aria-hidden="true"></i></div>
                        <h3>Sin guías</h3>
                        <p>Agregá una guía para asignar chofer + destinatarios.</p>
                        <button *ngIf="canAddGuide()" type="button" pButton
                                icon="pi pi-plus" severity="primary" size="small"
                                label="Nueva guía" (click)="openCreateGuide()"></button>
                      </div>
                    </td>
                  </tr>
                </ng-template>
              </p-table>
            </article>
          </div>

          <!-- ETA de ruta (J12.4) -->
          <div class="sheet cols-12" *ngIf="guides().length">
            <article class="cell cell-span-12">
              <div class="shd-eta-head">
                <div>
                  <span class="cell-label">ETA de ruta</span>
                  <p class="comm-muted is-small" *ngIf="eta() as e">
                    {{ e.stops.length }} paradas pendientes · {{ e.total_km }} km · ~{{ e.total_minutes }} min
                    <span *ngIf="e.speed_kmh"> · {{ e.speed_kmh }} km/h<span *ngIf="e.speed_source === 'calibrated'"> (calibrada)</span></span>
                    <span *ngIf="e.from_source === 'first_stop'"> · (sin GPS del chofer, desde 1ª parada)</span>
                  </p>
                </div>
                <button pButton icon="pi pi-clock" label="Calcular ETA" size="small" severity="secondary"
                        [outlined]="true" [loading]="etaLoading()" (click)="loadEta()"></button>
              </div>
              <div *ngIf="eta() as e">
                <p-table *ngIf="e.stops.length" [value]="e.stops" responsiveLayout="scroll" styleClass="p-datatable-sm">
                  <ng-template pTemplate="header">
                    <tr><th>#</th><th>Cliente</th><th class="comm-num">Km acum.</th><th>ETA</th></tr>
                  </ng-template>
                  <ng-template pTemplate="body" let-s>
                    <tr>
                      <td><span class="shd-eta-seq">{{ s.sequence_order }}</span></td>
                      <td class="comm-cell-strong">{{ s.customer_name }}</td>
                      <td class="comm-num">{{ s.cumulative_km }}</td>
                      <td class="shd-eta-time">{{ s.eta | date:'shortTime' }}</td>
                    </tr>
                  </ng-template>
                </p-table>
                <p *ngIf="!e.stops.length" class="comm-muted is-small">
                  Sin paradas con orden + ubicación. Corré "Optimizar ruta" y captura lat/lng de los clientes.
                </p>
              </div>
            </article>
          </div>
        </ng-container>

        <!-- ── TAB COSTOS ── -->
        <ng-container *ngIf="tab() === 'expenses'">
          <!-- Form de inputs -->
          <div class="sheet cols-12">
            <article class="cell cell-span-12">
              <span class="cell-label">Conceptos de gasto operativo</span>
              <form [formGroup]="expForm" class="shd-exp-form">
                <div class="shd-exp-row">
                  <label><span>Combustible</span><p-inputNumber formControlName="fuel" mode="currency" currency="MXN" locale="es-MX"></p-inputNumber></label>
                  <label><span>Casetas</span><p-inputNumber formControlName="tolls" mode="currency" currency="MXN" locale="es-MX"></p-inputNumber></label>
                  <label><span>Hospedaje</span><p-inputNumber formControlName="lodging" mode="currency" currency="MXN" locale="es-MX"></p-inputNumber></label>
                </div>
                <div class="shd-exp-row">
                  <label><span>Pensiones</span><p-inputNumber formControlName="parking" mode="currency" currency="MXN" locale="es-MX"></p-inputNumber></label>
                  <label><span>Permisos</span><p-inputNumber formControlName="permits" mode="currency" currency="MXN" locale="es-MX"></p-inputNumber></label>
                  <label><span>Talachas</span><p-inputNumber formControlName="repairs" mode="currency" currency="MXN" locale="es-MX"></p-inputNumber></label>
                </div>
                <div class="shd-exp-row">
                  <label><span>Ayudantes ext.</span><p-inputNumber formControlName="external_helpers" mode="currency" currency="MXN" locale="es-MX"></p-inputNumber></label>
                  <label><span>Maniobras</span><p-inputNumber formControlName="handling" mode="currency" currency="MXN" locale="es-MX"></p-inputNumber></label>
                  <label><span>Viáticos guía</span><p-inputNumber formControlName="driver_per_diem" mode="currency" currency="MXN" locale="es-MX"></p-inputNumber></label>
                </div>
                <div class="shd-exp-row">
                  <label><span>Otros</span><p-inputNumber formControlName="other" mode="currency" currency="MXN" locale="es-MX"></p-inputNumber></label>
                  <label class="shd-check-line shd-check-span-2">
                    <p-checkbox formControlName="apply_config_km" [binary]="true" inputId="apply_km"></p-checkbox>
                    <span>Aplicar costo km de configuración (recalcula total)</span>
                  </label>
                </div>
                <label class="shd-notes-field">
                  <span>Notas</span>
                  <input pInputText formControlName="notes" />
                </label>
              </form>
            </article>
          </div>

          <!-- Totales -->
          <div *ngIf="expense() as e" class="sheet cols-12">
            <article class="cell cell-span-4">
              <span class="cell-label">Subtotal operativo</span>
              <span class="cell-value is-medium">{{ e.operating_subtotal | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
              <span class="cell-sub">suma de conceptos</span>
            </article>
            <article class="cell cell-span-4">
              <span class="cell-label">Costo por km</span>
              <span class="cell-value is-medium">{{ (e.total_cost - e.operating_subtotal) | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
              <span class="cell-sub">× {{ e.fixed_cost_per_km | number:'1.2-4' }} /km</span>
            </article>
            <article class="cell cell-span-4">
              <span class="cell-icon" aria-hidden="true"><i class="pi pi-wallet"></i></span>
              <span class="cell-label">Total</span>
              <span class="cell-value is-headline">{{ e.total_cost | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
            </article>
          </div>

          <!-- Save action -->
          <div class="shd-info-actions">
            <button pButton icon="pi pi-save" label="Guardar costos"
                    [loading]="savingExp()" (click)="saveExpense()"></button>
          </div>
        </ng-container>

        <!-- ── TAB CARTA PORTE ── -->
        <ng-container *ngIf="tab() === 'cartaporte'">
          <!-- Documentos ya timbrados -->
          <div class="sheet cols-12" *ngIf="cpDocs().length">
            <article class="cell cell-span-12 is-flush">
              <p-table [value]="cpDocs()" responsiveLayout="scroll" styleClass="p-datatable-sm">
                <ng-template pTemplate="header">
                  <tr><th>Folio fiscal (UUID)</th><th>Tipo</th><th>Estado</th><th>Timbrado</th></tr>
                </ng-template>
                <ng-template pTemplate="body" let-d>
                  <tr>
                    <td><code class="comm-code">{{ d.uuid_fiscal || '—' }}</code></td>
                    <td>{{ d.cfdi_type }}</td>
                    <td><span class="comm-pill" [class]="cpPillClass(d.status)">{{ d.status }}</span></td>
                    <td class="comm-muted">{{ d.stamped_at ? (d.stamped_at | date:'short') : '—' }}</td>
                  </tr>
                </ng-template>
              </p-table>
            </article>
          </div>

          <!-- Validación + acción -->
          <div class="sheet cols-12">
            <article class="cell cell-span-12">
              <div class="shd-cp-head">
                <div>
                  <span class="cell-label">Timbrado Carta Porte 3.1</span>
                  <p class="comm-muted is-small">CFDI de Traslado, un complemento por embarque. Revisá datos faltantes antes de timbrar.</p>
                </div>
                <div class="shd-cp-actions">
                  <button pButton icon="pi pi-search" label="Revisar datos" size="small" severity="secondary"
                          [outlined]="true" [loading]="cpValidating()" (click)="validateCp()"></button>
                  <button pButton icon="pi pi-file-check" label="Timbrar Carta Porte" size="small"
                          [loading]="cpStamping()" [disabled]="!cpReady()" (click)="stampCp()"></button>
                </div>
              </div>

              <!-- Gaps -->
              <div *ngIf="cpChecked() && cpGaps().length" class="shd-cp-gaps">
                <div class="shd-cp-gaps-head">
                  <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                  Faltan {{ cpGaps().length }} dato{{ cpGaps().length === 1 ? '' : 's' }} para timbrar
                </div>
                <ul>
                  <li *ngFor="let g of cpGaps()">
                    <code>{{ g.field }}</code> <span>{{ g.detail }}</span>
                  </li>
                </ul>
              </div>

              <!-- Listo -->
              <div *ngIf="cpChecked() && !cpGaps().length" class="shd-cp-ready">
                <i class="pi pi-check-circle" aria-hidden="true"></i>
                Datos completos — listo para timbrar.
              </div>
            </article>
          </div>
        </ng-container>
      </ng-container>

      <!-- Edit metrics dialog -->
      <p-dialog [(visible)]="metricsDialog" [modal]="true" [draggable]="false" [style]="{ width: '420px' }" header="Editar km / flete">
        <form [formGroup]="metricsForm" class="comm-form">
          <label>
            <span>Km recorridos</span>
            <p-inputNumber formControlName="actual_km"></p-inputNumber>
          </label>
          <label>
            <span>Flete cobrado</span>
            <p-inputNumber formControlName="freight_revenue" mode="currency" currency="MXN" locale="es-MX"></p-inputNumber>
          </label>
        </form>
        <ng-template pTemplate="footer">
          <button pButton label="Cancelar" severity="secondary" [outlined]="true" (click)="metricsDialog = false"></button>
          <button pButton label="Guardar" icon="pi pi-check" (click)="saveMetrics()"></button>
        </ng-template>
      </p-dialog>

      <!-- Create guide dialog -->
      <p-dialog [(visible)]="guideDialog" [modal]="true" [draggable]="false" [style]="{ width: '560px' }" header="Nueva guía">
        <form [formGroup]="guideForm" class="comm-form-grid">
          <label class="full">
            <span>Chofer principal</span>
            <p-select formControlName="driver_id" [options]="driverOptions()" optionLabel="label" optionValue="value"
                      placeholder="Seleccionar" [showClear]="true" appendTo="body"></p-select>
          </label>
          <label>
            <span>Ayudante 1</span>
            <p-select formControlName="helper1_id" [options]="driverOptions()" optionLabel="label" optionValue="value"
                      placeholder="Sin asignar" [showClear]="true" appendTo="body"></p-select>
          </label>
          <label>
            <span>Ayudante 2</span>
            <p-select formControlName="helper2_id" [options]="driverOptions()" optionLabel="label" optionValue="value"
                      placeholder="Sin asignar" [showClear]="true" appendTo="body"></p-select>
          </label>
          <label>
            <span>Comisión chofer</span>
            <p-inputNumber formControlName="driver_commission" mode="currency" currency="MXN" locale="es-MX"></p-inputNumber>
          </label>
          <label>
            <span>Comisión ayudante 1</span>
            <p-inputNumber formControlName="helper1_commission" mode="currency" currency="MXN" locale="es-MX"></p-inputNumber>
          </label>
          <label>
            <span>Comisión ayudante 2</span>
            <p-inputNumber formControlName="helper2_commission" mode="currency" currency="MXN" locale="es-MX"></p-inputNumber>
          </label>
          <label>
            <span>Viáticos totales</span>
            <p-inputNumber formControlName="per_diem_total" mode="currency" currency="MXN" locale="es-MX"></p-inputNumber>
          </label>
          <label class="checkbox-line full">
            <p-checkbox formControlName="overnight" [binary]="true" inputId="ov"></p-checkbox>
            <span>El chofer duerme fuera (overnight)</span>
          </label>
        </form>
        <ng-template pTemplate="footer">
          <button pButton label="Cancelar" severity="secondary" [outlined]="true" (click)="guideDialog = false"></button>
          <button pButton label="Crear guía" icon="pi pi-check" [loading]="savingGuide()" (click)="createGuide()"></button>
        </ng-template>
      </p-dialog>

      <!-- Guide detail dialog: recipients -->
      <p-dialog [(visible)]="guideDetailDialog" [modal]="true" [draggable]="false" [style]="{ width: '720px' }"
                [header]="'Guía ' + (selectedGuide()?.number || '')">
        <div *ngIf="selectedGuide() as g">
          <div class="shd-recipients-head">
            <span class="cell-label">Destinatarios</span>
            <span class="comm-muted is-small">{{ (g.recipients || []).length }} registrado{{ (g.recipients || []).length === 1 ? '' : 's' }}</span>
          </div>
          <p-table [value]="g.recipients || []" responsiveLayout="scroll" styleClass="p-datatable-sm">
            <ng-template pTemplate="header">
              <tr>
                <th>#</th>
                <th>Cliente</th>
                <th>Dirección</th>
                <th class="comm-num">Cajas</th>
                <th class="comm-num">Valor</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </ng-template>
            <ng-template pTemplate="body" let-r>
              <tr>
                <td><span class="shd-eta-seq">{{ r.sequence_order ?? '—' }}</span></td>
                <td class="comm-cell-strong">{{ r.customer_name }}</td>
                <td class="comm-muted">{{ r.address || '—' }}</td>
                <td class="comm-num">{{ r.boxes_count }}</td>
                <td class="comm-num">{{ r.value | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td>
                  <span class="comm-pill" [class]="recipientPillClass(r.status)">
                    {{ recipientLabel(r.status) }}
                  </span>
                </td>
                <td class="comm-actions">
                  <button pButton *ngIf="r.status === 'pendiente'" icon="pi pi-check" size="small" severity="secondary" [text]="true"
                          pTooltip="Marcar entregado" (click)="markRecipientDelivered(r)"></button>
                </td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage">
              <tr><td colspan="7" class="comm-muted shd-recip-empty">Sin destinatarios.</td></tr>
            </ng-template>
          </p-table>

          <form [formGroup]="recipientForm" class="comm-form-grid shd-add-recipient"
                *ngIf="g.status !== 'entregada' && g.status !== 'cancelada'">
            <div class="full shd-add-head">
              <span class="cell-label">Agregar destinatario</span>
            </div>
            <label class="full">
              <span>Buscar cliente</span>
              <p-autoComplete [suggestions]="customerSuggestions()" (completeMethod)="searchCustomer($event)"
                              (onSelect)="onCustomerSelect($event)" field="name" [forceSelection]="false"
                              placeholder="Nombre, código o RFC…" appendTo="body" styleClass="w-full"></p-autoComplete>
            </label>
            <label class="full" *ngIf="customerOrders().length">
              <span>Ligar pedido (opcional)</span>
              <p-select formControlName="order_id" [options]="customerOrders()" optionLabel="code" optionValue="id"
                        placeholder="Sin pedido" [showClear]="true" appendTo="body"
                        (onChange)="onOrderSelect($event.value)"></p-select>
            </label>
            <label class="full">
              <span>Nombre <em>*</em></span>
              <input pInputText formControlName="customer_name" />
            </label>
            <label>
              <span>Cajas</span>
              <p-inputNumber formControlName="boxes_count"></p-inputNumber>
            </label>
            <label>
              <span>Valor</span>
              <p-inputNumber formControlName="value" mode="currency" currency="MXN" locale="es-MX"></p-inputNumber>
            </label>
            <label class="full">
              <span>Dirección</span>
              <input pInputText formControlName="address" />
            </label>
            <div class="full shd-add-actions">
              <button pButton icon="pi pi-plus" label="Agregar" size="small"
                      [disabled]="recipientForm.invalid" (click)="addRecipient(g)"></button>
            </div>
          </form>
        </div>
      </p-dialog>
    </div>
  `,
  styles: [`
    :host { display:block; }

    /* ── BACK link + eyebrow + head ── */
    .shd-back {
      display: inline-flex;
      align-items: center;
      gap: .4rem;
      font-size: var(--fs-xs);
      font-weight: var(--fw-medium);
      color: var(--c-text-2);
      text-decoration: none;
      padding: .375rem .625rem;
      border-radius: 6px;
      margin-bottom: .25rem;
      transition: all 120ms var(--ease-standard);
      width: max-content;
    }
    .shd-back:hover { color: var(--c-text-1); background: var(--c-surface-2); }
    .shd-back i { font-size: var(--fs-xs); }

    .shd-eyebrow {
      display: inline-flex;
      align-items: center;
      gap: .35rem;
      font-size: var(--fs-micro);
      font-weight: var(--fw-bold);
      text-transform: uppercase;
      letter-spacing: .08em;
      color: var(--c-text-2);
      margin-bottom: .35rem;
    }
    .shd-eyebrow i { font-size: var(--fs-xs); }
    .shd-divider { opacity: 0.4; }

    .shd-head-actions {
      display: flex;
      gap: .5rem;
      align-items: center;
      flex-wrap: wrap;
    }

    /* ── TABS CELL ── */
    .shd-tabs-cell { padding: .5rem .75rem; }
    .shd-mode-tabs {
      display: inline-flex;
      gap: .25rem;
      padding: 3px;
      background: var(--c-surface-2);
      border: 1px solid var(--c-divider);
      border-radius: 10px;
    }
    .shd-mode-tab {
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
    .shd-mode-tab:hover { color: var(--c-text-1); }
    .shd-mode-tab.active {
      background: var(--c-surface-1);
      color: var(--c-text-1);
      box-shadow: 0 1px 2px rgba(0,0,0,.08);
      font-weight: var(--fw-bold);
    }
    .shd-mode-tab i { font-size: var(--fs-sm); }
    .shd-tab-count {
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
    .shd-mode-tab.active .shd-tab-count { background: var(--c-surface-2); }

    /* ── NOTES paragraph ── */
    .shd-notes {
      margin: .375rem 0 0;
      color: var(--c-text-1);
      font-size: var(--fs-sm);
      line-height: 1.5;
    }

    /* ── INFO actions row ── */
    .shd-info-actions {
      display: flex;
      justify-content: flex-end;
      gap: .5rem;
      padding: 0 .5rem;
    }

    /* ── CTA cell (Guías) ── */
    .shd-cta-cell {
      display: flex;
      flex-direction: row;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      padding: .75rem 1rem;
    }
    .shd-cta-actions { display: flex; gap: .5rem; flex-wrap: wrap; }
    .shd-eta-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-bottom: .5rem; }
    .shd-eta-head p { margin: .25rem 0 0; }
    .shd-eta-seq { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 6px; background: var(--c-surface-2); font-variant-numeric: tabular-nums; font-weight: var(--fw-bold); font-size: var(--fs-micro); }
    .shd-eta-time { font-variant-numeric: tabular-nums; font-weight: var(--fw-bold); }

    /* ── EXP FORM (Costos) ── */
    .shd-exp-form { display: flex; flex-direction: column; gap: .875rem; }
    .shd-exp-row {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: .75rem;
    }
    @media (max-width: 720px) {
      .shd-exp-row { grid-template-columns: 1fr; }
    }
    .shd-exp-form label {
      display: flex;
      flex-direction: column;
      gap: .3rem;
      font-size: var(--fs-micro);
      color: var(--c-text-2);
      font-weight: var(--fw-bold);
      text-transform: uppercase;
      letter-spacing: .06em;
    }
    .shd-check-line {
      flex-direction: row !important;
      align-items: center;
      gap: .5rem !important;
      text-transform: none !important;
      letter-spacing: 0 !important;
      font-size: var(--fs-sm) !important;
      color: var(--c-text-1) !important;
      font-weight: var(--fw-regular) !important;
    }
    .shd-check-span-2 { grid-column: span 2; }
    .shd-notes-field {
      display: flex;
      flex-direction: column;
      gap: .3rem;
      font-size: var(--fs-micro);
      color: var(--c-text-2);
      font-weight: var(--fw-bold);
      text-transform: uppercase;
      letter-spacing: .06em;
    }

    /* ── EMPTY STATE ── */
    .shd-empty-cell { padding: 0 !important; }
    .shd-empty {
      text-align: center;
      padding: 3rem 1.5rem;
      max-width: 420px;
      margin: 0 auto;
    }
    .shd-empty-icon {
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
    .shd-empty h3 {
      margin: 0 0 .375rem;
      font-size: var(--fs-h3);
      font-weight: var(--fw-bold);
      color: var(--c-text-1);
    }
    .shd-empty p {
      margin: 0 0 1rem;
      color: var(--c-text-2);
      font-size: var(--fs-sm);
      line-height: 1.4;
    }

    /* ── DIALOG: recipients ── */
    .shd-recipients-head {
      display: flex;
      align-items: baseline;
      gap: .5rem;
      margin-bottom: .75rem;
    }
    .shd-recip-empty { padding: 1.5rem !important; text-align: center !important; }
    .shd-add-recipient {
      margin-top: 1.25rem;
      padding-top: 1rem;
      border-top: 1px solid var(--c-divider);
    }
    .shd-add-head { margin-bottom: .25rem; }
    .shd-add-actions {
      display: flex;
      justify-content: flex-end;
    }

    /* ── CARTA PORTE ── */
    .shd-cp-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 1rem;
      flex-wrap: wrap;
    }
    .shd-cp-head p { margin: .25rem 0 0; }
    .shd-cp-actions { display: flex; gap: .5rem; flex-wrap: wrap; }
    .shd-cp-gaps {
      margin-top: 1rem;
      border: 1px solid var(--c-warn-border, #e6c15a);
      background: var(--c-warn-bg, #fdf6e3);
      border-radius: 10px;
      padding: .875rem 1rem;
    }
    .shd-cp-gaps-head {
      display: flex; align-items: center; gap: .5rem;
      font-weight: var(--fw-bold); font-size: var(--fs-sm);
      color: var(--c-text-1); margin-bottom: .5rem;
    }
    .shd-cp-gaps ul { margin: 0; padding-left: 1.1rem; display: flex; flex-direction: column; gap: .3rem; }
    .shd-cp-gaps li { font-size: var(--fs-sm); color: var(--c-text-2); }
    .shd-cp-gaps li code {
      background: var(--c-surface-2); padding: .05rem .35rem; border-radius: 4px;
      font-size: var(--fs-micro); color: var(--c-text-1); margin-right: .4rem;
    }
    .shd-cp-ready {
      margin-top: 1rem;
      display: flex; align-items: center; gap: .5rem;
      font-size: var(--fs-sm); font-weight: var(--fw-medium);
      color: var(--c-ok, #2e7d32);
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogisticaShipmentDetailComponent {
  private readonly api = inject(LogisticaService);
  private readonly route = inject(ActivatedRoute);
  private readonly fb = inject(FormBuilder);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);

  readonly shipmentId = signal<string>('');
  readonly shipment = signal<Shipment | null>(null);
  readonly guides = signal<DeliveryGuide[]>([]);
  readonly expense = signal<ShipmentExpense | null>(null);
  readonly drivers = signal<Driver[]>([]);
  readonly driverOptions = computed(() =>
    this.drivers().map((d) => ({ label: `${d.full_name} (${d.roles.join(', ')})`, value: d.id })),
  );

  readonly savingExp = signal(false);
  readonly savingGuide = signal(false);
  readonly optimizing = signal(false);
  readonly eta = signal<ShipmentEta | null>(null);
  readonly etaLoading = signal(false);
  readonly selectedGuide = signal<DeliveryGuide | null>(null);
  readonly tab = signal<'info' | 'guides' | 'expenses' | 'cartaporte'>('info');

  // ── Carta Porte ──
  readonly cpDocs = signal<CartaPorteDocument[]>([]);
  readonly cpGaps = signal<CartaPorteGap[]>([]);
  readonly cpChecked = signal(false);
  readonly cpValidating = signal(false);
  readonly cpStamping = signal(false);
  readonly cpReady = computed(() => this.cpChecked() && this.cpGaps().length === 0);

  setTab(t: 'info' | 'guides' | 'expenses' | 'cartaporte') {
    this.tab.set(t);
    if (t === 'cartaporte') this.loadCp();
  }

  metricsDialog = false;
  guideDialog = false;
  guideDetailDialog = false;

  metricsForm: FormGroup = this.fb.group({ actual_km: [0], freight_revenue: [0] });

  guideForm: FormGroup = this.fb.group({
    driver_id: [null], helper1_id: [null], helper2_id: [null],
    driver_commission: [0], helper1_commission: [0], helper2_commission: [0],
    overnight: [false], per_diem_total: [0],
  });

  recipientForm: FormGroup = this.fb.group({
    customer_id: [null as string | null],
    order_id: [null as string | null],
    customer_name: ['', Validators.required],
    address: [''],
    boxes_count: [0],
    value: [0],
  });
  readonly customerSuggestions = signal<CustomerLite[]>([]);
  readonly customerOrders = signal<OrderLite[]>([]);

  expForm: FormGroup = this.fb.group({
    fuel: [0], tolls: [0], lodging: [0], parking: [0], permits: [0], repairs: [0],
    external_helpers: [0], handling: [0], driver_per_diem: [0], other: [0],
    apply_config_km: [false],
    notes: [''],
  });

  constructor() {
    this.route.paramMap.subscribe((p) => {
      const id = p.get('id') || '';
      this.shipmentId.set(id);
      if (id) this.loadAll(id);
    });
    this.api.listDrivers({ active: true }).subscribe((r) => this.drivers.set(r || []));
  }

  loadAll(id: string) {
    this.api.getShipment(id).subscribe({
      next: (s) => this.shipment.set(s),
      error: () => this.toast.add({ severity:'error', summary:'Error', detail:'No se cargó embarque' }),
    });
    this.api.listGuides(id).subscribe({
      next: (g) => this.guides.set(g || []),
    });
    this.api.getExpense(id).subscribe({
      next: (e) => {
        this.expense.set(e);
        this.expForm.patchValue({
          fuel: e.fuel, tolls: e.tolls, lodging: e.lodging, parking: e.parking,
          permits: e.permits, repairs: e.repairs, external_helpers: e.external_helpers,
          handling: e.handling, driver_per_diem: e.driver_per_diem, other: e.other,
          notes: e.notes || '',
        });
      },
      error: () => { /* 404 si no hay expense aún — OK */ },
    });
  }

  driverName(id?: string | null): string {
    if (!id) return '';
    return this.drivers().find((d) => d.id === id)?.full_name || '';
  }
  canAddGuide(): boolean {
    const s = this.shipment(); return !!s && !['cerrado', 'cancelado'].includes(s.status);
  }

  severityStatus(s: string): Severity {
    if (s === 'programado' || s === 'checklist_salida') return 'info';
    if (s === 'en_ruta' || s === 'costos_pendientes') return 'warn';
    if (s === 'entregado' || s === 'checklist_llegada') return 'success';
    if (s === 'cerrado') return 'secondary';
    return 'danger';
  }

  /** Clase de comm-pill semántica por estado de embarque. */
  statusPillClass(s: string): string {
    if (s === 'programado' || s === 'checklist_salida') return 'is-info';
    if (s === 'en_ruta' || s === 'costos_pendientes') return 'is-warn';
    if (s === 'entregado' || s === 'checklist_llegada') return 'is-ok';
    if (s === 'cerrado') return 'is-neutral';
    return 'is-bad';
  }

  statusLabel(s: string): string {
    const map: Record<string, string> = {
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

  guidePillClass(s: string): string {
    if (s === 'pendiente') return 'is-info';
    if (s === 'en_ruta') return 'is-warn';
    if (s === 'entregada') return 'is-ok';
    return 'is-bad';
  }

  guideLabel(s: string): string {
    const map: Record<string, string> = {
      pendiente: 'Pendiente',
      en_ruta: 'En ruta',
      entregada: 'Entregada',
      cancelada: 'Cancelada',
    };
    return map[s] || s;
  }

  recipientPillClass(s: string): string {
    if (s === 'pendiente') return 'is-info';
    if (s === 'entregado') return 'is-ok';
    return 'is-bad';
  }

  recipientLabel(s: string): string {
    const map: Record<string, string> = {
      pendiente: 'Pendiente',
      entregado: 'Entregado',
      cancelado: 'Cancelado',
    };
    return map[s] || s;
  }

  // J.8 — descarga PDF reporte del shipment (jspdf backend)
  downloadPdf(id: string): void {
    this.api.downloadShipmentPdf(id).subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `embarque-${this.shipment()?.folio || id}.pdf`;
        a.click();
        URL.revokeObjectURL(url);
      },
      error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se descargó PDF' }),
    });
  }
  severityGuide(s: string): Severity {
    return s === 'pendiente' ? 'info' : s === 'en_ruta' ? 'warn' :
           s === 'entregada' ? 'success' : 'danger';
  }
  severityRecip(s: string): Severity {
    return s === 'pendiente' ? 'info' : s === 'entregado' ? 'success' : 'danger';
  }

  // ── Metrics ─────────────────────────────────────────────────────────
  openEditMetrics() {
    const s = this.shipment(); if (!s) return;
    this.metricsForm.patchValue({ actual_km: s.actual_km || 0, freight_revenue: s.freight_revenue });
    this.metricsDialog = true;
  }
  saveMetrics() {
    const id = this.shipmentId();
    this.api.updateShipment(id, this.metricsForm.value).subscribe({
      next: (r) => {
        this.metricsDialog = false;
        this.shipment.set(r);
        this.toast.add({ severity:'success', summary:'Datos actualizados' });
      },
      error: (err) => this.toast.add({ severity:'error', summary:'Error', detail: err?.error?.message || 'No se pudo' }),
    });
  }

  // ── Guides ──────────────────────────────────────────────────────────
  openCreateGuide() {
    this.guideForm.reset({
      driver_id: null, helper1_id: null, helper2_id: null,
      driver_commission: 0, helper1_commission: 0, helper2_commission: 0,
      overnight: false, per_diem_total: 0,
    });
    this.guideDialog = true;
    // Autollenar comisiones desde la ruta del embarque (consistencia con el alta).
    const routeId = this.shipment()?.route_id;
    if (routeId) {
      this.api.listRoutes({ active: true }).subscribe((rs) => {
        const r = (rs || []).find((x) => x.id === routeId);
        if (r) this.guideForm.patchValue({
          driver_commission: r.driver_commission || 0,
          helper1_commission: r.helper_commission || 0,
          helper2_commission: r.helper_commission || 0,
        });
      });
    }
  }
  createGuide() {
    this.savingGuide.set(true);
    this.api.createGuide({ shipment_id: this.shipmentId(), ...this.guideForm.value, auto_commissions: false }).subscribe({
      next: () => {
        this.savingGuide.set(false); this.guideDialog = false;
        this.toast.add({ severity:'success', summary:'Guía creada' });
        this.api.listGuides(this.shipmentId()).subscribe((g) => this.guides.set(g || []));
      },
      error: (err) => {
        this.savingGuide.set(false);
        this.toast.add({ severity:'error', summary:'Error', detail: err?.error?.message || 'No se pudo' });
      },
    });
  }

  optimizeRoute() {
    this.optimizing.set(true);
    this.api.optimizeShipmentRoute(this.shipmentId()).subscribe({
      next: (r) => {
        this.optimizing.set(false);
        const extra = r.unlocated ? ` · ${r.unlocated} sin ubicación` : '';
        this.toast.add({
          severity: r.located ? 'success' : 'warn',
          summary: r.located ? 'Ruta optimizada' : 'Sin paradas localizables',
          detail: r.located ? `${r.located} paradas · ${r.total_km} km${extra}` : 'Captura lat/lng en los clientes destino.',
        });
        this.api.listGuides(this.shipmentId()).subscribe((g) => this.guides.set(g || []));
      },
      error: (err) => {
        this.optimizing.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: err?.error?.message || 'No se optimizó' });
      },
    });
  }

  loadEta() {
    this.etaLoading.set(true);
    this.api.shipmentEta(this.shipmentId()).subscribe({
      next: (e) => { this.eta.set(e); this.etaLoading.set(false); },
      error: (err) => {
        this.etaLoading.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: err?.error?.message || 'No se calculó ETA' });
      },
    });
  }

  openGuideDetail(g: DeliveryGuide) {
    this.api.getGuide(g.id).subscribe({
      next: (full) => {
        this.selectedGuide.set(full);
        this.recipientForm.reset({ customer_id: null, order_id: null, customer_name: '', address: '', boxes_count: 0, value: 0 });
        this.customerSuggestions.set([]);
        this.customerOrders.set([]);
        this.guideDetailDialog = true;
      },
    });
  }

  addRecipient(g: DeliveryGuide) {
    if (this.recipientForm.invalid) return;
    this.api.addRecipient(g.id, this.recipientForm.value).subscribe({
      next: () => {
        this.toast.add({ severity:'success', summary:'Destinatario agregado' });
        this.openGuideDetail(g);
      },
      error: (err) => this.toast.add({ severity:'error', summary:'Error', detail: err?.error?.message || 'No se pudo' }),
    });
  }
  markRecipientDelivered(r: GuideRecipient) {
    this.api.markRecipientDelivered(r.id, {}).subscribe({
      next: () => {
        this.toast.add({ severity:'success', summary:'Marcado como entregado' });
        const g = this.selectedGuide(); if (g) this.openGuideDetail(g);
      },
      error: (err) => this.toast.add({ severity:'error', summary:'Error', detail: err?.error?.message || 'No se pudo' }),
    });
  }

  // ── Destinatario: búsqueda de cliente (autorelleno) ─────────────────
  searchCustomer(e: { query: string }) {
    this.api.searchCustomers(e.query).subscribe({
      next: (cs) => this.customerSuggestions.set(cs || []),
      error: () => this.customerSuggestions.set([]),
    });
  }
  onCustomerSelect(e: any) {
    const c: CustomerLite = e?.value ?? e;
    if (!c) return;
    const a = c.billing_address || c.shipping_address;
    const address = a
      ? [a['street'], a['exterior_number'], a['neighborhood'], a['city'], a['state'], a['zip']].filter(Boolean).join(', ')
      : '';
    this.recipientForm.patchValue({ customer_id: c.id, customer_name: c.name, address, order_id: null });
    // Trae los pedidos entregables del cliente para ligar order_id + valor.
    this.customerOrders.set([]);
    this.api.customerOrders(c.id).subscribe({
      next: (os) => this.customerOrders.set(os || []),
      error: () => this.customerOrders.set([]),
    });
  }
  onOrderSelect(orderId: string | null) {
    const o = this.customerOrders().find((x) => x.id === orderId);
    if (o) this.recipientForm.patchValue({ value: o.total });
  }

  // ── Carta Porte ─────────────────────────────────────────────────────
  loadCp() {
    this.api.listCartaPorteByShipment(this.shipmentId()).subscribe({
      next: (d) => this.cpDocs.set(d || []),
      error: () => { /* sin documentos aún — OK */ },
    });
  }
  validateCp() {
    this.cpValidating.set(true);
    this.api.validateCartaPorte(this.shipmentId()).subscribe({
      next: (gaps) => {
        this.cpGaps.set(gaps || []);
        this.cpChecked.set(true);
        this.cpValidating.set(false);
      },
      error: (err) => {
        this.cpValidating.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: err?.error?.message || 'No se validó' });
      },
    });
  }
  stampCp() {
    this.confirm.confirm({
      header: 'Timbrar Carta Porte',
      message: 'Se generará un CFDI de Traslado con complemento Carta Porte ante el SAT. ¿Continuar?',
      icon: 'pi pi-file-check',
      accept: () => {
        this.cpStamping.set(true);
        this.api.stampCartaPorte(this.shipmentId()).subscribe({
          next: () => {
            this.cpStamping.set(false);
            this.toast.add({ severity: 'success', summary: 'Carta Porte timbrada' });
            this.loadCp();
          },
          error: (err) => {
            this.cpStamping.set(false);
            const gaps = err?.error?.gaps as CartaPorteGap[] | undefined;
            if (gaps?.length) { this.cpGaps.set(gaps); this.cpChecked.set(true); }
            this.toast.add({ severity: 'error', summary: 'No se timbró', detail: err?.error?.message || 'Error PAC' });
          },
        });
      },
    });
  }
  cpPillClass(s: string): string {
    if (s === 'timbrado') return 'is-ok';
    if (s === 'error') return 'is-bad';
    if (s === 'cancelado') return 'is-neutral';
    return 'is-info';
  }

  // ── Expenses ────────────────────────────────────────────────────────
  saveExpense() {
    this.savingExp.set(true);
    this.api.upsertExpense(this.shipmentId(), this.expForm.value).subscribe({
      next: (e) => {
        this.savingExp.set(false);
        this.expense.set(e);
        this.toast.add({ severity:'success', summary:'Costos guardados' });
      },
      error: (err) => {
        this.savingExp.set(false);
        this.toast.add({ severity:'error', summary:'Error', detail: err?.error?.message || 'No se pudo' });
      },
    });
  }
}
