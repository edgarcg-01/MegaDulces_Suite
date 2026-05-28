import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { CheckboxModule } from 'primeng/checkbox';
import { SelectModule } from 'primeng/select';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { MessageService, ConfirmationService } from 'primeng/api';
import { ComercialService, PriceList, ProductPrice } from '../comercial.service';

@Component({
  selector: 'app-comercial-pricing',
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
    SelectModule,
    ToastModule,
    ConfirmDialogModule,
  ],
  providers: [MessageService, ConfirmationService],
  template: `
    <p-toast></p-toast>
    <p-confirmDialog></p-confirmDialog>

    <div class="header-row">
      <div>
        <h2>Listas de precios</h2>
        <p class="muted">Cada lista contiene precios por producto. Asignables a clientes para que vean ese precio en el portal/vendor.</p>
      </div>
      <button pButton icon="pi pi-plus" label="Nueva lista" (click)="openCreate()"></button>
    </div>

    <p-card>
      <p-table [value]="rows()" [loading]="loading()" responsiveLayout="scroll" styleClass="p-datatable-sm">
        <ng-template pTemplate="header">
          <tr>
            <th>Código</th>
            <th>Nombre</th>
            <th>Moneda</th>
            <th>Default</th>
            <th>Estado</th>
            <th></th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-pl>
          <tr [class.selected-row]="selected()?.id === pl.id">
            <td><code>{{ pl.code }}</code></td>
            <td class="strong">{{ pl.name }}</td>
            <td>{{ pl.currency || 'MXN' }}</td>
            <td>
              <p-tag *ngIf="pl.is_default" severity="info" value="Default"></p-tag>
              <span *ngIf="!pl.is_default" class="muted">—</span>
            </td>
            <td>
              <p-tag *ngIf="pl.active !== false" severity="success" value="Activa"></p-tag>
              <p-tag *ngIf="pl.active === false" severity="danger" value="Inactiva"></p-tag>
            </td>
            <td class="actions">
              <button pButton icon="pi pi-list" size="small" severity="secondary" [text]="true"
                      pTooltip="Ver precios" (click)="selectPriceList(pl)"></button>
              <button pButton icon="pi pi-pencil" size="small" severity="secondary" [text]="true" (click)="openEdit(pl)"></button>
              <button pButton icon="pi pi-trash" size="small" severity="danger" [text]="true" (click)="confirmDelete(pl)" *ngIf="pl.active !== false"></button>
            </td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="6" class="muted">Sin listas de precios registradas.</td></tr>
        </ng-template>
      </p-table>
    </p-card>

    <p-card *ngIf="selected() as sel" header="Precios — {{ sel.name }}" styleClass="prices-card">
      <p-table [value]="prices()" [loading]="loadingPrices()" responsiveLayout="scroll" styleClass="p-datatable-sm">
        <ng-template pTemplate="header">
          <tr>
            <th>Producto</th>
            <th class="num">Precio</th>
            <th class="num">Min qty</th>
            <th></th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-p>
          <tr>
            <td>
              <div class="strong">{{ p.product_name || p.product_id }}</div>
              <div class="muted small" *ngIf="p.brand_name">{{ p.brand_name }}</div>
            </td>
            <td class="num strong">{{ p.price | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
            <td class="num">{{ p.min_quantity || 1 }}</td>
            <td class="actions">
              <button pButton icon="pi pi-trash" size="small" severity="danger" [text]="true" (click)="confirmDeletePrice(p)"></button>
            </td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="4" class="muted">Sin precios cargados en esta lista. Usá el importer CLI <code>database/importers/commercial_import.js --type=prices</code> para carga masiva.</td></tr>
        </ng-template>
      </p-table>
    </p-card>

    <p-dialog
      [(visible)]="dialogVisible"
      [modal]="true"
      [draggable]="false"
      [style]="{ width: '440px' }"
      [header]="editing() ? 'Editar lista de precios' : 'Nueva lista de precios'"
    >
      <form [formGroup]="form" class="form" *ngIf="form">
        <label>
          <span>Código <em>*</em></span>
          <input pInputText formControlName="code" placeholder="ej: VIP-MXN" />
        </label>
        <label>
          <span>Nombre <em>*</em></span>
          <input pInputText formControlName="name" />
        </label>
        <label>
          <span>Moneda</span>
          <input pInputText formControlName="currency" placeholder="MXN" maxlength="3" style="text-transform:uppercase" />
        </label>
        <label class="checkbox-line">
          <p-checkbox formControlName="is_default" [binary]="true" inputId="pl_default"></p-checkbox>
          <span>Lista por defecto del tenant</span>
        </label>
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
    .muted { color: var(--text-color-secondary); font-size:.85rem; }
    .muted.small { font-size:.8rem; }
    .strong { font-weight: 600; }
    .num { text-align: right; }
    .actions { display:flex; gap:.25rem; justify-content:flex-end; }
    code { background: var(--surface-100); padding:.15rem .4rem; border-radius:4px; font-size:.85rem; }
    .selected-row { background: rgba(59,130,246,0.06); }
    .prices-card { margin-top: 1rem; }
    .form { display:flex; flex-direction:column; gap: 1rem; }
    .form label { display:flex; flex-direction:column; gap:.25rem; font-size:.85rem; color:var(--text-color-secondary); }
    .form em { color: var(--bad-fg); font-style: normal; }
    .checkbox-line { flex-direction: row !important; align-items: center; gap:.5rem !important; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComercialPricingComponent {
  private readonly api = inject(ComercialService);
  private readonly fb = inject(FormBuilder);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);

  readonly rows = signal<PriceList[]>([]);
  readonly loading = signal(false);
  readonly selected = signal<PriceList | null>(null);
  readonly prices = signal<ProductPrice[]>([]);
  readonly loadingPrices = signal(false);

  readonly editing = signal<PriceList | null>(null);
  readonly saving = signal(false);
  dialogVisible = false;

  form: FormGroup = this.fb.group({
    code: ['', [Validators.required, Validators.pattern(/^[A-Z0-9_-]{2,50}$/)]],
    name: ['', Validators.required],
    currency: ['MXN'],
    is_default: [false],
  });

  constructor() {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.api.listPriceLists().subscribe({
      next: (r) => {
        this.rows.set(r.data || []);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar listas' });
      },
    });
  }

  selectPriceList(pl: PriceList): void {
    this.selected.set(pl);
    this.loadingPrices.set(true);
    this.api.listPrices(pl.id).subscribe({
      next: (r) => {
        this.prices.set(r.data || []);
        this.loadingPrices.set(false);
      },
      error: () => {
        this.loadingPrices.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar precios' });
      },
    });
  }

  openCreate(): void {
    this.editing.set(null);
    this.form.reset({ code: '', name: '', currency: 'MXN', is_default: false });
    this.form.get('code')?.enable();
    this.dialogVisible = true;
  }

  openEdit(pl: PriceList): void {
    this.editing.set(pl);
    this.form.reset({
      code: pl.code,
      name: pl.name,
      currency: pl.currency || 'MXN',
      is_default: pl.is_default || false,
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
      ? this.api.updatePriceList(editing.id, payload)
      : this.api.createPriceList(payload);
    obs.subscribe({
      next: () => {
        this.saving.set(false);
        this.dialogVisible = false;
        this.toast.add({ severity: 'success', summary: editing ? 'Lista actualizada' : 'Lista creada' });
        this.load();
      },
      error: (err) => {
        this.saving.set(false);
        const detail = err?.error?.message || 'No se pudo guardar';
        this.toast.add({ severity: 'error', summary: 'Error', detail });
      },
    });
  }

  confirmDelete(pl: PriceList): void {
    this.confirm.confirm({
      message: `¿Desactivar lista ${pl.name}? Pedidos previos mantienen su precio histórico (snapshot inmutable en líneas).`,
      header: 'Confirmar',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, desactivar',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => {
        this.api.deletePriceList(pl.id).subscribe({
          next: () => {
            this.toast.add({ severity: 'success', summary: 'Lista desactivada' });
            this.load();
            if (this.selected()?.id === pl.id) this.selected.set(null);
          },
          error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo desactivar' }),
        });
      },
    });
  }

  confirmDeletePrice(p: ProductPrice): void {
    this.confirm.confirm({
      message: `¿Eliminar precio de "${p.product_name}" en esta lista?`,
      header: 'Confirmar',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, eliminar',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => {
        this.api.deletePrice(p.id).subscribe({
          next: () => {
            this.toast.add({ severity: 'success', summary: 'Precio eliminado' });
            const sel = this.selected();
            if (sel) this.selectPriceList(sel);
          },
          error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo eliminar' }),
        });
      },
    });
  }
}
