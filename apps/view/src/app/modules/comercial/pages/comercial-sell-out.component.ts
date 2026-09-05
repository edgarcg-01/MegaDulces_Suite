import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { CheckboxModule } from 'primeng/checkbox';
import { DatePickerModule } from 'primeng/datepicker';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { InputTextModule } from 'primeng/inputtext';
import { ToastModule } from 'primeng/toast';
import { PaginatorModule, PaginatorState } from 'primeng/paginator';
import { MessageService } from 'primeng/api';
import {
  ComercialService,
  SellOutBrandRow,
  SellOutCell,
  SellOutParams,
  SellOutReport,
  SellOutView,
  SellOutWarehouseRow,
  SellOutTreeGroup,
} from '../comercial.service';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { ProductSearchComponent, ProductHit } from '../components/product-search.component';
import { REPORTS_TABS } from '../reports-tabs';

type PeriodMode = 'month' | 'quarter' | 'year' | 'range';
type Measure = 'cajas' | 'monto' | 'ambas';

const CHANNEL_OPTS = [
  { label: 'Mostrador', value: 'mostrador' },
  { label: 'Preventa', value: 'preventa' },
  { label: 'Ruta', value: 'ruta' },
  { label: 'Mayoreo', value: 'credito' },
  { label: 'Otro', value: 'otro' },
];

/** RS — Generador de reportes Sell-Out por empresa (marca/proveedor). */
@Component({
  selector: 'app-comercial-sell-out',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, SelectModule, MultiSelectModule, CheckboxModule,
    DatePickerModule, ToggleSwitchModule, InputTextModule, ToastModule, PaginatorModule,
    PageTabsComponent, SegmentedComponent, ProductSearchComponent, MetricStripComponent,
  ],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="reportTabs" />

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Sell-Out por empresa</h1>
          <p class="surf-page-sub">Venta real consolidada (Kepler + Wincaja) por producto y sucursal · exporta XLSX / PDF</p>
        </div>
        <button type="button" class="so-about-btn" [class.is-open]="aboutOpen()"
                [attr.aria-expanded]="aboutOpen()" (click)="aboutOpen.set(!aboutOpen())">
          <i class="pi pi-info-circle"></i><span>¿Qué filtra cada filtro?</span>
        </button>
      </header>

      <!-- About: qué filtra cada control (plegable) -->
      @if (aboutOpen()) {
        <div class="so-about card-premium card-flat">
          <p class="so-about-lead">
            Todos los filtros y la tabla derivan del <strong>mismo universo</strong> de venta,
            acotado al periodo que elijas — lo que aparece en un filtro es exactamente lo que suma
            en la matriz (sin doble conteo entre Kepler y Wincaja).
          </p>
          <dl class="so-about-list">
            <div><dt>Empresa</dt><dd>Marca / proveedor. Deja las filas de sus productos. Vacío = todas las empresas.</dd></div>
            <div><dt>Ver</dt><dd><b>Por canal</b> desglosa por canal · sucursal; <b>Por vendedor</b> por vendedor (mayoreo Kepler + Wincaja, y RD/RV de Wincaja).</dd></div>
            <div><dt>Formato</dt><dd>Solo «Por canal». <b>Detalle</b> = columnas dinámicas; <b>Por plaza</b> = formato estándar plaza × tipo, en cajas, con todos los SKUs.</dd></div>
            <div><dt>Periodo</dt><dd>El rango de fechas (mes, trimestre, año o rango libre). Meses cerrados salen del consolidado nocturno; el mes en curso, en vivo.</dd></div>
            <div><dt>Canal · Sucursal / Vendedor</dt><dd>Elige qué canales y sucursales (o vendedores) suman. Solo aparecen los que tienen venta en el periodo. Vacío = todos.</dd></div>
            <div><dt>Buscar SKU</dt><dd>Acota a un producto por SKU o descripción, en todas las empresas a la vez.</dd></div>
            <div><dt>Vista</dt><dd>Solo «Por canal». <b>Por producto</b>, <b>Mes en columnas</b> o <b>Resumen mensual</b> — cambia cómo se despliegan filas y columnas.</dd></div>
            <div><dt>Medida</dt><dd>Qué números se muestran: <b>Cajas</b>, <b>Monto</b> o <b>Ambas</b>. Solo afecta la vista; el total no cambia.</dd></div>
            <div><dt>Promos</dt><dd><b>Sin promos</b> (excluye marcadores de $0.01), <b>Solo promos</b> o <b>Todo</b>.</dd></div>
            <div><dt>Concentrar por</dt><dd>Colapsa el detalle en <b>un</b> total consolidado por canal, sucursal, empresa o ruta.</dd></div>
            <div><dt>Desglosar canal · Incluir sin venta</dt><dd>Abre columnas por canal / muestra también los productos que no vendieron en el periodo.</dd></div>
            <div><dt>Limpiar filtros</dt><dd>Restablece todos los controles a sus valores por defecto.</dd></div>
          </dl>
        </div>
      }

      <!-- Controles -->
      <div class="so-filters card-premium card-flat">
        <div class="so-field so-empresa">
          <label>Empresa</label>
          <p-select [options]="brands()" [ngModel]="brandId()" (ngModelChange)="brandId.set($event)" optionLabel="nombre" optionValue="id"
                    [filter]="true" filterBy="nombre,code" [showClear]="true" placeholder="Todas las empresas"
                    [loading]="loadingBrands()" appendTo="body" styleClass="w-full"
                    (onChange)="generate()" (onClear)="generate()">
            <ng-template let-b #item>
              <span>{{ b.nombre }}</span>
              <span class="so-badge">{{ b.products }}</span>
            </ng-template>
          </p-select>
        </div>

        <div class="so-field">
          <label>Ver</label>
          <app-segmented [options]="reportModeOpts" [value]="reportMode()" (valueChange)="setReportMode($event)" ariaLabel="Modo del reporte" />
        </div>

        @if (reportMode() === 'canal') {
          <div class="so-field">
            <label>Formato</label>
            <app-segmented [options]="layoutOpts" [value]="layout()" (valueChange)="setLayout($event)" ariaLabel="Formato del reporte" />
          </div>
        }

        <div class="so-field">
          <label>Periodo</label>
          <app-segmented [options]="modeOpts" [value]="periodMode()" (valueChange)="setMode($event)" ariaLabel="Periodo" />
        </div>

        @switch (periodMode()) {
          @case ('month') {
            <div class="so-field">
              <label>Mes</label>
              <p-datepicker [(ngModel)]="monthDate" view="month" dateFormat="MM yy" [showIcon]="true"
                            appendTo="body" (onSelect)="refreshPeriod()" (onClose)="refreshPeriod()" />
            </div>
          }
          @case ('quarter') {
            <div class="so-field">
              <label>Trimestre</label>
              <p-select [options]="quarterOpts" [(ngModel)]="quarter" optionLabel="label" optionValue="value"
                        appendTo="body" (onChange)="refreshPeriod()" />
            </div>
            <div class="so-field so-year">
              <label>Año</label>
              <p-select [options]="yearOpts()" [(ngModel)]="year" appendTo="body" (onChange)="refreshPeriod()" />
            </div>
          }
          @case ('year') {
            <div class="so-field so-year">
              <label>Año</label>
              <p-select [options]="yearOpts()" [(ngModel)]="year" appendTo="body" (onChange)="refreshPeriod()" />
            </div>
          }
          @case ('range') {
            <div class="so-field">
              <label>Rango</label>
              <p-datepicker [(ngModel)]="rangeDates" selectionMode="range" dateFormat="dd/mm/yy"
                            [showIcon]="true" appendTo="body" (onSelect)="refreshPeriod()" (onClose)="refreshPeriod()" />
            </div>
          }
        }

        <div class="so-field">
          <label>{{ reportMode() === 'vendedor' ? 'Vendedor' : 'Canal · Sucursal' }}</label>
          <button type="button" class="so-slicer-btn" [class.is-open]="slicerOpen()" [class.has-val]="selectedCount() > 0"
                  [attr.aria-expanded]="slicerOpen()"
                  [attr.aria-label]="(reportMode() === 'vendedor' ? 'Vendedor' : 'Canal y sucursal') + ': ' + (selectedCount() ? selectedCount() + ' seleccionados' : 'Todos')"
                  (click)="slicerOpen.set(!slicerOpen())">
            <i class="pi pi-sitemap so-slicer-lead"></i>
            <span class="so-slicer-val">{{ selectedCount() ? (selectedCount() + ' seleccionados') : 'Todos' }}</span>
            <i class="pi so-slicer-caret" [class.pi-chevron-down]="!slicerOpen()" [class.pi-chevron-up]="slicerOpen()"></i>
          </button>
        </div>

        <div class="so-field so-search-field">
          <label>Buscar SKU</label>
          <app-product-search [includeInactive]="true" placeholder="SKU (5 díg.) o descripción…" (productSelected)="onProductPick($event)" />
        </div>

        @if (reportMode() === 'canal' && layout() !== 'plaza') {
          <div class="so-field">
            <label>Vista</label>
            <app-segmented [options]="viewOpts" [value]="view()" (valueChange)="setView($event)" ariaLabel="Vista del reporte" />
          </div>
        }

        <div class="so-field">
          <label>Medida</label>
          <app-segmented [options]="measureOpts" [value]="measure()" (valueChange)="setMeasure($event)" ariaLabel="Medida" />
        </div>

        <div class="so-field">
          <label>Promos</label>
          <app-segmented [options]="promoOpts" [value]="promo()" (valueChange)="setPromo($event)" ariaLabel="Filtro de promociones" />
        </div>

        <div class="so-field">
          <label>Concentrar por</label>
          <app-segmented [options]="concentrarOpts" [value]="concentrar()" (valueChange)="setConcentrar($event)" ariaLabel="Concentrado por dimensión" />
        </div>

        @if (reportMode() === 'canal' && layout() !== 'plaza') {
          <div class="so-field so-toggles">
            @if (view() !== 'month_columns') {
              <label class="so-toggle"><p-toggleswitch [(ngModel)]="byChannel" /> <span>Desglosar canal</span></label>
            }
            @if (view() !== 'month_summary') {
              <label class="so-toggle"><p-toggleswitch [(ngModel)]="includeZeros" /> <span>Incluir sin venta</span></label>
            }
          </div>
        }

        <div class="so-field so-reset-field">
          <label>&nbsp;</label>
          <button type="button" class="so-reset" (click)="resetFilters()" title="Restablecer todos los filtros a sus valores por defecto">
            <i class="pi pi-filter-slash"></i><span>Limpiar filtros</span>
          </button>
        </div>
      </div>

      <!-- RS.4 — Slicer jerárquico Canal→Sucursal / Grupo→Vendedor -->
      @if (slicerOpen()) {
        <div class="so-slicer card-premium card-flat">
          <div class="so-slicer-head">
            <span>{{ reportMode() === 'vendedor' ? 'Filtrar por vendedor (solo Wincaja)' : 'Filtrar por canal y sucursal' }}</span>
            <span class="so-slicer-actions">
              <button type="button" class="so-link" (click)="clearCells()">Limpiar</button>
              <button type="button" class="so-apply" (click)="applyCells()">Aplicar</button>
            </span>
          </div>
          <div class="so-slicer-groups">
            @for (g of activeTree(); track g.group) {
              <div class="so-slicer-col">
                <label class="so-slicer-group">
                  <p-checkbox [binary]="true" [ngModel]="groupAllSel(g)" (onChange)="toggleGroup(g)" />
                  <span>{{ g.group_label }}</span>
                </label>
                @for (leaf of g.leaves; track leaf.code) {
                  <label class="so-slicer-leaf">
                    <p-checkbox [binary]="true" [ngModel]="isLeafSel(g, leaf)" (onChange)="toggleLeaf(g, leaf)" />
                    <span>{{ leaf.name }}</span>
                  </label>
                }
              </div>
            } @empty {
              <p class="so-slicer-empty">Sin datos para este modo.</p>
            }
          </div>
        </div>
      }

      <div class="so-actions">
        <button pButton size="small" [loading]="loading()" (click)="generate()"><span class="p-button-icon p-button-icon-left pi pi-search" aria-hidden="true"></span><span class="p-button-label">Generar</span></button>
      </div>

      @if (loading()) {
        <div class="so-skel" aria-hidden="true">
          <div class="so-skel-bar shim"></div>
          <div class="so-kpi-grid">
            <div class="so-skel-card shim"></div>
            <div class="so-skel-card shim"></div>
            <div class="so-skel-card shim"></div>
            <div class="so-skel-card shim"></div>
          </div>
          <div class="so-skel-table">
            @for (i of skelRows; track i) { <div class="so-skel-row shim"></div> }
          </div>
        </div>
      } @else {
        @if (report(); as r) {
        <!-- Eco de la consulta + descargas -->
        <div class="so-actions-bar">
          @if (meta(); as m) {
            <div class="so-echo">
              <strong>{{ m.brand }}</strong>
              <span class="so-echo-sep">·</span><span>{{ m.period }}</span>
              <span class="so-echo-sep">·</span><span>{{ m.channels }}</span>
            </div>
          }
          <div class="so-dl">
            <button pButton size="small" severity="secondary" [outlined]="true" [loading]="dl() === 'xlsx'" (click)="download('xlsx')"><span class="p-button-icon p-button-icon-left pi pi-file-excel" aria-hidden="true"></span><span class="p-button-label">XLSX</span></button>
            <button pButton size="small" severity="secondary" [outlined]="true" [loading]="dl() === 'pdf'" (click)="download('pdf')"><span class="p-button-icon p-button-icon-left pi pi-file-pdf" aria-hidden="true"></span><span class="p-button-label">PDF</span></button>
          </div>
        </div>

        <!-- KPIs (MetricStrip compartido, sin caja) -->
        <app-metric-strip [items]="kpiItems()" ariaLabel="Resumen del sell-out" />

        @if (concentrar()) {
          <!-- CONCENTRADO: un total consolidado por dimensión (colapsa el detalle) -->
          <div class="card-premium card-flat so-conc">
            <div class="so-conc-head">
              <span class="so-conc-badge">Concentrado por {{ concentrarLabel() }}</span>
              <span class="so-conc-scope">{{ concentradoCount() }} {{ concentradoNoun().toLowerCase() }} con venta · {{ (meta()?.period) || '' }}</span>
            </div>
            <div class="so-conc-grid">
              <div class="so-conc-kpi"><span class="k-lbl">Monto consolidado</span><span class="k-val">{{ r.grand_total.monto | currency:'MXN':'symbol-narrow':'1.0-0' }}</span></div>
              <div class="so-conc-kpi"><span class="k-lbl">Cajas</span><span class="k-val">{{ r.grand_total.cajas | number:'1.0-1' }}</span></div>
              <div class="so-conc-kpi"><span class="k-lbl">{{ concentradoNoun() }}</span><span class="k-val">{{ concentradoCount() }}</span></div>
              <div class="so-conc-kpi"><span class="k-lbl">Productos</span><span class="k-val">{{ r.rows.length | number }}</span></div>
            </div>
          </div>
        }

        <!--
          [VP.0.3] El reporte declara la EDAD del dato con el que se calculó, no la hora en que
          respondio el servidor. Las matvistas que arman este pivote se refrescan de noche; si una
          falla, los guards de poblado no lo ven (relispopulated queda en true para siempre) y el
          reporte sale con una pierna vieja y otra fresca sin decir nada. Eso es exactamente "los
          numeros cambiaron y nadie toco nada". No bloquea: declara, y nombra el eslabon.
        -->
        @if (r.freshness.status !== 'fresh') {
          <p class="so-note so-note-stale" role="status">
            <i class="pi" [class.pi-clock]="r.freshness.status === 'stale'"
               [class.pi-question-circle]="r.freshness.status === 'unknown'"></i>
            @if (r.freshness.status === 'stale') {
              <strong>Datos de hace {{ r.freshness.age_human }}</strong> — el consolidado nocturno no corrio.
            } @else {
              <strong>No se pudo verificar que tan actual es este consolidado.</strong>
            }
            @if (staleLanes(r).length) {
              <span class="so-note-lanes">
                @for (i of staleLanes(r); track i.key) {
                  {{ i.label }}: {{ i.age_human || 'sin señal' }}{{ $last ? '' : ' · ' }}
                }
              </span>
            }
          </p>
        }

        @if (r.coverage.note) {
          <p class="so-note"><i class="pi pi-info-circle"></i> {{ r.coverage.note }}</p>
        }

        @if (r.rows.length && !concentrar()) {
          <!-- Matriz (dentro de card premium, como las secciones de reports) -->
          <div class="card-premium card-flat so-matrix-card">
            <div class="so-matrix-head">
              <h3 class="text-sm font-bold text-content-main">{{ matrixTitle(r) }}</h3>
              <span class="so-matrix-count">{{ r.rows.length | number }} {{ rowNoun(r) }} · {{ r.columns.length }} columnas@if (totalRows() > pageSize()) { <span class="so-matrix-page">· viendo {{ pageLabel() }}</span> }</span>
            </div>
          <div class="so-matrix-wrap">
            <table class="so-matrix">
              <thead>
                <tr>
                  @if (r.row_dim === 'month') {
                    <th class="frz c0 only" rowspan="2">Mes</th>
                  } @else {
                    <th class="frz c0" rowspan="2">Código</th>
                    <th class="frz c1" rowspan="2">{{ r.row_dim === 'brand' ? 'Empresa' : 'Descripción' }}</th>
                    <th class="frz c2" rowspan="2">UXC</th>
                  }
                  @for (c of r.columns; track c.key) { <th [attr.colspan]="grpColspan()" class="grp">{{ colLabel(c) }}</th> }
                  <th [attr.colspan]="grpColspan()" class="grp tot">TOTAL</th>
                </tr>
                <tr>
                  @for (c of r.columns; track c.key) {
                    @if (showCajas()) { <th class="sub">Cajas</th> }
                    @if (showMonto()) { <th class="sub m">Monto</th> }
                  }
                  @if (showCajas()) { <th class="sub">Cajas</th> }
                  @if (showMonto()) { <th class="sub m">Monto</th> }
                </tr>
              </thead>
              <tbody>
                @for (row of pagedRows(); track row.product_id) {
                  <tr [class.so-drill]="r.row_dim === 'brand'"
                      (click)="r.row_dim === 'brand' && drillBrand(row)"
                      [attr.title]="r.row_dim === 'brand' ? 'Ver productos de ' + row.nombre : null">
                    @if (r.row_dim === 'month') {
                      <td class="frz c0 only name">{{ row.nombre }}</td>
                    } @else {
                      <td class="frz c0 mono">{{ row.sku }}</td>
                      <td class="frz c1 name">{{ row.nombre }}
                        @if (row.unit_kind === 'weight') { <span class="so-kg-tag" title="Producto a granel: la cantidad está en kilos, no en cajas">granel</span> }
                      </td>
                      <td class="frz c2 n">{{ row.unit_kind === 'weight' ? 'kg' : (row.uxc ?? '—') }}</td>
                    }
                    @for (c of r.columns; track c.key) {
                      @if (showCajas()) { <td class="n">{{ cell(row, c.key)?.cajas != null ? (cell(row, c.key)!.cajas | number:'1.0-2') : '·' }}</td> }
                      @if (showMonto()) { <td class="n m">{{ cell(row, c.key)?.monto != null ? (cell(row, c.key)!.monto | currency:'MXN':'symbol-narrow':'1.0-0') : '·' }}</td> }
                    }
                    @if (showCajas()) { <td class="n b">{{ row.total.cajas | number:'1.0-2' }}</td> }
                    @if (showMonto()) { <td class="n m b">{{ row.total.monto | currency:'MXN':'symbol-narrow':'1.0-0' }}</td> }
                  </tr>
                }
              </tbody>
              <tfoot>
                <tr class="tot-row">
                  <td class="frz c0" [attr.colspan]="r.row_dim === 'month' ? 1 : 3">TOTAL</td>
                  @for (c of r.columns; track c.key) {
                    @if (showCajas()) { <td class="n">{{ colTotal(r, c.key).cajas | number:'1.0-2' }}</td> }
                    @if (showMonto()) { <td class="n m">{{ colTotal(r, c.key).monto | currency:'MXN':'symbol-narrow':'1.0-0' }}</td> }
                  }
                  @if (showCajas()) { <td class="n">{{ r.grand_total.cajas | number:'1.0-2' }}</td> }
                  @if (showMonto()) { <td class="n m">{{ r.grand_total.monto | currency:'MXN':'symbol-narrow':'1.0-0' }}</td> }
                </tr>
              </tfoot>
            </table>
          </div>
          @if (totalRows() > pageSize()) {
            <p-paginator [first]="page() * pageSize()" [rows]="pageSize()" [totalRecords]="totalRows()"
                         [rowsPerPageOptions]="[50, 100, 200]" (onPageChange)="onPage($event)"
                         styleClass="so-pager"
                         currentPageReportTemplate="{first} – {last} de {totalRecords}"
                         [showCurrentPageReport]="true" />
          }
          </div>
        } @else if (!concentrar()) {
          <div class="comm-empty"><div class="comm-empty-icon"><i class="pi pi-inbox"></i></div>
            <h3>Sin venta en el periodo</h3><p>No hay ventas de esta empresa en el rango elegido.</p></div>
        }
        } @else {
          <div class="comm-empty"><div class="comm-empty-icon"><i class="pi pi-file-excel"></i></div>
            <h3>Generá un reporte</h3><p>Elegí empresa y periodo, luego «Generar».</p></div>
        }
      }
    </div>
  `,
  styles: [`
    :host { display:block; }
    /* About: botón en el head + panel plegable con la leyenda de cada filtro. */
    .so-about-btn { display:inline-flex; align-items:center; gap:.4rem; align-self:center; white-space:nowrap;
      background:var(--card-bg); border:1px solid var(--border-color); border-radius:var(--r-sm,8px);
      color:var(--text-muted); font-size:.8rem; font-weight:600; cursor:pointer; padding:.4rem .7rem;
      transition:border-color .15s ease, color .15s ease, background-color .15s ease; }
    .so-about-btn:hover { border-color:var(--action); color:var(--text-main); }
    .so-about-btn.is-open { border-color:var(--action); color:var(--action); box-shadow:0 0 0 2px var(--action-ring); }
    .so-about-btn i { font-size:.85rem; }
    .so-about { padding:1rem 1.25rem; margin-bottom:1rem; }
    .so-about-lead { margin:0 0 .85rem; font-size:.82rem; line-height:1.5; color:var(--text-muted); }
    .so-about-lead strong { color:var(--text-main); font-weight:700; }
    .so-about-list { display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:.55rem 1.5rem; margin:0; }
    .so-about-list > div { display:grid; grid-template-columns:minmax(9rem,auto) 1fr; gap:.6rem; align-items:baseline;
      padding-bottom:.5rem; border-bottom:1px solid var(--border-color); }
    .so-about-list dt { font-size:.78rem; font-weight:700; color:var(--text-main); }
    .so-about-list dd { margin:0; font-size:.78rem; line-height:1.45; color:var(--text-muted); }
    .so-about-list dd b { color:var(--text-main); font-weight:600; }
    .so-filters { display:flex; flex-wrap:wrap; gap:.75rem 1rem; align-items:flex-end; margin-bottom:1rem; }
    .so-field { display:flex; flex-direction:column; gap:.3rem; }
    .so-field > label { font-size:.72rem; font-weight:600; color:var(--text-muted); text-transform:uppercase; letter-spacing:.03em; }
    .so-empresa { flex:0 1 300px; min-width:240px; }
    .so-search-field { flex:0 1 260px; min-width:200px; }
    .so-search-field app-product-search { display:block; width:100%; }
    :host ::ng-deep .so-search-field .ps-ac,
    :host ::ng-deep .so-search-field .ps-ac .p-autocomplete-input { width:100%; min-width:0; }
    .so-year { max-width:110px; }
    .so-badge { margin-left:.5rem; font-size:.7rem; color:var(--text-muted); }
    /* segmented → app-segmented (átomo compartido) */
    .so-toggles { flex-direction:row; gap:1rem; align-items:center; }
    /* RS.4 — slicer jerárquico Canal/Vendedor */
    /* Trigger tipo select (consistente con los p-select de la barra): mismo alto,
       radio, hover, foco anillado y estado "abierto". */
    .so-slicer-btn { display:inline-flex; align-items:center; gap:.5rem; width:100%; min-width:13rem;
      min-height:2.5rem; padding:.4rem .75rem;
      background:var(--card-bg); border:1px solid var(--border-color); border-radius:var(--r-md);
      font-size:.82rem; color:var(--text-main); cursor:pointer; justify-content:space-between;
      transition:border-color .15s ease, box-shadow .15s ease, background-color .15s ease; }
    .so-slicer-btn:hover { border-color:var(--action); background:var(--surface-hover-bg); }
    .so-slicer-btn:focus-visible { outline:none; border-color:var(--action); box-shadow:0 0 0 2px var(--action-ring); }
    .so-slicer-btn.is-open { border-color:var(--action); box-shadow:0 0 0 2px var(--action-ring); }
    .so-slicer-lead { color:var(--text-muted); font-size:.85rem; }
    .so-slicer-val { flex:1; text-align:left; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .so-slicer-btn.has-val .so-slicer-val { font-weight:600; }
    .so-slicer-caret { color:var(--text-muted); font-size:.72rem; }
    .so-slicer { margin-bottom:1rem; padding:.9rem 1rem; }
    .so-slicer-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:.75rem;
      font-size:.82rem; font-weight:700; color:var(--text-main); }
    .so-slicer-actions { display:flex; gap:.5rem; }
    .so-link { background:none; border:none; color:var(--text-muted); font-size:.78rem; cursor:pointer; padding:.2rem .4rem; }
    .so-link:hover { color:var(--text-main); }
    .so-apply { background:var(--action); color:#fff; border:none; border-radius:var(--r-xs,6px); font-size:.78rem;
      font-weight:600; cursor:pointer; padding:.28rem .7rem; }
    .so-reset { display:inline-flex; align-items:center; gap:.4rem; background:none; color:var(--text-muted);
      border:1px solid var(--border-color); border-radius:var(--r-xs,6px); font-size:.8rem; cursor:pointer;
      padding:.4rem .7rem; white-space:nowrap; }
    .so-reset:hover { color:var(--bad-fg); border-color:var(--bad-border,var(--bad-fg)); }
    .so-slicer-groups { display:flex; flex-wrap:wrap; gap:1.5rem; }
    .so-slicer-col { display:flex; flex-direction:column; gap:.35rem; min-width:11rem; }
    .so-slicer-group { display:flex; align-items:center; gap:.5rem; font-weight:700; font-size:.8rem;
      color:var(--text-main); padding-bottom:.3rem; border-bottom:1px solid var(--border-color); margin-bottom:.15rem; }
    .so-slicer-leaf { display:flex; align-items:center; gap:.5rem; font-size:.8rem; color:var(--text-main);
      cursor:pointer; padding-left:.3rem; }
    .so-slicer-empty { color:var(--text-muted); font-size:.82rem; }
    .so-toggle { display:inline-flex; align-items:center; gap:.4rem; font-size:.8rem; color:var(--text-main); }
    .so-actions { margin-left:auto; }
    .so-actions-bar { display:flex; align-items:center; justify-content:space-between; gap:1rem; flex-wrap:wrap; margin-bottom:1rem; }
    .so-echo { display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; font-size:.85rem; color:var(--text-muted); }
    .so-echo strong { color:var(--text-main); font-weight:700; }
    .so-echo-sep { color:var(--text-faint); }
    .so-dl { display:flex; gap:.5rem; margin-left:auto; }
    /* KPI grid — mismo lenguaje que /dashboard/reports (card-premium + rk-card). */
    app-metric-strip { display:block; margin-bottom:1rem; }
    .so-note { font-size:.78rem; color:var(--text-muted); background:var(--layout-bg); border:1px solid var(--border-color);
      border-radius:var(--r-sm); padding:.5rem .7rem; margin:0 0 1rem; display:flex; gap:.4rem; align-items:baseline; flex-wrap:wrap; }
    /* [VP.0.3] Condicion del DATO, no de una accion: tono warn y no se puede cerrar. */
    .so-note-stale { color:var(--warn-fg); border-color:color-mix(in srgb, var(--warn-fg) 35%, var(--border-color)); }
    .so-note-stale strong { font-weight:700; }
    .so-note-lanes { flex-basis:100%; opacity:.85; font-size:var(--fs-xs,.72rem); padding-left:1.2rem; }
    /* Concentrado: total consolidado por dimensión */
    .so-conc { padding:1.25rem 1.5rem; margin-top:1rem; }
    .so-conc-head { display:flex; align-items:baseline; gap:.75rem; flex-wrap:wrap; margin-bottom:1rem; }
    .so-conc-badge { font-size:var(--fs-sm,.8rem); font-weight:700; letter-spacing:.02em; color:var(--action); text-transform:uppercase; }
    .so-conc-scope { font-size:var(--fs-xs,.75rem); color:var(--text-faint); }
    .so-conc-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:1rem; }
    .so-conc-kpi { display:flex; flex-direction:column; gap:.2rem; }
    .so-conc-kpi .k-lbl { font-size:var(--fs-xs,.72rem); color:var(--text-faint); text-transform:uppercase; letter-spacing:.03em; }
    .so-conc-kpi .k-val { font-size:1.6rem; font-weight:700; color:var(--text-main); line-height:1.1; }
    .so-matrix-card { padding:1.25rem; }
    .so-matrix-head { display:flex; align-items:center; justify-content:space-between; gap:.75rem; margin-bottom:.75rem; flex-wrap:wrap; }
    .so-matrix-tools { display:flex; align-items:center; gap:1rem; }
    .so-matrix-count { font-size:var(--fs-xs); color:var(--text-muted); }
    /* Cuántas filas se están viendo del total — la matriz pagina, el TOTAL del pie no. */
    .so-matrix-page { color:var(--text-faint); font-variant-numeric:tabular-nums; margin-left:.25rem; }
    /* Paginación abajo de la tabla (Jakob: tabla = Excel). Hairline superior, sin caja. */
    :host ::ng-deep .so-pager { border-top:1px solid var(--border-color); margin-top:.5rem; padding-top:.25rem; background:transparent; }
    :host ::ng-deep .so-pager .p-paginator { background:transparent; padding:.25rem 0; font-size:var(--fs-xs); }
    /* Buscador de producto: el input neutraliza el outline global (input:focus !important). */
    .so-search { display:inline-flex; align-items:center; gap:.4rem; height:32px; width:240px; max-width:100%;
      background:var(--card-bg); border:1px solid var(--border-color); border-radius:var(--r-sm,8px); padding:0 .5rem;
      transition:border-color 120ms var(--ease-standard); }
    .so-search:focus-within { border-color:var(--action); box-shadow:0 0 0 3px var(--action-ring); }
    .so-search > i { color:var(--text-faint); font-size:var(--fs-sm,.85rem); flex-shrink:0; }
    .so-search input { flex:1; min-width:0; border:none !important; outline:none !important; box-shadow:none !important;
      background:transparent; font-size:.8rem; color:var(--text-main); padding:0; height:28px; }
    .so-search input::placeholder { color:var(--text-faint); }
    .so-search-clear { background:transparent; border:none; width:20px; height:20px; border-radius:4px; flex-shrink:0;
      color:var(--text-faint); cursor:pointer; display:grid; place-items:center; font-size:var(--fs-xs,.75rem); }
    .so-search-clear:hover { color:var(--text-main); background:var(--hover-bg); }
    .so-matrix-empty { text-align:center; color:var(--text-muted); padding:1.5rem; }
    .so-matrix-wrap { overflow-x:auto; border:1px solid var(--border-color); border-radius:var(--r-md); }
    .so-matrix { border-collapse:separate; border-spacing:0; font-size:.78rem; white-space:nowrap; min-width:100%; --so-h1:2.15rem; }
    /* Reglas horizontales solamente; verticales SOLO en fronteras de grupo (look de reporte, no de hoja de cálculo). */
    .so-matrix th, .so-matrix td { border-bottom:1px solid var(--border-color); padding:.34rem .6rem; }
    .so-matrix thead th { background:var(--layout-bg); font-weight:700; text-align:center; position:sticky; top:0; z-index:2; }
    /* Header de 2 niveles: la sub-fila (Cajas/Monto) baja bajo la fila de grupos, si no se solapan al hacer scroll. */
    .so-matrix thead tr:first-child th { height:var(--so-h1); top:0; }
    .so-matrix thead tr:nth-child(2) th { top:var(--so-h1); border-bottom:2px solid var(--border-color); }
    .so-matrix thead th.c0, .so-matrix thead th.c1 { text-align:left; }
    .so-matrix thead th.c2 { text-align:right; }
    .so-matrix thead th.grp { text-align:center; font-size:.72rem; border-right:1px solid var(--border-color); }
    .so-matrix thead th.grp.tot { background:var(--surface-selected-bg); }
    /* Sub-headers Cajas/Monto: micro-label alineado a su número. */
    .so-matrix .sub { font-size:.66rem; font-weight:700; color:var(--text-muted); text-transform:uppercase; letter-spacing:.04em; text-align:right; }
    /* Separador continuo en cada frontera de grupo-sucursal (fin de cada Monto). */
    .so-matrix .m { border-right:1px solid var(--border-color); }
    /* Números: Cajas = secundario (muted), Monto = primario (fuerte). */
    .so-matrix td.n { text-align:right; font-variant-numeric:tabular-nums; min-width:64px; }
    .so-matrix td.n:not(.m):not(.b) { color:var(--text-muted); }
    .so-matrix td.name { max-width:280px; overflow:hidden; text-overflow:ellipsis; }
    /* RS.3 — marca de producto a granel: su cantidad va en kg, no en cajas. */
    .so-kg-tag { display:inline-block; margin-left:.4rem; font-size:.62rem; font-weight:700; text-transform:uppercase;
      letter-spacing:.04em; color:var(--text-muted); border:1px solid var(--border-color); border-radius:var(--r-xs,4px);
      padding:.02rem .28rem; vertical-align:middle; }
    .so-matrix td.mono { font-family:var(--font-mono); font-size:.74rem; }
    .so-matrix td.b { font-weight:700; }
    /* Bloque congelado: identidad del producto; divisores internos suaves + sombra de borde. */
    .so-matrix .frz { position:sticky; background:var(--card-bg); z-index:1; }
    .so-matrix thead .frz { z-index:3; }
    .so-matrix .c0, .so-matrix .c1 { border-right:1px solid var(--border-color); }
    .so-matrix .c0 { left:0; } .so-matrix .c1 { left:70px; } .so-matrix .c2 { left:350px; }
    .so-matrix .c2 { box-shadow:6px 0 6px -4px rgba(0,0,0,.16); }
    /* Resumen mensual: única columna congelada (Mes) → borde + sombra propios. */
    .so-matrix .c0.only { border-right:1px solid var(--border-color); box-shadow:6px 0 6px -4px rgba(0,0,0,.16); text-align:left; min-width:120px; }
    /* Columna TOTAL: resumen destacado (tinte + borde izquierdo marcado, header→foot). */
    .so-matrix tbody td:last-child, .so-matrix tbody td:nth-last-child(2),
    .so-matrix tfoot td:last-child, .so-matrix tfoot td:nth-last-child(2) { background:var(--surface-selected-bg); }
    .so-matrix tbody td:nth-last-child(2),
    .so-matrix tfoot td:nth-last-child(2),
    .so-matrix thead tr:first-child th.tot,
    .so-matrix thead tr:nth-child(2) th:nth-last-child(2) { border-left:2px solid var(--border-color); }
    .so-matrix tbody tr:hover td:not(.frz) { background:var(--table-hover); }
    .so-matrix tbody tr:hover td.frz { background:var(--hover-bg); }
    /* Reporte general: filas de empresa clicables (drill a productos). */
    .so-matrix tbody tr.so-drill { cursor:pointer; }
    .so-matrix tbody tr.so-drill:hover td.frz.c1 { color:var(--action); }
    .so-matrix tfoot td { position:sticky; bottom:0; background:var(--surface-selected-bg); font-weight:700; z-index:2; }
    /* Skeleton de carga (mientras se genera el reporte) */
    .so-skel { display:flex; flex-direction:column; gap:1rem; }
    .so-skel-bar { height:2rem; width:min(420px,60%); border-radius:var(--r-sm); }
    .so-skel-card { height:104px; border-radius:var(--r-md); }
    .so-skel-table { display:flex; flex-direction:column; gap:.4rem; border:1px solid var(--border-color); border-radius:var(--r-md); padding:.75rem; }
    .so-skel-row { height:1.9rem; border-radius:var(--r-sm); }
    .shim { position:relative; overflow:hidden; background:var(--skeleton-bg); }
    .shim::after { content:''; position:absolute; inset:0; transform:translateX(-100%);
      background:linear-gradient(90deg,transparent,rgba(255,255,255,.22),transparent); animation:so-shim 1.2s infinite; }
    @keyframes so-shim { 100% { transform:translateX(100%); } }
    /* Congelado responsive: en móvil solo Código queda fijo (los px de c1/c2 comen el viewport). */
    @media (max-width:640px) {
      .so-matrix .c1, .so-matrix .c2 { position:static; }
      .so-matrix .c2 { box-shadow:none; }
      .so-matrix .c0 { box-shadow:6px 0 6px -4px rgba(0,0,0,.16); }
    }
    @media (prefers-reduced-motion:reduce) { .shim::after { animation:none; } }
  `],
})
export class ComercialSellOutComponent {
  readonly reportTabs = REPORTS_TABS;
  readonly channelOpts = CHANNEL_OPTS;
  readonly modes: { key: PeriodMode; label: string }[] = [
    { key: 'month', label: 'Mes' },
    { key: 'quarter', label: 'Trimestre' },
    { key: 'year', label: 'Año' },
    { key: 'range', label: 'Rango' },
  ];
  readonly quarterOpts = [
    { label: 'Q1 (Ene–Mar)', value: 1 },
    { label: 'Q2 (Abr–Jun)', value: 2 },
    { label: 'Q3 (Jul–Sep)', value: 3 },
    { label: 'Q4 (Oct–Dic)', value: 4 },
  ];

  private readonly svc = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  // Persistencia de filtros en localStorage (mismo patrón que /compras/pedido) →
  // se mantienen al cambiar de tab, navegar y hasta un reload completo.
  private static readonly FKEY = 'sell-out-filters:v1';

  brands = signal<SellOutBrandRow[]>([]);
  loadingBrands = signal(false);
  loading = signal(false);
  dl = signal<'' | 'xlsx' | 'pdf'>('');
  report = signal<SellOutReport | null>(null);

  // ── Paginación de la matriz (DESIGN §datos densos 7) ─────────────────────────
  // La matriz pintaba TODAS las filas: con una empresa grande son miles de <tr> ×
  // (columnas × 2 subcolumnas) → el DOM explota y el scroll se arrastra. El reporte
  // llega completo en un payload, así que la página se corta en cliente: el TOTAL del
  // pie NO se toca (viene de r.column_totals / r.grand_total, calculados en el server
  // sobre TODO el periodo) y el export XLSX sigue exportando el set completo.
  readonly page = signal(0);
  readonly pageSize = signal(50);
  readonly totalRows = computed(() => this.report()?.rows.length ?? 0);
  readonly pagedRows = computed(() => {
    const rows = this.report()?.rows ?? [];
    const from = this.page() * this.pageSize();
    return rows.slice(from, from + this.pageSize());
  });
  /** Lectura en llano de qué se está viendo (§Q.2), no sólo el total crudo. */
  readonly pageLabel = computed(() => {
    const total = this.totalRows();
    if (!total) return '';
    const from = this.page() * this.pageSize();
    return `${(from + 1).toLocaleString('es-MX')}–${Math.min(from + this.pageSize(), total).toLocaleString('es-MX')} de ${total.toLocaleString('es-MX')}`;
  });
  onPage(e: PaginatorState) {
    this.page.set(e.page ?? 0);
    this.pageSize.set(e.rows ?? 50);
  }
  readonly kpiItems = computed<MetricStripItem[]>(() => {
    const r = this.report();
    if (!r) return [];
    return [
      { label: 'Monto total', value: r.grand_total.monto, format: 'currency', sub: 'Sell-out del periodo' },
      { label: 'Cajas', value: r.grand_total.cajas, format: 'decimal1', sub: 'Unidades ÷ UXC' },
      { label: this.rowNounCap(r), value: r.rows.length, sub: r.row_dim === 'brand' ? 'Con venta · click para ver' : r.row_dim === 'month' ? 'Meses con venta' : 'Con venta en el periodo' },
      { label: 'Sucursales', value: r.coverage.branches_with_data.length, sub: r.columns.length + ' columnas' },
    ];
  });
  meta = signal<{ brand: string; period: string; channels: string } | null>(null);
  // Filtro por producto (SKU/descr) — server-side, aplica en TODAS las empresas.
  search = signal('');
  readonly skelRows = [0, 1, 2, 3, 4, 5, 6];
  readonly modeOpts = this.modes.map((m) => ({ label: m.label, value: m.key }));

  // form state
  brandId = signal<string | null>(null);
  periodMode = signal<PeriodMode>('month');
  // Medida visible en la matriz (display-only; el backend siempre trae cajas+monto).
  measure = signal<Measure>('ambas');
  readonly measureOpts = [
    { label: 'Cajas', value: 'cajas' },
    { label: 'Monto', value: 'monto' },
    { label: 'Ambas', value: 'ambas' },
  ];
  showCajas = computed(() => this.measure() !== 'monto');
  showMonto = computed(() => this.measure() !== 'cajas');
  grpColspan = computed(() => (this.measure() === 'ambas' ? 2 : 1));
  setMeasure(m: string) { this.measure.set(m as Measure); }
  // RS — filtro de promos: sin (default, excluye marcadores $0.01) / solo / todo.
  promo = signal<'sin' | 'solo' | 'todo'>('sin');
  readonly promoOpts = [
    { label: 'Sin promos', value: 'sin' },
    { label: 'Solo promos', value: 'solo' },
    { label: 'Todo', value: 'todo' },
  ];
  setPromo(p: string) { this.promo.set(p as 'sin' | 'solo' | 'todo'); this.generate(); }
  // RS — CONCENTRADO: colapsa el detalle y muestra UN total consolidado por dimensión.
  // '' = off (matriz normal). 'ruta' además acota el alcance al canal ruta.
  concentrar = signal<'' | 'ruta' | 'canal' | 'sucursal' | 'empresa'>('');
  readonly concentrarOpts = [
    { label: 'Ninguno', value: '' },
    { label: 'Ruta', value: 'ruta' },
    { label: 'Canal', value: 'canal' },
    { label: 'Sucursal', value: 'sucursal' },
    { label: 'Empresa', value: 'empresa' },
  ];
  setConcentrar(v: string) { this.concentrar.set(v as '' | 'ruta' | 'canal' | 'sucursal' | 'empresa'); this.generate(); }
  /**
   * [VP.0.3] Los eslabones que fallan, para que el aviso nombre algo accionable ("la MV de Kepler
   * lleva 3 días") y no un genérico "hay rezago" que nadie sabe a quién escalar.
   */
  staleLanes(r: SellOutReport) { return (r.freshness?.inputs || []).filter((i) => i.stale); }

  private readonly concLabels: Record<string, string> = { ruta: 'Rutas', canal: 'Canales', sucursal: 'Sucursales', empresa: 'Empresas' };
  concentrarLabel = computed(() => (this.concLabels[this.concentrar()] ?? '').toUpperCase());
  concentradoNoun = computed(() => this.concLabels[this.concentrar()] ?? '');
  concentradoCount = computed(() => {
    const r = this.report(); const dim = this.concentrar();
    if (!r || !dim) return 0;
    if (dim === 'canal') return new Set(r.columns.map((c) => c.channel).filter(Boolean)).size;
    if (dim === 'sucursal' || dim === 'ruta') return new Set(r.columns.map((c) => c.branch_code)).size;
    return r.row_dim === 'brand' ? r.rows.length : 1; // empresa
  });
  // RS.2 — vista del reporte: por producto (default) / mes en columnas / resumen mensual.
  view = signal<SellOutView>('product');
  readonly viewOpts = [
    { label: 'Por producto', value: 'product' },
    { label: 'Mes en columnas', value: 'month_columns' },
    { label: 'Resumen mensual', value: 'month_summary' },
  ];
  setView(v: string) { this.view.set(v as SellOutView); this.generate(); }
  monthDate: Date = new Date();
  rangeDates: Date[] | null = null;
  quarter = 1;
  year = new Date().getFullYear();
  channels: string[] = [];
  warehouses: string[] = [];
  byChannel = true;
  includeZeros = false;

  warehouseOpts = signal<SellOutWarehouseRow[]>([]);
  loadingWarehouses = signal(false);

  // RS.4 — modo del reporte + slicer jerárquico (CANAL o VENDEDOR).
  reportMode = signal<'canal' | 'vendedor'>('canal');
  readonly reportModeOpts = [
    { label: 'Por canal', value: 'canal' },
    { label: 'Por vendedor', value: 'vendedor' },
  ];
  // RS.13 — formato de columnas: 'detalle' (dinámico) o 'plaza' (formato estándar plaza×tipo).
  layout = signal<'detalle' | 'plaza'>('detalle');
  readonly layoutOpts = [
    { label: 'Detalle', value: 'detalle' },
    { label: 'Por plaza', value: 'plaza' },
  ];
  setLayout(v: string) {
    const l = v as 'detalle' | 'plaza';
    this.layout.set(l);
    // El formato estándar es en CAJAS, por producto, con TODOS los SKUs (incluye sin venta).
    if (l === 'plaza') { this.measure.set('cajas'); this.includeZeros = true; this.view.set('product'); this.concentrar.set(''); }
    this.generate();
  }
  canalTree = signal<SellOutTreeGroup[]>([]);
  vendorTree = signal<SellOutTreeGroup[]>([]);
  activeTree = computed(() => (this.reportMode() === 'vendedor' ? this.vendorTree() : this.canalTree()));
  // tokens seleccionados ("<canal|grupo>|<code>"). Vacío = todos.
  selectedCells = signal<Set<string>>(new Set());
  slicerOpen = signal(false);
  readonly selectedCount = computed(() => this.selectedCells().size);
  // "About" plegable: qué filtra cada control (los filtros y la tabla derivan del MISMO
  // universo `analytics.v_sellout_daily`, acotado al periodo → lo que ves en el slicer suma
  // en la matriz, sin doble conteo Kepler↔Wincaja).
  aboutOpen = signal(false);

  private curFrom = '';
  private curTo = '';

  yearOpts = computed(() => {
    const y = new Date().getFullYear();
    return [y, y - 1, y - 2, y - 3];
  });

  constructor() {
    const now = new Date();
    // Default = mes anterior (cerrado). El mes en curso casi no tiene venta
    // consolidada todavía → arrancar ahí daba "sin venta" en todas las marcas.
    this.monthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    this.year = this.monthDate.getFullYear();
    this.quarter = Math.floor(this.monthDate.getMonth() / 3) + 1;
    // Restaura los filtros guardados (sobrevive cambio de tab / navegación / reload);
    // re-consulta fresco. Si es la 1ra vez → defaults de arriba.
    this.restoreFilters();
    this.syncPeriod();
    this.loadBrands();
    this.loadWarehouses();
    this.loadTrees();
    // Al entrar: reporte general de TODAS las empresas (empresa opcional).
    this.generate();
  }

  // Los árboles se piden ACOTADOS AL RANGO (from/to) → sus hojas reflejan exactamente lo que el reporte
  // muestra para el periodo elegido (sintonía filtros↔datos). Se re-piden al cambiar el rango.
  private loadTrees() {
    this.svc.sellOutCanales(this.curFrom, this.curTo).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (t) => { this.canalTree.set(t); if (this.reportMode() === 'canal') this.pruneStaleCells(); }, error: () => {} });
    this.svc.sellOutVendors(this.curFrom, this.curTo).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (t) => { this.vendorTree.set(t); if (this.reportMode() === 'vendedor') this.pruneStaleCells(); }, error: () => {} });
  }

  /**
   * Poda celdas seleccionadas que YA NO existen en el árbol vigente (p.ej. una sucursal de
   * Mayoreo guardada antes de que el slicer pasara a vendedores → token colgado que filtra
   * a $0). Si algo cambió, re-genera. Conserva los comodines 'grupo|*'.
   */
  private pruneStaleCells() {
    const cur = this.selectedCells();
    if (!cur.size) return;
    const tree = this.reportMode() === 'vendedor' ? this.vendorTree() : this.canalTree();
    if (!tree.length) return;
    const valid = new Set<string>();
    for (const g of tree) for (const l of g.leaves) valid.add(this.leafToken(g, l));
    const next = new Set([...cur].filter((t) => t.endsWith('|*') || valid.has(t)));
    if (next.size !== cur.size) { this.selectedCells.set(next); this.generate(); }
  }

  setReportMode(m: string) {
    this.reportMode.set(m as 'canal' | 'vendedor');
    this.selectedCells.set(new Set());   // el token de canal no aplica al de vendedor
    this.generate();
  }

  // Token de una hoja: canal usa leaf.channel; vendedor usa el grupo.
  leafToken(g: SellOutTreeGroup, leaf: { channel?: string; code: string }): string {
    return `${(leaf.channel ?? g.group)}|${leaf.code}`.toLowerCase();
  }
  isLeafSel(g: SellOutTreeGroup, leaf: { channel?: string; code: string }): boolean {
    return this.selectedCells().has(this.leafToken(g, leaf));
  }
  toggleLeaf(g: SellOutTreeGroup, leaf: { channel?: string; code: string }) {
    const s = new Set(this.selectedCells());
    const t = this.leafToken(g, leaf);
    s.has(t) ? s.delete(t) : s.add(t);
    this.selectedCells.set(s);
  }
  groupAllSel(g: SellOutTreeGroup): boolean {
    return g.leaves.length > 0 && g.leaves.every((l) => this.isLeafSel(g, l));
  }
  toggleGroup(g: SellOutTreeGroup) {
    const s = new Set(this.selectedCells());
    const all = this.groupAllSel(g);
    for (const l of g.leaves) { const t = this.leafToken(g, l); all ? s.delete(t) : s.add(t); }
    this.selectedCells.set(s);
  }
  clearCells() { this.selectedCells.set(new Set()); this.generate(); }

  /** Restablece TODOS los filtros a los defaults (empresa, periodo, medida, promos, celdas,
   *  búsqueda, concentrado, vista, modo) y borra lo persistido. Luego regenera. */
  resetFilters(): void {
    this.brandId.set(null);
    this.search.set('');
    this.promo.set('sin');
    this.concentrar.set('');
    this.view.set('product');
    this.reportMode.set('canal');
    this.layout.set('detalle');
    this.measure.set('ambas');
    this.periodMode.set('month');
    this.selectedCells.set(new Set());
    this.channels = [];
    this.warehouses = [];
    this.byChannel = true;
    this.includeZeros = false;
    this.rangeDates = null;
    // Periodo default = mes anterior cerrado (igual que el constructor).
    const now = new Date();
    this.monthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    this.year = this.monthDate.getFullYear();
    this.quarter = Math.floor(this.monthDate.getMonth() / 3) + 1;
    try { localStorage.removeItem(ComercialSellOutComponent.FKEY); } catch { /* no-op */ }
    this.syncPeriod();
    this.generate();
  }
  applyCells() { this.slicerOpen.set(false); this.generate(); }

  /** Autocomplete de producto (todas las empresas): al elegir uno, filtra por su SKU y regenera.
   *  Al elegir un SKU específico ponemos Promos en "Todo" — el usuario pidió ESE producto, así que
   *  no debe esconderlo el filtro default "Sin promos" si resulta ser un marcador de promo ($0.01). */
  onProductPick(hit: ProductHit | null): void {
    this.search.set(hit ? (hit.sku || hit.label) : '');
    if (hit && this.promo() === 'sin') this.promo.set('todo');
    this.generate();
  }

  /** Drill del reporte general: click en una empresa → detalle de sus productos. */
  drillBrand(row: { product_id: string }): void {
    if (!row.product_id) return;
    this.brandId.set(row.product_id);
    this.generate();
  }

  private loadBrands() {
    this.loadingBrands.set(true);
    this.svc.sellOutBrands()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (b) => { this.brands.set(b); this.loadingBrands.set(false); },
        error: () => { this.loadingBrands.set(false); this.toast.add({ severity: 'error', summary: 'Error al cargar empresas' }); },
      });
  }

  private loadWarehouses() {
    this.loadingWarehouses.set(true);
    this.svc.sellOutWarehouses(this.curFrom, this.curTo)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (w) => { this.warehouseOpts.set(w); this.loadingWarehouses.set(false); },
        error: () => { this.loadingWarehouses.set(false); },
      });
  }

  setMode(m: string) { this.periodMode.set(m as PeriodMode); this.refreshPeriod(); }

  /** Cambio de periodo/selector → recalcula rango y RE-GENERA solo (como Vista/Promos),
   *  salvo rango incompleto (from/to vacíos → espera a que el usuario complete + Generar). */
  refreshPeriod() {
    this.syncPeriod();
    if (this.curFrom && this.curTo) {
      // Filtros y datos van juntos: al mover el rango, re-pedí los árboles/almacenes acotados y re-generá.
      this.loadWarehouses();
      this.loadTrees();
      this.generate();
    }
  }

  private iso(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /** Recalcula from/to según el modo de periodo activo. */
  syncPeriod() {
    const mode = this.periodMode();
    if (mode === 'month' && this.monthDate) {
      const d = this.monthDate;
      this.curFrom = this.iso(new Date(d.getFullYear(), d.getMonth(), 1));
      this.curTo = this.iso(new Date(d.getFullYear(), d.getMonth() + 1, 0));
    } else if (mode === 'quarter') {
      const m0 = (this.quarter - 1) * 3;
      this.curFrom = this.iso(new Date(this.year, m0, 1));
      this.curTo = this.iso(new Date(this.year, m0 + 3, 0));
    } else if (mode === 'year') {
      this.curFrom = this.iso(new Date(this.year, 0, 1));
      this.curTo = this.iso(new Date(this.year, 11, 31));
    } else if (mode === 'range') {
      if (this.rangeDates?.[0] && this.rangeDates?.[1]) {
        this.curFrom = this.iso(this.rangeDates[0]);
        this.curTo = this.iso(this.rangeDates[1]);
      } else { this.curFrom = ''; this.curTo = ''; } // rango incompleto → no re-generar
    }
  }

  private fmtDMY(iso: string): string {
    const [y, m, d] = iso.split('-');
    return d ? `${d}/${m}/${y}` : iso;
  }

  private buildMeta(): { brand: string; period: string; channels: string } {
    const brand = this.brandId()
      ? (this.brands().find((b) => b.id === this.brandId())?.nombre ?? '—')
      : 'Todas las empresas';
    const period = this.curFrom === this.curTo
      ? this.fmtDMY(this.curFrom)
      : `${this.fmtDMY(this.curFrom)} – ${this.fmtDMY(this.curTo)}`;
    const channels = this.channels.length
      ? this.channels.map((c) => this.channelOpts.find((o) => o.value === c)?.label ?? c).join(', ')
      : 'Todos los canales';
    const productLabel = this.search() ? ` · SKU «${this.search()}»` : '';
    return { brand, period, channels: channels + productLabel };
  }

  private buildParams(): SellOutParams {
    return {
      brand_id: this.brandId() || undefined,
      from: this.curFrom,
      to: this.curTo,
      group_by: this.byChannel ? 'branch_channel' : 'branch',
      view: this.view(),
      channels: this.concentrar() === 'ruta' ? ['ruta'] : (this.channels.length ? this.channels : undefined),
      warehouses: this.warehouses.length ? this.warehouses : undefined,
      cells: this.selectedCells().size ? Array.from(this.selectedCells()) : undefined,
      mode: this.reportMode(),
      include_zeros: this.includeZeros,
      search: this.search() || undefined,
      promo: this.promo() !== 'sin' ? this.promo() : undefined,
      layout: this.reportMode() === 'canal' && this.layout() === 'plaza' ? 'plaza' : undefined,
      // La matriz de pantalla filtra la medida en cliente, pero el XLSX/PDF se arma en el
      // server: sin mandarla, "Ambas" + "Por plaza" salía sin la columna de monto.
      measure: this.measure(),
    };
  }

  /** Persiste TODOS los filtros. Fechas → ISO; Set → array (JSON-safe). */
  private saveFilters(): void {
    try {
      localStorage.setItem(ComercialSellOutComponent.FKEY, JSON.stringify({
        brandId: this.brandId(), periodMode: this.periodMode(), measure: this.measure(),
        promo: this.promo(), concentrar: this.concentrar(), view: this.view(),
        reportMode: this.reportMode(), layout: this.layout(), search: this.search(),
        selectedCells: Array.from(this.selectedCells()),
        monthDate: this.iso(this.monthDate),
        rangeDates: this.rangeDates?.map((d) => this.iso(d)) ?? null,
        quarter: this.quarter, year: this.year,
        channels: this.channels, warehouses: this.warehouses,
        byChannel: this.byChannel, includeZeros: this.includeZeros,
      }));
    } catch { /* localStorage no disponible */ }
  }
  private restoreFilters(): void {
    try {
      const raw = localStorage.getItem(ComercialSellOutComponent.FKEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s.periodMode === 'month' || s.periodMode === 'quarter' || s.periodMode === 'year' || s.periodMode === 'range') this.periodMode.set(s.periodMode);
      if ('brandId' in s) this.brandId.set(s.brandId ?? null);
      if (s.measure === 'cajas' || s.measure === 'monto' || s.measure === 'ambas') this.measure.set(s.measure);
      if (s.promo === 'sin' || s.promo === 'solo' || s.promo === 'todo') this.promo.set(s.promo);
      if (['', 'ruta', 'canal', 'sucursal', 'empresa'].includes(s.concentrar)) this.concentrar.set(s.concentrar);
      if (s.view === 'product' || s.view === 'month_columns' || s.view === 'month_summary') this.view.set(s.view);
      if (s.reportMode === 'canal' || s.reportMode === 'vendedor') this.reportMode.set(s.reportMode);
      if (s.layout === 'detalle' || s.layout === 'plaza') this.layout.set(s.layout);
      if (typeof s.search === 'string') this.search.set(s.search);
      if (Array.isArray(s.selectedCells)) this.selectedCells.set(new Set(s.selectedCells));
      // Parse LOCAL (no `new Date(iso)` que interpreta UTC → correría el mes en TZ MX).
      const parseLocal = (v: string): Date | null => {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
        return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
      };
      if (typeof s.monthDate === 'string') { const d = parseLocal(s.monthDate); if (d) this.monthDate = d; }
      if (Array.isArray(s.rangeDates)) {
        const ds = s.rangeDates.map((x: string) => parseLocal(x)).filter((d: Date | null): d is Date => !!d);
        this.rangeDates = ds.length ? ds : null;
      }
      if (typeof s.quarter === 'number') this.quarter = s.quarter;
      if (typeof s.year === 'number') this.year = s.year;
      if (Array.isArray(s.channels)) this.channels = s.channels;
      if (Array.isArray(s.warehouses)) this.warehouses = s.warehouses;
      if (typeof s.byChannel === 'boolean') this.byChannel = s.byChannel;
      if (typeof s.includeZeros === 'boolean') this.includeZeros = s.includeZeros;
    } catch { /* JSON inválido */ }
  }

  generate() {
    this.syncPeriod();
    if (!this.curFrom || !this.curTo) {
      this.toast.add({ severity: 'warn', summary: 'Elegí un periodo' });
      return;
    }
    this.saveFilters();
    this.loading.set(true);
    const req = this.reportMode() === 'vendedor'
      ? this.svc.sellOutByVendor(this.buildParams())
      : this.svc.sellOut(this.buildParams());
    req
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.report.set(r); this.page.set(0); this.meta.set(this.buildMeta()); this.loading.set(false); },
        // Al fallar: limpiar el reporte previo. Si no, quedaba el del periodo anterior en
        // pantalla y parecía que "ignoraba" el filtro (ej. elegir julio → seguía viéndose junio).
        error: (e) => {
          this.report.set(null);
          this.meta.set(null);
          this.loading.set(false);
          this.toast.add({ severity: 'error', summary: 'Error al generar', detail: e?.error?.message });
        },
      });
  }

  download(fmt: 'xlsx' | 'pdf') {
    if (!this.report()) return;
    this.dl.set(fmt);
    this.svc.sellOutDownload(this.buildParams(), fmt)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (resp) => {
          this.dl.set('');
          const blob = resp.body!;
          const cd = resp.headers.get('content-disposition') || '';
          const name = this.filenameFrom(cd, fmt);
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = name; a.click();
          URL.revokeObjectURL(url);
        },
        error: () => { this.dl.set(''); this.toast.add({ severity: 'error', summary: `Error al descargar ${fmt.toUpperCase()}` }); },
      });
  }

  private filenameFrom(contentDisposition: string, fmt: string): string {
    const star = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition);
    if (star) { try { return decodeURIComponent(star[1]); } catch { /* noop */ } }
    const plain = /filename="?([^";]+)"?/i.exec(contentDisposition);
    if (plain) return plain[1];
    return `sell-out.${fmt}`;
  }

  colLabel(c: { branch_name: string; channel_label?: string; source_label?: string }): string {
    const base = c.channel_label ? `${c.branch_name} · ${c.channel_label}` : c.branch_name;
    return c.source_label ? `${base} · ${c.source_label}` : base;
  }

  /** Sustantivo de la fila según la vista (para conteos/labels). */
  rowNoun(r: SellOutReport): string {
    return r.row_dim === 'month' ? 'meses' : r.row_dim === 'brand' ? 'empresas' : 'productos';
  }
  rowNounCap(r: SellOutReport): string {
    return r.row_dim === 'month' ? 'Meses' : r.row_dim === 'brand' ? 'Empresas' : 'Productos';
  }
  matrixTitle(r: SellOutReport): string {
    return r.row_dim === 'month' ? 'Resumen mensual' : r.row_dim === 'brand' ? 'Detalle por empresa' : 'Detalle por producto';
  }

  cell(row: SellOutReport['rows'][number], key: string): SellOutCell | undefined {
    return row.cells[key];
  }

  colTotal(r: SellOutReport, key: string) {
    return r.column_totals[key] ?? { cajas: 0, monto: 0 };
  }
}
