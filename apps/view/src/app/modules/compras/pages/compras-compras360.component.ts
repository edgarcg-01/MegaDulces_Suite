import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, switchMap, of, catchError } from 'rxjs';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { DatePickerModule } from 'primeng/datepicker';
import { SelectModule } from 'primeng/select';
import { InputNumberModule } from 'primeng/inputnumber';
import { DialogModule } from 'primeng/dialog';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { EntityInspectorComponent } from '../../../shared/components/entity-inspector/entity-inspector.component';
import { entityRef } from '../../../shared/components/entity-inspector/entity-ref.service';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { EntradasService, CoverageReport } from '../entradas.service';
import { branchName } from '../../../core/constants/store-branches';
import { makeLazyLoad, type LazyTableEvent, DATE_PRESET_OPTIONS, datePresetRange, money, moneyShort } from '../../../shared/util';
import { ComprasService, Compras360Row, Compras360Response, Compras360Filters, Compras360AjusteMode, Compras360OcMode, Compras360CompMode, AdjustmentForEntradaRow, PolizaForReceipt, ReceiptEvidenceDeposit, ReceiptEvidenceFile } from '../compras.service';

/**
 * CXP.3 — "Compras 360": el Excel de recepciones en una interfaz. Una fila por orden
 * de entrada / factura de Kepler (XA2001) con su OC, la factura, el ajuste ligado exacto
 * (devoluciones X-D-40 / notas X-D-55 confirmadas) y el neto. El detalle abre los ajustes
 * que explican el descuadre (exacto o proveedor+fecha heurístico) y navega a Descuentos.
 * Read-only sobre analytics.*. Operations mode, PrimeNG-first (p-table lazy server-paginado).
 */
@Component({
  selector: 'app-compras-compras360',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule, FormsModule, ButtonModule, InputTextModule, IconFieldModule, InputIconModule,
    TableModule, TagModule, DatePickerModule, SelectModule, InputNumberModule, DialogModule, MetricStripComponent, ContextHelpComponent, SegmentedComponent, RouterLink,
    EntityInspectorComponent,
  ],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1 class="c3-title-row">Compras 360 <app-context-help topic="compras-360" /></h1>
          <p class="surf-page-sub">Todas las órdenes de entrada y facturas de compra en una vista, con su OC, ajustes (devoluciones/notas ligadas) y neto. El "Excel" de recepción, vivo y filtrable.</p>
        </div>
        <div class="c3-head-actions">
          <!-- RE.13.4 — dos lentes sobre las MISMAS filas: el dinero (cuánto costó) y el
               cumplimiento (en qué anda el proceso). Son dos preguntas distintas y antes
               esta pantalla sólo contestaba la primera. -->
          <app-segmented [options]="lenteOpts" [value]="lente()" (valueChange)="setLente($event)" ariaLabel="Lente de la vista" />
          <!-- Frescura: esta vista es un espejo que puebla un importer. Sin esto no se
               distingue "no hay recepciones" de "el feed no corrió". -->
          <span class="c3-fresh" [class.stale]="staleFeed()" [title]="freshTitle()">
            <i class="pi" [ngClass]="staleFeed() ? 'pi-exclamation-triangle' : 'pi-clock'" aria-hidden="true"></i>
            {{ freshLabel() }}
          </span>
          <button pButton type="button" class="p-button-sm p-button-text" [disabled]="loading()" (click)="reload()" title="Volver a consultar (no recarga la app)"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Actualizar</span></button>
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="exporting()" (click)="exportCsv()"><span class="p-button-icon p-button-icon-left pi pi-download" aria-hidden="true"></span><span class="p-button-label">Exportar CSV</span></button>
        </div>
      </header>

      <div class="c3-filters">
        <p-iconfield styleClass="c3-search">
          <p-inputicon styleClass="pi pi-search" />
          <input pInputText type="text" placeholder="Proveedor, OC, folio, vale o concepto…" [ngModel]="search()" (ngModelChange)="onSearch($event)" class="p-inputtext-sm" aria-label="Buscar por proveedor, OC, folio, vale o concepto" />
        </p-iconfield>
        <p-select [options]="sucursalOpts()" [ngModel]="sucursal()" (onChange)="onSucursal($event.value)" optionLabel="label" optionValue="value" placeholder="Todas las sucursales" [showClear]="true" [filter]="true" styleClass="c3-sel c3-sel-sm" ariaLabel="Filtrar por sucursal" appendTo="body" />
        <p-select [options]="proveedorOpts()" [ngModel]="proveedorCode()" (onChange)="onProveedor($event.value)" optionLabel="label" optionValue="value" placeholder="Todos los proveedores" [showClear]="true" [filter]="true" [virtualScroll]="true" [virtualScrollItemSize]="34" styleClass="c3-sel c3-sel-wide" ariaLabel="Filtrar por proveedor" appendTo="body" />
        <p-select [options]="ocOpts" [ngModel]="conOc()" (onChange)="onOc($event.value)" optionLabel="label" optionValue="value" placeholder="OC: todas" [showClear]="true" styleClass="c3-sel c3-sel-sm" ariaLabel="Filtrar por orden de compra" appendTo="body" />
        <p-select [options]="ajusteOpts" [ngModel]="ajusteMode()" (onChange)="onAjuste($event.value)" optionLabel="label" optionValue="value" placeholder="Ajuste: todos" [showClear]="true" styleClass="c3-sel c3-sel-sm" ariaLabel="Filtrar por ajuste" appendTo="body" />
        <p-select [options]="compOpts" [ngModel]="comprobante()" (onChange)="onComprobante($event.value)" optionLabel="label" optionValue="value" placeholder="Comprobante: todos" [showClear]="true" styleClass="c3-sel c3-sel-sm" ariaLabel="Filtrar por comprobante" appendTo="body" />
        <p-select [options]="presetOpts" [ngModel]="preset()" (onChange)="onPreset($event.value)" optionLabel="label" optionValue="value" placeholder="Rango rápido" [showClear]="true" styleClass="c3-sel c3-sel-sm" ariaLabel="Rango de fecha rápido" appendTo="body" />
        <p-datepicker [ngModel]="dateFrom()" (onSelect)="onDate('from', $event)" (onClear)="onDate('from', null)" dateFormat="yy-mm-dd" [showIcon]="true" [showClear]="true" appendTo="body" placeholder="Desde" styleClass="c3-dp" ariaLabel="Desde" />
        <p-datepicker [ngModel]="dateTo()" (onSelect)="onDate('to', $event)" (onClear)="onDate('to', null)" dateFormat="yy-mm-dd" [showIcon]="true" [showClear]="true" appendTo="body" placeholder="Hasta" styleClass="c3-dp" ariaLabel="Hasta" />
        <p-inputnumber [ngModel]="montoMin()" (ngModelChange)="onMonto('min', $event)" mode="currency" currency="MXN" locale="es-MX" [minFractionDigits]="0" [min]="0" placeholder="Monto mín" styleClass="c3-num-in" inputStyleClass="p-inputtext-sm" ariaLabel="Monto mínimo de factura" />
        <p-inputnumber [ngModel]="montoMax()" (ngModelChange)="onMonto('max', $event)" mode="currency" currency="MXN" locale="es-MX" [minFractionDigits]="0" [min]="0" placeholder="Monto máx" styleClass="c3-num-in" inputStyleClass="p-inputtext-sm" ariaLabel="Monto máximo de factura" />
        @if (hasFilters()) {
          <button pButton type="button" class="p-button-sm p-button-text c3-clear" (click)="clearFilters()"><span class="pi pi-filter-slash" aria-hidden="true"></span>&nbsp;Limpiar</button>
        }
      </div>

      @if (exportMsg(); as m) {
        <div class="c3-errbox c3-warnbox" role="status">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span class="c3-errbox-txt">{{ m }}</span>
          <button pButton type="button" class="p-button-sm p-button-text" (click)="exportMsg.set(null)" label="Cerrar"></button>
        </div>
      }

      @if (err(); as e) {
        <div class="c3-errbox" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span class="c3-errbox-txt">{{ e }}</span>
          <button pButton type="button" class="p-button-sm p-button-outlined" (click)="retry()" label="Reintentar"></button>
        </div>
      }

      @if (data(); as d) {
        <!-- §Q.1 — la lectura del periodo antes del grid. El strip da totales; esto dice
             qué hay que mirar y cuánto pesa. -->
        <div class="c3-verdict" [class.ok]="verdictClean(d)" [class.warn]="!verdictClean(d)">
          <i [class]="verdictClean(d) ? 'pi pi-check-circle' : 'pi pi-exclamation-triangle'" aria-hidden="true"></i>
          <span class="c3-verdict-txt">{{ verdict(d) }}</span>
          @if (d.total > d.totals.con_comprobante) {
            <button type="button" class="c3-linkbtn" (click)="onComprobante('sin')">Ver las {{ d.total - d.totals.con_comprobante }} sin comprobante</button>
          }
          @if (d.totals.ajuste_operativo) {
            <button type="button" class="c3-linkbtn" (click)="onAjuste('operativo')">Ver los ajustes operativos</button>
          }
        </div>
        <app-metric-strip [items]="kpiItems(d)" ariaLabel="Totales de compras" />
      }

      <!-- RE.13.4 — Cobertura por sucursal: la tabla que contesta "¿quién no está subiendo?".
           Un % global no sirve para actuar: con CEDIS pesando el 74% del volumen, la red puede
           verse bien mientras una sucursal chica lleva tres semanas sin subir nada. -->
      @if (lente() === 'cumplimiento') {
        @if (cov(); as cv) {
          <section class="c3-cov" aria-label="Cobertura por sucursal">
            <div class="c3-cov-head">
              <h2>Cobertura del proceso por sucursal</h2>
              <span class="c3-cov-sub">
                desde el arranque ({{ cv.settings.reception_start }}) · vencidas = más de
                {{ cv.settings.sla_capture_days }} días sin factura
              </span>
              @if (cv.rezago.entradas > 0) {
                <span class="c3-cov-rez" [title]="'Entradas anteriores al arranque: no entran al % ni al SLA'">
                  rezago aparte: {{ cv.rezago.entradas }} · {{ moneyShort(cv.rezago.monto) }}
                </span>
              }
            </div>
            <div class="c3-cov-table" role="table">
              <div class="c3-cov-h" role="row">
                <span role="columnheader">Sucursal</span>
                <span role="columnheader" class="ta-r">Entradas</span>
                <span role="columnheader">Con factura</span>
                <span role="columnheader" class="ta-r">Validadas</span>
                <span role="columnheader" class="ta-r">Vencidas</span>
                <span role="columnheader" class="ta-r">Antigüedad p50 / p90</span>
                <span role="columnheader" class="ta-r">$ por comprobar</span>
                <span role="columnheader"></span>
              </div>
              @for (c of cv.rows; track c.sucursal) {
                <div class="c3-cov-r" role="row" [class.cero]="c.pct_evidencia === 0">
                  <span role="cell" class="c3-cov-suc">{{ suc(c.sucursal) }}</span>
                  <span role="cell" class="ta-r c3-num">{{ c.entradas }}</span>
                  <span role="cell" class="c3-cov-bar">
                    <span class="c3-cov-track"><span [style.width.%]="c.pct_evidencia"></span></span>
                    <em>{{ c.pct_evidencia }}%</em>
                  </span>
                  <span role="cell" class="ta-r c3-num">{{ c.validadas }}</span>
                  <span role="cell" class="ta-r c3-num" [class.c3-neg]="c.atrasadas > 0">{{ c.atrasadas }}</span>
                  <span role="cell" class="ta-r c3-num" [title]="'La mitad de lo pendiente lleva ' + c.dias_p50 + ' días o más; el 10% peor, ' + c.dias_p90"
                        [class.c3-neg]="c.dias_p50 > cv.settings.sla_capture_days">{{ c.dias_p50 }} / {{ c.dias_p90 }}</span>
                  <span role="cell" class="ta-r c3-num">{{ moneyShort(c.monto_pendiente) }}</span>
                  <span role="cell" class="c3-cov-act">
                    @if (c.entradas > c.con_evidencia) {
                      <a [routerLink]="['/compras/entradas']" [queryParams]="{ suc: c.sucursal }" class="c3-linkbtn"
                         title="Abrir la worklist de esa sucursal">pendientes</a>
                    }
                    @if (c.por_validar > 0) {
                      <a [routerLink]="['/compras/entradas/revision']" [queryParams]="{ suc: c.sucursal }" class="c3-linkbtn"
                         [title]="c.por_validar + ' esperando decisión'">revisar {{ c.por_validar }}</a>
                    }
                  </span>
                </div>
              }
              @if (!cv.rows.length) {
                <div class="c3-cov-r" role="row"><span class="muted">Sin sucursales en tu alcance.</span></div>
              }
            </div>
          </section>
        } @else if (covLoading()) {
          <p class="c3-cov-load"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Calculando cobertura…</p>
        }
      }

      <p-table
        [value]="data()?.rows || []"
        [loading]="loading()"
        [lazy]="true"
        [paginator]="true"
        [rows]="pageSize()"
        [totalRecords]="total()"
        [first]="(page() - 1) * pageSize()"
        [rowsPerPageOptions]="[25, 50, 100, 200]"
        (onLazyLoad)="onLazyLoad($event)"
        styleClass="p-datatable-sm surf-table surf-table--sticky c3-table"
        [rowHover]="true"
        [sortField]="sortField()"
        [sortOrder]="sortOrder()"
        [scrollable]="true"
        scrollHeight="58vh"
        currentPageReportTemplate="{first}–{last} de {totalRecords}"
        [showCurrentPageReport]="true">
        <ng-template #header>
          <tr>
            <th class="c3-w-date" pSortableColumn="receipt_date">Fecha <p-sorticon field="receipt_date" /></th>
            <th class="c3-w-suc" pSortableColumn="sucursal">Suc. <p-sorticon field="sucursal" /></th>
            <th pSortableColumn="proveedor_nombre">Proveedor <p-sorticon field="proveedor_nombre" /></th>
            <th class="c3-w-oc" pSortableColumn="oc_folio">OC <p-sorticon field="oc_folio" /></th>
            <th class="c3-w-oc" pSortableColumn="folio">Folio <p-sorticon field="folio" /></th>
            <th class="ta-r c3-w-amt" pSortableColumn="factura">Factura <p-sorticon field="factura" /></th>
            @if (lente() === 'dinero') {
              <th class="ta-r c3-w-amt" pSortableColumn="ajuste">Ajuste <p-sorticon field="ajuste" /></th>
              <th class="ta-r c3-w-amt" pSortableColumn="neto">Neto <p-sorticon field="neto" /></th>
              <th class="c3-w-comp">Comprobante</th>
            } @else {
              <th class="ta-r c3-w-dias">Días</th>
              <th class="c3-w-comp">Evidencia</th>
              <th class="ta-r c3-w-amt">Δ factura</th>
              <th class="c3-w-quien">Decidió</th>
            }
          </tr>
        </ng-template>
        <ng-template #body let-r>
          <!-- La fila abre el detalle con el mouse, pero NO lleva role="button": adentro hay
               otro botón (la OC) y un botón dentro de otro es HTML inválido y confuso para un
               lector de pantalla. El acceso por teclado va por el botón del folio, que además
               es lo que identifica la fila. -->
          <tr class="c3-row" [class.has-adj]="r.ajuste_operativo !== 0" (click)="openDetail(r)">
            <td class="c3-mono">{{ r.receipt_date ? r.receipt_date.slice(0,10) : '—' }}</td>
            <td [title]="r.sucursal">{{ sucNames().get(r.sucursal) || r.sucursal }}</td>
            <td class="c3-prov" [title]="r.proveedor_nombre">
              @if (r.proveedor_code) {
                <button type="button" class="c3-provlink" (click)="$event.stopPropagation(); inspect.set(refProv(r.proveedor_code))"
                        [attr.aria-label]="'Ver ficha de ' + (r.proveedor_nombre || r.proveedor_code)">{{ r.proveedor_nombre || r.proveedor_code }}</button>
              } @else { <span class="muted">—</span> }
            </td>
            <td class="c3-mono">
              @if (r.oc_folio) {
                <button type="button" class="c3-oclink" (click)="$event.stopPropagation(); inspect.set(refOc(r))"
                        [title]="'Abrir la orden de compra ' + r.oc_folio + ': lo pedido, sus vales y qué tanto se surtió'">{{ r.oc_folio }}</button>
              } @else { <span class="muted">—</span> }
            </td>
            <td class="c3-mono">
              <button type="button" class="c3-foliolink" (click)="$event.stopPropagation(); openDetail(r)"
                      [attr.aria-label]="'Ver detalle de la entrada ' + r.folio + ' de ' + (r.proveedor_nombre || r.proveedor_code || '')">{{ r.folio }}</button>
            </td>
            <td class="ta-r c3-num">{{ money(r.factura) }}</td>
            @if (lente() === 'dinero') {
              <!-- El ajuste se parte: lo COMERCIAL es un beneficio negociado y no se pinta como
                   error; lo OPERATIVO (faltante, mal estado, factura duplicada…) sí. Antes todo
                   iba en rojo, y 3 de cada 4 ajustes son descuentos ganados. -->
              <td class="ta-r c3-num">
                @if (r.ajuste !== 0) {
                  <span class="c3-adj" [class.c3-neg]="r.ajuste_operativo !== 0">−{{ money(r.ajuste) }}@if (r.n_ajuste > 1) { <span class="c3-adj-n" [title]="r.n_ajuste + ' ajustes ligados'">×{{ r.n_ajuste }}</span> }</span>
                  <span class="c3-adj-kind">
                    @if (r.ajuste_operativo !== 0 && r.ajuste_comercial !== 0) { <span class="c3-adj-mix" [title]="'Operativo ' + money(r.ajuste_operativo) + ' · comercial ' + money(r.ajuste_comercial)">mixto</span> }
                    @else if (r.ajuste_operativo !== 0) { <span class="c3-adj-op" title="Devolución/faltante/mal estado/factura duplicada — algo salió mal">operativo</span> }
                    @else { <span class="c3-adj-com" title="Descuento comercial, pronto pago o apoyo de marca — beneficio negociado, no un problema">comercial</span> }
                  </span>
                } @else { <span class="c3-adj-no" title="Sin devoluciones ni notas ligadas por folio (puede haber heurísticas — abrí el detalle)">sin</span> }
              </td>
              <td class="ta-r c3-num c3-strong">{{ money(r.neto) }}</td>
              <td>
                @if (r.deposits > 0) {
                  <span class="c3-comp">
                    <p-tag [value]="compLabel(r.deposit_status)" [severity]="compSev(r.deposit_status)" />
                    <i class="pi c3-comp-match" [class.ok]="r.monto_match" [class.bad]="!r.monto_match" [ngClass]="r.monto_match ? 'pi-check-circle' : 'pi-exclamation-triangle'" [title]="r.monto_match ? 'El total del comprobante cuadra con la factura' : 'El total del comprobante NO cuadra'"></i>
                  </span>
                } @else {
                  <span class="muted c3-comp-none"><i class="pi pi-paperclip" aria-hidden="true"></i> Sin</span>
                }
              </td>
            } @else {
              <!-- Lente de CUMPLIMIENTO: los mismos renglones contestando otra pregunta —
                   cuánto lleva sin evidencia, en qué estado está y quién la decidió. -->
              <td class="ta-r c3-num">
                <span class="c3-dias" [class]="'is-' + tonoDias(r)" [title]="r.dias + ' días desde la recepción'">{{ r.dias }}</span>
              </td>
              <td>
                @if (r.deposits > 0) {
                  <p-tag [value]="compLabel(r.deposit_status)" [severity]="compSev(r.deposit_status)" />
                } @else {
                  <span class="muted c3-comp-none"><i class="pi pi-paperclip" aria-hidden="true"></i> Falta</span>
                }
              </td>
              <td class="ta-r c3-num">
                @if (r.deposits === 0) { <span class="muted">—</span> }
                @else if (r.monto_match) { <span class="c3-ok-mini" title="Cuadra al peso">cuadra</span> }
                @else if (r.discrepancy_amount != null) { <span class="c3-neg">{{ money(r.discrepancy_amount) }}</span> }
                @else { <span class="muted" title="Sin total leído por el OCR">s/d</span> }
              </td>
              <td class="c3-quien" [title]="r.decidio || ''">{{ r.decidio || '—' }}</td>
            }
          </tr>
        </ng-template>
        <ng-template #emptymessage>
          <tr><td colspan="9">
            <div class="c3-empty-op">
              <i class="pi pi-inbox" aria-hidden="true"></i>
              <span class="c3-empty-op-title">Sin recepciones</span>
              @if (hasFilters()) {
                <span class="c3-empty-op-sub">Ninguna orden de entrada coincide con los filtros actuales.</span>
                <button pButton type="button" class="p-button-sm p-button-outlined" (click)="clearFilters()" label="Quitar filtros"></button>
              } @else {
                <span class="c3-empty-op-sub">No hay órdenes de entrada ni facturas de compra cargadas en el periodo.</span>
              }
            </div>
          </td></tr>
        </ng-template>
      </p-table>
    </div>

    <p-dialog [visible]="!!detail()" (visibleChange)="!$event && closeDetail()" [modal]="true" [dismissableMask]="true" [maximizable]="true" [style]="{ width: '1040px', maxWidth: '97vw' }" [header]="detailHeader()">
      @if (detail(); as r) {
        <div class="c3-review"><div class="c3-review-main">
        <div class="c3-dt">
          <div class="c3-dt-grid">
            <div><span class="c3-dt-l">Proveedor</span><span class="c3-dt-v">
              @if (r.proveedor_code) { <button type="button" class="c3-linkbtn" (click)="inspect.set(refProv(r.proveedor_code))">{{ r.proveedor_nombre || r.proveedor_code }}</button> }
              @else { {{ r.proveedor_nombre || '—' }} }
            </span></div>
            <div><span class="c3-dt-l">OC</span><span class="c3-dt-v c3-mono">
              @if (r.oc_folio) { <button type="button" class="c3-linkbtn c3-mono" (click)="inspect.set(refOc(r))">{{ r.oc_folio }}</button> } @else { — }
            </span></div>
            <div><span class="c3-dt-l">Vale</span><span class="c3-dt-v c3-mono">
              @if (r.vale_folio) { <button type="button" class="c3-linkbtn c3-mono" (click)="inspect.set(refVale(r))">{{ r.vale_folio }}</button> } @else { — }
            </span></div>
            <div><span class="c3-dt-l">Factura</span><span class="c3-dt-v c3-num">{{ money(r.factura) }}</span></div>
            <div><span class="c3-dt-l">Ajuste (exacto)</span><span class="c3-dt-v c3-num">{{ r.ajuste ? '−' + money(r.ajuste) : '—' }}</span></div>
            <div><span class="c3-dt-l">Neto</span><span class="c3-dt-v c3-num c3-strong">{{ money(r.neto) }}</span></div>
            <div><span class="c3-dt-l">Ficha</span><span class="c3-dt-v">
              <button type="button" class="c3-linkbtn" (click)="inspect.set(refEnt(r))" title="Renglones, pagos candidatos y copia CEDIS de esta recepción">Abrir ficha de la entrada</button>
            </span></div>
          </div>

          <h4 class="c3-dt-h">Póliza contable (Kepler)</h4>
          @if (polizaLoading()) {
            <p class="c3-empty">Cargando póliza…</p>
          } @else if (polizaErr()) {
            <p class="c3-empty c3-dt-err">No se pudo consultar la póliza contable. <button type="button" class="c3-linkbtn" (click)="openDetail(detail()!)">Reintentar</button></p>
          } @else if (poliza(); as pz) {
            @if (!pz.found) {
              <p class="c3-empty">Sin póliza contable localizada (XA2001) para esta recepción.</p>
            } @else {
              <div class="c3-pz-head">
                <span class="c3-pz-badge" [class.ok]="pz.cuadra" [class.bad]="!pz.cuadra">
                  <i class="pi" [class.pi-check-circle]="pz.cuadra" [class.pi-exclamation-triangle]="!pz.cuadra" aria-hidden="true"></i>
                  {{ pz.cuadra ? 'Cuadra' : 'No cuadra' }}
                </span>
                <span class="c3-pz-meta">{{ pz.polizas[0].anio_mes }} · cargos {{ money(pzCargos(pz)) }} · abonos {{ money(pzAbonos(pz)) }}</span>
              </div>
              <p-table [value]="pz.lines" styleClass="p-datatable-sm surf-table c3-dt-table" [scrollable]="true" scrollHeight="30vh">
                <ng-template #header>
                  <tr><th class="c3-w-cuenta">Cuenta</th><th>Nombre</th><th class="c3-w-ca">C/A</th><th class="ta-r c3-w-amt">Importe</th></tr>
                </ng-template>
                <ng-template #body let-l>
                  <tr>
                    <td class="c3-mono">{{ l.cuenta }} @if (l.cuenta_afectable === false) { <i class="pi pi-exclamation-triangle c3-pz-warn" title="Cuenta no afectable (no debería postear)"></i> }</td>
                    <td class="c3-prov" [title]="l.cuenta_nombre">{{ l.cuenta_nombre || '—' }}</td>
                    <td class="c3-mono">{{ l.cargo_abono }}</td>
                    <td class="ta-r c3-num">{{ money(l.importe) }}</td>
                  </tr>
                </ng-template>
              </p-table>
              <p class="c3-dt-note">Confirma que la recepción se asentó en libros (102 Bancos / 201 Proveedores / gasto). <b>Cuadra</b> = Σcargos − Σabonos ≈ 0.</p>
            }
          }

          <h4 class="c3-dt-h">Ajustes que explican el descuadre</h4>
          @if (explainsLoading()) {
            <p class="c3-empty">Cargando ajustes…</p>
          } @else if (explainsErr()) {
            <p class="c3-empty c3-dt-err">No se pudieron cargar los ajustes de esta recepción. <button type="button" class="c3-linkbtn" (click)="openDetail(detail()!)">Reintentar</button></p>
          } @else if (explains().length === 0) {
            <p class="c3-empty">Sin ajustes ligados a esta recepción.</p>
          } @else {
            <p-table [value]="explains()" styleClass="p-datatable-sm surf-table c3-dt-table" [scrollable]="true" scrollHeight="40vh">
              <ng-template #header>
                <tr><th class="c3-w-date">Fecha</th><th class="c3-w-doc">Tipo</th><th>Motivo</th><th class="ta-r c3-w-amt">Monto</th><th class="c3-w-match">Match</th></tr>
              </ng-template>
              <ng-template #body let-a>
                <tr>
                  <td class="c3-mono">{{ a.adjustment_date ? a.adjustment_date.slice(0,10) : '—' }}</td>
                  <td class="c3-mono">
                    <button type="button" class="c3-foliolink" (click)="inspect.set(refAdj(a))"
                            [attr.aria-label]="'Ver el ajuste ' + a.doctype + ' ' + a.folio">{{ a.doctype }}</button>
                  </td>
                  <td [title]="a.motivo">{{ a.categoria || a.motivo || '—' }}</td>
                  <td class="ta-r c3-num">{{ money(a.monto) }}</td>
                  <td><p-tag [value]="a.match" [severity]="a.match === 'exacto' ? 'success' : 'warn'" /></td>
                </tr>
              </ng-template>
            </p-table>
            <p class="c3-dt-note">Total ajustes ligados: <b>{{ money(explainsTotal()) }}</b>. Los match "proveedor+fecha" son heurísticos (Kepler no liga la nota a la entrada) — revisar.</p>
          }

          <h4 class="c3-dt-h">Comprobante adjunto (documento vs OCR)</h4>
          @if (evidenceLoading()) {
            <p class="c3-empty">Cargando comprobante…</p>
          } @else if (evidenceErr()) {
            <p class="c3-empty c3-dt-err">No se pudo consultar el comprobante adjunto. <button type="button" class="c3-linkbtn" (click)="openDetail(detail()!)">Reintentar</button></p>
          } @else if (!evidence().length) {
            <p class="c3-empty">Sin comprobante adjunto a esta orden de entrada.</p>
          } @else {
            @for (dep of evidence(); track dep.id) {
              <div class="c3-dep">
                <div class="c3-dep-head">
                  <p-tag [value]="compLabel(dep.status)" [severity]="compSev(dep.status)" />
                  @if (dep.monto_match === true) { <p-tag value="Cuadra" severity="success" /> }
                  @else if (dep.monto_match === false) { <p-tag value="No cuadra" severity="danger" /> }
                  <span class="c3-dep-meta">{{ dep.created_by || '—' }} · {{ dep.created_at | date:'dd/MM/yy HH:mm' }}</span>
                </div>
                <div class="c3-dep-files">
                  @for (f of dep.files; track f.url) {
                    <button type="button" class="c3-filebtn" [class.on]="selectedDoc()?.url === f.url" (click)="selectDoc(f)" [title]="'Ver ' + (f.name || 'documento') + ' a la derecha'">
                      <i class="pi" [ngClass]="isImageUrl(f) ? 'pi-image' : 'pi-file-pdf'" aria-hidden="true"></i>
                      <span>{{ f.name || (isImageUrl(f) ? 'imagen' : 'PDF') }}</span>
                    </button>
                  }
                  @if (!dep.files.length) { <span class="muted">Sin archivo.</span> }
                </div>
                <div class="c3-dep-ocr">
                  <span><em>Folio</em> {{ dep.ocr_folio || '—' }}</span>
                  <span><em>Fecha</em> {{ dep.ocr_fecha || '—' }}</span>
                  <span><em>Proveedor</em> {{ dep.ocr_proveedor || '—' }}</span>
                  <span><em>Total</em> {{ dep.ocr_monto != null ? money(dep.ocr_monto) : '—' }}</span>
                  @if (dep.ocr_subtotal != null) { <span><em>Subtotal</em> {{ money(dep.ocr_subtotal) }}</span> }
                  @if (dep.ocr_iva != null) { <span><em>IVA</em> {{ money(dep.ocr_iva) }}</span> }
                </div>
                @if (dep.status === 'rechazado' && dep.motivo_rechazo) { <div class="c3-dt-err">Rechazado: {{ dep.motivo_rechazo }}</div> }
              </div>
            }
          }

          <div class="c3-dt-actions">
            <button pButton type="button" class="p-button-sm p-button-text" (click)="drillToDescuentos(r)">
              <span class="pi pi-arrow-up-right" aria-hidden="true"></span>&nbsp;Ver ajustes de este proveedor en Descuentos
            </button>
          </div>
        </div>
        </div><!-- /.c3-review-main -->

        <!-- Panel derecho: documento del comprobante para comparar contra la lectura OCR de la izquierda -->
        <aside class="c3-review-doc">
          @if (selectedDoc(); as doc) {
            <div class="c3-doc-head">
              <span class="c3-doc-name" [title]="doc.name"><i class="pi" [ngClass]="doc.kind === 'pdf' ? 'pi-file-pdf' : 'pi-image'" aria-hidden="true"></i> {{ doc.name }}</span>
              <a pButton type="button" text size="small" [href]="doc.url" target="_blank" rel="noopener" title="Abrir en pestaña"><span class="p-button-icon pi pi-external-link" aria-hidden="true"></span></a>
            </div>
            <div class="c3-doc-frame">
              @if (doc.kind === 'pdf') {
                @if (doc.safeUrl) { <iframe [src]="doc.safeUrl" title="Comprobante de la orden de entrada"></iframe> }
                @else { <p class="c3-empty c3-dt-err">No se puede previsualizar este archivo (la dirección no es válida). Abrilo en una pestaña con el botón de arriba.</p> }
              }
              @else { <img [src]="doc.url" [alt]="doc.name" /> }
            </div>
          } @else {
            <div class="c3-doc-empty"><i class="pi pi-file" aria-hidden="true"></i><span>Elegí una hoja del comprobante para verla acá, junto a la lectura OCR.</span></div>
          }
        </aside>
        </div><!-- /.c3-review -->
      }
    </p-dialog>

    <!-- Panel de ficha: cualquier celda con ref lo abre; adentro se navega la cadena
         (proveedor -> recepción -> renglón -> producto) sin salir de la pantalla. -->
    <app-entity-inspector [(ref)]="inspect" />
  `,
  styles: [`
    :host { display:block; }
    .surf-page-head { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap; }
    .c3-head-actions { display:flex; gap:.5rem; }
    .c3-title-row { display:inline-flex; align-items:center; gap:.4rem; }
    .c3-filters { display:flex; flex-wrap:wrap; gap:.6rem; align-items:center; margin:1rem 0 .6rem; }
    .c3-search input { min-width:230px; }
    /* ::ng-deep — VENDOR ONLY (§S): PrimeNG renderiza p-select/p-inputnumber en su propio
       árbol, así que el ancho no se puede fijar desde el host sin perforar. No hay
       !important: alcanza con la especificidad del styleClass. */
    :host ::ng-deep .c3-sel { min-width:12rem; }
    :host ::ng-deep .c3-sel-sm { min-width:9rem; }
    :host ::ng-deep .c3-sel-wide { min-width:16rem; max-width:22rem; }
    :host ::ng-deep .c3-num-in { width:9.5rem; }
    :host ::ng-deep .c3-num-in input { width:100%; text-align:right; font-variant-numeric:tabular-nums; }
    .c3-clear { color:var(--text-muted); }
    .c3-fresh { display:inline-flex; align-items:center; gap:.35rem; font-size:.76rem; color:var(--text-faint); white-space:nowrap; }
    .c3-fresh .pi { font-size:.72rem; }
    .c3-fresh.stale { color:var(--warn-fg); }
    .c3-warnbox { border-left-color:var(--warn-fg); }
    .c3-warnbox .pi { color:var(--warn-fg); }
    .c3-table { margin-top:.6rem; }
    .c3-row { cursor:pointer; }
    /* La fila no es focusable a propósito (ver comentario del template): el objetivo de
       teclado es el botón del folio, que ya trae su propio focus-visible. Por eso acá NO va
       una regla :focus-visible — sería CSS muerto. */
    .c3-row:has(.c3-foliolink:focus-visible) { background:var(--overlay-hover); }
    /* Sólo el ajuste OPERATIVO marca la fila: un apoyo de marca no es una excepción a revisar. */
    .c3-row.has-adj > td:first-child { box-shadow:inset 3px 0 0 var(--warn-fg); }
    .ta-r { text-align:right; }
    .c3-mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .c3-num { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .c3-strong { font-weight:700; }
    .c3-neg { color:var(--bad-fg); }
    .c3-prov { max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .muted { color:var(--text-faint); }
    /* OC clickable + claridad de ajuste */
    .c3-oclink { border:0; background:transparent; color:var(--action); cursor:pointer; padding:0; font:inherit; font-family:var(--font-mono); }
    .c3-provlink { border:0; background:transparent; color:inherit; cursor:pointer; padding:0; font:inherit; text-align:left;
      max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .c3-provlink:hover { color:var(--action); text-decoration:underline; }
    .c3-provlink:focus-visible { outline:2px solid var(--action-ring); outline-offset:2px; border-radius:var(--r-sm); }
    .c3-oclink:hover { text-decoration:underline; }
    /* El folio abre el detalle: es el objetivo de teclado de la fila. */
    .c3-foliolink { border:0; background:transparent; color:var(--text-muted); cursor:pointer; padding:0; font:inherit; font-family:var(--font-mono); }
    .c3-foliolink:hover { color:var(--text-main); text-decoration:underline; }
    .c3-foliolink:focus-visible { outline:2px solid var(--action-ring); outline-offset:2px; border-radius:var(--r-sm); }
    .c3-adj.c3-neg { color:var(--bad-fg); }
    .c3-adj-kind { display:block; font-size:.68rem; text-transform:uppercase; letter-spacing:.03em; }
    .c3-adj-op { color:var(--warn-fg); }
    .c3-adj-com { color:var(--ok-fg); }
    .c3-adj-mix { color:var(--text-muted); }
    .c3-adj-n { font-size:.72rem; color:var(--text-faint); margin-left:.25rem; }
    .c3-adj-no { color:var(--text-faint); font-size:.78rem; }
    .c3-w-date { width:6rem; } .c3-w-suc { width:4rem; } .c3-w-oc { width:7rem; } .c3-w-amt { width:8rem; } .c3-w-doc { width:5rem; } .c3-w-match { width:6rem; } .c3-w-comp { width:9rem; }
    /* RE.9 — columna Comprobante (estado + cuadre OCR) */
    .c3-comp { display:inline-flex; align-items:center; gap:.4rem; }
    .c3-comp-match.ok { color:var(--ok-fg); } .c3-comp-match.bad { color:var(--bad-fg); }
    .c3-comp-none { display:inline-flex; align-items:center; gap:.3rem; font-size:.8rem; }
    .c3-comp-none .pi { font-size:.75rem; opacity:.7; }
    .c3-empty { padding:1.4rem; text-align:center; color:var(--text-faint); font-size:.85rem; }
    /* error de red (banner + reintento) — Empty ≠ error */
    .c3-errbox { display:flex; align-items:center; gap:.6rem; padding:.7rem .85rem; margin:.2rem 0 .6rem; border:1px solid var(--bad-border, var(--border-color)); border-left:3px solid var(--bad-fg); border-radius:var(--r-md); background:var(--card-bg); }
    .c3-errbox .pi { color:var(--bad-fg); }
    .c3-errbox-txt { flex:1; font-size:.84rem; color:var(--text-main); }
    /* empty operacional: icono + título + microcopy + CTA */
    .c3-empty-op { display:flex; flex-direction:column; align-items:center; gap:.4rem; padding:2.4rem 1rem; text-align:center; }
    .c3-empty-op .pi { font-size:1.6rem; color:var(--text-faint); }
    .c3-empty-op-title { font-weight:600; color:var(--text-main); }
    .c3-empty-op-sub { font-size:.84rem; color:var(--text-muted); max-width:32rem; }
    app-metric-strip { display:block; margin:.9rem 0; }
    /* Veredicto: una línea, borde izquierdo de 3px como portador de estado (mismo organismo
       que el Cuadre de Bancos/Caja). Elevación = borde, nunca sombra. */
    .c3-verdict { display:flex; align-items:center; gap:.55rem; padding:.6rem .85rem; margin:.9rem 0 0;
      border:1px solid var(--border-color); border-left:3px solid var(--border-color);
      border-radius:var(--r-md); background:var(--card-bg); font-size:.85rem; }
    .c3-verdict.ok { border-left-color:var(--ok-fg); } .c3-verdict.ok .pi { color:var(--ok-fg); }
    .c3-verdict.warn { border-left-color:var(--warn-fg); } .c3-verdict.warn .pi { color:var(--warn-fg); }
    .c3-verdict-txt { flex:1; color:var(--text-main); }
    /* detalle */
    .c3-dt-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:.8rem 1rem; margin-bottom:1rem; }
    @container c3review (max-width:35rem) { .c3-dt-grid { grid-template-columns:repeat(2,1fr); } }
    .c3-dt-grid > div { display:flex; flex-direction:column; gap:.15rem; }
    .c3-dt-l { font-size:.66rem; text-transform:uppercase; letter-spacing:.04em; color:var(--text-faint); }
    .c3-dt-v { font-size:.9rem; color:var(--text-main); }
    .c3-dt-h { font-size:.82rem; font-weight:700; margin:.4rem 0 .5rem; color:var(--text-main); }
    .c3-dt-table { font-size:.78rem; }
    .c3-dt-note { font-size:.72rem; color:var(--text-faint); margin-top:.6rem; line-height:1.5; }
    .c3-dt-err { color:var(--bad-fg); }
    .c3-linkbtn { background:none; border:0; color:var(--action); cursor:pointer; font:inherit; text-decoration:underline; padding:0; }
    /* póliza contable */
    .c3-pz-head { display:flex; align-items:center; gap:.6rem; margin:.2rem 0 .6rem; flex-wrap:wrap; }
    .c3-pz-badge { display:inline-flex; align-items:center; gap:.35rem; font-size:.72rem; font-weight:700; padding:.12rem .5rem; border-radius:var(--r-sm,4px); }
    .c3-pz-badge.ok { color:var(--ok-fg); background:var(--ok-soft-bg,transparent); }
    .c3-pz-badge.bad { color:var(--bad-fg); background:var(--bad-soft-bg,transparent); }
    .c3-pz-meta { font-size:.74rem; color:var(--text-faint); font-variant-numeric:tabular-nums; }
    .c3-pz-warn { color:var(--warn-fg); margin-left:.3rem; font-size:.72rem; }
    .c3-w-cuenta { width:8rem; } .c3-w-ca { width:3rem; }
    .c3-dt-actions { margin-top:1rem; padding-top:.7rem; border-top:1px solid var(--border-color); display:flex; justify-content:flex-end; }
    /* RE.9b — comparación de dos paneles en el detalle (contenido/OCR izq + documento der) */
    /* §R — el layout de revisión depende del ancho REAL que le da el diálogo (que cambia
       con maximizar), no del viewport: un modal de 1040px en una pantalla de 1920 medía el
       viewport y se creía ancho. */
    .c3-review { container-type:inline-size; container-name:c3review; display:grid; grid-template-columns:1fr; gap:1.1rem; }
    @container c3review (min-width:60rem) { .c3-review { grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr); align-items:start; } }
    .c3-review-main { min-width:0; }
    .c3-review-doc { min-width:0; }
    @container c3review (min-width:60rem) { .c3-review-doc { position:sticky; top:0; align-self:start; } }
    .c3-doc-head { display:flex; align-items:center; justify-content:space-between; gap:.5rem; margin-bottom:.4rem; }
    .c3-doc-name { display:inline-flex; align-items:center; gap:.4rem; min-width:0; font-size:.8rem; color:var(--text-main); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .c3-doc-name .pi-file-pdf { color:var(--bad-fg); }
    .c3-doc-frame { border:1px solid var(--border-color); border-radius:var(--r-md); overflow:hidden; background:var(--surface-ground); height:64vh; min-height:24rem; display:flex; }
    /* El #fff del visor es literal a propósito: representa la HOJA de papel, que es blanca
       en los dos temas — no es una superficie de la app. */
    .c3-doc-frame iframe { width:100%; height:100%; border:0; background:#fff; }
    .c3-doc-frame img { width:100%; height:100%; object-fit:contain; }
    .c3-doc-empty { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:.6rem; height:64vh; min-height:24rem; border:1px dashed var(--border-color); border-radius:var(--r-md); color:var(--text-faint); text-align:center; padding:1rem; background:var(--card-bg); }
    .c3-doc-empty .pi { font-size:1.9rem; opacity:.5; }
    .c3-dep { border:1px solid var(--border-color); border-radius:var(--r-md); padding:.7rem .8rem; display:flex; flex-direction:column; gap:.5rem; margin-bottom:.6rem; }
    .c3-dep-head { display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; }
    .c3-dep-meta { font-size:.72rem; color:var(--text-faint); margin-left:auto; }
    .c3-dep-files { display:flex; flex-wrap:wrap; gap:.5rem; }
    .c3-filebtn { display:inline-flex; align-items:center; gap:.4rem; padding:.4rem .7rem; border:1px solid var(--border-color); border-radius:var(--r-sm,4px); color:var(--action); background:var(--card-bg); font-size:.8rem; cursor:pointer; max-width:16rem; overflow:hidden; }
    .c3-filebtn span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .c3-filebtn:hover { border-color:var(--action); }
    .c3-filebtn.on { border-color:var(--action); box-shadow:inset 0 0 0 1px var(--action); }
    .c3-dep-ocr { display:flex; flex-wrap:wrap; gap:.3rem 1.1rem; font-size:.76rem; color:var(--text-main); }
    .c3-dep-ocr em { font-style:normal; color:var(--text-faint); margin-right:.3rem; }


    /* RE.13.4 — cobertura por sucursal + columnas del lente de cumplimiento */
    .c3-cov { margin: 0 0 1rem; border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); overflow: hidden; }
    .c3-cov-head { display: flex; align-items: baseline; gap: .6rem; flex-wrap: wrap; padding: .6rem .8rem;
      background: var(--surface-sunken, var(--card-bg)); border-bottom: 1px solid var(--border-color); }
    .c3-cov-head h2 { margin: 0; font-size: 1rem; }
    .c3-cov-sub { font-size: var(--fs-xs, .75rem); color: var(--text-muted); }
    .c3-cov-rez { margin-left: auto; font-size: var(--fs-xs, .75rem); color: var(--text-muted);
      border: 1px dashed var(--border-color); border-radius: var(--r-sm, .35rem); padding: .1rem .45rem; }
    .c3-cov-table { display: grid; }
    .c3-cov-h, .c3-cov-r { display: grid; gap: .6rem; align-items: center; padding: .4rem .8rem;
      grid-template-columns: minmax(7rem, 1fr) 5rem minmax(7rem, 1fr) 5rem 5rem 8rem 8rem minmax(8rem, auto); }
    .c3-cov-h { font-size: var(--fs-micro, .72rem); text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); }
    .c3-cov-r { border-top: 1px solid var(--border-color); font-size: var(--fs-sm, .85rem); }
    .c3-cov-r.cero { background: color-mix(in oklab, var(--bad-fg) 5%, transparent); }
    .c3-cov-suc { font-weight: 600; }
    .c3-cov-bar { display: flex; align-items: center; gap: .4rem; }
    .c3-cov-track { flex: 1; height: .4rem; min-width: 3rem; border-radius: 99px; background: var(--border-color); overflow: hidden; }
    .c3-cov-track > span { display: block; height: 100%; background: var(--ok-fg); border-radius: 99px; }
    .c3-cov-bar em { font-style: normal; font-size: var(--fs-xs, .75rem); color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .c3-cov-act { display: flex; gap: .5rem; justify-content: flex-end; flex-wrap: wrap; }
    .c3-cov-load { color: var(--text-muted); font-size: var(--fs-sm, .85rem); }
    @media (max-width: 68rem) {
      .c3-cov-h { display: none; }
      .c3-cov-r { grid-template-columns: 1fr 1fr; }
    }
    .c3-dias { font-variant-numeric: tabular-nums; font-weight: 600; border-radius: var(--r-sm, .35rem); padding: .05rem .3rem; }
    .c3-dias.is-ok { color: var(--text-muted); }
    .c3-dias.is-warn { color: var(--warn-fg, var(--bad-fg)); background: color-mix(in oklab, var(--warn-fg, var(--bad-fg)) 10%, transparent); }
    .c3-dias.is-bad { color: var(--bad-fg); background: color-mix(in oklab, var(--bad-fg) 12%, transparent); }
    .c3-ok-mini { color: var(--ok-fg); font-size: var(--fs-xs, .75rem); }
    .c3-quien { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); font-size: var(--fs-sm, .85rem); }
  `],
})
export class ComprasCompras360Component implements OnInit {
  private readonly svc = inject(ComprasService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly sanitizer = inject(DomSanitizer);

  private readonly entradas = inject(EntradasService);

  /**
   * RE.13.4 — el lente: las MISMAS filas contestando dos preguntas distintas. `dinero` es la
   * vista histórica (factura/ajuste/neto); `cumplimiento` responde en qué anda el proceso
   * (antigüedad, evidencia, descuadre, quién decidió) y trae la cobertura por sucursal.
   */
  readonly lente = signal<'dinero' | 'cumplimiento'>('dinero');
  readonly lenteOpts = [
    { label: 'Dinero', value: 'dinero' },
    { label: 'Cumplimiento', value: 'cumplimiento' },
  ];
  readonly cov = signal<CoverageReport | null>(null);
  readonly covLoading = signal(false);

  setLente(v: string): void {
    this.lente.set(v === 'cumplimiento' ? 'cumplimiento' : 'dinero');
    if (this.lente() === 'cumplimiento' && !this.cov() && !this.covLoading()) this.cargarCobertura();
  }
  private cargarCobertura(): void {
    this.covLoading.set(true);
    const q = {
      from: this.toIso(this.dateFrom()) || undefined,
      to: this.toIso(this.dateTo()) || undefined,
    };
    this.entradas.coverage(q).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.covLoading.set(false); this.cov.set(r); },
      error: () => { this.covLoading.set(false); },
    });
  }
  suc(code: string): string { return branchName(code) || code; }
  /** Tres niveles sobre el SLA del tenant, igual que la worklist del capturista. */
  tonoDias(r: Compras360Row): 'ok' | 'warn' | 'bad' {
    const sla = this.cov()?.settings?.sla_capture_days ?? 3;
    if (r.deposits > 0) return 'ok';           // ya tiene factura: el reloj de captura se detuvo
    if (r.dias > sla * 2) return 'bad';
    if (r.dias > sla) return 'warn';
    return 'ok';
  }

  readonly data = signal<Compras360Response | null>(null);
  readonly loading = signal(false);
  readonly exporting = signal(false);
  /** Aviso del export (cortado por tope o fallido) — nunca falla callado. */
  readonly exportMsg = signal<string | null>(null);
  /** Error de red de la lista (banner + reintento). Empty ≠ error. */
  readonly err = signal<string | null>(null);
  readonly search = signal('');
  readonly sucursal = signal<string>('');
  readonly proveedorCode = signal<string>('');
  readonly conOc = signal<Compras360OcMode | ''>('');
  readonly ajusteMode = signal<Compras360AjusteMode | ''>('');
  readonly comprobante = signal<Compras360CompMode | ''>('');
  readonly montoMin = signal<number | null>(null);
  readonly montoMax = signal<number | null>(null);
  readonly dateFrom = signal<Date | null>(null);
  readonly dateTo = signal<Date | null>(null);
  readonly preset = signal<string>('');
  readonly filters = signal<Compras360Filters | null>(null);
  readonly sucursalOpts = computed(() => (this.filters()?.sucursales || []).map((s) => ({ label: `${s.name || s.code} · ${s.n}`, value: s.code })));
  // Mapa código→nombre (viene del backend) para pintar el nombre de sucursal en la tabla.
  readonly sucNames = computed(() => { const m = new Map<string, string>(); for (const s of this.filters()?.sucursales || []) m.set(s.code, s.name || s.code); return m; });
  readonly proveedorOpts = computed(() => (this.filters()?.proveedores || []).map((p) => ({ label: `${p.nombre || p.code} · ${p.n}`, value: p.code })));
  readonly ocOpts = [{ label: 'Con OC', value: 'con' }, { label: 'Sin OC', value: 'sin' }];
  readonly ajusteOpts = [
    { label: 'Con ajuste', value: 'con' },
    { label: 'Sin ajuste', value: 'sin' },
    { label: 'Solo operativo', value: 'operativo' },   // faltante · mal estado · duplicada
    { label: 'Solo comercial', value: 'comercial' },   // descuento · pronto pago · apoyo
  ];
  readonly compOpts = [{ label: 'Con comprobante', value: 'con' }, { label: 'Sin comprobante', value: 'sin' }, { label: 'Validado', value: 'validado' }, { label: 'Por validar', value: 'por_validar' }, { label: 'Rechazado', value: 'rechazado' }];
  readonly presetOpts = DATE_PRESET_OPTIONS;
  readonly page = signal(1);
  readonly pageSize = signal(50);
  readonly total = signal(0);
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private montoTimer: ReturnType<typeof setTimeout> | null = null;

  readonly detail = signal<Compras360Row | null>(null);
  readonly explains = signal<AdjustmentForEntradaRow[]>([]);
  readonly explainsLoading = signal(false);
  readonly explainsErr = signal(false);
  readonly explainsTotal = signal(0);
  readonly poliza = signal<PolizaForReceipt | null>(null);
  readonly polizaLoading = signal(false);
  /** Un fallo de red NO puede leerse como "esta recepción no tiene póliza": es una conclusión. */
  readonly polizaErr = signal(false);
  readonly detailHeader = computed(() => { const r = this.detail(); return r ? `Entrada ${r.folio} — ${r.proveedor_nombre || r.proveedor_code || ''}` : ''; });
  // RE.9b — evidencia (comprobante) + documento en el panel derecho para comparar vs OCR.
  readonly evidence = signal<ReceiptEvidenceDeposit[]>([]);
  readonly evidenceLoading = signal(false);
  /** Igual que la póliza: sin esto, un 500 se leía como "sin comprobante adjunto". */
  readonly evidenceErr = signal(false);
  readonly selectedDoc = signal<{ url: string; safeUrl: SafeResourceUrl | null; kind: 'image' | 'pdf'; name: string } | null>(null);

  /** Ficha abierta en el panel lateral (`null` = cerrado). Es lo que hace clickeable la vista. */
  readonly inspect = signal<string | null>(null);

  refProv(code: string | null): string { return entityRef('prov', code); }
  refEnt(r: Compras360Row): string { return entityRef('ent', r.sucursal, 'XA2001', r.folio); }
  refAdj(a: AdjustmentForEntradaRow): string { return entityRef('adj', a.doctype, a.sucursal, a.folio); }
  refOc(r: Compras360Row): string { return entityRef('pdoc', 'XA3501', r.sucursal, r.oc_folio); }
  refVale(r: Compras360Row): string { return entityRef('pdoc', 'XA3701', r.sucursal, r.vale_folio); }

  /** Orden pedido por el usuario. Viaja al backend: la tabla es server-paginada y ordenar en
   *  el cliente ordenaría sólo los 50 registros visibles, que es peor que no ordenar. */
  readonly sortField = signal<string>('');
  readonly sortOrder = signal<number>(-1);
  private readonly baseLazy = makeLazyLoad(this.page, this.pageSize, () => this.reload());

  /** onLazyLoad de p-table → page/pageSize (helper compartido) + orden. */
  onLazyLoad(e: LazyTableEvent): void {
    const f = (typeof e.sortField === 'string' ? e.sortField : '') || '';
    const o = e.sortOrder ?? -1;
    if (f !== this.sortField() || o !== this.sortOrder()) {
      this.sortField.set(f); this.sortOrder.set(o);
      this.page.set(1); this.syncUrl();
    }
    this.baseLazy(e);
  }

  ngOnInit(): void {
    // Estado en URL: rehidratar filtros + página (F5 y deep-link).
    const q = this.route.snapshot.queryParamMap;
    this.search.set(q.get('q') || '');
    this.sucursal.set(q.get('suc') || '');
    this.proveedorCode.set(q.get('prov') || '');
    this.dateFrom.set(this.fromIso(q.get('from')));
    this.dateTo.set(this.fromIso(q.get('to')));
    const oc = q.get('oc'); this.conOc.set(oc === 'con' || oc === 'sin' ? oc : '');
    // ajuste: param nuevo 'aj'; back-compat del viejo 'adj=1' → con ajuste.
    const aj = q.get('aj');
    this.ajusteMode.set((['con', 'sin', 'operativo', 'comercial'] as string[]).includes(aj || '') ? (aj as Compras360AjusteMode) : (q.get('adj') === '1' ? 'con' : ''));
    const cp = q.get('comp'); this.comprobante.set((['con', 'sin', 'validado', 'por_validar', 'rechazado'] as string[]).includes(cp || '') ? (cp as Compras360CompMode) : '');
    this.montoMin.set(this.toNum(q.get('mmin')));
    this.montoMax.set(this.toNum(q.get('mmax')));
    this.preset.set(q.get('preset') || '');
    const sf = q.get('sort'); if (sf) { this.sortField.set(sf); this.sortOrder.set(q.get('dir') === 'asc' ? 1 : -1); }
    const p = parseInt(q.get('page') || '1', 10);
    this.page.set(!Number.isFinite(p) || p < 1 ? 1 : p);

    // Pipeline único de carga: switchMap cancela la petición anterior en vuelo.
    this.reload$.pipe(
      switchMap(() => {
        this.loading.set(true); this.err.set(null);
        return this.svc.compras360(this.query()).pipe(catchError(() => { this.err.set('No se pudieron cargar las recepciones.'); return of(null); }));
      }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((d) => {
      this.loading.set(false);
      if (!d) return;                       // error: el banner ya quedó puesto
      this.data.set(d); this.total.set(d.total);
      this.loadFilters();                   // facetas coherentes con el filtro aplicado
      this.openPendingEnt();                // ?ent=suc|folio
    });
    this.destroyRef.onDestroy(() => this.cancelTimers());

    this.loadFilters();
    // La carga inicial de la tabla la dispara el onLazyLoad de la p-table.
    // Deep-link del detalle: /compras/compras-360?ent=<sucursal>|<folio> abre la ficha.
    const ent = q.get('ent');
    if (ent) this.pendingEnt = ent;
  }

  /** Entrada pedida por URL (`?ent=suc|folio`) que se abre en cuanto llegan las filas. */
  private pendingEnt: string | null = null;

  /** Abre el detalle pedido por URL una vez que la fila existe en la página cargada. */
  private openPendingEnt(): void {
    const ent = this.pendingEnt;
    if (!ent) return;
    const [suc, folio] = ent.split('|');
    const row = (this.data()?.rows || []).find((r) => r.sucursal === suc && r.folio === folio);
    if (row) { this.pendingEnt = null; this.openDetail(row); }
  }

  /**
   * Catálogo de filtros (facetas). Se recarga junto con la tabla y con los MISMOS filtros:
   * el "· N" de cada opción es lo que la tabla va a dar al elegirla, no un total global.
   * Un fallo no rompe la tabla.
   */
  private loadFilters(): void {
    this.svc.compras360Filters(this.query()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (f) => this.filters.set(f),
      error: () => { /* sin dropdown de sucursal; el resto sigue */ },
    });
  }

  /** 'YYYY-MM-DD'/número → number|null. */
  private toNum(s: string | null): number | null {
    if (s == null || s === '') return null;
    const n = Number(s); return Number.isFinite(n) ? n : null;
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

  private query(all = false) {
    return {
      search: this.search().trim() || undefined,
      sucursal: this.sucursal() || undefined,
      proveedor_code: this.proveedorCode() || undefined,
      date_from: this.toIso(this.dateFrom()), date_to: this.toIso(this.dateTo()),
      ajuste: this.ajusteMode() || undefined,
      con_oc: this.conOc() || undefined,
      comprobante: this.comprobante() || undefined,
      monto_min: this.montoMin() ?? undefined,
      monto_max: this.montoMax() ?? undefined,
      sort: this.sortField() || undefined, dir: this.sortOrder() === 1 ? 'asc' as const : 'desc' as const,
      page: this.page(), pageSize: this.pageSize(), all,
    };
  }

  /** Refleja filtros + página en la URL (replaceUrl → no ensucia el historial). */
  private syncUrl(): void {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        q: this.search().trim() || null,
        suc: this.sucursal() || null,
        prov: this.proveedorCode() || null,
        from: this.toIso(this.dateFrom()) || null,
        to: this.toIso(this.dateTo()) || null,
        oc: this.conOc() || null,
        aj: this.ajusteMode() || null,
        comp: this.comprobante() || null,
        adj: null, // limpia el param legado
        mmin: this.montoMin() != null ? this.montoMin() : null,
        mmax: this.montoMax() != null ? this.montoMax() : null,
        preset: this.preset() || null,
        ent: this.detail() ? `${this.detail()!.sucursal}|${this.detail()!.folio}` : null,
        sort: this.sortField() || null,
        dir: this.sortField() ? (this.sortOrder() === 1 ? 'asc' : 'desc') : null,
        page: this.page() > 1 ? this.page() : null,
      },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  /**
   * Toda recarga pasa por este Subject + `switchMap`: si el comprador cambia dos filtros
   * seguidos, la respuesta de la primera se CANCELA. Antes eran subscribes sueltos y ganaba
   * el que respondiera último, no el último pedido — la tabla podía quedar mostrando un
   * filtro que ya no estaba seleccionado (invisible en local a 9ms, real contra Railway).
   */
  private readonly reload$ = new Subject<void>();

  reload(): void {
    this.cancelTimers();          // un filtro explícito mata el debounce pendiente
    this.reload$.next();
  }

  /** Reintento del banner de error. */
  retry(): void { this.err.set(null); this.reload(); }

  /** Cancela los debounces pendientes (búsqueda / monto) — también al destruir. */
  private cancelTimers(): void {
    if (this.searchTimer) { clearTimeout(this.searchTimer); this.searchTimer = null; }
    if (this.montoTimer) { clearTimeout(this.montoTimer); this.montoTimer = null; }
  }

  onSearch(v: string): void {
    this.search.set(v);
    this.cancelTimers();
    this.searchTimer = setTimeout(() => { this.page.set(1); this.syncUrl(); this.reload(); }, 320);
  }

  onDate(which: 'from' | 'to', v: Date | null): void {
    (which === 'from' ? this.dateFrom : this.dateTo).set(v);
    this.preset.set(''); // cambio manual de fecha → deja de ser un preset
    this.page.set(1); this.syncUrl(); this.reload();
  }

  /** Rango rápido: fija Desde/Hasta según el preset (mes en curso, mes pasado, etc.). */
  onPreset(key: string | null): void {
    this.preset.set(key || '');
    const r = key ? datePresetRange(key) : null;
    if (!r) return; // limpiar el chip no borra las fechas ya elegidas
    this.dateFrom.set(r.from); this.dateTo.set(r.to);
    this.page.set(1); this.syncUrl(); this.reload();
  }

  onSucursal(v: string | null): void { this.sucursal.set(v || ''); this.page.set(1); this.syncUrl(); this.reload(); }
  onProveedor(v: string | null): void { this.proveedorCode.set(v || ''); this.page.set(1); this.syncUrl(); this.reload(); }
  onOc(v: Compras360OcMode | null): void { this.conOc.set(v || ''); this.page.set(1); this.syncUrl(); this.reload(); }
  onAjuste(v: Compras360AjusteMode | null): void { this.ajusteMode.set(v || ''); this.page.set(1); this.syncUrl(); this.reload(); }
  onComprobante(v: Compras360CompMode | null): void { this.comprobante.set(v || ''); this.page.set(1); this.syncUrl(); this.reload(); }
  /** Clic en la OC: filtra la tabla a todas las recepciones de esa orden de compra. */


  /** Monto min/max con debounce (evita un request por dígito tecleado). */
  onMonto(which: 'min' | 'max', v: number | null): void {
    (which === 'min' ? this.montoMin : this.montoMax).set(v ?? null);
    this.cancelTimers();
    this.montoTimer = setTimeout(() => { this.page.set(1); this.syncUrl(); this.reload(); }, 380);
  }

  hasFilters(): boolean {
    return !!(this.search().trim() || this.sucursal() || this.proveedorCode() || this.dateFrom() || this.dateTo() || this.conOc() || this.ajusteMode() || this.comprobante() || this.montoMin() != null || this.montoMax() != null);
  }

  clearFilters(): void {
    this.search.set(''); this.sucursal.set(''); this.proveedorCode.set(''); this.dateFrom.set(null); this.dateTo.set(null);
    this.conOc.set(''); this.ajusteMode.set(''); this.comprobante.set(''); this.montoMin.set(null); this.montoMax.set(null); this.preset.set('');
    this.sortField.set(''); this.sortOrder.set(-1);
    this.page.set(1); this.syncUrl(); this.reload();
  }

  openDetail(r: Compras360Row): void {
    this.detail.set(r);
    this.syncUrl();   // ?ent=suc|folio → el detalle es compartible y sobrevive F5
    this.explains.set([]); this.explainsTotal.set(0); this.explainsErr.set(false); this.explainsLoading.set(true);
    this.svc.adjustmentsForEntrada({ proveedor_code: r.proveedor_code, entrada_folio: r.folio, date: r.receipt_date?.slice(0, 10), window_days: 15 }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => { this.explains.set(res.rows || []); this.explainsTotal.set(res.total_monto || 0); this.explainsLoading.set(false); },
      error: () => { this.explainsLoading.set(false); this.explainsErr.set(true); },
    });
    // CXP.6 — póliza contable (Kepler) de la recepción (XA2001).
    this.poliza.set(null); this.polizaErr.set(false); this.polizaLoading.set(true);
    this.svc.polizaForReceipt({ sucursal: r.sucursal, folio: r.folio }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (pz) => { this.poliza.set(pz); this.polizaLoading.set(false); },
      error: () => { this.polizaLoading.set(false); this.poliza.set(null); this.polizaErr.set(true); },
    });
    // RE.9b — evidencia (comprobante) + auto-selecciona el 1er documento en el panel derecho.
    this.evidence.set([]); this.selectedDoc.set(null); this.evidenceErr.set(false); this.evidenceLoading.set(true);
    this.svc.receiptEvidence(r.sucursal, r.folio).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => {
        this.evidence.set(res.deposits || []);
        this.evidenceLoading.set(false);
        let first: ReceiptEvidenceFile | null = null;
        for (const dep of res.deposits || []) { if (dep.files && dep.files.length) { first = dep.files[0]; break; } }
        if (first) this.selectDoc(first);
      },
      error: () => { this.evidenceLoading.set(false); this.evidenceErr.set(true); },
    });
  }
  closeDetail(): void {
    this.detail.set(null); this.poliza.set(null); this.polizaErr.set(false);
    this.evidence.set([]); this.evidenceErr.set(false); this.selectedDoc.set(null);
    this.pendingEnt = null; this.syncUrl();
  }

  /** RE.9b — muestra el archivo en el panel derecho (iframe PDF / img) para comparar vs OCR. */
  selectDoc(f: ReceiptEvidenceFile): void {
    const isImg = this.isImageUrl(f);
    // El bypass del sanitizer solo se aplica a una URL http(s) verificada. La URL viene
    // prefirmada del backend, pero el registro lo origina un archivo que sube un usuario:
    // sin este guard un `javascript:`/`data:` en el campo se embebería en el iframe (§8).
    const safe = !isImg && this.isSafeHttpUrl(f.url);
    this.selectedDoc.set({
      url: f.url,
      safeUrl: safe ? this.sanitizer.bypassSecurityTrustResourceUrl(f.url) : null,
      kind: isImg ? 'image' : 'pdf',
      name: f.name || (isImg ? 'imagen' : 'comprobante (PDF)'),
    });
  }

  /** Solo http/https absolutas: nada de `javascript:`, `data:` ni protocolos raros. */
  private isSafeHttpUrl(u: string | null | undefined): boolean {
    try { const p = new URL(String(u ?? ''), window.location.origin); return p.protocol === 'http:' || p.protocol === 'https:'; }
    catch { return false; }
  }
  isImageUrl(f: ReceiptEvidenceFile): boolean {
    const k = (f.kind || '').toLowerCase();
    if (k === 'image' || /(jpe?g|png|webp|gif)/.test(k)) return true;
    if (k === 'pdf' || k === 'raw') return false;
    return /\.(jpe?g|png|webp|gif)(\?|$)/i.test(f.url || '');
  }

  /** Q.4 — navega a Descuentos filtrando por el proveedor (su lugar de arreglo). */
  drillToDescuentos(r: Compras360Row): void {
    const prov = r.proveedor_nombre || r.proveedor_code || '';
    this.closeDetail();
    this.router.navigate(['/compras/descuentos'], { queryParams: { q: prov } });
  }

  exportCsv(): void {
    this.exporting.set(true); this.exportMsg.set(null);
    this.svc.compras360(this.query(true)).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        const head = ['Fecha', 'Sucursal', 'Proveedor', 'Codigo', 'OC', 'Folio', 'Factura', 'Ajuste', 'Ajuste operativo', 'Ajuste comercial', 'Neto', 'Comprobante'];
        const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const comp = (r: Compras360Row) => r.deposits > 0 ? `${this.compLabel(r.deposit_status)}${r.monto_match ? ' (cuadra)' : ' (no cuadra)'}` : 'Sin comprobante';
        const lines = [head.join(',')].concat(d.rows.map((r) => [r.receipt_date?.slice(0, 10) || '', r.sucursal, r.proveedor_nombre || '', r.proveedor_code || '', r.oc_folio || '', r.folio, r.factura, r.ajuste, r.ajuste_operativo, r.ajuste_comercial, r.neto, comp(r)].map(esc).join(',')));
        const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'compras-360.csv'; a.click(); URL.revokeObjectURL(a.href);
        this.exporting.set(false);
        // El backend corta el export en 5,000 filas: se dice, no se calla. Un CSV incompleto
        // que parece completo es peor que no exportar.
        if (d.truncated) this.exportMsg.set(`El archivo trae las primeras ${d.rows.length.toLocaleString('es-MX')} de ${d.total.toLocaleString('es-MX')} recepciones (tope del export). Afiná los filtros para bajarlo completo.`);
      },
      error: () => { this.exporting.set(false); this.exportMsg.set('No se pudo generar el CSV. Intentá de nuevo o reducí el rango de fechas.'); },
    });
  }

  /** Antigüedad del espejo en minutos (null = el backend no reportó `data_as_of`). */
  private ageMin(): number | null {
    const iso = this.data()?.data_as_of;
    if (!iso) return null;
    const ms = Date.now() - new Date(iso).getTime();
    return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 60000)) : null;
  }
  /** Más de 24h sin correr el importer = el dato ya no representa la operación. */
  staleFeed(): boolean { const a = this.ageMin(); return a != null && a > 24 * 60; }
  freshLabel(): string {
    const a = this.ageMin();
    if (a == null) return 'Frescura desconocida';
    if (a < 60) return `Datos de hace ${a} min`;
    const h = Math.round(a / 60);
    if (h < 48) return `Datos de hace ${h} h`;
    return `Datos de hace ${Math.round(h / 24)} días`;
  }
  freshTitle(): string {
    const iso = this.data()?.data_as_of;
    const base = iso ? `Última corrida del importer: ${new Date(iso).toLocaleString('es-MX')}` : 'El backend no reportó la fecha del último feed';
    return this.staleFeed() ? `${base}. Hace más de 24 h — puede faltar operación reciente.` : base;
  }

  /** Sin nada que mirar: todo con comprobante y sin ajuste operativo. */
  verdictClean(d: Compras360Response): boolean {
    return d.total > 0 && d.totals.con_comprobante >= d.total && (d.totals.ajuste_operativo || 0) === 0;
  }

  /**
   * La lectura del periodo, en llano (§Q.2). Nombra lo que hay que mirar y cuánto pesa; el
   * strip de KPIs da los totales, pero un total no dice qué hacer.
   */
  verdict(d: Compras360Response): string {
    if (!d.total) return 'Sin recepciones en el periodo.';
    const sinComp = d.total - d.totals.con_comprobante;
    const op = d.totals.ajuste_operativo || 0;
    const partes: string[] = [];
    if (sinComp > 0) partes.push(`${sinComp} sin comprobante adjunto`);
    if (op !== 0) partes.push(`${moneyShort(op)} en ajustes operativos`);
    if (!partes.length) return `Las ${d.total} recepciones tienen comprobante y ningún ajuste operativo.`;
    return `De ${d.total} recepciones: ${partes.join(' y ')}.`;
  }

  kpiItems(d: Compras360Response): MetricStripItem[] {
    const cov = d.total > 0 ? Math.round((d.totals.con_comprobante / d.total) * 100) : 0;
    return [
      { label: 'Recepciones', value: d.total, format: 'number', tone: 'default' },
      { label: 'Factura total', value: d.totals.factura, format: 'currency-short', tone: 'default' },
      { label: 'Ajuste operativo', value: d.totals.ajuste_operativo, format: 'currency-short', tone: 'warn', sub: 'faltante · mal estado · duplicada' },
      { label: 'Ajuste comercial', value: d.totals.ajuste_comercial, format: 'currency-short', tone: 'ok', sub: 'descuento · pronto pago · apoyo' },
      { label: 'Neto', value: d.totals.neto, format: 'currency-short', tone: 'brand', sub: 'factura − ajuste' },
      // El tono lo decide la cobertura: con 0% adjuntos esta card estaba VERDE al lado de un
      // veredicto que decía que faltaban todos.
      { label: 'Con comprobante', value: d.totals.con_comprobante, format: 'number', tone: cov >= 90 ? 'ok' : cov >= 50 ? 'warn' : 'bad', sub: `${cov}% de ${d.total}` },
    ];
  }

  /** RE.9 — etiqueta/severidad del estado del comprobante adjunto (último depósito). */
  compLabel(s: string | null): string { return ({ recibido: 'Por validar', validado: 'Validado', rechazado: 'Rechazado' } as Record<string, string>)[s || ''] || 'Adjunto'; }
  compSev(s: string | null): 'success' | 'warn' | 'danger' | 'secondary' { return ({ recibido: 'warn', validado: 'success', rechazado: 'danger' } as Record<string, 'success' | 'warn' | 'danger'>)[s || ''] || 'secondary'; }

  pzCargos(pz: PolizaForReceipt): number { return pz.polizas.reduce((s, p) => s + (Number(p.cargos) || 0), 0); }
  pzAbonos(pz: PolizaForReceipt): number { return pz.polizas.reduce((s, p) => s + (Number(p.abonos) || 0), 0); }

  /**
   * 2 decimales, del formateador compartido. La copia local cortaba a pesos enteros y esta
   * pantalla cuadra Factura − Ajuste = Neto contra el OCR del comprobante: el chip
   * "cuadra/no cuadra" se calcula CON centavos, así que esconderlos dejaba al usuario viendo
   * dos cifras idénticas al lado de una alarma, sin manera de entenderla.
   */
  readonly money = money;
  readonly moneyShort = moneyShort;
}
