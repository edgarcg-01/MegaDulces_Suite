import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { SkeletonModule } from 'primeng/skeleton';
import { DialogModule } from 'primeng/dialog';
import { TagModule } from 'primeng/tag';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { DATE_PRESET_OPTIONS, datePresetRange } from '../../../shared/util';
import { ComprasService, SupplierLedgerResponse, SupplierLedgerRow, SupplierLedgerMove, SupplierInvoiceLedgerResponse, SupplierInvoiceTotals, InvoiceEstado, SupplierFiscalLedgerResponse, ContpaqiPayablesResponse, ContpaqiPayableRow } from '../compras.service';

/**
 * CXP.7 — "Cuadre contable por proveedor": estado de cuenta de la 201 (Proveedores) según
 * los libros de Kepler. Por proveedor: facturado (XA2001/XA1001) vs pagado (XD2601/XD2501)
 * vs notas (XD5501) vs devoluciones (XD4001) → Δ = movimiento neto de la deuda en el periodo.
 * Corroboración contable independiente de Compras 360. Read-only sobre analytics.gl_*.
 * Operations mode, PrimeNG-first.
 */
@Component({
  selector: 'app-compras-cuadre-proveedor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule, FormsModule, ButtonModule, InputTextModule, IconFieldModule, InputIconModule,
    TableModule, SelectModule, DatePickerModule, SkeletonModule, DialogModule, TagModule, MetricStripComponent,
  ],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Cuadre y deuda por proveedor</h1>
          <p class="surf-page-sub">Cuánto le debes a cada proveedor y su estado de cuenta. <b>Lo que se debe</b> = saldo real de ContPAQi (libros fiscales); <b>Movimiento</b> = facturado/pagado de Kepler (201) en el periodo. Clic en un proveedor → cuadre de 3 lentes (Contable · Por factura · Fiscal).</p>
        </div>
        <div class="cq-head-actions">
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="loading()" (click)="reload()"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Actualizar</span></button>
        </div>
      </header>

      <div class="cq-modebar" role="tablist" aria-label="Vista de entrada">
        <button type="button" role="tab" class="cq-mode" [class.is-active]="entryMode()==='debe'" [attr.aria-selected]="entryMode()==='debe'" (click)="setMode('debe')"><span class="pi pi-wallet" aria-hidden="true"></span>&nbsp;Lo que se debe (ContPAQi)</button>
        <button type="button" role="tab" class="cq-mode" [class.is-active]="entryMode()==='kepler'" [attr.aria-selected]="entryMode()==='kepler'" (click)="setMode('kepler')"><span class="pi pi-book" aria-hidden="true"></span>&nbsp;Movimiento (Kepler 201)</button>
      </div>

      <div class="cq-filters">
        <p-iconfield styleClass="cq-search">
          <p-inputicon styleClass="pi pi-search" />
          <input pInputText type="text" placeholder="Proveedor…" [ngModel]="search()" (ngModelChange)="onSearch($event)" class="p-inputtext-sm" aria-label="Buscar proveedor" />
        </p-iconfield>
        @if (entryMode() === 'kepler') {
          <p-select [options]="presetOpts" [ngModel]="preset()" (onChange)="onPreset($event.value)" optionLabel="label" optionValue="value" placeholder="Rango rápido" [showClear]="true" styleClass="cq-sel" ariaLabel="Rango de fecha rápido" />
          <p-datepicker [ngModel]="dateFrom()" (onSelect)="onDate('from', $event)" (onClear)="onDate('from', null)" dateFormat="yy-mm-dd" [showIcon]="true" [showClear]="true" appendTo="body" placeholder="Desde" styleClass="cq-dp" ariaLabel="Desde" />
          <p-datepicker [ngModel]="dateTo()" (onSelect)="onDate('to', $event)" (onClear)="onDate('to', null)" dateFormat="yy-mm-dd" [showIcon]="true" [showClear]="true" appendTo="body" placeholder="Hasta" styleClass="cq-dp" ariaLabel="Hasta" />
        } @else {
          <button pButton type="button" class="p-button-sm" [class.p-button-outlined]="!onlyStale()" (click)="toggleStale()"><span class="pi pi-clock" aria-hidden="true"></span>&nbsp;Solo saldos viejos</button>
        }
        @if (hasFilters()) {
          <button pButton type="button" class="p-button-sm p-button-text" (click)="clearFilters()"><span class="pi pi-filter-slash" aria-hidden="true"></span>&nbsp;Limpiar</button>
        }
      </div>

      @if (err(); as e) {
        <div class="cq-errbox" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span class="cq-errbox-txt">{{ e }}</span>
          <button pButton type="button" class="p-button-sm p-button-outlined" (click)="retry()" label="Reintentar"></button>
        </div>
      }

      @if (entryMode() === 'debe') {
        <!-- LO QUE SE DEBE (ContPAQi): saldo real de la 2120 por proveedor -->
        @if (payables(); as p) {
          <app-metric-strip [items]="payKpis(p)" ariaLabel="Totales de deuda a proveedores" />
        }
        @if (loading()) {
          <div class="cq-skel">@for (i of skelRows; track i) { <p-skeleton height="2rem" styleClass="cq-skel-row" /> }</div>
        } @else if (payables(); as p) {
          <p-table [value]="p.rows" styleClass="p-datatable-sm surf-table surf-table--sticky cq-table"
                   [rowHover]="true" [scrollable]="true" scrollHeight="flex" [paginator]="p.rows.length > 100" [rows]="100">
            <ng-template #header>
              <tr><th>Proveedor</th><th class="ta-r cq-w-amt">Se debe</th><th class="cq-w-mes">Último mov.</th></tr>
            </ng-template>
            <ng-template #body let-r>
              <tr class="cq-row" role="button" tabindex="0"
                  [attr.aria-label]="'Ver cuadre de ' + (r.proveedor || 'proveedor')"
                  (click)="openDebe(r)" (keydown.enter)="openDebe(r)" (keydown.space)="$event.preventDefault(); openDebe(r)">
                <td class="cq-prov" [title]="r.proveedor">{{ r.proveedor || '—' }} <span class="cq-drillhint" aria-hidden="true">→ cuadre</span></td>
                <td class="ta-r cq-num cq-strong" [class.cq-down]="r.saldo < 0">{{ money(r.saldo) }}</td>
                <td class="cq-w-mes"><span class="cq-mono muted">{{ r.hasta }}</span>@if (r.stale) { <p-tag value="viejo" severity="warn" styleClass="cq-tag" /> }</td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="3"><div class="cq-empty-op">
                <i class="pi pi-inbox" aria-hidden="true"></i>
                <span class="cq-empty-op-title">Sin saldos</span>
                @if (hasFilters()) {
                  <span class="cq-empty-op-sub">Ningún proveedor coincide con los filtros.</span>
                  <button pButton type="button" class="p-button-sm p-button-outlined" (click)="clearFilters()" label="Quitar filtros"></button>
                } @else {
                  <span class="cq-empty-op-sub">No hay saldos de proveedores en ContPAQi (o falta cargar la balanza en este entorno).</span>
                }
              </div></td></tr>
            </ng-template>
          </p-table>
          <p class="cq-foot">Saldo <b>acreedor</b> de la cuenta de proveedores (2120) en la balanza de ContPAQi = <b>lo que se debe</b> (apertura del ejercicio + Σ facturado − pagado del año). <span class="cq-down">Negativo</span> = pagado de más / saldo a favor. <b>Viejo</b> = ≥3 meses sin movimiento (saldo colgado, posible antigüedad). Al cierre de <b>{{ p.as_of }}</b>. <b>Clic en una fila</b> → cuadre de 3 lentes.</p>
        }
      } @else {
        <!-- MOVIMIENTO (Kepler 201): facturado/pagado/notas/Δ del periodo -->
        @if (data(); as d) {
          <app-metric-strip [items]="kpiItems(d)" ariaLabel="Totales del cuadre por proveedor" />
        }
        @if (loading()) {
          <div class="cq-skel">@for (i of skelRows; track i) { <p-skeleton height="2rem" styleClass="cq-skel-row" /> }</div>
        } @else if (data(); as d) {
          <p-table [value]="d.rows" [loading]="false" styleClass="p-datatable-sm surf-table surf-table--sticky cq-table"
                   [rowHover]="true" [scrollable]="true" scrollHeight="flex">
            <ng-template #header>
              <tr>
                <th>Proveedor</th>
                <th class="ta-r cq-w-amt">Facturado</th>
                <th class="ta-r cq-w-amt">Pagado</th>
                <th class="ta-r cq-w-amt">Notas</th>
                <th class="ta-r cq-w-amt">Devol.</th>
                <th class="ta-r cq-w-amt">Δ periodo</th>
              </tr>
            </ng-template>
            <ng-template #body let-r>
              <tr class="cq-row" role="button" tabindex="0"
                  [attr.aria-label]="'Ver desglose de ' + (r.proveedor || 'sin referencia')"
                  (click)="openKepler(r)" (keydown.enter)="openKepler(r)" (keydown.space)="$event.preventDefault(); openKepler(r)">
                <td class="cq-prov" [title]="r.proveedor">{{ r.proveedor || '—' }} <span class="cq-drillhint" aria-hidden="true">→ desglose</span></td>
                <td class="ta-r cq-num">{{ money(r.facturado) }}</td>
                <td class="ta-r cq-num">{{ r.pagado ? money(r.pagado) : '—' }}</td>
                <td class="ta-r cq-num" [class.cq-pos]="r.notas > 0">{{ r.notas ? money(r.notas) : '—' }}</td>
                <td class="ta-r cq-num">{{ r.devoluciones ? money(r.devoluciones) : '—' }}</td>
                <td class="ta-r cq-num cq-strong" [class.cq-up]="r.delta > 0" [class.cq-down]="r.delta < 0">{{ money(r.delta) }}</td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="6">
                <div class="cq-empty-op">
                  <i class="pi pi-inbox" aria-hidden="true"></i>
                  <span class="cq-empty-op-title">Sin movimientos</span>
                  @if (hasFilters()) {
                    <span class="cq-empty-op-sub">Ningún proveedor coincide con los filtros actuales.</span>
                    <button pButton type="button" class="p-button-sm p-button-outlined" (click)="clearFilters()" label="Quitar filtros"></button>
                  } @else {
                    <span class="cq-empty-op-sub">No hay pólizas de proveedor (201) en el periodo (o falta el feed de pólizas de Kepler).</span>
                  }
                </div>
              </td></tr>
            </ng-template>
          </p-table>
          <p class="cq-foot">Movimiento de la cuenta <b>201 Proveedores</b> en los libros de Kepler: <b>Facturado</b> = abonos (XA2001/comprobación) · <b>Pagado</b> = cargos de pago (XD2601/XD2501) · <b>Notas</b> = notas de crédito (XD5501) · <b>Devol.</b> = devoluciones (XD4001). <b>Δ</b> = facturado − pagado − notas − devol (movimiento del periodo; no incluye saldo de apertura). Algunas filas son entidades internas (el dueño, sucursales). <b>Clic en una fila</b> para ver el desglose.</p>
        }
      }
    </div>

    <p-dialog [visible]="!!detail()" (visibleChange)="!$event && closeDetail()" [modal]="true" [dismissableMask]="true" [style]="{ width: '1040px', maxWidth: '96vw' }" [header]="detail()?.proveedor || 'Desglose'">
      @if (detail(); as d) {
        <div class="cq-dt-tabs" role="tablist" aria-label="Lente del desglose">
          <button type="button" role="tab" class="cq-dt-tab" [class.is-active]="dtTab()==='contable'" [attr.aria-selected]="dtTab()==='contable'" (click)="setTab('contable')">Contable (201)</button>
          <button type="button" role="tab" class="cq-dt-tab" [class.is-active]="dtTab()==='factura'" [attr.aria-selected]="dtTab()==='factura'" (click)="setTab('factura')">Por factura</button>
          <button type="button" role="tab" class="cq-dt-tab" [class.is-active]="dtTab()==='fiscal'" [attr.aria-selected]="dtTab()==='fiscal'" (click)="setTab('fiscal')">Fiscal (ContPAQi)</button>
        </div>
        @if (dtTab() === 'contable') {
        @if (movesLoading()) {
          <p class="cq-empty">Cargando movimientos…</p>
        } @else if (moves().length === 0) {
          <p class="cq-empty">Sin movimientos en la 201 para este proveedor en el periodo.</p>
        } @else {
          <!-- Comparación estricta: cada renglón alinea una compra (izq) con un pago/crédito (der)
               en el MISMO <tr> → misma altura y mismo ancho por construcción. Se rellena con vacío
               el lado más corto. Alineación posicional/cronológica (Kepler no liga 1:1). -->
          <p-table [value]="pairedRows()" styleClass="p-datatable-sm surf-table cq-cmp" [scrollable]="true" scrollHeight="52vh" [rowHover]="true">
            <ng-template #header>
              <tr class="cq-cmp-grp">
                <th colspan="4" class="cq-grp cq-grp--debe"><i class="pi pi-arrow-up-right" aria-hidden="true"></i> Compras (facturado) <span class="cq-grp-tot">{{ money(totalCompras()) }} · {{ comprasMoves().length }}</span></th>
                <th colspan="4" class="cq-grp cq-grp--haber cq-coldiv"><i class="pi pi-arrow-down-left" aria-hidden="true"></i> Pagos y créditos <span class="cq-grp-tot">{{ money(totalPagos()) }} · {{ pagosMoves().length }}</span></th>
              </tr>
              <tr>
                <th class="cq-w-date">Fecha</th><th class="cq-w-folio">Folio</th><th class="cq-w-suc">Suc</th><th class="ta-r cq-w-amt">Importe</th>
                <th class="cq-w-date cq-coldiv">Fecha</th><th class="cq-w-tipo">Tipo</th><th class="cq-w-folio">Folio</th><th class="ta-r cq-w-amt">Importe</th>
              </tr>
            </ng-template>
            <ng-template #body let-row>
              <tr class="cq-cmp-row">
                @if (row.c; as m) {
                  <td class="cq-mono">{{ m.fecha ? (m.fecha | date:'yyyy-MM-dd') : m.anio_mes }}</td>
                  <td class="cq-mono muted">{{ m.folio }}</td>
                  <td class="cq-mono muted">{{ m.sucursal }}</td>
                  <td class="ta-r cq-num cq-debe">{{ money(m.importe) }}</td>
                } @else {
                  <td class="cq-blank" colspan="4"></td>
                }
                @if (row.p; as m) {
                  <td class="cq-mono cq-coldiv">{{ m.fecha ? (m.fecha | date:'yyyy-MM-dd') : m.anio_mes }}</td>
                  <td><p-tag [value]="m.tipo_label" [severity]="tagSev(m.categoria)" styleClass="cq-tag" /></td>
                  <td class="cq-mono muted">{{ m.folio }}</td>
                  <td class="ta-r cq-num cq-haber">{{ money(m.importe) }}</td>
                } @else {
                  <td class="cq-blank cq-coldiv" colspan="4"></td>
                }
              </tr>
            </ng-template>
          </p-table>
          <!-- BALANCE: Compras − Pagos = lo que falta pagar -->
          <div class="cq-balance" [class.cq-balance--pend]="pendiente() > 0" [class.cq-balance--over]="pendiente() < 0">
            <div class="cq-bal-cell"><span class="cq-bal-lbl">Compras</span><span class="cq-bal-val">{{ money(totalCompras()) }}</span></div>
            <span class="cq-bal-op">−</span>
            <div class="cq-bal-cell"><span class="cq-bal-lbl">Pagos y créditos</span><span class="cq-bal-val">{{ money(totalPagos()) }}</span></div>
            <span class="cq-bal-op">=</span>
            <div class="cq-bal-cell cq-bal-res">
              <span class="cq-bal-lbl">{{ pendiente() > 0.5 ? 'Sin pagar (falta)' : pendiente() < -0.5 ? 'Pagado de más' : 'Cuadrado' }}</span>
              <span class="cq-bal-val">{{ money(absVal(pendiente())) }}</span>
            </div>
          </div>
          <p class="cq-dt-note">Cuenta-T de la <b>201 Proveedores</b> (Kepler). <b>Compras</b> = facturado (sube deuda) · <b>Pagos y créditos</b> = pagos, notas y devoluciones (bajan deuda). <b>Pendiente</b> = Compras − Pagos: lo no cubierto en el periodo (movimiento neto, sin saldo de apertura). Cada renglón alinea la compra y el pago de la <b>misma posición cronológica</b> (ambos lados ordenados por fecha) — Kepler <b>no liga factura↔pago 1:1</b>, así que es un cuadre por totales del periodo, no una liga línea a línea.</p>
        }
        } @else if (dtTab() === 'factura') {
          <!-- POR FACTURA (documental): cada entrada real con estado de pago estimado FIFO -->
          @if (invoiceLoading()) {
            <p class="cq-empty">Cargando facturas…</p>
          } @else if (invoice(); as inv) {
            @if (!inv.found || !inv.totals) {
              <p class="cq-empty">No se encontró este proveedor en el feed de facturas (entradas). El nombre en la 201 puede no coincidir con el catálogo de compras de Kepler.</p>
            } @else {
              <div class="cq-dt-kpis">
                <span>Facturas <b>{{ inv.totals.n_facturas }}</b></span>
                <span>Facturado <b>{{ money(inv.totals.facturado) }}</b></span>
                <span>Pagado <b>{{ money(inv.totals.pagado) }}</b></span>
                <span>Saldo <b>{{ money(inv.totals.saldo) }}</b></span>
              </div>
              <div class="cq-inv-legend">
                <p-tag value="Pagadas" severity="success" styleClass="cq-tag" /><span class="cq-lgn">{{ inv.totals.n_pagadas }}</span>
                <p-tag value="Parcial" severity="warn" styleClass="cq-tag" /><span class="cq-lgn">{{ inv.totals.n_parciales }}</span>
                <p-tag value="Pendiente" severity="danger" styleClass="cq-tag" /><span class="cq-lgn">{{ inv.totals.n_pendientes }}</span>
                @if (inv.totals.anticipo > 0.5) { <span class="cq-anticipo">· anticipo / saldo a favor {{ money(inv.totals.anticipo) }}</span> }
              </div>
              @if (inv.totals.contable; as c) {
                <div class="cq-xcheck" [class.cq-xcheck--warn]="contableIncompleto(inv.totals)">
                  <i class="pi" [class.pi-info-circle]="!contableIncompleto(inv.totals)" [class.pi-exclamation-triangle]="contableIncompleto(inv.totals)" aria-hidden="true"></i>
                  <span>Contable <b>201</b>: facturado {{ money(c.facturado) }} · saldo {{ money(c.saldo) }}. @if (contableIncompleto(inv.totals)) { El 201 de Kepler registra <b>menos</b> que las facturas reales → póliza contable incompleta; para este proveedor el cuadre <b>documental</b> es el confiable. } @else { Concuerda a grandes rasgos con lo documental. }</span>
                </div>
              }
              <p-table [value]="inv.rows" styleClass="p-datatable-sm surf-table cq-inv" [scrollable]="true" scrollHeight="46vh" [rowHover]="true">
                <ng-template #header>
                  <tr>
                    <th class="cq-w-date">Fecha</th>
                    <th class="cq-w-folio">Folio</th>
                    <th class="cq-w-folio">OC</th>
                    <th class="ta-r cq-w-amt">Neto</th>
                    <th class="cq-w-estado">Estado</th>
                    <th class="ta-r cq-w-amt">Pendiente</th>
                  </tr>
                </ng-template>
                <ng-template #body let-r>
                  <tr>
                    <td class="cq-mono">{{ r.fecha ? (r.fecha | date:'yyyy-MM-dd') : '—' }}</td>
                    <td class="cq-mono muted" [title]="r.ajuste ? ('Bruto ' + money(r.bruto) + ' − ajuste ' + money(r.ajuste) + ' = neto ' + money(r.neto)) : ''">{{ r.folio }}@if (r.ajuste) { <span class="cq-adjmark" aria-hidden="true">*</span> }</td>
                    <td class="cq-mono muted">{{ r.oc_folio || '—' }}</td>
                    <td class="ta-r cq-num">{{ money(r.neto) }}</td>
                    <td><p-tag [value]="estadoLabel(r.estado)" [severity]="estadoSev(r.estado)" styleClass="cq-tag" /></td>
                    <td class="ta-r cq-num" [class.cq-strong]="r.pendiente > 0.5">{{ r.pendiente > 0.5 ? money(r.pendiente) : '—' }}</td>
                  </tr>
                </ng-template>
              </p-table>
              <p class="cq-dt-note">Cada fila es una <b>factura/entrada real</b> (recepciones de Kepler). El <b>estado de pago es una estimación FIFO</b>: los pagos del proveedor —que Kepler asienta <b>batcheados</b>, sin ligar folio a folio— se aplican a las facturas <b>más antiguas primero</b>. Por eso las pendientes suelen ser las más recientes (no necesariamente vencidas). <b>Neto</b> = factura − ajustes ligados por folio (devolución/nota, marcadas con <b>*</b>). Histórico completo del proveedor (máx. 300 filas, más recientes primero).</p>
            }
          }
        } @else {
          <!-- FISCAL (ContPAQi): las 3 verdades del proveedor + movimientos ContPAQi -->
          @if (fiscalLoading()) {
            <p class="cq-empty">Cargando libros fiscales…</p>
          } @else if (fiscal(); as fx) {
            <table class="cq-3way">
              <thead>
                <tr><th>Libro</th><th class="ta-r">Facturado</th><th class="ta-r">Pagado</th><th class="ta-r">Saldo</th></tr>
              </thead>
              <tbody>
                <tr class="cq-3way-best">
                  <td>Kepler operativo <span class="cq-3way-tag">facturas/pagos reales</span></td>
                  @if (fx.operativo; as o) {
                    <td class="ta-r cq-num">{{ money(o.facturado) }}</td><td class="ta-r cq-num">{{ money(o.pagado) }}</td><td class="ta-r cq-num cq-strong">{{ money(o.saldo) }}</td>
                  } @else { <td class="ta-r muted cq-3way-nd" colspan="3">sin datos</td> }
                </tr>
                <tr>
                  <td>Kepler contable <span class="cq-3way-tag">cuenta 201</span></td>
                  @if (fx.contable; as c) {
                    <td class="ta-r cq-num">{{ money(c.facturado) }}</td><td class="ta-r cq-num">{{ money(c.pagado) }}</td><td class="ta-r cq-num">{{ money(c.saldo) }}</td>
                  } @else { <td class="ta-r muted cq-3way-nd" colspan="3">sin datos</td> }
                </tr>
                <tr class="cq-3way-fiscal">
                  <td>ContPAQi fiscal <span class="cq-3way-tag">cuenta 2120@if (fx.contpaqi.ejercicio) { · ej. {{ fx.contpaqi.ejercicio }}}</span></td>
                  @if (fx.contpaqi.matched) {
                    <td class="ta-r cq-num">{{ money(fx.contpaqi.facturado) }}</td><td class="ta-r cq-num">{{ money(fx.contpaqi.pagado) }}</td><td class="ta-r cq-num cq-strong" [title]="'Saldo REAL con apertura = lo que se debe'">{{ money(fx.contpaqi.saldo) }}</td>
                  } @else { <td class="ta-r muted cq-3way-nd" colspan="3">no ligado a ContPAQi</td> }
                </tr>
              </tbody>
            </table>
            @if (!fx.contpaqi.matched) {
              <div class="cq-xcheck cq-xcheck--warn"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span>Este proveedor <b>no se pudo ligar a ContPAQi</b> por nombre (los libros usan otra grafía/ortografía). Sin comparación fiscal para este.</span></div>
            } @else {
              @if (fx.contpaqi.saldo_ini) {
                <p class="cq-fiscal-ini">Saldo inicial del ejercicio {{ fx.contpaqi.ejercicio }}: <b>{{ money(fx.contpaqi.saldo_ini) }}</b> · saldo actual (lo que se debe): <b>{{ money(fx.contpaqi.saldo) }}</b></p>
              }
              <p-table [value]="fx.rows" styleClass="p-datatable-sm surf-table cq-inv" [scrollable]="true" scrollHeight="36vh" [rowHover]="true">
                <ng-template #header>
                  <tr><th class="cq-w-date">Mes</th><th class="ta-r cq-w-amt">Facturado</th><th class="ta-r cq-w-amt">Pagado</th><th class="ta-r cq-w-amt">Saldo</th></tr>
                </ng-template>
                <ng-template #body let-r>
                  <tr>
                    <td class="cq-mono">{{ r.anio_mes }}</td>
                    <td class="ta-r cq-num">{{ r.abonos ? money(r.abonos) : '—' }}</td>
                    <td class="ta-r cq-num">{{ r.cargos ? money(r.cargos) : '—' }}</td>
                    <td class="ta-r cq-num cq-strong">{{ money(r.saldo) }}</td>
                  </tr>
                </ng-template>
              </p-table>
            }
            <p class="cq-dt-note"><b>Tres libros del mismo proveedor.</b> <b>Kepler operativo</b> = facturas/pagos reales (el más completo, ver "Por factura"). <b>Kepler contable</b> = cuenta 201 (póliza). <b>ContPAQi fiscal</b> = cuenta de proveedores <b>2120</b> de la balanza (SoR contable). El <b>saldo de ContPAQi es el REAL</b> (incluye saldo de apertura del ejercicio) = <b>lo que se debe</b>; facturado/pagado son los movimientos del año. Kepler no trae apertura → su "saldo" es solo movimiento. <b>No atan al peso</b> (distinto alcance/periodo). Match Kepler↔ContPAQi por <b>nombre normalizado</b>; si difiere la grafía, no liga.</p>
          }
        }
      }
    </p-dialog>
  `,
  styles: [`
    :host { display:block; }
    .surf-page-head { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap; }
    .cq-head-actions { display:flex; gap:.5rem; }
    .cq-filters { display:flex; flex-wrap:wrap; gap:.6rem; align-items:center; margin:1rem 0 .6rem; }
    .cq-search input { min-width:220px; }
    :host ::ng-deep .cq-sel { min-width:11rem; }
    .cq-modebar { display:flex; gap:.3rem; margin:.8rem 0 .2rem; border-bottom:1px solid var(--border-color); flex-wrap:wrap; }
    .cq-mode { appearance:none; background:none; border:0; border-bottom:2px solid transparent; padding:.5rem .9rem; font:inherit; font-size:.86rem; color:var(--text-muted); cursor:pointer; display:inline-flex; align-items:center; }
    .cq-mode:hover { color:var(--text-main); }
    .cq-mode.is-active { color:var(--text-main); border-bottom-color:var(--action); font-weight:600; }
    .cq-mode:focus-visible { outline:2px solid var(--action-ring); outline-offset:-2px; border-radius:var(--r-sm); }
    .cq-w-mes { width:9rem; }
    .cq-table { margin-top:.6rem; }
    .cq-row { cursor:pointer; }
    .cq-row:focus-visible { outline:2px solid var(--action-ring); outline-offset:-2px; }
    .cq-drillhint { font-size:.72rem; color:var(--text-faint); margin-left:.35rem; }
    .ta-r { text-align:right; }
    .cq-num { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .cq-mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .muted { color:var(--text-faint); }
    .cq-strong { font-weight:700; }
    .cq-pos { color:var(--ok-fg); }
    .cq-up { color:var(--warn-fg); }
    .cq-down { color:var(--ok-fg); }
    .cq-w-amt { width:8.5rem; }
    .cq-w-date { width:6rem; } .cq-w-tipo { width:9.5rem; } .cq-w-folio { width:6rem; } .cq-w-suc { width:3.5rem; }
    .cq-prov { max-width:340px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    /* desglose (dialog) */
    .cq-dt-kpis { display:flex; flex-wrap:wrap; gap:1rem; margin-bottom:.8rem; font-size:.8rem; color:var(--text-muted); }
    .cq-dt-kpis b { color:var(--text-main); font-family:var(--font-mono); margin-left:.2rem; }
    .cq-dt-table { font-size:.8rem; }
    .cq-dt-note { font-size:.72rem; color:var(--text-faint); margin-top:.6rem; line-height:1.5; }
    .cq-empty { padding:1.4rem; text-align:center; color:var(--text-faint); font-size:.85rem; }
    /* Pestañas del desglose (contable 201 | por factura) */
    .cq-dt-tabs { display:flex; gap:.3rem; margin-bottom:.9rem; border-bottom:1px solid var(--border-color); }
    .cq-dt-tab { appearance:none; background:none; border:0; border-bottom:2px solid transparent; padding:.45rem .8rem; font:inherit; font-size:.82rem; color:var(--text-muted); cursor:pointer; }
    .cq-dt-tab:hover { color:var(--text-main); }
    .cq-dt-tab.is-active { color:var(--text-main); border-bottom-color:var(--action); font-weight:600; }
    .cq-dt-tab:focus-visible { outline:2px solid var(--action-ring); outline-offset:-2px; border-radius:var(--r-sm); }
    /* Vista por factura (documental, FIFO) */
    .cq-inv-legend { display:flex; align-items:center; gap:.35rem; flex-wrap:wrap; font-size:.78rem; color:var(--text-muted); margin-bottom:.6rem; }
    .cq-inv-legend .cq-lgn { margin-right:.7rem; font-family:var(--font-mono); font-variant-numeric:tabular-nums; }
    .cq-anticipo { color:var(--ok-fg); }
    .cq-xcheck { display:flex; align-items:flex-start; gap:.5rem; padding:.55rem .75rem; margin-bottom:.7rem; border:1px solid var(--border-color); border-left:3px solid var(--text-faint); border-radius:var(--r-md); background:var(--card-bg); font-size:.78rem; color:var(--text-muted); line-height:1.5; }
    .cq-xcheck b { color:var(--text-main); }
    .cq-xcheck .pi { margin-top:.1rem; color:var(--text-faint); }
    .cq-xcheck--warn { border-left-color:var(--warn-fg); }
    .cq-xcheck--warn .pi { color:var(--warn-fg); }
    .cq-adjmark { color:var(--warn-fg); font-weight:700; margin-left:.1rem; }
    .cq-w-estado { width:6.5rem; }
    /* 3-vías (fiscal): un renglón por libro */
    .cq-3way { width:100%; border-collapse:collapse; margin-bottom:.8rem; font-size:.82rem; }
    .cq-3way th, .cq-3way td { padding:.5rem .7rem; border-bottom:1px solid var(--border-color); }
    .cq-3way th { text-align:left; font-weight:600; color:var(--text-muted); font-size:.72rem; text-transform:uppercase; letter-spacing:.03em; }
    .cq-3way td { color:var(--text-main); }
    .cq-3way .cq-num { font-family:var(--font-mono); font-variant-numeric:tabular-nums; }
    .cq-3way-best td { background:color-mix(in srgb, var(--ok-fg) 8%, transparent); }
    .cq-3way-tag { display:inline-block; margin-left:.4rem; font-size:.68rem; color:var(--text-faint); }
    .cq-3way-nd { font-style:italic; }
    :host ::ng-deep .cq-3way-fiscal td:last-child { font-weight:700; }
    .cq-fiscal-ini { font-size:.78rem; color:var(--text-muted); margin:.2rem 0 .7rem; }
    .cq-fiscal-ini b { color:var(--text-main); font-family:var(--font-mono); }
    :host ::ng-deep .cq-tag { font-size:.64rem; }
    /* Comparación estricta: una sola tabla, dos mitades (Compras | Pagos) alineadas renglón a
       renglón. Divisor central en la 5ª columna; celdas vacías tenues donde no hay contraparte. */
    .cq-debe { color:var(--warn-fg); }
    .cq-haber { color:var(--ok-fg); }
    :host ::ng-deep .cq-cmp .cq-grp { text-align:left; font-weight:700; font-size:.78rem; padding:.5rem .7rem; }
    :host ::ng-deep .cq-cmp .cq-grp .cq-grp-tot { float:right; font-family:var(--font-mono); font-variant-numeric:tabular-nums; font-weight:600; }
    :host ::ng-deep .cq-cmp .cq-grp--debe { color:var(--warn-fg); }
    :host ::ng-deep .cq-cmp .cq-grp--haber { color:var(--ok-fg); }
    :host ::ng-deep .cq-cmp .cq-coldiv { border-left:2px solid var(--border-color); }
    :host ::ng-deep .cq-cmp .cq-blank { background:color-mix(in srgb, var(--border-color) 14%, transparent); }
    .cq-balance { display:flex; align-items:stretch; gap:.6rem; margin-top:.9rem; padding:.7rem .9rem; border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); }
    .cq-bal-cell { display:flex; flex-direction:column; gap:.15rem; flex:1; min-width:0; }
    .cq-bal-lbl { font-size:.7rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:.03em; }
    .cq-bal-val { font-family:var(--font-mono); font-variant-numeric:tabular-nums; font-weight:700; }
    .cq-bal-op { align-self:center; color:var(--text-faint); font-family:var(--font-mono); font-size:1.1rem; }
    .cq-bal-res { border-left:1px solid var(--border-color); padding-left:.8rem; }
    .cq-balance--pend .cq-bal-res, .cq-balance--pend .cq-bal-res .cq-bal-lbl { color:var(--bad-fg); }
    .cq-balance--over .cq-bal-res, .cq-balance--over .cq-bal-res .cq-bal-lbl { color:var(--ok-fg); }
    .cq-foot { margin-top:1.2rem; font-size:.74rem; color:var(--text-faint); line-height:1.55; }
    .cq-errbox { display:flex; align-items:center; gap:.6rem; padding:.7rem .85rem; margin:.2rem 0 .6rem; border:1px solid var(--bad-border, var(--border-color)); border-left:3px solid var(--bad-fg); border-radius:var(--r-md); background:var(--card-bg); }
    .cq-errbox .pi { color:var(--bad-fg); }
    .cq-errbox-txt { flex:1; font-size:.84rem; color:var(--text-main); }
    .cq-empty-op { display:flex; flex-direction:column; align-items:center; gap:.4rem; padding:2.4rem 1rem; text-align:center; }
    .cq-empty-op .pi { font-size:1.6rem; color:var(--text-faint); }
    .cq-empty-op-title { font-weight:600; color:var(--text-main); }
    .cq-empty-op-sub { font-size:.84rem; color:var(--text-muted); max-width:32rem; }
    .cq-skel { display:flex; flex-direction:column; gap:.4rem; margin-top:1.2rem; padding:.3rem 0; }
    app-metric-strip { display:block; margin:.9rem 0; }
  `],
})
export class ComprasCuadreProveedorComponent implements OnInit {
  private readonly svc = inject(ComprasService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly data = signal<SupplierLedgerResponse | null>(null);        // modo 'kepler' (movimiento 201)
  readonly payables = signal<ContpaqiPayablesResponse | null>(null);  // modo 'debe' (ContPAQi, lo que se debe)
  readonly entryMode = signal<'debe' | 'kepler'>('debe');
  readonly onlyStale = signal(false);
  readonly loading = signal(false);
  readonly err = signal<string | null>(null);
  readonly search = signal('');
  readonly dateFrom = signal<Date | null>(null);
  readonly dateTo = signal<Date | null>(null);
  readonly preset = signal<string>('');
  readonly presetOpts = DATE_PRESET_OPTIONS;
  private searchTimer: any;
  readonly skelRows = Array.from({ length: 8 });
  // Drill (3 lentes) del proveedor. `drillName` = nombre que resuelve las lentes Kepler (para filas
  // ContPAQi, el nombre Kepler mapeado); `proveedor` = etiqueta a mostrar.
  readonly detail = signal<{ proveedor: string; drillName: string } | null>(null);
  readonly moves = signal<SupplierLedgerMove[]>([]);
  readonly movesLoading = signal(false);
  readonly saldoFinal = signal(0);
  // Lente del desglose: 'contable' (201) | 'factura' (documental FIFO). La vista por factura se
  // carga bajo demanda (histórico completo del proveedor, ignora el rango de fecha del cuadre).
  readonly dtTab = signal<'contable' | 'factura' | 'fiscal'>('contable');
  readonly invoice = signal<SupplierInvoiceLedgerResponse | null>(null);
  readonly invoiceLoading = signal(false);
  readonly fiscal = signal<SupplierFiscalLedgerResponse | null>(null);
  readonly fiscalLoading = signal(false);
  // Cuenta-T: compras (facturado, sube deuda) a la izquierda; pagos/notas/devoluciones (bajan) a la
  // derecha. `signed` > 0 = compra · < 0 = pago/crédito (lo escribe el backend por categoría).
  readonly comprasMoves = computed(() => this.moves().filter((m) => m.signed > 0));
  readonly pagosMoves = computed(() => this.moves().filter((m) => m.signed < 0));
  readonly totalCompras = computed(() => this.comprasMoves().reduce((s, m) => s + Math.abs(m.importe || 0), 0));
  readonly totalPagos = computed(() => this.pagosMoves().reduce((s, m) => s + Math.abs(m.importe || 0), 0));
  readonly pendiente = computed(() => this.totalCompras() - this.totalPagos());
  // Comparación estricta uno-a-uno: cada renglón alinea la i-ésima compra con el i-ésimo pago/crédito
  // (ambos lados ordenados por fecha), rellenando con vacío el lado más corto → mismas filas, misma
  // altura por construcción. Kepler NO liga factura↔pago 1:1; la alineación es posicional/cronológica.
  readonly pairedRows = computed(() => {
    const c = [...this.comprasMoves()].sort((a, b) => this.byFecha(a, b));
    const p = [...this.pagosMoves()].sort((a, b) => this.byFecha(a, b));
    const n = Math.max(c.length, p.length);
    return Array.from({ length: n }, (_, i) => ({ c: c[i] ?? null, p: p[i] ?? null }));
  });
  private byFecha(a: SupplierLedgerMove, b: SupplierLedgerMove): number {
    const ka = a.fecha || a.anio_mes || ''; const kb = b.fecha || b.anio_mes || '';
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  }

  ngOnInit(): void {
    const q = this.route.snapshot.queryParamMap;
    this.search.set(q.get('q') || '');
    this.dateFrom.set(this.fromIso(q.get('from')));
    this.dateTo.set(this.fromIso(q.get('to')));
    this.reload();
  }

  /** Date → 'YYYY-MM-DD' (local, sin correr por TZ). */
  private toIso(d: Date | null): string | undefined {
    if (!d) return undefined;
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  }
  /** 'YYYY-MM-DD' → Date (local). */
  private fromIso(s: string | null): Date | null {
    if (!s) return null;
    const [y, m, d] = s.split('-').map(Number);
    return y && m && d ? new Date(y, m - 1, d) : null;
  }

  reload(): void {
    this.loading.set(true); this.err.set(null);
    if (this.entryMode() === 'debe') {
      this.svc.contpaqiPayables({ search: this.search() || undefined, only_stale: this.onlyStale() })
        .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
          next: (p) => { this.payables.set(p); this.loading.set(false); },
          error: () => { this.loading.set(false); this.err.set('No se pudo cargar la deuda a proveedores (ContPAQi).'); },
        });
    } else {
      this.svc.supplierLedger({ search: this.search() || undefined, date_from: this.toIso(this.dateFrom()), date_to: this.toIso(this.dateTo()) })
        .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
          next: (d) => { this.data.set(d); this.loading.set(false); },
          error: () => { this.loading.set(false); this.err.set('No se pudo cargar el movimiento por proveedor.'); },
        });
    }
  }

  retry(): void { this.err.set(null); this.reload(); }

  private syncUrl(): void {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { q: this.search().trim() || null, from: this.toIso(this.dateFrom()) || null, to: this.toIso(this.dateTo()) || null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  onSearch(v: string): void {
    this.search.set(v);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => { this.syncUrl(); this.reload(); }, 320);
  }

  onDate(which: 'from' | 'to', v: Date | null): void {
    (which === 'from' ? this.dateFrom : this.dateTo).set(v);
    this.preset.set(''); this.syncUrl(); this.reload();
  }

  onPreset(key: string | null): void {
    this.preset.set(key || '');
    const r = key ? datePresetRange(key) : null;
    if (!r) return;
    this.dateFrom.set(r.from); this.dateTo.set(r.to);
    this.syncUrl(); this.reload();
  }

  hasFilters(): boolean {
    return !!(this.search().trim() || (this.entryMode() === 'kepler' ? (this.dateFrom() || this.dateTo()) : this.onlyStale()));
  }

  clearFilters(): void {
    this.search.set(''); this.dateFrom.set(null); this.dateTo.set(null); this.preset.set(''); this.onlyStale.set(false);
    this.syncUrl(); this.reload();
  }

  /** Cambia entre "Lo que se debe (ContPAQi)" y "Movimiento (Kepler 201)". */
  setMode(m: 'debe' | 'kepler'): void {
    if (this.entryMode() === m) return;
    this.entryMode.set(m);
    this.reload();
  }
  toggleStale(): void { this.onlyStale.set(!this.onlyStale()); this.reload(); }

  /** Fila del modo "Movimiento (Kepler 201)": el nombre 201 resuelve todas las lentes. */
  openKepler(r: SupplierLedgerRow): void { this.openDrill(r.proveedor || '', r.proveedor || ''); }
  /** Fila del modo "Lo que se debe (ContPAQi)": usa el nombre Kepler mapeado para las lentes Kepler. */
  openDebe(r: ContpaqiPayableRow): void { this.openDrill(r.proveedor || '', r.proveedor_kepler || r.proveedor || ''); }

  /** Abre el drill (3 lentes). `drillName` alimenta las lentes; arranca en Contable, factura/fiscal son lazy. */
  private openDrill(proveedor: string, drillName: string): void {
    this.detail.set({ proveedor, drillName });
    this.dtTab.set('contable'); this.invoice.set(null); this.fiscal.set(null);
    this.moves.set([]); this.saldoFinal.set(0); this.movesLoading.set(true);
    this.svc.supplierLedgerDetail({ proveedor: drillName || undefined, date_from: this.toIso(this.dateFrom()), date_to: this.toIso(this.dateTo()) })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (d) => { this.moves.set(d.rows || []); this.saldoFinal.set(d.saldo_final || 0); this.movesLoading.set(false); },
        error: () => { this.movesLoading.set(false); },
      });
  }
  closeDetail(): void { this.detail.set(null); this.moves.set([]); this.invoice.set(null); this.fiscal.set(null); this.dtTab.set('contable'); }

  /** Cambia de lente; las vistas por factura / fiscal se cargan la primera vez que se abren. */
  setTab(t: 'contable' | 'factura' | 'fiscal'): void {
    this.dtTab.set(t);
    if (t === 'factura' && !this.invoice() && !this.invoiceLoading()) this.loadInvoices();
    if (t === 'fiscal' && !this.fiscal() && !this.fiscalLoading()) this.loadFiscal();
  }
  private loadInvoices(): void {
    const r = this.detail(); if (!r) return;
    this.invoiceLoading.set(true);
    this.svc.supplierInvoiceLedger({ proveedor: r.drillName || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (d) => { this.invoice.set(d); this.invoiceLoading.set(false); },
        error: () => { this.invoice.set({ found: false, proveedor_code: null, proveedor_nombre: null, totals: null, rows: [] }); this.invoiceLoading.set(false); },
      });
  }
  private loadFiscal(): void {
    const r = this.detail(); if (!r) return;
    this.fiscalLoading.set(true);
    this.svc.supplierFiscalLedger({ proveedor: r.drillName || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (d) => { this.fiscal.set(d); this.fiscalLoading.set(false); },
        error: () => { this.fiscal.set({ proveedor: r.proveedor, contpaqi: { matched: false, cuentas: [], cuenta_nombre: null, facturado: 0, pagado: 0, saldo: 0, saldo_ini: 0, ejercicio: null, n: 0 }, operativo: null, contable: null, rows: [] }); this.fiscalLoading.set(false); },
      });
  }

  /** El 201 está incompleto si registra <90% de lo facturado documental (póliza Kepler parcial). */
  contableIncompleto(t: SupplierInvoiceTotals): boolean {
    return !!(t.contable && t.facturado > 0 && t.contable.facturado < t.facturado * 0.9);
  }
  estadoLabel(e: InvoiceEstado): string { return e === 'pagada' ? 'Pagada' : e === 'parcial' ? 'Parcial' : 'Pendiente'; }
  estadoSev(e: InvoiceEstado): 'success' | 'warn' | 'danger' { return e === 'pagada' ? 'success' : e === 'parcial' ? 'warn' : 'danger'; }

  /** Color del tag por categoría del movimiento. */
  tagSev(cat: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    return cat === 'facturado' ? 'warn' : cat === 'pagado' ? 'success' : cat === 'nota' ? 'info' : cat === 'devolucion' ? 'danger' : 'secondary';
  }

  kpiItems(d: SupplierLedgerResponse): MetricStripItem[] {
    return [
      { label: 'Facturado', value: d.totals.facturado, format: 'currency-short', tone: 'default', sub: `${d.total} proveedor(es)` },
      { label: 'Pagado', value: d.totals.pagado, format: 'currency-short', tone: 'ok' },
      { label: 'Notas de crédito', value: d.totals.notas, format: 'currency-short', tone: 'warn' },
      { label: 'Δ deuda (periodo)', value: d.totals.delta, format: 'currency-short', tone: 'brand' },
    ];
  }

  payKpis(p: ContpaqiPayablesResponse): MetricStripItem[] {
    return [
      { label: 'Se debe (total)', value: p.total_debe, format: 'currency-short', tone: 'brand', sub: `${p.n} proveedor(es)` },
      { label: 'Saldo a favor', value: Math.abs(p.total_favor), format: 'currency-short', tone: 'ok' },
      { label: 'Saldos viejos', value: p.n_stale, format: 'number', tone: 'warn', sub: 'sin mov. reciente' },
    ];
  }

  money(n: number): string { return Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  absVal(n: number): number { return Math.abs(n || 0); }
}
