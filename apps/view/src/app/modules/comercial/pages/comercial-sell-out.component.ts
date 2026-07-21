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
    DatePickerModule, ToggleSwitchModule, InputTextModule, ToastModule,
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
          <p class="surf-page-sub">Venta real consolidada (Kepler) por producto y sucursal · exporta XLSX / PDF</p>
        </div>
      </header>

      <!-- Controles -->
      <div class="so-filters card-premium card-flat">
        <div class="so-field so-empresa">
          <label>Empresa</label>
          <p-select [options]="brands()" [ngModel]="brandId()" (ngModelChange)="brandId.set($event)" optionLabel="nombre" optionValue="id"
                    [filter]="true" filterBy="nombre,code" [showClear]="true" placeholder="Todas las empresas"
                    [loading]="loadingBrands()" appendTo="body" styleClass="w-full"
                    (onChange)="generate()" (onClear)="generate()">
            <ng-template let-b pTemplate="item">
              <span>{{ b.nombre }}</span>
              <span class="so-badge">{{ b.products }}</span>
            </ng-template>
          </p-select>
        </div>

        <div class="so-field">
          <label>Ver</label>
          <app-segmented [options]="reportModeOpts" [value]="reportMode()" (valueChange)="setReportMode($event)" ariaLabel="Modo del reporte" />
        </div>

        <div class="so-field">
          <label>Periodo</label>
          <app-segmented [options]="modeOpts" [value]="periodMode()" (valueChange)="setMode($event)" ariaLabel="Periodo" />
        </div>

        @switch (periodMode()) {
          @case ('month') {
            <div class="so-field">
              <label>Mes</label>
              <p-datePicker [(ngModel)]="monthDate" view="month" dateFormat="MM yy" [showIcon]="true"
                            appendTo="body" (onSelect)="syncPeriod()" (onClose)="syncPeriod()" />
            </div>
          }
          @case ('quarter') {
            <div class="so-field">
              <label>Trimestre</label>
              <p-select [options]="quarterOpts" [(ngModel)]="quarter" optionLabel="label" optionValue="value"
                        appendTo="body" (onChange)="syncPeriod()" />
            </div>
            <div class="so-field so-year">
              <label>Año</label>
              <p-select [options]="yearOpts()" [(ngModel)]="year" appendTo="body" (onChange)="syncPeriod()" />
            </div>
          }
          @case ('year') {
            <div class="so-field so-year">
              <label>Año</label>
              <p-select [options]="yearOpts()" [(ngModel)]="year" appendTo="body" (onChange)="syncPeriod()" />
            </div>
          }
          @case ('range') {
            <div class="so-field">
              <label>Rango</label>
              <p-datePicker [(ngModel)]="rangeDates" selectionMode="range" dateFormat="dd/mm/yy"
                            [showIcon]="true" appendTo="body" (onSelect)="syncPeriod()" (onClose)="syncPeriod()" />
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
          <app-product-search placeholder="SKU (5 díg.) o descripción…" (productSelected)="onProductPick($event)" />
        </div>

        @if (reportMode() === 'canal') {
          <div class="so-field">
            <label>Vista</label>
            <app-segmented [options]="viewOpts" [value]="view()" (valueChange)="setView($event)" ariaLabel="Vista del reporte" />
          </div>
        }

        <div class="so-field">
          <label>Medida</label>
          <app-segmented [options]="measureOpts" [value]="measure()" (valueChange)="setMeasure($event)" ariaLabel="Medida" />
        </div>

        @if (reportMode() === 'canal') {
          <div class="so-field so-toggles">
            @if (view() !== 'month_columns') {
              <label class="so-toggle"><p-toggleSwitch [(ngModel)]="byChannel" /> <span>Desglosar canal</span></label>
            }
            @if (view() !== 'month_summary') {
              <label class="so-toggle"><p-toggleSwitch [(ngModel)]="includeZeros" /> <span>Incluir sin venta</span></label>
            }
          </div>
        }
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
        <button pButton label="Generar" icon="pi pi-search" size="small"
                [loading]="loading()" (click)="generate()"></button>
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
            <button pButton label="XLSX" icon="pi pi-file-excel" size="small" severity="secondary" [outlined]="true"
                    [loading]="dl() === 'xlsx'" (click)="download('xlsx')"></button>
            <button pButton label="PDF" icon="pi pi-file-pdf" size="small" severity="secondary" [outlined]="true"
                    [loading]="dl() === 'pdf'" (click)="download('pdf')"></button>
          </div>
        </div>

        <!-- KPIs (MetricStrip compartido, sin caja) -->
        <app-metric-strip [items]="kpiItems()" ariaLabel="Resumen del sell-out" />


        @if (r.coverage.note) {
          <p class="so-note"><i class="pi pi-info-circle"></i> {{ r.coverage.note }}</p>
        }

        @if (r.rows.length) {
          <!-- Matriz (dentro de card premium, como las secciones de reports) -->
          <div class="card-premium card-flat so-matrix-card">
            <div class="so-matrix-head">
              <h3 class="text-sm font-bold text-content-main">{{ matrixTitle(r) }}</h3>
              <span class="so-matrix-count">{{ r.rows.length }} {{ rowNoun(r) }} · {{ r.columns.length }} columnas</span>
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
                @for (row of r.rows; track row.product_id) {
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
          </div>
        } @else {
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
      border-radius:var(--r-sm); padding:.5rem .7rem; margin:0 0 1rem; display:flex; gap:.4rem; align-items:baseline; }
    .so-matrix-card { padding:1.25rem; }
    .so-matrix-head { display:flex; align-items:center; justify-content:space-between; gap:.75rem; margin-bottom:.75rem; flex-wrap:wrap; }
    .so-matrix-tools { display:flex; align-items:center; gap:1rem; }
    .so-matrix-count { font-size:.75rem; color:var(--text-muted); white-space:nowrap; }
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

  brands = signal<SellOutBrandRow[]>([]);
  loadingBrands = signal(false);
  loading = signal(false);
  dl = signal<'' | 'xlsx' | 'pdf'>('');
  report = signal<SellOutReport | null>(null);
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
  canalTree = signal<SellOutTreeGroup[]>([]);
  vendorTree = signal<SellOutTreeGroup[]>([]);
  activeTree = computed(() => (this.reportMode() === 'vendedor' ? this.vendorTree() : this.canalTree()));
  // tokens seleccionados ("<canal|grupo>|<code>"). Vacío = todos.
  selectedCells = signal<Set<string>>(new Set());
  slicerOpen = signal(false);
  readonly selectedCount = computed(() => this.selectedCells().size);

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
    this.syncPeriod();
    this.loadBrands();
    this.loadWarehouses();
    this.loadTrees();
    // Al entrar: reporte general de TODAS las empresas (empresa opcional).
    this.generate();
  }

  private loadTrees() {
    this.svc.sellOutCanales().pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (t) => this.canalTree.set(t), error: () => {} });
    this.svc.sellOutVendors().pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (t) => this.vendorTree.set(t), error: () => {} });
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
  applyCells() { this.slicerOpen.set(false); this.generate(); }

  /** Autocomplete de producto (todas las empresas): al elegir uno, filtra por su SKU y regenera. */
  onProductPick(hit: ProductHit | null): void {
    this.search.set(hit ? (hit.sku || hit.label) : '');
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
    this.svc.sellOutWarehouses()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (w) => { this.warehouseOpts.set(w); this.loadingWarehouses.set(false); },
        error: () => { this.loadingWarehouses.set(false); },
      });
  }

  setMode(m: string) { this.periodMode.set(m as PeriodMode); this.syncPeriod(); }

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
    } else if (mode === 'range' && this.rangeDates?.[0] && this.rangeDates?.[1]) {
      this.curFrom = this.iso(this.rangeDates[0]);
      this.curTo = this.iso(this.rangeDates[1]);
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
      channels: this.channels.length ? this.channels : undefined,
      warehouses: this.warehouses.length ? this.warehouses : undefined,
      cells: this.selectedCells().size ? Array.from(this.selectedCells()) : undefined,
      mode: this.reportMode(),
      include_zeros: this.includeZeros,
      search: this.search() || undefined,
    };
  }

  generate() {
    this.syncPeriod();
    if (!this.curFrom || !this.curTo) {
      this.toast.add({ severity: 'warn', summary: 'Elegí un periodo' });
      return;
    }
    this.loading.set(true);
    const req = this.reportMode() === 'vendedor'
      ? this.svc.sellOutByVendor(this.buildParams())
      : this.svc.sellOut(this.buildParams());
    req
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.report.set(r); this.meta.set(this.buildMeta()); this.loading.set(false); },
        error: (e) => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error al generar', detail: e?.error?.message }); },
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
