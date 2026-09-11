import { ChangeDetectionStrategy, Component, DestroyRef, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HasUnsavedChanges } from '../../../core/guards/unsaved-changes.guard';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { catchError, of, forkJoin } from 'rxjs';
import { compareWarehouseCodes } from '@megadulces/contracts';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { PaginatorModule, PaginatorState } from 'primeng/paginator';
import { ToastModule } from 'primeng/toast';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { MessageService } from 'primeng/api';
import {
  ComprasService, PurchaseSuggestionRow, PurchaseSuggestionResponse, ReplenishmentFilters,
  DeadStockRow, CreateRequisitionDto, CreateRequisitionLine, PedidoExportLine, saveXlsxResponse,
  TransferSuggestionRow, TransferSuggestionResponse, OverstockRow, OverstockResponse, WorkbookRow, WorkbookResponse,
  InTransitOc, InTransitResponse,
} from '../compras.service';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';

type Sev = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';
type Mode = 'pedido' | 'muerto';
type UType = 'comprar' | 'traspaso' | 'sobre';

/** Renglón unificado de la vista consolidada por sucursal. */
interface URow {
  type: UType;
  product_id: string; sku: string; nombre: string;
  warehouse_code: string; warehouse_id: string | null;   // sucursal de agrupación (compra en / destino / almacén)
  supplier_id: string | null; supplier_name: string | null;
  from_code: string | null; from_warehouse_id: string | null; to_warehouse_id: string | null;
  uxc: number; unit_cost: number;
  qty: number; editable: boolean;
  on_hand: number; cover: number | null; sell_daily: number; deficit: number; surplus: number; days_on_hand: number | null;
  fill_rate: number | null; abc_class: string | null; unit_source: string | undefined;
  buy: PurchaseSuggestionRow | null;   // ref al row de compra (override de unidad)
}
interface Grp { code: string; name: string; buy: number; tr: number; over: number; buyCj: number; trCj: number; n: number; }

/**
 * RA-PRO.47 — Renglón de COMPRA por sucursal del desglose.
 *
 * Sale de las celdas del workbook (`r.cells[code]`), NO de `purchase-suggestion`. Dos razones:
 *  1. `purchase-suggestion` agrupa a grano RED (`GROUP BY product_id`) y rotula con `primary_wh`:
 *     nunca pudo dar un renglón por sucursal, aunque la columna dijera "Sucursal".
 *  2. La tabla de arriba y el desglose quedan con el MISMO número. Antes cada uno lo calculaba con
 *     su fórmula (el workbook sin fill rate ni colchón; el otro con ellos y con su propia
 *     cobertura), así que el knob de Cobertura movía la tabla y no movía lo que se pedía.
 */
interface BranchBuy {
  code: string; name: string;
  vta: number;           // venta 30 d, en cajas — es lo que ordena la lista
  exis: number;          // existencia, en cajas
  seed: number;          // sugerido del motor, en cajas (valor inicial del input)
  cc: number;            // costo de caja DE ESA SUCURSAL
  /** U.2 — peldaño de unidad contradicho por el costo: acá no se puede ni convertir ni pedir. */
  rung: string | null;
  nat: number;           // existencia en la unidad nativa del almacén (lo que sí es verdad)
  natu: string;          // rótulo de esa unidad, ya legible (ver natLabel)
  natuRaw: string;       // el rótulo CRUDO del ERP — puede ser el GRAMAJE ('500'), no un nombre
  hub: boolean;          // ¿este almacén ES un CEDIS de consolidación?
}

/** RA-PRO.48 — una zona de compra con sus sucursales y el CEDIS donde consolida. */
interface ZoneGroup {
  zone: string;
  hubCode: string | null; hubName: string;
  order: number;
  rows: BranchBuy[];
}

/** RA-PRO.48 — acuse de entrega: a dónde llega, en total, lo que se está pidiendo. */
interface Entrega { code: string; name: string; direct: boolean; cajas: number; valor: number; }

/**
 * RA-PRO.29 — PEDIDO consolidado POR SUCURSAL. Una sola superficie agrupa lo accionable de cada
 * sucursal: qué comprar (venta×cobertura−existencia−tránsito, costo real por caja), qué traspasar
 * desde su CEDIS, y su sobrestock. Chips Comprar/Traspasos/Sobrestock agregan o quitan renglones.
 * Cada sucursal exporta XLSX o arma requisición; barra global hace lo mismo para toda la red.
 * Superficie Operations (denso, tokens, dark first-class).
 */
@Component({
  selector: 'app-compras-pedido-real',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, TableModule, PaginatorModule, ToastModule, SelectModule, MultiSelectModule,
    InputNumberModule, InputTextModule, IconFieldModule, InputIconModule, TagModule, DialogModule, MetricStripComponent, ContextHelpComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in pr-page">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1 style="display:inline-flex;align-items:center;gap:.4rem">Pedido <span class="pr-badge">unificado</span> <app-context-help topic="pedido-compras" /></h1>
          <p class="surf-page-sub">Una fila por producto, con su <strong>total de red</strong>. Clic en la fila para abrir el desglose <strong>por sucursal</strong>, en dos cejitas: <strong>Pedir a proveedor</strong> (ordenado por la que más vende, con cantidad editable, días de inventario en vivo y su valor) y <strong>Traspasos</strong> desde el CEDIS. Lo que edites abajo mueve las columnas <strong>Σ Ped.</strong> y <strong>$ Pedido</strong> de arriba. Exporta XLSX o arma la requisición por producto o global.</p>
        </div>
        <div class="pr-mode" role="tablist" aria-label="Vista">
          <button role="tab" [attr.aria-selected]="mode()==='pedido'" class="pr-tab" [class.pr-tab-on]="mode()==='pedido'" (click)="setMode('pedido')">Pedido</button>
          <button role="tab" [attr.aria-selected]="mode()==='muerto'" class="pr-tab" [class.pr-tab-on]="mode()==='muerto'" (click)="setMode('muerto')">Stock muerto</button>
        </div>
      </header>

      @if (loadedAt()) {
        <div class="pr-fresh"><i class="pi pi-clock" aria-hidden="true"></i> Datos actualizados {{ freshLabel() }}</div>
      }

      @if (mode()==='pedido') {
        <!-- RA-PRO.32.3 — PEDIDO unificado: workbook por SKU + desglose por sucursal (compra/traspaso/sobre) en el acordeón -->
        <app-metric-strip [items]="pedidoKpi()" ariaLabel="Resumen del pedido" />
        <div class="pr-filters">
          <p-select [options]="supplierOpts()" [(ngModel)]="fSupplier" (onChange)="loadWorkbook()"
                    optionLabel="label" optionValue="value" placeholder="Todos los proveedores" [showClear]="true"
                    [filter]="true" filterBy="label" [virtualScroll]="true" [virtualScrollItemSize]="34" appendTo="body"
                    styleClass="pr-sel-wide" ariaLabel="Filtrar por proveedor"></p-select>
          <p-select [options]="brandOpts()" [(ngModel)]="fBrand" (onChange)="loadWorkbook()"
                    optionLabel="label" optionValue="value" placeholder="Todas las marcas" [showClear]="true"
                    [filter]="true" filterBy="label" [virtualScroll]="true" [virtualScrollItemSize]="34" appendTo="body"
                    styleClass="pr-sel-wide" ariaLabel="Filtrar por marca"></p-select>
          <p-select [options]="categoryOpts()" [(ngModel)]="fCategory" (onChange)="loadWorkbook()"
                    optionLabel="label" optionValue="value" placeholder="Todas las categorías" [showClear]="true"
                    [filter]="true" filterBy="label" appendTo="body" styleClass="pr-sel" ariaLabel="Filtrar por categoría"></p-select>
          <p-multiselect [options]="warehouseOpts()" [(ngModel)]="wbWarehouses" (onChange)="loadWorkbook()"
                         optionLabel="label" optionValue="value" placeholder="Todas las sucursales" [showClear]="true"
                         [filter]="true" filterBy="label" [maxSelectedLabels]="2" selectedItemsLabel="{0} sucursales"
                         appendTo="body" styleClass="pr-sel" ariaLabel="Sucursales que entran al pedido y al desglose"></p-multiselect>
          <p-iconfield styleClass="pr-search">
            <p-inputicon styleClass="pi pi-search" />
            <input pInputText type="text" [(ngModel)]="search" (keyup.enter)="loadWorkbook()" placeholder="SKU o producto…" aria-label="Buscar producto" />
          </p-iconfield>
          <label class="pr-cov">
            <span>Cobertura</span>
            <p-inputnumber [(ngModel)]="coverage" (onBlur)="loadWorkbook()" [min]="1" [max]="120" [showButtons]="true"
                           buttonLayout="horizontal" [step]="1" suffix=" d" inputStyleClass="pr-cov-in"
                           decrementButtonClass="p-button-text" incrementButtonClass="p-button-text"
                           incrementButtonIcon="pi pi-plus" decrementButtonIcon="pi pi-minus" ariaLabel="Días de cobertura"></p-inputnumber>
          </label>
          <div class="pr-presets" role="group" aria-label="Cobertura rápida">
            @for (p of [14, 30, 45]; track p) {
              <button type="button" class="pr-chip" [class.pr-chip-on]="coverage === p" (click)="coverage = p; loadWorkbook()">{{ p }}d</button>
            }
          </div>
          <button type="button" class="pr-chip" [class.pr-chip-on]="wbScopeNeeded()" (click)="wbScopeNeeded.set(!wbScopeNeeded()); loadWorkbook()">Solo con pedido</button>
          <button type="button" class="pr-chip" [class.pr-chip-on]="wbOnlyOver()" (click)="toggleOnlyOver()" title="Ver solo productos con sobrestock (capital inmovilizado)">Con sobrestock</button>
          <button type="button" class="pr-chip" [class.pr-chip-on]="fIad()==='accel'" (click)="toggleIad('accel')" title="Solo productos con demanda acelerando (IAD ≥ +0.25)">▲ Acelerando</button>
          <button type="button" class="pr-chip" [class.pr-chip-on]="fIad()==='decel'" (click)="toggleIad('decel')" title="Solo productos con demanda desacelerando (IAD ≤ −0.25)">▼ Desacelerando</button>
        </div>

        @if (error()) {
          <div class="pr-state pr-error">
            <i class="pi pi-exclamation-triangle"></i>
            <div><p>No se pudo cargar el workbook.</p>
              <p-button type="button" label="Reintentar" icon="pi pi-refresh" styleClass="p-button-sm p-button-text" (click)="loadWorkbook()"></p-button></div>
          </div>
        } @else {
          <!-- U.2 — el inventario valuado declara su hueco. Sin este banner el total baja en
               silencio al dejar de sumar lo no verificado, y eso se lee como "hay menos
               inventario" — otra mentira distinta de la que estamos quitando. -->
          @if (rungGap(); as g) {
            <div class="pr-rung-banner">
              <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
              <p>
                <strong>{{ g.skus | number }} {{ g.skus === 1 ? 'producto' : 'productos' }}</strong>
                ({{ g.celdas | number }} {{ g.celdas === 1 ? 'almacén' : 'almacenes' }})
                quedan <strong>sin valuar</strong>: su divisor de cajas no cuadra con lo que se pagó
                por unidad de stock, así que la existencia no se convierte a cajas ni se multiplica
                por el costo de caja. <strong>No valen cero — no se están midiendo.</strong>
                @if (g.arbitrado > 0) {
                  Contra lo pagado rondarían <strong>{{ money(g.arbitrado) }}</strong>, cifra de
                  referencia para revisar y no para publicar.
                }
                En esos renglones la celda muestra la cantidad en la unidad que el ERP realmente
                guarda (kg, paquete, cubeta), que sí es verdad.
              </p>
            </div>
          }
          <div class="pr-wb-scroll">
            <p-table [value]="wbRows()" [loading]="loading()"
                     styleClass="p-datatable-sm pr-table pr-wb" [tableStyle]="wbTableStyle">
              <ng-template #header>
                <tr>
                  <th style="min-width:15rem">Producto</th>
                  <th class="pr-r" title="Piezas por caja · y paquetes por caja si es multipack">Unidad<br/>x caja</th>
                  <th class="pr-r">Costo/Cja</th>
                  <th class="pr-r" title="Índice de Aceleración de Demanda (−2..+2): compara el ritmo reciente (30d vs 31-60d) + estacional año-vs-año. ▲ acelera · ═ estable · ▼ desacelera. Señal informativa; no cambia el sugerido.">Tend.</th>
                  <th class="pr-r" title="Estacionalidad (RA-PRO.41): cuánto vende el horizonte (próximos 30 días) vs los últimos 30, según la historia del SKU/categoría/red. El Pedido YA la incluye. — = mes plano.">Est.</th>
                  <th class="pr-r" title="Existencia de toda la red, en CAJAS (suma de las sucursales). El desglose por sucursal está al abrir la fila.">Exist.<br/>red</th>
                  <th class="pr-r" title="Clase XYZ de red (X estable · Y variable · Z errático) — peor caso entre sucursales">XYZ</th>
                  <th class="pr-r" title="Mercancía ya pedida que todavía no llega (OC abierta en Kepler). Clic para ver folios, antigüedad y cuándo llega. El Pedido la descuenta PESADA por la probabilidad de que llegue: una orden abierta hace semanas casi no cuenta, porque en Kepler la OC se captura al recibir.">En camino</th>
                  <th class="pr-r" title="Punto de reorden de red (cajas)">Reorden</th>
                  <th class="pr-r" title="Máximo de red (cajas)">Máx</th>
                  <th class="pr-r" title="Total de lo que se va a pedir, en CAJAS. Es la suma de las sucursales del desglose y SE MUEVE al editarlas.">Σ Ped.<br/>cajas</th>
                  <th class="pr-r pr-muted-h" title="El mismo total, en piezas (cajas × unidades por caja).">Σ Piezas</th>
                  <th class="pr-r pr-val" title="Lo que cuesta ese pedido, valuado con el costo de caja de CADA sucursal.">$ Pedido</th>
                  <th class="pr-r">Valor<br/>venta</th>
                  <th class="pr-r">Valor<br/>exist.</th>
                </tr>
              </ng-template>
              <ng-template #body let-r>
                <tr class="pr-wb-row" [class.pr-wb-open]="isOpen(r)" (click)="toggleRow(r)" tabindex="0" (keyup.enter)="toggleRow(r)"
                    [attr.aria-expanded]="isOpen(r)" [attr.aria-label]="(isOpen(r) ? 'Cerrar' : 'Abrir') + ' detalle de ' + r.sku">
                  <td><div class="pr-prod"><i class="pi pr-wb-go" [ngClass]="isOpen(r) ? 'pi-angle-down' : 'pi-angle-right'"></i> {{ r.nombre }}</div><div class="pr-prod-meta"><span class="pr-sku">{{ r.sku }}</span> <span class="pr-supp">{{ r.supplier_name || '—' }}</span>@if (abcOf(r.product_id); as a) { <p-tag [value]="a" [severity]="abcSev(a)" styleClass="pr-abc"></p-tag> }@for (t of prodTypes(r.product_id); track t) { <p-tag [value]="typeLabel(t)" [severity]="typeSev(t)" styleClass="pr-abc"></p-tag> }@if (unitRefOf(r.product_id); as u) { <button type="button" class="pr-unit-btn" (click)="openUnit(u); $event.stopPropagation()" title="Ajustar la unidad de venta de este producto"><p-tag [value]="unitLabel(u.unit_source)" [severity]="u.unit_source === 'revisar' ? 'warn' : 'contrast'" styleClass="pr-abc"></p-tag></button> }</div></td>
                  <td class="pr-r pr-muted pr-uxc">
                    <div>{{ r.uxc | number:'1.0-0' }} <span class="pr-unit" [title]="unidadTitle(r)">{{ unidadBase(r) }}</span></div>
                    @if (r.packs_per_box) { <div class="pr-unit2" [title]="r.packs_per_box + ' paquetes de ' + r.pack_size + ' por caja'">{{ r.packs_per_box }} paq × {{ r.pack_size }}</div> }
                  </td>
                  <td class="pr-r pr-muted">{{ money(r.caja_cost) }}</td>
                  <td class="pr-r">
                    @if (r.iad != null) {
                      <p-tag [value]="iadLabel(r)" [severity]="iadSev(r)" styleClass="pr-cov-tag" [title]="iadTitle(r)"></p-tag>
                    } @else { <span class="pr-muted" [title]="iadTitle(r)">—</span> }
                  </td>
                  <td class="pr-r">
                    @if (seasonOn(r)) {
                      <p-tag [value]="seasonLabel(r)" [severity]="seasonSev(r)" styleClass="pr-cov-tag" [title]="seasonTitle(r)"></p-tag>
                    } @else { <span class="pr-muted" title="Mes plano — la estacionalidad no mueve el pedido">—</span> }
                  </td>
                  <!-- U.2 — la existencia de red suma SOLO los almacenes con el peldano verificado.
                       Si alguno quedo fuera se declara con el triangulo y el conteo en el tooltip,
                       porque un total mas chico se lee como "hay menos inventario". -->
                  <td class="pr-r pr-muted" [title]="exisRedTitle(r)">
                    @if (r.almacenes_sin_valuar) {
                      <span class="pr-rung">{{ exisRed(r) | number:'1.0-1' }} <i class="pi pi-exclamation-triangle" aria-hidden="true"></i></span>
                    } @else { {{ exisRed(r) | number:'1.0-1' }} }
                  </td>
                  <td class="pr-r">@if (r.xyz_class) { <span class="pr-mono">{{ r.xyz_class }}</span> } @else { <span class="pr-muted">—</span> }</td>
                  <td class="pr-r">
                    @if (r.transito_cajas && r.transito_cajas > 0) {
                      <button type="button" class="pr-tran-btn" (click)="openTransit(r); $event.stopPropagation()"
                              [title]="'Ver las órdenes de compra abiertas de ' + r.sku">
                        <i class="pi pi-truck" aria-hidden="true"></i> {{ r.transito_cajas | number:'1.0-1' }}
                      </button>
                    } @else { <span class="pr-muted">—</span> }
                  </td>
                  <td class="pr-r pr-muted">{{ r.reorder_cajas != null ? (r.reorder_cajas | number:'1.0-1') : '—' }}</td>
                  <td class="pr-r pr-muted">{{ r.max_cajas != null ? (r.max_cajas | number:'1.0-1') : '—' }}</td>
                  <!-- Los totales son la SUMA VIVA del desglose de abajo: al editar una sucursal
                       se mueven acá. Arrancan en el sugerido del motor, que es lo mismo que
                       publicaba antes la columna por sucursal. -->
                  <td class="pr-r pr-strong" [title]="pedidoTitle(r)">
                    {{ sumCajas(r) | number:'1.0-1' }}@if (r.almacenes_sin_pedido) { <i class="pi pi-exclamation-triangle" aria-hidden="true"></i> }
                  </td>
                  <td class="pr-r pr-muted-h">{{ sumPiezas(r) | number:'1.0-0' }}</td>
                  <td class="pr-r pr-val pr-strong" [class.pr-ped-on]="sumCajas(r) > 0">{{ money(sumValor(r)) }}</td>
                  <td class="pr-r pr-muted">{{ money(r.valor_venta) }}</td>
                  <!-- U.2 — el valuado no se dibuja si algún almacén tiene el peldaño sin verificar:
                       un cero o un parcial silencioso se lee como "hay poco inventario", que es otra
                       mentira. Se declara con el conteo de almacenes y el motivo en el tooltip. -->
                  <td class="pr-r pr-muted" [title]="valorExisTitle(r)">
                    @if (r.almacenes_sin_valuar) {
                      <span class="pr-rung">
                        @if (r.valor_exis) { {{ money(r.valor_exis) }} } @else { sin valuar }
                        <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                      </span>
                    } @else { {{ money(r.valor_exis) }} }
                  </td>
                </tr>
                @if (isOpen(r)) {
                  <tr class="pr-wb-exp">
                    <td [attr.colspan]="wbColCount">
                      <div class="pr-exp-in">
                        <div class="pr-det-head">
                          <span class="pr-mono pr-det-sku">{{ r.sku }}</span>
                          <strong class="pr-det-name">{{ r.nombre }}</strong>
                          @if (r.supplier_name) { <span class="pr-supp">{{ r.supplier_name }}</span> }
                          <span class="pr-det-uxc">1 caja = {{ r.uxc | number:'1.0-0' }} {{ unidadBase(r) }}</span>
                        </div>
                        <div class="pr-det-tabs" role="tablist" aria-label="Desglose por sucursal">
                          <button role="tab" type="button" class="pr-tab" [class.pr-tab-on]="tabOf(r.product_id)==='buy'"
                                  [attr.aria-selected]="tabOf(r.product_id)==='buy'" (click)="setTab(r.product_id, 'buy')">
                            Pedir a proveedor @if (branchBuys(r).length) { <span class="pr-tab-n">{{ branchBuys(r).length }}</span> }
                          </button>
                          <button role="tab" type="button" class="pr-tab" [class.pr-tab-on]="tabOf(r.product_id)==='tr'"
                                  [attr.aria-selected]="tabOf(r.product_id)==='tr'" (click)="setTab(r.product_id, 'tr')">
                            Traspasos @if (trasRows(r.product_id).length) { <span class="pr-tab-n">{{ trasRows(r.product_id).length }}</span> }
                          </button>
                        </div>

                        @if (tabOf(r.product_id) === 'buy') {
                          @if (!branchBuys(r).length) {
                            <div class="pr-peek-loading">Este producto no tiene existencia ni venta en ninguna sucursal del filtro.</div>
                          } @else {
                            <div class="pr-wb-scroll">
                              <table class="pr-peek-tbl pr-det-tbl">
                                <thead><tr>
                                  <th>Sucursal</th>
                                  <th class="pr-r" title="Venta de los últimos 30 días en esa sucursal, en CAJAS. Ordena la lista dentro de cada zona: la que más vende, arriba.">Venta 30d</th>
                                  <th class="pr-r" title="Existencia de esa sucursal, en CAJAS.">Exist.</th>
                                  <th class="pr-r pr-ped-h" title="Lo que se le va a pedir. Arranca en el sugerido del motor (venta × cobertura − existencia − en camino); editalo con las flechas o escribiendo.">Pedido ✎</th>
                                  <th class="pr-r" title="En qué unidad estás capturando ESTE renglón. Sólo cambia cómo se escribe: el pedido, los días y el valor siempre se calculan en cajas.">Unidad</th>
                                  <th class="pr-r" title="Cuánto dura el inventario con lo que pidas: (existencia + pedido) ÷ (venta 30d ÷ 30.4). Se mueve mientras escribís.">Días inv.</th>
                                  <th title="Dónde entrega el proveedor: directo en la sucursal, o consolidado en un CEDIS (que después baja la mercancía por traspaso).">Entrega</th>
                                  <th class="pr-r pr-val" title="Pedido × costo de caja DE ESA SUCURSAL.">Valor</th>
                                </tr></thead>
                                <tbody>
                                  @for (z of branchZones(r); track z.zone) {
                                  @if (showZones(r)) {
                                  <tr class="pr-zrow">
                                    <td colspan="8">
                                      <span class="pr-zname">Zona {{ z.zone }}</span>
                                      @if (z.hubCode) {
                                        <span class="pr-zhub">consolida en <span class="pr-mono">{{ z.hubCode }}</span> {{ z.hubName }}</span>
                                        <span class="pr-bulk-sp"></span>
                                        <button type="button" class="pr-zlink" (click)="zoneAllDirect(r, z)">todo directo</button>
                                        <button type="button" class="pr-zlink" (click)="zoneAllToHub(r, z)">todo a {{ z.hubCode }}</button>
                                      } @else {
                                        <span class="pr-zhub pr-rung">sin CEDIS asignado — configuralo en el almacén</span>
                                      }
                                    </td>
                                  </tr>
                                  }
                                  @for (b of z.rows; track b.code) {
                                    <tr>
                                      <td><span class="pr-mono">{{ b.code }}</span> <span class="pr-peek-terr">{{ b.name }}</span></td>
                                      <td class="pr-r pr-muted">{{ b.vta | number:'1.0-1' }}</td>
                                      <!-- U.2 — con el peldano contradicho la conversion a cajas no es
                                           confiable: se muestra la cantidad SUELTA con el rotulo que da
                                           el ERP, que si es verdad. -->
                                      @if (b.rung) {
                                        <td class="pr-r"><span class="pr-rung" [title]="bRungTitle(b)">{{ b.nat | number:'1.0-0' }} {{ b.natu }} <i class="pi pi-exclamation-triangle" aria-hidden="true"></i></span></td>
                                      } @else {
                                        <td class="pr-r"><p-tag [value]="(b.exis | number:'1.0-1') ?? ''" [severity]="existSev(b.exis, qtyOf(r, b))" styleClass="pr-cov-tag" [title]="existTitle(b.exis, qtyOf(r, b))"></p-tag></td>
                                      }
                                      <!-- U.2 — no se puede restar existencia con un divisor que el costo
                                           contradice: el sugerido saldria mal en la direccion cara. Se
                                           bloquea la captura en vez de prellenar un numero falso. -->
                                      @if (b.rung) {
                                        <td class="pr-r pr-rung" [title]="bRungTitle(b)">—</td>
                                        <td class="pr-r pr-muted">—</td>
                                        <td class="pr-r pr-muted">—</td>
                                        <td class="pr-muted">—</td>
                                        <td class="pr-r pr-muted">—</td>
                                      } @else {
                                        <td class="pr-r">
                                          <input type="number" min="0" step="1" class="pr-qty pr-qty-sm"
                                                 [ngModel]="dispOf(r, b)" (ngModelChange)="setDispOf(r, b, $event)"
                                                 [attr.aria-label]="'Pedido de ' + r.sku + ' en ' + b.code + ' en ' + (unitOfBranch(r, b) === 'pieza' ? 'piezas' : 'cajas')" />
                                        </td>
                                        <td class="pr-r">
                                          <div class="pr-uu" role="group" [attr.aria-label]="'Unidad de captura en ' + b.code">
                                            <button type="button" class="pr-uu-b" [class.pr-uu-on]="unitOfBranch(r, b)==='caja'"
                                                    [attr.aria-pressed]="unitOfBranch(r, b)==='caja'" (click)="setUnitBranch(r, b, 'caja')" title="Capturar en cajas">cj</button>
                                            <button type="button" class="pr-uu-b" [class.pr-uu-on]="unitOfBranch(r, b)==='pieza'"
                                                    [attr.aria-pressed]="unitOfBranch(r, b)==='pieza'" (click)="setUnitBranch(r, b, 'pieza')" [title]="'Capturar en ' + unidadBase(r)">pz</button>
                                          </div>
                                        </td>
                                        <!-- Sin venta no hay cobertura que calcular: se DECLARA, no se
                                             dibuja como 0 (que se lee "urge") ni como infinito. -->
                                        @if (diasInv(r, b) !== null) {
                                          <td class="pr-r"><p-tag [value]="diasLabel(diasInv(r, b))" [severity]="coverSev(diasInv(r, b))" styleClass="pr-cov-tag" [title]="diasTitle(r, b)"></p-tag></td>
                                        } @else {
                                          <td class="pr-r"><span class="pr-muted" [title]="diasTitle(r, b)">—</span></td>
                                        }
                                        <!-- El texto al lado de la palomita es lo que la hace legible:
                                             una casilla pelada nunca dice si marcada es "directo" o
                                             "consolidado". Acá el renglón lo declara: "→ 01". -->
                                        <td class="pr-ent">
                                          <div class="pr-uu" role="group" [attr.aria-label]="'Entrega de ' + b.code">
                                            <button type="button" class="pr-uu-b" [class.pr-uu-on]="!isConsolidated(r, b)"
                                                    [attr.aria-pressed]="!isConsolidated(r, b)" (click)="setDirect(r, b)"
                                                    title="El proveedor entrega en esta sucursal">Sucursal</button>
                                            <button type="button" class="pr-uu-b" [class.pr-uu-on]="isConsolidated(r, b)"
                                                    [attr.aria-pressed]="isConsolidated(r, b)" (click)="setConsolidated(r, b)"
                                                    [disabled]="!cedisFor(b).length"
                                                    title="El proveedor entrega en un CEDIS y de ahí baja por traspaso">Consolidado</button>
                                          </div>
                                          @if (isConsolidated(r, b)) {
                                            <select class="pr-cedis" [ngModel]="deliverOf(r, b)" (ngModelChange)="setDeliverTo(r, b, $event)"
                                                    [title]="deliverTitle(r, b)" [attr.aria-label]="'CEDIS donde se entrega lo de ' + b.code">
                                              @for (cd of cedisFor(b); track cd.code) {
                                                <option [value]="cd.code">→ {{ cd.code }} · {{ cedisLabel(cd.name) }}</option>
                                              }
                                            </select>
                                          }
                                        </td>
                                        <td class="pr-r pr-val" [class.pr-strong]="qtyOf(r, b) > 0">{{ money(qtyOf(r, b) * b.cc) }}</td>
                                      }
                                    </tr>
                                  }
                                  }
                                </tbody>
                              </table>
                            </div>
                            <!-- ACUSE — la palomita dice qué marcaste; esto dice qué se le va a
                                 pedir al proveedor. Y avisa de los traspasos ANTES del botón:
                                 consolidar no es una etiqueta, son dos movimientos reales. -->
                            @if (entregas(r).length) {
                              <div class="pr-entregas">
                                <span class="pr-ent-lbl">Se entrega en</span>
                                @for (e of entregas(r); track e.code) {
                                  <span class="pr-ent-chip" [class.pr-ent-dir]="e.direct">
                                    @if (!e.direct) { <i class="pi pi-building" aria-hidden="true"></i> }
                                    <span class="pr-mono">{{ e.code }}</span> {{ e.name }}
                                    <b>{{ e.cajas | number:'1.0-1' }} cj</b> {{ money(e.valor) }}
                                    @if (e.direct) { <em>directo</em> }
                                  </span>
                                }
                                @if (traspasosGenerados(r); as n) {
                                  <span class="pr-ent-warn" title="Consolidar significa que la mercancía llega al CEDIS y de ahí baja a la sucursal. Al armar la requisición se crean los dos documentos: la compra al CEDIS y el traspaso.">
                                    <i class="pi pi-info-circle" aria-hidden="true"></i>
                                    al armar se {{ n === 1 ? 'genera 1 traspaso' : 'generan ' + n + ' traspasos' }} CEDIS → sucursal
                                  </span>
                                }
                              </div>
                            }
                          }
                        } @else {
                          @if (!detailReady()) {
                            <div class="pr-peek-loading"><i class="pi pi-spin pi-spinner"></i> Cargando traspasos…</div>
                          } @else if (!trasRows(r.product_id).length) {
                            <div class="pr-peek-loading">Sin traspasos sugeridos para este producto con estos filtros.</div>
                          } @else {
                            <div class="pr-ordu" role="group" aria-label="Unidad de traspaso">
                              <span class="pr-ordu-lbl">Traspasar en:</span>
                              <button type="button" class="pr-chip" [class.pr-chip-on]="unitOf(r.product_id)==='caja'" (click)="setUnit(r.product_id, 'caja')">Caja</button>
                              @if (packOf(r.product_id)?.packs) {
                                <button type="button" class="pr-chip" [class.pr-chip-on]="unitOf(r.product_id)==='paquete'" (click)="setUnit(r.product_id, 'paquete')">Paquete</button>
                              }
                              <button type="button" class="pr-chip" [class.pr-chip-on]="unitOf(r.product_id)==='pieza'" (click)="setUnit(r.product_id, 'pieza')">Pieza</button>
                              @if (packOf(r.product_id); as pk) {
                                <span class="pr-ordu-hint">1 caja = {{ pk.uxc | number:'1.0-0' }} pz@if (pk.packs) { = {{ pk.packs }} paq × {{ pk.pack }} pz }</span>
                              }
                            </div>
                            <div class="pr-wb-scroll">
                              <table class="pr-peek-tbl pr-det-tbl">
                                <thead><tr>
                                  <th>Sucursal</th><th>Acción</th>
                                  <th class="pr-r" title="Déficit de la sucursal (cajas)">Señal</th>
                                  <th class="pr-r" title="Existencia de la sucursal, en CAJAS.">Exist.</th>
                                  <th class="pr-r">Cant. ({{ unitLabelShort(r.product_id) }}) ✎</th>
                                  <th class="pr-r" title="Equivalente TOTAL en piezas de lo traspasado (cajas × piezas por caja). No es la unidad de captura — esa es la columna Cant.">= Piezas</th>
                                  <th class="pr-r">Costo</th><th class="pr-r">Valor</th>
                                </tr></thead>
                                <tbody>
                                  @for (u of trasRows(r.product_id); track u.warehouse_code) {
                                    <tr>
                                      <td><span class="pr-mono">{{ u.warehouse_code }}</span> <span class="pr-peek-terr">{{ nameOf(u.warehouse_code) }}</span></td>
                                      <td class="pr-det-act">
                                        <p-tag [value]="typeLabel(u.type)" [severity]="typeSev(u.type)" styleClass="pr-abc"></p-tag>
                                        @if (u.from_code) { <span class="pr-mono pr-from">← {{ u.from_code }}</span> }
                                      </td>
                                      <td class="pr-r"><span class="pr-muted" title="Déficit de la sucursal (cajas)">déf {{ u.deficit | number:'1.0-1' }}</span></td>
                                      <td class="pr-r"><p-tag [value]="(u.on_hand | number:'1.0-1') ?? ''" [severity]="existSevU(u)" styleClass="pr-cov-tag" [title]="existTitleU(u)"></p-tag></td>
                                      <td class="pr-r"><input type="number" min="0" step="any" class="pr-qty pr-qty-sm" [ngModel]="dispQty(u)" (ngModelChange)="setDispQty(u, $event)" [attr.aria-label]="'Traspaso de ' + r.sku + ' a ' + u.warehouse_code + ' (' + unitLabelShort(r.product_id) + ')'" /></td>
                                      <td class="pr-r pr-muted">{{ (u.qty * u.uxc) | number:'1.0-0' }}</td>
                                      <td class="pr-r pr-muted">{{ money(u.unit_cost) }}</td>
                                      <td class="pr-r pr-strong">{{ money(u.qty * u.unit_cost) }}</td>
                                    </tr>
                                  }
                                </tbody>
                              </table>
                            </div>
                          }
                        }

                        <div class="pr-exp-actions">
                          <span class="pr-exp-sum">
                            @if (sumValor(r) > 0) { <span class="pr-gs-buy">comprar {{ money(sumValor(r)) }}</span> }
                            @if (prodTr(r.product_id) > 0) { <span class="pr-gs-tr">· traspaso {{ money(prodTr(r.product_id)) }}</span> }
                          </span>
                          <span class="pr-bulk-sp"></span>
                          <p-button type="button" label="XLSX del producto" icon="pi pi-file-excel" styleClass="p-button-sm p-button-text" (click)="exportScope(undefined, r.product_id)" [disabled]="dl()"></p-button>
                          <p-button type="button" [label]="saving() ? 'Armando…' : 'Requisición'" icon="pi pi-check" styleClass="p-button-sm" (click)="buildReq(undefined, r.product_id)" [disabled]="saving() || (sumValor(r) + prodTr(r.product_id)) <= 0"></p-button>
                        </div>
                      </div>
                    </td>
                  </tr>
                }
              </ng-template>
              <ng-template #emptymessage>
                <tr><td [attr.colspan]="wbColCount" class="pr-empty">
                  <i class="pi pi-inbox"></i>
                  <p>Sin datos en los puntos de compra.</p>
                  <span>Ajusta proveedor o búsqueda. Requiere el fact del pedido cargado + la topología de abasto configurada.</span>
                </td></tr>
              </ng-template>
            </p-table>
          </div>
          @if (wbTotal() > wbPageSize()) {
            <p-paginator [first]="wbFirst()" [rows]="wbPageSize()" [totalRecords]="wbTotal()"
                         [rowsPerPageOptions]="[20, 50, 100]" (onPageChange)="onWbPage($event)"
                         styleClass="pr-pager"></p-paginator>
          }
          <p class="pr-foot">Una fila por producto, en <strong>cajas</strong>. <strong>Exist. red</strong> = existencia sumada de las sucursales · <strong>Σ Ped.</strong> = lo que se va a pedir, suma viva del desglose (arranca en el sugerido: venta diaria × <strong>estación</strong> × cobertura − existencia − <strong>en camino</strong>). La columna <strong>Est.</strong> muestra la razón estacional que ya lleva puesta; <strong>En camino</strong> es lo ya pedido y sin recibir — clic para ver folios, antigüedad y fechas: se descuenta pesado por la probabilidad de que cada orden llegue, así que una OC estancada deja de tapar el pedido. La venta de las <strong>rutas</strong> cuenta en su sucursal madre. <em>Clic en una fila para abrir su desglose por sucursal — podés abrir varias a la vez.</em></p>
        }

        @if (wbRows().length) {
          <div class="pr-bulk" role="region" aria-label="Acciones globales">
            @if (totCajas() > 0) {
              <span class="pr-bulk-n" title="Suma de los productos de ESTA página, con lo que hayas editado en los desgloses. Es exactamente lo que arman los botones de acá al lado. El KPI «A comprar» de arriba es el total del filtro completo.">En esta página · comprar <strong>{{ money(totBuy()) }}</strong> · traspaso <strong>{{ money(totTr()) }}</strong>@if (totOver() > 0) { · <span class="pr-gs-over">sobre {{ money(totOver()) }}</span> }</span>
            } @else {
              <span class="pr-bulk-n">{{ wbTotal() }} productos en la vista</span>
            }
            <span class="pr-bulk-sp"></span>
            <p-button type="button" label="XLSX" icon="pi pi-file-excel" styleClass="p-button-sm" (click)="exportWorkbook()" [disabled]="dl() || !wbRows().length" ariaLabel="Exportar XLSX: hoja Todos + una por proveedor + hoja Traspasos"></p-button>
            <p-button type="button" [label]="saving() ? 'Armando…' : 'Requisiciones (global)'" icon="pi pi-check" styleClass="p-button-sm p-button-text" (click)="buildReq()" [disabled]="saving() || totCajas() <= 0"></p-button>
          </div>
        }

        <!-- RA-PRO.44 — QUÉ VIENE EN CAMINO: las OCs abiertas del SKU. Es la explicación del
             "Pedido 0" — el motor descuenta lo ya pedido, y hasta ahora eso era invisible. -->
        <p-dialog [(visible)]="tranVisible" [modal]="true" [style]="{ width: '46rem' }" [dismissableMask]="true"
                  [header]="'En camino — ' + (tranProduct()?.nombre || '')">
          @if (tranLoading()) {
            <div class="pr-peek-loading"><i class="pi pi-spin pi-spinner"></i> Consultando órdenes de compra…</div>
          } @else if (tranError()) {
            <div class="pr-state pr-error"><i class="pi pi-exclamation-triangle"></i>
              <p>No se pudieron leer las órdenes de compra.</p></div>
          } @else if (tranRows().length) {
            <p class="pr-uov-hint">
              <strong>{{ tranTotalCajas() | number:'1.0-1' }} cajas</strong> ya pedidas y sin recibir
              ({{ money(tranTotalValor()) }}).
              La llegada es <strong>estimada</strong>: Kepler no guarda fecha prometida, así que se calcula
              como fecha de la orden + el tiempo de surtido del proveedor@if (tranLead()) { ({{ tranLead() }} d) }.
            </p>
            <!-- RA-PRO.45 — la brecha entre lo que dice el papel y lo que el motor descuenta. Sin
                 esto la pantalla se contradice sola: "vienen 180 cajas" y aun así sugiere pedir. -->
            @if (tranGap() > 0.05) {
              <p class="pr-tran-gap">
                <i class="pi pi-info-circle" aria-hidden="true"></i>
                El pedido descuenta <strong>{{ tranDescuenta() | number:'1.0-1' }} cajas</strong>, no las
                {{ tranTotalCajas() | number:'1.0-1' }}: en Kepler la orden se captura al recibir, así que
                una que sigue abierta hace semanas casi nunca llega. Cada orden pesa según su antigüedad.
              </p>
            }
            <table class="pr-peek-tbl">
              <thead><tr>
                <th>Folio</th><th>Suc.</th><th>Proveedor</th><th>Fecha OC</th><th>Llega aprox.</th>
                <th class="pr-r">Abierta</th>
                <th class="pr-r">Pedido</th><th class="pr-r">Cajas</th><th class="pr-r">Valor</th>
              </tr></thead>
              <tbody>
                @for (o of tranRows(); track o.folio + ':' + o.sucursal) {
                  <tr>
                    <td class="pr-mono">{{ o.folio }}</td>
                    <td class="pr-mono pr-muted">{{ o.sucursal }}</td>
                    <td class="pr-supp">{{ o.proveedor || '—' }}</td>
                    <td class="pr-muted">{{ o.fecha_oc | date:'dd/MM/yy' }}</td>
                    <td>
                      <p-tag [value]="(o.llega_aprox | date:'dd/MM/yy') || ''"
                             [severity]="llegaSev(o)" styleClass="pr-cov-tag" [title]="llegaTitle(o)"></p-tag>
                    </td>
                    <td class="pr-r"><span [class]="edadCls(o)" [title]="edadTitle(o)">{{ o.dias_abierta }} d</span></td>
                    <td class="pr-r pr-muted">{{ o.cantidad | number:'1.0-0' }} {{ o.unidad }}</td>
                    <td class="pr-r pr-strong">{{ o.cajas | number:'1.0-1' }}</td>
                    <td class="pr-r pr-val">{{ money(o.valor) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <div class="pr-peek-loading">Este producto no tiene órdenes de compra abiertas.</div>
          }
        </p-dialog>

        <!-- RA-PRO.28 — override manual de unidad de venta (se abre desde el desglose por sucursal) -->
        <p-dialog [(visible)]="unitVisible" [modal]="true" [style]="{ width: '32rem' }" [dismissableMask]="true" header="Unidad de venta">
          @if (unitRow(); as u) {
            <div class="pr-uov">
              <p class="pr-uov-prod"><strong>{{ u.nombre }}</strong> <span class="pr-sku">{{ u.sku }}</span></p>
              <p class="pr-uov-hint">
                El motor detectó <strong>{{ unitLabel(u.unit_source) || 'catálogo' }}</strong>@if (u.price_ratio) { · ratio de precio mayoreo/retail <strong>{{ u.price_ratio | number:'1.0-1' }}×</strong> }.
                Ajusta solo si el pedido sale en la unidad equivocada. Deja vacío para volver al automático.
              </p>
              <label class="pr-uov-f">
                <span>Sub-unidades por unidad de stock (SUF)</span>
                <input pInputText type="number" min="1" step="0.1" [(ngModel)]="ovSuf" placeholder="auto" />
                <small>Para granel: kg (o piezas) por cubeta/bulto. Ej. cobertura 20K → 20.</small>
              </label>
              <label class="pr-uov-f">
                <span>Unidades de stock por caja de pedido (BF)</span>
                <input pInputText type="number" min="1" step="1" [(ngModel)]="ovBf" placeholder="auto" />
                <small>Cuántas unidades de stock trae una caja de compra. Granel = 1.</small>
              </label>
              <div class="pr-uov-actions">
                <p-button type="button" label="Volver a automático" styleClass="p-button-sm p-button-text" (click)="clearUnit()" [disabled]="unitSaving()"></p-button>
                <span class="pr-bulk-sp"></span>
                <p-button type="button" label="Cancelar" styleClass="p-button-sm p-button-text" (click)="unitVisible=false"></p-button>
                <p-button type="button" [label]="unitSaving() ? 'Guardando…' : 'Guardar'" icon="pi pi-check" styleClass="p-button-sm" (click)="saveUnit()" [disabled]="unitSaving()"></p-button>
              </div>
            </div>
          }
        </p-dialog>
      } @else {
        <!-- STOCK MUERTO: productos activos SIN rotación (capital inmovilizado) -->
        <div class="pr-filters">
          <p-iconfield styleClass="pr-search">
            <p-inputicon styleClass="pi pi-search" />
            <input pInputText type="text" [(ngModel)]="search" (keyup.enter)="loadDead()" placeholder="SKU o producto…" aria-label="Buscar producto" />
          </p-iconfield>
          @if (deadValue() > 0) { <span class="pr-count">{{ money(deadValue()) }} inmovilizado</span> }
          <p-button type="button" label="XLSX" icon="pi pi-file-excel" styleClass="p-button-sm p-button-text" (click)="exportDead()" [disabled]="dl() || !deadRows().length"></p-button>
        </div>
        <p-table [value]="deadRows()" [loading]="loading()"
                 [paginator]="true" [rows]="50" [rowsPerPageOptions]="[50, 100, 200]"
                 styleClass="p-datatable-sm pr-table" [tableStyle]="deadTableStyle">
          <ng-template #header>
            <tr><th style="min-width:16rem">Producto</th><th style="width:5rem">Almacén</th>
              <th class="pr-r" title="Existencia en CAJAS. La cantidad en la unidad suelta del almacén va en el tooltip de la celda.">Exist.<br/>cajas</th>
              <th class="pr-r">Costo</th><th class="pr-r pr-val">Inmovilizado</th><th>Última actividad</th><th>Proveedor</th></tr>
          </ng-template>
          <ng-template #body let-r>
            <tr>
              <td><div class="pr-prod">{{ r.nombre }}</div><div class="pr-sku">{{ r.sku }}</div></td>
              <td class="pr-mono pr-muted">{{ r.warehouse_code }}</td>
              <td class="pr-r pr-muted" [title]="deadUnitsTitle(r)">{{ r.on_hand_cajas | number:'1.0-1' }}</td>
              <td class="pr-r pr-muted" [title]="'Costo de una caja (' + (r.unit_cost | number:'1.2-2') + ' por ' + r.base_label + ' × ' + r.box_factor + ')'">{{ money(r.caja_cost) }}</td>
              <td class="pr-r pr-val pr-strong">{{ money(r.dead_value) }}</td>
              <td class="pr-muted">{{ r.last_activity ? (r.last_activity | date:'dd/MM/yy') : 'sin actividad' }}</td>
              <td class="pr-supp">{{ r.supplier_name || '—' }}</td>
            </tr>
          </ng-template>
          <ng-template #emptymessage>
            <tr><td colspan="7" class="pr-empty"><i class="pi pi-inbox"></i><p>Sin stock muerto.</p><span>Ningún producto activo con existencia y sin rotación.</span></td></tr>
          </ng-template>
        </p-table>
      }
    </div>
  `,
  styles: [`
    :host { display: block; padding-bottom: 3.5rem; }
    app-metric-strip { display: block; margin-bottom: 1rem; }
    .surf-page-head { display: flex; align-items: flex-start; gap: 1rem; }
    .pr-badge { font-family: var(--font-mono, ui-monospace, monospace); font-size: .6rem; text-transform: uppercase; letter-spacing: .08em;
      color: var(--action); border: 1px solid var(--action-ring, var(--border-color)); border-radius: var(--r-pill, 999px); padding: .05rem .45rem; vertical-align: middle; margin-left: .4rem; }
    .pr-mode { display: inline-flex; gap: .15rem; margin-left: auto; border: 1px solid var(--border-color); border-radius: var(--r-md, 12px); padding: .15rem; }
    .pr-tab { font-size: .78rem; padding: .3rem .7rem; border: 0; background: transparent; color: var(--text-muted); border-radius: var(--r-sm, 8px); cursor: pointer; }
    .pr-tab-on { background: var(--overlay-selected, var(--hover-bg)); color: var(--text-main); font-weight: 600; }
    .pr-filters { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; margin-bottom: .75rem; }
    :host ::ng-deep .pr-sel-wide { min-width: 17rem; }
    :host ::ng-deep .pr-sel { min-width: 13rem; }
    :host ::ng-deep .pr-search input { min-width: 12rem; }
    .pr-count { margin-left: auto; font-size: .8rem; color: var(--text-muted); }
    .pr-cov { display: inline-flex; align-items: center; gap: .4rem; font-size: .8rem; color: var(--text-muted); }
    :host ::ng-deep .pr-cov-in { width: 4.5rem; text-align: right; font-variant-numeric: tabular-nums; }
    .pr-chips { display: inline-flex; gap: .25rem; }
    .pr-presets { display: inline-flex; gap: .25rem; }
    .pr-chip { font-size: .74rem; padding: .2rem .5rem; border: 1px solid var(--border-color); background: transparent; color: var(--text-muted);
      border-radius: var(--r-sm, 8px); cursor: pointer; font-variant-numeric: tabular-nums; }
    .pr-chip:hover { background: var(--overlay-hover, var(--hover-bg)); color: var(--text-main); }
    .pr-chip-on { border-color: var(--action); color: var(--action); font-weight: 600; }
    .pr-table { font-size: .84rem; }
    .pr-r { text-align: right; font-variant-numeric: tabular-nums; }
    .pr-muted, .pr-muted-h { color: var(--text-muted); }
    .pr-prod { line-height: 1.2; }
    .pr-prod-meta { display: flex; align-items: center; gap: .4rem; margin-top: .1rem; }
    .pr-sku { font-family: var(--font-mono, ui-monospace, monospace); font-size: .7rem; color: var(--text-faint); }
    .pr-unit-btn { border: 0; background: transparent; padding: 0; cursor: pointer; }
    /* RA-PRO.44 — "En camino": chip accionable que abre las OCs abiertas del SKU. */
    .pr-tran-btn { display: inline-flex; align-items: center; gap: .25rem; font: inherit; font-size: .78rem;
      padding: .1rem .4rem; border: 1px solid var(--border-color); border-radius: var(--r-sm, 8px);
      background: transparent; color: var(--info-fg, var(--text-main)); cursor: pointer;
      font-variant-numeric: tabular-nums; }
    .pr-tran-btn:hover { background: var(--overlay-hover, var(--hover-bg)); border-color: var(--action); color: var(--action); }
    .pr-tran-btn:focus-visible { outline: none; border-color: var(--action); box-shadow: 0 0 0 2px var(--action-ring); }
    .pr-tran-btn i { font-size: .7rem; }
    /* RA-PRO.45 — por qué el pedido no descuenta todo lo que dice el papel. */
    .pr-tran-gap { display: flex; gap: .4rem; align-items: flex-start; font-size: .78rem; line-height: 1.45;
      margin: 0 0 1rem; padding: .5rem .65rem; border: 1px solid var(--border-color);
      border-left: 2px solid var(--warn-fg); border-radius: var(--r-sm, 8px);
      background: var(--surface-2, transparent); color: var(--text-muted); }
    .pr-tran-gap i { color: var(--warn-fg); margin-top: .12rem; }
    /* U.2 — el hueco del valuado, declarado. Mismo lenguaje visual que .pr-tran-gap (hairline +
       filete ámbar): es una advertencia de dato, no un error de la pantalla. */
    .pr-rung-banner { display: flex; gap: .5rem; align-items: flex-start; font-size: .8rem;
      line-height: 1.5; margin: 0 0 1rem; padding: .6rem .75rem;
      border: 1px solid var(--border-color); border-left: 2px solid var(--warn-fg);
      border-radius: var(--r-sm, 8px); background: var(--surface-2, transparent);
      color: var(--text-muted); }
    .pr-rung-banner i { color: var(--warn-fg); margin-top: .18rem; flex: none; }
    .pr-rung-banner p { margin: 0; max-width: 78ch; }
    .pr-rung-banner strong { color: var(--text-main); font-weight: 600; }
    /* La celda que no se puede convertir a cajas: muestra la cantidad SUELTA con su rótulo. */
    .pr-rung { display: inline-flex; align-items: baseline; gap: .25rem;
      font-family: var(--font-mono, ui-monospace); font-variant-numeric: tabular-nums;
      color: var(--warn-fg); cursor: help; }
    .pr-rung i { font-size: .68rem; }
    .pr-edad { font-variant-numeric: tabular-nums; color: var(--text-muted); }
    .pr-edad-warn { color: var(--warn-fg); font-weight: 600; }
    .pr-edad-bad { color: var(--bad-fg); font-weight: 600; }
    .pr-uov-prod { margin: 0 0 .5rem; }
    .pr-uov-hint { font-size: .78rem; color: var(--text-muted); margin: 0 0 1rem; line-height: 1.4; }
    .pr-uov-f { display: block; margin-bottom: .9rem; }
    .pr-uov-f > span { display: block; font-size: .8rem; font-weight: 600; margin-bottom: .25rem; }
    .pr-uov-f input { width: 100%; }
    .pr-uov-f small { display: block; font-size: .7rem; color: var(--text-muted); margin-top: .2rem; }
    .pr-uov-actions { display: flex; align-items: center; gap: .4rem; margin-top: .5rem; }
    :host ::ng-deep .pr-abc { font-size: .6rem; padding: .02rem .3rem; line-height: 1.3; }
    /* group header por sucursal */
    .pr-grp td { background: var(--overlay-hover, var(--hover-bg)); border-top: 1px solid var(--border-color); }
    .pr-grp-in { display: flex; align-items: center; gap: .6rem; padding: .15rem 0; }
    .pr-grp-name { font-weight: 700; color: var(--text-main); font-size: .82rem; }
    .pr-grp-name-btn { border: 0; background: transparent; padding: 0; cursor: pointer; text-align: left; }
    :host ::ng-deep .pr-grp-tog { color: var(--text-muted); width: 1.7rem; height: 1.7rem; padding: 0; }
    .pr-grp-n { font-size: .68rem; color: var(--text-faint); font-variant-numeric: tabular-nums; }
    .pr-exp-bar { display: flex; align-items: center; gap: .4rem; margin-bottom: .5rem; }
    .pr-exp-hint { font-size: .74rem; color: var(--text-muted); }
    .pr-grp-sub { display: inline-flex; gap: .5rem; font-size: .72rem; }
    .pr-gs { font-variant-numeric: tabular-nums; }
    .pr-gs-buy { color: var(--action); } .pr-gs-tr { color: var(--text-main); } .pr-gs-over { color: var(--warn-fg, var(--text-muted)); }
    .pr-grp-sp { flex: 1; }
    :host ::ng-deep .pr-grp-btn { --p-button-sm-font-size: .74rem; }
    .pr-link { color: var(--action); cursor: pointer; text-decoration: underline; }
    .pr-supp { color: var(--text-muted); font-size: .8rem; }
    .pr-mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .78rem; }
    .pr-strong { font-weight: 700; }
    .pr-sug { background: var(--overlay-selected, transparent); }
    .pr-val { color: var(--text-main); }
    .pr-over-val { color: var(--warn-fg, var(--text-muted)); }
    .pr-row-over td { color: var(--text-muted); }
    /* input de cantidad — estilo propio (ya no depende de pInputText; ver primeng#12522). */
    .pr-qty { width: 4.5rem; text-align: right; font-variant-numeric: tabular-nums; padding: .2rem .35rem;
      border: 1px solid var(--border-color); border-radius: var(--r-sm, 8px); background: var(--card-bg);
      color: var(--text-main); font-size: .84rem; font-family: inherit; }
    .pr-qty:focus { outline: none; border-color: var(--action); box-shadow: 0 0 0 2px var(--action-ring); }
    :host ::ng-deep .pr-cov-tag { font-variant-numeric: tabular-nums; }
    .pr-empty { text-align: center; color: var(--text-muted); padding: 2rem 1rem; }
    .pr-empty i { font-size: 1.6rem; display: block; margin-bottom: .5rem; color: var(--text-faint); }
    .pr-empty p { margin: 0 0 .25rem; font-weight: 600; color: var(--text-main); }
    .pr-empty span { font-size: .78rem; }
    .pr-state { display: flex; gap: .75rem; align-items: center; padding: 1.25rem; border: 1px solid var(--border-color); border-radius: var(--r-md, 12px); }
    .pr-error { color: var(--bad-fg); } .pr-error i { font-size: 1.4rem; } .pr-error p { margin: 0; color: var(--text-main); }
    .pr-foot { font-size: .72rem; color: var(--text-muted); margin-top: .5rem; }
    .pr-fresh { display: inline-flex; align-items: center; gap: .35rem; font-size: .72rem; color: var(--text-muted); margin: -.25rem 0 .6rem; }
    .pr-fresh i { font-size: .7rem; color: var(--text-faint); }
    .pr-bulk { position: sticky; bottom: 0; display: flex; align-items: center; gap: .5rem; margin-top: .75rem; padding: .6rem .9rem;
      background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md, 12px); box-shadow: var(--shadow-sm, 0 1px 3px rgba(0,0,0,.08)); }
    .pr-bulk-n { font-size: .84rem; color: var(--text-main); font-variant-numeric: tabular-nums; }
    .pr-bulk-sp { flex: 1; }
    /* RA-PRO.32 — vista Excel (workbook) */
    .pr-seg { display: inline-flex; gap: .15rem; border: 1px solid var(--border-color); border-radius: var(--r-md, 12px); padding: .15rem; }
    /* RA-PRO.32.1 — botón englobar/desglosar columnas por sucursal */
    .pr-colbtn { display: inline-flex; align-items: center; gap: .4rem; font-size: .78rem; padding: .4rem .75rem; border: 1px solid var(--border-color);
      background: var(--card-bg); color: var(--text-muted); border-radius: var(--r-sm, 8px); cursor: pointer; font-family: inherit; }
    .pr-colbtn:hover { background: var(--overlay-hover, var(--hover-bg)); color: var(--text-main); }
    .pr-colbtn-on { border-color: var(--action); color: var(--action); font-weight: 600; }
    .pr-colbtn i { font-size: .8rem; }
    .pr-wb-scroll { overflow-x: auto; }
    :host ::ng-deep .pr-wb { font-size: .8rem; }
    :host ::ng-deep .pr-wb th.pr-grp-h { text-align: center; border-left: 1px solid var(--border-color); font-size: .68rem; text-transform: uppercase; letter-spacing: .05em; color: var(--text-muted); font-weight: 700; }
    :host ::ng-deep .pr-wb th.pr-sub-h { font-size: .66rem; font-weight: 600; color: var(--text-faint); }
    :host ::ng-deep .pr-wb th.pr-ped-h { color: var(--action); }
    .pr-ped { font-variant-numeric: tabular-nums; }
    .pr-ped-on { color: var(--action); font-weight: 600; }
    .pr-uxc { line-height: 1.15; }
    .pr-unit { font-size: .6rem; color: var(--text-faint); }
    .pr-unit2 { font-size: .62rem; color: var(--info-fg, var(--text-muted)); }
    :host ::ng-deep .pr-wb .pr-wb-row { cursor: pointer; }
    :host ::ng-deep .pr-wb .pr-wb-row:hover td { background: var(--overlay-hover, var(--hover-bg)); }
    :host ::ng-deep .pr-wb .pr-wb-open td { background: var(--overlay-selected, var(--hover-bg)); }
    :host ::ng-deep .pr-wb .pr-wb-open td:first-child { box-shadow: inset 3px 0 0 var(--action); }
    .pr-wb-go { font-size: .7rem; color: var(--text-faint); margin-right: .1rem; }
    /* Producto congelado al scrollear horizontal (columna 1 sticky, patrón existencia-crítica) */
    :host ::ng-deep .pr-wb thead tr:first-child th:first-child,
    :host ::ng-deep .pr-wb tbody td:first-child { position: sticky; left: 0; z-index: 2; background: var(--card-bg); }
    :host ::ng-deep .pr-wb thead tr:first-child th:first-child { z-index: 3; }
    :host ::ng-deep .pr-wb .pr-wb-row:hover td:first-child { background: var(--overlay-hover, var(--hover-bg)); }
    :host ::ng-deep .pr-wb .pr-wb-open td:first-child { background: var(--overlay-selected, var(--hover-bg)); }
    /* RA-PRO.32.1 — fila expandida (acordeón): desglose por sucursal accionable inline */
    :host ::ng-deep .pr-wb .pr-wb-exp > td { padding: 0; background: var(--card-bg); border-bottom: 2px solid var(--border-color); }
    .pr-exp-in { padding: .85rem 1rem 1rem 1.75rem; border-left: 3px solid var(--action); }
    .pr-exp-actions { display: flex; align-items: center; gap: .5rem; margin-top: .6rem; padding-top: .6rem; border-top: 1px solid var(--border-color); }
    .pr-exp-sum { font-size: .8rem; color: var(--text-muted); font-variant-numeric: tabular-nums; display: inline-flex; gap: .35rem; flex-wrap: wrap; }
    .pr-qty-sm { width: 4rem; padding: .15rem .3rem; font-size: .8rem; }
    .pr-det-tbl td { vertical-align: middle; }
    /* El desglose NO se estira. Vive dentro de un td que abarca las 15 columnas de la tabla de
       arriba (~82rem), y con width:100% sus 8 columnas cortas quedaban repartidas en todo ese
       ancho, con huecos enormes entre dato y dato. Con width:auto la tabla mide lo que mide su
       contenido y queda pegada a la izquierda, que es lo que se pidió. Las cifras siguen
       alineadas a la derecha DENTRO de su columna: es lo que deja comparar una sobre otra. */
    .pr-det-tbl { width: auto; }
    .pr-det-tbl th, .pr-det-tbl td { white-space: nowrap; }
    .pr-det-tbl th:first-child, .pr-det-tbl td:first-child { padding-right: 1.2rem; }
    /* RA-PRO.47 — encabezado y cejitas del desglose por sucursal */
    .pr-det-head { display: flex; align-items: baseline; gap: .5rem; flex-wrap: wrap; margin-bottom: .5rem; }
    .pr-det-sku { font-size: .75rem; color: var(--text-muted); }
    .pr-det-name { font-size: .9rem; color: var(--text-main); letter-spacing: -.01em; }
    .pr-det-uxc { font-size: .68rem; color: var(--text-faint); font-variant-numeric: tabular-nums; margin-left: auto; }
    .pr-det-tabs { display: inline-flex; gap: .15rem; border: 1px solid var(--border-color); border-radius: var(--r-md, 12px); padding: .15rem; margin-bottom: .6rem; }
    .pr-det-tabs .pr-tab { display: inline-flex; align-items: center; gap: .35rem; }
    .pr-tab-n { font-family: var(--font-mono, ui-monospace, monospace); font-size: .62rem; padding: 0 .3rem; border-radius: var(--r-pill, 999px);
      background: var(--overlay-hover, var(--hover-bg)); color: var(--text-muted); }
    .pr-tab-on .pr-tab-n { background: var(--action); color: var(--action-fg, #fff); }
    /* selector de unidad de captura POR RENGLÓN (cajas / piezas) */
    .pr-uu { display: inline-flex; border: 1px solid var(--border-color); border-radius: var(--r-sm, 8px); overflow: hidden; }
    .pr-uu-b { font-family: var(--font-mono, ui-monospace, monospace); font-size: .68rem; line-height: 1; padding: .25rem .4rem; border: 0;
      background: transparent; color: var(--text-muted); cursor: pointer; }
    .pr-uu-b + .pr-uu-b { border-left: 1px solid var(--border-color); }
    .pr-uu-b:hover { background: var(--overlay-hover, var(--hover-bg)); color: var(--text-main); }
    .pr-uu-on { background: var(--action); color: var(--action-fg, #fff); font-weight: 700; }
    .pr-uu-on:hover { background: var(--action); color: var(--action-fg, #fff); }
    .pr-uu-b:focus-visible { outline: 2px solid var(--action); outline-offset: -2px; }
    .pr-uu-b:disabled { opacity: .4; cursor: not-allowed; }
    /* RA-PRO.48 — encabezado de ZONA dentro del desglose */
    .pr-zrow > td { background: var(--overlay-hover, var(--hover-bg)); padding: .3rem .5rem !important; border-top: 1px solid var(--border-color); }
    .pr-zname { font-size: .7rem; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--text-main); }
    .pr-zhub { font-size: .68rem; color: var(--text-muted); margin-left: .5rem; }
    .pr-zlink { font-size: .66rem; border: 0; background: transparent; color: var(--action); cursor: pointer; padding: .1rem .3rem; border-radius: var(--r-sm, 8px); }
    .pr-zlink:hover { background: var(--card-bg); text-decoration: underline; }
    /* control de entrega + selector de CEDIS */
    .pr-ent { white-space: nowrap; }
    .pr-cedis { margin-left: .35rem; font-size: .7rem; padding: .15rem .25rem; max-width: 15rem;
      border: 1px solid var(--border-color); border-radius: var(--r-sm, 8px); background: var(--card-bg); color: var(--text-main); }
    /* ACUSE de entregas */
    .pr-entregas { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; margin-top: .5rem; padding: .4rem .55rem;
      border: 1px dashed var(--border-color); border-radius: var(--r-md, 12px); background: var(--overlay-hover, var(--hover-bg)); }
    .pr-ent-lbl { font-size: .66rem; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--text-muted); }
    .pr-ent-chip { display: inline-flex; align-items: center; gap: .3rem; font-size: .72rem; color: var(--text-main);
      background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-pill, 999px); padding: .1rem .5rem; font-variant-numeric: tabular-nums; }
    .pr-ent-chip i { font-size: .68rem; color: var(--action); }
    .pr-ent-chip b { font-weight: 700; }
    .pr-ent-chip em { font-style: normal; font-size: .64rem; color: var(--text-faint); text-transform: uppercase; letter-spacing: .04em; }
    .pr-ent-dir { border-style: dashed; }
    .pr-ent-warn { display: inline-flex; align-items: center; gap: .3rem; font-size: .68rem; color: var(--warn-fg, var(--text-muted)); }
    .pr-ordu { display: flex; align-items: center; gap: .35rem; flex-wrap: wrap; margin: .1rem 0 .6rem; }
    .pr-ordu-lbl { font-size: .72rem; color: var(--text-muted); font-weight: 600; }
    .pr-ordu-hint { font-size: .68rem; color: var(--text-faint); margin-left: .4rem; font-variant-numeric: tabular-nums; }
    .pr-det-act { display: flex; align-items: center; gap: .3rem; flex-wrap: wrap; }
    .pr-from { color: var(--info-fg, var(--text-muted)); font-size: .72rem; }
    .pr-peek-loading { color: var(--text-muted); padding: 1rem 0; }
    .pr-peek-econ { display: grid; grid-template-columns: repeat(2, 1fr); gap: .6rem 1rem; margin-bottom: 1.25rem; }
    .pr-peek-stat { display: flex; flex-direction: column; gap: .1rem; }
    .pr-peek-stat span { font-size: .66rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: .04em; }
    .pr-peek-stat strong { font-size: .9rem; color: var(--text-main); font-variant-numeric: tabular-nums; }
    .pr-peek-h { font-size: .8rem; font-weight: 700; margin: 0 0 .5rem; color: var(--text-main); }
    .pr-peek-tbl { width: 100%; border-collapse: collapse; font-size: .8rem; }
    .pr-peek-tbl th { text-align: left; font-size: .64rem; text-transform: uppercase; letter-spacing: .04em; color: var(--text-faint); font-weight: 600; padding: .3rem .4rem; border-bottom: 1px solid var(--border-color); }
    .pr-peek-tbl td { padding: .35rem .4rem; border-bottom: 1px solid var(--border-color); }
    .pr-peek-terr { font-size: .7rem; color: var(--text-muted); }
    .pr-peek-note { font-size: .7rem; color: var(--text-muted); margin-top: .75rem; line-height: 1.4; }
  `],
})
export class ComprasPedidoRealComponent implements OnInit, HasUnsavedChanges {
  private readonly api = inject(ComprasService);
  private readonly route = inject(ActivatedRoute); // Q.4 — deep-link desde Existencia
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  // P2 — cantidades editadas sin armar requisición = trabajo volátil. dirty protege contra
  // navegación interna (unsavedChangesGuard) + salida externa (beforeunload).
  private readonly dirty = signal(false);
  onQtyEdit(): void { this.dirty.set(true); this.tick(); }
  hasUnsavedChanges(): boolean { return this.dirty(); }
  @HostListener('window:beforeunload', ['$event'])
  onBeforeUnload(e: BeforeUnloadEvent): void { if (this.dirty()) e.preventDefault(); }

  // P2 — frescura del dato (el pedido se calcula sobre feeds que pueden estar stale).
  readonly loadedAt = signal<number | null>(null);
  private readonly nowTick = signal(Date.now());
  readonly freshLabel = computed(() => {
    const t = this.loadedAt(); if (!t) return '';
    const mins = Math.floor((this.nowTick() - t) / 60000);
    return mins < 1 ? 'recién' : mins < 60 ? `hace ${mins} min` : `hace ${Math.floor(mins / 60)} h`;
  });

  private readonly buyRows = signal<PurchaseSuggestionRow[]>([]);
  private readonly trRows = signal<TransferSuggestionRow[]>([]);
  private readonly ovRows = signal<OverstockRow[]>([]);
  private readonly urows = signal<URow[]>([]);       // modelo unificado (qty editable vive aquí)
  private readonly tickN = signal(0);                 // fuerza recompute de subtotales al editar qty

  deadRows = signal<DeadStockRow[]>([]);
  loading = signal(false);
  error = signal(false);
  dl = signal(false);
  saving = signal(false);
  mode = signal<Mode>('pedido');
  deadValue = signal(0);

  // RA-PRO.32 — Vista Excel (réplica del workbook del comprador, una fila por SKU × punto de compra).
  wbRows = signal<WorkbookRow[]>([]);
  wbTotals = signal<{ pedido: number; venta: number; exis: number }>({ pedido: 0, venta: 0, exis: 0 });
  // U.2 — el hueco del valuado. null cuando no hay nada sin verificar (el banner no se pinta).
  private readonly wbRung = signal<{ skus: number; celdas: number; arbitrado: number } | null>(null);
  rungGap(): { skus: number; celdas: number; arbitrado: number } | null {
    const g = this.wbRung();
    return g && g.skus > 0 ? g : null;
  }
  wbTotal = signal(0);
  // RA-PRO.36.2 — paginación SERVER-SIDE (20/página): la matriz pedía 1000 filas + 3 motores en
  // paralelo → saturaba Railway. Ahora trae solo la página; los filtros (pedido/IAD/sobrestock) van
  // server-side para filtrar TODO el dataset, no la página cargada.
  readonly wbFirst = signal(0);
  readonly wbPageSize = signal(20);
  wbScopeNeeded = signal(false);
  wbOnlyOver = signal(false);   // RA-PRO.33 — filtrar a productos CON sobrestock (capital inmovilizado)
  wbWarehouses: string[] = [];                          // sucursales elegidas (vacío = todas con stock)
  // RA-PRO.47 — las sucursales ya NO son columnas (bajaron al desglose), así que el ancho es fijo
  // y la tabla tiene un solo renglón de encabezado. Ref estable → evita ExpressionChanged.
  readonly wbTableStyle = { 'min-width': '82rem' };
  /** Producto · Ud/caja · Costo · Tend. · Est. · Exist. red · XYZ · En camino · Reorden · Máx
   *  · Σ Ped. · Σ Piezas · $ Pedido · Valor venta · Valor exist. */
  readonly wbColCount = 15;


  // ── RA-PRO.47 — DESGLOSE POR SUCURSAL (el acordeón) ──────────────────
  // Las sucursales dejaron de ser columnas y bajaron acá. El dato es el MISMO que alimentaba esas
  // columnas (`r.cells`), así que no cuesta un request extra y la tabla de arriba no puede
  // contradecir al desglose: los totales del renglón son la suma de estos renglones.

  /** Renglones de compra por sucursal, por producto. Se rearma sólo cuando cambia la página. */
  private readonly branchBuyMap = computed(() => {
    const names = this.whName();
    const meta = this.whMeta();
    const m = new Map<string, BranchBuy[]>();
    for (const r of this.wbRows()) {
      const out: BranchBuy[] = [];
      for (const [code, c] of Object.entries(r.cells ?? {})) {
        if (code === 'GENERAL') continue;   // defensivo: el agregado de red no es una sucursal
        out.push({
          code, name: names.get(code) || '',
          vta: Number(c.vta) || 0,
          exis: Number(c.exis) || 0,
          seed: Number(c.ped) || 0,
          // Sin costo por celda (feed viejo) se cae al del producto, que es el `max` entre
          // almacenes: sobrevalúa, pero es lo que ya publicaba la pantalla. No se inventa 0.
          cc: Number(c.cc ?? r.caja_cost) || 0,
          rung: c.rung ?? null,
          nat: Number(c.nat) || 0,
          natu: this.natLabel(c.natu),
          natuRaw: (c.natu || '').trim(),
          hub: !!meta.get(code)?.hub,
        });
      }
      // "Por orden de mayor venta". Con el feed de ventas caído la venta es 0 en todas, así que
      // desempata por existencia y después por código: el orden queda estable, nunca al azar.
      out.sort((a, b) => b.vta - a.vta || b.exis - a.exis || a.code.localeCompare(b.code));
      m.set(r.product_id, out);
    }
    return m;
  });
  branchBuys(r: WorkbookRow): BranchBuy[] { return this.branchBuyMap().get(r.product_id) ?? []; }

  /**
   * Rótulo de la unidad nativa, para la celda.
   *
   * ⚠️ 65 de las 552 celdas marcadas traen un rótulo que es un NÚMERO ('500', '250'): Kepler ahí
   * no guarda el nombre de la unidad sino el GRAMAJE de la bolsa. Concatenarlo sin más daba
   * "298 500", que no se lee como nada. En ese caso la cantidad va con "u" y el gramaje queda en
   * el tooltip, que es donde cabe la explicación completa.
   */
  private natLabel(raw: string | undefined): string {
    const v = (raw || '').trim();
    if (!v) return 'u';
    return /^[\d.]+$/.test(v) ? 'u' : v.toLowerCase();
  }
  bRungTitle(b: BranchBuy): string {
    // Acá sí entra el gramaje completo: el tooltip tiene lugar para decir "unidades de 500".
    const u = /^[\d.]+$/.test(b.natuRaw) ? `unidades de ${b.natuRaw}` : b.natu;
    const dir = b.rung === 'x1_inflada'
      ? 'el divisor de cajas es más chico de lo que el costo justifica (la valuación saldría inflada)'
      : 'el divisor de cajas es más grande de lo que el costo justifica (la valuación saldría corta)';
    return `No se puede convertir a cajas ni pedir acá: ${dir}. Lo que sí es verdad: hay `
      + `${b.nat.toLocaleString('es-MX')} ${u} en este almacén. Restar demanda − existencia `
      + 'mezclaría peldaños y el sugerido saldría mal. Se compara el divisor contra lo que se pagó '
      + 'por unidad de stock; el detalle está en la bandeja de hallazgos.';
  }

  /** Existencia de RED en cajas = Σ de las sucursales con el peldaño verificado (U.2). */
  exisRed(r: WorkbookRow): number {
    return this.branchBuys(r).reduce((s, b) => s + (b.rung ? 0 : b.exis), 0);
  }
  exisRedTitle(r: WorkbookRow): string {
    const n = r.almacenes_sin_valuar || 0;
    if (!n) return 'Existencia sumada de todas las sucursales, en cajas. El desglose está al abrir la fila.';
    return `Suma sólo las sucursales con el peldaño de unidad verificado. ${n} `
      + `${n === 1 ? 'almacén queda' : 'almacenes quedan'} fuera porque su divisor de cajas no cuadra `
      + 'con lo que se pagó: ahí la existencia se muestra en su unidad suelta, dentro del desglose.';
  }

  // ── cantidad editable POR SUCURSAL ───────────────────────────────────
  // Canónico = CAJAS, siempre. El selector cj/pz del renglón sólo cambia cómo se escribe: los días
  // de inventario y el valor se calculan con las cajas, así que nunca se mezclan unidades.
  private readonly buyQty = signal<Record<string, number>>({});                  // 'pid|code' → CAJAS
  private readonly buyUnit = signal<Record<string, 'caja' | 'pieza'>>({});
  private bk(pid: string, code: string): string { return pid + '|' + code; }

  /** Cantidad en CAJAS: lo que el usuario escribió, o el sugerido del motor si no tocó nada. */
  qtyOf(r: WorkbookRow, b: BranchBuy): number {
    if (b.rung) return 0;
    const ov = this.buyQty()[this.bk(r.product_id, b.code)];
    return ov === undefined ? b.seed : ov;
  }
  unitOfBranch(r: WorkbookRow, b: BranchBuy): 'caja' | 'pieza' {
    return this.buyUnit()[this.bk(r.product_id, b.code)] ?? 'caja';
  }
  setUnitBranch(r: WorkbookRow, b: BranchBuy, u: 'caja' | 'pieza'): void {
    this.buyUnit.update((m) => ({ ...m, [this.bk(r.product_id, b.code)]: u }));
  }
  /** Factor cajas → unidad de captura del renglón. */
  private bFactor(r: WorkbookRow, b: BranchBuy): number {
    return this.unitOfBranch(r, b) === 'pieza' ? (Number(r.uxc) || 1) : 1;
  }
  dispOf(r: WorkbookRow, b: BranchBuy): number { return this.qtyOf(r, b) * this.bFactor(r, b); }
  setDispOf(r: WorkbookRow, b: BranchBuy, v: number | string): void {
    const cajas = Math.max(0, Number(v) || 0) / (this.bFactor(r, b) || 1);
    this.buyQty.update((m) => ({ ...m, [this.bk(r.product_id, b.code)]: cajas }));
    this.dirty.set(true);
  }

  /**
   * Días de inventario con lo que se pida: (existencia + pedido) ÷ (venta 30 d ÷ 30.4).
   * 30.4 es el convenio de días del mes que ya usa el comprador en su Excel.
   * Sin venta NO hay cobertura que calcular → null, que la pantalla pinta "—". Un 0 se leería
   * "urge" y un número enorme se leería "sobra"; las dos serían mentira.
   */
  diasInv(r: WorkbookRow, b: BranchBuy): number | null {
    if (b.rung || !(b.vta > 0)) return null;
    return (b.exis + this.qtyOf(r, b)) * 30.4 / b.vta;
  }
  diasLabel(d: number | null): string {
    if (d == null) return '—';
    return d >= 999 ? '+999 d' : `${Math.round(d)} d`;
  }
  diasTitle(r: WorkbookRow, b: BranchBuy): string {
    if (b.rung) return 'No se puede calcular: el peldaño de unidad de este almacén no está verificado.';
    if (!(b.vta > 0)) return 'Sin venta en los últimos 30 días en esta sucursal: no hay cobertura que calcular.';
    const q = this.qtyOf(r, b);
    return `(${b.exis.toFixed(1)} de existencia + ${q.toFixed(1)} de pedido) ÷ (${b.vta.toFixed(1)} de venta 30 d ÷ 30.4 días)`;
  }

  // ── totales del renglón de producto (los de arriba) ──────────────────
  // Son la SUMA VIVA del desglose: es lo que hace que la columna Σ Ped. y el $ Pedido digan lo
  // mismo que se va a ordenar. Antes venían del servidor y no se movían al editar.
  sumCajas(r: WorkbookRow): number { return this.branchBuys(r).reduce((s, b) => s + this.qtyOf(r, b), 0); }
  sumPiezas(r: WorkbookRow): number { return this.sumCajas(r) * (Number(r.uxc) || 1); }
  sumValor(r: WorkbookRow): number { return this.branchBuys(r).reduce((s, b) => s + this.qtyOf(r, b) * b.cc, 0); }

  // ── cejitas del desglose ─────────────────────────────────────────────
  private readonly detTab = signal<Record<string, 'buy' | 'tr'>>({});
  tabOf(pid: string): 'buy' | 'tr' { return this.detTab()[pid] ?? 'buy'; }
  setTab(pid: string, t: 'buy' | 'tr'): void { this.detTab.update((m) => ({ ...m, [pid]: t })); }
  /** Sólo los traspasos del producto (la cejita de traspasos queda como estaba). */
  trasRows(pid: string): URow[] { return this.detailRows(pid).filter((u) => u.type === 'traspaso'); }

  /** code → warehouse_id, para armar la requisición desde las celdas (que vienen por código). */
  private readonly whIdByCode = computed(() => {
    const m = new Map<string, string>();
    for (const w of this.filters()?.warehouses ?? []) m.set(w.code, w.id);
    return m;
  });

  // ── RA-PRO.48 — ZONA DE COMPRA y ENTREGA (directo a la sucursal vs consolidado en un CEDIS) ──
  // La zona y la bandera de CEDIS salen de la TABLA (`purchase_zone` / `is_purchase_hub`, mig
  // 20260910120000), no de un mapa de códigos acá: dar de alta un almacén o mover el CEDIS de una
  // zona tiene que ser editar un dato, no tocar y desplegar código. Es la regla que el propio
  // workbook declara ("Cero códigos hardcodeados").

  /** Metadatos por código de almacén: nombre, zona de compra, si es CEDIS y su orden. */
  private readonly whMeta = computed(() => {
    const m = new Map<string, { name: string; zone: string; hub: boolean; order: number }>();
    for (const w of this.filters()?.warehouses ?? []) {
      m.set(w.code, {
        name: w.name,
        zone: (w.purchase_zone || '').trim() || 'Sin zona',
        hub: !!w.is_purchase_hub,
        order: w.display_order == null ? 98 : Number(w.display_order),
      });
    }
    return m;
  });
  /** Los CEDIS donde se puede consolidar una compra, en el orden en que se muestran los almacenes. */
  readonly cedisList = computed(() => (this.filters()?.warehouses ?? [])
    .filter((w) => w.is_purchase_hub)
    .map((w) => ({ code: w.code, name: w.name, order: w.display_order == null ? 98 : Number(w.display_order) }))
    .sort((a, b) => a.order - b.order || a.code.localeCompare(b.code)));
  /** El CEDIS de una zona (el almacén marcado como hub dentro de ella). */
  private hubOfZone(zone: string): { code: string; name: string; order: number } | null {
    for (const w of this.filters()?.warehouses ?? []) {
      if (w.is_purchase_hub && ((w.purchase_zone || '').trim() || 'Sin zona') === zone) {
        return { code: w.code, name: w.name, order: w.display_order == null ? 98 : Number(w.display_order) };
      }
    }
    return null;
  }

  /**
   * Los renglones del producto, agrupados por ZONA. Dentro de cada zona siguen ordenados por venta
   * (la regla del desglose); las zonas se ordenan por el `display_order` de su CEDIS — así, mover
   * una zona de lugar es editar ese campo desde el admin, sin tocar esto.
   */
  private readonly branchZoneMap = computed(() => {
    const meta = this.whMeta();
    const m = new Map<string, ZoneGroup[]>();
    for (const [pid, rows] of this.branchBuyMap()) {
      const byZone = new Map<string, BranchBuy[]>();
      for (const b of rows) {
        const z = meta.get(b.code)?.zone || 'Sin zona';
        const arr = byZone.get(z); if (arr) arr.push(b); else byZone.set(z, [b]);
      }
      const out: ZoneGroup[] = [];
      for (const [zone, rs] of byZone) {
        const hub = this.hubOfZone(zone);
        out.push({ zone, hubCode: hub?.code ?? null, hubName: hub?.name ?? '', order: hub?.order ?? 99, rows: rs });
      }
      out.sort((a, b) => a.order - b.order || a.zone.localeCompare(b.zone));
      m.set(pid, out);
    }
    return m;
  });
  branchZones(r: WorkbookRow): ZoneGroup[] { return this.branchZoneMap().get(r.product_id) ?? []; }
  /**
   * ¿Vale la pena pintar los encabezados de zona? Si la migración 20260910120000 todavía no corrió,
   * ningún almacén trae `purchase_zone` y TODO cae en "Sin zona": un encabezado único que no agrupa
   * nada y encima se lee como si la pantalla estuviera rota. En ese caso no se pinta y la tabla
   * queda como estaba, ordenada por venta.
   */
  showZones(r: WorkbookRow): boolean {
    const zs = this.branchZones(r);
    return zs.length > 1 || (zs.length === 1 && zs[0].zone !== 'Sin zona');
  }

  /**
   * Dónde se entrega cada renglón. `null` (el default) = el proveedor entrega DIRECTO en la
   * sucursal. Un código = la compra se CONSOLIDA en ese CEDIS y después baja por traspaso.
   */
  private readonly buyDeliver = signal<Record<string, string | null>>({});
  deliverOf(r: WorkbookRow, b: BranchBuy): string | null { return this.buyDeliver()[this.bk(r.product_id, b.code)] ?? null; }
  isConsolidated(r: WorkbookRow, b: BranchBuy): boolean { return !!this.deliverOf(r, b); }
  private setDeliver(r: WorkbookRow, b: BranchBuy, code: string | null): void {
    this.buyDeliver.update((m) => ({ ...m, [this.bk(r.product_id, b.code)]: code }));
    this.dirty.set(true);
  }
  setDirect(r: WorkbookRow, b: BranchBuy): void { this.setDeliver(r, b, null); }
  /** Al marcar Consolidado se propone el CEDIS de SU zona; si esa sucursal ya es el CEDIS, el primero que no sea ella. */
  setConsolidated(r: WorkbookRow, b: BranchBuy): void {
    if (this.isConsolidated(r, b)) return;
    const zone = this.whMeta().get(b.code)?.zone ?? 'Sin zona';
    const hub = this.hubOfZone(zone);
    const target = hub && hub.code !== b.code ? hub.code : (this.cedisFor(b)[0]?.code ?? null);
    if (target) this.setDeliver(r, b, target);
  }
  setDeliverTo(r: WorkbookRow, b: BranchBuy, code: string): void { this.setDeliver(r, b, code || null); }
  /** Atajos de zona: con 4 sucursales por zona, marcar una por una es trabajo de más. */
  zoneAllDirect(r: WorkbookRow, z: ZoneGroup): void {
    this.buyDeliver.update((m) => {
      const n = { ...m }; for (const b of z.rows) n[this.bk(r.product_id, b.code)] = null; return n;
    });
    this.dirty.set(true);
  }
  zoneAllToHub(r: WorkbookRow, z: ZoneGroup): void {
    if (!z.hubCode) return;
    this.buyDeliver.update((m) => {
      const n = { ...m };
      // La sucursal que ES el CEDIS no se consolida en sí misma: se queda directa.
      for (const b of z.rows) n[this.bk(r.product_id, b.code)] = b.code === z.hubCode ? null : z.hubCode;
      return n;
    });
    this.dirty.set(true);
  }
  /** CEDIS elegibles para este renglón: todos menos él mismo (consolidarse en sí mismo no es nada). */
  cedisFor(b: BranchBuy): { code: string; name: string }[] { return this.cedisList().filter((cd) => cd.code !== b.code); }
  /**
   * Nombre del CEDIS para la cortinilla. El almacén de Morelia se llama `Almacén Morelia Abastos
   * (30)` en la tabla: dentro de un desplegable angosto ese prefijo y ese sufijo son ruido que
   * empuja fuera lo único que se lee ("Morelia Abastos"). Se recortan SOLO para mostrar; el nombre
   * real no se toca en ningún lado.
   */
  cedisLabel(name: string): string {
    return (name || '').replace(/^Almac[eé]n\s+/i, '').replace(/\s*\(\d+\)\s*$/, '').trim() || name;
  }
  deliverTitle(r: WorkbookRow, b: BranchBuy): string {
    const to = this.deliverOf(r, b);
    if (!to) return 'El proveedor entrega directo en esta sucursal. No genera traspaso.';
    return `La compra se entrega en ${to} ${this.nameOf(to)}. Al armar la requisición se genera además `
      + `un traspaso ${to} → ${b.code} por esa misma cantidad.`;
  }

  /**
   * ACUSE DE ENTREGA — el punto de la pantalla. La palomita dice qué marcaste; esto dice qué se le
   * va a pedir al proveedor: cuánto llega a cada CEDIS y cuánto va directo a cada sucursal.
   */
  entregas(r: WorkbookRow): Entrega[] {
    const m = new Map<string, Entrega>();
    for (const b of this.branchBuys(r)) {
      const q = this.qtyOf(r, b);
      if (!(q > 0)) continue;
      const to = this.deliverOf(r, b);
      const code = to ?? b.code;
      const e = m.get(code) ?? { code, name: to ? this.nameOf(to) : b.name, direct: !to, cajas: 0, valor: 0 };
      // Un mismo CEDIS puede recibir de varias sucursales: si alguna es directa y otra consolidada
      // sobre el mismo código, manda "consolidado" (es el caso del renglón que ES el CEDIS).
      if (to) e.direct = false;
      e.cajas += q; e.valor += q * b.cc;
      m.set(code, e);
    }
    return [...m.values()].sort((a, b) => Number(a.direct) - Number(b.direct) || b.valor - a.valor);
  }
  /** Cuántos traspasos CEDIS→sucursal va a generar este producto. Se avisa ANTES de armar. */
  traspasosGenerados(r: WorkbookRow): number {
    return this.branchBuys(r).filter((b) => {
      const to = this.deliverOf(r, b);
      return !!to && to !== b.code && this.qtyOf(r, b) > 0;
    }).length;
  }

  /** U.2 — por qué el pedido de red puede venir corto: hay almacenes que no se pudieron calcular. */
  pedidoTitle(r: WorkbookRow): string {
    const n = r.almacenes_sin_pedido || 0;
    if (!n) return '';
    return `Este total NO incluye ${n} almacén${n > 1 ? 'es' : ''}: ahí el costo de compra contradice `
      + 'el divisor con el que se lee la existencia, así que restar demanda − existencia mezclaría '
      + 'peldaños y el sugerido saldría mal. Falta pedido, no es que no haga falta comprar.';
  }
  valorExisTitle(r: WorkbookRow): string {
    if (!r.almacenes_sin_valuar) return 'Dinero inmovilizado en existencia: existencia × costo de caja.';
    const n = r.almacenes_sin_valuar;
    const arb = r.valor_exis_arbitrado
      ? ` Contra lo pagado rondarían ${this.money(r.valor_exis_arbitrado)}, pero es una referencia `
        + 'para revisar, no una cifra publicable.'
      : '';
    return `${n} ${n === 1 ? 'almacén' : 'almacenes'} con el peldaño de unidad sin verificar: su `
      + `existencia NO se valúa acá para no publicar un número que el costo contradice.${arb}`;
  }
  /** ABC por producto (del motor por-sucursal) → etiqueta en el renglón del Excel. */
  private readonly abcMap = computed(() => {
    const m = new Map<string, string>();
    for (const u of this.urows()) if (u.abc_class && !m.has(u.product_id)) m.set(u.product_id, u.abc_class);
    return m;
  });
  abcOf(pid: string): string | null { return this.abcMap().get(pid) ?? null; }
  /**
   * RA-PRO.47 — el override de unidad (RA-PRO.28) es POR PRODUCTO, así que su botón sube al
   * renglón del producto. Antes colgaba de los renglones de compra del desglose, que eran de grano
   * red: al bajar el desglose a sucursales el diálogo se habría quedado sin puerta de entrada.
   */
  private readonly unitRefMap = computed(() => {
    const m = new Map<string, PurchaseSuggestionRow>();
    for (const u of this.urows()) {
      if (u.type !== 'comprar' || !u.buy) continue;
      const src = u.unit_source;
      if (!src || src === 'catalog') continue;
      if (!m.has(u.product_id)) m.set(u.product_id, u.buy);
    }
    return m;
  });
  unitRefOf(pid: string): PurchaseSuggestionRow | null { return this.unitRefMap().get(pid) ?? null; }
  // RA-PRO.33 — unidades: pz/caja (uxc) + paquete (solo multipacks). Map product_id → {uxc, pack, packs}.
  private readonly packByProduct = computed(() => {
    const m = new Map<string, { uxc: number; pack: number | null; packs: number | null }>();
    for (const r of this.wbRows()) m.set(r.product_id, { uxc: Number(r.uxc) || 1, pack: r.pack_size ?? null, packs: r.packs_per_box ?? null });
    return m;
  });
  packOf(pid: string): { uxc: number; pack: number | null; packs: number | null } | null { return this.packByProduct().get(pid) ?? null; }

  // RA-PRO.33 — unidad de PEDIDO por producto (caja/paquete/pieza). Canónico interno = CAJAS (u.qty);
  // el input muestra/edita en la unidad elegida y convierte. paquete solo si el producto es multipack.
  readonly orderUnit = signal<Record<string, 'caja' | 'paquete' | 'pieza'>>({});
  unitOf(pid: string): 'caja' | 'paquete' | 'pieza' { return this.orderUnit()[pid] ?? 'caja'; }
  setUnit(pid: string, u: 'caja' | 'paquete' | 'pieza'): void { this.orderUnit.update((m) => ({ ...m, [pid]: u })); }
  unitLabelShort(pid: string): string { const u = this.unitOf(pid); return u === 'pieza' ? 'pz' : u === 'paquete' ? 'paq' : 'caja'; }
  /**
   * RA-PRO.46 — el rótulo de la unidad base LO DICE KEPLER (`kdii.c11`), no lo escribimos nosotros.
   * Antes acá decía "pz" fijo y mentía en todo lo que se vende a granel: el azúcar 99029 se mide en
   * 500 g (rótulo `500`), no en piezas. Sin dato, se muestra "u" — genérico honesto, no "pz" falso.
   */
  unidadBase(r: WorkbookRow): string { return (r.unidad_base || '').trim().toLowerCase() || 'u'; }
  unidadTitle(r: WorkbookRow): string {
    const u = (r.unidad_base || '').trim();
    return u ? `${r.uxc} ${u} por caja (unidad declarada en Kepler)` : `${r.uxc} unidades por caja — Kepler no declara la unidad`;
  }
  /**
   * ADR-055 — la existencia se muestra en CAJAS (la unidad más grande), y el tooltip declara la
   * cantidad suelta con el rótulo que da el ERP dueño del almacén: la unidad base de Kepler en las
   * sucursales, la unidad de venta de Wincaja en MD-30/MD-32/00 (que es el PAQUETE en los
   * multipack). Sin factor de caja la celda ya viene igual a la cantidad suelta.
   */
  deadUnitsTitle(r: { on_hand: number; box_factor?: number; base_label?: string }): string {
    const bf = Number(r.box_factor) || 1;
    const u = (r.base_label || '').trim() || 'u';
    const n = Math.round(Number(r.on_hand) || 0).toLocaleString('es-MX');
    return bf > 1 ? `${n} ${u} sueltas · ${bf} ${u} por caja` : `${n} ${u} — sin factor de caja`;
  }
  /** Factor cajas→unidad elegida: pieza=uxc(pz/caja), paquete=packs/caja, caja=1. */
  unitFactor(pid: string): number {
    const u = this.unitOf(pid), p = this.packOf(pid);
    if (u === 'pieza') return p?.uxc || 1;
    if (u === 'paquete') return p?.packs || 1;
    return 1;
  }
  /** Cantidad mostrada en la unidad elegida (u.qty vive en CAJAS). */
  dispQty(u: URow): number { return u.qty * this.unitFactor(u.product_id); }
  setDispQty(u: URow, v: number | string): void { const f = this.unitFactor(u.product_id) || 1; u.qty = Math.max(0, Number(v) || 0) / f; this.onQtyEdit(); }
  /** Tipos de acción presentes por producto (compra/traspaso/sobre) → tags de color en el renglón. */
  private readonly typesByProduct = computed(() => {
    const m = new Map<string, Set<UType>>();
    for (const u of this.urows()) { let s = m.get(u.product_id); if (!s) m.set(u.product_id, s = new Set()); s.add(u.type); }
    return m;
  });
  prodTypes(pid: string): UType[] {
    const s = this.typesByProduct().get(pid);
    return s ? (['comprar', 'traspaso', 'sobre'] as UType[]).filter((t) => s.has(t)) : [];
  }

  // Semáforo de existencia como CHIP (como en "por sucursal"): rojo=sin stock · amarillo=bajo (necesita
  // pedido) · verde=sano. Tabla principal: por plaza (exis + ped). Detalle: por almacén (según la acción).
  existSev(exis: number, ped: number): Sev {
    if (!(exis > 0)) return 'danger';
    return ped > 0 ? 'warn' : 'success';
  }
  existTitle(exis: number, ped: number): string {
    if (!(exis > 0)) return 'Sin stock';
    return ped > 0 ? 'Bajo — requiere pedido' : 'Sano';
  }
  existSevU(u: URow): Sev {
    if (u.type === 'sobre') return 'success';
    return u.on_hand > 0 ? 'warn' : 'danger';
  }
  existTitleU(u: URow): string {
    if (u.type === 'sobre') return 'Sobrestock (sano/de más)';
    return u.on_hand > 0 ? 'Bajo — requiere ' + (u.type === 'traspaso' ? 'traspaso' : 'compra') : 'Sin stock';
  }
  // RA-PRO.32.1 — Fila EXPANDIBLE (acordeón) que UNIFICA "por sucursal" en la Vista Excel: al abrir un
  // SKU se despliega INLINE toda su info por sucursal reusando el MISMO motor de la vista consolidada
  // (comprar/traspaso/sobrestock, ABC, señal de cobertura, déficit, origen del traspaso, cantidad
  // editable) con su COLORIMETRÍA. Varias filas abiertas a la vez. Los URows viven en this.urows (se
  // cargan junto con el workbook, sin filtro de almacén, para que el detalle vea todas las sucursales).
  private readonly wbOpen = signal<Set<string>>(new Set());
  readonly detailReady = signal(false);   // ¿ya llegó el modelo por-sucursal (urows)?
  isOpen(r: WorkbookRow): boolean { return this.wbOpen().has(r.product_id); }
  toggleRow(r: WorkbookRow): void {
    const s = new Set(this.wbOpen());
    if (s.has(r.product_id)) s.delete(r.product_id); else s.add(r.product_id);
    this.wbOpen.set(s);
  }
  /** Filas por-sucursal (comprar/traspaso/sobre) del producto, ordenadas acción→sucursal
   *  (sucursal en el orden canónico PH · MA · MM · 8ESQ · LPA · YUR · CAN · Zamora · CEDIS). */
  detailRows(pid: string): URow[] {
    this.tickN();
    return this.urows()
      .filter((u) => u.product_id === pid)
      .sort((a, b) => this.typeOrder[a.type] - this.typeOrder[b.type] || compareWarehouseCodes(a.warehouse_code, b.warehouse_code));
  }
  prodTr(pid: string): number { return this.detailRows(pid).filter((u) => u.type === 'traspaso').reduce((s, u) => s + u.qty * u.unit_cost, 0); }

  // RA-PRO.47 — el toggle Englobar/Desglosar se retiró: ya no hay columnas por sucursal que abrir
  // o cerrar. La consulta pide SIEMPRE grano sucursal, porque es lo que alimenta el desglose.

  // RA-PRO.36.2 — filtros SERVER-SIDE (aplican sobre TODO el dataset, no la página cargada).
  readonly fIad = signal<'all' | 'accel' | 'decel'>('all');   // RA-PRO.36 filtro de tendencia
  toggleOnlyOver(): void {
    const on = !this.wbOnlyOver();
    this.wbOnlyOver.set(on);
    // sobrestock suele NO tener pedido → apagar "Solo con pedido" para que aparezcan.
    if (on && this.wbScopeNeeded()) this.wbScopeNeeded.set(false);
    this.loadWorkbook();
  }
  toggleIad(mode: 'accel' | 'decel'): void { this.fIad.set(this.fIad() === mode ? 'all' : mode); this.loadWorkbook(); }

  // RA-PRO.36 — IAD (Índice de Aceleración de Demanda): etiqueta/severidad/tooltip por SKU.
  private readonly IAD_BANDS: Record<string, { txt: string; sev: Sev }> = {
    accel_extra:  { txt: '▲▲', sev: 'success' },
    accel:        { txt: '▲',  sev: 'success' },
    accel_leve:   { txt: '▲',  sev: 'success' },
    estable:      { txt: '═',  sev: 'secondary' },
    desacel_leve: { txt: '▼',  sev: 'warn' },
    desacel:      { txt: '▼',  sev: 'warn' },
    desacel_extra:{ txt: '▼▼', sev: 'danger' },
  };
  // Postgres numeric → llega como STRING en el JSON. SIEMPRE Number()-coercionar antes de .toFixed()/
  // comparar (mismo patrón que money()). Sin esto: "n.toFixed is not a function" rompe el render.
  iadLabel(r: WorkbookRow): string {
    const b = this.IAD_BANDS[r.iad_band ?? ''];
    const v = Number(r.iad ?? 0);
    return `${b?.txt ?? ''} ${v > 0 ? '+' : ''}${v.toFixed(2)}`.trim();
  }
  iadSev(r: WorkbookRow): Sev { return this.IAD_BANDS[r.iad_band ?? '']?.sev ?? 'secondary'; }

  // ── RA-PRO.44 — "En camino": las OCs abiertas del SKU ────────────────
  tranVisible = false;
  readonly tranLoading = signal(false);
  readonly tranError = signal(false);
  readonly tranRows = signal<InTransitOc[]>([]);
  readonly tranProduct = signal<{ sku: string; nombre: string } | null>(null);
  readonly tranLead = signal<number | null>(null);
  readonly tranDescuenta = signal(0);          // RA-PRO.45 — cajas que el motor sí resta
  tranTotalCajas = computed(() => this.tranRows().reduce((s, o) => s + (Number(o.cajas) || 0), 0));
  tranTotalValor = computed(() => this.tranRows().reduce((s, o) => s + (Number(o.valor) || 0), 0));
  tranGap = computed(() => Math.max(0, this.tranTotalCajas() - this.tranDescuenta()));

  openTransit(r: WorkbookRow): void {
    this.tranProduct.set({ sku: r.sku, nombre: r.nombre });
    this.tranRows.set([]); this.tranError.set(false); this.tranLoading.set(true); this.tranVisible = true;
    this.api.inTransit(r.product_id)
      .pipe(catchError(() => of(null as InTransitResponse | null)), takeUntilDestroyed(this.destroyRef))
      .subscribe((res) => {
        this.tranLoading.set(false);
        if (!res) { this.tranError.set(true); return; }   // NO tragar el error: se avisa (DESIGN §Ing.UI 6)
        this.tranRows.set(res.rows ?? []);
        this.tranLead.set(res.lead_days ?? null);
        this.tranDescuenta.set(Number(res.descuenta_cajas ?? 0));
        if (res.product) this.tranProduct.set(res.product);
      });
  }
  /** Antigüedad de la OC: es lo que decide cuánto pesa. +30 d = prácticamente muerta. */
  edadCls(o: InTransitOc): string {
    const d = Number(o.dias_abierta) || 0;
    return d > 30 ? 'pr-edad pr-edad-bad' : d > 14 ? 'pr-edad pr-edad-warn' : 'pr-edad';
  }
  edadTitle(o: InTransitOc): string {
    const d = Number(o.dias_abierta) || 0;
    if (d > 30) return 'Lleva más de un mes abierta: históricamente sólo una de cada siete llega. Casi no descuenta pedido.';
    if (d > 14) return 'Lleva más de dos semanas abierta: cerca de la mitad de estas ya no se surte.';
    return 'Orden reciente: se descuenta casi completa.';
  }
  /** Semáforo de llegada: vencida (debió llegar) · esta semana · más adelante. */
  llegaSev(o: InTransitOc): Sev {
    const d = Math.ceil((new Date(o.llega_aprox).getTime() - Date.now()) / 86400000);
    return d < 0 ? 'danger' : d <= 7 ? 'warn' : 'info';
  }
  llegaTitle(o: InTransitOc): string {
    const d = Math.ceil((new Date(o.llega_aprox).getTime() - Date.now()) / 86400000);
    const base = o.llega_estimada ? 'Estimado (fecha de la orden + tiempo de surtido del proveedor)' : 'Fecha comprometida';
    return d < 0 ? `${base} — lleva ${-d} día(s) de retraso` : `${base} — en ${d} día(s)`;
  }

  // RA-PRO.41 — estacionalidad (el Pedido ya la trae puesta; el chip la hace visible).
  seasonOn(r: WorkbookRow): boolean { const v = Number(r.season_ratio ?? 1); return v !== 1 && v > 0; }
  seasonLabel(r: WorkbookRow): string { return '×' + Number(r.season_ratio ?? 1).toFixed(2); }
  seasonSev(r: WorkbookRow): Sev { return Number(r.season_ratio ?? 1) > 1 ? 'warn' : 'info'; }
  seasonTitle(r: WorkbookRow): string {
    const v = Number(r.season_ratio ?? 1);
    const src: Record<string, string> = { sku: 'historia del propio SKU', cat: 'historia de su categoría', global: 'estación de toda la red' };
    return `Los próximos 30 días venden ×${v.toFixed(2)} vs los últimos 30 (${src[r.season_src ?? ''] ?? 'historia'}). El Pedido ya lo incluye.`;
  }
  iadTitle(r: WorkbookRow): string {
    if (r.iad == null) {
      const m: Record<string, string> = {
        insufficient_history: 'Menos de 60 días de historia',
        insufficient_sales: 'Menos de 20 días con venta en 60d',
        no_prior: 'Sin base de comparación (periodo anterior en cero)',
      };
      return `Información insuficiente — ${m[r.iad_status ?? ''] ?? 'sin datos'}`;
    }
    const band: Record<string, string> = {
      accel_extra: 'Aceleración extraordinaria', accel: 'Aceleración relevante', accel_leve: 'Aceleración ligera',
      estable: 'Demanda estable', desacel_leve: 'Desaceleración ligera', desacel: 'Desaceleración relevante',
      desacel_extra: 'Desaceleración extraordinaria',
    };
    const iad = Number(r.iad), z30v = r.iad_z_short != null ? Number(r.iad_z_short) : null, zYv = r.iad_z_seasonal != null ? Number(r.iad_z_seasonal) : null;
    const z30 = z30v != null ? `corto 30v30 ${z30v > 0 ? '+' : ''}${z30v}` : 'corto n/d';
    const zY = r.iad_has_seasonal && zYv != null ? ` · estacional ${zYv > 0 ? '+' : ''}${zYv}` : ' · sin base estacional';
    return `${band[r.iad_band ?? ''] ?? ''} (IAD ${iad > 0 ? '+' : ''}${iad}) — ${z30}${zY}`;
  }

  cBuy = signal(true);
  cTr = signal(true);
  cOver = signal(true);

  fSupplier: string | null = null;
  fBrand: string | null = null;                                       // filtro de marca (igual que /comercial/salidas)
  fWarehouse: string | null = null;
  fCategory: string | null = null;                                    // RA-PRO.12 — categoría de compra
  search = '';
  coverage = 30;

  // Condensado por sucursal (colapso MANUAL — PrimeNG 18 no trae grupos colapsables): signal para
  // que displayRows() reaccione. Vacío = TODAS colapsadas por default. Clic en el chevron despliega.
  private readonly expandedGroups = signal<Record<string, boolean>>({});
  // Ref ESTABLE (no objeto literal en el template → evita ExpressionChanged/loop de CD).
  readonly tableStyle = { 'min-width': '78rem' };
  readonly deadTableStyle = { 'min-width': '60rem' };
  isExpanded(code: string): boolean { return !!this.expandedGroups()[code]; }
  toggle(code: string): void { this.expandedGroups.update((m) => ({ ...m, [code]: !m[code] })); }
  expandAll(): void { const e: Record<string, boolean> = {}; this.subs().forEach((_g, code) => (e[code] = true)); this.expandedGroups.set(e); }
  collapseAll(): void { this.expandedGroups.set({}); }
  /** trackBy estable → p-table reusa el DOM al expandir/colapsar (aplica solo el delta, no re-crea todas las filas). */
  rowKey = (_i: number, r: URow | { __header: true; warehouse_code: string }): string =>
    (r as { __header?: boolean }).__header
      ? 'h:' + r.warehouse_code
      : (r as URow).type + ':' + (r as URow).product_id + ':' + r.warehouse_code;

  private readonly filters = signal<ReplenishmentFilters | null>(null);
  supplierOpts = computed(() => (this.filters()?.suppliers ?? []).map((s) => ({ label: s.name, value: s.id })));
  brandOpts = computed(() => (this.filters()?.brands ?? []).map((b) => ({ label: b.name, value: b.id })));
  // Categorías salen del MISMO payload de /filters (que ya las trae) en vez de un GET aparte a
  // /categories: ese endpoint exige COMPRAS_CATEGORIAS_VER — permiso que esta ruta NO pide — así
  // que un rol con solo COMPRAS_PEDIDO_VER recibía 403 y el filtro quedaba vacío para siempre.
  categoryOpts = computed(() => (this.filters()?.categories ?? []).map((c) => ({ label: c.name, value: c.id })));
  warehouseOpts = computed(() => (this.filters()?.warehouses ?? []).map((w) => ({ label: `${w.code} · ${w.name}`, value: w.id })));
  private readonly whName = computed(() => {
    const m = new Map<string, string>();
    for (const w of this.filters()?.warehouses ?? []) m.set(w.code, w.name);
    return m;
  });
  nameOf(code: string): string { return this.whName().get(code) || (code === '—' ? 'Sin almacén / red' : ''); }

  ngOnInit(): void {
    // Lookups de los filtros. NUNCA tragar el error (DESIGN §Ing.UI 6): si esto falla en
    // silencio, los selects quedan vacíos y la pantalla se ve "sin menús" sin decir por qué.
    this.api.filters().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (f) => this.filters.set(f),
      error: (e) => this.toast.add({
        severity: 'error', summary: 'Filtros no disponibles', life: 8000,
        detail: e?.status === 403
          ? 'Tu rol no tiene permiso para leer proveedores/marcas/sucursales.'
          : (e?.error?.message || 'No se pudieron cargar proveedor / marca / sucursal.'),
      }),
    });
    this.restoreFilters();
    // Q.4 — hidratación por query-params, DESPUÉS de restoreFilters para que el link gane sobre
    // el localStorage. Es lo que hace navegable "todo dato accionable a su lugar de arreglo con
    // el filtro puesto": Existencia manda acá con ?search=<sku>. Sin esto el enlace no hacía nada
    // (esta pantalla no leía ActivatedRoute en absoluto).
    const qp = this.route.snapshot.queryParamMap;
    const qSearch = qp.get('search');
    if (qSearch) this.search = qSearch;
    const qWh = qp.get('warehouse_ids');
    if (qWh) this.wbWarehouses = qWh.split(',').map((c) => c.trim()).filter(Boolean);
    if (this.mode() === 'muerto') this.loadDead();
    else this.loadWorkbook();
    // Refresca la etiqueta "hace N min" sin recargar datos.
    const id = setInterval(() => this.nowTick.set(Date.now()), 60000);
    this.destroyRef.onDestroy(() => clearInterval(id));
  }

  // Persistencia de filtros en localStorage → se mantienen al recargar / navegar / cambiar de pestaña.
  private readonly FKEY = 'compras-pedido-filters:v1';
  private saveFilters(): void {
    try {
      localStorage.setItem(this.FKEY, JSON.stringify({
        mode: this.mode(), fSupplier: this.fSupplier, fBrand: this.fBrand, fCategory: this.fCategory, fWarehouse: this.fWarehouse,
        search: this.search, coverage: this.coverage, cBuy: this.cBuy(), cTr: this.cTr(), cOver: this.cOver(),
        wbWarehouses: this.wbWarehouses, wbScopeNeeded: this.wbScopeNeeded(),
      }));
    } catch { /* localStorage no disponible */ }
  }
  private restoreFilters(): void {
    try {
      const raw = localStorage.getItem(this.FKEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      // 'consolidado'/'excel' (versiones previas de 3 pestañas) migran a la única 'pedido'.
      if (s.mode === 'muerto') this.mode.set('muerto');
      else if (s.mode === 'pedido' || s.mode === 'consolidado' || s.mode === 'excel') this.mode.set('pedido');
      if ('fSupplier' in s) this.fSupplier = s.fSupplier;
      if ('fBrand' in s) this.fBrand = s.fBrand;
      if ('fCategory' in s) this.fCategory = s.fCategory;
      if ('fWarehouse' in s) this.fWarehouse = s.fWarehouse;
      if (typeof s.search === 'string') this.search = s.search;
      if (typeof s.coverage === 'number') this.coverage = s.coverage;
      if (typeof s.cBuy === 'boolean') this.cBuy.set(s.cBuy);
      if (typeof s.cTr === 'boolean') this.cTr.set(s.cTr);
      if (typeof s.cOver === 'boolean') this.cOver.set(s.cOver);
      if (Array.isArray(s.wbWarehouses)) this.wbWarehouses = s.wbWarehouses;
      if (typeof s.wbScopeNeeded === 'boolean') this.wbScopeNeeded.set(s.wbScopeNeeded);
    } catch { /* JSON inválido */ }
  }

  setMode(m: Mode): void {
    if (this.mode() === m) return;
    this.mode.set(m);
    if (m === 'muerto') this.loadDead();
    else this.loadWorkbook();
  }

  /** RA-PRO.32 — carga la réplica del workbook (fila por SKU, columnas por punto de compra) +, en
   * paralelo, el modelo por-sucursal (compra/traspaso/sobrestock) que alimenta el detalle expandible. */
  /** Cambio de filtro → reinicia a la página 1 y recarga (workbook + enriquecimiento). */
  loadWorkbook(): void { this.wbFirst.set(0); this.fetchWorkbookPage(true); }

  /** Cambio de página (p-paginator) → solo trae la página; NO recarga el enriquecimiento (mismos filtros). */
  onWbPage(e: PaginatorState): void {
    const first = e.first ?? 0, rows = e.rows ?? 20;
    if (first === this.wbFirst() && rows === this.wbPageSize()) return;
    this.wbFirst.set(first); this.wbPageSize.set(rows);
    this.fetchWorkbookPage(false);
  }

  /**
   * RA-PRO.36.1/36.2 — Carga UNA página del workbook. SECUENCIAL (no 4 queries en paralelo que
   * saturaban Railway): el workbook (20 filas) corre solo primero → matriz interactiva rápido; luego,
   * SOLO en cambio de filtro (reloadEnrichment), las 3 fuentes por-sucursal (tags + detalle) cargan en
   * segundo plano. Paginar NO re-dispara el enriquecimiento (cubre los top ~1000 productos del filtro).
   */
  private fetchWorkbookPage(reloadEnrichment: boolean): void {
    this.loading.set(true); this.error.set(false); this.saveFilters();
    this.wbOpen.set(new Set());   // nueva página/data → colapsa el acordeón
    if (reloadEnrichment) {
      this.detailReady.set(false);
      // Cambio de filtro = otro universo: las cantidades editadas vuelven al sugerido del motor.
      // Al paginar NO se limpian (están indexadas por producto×sucursal), así que ir y volver de
      // página conserva lo capturado.
      this.buyQty.set({}); this.buyUnit.set({}); this.buyDeliver.set({}); this.dirty.set(false);
    }
    const iad = this.fIad();
    this.api.workbook({
      supplier_id: this.fSupplier || undefined, brand_id: this.fBrand || undefined, category_id: this.fCategory || undefined, search: this.search.trim() || undefined,
      coverage_days: this.coverage, scope: this.wbScopeNeeded() ? 'needed' : undefined,
      warehouse_ids: this.wbWarehouses.length ? this.wbWarehouses : undefined, group: 'branch',
      iad: iad === 'all' ? undefined : iad,
      only_overstock: this.wbOnlyOver() || undefined,
      page: Math.floor(this.wbFirst() / this.wbPageSize()) + 1, pageSize: this.wbPageSize(),
    }).pipe(catchError(() => of(null as WorkbookResponse | null)), takeUntilDestroyed(this.destroyRef))
      .subscribe((r) => {
        this.loading.set(false);
        if (!r) { this.error.set(true); this.wbRows.set([]); return; }
        this.wbRows.set(r.rows); this.wbTotals.set(r.totals); this.wbTotal.set(r.total);
        this.wbRung.set(r.unit_rung ?? null);
        this.loadedAt.set(Date.now());
        if (reloadEnrichment) {
          this.fetchConsolidated(true).pipe(takeUntilDestroyed(this.destroyRef)).subscribe((res) => {
            this.buyRows.set(res.buy?.rows ?? []); this.trRows.set(res.tr?.rows ?? []); this.ovRows.set(res.ov?.rows ?? []);
            this.rebuild(); this.detailReady.set(true);
          });
        }
      });
  }

  /** forkJoin de las 3 fuentes por-sucursal. ignoreWarehouse=true (Vista Excel) trae todas las sucursales. */
  private fetchConsolidated(ignoreWarehouse: boolean) {
    const wh = ignoreWarehouse ? undefined : (this.fWarehouse || undefined);
    const sup = this.fSupplier || undefined, s = this.search.trim() || undefined, cat = this.fCategory || undefined;
    const brand = this.fBrand || undefined;
    return forkJoin({
      buy: this.api.purchaseSuggestion({ supplier_id: sup, brand_id: brand, category_id: cat, warehouse_id: wh, scope: 'needed', search: s, coverage_days: this.coverage, pageSize: 1000 })
        .pipe(catchError(() => of(null as PurchaseSuggestionResponse | null))),
      tr: this.api.transferSuggestion({ warehouse_id: wh, supplier_id: sup, brand_id: brand, category_id: cat, search: s, coverage_days: this.coverage, pageSize: 1000 })
        .pipe(catchError(() => of(null as TransferSuggestionResponse | null))),
      ov: this.api.overstock({ warehouse_id: wh, supplier_id: sup, brand_id: brand, category_id: cat, search: s, over_days: 90, pageSize: 1000 })
        .pipe(catchError(() => of(null as OverstockResponse | null))),
    });
  }

  pedidoKpi(): MetricStripItem[] {
    const t = this.wbTotals();
    return [
      { label: 'A comprar', value: t.pedido, format: 'currency', tone: 'brand', sub: 'venta × cobertura' },
      { label: 'A traspasar', value: this.totTr(), format: 'currency', sub: 'desde CEDIS' },
      { label: 'Sobrestock', value: this.totOver(), format: 'currency', tone: 'warn', sub: 'inmovilizado' },
      { label: 'SKUs', value: this.wbTotal() },
      { label: 'Cobertura', value: this.coverage, sub: 'días objetivo' },
    ];
  }

  setCoverage(d: number): void { this.coverage = d; this.loadAll(); }
  tick(): void { this.tickN.update((n) => n + 1); }

  /** Carga las 3 fuentes (compra needed / traspasos / sobrestock) y arma el modelo unificado. */
  loadAll(): void {
    this.loading.set(true); this.error.set(false); this.saveFilters();
    this.fetchConsolidated(false).pipe(takeUntilDestroyed(this.destroyRef)).subscribe((res) => {
      this.loading.set(false);
      if (!res.buy && !res.tr && !res.ov) { this.error.set(true); this.buyRows.set([]); this.trRows.set([]); this.ovRows.set([]); this.rebuild(); return; }
      this.buyRows.set(res.buy?.rows ?? []);
      this.trRows.set(res.tr?.rows ?? []);
      this.ovRows.set(res.ov?.rows ?? []);
      this.rebuild(); this.detailReady.set(true);
    });
  }

  /** Reconstruye el modelo unificado (una sola vez por carga; qty editable persiste en cada URow). */
  private rebuild(): void {
    const out: URow[] = [];
    for (const r of this.buyRows()) {
      out.push({
        type: 'comprar', product_id: r.product_id, sku: r.sku, nombre: r.nombre,
        warehouse_code: r.warehouse_code || '—', warehouse_id: r.warehouse_id ?? null,
        supplier_id: r.supplier_id ?? null, supplier_name: r.supplier_name ?? null,
        from_code: null, from_warehouse_id: null, to_warehouse_id: null,
        uxc: Number(r.uxc) || 1, unit_cost: Number(r.unit_cost) || 0,
        qty: Math.round(Number(r.suggested_units) || 0), editable: true,
        on_hand: Number(r.on_hand_units) || 0, cover: r.days_cover ?? null, sell_daily: Number(r.sell_daily_cajas) || 0,
        deficit: 0, surplus: 0, days_on_hand: null,
        fill_rate: r.fill_rate ?? null, abc_class: r.abc_class ?? null, unit_source: r.unit_source, buy: r,
      });
    }
    for (const r of this.trRows()) {
      out.push({
        type: 'traspaso', product_id: r.product_id, sku: r.sku, nombre: r.nombre,
        warehouse_code: r.to_code || '—', warehouse_id: r.to_warehouse_id ?? null,
        supplier_id: null, supplier_name: r.supplier_name ?? null,
        from_code: r.from_code ?? null, from_warehouse_id: r.from_warehouse_id ?? null, to_warehouse_id: r.to_warehouse_id ?? null,
        uxc: Number(r.uxc) || 1, unit_cost: Number(r.unit_cost) || 0,
        qty: Math.round(Number(r.transfer_cajas) || 0), editable: true,
        on_hand: 0, cover: null, sell_daily: 0, deficit: Number(r.deficit_cajas) || 0, surplus: 0, days_on_hand: null,
        fill_rate: null, abc_class: null, unit_source: undefined, buy: null,
      });
    }
    for (const r of this.ovRows()) {
      out.push({
        type: 'sobre', product_id: r.product_id, sku: r.sku, nombre: r.nombre,
        warehouse_code: r.warehouse_code || '—', warehouse_id: r.warehouse_id ?? null,
        supplier_id: null, supplier_name: r.supplier_name ?? null,
        from_code: null, from_warehouse_id: null, to_warehouse_id: null,
        uxc: Number(r.uxc) || 1, unit_cost: Number(r.unit_cost) || 0,
        qty: Math.round(Number(r.surplus_cajas) || 0), editable: false,
        on_hand: Number(r.on_hand_cajas) || 0, cover: null, sell_daily: 0, deficit: 0,
        surplus: Number(r.surplus_cajas) || 0, days_on_hand: r.days_on_hand ?? null,
        fill_rate: null, abc_class: null, unit_source: undefined, buy: null,
      });
    }
    this.urows.set(out);
    this.tick();
    this.loadedAt.set(Date.now());   // sella frescura
    this.dirty.set(false);           // datos frescos = sin ediciones pendientes
  }

  private readonly typeOrder: Record<UType, number> = { comprar: 0, traspaso: 1, sobre: 2 };
  /** Lista plana filtrada por chips y ORDENADA por sucursal (para el rowGroup subheader), en el
   *  orden canónico de tiendas compartido con el backend (@megadulces/contracts). */
  flatRows = computed<URow[]>(() => {
    const show = { comprar: this.cBuy(), traspaso: this.cTr(), sobre: this.cOver() } as Record<UType, boolean>;
    return this.urows()
      .filter((r) => show[r.type])
      .sort((a, b) => compareWarehouseCodes(a.warehouse_code, b.warehouse_code) || this.typeOrder[a.type] - this.typeOrder[b.type] || (b.qty * b.unit_cost) - (a.qty * a.unit_cost));
  });

  /** Subtotales por sucursal (código → $ comprar/traspaso/sobre + cajas). */
  private readonly subs = computed(() => {
    this.tickN();
    const m = new Map<string, Grp>();
    for (const r of this.flatRows()) {
      const g = m.get(r.warehouse_code) ?? { code: r.warehouse_code, name: this.nameOf(r.warehouse_code), buy: 0, tr: 0, over: 0, buyCj: 0, trCj: 0, n: 0 };
      const val = r.qty * r.unit_cost;
      if (r.type === 'comprar') { g.buy += val; g.buyCj += r.qty; }
      else if (r.type === 'traspaso') { g.tr += val; g.trCj += r.qty; }
      else g.over += val;
      g.n++;
      m.set(r.warehouse_code, g);
    }
    return m;
  });
  grp(code: string): Grp | undefined { return this.subs().get(code); }
  grpCount = computed(() => this.subs().size);

  // Renglones de la tabla: por cada sucursal un __header (siempre visible) y, si está EXPANDIDA,
  // sus productos debajo. Colapso manual (PrimeNG 18 no tiene expandableRowGroups). flatRows ya
  // viene ordenado por warehouse_code → los grupos quedan contiguos (Map preserva orden de inserción).
  readonly displayRows = computed<Array<URow | { __header: true; warehouse_code: string }>>(() => {
    const exp = this.expandedGroups();
    const byGroup = new Map<string, URow[]>();
    for (const r of this.flatRows()) {
      const arr = byGroup.get(r.warehouse_code);
      if (arr) arr.push(r); else byGroup.set(r.warehouse_code, [r]);
    }
    const out: Array<URow | { __header: true; warehouse_code: string }> = [];
    for (const [code, rows] of byGroup) {
      out.push({ __header: true, warehouse_code: code });
      if (exp[code]) out.push(...rows);
    }
    return out;
  });
  // RA-PRO.47 — la compra de la barra sale del MISMO desglose que el botón Requisición ordena, así
  // que decir y hacer no se pueden separar. Alcance = los productos de ESTA página (que es lo que
  // el botón global arma); el KPI "A comprar" de arriba es el total del filtro completo, server-side.
  totBuy = computed(() => this.wbRows().reduce((s, r) => s + this.sumValor(r), 0));
  totBuyCajas = computed(() => this.wbRows().reduce((s, r) => s + this.sumCajas(r), 0));
  totTr = computed(() => { let s = 0; this.subs().forEach((g) => (s += g.tr)); return s; });
  totOver = computed(() => { let s = 0; this.subs().forEach((g) => (s += g.over)); return s; });
  totCajas = computed(() => {
    let tr = 0; this.subs().forEach((g) => (tr += g.trCj));
    return this.totBuyCajas() + tr;
  });

  loadDead(): void {
    this.loading.set(true); this.saveFilters();
    this.api.deadStock({ search: this.search.trim() || undefined, pageSize: 200 })
      .pipe(catchError(() => of(null)), takeUntilDestroyed(this.destroyRef))
      .subscribe((r) => { this.loading.set(false); this.deadRows.set(r?.rows ?? []); this.deadValue.set(Number(r?.total_value) || 0); this.loadedAt.set(Date.now()); });
  }

  /** RA-PRO.33 — XLSX del stock muerto (capital inmovilizado). */
  exportDead(): void {
    const rows = this.deadRows();
    if (!rows.length) { this.toast.add({ severity: 'warn', summary: 'Nada que exportar' }); return; }
    const lines: PedidoExportLine[] = rows.map((r) => ({
      warehouse_code: r.warehouse_code, supplier_name: r.supplier_name,
      // ADR-055 — en CAJAS, igual que la pantalla; el costo va por caja para que cuadre.
      sku: r.sku, nombre: r.nombre, on_hand: Number(r.on_hand_cajas) || 0,
      unit_cost: Number(r.caja_cost) || 0, line_cost: Number(r.dead_value) || 0,
    }));
    this.dl.set(true);
    this.api.exportPedidoXlsx({
      title: 'Stock muerto — capital inmovilizado',
      basis: `${rows.length} productos · ${this.money(this.deadValue())} inmovilizado`,
      multi_warehouse: true, lines,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (resp) => { this.dl.set(false); saveXlsxResponse(resp, 'stock-muerto.xlsx'); },
      error: () => { this.dl.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo exportar.' }); },
    });
  }

  // ── etiquetas / severidades ──────────────────────────────────────────
  typeLabel(t: UType): string { return t === 'comprar' ? 'comprar' : t === 'traspaso' ? 'traspaso' : 'sobre'; }
  typeSev(t: UType): Sev { return t === 'comprar' ? 'success' : t === 'traspaso' ? 'info' : 'warn'; }
  abcSev(c: string | null): Sev { return c === 'A' ? 'success' : c === 'B' ? 'info' : 'secondary'; }
  unitLabel(src: string | undefined): string { return src === 'granel' ? 'granel' : src === 'revisar' ? 'revisar unidad' : src === 'manual' ? 'unidad fija' : ''; }
  coverSev(d: number | null): Sev { if (d == null) return 'secondary'; if (d < 7) return 'danger'; if (d < 30) return 'warn'; if (d > 90) return 'info'; return 'success'; }

  // ── override de unidad de venta ──────────────────────────────────────
  unitVisible = false;
  unitRow = signal<PurchaseSuggestionRow | null>(null);
  unitSaving = signal(false);
  ovSuf: number | null = null;
  ovBf: number | null = null;
  openUnit(r: PurchaseSuggestionRow): void {
    this.unitRow.set(r);
    this.ovSuf = r.unit_source === 'manual' && r.stock_unit_factor && r.stock_unit_factor > 1 ? Number(r.stock_unit_factor) : null;
    this.ovBf = r.unit_source === 'manual' ? Number(r.uxc) || null : null;
    this.unitVisible = true;
  }
  saveUnit(): void {
    const r = this.unitRow(); if (!r) return;
    this.unitSaving.set(true);
    this.api.setProductUnitOverride(r.product_id, {
      pieces_per_unit: this.ovSuf != null && Number(this.ovSuf) > 0 ? Number(this.ovSuf) : null,
      box_factor: this.ovBf != null && Number(this.ovBf) > 0 ? Number(this.ovBf) : null,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.unitSaving.set(false); this.unitVisible = false; this.toast.add({ severity: 'success', summary: 'Unidad actualizada', detail: r.sku }); this.mode() === 'muerto' ? this.loadDead() : this.loadWorkbook(); },
      error: (e) => { this.unitSaving.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo guardar.' }); },
    });
  }
  clearUnit(): void { this.ovSuf = null; this.ovBf = null; this.saveUnit(); }

  // ── requisiciones (por sucursal o global) ────────────────────────────
  /** Arma requisición(es) del scope: compra → agrupa por (proveedor × almacén); traspaso → por (destino × origen). */
  /** Nota de unidad de pedido para los productos que NO se piden en caja (aún sin columna en el schema). */
  private unitNote(rs: URow[]): string {
    const parts: string[] = []; const seen = new Set<string>();
    for (const r of rs) {
      const u = this.unitOf(r.product_id);
      if (u === 'caja' || seen.has(r.product_id)) continue;
      seen.add(r.product_id); parts.push(`${r.sku}=${u}`);
    }
    return parts.length ? ` · unidad de pedido: ${parts.join(', ')}` : '';
  }

  /**
   * RA-PRO.47 — líneas de COMPRA a ordenar: salen del desglose por sucursal (lo que el comprador
   * ve y editó), no del motor de grano red. Se saltan las sucursales con el peldaño sin verificar
   * (`qtyOf` ya devuelve 0 ahí): la tabla dice que no se puede calcular y la orden tiene que decir
   * lo mismo — antes la tabla retenía el número y la requisición lo mandaba igual.
   */
  private buyLines(pid?: string, code?: string) {
    const ids = this.whIdByCode();
    const out: Array<{
      r: WorkbookRow; b: BranchBuy; qty: number;
      wh: string | undefined;                       // la sucursal que NECESITA la mercancía
      /** RA-PRO.48 — dónde la ENTREGA el proveedor. null = la misma sucursal. */
      toCode: string | null; toWh: string | undefined;
    }> = [];
    for (const r of this.wbRows()) {
      if (pid && r.product_id !== pid) continue;
      for (const b of this.branchBuys(r)) {
        if (code && b.code !== code) continue;
        const qty = this.qtyOf(r, b);
        if (!(qty > 0)) continue;
        // Consolidar en la propia sucursal no es consolidar: cuenta como entrega directa.
        const to = this.deliverOf(r, b);
        const toCode = to && to !== b.code ? to : null;
        out.push({ r, b, qty, wh: ids.get(b.code), toCode, toWh: toCode ? ids.get(toCode) : undefined });
      }
    }
    return out;
  }

  buildReq(code?: string, pid?: string): void {
    const all = this.buyLines(pid, code);
    // Una línea consolidada necesita DOS almacenes resueltos (el CEDIS que recibe y la sucursal
    // que la va a recibir en el traspaso); una directa, sólo el suyo.
    const buyL = all.filter((l) => l.wh && (!l.toCode || l.toWh));
    const sinWh = all.length - buyL.length;
    const tr = (pid ? this.urows() : this.flatRows())
      .filter((r) => (!code || r.warehouse_code === code) && (!pid || r.product_id === pid) && r.type === 'traspaso' && r.editable && Number(r.qty) > 0);
    if (!buyL.length && !tr.length) { this.toast.add({ severity: 'warn', summary: 'Nada que armar', detail: 'No hay cantidades > 0 en el scope.' }); return; }
    // El código de almacén tiene que resolver a un id o la línea no se puede mandar. Se avisa en
    // vez de perderla en silencio (pasaría si /filters falló y los lookups quedaron vacíos).
    if (sinWh) {
      this.toast.add({ severity: 'warn', life: 8000, summary: 'Sucursales sin identificar',
        detail: `${sinWh} renglón(es) quedan fuera: no se pudo resolver su almacén. Recargá la página.` });
    }

    const dtos: CreateRequisitionDto[] = [];
    // RA-PRO.48 — la COMPRA se agrupa por (proveedor × dónde ENTREGA el proveedor), no por la
    // sucursal que la necesita. Consolidar significa exactamente eso: una sola entrega en el CEDIS.
    const buyGroups = new Map<string, typeof buyL>();
    for (const l of buyL) {
      const k = `${l.r.supplier_id || 'none'}|${l.toWh ?? l.wh}`;
      (buyGroups.get(k) ?? buyGroups.set(k, []).get(k)!).push(l);
    }
    for (const ls of buyGroups.values()) {
      const consol = ls.filter((l) => l.toCode);
      const nota = consol.length
        ? ` — consolidado: ${[...new Set(consol.map((l) => l.b.code))].join(', ')} bajan por traspaso`
        : '';
      dtos.push({
        warehouse_id: (ls[0].toWh ?? ls[0].wh)!, supplier_id: ls[0].r.supplier_id || null, source_type: 'supplier',
        notes: `Demand-driven (venta × cobertura ${this.coverage}d) — por sucursal${nota}`,
        lines: ls.map<CreateRequisitionLine>((l) => ({
          product_id: l.r.product_id, supplier_id: l.r.supplier_id || null, source_type: 'supplier',
          on_hand: l.b.exis, suggested_qty: l.b.seed, final_qty: l.qty, unit_cost: l.b.cc,
        })),
      });
    }
    // RA-PRO.48 — y el TRASPASO que la consolidación implica. El schema ya lo expresa
    // (`source_type='branch'` + `source_warehouse_id`), así que no hace falta columna nueva: la
    // mercancía llega al CEDIS y baja, que es lo que físicamente pasa. Se agrupa por (destino × CEDIS).
    const bajadas = new Map<string, typeof buyL>();
    for (const l of buyL) {
      if (!l.toCode) continue;
      const k = `${l.wh}|${l.toWh}`;
      (bajadas.get(k) ?? bajadas.set(k, []).get(k)!).push(l);
    }
    for (const ls of bajadas.values()) {
      dtos.push({
        warehouse_id: ls[0].wh!, supplier_id: null, source_type: 'branch', source_warehouse_id: ls[0].toWh!,
        notes: `Bajada de compra consolidada ${ls[0].toCode} → ${ls[0].b.code}`,
        lines: ls.map<CreateRequisitionLine>((l) => ({
          product_id: l.r.product_id, source_type: 'branch', source_warehouse_id: l.toWh!,
          suggested_qty: l.qty, final_qty: l.qty, unit_cost: l.b.cc,
        })),
      });
    }
    const trGroups = new Map<string, URow[]>();
    for (const r of tr) { const k = `${r.to_warehouse_id}|${r.from_warehouse_id}`; (trGroups.get(k) ?? trGroups.set(k, []).get(k)!).push(r); }
    for (const rs of trGroups.values()) {
      dtos.push({
        warehouse_id: rs[0].to_warehouse_id!, supplier_id: null, source_type: 'branch', source_warehouse_id: rs[0].from_warehouse_id,
        notes: 'Traspaso CEDIS→sucursal (déficit × cobertura)' + this.unitNote(rs),
        lines: rs.map<CreateRequisitionLine>((r) => ({
          product_id: r.product_id, source_type: 'branch', source_warehouse_id: r.from_warehouse_id,
          suggested_qty: r.qty, final_qty: r.qty, unit_cost: r.unit_cost,
        })),
      });
    }
    if (!dtos.length) return;
    this.saving.set(true);
    let done = 0; const folios: string[] = []; let failed = 0;
    const finish = () => {
      this.saving.set(false);
      if (folios.length) this.toast.add({ severity: 'success', summary: `${folios.length} requisición(es)`, detail: folios.join(', ') });
      if (failed) this.toast.add({ severity: 'error', summary: 'Error parcial', detail: `${failed} no se pudieron crear.` });
      if (folios.length) { this.mode() === 'muerto' ? this.loadDead() : this.loadWorkbook(); }
    };
    dtos.forEach((dto) => {
      this.api.createRequisition(dto).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => { folios.push(r.folio); if (++done === dtos.length) finish(); },
        error: () => { failed++; if (++done === dtos.length) finish(); },
      });
    });
  }

  /** Query del workbook = MISMOS filtros que la tabla en pantalla (group=desglosar/englobar,
   *  proveedor, categoría, búsqueda, cobertura, sucursales, tendencia, sobrestock). Sin page. */
  private currentWbQuery() {
    const iad = this.fIad();
    return {
      supplier_id: this.fSupplier || undefined, brand_id: this.fBrand || undefined, category_id: this.fCategory || undefined, search: this.search.trim() || undefined,
      coverage_days: this.coverage, scope: this.wbScopeNeeded() ? 'needed' : undefined,
      warehouse_ids: this.wbWarehouses.length ? this.wbWarehouses : undefined, group: 'branch',
      iad: iad === 'all' ? undefined : iad, only_overstock: this.wbOnlyOver() || undefined,
    } as const;
  }

  /** "XLSX" = la tabla en pantalla (workbook) en UN archivo unificado: hoja "Todos" (plano) +
   *  una hoja por proveedor. Hereda desglosar/englobar + TODOS los filtros (se re-consulta
   *  server-side sin paginar). Los drills (por sucursal / por producto del acordeón) siguen
   *  usando el pedido editable (flatRows) — ver `exportScope(code, pid)`. */
  exportWorkbook(): void {
    if (!this.wbRows().length) {
      this.toast.add({ severity: 'warn', summary: 'Nada que exportar', detail: 'No hay productos con los filtros actuales.' });
      return;
    }
    this.dl.set(true);
    this.api.exportWorkbookXlsx(this.currentWbQuery())
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (resp) => { this.dl.set(false); saveXlsxResponse(resp, 'pedido.xlsx'); },
        error: () => { this.dl.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo exportar.' }); },
      });
  }

  /** Exporta XLSX del scope editable (compra + traspaso con qty > 0). Drill: code = una sucursal,
   *  pid = un solo producto (desde el acordeón) — mantiene las cantidades editadas. */
  exportScope(code?: string, pid?: string): void {
    // RA-PRO.47 — la compra sale del desglose por sucursal (lo que está en pantalla y se editó);
    // los traspasos siguen saliendo del motor de traspasos, que sí es por almacén.
    const buyL = this.buyLines(pid, code);
    const tr = (pid ? this.urows() : this.flatRows())
      .filter((r) => (!code || r.warehouse_code === code) && (!pid || r.product_id === pid) && r.type === 'traspaso' && r.editable && Number(r.qty) > 0);
    if (!buyL.length && !tr.length) { this.toast.add({ severity: 'warn', summary: 'Nada que exportar' }); return; }
    const lines: PedidoExportLine[] = [
      ...buyL.map<PedidoExportLine>((l) => ({
        warehouse_code: l.b.code, supplier_name: l.r.supplier_name,
        // RA-PRO.48 — el XLSX tiene que decir dónde entregar, que es media instrucción al proveedor.
        deliver_to: l.toCode,
        sku: l.r.sku, nombre: l.r.nombre, abc_class: this.abcOf(l.r.product_id),
        sell_daily: l.b.vta / 30.4, days_cover: this.diasInv(l.r, l.b),
        on_hand: l.b.exis, in_transit: l.r.transito_cajas ?? undefined, suggested_qty: l.b.seed,
        uxc: l.r.uxc, cajas: l.qty, piezas: l.qty * l.r.uxc, unit_cost: l.b.cc, line_cost: l.qty * l.b.cc,
      })),
      ...tr.map<PedidoExportLine>((r) => ({
        warehouse_code: r.warehouse_code, supplier_name: `TRASPASO ← ${r.from_code}`,
        sku: r.sku, nombre: r.nombre, abc_class: r.abc_class,
        sell_daily: r.sell_daily, days_cover: r.cover, deficit: r.deficit || undefined,
        on_hand: r.on_hand, suggested_qty: r.qty,
        uxc: r.uxc, cajas: r.qty, piezas: r.qty * r.uxc, unit_cost: r.unit_cost, line_cost: r.qty * r.unit_cost,
      })),
    ];
    this.dl.set(true);
    const first = buyL[0]?.r ?? tr[0];
    const scopeName = pid ? (first?.nombre || 'producto') : code ? `${code} ${this.nameOf(code)}`.trim() : 'toda la red';
    const fileTag = pid ? (first?.sku || 'producto') : code || 'global';
    this.api.exportPedidoXlsx({ title: `Pedido por sucursal — ${scopeName}`, basis: `cobertura ${this.coverage}d`, multi_warehouse: true, lines })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (resp) => { this.dl.set(false); saveXlsxResponse(resp, `pedido-${fileTag}.xlsx`); },
        error: () => { this.dl.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo exportar.' }); },
      });
  }

  private _mc = 0;
  private _mcReset = false;
  money(v: number | string | null | undefined): string {
    // DIAGNÓSTICO PROD (temporal): /compras/pedido crashea con "Maximum call stack" — una recursión
    // de render que pasa por money(). El volumen normal (p.ej. expand-all) llama money muchas veces
    // pero con stack SHALLOW; la recursión lo llama con stack PROFUNDO. Contamos por tick (reset en
    // microtask) y sólo tras muchas llamadas medimos la profundidad del stack: si es honda, logueamos
    // el contexto (qué modo/cuántas filas/qué valor) y CORTAMOS con throw para no congelar la pestaña.
    if (!this._mcReset) { this._mcReset = true; queueMicrotask(() => { this._mc = 0; this._mcReset = false; }); }
    if (++this._mc > 800) {
      const depth = (new Error().stack || '').split('\n').length;
      if (depth > 300) {
        // eslint-disable-next-line no-console
        console.error('[pedido][RECURSION] money() stack=' + depth + ' frames; arg=', v, {
          mode: this.mode(), flat: this.flatRows().length, disp: this.displayRows().length,
          wb: this.wbRows().length, dead: this.deadRows().length, calls: this._mc,
        });
        throw new Error('[pedido] recursion guard @money depth=' + depth + ' mode=' + this.mode());
      }
    }
    return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  }
}
