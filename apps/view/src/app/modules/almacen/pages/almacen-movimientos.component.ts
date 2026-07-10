import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule, TableLazyLoadEvent } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { DatePickerModule } from 'primeng/datepicker';
import { DialogModule } from 'primeng/dialog';
import { TagModule } from 'primeng/tag';
import { InputTextModule } from 'primeng/inputtext';
import {
  AlmacenMovimientosService, GroupBy, MovementsFilters, MovementsSummary,
  AggregateRow, MovementLine, MovementsFilterOpts,
} from '../almacen-movimientos.service';

/**
 * DM.2 — Diario de movimientos (mejora del reporte Kepler homónimo).
 *
 * Superficie Operations (PrimeNG denso, quiet-luxury). Diseño rector:
 * **agregación primero, folio a folio bajo demanda**. La tabla arranca agrupada
 * (producto por default; re-agrupable por tipo/día/almacén); un click en la fila
 * abre el drill con los folios individuales de esa rama.
 */
@Component({
  selector: 'app-almacen-movimientos',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, SelectModule, MultiSelectModule, DatePickerModule, DialogModule, TagModule, InputTextModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in dm-page">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Diario de movimientos</h1>
          <p class="surf-page-sub">Entradas y salidas de inventario. Vista agregada; clic en una fila para ver los folios.</p>
        </div>
      </header>

      <!-- KPIs -->
      @if (summary(); as s) {
        <div class="dm-kpis">
          <div class="dm-kpi"><span class="dm-kpi-val up">+{{ s.totals.entradas | number:'1.0-0' }}</span><span class="dm-kpi-lbl">Entradas</span></div>
          <div class="dm-kpi"><span class="dm-kpi-val down">−{{ absN(s.totals.salidas) | number:'1.0-0' }}</span><span class="dm-kpi-lbl">Salidas</span></div>
          <div class="dm-kpi"><span class="dm-kpi-val" [class.up]="s.totals.neto>=0" [class.down]="s.totals.neto<0">{{ s.totals.neto | number:'1.0-0' }}</span><span class="dm-kpi-lbl">Neto</span></div>
          <div class="dm-kpi"><span class="dm-kpi-val">{{ money(s.totals.valor) }}</span><span class="dm-kpi-lbl">Valor movido</span></div>
          <div class="dm-kpi"><span class="dm-kpi-val">{{ s.totals.documentos | number }}</span><span class="dm-kpi-lbl">Documentos</span></div>
          <div class="dm-kpi"><span class="dm-kpi-val">{{ s.totals.lineas | number }}</span><span class="dm-kpi-lbl">Líneas</span></div>
        </div>
      }

      <!-- Filtros -->
      <div class="dm-filters">
        <p-select [options]="groupOpts" [(ngModel)]="fGroup" (onChange)="reload()"
                  optionLabel="label" optionValue="value" styleClass="dm-sel" placeholder="Agrupar por"></p-select>
        <p-multiSelect [options]="warehouseOpts()" [(ngModel)]="fWarehouses" (onChange)="reload()"
                       optionLabel="label" optionValue="value" placeholder="Todos los almacenes" [showClear]="true"
                       [maxSelectedLabels]="2" selectedItemsLabel="{0} almacenes" styleClass="dm-sel"></p-multiSelect>
        <p-datepicker [(ngModel)]="fFrom" (onSelect)="reload()" dateFormat="yy-mm-dd" placeholder="Desde" [showIcon]="true" styleClass="dm-date" appendTo="body"></p-datepicker>
        <p-datepicker [(ngModel)]="fTo" (onSelect)="reload()" dateFormat="yy-mm-dd" placeholder="Hasta" [showIcon]="true" styleClass="dm-date" appendTo="body"></p-datepicker>
        <p-select [options]="kindOpts" [(ngModel)]="fKind" (onChange)="reload()"
                  optionLabel="label" optionValue="value" placeholder="Dirección" [showClear]="true" styleClass="dm-sel-sm"></p-select>
        <p-select [options]="docTypeOpts()" [(ngModel)]="fDocCode" (onChange)="reload()"
                  optionLabel="label" optionValue="value" placeholder="Tipo de documento" [showClear]="true" styleClass="dm-sel"></p-select>
        <span class="dm-search">
          <input pInputText type="text" [(ngModel)]="fSearch" (keyup.enter)="reload()" placeholder="SKU o producto…" />
        </span>
        <button pButton type="button" icon="pi pi-search" class="p-button-sm p-button-text" (click)="reload()" ariaLabel="Buscar"></button>
      </div>

      <!-- Tabla agregada (DEFAULT) -->
      <p-table [value]="rows()" [loading]="loading()" [scrollable]="true" scrollHeight="flex"
               [paginator]="true" [rows]="pageSize" [totalRecords]="total()" [lazy]="true" (onLazyLoad)="onPage($event)"
               styleClass="p-datatable-sm dm-table" [rowsPerPageOptions]="[50, 100, 200]"
               [rowHover]="true" (onRowSelect)="drill($event.data)" selectionMode="single">
        <ng-template pTemplate="header">
          <tr>
            <th>{{ groupHeader() }}</th>
            <th class="dm-r">Entradas</th>
            <th class="dm-r">Salidas</th>
            <th class="dm-r">Neto</th>
            <th class="dm-r">Valor</th>
            <th class="dm-r">Docs</th>
            <th style="width:2.2rem"></th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-r>
          <tr class="dm-row" (click)="drill(r)">
            <td>
              <span class="dm-label">{{ rowLabel(r) }}</span>
              @if (fGroup === 'product' && r.sku) { <span class="dm-sub dm-mono">{{ r.sku }}</span> }
              @if (fGroup === 'doc_code') { <p-tag [value]="r.movement_kind === 'entrada' ? 'entrada' : 'salida'" [severity]="r.movement_kind === 'entrada' ? 'success' : 'warn'" styleClass="dm-tag"></p-tag> }
              @if (fGroup === 'warehouse' && r.code) { <span class="dm-sub dm-mono">{{ r.code }}</span> }
            </td>
            <td class="dm-r up">{{ r.entradas ? ('+' + (r.entradas | number:'1.0-0')) : '—' }}</td>
            <td class="dm-r down">{{ r.salidas ? ('−' + (absN(r.salidas) | number:'1.0-0')) : '—' }}</td>
            <td class="dm-r" [class.up]="r.neto>0" [class.down]="r.neto<0">{{ r.neto | number:'1.0-0' }}</td>
            <td class="dm-r dm-strong">{{ money(r.valor || 0) }}</td>
            <td class="dm-r dm-muted">{{ r.documentos | number }}</td>
            <td class="dm-r"><i class="pi pi-angle-right dm-muted"></i></td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="7" class="dm-empty">Sin movimientos en el rango seleccionado.</td></tr>
        </ng-template>
      </p-table>
    </div>

    <!-- Drill: folios de la rama seleccionada -->
    <p-dialog [(visible)]="drillOpen" [modal]="true" [style]="{ width: '52rem', maxWidth: '95vw' }" [dismissableMask]="true" styleClass="dm-dlg">
      <ng-template pTemplate="header"><span class="dm-dlg-title">{{ drillTitle() }}</span></ng-template>
      @if (drillLoading()) { <div class="dm-empty">Cargando folios…</div> }
      @else if (!drillLines().length) { <div class="dm-empty">Sin folios.</div> }
      @else {
        <p-table [value]="drillLines()" styleClass="p-datatable-sm dm-dtable" [scrollable]="true" scrollHeight="26rem">
          <ng-template pTemplate="header">
            <tr>
              <th>Fecha</th><th>Folio</th><th>Tipo</th>
              @if (fGroup !== 'product') { <th>Producto</th> }
              <th class="dm-r">Cantidad</th><th class="dm-r">Costo/u</th><th class="dm-r">Valor</th><th>Cadena</th>
            </tr>
          </ng-template>
          <ng-template pTemplate="body" let-l>
            <tr>
              <td class="dm-mono">{{ l.doc_date | date:'yyyy-MM-dd' }}</td>
              <td class="dm-mono">{{ l.folio }}</td>
              <td><p-tag [value]="l.movement_label" [severity]="l.movement_kind === 'entrada' ? 'success' : 'warn'" styleClass="dm-tag"></p-tag></td>
              @if (fGroup !== 'product') { <td class="dm-dname">{{ l.product_name || l.sku }}</td> }
              <td class="dm-r" [class.up]="l.signed_qty>0" [class.down]="l.signed_qty<0">{{ l.signed_qty | number:'1.0-0' }}</td>
              <td class="dm-r dm-muted">{{ l.unit_cost != null ? money(l.unit_cost) : '—' }}</td>
              <td class="dm-r dm-strong">{{ l.amount != null ? money(l.amount) : '—' }}</td>
              <td class="dm-sub dm-mono">{{ l.parent_folio ? (l.parent_group + '·' + l.parent_folio) : '—' }}</td>
            </tr>
          </ng-template>
        </p-table>
        <p class="dm-dlg-foot">{{ drillTotal() | number }} folios · sucursal {{ drillLines()[0].source_branch }}</p>
      }
    </p-dialog>
  `,
  styles: [`
    :host { display: block; }
    .dm-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr)); gap: .5rem; margin-bottom: 1rem; }
    .dm-kpi { display: flex; flex-direction: column; gap: .15rem; padding: .7rem .9rem; border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); }
    .dm-kpi-val { font-size: 1.3rem; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; }
    .dm-kpi-lbl { font-size: .72rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: .03em; }
    .dm-kpi-val.up { color: var(--ok-fg); }
    .dm-kpi-val.down { color: var(--bad-fg); }
    .dm-filters { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin-bottom: .75rem; }
    .dm-sel { min-width: 12rem; } .dm-sel-sm { min-width: 8rem; } .dm-date { min-width: 9rem; } .dm-search input { min-width: 12rem; }
    .dm-table { font-size: .82rem; }
    .dm-row { cursor: pointer; }
    .dm-r { text-align: right; font-variant-numeric: tabular-nums; }
    .dm-r.up, .dm-kpi-val.up, td.up { color: var(--ok-fg); }
    .dm-r.down, td.down { color: var(--bad-fg); }
    .dm-label { font-weight: 600; }
    .dm-sub { display: block; font-size: .68rem; color: var(--text-muted); }
    .dm-mono { font-family: var(--font-mono, ui-monospace, monospace); }
    .dm-muted { color: var(--text-muted); }
    .dm-strong { font-weight: 700; }
    .dm-tag { font-size: .66rem; }
    .dm-empty { color: var(--text-muted); padding: 1.2rem; text-align: center; }
    .dm-dlg-title { font-weight: 700; }
    .dm-dtable { font-size: .8rem; margin-top: .3rem; }
    .dm-dname { max-width: 14rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dm-dlg-foot { margin-top: .6rem; font-size: .74rem; color: var(--text-muted); }
  `],
})
export class AlmacenMovimientosComponent implements OnInit {
  private readonly api = inject(AlmacenMovimientosService);
  private readonly destroyRef = inject(DestroyRef);

  readonly pageSize = 50;
  rows = signal<AggregateRow[]>([]);
  total = signal(0);
  summary = signal<MovementsSummary | null>(null);
  loading = signal(false);
  page = signal(1);

  warehouseOpts = signal<{ label: string; value: string }[]>([]);
  docTypeOpts = signal<{ label: string; value: string }[]>([]);

  fGroup: GroupBy = 'product';
  fWarehouses: string[] = [];
  fFrom: Date | null = null;
  fTo: Date | null = null;
  fKind: '' | 'entrada' | 'salida' = '';
  fDocCode = '';
  fSearch = '';

  groupOpts = [
    { label: 'Por producto', value: 'product' },
    { label: 'Por tipo de documento', value: 'doc_code' },
    { label: 'Por día', value: 'day' },
    { label: 'Por almacén', value: 'warehouse' },
  ];
  kindOpts = [
    { label: 'Entradas', value: 'entrada' },
    { label: 'Salidas', value: 'salida' },
  ];

  // Drill
  drillOpen = false;
  drillLoading = signal(false);
  drillLines = signal<MovementLine[]>([]);
  drillTotal = signal(0);
  private drillLabel = signal('');

  ngOnInit(): void {
    this.api.filters().pipe(takeUntilDestroyed(this.destroyRef)).subscribe((f: MovementsFilterOpts) => {
      this.warehouseOpts.set(f.warehouses.filter(w => w.code).map(w => ({ label: `${w.code} — ${w.name}`, value: w.id })));
      this.docTypeOpts.set(f.doc_types.map(d => ({ label: d.movement_label, value: d.doc_code })));
    });
    this.reload();
  }

  private currentFilters(): MovementsFilters {
    return {
      warehouse_ids: this.fWarehouses,
      from: this.fFrom ? this.iso(this.fFrom) : undefined,
      to: this.fTo ? this.iso(this.fTo) : undefined,
      movement_kind: this.fKind,
      doc_code: this.fDocCode || undefined,
      search: this.fSearch || undefined,
    };
  }

  reload(): void {
    this.page.set(1);
    this.load();
    this.api.summary(this.currentFilters()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(s => this.summary.set(s));
  }

  private load(): void {
    this.loading.set(true);
    this.api.aggregate(this.currentFilters(), this.fGroup, this.page(), this.pageSize)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.rows.set(r.rows); this.total.set(r.total); this.loading.set(false); },
        error: () => { this.rows.set([]); this.total.set(0); this.loading.set(false); },
      });
  }

  onPage(e: TableLazyLoadEvent): void {
    const p = Math.floor((e.first || 0) / (e.rows || this.pageSize)) + 1;
    this.page.set(p);
    this.load();
  }

  drill(r: AggregateRow): void {
    this.drillOpen = true;
    this.drillLoading.set(true);
    this.drillLines.set([]);
    this.drillLabel.set(this.rowLabel(r));
    const f = this.currentFilters();
    // Fija la rama seleccionada según el eje de agrupación.
    if (this.fGroup === 'product') f.search = undefined;
    const extra: { product_id?: string; page?: number; pageSize?: number } = { page: 1, pageSize: 200 };
    if (this.fGroup === 'product') extra.product_id = r.key;
    else if (this.fGroup === 'doc_code') f.doc_code = r.key;
    else if (this.fGroup === 'warehouse') f.warehouse_ids = [r.key];
    else if (this.fGroup === 'day') { f.from = r.key.slice(0, 10); f.to = r.key.slice(0, 10); }
    this.api.lines(f, extra).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => { this.drillLines.set(res.rows); this.drillTotal.set(res.total); this.drillLoading.set(false); },
      error: () => { this.drillLines.set([]); this.drillLoading.set(false); },
    });
  }

  groupHeader(): string {
    return this.fGroup === 'product' ? 'Producto' : this.fGroup === 'doc_code' ? 'Tipo de documento' : this.fGroup === 'day' ? 'Día' : 'Almacén';
  }
  rowLabel(r: AggregateRow): string {
    if (this.fGroup === 'day') return (r.label || '').slice(0, 10);
    return r.label || r.key || '—';
  }
  drillTitle(): string { return this.drillLabel() || 'Folios'; }

  absN(v: number): number { return Math.abs(v || 0); }
  money(v: number): string {
    return (v || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }
  private iso(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}
