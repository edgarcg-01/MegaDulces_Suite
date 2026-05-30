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
import { TooltipModule } from 'primeng/tooltip';
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
    TooltipModule,
    ConfirmDialogModule,
  ],
  providers: [MessageService, ConfirmationService],
  template: `
    <div class="surf-page pr">
      <p-toast></p-toast>
      <p-confirmDialog></p-confirmDialog>

      <!-- PAGE HEAD -->
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Listas de precios</h1>
          <p class="surf-page-sub">
            <b>{{ rows().length }}</b> lista{{ rows().length === 1 ? '' : 's' }}
            <span class="pr-divider" aria-hidden="true">·</span>
            asignables a clientes para portal/vendor
          </p>
        </div>
        <div class="pr-head-actions">
          <button
            pButton
            icon="pi pi-refresh"
            [text]="true"
            severity="secondary"
            size="small"
            (click)="load()"
            [loading]="loading()"
            pTooltip="Refrescar"
          ></button>
          <button
            pButton
            icon="pi pi-plus"
            label="Nueva lista"
            size="small"
            (click)="openCreate()"
          ></button>
        </div>
      </header>

      <!-- MASTER: tabla de listas, flush -->
      <div class="sheet cols-12">
        <article class="cell cell-span-12 is-flush">
          <p-table [value]="rows()" [loading]="loading()" responsiveLayout="scroll" styleClass="p-datatable-sm pr-master">
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
              <tr [class.pr-selected]="selected()?.id === pl.id" (click)="selectPriceList(pl)" class="comm-row-clickable">
                <td><code class="comm-code">{{ pl.code }}</code></td>
                <td class="comm-cell-strong">{{ pl.name }}</td>
                <td>{{ pl.currency || 'MXN' }}</td>
                <td>
                  <span *ngIf="pl.is_default" class="comm-pill is-default">Default</span>
                  <span *ngIf="!pl.is_default" class="comm-muted">—</span>
                </td>
                <td>
                  <span *ngIf="pl.active !== false" class="comm-pill is-active">Activa</span>
                  <span *ngIf="pl.active === false" class="comm-pill is-inactive">Inactiva</span>
                </td>
                <td class="comm-actions">
                  <button pButton icon="pi pi-pencil" size="small" severity="secondary" [text]="true"
                          (click)="$event.stopPropagation(); openEdit(pl)" pTooltip="Editar"></button>
                  <button pButton icon="pi pi-trash" size="small" severity="danger" [text]="true"
                          (click)="$event.stopPropagation(); confirmDelete(pl)"
                          *ngIf="pl.active !== false" pTooltip="Desactivar"></button>
                </td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage">
              <tr>
                <td colspan="6" class="pr-empty-cell">
                  <div class="pr-empty">
                    <div class="pr-empty-icon"><i class="pi pi-tag" aria-hidden="true"></i></div>
                    <h3>Sin listas de precios</h3>
                    <p>Creá una lista y asignala a clientes para personalizar precios por cuenta.</p>
                    <button
                      type="button"
                      pButton
                      icon="pi pi-plus"
                      severity="primary"
                      size="small"
                      label="Nueva lista"
                      (click)="openCreate()"
                    ></button>
                  </div>
                </td>
              </tr>
            </ng-template>
          </p-table>
        </article>
      </div>

      <!-- DETAIL: precios de la lista seleccionada -->
      <div *ngIf="selected() as sel" class="sheet cols-12 pr-detail">
        <article class="cell cell-span-12 is-flush">
          <header class="pr-detail-head">
            <div class="pr-detail-head-text">
              <span class="cell-label">Precios de la lista</span>
              <h3 class="pr-detail-title">{{ sel.name }}</h3>
              <span class="comm-muted is-small">{{ prices().length }} producto{{ prices().length === 1 ? '' : 's' }} · {{ sel.currency || 'MXN' }}</span>
            </div>
            <button
              pButton
              icon="pi pi-times"
              [text]="true"
              severity="secondary"
              size="small"
              (click)="selected.set(null)"
              pTooltip="Cerrar detalle"
            ></button>
          </header>
          <p-table [value]="prices()" [loading]="loadingPrices()" responsiveLayout="scroll" styleClass="p-datatable-sm">
            <ng-template pTemplate="header">
              <tr>
                <th>Producto</th>
                <th class="comm-num">Precio</th>
                <th class="comm-num">Min qty</th>
                <th></th>
              </tr>
            </ng-template>
            <ng-template pTemplate="body" let-p>
              <tr>
                <td>
                  <div class="comm-cell-strong">{{ p.product_name || p.product_id }}</div>
                  <div class="comm-muted is-small" *ngIf="p.brand_name">{{ p.brand_name }}</div>
                </td>
                <td class="comm-num is-strong">{{ p.price | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td class="comm-num">{{ p.min_quantity || 1 }}</td>
                <td class="comm-actions">
                  <button pButton icon="pi pi-trash" size="small" severity="danger" [text]="true"
                          (click)="confirmDeletePrice(p)" pTooltip="Eliminar"></button>
                </td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage">
              <tr>
                <td colspan="4" class="pr-empty-cell">
                  <div class="pr-empty">
                    <div class="pr-empty-icon"><i class="pi pi-box" aria-hidden="true"></i></div>
                    <h3>Lista vacía</h3>
                    <p>Cargá precios via importer CLI:</p>
                    <code class="comm-code pr-empty-cmd">database/importers/commercial_import.js --type=prices</code>
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
      [style]="{ width: '440px' }"
      [header]="editing() ? 'Editar lista de precios' : 'Nueva lista de precios'"
    >
      <form [formGroup]="form" class="comm-form" *ngIf="form">
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

    .pr-head-actions { display:flex; gap:.5rem; align-items:center; }
    .pr-divider { opacity: 0.4; }
    .surf-page-sub b { font-weight: var(--fw-bold); color: var(--c-text-1); }

    /* ── Master table: selected row con stripe brand ── */
    tr.pr-selected {
      background: var(--c-surface-2);
      box-shadow: inset 3px 0 0 var(--c-accent);
    }
    tr.pr-selected td:first-child { padding-left: calc(.75rem + 3px); }

    /* ── DETAIL head: título de la lista seleccionada ── */
    .pr-detail-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 1rem;
      padding: 1rem 1.25rem;
      border-bottom: 1px solid var(--c-divider);
      background: var(--c-surface-2);
    }
    .pr-detail-head-text {
      display: flex;
      flex-direction: column;
      gap: .25rem;
      min-width: 0;
    }
    .pr-detail-title {
      margin: 0;
      font-size: var(--fs-h3);
      font-weight: var(--fw-bold);
      color: var(--c-text-1);
      letter-spacing: -0.01em;
    }

    /* ── EMPTY STATE inline ── */
    .pr-empty-cell { padding: 0 !important; }
    .pr-empty {
      text-align: center;
      padding: 3rem 1.5rem;
      max-width: 480px;
      margin: 0 auto;
    }
    .pr-empty-icon {
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
    .pr-empty h3 {
      margin: 0 0 .375rem;
      font-size: var(--fs-h3);
      font-weight: var(--fw-bold);
      color: var(--c-text-1);
    }
    .pr-empty p {
      margin: 0 0 1rem;
      color: var(--c-text-2);
      font-size: var(--fs-sm);
      line-height: 1.4;
    }
    .pr-empty-cmd {
      display: inline-block;
      padding: .4rem .75rem;
      font-size: var(--fs-xs);
    }
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
