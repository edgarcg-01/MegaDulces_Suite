import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
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
  SalesByRouteTicket,
  SalesByRouteTicketDetail,
  SalesByRouteTicketsPage,
  SalesByRouteTicketsParams,
  VecinalConciliacion,
  VecinalConciliacionFila,
  VecinalVeredicto,
  RouteCreditSales,
} from '../comercial.service';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { REPORTS_TABS } from '../reports-tabs';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { RouteClosureReconComponent } from './comercial-route-closure-recon.component';
import { VecinalReconComponent } from './comercial-vecinal-recon.component';
import { RutaCajaCaosComponent } from './comercial-ruta-caja-caos.component';
import { CaosService, RutaCajaReporte } from '../../finanzas/caos.service';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { RoutePromoComponent } from './comercial-route-promo.component';

type DetailTab = 'productos' | 'unidades' | 'dias' | 'clientes' | 'tickets' | 'deposito';

/**
 * `[VEC.12.2]` Un día de la ruta contra el dinero que se contó.
 *
 * `deposito` y `diff` son `number | null` a propósito: `null` = **no se puede atribuir a esta
 * ruta**, y entonces `motivo` dice por qué. Un 0 ahí significaría «no depositó», que es otra cosa.
 */
type ArqDia = {
  date: string;
  venta_ruta: number;
  /**
   * `[VEC.21]` Lo que ese día la ruta facturó **a crédito** (`U-D-8`), y cuánto de eso se cobró.
   *
   * ⛔ Va en la MISMA tabla y no en un panel aparte (pedido de Edgar): la pregunta de esta
   * pestaña es *"el dinero de esta ruta, ¿llegó?"*, y el crédito es parte de esa pregunta — sólo
   * que con otro calendario. Se factura un día y se cobra otro, por eso no entra al cuadre del
   * arqueo: **no es que falte, es que todavía no vence**.
   */
  credito: number;
  credito_cobrado: number;
  credito_saldo: number;
  /** Facturas a crédito vencidas de ese día. Es lo único accionable del renglón. */
  credito_vencidas: number;
  /** El efectivo contado en su(s) caja(s). Se muestra SIEMPRE: existe aunque no sea sólo suyo. */
  deposito: number | null;
  /** `efectivo_esperado − efectivo_contado` de la caja. `null` = todavía nadie la cerró. */
  diff: number | null;
  /**
   * ⛔ CUATRO estados, no tres. `sin_medir` no es «no cuadra»: es que no hay arqueo con qué
   * juzgarlo, y mezclarlos bajaría el cumplimiento por algo que nadie midió (ADR-056).
   */
  estado: 'cuadra' | 'falta' | 'sobra' | 'sin_medir';
  /** `false` cuando la caja fue compartida: un faltante NO es atribuible a esta ruta. */
  atribuible: boolean;
  /** Por qué no es atribuible. Sólo se lee cuando el día SÍ se midió. */
  motivo: string | null;
  /**
   * ⛔ Campo aparte, y no un `motivo` reusado: son dos preguntas distintas. Con uno solo, el
   * `??=` dejaba el día de hoy diciendo «caja compartida con 1V002» donde lo cierto es que
   * **todavía no hay arqueo** — una respuesta correcta a la pregunta que nadie hizo.
   */
  sin_medir: string | null;
};

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
    FreshnessPillComponent,
    CommonModule, FormsModule, ButtonModule, SelectModule, MultiSelectModule,
    ToastModule, TableModule, InputTextModule, InputNumberModule, CheckboxModule,
    IconFieldModule, InputIconModule,
    RouterLink, LoadStateComponent, PageTabsComponent, SidePeekComponent, MetricStripComponent, RouteClosureReconComponent, VecinalReconComponent, RutaCajaCaosComponent, RoutePromoComponent,
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
        @if (report(); as r) {
          <app-freshness-pill measures="data" [freshness]="r.freshness" label="Venta" />
        }
      </header>

      <!-- RR — Conciliación cierre de ruta (corte vendedor vs venta real, D+1) -->
      <app-route-closure-recon />

      <!-- [VEC.10] — La vecinal contra el dinero que se contó en SU caja (arqueo de la sucursal).
           Va aparte del de arriba a propósito: ése cruza el corte que sube el vendedor de RD, y la
           vecinal no sube corte — se timbra en una caja y su testigo es el arqueo. -->
      <app-vecinal-recon />

      <!-- [CG.58.7] — La ruta y su DINERO: lo que deposito en la caja fuerte (CAOS) y la entrada
           que esa caja genero en Caja General. Va despues del panel de la vecinal porque es el
           otro circuito: las rutas directas depositan en CAOS, la vecinal se arquea en su caja. -->
      <app-ruta-caja-caos />

      <!-- RR-PROMO — Agente AI: calcula incentivos de ruta desde el enunciado de la promo -->
      <app-comercial-route-promo />

      <div class="rr-filters card-premium card-flat">
        <div class="rr-field rr-year">
          <label>Año</label>
          <p-select [options]="yearOpts()" [(ngModel)]="year" appendTo="body" (onChange)="load()" />
        </div>
        <div class="rr-field rr-wh">
          <label>Rutas</label>
          <p-multiselect [options]="routeOpts()" [(ngModel)]="routes" optionLabel="label" optionValue="value"
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
          <button pButton size="small" [loading]="loading()" (click)="load()"><span class="p-button-icon p-button-icon-left pi pi-search" aria-hidden="true"></span><span class="p-button-label">Consultar</span></button>
        </div>
      </div>

      <!-- Filtros de vista (client-side, instantáneos sobre lo cargado) -->
      @if (report()?.rows?.length) {
        <div class="rr-viewfilters">
          <p-multiselect [options]="branchOpts()" [ngModel]="fBranch()" (ngModelChange)="fBranch.set($event)"
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
            <p-inputnumber [ngModel]="fMinRevenue()" (ngModelChange)="fMinRevenue.set($event)" mode="currency" currency="MXN"
                           [maxFractionDigits]="0" [showButtons]="false" placeholder="Venta mín" inputStyleClass="rr-vf-num" ariaLabel="Venta mínima" />
            <span class="rr-vf-dash">–</span>
            <p-inputnumber [ngModel]="fMaxRevenue()" (ngModelChange)="fMaxRevenue.set($event)" mode="currency" currency="MXN"
                           [maxFractionDigits]="0" [showButtons]="false" placeholder="Venta máx" inputStyleClass="rr-vf-num" ariaLabel="Venta máxima" />
          </div>
          <label class="rr-vf-chk"><p-checkbox [binary]="true" [ngModel]="fOnlyWithSales()" (ngModelChange)="fOnlyWithSales.set($event)" inputId="rr-only" /> Solo con venta</label>
          @if (hasViewFilters()) {
            <button pButton type="button" class="p-button-sm p-button-text" (click)="clearViewFilters()"><span class="p-button-icon p-button-icon-left pi pi-filter-slash" aria-hidden="true"></span><span class="p-button-label">Limpiar filtros</span></button>
          }
        </div>
      }

      @if (error()) {
        <div class="rr-error" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span>{{ error() }}</span>
          <button pButton type="button" class="p-button-sm p-button-text" (click)="load()"><span class="p-button-label">Reintentar</span></button>
        </div>
      }

      @if (report(); as r) {
        @if (r.rows.length) {
          <app-metric-strip [items]="kpiItems()" ariaLabel="Resumen de ventas por ruta" />


          <div class="so-actions-bar">
            <span class="text-xs text-content-muted">{{ filteredRows().length }}@if (filteredRows().length !== r.rows.length) { de {{ r.rows.length }}} rutas · año {{ r.year }}@if (periodLabel()) { · {{ periodLabel() }}}</span>
            <button pButton size="small" severity="secondary" [outlined]="true" [loading]="dl()" (click)="download()"><span class="p-button-icon p-button-icon-left pi pi-file-excel" aria-hidden="true"></span><span class="p-button-label">XLSX</span></button>
          </div>

          @if (filteredRows().length) {
          <div class="card-premium card-flat rr-table-card">
            <p-table [value]="filteredRows()" [loading]="loading()" [rowHover]="true"
                     [scrollable]="true" scrollHeight="60vh"
                     sortField="_revenue" [sortOrder]="-1"
                     styleClass="p-datatable-sm surf-table rr-ptable">
              <ng-template #header>
                <tr>
                  <th scope="col" pFrozenColumn style="min-width:150px" pSortableColumn="warehouse_name">Sucursal <p-sorticon field="warehouse_name" /></th>
                  <th scope="col" pFrozenColumn style="min-width:120px" pSortableColumn="route_no">Ruta <p-sorticon field="route_no" /></th>
                  @for (m of visibleMonths(); track m) {
                    <th scope="col" class="comm-num" [pSortableColumn]="'monthly.' + m + '.revenue'">{{ mes(m) }} <p-sorticon [field]="'monthly.' + m + '.revenue'" /></th>
                  }
                  <th scope="col" class="comm-num rr-strong" pSortableColumn="_revenue">Total <p-sorticon field="_revenue" /></th>
                  <th scope="col" class="comm-num" pSortableColumn="_share">Share <p-sorticon field="_share" /></th>
                  <th scope="col" class="comm-num" pSortableColumn="_tickets">Tickets <p-sorticon field="_tickets" /></th>
                </tr>
              </ng-template>
              <ng-template #body let-row>
                <tr class="rr-row" (click)="openRoute(row)" title="Ver desglose de la ruta">
                  <td pFrozenColumn class="comm-cell-strong">{{ row.warehouse_name }}</td>
                  <td pFrozenColumn class="rr-strong">
                    <!-- Botón real: el drill es accesible por teclado (la fila (click) queda para mouse). -->
                    <button type="button" class="rr-link" (click)="$event.stopPropagation(); openRoute(row)"
                            [attr.aria-label]="'Ver desglose de la ruta ' + row.route_no">Ruta {{ row.route_no }}</button>
                  </td>
                  @for (m of visibleMonths(); track m) {
                    <td class="comm-num">
                      @if (cell(row, m)?.revenue) {
                        <!-- La celda abre la ruta ACOTADA a ese mes: es el drill más barato
                             (1.2 s medido) y el más usado. -->
                        <button type="button" class="rr-cell-link" (click)="$event.stopPropagation(); openRoute(row, m)"
                                [attr.aria-label]="'Ver la ruta ' + row.route_no + ' en ' + mes(m)">{{ cell(row, m)!.revenue | currency:'MXN':'symbol-narrow':'1.0-0' }}</button>
                      } @else { · }
                    </td>
                  }
                  <td class="comm-num rr-strong">{{ row._revenue | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  <td class="comm-num comm-muted">{{ row._share | number:'1.0-1' }}%</td>
                  <td class="comm-num">{{ row._tickets | number }}</td>
                </tr>
              </ng-template>
              <ng-template #footer>
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
              <h3>Sin coincidencias</h3><p>Ninguna ruta coincide con los filtros de vista. <button pButton type="button" class="p-button-sm p-button-text" (click)="clearViewFilters()"><span class="p-button-label">Limpiar filtros</span></button></p></div>
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
          <h3>Ventas por ruta</h3><p>Elige las rutas; el reporte carga automáticamente.</p></div>
      }

      <!-- Ventana y no cajón: el desglose trae nueve métricas y una tabla de productos, y en
           los 520px del cajón el nombre del producto salía partido en tres renglones. Se cede
           el ver-sin-perder-la-lista a cambio de poder leer. Ver la nota del input mode. -->
      <app-side-peek [(open)]="peekOpen"
                     mode="window"
                     [title]="detail()?.warehouse_name || 'Ruta'"
                     [subtitle]="detailSubtitle()">
        @if (detailLoading()) {
          <div class="rr-detail-loading"><i class="pi pi-spin pi-spinner"></i> Cargando desglose…</div>
        }
        @if (detail(); as d) {
          <div class="rr-rhythm-head">
            <div>
              <span>Ritmo de venta</span>
              <p>La venta identificada se explica por clientes, artículos y unidades.</p>
            </div>
            <small>Venta/cliente = artículos distintos/cliente × valor/artículo = unidades/cliente × valor/unidad</small>
          </div>
          <div class="rr-dkpis">
            <div class="rr-dkpi"><span>Venta total</span><b>{{ d.totals.revenue | currency:'MXN':'symbol-narrow':'1.0-0' }}</b></div>
            <div class="rr-dkpi"><span>Tickets</span><b>{{ d.totals.tickets | number }}</b></div>
            <!-- RR4 — Los promedios van POR CLIENTE (la tiendita), no por ticket. El público
                 no tiene identidad de cliente: queda fuera del promedio y se declara su peso. -->
            <div class="rr-dkpi"><span>Clientes atendidos</span><b>{{ d.per_client.clients | number }}</b><em>clientes identificados en esta ruta</em>
              @if (d.per_client.public_pct > 0) { <em>+ público sin identificar: {{ d.per_client.public_pct | number:'1.0-1' }}% de la venta</em> }</div>
            <div class="rr-dkpi"><span>Venta promedio/cliente</span>
              @if (d.per_client.avg_revenue != null) { <b>{{ d.per_client.avg_revenue | currency:'MXN':'symbol-narrow':'1.0-0' }}</b> } @else { <b class="rr-nodata">—</b> }
              <em>sólo venta identificada</em></div>
            <div class="rr-dkpi"><span>Artículos/cliente</span>
              @if (d.per_client.avg_skus != null) { <b>{{ d.per_client.avg_skus | number:'1.0-2' }}</b> } @else { <b class="rr-nodata">—</b> }
              <em>SKU distintos por cliente</em></div>
            <div class="rr-dkpi"><span>Valor promedio/artículo</span>
              @if (d.per_client.avg_value_per_article != null) { <b>{{ d.per_client.avg_value_per_article | currency:'MXN':'symbol-narrow':'1.2-2' }}</b> } @else { <b class="rr-nodata">—</b> }
              <em>venta identificada ÷ artículos distintos</em></div>
            <div class="rr-dkpi"><span>Unidades/cliente</span>
              @if (d.per_client.avg_units != null) { <b>{{ d.per_client.avg_units | number:'1.0-2' }}</b> } @else { <b class="rr-nodata">—</b> }
              <em>unidades compradas por cliente</em></div>
            <div class="rr-dkpi"><span>Valor unidad promedio</span>
              @if (d.per_client.avg_unit_value != null) { <b>{{ d.per_client.avg_unit_value | currency:'MXN':'symbol-narrow':'1.2-2' }}</b> } @else { <b class="rr-nodata">—</b> }
              <em>venta identificada ÷ unidades</em></div>
            <div class="rr-dkpi"><span>Visitas/cliente</span>
              @if (d.per_client.avg_tickets != null) { <b>{{ d.per_client.avg_tickets | number:'1.0-1' }}</b> } @else { <b class="rr-nodata">—</b> }
              <em>documentos por cliente</em></div>
            <!-- Margen: siempre acompañado de su cobertura. El push de camionetas no trae
                 costo, así que un margen "a secas" mezclaría peras con manzanas. -->
            <div class="rr-dkpi rr-dkpi-wide">
              <span>Margen</span>
              @if (d.margin.margin_pct != null) {
                <b>{{ d.margin.margin_pct | number:'1.0-1' }}%</b>
                <em>sobre {{ d.margin.coverage_pct | number:'1.0-0' }}% de la venta (lo que trae costo en la fuente)</em>
              } @else {
                <b class="rr-nodata">—</b><em>la fuente de esta ruta no trae costo</em>
              }
            </div>
          </div>

          <!-- El filtro ES el estado: cada click agrega una faceta y queda visible acá.
               Sin esto, "todo clickeable" se vuelve un laberinto sin salida. -->
          <div class="rr-chips" role="group" aria-label="Filtros del desglose">
            <span class="rr-chip rr-chip-fixed">Ruta {{ d.route_no }}</span>
            <button type="button" class="rr-chip" (click)="toggleFullYear()"
                    [attr.aria-label]="'Periodo: ' + scopeLabel() + '. Cambiar'">
              <i class="pi pi-calendar" aria-hidden="true"></i> {{ scopeLabel() }}
            </button>
            @if (dSku(); as s) {
              <button type="button" class="rr-chip rr-chip-on" (click)="dSku.set(null); reloadDetail()">
                SKU {{ s }} <i class="pi pi-times" aria-hidden="true"></i>
              </button>
            }
            @if (dClient(); as c) {
              <button type="button" class="rr-chip rr-chip-on" (click)="dClient.set(null); reloadDetail()">
                {{ dClientName() || c }} <i class="pi pi-times" aria-hidden="true"></i>
              </button>
            }
            @if (dUnit(); as u) {
              <button type="button" class="rr-chip rr-chip-on" (click)="dUnit.set(null); reloadDetail()">
                Unidad {{ u }} <i class="pi pi-times" aria-hidden="true"></i>
              </button>
            }
            @if (dDay(); as day) {
              <button type="button" class="rr-chip rr-chip-on" (click)="dDay.set(null); reloadDetail()">
                {{ day }} <i class="pi pi-times" aria-hidden="true"></i>
              </button>
            }
            @if (hasDrill()) {
              <button type="button" class="rr-chip rr-chip-clear" (click)="clearDrill()">Quitar filtros</button>
            }
          </div>

          <div class="rr-tabs" role="radiogroup">
            <button type="button" role="radio" [class.on]="tab()==='productos'" [attr.aria-checked]="tab()==='productos'" (click)="setTab('productos')">Productos</button>
            <button type="button" role="radio" [class.on]="tab()==='unidades'" [attr.aria-checked]="tab()==='unidades'" (click)="setTab('unidades')">Unidades</button>
            <button type="button" role="radio" [class.on]="tab()==='dias'" [attr.aria-checked]="tab()==='dias'" (click)="setTab('dias')">Por día</button>
            <button type="button" role="radio" [class.on]="tab()==='clientes'" [attr.aria-checked]="tab()==='clientes'" (click)="setTab('clientes')">Clientes</button>
            <button type="button" role="radio" [class.on]="tab()==='tickets'" [attr.aria-checked]="tab()==='tickets'" (click)="setTab('tickets')">Tickets</button>
            <button type="button" role="radio" [class.on]="tab()==='deposito'" [attr.aria-checked]="tab()==='deposito'" (click)="setTab('deposito')">Depósito</button>
          </div>

          @switch (tab()) {
            @case ('productos') {
              <p-table [value]="detail()!.products" styleClass="p-datatable-sm surf-table" [scrollable]="true" scrollHeight="52vh">
                <ng-template #header><tr>
                  <th scope="col">Producto</th><th scope="col" class="comm-num">Unid</th>
                  <th scope="col" class="comm-num">U/ren</th>
                  <th scope="col" class="comm-num">Importe</th><th scope="col" class="comm-num">%</th></tr>
                </ng-template>
                <ng-template #body let-p>
                  <tr class="rr-row" (click)="drillSku(p.sku)" [title]="'Ver tickets con ' + p.sku">
                    <td class="rr-prod">
                      <button type="button" class="rr-link" (click)="$event.stopPropagation(); drillSku(p.sku)"
                              [attr.aria-label]="'Filtrar por el producto ' + p.sku">
                        <span class="rr-sku">{{ p.sku }}</span> {{ p.name }}
                      </button>
                    </td>
                    <td class="comm-num">{{ p.units | number:'1.0-0' }}</td>
                    <td class="comm-num comm-muted">{{ p.units_per_line | number:'1.0-2' }}</td>
                    <td class="comm-num rr-strong">{{ p.revenue | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                    <td class="comm-num comm-muted">{{ p.share_pct | number:'1.0-1' }}%</td>
                  </tr>
                </ng-template>
              </p-table>
              <p class="rr-note">Top 50 por importe. <b>U/ren</b> = unidades por renglón: dice si el producto se lleva de a uno o de a bulto.</p>
            }
            @case ('unidades') {
              <p-table [value]="detail()!.units_mix" styleClass="p-datatable-sm surf-table" [scrollable]="true" scrollHeight="52vh">
                <ng-template #header><tr>
                  <th scope="col">Unidad</th><th scope="col" class="comm-num">Renglones</th>
                  <th scope="col" class="comm-num">Cantidad</th><th scope="col" class="comm-num">Importe</th>
                  <th scope="col" class="comm-num">%</th></tr>
                </ng-template>
                <ng-template #body let-u>
                  <tr class="rr-row" (click)="drillUnit(u.unidad)" [title]="u.unidad ? ('Ver tickets en ' + u.unidad) : ''">
                    <td class="comm-cell-strong">
                      @if (u.unidad) {
                        <button type="button" class="rr-link" (click)="$event.stopPropagation(); drillUnit(u.unidad)"
                                [attr.aria-label]="'Filtrar por la unidad ' + u.unidad">{{ u.unidad }}</button>
                      } @else { — }
                    </td>
                    <td class="comm-num">{{ u.lines | number }}</td>
                    <td class="comm-num">{{ u.units | number:'1.0-2' }}</td>
                    <td class="comm-num rr-strong">{{ u.revenue | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                    <td class="comm-num comm-muted">{{ u.share_pct | number:'1.0-1' }}%</td>
                  </tr>
                </ng-template>
              </p-table>
              <p class="rr-note">Unidad tal como la declara la fuente (Wincaja: catálogo del artículo · Kepler: renglón del documento). "—" = SKU sin unidad en el catálogo de esa fuente.</p>
            }
            @case ('dias') {
              <!-- [CG.58.7] La venta del día y lo que ESE día se depositó en la caja fuerte, en el
                   mismo renglón: eso es conciliar. El día del depósito es el que DECLARA su texto,
                   no el día en que se hizo (la ruta vuelve al otro día). -->
              <p-table [value]="detail()!.daily" styleClass="p-datatable-sm surf-table" [scrollable]="true" scrollHeight="52vh">
                <ng-template #header><tr>
                  <th scope="col">Día</th><th scope="col" class="comm-num">Tickets</th>
                  <th scope="col" class="comm-num">Venta</th>
                  @if (!esRutaVecinal()) {
                    <th scope="col" class="comm-num">Depositado</th>
                    <th scope="col">Entrada a Caja General</th>
                  }
                  <th scope="col" class="rr-barcol"><span class="sr-only">Proporción</span></th></tr>
                </ng-template>
                <ng-template #body let-x>
                  <tr class="rr-row" (click)="drillDay(x.date)" [title]="'Ver tickets del ' + x.date">
                    <td>
                      <button type="button" class="rr-link" (click)="$event.stopPropagation(); drillDay(x.date)"
                              [attr.aria-label]="'Filtrar por el día ' + x.date">{{ x.date }}</button>
                    </td>
                    <td class="comm-num">{{ x.tickets | number }}</td>
                    <td class="comm-num rr-strong">{{ x.revenue | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                    @if (!esRutaVecinal()) {
                      <td class="comm-num">
                        @if (depDelDia(x.date); as d) { {{ d.monto | currency:'MXN':'symbol-narrow':'1.0-0' }} }
                        @else { <span class="comm-muted">—</span> }
                      </td>
                      <td>
                        @if (depDelDia(x.date); as d) {
                          @for (f of d.folios; track f.folio) {
                            <a class="rr-link rr-mono" [routerLink]="['/finanzas/caja-general']"
                               [queryParams]="{ q: f.folio, from: f.fecha, to: f.fecha }"
                               [attr.aria-label]="'Abrir ' + f.folio + ' en Caja General'">{{ f.folio }}</a>
                          }
                          @if (d.sin_capturar) {
                            <span class="comm-muted">{{ d.sin_capturar }} sin capturar</span>
                          }
                        } @else { <span class="comm-muted">—</span> }
                      </td>
                    }
                    <td class="rr-barcol"><span class="rr-bar" [style.width.%]="barPct(x.revenue)"></span></td>
                  </tr>
                </ng-template>
              </p-table>
              @if (!esRutaVecinal()) {
                @if (depCargando()) {
                  <p class="rr-note">Buscando los depósitos de esta ruta…</p>
                } @else if (depError()) {
                  <p class="rr-note rr-dep-bad-txt">{{ depError() }}</p>
                } @else {
                  <p class="rr-note">
                    «Depositado» es lo que entró a la caja fuerte declarando <strong>este día</strong>
                    en el texto del depósito.
                    @if (depSinDia().n) {
                      Esta ruta tiene además
                      <strong>{{ depSinDia().n }}</strong> depósitos por
                      <strong>{{ depSinDia().monto | currency:'MXN':'symbol-narrow':'1.0-0' }}</strong>
                      cuyo texto <strong>declara la ruta pero no el día</strong>: no se pueden poner en
                      ningún renglón, y se ven completos en la pestaña Depósito.
                    }
                    ⛔ Venta y depósito <strong>no son el mismo universo</strong> —la venta incluye
                    crédito y otros medios de pago, el depósito es sólo efectivo—, así que acá
                    <strong>no se resta</strong> una de otra: se muestran lado a lado.
                  </p>
                }
              }
            }
            @case ('clientes') {
              <p-table [value]="detail()!.clients" styleClass="p-datatable-sm surf-table" [scrollable]="true" scrollHeight="52vh">
                <ng-template #header><tr>
                  <th scope="col">Cliente</th><th scope="col" class="comm-num">Tickets</th>
                  <th scope="col" class="comm-num">Importe</th></tr>
                </ng-template>
                <ng-template #body let-c>
                  <!-- El público no es UN cliente: es el mostrador a bordo. No se puede filtrar por él. -->
                  <tr [class.rr-row]="!c.is_public" (click)="c.is_public ? null : drillClient(c.code, c.name)"
                      [title]="c.is_public ? 'Venta sin cliente identificado' : ('Ver tickets de ' + c.name)">
                    <td>
                      @if (c.is_public) {
                        {{ c.name }} <span class="rr-tag">público</span>
                      } @else {
                        <button type="button" class="rr-link" (click)="$event.stopPropagation(); drillClient(c.code, c.name)"
                                [attr.aria-label]="'Filtrar por el cliente ' + c.name">{{ c.name }}</button>
                      }
                    </td>
                    <td class="comm-num">{{ c.tickets | number }}</td>
                    <td class="comm-num rr-strong">{{ c.revenue | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  </tr>
                </ng-template>
              </p-table>
              <p class="rr-note">Top 50 por importe. "Público" = venta a bordo sin cliente identificado (no es filtrable: no es un cliente).</p>
            }
            @case ('tickets') {
              @if (ticket(); as t) {
                <!-- Detalle de UN ticket (master-detail dentro del mismo panel) -->
                <div class="rr-tk-head">
                  <button pButton type="button" class="p-button-sm p-button-text" (click)="closeTicket()">
                    <span class="p-button-icon p-button-icon-left pi pi-arrow-left" aria-hidden="true"></span>
                    <span class="p-button-label">Tickets</span>
                  </button>
                  <span class="rr-mono rr-strong">{{ t.folio }}</span>
                  @if (t.doc_type) { <span class="rr-tag">{{ t.doc_type }}</span> }
                  <span class="rr-tag rr-tag-src">{{ t.source === 'push' ? 'push' : 'wincaja' }}</span>
                </div>
                <div class="rr-tk-meta">
                  <div><span>Fecha</span><b>{{ t.date }}@if (t.time) { · {{ t.time }}}</b></div>
                  <div><span>Cliente</span><b>{{ t.client_name || '—' }}</b></div>
                  <div><span>Pago</span><b>{{ t.payment_method_label || '—' }}</b></div>
                  <div><span>Vendedor</span><b>{{ t.seller || '—' }}</b></div>
                  <div><span>Importe</span><b>{{ t.revenue | currency:'MXN':'symbol-narrow':'1.2-2' }}</b></div>
                  <div><span>Margen</span><b>{{ t.margin_pct != null ? (t.margin_pct | number:'1.0-1') + '%' : '—' }}</b></div>
                </div>
                <p-table [value]="t.lines_detail" styleClass="p-datatable-sm surf-table" [scrollable]="true" scrollHeight="42vh">
                  <ng-template #header><tr>
                    <th scope="col">Producto</th>
                    <th scope="col" class="comm-num">Cant</th>
                    <th scope="col">Unidad</th>
                    <th scope="col" class="comm-num">Precio</th>
                    <th scope="col" class="comm-num">Importe</th>
                    <th scope="col" class="comm-num">Margen</th></tr>
                  </ng-template>
                  <ng-template #body let-l><tr>
                    <td class="rr-prod">
                      <button type="button" class="rr-link" (click)="drillSku(l.sku)"
                              [attr.aria-label]="'Ver todos los tickets con ' + l.sku">
                        <span class="rr-sku">{{ l.sku }}</span> {{ l.name || '' }}
                      </button>
                    </td>
                    <td class="comm-num">{{ l.qty | number:'1.0-2' }}</td>
                    <td>
                      {{ l.unidad || '—' }}
                      @if (l.boxes != null) { <em class="rr-eq">= {{ l.boxes | number:'1.0-2' }} cja</em> }
                    </td>
                    <td class="comm-num">{{ l.precio_unitario != null ? (l.precio_unitario | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }}</td>
                    <td class="comm-num rr-strong">{{ l.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                    <td class="comm-num comm-muted">{{ l.margin_pct != null ? (l.margin_pct | number:'1.0-1') + '%' : '—' }}</td></tr>
                  </ng-template>
                </p-table>
                <p class="rr-note">
                  {{ t.lines | number }} renglones · {{ t.skus | number }} SKUs.
                  La equivalencia en cajas se imprime sólo con factor de empaque real y compra ≥ 1 caja.
                  @if (t.source === 'push') { El push de camionetas no trae costo ni impuestos por renglón. }
                </p>
              } @else {
                <!-- Lista paginada de tickets (server-side) -->
                <div class="rr-tk-filters">
                  <p-iconfield styleClass="rr-tk-search">
                    <p-inputicon styleClass="pi pi-search" />
                    <input pInputText type="text" [ngModel]="tkQuery()" (ngModelChange)="tkQuery.set($event)"
                           (keyup.enter)="loadTickets(true)" placeholder="Folio o cliente…" aria-label="Buscar folio o cliente" />
                  </p-iconfield>
                  <p-select [options]="tkUnitOpts()" [ngModel]="tkUnit()" (ngModelChange)="tkUnit.set($event); loadTickets(true)"
                            optionLabel="label" optionValue="value" placeholder="Unidad" [showClear]="true"
                            appendTo="body" styleClass="rr-tk-sel" ariaLabel="Filtrar por unidad" />
                  <p-select [options]="docTypeOpts" [ngModel]="tkDocType()" (ngModelChange)="tkDocType.set($event); loadTickets(true)"
                            optionLabel="label" optionValue="value" placeholder="Tipo" [showClear]="true"
                            appendTo="body" styleClass="rr-tk-sel" ariaLabel="Filtrar por tipo de documento" />
                  <button pButton size="small" severity="secondary" [outlined]="true" (click)="loadTickets(true)">
                    <span class="p-button-icon p-button-icon-left pi pi-search" aria-hidden="true"></span>
                    <span class="p-button-label">Buscar</span>
                  </button>
                </div>
                @if (tkPage(); as pg) {
                  <div class="rr-tk-sum">
                    <span>{{ pg.total | number }} tickets</span>
                    <span>{{ pg.totals.revenue | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
                    <span>prom. {{ pg.totals.avg_ticket | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
                  </div>
                }
                <p-table [value]="tkPage()?.rows || []" [loading]="tkLoading()" [rowHover]="true"
                         [lazy]="true" (onLazyLoad)="onTicketsLazy($event)"
                         [paginator]="true" [rows]="tkLimit" [first]="tkOffset()"
                         [totalRecords]="tkPage()?.total || 0"
                         [scrollable]="true" scrollHeight="42vh"
                         styleClass="p-datatable-sm surf-table">
                  <ng-template #header><tr>
                    <th scope="col" pSortableColumn="date">Fecha <p-sorticon field="date" /></th>
                    <th scope="col">Folio</th>
                    <th scope="col">Cliente</th>
                    <th scope="col" class="comm-num" pSortableColumn="lines">Líneas <p-sorticon field="lines" /></th>
                    <th scope="col" class="comm-num">U/ren</th>
                    <th scope="col" class="comm-num" pSortableColumn="revenue">Importe <p-sorticon field="revenue" /></th>
                    <th scope="col" class="comm-num" pSortableColumn="margin">Margen <p-sorticon field="margin" /></th></tr>
                  </ng-template>
                  <ng-template #body let-t>
                    <tr class="rr-row" (click)="openTicket(t)" title="Ver renglones del ticket">
                      <td>{{ t.date }}@if (t.time) { <em class="rr-hh">{{ t.time }}</em> }</td>
                      <td>
                        <button type="button" class="rr-link rr-mono" (click)="$event.stopPropagation(); openTicket(t)"
                                [attr.aria-label]="'Ver renglones del ticket ' + t.folio">{{ t.folio }}</button>
                      </td>
                      <td class="rr-tk-cli">
                        {{ t.client_name || '—' }}
                        @if (t.is_public) { <span class="rr-tag">público</span> }
                      </td>
                      <td class="comm-num">{{ t.lines | number }}</td>
                      <td class="comm-num comm-muted">{{ ticketUnitsPerLine(t) | number:'1.0-2' }}</td>
                      <td class="comm-num rr-strong">{{ t.revenue | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                      <td class="comm-num comm-muted">{{ t.margin_pct != null ? (t.margin_pct | number:'1.0-1') + '%' : '—' }}</td>
                    </tr>
                  </ng-template>
                  <ng-template #emptymessage>
                    <tr><td colspan="7" class="rr-tk-empty">Ningún ticket coincide con los filtros.</td></tr>
                  </ng-template>
                </p-table>
              }
            }
            @case ('deposito') {
              <!-- [CG.58.7] El dinero de ESTA ruta: su deposito en la caja fuerte (CAOS) y la
                   entrada que ese deposito genero en Caja General. El vinculo es estructural
                   (la entrada guarda de que deposito salio), por eso el folio es un enlace. -->
              @if (esRutaVecinal()) {
                <p class="rr-dep-nota">
                  <i class="pi pi-info-circle" aria-hidden="true"></i>
                  <span>
                    <strong>Esta ruta no deposita en la caja fuerte.</strong> La vecinal cobra en una
                    caja registradora de la sucursal, así que su dinero se cuenta en el
                    <strong>arqueo de esa caja</strong>, no en CAOS ni en Caja General.
                  </span>
                </p>
                <!-- [VEC.12] Antes esto terminaba acá, mandando a leer el panel de arriba. Pero la
                     pregunta de quien abre una ruta es "ésta, ¿entregó el dinero?", y remitir a
                     otro lado la deja sin responder donde se hace. Se muestran SUS cajas.
                     ⛔ El grano es la CAJA, no la ruta: una caja mezcla rutas y mostrador, asi que
                     la columna "% vecinal" dice cuanto del arqueo es atribuible -- y solo con 100
                     el descuadre es de la vecinal. Sin eso, el numero invita a culpar al que pasa. -->
                <app-load-state [loading]="arqCargando()" [error]="arqError()"
                                [isEmpty]="!arqCargando() && !arqError() && !arqFilas().length"
                                [skeletonRows]="5" emptyIcon="pi-wallet"
                                emptyTitle="Ninguna caja con arqueo declara esta ruta en el período"
                                emptyHint="El arqueo lo cierra la sucursal al terminar el turno. Si el período es reciente, puede que todavía no lo suban."
                                (retry)="recargarArqueo()">
                  @if (arqFilas().length) {
                    <!-- [VEC.12.2] Vendio vs deposito, por DIA. Fuera la columna "Caja": es
                         plomeria, y la pregunta es si el dinero llego.
                         ⛔ El cuadre por ruta NO siempre se puede: cash_cuts no tiene ruta (grano
                         sucursal/caja/turno, verificado), asi que solo cierra cuando la caja fue
                         de ESTA ruta sola y 100% vecinal. Medido: 129 de 735 dia-ruta (17.6%).
                         Donde no, se dice POR QUE en vez de dibujar una Δ que es de otro. -->
                    <p class="rr-dep-sub">
                      <strong>{{ arqCuadran() }}</strong> de {{ arqMedidos() }} día(s) medido(s)
                      <strong>cuadran</strong>.
                      @if (arqSinMedir()) {
                        <!-- ADR-056: un dia sin arqueo no es "no cuadra", es que todavia no hay
                             con que juzgarlo. Meterlo al denominador bajaria el cumplimiento por
                             algo que nadie midio. -->
                        {{ arqSinMedir() }} todavía sin arqueo, fuera de la cuenta.
                      }
                    </p>
                    <!-- dt-scope + dt-stack: ocho columnas que son CAMPOS del mismo dia, no un
                         pivote. ⚠️ El dt-stack SIN el dt-scope no apila nada: la consulta de
                         contenedor no tiene contra que medir, y se ve igual de roto pero en verde. -->
                    <div class="dt-scope">
                    <p-table [value]="arqDias()" size="small" class="dt-stack surf-table" [scrollable]="true" scrollHeight="46vh" [tableStyle]="{ 'min-width': '64rem' }">
                      <ng-template #header>
                        <tr>
                          <th scope="col">Día</th>
                          <!-- ⛔ Decía «Contado» y pinta venta_ruta: la VENTA de la ruta, no el
                               efectivo contado en el arqueo (ese es «Depósito»). Con el nombre
                               viejo la fila se leía como un cuadre entre dos cifras que no se
                               comparan — 12,764 contra 24,005 con Δ 0 — y la Δ es del ARQUEO
                               DE LA CAJA, no de estas dos columnas. -->
                          <th scope="col" class="comm-num">Venta de la ruta</th>
                          <th scope="col" class="comm-num">Depósito</th>
                          <th scope="col" class="comm-num">Δ</th>
                          <th scope="col">Cuadre</th>
                          <!-- [VEC.21] El credito en la MISMA tabla: es la otra mitad de "el
                               dinero de esta ruta, ¿llego?". Se factura un dia y se cobra otro,
                               por eso NO entra al cuadre del arqueo de arriba. -->
                          <th scope="col" class="comm-num">A crédito</th>
                          <th scope="col" class="comm-num">Cobrado</th>
                          <th scope="col" class="comm-num">Por cobrar</th>
                        </tr>
                      </ng-template>
                      <ng-template #body let-d>
                        <tr>
                          <td class="rr-mono" role="cell" data-label="Día">{{ d.date }}</td>
                          <td class="comm-num rr-mono rr-strong" role="cell" data-label="Venta de la ruta">{{ d.venta_ruta | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                          <!-- El deposito SE MUESTRA SIEMPRE: es un hecho de la caja y existe
                               aunque no se pueda atribuir a esta ruta sola. -->
                          <td class="comm-num rr-mono" role="cell" data-label="Depósito">
                            @if (d.deposito === null) { <span class="rr-tenue">—</span> }
                            @else { {{ d.deposito | currency:'MXN':'symbol-narrow':'1.0-0' }} }
                          </td>
                          <td class="comm-num rr-mono"
                              [class.rr-bad]="d.estado === 'falta'"
                              [class.rr-warn]="d.estado === 'sobra'" role="cell" data-label="Δ">
                            @if (d.diff === null) { <span class="rr-tenue">—</span> }
                            @else if (d.estado === 'cuadra') { 0 }
                            @else { {{ d.diff | currency:'MXN':'symbol-narrow':'1.0-0' }} }
                          </td>
                          <td role="cell" data-label="Cuadre">
                            @switch (d.estado) {
                              @case ('cuadra') { <span class="rr-ok">Cuadra</span> }
                              @case ('falta')  { <span class="rr-bad">No cuadra · falta</span> }
                              @case ('sobra')  { <span class="rr-warn">No cuadra · sobra</span> }
                              @default         { <span class="rr-tenue">{{ d.sin_medir ?? 'Sin arqueo' }}</span> }
                            }
                            @if (d.estado !== 'sin_medir' && !d.atribuible) {
                              <!-- Cuando CUADRA, compartir caja no estorba: si la caja cuadro, el
                                   dinero de esta ruta esta adentro. Cuando NO cuadra, de quien es
                                   el faltante no se puede saber -- y eso hay que decirlo. -->
                              <span class="rr-tenue rr-nota"> · {{ d.motivo }}</span>
                            }
                          </td>
                          <!-- ⛔ Un dia SIN credito muestra guion, no $0: "no facturo a credito"
                               y "facturo cero" no son lo mismo. -->
                          <td class="comm-num rr-mono" role="cell" data-label="A crédito">
                            @if (!d.credito) { <span class="rr-tenue">—</span> }
                            @else { {{ d.credito | currency:'MXN':'symbol-narrow':'1.0-0' }} }
                          </td>
                          <td class="comm-num rr-mono" role="cell" data-label="Cobrado">
                            @if (!d.credito) { <span class="rr-tenue">—</span> }
                            @else { {{ d.credito_cobrado | currency:'MXN':'symbol-narrow':'1.0-0' }} }
                          </td>
                          <td class="comm-num rr-mono rr-strong" role="cell" data-label="Por cobrar"
                              [class.rr-bad]="d.credito_vencidas > 0">
                            @if (!d.credito) { <span class="rr-tenue">—</span> }
                            @else {
                              {{ d.credito_saldo | currency:'MXN':'symbol-narrow':'1.0-0' }}
                              @if (d.credito_vencidas) {
                                <span class="rr-nota"> · {{ d.credito_vencidas }} vencida(s)</span>
                              }
                            }
                          </td>
                        </tr>
                      </ng-template>
                    </p-table>
                    </div>
                    @if (creditoError()) {
                      <!-- ⛔ Se declara, no se dibuja en blanco: columnas vacías sin aviso se
                           leen como "no vendió a crédito", que es otra cosa. -->
                      <p class="rr-dep-sub rr-warn">
                        No se pudo leer la venta a crédito de esta ruta: las tres últimas columnas
                        están vacías por eso, no porque no haya.
                      </p>
                    } @else if (creditoTotal() > 0) {
                      <p class="rr-dep-sub">
                        A crédito en el período: <strong>{{ creditoTotal() | currency:'MXN':'symbol-narrow':'1.0-0' }}</strong>,
                        por cobrar <strong>{{ creditoPorCobrar() | currency:'MXN':'symbol-narrow':'1.0-0' }}</strong>.
                        Esto <strong>no entra al cuadre</strong> de arriba: se factura un día y se
                        cobra otro, así que no es que falte — es que todavía no se cobró.
                      </p>
                    }
                    <p class="rr-dep-sub rr-tenue">
                      «Depósito» es el efectivo que se <strong>contó en el arqueo</strong> de la
                      caja donde se timbró la ruta — Kepler no registra el depósito por ruta
                      (<span class="rr-mono">cash_cuts</span> va por sucursal, caja y turno).
                      ⛔ La <strong>Δ es la del arqueo de esa caja</strong> —lo contado contra lo
                      que la caja debía tener—, <strong>no</strong> «Depósito menos Venta de la
                      ruta»: esas dos no se restan, porque en la misma caja cobran otras rutas y
                      el mostrador. Δ positiva = falta efectivo; negativa = sobra. Cuando la caja
                      cuadra, el dinero de esta ruta está dentro; cuando no, el faltante es
                      <strong>de la caja</strong> y no se puede atribuir a una ruta sola.
                    </p>
                  }
                </app-load-state>
              } @else {
                <!-- La matriz de estados la lleva app-load-state: cargando, vacio y error de red
                     NO se pintan igual, y el error ofrece reintentar. -->
                <app-load-state [loading]="depCargando()" [error]="depError()"
                                [isEmpty]="!depCargando() && !depError() && !depDepositos().length"
                                [skeletonRows]="6" emptyIcon="pi-wallet"
                                emptyTitle="Ningún depósito de la caja fuerte declara esta ruta"
                                emptyHint="El texto del depósito es lo que la atribuye. Lo que no declara ruta queda sin dueño y se ve en el panel de arriba."
                                (retry)="recargarDeposito()">
                  <div class="rr-dep-kpis">
                    <div><span>Depósitos</span><b>{{ depFila()?.depositos ?? 0 }}</b></div>
                    <div><span>Depositado</span><b>{{ (depFila()?.monto_caos ?? 0) | currency:'MXN':'symbol-narrow':'1.0-0' }}</b></div>
                    <div><span>En Caja General</span><b>{{ depFila()?.en_caja_general ? ((depFila()!.monto_caja_general) | currency:'MXN':'symbol-narrow':'1.0-0') : '—' }}</b></div>
                    <div><span>Sin capturar</span><b>{{ (depFila()?.monto_pendiente ?? 0) | currency:'MXN':'symbol-narrow':'1.0-0' }}</b></div>
                  </div>

                  @if (depFila()?.motivo_sucursal) {
                    <p class="rr-dep-nota rr-dep-warn">
                      <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                      <span>{{ depFila()!.motivo_sucursal }}</span>
                    </p>
                  }

                  <p-table [value]="depDepositos()" size="small" class="surf-table" [scrollable]="true" scrollHeight="46vh">
                    <ng-template #header><tr>
                      <th scope="col">Depósito</th>
                      <th scope="col">Cuándo</th>
                      <th scope="col">Texto que tecleó</th>
                      <th scope="col">Día de venta</th>
                      <th scope="col" class="comm-num">Depositado</th>
                      <th scope="col">Entrada a Caja General</th>
                      <th scope="col" class="comm-num">Δ</th></tr>
                    </ng-template>
                    <ng-template #body let-d>
                      <tr>
                        <td class="rr-mono">#{{ d.external_id }}</td>
                        <td class="rr-mono">{{ d.occurred_at.slice(0, 16).replace('T', ' ') }}</td>
                        <td class="rr-mono comm-muted">{{ d.ref || '(sin referencia)' }}</td>
                        <td class="rr-mono">
                          @if (d.fecha_venta) { {{ d.fecha_venta }} }
                          @else { <span class="comm-muted" [title]="d.motivo">no lo declara</span> }
                        </td>
                        <td class="comm-num rr-strong">{{ d.monto_caos | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                        <td>
                          @if (d.cg_folio) {
                            <a class="rr-link rr-mono" [routerLink]="['/finanzas/caja-general']"
                               [queryParams]="{ q: d.cg_folio, from: d.cg_fecha, to: d.cg_fecha }"
                               [title]="'Abrir ' + d.cg_folio + ' en Caja General'">
                              {{ d.cg_folio }} <i class="pi pi-external-link" aria-hidden="true"></i>
                            </a>
                          } @else {
                            <span class="comm-muted">sin capturar todavía</span>
                          }
                        </td>
                        <td class="comm-num comm-muted">
                          @if (d.delta === null) { — }
                          @else { {{ d.delta | currency:'MXN':'symbol-narrow':'1.0-0' }} }
                        </td>
                      </tr>
                    </ng-template>
                  </p-table>
                  <p class="rr-note">
                    De qué ruta es cada depósito lo dice el texto que tecleó quien depositó. Lo que no
                    declara ruta no se reparte: se queda sin dueño y se ve en el panel de arriba. La
                    <strong>Δ</strong> es cuánto más dice la entrada que el depósito y nunca es
                    negativa en lo medido; su causa no está medida.
                  </p>
                </app-load-state>
              }
            }
          }
        }
      </app-side-peek>
    </div>
  `,
  styles: [`
    :host { display:block; }
    /* [CG.58.7] El deposito de la ruta en la caja fuerte */
    .rr-dep-kpis { display:flex; gap:var(--sp-4); flex-wrap:wrap; margin:0 0 var(--sp-3); }
    .rr-dep-kpis > div { display:flex; flex-direction:column; gap:2px; }
    .rr-dep-kpis span { font-size:var(--fs-micro); color:var(--text-faint); }
    .rr-dep-kpis b { font-family:var(--font-mono); font-variant-numeric:tabular-nums; font-size:var(--fs-sm); color:var(--text-main); }
    .rr-dep-nota { display:flex; gap:var(--sp-2); align-items:flex-start; margin:0 0 var(--sp-3);
      padding:var(--sp-2) var(--sp-3); border:1px solid var(--border-color); border-radius:var(--r-md);
      font-size:var(--fs-sm); color:var(--text-muted); line-height:1.5; }
    .rr-dep-nota .pi { margin-top:2px; color:var(--text-faint); }
    /* [VEC.12] El arqueo de la vecinal: su circuito del dinero, en su propia ruta. */
    .rr-dep-sub { margin:0 0 var(--sp-2); font-size:var(--fs-micro); color:var(--text-muted); }
    .rr-dep-sub:last-child { margin:var(--sp-2) 0 0; }
    .rr-tenue { color:var(--text-faint); }
    .rr-bad { color:var(--bad-fg); }
    .rr-warn { color:var(--warn-fg); }
    .rr-ok { color:var(--ok-fg); }
    .rr-nota { font-size:var(--fs-micro); }
    .rr-dep-warn { border-color: color-mix(in srgb, var(--warn-fg) 38%, var(--border-color)); }
    .rr-dep-warn .pi { color: var(--warn-fg); }
    .rr-dep-bad-txt { color: var(--bad-fg); }
    .rr-dep-bad { border-color: color-mix(in srgb, var(--bad-fg) 38%, var(--border-color)); }
    .rr-dep-bad .pi { color: var(--bad-fg); }
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
    /* Fluye con el ancho en vez de quedarse en dos columnas: en la ventana las nueve metricas
       entran en dos renglones, y en pantalla chica caen solas a una columna. Agrandar el
       contenedor sin esto no mejoraba nada -las tarjetas seguian apiladas igual de altas. */
    .rr-dkpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:.5rem; margin-bottom:1rem; }
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
    /* RR2 — margen con cobertura + desglose por ticket */
    .rr-dkpi-wide { grid-column:1 / -1; }
    .rr-dkpi em { display:block; font-style:normal; font-size:.62rem; color:var(--text-muted); margin-top:.1rem; }
    .rr-nodata { color:var(--text-muted); }
    .rr-rhythm-head { display:flex; align-items:flex-end; justify-content:space-between; gap:1rem; margin:.15rem 0 .55rem; }
    .rr-rhythm-head span { display:block; font-size:.78rem; font-weight:700; color:var(--text-main); }
    .rr-rhythm-head p, .rr-rhythm-head small { margin:.1rem 0 0; font-size:.65rem; color:var(--text-muted); }
    .rr-rhythm-head small { max-width:27rem; text-align:right; font-variant-numeric:tabular-nums; }
    @media (max-width:40rem) {
      .rr-rhythm-head { align-items:flex-start; flex-direction:column; }
      .rr-rhythm-head small { text-align:left; }
    }
    .rr-tk-filters { display:flex; flex-wrap:wrap; gap:.4rem; align-items:center; margin-bottom:.6rem; }
    :host ::ng-deep .rr-tk-search input { min-width:11rem; }
    :host ::ng-deep .rr-tk-sel { min-width:8.5rem; }
    .rr-tk-sum { display:flex; gap:.9rem; font-size:.72rem; color:var(--text-muted); margin-bottom:.5rem; font-variant-numeric:tabular-nums; }
    .rr-tk-empty { text-align:center; color:var(--text-muted); font-size:.8rem; padding:1.2rem 0; }
    .rr-tk-cli { max-width:190px; }
    .rr-hh { font-style:normal; color:var(--text-muted); margin-left:.35rem; font-size:.72rem; }
    .rr-tk-head { display:flex; align-items:center; gap:.5rem; margin-bottom:.6rem; }
    .rr-tag-src { text-transform:none; }
    .rr-tk-meta { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:.4rem .6rem; margin-bottom:.75rem; }
    .rr-tk-meta > div { min-width:0; }
    .rr-tk-meta span { display:block; font-size:.62rem; font-weight:600; text-transform:uppercase; letter-spacing:.04em; color:var(--text-muted); }
    .rr-tk-meta b { display:block; font-size:.82rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .rr-eq { display:block; font-style:normal; font-size:.66rem; color:var(--text-muted); }
    /* RR3 — chips de drill (el filtro es el estado) + celdas navegables */
    .rr-chips { display:flex; flex-wrap:wrap; gap:.35rem; margin-bottom:.7rem; }
    .rr-chip { display:inline-flex; align-items:center; gap:.3rem; appearance:none; font:inherit;
      font-size:.7rem; font-weight:600; padding:.2rem .5rem; border-radius:999px; cursor:pointer;
      background:var(--hover-bg); color:var(--text-muted); border:1px solid var(--border-color); }
    .rr-chip:hover { color:var(--text-main); }
    .rr-chip:focus-visible { outline:2px solid var(--action); outline-offset:2px; }
    .rr-chip i { font-size:.62rem; }
    .rr-chip-fixed { cursor:default; background:transparent; }
    .rr-chip-fixed:hover { color:var(--text-muted); }
    .rr-chip-on { background:var(--action); color:#fff; border-color:transparent; }
    .rr-chip-on:hover { color:#fff; opacity:.9; }
    .rr-chip-clear { border-style:dashed; }
    .rr-cell-link { appearance:none; background:none; border:none; padding:0; font:inherit;
      font-variant-numeric:tabular-nums; cursor:pointer; color:inherit; }
    .rr-cell-link:hover { color:var(--action); text-decoration:underline; text-underline-offset:2px; }
    .rr-cell-link:focus-visible { outline:2px solid var(--action); outline-offset:2px; border-radius:var(--r-sm); }
    .rr-prod .rr-link { text-align:left; white-space:normal; }
  `],
})
export class ComercialVentasPorRutaComponent {
  readonly reportTabs = REPORTS_TABS;
  private readonly svc = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  /** `[JZ.1]` Para aterrizar filtrado desde un enlace. Ver `leerFiltrosDeLaUrl()`. */
  private readonly ruta = inject(ActivatedRoute);
  /** `[CG.58.7]` El dinero de la ruta: su depósito en la caja fuerte y la entrada que generó. */
  private readonly caos = inject(CaosService);

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

  /** Subtítulo del desglose: ruta + año + periodo/filtros aplicados (para que quede claro el alcance). */
  readonly detailSubtitle = computed(() => {
    const d = this.detail();
    if (!d) return null;
    const parts = [`Ruta ${d.route_no}`, String(d.year)];
    if (this.periodLabel()) parts.push(this.periodLabel());
    if (this.fProduct() || this.fClient()) parts.push('filtrado');
    return parts.join(' · ');
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

  // ── `[CG.58.7]` El depósito de la ruta en la caja fuerte, y su entrada a Caja General ──────
  //
  // La fila que se está mirando se guarda entera: para resolver el depósito hacen falta el
  // `route_no` (lo que el texto del depósito declara) y el `route_code` (para saber si es
  // vecinal, que es otro circuito y NO deposita en CAOS).
  peekRow = signal<SalesByRouteRow | null>(null);
  depReporte = signal<RutaCajaReporte | null>(null);
  depCargando = signal(false);
  depError = signal<string | null>(null);

  /**
   * ⛔ La vecinal no deposita en la caja fuerte: cobra en una caja registradora y su dinero se
   * cuenta en el arqueo de esa caja. Mezclarla acá le cobraría a un camión la venta de un
   * vendedor que no lo maneja — mismo criterio que el clasificador del backend.
   */
  readonly esRutaVecinal = computed(() => {
    const r = this.peekRow();
    if (!r) return false;
    return /^\d+V\d/i.test(r.route_no ?? '') || /VEC/i.test(r.route_code ?? '');
  });

  // ── `[VEC.12]` El dinero de una ruta VECINAL: el arqueo de la caja donde se timbró ────────
  //
  // El otro circuito. No se reusa `depReporte` (CAOS) a propósito: son dos hechos distintos y
  // juntarlos en una estructura invitaría a sumarlos.
  arqData = signal<VecinalConciliacion | null>(null);
  arqCargando = signal(false);
  arqError = signal<string | null>(null);
  /**
   * `[VEC.21]` La venta a crédito de ESTA ruta, para el mismo rango. Se pide aparte del arqueo
   * porque son dos hechos distintos —el efectivo del día y la factura que se cobra después— y
   * uno puede existir sin el otro: un día puede tener crédito y no tener arqueo, o al revés.
   *
   * ⚠️ Un error acá NO rompe la pestaña: el arqueo se sigue viendo y las columnas de crédito
   * declaran que no se pudieron leer. Son dos preguntas, no una.
   */
  creditoData = signal<RouteCreditSales | null>(null);
  creditoError = signal<string | null>(null);

  /**
   * Las filas día-caja donde participó ESTA ruta.
   *
   * ⚠️ El filtro es por pertenencia a `rutas`, no por igualdad: una caja mezcla rutas, y exigir
   * que sea la única dejaría fuera justo las cajas compartidas —que son la mayoría— mostrando
   * una tabla vacía que se leería como «no se contó».
   */
  readonly arqFilas = computed<VecinalConciliacionFila[]>(() => {
    const d = this.arqData();
    if (!d) return [];
    const code = this.rutaAbierta();
    if (!code) return [];
    return d.filas.filter((f) => f.rutas.some((r) => r.trim().toUpperCase() === code));
  });

  /** El código de la ruta abierta, normalizado — la llave de todo lo de `[VEC.12]`. */
  private rutaAbierta(): string {
    return String(this.peekRow()?.route_no ?? '').trim().toUpperCase();
  }

  /** Las OTRAS rutas que usaron esa caja ese día. Vacío = la caja fue sólo de esta ruta. */
  otrasRutas(f: VecinalConciliacionFila): string[] {
    const mia = this.rutaAbierta();
    return f.rutas.map((r) => r.trim().toUpperCase()).filter((r) => r && r !== mia);
  }

  /**
   * `[VEC.12.2]` **Vendió contra depositó, por DÍA.** Se agrega sobre las cajas del día porque la
   * caja es plomería: la pregunta del detalle de una ruta es si el dinero llegó.
   *
   * ⛔ **El cuadre por ruta no siempre existe, y eso NO se disimula.** `analytics.cash_cuts` no
   * tiene columna de ruta —su grano es (sucursal, caja, turno), verificado— así que el efectivo
   * contado sólo es de esta ruta cuando **todas** sus cajas del día fueron suyas solas y 100%
   * vecinales. Medido el 2026-10-14 sobre 180 días: **129 de 735 día-ruta (17.6%)**; en PH
   * `1V001`, 2 de 94. Donde no se puede, `deposito` y `diff` llegan `null` **con el motivo**, que
   * es muy distinto de un cero (ADR-056).
   *
   * ⚠️ Una ruta puede timbrar en más de una caja el mismo día (38 de 696 medido), por eso se
   * suma sobre las cajas y basta que UNA no sea atribuible para que el día no lo sea.
   */
  readonly arqDias = computed<ArqDia[]>(() => {
    const porDia = new Map<string, VecinalConciliacionFila[]>();
    for (const f of this.arqFilas()) {
      const g = porDia.get(f.date);
      if (g) g.push(f); else porDia.set(f.date, [f]);
    }
    // `[VEC.21]` El crédito del día, indexado por fecha de FACTURA. ⛔ No por fecha de cobro: lo
    // que se vendió ese día es lo que se facturó ese día; el cobro llega después y por eso viaja
    // como `credito_cobrado`, no como otro renglón.
    const credito = new Map<string, { importe: number; cobrado: number; saldo: number; vencidas: number }>();
    for (const f of this.creditoData()?.filas ?? []) {
      const e = credito.get(f.fecha) ?? { importe: 0, cobrado: 0, saldo: 0, vencidas: 0 };
      e.importe += f.importe; e.cobrado += f.cobrado; e.saldo += f.saldo;
      if (f.cobranza === 'vencida') e.vencidas += 1;
      credito.set(f.fecha, e);
      // Un día con crédito y SIN arqueo igual tiene que salir: si no, la venta a crédito de un
      // día sin corte desaparece de la pantalla sin que nadie se entere.
      if (!porDia.has(f.fecha)) porDia.set(f.fecha, []);
    }

    const out: ArqDia[] = [];
    for (const [date, fs] of porDia) {
      let venta = 0, contado = 0, diff = 0;
      let atribuible = true, medido = false;
      let motivo: string | null = null, sinMedir: string | null = null;
      for (const f of fs) {
        venta += f.vecinal_ruta ?? 0;
        // La caja es compartida si otra ruta la usó o si también cobró mostrador. Eso NO impide
        // decir si cuadra: impide decir DE QUIÉN es el faltante cuando no cuadra.
        const otras = this.otrasRutas(f);
        if (otras.length) {
          atribuible = false;
          motivo ??= `caja compartida con ${otras.join(' · ')}`;
        } else if (f.vecinal_pct !== null && f.vecinal_pct < 100) {
          atribuible = false;
          motivo ??= `la caja también cobró mostrador (${f.vecinal_pct}% vecinal)`;
        }
        if (f.efectivo_contado !== null) {
          medido = true;
          contado += f.efectivo_contado;
          diff += f.efectivo_diff ?? 0;
        } else {
          sinMedir ??= this.etiquetaArqueo(f.veredicto);
        }
      }
      /**
       * ⚠️ El umbral es **$1**, no `=== 0`: la tabla redondea al peso y exigir el centavo pintaría
       * «no cuadra» sobre un arqueo que cuadró. Medido en PH: el neto de 6 meses es $0.79.
       */
      const estado: ArqDia['estado'] = !medido ? 'sin_medir'
        : Math.abs(diff) <= 1 ? 'cuadra'
          : diff > 0 ? 'falta' : 'sobra';
      const cr = credito.get(date);
      out.push({
        date,
        venta_ruta: Math.round(venta * 100) / 100,
        credito: Math.round((cr?.importe ?? 0) * 100) / 100,
        credito_cobrado: Math.round((cr?.cobrado ?? 0) * 100) / 100,
        credito_saldo: Math.round((cr?.saldo ?? 0) * 100) / 100,
        credito_vencidas: cr?.vencidas ?? 0,
        deposito: medido ? Math.round(contado * 100) / 100 : null,
        diff: medido ? Math.round(diff * 100) / 100 : null,
        estado,
        atribuible,
        motivo,
        sin_medir: sinMedir,
      });
    }
    return out.sort((a, b) => (a.date < b.date ? 1 : -1));
  });

  /** Días con arqueo: el único denominador honesto del cumplimiento. */
  readonly arqMedidos = computed(() => this.arqDias().filter((d) => d.estado !== 'sin_medir').length);
  readonly arqCuadran = computed(() => this.arqDias().filter((d) => d.estado === 'cuadra').length);
  /** Los que todavía no se pueden juzgar. Se publican aparte, NUNCA dentro del denominador. */
  readonly arqSinMedir = computed(() => this.arqDias().filter((d) => d.estado === 'sin_medir').length);

  /** `[VEC.21]` Lo facturado a crédito y lo que falta cobrar, del período que se está mirando. */
  readonly creditoTotal = computed(() => this.arqDias().reduce((a, d) => a + d.credito, 0));
  readonly creditoPorCobrar = computed(() => this.arqDias().reduce((a, d) => a + d.credito_saldo, 0));

  /** La fila del reporte que corresponde a ESTA ruta. Null = ningún depósito la declara. */
  readonly depFila = computed(() => {
    const rep = this.depReporte();
    const row = this.peekRow();
    if (!rep || !row) return null;
    return rep.filas.find((f) => f.ruta === String(Number(row.route_no))) ?? null;
  });

  /**
   * `[CG.58.7]` Los depósitos de esta ruta indexados por el día que DECLARA su texto, para
   * ponerlos al lado de la venta de ese día en «Por día». ⛔ No se indexa por `occurred_at`: el
   * depósito se hace cuando la ruta vuelve, que normalmente es otro día — cruzarlo por la fecha
   * del depósito pondría el dinero en el renglón equivocado.
   */
  readonly depPorDia = computed(() => {
    const m = new Map<string, { monto: number; folios: { folio: string; fecha: string | null }[]; sin_capturar: number }>();
    for (const d of this.depDepositos()) {
      if (!d.fecha_venta) continue;
      if (!m.has(d.fecha_venta)) m.set(d.fecha_venta, { monto: 0, folios: [], sin_capturar: 0 });
      const e = m.get(d.fecha_venta) as { monto: number; folios: { folio: string; fecha: string | null }[]; sin_capturar: number };
      e.monto += d.monto_caos;
      if (d.cg_folio) e.folios.push({ folio: d.cg_folio, fecha: d.cg_fecha }); else e.sin_capturar += 1;
    }
    return m;
  });

  /**
   * Lo que NO se puede poner en ningún renglón: declara la ruta pero no el día. Se DECLARA al pie
   * en vez de repartirlo — un depósito no es un día, y repartirlo inventaría la fecha.
   */
  readonly depSinDia = computed(() => {
    const sin = this.depDepositos().filter((d) => !d.fecha_venta);
    return { n: sin.length, monto: sin.reduce((a, d) => a + d.monto_caos, 0) };
  });

  depDelDia(dia: string) { return this.depPorDia().get(dia) ?? null; }

  readonly depDepositos = computed(() => {
    const rep = this.depReporte();
    const f = this.depFila();
    if (!rep || !f) return [];
    return rep.depositos.filter((d) => d.clave === f.clave);
  });

  // RR2 — Tickets (paginado server-side) + drill al ticket
  readonly tkLimit = 50;
  readonly docTypeOpts = [{ label: 'Ticket', value: 'ticket' }, { label: 'Factura', value: 'factura' }];
  tkPage = signal<SalesByRouteTicketsPage | null>(null);
  tkLoading = signal(false);
  tkQuery = signal('');
  tkUnit = signal<string | null>(null);
  tkDocType = signal<string | null>(null);
  tkSort = signal<'date' | 'revenue' | 'units' | 'lines' | 'margin'>('date');
  tkDir = signal<'asc' | 'desc'>('desc');
  tkOffset = signal(0);
  ticket = signal<SalesByRouteTicketDetail | null>(null);

  /** Unidades para el filtro: las que REALMENTE aparecen en el periodo de esta ruta. */
  readonly tkUnitOpts = computed(() =>
    (this.detail()?.units_mix ?? [])
      .filter((u) => !!u.unidad)
      .map((u) => ({ label: u.unidad as string, value: u.unidad as string })));

  // ── RR3 — El filtro ES el estado del panel ──────────────────────────────────
  // Facetas del drill. Se siembran de los filtros de página al abrir la ruta y a
  // partir de ahí viven sólo dentro del panel: quitarlas acá no toca la matriz.
  dSku = signal<string | null>(null);
  dClient = signal<string | null>(null);
  dClientName = signal<string | null>(null);
  dUnit = signal<string | null>(null);
  dDay = signal<string | null>(null);
  /** Mes al que está acotado el panel (`MM`); null = todo el periodo visible. */
  dMonth = signal<string | null>(null);
  /** Escape explícito al año completo (el caro: 7.1 s medidos). */
  fullYear = signal(false);

  readonly hasDrill = computed(() =>
    !!this.dSku() || !!this.dClient() || !!this.dUnit() || !!this.dDay());

  readonly scopeLabel = computed(() => {
    if (this.dMonth()) return this.mes(this.dMonth() as string);
    if (this.fullYear()) return `${this.year} completo`;
    return this.periodLabel() || `${this.year} completo`;
  });

  /** Un solo lugar decide el alcance temporal del panel: mes > año completo > periodo de la vista. */
  private detailBounds(): { from?: string; to?: string } {
    const y = this.year;
    const m = this.dMonth();
    if (m) {
      const n = Number(m);
      return {
        from: `${y}-${m}-01`,
        to: n >= 12 ? `${y + 1}-01-01` : `${y}-${String(n + 1).padStart(2, '0')}-01`,
      };
    }
    if (this.fullYear()) return {};
    const vm = this.visibleMonths();
    if ((!this.fMonthFrom() && !this.fMonthTo()) || !vm.length) return {};
    const lastM = Number(vm[vm.length - 1]);
    return {
      from: `${y}-${vm[0]}-01`,
      to: lastM >= 12 ? `${y + 1}-01-01` : `${y}-${String(lastM + 1).padStart(2, '0')}-01`,
    };
  }

  /** El día es una faceta más fina que el mes: acota from/to a ese solo día. */
  private dayBounds(): { from?: string; to?: string } | null {
    const d = this.dDay();
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
    const next = new Date(new Date(`${d}T00:00:00Z`).getTime() + 864e5).toISOString().slice(0, 10);
    return { from: d, to: next };
  }

  toggleFullYear() {
    if (this.dMonth()) { this.dMonth.set(null); this.fullYear.set(true); }
    else this.fullYear.update((v) => !v);
    this.reloadDetail();
  }

  clearDrill() {
    this.dSku.set(null); this.dClient.set(null); this.dClientName.set(null);
    this.dUnit.set(null); this.dDay.set(null);
    this.reloadDetail();
  }

  /** Agregar una faceta = re-consultar el desglose y saltar a Tickets (el "¿quiénes?"). */
  private applyFacet() {
    this.ticket.set(null);
    this.tkPage.set(null);
    this.tkOffset.set(0);
    this.reloadDetail();
    this.tab.set('tickets');
  }

  drillSku(sku: string) { if (!sku) return; this.dSku.set(sku); this.applyFacet(); }
  drillUnit(unit: string | null) { if (!unit) return; this.dUnit.set(unit); this.applyFacet(); }
  drillDay(date: string) { if (!date) return; this.dDay.set(date); this.applyFacet(); }
  drillClient(code: string, name?: string) {
    if (!code || code === '—') return;
    this.dClient.set(code); this.dClientName.set(name || null); this.applyFacet();
  }

  // RR3/RR4 — El ritmo por cliente viene calculado por el servidor sobre venta identificada.
  // La profundidad por renglón de cada ticket sí se deriva acá porque usa un solo documento.
  ticketUnitsPerLine(t: SalesByRouteTicket): number {
    return t.lines > 0 ? t.units / t.lines : 0;
  }

  /** La carga de tickets la dispara el (onLazyLoad) de la tabla al montarse — no acá,
   *  o se pediría dos veces la misma página. */
  setTab(t: DetailTab) {
    this.tab.set(t);
    // `[CG.58.7]` Se pide al abrir la pestaña y no al abrir la ruta: son 749 depósitos en toda la
    // historia, pero no hay motivo para pagarlos cuando nadie los va a mirar.
    // También en «Por día»: ahí es donde se concilia —la venta del día contra lo que ese día se
    // depositó— y si no se pide, las dos columnas nuevas salen vacías y se leen como «no depositó».
    if ((t === 'deposito' || t === 'dias') && !this.esRutaVecinal() && !this.depReporte() && !this.depCargando()) {
      this.cargarDeposito();
    }
    // `[VEC.12]` La vecinal tiene su propio circuito: el arqueo de la caja, no la caja fuerte.
    if (t === 'deposito' && this.esRutaVecinal() && !this.arqData() && !this.arqCargando()) {
      this.cargarArqueo();
    }
  }

  /**
   * `[CG.58.7]` Los depósitos del AÑO que la pantalla está mirando. No se acota al mes del drill
   * a propósito: un depósito no es un día —el texto declara ruta y día en el 54.5% de los casos y
   * sólo la ruta en el resto—, así que recortarlo al mes escondería los que no fechan.
   */
  /** Reintento desde `app-load-state`: tira lo que haya y vuelve a pedir. */
  recargarDeposito() { this.depReporte.set(null); this.cargarDeposito(); }

  /** `[VEC.12]` Reintento del arqueo de la vecinal. */
  recargarArqueo() { this.arqData.set(null); this.creditoData.set(null); this.cargarArqueo(); }

  /**
   * `[VEC.12]` El arqueo del AÑO que la pantalla está mirando, igual que los depósitos: el drill
   * puede estar en un mes y la pregunta «¿entregó?» no se contesta mes a mes.
   */
  private cargarArqueo() {
    const hoy = new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 10);
    /**
     * `[VEC.12.3]` **Se pide el período que la pantalla está mirando, no el año entero.**
     *
     * A diferencia de los depósitos de CAOS —donde el año se pide a propósito, porque el texto
     * del depósito sólo fecha en el 54.5% de los casos— acá cada renglón del arqueo **tiene su
     * día**, así que traer meses que nadie va a ver sólo cuesta. Medido contra prod: el mes del
     * drill son **18 ms** contra **206 ms** del año.
     *
     * ⚠️ `detailBounds().to` es el primer día del mes SIGUIENTE (tope exclusivo) y el endpoint
     * filtra con `<=`. Sin restar el día, octubre arrastraría el 1-nov.
     */
    const b = this.detailBounds();
    const menosUnDia = (d: string) =>
      new Date(new Date(`${d}T00:00:00Z`).getTime() - 864e5).toISOString().slice(0, 10);
    const desde = b.from ?? `${this.year}-01-01`;
    const topeAnio = hoy.slice(0, 4) === String(this.year) ? hoy : `${this.year}-12-31`;
    const hasta = b.to ? menosUnDia(b.to) : topeAnio;
    this.arqCargando.set(true);
    this.arqError.set(null);
    this.creditoError.set(null);
    /**
     * `[VEC.24]` La ruta que se está pidiendo, sellada antes de salir. Tirar el estado al abrir
     * la ruta cierra el camino de ida; **esto cierra el de vuelta**: dos peticiones en vuelo no
     * vuelven en orden, y la de la ruta vieja aterrizando después pinta lo mismo que el defecto
     * que se acaba de arreglar. No alcanza con comparar al llegar y ya: se compara contra la
     * ruta que la pantalla tiene ABIERTA en ese momento.
     */
    const rutaPedida = this.rutaAbierta();
    const sigueSiendoMia = () => this.rutaAbierta() === rutaPedida;
    /**
     * `[VEC.21]` La venta a CRÉDITO de la misma ruta y el mismo rango, en paralelo.
     *
     * ⛔ Va en su propia suscripción y **no encadenada** al arqueo: si la vista de crédito no
     * está (la migración puede no estar aplicada) el arqueo tiene que seguir viéndose igual.
     * Son dos preguntas; una que falla no puede apagar a la otra.
     */
    this.svc.routeCreditSales(desde, hasta, rutaPedida)
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        /**
         * ⛔ Se comprueba la FORMA, no sólo el `next`. Medido el 2026-10-15: el endpoint no
         * está desplegado (404) y las tres columnas salían en blanco **sin aviso**, que se lee
         * como «esta ruta no vendió a crédito» — y 1V001 facturó $59,475 en 6 documentos de
         * octubre. Un cuerpo que no trae `filas` es una falla, no un cero (ADR-056).
         */
        next: (r) => {
          if (!sigueSiendoMia()) return;
          if (!r || !Array.isArray(r.filas)) {
            this.creditoError.set('No se pudo leer la venta a crédito de esta ruta.');
            return;
          }
          this.creditoData.set(r);
        },
        error: () => {
          if (!sigueSiendoMia()) return;
          this.creditoError.set('No se pudo leer la venta a crédito de esta ruta.');
        },
      });
    // `[VEC.12.1]` La ruta viaja al servidor: sin ella la fila sólo trae el total de la CAJA, y
    // mostrarlo en el detalle de una ruta es lo que hacía mentir a esta pestaña.
    this.svc.vecinalConciliacion(desde, hasta, rutaPedida).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        if (!sigueSiendoMia()) return;
        this.arqData.set(r); this.arqCargando.set(false);
      },
      error: () => {
        if (!sigueSiendoMia()) return;
        this.arqError.set('No se pudo leer el arqueo de las cajas.');
        this.arqCargando.set(false);
      },
    });
  }

  /**
   * ⛔ Las dos ausencias NO se dicen igual (ADR-056): `sin_arqueo` lo arregla la sucursal subiendo
   * su corte; `contado_en_cero` es un corte que existe y declara cero, que es otra cosa.
   */
  etiquetaArqueo(v: VecinalVeredicto): string {
    switch (v) {
      case 'cuadra': return 'Cuadra';
      case 'faltante': return 'Falta efectivo';
      case 'sobrante': return 'Sobra efectivo';
      case 'contado_en_cero': return 'Contado en cero';
      case 'vecinal_excede_arqueo': return 'La vecinal excede el arqueo';
      case 'sin_arqueo': return 'Sin arqueo';
      case 'arqueo_abierto': return 'Caja sin cerrar';
      case 'dia_en_curso': return 'Día en curso';
      default: return v;
    }
  }

  private cargarDeposito() {
    const hoy = new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 10);
    const desde = `${this.year}-01-01`;
    const hasta = hoy.slice(0, 4) === String(this.year) ? hoy : `${this.year}-12-31`;
    this.depCargando.set(true);
    this.depError.set(null);
    this.caos.rutaCaja(desde, hasta).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.depReporte.set(r); this.depCargando.set(false); },
      error: () => {
        this.depError.set('No se pudieron leer los depósitos de la caja fuerte.');
        this.depCargando.set(false);
      },
    });
  }

  private ticketParams(): SalesByRouteTicketsParams {
    const b = this.dayBounds() ?? this.detailBounds();
    return {
      route: this.detail()?.route_code || '',
      year: this.year,
      from: b.from, to: b.to,
      sku: this.dSku() || undefined,
      client: this.dClient() || undefined,
      // El select de unidad de la tab y la faceta de chip son el mismo filtro:
      // la faceta manda (es la que el usuario ve declarada arriba).
      unit: this.dUnit() || this.tkUnit() || undefined,
      docType: this.tkDocType() || undefined,
      q: this.tkQuery().trim() || undefined,
      sort: this.tkSort(), dir: this.tkDir(),
      limit: this.tkLimit, offset: this.tkOffset(),
    };
  }

  loadTickets(reset = false) {
    if (!this.detail()) return;
    if (reset) this.tkOffset.set(0);
    this.tkLoading.set(true);
    this.svc.salesByRouteTickets(this.ticketParams())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (p) => { this.tkPage.set(p); this.tkLoading.set(false); },
        error: (e) => {
          this.tkLoading.set(false);
          this.toast.add({ severity: 'error', summary: 'Error al cargar tickets', detail: e?.error?.message });
        },
      });
  }

  /** p-table lazy: paginación y orden los resuelve el server (la tabla puede tener 8k tickets). */
  // PrimeNG (v22) tipa TableLazyLoadEvent con sortField: string | string[] | null y
  // sortOrder: number | null; ensanchamos la firma para matchear (el cuerpo ya normaliza
  // vía `as any` / comparación estricta). Sin esto el build de view falla con TS2345.
  onTicketsLazy(ev: { first?: number; sortField?: string | string[] | null; sortOrder?: number | null }) {
    const first = ev.first ?? 0;
    const sort = (ev.sortField as any) || 'date';
    const dir = ev.sortOrder === 1 ? 'asc' : 'desc';
    const changed = first !== this.tkOffset() || sort !== this.tkSort() || dir !== this.tkDir();
    this.tkOffset.set(first);
    this.tkSort.set(sort);
    this.tkDir.set(dir);
    if (changed || !this.tkPage()) this.loadTickets();
  }

  openTicket(t: SalesByRouteTicket) {
    this.svc.salesByRouteTicket(t.key)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (d) => this.ticket.set(d),
        error: (e) => this.toast.add({ severity: 'error', summary: 'Error al cargar el ticket', detail: e?.error?.message }),
      });
  }

  closeTicket() { this.ticket.set(null); }

  yearOpts = computed(() => { const y = new Date().getFullYear(); return [y, y - 1, y - 2]; });

  /**
   * `[JZ.1]` **La pantalla aterriza filtrada cuando se llega desde otro lado.**
   *
   * Nace de la portada del jefe de zona: su fila «Ruta 28 · +62.8%» tiene que abrir ESTA pantalla
   * ya puesta en esa ruta, no en el reporte completo para que él vuelva a filtrar. El filtro por
   * sucursal y por ruta **ya existía como control**; lo que no existía era leerlo de la URL — cero
   * usos de `ActivatedRoute` en el archivo antes de esto.
   *
   * Es el mismo patrón que `[SN.16]` reusó sin tocar las pantallas: bancos lee `?view=&period=` y
   * el Libro de compras lee `?mes=`. Acá:
   *
   *   `/comercial/ventas-por-ruta?branch=01,02,03`   → filtro de vista por sucursal
   *   `/comercial/ventas-por-ruta?route=RUTA-28`     → filtro de servidor por ruta (re-agrega)
   *   `/comercial/ventas-por-ruta?year=2026`         → el año del reporte
   *
   * ⛔ **Sólo LEE la URL, no la escribe.** Escribirla haría que cada cambio de filtro empuje una
   * entrada al historial, y el valor que se busca acá es aterrizar desde un enlace — no que la
   * pantalla sea compartible. Queda declarado: si más adelante hace falta compartir un filtro, se
   * agrega `writeUrl` como en bancos.
   *
   * ⚠️ `branch` es un filtro de VISTA sobre lo ya cargado. Un código que no esté en el reporte deja
   * la tabla vacía — igual que si la persona lo eligiera a mano en el multiselect. No se valida
   * contra `branchOpts()` porque ese `computed` depende del reporte, que todavía no llegó acá.
   */
  private leerFiltrosDeLaUrl(): void {
    const qp = this.ruta.snapshot.queryParamMap;

    const year = Number(qp.get('year'));
    // Rango sano: el reporte es por año de folio, no acepta cualquier entero.
    if (Number.isInteger(year) && year >= 2000 && year <= 2100) this.year = year;

    // `route` y `routes` son el mismo parámetro: el singular es el que usa un enlace de una fila.
    const rutas = this.lista(qp.get('route') ?? qp.get('routes'));
    if (rutas.length) this.routes = rutas;

    const sucursales = this.lista(qp.get('branch') ?? qp.get('branches'));
    if (sucursales.length) this.fBranch.set(sucursales);
  }

  /** `'01,02 , 03'` → `['01','02','03']`. Vacío si no vino nada útil. */
  private lista(v: string | null): string[] {
    return (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  }

  constructor() {
    // ANTES del `load()`: `year` y `routes` viajan en `params()`, así que leerlos después
    // dispararía una segunda consulta con el filtro puesto y mostraría el reporte completo
    // durante el parpadeo.
    this.leerFiltrosDeLaUrl();

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
          this.error.set(e?.error?.message || 'No se pudo consultar el reporte. Revisa la conexión e intenta de nuevo.');
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

  /** Último mes CON VENTA de la fila: el default sano cuando no hay rango elegido. */
  private lastMonthWithSales(row: SalesByRouteRow): string | null {
    const months = this.visibleMonths();
    for (let i = months.length - 1; i >= 0; i--) {
      if ((row.monthly[months[i]]?.revenue ?? 0) > 0) return months[i];
    }
    return null;
  }

  /**
   * RR3.0 — el desglose ya NO abre en el año completo. Medido en prod: año = 7.1 s,
   * mes = 1.2 s. Se abre en el mes que el usuario clickeó, o en el último con venta;
   * el año queda a un click explícito en el chip de periodo.
   */
  openRoute(row: SalesByRouteRow, month?: string) {
    this.tab.set('productos');
    this.detail.set(null);
    // `[CG.58.7]` La fila entera, para resolver el depósito de ESTA ruta. El reporte se tira: si
    // no, la ruta nueva mostraría los depósitos de la anterior mientras carga.
    this.peekRow.set(row);
    this.depReporte.set(null);
    this.depError.set(null);
    /**
     * `[VEC.24]` ⛔ **El arqueo de la ruta anterior también se tira.** Se tiraba `depReporte` por
     * este mismo motivo y estos dos quedaron fuera — y acá el defecto no se nota, se publica:
     *
     *   1. `setTab('deposito')` sólo pide si `!arqData()`, así que con la respuesta vieja en mano
     *      la ruta nueva **no vuelve a preguntar**.
     *   2. `arqFilas` filtra por PERTENENCIA a `rutas`, y en PH las cajas son compartidas todos
     *      los días — así que las filas de la ruta anterior **pasan el filtro enteras**, con su
     *      `vecinal_ruta` adentro.
     *
     * Medido en prod el 2026-10-16: abrir 1V002 y después 1V001 publicaba los 13 días de octubre
     * de 1V002 bajo el título «Ruta 1V001». El 03-oct decía $7,498 donde 1V001 vendió
     * **$22,903.59**; el 02-oct, $6,953 contra $25,141.97. Las dos rutas timbran en la caja 4.
     */
    this.arqData.set(null);
    this.arqError.set(null);
    this.creditoData.set(null);
    this.creditoError.set(null);
    /**
     * ⚠️ `arqCargando` también se baja, y no es cosmético: `setTab('deposito')` pide sólo si
     * `!arqData() && !arqCargando()`. Cambiar de ruta con la petición anterior EN VUELO dejaba
     * la bandera levantada para siempre —su respuesta ya se descarta por no ser de esta ruta—,
     * y la pestaña se quedaba cargando sin que nadie volviera a preguntar. Lo destapó la
     * segunda prueba de `[VEC.24]`, no la pantalla.
     */
    this.arqCargando.set(false);
    this.detailLoading.set(true);
    this.peekOpen.set(true);
    // El estado del panel es por ruta: si no se limpia, la ruta nueva hereda el drill anterior.
    this.tkPage.set(null);
    this.ticket.set(null);
    this.tkQuery.set(''); this.tkUnit.set(null); this.tkDocType.set(null);
    this.tkOffset.set(0); this.tkSort.set('date'); this.tkDir.set('desc');
    this.dUnit.set(null); this.dDay.set(null);
    // Las facetas de producto/cliente se siembran del filtro de página: lo que el
    // usuario ya eligió arriba sigue valiendo adentro, y queda visible como chip.
    this.dSku.set(this.fProduct() || null);
    this.dClient.set(this.fClient() || null);
    this.dClientName.set(null);
    this.fullYear.set(false);
    this.dMonth.set(month ?? (this.fMonthFrom() || this.fMonthTo() ? null : this.lastMonthWithSales(row)));
    this.fetchDetail(row.route_code);
  }

  /** Re-consulta el desglose con las facetas vigentes (sin cerrar ni reabrir el panel). */
  reloadDetail() {
    const code = this.detail()?.route_code;
    if (!code) return;
    this.tkPage.set(null);
    this.fetchDetail(code);
  }

  private fetchDetail(routeCode: string) {
    const b = this.dayBounds() ?? this.detailBounds();
    this.detailLoading.set(true);
    this.svc.salesByRouteDetail(routeCode, this.year, {
      from: b.from, to: b.to,
      sku: this.dSku() || undefined,
      client: this.dClient() || undefined,
      unit: this.dUnit() || undefined,
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (d) => {
          this.dailyMax = Math.max(1, ...d.daily.map((x) => x.revenue));
          this.detail.set(d);
          this.detailLoading.set(false);
        },
        error: (e) => {
          this.detailLoading.set(false);
          if (!this.detail()) this.peekOpen.set(false);
          this.toast.add({ severity: 'error', summary: 'Error al cargar el desglose', detail: e?.error?.message });
        },
      });
  }

  barPct(v: number): number { return this.dailyMax > 0 ? Math.round((v / this.dailyMax) * 100) : 0; }

  mes(m: string): string { return MES[m] ?? m; }
  cell(row: SalesByRouteRow, m: string) { return row.monthly[m]; }
}
