import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { forkJoin, Subject } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';
import { ButtonModule } from 'primeng/button';
import { TableModule, TableLazyLoadEvent } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { DialogModule } from 'primeng/dialog';
import { TagModule } from 'primeng/tag';
import { InputTextModule } from 'primeng/inputtext';
import { CheckboxModule, CheckboxChangeEvent } from 'primeng/checkbox';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { MessageService } from 'primeng/api';
import { ComprasService, CriticalStockRow, ReplenishmentSummary, Bucket, TargetBasis, SourceType, CreateRequisitionDto, DeadStockRow } from '../compras.service';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';

type Sev = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';

/** Línea del borrador de requisición: sugerido + origen (proveedor/sucursal) + datos para el aviso de mínimo. */
interface DraftLine {
  product_id: string;
  warehouse_id: string;
  warehouse_code: string;
  sku: string;
  nombre: string;
  supplier_id: string | null;
  supplier_name: string | null;
  supplier_min_boxes: number | null;
  factor_purchase: number | null;
  source_type: SourceType;
  source_warehouse_id: string | null;
  on_hand: number;
  in_transit: number;
  min_stock: number;
  reorder_point: number;
  max_stock: number;
  suggested_qty: number;
  final_qty: number;
  unit_cost: number;
}

/**
 * Fase RA (ADR-030) — Existencia Crítica. Existencia vs mín/reorden/máx + sugerido de
 * compra; selección → requisición (HITL). Superficie Operations (PrimeNG denso).
 * RA.11 origen proveedor/sucursal · RA.12 multi-sucursal · RA.13a aviso de mínimo en cajas.
 */
@Component({
  selector: 'app-compras-existencia-critica',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, ButtonModule, TableModule, ToastModule, SelectModule, MultiSelectModule, DialogModule, TagModule, InputTextModule, CheckboxModule, IconFieldModule, InputIconModule, MetricStripComponent, FreshnessPillComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in ec-page">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Existencia crítica</h1>
          <p class="surf-page-sub">Existencia contra punto de reorden por almacén. El motor sugiere cuánto pedir; tú generas la requisición.</p>
        </div>
        <div class="ec-head-actions">
          @if (loadedAt()) { <app-freshness-pill [since]="loadedAt()" /> }
          <a pButton routerLink="/compras/pedido" label="Pedido" icon="pi pi-cart-plus" class="p-button-sm p-button-text" title="Armar el pedido por proveedor y ciclo de reabasto"></a>
          <button pButton type="button" label="Excel" icon="pi pi-file-excel" class="p-button-sm p-button-outlined p-button-secondary"
                  [loading]="dl()" [disabled]="dl() || total() === 0" (click)="downloadXlsx()"></button>
          <button pButton type="button" [label]="'Generar requisición' + (selCount() ? ' (' + selCount() + ')' : '')" icon="pi pi-file-edit"
                  class="p-button-sm" [disabled]="!canRequire()" (click)="openDialog()"></button>
        </div>
      </header>

      <!-- KPIs -->
      @if (summary(); as s) {
        <app-metric-strip [items]="kpiItems(s)" ariaLabel="Resumen de existencia crítica" />
      }

      <!-- Filtros -->
      <div class="ec-filters">
        <p-multiSelect [options]="warehouseOpts()" [(ngModel)]="fWarehouses" (onChange)="reload()"
                       optionLabel="label" optionValue="value" placeholder="Todos los almacenes" [showClear]="true"
                       [filter]="true" filterBy="label" filterPlaceholder="Buscar almacén…"
                       [maxSelectedLabels]="2" selectedItemsLabel="{0} almacenes" styleClass="ec-sel"></p-multiSelect>
        <p-select [options]="bucketOpts" [(ngModel)]="fBucket" (onChange)="reload()"
                  optionLabel="label" optionValue="value" placeholder="Críticos (≤ reorden)" [showClear]="true" styleClass="ec-sel"></p-select>
        <p-select [options]="basisOpts" [(ngModel)]="fBasis" (onChange)="reload()"
                  optionLabel="label" optionValue="value" placeholder="Objetivo" styleClass="ec-sel"></p-select>
        <p-select [options]="supplierOpts()" [(ngModel)]="fSupplier" (onChange)="reload()"
                  optionLabel="label" optionValue="value" placeholder="Todos los proveedores" [showClear]="true"
                  [filter]="true" filterBy="label" filterPlaceholder="Buscar proveedor…" [resetFilterOnHide]="true"
                  [virtualScroll]="true" [virtualScrollItemSize]="34" styleClass="ec-sel-wide"></p-select>
        <p-select [options]="abcOpts" [(ngModel)]="fAbc" (onChange)="reload()"
                  optionLabel="label" optionValue="value" placeholder="ABC" [showClear]="true" styleClass="ec-sel-sm"></p-select>
        <p-select [options]="xyzOpts" [(ngModel)]="fXyz" (onChange)="reload()"
                  optionLabel="label" optionValue="value" placeholder="XYZ" [showClear]="true" styleClass="ec-sel-sm"></p-select>
        <p-iconfield styleClass="ec-search">
          <p-inputicon styleClass="pi pi-search" />
          <input pInputText type="text" [(ngModel)]="fSearch" (ngModelChange)="onSearchChange($event)" (keyup.enter)="reload()"
                 placeholder="SKU o nombre…" aria-label="Buscar por SKU o nombre" />
          @if (fSearch) { <p-inputicon styleClass="pi pi-times ec-search-clear" (click)="clearSearch()" role="button" ariaLabel="Limpiar búsqueda" /> }
        </p-iconfield>
      </div>

      <!-- Tabla -->
      <p-table [value]="rows()" [loading]="loading()" [scrollable]="true" scrollHeight="flex"
               [paginator]="true" [rows]="pageSize" [totalRecords]="total()" [lazy]="true" (onLazyLoad)="onPage($event)"
               styleClass="p-datatable-sm ec-table" [rowsPerPageOptions]="[50, 100, 200]">
        <ng-template pTemplate="header">
          <tr>
            <th pFrozenColumn style="width:2.5rem"><p-checkbox [binary]="true" [ngModel]="allSelected()" (onChange)="toggleAll($event)" ariaLabel="Seleccionar todo" /></th>
            <th pFrozenColumn style="min-width:7rem" pSortableColumn="sku">SKU <p-sortIcon field="sku" /></th>
            <th pSortableColumn="nombre">Producto <p-sortIcon field="nombre" /></th>
            <th pSortableColumn="warehouse_code">Almacén <p-sortIcon field="warehouse_code" /></th>
            <th pSortableColumn="abc_class">Clase <p-sortIcon field="abc_class" /></th>
            <th class="ec-r" pSortableColumn="sales_rank" title="Ranking por venta EN DINERO (venta/mes) del proveedor en la sucursal — #1 = el que más te vende en $ = más importante pedir. Coincide con ordenar por Venta/mes.">Rank vta <p-sortIcon field="sales_rank" /></th>
            <th class="ec-r" pSortableColumn="monthly_revenue" title="Venta mensual estimada ($) = demanda diaria × 30 × precio de venta. El peso en dinero del producto: cuánto representa en venta.">Venta/mes <p-sortIcon field="monthly_revenue" /></th>
            <th class="ec-r" pSortableColumn="on_hand">Existencia <p-sortIcon field="on_hand" /></th>
            <th class="ec-r" pSortableColumn="min_stock">Mín <p-sortIcon field="min_stock" /></th>
            <th class="ec-r" pSortableColumn="reorder_point">Reorden <p-sortIcon field="reorder_point" /></th>
            <th class="ec-r" pSortableColumn="max_stock">Máx <p-sortIcon field="max_stock" /></th>
            <th class="ec-r" pSortableColumn="safety_stock">Colchón <p-sortIcon field="safety_stock" /></th>
            <th class="ec-r" pSortableColumn="in_transit">OC a recibir <p-sortIcon field="in_transit" /></th>
            <th class="ec-r" pSortableColumn="suggested_qty">Sugerido <p-sortIcon field="suggested_qty" /></th>
            <th>Estado</th>
            <th pSortableColumn="supplier_name">Proveedor <p-sortIcon field="supplier_name" /></th>
            <th class="ec-r" pSortableColumn="suggested_cost">Costo est. <p-sortIcon field="suggested_cost" /></th>
            <th>Origen</th>
            <th title="Cómo se surte (compra/traspaso) y cada cuánto — deriva del histórico">Ciclo</th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-r>
          <tr [class.ec-sel-row]="isSelected(r)">
            <td pFrozenColumn><p-checkbox [binary]="true" [ngModel]="isSelected(r)" (onChange)="toggle(r)" [ariaLabel]="'Seleccionar ' + r.sku" /></td>
            <td pFrozenColumn class="ec-mono">{{ r.sku }}</td>
            <td>{{ r.nombre }}</td>
            <td class="ec-muted">{{ r.warehouse_code }}</td>
            <td class="ec-class">
              @if (r.abc_class) { <span class="ec-cls ec-abc-{{ r.abc_class }}">{{ r.abc_class }}</span> }
              @if (r.xyz_class) { <span class="ec-cls ec-xyz-{{ r.xyz_class }}" [title]="xyzTitle(r)">{{ r.xyz_class }}</span> }
              @if (!r.abc_class && !r.xyz_class) { <span class="ec-muted">—</span> }
            </td>
            <td class="ec-r">
              @if (r.sales_rank != null) { <span [class.ec-rank-top]="r.sales_rank <= 20">#{{ r.sales_rank }}</span> }
              @else { <span class="ec-muted">—</span> }
            </td>
            <td class="ec-r">
              @if (revNum(r.monthly_revenue) > 0) { {{ money(r.monthly_revenue) }} }
              @else { <span class="ec-muted">—</span> }
            </td>
            <td class="ec-r">{{ r.on_hand | number:'1.0-0' }}</td>
            <td class="ec-r ec-muted">{{ r.min_stock | number:'1.0-0' }}</td>
            <td class="ec-r ec-muted">{{ r.reorder_point | number:'1.0-0' }}</td>
            <td class="ec-r ec-muted">{{ r.max_stock | number:'1.0-0' }}</td>
            <td class="ec-r" [title]="safetyTitle(r)">{{ r.safety_stock != null ? (r.safety_stock | number:'1.0-0') : '—' }}@if (r.service_level) {<span class="ec-svc">{{ (r.service_level * 100) | number:'1.0-0' }}%</span>}</td>
            <td class="ec-r" [class.ec-transit]="r.in_transit > 0">{{ r.in_transit > 0 ? (r.in_transit | number:'1.0-0') : '—' }}</td>
            <td class="ec-r ec-strong">{{ r.suggested_qty | number:'1.0-0' }}</td>
            <td><p-tag [value]="bucketLabel(r.bucket)" [severity]="bucketSev(r.bucket)"></p-tag></td>
            <td class="ec-muted">{{ r.supplier_name || '—' }}</td>
            <td class="ec-r">{{ money(r.suggested_cost) }}</td>
            <td><span class="ec-src ec-src-{{ r.source }}">{{ sourceLabel(r.source) }}</span></td>
            <td class="ec-muted ec-cycle">
              @if (r.cadence_days != null) {
                <i [class]="r.replenish_via === 'transfer' ? 'pi pi-arrow-right-arrow-left' : 'pi pi-shopping-cart'"
                   [title]="r.replenish_via === 'transfer' ? ('Traspaso ← ' + (r.source_warehouse_code || '?')) : 'Compra directa'"></i>
                {{ r.cadence_days | number:'1.0-0' }}d
                @if (r.next_due_date) { <span class="ec-cyc-due">· {{ r.next_due_date | date:'dd/MM' }}</span> }
              } @else { — }
            </td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="18" class="ec-empty">Sin productos que reponer con estos filtros.</td></tr>
        </ng-template>
      </p-table>
    </div>

    <!-- Stock muerto: existencia sin política (no rota) = capital inmovilizado. Colapsable. -->
    <section class="ec-dead">
      <button type="button" class="ec-dead-head" (click)="toggleDead()" [attr.aria-expanded]="deadOpen()">
        <i class="pi" [class.pi-chevron-right]="!deadOpen()" [class.pi-chevron-down]="deadOpen()" aria-hidden="true"></i>
        <span class="ec-dead-title">Stock muerto</span>
        @if (deadTotal()) { <span class="ec-dead-count">{{ deadTotal() | number }}</span> }
        @if (deadValue()) { <span class="ec-dead-val">{{ money(deadValue()) }} inmovilizado</span> }
        <i class="pi pi-info-circle ec-dead-about" (click)="openAbout($event)" title="¿Qué es el stock muerto?" aria-label="Qué es el stock muerto"></i>
      </button>

      @if (deadOpen()) {
        <p class="ec-dead-sub">TODO producto activo SIN rotación (sin política de reorden), por eso no aparece arriba. <b>Con existencia</b> = capital inmovilizado (liquidar/promover); <b>Sin existencia</b> = descontinuado o nunca surtido aquí. "Desde cuándo" = última venta/movimiento en el almacén; si nunca tuvo → alta en catálogo.</p>
        <p-table [value]="deadRows()" [loading]="deadLoading()" [scrollable]="true"
                 [paginator]="true" [rows]="pageSize" [totalRecords]="deadTotal()" [lazy]="true" (onLazyLoad)="onDeadPage($event)"
                 styleClass="p-datatable-sm ec-table" [rowsPerPageOptions]="[50, 100, 200]">
          <ng-template pTemplate="header">
            <tr>
              <th>SKU</th>
              <th>Producto</th>
              <th>Almacén</th>
              <th class="ec-r">Existencia</th>
              <th>Estado</th>
              <th>Desde cuándo</th>
              <th class="ec-r">Costo unit.</th>
              <th class="ec-r">Capital inmovilizado</th>
              <th>Proveedor</th>
            </tr>
          </ng-template>
          <ng-template pTemplate="body" let-r>
            <tr>
              <td class="ec-mono">{{ r.sku }}</td>
              <td>{{ r.nombre }}</td>
              <td class="ec-muted">{{ r.warehouse_code }}</td>
              <td class="ec-r">{{ r.on_hand | number:'1.0-0' }}</td>
              <td>
                @if (r.on_hand > 0) { <span class="ec-dead-cap">Con existencia</span> }
                @else { <span class="ec-muted">Sin existencia</span> }
              </td>
              <td class="ec-muted ec-dead-since">{{ deadSince(r) }}</td>
              <td class="ec-r ec-muted">{{ money(r.unit_cost) }}</td>
              <td class="ec-r ec-strong">{{ money(r.dead_value) }}</td>
              <td class="ec-muted">{{ r.supplier_name || '—' }}</td>
            </tr>
          </ng-template>
          <ng-template pTemplate="emptymessage">
            <tr><td colspan="9" class="ec-empty">Sin productos sin rotación con estos filtros. 🎉</td></tr>
          </ng-template>
        </p-table>
      }
    </section>

    <!-- About: qué es el stock muerto -->
    <p-dialog [visible]="aboutOpen()" (visibleChange)="aboutOpen.set($event)" [modal]="true" appendTo="body"
              [style]="{ width: '34rem', maxWidth: '94vw' }" header="Stock muerto" [dismissableMask]="true">
      <div class="ec-about">
        <p><strong>Stock muerto</strong> = productos con existencia física pero <strong>sin rotación</strong> (0 ventas en la sucursal en la ventana de análisis).</p>
        <p>Como no venden, el motor no les calcula una <em>política de reorden</em> (mínimo/reorden/máximo), y por eso <strong>no aparecen en Existencia Crítica</strong> arriba — que solo lista lo que hay que reabastecer.</p>
        <p>Es <strong>capital inmovilizado</strong>: inventario parado que ocupa espacio y dinero. La acción no es pedir más, sino <strong>liquidar, promocionar o trasladar</strong> a una sucursal donde sí rote.</p>
        <p class="ec-about-note">Para ver TODO el inventario (rote o no), usa el reporte de <strong>Salidas</strong> (/comercial/salidas), que lista el catálogo completo por sucursal.</p>
      </div>
    </p-dialog>

    <!-- Dialog: generar requisición. appendTo=body: la página vive en un contenedor
         con overflow/transform → sin esto el modal se renderiza pero queda clipeado
         detrás (el clic "no hace nada" a la vista). -->
    <p-dialog [visible]="dialogOpen()" (visibleChange)="dialogOpen.set($event)" [modal]="true" appendTo="body" [style]="{ width: '52rem', maxWidth: '96vw' }" header="Generar requisición" [dismissableMask]="true">
      <div class="ec-dlg">
        <p class="ec-dlg-sub">{{ draft().length }} producto(s) · {{ draftWarehouses().length }} almacén(es) · objetivo <strong>{{ basisLabel(fBasis) }}</strong>
          @if (draftReqCount() > 1) { <span class="ec-dlg-note">— se crearán {{ draftReqCount() }} requisiciones (compra: una por proveedor · traspaso: una por sucursal origen)</span> }
        </p>

        <!-- Aviso de compra mínima (RA.13a): proveedores que no alcanzan su mínimo en cajas -->
        @for (w of minBoxesWarn(); track w.supplier_id) {
          <div class="ec-warn"><i class="pi pi-exclamation-triangle"></i>
            <strong>{{ w.supplier_name }}</strong>: {{ w.have | number:'1.0-1' }} de {{ w.need | number:'1.0-1' }} cajas mínimas. Faltan {{ (w.need - w.have) | number:'1.0-1' }}.
          </div>
        }

        <div class="ec-dlg-lines">
          @for (l of draft(); track l.product_id + '|' + l.warehouse_id) {
            <div class="ec-dlg-line">
              <span class="ec-dlg-name"><span class="ec-mono">{{ l.sku }}</span> {{ l.nombre }} <span class="ec-muted">· {{ l.warehouse_code }}</span></span>
              <p-select [options]="originOpts" [(ngModel)]="l.source_type" optionLabel="label" optionValue="value" styleClass="ec-dlg-origin" appendTo="body"></p-select>
              @if (l.source_type === 'branch') {
                <p-select [options]="warehouseOpts()" [(ngModel)]="l.source_warehouse_id" optionLabel="label" optionValue="value"
                          placeholder="Almacén origen" [filter]="true" filterBy="label" filterPlaceholder="Buscar…"
                          styleClass="ec-dlg-srcwh" appendTo="body"></p-select>
              }
              <input pInputText type="number" min="0" [(ngModel)]="l.final_qty" class="ec-dlg-qty" />
            </div>
          }
        </div>
        <input pInputText type="text" [(ngModel)]="notes" placeholder="Nota (opcional)" class="ec-dlg-notes" />
      </div>
      <ng-template pTemplate="footer">
        <button pButton type="button" label="Cancelar" class="p-button-text p-button-sm" [disabled]="saving()" (click)="dialogOpen.set(false)"></button>
        <button pButton type="button" label="Crear requisición" icon="pi pi-check" class="p-button-sm" [loading]="saving()" [disabled]="saving()" (click)="create()"></button>
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    :host { display: block; }
    .ec-head-actions { display: flex; gap: .5rem; align-items: center; }
    app-metric-strip { display:block; margin-bottom: 1rem; }
    .ec-filters { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin-bottom: .75rem; }
    .ec-sel { min-width: 12rem; } .ec-sel-wide { min-width: 15rem; } .ec-sel-sm { min-width: 6.5rem; }
    /* Search: p-iconfield pone el ícono de lupa a la izquierda; el clear (inputicon) a la derecha. */
    :host ::ng-deep .ec-search input { min-width: 14rem; }
    /* p-inputicon trae pointer-events:none por default; el clear necesita ser clickeable. */
    :host ::ng-deep .ec-search-clear { pointer-events: auto; cursor: pointer; font-size: .72rem; color: var(--text-muted); }
    :host ::ng-deep .ec-search-clear:hover { color: var(--text-main); }
    .ec-class { white-space: nowrap; }
    .ec-cls { display: inline-block; min-width: 1.1rem; text-align: center; font-size: .68rem; font-weight: 700; font-family: var(--font-mono, ui-monospace, monospace); padding: 0 .2rem; color: var(--text-muted); }
    .ec-abc-A { color: var(--text-main); } /* alto valor: un poco más de peso */
    .ec-xyz-Z { color: var(--action); }       /* errático: difícil de pronosticar (señal) */
    .ec-svc { display: block; font-size: .62rem; color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .ec-table { font-size: .82rem; }
    .ec-r { text-align: right; font-variant-numeric: tabular-nums; }
    .ec-mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .78rem; }
    .ec-muted { color: var(--text-muted); }
    .ec-strong { font-weight: 700; }
    .ec-rank-top { font-weight: 700; } /* top-20 vendedor de la sucursal: resalta por peso (quiet-luxury, sin color) */
    .ec-sel-row { background: var(--surface-hover-bg); }
    .ec-src { font-size: .68rem; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted); }
    .ec-src-kepler { color: var(--action); }
    .ec-transit { font-weight: 600; }
    .ec-empty { color: var(--text-muted); padding: 1rem; text-align: center; }
    /* Stock muerto */
    .ec-dead { margin-top: 1.25rem; border-top: 1px solid var(--border-color); padding-top: .75rem; }
    .ec-dead-head { display: flex; align-items: center; gap: .5rem; width: 100%; background: none; border: 0; cursor: pointer; padding: .3rem 0; color: var(--text-main); font: inherit; }
    .ec-dead-head .pi-chevron-right, .ec-dead-head .pi-chevron-down { color: var(--text-muted); font-size: .8rem; }
    .ec-dead-title { font-weight: 700; }
    .ec-dead-count { font-variant-numeric: tabular-nums; font-size: .78rem; color: var(--text-muted); background: var(--surface-hover-bg); border-radius: var(--r-sm); padding: .05rem .4rem; }
    .ec-dead-val { font-variant-numeric: tabular-nums; font-size: .78rem; color: var(--text-muted); }
    .ec-dead-about { margin-left: .25rem; color: var(--text-muted); cursor: pointer; font-size: .85rem; }
    .ec-dead-about:hover { color: var(--action); }
    .ec-dead-sub { color: var(--text-muted); font-size: .8rem; margin: .35rem 0 .6rem; }
    .ec-dead-cap { font-size: .7rem; padding: .08rem .4rem; border: 1px solid var(--border-color); border-radius: var(--r-sm); white-space: nowrap; }
    .ec-dead-since { white-space: nowrap; font-size: .74rem; }
    .ec-about p { font-size: .88rem; line-height: 1.5; margin: 0 0 .7rem; }
    .ec-about-note { color: var(--text-muted); font-size: .82rem; border-top: 1px solid var(--border-color); padding-top: .6rem; }
    .ec-dlg-sub { color: var(--text-muted); font-size: .85rem; margin-bottom: .5rem; }
    .ec-dlg-note { color: var(--action); }
    .ec-warn { display: flex; gap: .45rem; align-items: center; font-size: .8rem; color: var(--warn-soft-fg); background: var(--warn-soft-bg); border: 1px solid var(--warn-border); border-radius: var(--r-sm); padding: .45rem .6rem; margin-bottom: .4rem; }
    .ec-dlg-lines { max-height: 24rem; overflow-y: auto; display: flex; flex-direction: column; gap: .35rem; }
    .ec-dlg-line { display: flex; gap: .5rem; align-items: center; }
    .ec-dlg-name { font-size: .82rem; flex: 1; min-width: 0; }
    .ec-dlg-origin { min-width: 8rem; } .ec-dlg-srcwh { min-width: 10rem; }
    .ec-dlg-qty { width: 5.5rem; text-align: right; }
    .ec-dlg-notes { width: 100%; margin-top: .6rem; }
  `],
})
export class ComprasExistenciaCriticaComponent implements OnInit {
  private readonly api = inject(ComprasService);
  private readonly toast = inject(MessageService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly pageSize = 50;
  rows = signal<CriticalStockRow[]>([]);
  total = signal(0);
  summary = signal<ReplenishmentSummary | null>(null);

  kpiItems(s: ReplenishmentSummary): MetricStripItem[] {
    return [
      { label: 'Agotado', value: s.agotado, tone: s.agotado > 0 ? 'bad' : 'default' },
      { label: 'Bajo mínimo', value: s.bajo_minimo, tone: s.bajo_minimo > 0 ? 'bad' : 'default' },
      { label: 'Bajo reorden', value: s.bajo_reorden, tone: s.bajo_reorden > 0 ? 'warn' : 'default' },
      { label: 'Sobrestock', value: s.sobrestock },
      { label: 'Con política', value: s.total_policies },
      { label: 'Sugerido a comprar', value: s.sugerido_costo || 0, format: 'currency', tone: 'brand' },
    ];
  }
  loading = signal(false);
  dl = signal(false);
  saving = signal(false);
  page = signal(1);
  readonly loadedAt = signal<number | null>(null); // §14 frescura

  // Stock muerto (existencia sin política de reorden = capital inmovilizado sin rotación).
  deadRows = signal<DeadStockRow[]>([]);
  deadTotal = signal(0);
  deadValue = signal(0);
  deadLoading = signal(false);
  deadOpen = signal(false);
  deadPage = signal(1);
  aboutOpen = signal(false);

  warehouseOpts = signal<{ label: string; value: string }[]>([]);
  supplierOpts = signal<{ label: string; value: string }[]>([]);
  private warehouseNames = new Map<string, string>();

  fWarehouses: string[] = [];
  fBucket = '';
  fBasis: TargetBasis = 'max';
  fSupplier = '';
  fAbc = '';
  fXyz = '';
  fSearch = '';
  /** Orden por columna (server-side). null = orden por defecto (prioridad por valor). */
  fSortBy: string | null = null;
  fSortDir: 'asc' | 'desc' = 'desc';

  /** Búsqueda en vivo: cada tecla empuja al Subject; debounce evita una consulta por letra. */
  private readonly search$ = new Subject<string>();

  abcOpts = [
    { label: 'A (alto valor)', value: 'A' },
    { label: 'B (medio)', value: 'B' },
    { label: 'C (cola larga)', value: 'C' },
  ];
  xyzOpts = [
    { label: 'X estable', value: 'X' },
    { label: 'Y variable', value: 'Y' },
    { label: 'Z errático', value: 'Z' },
  ];

  bucketOpts = [
    { label: 'Agotado', value: 'agotado' },
    { label: 'Bajo mínimo', value: 'bajo_minimo' },
    { label: 'Bajo reorden', value: 'bajo_reorden' },
    { label: 'Sobrestock', value: 'sobrestock' },
    { label: 'Todos', value: '__all' },
  ];
  basisOpts = [
    { label: 'Ciclo (cadencia)', value: 'cadence' }, // RA-PRO.9 — objetivo por horizonte de ciclo (casa con Qué Toca)
    { label: 'Hasta el máximo', value: 'max' },
    { label: 'Hasta reorden', value: 'reorder' },
    { label: 'Hasta el mínimo', value: 'min' },
  ];
  originOpts = [
    { label: 'Proveedor', value: 'supplier' as SourceType },
    { label: 'Sucursal', value: 'branch' as SourceType },
  ];

  // Selección → requisición. La key incluye el almacén: el MISMO SKU puede aparecer
  // en varias sucursales (multi-select) y colisionaría con sólo product_id.
  // El tamaño vive en un signal porque computed() sólo reacciona a signals.
  private selected = new Map<string, CriticalStockRow>();
  selCount = signal(0);
  dialogOpen = signal(false);
  notes = '';
  draft = signal<DraftLine[]>([]);

  // Leer el signal SIEMPRE primero e incondicional: detrás de un `&&` que corta al
  // init, el computed queda sin dependencias y jamás recalcula (el botón nunca se
  // habilitaría). Ver [[feedback_vendor_ux_best_practices]].
  canRequire = computed(() => this.selCount() > 0);

  ngOnInit(): void {
    this.api.filters().pipe(takeUntilDestroyed(this.destroyRef)).subscribe((f) => {
      this.warehouseOpts.set(f.warehouses.map((w) => ({ label: `${w.code} · ${w.name}`, value: w.id })));
      f.warehouses.forEach((w) => this.warehouseNames.set(w.id, `${w.code} · ${w.name}`));
      this.supplierOpts.set(f.suppliers.map((s) => ({ label: s.name, value: s.id })));
    });
    // Búsqueda en vivo: debounce 300ms + distinct para no reconsultar con el mismo texto.
    this.search$.pipe(debounceTime(300), distinctUntilChanged(), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.reload());
    this.reload();
  }

  onSearchChange(v: string): void { this.search$.next((v ?? '').trim()); }
  clearSearch(): void { this.fSearch = ''; this.reload(); }

  reload(): void {
    this.selected.clear();
    this.selCount.set(0);
    this.page.set(1);
    this.load();
    this.loadSummary();
    this.deadPage.set(1);
    if (this.deadOpen()) this.loadDead();
  }

  toggleDead(): void {
    const open = !this.deadOpen();
    this.deadOpen.set(open);
    if (open) { this.deadPage.set(1); this.loadDead(); }
  }
  openAbout(e: Event): void { e.stopPropagation(); this.aboutOpen.set(true); }
  onDeadPage(e: TableLazyLoadEvent): void {
    const size = e.rows || this.pageSize;
    this.deadPage.set(Math.floor((e.first || 0) / size) + 1);
    this.loadDead();
  }
  private loadDead(): void {
    this.deadLoading.set(true);
    this.api.deadStock({
      warehouse_ids: this.fWarehouses.length ? this.fWarehouses : undefined,
      supplier_id: this.fSupplier || undefined,
      search: this.fSearch || undefined,
      page: this.deadPage(), pageSize: this.pageSize,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.deadRows.set(r.rows); this.deadTotal.set(r.total); this.deadValue.set(r.total_value); this.deadLoading.set(false); },
      error: () => { this.deadLoading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar el stock muerto.' }); },
    });
  }

  private load(): void {
    this.loading.set(true);
    const scope = this.fBucket === '__all' ? 'all' : undefined;
    const bucket = this.fBucket && this.fBucket !== '__all' ? this.fBucket : undefined;
    this.api.criticalStock({
      warehouse_ids: this.fWarehouses.length ? this.fWarehouses : undefined, supplier_id: this.fSupplier || undefined,
      abc: this.fAbc || undefined, xyz: this.fXyz || undefined,
      bucket, scope, target_basis: this.fBasis, search: this.fSearch || undefined,
      sort_by: this.fSortBy || undefined, sort_dir: this.fSortBy ? this.fSortDir : undefined,
      page: this.page(), pageSize: this.pageSize,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.rows.set(r.rows); this.total.set(r.total); this.loading.set(false); this.loadedAt.set(Date.now()); },
      error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar la existencia crítica.' }); },
    });
  }

  /** Export XLSX con diseño: mismos filtros de la vista, todas las filas del filtro. */
  downloadXlsx(): void {
    this.dl.set(true);
    const scope = this.fBucket === '__all' ? 'all' : undefined;
    const bucket = this.fBucket && this.fBucket !== '__all' ? this.fBucket : undefined;
    this.api.criticalStockXlsx({
      warehouse_ids: this.fWarehouses.length ? this.fWarehouses : undefined, supplier_id: this.fSupplier || undefined,
      abc: this.fAbc || undefined, xyz: this.fXyz || undefined,
      bucket, scope, target_basis: this.fBasis, search: this.fSearch || undefined,
      sort_by: this.fSortBy || undefined, sort_dir: this.fSortBy ? this.fSortDir : undefined,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (resp) => {
        this.dl.set(false);
        const blob = resp.body!;
        const cd = resp.headers.get('content-disposition') || '';
        const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
        const plain = /filename="?([^";]+)"?/i.exec(cd);
        const name = star ? decodeURIComponent(star[1]) : (plain ? plain[1] : 'Existencia_Critica.xlsx');
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = name; a.click();
        URL.revokeObjectURL(url);
      },
      error: () => { this.dl.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo generar el Excel.' }); },
    });
  }

  private loadSummary(): void {
    this.api.summary({ warehouse_ids: this.fWarehouses.length ? this.fWarehouses : undefined, supplier_id: this.fSupplier || undefined, target_basis: this.fBasis })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe((s) => this.summary.set(s));
  }

  onPage(e: TableLazyLoadEvent): void {
    const size = e.rows || this.pageSize;
    this.page.set(Math.floor((e.first || 0) / size) + 1);
    // Ordenamiento por columna (server-side): PrimeNG manda sortField + sortOrder (1 asc, -1 desc).
    const field = Array.isArray(e.sortField) ? e.sortField[0] : e.sortField;
    this.fSortBy = field || null;
    this.fSortDir = e.sortOrder === 1 ? 'asc' : 'desc';
    this.load();
  }

  // Selección — key = producto|almacén.
  private key(r: CriticalStockRow) { return `${r.product_id}|${r.warehouse_id}`; }
  isSelected(r: CriticalStockRow) { return this.selected.has(this.key(r)); }
  toggle(r: CriticalStockRow) {
    const k = this.key(r);
    this.selected.has(k) ? this.selected.delete(k) : this.selected.set(k, r);
    this.selCount.set(this.selected.size);
  }
  allSelected() { return this.rows().length > 0 && this.rows().every((r) => this.selected.has(this.key(r))); }
  toggleAll(e: CheckboxChangeEvent) {
    if (e.checked) this.rows().forEach((r) => this.selected.set(this.key(r), r));
    else this.rows().forEach((r) => this.selected.delete(this.key(r)));
    this.selCount.set(this.selected.size);
  }

  openDialog(): void {
    this.draft.set([...this.selected.values()].map((r) => ({
      product_id: r.product_id, warehouse_id: r.warehouse_id, warehouse_code: r.warehouse_code,
      sku: r.sku, nombre: r.nombre,
      supplier_id: r.supplier_id, supplier_name: r.supplier_name,
      supplier_min_boxes: r.supplier_min_boxes, factor_purchase: r.factor_purchase,
      source_type: 'supplier' as SourceType, source_warehouse_id: null,
      on_hand: r.on_hand, in_transit: r.in_transit,
      min_stock: r.min_stock, reorder_point: r.reorder_point, max_stock: r.max_stock,
      suggested_qty: r.suggested_qty, final_qty: Math.round(r.suggested_qty), unit_cost: r.unit_cost || 0,
    })));
    this.notes = '';
    this.dialogOpen.set(true);
  }

  /** Almacenes distintos en el borrador (para el aviso "N requisiciones"). */
  draftWarehouses(): string[] { return [...new Set(this.draft().map((l) => l.warehouse_id))]; }

  /** Clave de agrupación de requisición: compra → (almacén, proveedor);
   * traspaso → (almacén, sucursal origen). Compra y traspaso nunca se mezclan. */
  private reqGroupKey(l: DraftLine): string {
    const branch = l.source_type === 'branch';
    const sub = branch ? (l.source_warehouse_id || 'SIN-ORIGEN') : (l.supplier_id || 'SIN-PROV');
    return `${l.warehouse_id}||${branch ? 'branch' : 'supplier'}||${sub}`;
  }
  /** Cuántas requisiciones se crearán (una por grupo compra/traspaso × origen). */
  draftReqCount(): number {
    return new Set(this.draft().filter((l) => Number(l.final_qty) > 0).map((l) => this.reqGroupKey(l))).size;
  }

  /**
   * RA.13a — proveedores del borrador que NO alcanzan su pedido mínimo en cajas.
   * cajas = Σ (final_qty / factor_purchase) por proveedor, sólo líneas source_type='supplier'.
   * Método (no computed): final_qty se edita por ngModel sobre objeto plano; el CD del
   * diálogo lo recorre en cada cambio.
   */
  minBoxesWarn(): { supplier_id: string; supplier_name: string; need: number; have: number }[] {
    const bySup = new Map<string, { name: string; min: number; boxes: number }>();
    for (const l of this.draft()) {
      if (l.source_type !== 'supplier' || !l.supplier_id || !l.supplier_min_boxes || l.supplier_min_boxes <= 0) continue;
      const factor = Number(l.factor_purchase) > 0 ? Number(l.factor_purchase) : 1;
      const boxes = Number(l.final_qty || 0) / factor;
      const cur = bySup.get(l.supplier_id) || { name: l.supplier_name || '—', min: Number(l.supplier_min_boxes), boxes: 0 };
      cur.boxes += boxes;
      bySup.set(l.supplier_id, cur);
    }
    return [...bySup.entries()]
      .filter(([, v]) => v.boxes < v.min)
      .map(([supplier_id, v]) => ({ supplier_id, supplier_name: v.name, need: v.min, have: v.boxes }));
  }

  create(): void {
    if (this.saving()) return; // §13 idempotencia visual: ignora re-clicks
    const all = this.draft().filter((l) => Number(l.final_qty) > 0);
    if (!all.length) { this.toast.add({ severity: 'warn', summary: 'Sin líneas', detail: 'Ajusta las cantidades (> 0).' }); return; }
    // Validar que las líneas de traspaso tengan almacén origen.
    if (all.some((l) => l.source_type === 'branch' && !l.source_warehouse_id)) {
      this.toast.add({ severity: 'warn', summary: 'Falta almacén origen', detail: 'Elige la sucursal origen de las líneas por traspaso.' }); return;
    }
    // Compra y traspaso NUNCA van juntos, y la compra es UNA requisición por
    // proveedor. Grano = almacén destino × origen: compra → (almacén, proveedor);
    // traspaso → (almacén, sucursal origen).
    const groups = new Map<string, DraftLine[]>();
    for (const l of all) { const k = this.reqGroupKey(l); (groups.get(k) ?? groups.set(k, []).get(k)!).push(l); }

    const dtos: CreateRequisitionDto[] = [...groups.values()].map((lines) => {
      const f = lines[0];
      const isBranch = f.source_type === 'branch';
      return {
        warehouse_id: f.warehouse_id,
        supplier_id: isBranch ? null : (f.supplier_id ?? null),
        source_type: isBranch ? 'branch' : 'supplier',
        source_warehouse_id: isBranch ? f.source_warehouse_id : null,
        target_basis: this.fBasis, notes: this.notes || undefined,
        lines: lines.map((l) => ({
          product_id: l.product_id, supplier_id: l.supplier_id,
          source_type: l.source_type, source_warehouse_id: l.source_type === 'branch' ? l.source_warehouse_id : null,
          on_hand: l.on_hand, in_transit: l.in_transit,
          min_stock: l.min_stock, reorder_point: l.reorder_point, max_stock: l.max_stock,
          suggested_qty: l.suggested_qty, final_qty: Number(l.final_qty), unit_cost: l.unit_cost,
        })),
      };
    });

    this.saving.set(true);
    forkJoin(dtos.map((d) => this.api.createRequisition(d))).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => {
        this.saving.set(false); this.dialogOpen.set(false);
        if (res.length === 1) {
          this.toast.add({ severity: 'success', summary: 'Requisición creada', detail: res[0].folio });
          this.router.navigate(['/compras/requisiciones', res[0].id]);
        } else {
          this.toast.add({ severity: 'success', summary: `${res.length} requisiciones creadas`, detail: res.map((r) => r.folio).join(', ') });
          this.router.navigate(['/compras/requisiciones']);
        }
      },
      error: (e) => { this.saving.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo crear la requisición.' }); },
    });
  }

  // Helpers
  /** Postgres numeric llega como STRING por JSON; sin Number() el toLocaleString de string ignora el formato de moneda. */
  money(v: number | string | null | undefined) { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  /** venta/mes como número (numeric de Postgres llega string) para el guard de "—". */
  revNum(v: number | string | null | undefined) { return Number(v ?? 0) || 0; }
  /** fecha corta es-MX; '—' si inválida/nula. */
  fmtDate(d: string | null | undefined) {
    if (!d) return '—';
    const dt = new Date(d);
    return isNaN(dt.getTime()) ? '—' : dt.toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  /** "Desde cuándo": última venta/movimiento; si nunca tuvo → alta en catálogo. */
  deadSince(r: DeadStockRow) {
    return r.last_activity ? this.fmtDate(r.last_activity) : `sin actividad · alta ${this.fmtDate(r.created_at)}`;
  }
  basisLabel(b: string) { return this.basisOpts.find((o) => o.value === b)?.label || b; }
  bucketLabel(b: Bucket) { return ({ agotado: 'Agotado', bajo_minimo: 'Bajo mínimo', bajo_reorden: 'Bajo reorden', sobrestock: 'Sobrestock', sano: 'Sano' } as Record<Bucket, string>)[b]; }
  bucketSev(b: Bucket): Sev { return ({ agotado: 'danger', bajo_minimo: 'danger', bajo_reorden: 'warn', sobrestock: 'secondary', sano: 'success' } as Record<Bucket, Sev>)[b]; }
  sourceLabel(s: string) { return s === 'kepler' ? 'Kepler' : s === 'computed' ? 'Computado' : 'Manual'; }

  // RA-PRO.2 — tooltips de segmentación y colchón.
  xyzTitle(r: CriticalStockRow) {
    const cv = r.demand_cv != null ? Number(r.demand_cv).toFixed(2) : '—';
    const lbl = r.xyz_class === 'X' ? 'estable' : r.xyz_class === 'Y' ? 'variable' : 'errático';
    return `Demanda ${lbl} · CV=${cv}`;
  }
  safetyTitle(r: CriticalStockRow) {
    if (r.policy_method !== 'service_level') return 'Colchón por días de cobertura (legacy)';
    const svc = r.service_level != null ? (r.service_level * 100).toFixed(0) + '%' : '—';
    const lt = r.lead_time_days ?? '—';
    return `Safety stock por nivel de servicio ${svc} (Z×σ×√lead). Lead ${lt}d.`;
  }
}
