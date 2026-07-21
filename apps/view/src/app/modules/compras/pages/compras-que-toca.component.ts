import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin, of } from 'rxjs';
import { switchMap, map, catchError } from 'rxjs/operators';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { DialogModule } from 'primeng/dialog';
import { MessageService } from 'primeng/api';
import { ComprasService, WorklistRow, ReplenishmentFilters, CriticalStockRow, CreateRequisitionDto, OrderBasis, SupplierOrderHistory, SupplierOrder, SupplierOrderLine } from '../compras.service';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';

type Sev = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';
type WLRow = WorklistRow & { _key: string };
type DetailLine = CriticalStockRow & { finalCajas: number; uxc: number };
interface DetailState {
  loading: boolean;
  basis: OrderBasis;
  lines: DetailLine[];
  hub: Record<string, CriticalStockRow> | null;
  hist: SupplierOrderHistory | null;
  creating: boolean;
}

/**
 * RA-PRO.8/9/10 — Cockpit "Pedido". Master (almacén × proveedor) con: multi-select + generación
 * masiva (pedido general de renglones seleccionados) y drill-down que concentra la compra (base
 * cadencia/reorden/máx, cajas editables, ranking + $ que mueve, columnas ordenables, mínimo,
 * traspaso no-surtible con split, histórico, export). Además "Pedido consolidado por proveedor"
 * (todos sus almacenes de compra en un diálogo accionable). Operations: PrimeNG denso, tokens,
 * monocromático quiet-luxury (solo se colorean los problemas).
 */
@Component({
  selector: 'app-compras-que-toca',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, ToastModule, SelectModule, MultiSelectModule, TagModule, TooltipModule, InputTextModule, InputNumberModule, DialogModule, MetricStripComponent, FreshnessPillComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in qt-page">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Pedido</h1>
          <p class="surf-page-sub">Ciclos de reabasto por proveedor y sucursal. Selecciona renglones para un pedido general, o abre uno para armar la compra (base, cajas, mínimo, traspaso). También hay pedido consolidado por proveedor.</p>
        </div>
        @if (loadedAt()) { <app-freshness-pill [since]="loadedAt()" /> }
      </header>

      <app-metric-strip [items]="kpiItems()" ariaLabel="Resumen de ciclos de reabasto" />

      <div class="qt-filters">
        <div class="qt-wh">
          <p-multiSelect [options]="warehouses()" [(ngModel)]="fWh" (onChange)="reload()"
                         optionLabel="label" optionValue="id" placeholder="Todos los almacenes" [showClear]="true"
                         [maxSelectedLabels]="2" selectedItemsLabel="{0} almacenes" styleClass="qt-sel"></p-multiSelect>
          <div class="qt-atajos">
            <span class="qt-atajos-lbl">Atajos:</span>
            <button type="button" class="qt-atajo" [class.on]="!fWh.length" (click)="clearWh()">Todos</button>
            @for (t of territories; track t.label) {
              <button type="button" class="qt-atajo" [class.on]="isTerr(t.codes)" (click)="applyTerr(t.codes)">{{ t.label }}</button>
            }
          </div>
        </div>
        <p-select [options]="viaOpts" [(ngModel)]="fVia" (onChange)="reload()" optionLabel="label" optionValue="value"
                  placeholder="Canal" [showClear]="true" styleClass="qt-sel-sm"></p-select>
        <p-select [options]="statusOpts" [(ngModel)]="fStatus" (onChange)="reload()" optionLabel="label" optionValue="value" styleClass="qt-sel-sm"></p-select>
        <p-select [options]="basisOpts" [ngModel]="fBasis()" (ngModelChange)="fBasis.set($event); reload()" optionLabel="label" optionValue="value"
                  placeholder="Objetivo" styleClass="qt-sel-sm" ariaLabel="Base del sugerido (objetivo)" pTooltip="Nivel al que se llena el sugerido: aplica a la columna Costo est. y al detalle" tooltipPosition="bottom"></p-select>
        <p-select [options]="supplierOpts()" [(ngModel)]="fSearch" (onChange)="reload()" (onClear)="reload()"
                  optionLabel="label" optionValue="value" placeholder="Todos los proveedores" [showClear]="true"
                  [filter]="true" filterBy="label" filterPlaceholder="Buscar proveedor…" [resetFilterOnHide]="true"
                  [virtualScroll]="true" [virtualScrollItemSize]="34" styleClass="qt-sel-wide" ariaLabel="Filtrar por proveedor"></p-select>
        <span class="qt-count">{{ total() | number }} par(es) activo(s)</span>
      </div>

      <!-- A1 — barra de acción del pedido general (selección múltiple) -->
      @if (selectedRows().length) {
        <div class="qt-bulk">
          <span class="qt-bulk-txt"><strong>{{ selectedRows().length }}</strong> seleccionado(s) · {{ money(selTotal()) }}</span>
          <button pButton label="Generar pedido general" icon="pi pi-bolt" class="p-button-sm"
                  [loading]="bulkGenerating()" (click)="bulkGenerate()"></button>
          <button pButton label="Limpiar" icon="pi pi-times" class="p-button-sm p-button-text" (click)="selectedRows.set([])"></button>
        </div>
      }

      <p-table [value]="rows()" [loading]="loading()" [scrollable]="true" scrollHeight="flex"
               dataKey="_key" (onRowExpand)="onExpand($event.data)"
               [selection]="selectedRows()" (selectionChange)="selectedRows.set($event)" selectionMode="multiple"
               styleClass="p-datatable-sm qt-table">
        <ng-template pTemplate="header">
          <tr>
            <th style="width:2.2rem"><p-tableHeaderCheckbox /></th>
            <th style="width:2.5rem"></th>
            <th>Estado</th><th>Próximo</th><th>Proveedor</th><th>Almacén</th><th>Canal</th>
            <th class="qt-r">Cadencia</th><th>Última</th><th class="qt-r">SKUs</th>
            <th class="qt-r">Sugerido</th><th class="qt-r">Costo est.</th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-r let-expanded="expanded">
          <tr>
            <td><p-tableCheckbox [value]="r" /></td>
            <td>
              <button type="button" pButton [pRowToggler]="r" [text]="true" [rounded]="true"
                      class="p-button-sm" [icon]="expanded ? 'pi pi-chevron-down' : 'pi pi-chevron-right'"></button>
            </td>
            <td><p-tag [value]="estLabel(r)" [severity]="estSev(r)"></p-tag></td>
            <td class="qt-nowrap" [class.qt-bad]="(r.days_to_due ?? 0) < 0">
              {{ r.next_due_date | date:'dd/MM/yy' }}
              <span class="qt-dd">{{ ddLabel(r.days_to_due) }}</span>
            </td>
            <td>{{ r.supplier_name || '—' }}</td>
            <td class="qt-muted" [title]="r.warehouse_code">{{ r.warehouse_name || r.warehouse_code }}</td>
            <td>
              @if (r.via === 'transfer') {
                <span class="qt-via qt-via-t" [pTooltip]="'Traspaso desde ' + (r.source_warehouse_code||'?')">
                  <i class="pi pi-arrow-right-arrow-left"></i> Traspaso <span class="qt-muted">← {{ r.source_warehouse_code || '?' }}</span>
                </span>
              } @else {
                <span class="qt-via qt-via-c"><i class="pi pi-shopping-cart"></i> Compra</span>
              }
            </td>
            <td class="qt-r">
              <span class="qt-cad">{{ r.cadence_days != null ? (r.cadence_days | number:'1.0-1') + 'd' : '—' }}</span>
              @if (r.health_band) { <p-tag [value]="bandLabel(r.health_band)" [severity]="bandSev(r.health_band)" styleClass="qt-band"></p-tag> }
            </td>
            <td class="qt-muted qt-nowrap">{{ r.last_delivery_date | date:'dd/MM/yy' }}</td>
            <td class="qt-r"><span [class.qt-strong]="r.n_below>0">{{ r.n_below | number }}</span><span class="qt-muted">/{{ r.n_skus | number }}</span></td>
            <td class="qt-r">{{ r.suggested_qty | number:'1.0-0' }}</td>
            <td class="qt-r qt-strong">{{ money(r.suggested_cost) }}</td>
          </tr>
        </ng-template>
        <ng-template pTemplate="rowexpansion" let-r>
          <tr class="qt-detrow">
            <td colspan="12">
              @if (detail()[r._key]; as st) {
                @if (st.loading && !st.lines.length) {
                  <div class="qt-det-msg">Cargando pedido…</div>
                } @else {
                <div class="qt-det">
                  <div class="qt-det-bar">
                    <span class="qt-basis-lbl">Objetivo: <strong>{{ basisLabel(fBasis()) }}</strong> <span class="qt-muted">(cambialo en el filtro de arriba)</span></span>
                    @if (st.hist; as h) {
                      <div class="qt-hist" [pTooltip]="histTip(h)" tooltipPosition="left">
                        <i class="pi pi-history"></i>
                        @if (h.last) {
                          Última compra {{ h.last.date | date:'dd/MM/yy' }} · {{ money(h.last.amount) }}
                          <span class="qt-muted">· típico ~{{ money(h.typical_amount) }} · {{ h.n_orders }} órdenes</span>
                        } @else {
                          <span class="qt-muted">Sin compras directas{{ r.via==='transfer' ? ' (se surte por traspaso)' : '' }}</span>
                        }
                      </div>
                    }
                  </div>

                  @if (r.via==='transfer' && hubShortCount(r._key) > 0) {
                    <div class="qt-block" role="alert">
                      <i class="pi pi-exclamation-triangle"></i>
                      <span>El hub <strong>{{ r.source_warehouse_code }}</strong> no tiene stock para surtir {{ hubShortCount(r._key) }} línea(s).</span>
                      <button pButton label="Traspasar disponible + comprar faltante" icon="pi pi-arrows-h"
                              class="p-button-sm qt-block-btn" [loading]="st.creating" (click)="splitTransfer(r)"></button>
                    </div>
                  }

                  @if (st.lines.length) {
                    <table class="qt-det-table">
                      <thead>
                        <tr>
                          <th class="qt-sortable" (click)="setSort('sku')">SKU {{ sortArrow('sku') }}</th>
                          <th class="qt-sortable" (click)="setSort('nombre')">Producto {{ sortArrow('nombre') }}</th>
                          <th class="qt-r qt-sortable" (click)="setSort('rank')" pTooltip="Ranking de ventas en la sucursal (#1 = el que más vende)">Rank {{ sortArrow('rank') }}</th>
                          <th class="qt-r qt-sortable" (click)="setSort('rev')" pTooltip="Venta mensual estimada ($ que mueve)">$ mueve {{ sortArrow('rev') }}</th>
                          <th class="qt-r qt-sortable" (click)="setSort('oh')">Existencia {{ sortArrow('oh') }}</th>
                          @if (r.via==='transfer') { <th class="qt-r">En hub</th> }
                          <th class="qt-r">Objetivo</th>
                          <th class="qt-r qt-sortable" (click)="setSort('sug')">Sugerido {{ sortArrow('sug') }}</th>
                          <th class="qt-r qt-pedir qt-sortable" (click)="setSort('cajas')">Pedir (cajas) {{ sortArrow('cajas') }}</th>
                          <th class="qt-r qt-sortable" (click)="setSort('pz')">Piezas {{ sortArrow('pz') }}</th>
                          <th class="qt-r qt-sortable" (click)="setSort('line')">$ línea {{ sortArrow('line') }}</th>
                        </tr>
                      </thead>
                      <tbody>
                        @for (l of sortedLines(r._key); track l.product_id) {
                          <tr [class.qt-det-below]="l.on_hand <= l.reorder_point">
                            <td class="qt-mono">{{ l.sku }}</td>
                            <td>{{ l.nombre }}</td>
                            <td class="qt-r qt-muted">{{ l.sales_rank ? ('#' + l.sales_rank) : '—' }}</td>
                            <td class="qt-r qt-muted">{{ money(l.monthly_revenue) }}</td>
                            <td class="qt-r" [class.qt-bad]="l.on_hand <= 0">{{ l.on_hand | number:'1.0-0' }}</td>
                            @if (r.via==='transfer') {
                              <td class="qt-r" [class.qt-bad]="hubShort(r._key, l)" [pTooltip]="hubShort(r._key, l) ? 'El hub no alcanza a surtir lo pedido' : ''">
                                {{ hubOnHand(r._key, l) === null ? '—' : (hubOnHand(r._key, l) | number:'1.0-0') }}
                              </td>
                            }
                            <td class="qt-r qt-muted">{{ objetivo(l) | number:'1.0-0' }}</td>
                            <td class="qt-r">{{ l.suggested_qty | number:'1.0-0' }}</td>
                            <td class="qt-r qt-pedir"><p-inputNumber [(ngModel)]="l.finalCajas" [min]="0" [showButtons]="false" inputStyleClass="qt-qty" (onInput)="touch()"></p-inputNumber></td>
                            <td class="qt-r qt-muted">{{ pzOf(l) | number:'1.0-0' }}</td>
                            <td class="qt-r">{{ money(lineCost(l)) }}</td>
                          </tr>
                        }
                      </tbody>
                    </table>
                    <div class="qt-det-foot">
                      @if (r.via==='purchase' && minWarn(r._key); as mw) {
                        <p-tag severity="warn" [value]="mw" styleClass="qt-mintag" [pTooltip]="'Mínimo de compra del proveedor (captúralo en Proveedores).'"></p-tag>
                        <button pButton label="Subir al mínimo" icon="pi pi-arrow-up" class="p-button-sm p-button-text" (click)="padToMin(r)"></button>
                      }
                      <button pButton label="Pedido consolidado del proveedor" icon="pi pi-sitemap" class="p-button-sm p-button-text qt-cons-open"
                              (click)="openConsolidated(r.supplier_id, r.supplier_name)"></button>
                      <span class="qt-foot-tot">
                        {{ countToOrder(r._key) }} línea(s) · {{ totalCajas(r._key) | number:'1.0-0' }} cajas ·
                        {{ totalPz(r._key) | number:'1.0-0' }} pz · <strong>{{ money(detailTotal(r._key)) }}</strong>
                      </span>
                      <button pButton label="Exportar" icon="pi pi-download" class="p-button-sm p-button-text"
                              [disabled]="countToOrder(r._key)===0" (click)="exportRow(r)"></button>
                      <button pButton [label]="r.via==='transfer' ? 'Crear traspaso' : 'Crear requisición'"
                              icon="pi pi-file-edit" class="p-button-sm"
                              [loading]="st.creating" [disabled]="countToOrder(r._key)===0"
                              (click)="createReq(r)"></button>
                    </div>
                  } @else {
                    <div class="qt-det-msg">Sin SKUs por pedir con base “{{ basisLabel(st.basis) }}” (todo cubierto).</div>
                  }
                </div>
                }
              }
            </td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="12" class="qt-empty">Sin ciclos activos con estos filtros. Ajusta el territorio o corre el job de cadencia.</td></tr>
        </ng-template>
      </p-table>
    </div>

    <!-- A2 — Pedido consolidado por proveedor (todos sus almacenes de compra) -->
    <p-dialog [visible]="consVisible()" (visibleChange)="consVisible.set($event)" [modal]="true"
              [style]="{width:'min(1040px,96vw)'}" [header]="consHeader()" (onHide)="consOrder.set(null)">
      @if (consLoading()) {
        <div class="qt-det-msg">Cargando pedido consolidado…</div>
      } @else {
        @if (consOrder(); as o) {
        <div class="qt-cons">
          <div class="qt-cons-wh">
            <span class="qt-basis-lbl">Almacenes:</span>
            @for (w of consWhs(); track w.id) {
              <button pButton type="button" [label]="w.code + ' · ' + w.n" class="p-button-sm"
                      [ngClass]="isWhIncluded(w.id) ? 'p-button-outlined' : 'p-button-text'" (click)="toggleWh(w.id)"></button>
            }
          </div>
          @if (consLinesFiltered().length) {
            <div class="qt-cons-scroll">
              <table class="qt-det-table">
                <thead><tr><th>Almacén</th><th>SKU</th><th>Producto</th><th class="qt-r">Cajas</th><th class="qt-r">Piezas</th><th class="qt-r">$ línea</th></tr></thead>
                <tbody>
                  @for (l of consLinesFiltered(); track l.product_id + '_' + l.warehouse_id) {
                    <tr>
                      <td class="qt-muted">{{ l.warehouse_code }}</td>
                      <td class="qt-mono">{{ l.sku }}</td>
                      <td>{{ l.nombre }}</td>
                      <td class="qt-r">{{ l.cajas | number:'1.0-0' }}</td>
                      <td class="qt-r qt-muted">{{ l.final | number:'1.0-0' }}</td>
                      <td class="qt-r">{{ money(l.line_cost) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            <div class="qt-det-foot">
              @if (o.padded) { <p-tag severity="info" value="Subido al mínimo" styleClass="qt-mintag"></p-tag> }
              <span class="qt-foot-tot">
                {{ consWhsIncluded() }} almacén(es) · {{ consTotCajas() | number:'1.0-0' }} cajas · <strong>{{ money(consTotAmount()) }}</strong>
              </span>
              <button pButton label="Generar requisiciones" icon="pi pi-file-edit" class="p-button-sm"
                      [loading]="consGenerating()" [disabled]="!consLinesFiltered().length" (click)="generateConsolidated()"></button>
            </div>
          } @else {
            <div class="qt-det-msg">Sin líneas por pedir (o desactivaste todos los almacenes).</div>
          }
        </div>
      } @else {
        <div class="qt-det-msg">Sin pedido de compra para este proveedor.</div>
      }
      }
    </p-dialog>
  `,
  styles: [`
    :host { display: block; }
    app-metric-strip { display: block; margin-bottom: .9rem; }
    .qt-filters { display: flex; flex-wrap: wrap; gap: .5rem; align-items: flex-start; margin-bottom: .75rem; }
    .qt-wh { display: flex; flex-direction: column; gap: .25rem; }
    .qt-atajos { display: flex; align-items: center; gap: .1rem; flex-wrap: wrap; }
    .qt-atajos-lbl { font-size: .7rem; color: var(--text-muted); margin-right: .2rem; }
    .qt-atajo { border: none; background: none; cursor: pointer; font-size: .74rem; color: var(--text-muted);
      padding: .05rem .4rem; border-radius: var(--r-sm, 6px); font-family: inherit; }
    .qt-atajo:hover { color: var(--text-main); background: color-mix(in srgb, var(--text-main) 6%, transparent); }
    .qt-atajo.on { color: var(--action); font-weight: 600; }
    .qt-sel { min-width: 14rem; }
    .qt-sel-sm { min-width: 9rem; }
    .qt-sel-wide { min-width: 15rem; }
    .qt-count { color: var(--text-muted); font-size: .82rem; margin-left: auto; }
    .qt-bulk { display: flex; align-items: center; gap: .6rem; margin-bottom: .6rem; padding: .45rem .7rem;
      background: var(--action-ring, color-mix(in srgb, var(--action) 12%, transparent)); border-radius: var(--r-sm, 6px); }
    .qt-bulk-txt { font-size: .82rem; color: var(--text-main); }
    .qt-table { font-size: .82rem; }
    .qt-r { text-align: right; font-variant-numeric: tabular-nums; }
    .qt-nowrap { white-space: nowrap; }
    .qt-muted { color: var(--text-muted); }
    .qt-strong { font-weight: 700; }
    .qt-bad { color: var(--bad-fg); font-weight: 600; }
    .qt-dd { font-size: .72rem; color: var(--text-muted); margin-left: .35rem; }
    .qt-via { display: inline-flex; align-items: center; gap: .3rem; font-size: .78rem; }
    .qt-via i { font-size: .7rem; }
    .qt-via-t { color: var(--action); }
    .qt-cad { font-variant-numeric: tabular-nums; margin-right: .35rem; }
    :host ::ng-deep .qt-band { font-size: .62rem !important; padding: .05rem .3rem !important; }
    .qt-empty { color: var(--text-muted); padding: 1rem; text-align: center; }
    /* La fila expandida NO debe estirar las columnas de la p-table (header sticky se
       desalinea). El wrapper .qt-det es un BFC con scroll propio: la tabla ancha del
       drill scrollea DENTRO en vez de ensanchar el cuerpo. min-width:0 en la celda
       evita que el contenido imponga su ancho mínimo a la tabla exterior. */
    .qt-detrow > td { background: var(--surface-sunken, var(--card-bg)); padding: .4rem .75rem .6rem; min-width: 0; }
    .qt-det { min-width: 0; overflow-x: auto; }
    .qt-det-msg { color: var(--text-muted); font-size: .82rem; padding: .5rem; }
    .qt-det-bar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; padding: .1rem .1rem .5rem; }
    .qt-basis { display: flex; align-items: center; gap: .1rem; }
    .qt-basis-lbl { font-size: .74rem; color: var(--text-muted); margin-right: .3rem; }
    .qt-hist { font-size: .76rem; color: var(--text-main); display: inline-flex; align-items: center; gap: .35rem; }
    .qt-hist i { font-size: .72rem; color: var(--text-muted); }
    .qt-block { display: flex; align-items: center; gap: .5rem; font-size: .78rem;
      background: var(--bad-soft-bg); color: var(--bad-soft-fg); border: 1px solid var(--bad-border);
      border-radius: var(--r-sm, 6px); padding: .4rem .6rem; margin-bottom: .5rem; flex-wrap: wrap; }
    .qt-block i { font-size: .8rem; }
    .qt-block-btn { margin-left: auto; }
    .qt-det-table { width: 100%; border-collapse: collapse; font-size: .8rem; }
    .qt-det-table th { text-align: left; color: var(--text-muted); font-weight: 600; font-size: .72rem;
      text-transform: uppercase; letter-spacing: .02em; padding: .25rem .5rem; border-bottom: 1px solid var(--border-color); white-space: nowrap; }
    .qt-sortable { cursor: pointer; user-select: none; }
    .qt-sortable:hover { color: var(--text-main); }
    .qt-det-table td { padding: .25rem .5rem; border-bottom: 1px solid var(--border-color); }
    .qt-det-below td { background: color-mix(in srgb, var(--bad-fg) 6%, transparent); }
    .qt-mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .76rem; }
    .qt-pedir { width: 7rem; }
    :host ::ng-deep .qt-qty { width: 5.5rem; text-align: right; font-size: .8rem; padding: .2rem .4rem; }
    .qt-det-foot { display: flex; align-items: center; justify-content: flex-end; gap: .75rem; padding: .55rem .5rem 0; flex-wrap: wrap; }
    .qt-foot-tot { font-size: .82rem; color: var(--text-main); }
    .qt-cons-open { margin-right: auto; }
    :host ::ng-deep .qt-mintag { font-size: .68rem !important; }
    .qt-cons-wh { display: flex; align-items: center; gap: .2rem; flex-wrap: wrap; margin-bottom: .6rem; }
    .qt-cons-scroll { max-height: 55vh; overflow: auto; }
  `],
})
export class ComprasQueTocaComponent implements OnInit {
  private readonly api = inject(ComprasService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  rows = signal<WLRow[]>([]);
  warehouses = signal<{ id: string; code: string; label: string }[]>([]);
  supplierOpts = signal<{ label: string; value: string }[]>([]);
  detail = signal<Record<string, DetailState>>({});
  total = signal(0);
  vencidos = signal(0);
  hoy = signal(0);
  prox7 = signal(0);
  loading = signal(false);
  readonly loadedAt = signal<number | null>(null);
  private readonly touchTick = signal(0);
  sugeridoTotal = computed(() => this.rows().reduce((s, r) => s + (Number(r.suggested_cost) || 0), 0));

  // A1 — selección múltiple + generación masiva
  selectedRows = signal<WLRow[]>([]);
  bulkGenerating = signal(false);
  // D — orden del detalle (default por $ que mueve, estable al editar)
  detSort = signal<{ f: string; d: 1 | -1 }>({ f: 'rev', d: -1 });
  // A2 — pedido consolidado por proveedor
  consVisible = signal(false);
  consLoading = signal(false);
  consGenerating = signal(false);
  consOrder = signal<SupplierOrder | null>(null);
  consSupplier = signal<{ id: string; name: string | null } | null>(null);
  consExcluded = signal<Set<string>>(new Set());

  readonly kpiItems = computed<MetricStripItem[]>(() => [
    { label: 'Vencidos', value: this.vencidos(), tone: this.vencidos() > 0 ? 'bad' : 'default' },
    { label: 'Hoy', value: this.hoy(), tone: this.hoy() > 0 ? 'warn' : 'default' },
    { label: 'Próx. 7 días', value: this.prox7() },
    { label: 'Sugerido (visible)', value: this.sugeridoTotal(), format: 'currency', tone: 'brand' },
  ]);

  fWh: string[] = [];
  fVia = '';
  fStatus = '';
  fSearch = '';
  /** Base GLOBAL (como "Objetivo" de Existencia Crítica): manda el sugerido/costo de
   * TODA la vista — columna "Costo est.", KPI y drill usan la misma. Default = máximo. */
  fBasis = signal<OrderBasis>('max');
  viaOpts = [{ label: 'Compra', value: 'purchase' }, { label: 'Traspaso', value: 'transfer' }];
  statusOpts = [{ label: 'Activos', value: '' }, { label: 'Solo lo que toca (≤ hoy)', value: 'due' }];
  basisOpts: { label: string; value: OrderBasis }[] = [
    { label: 'Hasta el máximo', value: 'max' },
    { label: 'Hasta reorden', value: 'reorder' },
    { label: 'Hasta el mínimo', value: 'min' },
  ];
  territories = [
    { label: 'Bajío', codes: ['01', '02', '03', '04'] },
    { label: 'Morelia', codes: ['MD-30', 'MD-32'] },
    { label: 'Zamora', codes: ['05', 'MD-50'] },
    { label: 'CEDIS', codes: ['00'] },
  ];

  ngOnInit(): void {
    this.api.filters().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (f: ReplenishmentFilters) => {
        this.warehouses.set(f.warehouses.map((w) => ({ id: w.id, code: w.code, label: `${w.code} · ${w.name}` })));
        this.supplierOpts.set(f.suppliers.map((s) => ({ label: s.name, value: s.name })));
      },
      error: () => {},
    });
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.detail.set({});
    this.selectedRows.set([]);
    this.api.worklist({ warehouse_ids: this.fWh.length ? this.fWh : undefined, via: this.fVia || undefined, status: this.fStatus || undefined, search: this.fSearch || undefined, target_basis: this.fBasis(), pageSize: 500 })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => {
          this.rows.set(r.rows.map((x) => ({ ...x, _key: `${x.warehouse_id}__${x.supplier_id}` })));
          this.total.set(r.total); this.vencidos.set(r.vencidos); this.hoy.set(r.hoy); this.prox7.set(r.prox7);
          this.loading.set(false); this.loadedAt.set(Date.now());
        },
        error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar el pedido.' }); },
      });
  }

  // ── Drill-down ──
  onExpand(r: WLRow): void {
    const cur = this.detail()[r._key];
    if (cur && !cur.loading) return;
    this.loadLines(r, this.fBasis(), true);
  }

  private loadLines(r: WLRow, basis: OrderBasis, withContext: boolean): void {
    this.detail.update((d) => ({
      ...d,
      [r._key]: { loading: true, basis, lines: d[r._key]?.lines ?? [], hub: d[r._key]?.hub ?? null, hist: d[r._key]?.hist ?? null, creating: false },
    }));
    this.api.criticalStock({ supplier_id: r.supplier_id, warehouse_id: r.warehouse_id, target_basis: basis, scope: 'all', pageSize: 500 })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (res) => {
          const lines: DetailLine[] = res.rows
            .filter((x) => Number(x.suggested_qty) > 0)
            .map((x) => { const uxc = this.uxc(x); return { ...x, uxc, finalCajas: Math.ceil((Number(x.suggested_qty) || 0) / uxc) }; });
          this.detail.update((d) => (d[r._key] ? { ...d, [r._key]: { ...d[r._key], loading: false, basis, lines } } : d));
        },
        error: () => {
          this.detail.update((d) => (d[r._key] ? { ...d, [r._key]: { ...d[r._key], loading: false, lines: [] } } : d));
          this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar los SKUs.' });
        },
      });
    if (!withContext) return;
    const buyWh = r.via === 'transfer' ? (r.source_warehouse_id ?? undefined) : r.warehouse_id;
    this.api.supplierOrderHistory(r.supplier_id, buyWh).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (h) => this.detail.update((d) => (d[r._key] ? { ...d, [r._key]: { ...d[r._key], hist: h } } : d)),
      error: () => {},
    });
    if (r.via === 'transfer' && r.source_warehouse_id) {
      this.api.criticalStock({ supplier_id: r.supplier_id, warehouse_id: r.source_warehouse_id, target_basis: 'max', scope: 'all', pageSize: 1000 })
        .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
          next: (res) => {
            const hub: Record<string, CriticalStockRow> = {};
            for (const x of res.rows) hub[x.product_id] = x;
            this.detail.update((d) => (d[r._key] ? { ...d, [r._key]: { ...d[r._key], hub } } : d));
          },
          error: () => {},
        });
    }
  }

  touch(): void { this.touchTick.update((n) => n + 1); }
  objetivo(l: DetailLine): number { return Math.round(Number(l.on_hand) + Number(l.in_transit) + Number(l.suggested_qty)); }
  // uxc canónico: factor_sale → box_size (etiquetera) → 1 (igual que sales_boxes_monthly).
  private uxc(l: CriticalStockRow): number {
    const fs = Number(l.factor_sale), bs = Number(l.box_size), fp = Number(l.factor_purchase);
    return fs > 1 ? fs : (bs > 1 ? bs : (fp > 1 ? fp : 1));
  }
  pzOf(l: DetailLine): number { return Math.round(Number(l.finalCajas || 0) * (l.uxc || 1)); }
  lineCost(l: DetailLine): number { return this.pzOf(l) * Number(l.unit_cost || 0); }

  private linesOf(key: string): DetailLine[] { this.touchTick(); return this.detail()[key]?.lines ?? []; }
  countToOrder(key: string): number { return this.linesOf(key).filter((l) => Number(l.finalCajas) > 0).length; }
  totalCajas(key: string): number { return this.linesOf(key).reduce((s, l) => s + Number(l.finalCajas || 0), 0); }
  totalPz(key: string): number { return this.linesOf(key).reduce((s, l) => s + this.pzOf(l), 0); }
  detailTotal(key: string): number { return this.linesOf(key).reduce((s, l) => s + this.pzOf(l) * Number(l.unit_cost || 0), 0); }

  // D — orden por columna (no lee touchTick → no salta la fila mientras editas)
  setSort(f: string): void { this.detSort.update((s) => (s.f === f ? { f, d: (s.d === 1 ? -1 : 1) as 1 | -1 } : { f, d: 1 })); }
  sortArrow(f: string): string { const s = this.detSort(); return s.f === f ? (s.d === 1 ? '↑' : '↓') : ''; }
  sortedLines(key: string): DetailLine[] {
    const st = this.detail()[key]; if (!st) return [];
    const { f, d } = this.detSort();
    const val = (l: DetailLine): number | string => {
      switch (f) {
        case 'sku': return l.sku || '';
        case 'nombre': return l.nombre || '';
        case 'rank': return l.sales_rank == null ? 1e9 : Number(l.sales_rank);
        case 'rev': return Number(l.monthly_revenue || 0);
        case 'oh': return Number(l.on_hand || 0);
        case 'sug': return Number(l.suggested_qty || 0);
        case 'cajas': return Number(l.finalCajas || 0);
        case 'pz': return this.pzOf(l);
        default: return this.lineCost(l);
      }
    };
    return [...st.lines].sort((a, b) => {
      const va = val(a), vb = val(b);
      if (typeof va === 'string' || typeof vb === 'string') return d * String(va).localeCompare(String(vb));
      return d * ((va as number) - (vb as number));
    });
  }

  hubOnHand(key: string, l: DetailLine): number | null { const h = this.detail()[key]?.hub; return h ? Number(h[l.product_id]?.on_hand ?? 0) : null; }
  hubShort(key: string, l: DetailLine): boolean {
    const st = this.detail()[key]; this.touchTick();
    if (!st?.hub) return false; return Number(st.hub[l.product_id]?.on_hand ?? 0) < this.pzOf(l);
  }
  hubShortCount(key: string): number {
    const st = this.detail()[key]; this.touchTick();
    if (!st?.hub) return 0; return st.lines.filter((l) => Number(st.hub![l.product_id]?.on_hand ?? 0) < this.pzOf(l)).length;
  }

  minWarn(key: string): string | null {
    this.touchTick();
    const st = this.detail()[key]; if (!st?.lines.length) return null;
    const l0 = st.lines[0];
    const minA = l0.supplier_min_amount != null ? Number(l0.supplier_min_amount) : null;
    const minB = l0.supplier_min_boxes != null ? Number(l0.supplier_min_boxes) : null;
    if (minA != null && this.detailTotal(key) < minA) return `Bajo mínimo · ${this.money(this.detailTotal(key))} < ${this.money(minA)}`;
    if (minB != null && this.totalCajas(key) < minB) return `Bajo mínimo · ${this.totalCajas(key)} < ${minB} cajas`;
    return null;
  }

  padToMin(r: WLRow): void {
    const key = r._key, st = this.detail()[key];
    if (!st?.lines.length) return;
    const l0 = st.lines[0];
    const minA = l0.supplier_min_amount != null ? Number(l0.supplier_min_amount) : null;
    const minB = l0.supplier_min_boxes != null ? Number(l0.supplier_min_boxes) : null;
    const sumAvg = st.lines.reduce((s, l) => s + Math.max(Number(l.avg_daily_units) || 0, 0), 0);
    const w = (l: DetailLine) => (sumAvg > 0 ? Math.max(Number(l.avg_daily_units) || 0, 0) / sumAvg : 1 / st.lines.length);
    if (minA != null && this.detailTotal(key) < minA) {
      const short = minA - this.detailTotal(key);
      for (const l of st.lines) { const cc = (l.uxc || 1) * (Number(l.unit_cost) || 0); if (cc > 0) l.finalCajas = Number(l.finalCajas || 0) + Math.ceil((short * w(l)) / cc); }
    } else if (minB != null && this.totalCajas(key) < minB) {
      const short = minB - this.totalCajas(key);
      for (const l of st.lines) l.finalCajas = Number(l.finalCajas || 0) + Math.ceil(short * w(l));
    } else { return; }
    this.touch();
    this.toast.add({ severity: 'info', summary: 'Pedido subido al mínimo', detail: `${this.totalCajas(key)} cajas · ${this.money(this.detailTotal(key))}` });
  }

  histTip(h: SupplierOrderHistory): string {
    if (!h.recent?.length) return '';
    const recent = h.recent.map((e) => `${new Date(e.date).toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: '2-digit' })}  ${this.money(e.amount)}`).join('\n');
    return `Últimas compras:\n${recent}\n\nMediana ${this.money(h.median_amount)} · máx ${this.money(h.max_amount)}`;
  }

  createReq(r: WLRow): void {
    const st = this.detail()[r._key];
    if (!st) return;
    const picked = st.lines.filter((l) => Number(l.finalCajas) > 0);
    if (!picked.length) return;
    const isTransfer = r.via === 'transfer';
    if (isTransfer && !r.source_warehouse_id) {
      this.toast.add({ severity: 'warn', summary: 'Sin origen', detail: 'Este traspaso no tiene almacén origen (hub). Configúralo en Red de abasto.' });
      return;
    }
    const dto: CreateRequisitionDto = {
      warehouse_id: r.warehouse_id,
      supplier_id: isTransfer ? null : r.supplier_id,
      source_type: isTransfer ? 'branch' : 'supplier',
      source_warehouse_id: isTransfer ? r.source_warehouse_id : null,
      notes: `Pedido ${r.supplier_name || ''} @ ${r.warehouse_code} · base ${st.basis}`.trim(),
      lines: picked.map((l) => this.reqLine(l, this.pzOf(l), isTransfer ? 'branch' : 'supplier', isTransfer ? null : (l.supplier_id ?? r.supplier_id), isTransfer ? r.source_warehouse_id : null)),
    };
    this.detail.update((d) => ({ ...d, [r._key]: { ...d[r._key], creating: true } }));
    this.api.createRequisition(dto).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (req) => {
        this.detail.update((d) => ({ ...d, [r._key]: { ...d[r._key], creating: false } }));
        this.toast.add({ severity: 'success', summary: isTransfer ? 'Traspaso creado' : 'Requisición creada', detail: `${req.folio} · ${picked.length} línea(s)` });
      },
      error: (e) => {
        this.detail.update((d) => ({ ...d, [r._key]: { ...d[r._key], creating: false } }));
        this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo crear.' });
      },
    });
  }

  splitTransfer(r: WLRow): void {
    const key = r._key, st = this.detail()[key];
    if (!st?.hub || !r.source_warehouse_id) return;
    const transfer: { l: DetailLine; qty: number }[] = [];
    const purchase: { l: DetailLine; qty: number }[] = [];
    for (const l of st.lines) {
      const want = this.pzOf(l); if (want <= 0) continue;
      const avail = Math.max(0, Math.min(want, Number(st.hub[l.product_id]?.on_hand ?? 0)));
      if (avail > 0) transfer.push({ l, qty: avail });
      if (want - avail > 0) purchase.push({ l, qty: want - avail });
    }
    if (!transfer.length && !purchase.length) return;
    const jobs = [];
    if (transfer.length) jobs.push(this.api.createRequisition({
      warehouse_id: r.warehouse_id, supplier_id: null, source_type: 'branch', source_warehouse_id: r.source_warehouse_id,
      notes: `Traspaso disponible ${r.supplier_name || ''} @ ${r.warehouse_code}`.trim(),
      lines: transfer.map(({ l, qty }) => this.reqLine(l, qty, 'branch', null, r.source_warehouse_id)),
    }));
    if (purchase.length) jobs.push(this.api.createRequisition({
      warehouse_id: r.source_warehouse_id, supplier_id: r.supplier_id, source_type: 'supplier', source_warehouse_id: null,
      notes: `Compra faltante ${r.supplier_name || ''} @ hub ${r.source_warehouse_code} (para surtir ${r.warehouse_code})`.trim(),
      lines: purchase.map(({ l, qty }) => { const hr = st.hub![l.product_id]; return this.reqLine(hr ?? l, qty, 'supplier', r.supplier_id, null); }),
    }));
    this.detail.update((d) => ({ ...d, [key]: { ...d[key], creating: true } }));
    forkJoin(jobs).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => {
        this.detail.update((d) => ({ ...d, [key]: { ...d[key], creating: false } }));
        const folios = res.map((x) => x.folio).join(' + ');
        this.toast.add({ severity: 'success', summary: 'Traspaso + compra', detail: `${folios} · ${transfer.length} traspaso / ${purchase.length} compra` });
      },
      error: (e) => {
        this.detail.update((d) => ({ ...d, [key]: { ...d[key], creating: false } }));
        this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo crear el split.' });
      },
    });
  }

  private reqLine(l: CriticalStockRow, finalPz: number, sourceType: 'supplier' | 'branch', supplierId: string | null, sourceWh: string | null) {
    return {
      product_id: l.product_id,
      supplier_id: supplierId,
      source_type: sourceType,
      source_warehouse_id: sourceWh,
      on_hand: Number(l.on_hand), in_transit: Number(l.in_transit),
      min_stock: Number(l.min_stock), reorder_point: Number(l.reorder_point), max_stock: Number(l.max_stock),
      suggested_qty: Number(finalPz), final_qty: Number(finalPz), unit_cost: Number(l.unit_cost || 0),
    };
  }

  // A1 — pedido general: genera la requisición/traspaso de cada renglón seleccionado (cadencia, redondeo a caja)
  selTotal(): number { return this.selectedRows().reduce((s, r) => s + (Number(r.suggested_cost) || 0), 0); }
  bulkGenerate(): void {
    const rows = this.selectedRows();
    if (!rows.length) return;
    this.bulkGenerating.set(true);
    const jobs = rows.map((r) =>
      this.api.criticalStock({ supplier_id: r.supplier_id, warehouse_id: r.warehouse_id, target_basis: 'cadence', scope: 'all', pageSize: 500 }).pipe(
        switchMap((res) => {
          const picked = res.rows.filter((x) => Number(x.suggested_qty) > 0);
          const isTransfer = r.via === 'transfer';
          if (!picked.length) return of({ ok: false, wh: r.warehouse_code });
          if (isTransfer && !r.source_warehouse_id) return of({ ok: false, wh: r.warehouse_code });
          const dto: CreateRequisitionDto = {
            warehouse_id: r.warehouse_id, supplier_id: isTransfer ? null : r.supplier_id,
            source_type: isTransfer ? 'branch' : 'supplier', source_warehouse_id: isTransfer ? r.source_warehouse_id : null,
            notes: `Pedido general ${r.supplier_name || ''} @ ${r.warehouse_code}`.trim(),
            lines: picked.map((l) => { const uxc = this.uxc(l); const pz = Math.ceil((Number(l.suggested_qty) || 0) / uxc) * uxc; return this.reqLine(l, pz, isTransfer ? 'branch' : 'supplier', isTransfer ? null : (l.supplier_id ?? r.supplier_id), isTransfer ? r.source_warehouse_id : null); }),
          };
          return this.api.createRequisition(dto).pipe(map((req) => ({ ok: true, wh: r.warehouse_code, folio: req.folio })), catchError(() => of({ ok: false, wh: r.warehouse_code })));
        }),
        catchError(() => of({ ok: false, wh: r.warehouse_code })),
      ),
    );
    forkJoin(jobs).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (results) => {
        this.bulkGenerating.set(false);
        const ok = results.filter((x: any) => x.ok);
        const skip = results.filter((x: any) => !x.ok);
        this.toast.add({ severity: ok.length ? 'success' : 'warn', summary: `${ok.length} pedido(s) creado(s)`, detail: skip.length ? `${skip.length} sin líneas/omitidos: ${skip.map((s: any) => s.wh).join(', ')}` : 'Todos OK' });
        this.selectedRows.set([]);
        this.reload();
      },
      error: () => { this.bulkGenerating.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'Falló la generación masiva.' }); },
    });
  }

  // A2 — pedido consolidado por proveedor (todos sus almacenes de compra)
  openConsolidated(supplierId: string, name: string | null): void {
    this.consSupplier.set({ id: supplierId, name });
    this.consExcluded.set(new Set());
    this.consOrder.set(null);
    this.consLoading.set(true);
    this.consVisible.set(true);
    this.api.supplierOrder(supplierId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (o) => { this.consOrder.set(o); this.consLoading.set(false); },
      error: () => { this.consLoading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar el pedido consolidado.' }); },
    });
  }
  consHeader(): string { return `Pedido consolidado · ${this.consSupplier()?.name || ''}`; }
  consWhs(): { id: string; code: string; n: number }[] {
    const o = this.consOrder(); if (!o) return [];
    const m = new Map<string, { id: string; code: string; n: number }>();
    for (const l of o.lines) { const e = m.get(l.warehouse_id) || { id: l.warehouse_id, code: l.warehouse_code, n: 0 }; e.n++; m.set(l.warehouse_id, e); }
    return [...m.values()].sort((a, b) => a.code.localeCompare(b.code));
  }
  isWhIncluded(id: string): boolean { return !this.consExcluded().has(id); }
  toggleWh(id: string): void { this.consExcluded.update((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
  consLinesFiltered(): SupplierOrderLine[] { const o = this.consOrder(); if (!o) return []; const ex = this.consExcluded(); return o.lines.filter((l) => !ex.has(l.warehouse_id)); }
  consWhsIncluded(): number { return new Set(this.consLinesFiltered().map((l) => l.warehouse_id)).size; }
  consTotCajas(): number { return this.consLinesFiltered().reduce((s, l) => s + Number(l.cajas || 0), 0); }
  consTotAmount(): number { return this.consLinesFiltered().reduce((s, l) => s + Number(l.line_cost || 0), 0); }
  generateConsolidated(): void {
    const sup = this.consSupplier(); const lines = this.consLinesFiltered();
    if (!sup || !lines.length) return;
    const byWh = new Map<string, SupplierOrderLine[]>();
    for (const l of lines) { if (!byWh.has(l.warehouse_id)) byWh.set(l.warehouse_id, []); byWh.get(l.warehouse_id)!.push(l); }
    this.consGenerating.set(true);
    const jobs = [...byWh.entries()].map(([whId, ls]) => this.api.createRequisition({
      warehouse_id: whId, supplier_id: sup.id, source_type: 'supplier', source_warehouse_id: null,
      notes: `Pedido consolidado ${sup.name || ''} @ ${ls[0].warehouse_code}`.trim(),
      lines: ls.map((l) => ({ product_id: l.product_id, supplier_id: sup.id, source_type: 'supplier' as const, source_warehouse_id: null, on_hand: Number(l.on_hand), in_transit: 0, min_stock: 0, reorder_point: 0, max_stock: 0, suggested_qty: Number(l.final), final_qty: Number(l.final), unit_cost: Number(l.unit_cost) })),
    }).pipe(map((req) => req.folio as string | null), catchError(() => of(null))));
    forkJoin(jobs).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (folios) => {
        this.consGenerating.set(false);
        const ok = folios.filter(Boolean);
        this.toast.add({ severity: ok.length ? 'success' : 'warn', summary: `${ok.length} requisición(es)`, detail: ok.join(' + ') || 'Nada creado' });
        this.consVisible.set(false); this.reload();
      },
      error: () => { this.consGenerating.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'Falló la generación.' }); },
    });
  }

  exportRow(r: WLRow): void {
    const st = this.detail()[r._key];
    const picked = (st?.lines ?? []).filter((l) => Number(l.finalCajas) > 0);
    if (!picked.length) return;
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['SKU', 'Producto', 'Rank', '$ mueve', 'Existencia', 'Sugerido (pz)', 'Pedir (cajas)', 'Piezas', '$ unitario', '$ linea'];
    const body = picked.map((l) => [l.sku, l.nombre, l.sales_rank ?? '', Math.round(Number(l.monthly_revenue) || 0), Math.round(Number(l.on_hand)), Math.round(Number(l.suggested_qty)), l.finalCajas, this.pzOf(l), Number(l.unit_cost || 0).toFixed(2), this.lineCost(l).toFixed(2)]);
    const foot = ['', 'TOTAL', '', '', '', '', this.totalCajas(r._key), this.totalPz(r._key), '', this.detailTotal(r._key).toFixed(2)];
    const csv = [head, ...body, foot].map((row) => row.map(esc).join(',')).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `pedido_${(r.supplier_name || 'prov').replace(/[^a-z0-9]+/gi, '_').slice(0, 30)}_${r.warehouse_code}_${stamp}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  isTerr(codes: string[]): boolean {
    const ids = this.idsForCodes(codes);
    return ids.length > 0 && ids.length === this.fWh.length && ids.every((i) => this.fWh.includes(i));
  }
  applyTerr(codes: string[]): void {
    const ids = this.idsForCodes(codes);
    this.fWh = this.isTerr(codes) ? [] : ids;
    this.reload();
  }
  clearWh(): void { this.fWh = []; this.reload(); }
  private idsForCodes(codes: string[]): string[] {
    return this.warehouses().filter((w) => codes.includes(w.code)).map((w) => w.id);
  }

  estLabel(r: WLRow): string {
    const d = r.days_to_due ?? 99;
    return d < 0 ? 'Vencido' : d === 0 ? 'Hoy' : d <= 7 ? 'Próximo' : 'Futuro';
  }
  estSev(r: WLRow): Sev {
    const d = r.days_to_due ?? 99;
    return d < 0 ? 'danger' : d === 0 ? 'warn' : d <= 7 ? 'info' : 'secondary';
  }
  ddLabel(d: number | null): string {
    if (d == null) return '';
    if (d < 0) return `${Math.abs(d)}d tarde`;
    if (d === 0) return 'hoy';
    return `en ${d}d`;
  }
  basisLabel(b: OrderBasis): string { return ({ cadence: 'Cadencia', reorder: 'Reorden', max: 'Máximo', min: 'Mínimo' } as Record<string, string>)[b] || b; }
  bandLabel(b: string): string { return ({ rapida: 'rápida', promedio: 'promedio', mal_abasto: 'lento' } as Record<string, string>)[b] || b; }
  bandSev(b: string): Sev { return ({ rapida: 'success', promedio: 'info', mal_abasto: 'danger' } as Record<string, Sev>)[b] || 'secondary'; }
  money(v: number | string | null | undefined) { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
}
