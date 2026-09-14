import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, of } from 'rxjs';
import { catchError, switchMap, tap } from 'rxjs/operators';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { DatePickerModule } from 'primeng/datepicker';
import { TabsModule } from 'primeng/tabs';
import { ToastModule } from 'primeng/toast';
import { AutoCompleteModule, AutoCompleteCompleteEvent, AutoCompleteSelectEvent } from 'primeng/autocomplete';
import { ChartModule } from 'primeng/chart';
import { CheckboxModule } from 'primeng/checkbox';
import { MessageService } from 'primeng/api';

import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import { ThemeService } from '../../../core/services/theme.service';
import { DATE_PRESET_OPTIONS, datePresetRange } from '../../../shared/util/date-presets.util';
import { makeDebouncedSearch } from '../../../shared/util/debounced-search.util';
import { makeLazyLoad, LazyTableEvent } from '../../../shared/util/lazy-table.util';
import { money, moneyShort } from '../../../shared/util/money.util';
import {
  AlmacenBiService, BiFilters, BiZoneGroup, BiWarehouseOpt, BiProductOpt, BiSummary,
  BiMovementRow, BiField, BiFilterParams, BiUnitProvenance,
} from '../almacen-bi.service';

/** Rótulo del bloque colapsado Sucursal/Almacén: en este modelo son la MISMA fila. */
interface WhOpt extends BiWarehouseOpt { zone_label: string }

const ISO = (d: Date) => d.toISOString().slice(0, 10);
/**
 * WMS-BI.2 (2026-09-15) — pedido explícito del usuario: este orden y este set de columnas van
 * TODAS visibles por default (no una selección recortada), calcado del que dictó en la revisión.
 */
const DEFAULT_MOV_COLS = [
  'doc_date', 'hora', 'zone_name', 'warehouse_code', 'almacen', 'canal', 'movement_kind', 'tipo_operacion', 'movement_label',
  'doc_code', 'folio', 'vendedor', 'sku', 'product_name', 'linea_producto', 'tipo_producto', 'grupo_producto',
  'qty', 'unidad_operacion', 'unidad_base', 'importe_costo', 'importe_venta',
  'iva_valor', 'ieps_valor', 'venta_neta',
];
const DEFAULT_EXPLORE_FIELDS = [
  'doc_date', 'hora', 'zone_name', 'warehouse_code', 'almacen', 'canal', 'movement_kind_label', 'tipo_operacion', 'movement_label',
  'vendedor', 'sku', 'product_name', 'linea_producto', 'tipo_producto', 'grupo_producto', 'qty', 'unidad_operacion', 'unidad_base',
];

@Component({
  selector: 'app-almacen-analisis-bi',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, TableModule, SelectModule, MultiSelectModule,
    DatePickerModule, TabsModule, ToastModule, AutoCompleteModule, ChartModule, CheckboxModule,
  ],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Análisis BI · Almacén</h1>
          <p class="surf-page-sub">
            @if (filters()?.movements_as_of?.max_doc_date) {
              Movimientos hasta {{ filters()!.movements_as_of.max_doc_date }} · existencia y costo en vivo (derivado del ODS)
            } @else {
              Existencia y costo en vivo (derivado del ODS) · sin movimientos importados en este entorno
            }
          </p>
        </div>
        <div class="abi-head-actions">
          <span class="abi-updated">Consultado {{ lastQueried() | date:'HH:mm:ss' }}</span>
          <button pButton type="button" class="p-button-outlined p-button-sm" (click)="refresh()" [loading]="loadingAny()">
            <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span> Actualizar
          </button>
          <button pButton type="button" class="p-button-outlined p-button-sm" (click)="exportCurrent()" [disabled]="activeTab() === 'resumen'">
            <span class="p-button-icon p-button-icon-left pi pi-download" aria-hidden="true"></span> Exportar
          </button>
        </div>
      </header>

      <!-- ── Filtros ─────────────────────────────────────────────────────── -->
      <div class="abi-filters">
        <div class="abi-filter-row">
          <p-select [options]="periodOpts" [ngModel]="periodPreset()" (ngModelChange)="periodPreset.set($event)" optionLabel="label" optionValue="value"
                    placeholder="Periodo" styleClass="abi-fld"></p-select>
          @if (periodPreset() === 'custom') {
            <p-datepicker [ngModel]="customFrom()" (ngModelChange)="customFrom.set($event)" placeholder="Desde" dateFormat="yy-mm-dd" [showIcon]="true" appendTo="body" styleClass="abi-fld"></p-datepicker>
            <p-datepicker [ngModel]="customTo()" (ngModelChange)="customTo.set($event)" placeholder="Hasta" dateFormat="yy-mm-dd" [showIcon]="true" appendTo="body" styleClass="abi-fld"></p-datepicker>
          }
          <p-multiselect [options]="zoneOpts()" [ngModel]="selectedZoneIds()" (ngModelChange)="selectedZoneIds.set($event)" optionLabel="label" optionValue="value"
                          placeholder="Zona" [showToggleAll]="false" styleClass="abi-fld" display="chip"></p-multiselect>
          <p-multiselect [options]="warehouseOptsFiltered()" [ngModel]="selectedWarehouseIds()" (ngModelChange)="selectedWarehouseIds.set($event)" optionLabel="label" optionValue="value"
                          placeholder="Almacén" [showToggleAll]="false" styleClass="abi-fld" display="chip"></p-multiselect>
          <p-autocomplete [(ngModel)]="selectedProduct" [suggestions]="productSuggestions()" (completeMethod)="onProductSearch($event)"
                           (onSelect)="onProductSelect($event)" (onClear)="selectedProductId.set(null)"
                           optionLabel="name" [delay]="250" [minQueryLength]="2" [showClear]="true"
                           placeholder="Buscar producto (código o nombre)" appendTo="body" styleClass="abi-fld abi-fld-wide">
            <ng-template let-p #item>
              <div class="abi-ac-item">
                <span>{{ p.name }}</span>
                @if (p.sku) { <code class="abi-ac-sku">{{ p.sku }}</code> }
              </div>
            </ng-template>
            <ng-template #empty><div class="abi-ac-empty">Sin coincidencias</div></ng-template>
          </p-autocomplete>
          <p-select [options]="movKindOpts" [ngModel]="movementKind()" (ngModelChange)="movementKind.set($event)" optionLabel="label" optionValue="value"
                    placeholder="Tipo de movimiento" styleClass="abi-fld"></p-select>
        </div>
        <div class="abi-filter-actions">
          <button pButton type="button" class="p-button-sm" (click)="applyFilters()">Aplicar filtros</button>
          <button pButton type="button" class="p-button-text p-button-sm" (click)="clearFilters()">Limpiar</button>
          @if (scopeNote()) { <span class="abi-scope-note"><i class="pi pi-shield" aria-hidden="true"></i> {{ scopeNote() }}</span> }
        </div>
      </div>

      <!-- ── Pestañas ────────────────────────────────────────────────────── -->
      <p-tabs [value]="activeTab()" (valueChange)="onTab($any($event))" styleClass="abi-tabs">
        <p-tablist>
          <p-tab value="resumen"><i class="pi pi-chart-pie" aria-hidden="true"></i> Resumen</p-tab>
          <p-tab value="movimientos"><i class="pi pi-list" aria-hidden="true"></i> Movimientos</p-tab>
          <p-tab value="explorar"><i class="pi pi-table" aria-hidden="true"></i> Explorar datos</p-tab>
        </p-tablist>
        <p-tabpanels>

        <!-- ═══════════════════════ RESUMEN ═══════════════════════ -->
        <p-tabpanel value="resumen">
          @if (summaryLoading()) {
            <div class="abi-skeleton">Cargando resumen…</div>
          } @else if (summaryError()) {
            <div class="abi-error"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ summaryError() }}
              <button pButton type="button" class="p-button-text p-button-sm" (click)="loadSummary()">Reintentar</button></div>
          } @else if (summary(); as s) {
            <div class="abi-kpis">
              <div class="abi-kpi">
                <span class="abi-kpi-l">Valor de inventario · costo de catálogo</span>
                <span class="abi-kpi-n">{{ s.inventory.valor_catalogo != null ? money(s.inventory.valor_catalogo) : 'No disponible' }}</span>
                <span class="abi-kpi-sub">Corte: hoy · {{ s.inventory.sku_en_scope != null ? s.inventory.sku_en_scope + ' SKU en tu alcance' : 'conteo no disponible' }}</span>
              </div>
              <div class="abi-kpi">
                <span class="abi-kpi-l">Valor de inventario · costo verificado (ERP)</span>
                @if (s.inventory.erp_cost_available) {
                  <span class="abi-kpi-n">{{ s.inventory.valor_erp_verificado != null ? money(s.inventory.valor_erp_verificado) : 'No disponible' }}</span>
                  <span class="abi-kpi-sub">Cobertura: {{ s.inventory.cobertura_testigo_pct != null ? s.inventory.cobertura_testigo_pct + '%' : '—' }} del inventario en scope</span>
                } @else {
                  <span class="abi-kpi-n abi-na">No disponible</span>
                  <span class="abi-kpi-sub abi-na-reason" [title]="s.inventory.unavailable_reason || ''">Falta el resolvedor de costo del ERP en este entorno</span>
                }
              </div>
              <div class="abi-kpi">
                <span class="abi-kpi-l">Diferencia (mismo subconjunto)</span>
                <span class="abi-kpi-n" [class.abi-bad]="(s.inventory.diferencia||0) < 0" [class.abi-ok]="(s.inventory.diferencia||0) > 0">
                  {{ s.inventory.diferencia != null ? money(s.inventory.diferencia) : 'No disponible' }}
                </span>
                <span class="abi-kpi-sub">ERP verificado − catálogo, sólo SKU con testigo</span>
              </div>
              <div class="abi-kpi">
                <span class="abi-kpi-l">Movimientos de entrada</span>
                <span class="abi-kpi-n abi-ok">{{ s.movements.entradas_lineas | number }}</span>
                <span class="abi-kpi-sub">líneas del periodo{{ !s.movements.covers_all_scope ? ' — sólo sucursales Kepler' : '' }}</span>
              </div>
              <div class="abi-kpi">
                <span class="abi-kpi-l">Movimientos de salida</span>
                <span class="abi-kpi-n abi-bad">{{ s.movements.salidas_lineas | number }}</span>
                <span class="abi-kpi-sub">líneas del periodo{{ !s.movements.covers_all_scope ? ' — sólo sucursales Kepler' : '' }}</span>
              </div>
              <div class="abi-kpi">
                <span class="abi-kpi-l">Productos con movimiento</span>
                <span class="abi-kpi-n">{{ s.movements.productos_con_movimiento | number }}</span>
                <span class="abi-kpi-sub">SKU distintos en el periodo</span>
              </div>
            </div>

            @if (!s.movements.covers_all_scope) {
              <div class="abi-banner">
                <i class="pi pi-info-circle" aria-hidden="true"></i>
                El Diario de Movimientos sólo cubre sucursales Kepler (01-06). Morelia (MD-30/MD-32) y el CEDIS todavía no tienen este feed —
                sus conteos de entradas/salidas no están incluidos arriba, aunque sí su valor de inventario.
              </div>
            }

            <div class="abi-charts">
              <div class="abi-chart-card">
                <h3>Entradas y salidas por día <span class="abi-chart-unit">(número de movimientos)</span></h3>
                @if (s.movements.daily_series.length) {
                  <p-chart type="bar" [data]="dailyChartData()" [options]="dailyChartOpts()" height="260px"></p-chart>
                } @else {
                  <div class="abi-empty-inline">Sin movimientos en el periodo seleccionado.</div>
                }
              </div>
              <div class="abi-chart-card">
                <h3>Top productos por salida <span class="abi-chart-unit">(valor a costo estándar, MXN)</span></h3>
                @if (s.movements.top_salida_valor.length) {
                  <p-chart type="bar" [data]="topSalidaChartData()" [options]="topSalidaChartOpts()" height="260px"></p-chart>
                } @else {
                  <div class="abi-empty-inline">Sin salidas en el periodo seleccionado.</div>
                }
              </div>
            </div>

            <div class="abi-section">
              <h3>Mayor desviación de costo (catálogo vs. ERP verificado)</h3>
              @if (!s.cost_deviation.available) {
                <div class="abi-empty-inline" [title]="s.cost_deviation.unavailable_reason || ''">
                  No disponible: falta el resolvedor de costo del ERP en este entorno.
                </div>
              } @else if (!s.cost_deviation.rows.length) {
                <div class="abi-empty-inline">Sin desviaciones para los SKU en tu alcance.</div>
              } @else {
                <p-table [value]="s.cost_deviation.rows" styleClass="p-datatable-sm surf-table" [scrollable]="true" scrollHeight="360px">
                  <ng-template #header>
                    <tr><th scope="col">Almacén</th><th scope="col">Producto</th><th scope="col" class="num">Costo catálogo</th>
                      <th scope="col" class="num">Costo ERP</th><th scope="col" class="num">Diferencia</th><th scope="col" class="num">%</th></tr>
                  </ng-template>
                  <ng-template #body let-r>
                    <tr (click)="openMovementsFor(r)" style="cursor:pointer">
                      <td class="abi-mono">{{ r.warehouse_code }}</td>
                      <td>{{ r.product_name }} <code class="abi-mono">{{ r.sku }}</code></td>
                      <td class="num">{{ r.costo_catalogo != null ? money(r.costo_catalogo) : 'No disponible' }}</td>
                      <td class="num">{{ r.costo_erp != null ? money(r.costo_erp) : 'No disponible' }}</td>
                      <td class="num" [class.abi-bad]="r.diferencia < 0" [class.abi-ok]="r.diferencia > 0">{{ r.diferencia != null ? money(r.diferencia) : '—' }}</td>
                      <td class="num">{{ r.diferencia_pct != null ? (r.diferencia_pct + '%') : '—' }}</td>
                    </tr>
                  </ng-template>
                </p-table>
              }
            </div>
          }
        </p-tabpanel>

        <!-- ═══════════════════════ MOVIMIENTOS ═══════════════════════ -->
        <p-tabpanel value="movimientos">
          <div class="abi-mov-toolbar">
            <p-multiselect [options]="movColumnOpts" [ngModel]="visibleMovCols()" (ngModelChange)="visibleMovCols.set($event)" optionLabel="label" optionValue="key"
                            [optionDisabled]="'disabled'" placeholder="Columnas" styleClass="abi-fld" display="chip"></p-multiselect>
          </div>
          <p-table [value]="movRows()" [loading]="movLoading()" [lazy]="true" (onLazyLoad)="onMovLazyLoad($any($event))"
                    [paginator]="true" [rows]="movPageSize()" [totalRecords]="movTotal()" [rowsPerPageOptions]="[25,50,100,200]"
                    styleClass="p-datatable-sm surf-table surf-table--zebra" [scrollable]="true" scrollHeight="flex">
            <ng-template #header>
              <tr>
                @if (colOn('doc_date')) { <th scope="col" pSortableColumn="doc_date">Fecha <p-sorticon field="doc_date" /></th> }
                @if (colOn('hora')) { <th scope="col">Hora</th> }
                @if (colOn('zone_name')) { <th scope="col">Zona</th> }
                @if (colOn('warehouse_code')) { <th scope="col">Sucursal</th> }
                @if (colOn('almacen')) { <th scope="col">Almacén</th> }
                @if (colOn('canal')) { <th scope="col">Canal</th> }
                @if (colOn('movement_kind')) { <th scope="col">Tipo</th> }
                @if (colOn('tipo_operacion')) { <th scope="col">Tipo de operación</th> }
                @if (colOn('movement_label')) { <th scope="col">Documento</th> }
                @if (colOn('doc_code')) { <th scope="col">Código doc.</th> }
                @if (colOn('folio')) { <th scope="col">Folio</th> }
                @if (colOn('vendedor')) { <th scope="col">Vendedor</th> }
                @if (colOn('sku')) { <th scope="col">Código</th> }
                @if (colOn('product_name')) { <th scope="col">Producto</th> }
                @if (colOn('linea_producto')) { <th scope="col">Línea</th> }
                @if (colOn('tipo_producto')) { <th scope="col">Tipo producto</th> }
                @if (colOn('grupo_producto')) { <th scope="col">Grupo</th> }
                @if (colOn('qty')) { <th scope="col" class="num" pSortableColumn="qty">Cantidad <p-sorticon field="qty" /></th> }
                @if (colOn('unidad_operacion')) { <th scope="col">Unidad operación</th> }
                @if (colOn('unidad_base')) { <th scope="col">Unidad base</th> }
                @if (colOn('signed_qty')) { <th scope="col" class="num">Efecto en inventario</th> }
                @if (colOn('unit_cost')) { <th scope="col" class="num">Costo del movimiento</th> }
                @if (colOn('amount')) { <th scope="col" class="num" pSortableColumn="amount">Importe <p-sorticon field="amount" /></th> }
                @if (colOn('importe_costo')) { <th scope="col" class="num">Importe costo</th> }
                @if (colOn('importe_venta')) { <th scope="col" class="num">Importe venta</th> }
                @if (colOn('iva_valor')) { <th scope="col" class="num">IVA valor</th> }
                @if (colOn('ieps_valor')) { <th scope="col" class="num">IEPS valor</th> }
                @if (colOn('venta_neta')) { <th scope="col" class="num">Venta neta</th> }
                @if (colOn('cost_base_hoy')) { <th scope="col" class="num">Costo catálogo (hoy)</th> }
                @if (colOn('source_system')) { <th scope="col">Sistema</th> }
              </tr>
            </ng-template>
            <ng-template #body let-r>
              <!-- [WMS-BI.4.7] El (click) vive en el FOLIO, no en el <tr>: con toda la fila
                   clicable, seleccionar el texto de una celda para copiarlo abría una pestaña. -->
              <tr class="abi-mov-row">
                @if (colOn('doc_date')) { <td>{{ r.doc_date }}</td> }
                @if (colOn('hora')) { <td class="abi-mono">{{ r.hora || 'No disponible' }}</td> }
                @if (colOn('zone_name')) { <td>{{ r.zone_name || '—' }}</td> }
                @if (colOn('warehouse_code')) { <td class="abi-mono">{{ r.warehouse_code }}</td> }
                @if (colOn('almacen')) { <td [title]="'Ajustes genéricos hoy — sin motivo capturado en Kepler'">{{ r.almacen }}</td> }
                @if (colOn('canal')) { <td [title]="'Sólo aplica en documentos de venta'">{{ r.canal || 'No disponible' }}</td> }
                @if (colOn('movement_kind')) { <td [class.abi-ok]="r.movement_kind === 'entrada'" [class.abi-bad]="r.movement_kind === 'salida'">{{ r.movement_kind === 'entrada' ? 'Entrada' : r.movement_kind === 'salida' ? 'Salida' : 'Informativo' }}</td> }
                @if (colOn('tipo_operacion')) { <td>{{ r.tipo_operacion }}</td> }
                @if (colOn('movement_label')) { <td>{{ r.movement_label }}</td> }
                @if (colOn('doc_code')) { <td class="abi-mono">{{ r.doc_code }}</td> }
                @if (colOn('folio')) {
                  <td class="abi-mono">
                    <button type="button" class="abi-folio-btn" (click)="openDocument(r)"
                            [attr.aria-label]="'Abrir documento ' + r.folio">{{ r.folio }}</button>
                  </td>
                }
                @if (colOn('vendedor')) { <td [title]="'Sólo aplica en documentos de venta'">{{ r.vendedor || 'No disponible' }}</td> }
                @if (colOn('sku')) { <td class="abi-mono">{{ r.sku || '—' }}</td> }
                @if (colOn('product_name')) { <td>{{ r.product_name }}</td> }
                @if (colOn('linea_producto')) { <td>{{ r.linea_producto || 'No disponible' }}</td> }
                @if (colOn('tipo_producto')) { <td>{{ r.tipo_producto || 'No disponible' }}</td> }
                @if (colOn('grupo_producto')) { <td>{{ r.grupo_producto || 'No disponible' }}</td> }
                @if (colOn('qty')) { <td class="num">{{ r.qty | number:'1.0-3' }}</td> }
                @if (colOn('unidad_operacion')) { <td class="abi-mono">{{ r.unidad_operacion || 'No disponible' }}</td> }
                @if (colOn('unidad_base')) { <td class="abi-mono">{{ r.unidad_base || 'No disponible' }}</td> }
                @if (colOn('signed_qty')) { <td class="num" [class.abi-ok]="r.signed_qty > 0" [class.abi-bad]="r.signed_qty < 0">{{ r.signed_qty > 0 ? '+' : '' }}{{ r.signed_qty | number:'1.0-3' }}</td> }
                @if (colOn('unit_cost')) { <td class="num">{{ r.unit_cost != null ? money(r.unit_cost) : 'No disponible' }}</td> }
                @if (colOn('amount')) { <td class="num">{{ r.amount != null ? money(r.amount) : 'No disponible' }}</td> }
                @if (colOn('importe_costo')) { <td class="num">{{ r.importe_costo != null ? money(r.importe_costo) : 'No aplica' }}</td> }
                @if (colOn('importe_venta')) { <td class="num">{{ r.importe_venta != null ? money(r.importe_venta) : 'No aplica' }}</td> }
                @if (colOn('iva_valor')) { <td class="num">{{ r.iva_valor != null ? money(r.iva_valor) : 'No disponible' }}</td> }
                @if (colOn('ieps_valor')) { <td class="num">{{ r.ieps_valor != null ? money(r.ieps_valor) : 'No disponible' }}</td> }
                @if (colOn('venta_neta')) { <td class="num">{{ r.venta_neta != null ? money(r.venta_neta) : 'No disponible' }}</td> }
                @if (colOn('cost_base_hoy')) { <td class="num">{{ r.cost_base_hoy != null ? money(r.cost_base_hoy) : 'No disponible' }}</td> }
                @if (colOn('source_system')) { <td>Kepler</td> }
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td [attr.colspan]="visibleMovCols().length" class="comm-empty-cell">
                <div class="comm-empty">
                  <div class="comm-empty-icon"><i class="pi pi-inbox" aria-hidden="true"></i></div>
                  <h3>Sin movimientos</h3>
                  <p>No hay líneas para los filtros aplicados en las sucursales Kepler de tu alcance.</p>
                </div>
              </td></tr>
            </ng-template>
          </p-table>
          @if (unitProvenanceNota(); as nota) {
            <p class="abi-unavailable-note"><i class="pi pi-clock" aria-hidden="true"></i> {{ nota }}</p>
          }
          <p class="abi-unavailable-note">
            <i class="pi pi-info-circle" aria-hidden="true"></i>
            "Almacén" muestra siempre <strong>Disponible</strong>: los ajustes de inventario en Kepler todavía no capturan un motivo
            (daño/caducidad) por línea — decisión del negocio, no un dato omitido. "Unidad operación", "Hora" y la desviación de costo
            por línea pueden faltar en documentos donde Kepler no lo registró (ver <em>Explorar datos</em> para el detalle).
          </p>
        </p-tabpanel>

        <!-- ═══════════════════════ EXPLORAR DATOS ═══════════════════════ -->
        <p-tabpanel value="explorar">
          <div class="abi-explore-layout">
            <aside class="abi-explore-fields">
              @for (group of fieldGroups(); track group.name) {
                <div class="abi-fg">
                  <h4>{{ group.name }}</h4>
                  @for (f of group.fields; track f.key) {
                    <label class="abi-fg-item" [class.abi-fg-disabled]="!f.available" [title]="f.reason || ''">
                      <p-checkbox [binary]="true" [ngModel]="isFieldSelected(f.key)" (ngModelChange)="toggleField(f.key)" [disabled]="!f.available"></p-checkbox>
                      <span>{{ f.label }}</span>
                      @if (!f.available) { <i class="pi pi-lock" aria-hidden="true"></i> }
                    </label>
                  }
                </div>
              }
            </aside>
            <section class="abi-explore-preview">
              <div class="abi-explore-actions">
                <button pButton type="button" class="p-button-sm" (click)="loadExplore()">Consultar</button>
                <span class="abi-explore-count">{{ exploreTotal() | number }} filas para los filtros aplicados</span>
              </div>
              <p-table [value]="exploreRows()" [loading]="exploreLoading()" [lazy]="true" (onLazyLoad)="onExploreLazyLoad($any($event))"
                        [paginator]="true" [rows]="explorePageSize()" [totalRecords]="exploreTotal()" [rowsPerPageOptions]="[25,50,100]"
                        styleClass="p-datatable-sm surf-table surf-table--zebra" [scrollable]="true" scrollHeight="flex">
                <ng-template #header>
                  <tr>@for (k of selectedFields(); track k) { <th scope="col">{{ fieldLabel(k) }}</th> }</tr>
                </ng-template>
                <ng-template #body let-r>
                  <tr>@for (k of selectedFields(); track k) { <td>{{ formatExploreCell(r[k]) }}</td> }</tr>
                </ng-template>
                <ng-template #emptymessage>
                  <tr><td [attr.colspan]="selectedFields().length || 1" class="comm-empty-cell">
                    <div class="comm-empty"><div class="comm-empty-icon"><i class="pi pi-table" aria-hidden="true"></i></div>
                      <h3>Sin vista previa</h3><p>Elegí columnas y tocá Consultar.</p></div>
                  </td></tr>
                </ng-template>
              </p-table>
            </section>
          </div>
        </p-tabpanel>

        </p-tabpanels>
      </p-tabs>
    </div>
  `,
  styles: [`
    .abi-head-actions { display: flex; align-items: center; gap: .6rem; }
    .abi-updated { font-size: .78rem; color: var(--text-color-secondary); }
    .abi-filters { display: flex; flex-direction: column; gap: .5rem; margin: .75rem 0 1rem; padding: .75rem 1rem; background: var(--surface-card, var(--surface-0)); border: 1px solid var(--surface-border); border-radius: 10px; }
    .abi-filter-row { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
    :host ::ng-deep .abi-fld { min-width: 11rem; }
    :host ::ng-deep .abi-fld-wide { min-width: 20rem; flex: 1 1 20rem; }
    .abi-filter-actions { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; }
    .abi-scope-note { font-size: .78rem; color: var(--text-color-secondary); display: inline-flex; align-items: center; gap: .3rem; }
    .abi-ac-item { display: flex; justify-content: space-between; gap: .5rem; }
    .abi-ac-sku { font-family: var(--font-mono, monospace); font-size: .72rem; color: var(--text-color-secondary); }
    .abi-ac-empty { padding: .5rem .75rem; color: var(--text-color-secondary); }

    .abi-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: .75rem; margin-bottom: 1rem; }
    .abi-kpi { background: var(--surface-card, var(--surface-0)); border: 1px solid var(--surface-border); border-radius: 10px; padding: .75rem .9rem; display: flex; flex-direction: column; gap: .15rem; }
    .abi-kpi-l { font-size: .74rem; color: var(--text-color-secondary); text-transform: uppercase; letter-spacing: .03em; }
    .abi-kpi-n { font-size: 1.3rem; font-weight: 800; font-variant-numeric: tabular-nums; }
    .abi-kpi-n.abi-na { color: var(--text-color-secondary); font-size: 1rem; font-weight: 600; }
    .abi-kpi-sub { font-size: .72rem; color: var(--text-color-secondary); }
    .abi-kpi-sub.abi-na-reason { text-decoration: underline dotted; cursor: help; }
    .abi-ok { color: var(--ok-fg, #16a34a); } .abi-bad { color: var(--bad-fg, #b91c1c); }

    .abi-banner { display: flex; gap: .5rem; align-items: flex-start; background: var(--surface-100, #f5f5f4); border: 1px solid var(--surface-border); border-radius: 8px; padding: .6rem .8rem; font-size: .82rem; color: var(--text-color-secondary); margin-bottom: 1rem; }
    .abi-charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr)); gap: 1rem; margin-bottom: 1.25rem; }
    .abi-chart-card { background: var(--surface-card, var(--surface-0)); border: 1px solid var(--surface-border); border-radius: 10px; padding: .85rem; }
    .abi-chart-card h3 { margin: 0 0 .5rem; font-size: .88rem; }
    .abi-chart-unit { font-weight: 400; color: var(--text-color-secondary); font-size: .78rem; }
    .abi-section h3 { font-size: .88rem; margin: 0 0 .5rem; }
    .abi-empty-inline { padding: 1.25rem; text-align: center; color: var(--text-color-secondary); font-size: .85rem; }
    .abi-mono { font-family: var(--font-mono, monospace); font-size: .82rem; }
    .abi-link { text-decoration: underline dotted; }

    .abi-skeleton { padding: 3rem; text-align: center; color: var(--text-color-secondary); }
    .abi-error { display: flex; gap: .5rem; align-items: center; padding: 1rem; color: var(--bad-fg, #b91c1c); }

    .abi-mov-toolbar { display: flex; justify-content: flex-end; margin-bottom: .5rem; }
    .abi-mov-row { cursor: pointer; }
    .abi-unavailable-note { font-size: .76rem; color: var(--text-color-secondary); margin-top: .5rem; display: flex; gap: .35rem; align-items: flex-start; }

    .abi-explore-layout { display: grid; grid-template-columns: 16rem 1fr; gap: 1rem; }
    @media (max-width: 900px) { .abi-explore-layout { grid-template-columns: 1fr; } }
    .abi-explore-fields { background: var(--surface-card, var(--surface-0)); border: 1px solid var(--surface-border); border-radius: 10px; padding: .75rem; max-height: 32rem; overflow-y: auto; }
    .abi-fg { margin-bottom: .85rem; }
    .abi-fg h4 { margin: 0 0 .35rem; font-size: .74rem; text-transform: uppercase; letter-spacing: .03em; color: var(--text-color-secondary); }
    .abi-fg-item { display: flex; align-items: center; gap: .4rem; padding: .2rem 0; font-size: .82rem; cursor: pointer; }
    .abi-fg-disabled { opacity: .5; cursor: not-allowed; }
    /* [WMS-BI.4.7] El folio es lo clicable, no la fila entera. Botón real (no un <td> con click):
       llega por teclado y anuncia su destino sin que haya que poner tabindex a mano. */
    .abi-folio-btn { background: none; border: 0; padding: 0; font: inherit; color: var(--action, #C2410C);
      cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
    .abi-folio-btn:hover { text-decoration-thickness: 2px; }
    .abi-folio-btn:focus-visible { outline: 2px solid var(--action, #C2410C); outline-offset: 2px; border-radius: 3px; }

    .abi-explore-actions { display: flex; align-items: center; gap: .75rem; margin-bottom: .5rem; }
    .abi-explore-count { font-size: .78rem; color: var(--text-color-secondary); }
  `],
})
export class AlmacenAnalisisBiComponent {
  private readonly bi = inject(AlmacenBiService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly auth = inject(AuthService);
  private readonly theme = inject(ThemeService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly money = money;
  readonly moneyShort = moneyShort;
  readonly periodOpts = [...DATE_PRESET_OPTIONS.filter((o) => o.value !== 'anio'), { label: 'Personalizado', value: 'custom' }];
  readonly movKindOpts = [
    { label: 'Todo', value: '' },
    { label: 'Entradas', value: 'entrada' },
    { label: 'Salidas', value: 'salida' },
  ];

  // ── filtros ──
  // [WMS-BI.4.7] SEÑALES, no campos planos. La app corre zoneless (`provideZonelessChangeDetection()`
  // en app.config.ts, `zone.js` fuera de polyfills), y acá había dos `computed()` leyendo campos
  // planos: `warehouseOptsFiltered` (leía `selectedZoneIds`) y `selectedFields` (leía
  // `selectedFieldsList`). Un `computed` sólo se invalida por SEÑALES ⇒ los dos servían caché:
  // elegir una Zona no volvía a filtrar el desplegable de Almacén, y tildar un campo en "Explorar
  // datos" no cambiaba la tabla. El primero engañaba más porque SÍ se refrescaba — por la señal
  // `filters()` de al lado, no por la que el usuario tocaba. Candado en
  // `almacen-analisis-bi.reactividad.spec.ts`.
  readonly periodPreset = signal('d30');
  readonly customFrom = signal<Date | null>(null);
  readonly customTo = signal<Date | null>(null);
  readonly selectedZoneIds = signal<string[]>([]);
  readonly selectedWarehouseIds = signal<string[]>([]);
  selectedProduct: BiProductOpt | null = null;
  selectedProductId = signal<string | null>(null);
  readonly movementKind = signal<'entrada' | 'salida' | ''>('');
  productSuggestions = signal<BiProductOpt[]>([]);

  readonly filters = signal<BiFilters | null>(null);
  readonly lastQueried = signal<Date>(new Date());
  readonly activeTab = signal<'resumen' | 'movimientos' | 'explorar'>('resumen');
  private dirty: Record<'resumen' | 'movimientos' | 'explorar', boolean> = { resumen: true, movimientos: true, explorar: true };

  readonly zoneOpts = computed(() => (this.filters()?.zones || []).map((z: BiZoneGroup) => ({ label: z.zone_name, value: z.zone_id || '(sin-zona)' })));
  private readonly allWarehouseOpts = computed<WhOpt[]>(() =>
    (this.filters()?.zones || []).flatMap((z: BiZoneGroup) => z.warehouses.map((w) => ({ ...w, zone_label: z.zone_name }))));
  readonly warehouseOptsFiltered = computed(() => {
    const zids = this.selectedZoneIds();
    const opts = zids.length ? this.allWarehouseOpts().filter((w) => zids.includes(w.zone_id || '(sin-zona)')) : this.allWarehouseOpts();
    return opts.map((w) => ({ label: `${w.code} · ${w.name}`, value: w.id }));
  });
  readonly scopeNote = computed(() => {
    const f = this.filters();
    if (!f) return '';
    if (f.scope.mode === 'all') return '';
    const n = f.scope.warehouse_count ?? 0;
    return `Tu alcance: ${n} almacén${n === 1 ? '' : 'es'} (rol: ${f.scope.mode})`;
  });

  readonly onProductSearch = (e: AutoCompleteCompleteEvent) => this.searchProducts(e.query || '');
  private readonly searchProducts = makeDebouncedSearch((term) => {
    if (term.trim().length < 2) { this.productSuggestions.set([]); return; }
    this.bi.productSearch(term, 1, 20).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => this.productSuggestions.set(r.rows),
      error: () => this.productSuggestions.set([]),
    });
  }, 250);
  onProductSelect(e: AutoCompleteSelectEvent): void { this.selectedProductId.set((e.value as BiProductOpt)?.id ?? null); }

  // ── Resumen ──
  readonly summary = signal<BiSummary | null>(null);
  readonly summaryLoading = signal(false);
  readonly summaryError = signal<string | null>(null);
  readonly loadingAny = computed(() => this.summaryLoading() || this.movLoading() || this.exploreLoading());

  readonly dailyChartData = computed(() => {
    const s = this.summary(); if (!s) return { labels: [], datasets: [] };
    const ok = this.cssVar('--ok-fg', '#16a34a'), bad = this.cssVar('--bad-fg', '#b91c1c');
    return {
      labels: s.movements.daily_series.map((d) => d.date.slice(5)),
      datasets: [
        { label: 'Entradas', data: s.movements.daily_series.map((d) => d.entradas), backgroundColor: ok },
        { label: 'Salidas', data: s.movements.daily_series.map((d) => d.salidas), backgroundColor: bad },
      ],
    };
  });
  readonly topSalidaChartData = computed(() => {
    const s = this.summary(); if (!s) return { labels: [], datasets: [] };
    const c1 = this.cssVar('--chart-1', '#F05A28');
    return {
      labels: s.movements.top_salida_valor.map((r) => r.product_name.length > 22 ? r.product_name.slice(0, 22) + '…' : r.product_name),
      datasets: [{ label: 'Valor de salida', data: s.movements.top_salida_valor.map((r) => r.valor), backgroundColor: c1 }],
    };
  });
  private baseChartOpts() {
    const dark = this.theme.isMonochrome();
    const axis = this.cssVar('--text-muted', dark ? '#A1A1AA' : '#52525B');
    const grid = dark ? 'rgba(255,255,255,.09)' : 'rgba(0,0,0,.08)';
    return {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom' as const, labels: { color: axis } } },
      scales: { x: { ticks: { color: axis }, grid: { color: grid } }, y: { ticks: { color: axis }, grid: { color: grid } } },
    };
  }
  readonly dailyChartOpts = computed(() => this.baseChartOpts());
  readonly topSalidaChartOpts = computed(() => ({ ...this.baseChartOpts(), indexAxis: 'y' as const }));
  private cssVar(name: string, fallback: string): string {
    if (typeof document === 'undefined') return fallback;
    const v = getComputedStyle(document.body).getPropertyValue(name).trim();
    return v || fallback;
  }

  // ── Movimientos ──
  readonly movRows = signal<BiMovementRow[]>([]);
  readonly movTotal = signal(0);
  readonly movPage = signal(1);
  readonly movPageSize = signal(50);
  private movSortField = 'doc_date';
  private movSortDir: 'asc' | 'desc' = 'desc';
  readonly movLoading = signal(false);
  readonly visibleMovCols = signal<string[]>([...DEFAULT_MOV_COLS]);
  /**
   * [WMS-BI.4.7] `colOn()` se evalúa una vez por columna y por fila: con 200 filas × 30 columnas
   * son 6,000 `Array.includes()` sobre una lista de 25 en CADA render. Un `Set` en un `computed`
   * lo deja en 6,000 lookups O(1) que además sólo se reconstruye cuando cambia la selección.
   */
  private readonly visibleMovColSet = computed(() => new Set(this.visibleMovCols()));
  /**
   * [WMS-BI.4.3] Edad del resolvedor de unidad. `null` = todavía no llegó una respuesta.
   * La pantalla lo IMPRIME: una copia materializada que nadie fecha se lee igual que un dato
   * en vivo (ADR-056).
   */
  readonly unitProvenance = signal<BiUnitProvenance | null>(null);
  readonly unitProvenanceNota = computed(() => {
    const p = this.unitProvenance();
    if (!p) return '';
    if (p.source === 'view') return 'Unidad base: resolvedor en vivo (la copia materializada no existe en este entorno).';
    if (!p.refreshed_at) return 'Unidad base: copia materializada, sin fecha de actualización — no se pudo medir.';
    return `Unidad base: copia materializada del ${new Date(p.refreshed_at).toLocaleString('es-MX')}.`;
  });
  readonly movColumnOpts = [
    { key: 'doc_date', label: 'Fecha' }, { key: 'hora', label: 'Hora' }, { key: 'zone_name', label: 'Zona' },
    { key: 'warehouse_code', label: 'Sucursal' }, { key: 'almacen', label: 'Almacén' },
    { key: 'canal', label: 'Canal' },
    { key: 'movement_kind', label: 'Tipo' },
    { key: 'tipo_operacion', label: 'Tipo de operación' },
    { key: 'movement_label', label: 'Documento' }, { key: 'doc_code', label: 'Código doc.' }, { key: 'folio', label: 'Folio' },
    { key: 'vendedor', label: 'Vendedor' },
    { key: 'sku', label: 'Código' }, { key: 'product_name', label: 'Producto' },
    { key: 'linea_producto', label: 'Línea' }, { key: 'tipo_producto', label: 'Tipo producto' }, { key: 'grupo_producto', label: 'Grupo' },
    { key: 'qty', label: 'Cantidad' }, { key: 'unidad_operacion', label: 'Unidad operación' }, { key: 'unidad_base', label: 'Unidad base' },
    { key: 'signed_qty', label: 'Efecto en inventario' }, { key: 'unit_cost', label: 'Costo del movimiento' }, { key: 'amount', label: 'Importe' },
    { key: 'importe_costo', label: 'Importe costo' }, { key: 'importe_venta', label: 'Importe venta' },
    { key: 'iva_valor', label: 'IVA valor' }, { key: 'ieps_valor', label: 'IEPS valor' }, { key: 'venta_neta', label: 'Venta neta' },
    { key: 'cost_base_hoy', label: 'Costo catálogo (hoy)' }, { key: 'source_system', label: 'Sistema' },
  ];
  colOn(k: string): boolean { return this.visibleMovColSet().has(k); }
  /** `makeLazyLoad` sólo traduce página/tamaño — el orden servidor lo captura acá (PrimeNG
   * manda `sortOrder` 1/-1, el backend espera 'asc'/'desc'). */
  private readonly movLazyBase = makeLazyLoad(this.movPage, this.movPageSize, () => this.loadMovements());
  onMovLazyLoad(e: LazyTableEvent): void {
    const field = Array.isArray(e.sortField) ? e.sortField[0] : e.sortField;
    if (field) { this.movSortField = field; this.movSortDir = e.sortOrder === 1 ? 'asc' : 'desc'; }
    this.movLazyBase(e);
  }

  // ── Explorar ──
  readonly fields = signal<BiField[]>([]);
  // [WMS-BI.4.7] Era `selectedFieldsList` plano + `computed(() => this.selectedFieldsList)`, que
  // no tenía NINGUNA dependencia de señal ⇒ se evaluaba una vez y quedaba congelado: las casillas
  // se tildaban pero la tabla nunca cambiaba de columnas.
  readonly selectedFields = signal<string[]>([...DEFAULT_EXPLORE_FIELDS]);
  readonly exploreRows = signal<Record<string, unknown>[]>([]);
  readonly exploreTotal = signal(0);
  readonly explorePage = signal(1);
  readonly explorePageSize = signal(25);
  readonly exploreLoading = signal(false);
  readonly onExploreLazyLoad = makeLazyLoad(this.explorePage, this.explorePageSize, () => this.loadExplore());
  readonly fieldGroups = computed(() => {
    const byGroup = new Map<string, BiField[]>();
    for (const f of this.fields()) { if (!byGroup.has(f.group)) byGroup.set(f.group, []); byGroup.get(f.group)!.push(f); }
    return [...byGroup.entries()].map(([name, fields]) => ({ name, fields }));
  });
  isFieldSelected(k: string): boolean { return this.selectedFields().includes(k); }
  toggleField(k: string): void {
    this.selectedFields.update((sel) => sel.includes(k) ? sel.filter((x) => x !== k) : [...sel, k]);
  }
  fieldLabel(k: string): string { return this.fields().find((f) => f.key === k)?.label || k; }
  formatExploreCell(v: unknown): string {
    if (v == null) return '—';
    if (typeof v === 'number') return v.toLocaleString('es-MX');
    return String(v);
  }

  constructor() {
    // Una sola suscripción para toda la vida del componente; cada pedido entra por `movRequest$`
    // y `switchMap` se encarga de que sólo la última pedida pinte.
    this.movStream.subscribe((r) => {
      this.movLoading.set(false);
      if (!r) return;
      this.movRows.set(r.rows);
      this.movTotal.set(r.total);
      this.unitProvenance.set(r.unit_provenance ?? null);
      this.lastQueried.set(new Date());
    });

    const tabParam = this.route.snapshot.queryParamMap.get('tab');
    if (tabParam === 'movimientos' || tabParam === 'explorar') this.activeTab.set(tabParam);
    this.loadFilters();
    this.ensureLoaded(this.activeTab());
    this.bi.fields().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (f) => this.fields.set(f) });
  }

  private currentRange(): { from: string; to: string } {
    const desde = this.customFrom(), hasta = this.customTo();
    if (this.periodPreset() === 'custom' && desde && hasta) {
      return { from: ISO(desde), to: ISO(hasta) };
    }
    const r = datePresetRange(this.periodPreset()) || datePresetRange('d30')!;
    return { from: ISO(r.from), to: ISO(r.to) };
  }
  /**
   * Resuelve el filtro de almacén de la barra: si se eligieron almacenes puntuales, esos ganan;
   * si sólo se eligió zona, se expande a los almacenes de esa zona (dentro de lo que YA es
   * visible, ver `warehouseOptsFiltered`); sin ninguno, no se manda nada y el backend aplica
   * el alcance completo del usuario.
   */
  private currentWarehouseIds(): string[] | undefined {
    const whs = this.selectedWarehouseIds(), zonas = this.selectedZoneIds();
    if (whs.length) return whs;
    if (zonas.length) {
      const ids = this.allWarehouseOpts().filter((w) => zonas.includes(w.zone_id || '(sin-zona)')).map((w) => w.id);
      return ids.length ? ids : undefined;
    }
    return undefined;
  }
  private currentFilterParams(): BiFilterParams {
    const { from, to } = this.currentRange();
    return {
      from, to, movement_kind: this.movementKind() || undefined, product_id: this.selectedProductId() || undefined,
      warehouse_ids: this.currentWarehouseIds(),
    };
  }


  loadFilters(): void {
    this.bi.filters().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (f) => this.filters.set(f),
      error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar los filtros de alcance' }),
    });
  }

  applyFilters(): void {
    this.movPage.set(1); this.explorePage.set(1);
    this.dirty = { resumen: true, movimientos: true, explorar: true };
    this.ensureLoaded(this.activeTab());
  }
  clearFilters(): void {
    this.periodPreset.set('d30'); this.customFrom.set(null); this.customTo.set(null);
    this.selectedZoneIds.set([]); this.selectedWarehouseIds.set([]);
    this.selectedProduct = null; this.selectedProductId.set(null);
    this.movementKind.set('');
    this.applyFilters();
  }
  refresh(): void { this.dirty = { resumen: true, movimientos: true, explorar: true }; this.loadFilters(); this.ensureLoaded(this.activeTab()); }

  onTab(tab: string): void {
    const t = (tab === 'movimientos' || tab === 'explorar' ? tab : 'resumen') as 'resumen' | 'movimientos' | 'explorar';
    this.activeTab.set(t);
    this.router.navigate([], { relativeTo: this.route, queryParams: { tab: t === 'resumen' ? null : t }, queryParamsHandling: 'merge', replaceUrl: true });
    this.ensureLoaded(t);
  }
  private ensureLoaded(tab: 'resumen' | 'movimientos' | 'explorar'): void {
    if (!this.dirty[tab]) return;
    this.dirty[tab] = false;
    if (tab === 'resumen') this.loadSummary();
    else if (tab === 'movimientos') this.loadMovements();
    else this.loadExplore();
  }

  loadSummary(): void {
    this.summaryLoading.set(true); this.summaryError.set(null);
    this.bi.summary(this.currentFilterParams()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (s) => { this.summary.set(s); this.summaryLoading.set(false); this.lastQueried.set(new Date()); },
      error: (e) => { this.summaryLoading.set(false); this.summaryError.set(e?.error?.message || 'No se pudo cargar el resumen'); },
    });
  }

  /**
   * [WMS-BI.4.7] Paginar dispara una consulta NUEVA sin esperar a la anterior.
   *
   * Antes cada llamada abría su propio `subscribe()`: con la latencia medida de esta pestaña
   * (**19.4 s en frío, 3–5 s en caliente** contra prod, antes de la MV de 4.3), tocar el paginador
   * tres veces dejaba tres requests en vuelo y **pintaba la que contestara última** — que no es
   * necesariamente la última pedida. El usuario terminaba viendo la página 2 con el paginador
   * marcando la 4, sin ningún error de por medio.
   *
   * `switchMap` cancela la anterior al llegar la siguiente: **la última pedida es la única que
   * pinta**. Es el punto donde RxJS resuelve un bug, no un estilo — el resto de este componente
   * vive bien con señales.
   */
  private readonly movRequest$ = new Subject<void>();
  private readonly movStream = this.movRequest$.pipe(
    tap(() => this.movLoading.set(true)),
    switchMap(() => this.bi
      .movements(this.currentFilterParams(), this.movPage(), this.movPageSize(), this.movSortField, this.movSortDir)
      .pipe(catchError(() => {
        this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar los movimientos' });
        return of(null);
      }))),
    takeUntilDestroyed(this.destroyRef),
  );

  loadMovements(): void { this.movRequest$.next(); }

  loadExplore(): void {
    this.exploreLoading.set(true);
    this.bi.explore(this.currentFilterParams(), this.selectedFields(), this.explorePage(), this.explorePageSize())
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => { this.exploreRows.set(r.rows); this.exploreTotal.set(r.total); this.exploreLoading.set(false); this.lastQueried.set(new Date()); },
        error: () => { this.exploreLoading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo consultar' }); },
      });
  }

  openDocument(r: BiMovementRow): void {
    // Ruta PROPIA (no /almacen/movimientos): mismo permiso ALMACEN_BI_VER + redacción de
    // destino por perfil — ver el comentario en el service backend.
    const w = this.allWarehouseOpts().find((x) => x.code === r.warehouse_code);
    const url = this.router.serializeUrl(this.router.createUrlTree(['/almacen/analisis-bi/documento'], {
      queryParams: { warehouse_id: w?.id, folio: r.folio, doc_code: r.doc_code },
    }));
    window.open(url, '_blank');
  }
  /**
   * Del renglón de desviación a Movimientos, filtrado por ESE almacén. No filtra por SKU:
   * `movements()` acepta `product_id` (uuid), no `sku` suelto, y esta fila no trae el id —
   * traducirlo agregaría una consulta más sólo para un atajo. El usuario llega ya acotado
   * al almacén y busca el producto en el filtro de arriba si lo necesita.
   */
  openMovementsFor(r: { warehouse_code: string; sku: string | null }): void {
    const w = this.allWarehouseOpts().find((x) => x.code === r.warehouse_code);
    if (w) { this.selectedWarehouseIds.set([w.id]); this.dirty.movimientos = true; }
    this.activeTab.set('movimientos');
    this.router.navigate([], { relativeTo: this.route, queryParams: { tab: 'movimientos' }, queryParamsHandling: 'merge', replaceUrl: true });
    this.ensureLoaded('movimientos');
  }

  /**
   * [WMS-BI.4.7] Antes esto era un `toast` que DESCRIBÍA una exportación que no existía: el botón
   * estaba habilitado, el usuario lo tocaba, leía "la exportación toma la vista filtrada actual" y
   * no bajaba ningún archivo. Un botón que explica lo que no hace es peor que no tenerlo.
   *
   * Ahora baja de verdad lo que está EN PANTALLA — la página cargada, con las columnas visibles y
   * en el orden en que se ven — y el mensaje dice exactamente cuántas filas tomó, para que nadie
   * confunda 50 filas con las 136,242 del filtro.
   *
   * ⚠️ La exportación COMPLETA del filtro (todas las páginas) es server-side y sigue pendiente
   * (WMS-BI.4.4): traerla al navegador serían cientos de miles de filas por una consulta que hoy
   * tarda segundos por página.
   */
  exportCurrent(): void {
    const esExplorar = this.activeTab() === 'explorar';
    const cols = esExplorar ? this.selectedFields() : this.visibleMovCols();
    const filas: Array<Record<string, unknown>> = esExplorar
      ? this.exploreRows()
      : (this.movRows() as unknown as Array<Record<string, unknown>>);

    if (!filas.length || !cols.length) {
      this.toast.add({ severity: 'warn', summary: 'Exportar', detail: 'No hay filas cargadas para exportar.' });
      return;
    }

    const etiqueta = (k: string) => esExplorar
      ? this.fieldLabel(k)
      : (this.movColumnOpts.find((c) => c.key === k)?.label ?? k);
    // Excel en es-MX abre CSV con `;`; el BOM evita que se coma los acentos.
    const celda = (v: unknown): string => {
      if (v == null) return '';
      const s = String(v);
      return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [
      cols.map((k) => celda(etiqueta(k))).join(';'),
      ...filas.map((r) => cols.map((k) => celda(r[k])).join(';')),
    ].join('\r\n');

    const { from, to } = this.currentRange();
    const nombre = `bi-almacen-${esExplorar ? 'explorar' : 'movimientos'}-${from}_${to}.csv`;
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url; a.download = nombre; a.click();
    URL.revokeObjectURL(url);

    const total = esExplorar ? this.exploreTotal() : this.movTotal();
    this.toast.add({
      severity: 'success', summary: 'Exportado',
      detail: `${filas.length.toLocaleString('es-MX')} filas (la página cargada) de ${total.toLocaleString('es-MX')} que tiene el filtro.`,
    });
  }

  canSeeCustomers(): boolean {
    return this.auth.user()?.permissions?.[Permission.COMMERCIAL_CUSTOMERS_VER] === true;
  }
}
