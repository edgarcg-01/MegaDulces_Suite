import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { TableModule } from 'primeng/table';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { TagModule } from 'primeng/tag';
import { TabsModule } from 'primeng/tabs';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { MessageService, ConfirmationService } from 'primeng/api';
import {
  Driver, DriverRole, LogisticaService, Vehicle, VehicleStatus,
  VehicleUsageLog, VehicleMaintenance,
} from '../logistica.service';

const VEHICLE_STATUS_OPTIONS: { label: string; value: VehicleStatus }[] = [
  { label: 'Disponible', value: 'disponible' },
  { label: 'En ruta', value: 'en_ruta' },
  { label: 'Mantenimiento', value: 'mantenimiento' },
  { label: 'Baja', value: 'baja' },
];
const DRIVER_ROLE_OPTIONS: { label: string; value: DriverRole }[] = [
  { label: 'Chofer', value: 'chofer' },
  { label: 'Ayudante', value: 'ayudante' },
  { label: 'Cargador', value: 'cargador' },
];
const DRIVER_STATUS_OPTIONS = [
  { label: 'Activo', value: 'activo' },
  { label: 'Inactivo', value: 'inactivo' },
  { label: 'Suspendido', value: 'suspendido' },
];

type Severity = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';
function severityForVehicleStatus(s: VehicleStatus): Severity {
  return s === 'disponible' ? 'success' : s === 'en_ruta' ? 'info' : s === 'mantenimiento' ? 'warn' : 'danger';
}
function severityForDriverStatus(s: string): Severity {
  return s === 'activo' ? 'success' : s === 'suspendido' ? 'warn' : 'danger';
}

@Component({
  selector: 'app-logistica-fleet',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ReactiveFormsModule,
    ButtonModule, CardModule, TableModule, DialogModule,
    InputTextModule, InputNumberModule, SelectModule, MultiSelectModule,
    TagModule, TabsModule, ToastModule, ConfirmDialogModule,
  ],
  providers: [MessageService, ConfirmationService],
  template: `
    <p-toast></p-toast>
    <p-confirmDialog></p-confirmDialog>

    <h2 class="page-title">Flotilla y personal</h2>

    <p-tabs value="vehicles">
      <p-tablist>
        <p-tab value="vehicles"><i class="pi pi-truck"></i> Unidades ({{ vehicles().length }})</p-tab>
        <p-tab value="drivers"><i class="pi pi-id-card"></i> Choferes / ayudantes ({{ drivers().length }})</p-tab>
        <p-tab value="usage"><i class="pi pi-clock"></i> Uso ({{ usageLogs().length }})</p-tab>
        <p-tab value="maintenance"><i class="pi pi-wrench"></i> Mantenimiento ({{ maintenance().length }})</p-tab>
      </p-tablist>
      <p-tabpanels>
        <p-tabpanel value="vehicles">
          <div class="tab-actions"><button pButton icon="pi pi-plus" label="Nueva unidad" (click)="openVehicleCreate()"></button></div>
          <p-card>
            <p-table [value]="vehicles()" [loading]="loadingV()" responsiveLayout="scroll" styleClass="p-datatable-sm">
              <ng-template pTemplate="header">
                <tr>
                  <th>Placa</th><th>Marca/Modelo</th><th>Año</th>
                  <th>Cap. cajas</th><th>Rendim.</th><th>Estado</th><th></th>
                </tr>
              </ng-template>
              <ng-template pTemplate="body" let-v>
                <tr>
                  <td><code>{{ v.plate }}</code></td>
                  <td>{{ (v.brand || '—') + ' / ' + (v.model || '—') }}</td>
                  <td class="num">{{ v.year || '—' }}</td>
                  <td class="num">{{ v.capacity_boxes || '—' }}</td>
                  <td class="num">{{ v.fuel_efficiency_km_l ? (v.fuel_efficiency_km_l + ' km/l') : '—' }}</td>
                  <td><p-tag [severity]="severityVeh(v.status)" [value]="vStatusLabel(v.status)"></p-tag></td>
                  <td class="actions">
                    <button pButton icon="pi pi-pencil" size="small" severity="secondary" [text]="true" (click)="openVehicleEdit(v)"></button>
                    <button pButton icon="pi pi-trash" size="small" severity="danger" [text]="true" (click)="confirmDeleteVehicle(v)" *ngIf="v.active"></button>
                  </td>
                </tr>
              </ng-template>
              <ng-template pTemplate="emptymessage">
                <tr><td colspan="7" class="muted">Sin unidades.</td></tr>
              </ng-template>
            </p-table>
          </p-card>
        </p-tabpanel>

        <p-tabpanel value="drivers">
          <div class="tab-actions"><button pButton icon="pi pi-plus" label="Nuevo colaborador" (click)="openDriverCreate()"></button></div>
          <p-card>
            <p-table [value]="drivers()" [loading]="loadingD()" responsiveLayout="scroll" styleClass="p-datatable-sm">
              <ng-template pTemplate="header">
                <tr>
                  <th>Nombre</th><th>Roles</th><th>Tipo</th>
                  <th>Teléfono</th><th>Estado</th><th></th>
                </tr>
              </ng-template>
              <ng-template pTemplate="body" let-d>
                <tr>
                  <td class="strong">{{ d.full_name }}</td>
                  <td>
                    <p-tag *ngFor="let r of d.roles" [value]="r" severity="info" class="role-tag"></p-tag>
                  </td>
                  <td>{{ d.employee_type }}</td>
                  <td>{{ d.phone || '—' }}</td>
                  <td><p-tag [severity]="severityDrv(d.status)" [value]="d.status"></p-tag></td>
                  <td class="actions">
                    <button pButton icon="pi pi-pencil" size="small" severity="secondary" [text]="true" (click)="openDriverEdit(d)"></button>
                    <button pButton icon="pi pi-trash" size="small" severity="danger" [text]="true" (click)="confirmDeleteDriver(d)" *ngIf="d.active"></button>
                  </td>
                </tr>
              </ng-template>
              <ng-template pTemplate="emptymessage">
                <tr><td colspan="6" class="muted">Sin colaboradores.</td></tr>
              </ng-template>
            </p-table>
          </p-card>
        </p-tabpanel>

        <!-- ──── J.9.9 Tab Uso (check-in/check-out) ──── -->
        <p-tabpanel value="usage">
          <div class="tab-actions">
            <button pButton icon="pi pi-sign-out" label="Nuevo check-in" (click)="openCheckIn()"></button>
          </div>
          <p-card>
            <p-table [value]="usageLogs()" [loading]="loadingUsage()" responsiveLayout="scroll" styleClass="p-datatable-sm">
              <ng-template pTemplate="header">
                <tr>
                  <th>Vehículo</th>
                  <th>Chofer</th>
                  <th>Salida</th>
                  <th class="num">Km inicial</th>
                  <th>Regreso</th>
                  <th class="num">Km final</th>
                  <th class="num">Combustible (L)</th>
                  <th>Estado</th>
                  <th></th>
                </tr>
              </ng-template>
              <ng-template pTemplate="body" let-u>
                <tr>
                  <td><code>{{ u.vehicle_plate }}</code></td>
                  <td>{{ u.driver_name || '—' }}</td>
                  <td>{{ u.check_in_at | date:'short' }}</td>
                  <td class="num">{{ u.check_in_km | number:'1.0-0' }}</td>
                  <td>{{ u.check_out_at ? (u.check_out_at | date:'short') : '—' }}</td>
                  <td class="num">{{ u.check_out_km !== null ? (u.check_out_km | number:'1.0-0') : '—' }}</td>
                  <td class="num">{{ u.fuel_loaded_liters !== null ? (u.fuel_loaded_liters | number:'1.2-2') : '—' }}</td>
                  <td>
                    <p-tag [severity]="u.status === 'en_uso' ? 'warn' : 'success'" [value]="u.status === 'en_uso' ? 'En uso' : 'Cerrado'"></p-tag>
                  </td>
                  <td class="actions">
                    <button pButton icon="pi pi-sign-in" size="small" label="Check-out" (click)="openCheckOut(u)" *ngIf="u.status === 'en_uso'"></button>
                  </td>
                </tr>
              </ng-template>
              <ng-template pTemplate="emptymessage">
                <tr><td colspan="9" class="muted">Sin historial de uso.</td></tr>
              </ng-template>
            </p-table>
          </p-card>
        </p-tabpanel>

        <!-- ──── J.9.9 Tab Mantenimiento ──── -->
        <p-tabpanel value="maintenance">
          <div class="tab-actions">
            <button pButton icon="pi pi-plus" label="Nuevo mantenimiento" (click)="openMaintenance()"></button>
          </div>
          <p-card>
            <p-table [value]="maintenance()" [loading]="loadingMaint()" responsiveLayout="scroll" styleClass="p-datatable-sm">
              <ng-template pTemplate="header">
                <tr>
                  <th>Vehículo</th>
                  <th>Fecha</th>
                  <th>Tipo</th>
                  <th>Descripción</th>
                  <th>Proveedor</th>
                  <th class="num">Km</th>
                  <th class="num">Costo</th>
                  <th>Próximo</th>
                  <th></th>
                </tr>
              </ng-template>
              <ng-template pTemplate="body" let-m>
                <tr>
                  <td><code>{{ m.vehicle_plate }}</code></td>
                  <td>{{ m.service_date | date:'shortDate' }}</td>
                  <td>
                    <p-tag [severity]="m.type === 'correctivo' ? 'danger' : (m.type === 'preventivo' ? 'info' : 'secondary')" [value]="m.type"></p-tag>
                  </td>
                  <td class="small">{{ m.description }}</td>
                  <td>{{ m.vendor || '—' }}</td>
                  <td class="num">{{ m.km_at_service ? (m.km_at_service | number:'1.0-0') : '—' }}</td>
                  <td class="num">\${{ m.cost | number:'1.2-2' }}</td>
                  <td class="small">{{ m.next_service_date ? (m.next_service_date | date:'shortDate') : (m.next_service_km ? (m.next_service_km + ' km') : '—') }}</td>
                  <td class="actions">
                    <button pButton icon="pi pi-trash" size="small" severity="danger" [text]="true" (click)="confirmDeleteMaint(m)"></button>
                  </td>
                </tr>
              </ng-template>
              <ng-template pTemplate="emptymessage">
                <tr><td colspan="9" class="muted">Sin mantenimientos registrados.</td></tr>
              </ng-template>
            </p-table>
          </p-card>
        </p-tabpanel>
      </p-tabpanels>
    </p-tabs>

    <!-- ──── J.9.9 Check-in dialog ──── -->
    <p-dialog [(visible)]="checkInDialog" [modal]="true" [style]="{ width: '480px' }" header="Nuevo check-in de vehículo">
      <form [formGroup]="checkInForm" class="form">
        <label>
          <span>Vehículo *</span>
          <p-select formControlName="vehicle_id" [options]="vehicleOptions()" optionLabel="label" optionValue="value" [filter]="true" placeholder="Seleccionar vehículo"></p-select>
        </label>
        <label>
          <span>Chofer</span>
          <p-select formControlName="driver_id" [options]="driverOptions()" optionLabel="full_name" optionValue="id" [filter]="true" [showClear]="true" placeholder="Sin chofer"></p-select>
        </label>
        <label>
          <span>Km inicial *</span>
          <p-inputNumber formControlName="check_in_km" [min]="0" [useGrouping]="false"></p-inputNumber>
        </label>
        <label>
          <span>Notas</span>
          <input pInputText formControlName="check_in_notes" placeholder="Estado del vehículo, observaciones..." />
        </label>
      </form>
      <ng-template pTemplate="footer">
        <button pButton label="Cancelar" severity="secondary" [text]="true" (click)="checkInDialog = false" [disabled]="savingUsage()"></button>
        <button pButton label="Registrar salida" icon="pi pi-check" [loading]="savingUsage()" [disabled]="checkInForm.invalid" (click)="submitCheckIn()"></button>
      </ng-template>
    </p-dialog>

    <!-- ──── J.9.9 Check-out dialog ──── -->
    <p-dialog [(visible)]="checkOutDialog" [modal]="true" [style]="{ width: '480px' }" header="Check-out de vehículo">
      <div *ngIf="checkingOutUsage() as u" class="muted small" style="margin-bottom: 1rem;">
        <p>Vehículo: <strong>{{ u.vehicle_plate }}</strong></p>
        <p>Km inicial: <strong>{{ u.check_in_km | number:'1.0-0' }}</strong></p>
      </div>
      <form [formGroup]="checkOutForm" class="form">
        <label>
          <span>Km final *</span>
          <p-inputNumber formControlName="check_out_km" [min]="0" [useGrouping]="false"></p-inputNumber>
        </label>
        <label>
          <span>Combustible cargado (L)</span>
          <p-inputNumber formControlName="fuel_loaded_liters" [minFractionDigits]="2"></p-inputNumber>
        </label>
        <label>
          <span>Notas</span>
          <input pInputText formControlName="check_out_notes" placeholder="Daños, incidentes, etc." />
        </label>
      </form>
      <ng-template pTemplate="footer">
        <button pButton label="Cancelar" severity="secondary" [text]="true" (click)="checkOutDialog = false" [disabled]="savingUsage()"></button>
        <button pButton label="Cerrar uso" icon="pi pi-check" [loading]="savingUsage()" [disabled]="checkOutForm.invalid" (click)="submitCheckOut()"></button>
      </ng-template>
    </p-dialog>

    <!-- ──── J.9.9 Maintenance dialog ──── -->
    <p-dialog [(visible)]="maintenanceDialog" [modal]="true" [style]="{ width: '560px' }" header="Nuevo mantenimiento">
      <form [formGroup]="maintenanceForm" class="form">
        <div class="row">
          <label>
            <span>Vehículo *</span>
            <p-select formControlName="vehicle_id" [options]="vehicleOptions()" optionLabel="label" optionValue="value" [filter]="true"></p-select>
          </label>
          <label>
            <span>Tipo *</span>
            <p-select formControlName="type" [options]="maintenanceTypeOptions" optionLabel="label" optionValue="value"></p-select>
          </label>
        </div>
        <div class="row">
          <label>
            <span>Fecha *</span>
            <p-datePicker formControlName="service_date" dateFormat="yy-mm-dd" appendTo="body"></p-datePicker>
          </label>
          <label>
            <span>Km al servicio</span>
            <p-inputNumber formControlName="km_at_service" [useGrouping]="false"></p-inputNumber>
          </label>
        </div>
        <label>
          <span>Descripción *</span>
          <input pInputText formControlName="description" placeholder="Cambio de aceite, frenos, etc." />
        </label>
        <div class="row">
          <label>
            <span>Proveedor / Taller</span>
            <input pInputText formControlName="vendor" />
          </label>
          <label>
            <span>Costo</span>
            <p-inputNumber formControlName="cost" mode="currency" currency="MXN" locale="es-MX"></p-inputNumber>
          </label>
        </div>
        <div class="row">
          <label>
            <span>Próximo servicio (fecha)</span>
            <p-datePicker formControlName="next_service_date" dateFormat="yy-mm-dd" appendTo="body"></p-datePicker>
          </label>
          <label>
            <span>Próximo servicio (km)</span>
            <p-inputNumber formControlName="next_service_km" [useGrouping]="false"></p-inputNumber>
          </label>
        </div>
        <label>
          <span>Notas</span>
          <input pInputText formControlName="notes" />
        </label>
      </form>
      <ng-template pTemplate="footer">
        <button pButton label="Cancelar" severity="secondary" [text]="true" (click)="maintenanceDialog = false" [disabled]="savingMaint()"></button>
        <button pButton label="Registrar" icon="pi pi-check" [loading]="savingMaint()" [disabled]="maintenanceForm.invalid" (click)="submitMaintenance()"></button>
      </ng-template>
    </p-dialog>

    <!-- Vehicle dialog -->
    <p-dialog [(visible)]="vDialog" [modal]="true" [draggable]="false" [style]="{ width: '560px' }"
              [header]="editingV() ? 'Editar unidad' : 'Nueva unidad'">
      <form [formGroup]="vForm" class="form" *ngIf="vForm">
        <div class="row">
          <label>
            <span>Placa <em>*</em></span>
            <input pInputText formControlName="plate" placeholder="ABC-1234" />
          </label>
          <label>
            <span>Año</span>
            <p-inputNumber formControlName="year" [showButtons]="false" [useGrouping]="false"></p-inputNumber>
          </label>
        </div>
        <div class="row">
          <label>
            <span>Marca</span>
            <input pInputText formControlName="brand" />
          </label>
          <label>
            <span>Modelo</span>
            <input pInputText formControlName="model" />
          </label>
        </div>
        <div class="row">
          <label>
            <span>Capacidad (cajas)</span>
            <p-inputNumber formControlName="capacity_boxes"></p-inputNumber>
          </label>
          <label>
            <span>Capacidad (kg)</span>
            <p-inputNumber formControlName="capacity_kg"></p-inputNumber>
          </label>
        </div>
        <div class="row">
          <label>
            <span>Rendimiento (km/l)</span>
            <p-inputNumber formControlName="fuel_efficiency_km_l" [maxFractionDigits]="2" mode="decimal"></p-inputNumber>
          </label>
          <label>
            <span>Estado</span>
            <p-select formControlName="status" [options]="vehicleStatusOptions" optionLabel="label" optionValue="value"></p-select>
          </label>
        </div>
        <label>
          <span>Notas</span>
          <input pInputText formControlName="notes" />
        </label>
      </form>
      <ng-template pTemplate="footer">
        <button pButton label="Cancelar" severity="secondary" [outlined]="true" (click)="vDialog = false"></button>
        <button pButton [label]="editingV() ? 'Guardar' : 'Crear'" icon="pi pi-check"
                [loading]="savingV()" [disabled]="vForm.invalid" (click)="saveVehicle()"></button>
      </ng-template>
    </p-dialog>

    <!-- Driver dialog -->
    <p-dialog [(visible)]="dDialog" [modal]="true" [draggable]="false" [style]="{ width: '560px' }"
              [header]="editingD() ? 'Editar colaborador' : 'Nuevo colaborador'">
      <form [formGroup]="dForm" class="form" *ngIf="dForm">
        <label>
          <span>Nombre completo <em>*</em></span>
          <input pInputText formControlName="full_name" />
        </label>
        <label>
          <span>Roles <em>*</em></span>
          <p-multiSelect formControlName="roles" [options]="driverRoleOptions" optionLabel="label" optionValue="value"
                         display="chip" placeholder="Seleccionar"></p-multiSelect>
        </label>
        <div class="row">
          <label>
            <span>Tipo</span>
            <p-select formControlName="employee_type" [options]="employeeTypes" optionLabel="label" optionValue="value"></p-select>
          </label>
          <label>
            <span>Estado</span>
            <p-select formControlName="status" [options]="driverStatusOptions" optionLabel="label" optionValue="value"></p-select>
          </label>
        </div>
        <div class="row">
          <label>
            <span>Teléfono</span>
            <input pInputText formControlName="phone" />
          </label>
          <label>
            <span>NSS</span>
            <input pInputText formControlName="nss" />
          </label>
        </div>
        <label>
          <span>Contacto emergencia</span>
          <input pInputText formControlName="emergency_contact" />
        </label>
        <label>
          <span>Notas</span>
          <input pInputText formControlName="notes" />
        </label>
      </form>
      <ng-template pTemplate="footer">
        <button pButton label="Cancelar" severity="secondary" [outlined]="true" (click)="dDialog = false"></button>
        <button pButton [label]="editingD() ? 'Guardar' : 'Crear'" icon="pi pi-check"
                [loading]="savingD()" [disabled]="dForm.invalid" (click)="saveDriver()"></button>
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    :host { display:block; }
    .page-title { margin: 0 0 1rem; font-size:1.25rem; }
    .tab-actions { display:flex; justify-content:flex-end; margin: .5rem 0; }
    .muted { color: var(--text-color-secondary); font-size:.85rem; }
    .strong { font-weight: 600; }
    .num { font-variant-numeric: tabular-nums; }
    .actions { display:flex; gap:.25rem; justify-content:flex-end; }
    .role-tag { margin-right: .25rem; }
    code { background: var(--surface-100); padding:.15rem .4rem; border-radius:4px; font-size:.85rem; }
    .form { display:flex; flex-direction:column; gap: .85rem; }
    .form label { display:flex; flex-direction:column; gap:.25rem; font-size:.85rem; color:var(--text-color-secondary); }
    .form em { color:#ef4444; font-style:normal; }
    .row { display:grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogisticaFleetComponent {
  private readonly api = inject(LogisticaService);
  private readonly fb = inject(FormBuilder);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);

  readonly vehicles = signal<Vehicle[]>([]);
  readonly drivers = signal<Driver[]>([]);
  readonly loadingV = signal(false);
  readonly loadingD = signal(false);

  readonly editingV = signal<Vehicle | null>(null);
  readonly editingD = signal<Driver | null>(null);
  readonly savingV = signal(false);
  readonly savingD = signal(false);

  vDialog = false;
  dDialog = false;

  // J.9.9 — Vehicle usage + maintenance state
  readonly usageLogs = signal<VehicleUsageLog[]>([]);
  readonly maintenance = signal<VehicleMaintenance[]>([]);
  readonly loadingUsage = signal(false);
  readonly loadingMaint = signal(false);
  readonly savingUsage = signal(false);
  readonly savingMaint = signal(false);
  readonly checkingOutUsage = signal<VehicleUsageLog | null>(null);
  checkInDialog = false;
  checkOutDialog = false;
  maintenanceDialog = false;

  readonly vehicleStatusOptions = VEHICLE_STATUS_OPTIONS;
  readonly driverRoleOptions = DRIVER_ROLE_OPTIONS;
  readonly driverStatusOptions = DRIVER_STATUS_OPTIONS;
  readonly employeeTypes = [{ label: 'Interno', value: 'interno' }, { label: 'Externo', value: 'externo' }];
  readonly maintenanceTypeOptions = [
    { label: 'Preventivo', value: 'preventivo' },
    { label: 'Correctivo', value: 'correctivo' },
    { label: 'Inspección', value: 'inspeccion' },
  ];

  // Vehicle/Driver options para los selects de los dialogs J.9.9
  readonly vehicleOptions = computed(() =>
    this.vehicles().filter((v) => v.active).map((v) => ({
      label: `${v.plate}${v.model ? ' — ' + v.model : ''}`,
      value: v.id,
    })),
  );
  readonly driverOptions = computed(() =>
    this.drivers().filter((d) => d.active && d.status === 'activo' && d.roles.includes('chofer')),
  );

  // J.9.9 forms
  checkInForm: FormGroup = this.fb.group({
    vehicle_id: [null as string | null, Validators.required],
    driver_id: [null as string | null],
    check_in_km: [0, [Validators.required, Validators.min(0)]],
    check_in_notes: [''],
  });
  checkOutForm: FormGroup = this.fb.group({
    check_out_km: [0, [Validators.required, Validators.min(0)]],
    fuel_loaded_liters: [null as number | null],
    check_out_notes: [''],
  });
  maintenanceForm: FormGroup = this.fb.group({
    vehicle_id: [null as string | null, Validators.required],
    type: ['preventivo' as 'preventivo' | 'correctivo' | 'inspeccion', Validators.required],
    service_date: [new Date(), Validators.required],
    km_at_service: [null as number | null],
    vendor: [''],
    description: ['', Validators.required],
    cost: [0],
    next_service_date: [null as Date | null],
    next_service_km: [null as number | null],
    notes: [''],
  });

  vForm: FormGroup = this.fb.group({
    plate: ['', [Validators.required, Validators.pattern(/^[A-Z0-9-]{2,20}$/)]],
    brand: [''], model: [''], year: [null],
    capacity_boxes: [null], capacity_kg: [null], fuel_efficiency_km_l: [null],
    status: ['disponible' as VehicleStatus, Validators.required],
    notes: [''],
  });

  dForm: FormGroup = this.fb.group({
    full_name: ['', Validators.required],
    roles: [['chofer'] as DriverRole[], [Validators.required]],
    employee_type: ['interno', Validators.required],
    status: ['activo', Validators.required],
    phone: [''], nss: [''], emergency_contact: [''], notes: [''],
  });

  constructor() {
    this.loadVehicles();
    this.loadDrivers();
    this.loadUsage();
    this.loadMaintenance();
  }

  loadVehicles() {
    this.loadingV.set(true);
    this.api.listVehicles().subscribe({
      next: (r) => { this.vehicles.set(r || []); this.loadingV.set(false); },
      error: () => { this.loadingV.set(false); this.toast.add({ severity:'error', summary:'Error', detail:'No se cargaron unidades' }); },
    });
  }
  loadDrivers() {
    this.loadingD.set(true);
    this.api.listDrivers().subscribe({
      next: (r) => { this.drivers.set(r || []); this.loadingD.set(false); },
      error: () => { this.loadingD.set(false); this.toast.add({ severity:'error', summary:'Error', detail:'No se cargaron colaboradores' }); },
    });
  }

  // ── J.9.9 Vehicle usage (check-in / check-out) ──────────────────────────
  loadUsage() {
    this.loadingUsage.set(true);
    this.api.listVehicleUsage({ limit: 100 }).subscribe({
      next: (r) => { this.usageLogs.set(r || []); this.loadingUsage.set(false); },
      error: () => { this.loadingUsage.set(false); /* silent */ },
    });
  }
  openCheckIn() {
    this.checkInForm.reset({ vehicle_id: null, driver_id: null, check_in_km: 0, check_in_notes: '' });
    this.checkInDialog = true;
  }
  submitCheckIn() {
    if (this.checkInForm.invalid) return;
    this.savingUsage.set(true);
    this.api.vehicleCheckIn(this.checkInForm.value).subscribe({
      next: () => {
        this.savingUsage.set(false); this.checkInDialog = false;
        this.toast.add({ severity: 'success', summary: 'Check-in registrado' });
        this.loadUsage(); this.loadVehicles();
      },
      error: (e) => {
        this.savingUsage.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo registrar' });
      },
    });
  }
  openCheckOut(u: VehicleUsageLog) {
    this.checkingOutUsage.set(u);
    this.checkOutForm.reset({ check_out_km: u.check_in_km, fuel_loaded_liters: null, check_out_notes: '' });
    this.checkOutDialog = true;
  }
  submitCheckOut() {
    const u = this.checkingOutUsage();
    if (!u || this.checkOutForm.invalid) return;
    this.savingUsage.set(true);
    this.api.vehicleCheckOut(u.id, this.checkOutForm.value).subscribe({
      next: () => {
        this.savingUsage.set(false); this.checkOutDialog = false;
        this.toast.add({ severity: 'success', summary: 'Check-out completado' });
        this.loadUsage(); this.loadVehicles();
      },
      error: (e) => {
        this.savingUsage.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo cerrar' });
      },
    });
  }

  // ── J.9.9 Vehicle maintenance log ───────────────────────────────────────
  loadMaintenance() {
    this.loadingMaint.set(true);
    this.api.listMaintenance({ limit: 100 }).subscribe({
      next: (r) => { this.maintenance.set(r || []); this.loadingMaint.set(false); },
      error: () => { this.loadingMaint.set(false); /* silent */ },
    });
  }
  openMaintenance() {
    this.maintenanceForm.reset({
      vehicle_id: null, type: 'preventivo', service_date: new Date(),
      km_at_service: null, vendor: '', description: '', cost: 0,
      next_service_date: null, next_service_km: null, notes: '',
    });
    this.maintenanceDialog = true;
  }
  submitMaintenance() {
    if (this.maintenanceForm.invalid) return;
    const raw = this.maintenanceForm.value;
    const body = {
      ...raw,
      service_date: raw.service_date instanceof Date
        ? raw.service_date.toISOString().slice(0, 10)
        : raw.service_date,
      next_service_date: raw.next_service_date instanceof Date
        ? raw.next_service_date.toISOString().slice(0, 10)
        : raw.next_service_date || undefined,
    };
    this.savingMaint.set(true);
    this.api.createMaintenance(body).subscribe({
      next: () => {
        this.savingMaint.set(false); this.maintenanceDialog = false;
        this.toast.add({ severity: 'success', summary: 'Mantenimiento registrado' });
        this.loadMaintenance();
      },
      error: (e) => {
        this.savingMaint.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo registrar' });
      },
    });
  }
  confirmDeleteMaint(m: VehicleMaintenance) {
    this.confirm.confirm({
      header: 'Eliminar mantenimiento',
      message: `¿Borrar el registro "${m.description}" del ${m.service_date}?`,
      icon: 'pi pi-exclamation-triangle',
      accept: () => {
        this.api.deleteMaintenance(m.id).subscribe({
          next: () => { this.toast.add({ severity: 'success', summary: 'Borrado' }); this.loadMaintenance(); },
          error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se borró' }),
        });
      },
    });
  }

  severityVeh(s: VehicleStatus): Severity { return severityForVehicleStatus(s); }
  severityDrv(s: string): Severity { return severityForDriverStatus(s); }
  vStatusLabel(s: VehicleStatus): string {
    return VEHICLE_STATUS_OPTIONS.find((o) => o.value === s)?.label || s;
  }

  // ── Vehicles ─────────────────────────────────────────────────────────
  openVehicleCreate() {
    this.editingV.set(null);
    this.vForm.reset({ plate: '', brand: '', model: '', year: null, capacity_boxes: null, capacity_kg: null, fuel_efficiency_km_l: null, status: 'disponible', notes: '' });
    this.vForm.get('plate')?.enable();
    this.vDialog = true;
  }
  openVehicleEdit(v: Vehicle) {
    this.editingV.set(v);
    this.vForm.reset({
      plate: v.plate, brand: v.brand || '', model: v.model || '',
      year: v.year, capacity_boxes: v.capacity_boxes, capacity_kg: v.capacity_kg,
      fuel_efficiency_km_l: v.fuel_efficiency_km_l, status: v.status, notes: v.notes || '',
    });
    this.vForm.get('plate')?.disable();
    this.vDialog = true;
  }
  saveVehicle() {
    if (this.vForm.invalid) return;
    this.savingV.set(true);
    const payload = this.vForm.getRawValue();
    const editing = this.editingV();
    const obs = editing ? this.api.updateVehicle(editing.id, payload) : this.api.createVehicle(payload);
    obs.subscribe({
      next: () => {
        this.savingV.set(false); this.vDialog = false;
        this.toast.add({ severity:'success', summary: editing ? 'Unidad actualizada' : 'Unidad creada' });
        this.loadVehicles();
      },
      error: (err) => {
        this.savingV.set(false);
        this.toast.add({ severity:'error', summary:'Error', detail: err?.error?.message || 'No se pudo guardar' });
      },
    });
  }
  confirmDeleteVehicle(v: Vehicle) {
    this.confirm.confirm({
      message: `¿Dar de baja la unidad ${v.plate}? No podrá asignarse a nuevos embarques.`,
      header: 'Confirmar', icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, dar de baja', rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => this.api.deleteVehicle(v.id).subscribe({
        next: () => { this.toast.add({ severity:'success', summary:'Unidad dada de baja' }); this.loadVehicles(); },
        error: (err) => this.toast.add({ severity:'error', summary:'Error', detail: err?.error?.message || 'No se pudo' }),
      }),
    });
  }

  // ── Drivers ──────────────────────────────────────────────────────────
  openDriverCreate() {
    this.editingD.set(null);
    this.dForm.reset({ full_name: '', roles: ['chofer'], employee_type: 'interno', status: 'activo', phone: '', nss: '', emergency_contact: '', notes: '' });
    this.dDialog = true;
  }
  openDriverEdit(d: Driver) {
    this.editingD.set(d);
    this.dForm.reset({
      full_name: d.full_name, roles: d.roles, employee_type: d.employee_type, status: d.status,
      phone: d.phone || '', nss: d.nss || '', emergency_contact: d.emergency_contact || '', notes: d.notes || '',
    });
    this.dDialog = true;
  }
  saveDriver() {
    if (this.dForm.invalid) return;
    this.savingD.set(true);
    const payload = this.dForm.getRawValue();
    const editing = this.editingD();
    const obs = editing ? this.api.updateDriver(editing.id, payload) : this.api.createDriver(payload);
    obs.subscribe({
      next: () => {
        this.savingD.set(false); this.dDialog = false;
        this.toast.add({ severity:'success', summary: editing ? 'Colaborador actualizado' : 'Colaborador creado' });
        this.loadDrivers();
      },
      error: (err) => {
        this.savingD.set(false);
        this.toast.add({ severity:'error', summary:'Error', detail: err?.error?.message || 'No se pudo guardar' });
      },
    });
  }
  confirmDeleteDriver(d: Driver) {
    this.confirm.confirm({
      message: `¿Dar de baja al colaborador ${d.full_name}? No podrá ser asignado a nuevas guías.`,
      header: 'Confirmar', icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, dar de baja', rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => this.api.deleteDriver(d.id).subscribe({
        next: () => { this.toast.add({ severity:'success', summary:'Colaborador dado de baja' }); this.loadDrivers(); },
        error: (err) => this.toast.add({ severity:'error', summary:'Error', detail: err?.error?.message || 'No se pudo' }),
      }),
    });
  }
}
