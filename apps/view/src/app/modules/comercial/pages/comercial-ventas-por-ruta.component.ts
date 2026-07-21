import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { ToastModule } from 'primeng/toast';
import { TableModule } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { CheckboxModule } from 'primeng/checkbox';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { MessageService } from 'primeng/api';
import {
  ComercialService,
  SalesByRouteCell,
  SalesByRouteDetail,
  SalesByRouteOption,
  SalesByRouteParams,
  SalesByRouteReport,
  SalesByRouteRow,
} from '../comercial.service';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { REPORTS_TABS } from '../reports-tabs';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';

type DetailTab = 'productos' | 'dias' | 'clientes' | 'tickets';

/** Fila con agregados del PERIODO visible (recalculados client-side según el rango de meses). */
type ViewRow = SalesByRouteRow & { _revenue: number; _units: number; _tickets: number; _share: number };

const MES: Record<string, string> = {
  '01': 'Ene', '02': 'Feb', '03': 'Mar', '04': 'Abr', '05': 'May', '06': 'Jun',
  '07': 'Jul', '08': 'Ago', '09': 'Sep', '10': 'Oct', '11': 'Nov', '12': 'Dic',
};

/** RR — Ventas por Ruta (venta mensual por sucursal×ruta, serie de folio Kepler). */
@Component({
  selector: 'app-comercial-ventas-por-ruta',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, SelectModule, MultiSelectModule,
    ToastModule, TableModule, InputTextModule, InputNumberModule, CheckboxModule,
    IconFieldModule, InputIconModule,
    PageTabsComponent, SidePeekComponent, MetricStripComponent,
  ],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="reportTabs" />

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Ventas por ruta</h1>
          <p class="surf-page-sub">Venta real por sucursal y ruta, mes a mes · importe · tickets · exporta XLSX</p>
        </div>
      </header>

      <div class="rr-filters card-premium card-flat">
        <div class="rr-field rr-year">
          <label>Año</label>
          <p-select [options]="yearOpts()" [(ngModel)]="year" appendTo="body" (onChange)="load()" />
        </div>
        <div class="rr-field rr-wh">
          <label>Rutas</label>
          <p-multiSelect [options]="routeOpts()" [(ngModel)]="routes" optionLabel="label" optionValue="value"
                         placeholder="Todas" [showClear]="true" [filter]="true" appendTo="body" styleClass="w-full" (onPanelHide)="load()" />
        </div>
        <div class="rr-field rr-prodf">
          <label>Producto</label>
          <p-select [options]="productOpts()" [ngModel]="fProduct()" (ngModelChange)="fProduct.set($event); load()"
                    optionLabel="label" optionValue="value" placeholder="Todos" [showClear]="true"
                    [filter]="true" filterBy="label" filterPlaceholder="Buscar SKU o nombre…" [resetFilterOnHide]="true"
                    [virtualScroll]="true" [virtualScrollItemSize]="34" appendTo="body" styleClass="w-full" ariaLabel="Filtrar por producto" />
        </div>
        <div class="rr-field rr-clientf">
          <label>Cliente</label>
          <p-select [options]="clientOpts()" [ngModel]="fClient()" (ngModelChange)="fClient.set($event); load()"
                    optionLabel="label" optionValue="value" placeholder="Todos" [showClear]="true"
                    [filter]="true" filterBy="label" filterPlaceholder="Buscar cliente…" [resetFilterOnHide]="true"
                    [virtualScroll]="true" [virtualScrollItemSize]="34" appendTo="body" styleClass="w-full" ariaLabel="Filtrar por cliente" />
        </div>
        <div class="rr-actions">
          <button pButton label="Consultar" icon="pi pi-search" size="small" [loading]="loading()" (click)="load()"></button>
        </div>
      </div>

      <!-- Filtros de vista (client-side, instantáneos sobre lo cargado) -->
      @if (report()?.rows?.length) {
        <div class="rr-viewfilters">
          <p-multiSelect [options]="branchOpts()" [ngModel]="fBranch()" (ngModelChange)="fBranch.set($event)"
                         optionLabel="label" optionValue="value" placeholder="Todas las sucursales" [showClear]="true"
                         [filter]="true" filterBy="label" filterPlaceholder="Buscar sucursal…" appendTo="body"
                         [maxSelectedLabels]="2" selectedItemsLabel="{0} sucursales" styleClass="rr-vf-branch" ariaLabel="Filtrar por sucursal" />
          <div class="rr-vf-months" role="group" aria-label="Rango de meses">
            <p-select [options]="monthOpts()" [ngModel]="fMonthFrom()" (ngModelChange)="fMonthFrom.set($event)"
                      optionLabel="label" optionValue="value" placeholder="Mes desde" [showClear]="true" appendTo="body" styleClass="rr-vf-mo" ariaLabel="Mes desde" />
            <span class="rr-vf-dash">–</span>
            <p-select [options]="monthOpts()" [ngModel]="fMonthTo()" (ngModelChange)="fMonthTo.set($event)"
                      optionLabel="label" optionValue="value" placeholder="Mes hasta" [showClear]="true" appendTo="body" styleClass="rr-vf-mo" ariaLabel="Mes hasta" />
          </div>
          <p-iconfield styleClass="rr-vf-search">
            <p-inputicon styleClass="pi pi-search" />
            <input pInputText type="text" [ngModel]="fQuery()" (ngModelChange)="fQuery.set($event)"
                   placeholder="Buscar ruta o sucursal…" aria-label="Buscar ruta o sucursal" />
            @if (fQuery()) { <p-inputicon styleClass="pi pi-times rr-vf-clear" (click)="fQuery.set('')" role="button" ariaLabel="Limpiar búsqueda" /> }
          </p-iconfield>
          <div class="rr-vf-money" role="group" aria-label="Rango de venta">
            <p-inputNumber [ngModel]="fMinRevenue()" (ngModelChange)="fMinRevenue.set($event)" mode="currency" currency="MXN"
                           [maxFractionDigits]="0" [showButtons]="false" placeholder="Venta mín" inputStyleClass="rr-vf-num" ariaLabel="Venta mínima" />
            <span class="rr-vf-dash">–</span>
            <p-inputNumber [ngModel]="fMaxRevenue()" (ngModelChange)="fMaxRevenue.set($event)" mode="currency" currency="MXN"
                           [maxFractionDigits]="0" [showButtons]="false" placeholder="Venta máx" inputStyleClass="rr-vf-num" ariaLabel="Venta máxima" />
          </div>
          <label class="rr-vf-chk"><p-checkbox [binary]="true" [ngModel]="fOnlyWithSales()" (ngModelChange)="fOnlyWithSales.set($event)" inputId="rr-only" /> Solo con venta</label>
          @if (hasViewFilters()) {
            <button pButton type="button" label="Limpiar filtros" icon="pi pi-filter-slash" class="p-button-sm p-button-text" (click)="clearViewFilters()"></button>
          }
        </div>
      }

      @if (error()) {
        <div class="rr-error" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span>{{ error() }}</span>
          <button pButton type="button" class="p-button-sm p-button-text" label="Reintentar" (click)="load()"></button>
        </div>
      }

      @if (report(); as r) {
        @if (r.rows.length) {
          <app-metric-strip [items]="kpiItems()" ariaLabel="Resumen de ventas por ruta" />


          <div class="so-actions-bar">
            <span class="text-xs text-content-muted">{{ filteredRows().length }}@if (filteredRows().length !== r.rows.length) { de {{ r.rows.length }}} rutas · año {{ r.year }}@if (periodLabel()) { · {{ periodLabel() }}}</span>
            <button pButton label="XLSX" icon="pi pi-file-excel" size="small" severity="secondary" [outlined]="true"
                    [loading]="dl()" (click)="download()"></button>
          </div>

          @if (filteredRows().length) {
          <div class="card-premium card-flat rr-table-card">
            <p-table [value]="filteredRows()" [loading]="loading()" [rowHover]="true"
                     [scrollable]="true" scrollHeight="60vh"
                     sortField="_revenue" [sortOrder]="-1"
                     styleClass="p-datatable-sm surf-table rr-ptable">
              <ng-template pTemplate="header">
                <tr>
                  <th scope="col" pFrozenColumn style="min-width:150px" pSortableColumn="warehouse_name">Sucursal <p-sortIcon field="warehouse_name" /></th>
                  <th scope="col" pFrozenColumn style="min-width:120px" pSortableColumn="route_no">Ruta <p-sortIcon field="route_no" /></th>
                  @for (m of visibleMonths(); track m) {
                    <th scope="col" class="comm-num" [pSortableColumn]="'monthly.' + m + '.revenue'">{{ mes(m) }} <p-sortIcon [field]="'monthly.' + m + '.revenue'" /></th>
                  }
                  <th scope="col" class="comm-num rr-strong" pSortableColumn="_revenue">Total <p-sortIcon field="_revenue" /></th>
                  <th scope="col" class="comm-num" pSortableColumn="_share">Share <p-sortIcon field="_share" /></th>
                  <th scope="col" class="comm-num" pSortableColumn="_tickets">Tickets <p-sortIcon field="_tickets" /></th>
                </tr>
              </ng-template>
              <ng-template pTemplate="body" let-row>
                <tr class="rr-row" (click)="openRoute(row)" title="Ver desglose de la ruta">
                  <td pFrozenColumn class="comm-cell-strong">{{ row.warehouse_name }}</td>
                  <td pFrozenColumn class="rr-strong">
                    <!-- Botón real: el drill es accesible por teclado (la fila (click) queda para mouse). -->
                    <button type="button" class="rr-link" (click)="$event.stopPropagation(); openRoute(row)"
                            [attr.aria-label]="'Ver desglose de la ruta ' + row.route_no">Ruta {{ row.route_no }}</button>
                  </td>
                  @for (m of visibleMonths(); track m) {
                    <td class="comm-num">{{ cell(row, m)?.revenue != null ? (cell(row, m)!.revenue | currency:'MXN':'symbol-narrow':'1.0-0') : '·' }}</td>
                  }
                  <td class="comm-num rr-strong">{{ row._revenue | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  <td class="comm-num comm-muted">{{ row._share | number:'1.0-1' }}%</td>
                  <td class="comm-num">{{ row._tickets | number }}</td>
                </tr>
              </ng-template>
              <ng-template pTemplate="footer">
                <tr class="rr-foot">
                  <td pFrozenColumn>TOTAL</td>
                  <td pFrozenColumn></td>
                  @for (m of visibleMonths(); track m) {
                    <td class="comm-num">{{ viewMonthlyTotals()[m]?.revenue ? (viewMonthlyTotals()[m].revenue | currency:'MXN':'symbol-narrow':'1.0-0') : '·' }}</td>
                  }
                  <td class="comm-num rr-strong">{{ viewTotals().revenue | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  <td class="comm-num comm-muted">{{ viewTotals().share | number:'1.0-1' }}%</td>
                  <td class="comm-num">{{ viewTotals().tickets | number }}</td>
                </tr>
              </ng-template>
            </p-table>
          </div>
          } @else {
            <div class="comm-empty"><div class="comm-empty-icon"><i class="pi pi-filter-slash"></i></div>
              <h3>Sin coincidencias</h3><p>Ninguna ruta coincide con los filtros de vista. <button pButton type="button" class="p-button-sm p-button-text" label="Limpiar filtros" (click)="clearViewFilters()"></button></p></div>
          }
        } @else {
          <div class="comm-empty"><div class="comm-empty-icon"><i class="pi pi-inbox"></i></div>
            <h3>Sin resultados</h3><p>No hay ventas de ruta para los filtros elegidos.</p></div>
        }
      } @else if (loading()) {
        <div class="comm-empty"><div class="comm-empty-icon"><i class="pi pi-spin pi-spinner"></i></div>
          <h3>Cargando reporte…</h3><p>Consultando la venta por ruta del {{ year }}.</p></div>
      } @else if (!error()) {
        <div class="comm-empty"><div class="comm-empty-icon"><i class="pi pi-directions"></i></div>
          <h3>Ventas por ruta</h3><p>Elegí las rutas; el reporte carga automáticamente.</p></div>
      }

      <app-side-peek [(open)]="peekOpen"
                     [title]="detail()?.warehouse_name || 'Ruta'"
                     [subtitle]="detail() ? ('Ruta ' + detail()!.route_no + ' · ' + detail()!.year) : null">
        @if (detailLoading()) {
          <div class="rr-detail-loading"><i class="pi pi-spin pi-spinner"></i> Cargando desglose…</div>
        }
        @if (detail(); as d) {
          <div class="rr-dkpis">
            <div class="rr-dkpi"><span>Venta</span><b>{{ d.totals.revenue | currency:'MXN':'symbol-narrow':'1.0-0' }}</b></div>
            <div class="rr-dkpi"><span>Tickets</span><b>{{ d.totals.tickets | number }}</b></div>
            <div class="rr-dkpi"><span>Unidades</span><b>{{ d.totals.units | number:'1.0-0' }}</b></div>
            <div class="rr-dkpi"><span>SKUs</span><b>{{ d.totals.skus | number }}</b></div>
            <div class="rr-dkpi"><span>Clientes</span><b>{{ d.totals.clients | number }}</b></div>
          </div>

          <div class="rr-tabs" role="tablist">
            <button type="button" role="tab" [class.on]="tab()==='productos'" [attr.aria-selected]="tab()==='productos'" (click)="tab.set('productos')">Productos</button>
            <button type="button" role="tab" [class.on]="tab()==='dias'" [attr.aria-selected]="tab()==='dias'" (click)="tab.set('dias')">Por día</button>
            <button type="button" role="tab" [class.on]="tab()==='clientes'" [attr.aria-selected]="tab()==='clientes'" (click)="tab.set('clientes')">Clientes</button>
            <button type="button" role="tab" [class.on]="tab()==='tickets'" [attr.aria-selected]="tab()==='tickets'" (click)="tab.set('tickets')">Tickets</button>
          </div>

          @switch (tab()) {
            @case ('productos') {
              <p-table [value]="detail()!.products" styleClass="p-datatable-sm surf-table" [scrollable]="true" scrollHeight="52vh">
                <ng-template pTemplate="header"><tr>
                  <th scope="col">Producto</th><th scope="col" class="comm-num">Unid</th>
                  <th scope="col" class="comm-num">Importe</th><th scope="col" class="comm-num">%</th></tr>
                </ng-template>
                <ng-template pTemplate="body" let-p><tr>
                  <td class="rr-prod"><span class="rr-sku">{{ p.sku }}</span> {{ p.name }}</td>
                  <td class="comm-num">{{ p.units | number:'1.0-0' }}</td>
                  <td class="comm-num rr-strong">{{ p.revenue | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  <td class="comm-num comm-muted">{{ p.share_pct | number:'1.0-1' }}%</td></tr>
                </ng-template>
              </p-table>
              <p class="rr-note">Top 50 por importe.</p>
            }
            @case ('dias') {
              <p-table [value]="detail()!.daily" styleClass="p-datatable-sm surf-table" [scrollable]="true" scrollHeight="52vh">
                <ng-template pTemplate="header"><tr>
                  <th scope="col">Día</th><th scope="col" class="comm-num">Tickets</th>
                  <th scope="col" class="comm-num">Venta</th><th scope="col" class="rr-barcol"></th></tr>
                </ng-template>
                <ng-template pTemplate="body" let-x><tr>
                  <td>{{ x.date }}</td>
                  <td class="comm-num">{{ x.tickets | number }}</td>
                  <td class="comm-num rr-strong">{{ x.revenue | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  <td class="rr-barcol"><span class="rr-bar" [style.width.%]="barPct(x.revenue)"></span></td></tr>
                </ng-template>
              </p-table>
            }
            @case ('clientes') {
              <p-table [value]="detail()!.clients" styleClass="p-datatable-sm surf-table" [scrollable]="true" scrollHeight="52vh">
                <ng-template pTemplate="header"><tr>
                  <th scope="col">Cliente</th><th scope="col" class="comm-num">Tickets</th>
                  <th scope="col" class="comm-num">Importe</th></tr>
                </ng-template>
                <ng-template pTemplate="body" let-c><tr>
                  <td>{{ c.name }} @if (c.is_public) {<span class="rr-tag">público</span>}</td>
                  <td class="comm-num">{{ c.tickets | number }}</td>
                  <td class="comm-num rr-strong">{{ c.revenue | currency:'MXN':'symbol-narrow':'1.0-0' }}</td></tr>
                </ng-template>
              </p-table>
              <p class="rr-note">Top 50 por importe. "Público" = venta a bordo sin cliente identificado.</p>
            }
            @case ('tickets') {
              <p-table [value]="detail()!.tickets" styleClass="p-datatable-sm surf-table" [scrollable]="true" scrollHeight="52vh">
                <ng-template pTemplate="header"><tr>
                  <th scope="col">Folio</th><th scope="col">Fecha</th>
                  <th scope="col" class="comm-num">Líneas</th><th scope="col" class="comm-num">Importe</th></tr>
                </ng-template>
                <ng-template pTemplate="body" let-t><tr>
                  <td class="rr-mono">{{ t.folio }}</td><td>{{ t.date }}</td>
                  <td class="comm-num">{{ t.lines | number }}</td>
                  <td class="comm-num rr-strong">{{ t.revenue | currency:'MXN':'symbol-narrow':'1.0-0' }}</td></tr>
                </ng-template>
              </p-table>
              <p class="rr-note">Últimos 100 tickets.</p>
            }
          }
        }
      </app-side-peek>
    </div>
  `,
  styles: [`
    :host { display:block; }
    .rr-filters { display:flex; flex-wrap:wrap; gap:.75rem 1rem; align-items:flex-end; margin-bottom:1rem; }
    .rr-field { display:flex; flex-direction:column; gap:.3rem; }
    .rr-field > label { font-size:.72rem; font-weight:600; color:var(--text-muted); text-transform:uppercase; letter-spacing:.03em; }
    .rr-year { max-width:110px; } .rr-wh { min-width:220px; flex:1 1 220px; }
    .rr-prodf, .rr-clientf { min-width:200px; flex:1 1 200px; }
    .rr-actions { margin-left:auto; }
    /* Filtros de vista (client-side) */
    .rr-viewfilters { display:flex; flex-wrap:wrap; gap:.5rem .6rem; align-items:center; margin-bottom:1rem; }
    .rr-vf-branch { min-width:16rem; }
    :host ::ng-deep .rr-vf-search input { min-width:14rem; }
    :host ::ng-deep .rr-vf-clear { pointer-events:auto; cursor:pointer; font-size:.72rem; color:var(--text-muted); }
    :host ::ng-deep .rr-vf-clear:hover { color:var(--text-main); }
    .rr-vf-months, .rr-vf-money { display:inline-flex; align-items:center; gap:.35rem; }
    .rr-vf-dash { color:var(--text-muted); }
    :host ::ng-deep .rr-vf-mo { min-width:8rem; }
    :host ::ng-deep .rr-vf-num { width:8rem; }
    .rr-vf-chk { display:inline-flex; align-items:center; gap:.4rem; font-size:.82rem; color:var(--text-muted); cursor:pointer; }
    app-metric-strip { display:block; margin-bottom:1rem; }
    .so-actions-bar { display:flex; align-items:center; justify-content:space-between; gap:1rem; margin-bottom:1rem; }
    .rr-table-card { padding:1.25rem; }
    /* Sticky/frozen/tema los da PrimeNG + surf-table; sólo jerarquía visual acá. */
    .rr-strong { font-weight:700; }
    .rr-foot td { font-weight:700; }
    .rr-row { cursor:pointer; }
    .rr-link { appearance:none; background:none; border:none; padding:0; font:inherit; font-weight:700; cursor:pointer; color:var(--action); text-underline-offset:2px; }
    .rr-row:hover .rr-link { text-decoration:underline; }
    .rr-link:focus-visible { outline:2px solid var(--action); outline-offset:2px; border-radius:var(--r-sm); }
    .rr-error { display:flex; align-items:center; gap:.5rem; font-size:.82rem; padding:.55rem .8rem; margin-bottom:1rem; border-radius:var(--r-sm); background:var(--bad-soft-bg); color:var(--bad-soft-fg); border:1px solid var(--bad-border); }
    .rr-error span { margin-right:auto; }
    /* Detalle (side-peek) */
    .rr-detail-loading { color:var(--text-muted); font-size:.85rem; padding:1rem 0; display:flex; align-items:center; gap:.5rem; }
    .rr-dkpis { display:grid; grid-template-columns:repeat(2,1fr); gap:.5rem; margin-bottom:1rem; }
    .rr-dkpi { border:1px solid var(--border-color); border-radius:var(--r-md); padding:.5rem .7rem; background:var(--card-bg); }
    .rr-dkpi span { display:block; font-size:.64rem; font-weight:600; text-transform:uppercase; letter-spacing:.04em; color:var(--text-muted); }
    .rr-dkpi b { display:block; font-size:1.05rem; margin-top:.1rem; font-variant-numeric:tabular-nums; }
    .rr-tabs { display:flex; gap:.25rem; border-bottom:1px solid var(--border-color); margin-bottom:.75rem; }
    .rr-tabs button { appearance:none; background:none; border:none; border-bottom:2px solid transparent; padding:.5rem .6rem; font-size:.8rem; font-weight:600; color:var(--text-muted); cursor:pointer; }
    .rr-tabs button:hover { color:var(--text-main); }
    .rr-tabs button.on { color:var(--text-main); border-bottom-color:var(--action); }
    .rr-tabs button:focus-visible { outline:2px solid var(--action); outline-offset:2px; }
    .rr-prod { max-width:230px; }
    .rr-sku { color:var(--text-muted); font-variant-numeric:tabular-nums; margin-right:.35rem; }
    .rr-mono { font-variant-numeric:tabular-nums; }
    .rr-tag { display:inline-block; margin-left:.4rem; font-size:.62rem; padding:.05rem .35rem; border-radius:var(--r-sm); background:var(--hover-bg); color:var(--text-muted); text-transform:uppercase; letter-spacing:.03em; }
    .rr-note { margin:.5rem 0 0; font-size:.68rem; color:var(--text-muted); }
    .rr-barcol { width:80px; }
    .rr-bar { display:block; height:8px; border-radius:4px; background:var(--action); opacity:.55; }
  `],
})
export class ComercialVentasPorRutaComponent {
  readonly reportTabs = REPORTS_TABS;
  private readonly svc = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  routeOpts = signal<SalesByRouteOption[]>([]);
  productOpts = signal<{ value: string; label: string }[]>([]);
  clientOpts = signal<{ value: string; label: string }[]>([]);
  loading = signal(false);
  dl = signal(false);
  error = signal<string | null>(null);
  report = signal<SalesByRouteReport | null>(null);

  // Filtros SERVER-driven (re-agregan desde la tabla-hecho): disparan load().
  fProduct = signal<string | null>(null);
  fClient = signal<string | null>(null);

  // Filtros de vista (client-side): narran lo ya cargado sin round-trip al server.
  fBranch = signal<string[]>([]);          // warehouse_code
  fQuery = signal('');                     // texto libre: ruta o sucursal
  fMonthFrom = signal<string | null>(null); // rango de meses (mm)
  fMonthTo = signal<string | null>(null);
  fOnlyWithSales = signal(false);          // ocultar rutas en $0 del periodo
  fMinRevenue = signal<number | null>(null); // rango de venta del periodo
  fMaxRevenue = signal<number | null>(null);

  /** Sucursales presentes en el reporte (para el multiselect). */
  readonly branchOpts = computed<{ label: string; value: string }[]>(() => {
    const r = this.report();
    if (!r) return [];
    const seen = new Map<string, string>();
    for (const row of r.rows) if (!seen.has(row.warehouse_code)) seen.set(row.warehouse_code, row.warehouse_name);
    return [...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  });

  /** Meses del reporte (para los selects de rango). */
  readonly monthOpts = computed(() => (this.report()?.months ?? []).map((m) => ({ label: this.mes(m), value: m })));

  /** Meses visibles = subconjunto por el rango [desde, hasta]; sin rango = todos. */
  readonly visibleMonths = computed<string[]>(() => {
    const months = this.report()?.months ?? [];
    const from = this.fMonthFrom(); const to = this.fMonthTo();
    if (!from && !to) return months;
    const fi = from ? months.indexOf(from) : 0;
    const ti = to ? months.indexOf(to) : months.length - 1;
    const lo = Math.min(fi < 0 ? 0 : fi, ti < 0 ? months.length - 1 : ti);
    const hi = Math.max(fi < 0 ? 0 : fi, ti < 0 ? months.length - 1 : ti);
    return months.slice(lo, hi + 1);
  });

  readonly periodLabel = computed(() => {
    const from = this.fMonthFrom(); const to = this.fMonthTo();
    if (!from && !to) return '';
    const vm = this.visibleMonths();
    return vm.length ? `${this.mes(vm[0])}–${this.mes(vm[vm.length - 1])}` : '';
  });

  private periodAgg(row: SalesByRouteRow, months: string[]) {
    let revenue = 0, units = 0, tickets = 0;
    for (const m of months) { const c = row.monthly[m]; if (c) { revenue += c.revenue || 0; units += c.units || 0; tickets += c.tickets || 0; } }
    return { revenue, units, tickets };
  }

  /** Todas las filas con agregados del periodo (denominador del share = gran total del periodo). */
  private readonly periodRows = computed<ViewRow[]>(() => {
    const r = this.report();
    if (!r) return [];
    const months = this.visibleMonths();
    const grand = r.rows.reduce((s, row) => s + this.periodAgg(row, months).revenue, 0);
    return r.rows.map((row) => {
      const a = this.periodAgg(row, months);
      return { ...row, _revenue: a.revenue, _units: a.units, _tickets: a.tickets, _share: grand > 0 ? (a.revenue / grand) * 100 : 0 };
    });
  });

  /** Filas visibles = periodo + sucursal + búsqueda + solo-con-venta + rango $. */
  readonly filteredRows = computed<ViewRow[]>(() => {
    const wh = this.fBranch();
    const q = this.fQuery().trim().toLowerCase();
    const only = this.fOnlyWithSales();
    const min = this.fMinRevenue(); const max = this.fMaxRevenue();
    return this.periodRows().filter((row) => {
      if (wh.length && !wh.includes(row.warehouse_code)) return false;
      if (q) { const hay = `${row.warehouse_name} ${row.route_no} ${row.route_code}`.toLowerCase(); if (!hay.includes(q)) return false; }
      if (only && row._revenue <= 0) return false;
      if (min != null && row._revenue < min) return false;
      if (max != null && row._revenue > max) return false;
      return true;
    });
  });

  /** Totales por mes recalculados sobre lo filtrado (footer coherente con la vista). */
  readonly viewMonthlyTotals = computed<Record<string, SalesByRouteCell>>(() => {
    const months = this.visibleMonths();
    const acc: Record<string, SalesByRouteCell> = {};
    for (const m of months) acc[m] = { revenue: 0, units: 0, tickets: 0 };
    for (const row of this.filteredRows()) {
      for (const m of months) {
        const c = row.monthly[m];
        if (c) { acc[m].revenue += c.revenue || 0; acc[m].units += c.units || 0; acc[m].tickets += c.tickets || 0; }
      }
    }
    return acc;
  });

  /** Totales de la vista + share sobre el gran total del periodo (peso real del subconjunto). */
  readonly viewTotals = computed(() => {
    let revenue = 0, units = 0, tickets = 0;
    for (const row of this.filteredRows()) { revenue += row._revenue; units += row._units; tickets += row._tickets; }
    const months = this.visibleMonths();
    const grand = (this.report()?.rows ?? []).reduce((s, row) => s + this.periodAgg(row, months).revenue, 0);
    return { revenue, units, tickets, share: grand > 0 ? (revenue / grand) * 100 : 0 };
  });

  readonly hasViewFilters = computed(() =>
    this.fBranch().length > 0 || !!this.fQuery() || !!this.fMonthFrom() || !!this.fMonthTo() ||
    this.fOnlyWithSales() || this.fMinRevenue() != null || this.fMaxRevenue() != null);

  readonly kpiItems = computed<MetricStripItem[]>(() => {
    if (!this.report()) return [];
    const t = this.viewTotals();
    return [
      { label: 'Venta total', value: t.revenue, format: 'currency' },
      { label: 'Rutas', value: this.filteredRows().length },
      { label: 'Tickets', value: t.tickets },
      { label: 'Unidades', value: t.units },
    ];
  });

  clearViewFilters() {
    this.fBranch.set([]); this.fQuery.set('');
    this.fMonthFrom.set(null); this.fMonthTo.set(null);
    this.fOnlyWithSales.set(false); this.fMinRevenue.set(null); this.fMaxRevenue.set(null);
  }

  year = new Date().getFullYear();
  routes: string[] = [];

  // Desglose (side-peek)
  peekOpen = signal(false);
  detail = signal<SalesByRouteDetail | null>(null);
  detailLoading = signal(false);
  tab = signal<DetailTab>('productos');
  private dailyMax = 1;

  yearOpts = computed(() => { const y = new Date().getFullYear(); return [y, y - 1, y - 2]; });

  constructor() {
    this.svc.salesByRouteRoutes().pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (r) => this.routeOpts.set(r), error: () => undefined });
    this.svc.salesByRouteProducts().pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (r) => this.productOpts.set(r), error: () => undefined });
    this.svc.salesByRouteClients().pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (r) => this.clientOpts.set(r), error: () => undefined });
    this.load();
  }

  private params(): SalesByRouteParams {
    return {
      year: this.year,
      routes: this.routes.length ? this.routes : undefined,
      sku: this.fProduct() || undefined,
      client: this.fClient() || undefined,
    };
  }

  load() {
    this.loading.set(true);
    this.error.set(null);
    this.svc.salesByRoute(this.params())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.report.set(r); this.loading.set(false); },
        error: (e) => {
          this.loading.set(false);
          this.error.set(e?.error?.message || 'No se pudo consultar el reporte. Revisá la conexión e intentá de nuevo.');
        },
      });
  }

  download() {
    this.dl.set(true);
    this.svc.salesByRouteDownloadXlsx(this.params())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (resp) => {
          this.dl.set(false);
          const cd = resp.headers.get('content-disposition') || '';
          const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
          const name = m ? decodeURIComponent(m[1]) : `Ventas_por_Ruta_${this.year}.xlsx`;
          const url = URL.createObjectURL(resp.body!);
          const a = document.createElement('a'); a.href = url; a.download = name; a.click();
          URL.revokeObjectURL(url);
        },
        error: () => { this.dl.set(false); this.toast.add({ severity: 'error', summary: 'Error al descargar XLSX' }); },
      });
  }

  openRoute(row: SalesByRouteRow) {
    this.tab.set('productos');
    this.detail.set(null);
    this.detailLoading.set(true);
    this.peekOpen.set(true);
    this.svc.salesByRouteDetail(row.route_code, this.year)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (d) => {
          this.dailyMax = Math.max(1, ...d.daily.map((x) => x.revenue));
          this.detail.set(d);
          this.detailLoading.set(false);
        },
        error: (e) => {
          this.detailLoading.set(false);
          this.peekOpen.set(false);
          this.toast.add({ severity: 'error', summary: 'Error al cargar el desglose', detail: e?.error?.message });
        },
      });
  }

  barPct(v: number): number { return this.dailyMax > 0 ? Math.round((v / this.dailyMax) * 100) : 0; }

  mes(m: string): string { return MES[m] ?? m; }
  cell(row: SalesByRouteRow, m: string) { return row.monthly[m]; }
}
