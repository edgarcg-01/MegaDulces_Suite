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
import { makeLazyLoad } from '../../../shared/util';
import { PROMOTION_META, PROMOTION_META_LIST, summarizePromotion } from '../promotions-meta';
import { PromotionFormDialogComponent } from '../components/promotion-form-dialog.component';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { PROMOS_TABS } from '../promos-tabs';

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
    PromotionFormDialogComponent,
    PageTabsComponent,
  ],
  providers: [MessageService, ConfirmationService],
  template: `
    <div class="surf-page pm">
      <p-toast></p-toast>
      <p-confirmDialog></p-confirmDialog>
      <app-page-tabs [tabs]="promoTabs" />

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
            [rowsPerPageOptions]="[25, 50, 100, 200]"
            (onLazyLoad)="onLazyLoad($event)"
            responsiveLayout="scroll"
            styleClass="p-datatable-sm surf-table surf-table--sticky surf-table--frozen-first surf-table--zebra"
          >
            <ng-template pTemplate="header">
              <tr>
                <th scope="col">Código</th>
                <th scope="col">Nombre</th>
                <th scope="col">Tipo</th>
                <th scope="col">Mecánica</th>
                <th scope="col">Vigencia</th>
                <th scope="col" class="comm-num">Prioridad</th>
                <th scope="col">Activa</th>
                <th scope="col"><span class="sr-only">Acciones</span></th>
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
                <td colspan="8" class="comm-empty-cell">
                  <div class="comm-empty">
                    <div class="comm-empty-icon"><i class="pi pi-megaphone" aria-hidden="true"></i></div>
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

    <!-- Dialog: Step 1 (type selector) + Step 2 (config) — extraído a app-promotion-form-dialog (CV.3) -->
    <app-promotion-form-dialog
      [visible]="dialogVisible"
      (visibleChange)="dialogVisible = $event"
      [header]="dialogHeader()"
      [wizardStep]="wizardStep()"
      [selectedType]="selectedType()"
      [editing]="editing()"
      [form]="form"
      [saving]="saving()"
      [canSave]="canSave()"
      [productOptions]="productOptions()"
      [metaList]="metaList"
      [tiers]="tiersValue"
      [bundle]="bundleValue"
      [bannerPreviewError]="bannerPreviewError()"
      (hide)="onDialogHide()"
      (chooseType)="chooseType($event)"
      (backToChoose)="backToChoose()"
      (cancel)="closeDialog()"
      (save)="save()"
      (addTier)="addTier()"
      (removeTier)="removeTier($event)"
      (addBundleItem)="addBundleItem()"
      (removeBundleItem)="removeBundleItem($event)"
      (bannerError)="bannerPreviewError.set($event)"
    ></app-promotion-form-dialog>
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

  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComercialPromotionsComponent {
  readonly promoTabs = PROMOS_TABS;
  private readonly api = inject(ComercialService);
  private readonly fb = inject(FormBuilder);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);

  readonly rows = signal<Promotion[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly pageSize = signal(25);
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
  readonly bannerPreviewError = signal(false);

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

  readonly onLazyLoad = makeLazyLoad(this.page, this.pageSize, () => this.load());

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
      banner_url: [p?.banner_url ?? ''],
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
      banner_url: raw.banner_url?.trim() || null,
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
