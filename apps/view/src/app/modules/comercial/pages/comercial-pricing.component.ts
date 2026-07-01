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
import { makeLazyLoad, makeDebouncedSearch } from '../../../shared/util';

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
            asignables a clientes para Portal y vendedores
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
            severity="contrast"
            (click)="openCreate()"
          ></button>
        </div>
      </header>

      <!-- MASTER: tabla de listas, flush -->
      <div class="sheet cols-12">
        <article class="cell cell-span-12 is-flush">
          <p-table [value]="rows()" [loading]="loading()" responsiveLayout="scroll" styleClass="p-datatable-sm pr-master surf-table surf-table--sticky">
            <ng-template pTemplate="header">
              <tr>
                <th scope="col">Código</th>
                <th scope="col">Nombre</th>
                <th scope="col">Moneda</th>
                <th scope="col">Default</th>
                <th scope="col">Estado</th>
                <th scope="col"><span class="sr-only">Acciones</span></th>
              </tr>
            </ng-template>
            <ng-template pTemplate="body" let-pl>
              <tr [class.pr-selected]="selected()?.id === pl.id" (click)="selectPriceList(pl)"
                  (keydown.enter)="selectPriceList(pl)" (keydown.space)="$event.preventDefault(); selectPriceList(pl)"
                  tabindex="0" role="button" [attr.aria-label]="'Ver precios de ' + pl.name" class="comm-row-clickable">
                <td><code class="comm-code">{{ pl.code }}</code></td>
                <td class="comm-cell-strong">{{ pl.name }}</td>
                <td>{{ pl.currency || 'MXN' }}</td>
                <td>
                  <span *ngIf="pl.is_default" class="pr-default-badge">
                    <i class="pi pi-bookmark-fill" aria-hidden="true"></i>
                    Default
                  </span>
                  <span *ngIf="!pl.is_default" class="comm-muted">—</span>
                </td>
                <td>
                  <span class="pr-status" [class.is-on]="pl.active !== false">
                    <span class="pr-status-dot" aria-hidden="true"></span>
                    {{ pl.active !== false ? 'Activa' : 'Inactiva' }}
                  </span>
                </td>
                <td class="comm-actions">
                  <button pButton icon="pi pi-pencil" size="small" severity="secondary" [text]="true"
                          (click)="$event.stopPropagation(); openEdit(pl)" pTooltip="Editar"></button>
                  <button pButton icon="pi pi-trash" size="small" severity="secondary" [text]="true"
                          (click)="$event.stopPropagation(); confirmDelete(pl)"
                          *ngIf="pl.active !== false" pTooltip="Desactivar"></button>
                </td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage">
              <tr>
                <td colspan="6" class="comm-empty-cell">
                  <div class="comm-empty">
                    <div class="comm-empty-icon"><i class="pi pi-tag" aria-hidden="true"></i></div>
                    <h3>Sin listas de precios</h3>
                    <p>Creá una lista y asignala a clientes para personalizar precios por cuenta.</p>
                    <button
                      type="button"
                      pButton
                      icon="pi pi-plus"
                      severity="contrast"
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

      <!-- DETAIL: precios de la lista seleccionada (paginado + search) -->
      <div *ngIf="selected() as sel" class="sheet cols-12 pr-detail">
        <article class="cell cell-span-12 is-flush">
          <header class="pr-detail-head">
            <div class="pr-detail-head-text">
              <span class="cell-label">Precios de la lista</span>
              <h3 class="pr-detail-title">{{ sel.name }}</h3>
              <span class="comm-muted is-small">
                <b>{{ pricesTotal() }}</b> producto{{ pricesTotal() === 1 ? '' : 's' }}
                <ng-container *ngIf="pricesSearchSignal()"> · filtrados de toda la lista</ng-container>
                · {{ sel.currency || 'MXN' }}
              </span>
            </div>
            <div class="pr-detail-actions">
              <div class="pr-search">
                <i class="pi pi-search pr-search-icon" aria-hidden="true"></i>
                <input
                  type="search"
                  [value]="pricesSearch"
                  (input)="onPricesSearchChange($any($event.target).value)"
                  placeholder="Buscar nombre, SKU o código de barras…"
                  inputmode="search"
                  autocomplete="off"
                  spellcheck="false"
                  aria-label="Buscar precios"
                />
                <button
                  *ngIf="pricesSearch"
                  type="button"
                  class="pr-search-clear"
                  (click)="clearPricesSearch()"
                  aria-label="Limpiar"
                >
                  <i class="pi pi-times" aria-hidden="true"></i>
                </button>
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
            </div>
          </header>
          <p-table
            [value]="prices()"
            [loading]="loadingPrices()"
            [lazy]="true"
            [paginator]="true"
            [rows]="pricesPageSize()"
            [totalRecords]="pricesTotal()"
            [first]="(pricesPage() - 1) * pricesPageSize()"
            [rowsPerPageOptions]="[25, 50, 100, 200]"
            (onLazyLoad)="onPricesLazyLoad($event)"
            responsiveLayout="scroll"
            styleClass="p-datatable-sm surf-table surf-table--sticky surf-table--frozen-first surf-table--zebra"
          >
            <ng-template pTemplate="header">
              <tr>
                <th scope="col">Producto</th>
                <th scope="col">SKU</th>
                <th scope="col">Categoría</th>
                <th scope="col">Ubic.</th>
                <th scope="col" class="comm-num">Costo</th>
                <th scope="col" class="comm-num">Precio</th>
                <th scope="col" class="comm-num">Margen</th>
                <th scope="col" class="comm-num">Min</th>
                <th scope="col"><span class="sr-only">Acciones</span></th>
              </tr>
            </ng-template>
            <ng-template pTemplate="body" let-p>
              <tr>
                <td>
                  <div class="comm-cell-strong" [pTooltip]="p.product_description || ''" tooltipPosition="right" [tooltipDisabled]="!p.product_description">
                    {{ p.product_name || p.product_id }}
                  </div>
                  <div class="comm-muted is-small" *ngIf="p.brand_name">{{ p.brand_name }}</div>
                </td>
                <td>
                  <code *ngIf="p.sku" class="comm-code">{{ p.sku }}</code>
                  <span *ngIf="!p.sku" class="comm-muted">—</span>
                  <div class="comm-muted is-small" *ngIf="p.barcode">{{ p.barcode }}</div>
                </td>
                <td>
                  <span *ngIf="p.category_name" class="pr-cat-tag">{{ p.category_name }}</span>
                  <span *ngIf="!p.category_name" class="comm-muted">—</span>
                </td>
                <td>
                  <code *ngIf="p.location" class="comm-code pr-loc-code">{{ p.location }}</code>
                  <span *ngIf="!p.location" class="comm-muted">—</span>
                </td>
                <td class="comm-num">
                  <span *ngIf="p.cost_base != null">{{ p.cost_base | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
                  <span *ngIf="p.cost_base == null" class="comm-muted">—</span>
                </td>
                <td class="comm-num is-strong">{{ p.price | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td class="comm-num">
                  <span *ngIf="marginPct(p) as m" class="pr-margin" [class.is-good]="m >= 20" [class.is-warn]="m >= 5 && m < 20" [class.is-bad]="m < 5">
                    {{ m | number:'1.1-1' }}%
                  </span>
                  <span *ngIf="!marginPct(p)" class="comm-muted">—</span>
                </td>
                <td class="comm-num">
                  <span class="pr-min-qty" [class.is-tier]="(p.min_qty || 1) > 1">{{ p.min_qty || p.min_quantity || 1 }}</span>
                </td>
                <td class="comm-actions">
                  <button pButton icon="pi pi-trash" size="small" severity="secondary" [text]="true"
                          (click)="confirmDeletePrice(p)" pTooltip="Eliminar"></button>
                </td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage">
              <tr>
                <td colspan="9" class="comm-empty-cell">
                  <div class="comm-empty">
                    <div class="comm-empty-icon"><i [class]="pricesSearchSignal() ? 'pi pi-search' : 'pi pi-box'" aria-hidden="true"></i></div>
                    <h3>{{ pricesSearchSignal() ? 'Sin resultados' : 'Lista vacía' }}</h3>
                    <p *ngIf="pricesSearchSignal()">No se encontraron precios con "{{ pricesSearchSignal() }}".</p>
                    <p *ngIf="!pricesSearchSignal()">Esta lista todavía no tiene precios cargados. Sincronizar desde Mega_Dulces ERP via importer:</p>
                    <code *ngIf="!pricesSearchSignal()" class="comm-code pr-empty-cmd">database/importers/mega_dulces_sync.js --scope=prices</code>
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

    /* ── Master table: selected row con stripe monocromo ── */
    tr.pr-selected {
      background: var(--c-surface-2);
      box-shadow: inset 3px 0 0 var(--c-text-1);
    }
    tr.pr-selected td:first-child { padding-left: calc(.75rem + 3px); }

    /* ── Default badge (subtle, no pill llena) ── */
    .pr-default-badge {
      display: inline-flex;
      align-items: center;
      gap: .35rem;
      font-size: var(--fs-xs);
      font-weight: var(--fw-bold);
      color: var(--c-text-1);
      text-transform: uppercase;
      letter-spacing: .04em;
    }
    .pr-default-badge i {
      font-size: var(--fs-xs);
      color: var(--c-text-2);
    }

    /* ── Estado dot + label (sin pill llena) ── */
    .pr-status {
      display: inline-flex;
      align-items: center;
      gap: .4rem;
      font-size: var(--fs-sm);
      color: var(--c-text-3);
    }
    .pr-status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--c-text-3);
    }
    .pr-status.is-on { color: var(--c-text-1); }
    .pr-status.is-on .pr-status-dot { background: var(--c-ok); }

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

    /* ── DETAIL head actions (search + close) ── */
    .pr-detail-actions {
      display: flex;
      align-items: center;
      gap: .5rem;
      flex-shrink: 0;
    }
    .pr-search {
      display: inline-flex;
      align-items: center;
      height: 32px;
      width: 280px;
      max-width: 100%;
      background: var(--c-surface-1);
      border: 1px solid var(--c-divider);
      border-radius: 8px;
      padding: 0 .5rem;
      gap: .35rem;
      transition: border-color 120ms var(--ease-standard);
    }
    .pr-search:focus-within {
      border-color: var(--c-text-1);
      box-shadow: 0 0 0 3px var(--c-focus-ring, rgba(0, 0, 0, 0.08));
    }
    .pr-search-icon {
      color: var(--c-text-3);
      font-size: var(--fs-sm);
      flex-shrink: 0;
    }
    .pr-search input {
      flex: 1;
      border: none !important;
      background: transparent;
      outline: none !important;
      box-shadow: none !important;
      font-size: var(--fs-sm);
      color: var(--c-text-1);
      min-width: 0;
      padding: 0;
      height: 28px;
    }
    .pr-search input::placeholder {
      color: var(--c-text-3);
    }
    .pr-search-clear {
      background: transparent;
      border: none;
      width: 22px;
      height: 22px;
      border-radius: 4px;
      color: var(--c-text-3);
      cursor: pointer;
      display: grid;
      place-items: center;
      flex-shrink: 0;
      font-size: var(--fs-xs);
    }
    .pr-search-clear:hover {
      color: var(--c-text-1);
      background: var(--c-surface-2);
    }

    /* ── Margen semáforo: bueno (≥20%) / warn (5-20%) / bad (<5%) ── */
    .pr-margin {
      display: inline-block;
      font-variant-numeric: tabular-nums;
      font-weight: var(--fw-medium);
      color: var(--c-text-2);
    }
    .pr-margin.is-good { color: var(--c-ok); font-weight: var(--fw-bold); }
    .pr-margin.is-warn { color: var(--c-warn); }
    .pr-margin.is-bad  { color: var(--c-bad);  font-weight: var(--fw-bold); }

    /* ── min_qty con tier badge (cuando > 1) ── */
    .pr-min-qty {
      display: inline-block;
      font-variant-numeric: tabular-nums;
      color: var(--c-text-2);
    }
    .pr-min-qty.is-tier {
      padding: .1rem .45rem;
      background: var(--c-surface-2);
      color: var(--c-text-1);
      font-weight: var(--fw-bold);
      border-radius: 4px;
      font-size: var(--fs-xs);
    }

    /* ── location code (más chico que SKU) ── */
    .pr-loc-code {
      font-size: var(--fs-xs);
      padding: .1rem .35rem;
      letter-spacing: 0.04em;
    }

    /* ── Category tag inline ── */
    .pr-cat-tag {
      display: inline-block;
      padding: .15rem .55rem;
      background: var(--c-surface-2);
      color: var(--c-text-2);
      font-size: var(--fs-xs);
      border-radius: 6px;
      font-weight: var(--fw-medium);
      white-space: nowrap;
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
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

  // Paginación + search del detail table — necesario para listas grandes
  // (post-importer Mega_Dulces: ~6500 SKUs en MAYOREO).
  readonly pricesPage = signal(1);
  readonly pricesPageSize = signal(50);
  readonly pricesTotal = signal(0);
  pricesSearch = '';
  readonly pricesSearchSignal = signal('');

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
        // El backend retorna array directo. Antes el código hacía `r.data || []`
        // y el array nunca matcheaba, dejando la tabla siempre vacía aunque
        // hubiera 6 listas en la DB.
        this.rows.set(Array.isArray(r) ? r : []);
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
    this.pricesPage.set(1);
    this.pricesSearch = '';
    this.pricesSearchSignal.set('');
    this.loadPricesPage();
  }

  loadPricesPage(): void {
    const sel = this.selected();
    if (!sel) return;
    this.loadingPrices.set(true);
    this.api
      .listPrices(sel.id, {
        page: this.pricesPage(),
        pageSize: this.pricesPageSize(),
        search: this.pricesSearchSignal() || undefined,
      })
      .subscribe({
        next: (r) => {
          this.prices.set(r.data || []);
          this.pricesTotal.set(r.pagination?.total || 0);
          this.loadingPrices.set(false);
        },
        error: () => {
          this.loadingPrices.set(false);
          this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar precios' });
        },
      });
  }

  readonly onPricesLazyLoad = makeLazyLoad(this.pricesPage, this.pricesPageSize, () => this.loadPricesPage());

  onPricesSearchChange(v: string): void {
    this.pricesSearch = v;
    this.pricesSearchDebounced(v);
  }
  private readonly pricesSearchDebounced = makeDebouncedSearch((v) => {
    this.pricesSearchSignal.set((v || '').trim());
    this.pricesPage.set(1);
    this.loadPricesPage();
  });

  clearPricesSearch(): void {
    this.pricesSearch = '';
    this.pricesSearchSignal.set('');
    this.pricesPage.set(1);
    this.loadPricesPage();
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

  /**
   * Margen sobre precio = (price - cost_base) / price * 100.
   * Devuelve null si falta data — el template lo renderiza como "—".
   * Usar precio (no costo) en el denominador es la convención retail estándar
   * ("margen sobre venta"), distinto al markup ("margen sobre costo").
   */
  marginPct(p: ProductPrice): number | null {
    const price = Number(p.price || 0);
    const cost = Number(p.cost_base || 0);
    if (!price || !cost) return null;
    return ((price - cost) / price) * 100;
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
            this.loadPricesPage();
          },
          error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo eliminar' }),
        });
      },
    });
  }
}
