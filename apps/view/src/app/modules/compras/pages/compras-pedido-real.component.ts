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
} from '../compras.service';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';

type Sev = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';
interface Row extends PurchaseSuggestionRow { _pedir: number; _sel: boolean; }

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
          <button role="tab" [attr.aria-selected]="!dead()" class="pr-tab" [class.pr-tab-on]="!dead()" (click)="setDead(false)">Por pedir</button>
          <button role="tab" [attr.aria-selected]="dead()" class="pr-tab" [class.pr-tab-on]="dead()" (click)="setDead(true)">Stock muerto</button>
        </div>
      </header>

      @if (!dead()) {
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
                    optionLabel="label" optionValue="value" placeholder="Todo lo por pedir" [showClear]="true"
                    styleClass="pr-sel-sm" ariaLabel="Filtrar por cobertura"></p-select>
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
                <th style="min-width:10rem">Proveedor</th>
                <th class="pr-r pr-sell" title="Venta de la RED, 30 días (cajas). La demanda que fija el reorden.">Venta 30d</th>
                <th class="pr-r pr-sell" title="Venta diaria de la red (cajas/día)">Venta/d</th>
                <th class="pr-r" title="Días hasta agotarse = existencia de red ÷ venta diaria de red">Cobertura</th>
                <th class="pr-r" title="Existencia de la red en cajas">Exist.</th>
                <th class="pr-r pr-sug" title="Cajas a pedir (editable)">Pedir</th>
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
                  <div class="pr-sku">{{ r.sku }}</div>
                </td>
                <td class="pr-mono pr-muted">{{ r.warehouse_code }}</td>
                <td class="pr-supp">{{ r.supplier_name || '—' }}</td>
                <td class="pr-r pr-sell pr-strong">{{ r.sell_month_cajas | number:'1.0-0' }}</td>
                <td class="pr-r pr-sell">{{ r.sell_daily_cajas | number:'1.0-1' }}</td>
                <td class="pr-r">
                  @if (r.days_cover != null) {
                    <p-tag [value]="(r.days_cover | number:'1.0-0') + ' d'" [severity]="coverSev(r.days_cover)" styleClass="pr-cov-tag"></p-tag>
                  } @else { <span class="pr-muted">—</span> }
                </td>
                <td class="pr-r pr-muted">{{ r.on_hand_units | number:'1.0-0' }}</td>
                <td class="pr-r pr-sug">
                  <input pInputText type="number" min="0" [(ngModel)]="r._pedir" (ngModelChange)="onSel()" class="pr-qty" [attr.aria-label]="'Cajas a pedir de ' + r.sku" />
                </td>
                <td class="pr-r pr-muted-h">{{ (r._pedir * r.uxc) | number:'1.0-0' }}</td>
                <td class="pr-r pr-muted">{{ money(r.unit_cost) }}</td>
                <td class="pr-r pr-val pr-strong">{{ money(r._pedir * r.unit_cost) }}</td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage">
              <tr><td colspan="12" class="pr-empty">
                <i class="pi pi-check-circle"></i>
                <p>Nada por pedir con estos filtros.</p>
                <span>Todo lo que rota está cubierto. Ajusta el proveedor, el bucket o sube la cobertura para ver más.</span>
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
    .pr-presets { display: inline-flex; gap: .25rem; }
    .pr-chip { font-size: .74rem; padding: .2rem .5rem; border: 1px solid var(--border-color); background: transparent; color: var(--text-muted);
      border-radius: var(--r-sm, 8px); cursor: pointer; font-variant-numeric: tabular-nums; }
    .pr-chip:hover { background: var(--overlay-hover, var(--hover-bg)); color: var(--text-main); }
    .pr-chip-on { border-color: var(--action); color: var(--action); font-weight: 600; }
    .pr-table { font-size: .84rem; }
    .pr-r { text-align: right; font-variant-numeric: tabular-nums; }
    .pr-muted, .pr-muted-h { color: var(--text-muted); }
    .pr-prod { line-height: 1.2; }
    .pr-sku { font-family: var(--font-mono, ui-monospace, monospace); font-size: .7rem; color: var(--text-faint); }
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
  deadRows = signal<DeadStockRow[]>([]);
  loading = signal(false);
  error = signal(false);
  dl = signal(false);
  saving = signal(false);
  dead = signal(false);
  deadValue = signal(0);
  totalValor = signal(0);
  totalLines = signal(0);
  private readonly selTick = signal(0); // fuerza recompute de KPIs de selección al editar

  fSupplier: string | null = null;
  fWarehouse: string | null = null;
  fBucket: string | null = null;
  search = '';
  coverage = 30;

  readonly bucketOpts = [
    { label: 'Agotado', value: 'agotado' },
    { label: 'Crítico (<7 d)', value: 'critico' },
    { label: 'Bajo (< cobertura)', value: 'bajo' },
    { label: 'Sano', value: 'sano' },
    { label: 'Sobrestock (>90 d)', value: 'sobrestock' },
  ];

  private readonly filters = signal<ReplenishmentFilters | null>(null);
  supplierOpts = computed(() => (this.filters()?.suppliers ?? []).map((s) => ({ label: s.name, value: s.id })));
  warehouseOpts = computed(() => (this.filters()?.warehouses ?? []).map((w) => ({ label: `${w.code} · ${w.name}`, value: w.id })));

  ngOnInit(): void {
    this.api.filters().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (f) => this.filters.set(f), error: () => {} });
    this.reload();
  }

  setDead(v: boolean): void { if (this.dead() === v) return; this.dead.set(v); v ? this.loadDead() : this.reload(); }

  reload(): void {
    this.loading.set(true); this.error.set(false);
    this.api.purchaseSuggestion({
      supplier_id: this.fSupplier || undefined, warehouse_id: this.fWarehouse || undefined,
      bucket: this.fBucket || undefined, search: this.search.trim() || undefined,
      coverage_days: this.coverage, pageSize: 500,
    }).pipe(
      catchError(() => { this.error.set(true); return of(null as PurchaseSuggestionResponse | null); }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((r) => {
      this.loading.set(false);
      if (!r) { this.rows.set([]); this.totalValor.set(0); this.totalLines.set(0); return; }
      this.rows.set(r.rows.map((x) => ({ ...x, _pedir: Math.round(Number(x.suggested_units) || 0), _sel: false })));
      this.totalValor.set(Number(r.total_valor) || 0);
      this.totalLines.set(Number(r.total) || 0);
      this.selTick.update((n) => n + 1);
    });
  }

  loadDead(): void {
    this.loading.set(true);
    this.api.deadStock({ search: this.search.trim() || undefined, pageSize: 200 })
      .pipe(catchError(() => of(null)), takeUntilDestroyed(this.destroyRef))
      .subscribe((r) => { this.loading.set(false); this.deadRows.set(r?.rows ?? []); this.deadValue.set(Number(r?.total_value) || 0); });
  }

  setCoverage(d: number): void { this.coverage = d; this.reload(); }
  onSel(): void { this.selTick.update((n) => n + 1); }
  allSel(): boolean { const r = this.rows(); return r.length > 0 && r.every((x) => x._sel); }
  toggleAll(v: boolean): void { this.rows().forEach((x) => (x._sel = v)); this.onSel(); }

  private selected(): Row[] { this.selTick(); return this.rows().filter((x) => x._sel && Number(x._pedir) > 0); }
  selCount = computed(() => { this.selTick(); return this.rows().filter((x) => x._sel && Number(x._pedir) > 0).length; });
  selValor = computed(() => { this.selTick(); return this.rows().filter((x) => x._sel).reduce((s, x) => s + Number(x._pedir) * Number(x.unit_cost || 0), 0); });

  kpiItems(): MetricStripItem[] {
    return [
      { label: 'Valor del pedido', value: this.totalValor(), format: 'currency', tone: 'brand' },
      { label: 'Líneas por pedir', value: this.totalLines() },
      { label: 'Cobertura', value: this.coverage, sub: 'días objetivo' },
    ];
  }

  coverSev(d: number | null): Sev {
    if (d == null) return 'secondary';
    if (d < 7) return 'danger';
    if (d < 30) return 'warn';
    if (d > 90) return 'info';
    return 'success';
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
