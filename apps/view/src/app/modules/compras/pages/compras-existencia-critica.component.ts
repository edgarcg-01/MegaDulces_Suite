import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { forkJoin } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { TableModule, TableLazyLoadEvent } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { DialogModule } from 'primeng/dialog';
import { TagModule } from 'primeng/tag';
import { InputTextModule } from 'primeng/inputtext';
import { MessageService } from 'primeng/api';
import { ComprasService, CriticalStockRow, ReplenishmentSummary, Bucket, TargetBasis, SourceType, CreateRequisitionDto } from '../compras.service';

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
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, ToastModule, SelectModule, MultiSelectModule, DialogModule, TagModule, InputTextModule],
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
          <button pButton type="button" [label]="'Generar requisición' + (selCount() ? ' (' + selCount() + ')' : '')" icon="pi pi-file-edit"
                  class="p-button-sm" [disabled]="!canRequire()" (click)="openDialog()"></button>
        </div>
      </header>

      <!-- KPIs -->
      @if (summary(); as s) {
        <div class="ec-kpis">
          <div class="ec-kpi" [class.bad]="s.agotado > 0"><span class="ec-kpi-val">{{ s.agotado | number }}</span><span class="ec-kpi-lbl">Agotado</span></div>
          <div class="ec-kpi" [class.bad]="s.bajo_minimo > 0"><span class="ec-kpi-val">{{ s.bajo_minimo | number }}</span><span class="ec-kpi-lbl">Bajo mínimo</span></div>
          <div class="ec-kpi" [class.warn]="s.bajo_reorden > 0"><span class="ec-kpi-val">{{ s.bajo_reorden | number }}</span><span class="ec-kpi-lbl">Bajo reorden</span></div>
          <div class="ec-kpi"><span class="ec-kpi-val">{{ s.sobrestock | number }}</span><span class="ec-kpi-lbl">Sobrestock</span></div>
          <div class="ec-kpi"><span class="ec-kpi-val">{{ s.total_policies | number }}</span><span class="ec-kpi-lbl">Con política</span></div>
          <div class="ec-kpi"><span class="ec-kpi-val">{{ money(s.sugerido_costo || 0) }}</span><span class="ec-kpi-lbl">Sugerido a comprar</span></div>
        </div>
      }

      <!-- Filtros -->
      <div class="ec-filters">
        <p-multiSelect [options]="warehouseOpts()" [(ngModel)]="fWarehouses" (onChange)="reload()"
                       optionLabel="label" optionValue="value" placeholder="Todos los almacenes" [showClear]="true"
                       [maxSelectedLabels]="2" selectedItemsLabel="{0} almacenes" styleClass="ec-sel"></p-multiSelect>
        <p-select [options]="bucketOpts" [(ngModel)]="fBucket" (onChange)="reload()"
                  optionLabel="label" optionValue="value" placeholder="Críticos (≤ reorden)" [showClear]="true" styleClass="ec-sel"></p-select>
        <p-select [options]="basisOpts" [(ngModel)]="fBasis" (onChange)="reload()"
                  optionLabel="label" optionValue="value" placeholder="Objetivo" styleClass="ec-sel"></p-select>
        <p-select [options]="supplierOpts()" [(ngModel)]="fSupplier" (onChange)="reload()"
                  optionLabel="label" optionValue="value" placeholder="Todos los proveedores" [showClear]="true" styleClass="ec-sel-wide"></p-select>
        <span class="p-input-icon-left ec-search">
          <input pInputText type="text" [(ngModel)]="fSearch" (keyup.enter)="reload()" placeholder="SKU o nombre…" />
        </span>
        <button pButton type="button" icon="pi pi-search" class="p-button-sm p-button-text" (click)="reload()"></button>
      </div>

      <!-- Tabla -->
      <p-table [value]="rows()" [loading]="loading()" [scrollable]="true" scrollHeight="flex"
               [paginator]="true" [rows]="pageSize" [totalRecords]="total()" [lazy]="true" (onLazyLoad)="onPage($event)"
               styleClass="p-datatable-sm ec-table" [rowsPerPageOptions]="[50, 100, 200]">
        <ng-template pTemplate="header">
          <tr>
            <th style="width:2.5rem"><input type="checkbox" [checked]="allSelected()" (change)="toggleAll($event)" /></th>
            <th>SKU</th>
            <th>Producto</th>
            <th>Almacén</th>
            <th class="ec-r">Existencia</th>
            <th class="ec-r">Mín</th>
            <th class="ec-r">Reorden</th>
            <th class="ec-r">Máx</th>
            <th class="ec-r">Sugerido</th>
            <th>Estado</th>
            <th>Proveedor</th>
            <th class="ec-r">Costo est.</th>
            <th>Origen</th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-r>
          <tr [class.ec-sel-row]="isSelected(r)">
            <td><input type="checkbox" [checked]="isSelected(r)" (change)="toggle(r)" /></td>
            <td class="ec-mono">{{ r.sku }}</td>
            <td>{{ r.nombre }}</td>
            <td class="ec-muted">{{ r.warehouse_code }}</td>
            <td class="ec-r">{{ r.on_hand | number:'1.0-0' }}</td>
            <td class="ec-r ec-muted">{{ r.min_stock | number:'1.0-0' }}</td>
            <td class="ec-r ec-muted">{{ r.reorder_point | number:'1.0-0' }}</td>
            <td class="ec-r ec-muted">{{ r.max_stock | number:'1.0-0' }}</td>
            <td class="ec-r ec-strong">{{ r.suggested_qty | number:'1.0-0' }}</td>
            <td><p-tag [value]="bucketLabel(r.bucket)" [severity]="bucketSev(r.bucket)"></p-tag></td>
            <td class="ec-muted">{{ r.supplier_name || '—' }}</td>
            <td class="ec-r">{{ money(r.suggested_cost) }}</td>
            <td><span class="ec-src ec-src-{{ r.source }}">{{ sourceLabel(r.source) }}</span></td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="13" class="ec-empty">Sin productos que reponer con estos filtros.</td></tr>
        </ng-template>
      </p-table>
    </div>

    <!-- Dialog: generar requisición. appendTo=body: la página vive en un contenedor
         con overflow/transform → sin esto el modal se renderiza pero queda clipeado
         detrás (el clic "no hace nada" a la vista). -->
    <p-dialog [visible]="dialogOpen()" (visibleChange)="dialogOpen.set($event)" [modal]="true" appendTo="body" [style]="{ width: '52rem', maxWidth: '96vw' }" header="Generar requisición" [dismissableMask]="true">
      <div class="ec-dlg">
        <p class="ec-dlg-sub">{{ draft().length }} producto(s) · {{ draftWarehouses().length }} almacén(es) · objetivo <strong>{{ basisLabel(fBasis) }}</strong>
          @if (draftWarehouses().length > 1) { <span class="ec-dlg-note">— se crearán {{ draftWarehouses().length }} requisiciones (una por almacén)</span> }
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
                          placeholder="Almacén origen" styleClass="ec-dlg-srcwh" appendTo="body"></p-select>
              }
              <input pInputText type="number" min="0" [(ngModel)]="l.final_qty" class="ec-dlg-qty" />
            </div>
          }
        </div>
        <input pInputText type="text" [(ngModel)]="notes" placeholder="Nota (opcional)" class="ec-dlg-notes" />
      </div>
      <ng-template pTemplate="footer">
        <button pButton type="button" label="Cancelar" class="p-button-text p-button-sm" (click)="dialogOpen.set(false)"></button>
        <button pButton type="button" label="Crear requisición" icon="pi pi-check" class="p-button-sm" [loading]="saving()" (click)="create()"></button>
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    :host { display: block; }
    .ec-head-actions { display: flex; gap: .5rem; align-items: center; }
    .ec-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: .5rem; margin-bottom: 1rem; }
    .ec-kpi { display: flex; flex-direction: column; gap: .15rem; padding: .7rem .9rem; border: 1px solid var(--surface-border, #e5e3df); border-radius: var(--radius-md, 10px); background: var(--surface-card, #fff); }
    .ec-kpi-val { font-size: 1.35rem; font-weight: 700; line-height: 1; }
    .ec-kpi-lbl { font-size: .72rem; color: var(--text-muted, #8a8580); text-transform: uppercase; letter-spacing: .03em; }
    .ec-kpi.bad .ec-kpi-val { color: var(--red-600, #dc2626); }
    .ec-kpi.warn .ec-kpi-val { color: var(--amber-600, #d97706); }
    .ec-filters { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin-bottom: .75rem; }
    .ec-sel { min-width: 12rem; } .ec-sel-wide { min-width: 15rem; } .ec-search input { min-width: 12rem; }
    .ec-table { font-size: .82rem; }
    .ec-r { text-align: right; font-variant-numeric: tabular-nums; }
    .ec-mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .78rem; }
    .ec-muted { color: var(--text-muted, #8a8580); }
    .ec-strong { font-weight: 700; }
    .ec-sel-row { background: var(--surface-hover, #f6f5f3); }
    .ec-src { font-size: .68rem; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted, #8a8580); }
    .ec-src-kepler { color: var(--action, #c2410c); }
    .ec-empty { color: var(--text-muted, #8a8580); padding: 1rem; text-align: center; }
    .ec-dlg-sub { color: var(--text-muted, #8a8580); font-size: .85rem; margin-bottom: .5rem; }
    .ec-dlg-note { color: var(--action, #c2410c); }
    .ec-warn { display: flex; gap: .45rem; align-items: center; font-size: .8rem; color: var(--amber-700, #b45309); background: var(--amber-50, #fffbeb); border: 1px solid var(--amber-200, #fde68a); border-radius: var(--radius-sm, 8px); padding: .45rem .6rem; margin-bottom: .4rem; }
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
  loading = signal(false);
  saving = signal(false);
  page = signal(1);

  warehouseOpts = signal<{ label: string; value: string }[]>([]);
  supplierOpts = signal<{ label: string; value: string }[]>([]);
  private warehouseNames = new Map<string, string>();

  fWarehouses: string[] = [];
  fBucket = '';
  fBasis: TargetBasis = 'max';
  fSupplier = '';
  fSearch = '';

  bucketOpts = [
    { label: 'Agotado', value: 'agotado' },
    { label: 'Bajo mínimo', value: 'bajo_minimo' },
    { label: 'Bajo reorden', value: 'bajo_reorden' },
    { label: 'Sobrestock', value: 'sobrestock' },
    { label: 'Todos', value: '__all' },
  ];
  basisOpts = [
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
    this.reload();
  }

  reload(): void {
    this.selected.clear();
    this.selCount.set(0);
    this.page.set(1);
    this.load();
    this.loadSummary();
  }

  private load(): void {
    this.loading.set(true);
    const scope = this.fBucket === '__all' ? 'all' : undefined;
    const bucket = this.fBucket && this.fBucket !== '__all' ? this.fBucket : undefined;
    this.api.criticalStock({
      warehouse_ids: this.fWarehouses.length ? this.fWarehouses : undefined, supplier_id: this.fSupplier || undefined,
      bucket, scope, target_basis: this.fBasis, search: this.fSearch || undefined,
      page: this.page(), pageSize: this.pageSize,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.rows.set(r.rows); this.total.set(r.total); this.loading.set(false); },
      error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar la existencia crítica.' }); },
    });
  }

  private loadSummary(): void {
    this.api.summary({ warehouse_ids: this.fWarehouses.length ? this.fWarehouses : undefined, supplier_id: this.fSupplier || undefined, target_basis: this.fBasis })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe((s) => this.summary.set(s));
  }

  onPage(e: TableLazyLoadEvent): void {
    const size = e.rows || this.pageSize;
    this.page.set(Math.floor((e.first || 0) / size) + 1);
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
  toggleAll(e: Event) {
    const on = (e.target as HTMLInputElement).checked;
    if (on) this.rows().forEach((r) => this.selected.set(this.key(r), r));
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
    const all = this.draft().filter((l) => Number(l.final_qty) > 0);
    if (!all.length) { this.toast.add({ severity: 'warn', summary: 'Sin líneas', detail: 'Ajusta las cantidades (> 0).' }); return; }
    // Validar que las líneas de traspaso tengan almacén origen.
    if (all.some((l) => l.source_type === 'branch' && !l.source_warehouse_id)) {
      this.toast.add({ severity: 'warn', summary: 'Falta almacén origen', detail: 'Elige la sucursal origen de las líneas por traspaso.' }); return;
    }
    // RA.12 — una requisición por almacén de destino.
    const byWh = new Map<string, DraftLine[]>();
    for (const l of all) { const g = byWh.get(l.warehouse_id) || []; g.push(l); byWh.set(l.warehouse_id, g); }

    const dtos: CreateRequisitionDto[] = [...byWh.entries()].map(([warehouse_id, lines]) => ({
      warehouse_id, target_basis: this.fBasis, notes: this.notes || undefined,
      lines: lines.map((l) => ({
        product_id: l.product_id, supplier_id: l.supplier_id,
        source_type: l.source_type, source_warehouse_id: l.source_type === 'branch' ? l.source_warehouse_id : null,
        on_hand: l.on_hand, in_transit: l.in_transit,
        min_stock: l.min_stock, reorder_point: l.reorder_point, max_stock: l.max_stock,
        suggested_qty: l.suggested_qty, final_qty: Number(l.final_qty), unit_cost: l.unit_cost,
      })),
    }));

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
  basisLabel(b: string) { return this.basisOpts.find((o) => o.value === b)?.label || b; }
  bucketLabel(b: Bucket) { return ({ agotado: 'Agotado', bajo_minimo: 'Bajo mínimo', bajo_reorden: 'Bajo reorden', sobrestock: 'Sobrestock', sano: 'Sano' } as Record<Bucket, string>)[b]; }
  bucketSev(b: Bucket): Sev { return ({ agotado: 'danger', bajo_minimo: 'danger', bajo_reorden: 'warn', sobrestock: 'secondary', sano: 'success' } as Record<Bucket, Sev>)[b]; }
  sourceLabel(s: string) { return s === 'kepler' ? 'Kepler' : s === 'computed' ? 'Computado' : 'Manual'; }
}
