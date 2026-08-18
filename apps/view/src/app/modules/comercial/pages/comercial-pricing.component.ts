import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { FormBuilder, FormGroup, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { CheckboxModule } from 'primeng/checkbox';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { MessageService, ConfirmationService } from 'primeng/api';
import {
  ComercialService,
  PriceHealthFlag,
  PriceList,
  PriceListHealth,
  PriceScope,
  ProductPrice,
} from '../comercial.service';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { makeDebouncedSearch, type LazyTableEvent } from '../../../shared/util';
import { exportXlsx, type XlsxCol } from '../../../shared/export/xlsx-export';

/** Fila lista para pintar: el diagnóstico ya viene resuelto, el template no calcula. */
interface PriceRow extends ProductPrice {
  _price: number | null;
  _cost: number | null;
  _margin: number | null;
  _flag: PriceHealthFlag | null;
  /**
   * Hay una fila en `product_prices` que borrar. NO es `_price !== null`: al
   * teclear un precio en una fila sin precio, `_price` se llena al instante por
   * el optimistic UI, pero `id` sigue siendo el del producto — y con ese id
   * `deletePrice` tira 404. Se apoya en lo que confirmó el server, no en la
   * pantalla.
   */
  _canDelete: boolean;
}

/** Espejo EXACTO de `PRICE_HEALTH_SQL` del backend. Si uno cambia, cambian los dos. */
const SENTINEL_MAX = 0.05;
const THIN_MARGIN_MAX = 10;

interface FlagMeta {
  key: PriceHealthFlag;
  label: string;
  tone: 'bad' | 'warn' | 'mute';
  hint: string;
}

const FLAGS: FlagMeta[] = [
  { key: 'below_cost', label: 'bajo costo', tone: 'bad', hint: 'Se vende por menos de lo que costó.' },
  { key: 'sentinel', label: 'centinela', tone: 'warn', hint: `Precio piso de promo (≤ $${SENTINEL_MAX}) que mete el sync de Kepler. No es un precio: es una marca.` },
  { key: 'thin', label: 'margen flaco', tone: 'warn', hint: `Margen entre 0% y ${THIN_MARGIN_MAX}%: no pierde, pero no paga la operación.` },
  { key: 'no_cost', label: 'sin costo', tone: 'mute', hint: 'Tiene precio y no hay costo con qué juzgarlo.' },
];

@Component({
  selector: 'app-comercial-pricing',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ReactiveFormsModule,
    ButtonModule,
    TableModule,
    DialogModule,
    InputTextModule,
    CheckboxModule,
    ToastModule,
    TooltipModule,
    ConfirmDialogModule,
  ],
  providers: [MessageService, ConfirmationService],
  template: `
    <div class="surf-page pl">
      <p-toast />
      <p-confirmdialog />

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Listas de precios</h1>
          <p class="surf-page-sub">
            <b>{{ lists().length }}</b> lista{{ lists().length === 1 ? '' : 's' }}
            <span class="pl-sep" aria-hidden="true">·</span>
            asignables a clientes para Portal y vendedores
          </p>
        </div>
        <div class="pl-head-actions">
          <button pButton [text]="true" severity="secondary" size="small" (click)="reloadAll()"
                  [loading]="loading()" pTooltip="Refrescar" aria-label="Refrescar">
            <span class="p-button-icon pi pi-refresh" aria-hidden="true"></span>
          </button>
          @if (canManage()) {
            <button pButton size="small" severity="contrast" (click)="openCreate()">
              <span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span>
              <span class="p-button-label">Nueva lista</span>
            </button>
          }
        </div>
      </header>

      <div class="pl-grid">
        <!-- ── ÍNDICE DE LISTAS ─────────────────────────────────────────── -->
        <aside class="pl-aside">
          <h2 class="pl-aside-h">Listas</h2>
          @for (it of listIndex(); track it.list.id) {
            <button type="button" class="pl-item" [class.is-off]="it.list.active === false"
                    [attr.aria-current]="selectedId() === it.list.id"
                    (click)="selectList(it.list.id)">
              <span class="pl-item-code">
                {{ it.list.code }}
                @if (it.list.is_default) {
                  <i class="pi pi-bookmark-fill" aria-hidden="true" pTooltip="Lista por defecto del tenant"></i>
                }
              </span>
              <span class="pl-item-n">{{ it.health ? (it.health.priced | number) : '—' }}</span>
              <span class="pl-item-nm">{{ it.list.name }}</span>
              @if (it.alert) { <span class="pl-item-alert">{{ it.alert }}</span> }
            </button>
          }
          @if (!lists().length && !loading()) {
            <p class="pl-aside-empty">Sin listas todavía.</p>
          }
        </aside>

        <!-- ── DETALLE ──────────────────────────────────────────────────── -->
        <section class="pl-main">
          @if (selected(); as sel) {
            <header class="pl-head">
              <div class="pl-head-text">
                <h2 class="pl-head-title">{{ sel.name }}</h2>
                <p class="pl-head-meta">
                  <code class="comm-code">{{ sel.code }}</code>
                  <span>{{ sel.currency || 'MXN' }}</span>
                  @if (health(); as h) {
                    <span><b>{{ h.priced | number }}</b> con precio</span>
                    <span>de {{ h.catalog | number }} del catálogo</span>
                  }
                </p>
              </div>
              <div class="pl-head-actions">
                <button pButton [text]="true" severity="secondary" size="small" (click)="exportSheet()"
                        [loading]="exporting()" pTooltip="Exportar a Excel lo que estás viendo" aria-label="Exportar a Excel">
                  <span class="p-button-icon pi pi-file-excel" aria-hidden="true"></span>
                </button>
                @if (canManage()) {
                  <button pButton [text]="true" severity="secondary" size="small" (click)="openEdit(sel)"
                          pTooltip="Editar lista" aria-label="Editar lista">
                    <span class="p-button-icon pi pi-pencil" aria-hidden="true"></span>
                  </button>
                  @if (sel.active !== false) {
                    <button pButton [text]="true" severity="secondary" size="small" (click)="confirmDeleteList(sel)"
                            pTooltip="Desactivar lista" aria-label="Desactivar lista">
                      <span class="p-button-icon pi pi-trash" aria-hidden="true"></span>
                    </button>
                  }
                }
              </div>
            </header>

            <!-- Filtros: alcance + salud. Cada contador es el filtro que lo abre. -->
            <div class="pl-filters">
              <div class="pl-seg" role="group" aria-label="Alcance">
                @for (s of SCOPES; track s.key) {
                  @let n = scopeCount(s.key);
                  <button type="button" class="pl-seg-btn" [class.is-on]="scope() === s.key"
                          [attr.aria-pressed]="scope() === s.key" (click)="setScope(s.key)">
                    {{ s.label }}
                    @if (n !== null) { <span class="pl-seg-n">{{ n | number }}</span> }
                  </button>
                }
              </div>

              @if (visibleFlags().length) {
                <div class="pl-chips" role="group" aria-label="Salud del precio">
                  @for (f of visibleFlags(); track f.meta.key) {
                    <button type="button" class="pl-chip"
                            [class.tone-bad]="f.meta.tone === 'bad'"
                            [class.tone-warn]="f.meta.tone === 'warn'"
                            [class.tone-mute]="f.meta.tone === 'mute'"
                            [class.is-on]="flag() === f.meta.key" [attr.aria-pressed]="flag() === f.meta.key"
                            [pTooltip]="f.meta.hint" tooltipPosition="bottom" (click)="toggleFlag(f.meta.key)">
                      <b>{{ f.count | number }}</b> {{ f.meta.label }}
                      @if (flag() === f.meta.key) { <i class="pi pi-times pl-chip-x" aria-hidden="true"></i> }
                    </button>
                  }
                </div>
              }

              <div class="pl-search">
                <i class="pi pi-search pl-search-ico" aria-hidden="true"></i>
                <input type="search" [value]="search" (input)="onSearch($any($event.target).value)"
                       placeholder="Buscar nombre, SKU o código de barras…"
                       inputmode="search" autocomplete="off" spellcheck="false" aria-label="Buscar productos" />
                @if (search) {
                  <button type="button" class="pl-search-x" (click)="clearSearch()" aria-label="Limpiar búsqueda">
                    <i class="pi pi-times" aria-hidden="true"></i>
                  </button>
                }
              </div>
            </div>

            <div class="pl-panel">
              <p-table
                [value]="rows()"
                [loading]="loadingPrices()"
                [lazy]="true"
                [paginator]="true"
                [rows]="pageSize()"
                [totalRecords]="total()"
                [first]="(page() - 1) * pageSize()"
                [rowsPerPageOptions]="[25, 50, 100, 200]"
                [sortField]="sort()?.field ?? ''"
                [sortOrder]="sort()?.dir === 'desc' ? -1 : 1"
                (onLazyLoad)="onLazy($event)"
                dataKey="product_id"
                currentPageReportTemplate="{first}–{last} de {totalRecords}"
                [showCurrentPageReport]="true"
                styleClass="p-datatable-sm surf-table surf-table--sticky surf-table--frozen-first">
                <ng-template #header>
                  <tr>
                    <th scope="col" class="pl-c-prod" pSortableColumn="product">Producto <p-sorticon field="product" /></th>
                    <th scope="col" class="pl-c-sku" pSortableColumn="sku">SKU <p-sorticon field="sku" /></th>
                    <th scope="col" class="pl-c-cat" pSortableColumn="category">Categoría <p-sorticon field="category" /></th>
                    <th scope="col" class="comm-num pl-c-num" pSortableColumn="rotation"
                        pTooltip="Unidades vendidas en 30 días. Dice si un precio malo importa.">Rot. 30d <p-sorticon field="rotation" /></th>
                    <th scope="col" class="comm-num pl-c-num" pSortableColumn="cost">Costo <p-sorticon field="cost" /></th>
                    <th scope="col" class="comm-num pl-c-num" pSortableColumn="price">Precio <p-sorticon field="price" /></th>
                    <th scope="col" class="comm-num pl-c-num" pSortableColumn="margin">Margen <p-sorticon field="margin" /></th>
                    <th scope="col" class="comm-num pl-c-min" pSortableColumn="min_qty"
                        pTooltip="Cantidad mínima de compra">Mín <p-sorticon field="min_qty" /></th>
                    <th scope="col" class="pl-c-act"><span class="sr-only">Acciones</span></th>
                  </tr>
                </ng-template>

                <ng-template #body let-p>
                  <tr [class.pl-r-unpriced]="p._price === null">
                    <td>
                      <div class="comm-cell-strong" [pTooltip]="p.product_description || ''" tooltipPosition="right"
                           [tooltipDisabled]="!p.product_description">{{ p.product_name || p.product_id }}</div>
                      @if (p.brand_name) { <div class="pl-sub">{{ p.brand_name }}</div> }
                    </td>
                    <td>
                      @if (p.sku) { <code class="comm-code">{{ p.sku }}</code> } @else { <span class="pl-none">—</span> }
                      @if (p.barcode) { <div class="pl-sub">{{ p.barcode }}</div> }
                    </td>
                    <td>
                      @if (p.category_name) { <span class="pl-cat">{{ p.category_name }}</span> }
                      @else { <span class="pl-none">—</span> }
                    </td>
                    <td class="comm-num">
                      @if (p.sales_units_30d) { {{ p.sales_units_30d | number }} }
                      @else { <span class="pl-none">0</span> }
                    </td>
                    <td class="comm-num">
                      @if (p._cost !== null) { {{ p._cost | currency:'MXN':'symbol-narrow':'1.2-2' }} }
                      @else { <span class="pl-none">—</span> }
                    </td>

                    <!-- Precio: editable en sitio. Es la única celda que se escribe. -->
                    <td class="comm-num pl-price-cell">
                      @if (editingId() === p.product_id) {
                        <input #priceInput type="number" class="pl-price-input" step="0.01" min="0"
                               [value]="p._price ?? ''" aria-label="Nuevo precio"
                               (keydown.enter)="commitPrice(p, $any($event.target).value)"
                               (keydown.escape)="editingId.set(null)"
                               (blur)="commitPrice(p, $any($event.target).value)" />
                      } @else if (canManage()) {
                        <button type="button" class="pl-price-btn" (click)="editingId.set(p.product_id)"
                                [attr.aria-label]="'Editar precio de ' + (p.product_name || '')">
                          @if (p._price !== null) { {{ p._price | currency:'MXN':'symbol-narrow':'1.2-2' }} }
                          @else { <span class="pl-price-add"><i class="pi pi-plus" aria-hidden="true"></i> precio</span> }
                        </button>
                      } @else if (p._price !== null) {
                        {{ p._price | currency:'MXN':'symbol-narrow':'1.2-2' }}
                      } @else { <span class="pl-none">—</span> }
                    </td>

                    <td class="comm-num">
                      @if (p._flag === 'sentinel') {
                        <span class="pl-mark tone-warn" pTooltip="Precio centinela: piso de promo, no un precio real">piso</span>
                      } @else if (p._flag === 'no_cost') {
                        <span class="pl-none" pTooltip="Sin costo con qué calcular margen">s/costo</span>
                      } @else if (p._margin !== null) {
                        <span class="pl-margin" [class.tone-bad]="p._flag === 'below_cost'"
                              [class.tone-warn]="p._flag === 'thin'">{{ p._margin | number:'1.1-1' }}%</span>
                      } @else { <span class="pl-none">—</span> }
                    </td>
                    <td class="comm-num">{{ p.min_qty || 1 }}</td>
                    <td class="pl-c-act">
                      @if (canManage() && p._canDelete) {
                        <button pButton size="small" severity="secondary" [text]="true"
                                (click)="confirmDeletePrice(p)" pTooltip="Quitar de la lista"
                                [attr.aria-label]="'Quitar ' + (p.product_name || '') + ' de la lista'">
                          <span class="p-button-icon pi pi-trash" aria-hidden="true"></span>
                        </button>
                      }
                    </td>
                  </tr>
                </ng-template>

                <ng-template #emptymessage>
                  <tr>
                    <td colspan="9" class="comm-empty-cell">
                      <div class="comm-empty">
                        <div class="comm-empty-icon">
                          <i [class]="hasFilters() ? 'pi pi-filter-slash' : 'pi pi-tag'" aria-hidden="true"></i>
                        </div>
                        <h3>{{ hasFilters() ? 'Sin resultados' : 'Lista vacía' }}</h3>
                        @if (hasFilters()) {
                          <p>Ningún producto cumple el filtro actual.</p>
                          <button type="button" pButton severity="secondary" size="small" [outlined]="true" (click)="clearFilters()">
                            <span class="p-button-label">Quitar filtros</span>
                          </button>
                        } @else {
                          <p>Esta lista no tiene precios. Poné uno desde la columna Precio, o cargalos en bloque con el importer.</p>
                          <code class="comm-code pl-cmd">database/importers/mega_dulces_sync.js --scope=prices</code>
                        }
                      </div>
                    </td>
                  </tr>
                </ng-template>
              </p-table>
            </div>
          } @else {
            <div class="pl-blank">
              <i class="pi pi-tags" aria-hidden="true"></i>
              <p>Elegí una lista para ver y editar sus precios.</p>
            </div>
          }
        </section>
      </div>

      <p-dialog
        [visible]="dialogVisible()"
        (visibleChange)="onDialogVisible($event)"
        [modal]="true"
        [draggable]="false"
        [style]="{ width: '440px' }"
        [header]="editing() ? 'Editar lista de precios' : 'Nueva lista de precios'">
        <form [formGroup]="form" class="comm-form">
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
            <input pInputText formControlName="currency" placeholder="MXN" maxlength="3" class="pl-upper" />
          </label>
          <label class="checkbox-line">
            <p-checkbox formControlName="is_default" [binary]="true" inputId="pl_default" />
            <span>Lista por defecto del tenant</span>
          </label>
        </form>
        <ng-template #footer>
          <button pButton severity="secondary" [outlined]="true" (click)="closeDialog()">
            <span class="p-button-label">Cancelar</span>
          </button>
          <p-button [label]="editing() ? 'Guardar' : 'Crear'" icon="pi pi-check"
                    [loading]="saving()" [disabled]="form.invalid" (click)="save()" />
        </ng-template>
      </p-dialog>
    </div>
  `,
  styles: [`
    :host { display: block; }

    .pl-sep { opacity: .4; }
    .pl-head-actions { display: flex; gap: var(--sp-2); align-items: center; }
    .surf-page-sub b { font-weight: var(--fw-bold); color: var(--c-text-1); }
    .pl-none { color: var(--c-text-3); }
    .pl-sub { font-size: var(--fs-micro); color: var(--c-text-3); }

    /* ── Rejilla master-detail ─────────────────────────────────────────── */
    .pl-grid {
      display: grid;
      grid-template-columns: 232px minmax(0, 1fr);
      gap: var(--sp-4);
      align-items: start;
    }

    /* ── Índice de listas ──────────────────────────────────────────────── */
    .pl-aside {
      background: var(--c-surface-1);
      border: 1px solid var(--c-divider);
      border-radius: var(--r-md);
      padding: var(--sp-2);
      position: sticky;
      top: var(--sp-4);
    }
    .pl-aside-h {
      margin: 0;
      font-size: var(--fs-micro);
      text-transform: uppercase;
      letter-spacing: .06em;
      font-weight: var(--fw-bold);
      color: var(--c-text-3);
      padding: var(--sp-2) var(--sp-2) var(--sp-1);
    }
    .pl-aside-empty { margin: 0; padding: var(--sp-2); font-size: var(--fs-sm); color: var(--c-text-3); }
    .pl-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 1px var(--sp-2);
      width: 100%;
      text-align: left;
      font: inherit;
      background: none;
      border: none;
      border-radius: var(--r-sm);
      padding: var(--sp-2);
      cursor: pointer;
      transition: background-color var(--dur-micro) var(--ease-standard);
    }
    .pl-item:hover { background: var(--overlay-hover); }
    .pl-item:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    .pl-item[aria-current='true'] {
      background: var(--overlay-selected);
      box-shadow: inset 2px 0 0 var(--action);
    }
    .pl-item.is-off .pl-item-code,
    .pl-item.is-off .pl-item-nm { color: var(--c-text-3); text-decoration: line-through; }
    .pl-item-code {
      font-family: var(--font-mono);
      font-size: var(--fs-sm);
      font-weight: var(--fw-bold);
      color: var(--c-text-1);
      display: inline-flex;
      align-items: center;
      gap: var(--sp-1);
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .pl-item-code i { font-size: var(--fs-nano); color: var(--c-text-3); }
    .pl-item-n {
      font-size: var(--fs-xs);
      color: var(--c-text-2);
      font-variant-numeric: tabular-nums;
    }
    .pl-item-nm {
      grid-column: 1 / -1;
      font-size: var(--fs-micro);
      color: var(--c-text-3);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* La alerta es la razón para entrar a esta lista antes que a otra. */
    .pl-item-alert {
      grid-column: 1 / -1;
      font-size: var(--fs-micro);
      color: var(--c-bad);
      font-variant-numeric: tabular-nums;
      margin-top: 1px;
    }

    /* ── Encabezado del detalle ────────────────────────────────────────── */
    .pl-main { min-width: 0; display: flex; flex-direction: column; gap: var(--sp-3); }
    .pl-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: var(--sp-4);
    }
    .pl-head-text { min-width: 0; }
    .pl-head-title {
      margin: 0;
      font-size: var(--fs-h2);
      font-weight: var(--fw-bold);
      color: var(--c-text-1);
      letter-spacing: -0.01em;
    }
    .pl-head-meta {
      margin: var(--sp-1) 0 0;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--sp-1) var(--sp-3);
      font-size: var(--fs-xs);
      color: var(--c-text-3);
    }
    .pl-head-meta b { color: var(--c-text-1); font-weight: var(--fw-bold); }

    /* ── Filtros ───────────────────────────────────────────────────────── */
    .pl-filters {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--sp-2) var(--sp-3);
    }
    .pl-seg {
      display: inline-flex;
      background: var(--c-surface-2);
      border: 1px solid var(--c-divider);
      border-radius: var(--r-sm);
      padding: 2px;
      gap: 2px;
    }
    .pl-seg-btn {
      font: inherit;
      font-size: var(--fs-xs);
      color: var(--c-text-2);
      background: none;
      border: none;
      border-radius: calc(var(--r-sm) - 3px);
      padding: var(--sp-1) var(--sp-3);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: var(--sp-2);
      transition: background-color var(--dur-micro) var(--ease-standard);
    }
    .pl-seg-btn:hover { background: var(--overlay-hover); }
    .pl-seg-btn:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    /* Sin sombra: el contenedor ya trae borde y la regla del DS es elevación por
       borde O sombra, nunca las dos. El cambio de fondo alcanza para marcar cuál
       está activo. */
    .pl-seg-btn.is-on {
      background: var(--c-surface-1);
      color: var(--c-text-1);
      font-weight: var(--fw-medium);
    }
    .pl-seg-n { font-size: var(--fs-micro); color: var(--c-text-3); font-variant-numeric: tabular-nums; }

    /* Chips de salud: el contador ES el filtro (DESIGN §Q.4). */
    .pl-chips { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
    .pl-chip {
      font: inherit;
      font-size: var(--fs-xs);
      color: var(--c-text-2);
      background: none;
      border: 1px solid var(--c-divider);
      border-radius: var(--r-pill);
      padding: 2px var(--sp-3);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: var(--sp-1);
      transition: background-color var(--dur-micro) var(--ease-standard),
                  border-color var(--dur-micro) var(--ease-standard);
    }
    .pl-chip b { font-variant-numeric: tabular-nums; font-weight: var(--fw-bold); }
    .pl-chip:hover { background: var(--overlay-hover); }
    .pl-chip:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    .pl-chip.tone-bad b { color: var(--c-bad); }
    .pl-chip.tone-warn b { color: var(--c-warn); }
    .pl-chip.is-on.tone-bad { border-color: var(--c-bad); background: color-mix(in srgb, var(--c-bad) 10%, transparent); }
    .pl-chip.is-on.tone-warn { border-color: var(--c-warn); background: color-mix(in srgb, var(--c-warn) 12%, transparent); }
    .pl-chip.is-on.tone-mute { border-color: var(--c-text-2); background: var(--overlay-selected); }
    .pl-chip-x { font-size: var(--fs-nano); opacity: .7; }

    /* --row-h-sm sube solo a 44px en punteros gruesos: el buscador cumple el
       área de toque en tablet sin una media query propia. */
    .pl-search {
      display: inline-flex;
      align-items: center;
      height: var(--row-h-sm);
      width: 280px;
      max-width: 100%;
      margin-left: auto;
      background: var(--c-surface-1);
      border: 1px solid var(--c-divider);
      border-radius: var(--r-sm);
      padding: 0 var(--sp-2);
      gap: var(--sp-1);
      transition: border-color var(--dur-micro) var(--ease-standard);
    }
    .pl-search:focus-within {
      border-color: var(--c-text-1);
      box-shadow: 0 0 0 3px var(--focus-ring);
    }
    .pl-search-ico { color: var(--c-text-3); font-size: var(--fs-sm); flex-shrink: 0; }
    .pl-search input {
      flex: 1;
      min-width: 0;
      align-self: stretch;
      padding: 0;
      border: none;
      background: transparent;
      outline: none;
      box-shadow: none;
      font-size: var(--fs-sm);
      color: var(--c-text-1);
    }
    .pl-search input::placeholder { color: var(--c-text-3); }
    .pl-search-x {
      background: transparent;
      border: none;
      width: 22px;
      height: 22px;
      border-radius: var(--r-sm);
      color: var(--c-text-3);
      cursor: pointer;
      display: grid;
      place-items: center;
      flex-shrink: 0;
      font-size: var(--fs-xs);
    }
    .pl-search-x:hover { color: var(--c-text-1); background: var(--c-surface-2); }
    .pl-search-x:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    /* 22px es un blanco chico para un dedo; en táctil se lleva el mínimo del DS. */
    @media (pointer: coarse) {
      .pl-search-x { min-width: var(--tap-min); min-height: var(--tap-min); }
    }

    /* ── Tabla ─────────────────────────────────────────────────────────── */
    .pl-panel {
      background: var(--c-surface-1);
      border: 1px solid var(--c-divider);
      border-radius: var(--r-md);
      overflow: hidden;
    }
    .pl-c-prod { min-width: 15rem; }
    .pl-c-sku { min-width: 8rem; }
    .pl-c-cat { min-width: 9rem; }
    .pl-c-num { min-width: 6.5rem; }
    .pl-c-min { min-width: 4.5rem; }
    .pl-c-act { width: 3rem; text-align: right; }
    /* Fila sin precio: presente pero en segundo plano — es trabajo pendiente,
       no un dato con el mismo peso que un precio puesto. */
    .pl-r-unpriced .comm-cell-strong { font-weight: var(--fw-regular); color: var(--c-text-2); }
    .pl-cat {
      display: inline-block;
      max-width: 12rem;
      padding: 1px var(--sp-2);
      background: var(--c-surface-2);
      color: var(--c-text-2);
      font-size: var(--fs-micro);
      border-radius: var(--r-sm);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      vertical-align: middle;
    }

    /* El margen sólo se pinta cuando algo anda mal: en 8,900 filas, colorear
       lo normal es ruido y deja de señalar la excepción. */
    .pl-margin { font-variant-numeric: tabular-nums; color: var(--c-text-2); }
    .pl-margin.tone-warn { color: var(--c-warn); }
    .pl-margin.tone-bad { color: var(--c-bad); font-weight: var(--fw-bold); }
    .pl-mark {
      font-size: var(--fs-micro);
      text-transform: uppercase;
      letter-spacing: .04em;
      font-weight: var(--fw-bold);
    }
    .pl-mark.tone-warn { color: var(--c-warn); }

    /* ── Edición en sitio del precio ───────────────────────────────────── */
    .pl-price-cell { padding-top: 0; padding-bottom: 0; vertical-align: middle; }
    .pl-price-btn {
      font: inherit;
      font-size: var(--fs-sm);
      font-variant-numeric: tabular-nums;
      color: var(--c-text-1);
      font-weight: var(--fw-medium);
      background: none;
      border: 1px solid transparent;
      border-radius: var(--r-sm);
      padding: var(--sp-1) var(--sp-2);
      width: 100%;
      text-align: right;
      cursor: text;
      transition: border-color var(--dur-micro) var(--ease-standard);
    }
    .pl-price-btn:hover { border-color: var(--c-divider); background: var(--c-surface-2); }
    .pl-price-btn:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    .pl-price-add {
      color: var(--c-text-3);
      font-size: var(--fs-micro);
      display: inline-flex;
      align-items: center;
      gap: 3px;
    }
    .pl-price-btn:hover .pl-price-add { color: var(--action); }
    .pl-price-input {
      width: 100%;
      height: var(--row-h-sm);
      padding: 0 var(--sp-2);
      text-align: right;
      font-family: var(--font-mono);
      font-size: var(--fs-sm);
      color: var(--c-text-1);
      background: var(--c-surface-1);
      border: 1px solid var(--action);
      border-radius: var(--r-sm);
      outline: none;
      box-shadow: 0 0 0 3px var(--focus-ring);
    }

    .pl-blank {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--sp-2);
      padding: var(--sp-12) var(--sp-4);
      background: var(--c-surface-1);
      border: 1px dashed var(--c-divider);
      border-radius: var(--r-md);
      color: var(--c-text-3);
    }
    .pl-blank i { font-size: 1.5rem; }
    .pl-blank p { margin: 0; font-size: var(--fs-sm); }
    .pl-cmd { display: inline-block; padding: var(--sp-1) var(--sp-3); font-size: var(--fs-xs); }
    .pl-upper { text-transform: uppercase; }

    /* ── Móvil: el índice pasa a ser una tira horizontal sobre la tabla. ── */
    @media (max-width: 900px) {
      .pl-grid { grid-template-columns: minmax(0, 1fr); }
      .pl-aside {
        position: static;
        display: flex;
        gap: var(--sp-1);
        overflow-x: auto;
        scrollbar-width: none;
      }
      .pl-aside::-webkit-scrollbar { display: none; }
      .pl-aside-h { display: none; }
      .pl-item {
        grid-template-columns: auto auto;
        width: auto;
        flex: none;
        white-space: nowrap;
      }
      .pl-item-nm, .pl-item-alert { display: none; }
      .pl-search { margin-left: 0; width: 100%; }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComercialPricingComponent {
  private readonly api = inject(ComercialService);
  private readonly fb = inject(FormBuilder);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);

  readonly SCOPES: { key: PriceScope; label: string }[] = [
    { key: 'priced', label: 'Con precio' },
    { key: 'unpriced', label: 'Sin precio' },
    { key: 'all', label: 'Todo el catálogo' },
  ];

  readonly canManage = computed(
    () => this.perms.can('manage', 'all') || !!this.auth.user()?.permissions?.[Permission.COMMERCIAL_PRICING_GESTIONAR],
  );

  // ── Listas ────────────────────────────────────────────────────────────
  readonly lists = signal<PriceList[]>([]);
  readonly loading = signal(false);
  readonly selectedId = signal<string | null>(null);
  readonly selected = computed(() => this.lists().find((l) => l.id === this.selectedId()) ?? null);

  /**
   * Salud de las 6 listas en una consulta. `healthTick` la refresca sin recargar
   * la tabla — al guardar un precio los contadores cambian, pero mover la fila
   * bajo el cursor del usuario sería peor que un contador un segundo viejo.
   */
  private readonly healthTick = signal(0);
  private readonly healthRes = rxResource({
    params: () => ({ t: this.healthTick() }),
    stream: () => this.api.listPriceListsHealth(),
  });
  private readonly healthById = computed(() => {
    const m = new Map<string, PriceListHealth>();
    for (const h of this.healthRes.value()?.data ?? []) m.set(h.price_list_id, h);
    return m;
  });
  readonly health = computed(() => this.healthById().get(this.selectedId() ?? '') ?? null);

  readonly listIndex = computed(() =>
    [...this.lists()]
      .sort((a, b) => a.code.localeCompare(b.code))
      .map((list) => {
        const h = this.healthById().get(list.id) ?? null;
        return { list, health: h, alert: h ? this.listAlert(h) : '' };
      }),
  );

  /** Lo que amerita entrar a esta lista antes que a otra. '' = nada que señalar. */
  private listAlert(h: PriceListHealth): string {
    if (h.below_cost) return `${h.below_cost} bajo costo`;
    if (h.unpriced && h.priced) return `${h.unpriced.toLocaleString('es-MX')} sin precio`;
    return '';
  }

  // ── Filtros de la tabla ───────────────────────────────────────────────
  readonly scope = signal<PriceScope>('priced');
  readonly flag = signal<PriceHealthFlag | null>(null);
  readonly page = signal(1);
  readonly pageSize = signal(50);
  readonly sort = signal<{ field: string; dir: 'asc' | 'desc' } | null>(null);
  search = '';
  readonly searchTerm = signal('');

  readonly hasFilters = computed(() => !!this.flag() || !!this.searchTerm() || this.scope() !== 'all');

  private readonly params = computed(() => {
    const id = this.selectedId();
    if (!id) return undefined;
    const s = this.sort();
    return {
      id,
      page: this.page(),
      pageSize: this.pageSize(),
      search: this.searchTerm() || undefined,
      scope: this.scope(),
      flag: this.flag() ?? undefined,
      sort: s?.field,
      dir: s?.dir,
    };
  });

  private readonly pricesRes = rxResource({
    params: () => this.params(),
    stream: ({ params }) => this.api.listPrices(params.id, params),
  });

  readonly total = computed(() => this.pricesRes.value()?.pagination?.total ?? 0);
  readonly loadingPrices = computed(() => this.pricesRes.isLoading());

  /**
   * Precios guardados en esta sesión, superpuestos sobre lo que vino del server.
   * Es el "optimistic UI sin spinner" del DS: la celda muestra el valor nuevo al
   * instante y sólo revierte si el PATCH falla. Se limpia en cada cambio de
   * filtro, donde el server vuelve a ser la verdad.
   */
  private readonly priceEdits = signal<Record<string, number>>({});
  readonly editingId = signal<string | null>(null);
  private readonly priceInput = viewChild<ElementRef<HTMLInputElement>>('priceInput');

  /** Filas con el diagnóstico ya resuelto — el template no calcula nada. */
  readonly rows = computed<PriceRow[]>(() => {
    const edits = this.priceEdits();
    return (this.pricesRes.value()?.data ?? []).map((r) => {
      const edited = edits[r.product_id];
      // numeric de Postgres llega como string: coerción una sola vez, acá.
      const price = edited ?? (r.price === null || r.price === undefined ? null : Number(r.price));
      const cost = r.cost_base === null || r.cost_base === undefined ? null : Number(r.cost_base);
      const margin = price !== null && price > 0 && cost !== null && cost > 0 ? ((price - cost) / price) * 100 : null;
      return {
        ...r,
        _price: price,
        _cost: cost,
        _margin: margin,
        _flag: this.flagOf(price, cost, margin),
        _canDelete: r.price !== null && r.price !== undefined,
      };
    });
  });

  /** Mismo criterio y mismo orden que `PRICE_HEALTH_SQL` del backend. */
  private flagOf(price: number | null, cost: number | null, margin: number | null): PriceHealthFlag | null {
    if (price === null) return null;
    if (price <= SENTINEL_MAX) return 'sentinel';
    if (cost === null || cost === 0) return 'no_cost';
    if (price < cost) return 'below_cost';
    return margin !== null && margin < THIN_MARGIN_MAX ? 'thin' : null;
  }

  readonly visibleFlags = computed(() => {
    const h = this.health();
    if (!h) return [];
    return FLAGS.map((meta) => ({ meta, count: (h as any)[meta.key] as number | undefined }))
      .filter((f): f is { meta: FlagMeta; count: number } => !!f.count);
  });

  scopeCount(s: PriceScope): number | null {
    const h = this.health();
    if (!h) return null;
    return s === 'priced' ? h.priced : s === 'unpriced' ? h.unpriced : h.catalog;
  }

  // ── Formulario de lista ───────────────────────────────────────────────
  readonly editing = signal<PriceList | null>(null);
  readonly saving = signal(false);
  readonly dialogVisible = signal(false);
  readonly exporting = signal(false);

  form: FormGroup = this.fb.group({
    code: ['', [Validators.required, Validators.pattern(/^[A-Z0-9_-]{2,50}$/)]],
    name: ['', Validators.required],
    currency: ['MXN'],
    is_default: [false],
  });

  constructor() {
    // Estado de la vista desde la URL (DESIGN §9): F5 no pierde el contexto y
    // "los precios de MAYOREO bajo costo" se puede pasar como liga.
    const q = this.route.snapshot.queryParamMap;
    const scope = q.get('scope') as PriceScope | null;
    if (scope && this.SCOPES.some((s) => s.key === scope)) this.scope.set(scope);
    const flag = q.get('flag') as PriceHealthFlag | null;
    if (flag && FLAGS.some((f) => f.key === flag)) this.flag.set(flag);
    const term = q.get('q') ?? '';
    if (term) { this.search = term; this.searchTerm.set(term); }
    const page = Number(q.get('page'));
    if (page > 1) this.page.set(page);
    const sortField = q.get('sort');
    if (sortField) this.sort.set({ field: sortField, dir: q.get('dir') === 'desc' ? 'desc' : 'asc' });
    this.load(q.get('list'));

    effect(() => {
      if (this.pricesRes.error()) {
        this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar los precios' });
      }
    });
    // Al abrir la celda de precio, foco + texto seleccionado: se teclea el valor
    // nuevo directo, sin borrar antes.
    effect(() => {
      const el = this.priceInput()?.nativeElement;
      if (el) { el.focus(); el.select(); }
    });
  }

  // ── Carga ─────────────────────────────────────────────────────────────
  load(preselect?: string | null): void {
    this.loading.set(true);
    this.api.listPriceLists().subscribe({
      next: (r) => {
        // El backend retorna array directo (no `{ data }`).
        const list = Array.isArray(r) ? r : [];
        this.lists.set(list);
        this.loading.set(false);
        const wanted = preselect ?? this.selectedId();
        const target = list.find((l) => l.id === wanted) ?? list.find((l) => l.is_default) ?? list[0];
        if (target && target.id !== this.selectedId()) this.selectedId.set(target.id);
        this.syncUrl();
      },
      error: () => {
        this.loading.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar las listas' });
      },
    });
  }

  reloadAll(): void {
    this.priceEdits.set({});
    this.pricesRes.reload();
    this.healthTick.update((t) => t + 1);
    this.load();
  }

  selectList(id: string): void {
    if (id === this.selectedId()) return;
    this.selectedId.set(id);
    this.editingId.set(null);
    this.priceEdits.set({});
    this.resetPage();
  }

  // ── Filtros ───────────────────────────────────────────────────────────
  private resetPage(): void {
    this.page.set(1);
    this.priceEdits.set({});
    this.syncUrl();
  }

  setScope(s: PriceScope): void {
    this.scope.set(s);
    // Los diagnósticos sólo existen donde hay precio; sostener el chip acá
    // devolvería cero filas y parecería un bug.
    if (s === 'unpriced') this.flag.set(null);
    this.resetPage();
  }

  toggleFlag(f: PriceHealthFlag): void {
    const next = this.flag() === f ? null : f;
    this.flag.set(next);
    if (next) this.scope.set('priced');
    this.resetPage();
  }

  onSearch(v: string): void { this.search = v; this.searchDebounced(v); }
  private readonly searchDebounced = makeDebouncedSearch((v) => {
    this.searchTerm.set((v || '').trim());
    this.resetPage();
  });

  clearSearch(): void { this.search = ''; this.searchTerm.set(''); this.resetPage(); }

  clearFilters(): void {
    this.search = '';
    this.searchTerm.set('');
    this.flag.set(null);
    this.scope.set('all');
    this.resetPage();
  }

  onLazy(e: LazyTableEvent): void {
    const rows = e.rows ?? this.pageSize();
    const field = (Array.isArray(e.sortField) ? e.sortField[0] : e.sortField) || null;
    const dir: 'asc' | 'desc' = (e.sortOrder ?? 1) < 0 ? 'desc' : 'asc';
    const cur = this.sort();
    // Cambiar el orden manda a la página 1: quedarse en la 87 después de
    // reordenar deja al usuario en un tramo que no pidió.
    const sortChanged = (cur?.field ?? null) !== field || (!!field && cur?.dir !== dir);
    this.sort.set(field ? { field, dir } : null);
    this.pageSize.set(rows);
    this.page.set(sortChanged ? 1 : Math.floor((e.first ?? 0) / rows) + 1);
    this.editingId.set(null);
    this.syncUrl();
  }

  private syncUrl(): void {
    const s = this.sort();
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        list: this.selectedId() || null,
        scope: this.scope() === 'priced' ? null : this.scope(),
        flag: this.flag() || null,
        q: this.searchTerm() || null,
        page: this.page() > 1 ? this.page() : null,
        sort: s?.field ?? null,
        dir: s ? s.dir : null,
      },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  // ── Edición del precio en sitio ───────────────────────────────────────
  commitPrice(row: PriceRow, raw: string): void {
    if (this.editingId() !== row.product_id) return;   // blur después de Enter
    this.editingId.set(null);
    const list = this.selectedId();
    const value = Number(String(raw ?? '').replace(',', '.'));
    if (!list || !isFinite(value) || value < 0) {
      if (raw !== '' && raw !== null) {
        this.toast.add({ severity: 'warn', summary: 'Precio inválido', detail: 'Tiene que ser un número mayor o igual a 0.' });
      }
      return;
    }
    const rounded = Math.round(value * 100) / 100;
    if (rounded === row._price) return;

    const previous = this.priceEdits()[row.product_id];
    this.priceEdits.update((m) => ({ ...m, [row.product_id]: rounded }));

    this.api.bulkUpsertPrices({ price_list_id: list, items: [{ product_id: row.product_id, price: rounded }] }).subscribe({
      // Sin toast en éxito: la celda ya muestra el valor nuevo. Un toast por
      // cada precio editado convertiría una sesión de captura en una lluvia.
      next: () => this.healthTick.update((t) => t + 1),
      error: (err) => {
        this.priceEdits.update((m) => {
          const next = { ...m };
          if (previous === undefined) delete next[row.product_id]; else next[row.product_id] = previous;
          return next;
        });
        this.toast.add({
          severity: 'error',
          summary: 'No se guardó el precio',
          detail: err?.error?.message || `${row.product_name ?? 'El producto'} quedó como estaba.`,
        });
      },
    });
  }

  confirmDeletePrice(p: PriceRow): void {
    this.confirm.confirm({
      message: `¿Quitar "${p.product_name}" de esta lista? El producto sigue en el catálogo; sólo deja de tener precio acá.`,
      header: 'Confirmar',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, quitar',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => {
        this.api.deletePrice(p.id).subscribe({
          next: () => {
            this.toast.add({ severity: 'success', summary: 'Precio quitado de la lista' });
            this.priceEdits.set({});
            this.pricesRes.reload();
            this.healthTick.update((t) => t + 1);
          },
          error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo quitar' }),
        });
      },
    });
  }

  // ── Alta / edición de lista ───────────────────────────────────────────
  openCreate(): void {
    this.editing.set(null);
    this.form.reset({ code: '', name: '', currency: 'MXN', is_default: false });
    this.form.get('code')?.enable();
    this.dialogVisible.set(true);
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
    this.dialogVisible.set(true);
  }

  /** ✕ y Escape pasan por acá: con cambios sin guardar se pregunta (DESIGN §Leyes 8). */
  onDialogVisible(v: boolean): void {
    if (v) this.dialogVisible.set(true);
    else this.closeDialog();
  }

  closeDialog(): void {
    if (!this.form.dirty) { this.dialogVisible.set(false); return; }
    this.confirm.confirm({
      message: 'Hay cambios sin guardar. ¿Descartarlos?',
      header: '¿Descartar cambios?',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, descartar',
      rejectLabel: 'Seguir editando',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => { this.form.markAsPristine(); this.dialogVisible.set(false); },
    });
  }

  save(): void {
    if (this.form.invalid) return;
    this.saving.set(true);
    const payload = this.form.getRawValue();
    const editing = this.editing();
    const obs = editing ? this.api.updatePriceList(editing.id, payload) : this.api.createPriceList(payload);
    obs.subscribe({
      next: () => {
        this.saving.set(false);
        this.form.markAsPristine();
        this.dialogVisible.set(false);
        this.toast.add({ severity: 'success', summary: editing ? 'Lista actualizada' : 'Lista creada' });
        this.load();
        this.healthTick.update((t) => t + 1);
      },
      error: (err) => {
        this.saving.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: err?.error?.message || 'No se pudo guardar' });
      },
    });
  }

  confirmDeleteList(pl: PriceList): void {
    this.confirm.confirm({
      message: `¿Desactivar la lista ${pl.name}? Los pedidos previos mantienen su precio histórico (snapshot inmutable en las líneas).`,
      header: 'Confirmar',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, desactivar',
      rejectLabel: 'Cancelar',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => {
        this.api.deletePriceList(pl.id).subscribe({
          next: () => {
            this.toast.add({ severity: 'success', summary: 'Lista desactivada' });
            if (this.selectedId() === pl.id) this.selectedId.set(null);
            this.load();
          },
          error: (err) =>
            this.toast.add({ severity: 'error', summary: 'Error', detail: err?.error?.message || 'No se pudo desactivar' }),
        });
      },
    });
  }

  // ── Export ────────────────────────────────────────────────────────────
  /** Baja TODO lo que cumple el filtro actual, no sólo la página en pantalla. */
  exportSheet(): void {
    const sel = this.selected();
    const p = this.params();
    if (!sel || !p) return;
    this.exporting.set(true);
    this.api.listPrices(p.id, { ...p, page: 1, pageSize: Math.min(Math.max(this.total(), 1), 10000) }).subscribe({
      next: async (res) => {
        try {
          const data = (res.data ?? []).map((r) => {
            const price = r.price === null || r.price === undefined ? null : Number(r.price);
            const cost = r.cost_base === null || r.cost_base === undefined ? null : Number(r.cost_base);
            return {
              ...r,
              _price: price,
              _cost: cost,
              _margin: price && price > 0 && cost && cost > 0 ? ((price - cost) / price) * 100 : null,
            };
          });
          const cols: XlsxCol<(typeof data)[number]>[] = [
            { header: 'Producto', get: (r) => r.product_name, width: 40 },
            { header: 'Marca', get: (r) => r.brand_name, width: 20 },
            { header: 'SKU', get: (r) => r.sku, width: 14 },
            { header: 'Código de barras', get: (r) => r.barcode, width: 18 },
            { header: 'Categoría', get: (r) => r.category_name, width: 22 },
            { header: 'Rotación 30d', get: (r) => r.sales_units_30d, type: 'int', width: 13 },
            { header: 'Costo', get: (r) => r._cost, type: 'money' },
            { header: 'Precio', get: (r) => r._price, type: 'money' },
            { header: 'Margen %', get: (r) => r._margin, type: 'decimal', width: 11 },
            { header: 'Mínimo', get: (r) => r.min_qty ?? 1, type: 'int', width: 9 },
          ];
          const scopeLabel = this.SCOPES.find((s) => s.key === this.scope())?.label ?? '';
          const flagLabel = FLAGS.find((f) => f.key === this.flag())?.label;
          const bits = [scopeLabel, flagLabel && `sólo ${flagLabel}`, this.searchTerm() && `búsqueda "${this.searchTerm()}"`];
          await exportXlsx(`precios-${sel.code}`, [
            {
              name: sel.code,
              title: `Precios — ${sel.name}`,
              subtitle: `${data.length.toLocaleString('es-MX')} productos · ${bits.filter(Boolean).join(' · ')} · ${sel.currency || 'MXN'}`,
              cols,
              rows: data,
            },
          ]);
        } finally {
          this.exporting.set(false);
        }
      },
      error: () => {
        this.exporting.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo exportar' });
      },
    });
  }
}
