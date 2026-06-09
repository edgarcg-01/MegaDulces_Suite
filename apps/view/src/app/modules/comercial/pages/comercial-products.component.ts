import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, FormsModule, ReactiveFormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { TextareaModule } from 'primeng/textarea';
import { InputSwitchModule } from 'primeng/inputswitch';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageService } from 'primeng/api';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ComercialService, Product, UpdateProductDto } from '../comercial.service';

type ActiveFilter = 'all' | 'active' | 'inactive';

@Component({
  selector: 'app-comercial-products',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ReactiveFormsModule,
    ButtonModule,
    DialogModule,
    InputTextModule,
    InputNumberModule,
    TextareaModule,
    InputSwitchModule,
    SelectModule,
    TableModule,
    TagModule,
    ToastModule,
    TooltipModule,
    SkeletonModule,
  ],
  providers: [MessageService],
  template: `
    <div class="surf-page pp">
      <p-toast></p-toast>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Catálogo de productos</h1>
          <p class="surf-page-sub">
            <b>{{ total() }}</b> SKU{{ total() === 1 ? '' : 's' }}
            <span class="pp-divider" aria-hidden="true">·</span>
            sincronizado desde Mega_Dulces ERP
          </p>
        </div>
        <div class="pp-head-actions">
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
        </div>
      </header>

      <!-- Toolbar -->
      <div class="sheet cols-12">
        <article class="cell cell-span-12 is-flush pp-filters-cell">
          <div class="pp-toolbar">
            <!-- Search -->
            <div class="pp-search">
              <i class="pi pi-search pp-search-icon" aria-hidden="true"></i>
              <input
                type="search"
                [value]="searchInput"
                (input)="onSearchChange($any($event.target).value)"
                placeholder="Buscar nombre, SKU, barcode o descripción…"
                inputmode="search"
                autocomplete="off"
                spellcheck="false"
                aria-label="Buscar productos"
              />
              <button
                *ngIf="searchInput"
                type="button"
                class="pp-search-clear"
                (click)="clearSearch()"
                aria-label="Limpiar"
              >
                <i class="pi pi-times" aria-hidden="true"></i>
              </button>
            </div>

            <!-- Active filter -->
            <div class="pp-segment" role="group" aria-label="Filtrar por estado">
              <button
                *ngFor="let f of activeFilters"
                type="button"
                class="pp-seg-btn"
                [class.active]="activeFilter() === f.key"
                (click)="setActiveFilter(f.key)"
              >{{ f.label }}</button>
            </div>

            <!-- Only with cost (importer validation) -->
            <label class="pp-toggle">
              <p-inputSwitch [(ngModel)]="onlyWithCost" (onChange)="reload()"></p-inputSwitch>
              <span>Sólo con costo</span>
            </label>

            <div class="pp-toolbar-spacer"></div>

            <!-- Reset -->
            <button
              *ngIf="hasActiveFilters()"
              type="button"
              class="pp-reset"
              (click)="resetFilters()"
            >
              <i class="pi pi-refresh" aria-hidden="true"></i>
              <span>Reset</span>
            </button>
          </div>
        </article>
      </div>

      <!-- KPI strip -->
      <p-skeleton *ngIf="loading()" height="80px"></p-skeleton>
      <div *ngIf="!loading()" class="sheet cols-12">
        <article class="cell cell-span-3">
          <span class="cell-icon" aria-hidden="true"><i class="pi pi-box"></i></span>
          <span class="cell-label">SKUs</span>
          <span class="cell-value">{{ fmtNumber(total()) }}</span>
        </article>
        <article class="cell cell-span-3">
          <span class="cell-icon" aria-hidden="true"><i class="pi pi-check-circle"></i></span>
          <span class="cell-label">Activos</span>
          <span class="cell-value">{{ fmtNumber(kpis().active) }}</span>
        </article>
        <article class="cell cell-span-3">
          <span class="cell-icon" aria-hidden="true"><i class="pi pi-dollar"></i></span>
          <span class="cell-label">Con costo</span>
          <span class="cell-value">{{ fmtNumber(kpis().withCost) }}</span>
        </article>
        <article class="cell cell-span-3">
          <span class="cell-icon" aria-hidden="true"><i class="pi pi-map-marker"></i></span>
          <span class="cell-label">Con ubicación</span>
          <span class="cell-value">{{ fmtNumber(kpis().withLocation) }}</span>
        </article>
      </div>

      <!-- Table -->
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
            styleClass="p-datatable-sm pp-table"
            [rowHover]="true"
          >
            <ng-template pTemplate="header">
              <tr>
                <th>Producto</th>
                <th>SKU</th>
                <th>Marca</th>
                <th>Categoría</th>
                <th>Ubic.</th>
                <th class="comm-num">Costo</th>
                <th class="comm-num">Unidad</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </ng-template>
            <ng-template pTemplate="body" let-p>
              <tr (click)="openEdit(p)" class="comm-row-clickable">
                <td>
                  <div class="comm-cell-strong" [pTooltip]="p.description || ''" tooltipPosition="right" [tooltipDisabled]="!p.description">
                    {{ p.nombre }}
                  </div>
                  <div class="comm-muted is-small" *ngIf="p.barcode">{{ p.barcode }}</div>
                </td>
                <td>
                  <code *ngIf="p.sku" class="comm-code">{{ p.sku }}</code>
                  <span *ngIf="!p.sku" class="comm-muted">—</span>
                </td>
                <td>
                  <span *ngIf="p.brand_name" class="pp-brand-tag">{{ p.brand_name }}</span>
                  <span *ngIf="!p.brand_name" class="comm-muted">—</span>
                </td>
                <td>
                  <span *ngIf="p.category_name" class="pp-cat-tag">{{ p.category_name }}</span>
                  <span *ngIf="!p.category_name" class="comm-muted">—</span>
                </td>
                <td>
                  <code *ngIf="p.location" class="comm-code pp-loc-code">{{ p.location }}</code>
                  <span *ngIf="!p.location" class="comm-muted">—</span>
                </td>
                <td class="comm-num">
                  <span *ngIf="p.cost_base != null">{{ p.cost_base | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
                  <span *ngIf="p.cost_base == null" class="comm-muted">—</span>
                </td>
                <td class="comm-num">
                  <span *ngIf="p.unit_sale">{{ p.unit_sale }}<span class="comm-muted is-small" *ngIf="p.factor_sale && p.factor_sale > 1"> × {{ p.factor_sale }}</span></span>
                  <span *ngIf="!p.unit_sale" class="comm-muted">—</span>
                </td>
                <td>
                  <span class="pp-status" [class.is-on]="p.activo">
                    <span class="pp-status-dot" aria-hidden="true"></span>
                    {{ p.activo ? 'Activo' : 'Inactivo' }}
                  </span>
                </td>
                <td class="comm-actions">
                  <button pButton icon="pi pi-pencil" size="small" severity="secondary" [text]="true"
                          (click)="$event.stopPropagation(); openEdit(p)" pTooltip="Editar"></button>
                </td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage">
              <tr>
                <td colspan="9" class="pp-empty-cell">
                  <div class="pp-empty">
                    <div class="pp-empty-icon"><i [class]="searchInput ? 'pi pi-search' : 'pi pi-box'" aria-hidden="true"></i></div>
                    <h3>{{ searchInput ? 'Sin resultados' : 'Sin productos' }}</h3>
                    <p *ngIf="searchInput">No se encontraron productos con "{{ searchInput }}".</p>
                    <p *ngIf="!searchInput">Sincronizar desde Mega_Dulces ERP:</p>
                    <code *ngIf="!searchInput" class="comm-code pp-empty-cmd">database/importers/mega_dulces_sync.js --scope=products</code>
                  </div>
                </td>
              </tr>
            </ng-template>
          </p-table>
        </article>
      </div>
    </div>

    <!-- Edit Dialog -->
    <p-dialog
      [(visible)]="dialogVisible"
      [modal]="true"
      [draggable]="false"
      [style]="{ width: '560px' }"
      [header]="editing()?.nombre || 'Editar producto'"
    >
      <div class="pp-edit-body" *ngIf="editing() as e">
        <div class="pp-edit-meta">
          <div><span class="comm-muted is-small">SKU</span> <code class="comm-code">{{ e.sku || '—' }}</code></div>
          <div *ngIf="e.brand_name"><span class="comm-muted is-small">Marca</span> <strong>{{ e.brand_name }}</strong></div>
          <div *ngIf="e.cost_base != null"><span class="comm-muted is-small">Costo base</span> <strong>{{ e.cost_base | currency:'MXN':'symbol-narrow':'1.2-2' }}</strong></div>
          <div *ngIf="e.prices_count != null"><span class="comm-muted is-small">Precios configurados</span> <strong>{{ e.prices_count }}</strong></div>
          <div *ngIf="e.total_available != null"><span class="comm-muted is-small">Stock disponible</span> <strong>{{ fmtNumber(e.total_available) }}</strong></div>
        </div>

        <form [formGroup]="form" class="comm-form">
          <label>
            <span>Descripción larga</span>
            <textarea pInputTextarea rows="3" formControlName="description" maxlength="500"></textarea>
            <span class="comm-muted is-small">Visible en portal/vendor en hover sobre el nombre.</span>
          </label>
          <div class="pp-form-row">
            <label>
              <span>Ubicación</span>
              <input pInputText formControlName="location" maxlength="20" placeholder="ej: Z000" />
            </label>
            <label>
              <span>Ubicación bodega</span>
              <input pInputText formControlName="location_warehouse" maxlength="20" placeholder="ej: B-12" />
            </label>
          </div>
          <label>
            <span>Puntos de fidelidad</span>
            <p-inputNumber formControlName="loyalty_points" [min]="0" [showButtons]="true"></p-inputNumber>
          </label>
          <label class="pp-toggle-line">
            <p-inputSwitch formControlName="activo"></p-inputSwitch>
            <span>Activo en catálogo</span>
            <span class="comm-muted is-small">(si lo desactivás, no aparece en portal ni vendor)</span>
          </label>
        </form>
      </div>
      <ng-template pTemplate="footer">
        <button pButton label="Cancelar" severity="secondary" [outlined]="true" (click)="dialogVisible = false"></button>
        <button pButton label="Guardar" icon="pi pi-check" [loading]="saving()" [disabled]="form.invalid" (click)="save()"></button>
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    :host { display: block; }
    .pp-head-actions { display: flex; gap: 0.5rem; align-items: center; }
    .pp-divider { opacity: 0.4; }
    .surf-page-sub b { font-weight: var(--fw-bold); color: var(--c-text-1); }

    .pp-filters-cell { display: flex; flex-direction: column; }
    .pp-toolbar {
      display: flex; align-items: center; gap: .5rem;
      padding: .625rem .875rem;
      flex-wrap: wrap;
    }
    .pp-toolbar-spacer { flex: 1; min-width: 0; }

    .pp-search {
      display: inline-flex; align-items: center;
      height: 32px;
      width: 320px; max-width: 100%;
      background: var(--c-surface-1);
      border: 1px solid var(--c-divider);
      border-radius: 8px;
      padding: 0 .5rem;
      gap: .35rem;
      transition: border-color 120ms var(--ease-standard);
    }
    .pp-search:focus-within {
      border-color: var(--c-text-1);
      box-shadow: 0 0 0 3px var(--c-focus-ring, rgba(0, 0, 0, 0.08));
    }
    .pp-search-icon { color: var(--c-text-3); font-size: var(--fs-sm); flex-shrink: 0; }
    .pp-search input {
      flex: 1; border: none; background: transparent; outline: none;
      font-size: var(--fs-sm); color: var(--c-text-1);
      min-width: 0; padding: 0; height: 28px;
    }
    .pp-search input::placeholder { color: var(--c-text-3); }
    .pp-search-clear {
      background: transparent; border: none;
      width: 22px; height: 22px;
      border-radius: 4px;
      color: var(--c-text-3); cursor: pointer;
      display: grid; place-items: center; flex-shrink: 0;
      font-size: var(--fs-xs);
    }
    .pp-search-clear:hover { color: var(--c-text-1); background: var(--c-surface-2); }

    .pp-segment {
      display: inline-flex; align-items: stretch;
      height: 32px;
      background: var(--c-surface-2);
      border: 1px solid var(--c-divider);
      border-radius: 8px;
      padding: 2px; gap: 2px;
    }
    .pp-seg-btn {
      background: transparent; border: none;
      padding: 0 .65rem;
      font-size: var(--fs-xs); font-weight: var(--fw-medium);
      color: var(--c-text-2);
      cursor: pointer; border-radius: 6px;
      transition: all 100ms var(--ease-standard);
      white-space: nowrap;
    }
    .pp-seg-btn:hover { color: var(--c-text-1); }
    .pp-seg-btn.active {
      background: var(--c-surface-1);
      color: var(--c-text-1);
      box-shadow: 0 1px 2px rgba(0,0,0,.08);
      font-weight: var(--fw-bold);
    }

    .pp-toggle {
      display: inline-flex; align-items: center; gap: .5rem;
      font-size: var(--fs-xs); color: var(--c-text-2);
    }

    .pp-reset {
      display: inline-flex; align-items: center; gap: .35rem;
      height: 32px; padding: 0 .75rem;
      background: transparent;
      border: 1px solid var(--c-divider);
      border-radius: 8px;
      color: var(--c-text-2);
      font-size: var(--fs-xs); font-weight: var(--fw-medium);
      cursor: pointer;
    }
    .pp-reset:hover { color: var(--c-text-1); border-color: var(--c-text-1); background: var(--c-surface-2); }
    .pp-reset i { font-size: var(--fs-xs); }

    .pp-brand-tag, .pp-cat-tag {
      display: inline-block;
      padding: .15rem .55rem;
      background: var(--c-surface-2);
      color: var(--c-text-2);
      font-size: var(--fs-xs);
      border-radius: 6px;
      font-weight: var(--fw-medium);
      white-space: nowrap;
      max-width: 180px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .pp-loc-code {
      font-size: var(--fs-xs);
      padding: .1rem .35rem;
      letter-spacing: 0.04em;
    }
    .pp-status {
      display: inline-flex; align-items: center; gap: .4rem;
      font-size: var(--fs-sm);
      color: var(--c-text-3);
    }
    .pp-status-dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      background: var(--c-text-3);
    }
    .pp-status.is-on { color: var(--c-text-1); }
    .pp-status.is-on .pp-status-dot { background: var(--c-ok); }

    .pp-empty-cell { padding: 0 !important; }
    .pp-empty {
      text-align: center;
      padding: 3rem 1.5rem;
      max-width: 480px;
      margin: 0 auto;
    }
    .pp-empty-icon {
      width: 56px; height: 56px;
      margin: 0 auto 1rem;
      border-radius: 14px;
      background: var(--c-surface-2);
      color: var(--c-text-2);
      display: grid; place-items: center;
      font-size: 1.5rem;
    }
    .pp-empty h3 { margin: 0 0 .375rem; font-size: var(--fs-h3); color: var(--c-text-1); }
    .pp-empty p { margin: 0 0 1rem; color: var(--c-text-2); font-size: var(--fs-sm); }
    .pp-empty-cmd { display: inline-block; padding: .4rem .75rem; font-size: var(--fs-xs); }

    /* ── Edit dialog ── */
    .pp-edit-body { display: flex; flex-direction: column; gap: 1rem; }
    .pp-edit-meta {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: .65rem 1rem;
      padding: .75rem 1rem;
      background: var(--c-surface-2);
      border-radius: 8px;
    }
    .pp-edit-meta > div { display: flex; flex-direction: column; gap: .15rem; }
    .pp-edit-meta strong { font-variant-numeric: tabular-nums; color: var(--c-text-1); }
    .pp-form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    .pp-toggle-line {
      display: flex !important; flex-direction: row !important;
      align-items: center; gap: .65rem;
    }
    .pp-toggle-line > span:first-of-type { font-weight: var(--fw-medium); }

    @media (max-width: 640px) {
      .pp-edit-meta, .pp-form-row { grid-template-columns: 1fr; }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComercialProductsComponent {
  private readonly api = inject(ComercialService);
  private readonly fb = inject(FormBuilder);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly rows = signal<Product[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly pageSize = signal(50);
  readonly loading = signal(false);

  // Filtros
  searchInput = '';
  readonly searchSignal = signal('');
  private searchDebounce: any = null;

  readonly activeFilter = signal<ActiveFilter>('all');
  readonly activeFilters: { key: ActiveFilter; label: string }[] = [
    { key: 'all',      label: 'Todos' },
    { key: 'active',   label: 'Activos' },
    { key: 'inactive', label: 'Inactivos' },
  ];
  onlyWithCost = false;

  // KPI computed from current page (approx).
  readonly kpis = computed(() => {
    const list = this.rows();
    return {
      active: list.filter((p) => p.activo).length,
      withCost: list.filter((p) => p.cost_base != null).length,
      withLocation: list.filter((p) => p.location).length,
    };
  });

  // Edit dialog
  readonly editing = signal<Product | null>(null);
  readonly saving = signal(false);
  dialogVisible = false;
  form: FormGroup = this.fb.group({
    description: [''],
    location: [''],
    location_warehouse: [''],
    loyalty_points: [0],
    activo: [true],
  });

  constructor() {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    const activeFilter = this.activeFilter();
    this.api
      .listProducts({
        page: this.page(),
        pageSize: this.pageSize(),
        search: this.searchSignal() || undefined,
        active: activeFilter === 'all' ? undefined : activeFilter === 'active',
        with_cost: this.onlyWithCost || undefined,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.rows.set(r.data || []);
          this.total.set(r.pagination?.total || 0);
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
          this.toast.add({
            severity: 'error',
            summary: 'Error',
            detail: 'No se pudieron cargar productos',
          });
        },
      });
  }

  reload(): void {
    this.page.set(1);
    this.load();
  }

  onSearchChange(v: string): void {
    this.searchInput = v;
    if (this.searchDebounce) clearTimeout(this.searchDebounce);
    this.searchDebounce = setTimeout(() => {
      this.searchSignal.set((v || '').trim());
      this.reload();
    }, 250);
  }

  clearSearch(): void {
    this.searchInput = '';
    this.searchSignal.set('');
    this.reload();
  }

  setActiveFilter(key: ActiveFilter): void {
    if (this.activeFilter() === key) return;
    this.activeFilter.set(key);
    this.reload();
  }

  resetFilters(): void {
    this.searchInput = '';
    this.searchSignal.set('');
    this.activeFilter.set('all');
    this.onlyWithCost = false;
    this.reload();
  }

  hasActiveFilters(): boolean {
    return !!this.searchSignal() || this.activeFilter() !== 'all' || this.onlyWithCost;
  }

  onLazyLoad(e: { first?: number | null; rows?: number | null }): void {
    const first = e.first ?? 0;
    const rows = e.rows ?? this.pageSize();
    this.page.set(Math.floor(first / rows) + 1);
    this.pageSize.set(rows);
    this.load();
  }

  openEdit(p: Product): void {
    // Buscar el detalle completo para traer prices_count, total_available.
    this.api.findProduct(p.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (full) => {
        this.editing.set(full);
        this.form.reset({
          description: full.description || '',
          location: full.location || '',
          location_warehouse: full.location_warehouse || '',
          loyalty_points: full.loyalty_points || 0,
          activo: full.activo,
        });
        this.dialogVisible = true;
      },
      error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar detalle' }),
    });
  }

  save(): void {
    const e = this.editing();
    if (!e || this.form.invalid) return;
    this.saving.set(true);
    const v = this.form.value;
    const payload: UpdateProductDto = {
      description: v.description?.trim() || null,
      location: v.location?.trim() || null,
      location_warehouse: v.location_warehouse?.trim() || null,
      loyalty_points: v.loyalty_points == null ? null : Number(v.loyalty_points),
      activo: !!v.activo,
    };
    this.api.updateProduct(e.id, payload).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.saving.set(false);
        this.dialogVisible = false;
        this.toast.add({ severity: 'success', summary: 'Producto actualizado' });
        this.load();
      },
      error: (err) => {
        this.saving.set(false);
        const detail = err?.error?.message || 'No se pudo guardar';
        this.toast.add({ severity: 'error', summary: 'Error', detail });
      },
    });
  }

  fmtNumber(n: number | null | undefined): string {
    if (n === null || n === undefined) return '—';
    return new Intl.NumberFormat('es-MX').format(Number(n));
  }
}
