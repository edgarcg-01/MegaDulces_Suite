import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { CheckboxModule } from 'primeng/checkbox';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { MessageService, ConfirmationService } from 'primeng/api';
import { ComercialService, Warehouse } from '../comercial.service';

@Component({
  selector: 'app-comercial-warehouses',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ReactiveFormsModule,
    ButtonModule,
    CardModule,
    TableModule,
    TagModule,
    DialogModule,
    InputTextModule,
    CheckboxModule,
    ToastModule,
    ConfirmDialogModule,
  ],
  providers: [MessageService, ConfirmationService],
  template: `
    <p-toast></p-toast>
    <p-confirmDialog></p-confirmDialog>

    <div class="header-row">
      <div>
        <h2>Almacenes</h2>
        <p class="muted">Puntos de stock del tenant. {{ rows().length }} registros.</p>
      </div>
      <button pButton icon="pi pi-plus" label="Nuevo almacén" (click)="openCreate()"></button>
    </div>

    <p-card>
      <p-table [value]="rows()" [loading]="loading()" responsiveLayout="scroll" styleClass="p-datatable-sm">
        <ng-template pTemplate="header">
          <tr>
            <th>Código</th>
            <th>Nombre</th>
            <th>Dirección</th>
            <th>Default</th>
            <th>Estado</th>
            <th></th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-w>
          <tr>
            <td><code>{{ w.code }}</code></td>
            <td class="strong">{{ w.name }}</td>
            <td>{{ w.address || '—' }}</td>
            <td>
              <p-tag *ngIf="w.is_default" severity="info" value="Default"></p-tag>
              <span *ngIf="!w.is_default" class="muted">—</span>
            </td>
            <td>
              <p-tag *ngIf="w.active !== false" severity="success" value="Activo"></p-tag>
              <p-tag *ngIf="w.active === false" severity="danger" value="Inactivo"></p-tag>
            </td>
            <td class="actions">
              <button pButton icon="pi pi-pencil" size="small" severity="secondary" [text]="true" (click)="openEdit(w)"></button>
              <button pButton icon="pi pi-trash" size="small" severity="danger" [text]="true" (click)="confirmDelete(w)" *ngIf="w.active !== false"></button>
            </td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="6" class="muted">Sin almacenes registrados.</td></tr>
        </ng-template>
      </p-table>
    </p-card>

    <p-dialog
      [(visible)]="dialogVisible"
      [modal]="true"
      [draggable]="false"
      [style]="{ width: '480px' }"
      [header]="editing() ? 'Editar almacén' : 'Nuevo almacén'"
    >
      <form [formGroup]="form" class="form" *ngIf="form">
        <label>
          <span>Código <em>*</em></span>
          <input pInputText formControlName="code" placeholder="ej: MD-CENTRAL" />
        </label>
        <label>
          <span>Nombre <em>*</em></span>
          <input pInputText formControlName="name" />
        </label>
        <label>
          <span>Dirección</span>
          <input pInputText formControlName="address" />
        </label>
        <label class="checkbox-line">
          <p-checkbox formControlName="is_default" [binary]="true" inputId="is_default"></p-checkbox>
          <span>Almacén por defecto del tenant</span>
        </label>
        <div class="hint" *ngIf="form.value.is_default">
          <i class="pi pi-info-circle"></i>
          Solo puede haber 1 default; al activar éste, el anterior se desactivará automáticamente.
        </div>
      </form>
      <ng-template pTemplate="footer">
        <button pButton label="Cancelar" severity="secondary" [outlined]="true" (click)="dialogVisible = false"></button>
        <button pButton [label]="editing() ? 'Guardar' : 'Crear'" icon="pi pi-check"
                [loading]="saving()"
                [disabled]="form.invalid"
                (click)="save()"></button>
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    :host { display:block; }
    .header-row { display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:1rem; }
    .header-row h2 { margin:0 0 .25rem; font-size:1.25rem; }
    .muted { color: var(--text-color-secondary); font-size:.85rem; margin:0; }
    .strong { font-weight: 600; }
    .actions { display:flex; gap:.25rem; justify-content:flex-end; }
    code { background: var(--surface-100); padding:.15rem .4rem; border-radius:4px; font-size:.85rem; }
    .form { display:flex; flex-direction:column; gap: 1rem; }
    .form label { display:flex; flex-direction:column; gap:.25rem; font-size:.85rem; color:var(--text-color-secondary); }
    .form em { color: var(--bad-fg); font-style: normal; }
    .checkbox-line { flex-direction: row !important; align-items: center; gap:.5rem !important; color: var(--text-color-primary, inherit) !important; }
    .hint { background: var(--info-soft-bg); color: var(--info-soft-fg); padding:.5rem .75rem; border-radius:4px; font-size:.8rem; display:flex; gap:.5rem; align-items:flex-start; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComercialWarehousesComponent {
  private readonly api = inject(ComercialService);
  private readonly fb = inject(FormBuilder);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);

  readonly rows = signal<Warehouse[]>([]);
  readonly loading = signal(false);
  readonly editing = signal<Warehouse | null>(null);
  readonly saving = signal(false);
  dialogVisible = false;

  form: FormGroup = this.fb.group({
    code: ['', [Validators.required, Validators.pattern(/^[A-Z0-9_-]{2,50}$/)]],
    name: ['', Validators.required],
    address: [''],
    is_default: [false],
  });

  constructor() {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.api.listWarehouses().subscribe({
      next: (r) => {
        this.rows.set(r.data || []);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar almacenes' });
      },
    });
  }

  openCreate(): void {
    this.editing.set(null);
    this.form.reset({ code: '', name: '', address: '', is_default: false });
    this.form.get('code')?.enable();
    this.dialogVisible = true;
  }

  openEdit(w: Warehouse): void {
    this.editing.set(w);
    this.form.reset({
      code: w.code,
      name: w.name,
      address: w.address || '',
      is_default: w.is_default || false,
    });
    this.form.get('code')?.disable();
    this.dialogVisible = true;
  }

  save(): void {
    if (this.form.invalid) return;
    this.saving.set(true);
    const payload = this.form.getRawValue();
    const editing = this.editing();
    const obs = editing
      ? this.api.updateWarehouse(editing.id, payload)
      : this.api.createWarehouse(payload);
    obs.subscribe({
      next: () => {
        this.saving.set(false);
        this.dialogVisible = false;
        this.toast.add({ severity: 'success', summary: editing ? 'Almacén actualizado' : 'Almacén creado' });
        this.load();
      },
      error: (err) => {
        this.saving.set(false);
        const detail = err?.error?.message || 'No se pudo guardar';
        this.toast.add({ severity: 'error', summary: 'Error', detail });
      },
    });
  }

  confirmDelete(w: Warehouse): void {
    this.confirm.confirm({
      message: `¿Desactivar almacén ${w.name}? El stock asociado queda intacto, pero no se podrán crear nuevos movimientos hasta reactivarlo.`,
      header: 'Confirmar',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, desactivar',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => {
        this.api.deleteWarehouse(w.id).subscribe({
          next: () => {
            this.toast.add({ severity: 'success', summary: 'Almacén desactivado' });
            this.load();
          },
          error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo desactivar' }),
        });
      },
    });
  }
}
