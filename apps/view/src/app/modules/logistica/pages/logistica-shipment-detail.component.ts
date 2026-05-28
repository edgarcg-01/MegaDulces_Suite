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
import { TagModule } from 'primeng/tag';
import { TabsModule } from 'primeng/tabs';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { MessageService, ConfirmationService } from 'primeng/api';
import {
  DeliveryGuide, Driver, GuideRecipient, LogisticaService, Shipment, ShipmentExpense, Vehicle,
} from '../logistica.service';

type Severity = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';

@Component({
  selector: 'app-logistica-shipment-detail',
  standalone: true,
  imports: [
    CommonModule, RouterLink, FormsModule, ReactiveFormsModule,
    ButtonModule, CardModule, TableModule, DialogModule,
    InputTextModule, InputNumberModule, CheckboxModule, SelectModule,
    TagModule, TabsModule, ToastModule, ConfirmDialogModule,
  ],
  providers: [MessageService, ConfirmationService],
  template: `
    <p-toast></p-toast>
    <p-confirmDialog></p-confirmDialog>

    <div class="header-row" *ngIf="shipment() as s">
      <div>
        <a routerLink="/logistica/shipments" class="back"><i class="pi pi-arrow-left"></i> Volver</a>
        <h2>Embarque <code>{{ s.folio }}</code></h2>
        <p class="muted">{{ s.shipment_date | date:'mediumDate' }} · {{ s.origin || '—' }} → {{ s.destination || '—' }}</p>
      </div>
      <div class="header-actions">
        <p-tag [severity]="severityStatus(s.status)" [value]="s.status" class="big-tag"></p-tag>
        <a pButton icon="pi pi-check-square" label="Checklists" severity="secondary" size="small" [routerLink]="['/logistica/shipments', s.id, 'checklists']"></a>
        <a pButton icon="pi pi-camera" label="Fotos" severity="secondary" size="small" [routerLink]="['/logistica/shipments', s.id, 'photos']"></a>
        <button pButton icon="pi pi-file-pdf" label="PDF" severity="secondary" size="small" (click)="downloadPdf(s.id)"></button>
      </div>
    </div>

    <p-tabs value="info">
      <p-tablist>
        <p-tab value="info"><i class="pi pi-info-circle"></i> Información</p-tab>
        <p-tab value="guides"><i class="pi pi-file-edit"></i> Guías ({{ guides().length }})</p-tab>
        <p-tab value="expenses"><i class="pi pi-money-bill"></i> Costos</p-tab>
      </p-tablist>
      <p-tabpanels>
        <!-- INFO -->
        <p-tabpanel value="info">
          <p-card *ngIf="shipment() as s">
            <div class="info-grid">
              <div><span class="label">Tipo</span><span>{{ s.type }}</span></div>
              <div><span class="label">Cajas</span><span class="num">{{ s.boxes_count }}</span></div>
              <div><span class="label">Peso (kg)</span><span class="num">{{ s.total_weight_kg }}</span></div>
              <div><span class="label">Km recorridos</span><span class="num">{{ s.actual_km || '—' }}</span></div>
              <div><span class="label">Valor carga</span><span class="num">\${{ s.cargo_value | number:'1.2-2' }}</span></div>
              <div><span class="label">Flete cobrado</span><span class="num">\${{ s.freight_revenue | number:'1.2-2' }}</span></div>
              <div><span class="label">Salida</span><span>{{ s.departure_at ? (s.departure_at | date:'short') : '—' }}</span></div>
              <div><span class="label">Llegada</span><span>{{ s.arrival_at ? (s.arrival_at | date:'short') : '—' }}</span></div>
            </div>
            <div *ngIf="s.notes" class="notes-row"><span class="label">Notas</span><p>{{ s.notes }}</p></div>
            <div class="info-actions">
              <button pButton icon="pi pi-pencil" label="Editar km / flete" size="small" severity="secondary"
                      [disabled]="s.status === 'cerrado' || s.status === 'cancelado'"
                      (click)="openEditMetrics()"></button>
            </div>
          </p-card>
        </p-tabpanel>

        <!-- GUIDES -->
        <p-tabpanel value="guides">
          <div class="tab-actions" *ngIf="canAddGuide()">
            <button pButton icon="pi pi-plus" label="Nueva guía" (click)="openCreateGuide()"></button>
          </div>
          <p-card>
            <p-table [value]="guides()" responsiveLayout="scroll" styleClass="p-datatable-sm">
              <ng-template pTemplate="header">
                <tr>
                  <th>Número</th><th>Chofer</th>
                  <th class="num">Comisiones</th><th class="num">Viáticos</th>
                  <th>Estado</th><th></th>
                </tr>
              </ng-template>
              <ng-template pTemplate="body" let-g>
                <tr>
                  <td><code>{{ g.number }}</code></td>
                  <td>{{ driverName(g.driver_id) || '—' }}</td>
                  <td class="num">\${{ (g.driver_commission + g.helper1_commission + g.helper2_commission) | number:'1.2-2' }}</td>
                  <td class="num">\${{ g.per_diem_total | number:'1.2-2' }}</td>
                  <td><p-tag [severity]="severityGuide(g.status)" [value]="g.status"></p-tag></td>
                  <td class="actions">
                    <button pButton icon="pi pi-eye" size="small" [text]="true" (click)="openGuideDetail(g)"></button>
                  </td>
                </tr>
              </ng-template>
              <ng-template pTemplate="emptymessage">
                <tr><td colspan="6" class="muted">Sin guías. Agregar una para asignar chofer y destinatarios.</td></tr>
              </ng-template>
            </p-table>
          </p-card>
        </p-tabpanel>

        <!-- EXPENSES -->
        <p-tabpanel value="expenses">
          <p-card>
            <form [formGroup]="expForm" class="exp-form">
              <div class="exp-row">
                <label><span>Combustible</span><p-inputNumber formControlName="fuel" mode="currency" currency="MXN" locale="es-MX"></p-inputNumber></label>
                <label><span>Casetas</span><p-inputNumber formControlName="tolls" mode="currency" currency="MXN" locale="es-MX"></p-inputNumber></label>
                <label><span>Hospedaje</span><p-inputNumber formControlName="lodging" mode="currency" currency="MXN" locale="es-MX"></p-inputNumber></label>
              </div>
              <div class="exp-row">
                <label><span>Pensiones</span><p-inputNumber formControlName="parking" mode="currency" currency="MXN" locale="es-MX"></p-inputNumber></label>
                <label><span>Permisos</span><p-inputNumber formControlName="permits" mode="currency" currency="MXN" locale="es-MX"></p-inputNumber></label>
                <label><span>Talachas</span><p-inputNumber formControlName="repairs" mode="currency" currency="MXN" locale="es-MX"></p-inputNumber></label>
              </div>
              <div class="exp-row">
                <label><span>Ayudantes ext.</span><p-inputNumber formControlName="external_helpers" mode="currency" currency="MXN" locale="es-MX"></p-inputNumber></label>
                <label><span>Maniobras</span><p-inputNumber formControlName="handling" mode="currency" currency="MXN" locale="es-MX"></p-inputNumber></label>
                <label><span>Viáticos guía</span><p-inputNumber formControlName="driver_per_diem" mode="currency" currency="MXN" locale="es-MX"></p-inputNumber></label>
              </div>
              <div class="exp-row">
                <label><span>Otros</span><p-inputNumber formControlName="other" mode="currency" currency="MXN" locale="es-MX"></p-inputNumber></label>
                <label class="check-line">
                  <p-checkbox formControlName="apply_config_km" [binary]="true" inputId="apply_km"></p-checkbox>
                  <span>Aplicar costo km de configuración (recalcula total)</span>
                </label>
              </div>
              <label>
                <span>Notas</span>
                <input pInputText formControlName="notes" />
              </label>

              <div class="exp-totals" *ngIf="expense() as e">
                <div><span class="label">Operativo</span><strong class="num">\${{ e.operating_subtotal | number:'1.2-2' }}</strong></div>
                <div><span class="label">Km × {{ e.fixed_cost_per_km | number:'1.2-4' }}</span>
                     <strong class="num">\${{ (e.total_cost - e.operating_subtotal) | number:'1.2-2' }}</strong></div>
                <div class="grand"><span class="label">Total</span><strong class="num">\${{ e.total_cost | number:'1.2-2' }}</strong></div>
              </div>

              <div class="exp-actions">
                <button pButton icon="pi pi-save" label="Guardar costos"
                        [loading]="savingExp()" (click)="saveExpense()"></button>
              </div>
            </form>
          </p-card>
        </p-tabpanel>
      </p-tabpanels>
    </p-tabs>

    <!-- Edit metrics dialog -->
    <p-dialog [(visible)]="metricsDialog" [modal]="true" [draggable]="false" [style]="{ width: '420px' }" header="Editar km / flete">
      <form [formGroup]="metricsForm" class="form">
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
      <form [formGroup]="guideForm" class="form">
        <label>
          <span>Chofer principal</span>
          <p-select formControlName="driver_id" [options]="driverOptions()" optionLabel="label" optionValue="value"
                    placeholder="Seleccionar" [showClear]="true" appendTo="body"></p-select>
        </label>
        <div class="row">
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
        </div>
        <div class="row">
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
        </div>
        <div class="row">
          <label class="check-line">
            <p-checkbox formControlName="overnight" [binary]="true" inputId="ov"></p-checkbox>
            <span>El chofer duerme fuera (overnight)</span>
          </label>
          <label>
            <span>Viáticos totales</span>
            <p-inputNumber formControlName="per_diem_total" mode="currency" currency="MXN" locale="es-MX"></p-inputNumber>
          </label>
        </div>
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
        <h4>Destinatarios ({{ (g.recipients || []).length }})</h4>
        <p-table [value]="g.recipients || []" responsiveLayout="scroll" styleClass="p-datatable-sm">
          <ng-template pTemplate="header">
            <tr><th>Cliente</th><th>Dirección</th><th class="num">Cajas</th><th class="num">Valor</th><th>Estado</th><th></th></tr>
          </ng-template>
          <ng-template pTemplate="body" let-r>
            <tr>
              <td class="strong">{{ r.customer_name }}</td>
              <td class="muted">{{ r.address || '—' }}</td>
              <td class="num">{{ r.boxes_count }}</td>
              <td class="num">\${{ r.value | number:'1.2-2' }}</td>
              <td><p-tag [severity]="severityRecip(r.status)" [value]="r.status"></p-tag></td>
              <td class="actions">
                <button pButton *ngIf="r.status === 'pendiente'" icon="pi pi-check" size="small" severity="success" [text]="true"
                        pTooltip="Marcar entregado" (click)="markRecipientDelivered(r)"></button>
              </td>
            </tr>
          </ng-template>
          <ng-template pTemplate="emptymessage">
            <tr><td colspan="6" class="muted">Sin destinatarios.</td></tr>
          </ng-template>
        </p-table>

        <form [formGroup]="recipientForm" class="form add-recipient" *ngIf="g.status !== 'entregada' && g.status !== 'cancelada'">
          <h5>Agregar destinatario</h5>
          <div class="row three">
            <label><span>Nombre <em>*</em></span><input pInputText formControlName="customer_name" /></label>
            <label><span>Cajas</span><p-inputNumber formControlName="boxes_count"></p-inputNumber></label>
            <label><span>Valor</span><p-inputNumber formControlName="value" mode="currency" currency="MXN" locale="es-MX"></p-inputNumber></label>
          </div>
          <label><span>Dirección</span><input pInputText formControlName="address" /></label>
          <div class="exp-actions">
            <button pButton icon="pi pi-plus" label="Agregar" [disabled]="recipientForm.invalid" (click)="addRecipient(g)"></button>
          </div>
        </form>
      </div>
    </p-dialog>
  `,
  styles: [`
    :host { display:block; }
    .header-row { display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:1rem; gap:1rem; }
    .header-row h2 { margin:.25rem 0; font-size:1.35rem; }
    .back { display:inline-flex; align-items:center; gap:.25rem; font-size:.8rem; color:var(--text-color-secondary); text-decoration: none; }
    .back:hover { color: var(--primary-color); }
    .muted { color: var(--text-color-secondary); font-size:.85rem; margin:0; }
    .big-tag { transform: scale(1.3); }
    .strong { font-weight: 600; }
    .num { font-variant-numeric: tabular-nums; text-align:right; }
    .label { display:block; font-size:.75rem; color: var(--text-color-secondary); margin-bottom:.15rem; }
    .info-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap:1rem; }
    .info-grid > div { display:flex; flex-direction:column; }
    .info-actions { display:flex; justify-content:flex-end; margin-top:1rem; }
    .notes-row { margin-top:1rem; padding-top: .75rem; border-top:1px solid var(--surface-border); }
    .notes-row p { margin: .15rem 0 0; }
    code { background: var(--surface-100); padding:.15rem .4rem; border-radius:4px; font-weight: 600; }
    .actions { display:flex; gap:.25rem; justify-content:flex-end; }
    .tab-actions { display:flex; justify-content:flex-end; margin: .5rem 0; }
    .exp-form { display:flex; flex-direction:column; gap: .85rem; }
    .exp-form label { display:flex; flex-direction:column; gap:.25rem; font-size:.85rem; color:var(--text-color-secondary); }
    .exp-row { display:grid; grid-template-columns: 1fr 1fr 1fr; gap: 1rem; }
    .check-line { flex-direction: row !important; align-items:center; gap:.5rem !important; color: var(--text-color-primary, inherit) !important; }
    .exp-totals { display:grid; grid-template-columns: 1fr 1fr 1fr; gap: 1rem; padding: 1rem; background: var(--surface-100); border-radius: 6px; margin-top: .5rem; }
    .exp-totals > div { display:flex; flex-direction:column; gap:.15rem; }
    .exp-totals .grand strong { color: var(--primary-color); font-size: 1.15rem; }
    .exp-actions { display:flex; justify-content:flex-end; margin-top: .5rem; }
    .form { display:flex; flex-direction:column; gap:.85rem; }
    .form label { display:flex; flex-direction:column; gap:.25rem; font-size:.85rem; color:var(--text-color-secondary); }
    .form em { color: var(--bad-fg); font-style:normal; }
    .row { display:grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    .row.three { grid-template-columns: 2fr 1fr 1fr; }
    .add-recipient { padding-top:1rem; border-top:1px solid var(--surface-border); margin-top:1rem; }
    .add-recipient h5 { margin: 0 0 .5rem; }
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
  readonly selectedGuide = signal<DeliveryGuide | null>(null);

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
    customer_name: ['', Validators.required],
    address: [''],
    boxes_count: [0],
    value: [0],
  });

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

  openGuideDetail(g: DeliveryGuide) {
    this.api.getGuide(g.id).subscribe({
      next: (full) => {
        this.selectedGuide.set(full);
        this.recipientForm.reset({ customer_name: '', address: '', boxes_count: 0, value: 0 });
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
