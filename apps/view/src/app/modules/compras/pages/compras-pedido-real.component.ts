import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { catchError, of } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { SelectModule } from 'primeng/select';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { TagModule } from 'primeng/tag';
import { MessageService } from 'primeng/api';
import { ComprasService, PurchaseSuggestionRow, PurchaseSuggestionResponse, ReplenishmentFilters } from '../compras.service';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';

/**
 * RA-PRO.17 — Compra sugerida anclada en el RITMO DE COMPRA REAL (entrada X-A-40 de Kepler).
 *
 * Reemplaza la valuación derivada demanda×política×costo — que en el granel se rompía por
 * unidades mezcladas (venta piezas / compra cajas / costo per-caja o per-pieza según el
 * producto). El ledger de compras es la única fuente auto-consistente y en dinero real:
 *   sugerido = max(0, ritmo_diario × cobertura − existencia/uxc − en_tránsito) × costo_real
 * Validado contra prod: a 30d de cobertura reproduce el gasto mensual real por proveedor
 * (Fabricas Selectas $187k ≈ $220k real; antes daba $2M). Solo aparecen los almacenes que
 * compran directo (CEDIS/hubs); las sucursales van por traspaso. Superficie Operations.
 */
@Component({
  selector: 'app-compras-pedido-real',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, ToastModule, SelectModule, InputNumberModule, InputTextModule, IconFieldModule, InputIconModule, TagModule, MetricStripComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in pr-page">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Compra sugerida <span class="pr-badge">demanda</span></h1>
          <p class="surf-page-sub">La <strong>venta real de la red</strong> fija el reorden: <strong>pedir = venta diaria × cobertura − existencia − en tránsito</strong>, valuado al costo real de compra. Lo que ya está sobrestockeado no se re-pide. Un renglón por producto (entra al hub y se distribuye).</p>
        </div>
      </header>

      <!-- KPIs: el valor del pedido es el titular -->
      <app-metric-strip [items]="kpiItems()" ariaLabel="Resumen de compra sugerida" />

      <div class="pr-filters">
        <p-select [options]="supplierOpts()" [(ngModel)]="fSupplier" (onChange)="reload()"
                  optionLabel="label" optionValue="value" placeholder="Todos los proveedores" [showClear]="true"
                  [filter]="true" filterBy="label" [virtualScroll]="true" [virtualScrollItemSize]="34"
                  styleClass="pr-sel-wide" ariaLabel="Filtrar por proveedor"></p-select>
        <p-select [options]="warehouseOpts()" [(ngModel)]="fWarehouse" (onChange)="reload()"
                  optionLabel="label" optionValue="value" placeholder="Todos los almacenes de compra" [showClear]="true"
                  styleClass="pr-sel" ariaLabel="Filtrar por almacén"></p-select>
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
          <div>
            <p>No se pudo cargar la compra sugerida.</p>
            <button pButton type="button" label="Reintentar" icon="pi pi-refresh" class="p-button-sm p-button-text" (click)="reload()"></button>
          </div>
        </div>
      } @else {
        <p-table [value]="rows()" [loading]="loading()" [scrollable]="true" scrollHeight="flex"
                 [paginator]="true" [rows]="50" [rowsPerPageOptions]="[50, 100, 200]"
                 styleClass="p-datatable-sm pr-table" [tableStyle]="{ 'min-width': '80rem' }">
          <ng-template pTemplate="header">
            <tr>
              <th style="min-width:16rem">Producto</th>
              <th style="width:5rem" title="Almacén donde se compra directo (entra y se distribuye)">Compra en</th>
              <th style="min-width:11rem">Proveedor</th>
              <th class="pr-r pr-sell" title="Venta de la RED en cajas, últimos 30 días (sell-through de todas las sucursales). Es la demanda real que fija el reorden.">Venta 30d</th>
              <th class="pr-r pr-sell" title="Venta diaria de la red (cajas/día)">Venta/d</th>
              <th class="pr-r" title="Ritmo de compra real (cajas/día, entrada X-A-40 90d)">Compra/d</th>
              <th class="pr-r" title="Existencia actual en cajas (piezas ÷ UXC)">Exist.</th>
              <th class="pr-r" title="Cobertura REAL de la red = existencia de red ÷ venta diaria de red (días hasta agotarse)">Cobertura</th>
              <th class="pr-r pr-sug" title="Cajas a pedir = ritmo × cobertura − existencia − tránsito">Pedir (cja)</th>
              <th class="pr-r pr-muted-h" title="Equivalente en piezas (cajas × UXC)">Piezas</th>
              <th class="pr-r" title="Costo real por caja (de la entrada)">Costo</th>
              <th class="pr-r pr-val" title="Valor de la línea = cajas × costo real">Valor</th>
            </tr>
          </ng-template>
          <ng-template pTemplate="body" let-r>
            <tr>
              <td>
                <div class="pr-prod">{{ r.nombre }}</div>
                <div class="pr-sku">{{ r.sku }}</div>
              </td>
              <td class="pr-mono pr-muted">{{ r.warehouse_code }}</td>
              <td class="pr-supp">{{ r.supplier_name || '—' }}</td>
              <td class="pr-r pr-sell pr-strong">{{ r.sell_month_cajas | number:'1.0-0' }}</td>
              <td class="pr-r pr-sell">{{ r.sell_daily_cajas | number:'1.0-1' }}</td>
              <td class="pr-r pr-muted">{{ r.daily_rate | number:'1.0-2' }}</td>
              <td class="pr-r pr-muted">{{ r.on_hand_units | number:'1.0-1' }}</td>
              <td class="pr-r">
                @if (r.days_cover != null) {
                  <p-tag [value]="(r.days_cover | number:'1.0-0') + ' d'" [severity]="coverSev(r.days_cover)" styleClass="pr-cov-tag"></p-tag>
                } @else { <span class="pr-muted">—</span> }
              </td>
              <td class="pr-r pr-sug pr-strong">{{ r.suggested_units | number:'1.0-0' }}</td>
              <td class="pr-r pr-muted-h">{{ r.suggested_pieces | number:'1.0-0' }}</td>
              <td class="pr-r pr-muted">{{ money(r.unit_cost) }}</td>
              <td class="pr-r pr-val pr-strong">{{ money(r.suggested_cost) }}</td>
            </tr>
          </ng-template>
          <ng-template pTemplate="emptymessage">
            <tr>
              <td colspan="12" class="pr-empty">
                <i class="pi pi-inbox"></i>
                <p>Nada por pedir con estos filtros.</p>
                <span>Solo se listan productos con historial de compra directa al proveedor. Ajusta el proveedor, el almacén o sube la cobertura.</span>
              </td>
            </tr>
          </ng-template>
        </p-table>
      }
      <p class="pr-foot">El ritmo sale de las entradas reales (X-A-40) de los últimos 90 días. Ajusta la cobertura a tu ciclo de pedido (30 d ≈ mensual). En cajas; piezas = cajas × UXC.</p>
    </div>
  `,
  styles: [`
    :host { display: block; }
    app-metric-strip { display: block; margin-bottom: 1rem; }
    .pr-badge { font-family: var(--font-mono, ui-monospace, monospace); font-size: .6rem; text-transform: uppercase; letter-spacing: .08em;
      color: var(--action); border: 1px solid var(--action-ring, var(--border-color)); border-radius: var(--r-pill, 999px); padding: .05rem .45rem; vertical-align: middle; margin-left: .4rem; }
    .pr-filters { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; margin-bottom: .75rem; }
    :host ::ng-deep .pr-sel-wide { min-width: 18rem; }
    :host ::ng-deep .pr-sel { min-width: 14rem; }
    :host ::ng-deep .pr-search input { min-width: 13rem; }
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
    :host ::ng-deep .pr-cov-tag { font-variant-numeric: tabular-nums; }
    .pr-empty { text-align: center; color: var(--text-muted); padding: 2rem 1rem; }
    .pr-empty i { font-size: 1.6rem; display: block; margin-bottom: .5rem; color: var(--text-faint); }
    .pr-empty p { margin: 0 0 .25rem; font-weight: 600; color: var(--text-main); }
    .pr-empty span { font-size: .78rem; }
    .pr-state { display: flex; gap: .75rem; align-items: center; padding: 1.25rem; border: 1px solid var(--border-color); border-radius: var(--r-md, 12px); }
    .pr-error { color: var(--bad-fg); }
    .pr-error i { font-size: 1.4rem; }
    .pr-error p { margin: 0; color: var(--text-main); }
    .pr-foot { font-size: .72rem; color: var(--text-muted); margin-top: .5rem; }
  `],
})
export class ComprasPedidoRealComponent implements OnInit {
  private readonly api = inject(ComprasService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  rows = signal<PurchaseSuggestionRow[]>([]);
  loading = signal(false);
  error = signal(false);
  totalValor = signal(0);
  totalLines = signal(0);

  fSupplier: string | null = null;
  fWarehouse: string | null = null;
  search = '';
  coverage = 30;

  private readonly filters = signal<ReplenishmentFilters | null>(null);
  supplierOpts = computed(() => (this.filters()?.suppliers ?? []).map((s) => ({ label: s.name, value: s.id })));
  warehouseOpts = computed(() => (this.filters()?.warehouses ?? []).map((w) => ({ label: `${w.code} · ${w.name}`, value: w.id })));

  ngOnInit(): void {
    this.api.filters().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (f) => this.filters.set(f), error: () => {},
    });
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.error.set(false);
    this.api.purchaseSuggestion({
      supplier_id: this.fSupplier || undefined,
      warehouse_id: this.fWarehouse || undefined,
      search: this.search.trim() || undefined,
      coverage_days: this.coverage,
      pageSize: 500,
    }).pipe(
      catchError(() => { this.error.set(true); return of(null as PurchaseSuggestionResponse | null); }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((r) => {
      this.loading.set(false);
      if (!r) { this.rows.set([]); this.totalValor.set(0); this.totalLines.set(0); return; }
      this.rows.set(r.rows);
      this.totalValor.set(Number(r.total_valor) || 0);
      this.totalLines.set(Number(r.total) || 0);
    });
  }

  setCoverage(d: number): void { this.coverage = d; this.reload(); }

  kpiItems(): MetricStripItem[] {
    return [
      { label: 'Valor del pedido', value: this.totalValor(), format: 'currency', tone: 'brand' },
      { label: 'Líneas por pedir', value: this.totalLines() },
      { label: 'Cobertura', value: this.coverage, sub: 'días objetivo' },
    ];
  }

  coverSev(d: number | null): 'success' | 'warn' | 'danger' | 'secondary' {
    if (d == null) return 'secondary';
    if (d < 7) return 'danger';
    if (d < 21) return 'warn';
    return 'success';
  }

  money(v: number | string | null | undefined): string {
    return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  }
}
