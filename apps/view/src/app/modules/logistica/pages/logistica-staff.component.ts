import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { TextareaModule } from 'primeng/textarea';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { MultiSelectModule } from 'primeng/multiselect';
import { CheckboxModule } from 'primeng/checkbox';
import { TagModule } from 'primeng/tag';
import { AvatarModule } from 'primeng/avatar';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { MessageService, ConfirmationService } from 'primeng/api';
import { Driver, DriverRole, BloodType, LogisticaService } from '../logistica.service';
import { MetricCardComponent } from '../../../shared/components/metric-card/metric-card.component';

type Severity = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';

/**
 * J.9.2 — Staff/Personal page.
 *
 * Migrado del repo `_imported/logistica/.../features/staff/`.
 * En este monorepo el "staff" se mapea a `logistics.drivers` (con roles[]
 * chofer|ayudante|cargador), por lo que reusamos los endpoints de drivers
 * pero presentamos la pantalla con el branding "Personal".
 */
@Component({
  selector: 'app-logistica-staff',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ReactiveFormsModule,
    ButtonModule, TableModule, DialogModule,
    InputTextModule, InputNumberModule, TextareaModule, SelectModule, MultiSelectModule, CheckboxModule, DatePickerModule,
    TagModule, AvatarModule, ToastModule, ConfirmDialogModule,
    MetricCardComponent,
  ],
  providers: [MessageService, ConfirmationService],
  template: `
    <div class="surf-page logs">
    <p-toast></p-toast>
    <p-confirmDialog></p-confirmDialog>

    <header class="surf-page-head">
      <div class="surf-page-head-text">
        <h1>Personal</h1>
        <p class="surf-page-sub">Choferes, ayudantes y cargadores. Un colaborador puede tener varios roles.</p>
      </div>
      <button pButton icon="pi pi-plus" label="Nuevo colaborador" (click)="openCreate()"></button>
    </header>

    <!-- KPI cards (J14/J15: jerarquía + color + count-up + spotlight) -->
    <div class="surf-grid">
      <app-metric-card class="panel-col-6" [large]="true"
        label="Total colaboradores" [value]="drivers().length" format="number"
        accent="var(--chart-2)" sub="choferes, ayudantes y cargadores"></app-metric-card>
      <app-metric-card class="panel-col-2"
        label="Activos" [value]="activos()" format="number" accent="var(--ok-fg)"></app-metric-card>
      <app-metric-card class="panel-col-2"
        label="Suspendidos" [value]="suspendidos()" format="number" accent="var(--warn-fg)"></app-metric-card>
      <app-metric-card class="panel-col-2"
        label="Inactivos" [value]="inactivos()" format="number" accent="var(--c-text-3)"></app-metric-card>
    </div>

    <!-- Filters + tabla -->
    <div class="filter-row">
      <input pInputText type="search" [(ngModel)]="search" (input)="onSearch()" placeholder="Buscar por nombre"
             inputmode="search" enterkeyhint="search" autocapitalize="none" autocorrect="off" spellcheck="false" />
      <p-select [(ngModel)]="roleFilter" [options]="roleOptions" optionLabel="label" optionValue="value"
                (onChange)="reload()" placeholder="Rol" [showClear]="true" styleClass="filter-select"></p-select>
    </div>

    <section class="surf-panel">
      <div class="surf-panel-body is-flush">
      <p-table [value]="drivers()" [loading]="loading()" responsiveLayout="scroll" styleClass="surf-table surf-table--sticky surf-table--frozen-first surf-table--zebra p-datatable-sm">
        <ng-template pTemplate="header">
          <tr>
            <th scope="col"><span class="sr-only">Avatar</span></th>
            <th scope="col">Nombre</th>
            <th scope="col">Roles</th>
            <th scope="col">Tipo</th>
            <th scope="col">Estado</th>
            <th scope="col">Teléfono</th>
            <th scope="col">NSS</th>
            <th scope="col"><span class="sr-only">Acciones</span></th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-d>
          <tr>
            <td>
              <p-avatar [label]="initials(d.full_name)" shape="circle"
                [style]="{ background: avatarColor(d.full_name), color: '#fff' }"></p-avatar>
            </td>
            <td><strong>{{ d.full_name }}</strong></td>
            <td>
              <p-tag *ngFor="let r of d.roles" [value]="r" severity="secondary" styleClass="role-tag"></p-tag>
            </td>
            <td>{{ d.employee_type }}</td>
            <td>
              <p-tag [severity]="severityStatus(d.status)" [value]="d.status"></p-tag>
            </td>
            <td>{{ d.phone || '—' }}</td>
            <td>{{ d.nss || '—' }}</td>
            <td class="actions">
              <button pButton icon="pi pi-pencil" size="small" severity="secondary" [text]="true" (click)="openEdit(d)"></button>
              <button pButton icon="pi pi-trash" size="small" severity="secondary" [text]="true" (click)="confirmDelete(d)"></button>
            </td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="8" class="comm-empty-cell">
            <div class="comm-empty">
              <i class="pi pi-users comm-empty-icon"></i>
              <p>Sin colaboradores. Creá el primero con el botón de arriba.</p>
            </div>
          </td></tr>
        </ng-template>
      </p-table>
      </div>
    </section>
    </div>

    <!-- Create/Edit Dialog -->
    <p-dialog [(visible)]="dialogVisible" [modal]="true" [style]="{ width: '520px' }"
              [header]="editing() ? 'Editar colaborador' : 'Nuevo colaborador'" [closable]="!saving()">
      <form [formGroup]="form" class="form-grid">
        <label class="full">
          Nombre completo *
          <input pInputText formControlName="full_name" />
        </label>
        <label class="full">
          Roles *
          <p-multiselect formControlName="roles" [options]="roleOptions" optionLabel="label" optionValue="value"
                         placeholder="Seleccionar roles" styleClass="w-full"></p-multiselect>
        </label>
        <label>
          Tipo empleado
          <p-select formControlName="employee_type" [options]="employeeTypeOptions" optionLabel="label" optionValue="value"></p-select>
        </label>
        <label>
          Estado
          <p-select formControlName="status" [options]="statusOptions" optionLabel="label" optionValue="value"></p-select>
        </label>
        <label>
          Teléfono
          <input pInputText formControlName="phone" />
        </label>
        <label>
          NSS
          <input pInputText formControlName="nss" />
        </label>
        <label>
          Contacto emergencia (nombre)
          <input pInputText formControlName="emergency_contact" />
        </label>
        <label>
          Teléfono emergencia
          <input pInputText formControlName="emergency_phone" inputmode="tel" />
        </label>

        <div class="form-section full">Datos legales / IMSS</div>
        <label>
          CURP
          <input pInputText formControlName="curp" maxlength="18" style="text-transform: uppercase;" />
        </label>
        <label>
          RFC
          <input pInputText formControlName="rfc" maxlength="13" style="text-transform: uppercase;" />
        </label>
        <label>
          Tipo de sangre
          <p-select formControlName="blood_type" [options]="bloodTypeOptions" optionLabel="label" optionValue="value" [showClear]="true" placeholder="—"></p-select>
        </label>
        <label>
          Licencia federal (choferes)
          <input pInputText formControlName="federal_license" />
        </label>
        <label>
          Fecha de ingreso
          <input pInputText type="date" formControlName="hire_date" />
        </label>
        <label>
          Sueldo base catorcenal ($)
          <input pInputText type="number" min="0" step="0.01" formControlName="base_salary_biweekly" />
        </label>

        <label class="full">
          Notas
          <textarea pTextarea rows="2" formControlName="notes"></textarea>
        </label>
      </form>

      <ng-template pTemplate="footer">
        <button pButton label="Cancelar" severity="secondary" [text]="true" (click)="dialogVisible = false" [disabled]="saving()"></button>
        <button pButton [label]="editing() ? 'Guardar cambios' : 'Crear'" icon="pi pi-check" (click)="save()" [loading]="saving()" [disabled]="form.invalid"></button>
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    :host { display:block; }

    .filter-row { display:flex; gap:.75rem; align-items:center; flex-wrap:wrap; }
    .filter-row input { min-width: 200px; }
    :host ::ng-deep .filter-select { min-width: 180px; }

    .role-tag { margin-right:.25rem; }
    .actions { display:flex; gap:.25rem; justify-content:flex-end; }

    .form-grid { display:grid; grid-template-columns: 1fr 1fr; gap:1rem; margin-top:1rem; }
    .form-grid label { display:flex; flex-direction:column; gap:.25rem; font-size:.8rem; color: var(--c-text-2); }
    .form-grid .full { grid-column: 1 / -1; }
    .form-section { grid-column: 1 / -1; font-size:.7rem; text-transform: uppercase; letter-spacing:.1em; color: var(--c-text-2); border-bottom: 1px solid var(--c-divider); padding-bottom: .25rem; margin-top: .5rem; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogisticaStaffComponent {
  private readonly api = inject(LogisticaService);
  private readonly fb = inject(FormBuilder);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);

  readonly drivers = signal<Driver[]>([]);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly editing = signal<Driver | null>(null);

  search = '';
  roleFilter: DriverRole | null = null;
  dialogVisible = false;
  private searchTimeout: any = null;

  readonly roleOptions: { label: string; value: DriverRole }[] = [
    { label: 'Chofer', value: 'chofer' },
    { label: 'Ayudante', value: 'ayudante' },
    { label: 'Cargador', value: 'cargador' },
  ];
  readonly employeeTypeOptions = [
    { label: 'Interno', value: 'interno' },
    { label: 'Externo', value: 'externo' },
  ];
  readonly statusOptions = [
    { label: 'Activo', value: 'activo' },
    { label: 'Inactivo', value: 'inactivo' },
    { label: 'Suspendido', value: 'suspendido' },
  ];
  readonly bloodTypeOptions: { label: string; value: BloodType }[] = [
    { label: 'O+', value: 'O+' }, { label: 'O-', value: 'O-' },
    { label: 'A+', value: 'A+' }, { label: 'A-', value: 'A-' },
    { label: 'B+', value: 'B+' }, { label: 'B-', value: 'B-' },
    { label: 'AB+', value: 'AB+' }, { label: 'AB-', value: 'AB-' },
  ];

  form = this.fb.group({
    full_name: ['', Validators.required],
    roles: [[] as DriverRole[], Validators.required],
    employee_type: ['interno'],
    status: ['activo'],
    phone: [''],
    nss: [''],
    emergency_contact: [''],
    emergency_phone: [''],
    curp: [''],
    rfc: [''],
    blood_type: [null as BloodType | null],
    federal_license: [''],
    hire_date: [''],
    base_salary_biweekly: [null as number | null],
    notes: [''],
  });

  readonly activos = computed(() => this.drivers().filter((d) => d.status === 'activo').length);
  readonly suspendidos = computed(() => this.drivers().filter((d) => d.status === 'suspendido').length);
  readonly inactivos = computed(() => this.drivers().filter((d) => d.status === 'inactivo').length);

  constructor() {
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.api.listDrivers({
      role: this.roleFilter || undefined,
      search: this.search || undefined,
    }).subscribe({
      next: (list) => { this.drivers.set(list || []); this.loading.set(false); },
      error: () => {
        this.loading.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se cargaron colaboradores' });
      },
    });
  }

  onSearch(): void {
    if (this.searchTimeout) clearTimeout(this.searchTimeout);
    this.searchTimeout = setTimeout(() => this.reload(), 300);
  }

  openCreate(): void {
    this.editing.set(null);
    this.form.reset({
      full_name: '', roles: [], employee_type: 'interno', status: 'activo',
      phone: '', nss: '', emergency_contact: '', emergency_phone: '',
      curp: '', rfc: '', blood_type: null, federal_license: '',
      hire_date: '', base_salary_biweekly: null, notes: '',
    });
    this.dialogVisible = true;
  }

  openEdit(d: Driver): void {
    this.editing.set(d);
    this.form.patchValue({
      full_name: d.full_name,
      roles: d.roles,
      employee_type: d.employee_type,
      status: d.status,
      phone: d.phone || '',
      nss: d.nss || '',
      emergency_contact: d.emergency_contact || '',
      emergency_phone: d.emergency_phone || '',
      curp: d.curp || '',
      rfc: d.rfc || '',
      blood_type: d.blood_type || null,
      federal_license: d.federal_license || '',
      hire_date: d.hire_date || '',
      base_salary_biweekly: d.base_salary_biweekly ?? null,
      notes: d.notes || '',
    });
    this.dialogVisible = true;
  }

  save(): void {
    if (this.form.invalid) return;
    this.saving.set(true);
    const body = this.form.value as Partial<Driver>;
    const ed = this.editing();
    const obs$ = ed ? this.api.updateDriver(ed.id, body) : this.api.createDriver(body);
    obs$.subscribe({
      next: () => {
        this.saving.set(false);
        this.dialogVisible = false;
        this.toast.add({ severity: 'success', summary: ed ? 'Actualizado' : 'Creado' });
        this.reload();
      },
      error: (e) => {
        this.saving.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se guardó' });
      },
    });
  }

  confirmDelete(d: Driver): void {
    this.confirm.confirm({
      header: 'Eliminar colaborador',
      message: `¿Borrar a ${d.full_name}? (soft-delete)`,
      icon: 'pi pi-exclamation-triangle',
      accept: () => {
        this.api.deleteDriver(d.id).subscribe({
          next: () => { this.toast.add({ severity: 'success', summary: 'Borrado' }); this.reload(); },
          error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se borró' }),
        });
      },
    });
  }

  severityStatus(s: string): Severity {
    if (s === 'activo') return 'success';
    if (s === 'suspendido') return 'warn';
    return 'secondary';
  }

  initials(name: string): string {
    return name.split(' ').slice(0, 2).map((p) => p[0] || '').join('').toUpperCase();
  }

  avatarColor(name: string): string {
    // Paleta canónica --avatar-1..8 (AA con texto blanco, adapta a dark mode).
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash << 5) - hash + name.charCodeAt(i);
    return `var(--avatar-${(Math.abs(hash) % 8) + 1})`;
  }
}
