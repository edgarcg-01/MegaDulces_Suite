import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { FormBuilder, FormGroup, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { CheckboxModule } from 'primeng/checkbox';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { MessageService, ConfirmationService } from 'primeng/api';
import { ComercialService, Warehouse } from '../comercial.service';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { INV_STOCK_TABS } from '../inventory-tabs';

@Component({
  selector: 'app-comercial-warehouses',
  standalone: true,
  imports: [
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
    TooltipModule,
    ConfirmDialogModule,
    PageTabsComponent
],
  providers: [MessageService, ConfirmationService],
  template: `
    <div class="surf-page wh">
      <p-toast></p-toast>
      <p-confirmdialog></p-confirmdialog>
      <app-page-tabs [tabs]="inventoryTabs" />
    
      <!-- PAGE HEAD -->
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Almacenes</h1>
          <p class="surf-page-sub">
            <b>{{ rows().length }}</b> almacén{{ rows().length === 1 ? '' : 'es' }}
            <span class="wh-divider" aria-hidden="true">·</span>
            puntos de stock del tenant
          </p>
        </div>
        <div class="wh-head-actions">
          <button pButton [text]="true" severity="secondary" size="small" (click)="load()" [loading]="loading()" pTooltip="Refrescar"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span></button>
          <button pButton size="small" severity="contrast" (click)="openCreate()"><span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span><span class="p-button-label">Nuevo almacén</span></button>
        </div>
      </header>
    
      <!-- TABLA flush -->
      <div class="sheet cols-12">
        <article class="cell cell-span-12 is-flush">
          <p-table [value]="rows()" [loading]="loading()" responsiveLayout="scroll"
            styleClass="p-datatable-sm surf-table surf-table--sticky surf-table--frozen-first surf-table--zebra">
            <ng-template #header>
              <tr>
                <th scope="col">Código</th>
                <th scope="col">Nombre</th>
                <th scope="col">Dirección</th>
                <th scope="col">Default</th>
                <th scope="col">Estado</th>
                <th scope="col"><span class="sr-only">Acciones</span></th>
              </tr>
            </ng-template>
            <ng-template #body let-w>
              <tr>
                <td><code class="comm-code">{{ w.code }}</code></td>
                <td>
                  <span class="wh-name">
                    <i class="pi pi-warehouse" aria-hidden="true"></i>
                    <span class="comm-cell-strong">{{ w.name }}</span>
                  </span>
                </td>
                <td>{{ w.address || '—' }}</td>
                <td>
                  @if (w.is_default) {
                    <span class="wh-default-badge">
                      <i class="pi pi-bookmark-fill" aria-hidden="true"></i>
                      Default
                    </span>
                  }
                  @if (!w.is_default) {
                    <span class="comm-muted">—</span>
                  }
                </td>
                <td>
                  <span class="wh-status" [class.is-on]="w.active !== false">
                    <span class="wh-status-dot" aria-hidden="true"></span>
                    {{ w.active !== false ? 'Activo' : 'Inactivo' }}
                  </span>
                </td>
                <td class="comm-actions">
                  <button pButton size="small" severity="secondary" [text]="true" (click)="openEdit(w)" pTooltip="Editar"><span class="p-button-icon p-button-icon-left pi pi-pencil" aria-hidden="true"></span></button>
                  @if (w.active !== false) {
                    <button pButton size="small" severity="secondary" [text]="true" (click)="confirmDelete(w)" pTooltip="Desactivar"><span class="p-button-icon p-button-icon-left pi pi-trash" aria-hidden="true"></span></button>
                  }
                </td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr>
                <td colspan="6" class="comm-empty-cell">
                  <div class="comm-empty">
                    <div class="comm-empty-icon"><i class="pi pi-warehouse" aria-hidden="true"></i></div>
                    <h3>Sin almacenes</h3>
                    <p>Creá un almacén para empezar a registrar stock y procesar pedidos.</p>
                    <button type="button" pButton severity="contrast" size="small" (click)="openCreate()"><span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span><span class="p-button-label">Nuevo almacén</span></button>
                  </div>
                </td>
              </tr>
            </ng-template>
          </p-table>
        </article>
      </div>
    </div>
    
    <p-dialog
      [(visible)]="dialogVisible"
      [modal]="true"
      [draggable]="false"
      [style]="{ width: '480px' }"
      [header]="editing() ? 'Editar almacén' : 'Nuevo almacén'"
      >
      @if (form) {
        <form [formGroup]="form" class="comm-form">
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
          @if (form.value.is_default) {
            <div class="comm-form-hint">
              <i class="pi pi-info-circle"></i>
              Solo puede haber 1 default; al activar éste, el anterior se desactivará automáticamente.
            </div>
          }
        </form>
      }
      <ng-template #footer>
        <button pButton severity="secondary" [outlined]="true" (click)="dialogVisible = false"><span class="p-button-label">Cancelar</span></button>
        <p-button pButton [label]="editing() ? 'Guardar' : 'Crear'" icon="pi pi-check"
          [loading]="saving()"
          [disabled]="form.invalid"
        (click)="save()"></p-button>
      </ng-template>
    </p-dialog>
    `,
  styles: [`
    :host { display:block; }

    .wh-head-actions { display:flex; gap:.5rem; align-items:center; }
    .wh-divider { opacity: 0.4; }
    .surf-page-sub b { font-weight: var(--fw-bold); color: var(--c-text-1); }

    /* ── Nombre con icono (consistente con inventory) ── */
    .wh-name {
      display: inline-flex;
      align-items: center;
      gap: .4rem;
    }
    .wh-name i {
      color: var(--c-text-3);
      font-size: var(--fs-xs);
    }

    /* ── Default badge (subtle, no pill llena) ── */
    .wh-default-badge {
      display: inline-flex;
      align-items: center;
      gap: .35rem;
      font-size: var(--fs-xs);
      font-weight: var(--fw-bold);
      color: var(--c-text-1);
      text-transform: uppercase;
      letter-spacing: .04em;
    }
    .wh-default-badge i {
      font-size: var(--fs-xs);
      color: var(--c-text-2);
    }

    /* ── Estado dot + label (sin pill llena) ── */
    .wh-status {
      display: inline-flex;
      align-items: center;
      gap: .4rem;
      font-size: var(--fs-sm);
      color: var(--c-text-3);
    }
    .wh-status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--c-text-3);
    }
    .wh-status.is-on { color: var(--c-text-1); }
    .wh-status.is-on .wh-status-dot { background: var(--c-ok); }

  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComercialWarehousesComponent {
  readonly inventoryTabs = INV_STOCK_TABS;
  private readonly api = inject(ComercialService);
  private readonly fb = inject(FormBuilder);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);
  private readonly destroyRef = inject(DestroyRef);

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
    this.api.listWarehouses().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        // Backend retorna array directo. Antes era `r.data || []` y siempre
        // caía al fallback vacío aunque el importer cargara 11 warehouses.
        this.rows.set(Array.isArray(r) ? r : []);
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
    obs.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
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
        this.api.deleteWarehouse(w.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
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
