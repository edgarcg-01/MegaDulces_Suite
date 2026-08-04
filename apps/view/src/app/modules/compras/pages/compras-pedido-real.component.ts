import { ChangeDetectionStrategy, Component, DestroyRef, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HasUnsavedChanges } from '../../../core/guards/unsaved-changes.guard';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { catchError, of, forkJoin } from 'rxjs';
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
  WorkbookTerritory,
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
          <p class="surf-page-sub">Una fila por producto (venta / existencia / <strong>pedido</strong> por punto de compra). Clic para desplegar su desglose <strong>por sucursal</strong>: <strong>comprar</strong> (venta × cobertura − existencia − tránsito), <strong>traspasar</strong> desde su CEDIS y su <strong>sobrestock</strong> — con cantidad editable. Exporta XLSX o arma la requisición por producto o global.</p>
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
                    [filter]="true" filterBy="label" [virtualScroll]="true" [virtualScrollItemSize]="34"
                    styleClass="pr-sel-wide" ariaLabel="Filtrar por proveedor"></p-select>
          <p-select [options]="categoryOpts()" [(ngModel)]="fCategory" (onChange)="loadWorkbook()"
                    optionLabel="label" optionValue="value" placeholder="Todas las categorías" [showClear]="true"
                    [filter]="true" filterBy="label" styleClass="pr-sel" ariaLabel="Filtrar por categoría"></p-select>
          <button type="button" class="pr-colbtn" [class.pr-colbtn-on]="wbGroup()==='branch'" (click)="toggleGroup()"
                  [attr.aria-pressed]="wbGroup()==='branch'"
                  [title]="wbGroup()==='branch' ? 'Englobar las columnas de venta en una sola (red)' : 'Desglosar las columnas de venta por sucursal'">
            <i class="pi" [ngClass]="wbGroup()==='branch' ? 'pi-arrows-h' : 'pi-table'"></i>
            {{ wbGroup()==='branch' ? 'Englobar columnas' : 'Desglosar por sucursal' }}
          </button>
          @if (wbGroup()==='branch') {
            <p-multiselect [options]="warehouseOpts()" [(ngModel)]="wbWarehouses" (onChange)="loadWorkbook()"
                           optionLabel="label" optionValue="value" placeholder="Todas las sucursales" [showClear]="true"
                           [filter]="true" filterBy="label" [maxSelectedLabels]="2" selectedItemsLabel="{0} sucursales"
                           styleClass="pr-sel" ariaLabel="Sucursales a mostrar como columnas"></p-multiselect>
          }
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
          <div class="pr-wb-scroll">
            <p-table [value]="wbRows()" [loading]="loading()"
                     styleClass="p-datatable-sm pr-table pr-wb" [tableStyle]="wbTableStyle()">
              <ng-template #header>
                <tr>
                  <th rowspan="2" style="min-width:15rem">Producto</th>
                  <th rowspan="2" class="pr-r" title="Piezas por caja · y paquetes por caja si es multipack">Unidad<br/>x caja</th>
                  <th rowspan="2" class="pr-r">Costo/Cja</th>
                  <th rowspan="2" class="pr-r" title="Índice de Aceleración de Demanda (−2..+2): compara el ritmo reciente (30d vs 31-60d) + estacional año-vs-año. ▲ acelera · ═ estable · ▼ desacelera. Señal informativa; no cambia el sugerido.">Tend.</th>
                  <th rowspan="2" class="pr-r" title="Clase XYZ de red (X estable · Y variable · Z errático) — peor caso entre sucursales">XYZ</th>
                  <th rowspan="2" class="pr-r" title="Punto de reorden de red (cajas)">Reorden</th>
                  <th rowspan="2" class="pr-r" title="Máximo de red (cajas)">Máx</th>
                  @for (t of wbTerritories(); track t.code) {
                    <th colspan="3" class="pr-grp-h" [title]="t.code">{{ t.name }}</th>
                  }
                  <th rowspan="2" class="pr-r">Σ Ped.<br/>cajas</th>
                  <th rowspan="2" class="pr-r pr-muted-h">Σ Piezas</th>
                  <th rowspan="2" class="pr-r pr-val">$ Pedido</th>
                  <th rowspan="2" class="pr-r">Valor<br/>venta</th>
                  <th rowspan="2" class="pr-r">Valor<br/>exist.</th>
                </tr>
                <tr class="pr-sub-row">
                  @for (t of wbTerritories(); track t.code) {
                    <th class="pr-r pr-sub-h">Vta</th><th class="pr-r pr-sub-h">Exist.</th><th class="pr-r pr-sub-h pr-ped-h">Pedido</th>
                  }
                </tr>
              </ng-template>
              <ng-template #body let-r>
                <tr class="pr-wb-row" [class.pr-wb-open]="isOpen(r)" (click)="toggleRow(r)" tabindex="0" (keyup.enter)="toggleRow(r)"
                    [attr.aria-expanded]="isOpen(r)" [attr.aria-label]="(isOpen(r) ? 'Cerrar' : 'Abrir') + ' detalle de ' + r.sku">
                  <td><div class="pr-prod"><i class="pi pr-wb-go" [ngClass]="isOpen(r) ? 'pi-angle-down' : 'pi-angle-right'"></i> {{ r.nombre }}</div><div class="pr-prod-meta"><span class="pr-sku">{{ r.sku }}</span> <span class="pr-supp">{{ r.supplier_name || '—' }}</span>@if (abcOf(r.product_id); as a) { <p-tag [value]="a" [severity]="abcSev(a)" styleClass="pr-abc"></p-tag> }@for (t of prodTypes(r.product_id); track t) { <p-tag [value]="typeLabel(t)" [severity]="typeSev(t)" styleClass="pr-abc"></p-tag> }</div></td>
                  <td class="pr-r pr-muted pr-uxc">
                    <div>{{ r.uxc | number:'1.0-0' }} <span class="pr-unit">pz</span></div>
                    @if (r.packs_per_box) { <div class="pr-unit2" [title]="r.packs_per_box + ' paquetes de ' + r.pack_size + ' pz por caja'">{{ r.packs_per_box }} paq × {{ r.pack_size }}</div> }
                  </td>
                  <td class="pr-r pr-muted">{{ money(r.caja_cost) }}</td>
                  <td class="pr-r">
                    @if (r.iad != null) {
                      <p-tag [value]="iadLabel(r)" [severity]="iadSev(r)" styleClass="pr-cov-tag" [title]="iadTitle(r)"></p-tag>
                    } @else { <span class="pr-muted" [title]="iadTitle(r)">—</span> }
                  </td>
                  <td class="pr-r">@if (r.xyz_class) { <span class="pr-mono">{{ r.xyz_class }}</span> } @else { <span class="pr-muted">—</span> }</td>
                  <td class="pr-r pr-muted">{{ r.reorder_cajas != null ? (r.reorder_cajas | number:'1.0-1') : '—' }}</td>
                  <td class="pr-r pr-muted">{{ r.max_cajas != null ? (r.max_cajas | number:'1.0-1') : '—' }}</td>
                  @for (t of wbTerritories(); track t.code) {
                    <td class="pr-r pr-muted">{{ cellVal(r, t.code, 'vta') | number:'1.0-1' }}</td>
                    <td class="pr-r"><p-tag [value]="(cellVal(r, t.code, 'exis') | number:'1.0-1') ?? ''" [severity]="existSev(cellVal(r, t.code, 'exis'), cellVal(r, t.code, 'ped'))" styleClass="pr-cov-tag" [title]="existTitle(cellVal(r, t.code, 'exis'), cellVal(r, t.code, 'ped'))"></p-tag></td>
                    <td class="pr-r pr-ped" [class.pr-ped-on]="cellVal(r, t.code, 'ped') > 0">{{ cellVal(r, t.code, 'ped') | number:'1.0-1' }}</td>
                  }
                  <td class="pr-r pr-strong">{{ r.suma_pedido_cajas | number:'1.0-1' }}</td>
                  <td class="pr-r pr-muted-h">{{ (r.suma_pedido_cajas * r.uxc) | number:'1.0-0' }}</td>
                  <td class="pr-r pr-val pr-strong" [class.pr-ped-on]="r.suma_pedido_cajas > 0">{{ money(r.pedido_valor) }}</td>
                  <td class="pr-r pr-muted">{{ money(r.valor_venta) }}</td>
                  <td class="pr-r pr-muted">{{ money(r.valor_exis) }}</td>
                </tr>
                @if (isOpen(r)) {
                  <tr class="pr-wb-exp">
                    <td [attr.colspan]="wbColCount()">
                      <div class="pr-exp-in">
                        @if (!detailReady()) {
                          <div class="pr-peek-loading"><i class="pi pi-spin pi-spinner"></i> Cargando acciones por sucursal…</div>
                        } @else if (detailRows(r.product_id); as urows) {
                          @if (!urows.length) {
                            <div class="pr-peek-loading">Sin acciones por sucursal para este producto (ni compra, ni traspaso, ni sobrestock con estos filtros).</div>
                          } @else {
                            <div class="pr-ordu" role="group" aria-label="Unidad de pedido">
                              <span class="pr-ordu-lbl">Pedir en:</span>
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
                                  <th class="pr-r" title="Cobertura (compra) · déficit (traspaso) · días en mano (sobrestock)">Señal</th>
                                  <th class="pr-r">Exist.</th><th class="pr-r">Cant. ({{ unitLabelShort(r.product_id) }}) ✎</th><th class="pr-r" title="Equivalente TOTAL en piezas de lo pedido (cajas × piezas por caja). No es la unidad de captura — esa es la columna Cant.">= Piezas</th><th class="pr-r">Costo</th><th class="pr-r">Valor</th>
                                </tr></thead>
                                <tbody>
                                  @for (u of urows; track u.type + ':' + u.warehouse_code) {
                                    <tr [class.pr-row-over]="u.type==='sobre'">
                                      <td><span class="pr-mono">{{ u.warehouse_code }}</span> <span class="pr-peek-terr">{{ nameOf(u.warehouse_code) }}</span></td>
                                      <td class="pr-det-act">
                                        <p-tag [value]="typeLabel(u.type)" [severity]="typeSev(u.type)" styleClass="pr-abc"></p-tag>
                                        @if (u.abc_class) { <p-tag [value]="u.abc_class" [severity]="abcSev(u.abc_class)" styleClass="pr-abc"></p-tag> }
                                        @if (u.type==='traspaso' && u.from_code) { <span class="pr-mono pr-from">← {{ u.from_code }}</span> }
                                        @if (u.type==='comprar' && u.unit_source && u.unit_source !== 'catalog') {
                                          <button type="button" class="pr-unit-btn" (click)="openUnit(u.buy!)" title="Ajustar unidad de venta">
                                            <p-tag [value]="unitLabel(u.unit_source)" [severity]="u.unit_source === 'revisar' ? 'warn' : 'contrast'" styleClass="pr-abc"></p-tag>
                                          </button>
                                        }
                                      </td>
                                      <td class="pr-r">
                                        @if (u.type==='comprar') {
                                          @if (u.cover != null) { <p-tag [value]="(u.cover | number:'1.0-0') + ' d'" [severity]="coverSev(u.cover)" styleClass="pr-cov-tag"></p-tag> } @else { <span class="pr-muted">—</span> }
                                        } @else if (u.type==='traspaso') {
                                          <span class="pr-muted" title="Déficit de la sucursal (cajas)">déf {{ u.deficit | number:'1.0-1' }}</span>
                                        } @else {
                                          @if (u.days_on_hand != null) { <p-tag [value]="(u.days_on_hand | number:'1.0-0') + ' d'" severity="info" styleClass="pr-cov-tag"></p-tag> } @else { <span class="pr-muted">—</span> }
                                        }
                                      </td>
                                      <td class="pr-r"><p-tag [value]="(u.on_hand | number:'1.0-1') ?? ''" [severity]="existSevU(u)" styleClass="pr-cov-tag" [title]="existTitleU(u)"></p-tag></td>
                                      <td class="pr-r">
                                        @if (u.editable) { <input type="number" min="0" step="any" class="pr-qty pr-qty-sm" [ngModel]="dispQty(u)" (ngModelChange)="setDispQty(u, $event)" [attr.aria-label]="'Cantidad de ' + r.sku + ' en ' + u.warehouse_code + ' (' + unitLabelShort(r.product_id) + ')'" /> }
                                        @else { <span class="pr-muted">{{ dispQty(u) | number:'1.0-1' }}</span> }
                                      </td>
                                      <td class="pr-r pr-muted">{{ (u.qty * u.uxc) | number:'1.0-0' }}</td>
                                      <td class="pr-r pr-muted">{{ money(u.unit_cost) }}</td>
                                      <td class="pr-r" [class.pr-strong]="u.type!=='sobre'" [class.pr-over-val]="u.type==='sobre'">{{ money(u.qty * u.unit_cost) }}</td>
                                    </tr>
                                  }
                                </tbody>
                              </table>
                            </div>
                            <div class="pr-exp-actions">
                              <span class="pr-exp-sum">
                                @if (prodBuy(r.product_id) > 0) { <span class="pr-gs-buy">comprar {{ money(prodBuy(r.product_id)) }}</span> }
                                @if (prodTr(r.product_id) > 0) { <span class="pr-gs-tr">· traspaso {{ money(prodTr(r.product_id)) }}</span> }
                                @if (prodOver(r.product_id) > 0) { <span class="pr-gs-over">· sobre {{ money(prodOver(r.product_id)) }}</span> }
                              </span>
                              <span class="pr-bulk-sp"></span>
                              <p-button type="button" label="XLSX del producto" icon="pi pi-file-excel" styleClass="p-button-sm p-button-text" (click)="exportScope(undefined, r.product_id)" [disabled]="dl()"></p-button>
                              <p-button type="button" [label]="saving() ? 'Armando…' : 'Requisición'" icon="pi pi-check" styleClass="p-button-sm" (click)="buildReq(undefined, r.product_id)" [disabled]="saving() || (prodBuy(r.product_id) + prodTr(r.product_id)) <= 0"></p-button>
                            </div>
                          }
                        }
                      </div>
                    </td>
                  </tr>
                }
              </ng-template>
              <ng-template #emptymessage>
                <tr><td [attr.colspan]="wbColCount()" class="pr-empty">
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
          <p class="pr-foot">Una fila por producto. <strong>Vta</strong> = venta 30 días en cajas · <strong>Exist.</strong> = existencia en cajas · <strong>Pedido</strong> = venta diaria × cobertura − existencia − tránsito. Cada bloque es un <strong>punto de compra</strong>: @for (t of wbTerritories(); track t.code) {<span class="pr-mono">{{ t.code }}</span>&nbsp;}. <em>Clic en una fila para desplegar su desglose <strong>por sucursal</strong> (comprar/traspaso/sobrestock, editable) — podés abrir varias a la vez. El botón <strong>Englobar / Desglosar</strong> junta o abre las columnas de venta por sucursal.</em></p>
        }

        @if (wbRows().length) {
          <div class="pr-bulk" role="region" aria-label="Acciones globales">
            @if (totCajas() > 0) {
              <span class="pr-bulk-n">Red (todas las sucursales) · comprar <strong>{{ money(totBuy()) }}</strong> · traspaso <strong>{{ money(totTr()) }}</strong>@if (totOver() > 0) { · <span class="pr-gs-over">sobre {{ money(totOver()) }}</span> }</span>
            } @else {
              <span class="pr-bulk-n">{{ wbTotal() }} productos en la vista</span>
            }
            <span class="pr-bulk-sp"></span>
            <p-button type="button" label="XLSX" icon="pi pi-file-excel" styleClass="p-button-sm" (click)="exportWorkbook()" [disabled]="dl() || !wbRows().length" ariaLabel="Exportar XLSX: hoja Todos + una por proveedor"></p-button>
            <p-button type="button" [label]="saving() ? 'Armando…' : 'Requisiciones (global)'" icon="pi pi-check" styleClass="p-button-sm p-button-text" (click)="buildReq()" [disabled]="saving() || totCajas() <= 0"></p-button>
          </div>
        }

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
            <tr><th style="min-width:16rem">Producto</th><th style="width:5rem">Almacén</th><th class="pr-r">Existencia</th>
              <th class="pr-r">Costo</th><th class="pr-r pr-val">Inmovilizado</th><th>Última actividad</th><th>Proveedor</th></tr>
          </ng-template>
          <ng-template #body let-r>
            <tr>
              <td><div class="pr-prod">{{ r.nombre }}</div><div class="pr-sku">{{ r.sku }}</div></td>
              <td class="pr-mono pr-muted">{{ r.warehouse_code }}</td>
              <td class="pr-r pr-muted">{{ r.on_hand | number:'1.0-0' }}</td>
              <td class="pr-r pr-muted">{{ money(r.unit_cost) }}</td>
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
  wbTerritories = signal<WorkbookTerritory[]>([]);   // puntos de compra (columnas dinámicas)
  wbTotals = signal<{ pedido: number; venta: number; exis: number }>({ pedido: 0, venta: 0, exis: 0 });
  wbTotal = signal(0);
  // RA-PRO.36.2 — paginación SERVER-SIDE (20/página): la matriz pedía 1000 filas + 3 motores en
  // paralelo → saturaba Railway. Ahora trae solo la página; los filtros (pedido/IAD/sobrestock) van
  // server-side para filtrar TODO el dataset, no la página cargada.
  readonly wbFirst = signal(0);
  readonly wbPageSize = signal(20);
  wbScopeNeeded = signal(false);
  wbOnlyOver = signal(false);   // RA-PRO.33 — filtrar a productos CON sobrestock (capital inmovilizado)
  wbGroup = signal<'branch' | 'general'>('general');  // default: 1 columna agregada (red). "Por sucursal" = opt-in
  wbWarehouses: string[] = [];                          // sucursales elegidas (vacío = todas con stock)
  // Ancho dinámico según nº de territorios (3 fijas + 3 por territorio + 4 de cierre). computed →
  // referencia estable entre cargas (evita ExpressionChanged).
  wbTableStyle = computed(() => ({ 'min-width': (40 + this.wbTerritories().length * 13) + 'rem' }));
  wbColCount = computed(() => 7 + this.wbTerritories().length * 3 + 5);
  /** Valor de una celda territorio×métrica (0 si el SKU no tiene datos en ese punto de compra). */
  cellVal(r: WorkbookRow, code: string, key: 'vta' | 'exis' | 'ped'): number { return r.cells?.[code]?.[key] ?? 0; }
  /** ABC por producto (del motor por-sucursal) → etiqueta en el renglón del Excel. */
  private readonly abcMap = computed(() => {
    const m = new Map<string, string>();
    for (const u of this.urows()) if (u.abc_class && !m.has(u.product_id)) m.set(u.product_id, u.abc_class);
    return m;
  });
  abcOf(pid: string): string | null { return this.abcMap().get(pid) ?? null; }
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
  /** Filas por-sucursal (comprar/traspaso/sobre) del producto, ordenadas acción→sucursal. */
  detailRows(pid: string): URow[] {
    this.tickN();
    return this.urows()
      .filter((u) => u.product_id === pid)
      .sort((a, b) => this.typeOrder[a.type] - this.typeOrder[b.type] || a.warehouse_code.localeCompare(b.warehouse_code));
  }
  prodBuy(pid: string): number { return this.detailRows(pid).filter((u) => u.type === 'comprar').reduce((s, u) => s + u.qty * u.unit_cost, 0); }
  prodTr(pid: string): number { return this.detailRows(pid).filter((u) => u.type === 'traspaso').reduce((s, u) => s + u.qty * u.unit_cost, 0); }
  prodOver(pid: string): number { return this.detailRows(pid).filter((u) => u.type === 'sobre').reduce((s, u) => s + u.qty * u.unit_cost, 0); }

  toggleGroup(): void { this.wbGroup.set(this.wbGroup() === 'branch' ? 'general' : 'branch'); this.loadWorkbook(); }

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
  fWarehouse: string | null = null;
  fCategory: string | null = null;                                    // RA-PRO.12 — categoría de compra
  categoryOpts = signal<{ label: string; value: string }[]>([]);
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
  warehouseOpts = computed(() => (this.filters()?.warehouses ?? []).map((w) => ({ label: `${w.code} · ${w.name}`, value: w.id })));
  private readonly whName = computed(() => {
    const m = new Map<string, string>();
    for (const w of this.filters()?.warehouses ?? []) m.set(w.code, w.name);
    return m;
  });
  nameOf(code: string): string { return this.whName().get(code) || (code === '—' ? 'Sin almacén / red' : ''); }

  ngOnInit(): void {
    this.api.filters().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (f) => this.filters.set(f), error: () => {} });
    this.api.listCategories().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (cs) => this.categoryOpts.set(cs.map((c) => ({ label: c.name, value: c.id }))), error: () => {},
    });
    this.restoreFilters();
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
        mode: this.mode(), fSupplier: this.fSupplier, fCategory: this.fCategory, fWarehouse: this.fWarehouse,
        search: this.search, coverage: this.coverage, cBuy: this.cBuy(), cTr: this.cTr(), cOver: this.cOver(),
        wbGroup: this.wbGroup(), wbWarehouses: this.wbWarehouses, wbScopeNeeded: this.wbScopeNeeded(),
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
      if ('fCategory' in s) this.fCategory = s.fCategory;
      if ('fWarehouse' in s) this.fWarehouse = s.fWarehouse;
      if (typeof s.search === 'string') this.search = s.search;
      if (typeof s.coverage === 'number') this.coverage = s.coverage;
      if (typeof s.cBuy === 'boolean') this.cBuy.set(s.cBuy);
      if (typeof s.cTr === 'boolean') this.cTr.set(s.cTr);
      if (typeof s.cOver === 'boolean') this.cOver.set(s.cOver);
      if (s.wbGroup === 'branch' || s.wbGroup === 'general') this.wbGroup.set(s.wbGroup);
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
    if (reloadEnrichment) this.detailReady.set(false);
    const iad = this.fIad();
    this.api.workbook({
      supplier_id: this.fSupplier || undefined, category_id: this.fCategory || undefined, search: this.search.trim() || undefined,
      coverage_days: this.coverage, scope: this.wbScopeNeeded() ? 'needed' : undefined,
      warehouse_ids: this.wbWarehouses.length ? this.wbWarehouses : undefined, group: this.wbGroup(),
      iad: iad === 'all' ? undefined : iad,
      only_overstock: this.wbOnlyOver() || undefined,
      page: Math.floor(this.wbFirst() / this.wbPageSize()) + 1, pageSize: this.wbPageSize(),
    }).pipe(catchError(() => of(null as WorkbookResponse | null)), takeUntilDestroyed(this.destroyRef))
      .subscribe((r) => {
        this.loading.set(false);
        if (!r) { this.error.set(true); this.wbRows.set([]); this.wbTerritories.set([]); return; }
        this.wbRows.set(r.rows); this.wbTerritories.set(r.territories ?? []); this.wbTotals.set(r.totals); this.wbTotal.set(r.total);
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
    return forkJoin({
      buy: this.api.purchaseSuggestion({ supplier_id: sup, category_id: cat, warehouse_id: wh, scope: 'needed', search: s, coverage_days: this.coverage, pageSize: 1000 })
        .pipe(catchError(() => of(null as PurchaseSuggestionResponse | null))),
      tr: this.api.transferSuggestion({ warehouse_id: wh, supplier_id: sup, category_id: cat, search: s, coverage_days: this.coverage, pageSize: 1000 })
        .pipe(catchError(() => of(null as TransferSuggestionResponse | null))),
      ov: this.api.overstock({ warehouse_id: wh, supplier_id: sup, category_id: cat, search: s, over_days: 90, pageSize: 1000 })
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
  /** Lista plana filtrada por chips y ORDENADA por sucursal (para el rowGroup subheader). */
  flatRows = computed<URow[]>(() => {
    const show = { comprar: this.cBuy(), traspaso: this.cTr(), sobre: this.cOver() } as Record<UType, boolean>;
    return this.urows()
      .filter((r) => show[r.type])
      .sort((a, b) => a.warehouse_code.localeCompare(b.warehouse_code) || this.typeOrder[a.type] - this.typeOrder[b.type] || (b.qty * b.unit_cost) - (a.qty * a.unit_cost));
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
  totBuy = computed(() => { let s = 0; this.subs().forEach((g) => (s += g.buy)); return s; });
  totTr = computed(() => { let s = 0; this.subs().forEach((g) => (s += g.tr)); return s; });
  totOver = computed(() => { let s = 0; this.subs().forEach((g) => (s += g.over)); return s; });
  totCajas = computed(() => { let s = 0; this.subs().forEach((g) => (s += g.buyCj + g.trCj)); return s; });

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
      sku: r.sku, nombre: r.nombre, on_hand: Math.round(Number(r.on_hand) || 0),
      unit_cost: Number(r.unit_cost) || 0, line_cost: Number(r.dead_value) || 0,
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

  buildReq(code?: string, pid?: string): void {
    const scope = (pid ? this.urows() : this.flatRows()).filter((r) => (!code || r.warehouse_code === code) && (!pid || r.product_id === pid) && r.editable && Number(r.qty) > 0);
    const buy = scope.filter((r) => r.type === 'comprar');
    const tr = scope.filter((r) => r.type === 'traspaso');
    if (!buy.length && !tr.length) { this.toast.add({ severity: 'warn', summary: 'Nada que armar', detail: 'No hay cantidades > 0 en el scope.' }); return; }

    const dtos: CreateRequisitionDto[] = [];
    const buyGroups = new Map<string, URow[]>();
    for (const r of buy) { const k = `${r.supplier_id || 'none'}|${r.warehouse_id || 'none'}`; (buyGroups.get(k) ?? buyGroups.set(k, []).get(k)!).push(r); }
    for (const rs of buyGroups.values()) {
      dtos.push({
        warehouse_id: rs[0].warehouse_id!, supplier_id: rs[0].supplier_id || null, source_type: 'supplier',
        notes: 'Demand-driven (venta × cobertura) — por sucursal' + this.unitNote(rs),
        lines: rs.map<CreateRequisitionLine>((r) => ({
          product_id: r.product_id, supplier_id: r.supplier_id || null, source_type: 'supplier',
          on_hand: r.on_hand, suggested_qty: r.qty, final_qty: r.qty, unit_cost: r.unit_cost,
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
      supplier_id: this.fSupplier || undefined, category_id: this.fCategory || undefined, search: this.search.trim() || undefined,
      coverage_days: this.coverage, scope: this.wbScopeNeeded() ? 'needed' : undefined,
      warehouse_ids: this.wbWarehouses.length ? this.wbWarehouses : undefined, group: this.wbGroup(),
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
    const scope = (pid ? this.urows() : this.flatRows()).filter((r) => (!code || r.warehouse_code === code) && (!pid || r.product_id === pid) && r.editable && Number(r.qty) > 0);
    if (!scope.length) { this.toast.add({ severity: 'warn', summary: 'Nada que exportar' }); return; }
    const lines: PedidoExportLine[] = scope.map((r) => ({
      warehouse_code: r.warehouse_code,
      supplier_name: r.type === 'traspaso' ? `TRASPASO ← ${r.from_code}` : r.supplier_name,
      sku: r.sku, nombre: r.nombre, abc_class: r.abc_class,
      sales_rank: r.buy?.sales_rank ?? undefined,
      monthly_revenue: r.buy?.sell_month_mxn ?? undefined,
      sell_daily: r.sell_daily, days_cover: r.cover, deficit: r.deficit || undefined,
      on_hand: r.on_hand, in_transit: r.buy?.in_transit_units ?? undefined, suggested_qty: r.qty,
      uxc: r.uxc, cajas: r.qty, piezas: r.qty * r.uxc, unit_cost: r.unit_cost, line_cost: r.qty * r.unit_cost,
    }));
    this.dl.set(true);
    const scopeName = pid ? (scope[0]?.nombre || 'producto') : code ? `${code} ${this.nameOf(code)}`.trim() : 'toda la red';
    const fileTag = pid ? (scope[0]?.sku || 'producto') : code || 'global';
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
