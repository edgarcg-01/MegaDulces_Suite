import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, of } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { SelectModule } from 'primeng/select';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { CheckboxModule } from 'primeng/checkbox';
import { TagModule } from 'primeng/tag';
import { MessageService } from 'primeng/api';
import {
  ComprasService, PurchaseSuggestionRow, PurchaseSuggestionResponse, ReplenishmentFilters,
  DeadStockRow, CreateRequisitionDto, CreateRequisitionLine, PedidoExportLine, saveXlsxResponse,
  TransferSuggestionRow, TransferSuggestionResponse, OverstockRow, OverstockResponse,
} from '../compras.service';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';

type Sev = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';
type Mode = 'pedir' | 'traspaso' | 'sobrestock' | 'muerto';
interface Row extends PurchaseSuggestionRow { _pedir: number; _sel: boolean; }
interface TRow extends TransferSuggestionRow { _mover: number; _sel: boolean; }

/**
 * RA-PRO.17 — PEDIDO (vista unificada de Compras). Fusiona las 3 vistas previas (pedido / compra
 * sugerida / existencia crítica) en una: el motor DEMAND-DRIVEN correcto (la venta real de la red
 * fija el reorden) + el flujo (seleccionar → armar requisición HITL → exportar XLSX) + filtro por
 * bucket de cobertura + stock muerto. Superficie Operations (denso, tokens, dark first-class).
 */
@Component({
  selector: 'app-compras-pedido-real',
  standalone: true,
  imports: [
    CommonModule, FormsModule, RouterLink, ButtonModule, TableModule, ToastModule, SelectModule,
    InputNumberModule, InputTextModule, IconFieldModule, InputIconModule, CheckboxModule, TagModule, MetricStripComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in pr-page">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Pedido <span class="pr-badge">demanda</span></h1>
          <p class="surf-page-sub">La <strong>venta real de la red</strong> fija el reorden: <strong>pedir = venta diaria × cobertura − existencia − en tránsito</strong>, al costo real de compra. Lo sobrestockeado no se re-pide. Selecciona líneas → arma la requisición o exporta.</p>
        </div>
        <div class="pr-mode" role="tablist" aria-label="Vista">
          <button role="tab" [attr.aria-selected]="mode()==='pedir'" class="pr-tab" [class.pr-tab-on]="mode()==='pedir'" (click)="setMode('pedir')">Comprar</button>
          <button role="tab" [attr.aria-selected]="mode()==='traspaso'" class="pr-tab" [class.pr-tab-on]="mode()==='traspaso'" (click)="setMode('traspaso')">Traspasos</button>
          <button role="tab" [attr.aria-selected]="mode()==='sobrestock'" class="pr-tab" [class.pr-tab-on]="mode()==='sobrestock'" (click)="setMode('sobrestock')">Sobrestock</button>
          <button role="tab" [attr.aria-selected]="mode()==='muerto'" class="pr-tab" [class.pr-tab-on]="mode()==='muerto'" (click)="setMode('muerto')">Stock muerto</button>
        </div>
      </header>

      @if (mode()==='pedir') {
        <app-metric-strip [items]="kpiItems()" ariaLabel="Resumen del pedido" />

        <div class="pr-filters">
          <p-select [options]="supplierOpts()" [(ngModel)]="fSupplier" (onChange)="reload()"
                    optionLabel="label" optionValue="value" placeholder="Todos los proveedores" [showClear]="true"
                    [filter]="true" filterBy="label" [virtualScroll]="true" [virtualScrollItemSize]="34"
                    styleClass="pr-sel-wide" ariaLabel="Filtrar por proveedor"></p-select>
          <p-select [options]="warehouseOpts()" [(ngModel)]="fWarehouse" (onChange)="reload()"
                    optionLabel="label" optionValue="value" placeholder="Todos los almacenes" [showClear]="true"
                    styleClass="pr-sel" ariaLabel="Filtrar por almacén"></p-select>
          <p-select [options]="bucketOpts" [(ngModel)]="fBucket" (onChange)="reload()"
                    optionLabel="label" optionValue="value" placeholder="Todos los buckets" [showClear]="true"
                    styleClass="pr-sel-sm" ariaLabel="Filtrar por cobertura"></p-select>
          <label class="pr-toggle" title="Muestra solo los productos que necesitan pedido (cobertura por debajo de la meta)">
            <p-checkbox [binary]="true" [(ngModel)]="onlyNeeded" (onChange)="reload()" inputId="onlyNeeded"></p-checkbox>
            <span>Solo por pedir</span>
          </label>
          <p-iconfield styleClass="pr-search">
            <p-inputicon styleClass="pi pi-search" />
            <input pInputText type="text" [(ngModel)]="search" (keyup.enter)="reload()" placeholder="SKU o producto…" aria-label="Buscar producto" />
          </p-iconfield>
          <label class="pr-cov">
            <span>Cobertura</span>
            <p-inputNumber [(ngModel)]="coverage" (onBlur)="reload()" [min]="1" [max]="120" [showButtons]="true"
                           buttonLayout="horizontal" [step]="1" suffix=" d" inputStyleClass="pr-cov-in"
                           decrementButtonClass="p-button-text" incrementButtonClass="p-button-text"
                           incrementButtonIcon="pi pi-plus" decrementButtonIcon="pi pi-minus" ariaLabel="Días de cobertura"></p-inputNumber>
          </label>
          <div class="pr-presets" role="group" aria-label="Cobertura rápida">
            @for (p of [14, 30, 45]; track p) {
              <button type="button" class="pr-chip" [class.pr-chip-on]="coverage === p" (click)="setCoverage(p)">{{ p }}d</button>
            }
          </div>
        </div>

        @if (error()) {
          <div class="pr-state pr-error">
            <i class="pi pi-exclamation-triangle"></i>
            <div><p>No se pudo cargar el pedido.</p>
              <button pButton type="button" label="Reintentar" icon="pi pi-refresh" class="p-button-sm p-button-text" (click)="reload()"></button></div>
          </div>
        } @else {
          <p-table [value]="rows()" [loading]="loading()" [scrollable]="true" scrollHeight="flex"
                   [paginator]="true" [rows]="50" [rowsPerPageOptions]="[50, 100, 200]"
                   styleClass="p-datatable-sm pr-table" [tableStyle]="{ 'min-width': '84rem' }">
            <ng-template pTemplate="header">
              <tr>
                <th style="width:2.5rem"><p-checkbox [binary]="true" [ngModel]="allSel()" (onChange)="toggleAll($event.checked)" ariaLabel="Seleccionar todo"></p-checkbox></th>
                <th style="min-width:15rem">Producto</th>
                <th style="width:5rem" title="Almacén donde se compra directo">Compra en</th>
                <th style="min-width:9rem">Proveedor</th>
                <th class="pr-r pr-sell" title="Venta de la RED, 30 días (en dinero)">Venta $ 30d</th>
                <th class="pr-r pr-sell" title="Venta de la RED, 30 días (cajas). La demanda que fija el reorden.">Cajas 30d</th>
                <th class="pr-r pr-sell" title="Venta diaria de la red (cajas/día)">Venta/d</th>
                <th class="pr-r" title="Días hasta agotarse = existencia de red ÷ venta diaria de red">Cobertura</th>
                <th class="pr-r" title="Existencia de la red en cajas">Exist.</th>
                <th class="pr-r" title="Fill rate del proveedor (recibido ÷ pedido, últimos 180 d). Debajo de 100% infla el sugerido para compensar surtido incompleto (tope 1.3x). — = sin historia suficiente (no infla).">Fill</th>
                <th class="pr-r pr-sug" title="Cajas a pedir (editable). Ya incluye el ajuste por fill rate del proveedor.">Pedir</th>
                <th class="pr-r pr-muted-h" title="Piezas = cajas × UXC">Piezas</th>
                <th class="pr-r" title="Costo real por caja">Costo</th>
                <th class="pr-r pr-val" title="Valor = pedir × costo real">Valor</th>
              </tr>
            </ng-template>
            <ng-template pTemplate="body" let-r>
              <tr [class.pr-row-sel]="r._sel">
                <td><p-checkbox [binary]="true" [(ngModel)]="r._sel" (onChange)="onSel()" [ariaLabel]="'Seleccionar ' + r.sku"></p-checkbox></td>
                <td>
                  <div class="pr-prod">{{ r.nombre }}</div>
                  <div class="pr-prod-meta">
                    <span class="pr-sku">{{ r.sku }}</span>
                    @if (r.abc_class) { <p-tag [value]="r.abc_class" [severity]="abcSev(r.abc_class)" styleClass="pr-abc"></p-tag> }
                    @if (r.sales_rank != null) { <span class="pr-rank" title="Ranking por venta $ en el filtro">#{{ r.sales_rank }}</span> }
                    @if (r.unit_source && r.unit_source !== 'catalog') {
                      <p-tag [value]="unitLabel(r.unit_source)" [severity]="r.unit_source === 'revisar' ? 'warn' : 'contrast'" styleClass="pr-abc"
                             [title]="'Unidad de venta ' + unitLabel(r.unit_source) + (r.price_ratio ? ' · ratio precio ' + (r.price_ratio | number:'1.0-1') + '×' : '') + ((r.stock_unit_factor || 1) > 1 ? ' · demanda ÷' + (r.stock_unit_factor | number:'1.0-1') : '')"></p-tag>
                    }
                  </div>
                </td>
                <td class="pr-mono pr-muted">{{ r.warehouse_code }}</td>
                <td class="pr-supp">{{ r.supplier_name || '—' }}</td>
                <td class="pr-r pr-sell pr-strong">{{ money(r.sell_month_mxn) }}</td>
                <td class="pr-r pr-sell">{{ r.sell_month_cajas | number:'1.0-0' }}</td>
                <td class="pr-r pr-sell">{{ r.sell_daily_cajas | number:'1.0-1' }}</td>
                <td class="pr-r">
                  @if (r.days_cover != null) {
                    <p-tag [value]="(r.days_cover | number:'1.0-0') + ' d'" [severity]="coverSev(r.days_cover)" styleClass="pr-cov-tag"></p-tag>
                  } @else { <span class="pr-muted">—</span> }
                </td>
                <td class="pr-r pr-muted">{{ r.on_hand_units | number:'1.0-0' }}</td>
                <td class="pr-r">
                  @if (r.fill_rate != null && r.fill_rate < 0.999) {
                    <span [title]="'Necesidad ' + (r.base_units | number:'1.0-0') + ' → ' + (r.suggested_units | number:'1.0-0') + ' cajas (÷ fill ' + (r.fill_rate * 100 | number:'1.0-0') + '%)'">
                      <p-tag [value]="(r.fill_rate * 100 | number:'1.0-0') + '%'" [severity]="fillSev(r.fill_rate)" styleClass="pr-cov-tag"></p-tag>
                    </span>
                  } @else { <span class="pr-muted">—</span> }
                </td>
                <td class="pr-r pr-sug">
                  <input pInputText type="number" min="0" [(ngModel)]="r._pedir" (ngModelChange)="onSel()" class="pr-qty" [attr.aria-label]="'Cajas a pedir de ' + r.sku" />
                </td>
                <td class="pr-r pr-muted-h">{{ (r._pedir * r.uxc) | number:'1.0-0' }}</td>
                <td class="pr-r pr-muted">{{ money(r.unit_cost) }}</td>
                <td class="pr-r pr-val pr-strong">{{ money(r._pedir * r.unit_cost) }}</td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage">
              <tr><td colspan="14" class="pr-empty">
                <i class="pi pi-inbox"></i>
                <p>Sin productos con estos filtros.</p>
                <span>Ajusta proveedor, almacén, bucket o búsqueda. Quita "Solo por pedir" para ver todos los productos.</span>
              </td></tr>
            </ng-template>
          </p-table>
        }
        <p class="pr-foot">Venta = sell-through real de la red (30d). Existencia sospechosamente alta = revisar conteo físico. En cajas; piezas = cajas × UXC.</p>

        <!-- Bulk-bar: aparece al seleccionar líneas -->
        @if (selCount() > 0) {
          <div class="pr-bulk" role="region" aria-label="Acciones del pedido">
            <span class="pr-bulk-n">{{ selCount() }} {{ selCount() === 1 ? 'línea' : 'líneas' }} · <strong>{{ money(selValor()) }}</strong></span>
            <span class="pr-bulk-sp"></span>
            <button pButton type="button" label="Exportar XLSX" icon="pi pi-file-excel" class="p-button-sm p-button-text" (click)="exportXlsx()" [disabled]="dl()"></button>
            <button pButton type="button" [label]="saving() ? 'Armando…' : 'Armar requisición'" icon="pi pi-check" class="p-button-sm" (click)="createReq()" [disabled]="saving()"></button>
          </div>
        }
      } @else if (mode()==='traspaso') {
        <!-- TRASPASOS: déficit de sucursal ← stock del CEDIS que la surte (topología) -->
        <app-metric-strip [items]="tKpiItems()" ariaLabel="Resumen de traspasos" />
        <div class="pr-filters">
          <p-select [options]="warehouseOpts()" [(ngModel)]="fWarehouse" (onChange)="loadTransfer()"
                    optionLabel="label" optionValue="value" placeholder="Todas las sucursales destino" [showClear]="true"
                    styleClass="pr-sel" ariaLabel="Filtrar por sucursal destino"></p-select>
          <p-select [options]="supplierOpts()" [(ngModel)]="fSupplier" (onChange)="loadTransfer()"
                    optionLabel="label" optionValue="value" placeholder="Todos los proveedores" [showClear]="true"
                    [filter]="true" filterBy="label" [virtualScroll]="true" [virtualScrollItemSize]="34"
                    styleClass="pr-sel-wide" ariaLabel="Filtrar por proveedor"></p-select>
          <p-iconfield styleClass="pr-search">
            <p-inputicon styleClass="pi pi-search" />
            <input pInputText type="text" [(ngModel)]="search" (keyup.enter)="loadTransfer()" placeholder="SKU o producto…" aria-label="Buscar producto" />
          </p-iconfield>
        </div>
        <p-table [value]="tRows()" [loading]="loading()" [scrollable]="true" scrollHeight="flex"
                 [paginator]="true" [rows]="50" [rowsPerPageOptions]="[50, 100, 200]"
                 styleClass="p-datatable-sm pr-table" [tableStyle]="{ 'min-width': '72rem' }">
          <ng-template pTemplate="header">
            <tr>
              <th style="width:2.5rem"><p-checkbox [binary]="true" [ngModel]="tAllSel()" (onChange)="tToggleAll($event.checked)" ariaLabel="Seleccionar todo"></p-checkbox></th>
              <th style="min-width:15rem">Producto</th>
              <th style="width:6rem" title="Sucursal que recibe">Destino</th>
              <th style="width:5.5rem" title="CEDIS que surte">Origen</th>
              <th class="pr-r" title="Faltante de la sucursal para la cobertura (cajas)">Déficit</th>
              <th class="pr-r pr-sug" title="Cajas a traspasar (editable; tope = lo que el CEDIS puede cubrir)">Mover</th>
              <th class="pr-r pr-muted-h" title="Piezas = cajas × UXC">Piezas</th>
              <th class="pr-r" title="Costo real por caja">Costo</th>
              <th class="pr-r pr-val" title="Valor = mover × costo real">Valor</th>
            </tr>
          </ng-template>
          <ng-template pTemplate="body" let-r>
            <tr [class.pr-row-sel]="r._sel">
              <td><p-checkbox [binary]="true" [(ngModel)]="r._sel" (onChange)="tOnSel()" [ariaLabel]="'Seleccionar ' + r.sku"></p-checkbox></td>
              <td><div class="pr-prod">{{ r.nombre }}</div><div class="pr-sku">{{ r.sku }}</div></td>
              <td class="pr-mono">{{ r.to_code }}</td>
              <td class="pr-mono pr-muted">{{ r.from_code }}</td>
              <td class="pr-r pr-muted">{{ r.deficit_cajas | number:'1.0-1' }}</td>
              <td class="pr-r pr-sug"><input pInputText type="number" min="0" [(ngModel)]="r._mover" (ngModelChange)="tOnSel()" class="pr-qty" [attr.aria-label]="'Cajas a mover de ' + r.sku" /></td>
              <td class="pr-r pr-muted-h">{{ (r._mover * r.uxc) | number:'1.0-0' }}</td>
              <td class="pr-r pr-muted">{{ money(r.unit_cost) }}</td>
              <td class="pr-r pr-val pr-strong">{{ money(r._mover * r.unit_cost) }}</td>
            </tr>
          </ng-template>
          <ng-template pTemplate="emptymessage">
            <tr><td colspan="9" class="pr-empty"><i class="pi pi-inbox"></i><p>Sin traspasos sugeridos.</p>
              <span>Ninguna sucursal tiene déficit cubrible por su CEDIS con estos filtros. Verifica la topología en <a routerLink="/compras/red">Red de abasto</a>.</span></td></tr>
          </ng-template>
        </p-table>
        <p class="pr-foot">El CEDIS que surte a cada sucursal se define en <a routerLink="/compras/red">Red de abasto</a>. Mover = déficit acotado a lo que el CEDIS puede cubrir (reparto proporcional entre sucursales). El faltante no cubrible se compra.</p>
        @if (tSelCount() > 0) {
          <div class="pr-bulk" role="region" aria-label="Acciones de traspaso">
            <span class="pr-bulk-n">{{ tSelCount() }} {{ tSelCount() === 1 ? 'traspaso' : 'traspasos' }} · <strong>{{ money(tSelValor()) }}</strong></span>
            <span class="pr-bulk-sp"></span>
            <button pButton type="button" [label]="saving() ? 'Armando…' : 'Armar traspaso'" icon="pi pi-arrow-right-arrow-left" class="p-button-sm" (click)="createTransfer()" [disabled]="saving()"></button>
          </div>
        }
      } @else if (mode()==='sobrestock') {
        <!-- SOBRESTOCK: stock que excede N días de cobertura → capital inmovilizado (topología-aware) -->
        <app-metric-strip [items]="oKpiItems()" ariaLabel="Resumen de sobrestock" />
        <div class="pr-filters">
          <p-select [options]="warehouseOpts()" [(ngModel)]="fWarehouse" (onChange)="loadOverstock()"
                    optionLabel="label" optionValue="value" placeholder="Todos los almacenes" [showClear]="true"
                    styleClass="pr-sel" ariaLabel="Filtrar por almacén"></p-select>
          <p-select [options]="supplierOpts()" [(ngModel)]="fSupplier" (onChange)="loadOverstock()"
                    optionLabel="label" optionValue="value" placeholder="Todos los proveedores" [showClear]="true"
                    [filter]="true" filterBy="label" [virtualScroll]="true" [virtualScrollItemSize]="34"
                    styleClass="pr-sel-wide" ariaLabel="Filtrar por proveedor"></p-select>
          <p-iconfield styleClass="pr-search">
            <p-inputicon styleClass="pi pi-search" />
            <input pInputText type="text" [(ngModel)]="search" (keyup.enter)="loadOverstock()" placeholder="SKU o producto…" aria-label="Buscar producto" />
          </p-iconfield>
          <label class="pr-cov">
            <span>Excede</span>
            <p-inputNumber [(ngModel)]="overDays" (onBlur)="loadOverstock()" [min]="7" [max]="365" [showButtons]="true"
                           buttonLayout="horizontal" [step]="15" suffix=" d" inputStyleClass="pr-cov-in"
                           decrementButtonClass="p-button-text" incrementButtonClass="p-button-text"
                           incrementButtonIcon="pi pi-plus" decrementButtonIcon="pi pi-minus" ariaLabel="Días de cobertura umbral"></p-inputNumber>
          </label>
        </div>
        <p-table [value]="oRows()" [loading]="loading()" [scrollable]="true" scrollHeight="flex"
                 [paginator]="true" [rows]="50" [rowsPerPageOptions]="[50, 100, 200]"
                 styleClass="p-datatable-sm pr-table" [tableStyle]="{ 'min-width': '70rem' }">
          <ng-template pTemplate="header">
            <tr>
              <th style="min-width:15rem">Producto</th>
              <th style="width:6rem">Almacén</th>
              <th style="min-width:9rem">Proveedor</th>
              <th class="pr-r" title="Existencia total (cajas)">Existencia</th>
              <th class="pr-r" title="Días que dura la existencia a la venta actual (de red si es CEDIS)">Cobertura</th>
              <th class="pr-r pr-sell" title="Cajas por encima del umbral (excedente)">Excedente</th>
              <th class="pr-r">Costo</th>
              <th class="pr-r pr-val" title="Capital inmovilizado = excedente × costo real">Inmovilizado</th>
            </tr>
          </ng-template>
          <ng-template pTemplate="body" let-r>
            <tr>
              <td><div class="pr-prod">{{ r.nombre }}</div><div class="pr-sku">{{ r.sku }}</div></td>
              <td class="pr-mono">{{ r.warehouse_code }}@if (r.is_hub) { <span class="pr-hub" title="CEDIS (medido vs demanda de red)">CEDIS</span> }</td>
              <td class="pr-supp">{{ r.supplier_name || '—' }}</td>
              <td class="pr-r pr-muted">{{ r.on_hand_cajas | number:'1.0-0' }}</td>
              <td class="pr-r">
                @if (r.days_on_hand != null) { <p-tag [value]="(r.days_on_hand | number:'1.0-0') + ' d'" severity="info" styleClass="pr-cov-tag"></p-tag> }
                @else { <span class="pr-muted">—</span> }
              </td>
              <td class="pr-r pr-sell pr-strong">{{ r.surplus_cajas | number:'1.0-0' }}</td>
              <td class="pr-r pr-muted">{{ money(r.unit_cost) }}</td>
              <td class="pr-r pr-val pr-strong">{{ money(r.immobilized_value) }}</td>
            </tr>
          </ng-template>
          <ng-template pTemplate="emptymessage">
            <tr><td colspan="8" class="pr-empty"><i class="pi pi-inbox"></i><p>Sin sobrestock.</p>
              <span>Ningún producto excede {{ overDays }} días de cobertura con estos filtros.</span></td></tr>
          </ng-template>
        </p-table>
        <p class="pr-foot">Excedente = existencia − demanda × {{ overDays }}d. El CEDIS se mide contra la demanda de RED (Σ sucursales que surte), no su venta directa. Valuado en cajas al costo real. Considera <a (click)="setMode('traspaso')" class="pr-link">traspasar</a> lo que falta en otra sucursal.</p>
      } @else {
        <!-- STOCK MUERTO: productos activos SIN rotación (capital inmovilizado) -->
        <div class="pr-filters">
          <p-iconfield styleClass="pr-search">
            <p-inputicon styleClass="pi pi-search" />
            <input pInputText type="text" [(ngModel)]="search" (keyup.enter)="loadDead()" placeholder="SKU o producto…" aria-label="Buscar producto" />
          </p-iconfield>
          @if (deadValue() > 0) { <span class="pr-count">{{ money(deadValue()) }} inmovilizado</span> }
        </div>
        <p-table [value]="deadRows()" [loading]="loading()" [scrollable]="true" scrollHeight="flex"
                 [paginator]="true" [rows]="50" [rowsPerPageOptions]="[50, 100, 200]"
                 styleClass="p-datatable-sm pr-table" [tableStyle]="{ 'min-width': '60rem' }">
          <ng-template pTemplate="header">
            <tr><th style="min-width:16rem">Producto</th><th style="width:5rem">Almacén</th><th class="pr-r">Existencia</th>
              <th class="pr-r">Costo</th><th class="pr-r pr-val">Inmovilizado</th><th>Última actividad</th><th>Proveedor</th></tr>
          </ng-template>
          <ng-template pTemplate="body" let-r>
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
          <ng-template pTemplate="emptymessage">
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
    :host ::ng-deep .pr-sel-sm { min-width: 10rem; }
    :host ::ng-deep .pr-search input { min-width: 12rem; }
    .pr-count { margin-left: auto; font-size: .8rem; color: var(--text-muted); }
    .pr-cov { display: inline-flex; align-items: center; gap: .4rem; font-size: .8rem; color: var(--text-muted); }
    :host ::ng-deep .pr-cov-in { width: 4.5rem; text-align: right; font-variant-numeric: tabular-nums; }
    .pr-toggle { display: inline-flex; align-items: center; gap: .35rem; font-size: .8rem; color: var(--text-muted); cursor: pointer; }
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
    .pr-rank { font-size: .68rem; color: var(--text-muted); font-variant-numeric: tabular-nums; }
    :host ::ng-deep .pr-abc { font-size: .6rem; padding: .02rem .3rem; line-height: 1.3; }
    .pr-hub { font-size: .58rem; text-transform: uppercase; letter-spacing: .05em; color: var(--action); margin-left: .3rem; vertical-align: middle; }
    .pr-link { color: var(--action); cursor: pointer; text-decoration: underline; }
    .pr-supp { color: var(--text-muted); font-size: .8rem; }
    .pr-mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .78rem; }
    .pr-strong { font-weight: 700; }
    .pr-sug { background: var(--overlay-selected, transparent); }
    th.pr-sell, td.pr-sell { background: var(--overlay-hover, transparent); }
    td.pr-sell { color: var(--text-main); }
    .pr-val { color: var(--text-main); }
    .pr-row-sel { background: var(--overlay-selected, var(--hover-bg)); }
    :host ::ng-deep .pr-qty { width: 5rem; text-align: right; font-variant-numeric: tabular-nums; padding: .2rem .35rem; }
    :host ::ng-deep .pr-cov-tag { font-variant-numeric: tabular-nums; }
    .pr-empty { text-align: center; color: var(--text-muted); padding: 2rem 1rem; }
    .pr-empty i { font-size: 1.6rem; display: block; margin-bottom: .5rem; color: var(--text-faint); }
    .pr-empty p { margin: 0 0 .25rem; font-weight: 600; color: var(--text-main); }
    .pr-empty span { font-size: .78rem; }
    .pr-state { display: flex; gap: .75rem; align-items: center; padding: 1.25rem; border: 1px solid var(--border-color); border-radius: var(--r-md, 12px); }
    .pr-error { color: var(--bad-fg); } .pr-error i { font-size: 1.4rem; } .pr-error p { margin: 0; color: var(--text-main); }
    .pr-foot { font-size: .72rem; color: var(--text-muted); margin-top: .5rem; }
    /* Bulk-bar sticky (aparece al seleccionar) */
    .pr-bulk { position: sticky; bottom: 0; display: flex; align-items: center; gap: .5rem; margin-top: .75rem; padding: .6rem .9rem;
      background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md, 12px); box-shadow: var(--shadow-sm, 0 1px 3px rgba(0,0,0,.08)); }
    .pr-bulk-n { font-size: .84rem; color: var(--text-main); font-variant-numeric: tabular-nums; }
    .pr-bulk-sp { flex: 1; }
  `],
})
export class ComprasPedidoRealComponent implements OnInit {
  private readonly api = inject(ComprasService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  rows = signal<Row[]>([]);
  tRows = signal<TRow[]>([]);
  deadRows = signal<DeadStockRow[]>([]);
  loading = signal(false);
  error = signal(false);
  dl = signal(false);
  saving = signal(false);
  mode = signal<Mode>('pedir');
  deadValue = signal(0);
  totalValor = signal(0);
  totalRevenue = signal(0);
  totalLines = signal(0);
  tTotalValor = signal(0);
  tTotalCajas = signal(0);
  tTotalMoves = signal(0);
  oRows = signal<OverstockRow[]>([]);
  oTotalValor = signal(0);
  oTotalCajas = signal(0);
  oTotalProds = signal(0);
  overDays = 90;
  private readonly selTick = signal(0); // fuerza recompute de KPIs de selección al editar
  private readonly tSelTick = signal(0);

  fSupplier: string | null = null;
  fWarehouse: string | null = null;
  fBucket: string | null = null;
  onlyNeeded = false;
  search = '';
  coverage = 30;
  neededCount = signal(0);

  readonly bucketOpts = [
    { label: 'Agotado', value: 'agotado' },
    { label: 'Crítico (<7 d)', value: 'critico' },
    { label: 'Bajo (< cobertura)', value: 'bajo' },
    { label: 'Sano', value: 'sano' },
    { label: 'Sobrestock (>90 d)', value: 'sobrestock' },
    { label: 'Sin venta ni stock', value: 'sin_dato' },
  ];

  private readonly filters = signal<ReplenishmentFilters | null>(null);
  supplierOpts = computed(() => (this.filters()?.suppliers ?? []).map((s) => ({ label: s.name, value: s.id })));
  warehouseOpts = computed(() => (this.filters()?.warehouses ?? []).map((w) => ({ label: `${w.code} · ${w.name}`, value: w.id })));

  ngOnInit(): void {
    this.api.filters().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (f) => this.filters.set(f), error: () => {} });
    this.reload();
  }

  setMode(m: Mode): void {
    if (this.mode() === m) return;
    this.mode.set(m);
    if (m === 'pedir') this.reload();
    else if (m === 'traspaso') this.loadTransfer();
    else if (m === 'sobrestock') this.loadOverstock();
    else this.loadDead();
  }

  loadOverstock(): void {
    this.loading.set(true); this.error.set(false);
    this.api.overstock({
      warehouse_id: this.fWarehouse || undefined, supplier_id: this.fSupplier || undefined,
      search: this.search.trim() || undefined, over_days: this.overDays, pageSize: 500,
    }).pipe(
      catchError(() => { this.error.set(true); return of(null as OverstockResponse | null); }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((r) => {
      this.loading.set(false);
      if (!r) { this.oRows.set([]); this.oTotalValor.set(0); this.oTotalCajas.set(0); this.oTotalProds.set(0); return; }
      this.oRows.set(r.rows);
      this.oTotalValor.set(Number(r.total_valor) || 0);
      this.oTotalCajas.set(Number(r.total_cajas) || 0);
      this.oTotalProds.set(Number(r.total) || 0);
    });
  }

  oKpiItems(): MetricStripItem[] {
    return [
      { label: 'Capital inmovilizado', value: this.oTotalValor(), format: 'currency', tone: 'warn' },
      { label: 'Cajas excedentes', value: this.oTotalCajas(), sub: '> ' + this.overDays + 'd cobertura' },
      { label: 'Productos', value: this.oTotalProds(), sub: 'sobrestockeados' },
      { label: 'Umbral', value: this.overDays, sub: 'días cobertura' },
    ];
  }

  loadTransfer(): void {
    this.loading.set(true); this.error.set(false);
    this.api.transferSuggestion({
      warehouse_id: this.fWarehouse || undefined, supplier_id: this.fSupplier || undefined,
      search: this.search.trim() || undefined, coverage_days: this.coverage, pageSize: 500,
    }).pipe(
      catchError(() => { this.error.set(true); return of(null as TransferSuggestionResponse | null); }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((r) => {
      this.loading.set(false);
      if (!r) { this.tRows.set([]); this.tTotalValor.set(0); this.tTotalCajas.set(0); this.tTotalMoves.set(0); return; }
      this.tRows.set(r.rows.map((x) => ({ ...x, _mover: Math.round(Number(x.transfer_cajas) || 0), _sel: false })));
      this.tTotalValor.set(Number(r.total_valor) || 0);
      this.tTotalCajas.set(Number(r.total_cajas) || 0);
      this.tTotalMoves.set(Number(r.total) || 0);
      this.tSelTick.update((n) => n + 1);
    });
  }

  tOnSel(): void { this.tSelTick.update((n) => n + 1); }
  tAllSel(): boolean { const r = this.tRows(); return r.length > 0 && r.every((x) => x._sel); }
  tToggleAll(v: boolean): void { this.tRows().forEach((x) => (x._sel = v)); this.tOnSel(); }
  private tSelected(): TRow[] { this.tSelTick(); return this.tRows().filter((x) => x._sel && Number(x._mover) > 0); }
  tSelCount = computed(() => { this.tSelTick(); return this.tRows().filter((x) => x._sel && Number(x._mover) > 0).length; });
  tSelValor = computed(() => { this.tSelTick(); return this.tRows().filter((x) => x._sel).reduce((s, x) => s + Number(x._mover) * Number(x.unit_cost || 0), 0); });

  tKpiItems(): MetricStripItem[] {
    return [
      { label: 'Valor a traspasar', value: this.tTotalValor(), format: 'currency', tone: 'brand' },
      { label: 'Cajas', value: this.tTotalCajas(), sub: 'del CEDIS a sucursal' },
      { label: 'Movimientos', value: this.tTotalMoves(), sub: 'producto × sucursal' },
      { label: 'Cobertura', value: this.coverage, sub: 'días objetivo' },
    ];
  }

  /** Arma traspaso(s): agrupa lo seleccionado por (sucursal destino × CEDIS origen) → una requisición transfer por grupo. */
  createTransfer(): void {
    const sel = this.tSelected();
    if (!sel.length) { this.toast.add({ severity: 'warn', summary: 'Nada seleccionado', detail: 'Marca líneas con cantidad a mover.' }); return; }
    const groups = new Map<string, TRow[]>();
    for (const r of sel) { const k = `${r.to_warehouse_id}|${r.from_warehouse_id}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(r); }
    this.saving.set(true);
    const dtos: CreateRequisitionDto[] = [...groups.values()].map((rs) => ({
      warehouse_id: rs[0].to_warehouse_id,
      supplier_id: null,
      source_type: 'branch',
      source_warehouse_id: rs[0].from_warehouse_id,
      notes: 'Traspaso CEDIS→sucursal (déficit × cobertura)',
      lines: rs.map<CreateRequisitionLine>((r) => ({
        product_id: r.product_id, source_type: 'branch', source_warehouse_id: r.from_warehouse_id,
        suggested_qty: Math.round(Number(r.transfer_cajas) || 0),
        final_qty: Math.round(Number(r._mover) || 0), unit_cost: Number(r.unit_cost) || 0,
      })),
    }));
    let done = 0; const folios: string[] = []; let failed = 0;
    const finish = () => {
      this.saving.set(false);
      if (folios.length) this.toast.add({ severity: 'success', summary: `${folios.length} traspaso(s)`, detail: folios.join(', ') });
      if (failed) this.toast.add({ severity: 'error', summary: 'Error parcial', detail: `${failed} no se pudieron crear.` });
      if (folios.length) this.loadTransfer();
    };
    dtos.forEach((dto) => {
      this.api.createRequisition(dto).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => { folios.push(r.folio); if (++done === dtos.length) finish(); },
        error: () => { failed++; if (++done === dtos.length) finish(); },
      });
    });
  }

  reload(): void {
    this.loading.set(true); this.error.set(false);
    this.api.purchaseSuggestion({
      supplier_id: this.fSupplier || undefined, warehouse_id: this.fWarehouse || undefined,
      bucket: this.fBucket || undefined, scope: this.onlyNeeded ? 'needed' : undefined,
      search: this.search.trim() || undefined, coverage_days: this.coverage, pageSize: 500,
    }).pipe(
      catchError(() => { this.error.set(true); return of(null as PurchaseSuggestionResponse | null); }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((r) => {
      this.loading.set(false);
      if (!r) { this.rows.set([]); this.totalValor.set(0); this.totalLines.set(0); this.neededCount.set(0); return; }
      this.rows.set(r.rows.map((x) => ({ ...x, _pedir: Math.round(Number(x.suggested_units) || 0), _sel: false })));
      this.totalValor.set(Number(r.total_valor) || 0);
      this.totalRevenue.set(Number(r.total_revenue) || 0);
      this.totalLines.set(Number(r.total) || 0);
      this.neededCount.set(Number(r.needed ?? r.total) || 0);
      this.selTick.update((n) => n + 1);
    });
  }

  loadDead(): void {
    this.loading.set(true);
    this.api.deadStock({ search: this.search.trim() || undefined, pageSize: 200 })
      .pipe(catchError(() => of(null)), takeUntilDestroyed(this.destroyRef))
      .subscribe((r) => { this.loading.set(false); this.deadRows.set(r?.rows ?? []); this.deadValue.set(Number(r?.total_value) || 0); });
  }

  setCoverage(d: number): void { this.coverage = d; this.mode() === 'traspaso' ? this.loadTransfer() : this.reload(); }
  onSel(): void { this.selTick.update((n) => n + 1); }
  allSel(): boolean { const r = this.rows(); return r.length > 0 && r.every((x) => x._sel); }
  toggleAll(v: boolean): void { this.rows().forEach((x) => (x._sel = v)); this.onSel(); }

  private selected(): Row[] { this.selTick(); return this.rows().filter((x) => x._sel && Number(x._pedir) > 0); }
  selCount = computed(() => { this.selTick(); return this.rows().filter((x) => x._sel && Number(x._pedir) > 0).length; });
  selValor = computed(() => { this.selTick(); return this.rows().filter((x) => x._sel).reduce((s, x) => s + Number(x._pedir) * Number(x.unit_cost || 0), 0); });

  kpiItems(): MetricStripItem[] {
    return [
      { label: 'Valor del pedido', value: this.totalValor(), format: 'currency', tone: 'brand' },
      { label: 'Venta 30d', value: this.totalRevenue(), format: 'currency', sub: 'del filtro' },
      { label: 'Por pedir', value: this.neededCount(), tone: this.neededCount() > 0 ? 'warn' : 'default', sub: 'bajo cobertura' },
      { label: 'Productos', value: this.totalLines(), sub: 'en el filtro' },
      { label: 'Cobertura', value: this.coverage, sub: 'días objetivo' },
    ];
  }

  abcSev(c: string | null): Sev {
    return c === 'A' ? 'success' : c === 'B' ? 'info' : c === 'C' ? 'secondary' : 'secondary';
  }

  /** RA-PRO.28 — etiqueta de la unidad de venta detectada. */
  unitLabel(src: string | undefined): string {
    return src === 'granel' ? 'granel' : src === 'revisar' ? 'revisar unidad' : src === 'manual' ? 'unidad fija' : '';
  }

  coverSev(d: number | null): Sev {
    if (d == null) return 'secondary';
    if (d < 7) return 'danger';
    if (d < 30) return 'warn';
    if (d > 90) return 'info';
    return 'success';
  }

  /** Fill rate: <80% malo (danger) · <95% flojo (warn) · resto ok (secondary, ya casi 100%). */
  fillSev(f: number | null | undefined): Sev {
    if (f == null) return 'secondary';
    if (f < 0.80) return 'danger';
    if (f < 0.95) return 'warn';
    return 'secondary';
  }

  /** Arma requisición(es): agrupa lo seleccionado por (proveedor × almacén de compra) → una por grupo. */
  createReq(): void {
    const sel = this.selected();
    if (!sel.length) { this.toast.add({ severity: 'warn', summary: 'Nada seleccionado', detail: 'Marca líneas con cantidad a pedir.' }); return; }
    const groups = new Map<string, Row[]>();
    for (const r of sel) { const k = `${r.supplier_id || 'none'}|${r.warehouse_id}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(r); }
    this.saving.set(true);
    const dtos: CreateRequisitionDto[] = [...groups.values()].map((rs) => ({
      warehouse_id: rs[0].warehouse_id,
      supplier_id: rs[0].supplier_id || null,
      notes: 'Demand-driven (venta × cobertura)',
      lines: rs.map<CreateRequisitionLine>((r) => ({
        product_id: r.product_id, supplier_id: r.supplier_id || null, source_type: 'supplier',
        on_hand: Math.round(Number(r.on_hand_units) || 0), suggested_qty: Math.round(Number(r.suggested_units) || 0),
        final_qty: Math.round(Number(r._pedir) || 0), unit_cost: Number(r.unit_cost) || 0,
      })),
    }));
    let done = 0, folios: string[] = [], failed = 0;
    const finish = () => {
      this.saving.set(false);
      if (folios.length) this.toast.add({ severity: 'success', summary: `${folios.length} requisición(es)`, detail: folios.join(', ') });
      if (failed) this.toast.add({ severity: 'error', summary: 'Error parcial', detail: `${failed} no se pudieron crear.` });
      if (folios.length) this.reload();
    };
    dtos.forEach((dto) => {
      this.api.createRequisition(dto).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => { folios.push(r.folio); if (++done === dtos.length) finish(); },
        error: () => { failed++; if (++done === dtos.length) finish(); },
      });
    });
  }

  /** Exporta lo seleccionado (o todo el filtro si no hay selección) al XLSX que ya se maneja. */
  exportXlsx(): void {
    const base = this.selected();
    const rows = base.length ? base : this.rows().filter((x) => Number(x._pedir) > 0);
    if (!rows.length) { this.toast.add({ severity: 'warn', summary: 'Nada que exportar' }); return; }
    const lines: PedidoExportLine[] = rows.map((r) => ({
      warehouse_code: r.warehouse_code, supplier_name: r.supplier_name, sku: r.sku, nombre: r.nombre,
      on_hand: Math.round(Number(r.on_hand_units) || 0), suggested_qty: Math.round(Number(r.suggested_units) || 0),
      uxc: r.uxc, cajas: Number(r._pedir), piezas: Number(r._pedir) * Number(r.uxc || 1),
      unit_cost: Number(r.unit_cost) || 0, line_cost: Number(r._pedir) * (Number(r.unit_cost) || 0),
    }));
    this.dl.set(true);
    this.api.exportPedidoXlsx({ title: 'Pedido sugerido (demanda)', basis: `cobertura ${this.coverage}d`, lines })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (resp) => { this.dl.set(false); saveXlsxResponse(resp, 'pedido-sugerido.xlsx'); },
        error: () => { this.dl.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo exportar.' }); },
      });
  }

  money(v: number | string | null | undefined): string {
    return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  }
}
