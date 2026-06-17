import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormGroup, FormsModule, ReactiveFormsModule } from '@angular/forms';
import { DialogModule } from 'primeng/dialog';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputSwitchModule } from 'primeng/inputswitch';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { TextareaModule } from 'primeng/textarea';
import { Promotion, PromotionType } from '../comercial.service';
import { PROMOTION_META, PromotionMeta } from '../promotions-meta';

interface ProductOption {
  id: string;
  nombre: string;
  brand: string;
}

interface Tier {
  min_qty: number;
  percent: number;
}
interface BundleItem {
  product_id: string | null;
  quantity: number;
}

/**
 * Diálogo (wizard 2 pasos) de alta/edición de promoción — selector de tipo +
 * form dinámico por los 6 tipos. Presentacional: el padre es dueño del FormGroup,
 * de los arrays tiers/bundle (los reasigna en add/remove) y de toda la lógica
 * (save/canSave/buildForm). Extraído de comercial-promotions (CV.3).
 *
 * CD por defecto (NO OnPush): los `[(ngModel)]` de tiers/bundle mutan los objetos
 * del array recibido por input (misma referencia que el padre), así el padre los
 * lee al guardar sin sincronización extra. Los estilos del diálogo viven aquí
 * porque la encapsulación impide que los del padre alcancen este DOM.
 */
@Component({
  selector: 'app-promotion-form-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ReactiveFormsModule,
    DialogModule,
    ButtonModule,
    InputTextModule,
    InputNumberModule,
    InputSwitchModule,
    SelectModule,
    DatePickerModule,
    TextareaModule,
  ],
  template: `
    <p-dialog
      [visible]="visible"
      (visibleChange)="visibleChange.emit($event)"
      [modal]="true"
      [draggable]="false"
      [style]="{ width: '720px' }"
      [header]="header"
      (onHide)="hide.emit()"
    >
      <!-- STEP 1: Type selector -->
      <ng-container *ngIf="wizardStep === 'choose-type'">
        <p class="step-intro">Elegí el tipo de promoción que querés crear:</p>
        <div class="type-grid">
          <button
            *ngFor="let m of metaList"
            type="button"
            class="type-card"
            (click)="chooseType.emit(m.type)"
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
      <ng-container *ngIf="wizardStep === 'configure' && form">
        <div class="step-header" *ngIf="!editing">
          <button pButton icon="pi pi-arrow-left" label="Cambiar tipo" severity="secondary" [text]="true" size="small" (click)="backToChoose.emit()"></button>
          <span class="pm-type-chip">
            <i [class]="meta(selectedType!).icon" aria-hidden="true"></i>
            {{ meta(selectedType!).label }}
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
          <label class="full">
            <span>Banner (URL de imagen)</span>
            <input pInputText formControlName="banner_url" placeholder="https://res.cloudinary.com/.../banner.png" />
            <small class="comm-muted is-small">Opcional. Se muestra como portada en el portal (home + promociones). Subí la imagen a Cloudinary y pegá la URL.</small>
          </label>
          <div class="full" *ngIf="form.value.banner_url">
            <img
              [src]="form.value.banner_url"
              alt="Vista previa del banner"
              class="promo-banner-preview"
              (error)="bannerError.emit(true)"
              (load)="bannerError.emit(false)"
            />
            <small class="comm-muted is-small" *ngIf="bannerPreviewError">
              No se pudo cargar la imagen. Verificá la URL.
            </small>
          </div>

          <!-- Type-specific fields -->
          <ng-container [ngSwitch]="selectedType">
            <!-- percent_off_product -->
            <ng-container *ngSwitchCase="'percent_off_product'">
              <label class="full">
                <span>Producto <em>*</em></span>
                <p-select
                  formControlName="product_id"
                  [options]="productOptions"
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
                <p-select formControlName="product_id" [options]="productOptions" optionLabel="nombre" optionValue="id" [filter]="true" filterBy="nombre,brand" placeholder="Buscar producto…" appendTo="body"></p-select>
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
                <p-select formControlName="product_id" [options]="productOptions" optionLabel="nombre" optionValue="id" [filter]="true" filterBy="nombre,brand" placeholder="Buscar producto…" appendTo="body"></p-select>
              </label>
              <div class="tiers-section full">
                <div class="tiers-header">
                  <span>Tiers de descuento <em>*</em></span>
                  <button pButton type="button" icon="pi pi-plus" label="Agregar tier" size="small" severity="secondary" (click)="addTier.emit()"></button>
                </div>
                <div class="tiers-list">
                  <div *ngFor="let t of tiers; let i = index" class="tier-row">
                    <span class="tier-from">Desde</span>
                    <p-inputNumber [(ngModel)]="t.min_qty" [ngModelOptions]="{ standalone: true }" [min]="1" suffix=" und" />
                    <span class="tier-arrow">→</span>
                    <p-inputNumber [(ngModel)]="t.percent" [ngModelOptions]="{ standalone: true }" [min]="1" [max]="100" suffix=" %" />
                    <button pButton type="button" icon="pi pi-trash" size="small" severity="secondary" [text]="true" (click)="removeTier.emit(i)"></button>
                  </div>
                  <div *ngIf="tiers.length === 0" class="muted">Sin tiers. Agregá al menos uno.</div>
                </div>
              </div>
            </ng-container>

            <!-- bundle_fixed_price -->
            <ng-container *ngSwitchCase="'bundle_fixed_price'">
              <div class="tiers-section full">
                <div class="tiers-header">
                  <span>Productos del pack <em>*</em></span>
                  <button pButton type="button" icon="pi pi-plus" label="Agregar producto" size="small" severity="secondary" (click)="addBundleItem.emit()"></button>
                </div>
                <div class="tiers-list">
                  <div *ngFor="let it of bundle; let i = index" class="bundle-row">
                    <p-select
                      [(ngModel)]="it.product_id"
                      [ngModelOptions]="{ standalone: true }"
                      [options]="productOptions"
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
                    <button pButton type="button" icon="pi pi-trash" size="small" severity="secondary" [text]="true" (click)="removeBundleItem.emit(i)"></button>
                  </div>
                  <div *ngIf="bundle.length === 0" class="muted">Agregá al menos 2 productos.</div>
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
                <p-select formControlName="trigger_product_id" [options]="productOptions" optionLabel="nombre" optionValue="id" [filter]="true" filterBy="nombre,brand" placeholder="Producto que dispara…" appendTo="body"></p-select>
              </label>
              <label class="full">
                <span>Descuento en (target) <em>*</em></span>
                <p-select formControlName="target_product_id" [options]="productOptions" optionLabel="nombre" optionValue="id" [filter]="true" filterBy="nombre,brand" placeholder="Producto descontado…" appendTo="body"></p-select>
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
        <ng-container *ngIf="wizardStep === 'configure'">
          <button pButton label="Cancelar" severity="secondary" [outlined]="true" (click)="cancel.emit()"></button>
          <button
            pButton
            [label]="editing ? 'Guardar' : 'Crear promoción'"
            icon="pi pi-check"
            [loading]="saving"
            [disabled]="!canSave"
            (click)="save.emit()"
          ></button>
        </ng-container>
        <ng-container *ngIf="wizardStep === 'choose-type'">
          <button pButton label="Cancelar" severity="secondary" [outlined]="true" (click)="cancel.emit()"></button>
        </ng-container>
      </ng-template>
    </p-dialog>
  `,
  styles: [
    `
      .promo-banner-preview {
        width: 100%;
        max-height: 160px;
        object-fit: contain;
        border-radius: 10px;
        border: 1px solid var(--border-color);
        background: var(--neutral-100);
        margin-top: .25rem;
      }
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
      .pm-type-chip i { color: var(--c-text-2); font-size: var(--fs-xs); }

      /* DIALOG: wizard step 1 (type selector cards) */
      .step-intro { margin: 0 0 1rem; color: var(--c-text-2); font-size: var(--fs-sm); }
      .type-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: .625rem; }
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
      .type-card:hover { border-color: var(--c-text-1); box-shadow: 0 4px 12px rgba(0,0,0,.06); }
      .type-card:active { transform: scale(.99); }
      .type-icon { width: 40px; height: 40px; border-radius: 8px; display: grid; place-items: center; color: #fff; flex-shrink: 0; }
      .type-icon i { font-size: 1.15rem; }
      .type-body { flex: 1; min-width: 0; }
      .type-title { font-weight: var(--fw-bold); font-size: var(--fs-sm); margin-bottom: .2rem; color: var(--c-text-1); }
      .type-desc { font-size: var(--fs-xs); color: var(--c-text-2); margin-bottom: .3rem; line-height: 1.35; }
      .type-example { font-size: var(--fs-micro); color: var(--c-text-3); font-style: italic; }
      .type-example i { margin-right: .25rem; }

      /* DIALOG: wizard step 2 (config form) */
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
      .divider::after { content: ''; flex: 1; height: 1px; background: var(--c-divider); }
      .tiers-section { display: flex; flex-direction: column; gap: .5rem; }
      .tiers-header { display: flex; justify-content: space-between; align-items: center; }
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
      .tier-row, .bundle-row { display: flex; align-items: center; gap: .5rem; }
      .tier-row .tier-from { font-size: var(--fs-xs); color: var(--c-text-2); min-width: 50px; }
      .tier-row .tier-arrow { color: var(--c-text-3); }
      .muted { color: var(--c-text-2); font-size: var(--fs-sm); }
      :host ::ng-deep .p-select.bundle-product { flex: 1; }
    `,
  ],
})
export class PromotionFormDialogComponent {
  @Input() visible = false;
  @Input() header = '';
  @Input() wizardStep: 'choose-type' | 'configure' = 'choose-type';
  @Input() selectedType: PromotionType | null = null;
  @Input() editing: Promotion | null = null;
  @Input() form: FormGroup | null = null;
  @Input() saving = false;
  @Input() canSave = false;
  @Input() productOptions: ProductOption[] = [];
  @Input() metaList: PromotionMeta[] = [];
  @Input() tiers: Tier[] = [];
  @Input() bundle: BundleItem[] = [];
  @Input() bannerPreviewError = false;

  @Output() visibleChange = new EventEmitter<boolean>();
  @Output() hide = new EventEmitter<void>();
  @Output() chooseType = new EventEmitter<PromotionType>();
  @Output() backToChoose = new EventEmitter<void>();
  @Output() cancel = new EventEmitter<void>();
  @Output() save = new EventEmitter<void>();
  @Output() addTier = new EventEmitter<void>();
  @Output() removeTier = new EventEmitter<number>();
  @Output() addBundleItem = new EventEmitter<void>();
  @Output() removeBundleItem = new EventEmitter<number>();
  @Output() bannerError = new EventEmitter<boolean>();

  meta(type: PromotionType): PromotionMeta {
    return PROMOTION_META[type];
  }
}
