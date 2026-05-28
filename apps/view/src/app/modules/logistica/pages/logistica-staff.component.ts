import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { TableModule } from 'primeng/table';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { TextareaModule } from 'primeng/textarea';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { CheckboxModule } from 'primeng/checkbox';
import { TagModule } from 'primeng/tag';
import { AvatarModule } from 'primeng/avatar';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { MessageService, ConfirmationService } from 'primeng/api';
import { Driver, DriverRole, LogisticaService } from '../logistica.service';

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
    ButtonModule, CardModule, TableModule, DialogModule,
    InputTextModule, TextareaModule, SelectModule, MultiSelectModule, CheckboxModule,
    TagModule, AvatarModule, ToastModule, ConfirmDialogModule,
  ],
  providers: [MessageService, ConfirmationService],
  template: `
    <p-toast></p-toast>
    <p-confirmDialog></p-confirmDialog>

    <div class="header-row">
      <div>
        <h2>Personal</h2>
        <p class="muted">Choferes, ayudantes y cargadores. Un colaborador puede tener varios roles.</p>
      </div>
      <button pButton icon="pi pi-plus" label="Nuevo colaborador" (click)="openCreate()"></button>
    </div>

    <!-- KPI cards -->
    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label">Total colaboradores</div>
        <div class="kpi-value">{{ drivers().length }}</div>
      </div>
      <div class="kpi-card kpi-green">
        <div class="kpi-label">Activos</div>
        <div class="kpi-value">{{ activos() }}</div>
      </div>
      <div class="kpi-card kpi-orange">
        <div class="kpi-label">Suspendidos</div>
        <div class="kpi-value">{{ suspendidos() }}</div>
      </div>
      <div class="kpi-card kpi-secondary">
        <div class="kpi-label">Inactivos</div>
        <div class="kpi-value">{{ inactivos() }}</div>
      </div>
    </div>

    <!-- Filters -->
    <p-card>
      <div class="filter-row">
        <input pInputText [(ngModel)]="search" (input)="onSearch()" placeholder="Buscar por nombre" />
        <p-select [(ngModel)]="roleFilter" [options]="roleOptions" optionLabel="label" optionValue="value"
                  (onChange)="reload()" placeholder="Rol" [showClear]="true" styleClass="filter-select"></p-select>
      </div>

      <p-table [value]="drivers()" [loading]="loading()" responsiveLayout="scroll" styleClass="p-datatable-sm">
        <ng-template pTemplate="header">
          <tr>
            <th></th>
            <th>Nombre</th>
            <th>Roles</th>
            <th>Tipo</th>
            <th>Estado</th>
            <th>Teléfono</th>
            <th>NSS</th>
            <th></th>
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
              <p-tag *ngFor="let r of d.roles" [value]="r" severity="info" styleClass="role-tag"></p-tag>
            </td>
            <td>{{ d.employee_type }}</td>
            <td>
              <p-tag [severity]="severityStatus(d.status)" [value]="d.status"></p-tag>
            </td>
            <td>{{ d.phone || '—' }}</td>
            <td>{{ d.nss || '—' }}</td>
            <td class="actions">
              <button pButton icon="pi pi-pencil" size="small" severity="secondary" [text]="true" (click)="openEdit(d)"></button>
              <button pButton icon="pi pi-trash" size="small" severity="danger" [text]="true" (click)="confirmDelete(d)"></button>
            </td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="8" class="muted">Sin colaboradores. Creá el primero con el botón de arriba.</td></tr>
        </ng-template>
      </p-table>
    </p-card>

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
        <label class="full">
          Contacto emergencia
          <input pInputText formControlName="emergency_contact" />
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
    .header-row { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:1rem; flex-wrap:wrap; gap:1rem; }
    .header-row h2 { margin:0 0 .25rem; font-size:1.25rem; }
    .muted { color: var(--text-color-secondary); font-size:.85rem; margin:0; }

    .kpi-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap:1rem; margin-bottom:1rem; }
    .kpi-card { background: var(--surface-card, var(--surface-50)); border-left: 4px solid var(--surface-300); border-radius: 8px; padding: .75rem 1rem; }
    .kpi-green { border-left-color: var(--ok-fg); }
    .kpi-orange { border-left-color: var(--warn-fg); }
    .kpi-secondary { border-left-color: var(--surface-400); }
    .kpi-label { font-size:.7rem; text-transform: uppercase; letter-spacing:.05em; color: var(--text-color-secondary); }
    .kpi-value { font-size:1.5rem; font-weight:700; margin-top:.25rem; }

    .filter-row { display:flex; gap:.75rem; align-items:center; margin-bottom:1rem; flex-wrap:wrap; }
    .filter-row input { min-width: 200px; }
    :host ::ng-deep .filter-select { min-width: 180px; }

    .role-tag { margin-right:.25rem; }
    .actions { display:flex; gap:.25rem; justify-content:flex-end; }

    .form-grid { display:grid; grid-template-columns: 1fr 1fr; gap:1rem; margin-top:1rem; }
    .form-grid label { display:flex; flex-direction:column; gap:.25rem; font-size:.8rem; color: var(--text-color-secondary); }
    .form-grid .full { grid-column: 1 / -1; }
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

  form = this.fb.group({
    full_name: ['', Validators.required],
    roles: [[] as DriverRole[], Validators.required],
    employee_type: ['interno'],
    status: ['activo'],
    phone: [''],
    nss: [''],
    emergency_contact: [''],
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
      phone: '', nss: '', emergency_contact: '', notes: '',
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
    const colors = ['#9333ea', '#16a34a', '#f5a623', '#0ea5e9', '#dc2626', '#7c3aed'];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash << 5) - hash + name.charCodeAt(i);
    return colors[Math.abs(hash) % colors.length];
  }
}
