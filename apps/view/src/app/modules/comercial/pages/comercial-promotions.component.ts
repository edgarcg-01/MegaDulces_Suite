import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputSwitchModule } from 'primeng/inputswitch';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { TextareaModule } from 'primeng/textarea';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService, ConfirmationService } from 'primeng/api';
import {
  ComercialService,
  Promotion,
  PromotionType,
} from '../comercial.service';
import { PROMOTION_META, PROMOTION_META_LIST, summarizePromotion } from '../promotions-meta';

interface ProductOption {
  id: string;
  nombre: string;
  brand: string;
}

@Component({
  selector: 'app-comercial-promotions',
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
    InputNumberModule,
    InputSwitchModule,
    SelectModule,
    DatePickerModule,
    TextareaModule,
    ToastModule,
    ConfirmDialogModule,
    TooltipModule,
  ],
  providers: [MessageService, ConfirmationService],
  template: `
    <div class="surf-page pm">
      <p-toast></p-toast>
      <p-confirmDialog></p-confirmDialog>

      <!-- PAGE HEAD -->
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Promociones</h1>
          <p class="surf-page-sub">
            <b>{{ activeCount() }}</b> activa{{ activeCount() === 1 ? '' : 's' }}
            <span class="pm-divider" aria-hidden="true">·</span>
            {{ total() }} totales
            <span class="pm-divider" aria-hidden="true">·</span>
            6 tipos de mecánica
          </p>
        </div>
        <div class="pm-head-actions">
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
            label="Nueva promoción"
            size="small"
            severity="contrast"
            (click)="openCreate()"
          ></button>
        </div>
      </header>

      <!-- FILTERS toolbar -->
      <div class="sheet cols-12">
        <article class="cell cell-span-12 is-flush pm-filters-cell">
          <div class="pm-toolbar">
            <div class="pm-field">
              <i class="pi pi-filter pm-field-icon" aria-hidden="true"></i>
              <p-select
                [options]="typeFilterOptions"
                [(ngModel)]="typeFilter"
                (onChange)="reload()"
                optionLabel="label"
                optionValue="value"
                [showClear]="true"
                placeholder="Todos los tipos"
                styleClass="pm-type-select"
                appendTo="body"
              ></p-select>
            </div>

            <div class="pm-segment" role="group" aria-label="Estado de vigencia">
              <button
                type="button"
                class="pm-seg-btn"
                [class.active]="onlyActiveValue"
                (click)="setActive(true)"
              >Vigentes</button>
              <button
                type="button"
                class="pm-seg-btn"
                [class.active]="!onlyActiveValue"
                (click)="setActive(false)"
              >Todas</button>
            </div>

            <div class="pm-toolbar-spacer"></div>

            <button
              *ngIf="typeFilter"
              type="button"
              class="pm-reset"
              (click)="clearFilters()"
            >
              <i class="pi pi-refresh" aria-hidden="true"></i>
              <span>Reset</span>
            </button>
          </div>
        </article>
      </div>

      <!-- TABLA flush -->
      <div class="sheet cols-12">
        <article class="cell cell-span-12 is-flush">
          <p-table
            [value]="rows()"
            [loading]="loading()"
            [lazy]="true"
            [paginator]="true"
            [rows]="pageSize()"
            [totalRecords]="total()"
            [first]="(page() - 1) * pageSize()"
            (onLazyLoad)="onLazyLoad($event)"
            styleClass="p-datatable-sm"
          >
            <ng-template pTemplate="header">
              <tr>
                <th>Código</th>
                <th>Nombre</th>
                <th>Tipo</th>
                <th>Mecánica</th>
                <th>Vigencia</th>
                <th class="comm-num">Prioridad</th>
                <th>Activa</th>
                <th></th>
              </tr>
            </ng-template>
            <ng-template pTemplate="body" let-p>
              <tr>
                <td><code class="comm-code">{{ p.code }}</code></td>
                <td>
                  <div class="comm-cell-strong">{{ p.name }}</div>
                  <div class="comm-muted is-small" *ngIf="p.description">{{ p.description }}</div>
                </td>
                <td>
                  <span class="pm-type-chip">
                    <i [class]="meta(p.promotion_type).icon" aria-hidden="true"></i>
                    {{ meta(p.promotion_type).shortLabel }}
                  </span>
                </td>
                <td class="pm-mechanic">{{ summarize(p) }}</td>
                <td>
                  <div *ngIf="p.starts_at || p.ends_at; else noWindow" class="pm-window">
                    <span class="pm-window-from">{{ p.starts_at ? (p.starts_at | date:'dd MMM') : '∞' }}</span>
                    <i class="pi pi-arrow-right pm-window-sep" aria-hidden="true"></i>
                    <span class="pm-window-to">{{ p.ends_at ? (p.ends_at | date:'dd MMM') : '∞' }}</span>
                  </div>
                  <ng-template #noWindow><span class="comm-muted">Siempre</span></ng-template>
                </td>
                <td class="comm-num">{{ p.priority }}</td>
                <td>
                  <p-inputSwitch
                    [ngModel]="p.active"
                    [ngModelOptions]="{ standalone: true }"
                    (onChange)="toggleActive(p, $event.checked)"
                    [disabled]="togglingId() === p.id"
                  ></p-inputSwitch>
                </td>
                <td class="comm-actions">
                  <button pButton icon="pi pi-pencil" size="small" severity="secondary" [text]="true" (click)="openEdit(p)" pTooltip="Editar"></button>
                  <button pButton icon="pi pi-trash" size="small" severity="secondary" [text]="true" (click)="confirmDelete(p)" pTooltip="Eliminar"></button>
                </td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage">
              <tr>
                <td colspan="8" class="pm-empty-cell">
                  <div class="pm-empty">
                    <div class="pm-empty-icon"><i class="pi pi-megaphone" aria-hidden="true"></i></div>
                    <h3>Sin promociones</h3>
                    <p>{{ typeFilter ? 'No hay promociones de este tipo.' : 'Creá tu primera promoción para incentivar pedidos.' }}</p>
                    <button
                      type="button"
                      pButton
                      icon="pi pi-plus"
                      severity="contrast"
                      size="small"
                      label="Nueva promoción"
                      (click)="openCreate()"
                    ></button>
                  </div>
                </td>
              </tr>
            </ng-template>
          </p-table>
        </article>
      </div>
    </div>

    <!-- Dialog: Step 1 (type selector) + Step 2 (config) -->
    <p-dialog
      [(visible)]="dialogVisible"
      [modal]="true"
      [draggable]="false"
      [style]="{ width: '720px' }"
      [header]="dialogHeader()"
      (onHide)="onDialogHide()"
    >
      <!-- STEP 1: Type selector -->
      <ng-container *ngIf="wizardStep() === 'choose-type'">
        <p class="step-intro">Elegí el tipo de promoción que querés crear:</p>
        <div class="type-grid">
          <button
            *ngFor="let m of metaList"
            type="button"
            class="type-card"
            (click)="chooseType(m.type)"
          >
            <div class="type-icon" [style.background]="m.color">
              <i [class]="m.icon"></i>
            </div>
            <div class="type-body">
              <div class="type-title">{{ m.label }}</div>
              <div class="type-desc">{{ m.description }}</div>
              <div class="type-example"><i class="pi pi-info-circle"></i> {{ m.example }}</div>
            </div>
          </button>
        </div>
      </ng-container>

      <!-- STEP 2: Configure -->
      <ng-container *ngIf="wizardStep() === 'configure' && form">
        <div class="step-header" *ngIf="!editing()">
          <button pButton icon="pi pi-arrow-left" label="Cambiar tipo" severity="secondary" [text]="true" size="small" (click)="backToChoose()"></button>
          <span class="pm-type-chip">
            <i [class]="meta(selectedType()!).icon" aria-hidden="true"></i>
            {{ meta(selectedType()!).label }}
          </span>
        </div>

        <form [formGroup]="form" class="comm-form-grid">
          <!-- Comunes -->
          <label>
            <span>Código <em>*</em></span>
            <input pInputText formControlName="code" placeholder="ej: NAVIDAD-2026" />
          </label>
          <label>
            <span>Nombre <em>*</em></span>
            <input pInputText formControlName="name" placeholder="Ej: Descuento Navidad" />
          </label>
          <label class="full">
            <span>Descripción</span>
            <textarea pTextarea formControlName="description" rows="2" placeholder="Visible en reportes y al cliente."></textarea>
          </label>

          <!-- Type-specific fields -->
          <ng-container [ngSwitch]="selectedType()">
            <!-- percent_off_product -->
            <ng-container *ngSwitchCase="'percent_off_product'">
              <label class="full">
                <span>Producto <em>*</em></span>
                <p-select
                  formControlName="product_id"
                  [options]="productOptions()"
                  optionLabel="nombre"
                  optionValue="id"
                  [filter]="true"
                  filterBy="nombre,brand"
                  placeholder="Buscar producto…"
                  appendTo="body"
                ></p-select>
              </label>
              <label>
                <span>Descuento (%) <em>*</em></span>
                <p-inputNumber formControlName="percent" [min]="1" [max]="100" suffix=" %" />
              </label>
            </ng-container>

            <!-- percent_off_basket -->
            <ng-container *ngSwitchCase="'percent_off_basket'">
              <label>
                <span>Descuento (%) <em>*</em></span>
                <p-inputNumber formControlName="percent" [min]="1" [max]="100" suffix=" %" />
              </label>
              <label>
                <span>Mínimo de pedido (opcional)</span>
                <p-inputNumber formControlName="min_order_amount" mode="currency" currency="MXN" locale="es-MX" [min]="0" placeholder="Sin mínimo" />
              </label>
            </ng-container>

            <!-- nxm -->
            <ng-container *ngSwitchCase="'nxm'">
              <label class="full">
                <span>Producto <em>*</em></span>
                <p-select formControlName="product_id" [options]="productOptions()" optionLabel="nombre" optionValue="id" [filter]="true" filterBy="nombre,brand" placeholder="Buscar producto…" appendTo="body"></p-select>
              </label>
              <label>
                <span>Compra (N) <em>*</em></span>
                <p-inputNumber formControlName="n_buy" [min]="2" [showButtons]="true" />
              </label>
              <label>
                <span>Paga (M) <em>*</em></span>
                <p-inputNumber formControlName="m_pay" [min]="1" [showButtons]="true" />
              </label>
              <div class="comm-form-hint full" *ngIf="form.value.n_buy && form.value.m_pay">
                <i class="pi pi-info-circle"></i>
                Cliente lleva <b>{{ form.value.n_buy }}</b> unidades, paga sólo <b>{{ form.value.m_pay }}</b>.
                Ahorro = {{ form.value.n_buy - form.value.m_pay }} unidad(es) gratis.
              </div>
            </ng-container>

            <!-- volume_discount -->
            <ng-container *ngSwitchCase="'volume_discount'">
              <label class="full">
                <span>Producto <em>*</em></span>
                <p-select formControlName="product_id" [options]="productOptions()" optionLabel="nombre" optionValue="id" [filter]="true" filterBy="nombre,brand" placeholder="Buscar producto…" appendTo="body"></p-select>
              </label>
              <div class="tiers-section full">
                <div class="tiers-header">
                  <span>Tiers de descuento <em>*</em></span>
                  <button pButton type="button" icon="pi pi-plus" label="Agregar tier" size="small" severity="secondary" (click)="addTier()"></button>
                </div>
                <div class="tiers-list">
                  <div *ngFor="let t of tiersValue; let i = index" class="tier-row">
                    <span class="tier-from">Desde</span>
                    <p-inputNumber [(ngModel)]="t.min_qty" [ngModelOptions]="{ standalone: true }" [min]="1" suffix=" und" />
                    <span class="tier-arrow">→</span>
                    <p-inputNumber [(ngModel)]="t.percent" [ngModelOptions]="{ standalone: true }" [min]="1" [max]="100" suffix=" %" />
                    <button pButton type="button" icon="pi pi-trash" size="small" severity="secondary" [text]="true" (click)="removeTier(i)"></button>
                  </div>
                  <div *ngIf="tiersValue.length === 0" class="muted">Sin tiers. Agregá al menos uno.</div>
                </div>
              </div>
            </ng-container>

            <!-- bundle_fixed_price -->
            <ng-container *ngSwitchCase="'bundle_fixed_price'">
              <div class="tiers-section full">
                <div class="tiers-header">
                  <span>Productos del pack <em>*</em></span>
                  <button pButton type="button" icon="pi pi-plus" label="Agregar producto" size="small" severity="secondary" (click)="addBundleItem()"></button>
                </div>
                <div class="tiers-list">
                  <div *ngFor="let it of bundleValue; let i = index" class="bundle-row">
                    <p-select
                      [(ngModel)]="it.product_id"
                      [ngModelOptions]="{ standalone: true }"
                      [options]="productOptions()"
                      optionLabel="nombre"
                      optionValue="id"
                      [filter]="true"
                      filterBy="nombre,brand"
                      placeholder="Producto…"
                      appendTo="body"
                      styleClass="bundle-product"
                    ></p-select>
                    <span>×</span>
                    <p-inputNumber [(ngModel)]="it.quantity" [ngModelOptions]="{ standalone: true }" [min]="1" suffix=" und" />
                    <button pButton type="button" icon="pi pi-trash" size="small" severity="secondary" [text]="true" (click)="removeBundleItem(i)"></button>
                  </div>
                  <div *ngIf="bundleValue.length === 0" class="muted">Agregá al menos 2 productos.</div>
                </div>
              </div>
              <label class="full">
                <span>Precio fijo del pack <em>*</em></span>
                <p-inputNumber formControlName="price" mode="currency" currency="MXN" locale="es-MX" [min]="1" />
              </label>
            </ng-container>

            <!-- cross_sell_discount -->
            <ng-container *ngSwitchCase="'cross_sell_discount'">
              <label class="full">
                <span>Si compra (trigger) <em>*</em></span>
                <p-select formControlName="trigger_product_id" [options]="productOptions()" optionLabel="nombre" optionValue="id" [filter]="true" filterBy="nombre,brand" placeholder="Producto que dispara…" appendTo="body"></p-select>
              </label>
              <label class="full">
                <span>Descuento en (target) <em>*</em></span>
                <p-select formControlName="target_product_id" [options]="productOptions()" optionLabel="nombre" optionValue="id" [filter]="true" filterBy="nombre,brand" placeholder="Producto descontado…" appendTo="body"></p-select>
              </label>
              <label>
                <span>Descuento (%) <em>*</em></span>
                <p-inputNumber formControlName="percent" [min]="1" [max]="100" suffix=" %" />
              </label>
            </ng-container>
          </ng-container>

          <!-- Comunes: vigencia y configuración -->
          <div class="full divider"><span>Vigencia y configuración</span></div>
          <label>
            <span>Desde</span>
            <p-datepicker formControlName="starts_at" [showIcon]="true" placeholder="Sin fecha — desde siempre" appendTo="body"></p-datepicker>
          </label>
          <label>
            <span>Hasta</span>
            <p-datepicker formControlName="ends_at" [showIcon]="true" placeholder="Sin fecha — sin fin" appendTo="body"></p-datepicker>
          </label>
          <label>
            <span>Prioridad</span>
            <p-inputNumber formControlName="priority" [min]="0" [max]="1000" [showButtons]="true" />
          </label>
          <label>
            <span>Tope global de usos</span>
            <p-inputNumber formControlName="usage_limit" [min]="1" placeholder="Ilimitado" />
          </label>
          <label class="checkbox-line full">
            <p-inputSwitch formControlName="active" />
            <span>Activa al guardar</span>
          </label>
        </form>
      </ng-container>

      <ng-template pTemplate="footer">
        <ng-container *ngIf="wizardStep() === 'configure'">
          <button pButton label="Cancelar" severity="secondary" [outlined]="true" (click)="closeDialog()"></button>
          <button
            pButton
            [label]="editing() ? 'Guardar' : 'Crear promoción'"
            icon="pi pi-check"
            [loading]="saving()"
            [disabled]="!canSave()"
            (click)="save()"
          ></button>
        </ng-container>
        <ng-container *ngIf="wizardStep() === 'choose-type'">
          <button pButton label="Cancelar" severity="secondary" [outlined]="true" (click)="closeDialog()"></button>
        </ng-container>
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    :host { display:block; }

    .pm-head-actions { display:flex; gap:.5rem; align-items:center; }
    .pm-divider { opacity: 0.4; }
    .surf-page-sub b { font-weight: var(--fw-bold); color: var(--c-text-1); }

    /* ── TOOLBAR ── */
    .pm-filters-cell { display: flex; flex-direction: column; }
    .pm-toolbar {
      display: flex;
      align-items: center;
      gap: .5rem;
      padding: .625rem .875rem;
      flex-wrap: wrap;
    }
    .pm-toolbar-spacer { flex: 1; min-width: 0; }

    .pm-field {
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
    .pm-field:focus-within {
      border-color: var(--c-text-1);
      box-shadow: 0 0 0 3px var(--c-focus-ring, rgba(0, 0, 0, 0.08));
    }
    .pm-field-icon { color: var(--c-text-3); font-size: var(--fs-sm); flex-shrink: 0; }
    :host ::ng-deep .pm-type-select.p-select {
      flex: 1;
      border: none !important;
      background: transparent !important;
      box-shadow: none !important;
    }
    :host ::ng-deep .pm-type-select.p-select .p-select-label {
      padding: 0 !important;
      height: 28px !important;
      font-size: var(--fs-sm) !important;
      color: var(--c-text-1) !important;
      display: flex;
      align-items: center;
    }

    .pm-segment {
      display: inline-flex;
      align-items: stretch;
      height: 32px;
      background: var(--c-surface-2);
      border: 1px solid var(--c-divider);
      border-radius: 8px;
      padding: 2px;
      gap: 2px;
    }
    .pm-seg-btn {
      background: transparent;
      border: none;
      padding: 0 .75rem;
      font-size: var(--fs-xs);
      font-weight: var(--fw-medium);
      color: var(--c-text-2);
      cursor: pointer;
      border-radius: 6px;
      transition: all 100ms var(--ease-standard);
      white-space: nowrap;
    }
    .pm-seg-btn:hover { color: var(--c-text-1); }
    .pm-seg-btn.active {
      background: var(--c-surface-1);
      color: var(--c-text-1);
      box-shadow: 0 1px 2px rgba(0,0,0,.08);
      font-weight: var(--fw-bold);
    }

    .pm-reset {
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
    .pm-reset:hover {
      color: var(--c-text-1);
      border-color: var(--c-text-1);
      background: var(--c-surface-2);
    }

    /* ── TABLA: type chip monocromo + window inline + mechanic ── */
    .pm-type-chip {
      display: inline-flex;
      align-items: center;
      gap: .35rem;
      padding: .2rem .55rem;
      border-radius: 6px;
      background: var(--c-surface-2);
      color: var(--c-text-1);
      font-size: var(--fs-xs);
      font-weight: var(--fw-medium);
      white-space: nowrap;
      border: 1px solid var(--c-divider);
    }
    .pm-type-chip i {
      color: var(--c-text-2);
      font-size: var(--fs-xs);
    }
    .pm-mechanic {
      font-size: var(--fs-sm);
      color: var(--c-text-1);
    }
    .pm-window {
      display: inline-flex;
      align-items: center;
      gap: .3rem;
      font-size: var(--fs-xs);
      color: var(--c-text-1);
      font-variant-numeric: tabular-nums;
    }
    .pm-window-sep { color: var(--c-text-3); font-size: var(--fs-nano); }

    /* ── EMPTY STATE ── */
    .pm-empty-cell { padding: 0 !important; }
    .pm-empty {
      text-align: center;
      padding: 3rem 1.5rem;
      max-width: 420px;
      margin: 0 auto;
    }
    .pm-empty-icon {
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
    .pm-empty h3 {
      margin: 0 0 .375rem;
      font-size: var(--fs-h3);
      font-weight: var(--fw-bold);
      color: var(--c-text-1);
    }
    .pm-empty p {
      margin: 0 0 1rem;
      color: var(--c-text-2);
      font-size: var(--fs-sm);
      line-height: 1.4;
    }

    /* ── DIALOG: wizard step 1 (type selector cards) ── */
    .step-intro {
      margin: 0 0 1rem;
      color: var(--c-text-2);
      font-size: var(--fs-sm);
    }
    .type-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: .625rem;
    }
    .type-card {
      display: flex;
      gap: .75rem;
      padding: .875rem;
      border: 1px solid var(--c-divider);
      border-radius: 10px;
      background: var(--c-surface-1);
      color: var(--c-text-1);
      cursor: pointer;
      text-align: left;
      transition: border-color 120ms var(--ease-standard), box-shadow 200ms var(--ease-standard);
      font-family: inherit;
    }
    .type-card:hover {
      border-color: var(--c-text-1);
      box-shadow: 0 4px 12px rgba(0,0,0,.06);
    }
    .type-card:active { transform: scale(.99); }
    .type-icon {
      width: 40px;
      height: 40px;
      border-radius: 8px;
      display: grid;
      place-items: center;
      color: #fff;
      flex-shrink: 0;
    }
    .type-icon i { font-size: 1.15rem; }
    .type-body { flex: 1; min-width: 0; }
    .type-title {
      font-weight: var(--fw-bold);
      font-size: var(--fs-sm);
      margin-bottom: .2rem;
      color: var(--c-text-1);
    }
    .type-desc {
      font-size: var(--fs-xs);
      color: var(--c-text-2);
      margin-bottom: .3rem;
      line-height: 1.35;
    }
    .type-example {
      font-size: var(--fs-micro);
      color: var(--c-text-3);
      font-style: italic;
    }
    .type-example i { margin-right: .25rem; }

    /* ── DIALOG: wizard step 2 (config form) ── */
    .step-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
      padding-bottom: .75rem;
      border-bottom: 1px solid var(--c-divider);
    }
    .divider {
      grid-column: span 2;
      display: flex;
      align-items: center;
      gap: .75rem;
      margin: .5rem 0 .25rem;
      color: var(--c-text-2);
      font-size: var(--fs-micro);
      text-transform: uppercase;
      letter-spacing: .08em;
      font-weight: var(--fw-bold);
    }
    .divider::after {
      content: '';
      flex: 1;
      height: 1px;
      background: var(--c-divider);
    }
    .tiers-section {
      display: flex;
      flex-direction: column;
      gap: .5rem;
    }
    .tiers-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .tiers-header span {
      font-size: var(--fs-micro);
      color: var(--c-text-2);
      text-transform: uppercase;
      letter-spacing: .06em;
      font-weight: var(--fw-bold);
    }
    .tiers-list {
      display: flex;
      flex-direction: column;
      gap: .5rem;
      padding: .625rem;
      background: var(--c-surface-2);
      border: 1px solid var(--c-divider);
      border-radius: 8px;
    }
    .tier-row, .bundle-row {
      display: flex;
      align-items: center;
      gap: .5rem;
    }
    .tier-row .tier-from {
      font-size: var(--fs-xs);
      color: var(--c-text-2);
      min-width: 50px;
    }
    .tier-row .tier-arrow { color: var(--c-text-3); }
    :host ::ng-deep .p-select.bundle-product { flex: 1; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComercialPromotionsComponent {
  private readonly api = inject(ComercialService);
  private readonly fb = inject(FormBuilder);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);

  readonly rows = signal<Promotion[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly pageSize = signal(20);
  readonly loading = signal(false);
  readonly togglingId = signal<string | null>(null);

  typeFilter: PromotionType | null = null;
  onlyActiveValue = false;

  readonly typeFilterOptions = PROMOTION_META_LIST.map((m) => ({ value: m.type, label: m.label }));
  readonly metaList = PROMOTION_META_LIST;

  // Catálogo de productos para selects (id, nombre, brand)
  readonly products = signal<ProductOption[]>([]);
  readonly productsById = new Map<string, ProductOption>();

  // Dialog state
  dialogVisible = false;
  readonly wizardStep = signal<'choose-type' | 'configure'>('choose-type');
  readonly selectedType = signal<PromotionType | null>(null);
  readonly editing = signal<Promotion | null>(null);
  readonly saving = signal(false);

  // Tiers para volume_discount (manejados fuera del form porque son array dinámico).
  tiersValue: Array<{ min_qty: number; percent: number }> = [];
  // Items para bundle_fixed_price.
  bundleValue: Array<{ product_id: string | null; quantity: number }> = [];

  form: FormGroup | null = null;

  readonly activeCount = computed(() => this.rows().filter((p) => p.active).length);

  readonly productOptions = computed(() => this.products());

  readonly dialogHeader = computed(() => {
    if (this.editing()) return `Editar: ${this.editing()!.name}`;
    if (this.wizardStep() === 'choose-type') return 'Nueva promoción · Elegí el tipo';
    const t = this.selectedType();
    return t ? `Nueva promoción · ${PROMOTION_META[t].label}` : 'Nueva promoción';
  });

  constructor() {
    this.loadProducts();
    this.load();
  }

  // ── Data load ────────────────────────────────────────────────────

  private loadProducts(): void {
    this.api.listProductCatalog().subscribe({
      next: (brands) => {
        const flat: ProductOption[] = [];
        for (const b of brands) {
          for (const p of b.productos || []) {
            if (p.activo !== false) flat.push({ id: p.id, nombre: p.nombre, brand: b.nombre });
          }
        }
        flat.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
        this.products.set(flat);
        this.productsById.clear();
        for (const p of flat) this.productsById.set(p.id, p);
      },
      error: () => this.products.set([]),
    });
  }

  load(): void {
    this.loading.set(true);
    this.api
      .listPromotions({
        page: this.page(),
        pageSize: this.pageSize(),
        promotion_type: this.typeFilter || undefined,
        onlyActive: this.onlyActiveValue || undefined,
      })
      .subscribe({
        next: (r) => {
          this.rows.set(r.data || []);
          this.total.set(r.pagination?.total || 0);
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
          this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar promociones' });
        },
      });
  }

  reload(): void {
    this.page.set(1);
    this.load();
  }

  setActive(active: boolean): void {
    if (this.onlyActiveValue === active) return;
    this.onlyActiveValue = active;
    this.reload();
  }

  clearFilters(): void {
    this.typeFilter = null;
    this.reload();
  }

  onLazyLoad(e: { first?: number | null; rows?: number | null }): void {
    const first = e.first ?? 0;
    const rows = e.rows ?? this.pageSize();
    this.page.set(Math.floor(first / rows) + 1);
    this.pageSize.set(rows);
    this.load();
  }

  // ── Helpers visuales ─────────────────────────────────────────────

  meta(type: PromotionType) {
    return PROMOTION_META[type];
  }

  summarize(p: Promotion): string {
    return summarizePromotion(p.promotion_type, p.rules, (id) => this.productName(id));
  }

  productName(id: string): string {
    return this.productsById.get(id)?.nombre || '(producto)';
  }

  // ── Dialog: open / close / steps ─────────────────────────────────

  openCreate(): void {
    this.editing.set(null);
    this.selectedType.set(null);
    this.wizardStep.set('choose-type');
    this.dialogVisible = true;
  }

  openEdit(p: Promotion): void {
    this.editing.set(p);
    this.selectedType.set(p.promotion_type);
    this.wizardStep.set('configure');
    this.buildForm(p.promotion_type, p);
    this.dialogVisible = true;
  }

  chooseType(t: PromotionType): void {
    this.selectedType.set(t);
    this.buildForm(t);
    this.wizardStep.set('configure');
  }

  backToChoose(): void {
    this.wizardStep.set('choose-type');
    this.selectedType.set(null);
    this.form = null;
  }

  closeDialog(): void {
    this.dialogVisible = false;
  }

  onDialogHide(): void {
    this.editing.set(null);
    this.selectedType.set(null);
    this.form = null;
    this.tiersValue = [];
    this.bundleValue = [];
  }

  // ── Form construction (dinámico por tipo) ────────────────────────

  private buildForm(type: PromotionType, p?: Promotion): void {
    const rules = (p?.rules || {}) as any;
    const common: Record<string, any> = {
      code: [{ value: p?.code ?? '', disabled: !!p }, [Validators.required, Validators.pattern(/^[A-Z0-9_-]{2,50}$/)]],
      name: [p?.name ?? '', Validators.required],
      description: [p?.description ?? ''],
      starts_at: [p?.starts_at ? new Date(p.starts_at) : null],
      ends_at: [p?.ends_at ? new Date(p.ends_at) : null],
      priority: [p?.priority ?? 100, [Validators.min(0), Validators.max(1000)]],
      usage_limit: [p?.usage_limit ?? null],
      active: [p?.active ?? true],
    };

    let typeFields: Record<string, any> = {};
    this.tiersValue = [];
    this.bundleValue = [];

    switch (type) {
      case 'percent_off_product':
        typeFields = {
          product_id: [rules.product_id ?? null, Validators.required],
          percent: [this.fracToPctInput(rules.percent), [Validators.required, Validators.min(1), Validators.max(100)]],
        };
        break;
      case 'percent_off_basket':
        typeFields = {
          percent: [this.fracToPctInput(rules.percent), [Validators.required, Validators.min(1), Validators.max(100)]],
          min_order_amount: [rules.min_order_amount ?? null],
        };
        break;
      case 'nxm':
        typeFields = {
          product_id: [rules.product_id ?? null, Validators.required],
          n_buy: [rules.n_buy ?? 2, [Validators.required, Validators.min(2)]],
          m_pay: [rules.m_pay ?? 1, [Validators.required, Validators.min(1)]],
        };
        break;
      case 'volume_discount':
        typeFields = {
          product_id: [rules.product_id ?? null, Validators.required],
        };
        this.tiersValue = (rules.tiers || []).map((t: any) => ({ min_qty: t.min_qty, percent: this.fracToPctInput(t.percent, 5) }));
        if (this.tiersValue.length === 0) this.tiersValue.push({ min_qty: 10, percent: 5 });
        break;
      case 'bundle_fixed_price':
        typeFields = {
          price: [rules.price ?? 100, [Validators.required, Validators.min(1)]],
        };
        this.bundleValue = (rules.items || []).map((i: any) => ({ product_id: i.product_id, quantity: i.quantity }));
        if (this.bundleValue.length === 0) {
          this.bundleValue.push({ product_id: null, quantity: 1 });
          this.bundleValue.push({ product_id: null, quantity: 1 });
        }
        break;
      case 'cross_sell_discount':
        typeFields = {
          trigger_product_id: [rules.trigger_product_id ?? null, Validators.required],
          target_product_id: [rules.target_product_id ?? null, Validators.required],
          percent: [this.fracToPctInput(rules.percent), [Validators.required, Validators.min(1), Validators.max(100)]],
        };
        break;
    }

    this.form = this.fb.group({ ...common, ...typeFields });
  }

  // ── Tiers + bundle item managers ─────────────────────────────────

  addTier(): void {
    const last = this.tiersValue[this.tiersValue.length - 1];
    const nextMin = last ? Math.max(last.min_qty + 10, last.min_qty * 2) : 10;
    const nextPercent = last ? Math.min(last.percent + 5, 100) : 5;
    this.tiersValue = [...this.tiersValue, { min_qty: nextMin, percent: nextPercent }];
  }

  removeTier(i: number): void {
    this.tiersValue = this.tiersValue.filter((_, idx) => idx !== i);
  }

  addBundleItem(): void {
    this.bundleValue = [...this.bundleValue, { product_id: null, quantity: 1 }];
  }

  removeBundleItem(i: number): void {
    this.bundleValue = this.bundleValue.filter((_, idx) => idx !== i);
  }

  // ── Save ─────────────────────────────────────────────────────────

  canSave(): boolean {
    if (!this.form || this.form.invalid) return false;
    const t = this.selectedType();
    if (t === 'volume_discount' && this.tiersValue.length === 0) return false;
    if (t === 'bundle_fixed_price') {
      if (this.bundleValue.length < 2) return false;
      if (this.bundleValue.some((i) => !i.product_id || i.quantity < 1)) return false;
    }
    return true;
  }

  save(): void {
    if (!this.canSave()) return;
    const t = this.selectedType()!;
    const raw = this.form!.getRawValue();

    const rules = this.buildRulesFromForm(t, raw);

    const payload: any = {
      code: raw.code,
      name: raw.name,
      description: raw.description || undefined,
      promotion_type: t,
      rules,
      priority: raw.priority,
      starts_at: raw.starts_at ? new Date(raw.starts_at).toISOString() : null,
      ends_at: raw.ends_at ? new Date(raw.ends_at).toISOString() : null,
      usage_limit: raw.usage_limit ?? null,
      min_order_amount: t === 'percent_off_basket' ? (raw.min_order_amount ?? null) : null,
      active: raw.active,
    };

    this.saving.set(true);
    const editing = this.editing();
    const obs = editing
      ? this.api.updatePromotion(editing.id, payload)
      : this.api.createPromotion(payload);
    obs.subscribe({
      next: () => {
        this.saving.set(false);
        this.dialogVisible = false;
        this.toast.add({
          severity: 'success',
          summary: editing ? 'Promoción actualizada' : 'Promoción creada',
        });
        this.load();
      },
      error: (err) => {
        this.saving.set(false);
        const detail = err?.error?.message || 'No se pudo guardar la promoción';
        this.toast.add({ severity: 'error', summary: 'Error', detail });
      },
    });
  }

  // El engine guarda/aplica `percent` como FRACCIÓN [0..1] (0.15 = 15%, ver
  // commercial-orders.service: `Math.min(1, percent)`). La UI trabaja en 1-100.
  // Convertimos en el borde: fracción→input al cargar, input→fracción al guardar.
  // Sin esto, una promo creada por la UI guardaba 15 → el engine la clampaba a
  // 1 = 100% de descuento (bug de plata), y editar una existente mostraba 0.15.
  private fracToPctInput(f: any, def = 10): number {
    return f == null ? def : +(Number(f) * 100).toFixed(2);
  }
  private pctInputToFrac(v: any): number {
    return +(Number(v) / 100).toFixed(4);
  }

  private buildRulesFromForm(type: PromotionType, raw: any): any {
    switch (type) {
      case 'percent_off_product':
        return { product_id: raw.product_id, percent: this.pctInputToFrac(raw.percent) };
      case 'percent_off_basket':
        return { percent: this.pctInputToFrac(raw.percent) };
      case 'nxm':
        return { product_id: raw.product_id, n_buy: raw.n_buy, m_pay: raw.m_pay };
      case 'volume_discount':
        return {
          product_id: raw.product_id,
          tiers: [...this.tiersValue]
            .sort((a, b) => a.min_qty - b.min_qty)
            .map((t) => ({ min_qty: t.min_qty, percent: this.pctInputToFrac(t.percent) })),
        };
      case 'bundle_fixed_price':
        return {
          items: this.bundleValue.map((i) => ({ product_id: i.product_id, quantity: i.quantity })),
          price: raw.price,
        };
      case 'cross_sell_discount':
        return {
          trigger_product_id: raw.trigger_product_id,
          target_product_id: raw.target_product_id,
          percent: this.pctInputToFrac(raw.percent),
        };
    }
  }

  // ── Inline actions ───────────────────────────────────────────────

  toggleActive(p: Promotion, active: boolean): void {
    this.togglingId.set(p.id);
    this.api.setPromotionActive(p.id, active).subscribe({
      next: () => {
        this.togglingId.set(null);
        const next = this.rows().map((r) => (r.id === p.id ? { ...r, active } : r));
        this.rows.set(next);
        this.toast.add({
          severity: 'success',
          summary: active ? 'Promoción activada' : 'Promoción pausada',
          detail: p.name,
          life: 2000,
        });
      },
      error: () => {
        this.togglingId.set(null);
        this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cambiar el estado' });
      },
    });
  }

  confirmDelete(p: Promotion): void {
    this.confirm.confirm({
      message: `¿Eliminar la promoción "${p.name}"? Es un soft-delete: queda inactiva pero el historial se conserva.`,
      header: 'Confirmar eliminación',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, eliminar',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => {
        this.api.deletePromotion(p.id).subscribe({
          next: () => {
            this.toast.add({ severity: 'success', summary: 'Promoción eliminada' });
            this.load();
          },
          error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo eliminar' }),
        });
      },
    });
  }
}
