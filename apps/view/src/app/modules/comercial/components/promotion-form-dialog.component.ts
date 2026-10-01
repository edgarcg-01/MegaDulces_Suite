import { Component, EventEmitter, Input, Output, ChangeDetectionStrategy } from '@angular/core';

import { FormGroup, FormsModule, ReactiveFormsModule } from '@angular/forms';
import { DialogModule } from 'primeng/dialog';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
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
    FormsModule,
    ReactiveFormsModule,
    DialogModule,
    ButtonModule,
    InputTextModule,
    InputNumberModule,
    ToggleSwitchModule,
    SelectModule,
    DatePickerModule,
    TextareaModule
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
      @if (form) {
        <!--
          La mecánica se elige ACÁ ADENTRO, no en una antesala. Antes esto era un paso previo
          con seis tarjetas grandes: al abrir "Nueva promoción" nadie estaba creando nada
          todavía, y elegir el tipo costaba un clic que no producía trabajo. Ahora el diálogo
          abre sobre el formulario y el tipo es un control más — cambiarlo conserva lo ya
          escrito (código, nombre, vigencia) y sólo intercambia los campos de la mecánica.
          Al EDITAR no se muestra: cambiarle el tipo a una promoción viva invalidaría sus
          reglas guardadas, así que ahí el tipo es un hecho, no una opción.
          (Sin acentos graves acá dentro: esto vive en un template literal y es la sexta vez
          que uno rompe el build de este repo.)
        -->
        @if (!editing) {
          <div class="type-pick" role="radiogroup" aria-label="Mecánica de la promoción">
            @for (m of metaList; track m.type) {
              <button
                type="button"
                class="type-pill"
                role="radio"
                [attr.aria-checked]="m.type === selectedType"
                [class.is-on]="m.type === selectedType"
                (click)="typeChange.emit(m.type)"
                >
                <span class="type-dot" [style.background]="m.color" aria-hidden="true"></span>
                <i [class]="m.icon" aria-hidden="true"></i>
                <span>{{ m.shortLabel }}</span>
              </button>
            }
          </div>
          @if (selectedType) {
            <p class="type-hint">
              {{ meta(selectedType).description }}
              <span class="type-example"><i class="pi pi-info-circle" aria-hidden="true"></i> {{ meta(selectedType).example }}</span>
            </p>
          }
        }
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
          @if (form.value.banner_url) {
            <div class="full">
              <img
                [src]="form.value.banner_url"
                alt="Vista previa del banner"
                class="promo-banner-preview"
                (error)="bannerError.emit(true)"
                (load)="bannerError.emit(false)"
                />
                @if (bannerPreviewError) {
                  <small class="comm-muted is-small">
                    No se pudo cargar la imagen. Verificá la URL.
                  </small>
                }
              </div>
            }
            <!-- Type-specific fields -->
            @switch (selectedType) {
              <!-- percent_off_product -->
              @case ('percent_off_product') {
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
                  <p-inputnumber formControlName="percent" [min]="1" [max]="100" suffix=" %" />
                </label>
              }
              <!-- percent_off_basket -->
              @case ('percent_off_basket') {
                <label>
                  <span>Descuento (%) <em>*</em></span>
                  <p-inputnumber formControlName="percent" [min]="1" [max]="100" suffix=" %" />
                </label>
                <label>
                  <span>Mínimo de pedido (opcional)</span>
                  <p-inputnumber formControlName="min_order_amount" mode="currency" currency="MXN" locale="es-MX" [min]="0" placeholder="Sin mínimo" />
                </label>
              }
              <!-- nxm -->
              @case ('nxm') {
                <label class="full">
                  <span>Producto <em>*</em></span>
                  <p-select formControlName="product_id" [options]="productOptions" optionLabel="nombre" optionValue="id" [filter]="true" filterBy="nombre,brand" placeholder="Buscar producto…" appendTo="body"></p-select>
                </label>
                <label>
                  <span>Compra (N) <em>*</em></span>
                  <p-inputnumber formControlName="n_buy" [min]="2" [showButtons]="true" />
                </label>
                <label>
                  <span>Paga (M) <em>*</em></span>
                  <p-inputnumber formControlName="m_pay" [min]="1" [showButtons]="true" />
                </label>
                @if (form.value.n_buy && form.value.m_pay) {
                  <div class="comm-form-hint full">
                    <i class="pi pi-info-circle"></i>
                    Cliente lleva <b>{{ form.value.n_buy }}</b> unidades, paga sólo <b>{{ form.value.m_pay }}</b>.
                    Ahorro = {{ form.value.n_buy - form.value.m_pay }} unidad(es) gratis.
                  </div>
                }
              }
              <!-- volume_discount -->
              @case ('volume_discount') {
                <label class="full">
                  <span>Producto <em>*</em></span>
                  <p-select formControlName="product_id" [options]="productOptions" optionLabel="nombre" optionValue="id" [filter]="true" filterBy="nombre,brand" placeholder="Buscar producto…" appendTo="body"></p-select>
                </label>
                <div class="tiers-section full">
                  <div class="tiers-header">
                    <span>Tiers de descuento <em>*</em></span>
                    <button pButton type="button" size="small" severity="secondary" (click)="addTier.emit()"><span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span><span class="p-button-label">Agregar tier</span></button>
                  </div>
                  <div class="tiers-list">
                    @for (t of tiers; track t; let i = $index) {
                      <div class="tier-row">
                        <span class="tier-from">Desde</span>
                        <p-inputnumber [(ngModel)]="t.min_qty" [ngModelOptions]="{ standalone: true }" [min]="1" suffix=" und" />
                        <span class="tier-arrow">→</span>
                        <p-inputnumber [(ngModel)]="t.percent" [ngModelOptions]="{ standalone: true }" [min]="1" [max]="100" suffix=" %" />
                        <button pButton type="button" size="small" severity="secondary" [text]="true" (click)="removeTier.emit(i)"><span class="p-button-icon p-button-icon-left pi pi-trash" aria-hidden="true"></span></button>
                      </div>
                    }
                    @if (tiers.length === 0) {
                      <div class="muted">Sin tiers. Agregá al menos uno.</div>
                    }
                  </div>
                </div>
              }
              <!-- bundle_fixed_price -->
              @case ('bundle_fixed_price') {
                <div class="tiers-section full">
                  <div class="tiers-header">
                    <span>Productos del pack <em>*</em></span>
                    <button pButton type="button" size="small" severity="secondary" (click)="addBundleItem.emit()"><span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span><span class="p-button-label">Agregar producto</span></button>
                  </div>
                  <div class="tiers-list">
                    @for (it of bundle; track it; let i = $index) {
                      <div class="bundle-row">
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
                        <p-inputnumber [(ngModel)]="it.quantity" [ngModelOptions]="{ standalone: true }" [min]="1" suffix=" und" />
                        <button pButton type="button" size="small" severity="secondary" [text]="true" (click)="removeBundleItem.emit(i)"><span class="p-button-icon p-button-icon-left pi pi-trash" aria-hidden="true"></span></button>
                      </div>
                    }
                    @if (bundle.length === 0) {
                      <div class="muted">Agregá al menos 2 productos.</div>
                    }
                  </div>
                </div>
                <label class="full">
                  <span>Precio fijo del pack <em>*</em></span>
                  <p-inputnumber formControlName="price" mode="currency" currency="MXN" locale="es-MX" [min]="1" />
                </label>
              }
              <!-- cross_sell_discount -->
              @case ('cross_sell_discount') {
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
                  <p-inputnumber formControlName="percent" [min]="1" [max]="100" suffix=" %" />
                </label>
              }
            }
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
              <p-inputnumber formControlName="priority" [min]="0" [max]="1000" [showButtons]="true" />
            </label>
            <label>
              <span>Tope global de usos</span>
              <p-inputnumber formControlName="usage_limit" [min]="1" placeholder="Ilimitado" />
            </label>
            <label class="checkbox-line full">
              <p-toggleswitch formControlName="active" />
              <span>Activa al guardar</span>
            </label>
          </form>
        }
    
        <ng-template #footer>
          <button pButton severity="secondary" [outlined]="true" (click)="cancel.emit()"><span class="p-button-label">Cancelar</span></button>
          <p-button
            [label]="editing ? 'Guardar' : 'Crear promoción'"
            icon="pi pi-check"
            [loading]="saving"
            [disabled]="!canSave"
            (click)="save.emit()"
          ></p-button>
        </ng-template>
      </p-dialog>
    `,
  changeDetection: ChangeDetectionStrategy.Eager,
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

      /* Selector de mecánica, EN LÍNEA dentro del formulario (no un paso aparte).
         Superficie Operations: denso y sin ceremonia. El color del tipo queda como un punto
         de 8px —lo justo para distinguirlo— y NUNCA como relleno de un mosaico grande:
         DESIGN.md manda "color disciplinado", y el acento de marca es sólo del estado activo. */
      .type-pick { display: flex; flex-wrap: wrap; gap: .3rem; margin-bottom: .5rem; }
      .type-pill {
        display: inline-flex;
        align-items: center;
        gap: .35rem;
        padding: .25rem .6rem;
        border: 1px solid var(--c-divider);
        border-radius: 999px;
        background: var(--c-surface-1);
        color: var(--c-text-2);
        font-family: inherit;
        font-size: var(--fs-xs);
        line-height: 1.7;
        cursor: pointer;
        transition: border-color 120ms var(--ease-standard), color 120ms var(--ease-standard);
      }
      .type-pill:hover { border-color: var(--c-text-2); color: var(--c-text-1); }
      .type-pill.is-on {
        border-color: var(--action);
        color: var(--action);
        font-weight: var(--fw-bold);
      }
      /* El foco visible se conserva: el pill es el control, y con teclado hay que verlo. */
      .type-pill:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
      .type-pill i { font-size: var(--fs-micro); }
      .type-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
      .type-hint {
        margin: 0 0 .9rem;
        padding-bottom: .75rem;
        border-bottom: 1px solid var(--c-divider);
        font-size: var(--fs-xs);
        color: var(--c-text-2);
        line-height: 1.4;
      }
      .type-example { color: var(--c-text-3); font-style: italic; }
      .type-example i { margin: 0 .25rem 0 .35rem; }

      /* DIALOG: formulario de configuración */
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
  /**
   * El tipo SIEMPRE llega con valor al crear: el diálogo abre sobre el formulario, no sobre
   * una antesala. Sigue siendo `| null` porque el padre lo limpia al cerrar.
   */
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
  /**
   * Cambio de mecánica desde el selector en línea. El padre reconstruye los campos del tipo
   * **conservando lo ya escrito** — si cambiar de tipo borrara el nombre y la vigencia, esto
   * sería peor que el paso previo que vino a reemplazar.
   */
  @Output() typeChange = new EventEmitter<PromotionType>();
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
