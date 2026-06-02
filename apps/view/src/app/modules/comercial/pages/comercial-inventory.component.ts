import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { DialogModule } from 'primeng/dialog';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService } from 'primeng/api';
import { ComercialService, StockRow, Warehouse } from '../comercial.service';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';

@Component({
  selector: 'app-comercial-inventory',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    CardModule,
    TableModule,
    TagModule,
    SelectModule,
    DialogModule,
    InputNumberModule,
    InputTextModule,
    ToastModule,
    TooltipModule,
  ],
  providers: [MessageService],
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>

      <!-- PAGE HEAD -->
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Inventario</h1>
          <p class="surf-page-sub">
            <b>{{ total() }}</b> línea{{ total() === 1 ? '' : 's' }} de stock
            <span class="in-divider" aria-hidden="true">·</span>
            on-hand / reservado / disponible
          </p>
        </div>
        <div class="in-head-actions">
          <button
            pButton
            icon="pi pi-refresh"
            [text]="true"
            severity="secondary"
            size="small"
            (click)="load()"
            [loading]="loading()"
            pTooltip="Refrescar"
          ></button>
        </div>
      </header>

      <!-- KPI STRIP — resumen del total (independiente del paginado) -->
      <div class="sheet cols-12" *ngIf="summaryAll().length > 0">
        <article class="cell cell-span-3">
          <span class="cell-icon" aria-hidden="true"><i class="pi pi-box"></i></span>
          <span class="cell-label">Líneas de stock</span>
          <span class="cell-value is-headline">{{ kpis().lines }}</span>
          <span class="cell-sub">producto × almacén</span>
        </article>
        <article class="cell cell-span-3">
          <span class="cell-icon" aria-hidden="true"><i class="pi pi-exclamation-circle"></i></span>
          <span class="cell-label">Stock crítico</span>
          <span class="cell-value">{{ kpis().critical }}</span>
          <span class="cell-sub">disponible &lt; 20</span>
        </article>
        <article class="cell cell-span-3">
          <span class="cell-icon" aria-hidden="true"><i class="pi pi-times-circle"></i></span>
          <span class="cell-label">Sin stock</span>
          <span class="cell-value">{{ kpis().zero }}</span>
          <span class="cell-sub">requieren reabasto</span>
        </article>
        <article class="cell cell-span-3">
          <span class="cell-icon" aria-hidden="true"><i class="pi pi-database"></i></span>
          <span class="cell-label">Unidades on-hand</span>
          <span class="cell-value">{{ fmtUnits(kpis().totalUnits) }}</span>
          <span class="cell-sub">suma de todas las líneas</span>
        </article>
      </div>

      <!-- FILTERS toolbar -->
      <div class="sheet cols-12">
        <article class="cell cell-span-12 is-flush in-filters-cell">
          <div class="in-toolbar">
            <div class="in-field">
              <i class="pi pi-warehouse in-field-icon" aria-hidden="true"></i>
              <p-select
                [options]="warehouses()"
                [(ngModel)]="warehouseFilter"
                (onChange)="reload()"
                optionLabel="name"
                optionValue="id"
                [showClear]="true"
                placeholder="Todos los almacenes"
                styleClass="in-warehouse-select"
                appendTo="body"
              ></p-select>
            </div>

            <div class="in-toolbar-spacer"></div>

            <button
              *ngIf="warehouseFilter"
              type="button"
              class="in-reset"
              (click)="clearFilter()"
            >
              <i class="pi pi-refresh" aria-hidden="true"></i>
              <span>Reset</span>
            </button>
          </div>
        </article>
      </div>

      <!-- TABLA flush -->
      <div class="sheet cols-12">
        <article class="cell cell-span-12 is-flush">
          <p-table
            [value]="rows()"
            [loading]="loading()"
            [lazy]="true"
            [paginator]="true"
            [rows]="pageSize()"
            [totalRecords]="total()"
            [first]="(page() - 1) * pageSize()"
            (onLazyLoad)="onLazyLoad($event)"
            responsiveLayout="scroll"
            styleClass="p-datatable-sm"
          >
            <ng-template pTemplate="header">
              <tr>
                <th>Almacén</th>
                <th>Producto</th>
                <th class="comm-num">On hand</th>
                <th class="comm-num">Reservado</th>
                <th class="comm-num">Disponible</th>
                <th></th>
              </tr>
            </ng-template>
            <ng-template pTemplate="body" let-s>
              <tr [class.in-row-low]="s.available > 0 && s.available < 20" [class.in-row-zero]="s.available <= 0">
                <td>
                  <span class="in-warehouse-cell">
                    <i class="pi pi-warehouse" aria-hidden="true"></i>
                    {{ s.warehouse_name || s.warehouse_id }}
                  </span>
                </td>
                <td>
                  <div class="comm-cell-strong">{{ s.product_name || s.product_id }}</div>
                  <div class="comm-muted is-small" *ngIf="s.brand_name">{{ s.brand_name }}</div>
                </td>
                <td class="comm-num in-num-soft">{{ s.on_hand }}</td>
                <td class="comm-num in-num-soft">{{ s.reserved }}</td>
                <td class="comm-num in-avail-cell">
                  <span class="comm-pill no-dot in-avail-pill" [class]="stockPillClass(s.available)">
                    {{ s.available }}
                  </span>
                </td>
                <td class="comm-actions">
                  <button *ngIf="canAdjust()" pButton icon="pi pi-pencil" size="small" severity="secondary" [text]="true"
                          pTooltip="Ajustar saldo"
                          (click)="openAdjust(s)"></button>
                </td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage">
              <tr>
                <td colspan="6" class="in-empty-cell">
                  <div class="in-empty">
                    <div class="in-empty-icon"><i class="pi pi-inbox" aria-hidden="true"></i></div>
                    <h3>Sin stock registrado</h3>
                    <p>{{ warehouseFilter ? 'Este almacén no tiene productos con saldo.' : 'Aún no hay líneas de stock en el tenant.' }}</p>
                    <button
                      *ngIf="warehouseFilter"
                      type="button"
                      pButton
                      icon="pi pi-refresh"
                      severity="secondary"
                      [outlined]="true"
                      size="small"
                      label="Ver todos los almacenes"
                      (click)="clearFilter()"
                    ></button>
                  </div>
                </td>
              </tr>
            </ng-template>
          </p-table>
        </article>
      </div>
    </div>

    <p-dialog
      [(visible)]="dialogVisible"
      [modal]="true"
      [draggable]="false"
      [style]="{ width: '440px' }"
      header="Ajustar saldo de stock"
    >
      <div class="adjust-body" *ngIf="adjusting() as a">
        <div class="adjust-info">
          <div><span>Almacén</span> <strong>{{ a.warehouse_name || a.warehouse_id }}</strong></div>
          <div><span>Producto</span> <strong>{{ a.product_name || a.product_id }}</strong></div>
          <div><span>Saldo on_hand</span> <strong>{{ a.on_hand }}</strong></div>
          <div><span>Reservado</span> <strong>{{ a.reserved }}</strong></div>
        </div>
        <label class="adjust-field">
          <span>Nuevo saldo on_hand</span>
          <p-inputNumber [(ngModel)]="newQuantity" [min]="0" [showButtons]="true" />
        </label>
        <label class="adjust-field">
          <span>Notas (auditoría física, etc.)</span>
          <input pInputText [(ngModel)]="adjustNotes" />
        </label>
        <div class="delta-preview" *ngIf="newQuantity !== null">
          Cambio: <strong [class.up]="delta() > 0" [class.down]="delta() < 0">{{ delta() > 0 ? '+' + delta() : delta() }}</strong> unidades
        </div>
      </div>
      <ng-template pTemplate="footer">
        <button pButton label="Cancelar" severity="secondary" [outlined]="true" (click)="dialogVisible = false"></button>
        <button pButton label="Aplicar ajuste" icon="pi pi-check"
                [loading]="saving()"
                [disabled]="newQuantity === null"
                (click)="applyAdjust()"></button>
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    :host { display:block; }

    .in-head-actions { display:flex; gap:.5rem; align-items:center; }
    .in-divider { opacity: 0.4; }
    .surf-page-sub b { font-weight: var(--fw-bold); color: var(--c-text-1); }

    /* ── FILTERS TOOLBAR ── */
    .in-filters-cell { display: flex; flex-direction: column; }
    .in-toolbar {
      display: flex;
      align-items: center;
      gap: .5rem;
      padding: .625rem .875rem;
      flex-wrap: wrap;
    }
    .in-toolbar-spacer { flex: 1; min-width: 0; }

    .in-field {
      display: inline-flex;
      align-items: center;
      height: 32px;
      min-width: 240px;
      background: var(--c-surface-1);
      border: 1px solid var(--c-divider);
      border-radius: 8px;
      padding: 0 .5rem;
      gap: .35rem;
      transition: border-color 120ms var(--ease-standard);
    }
    .in-field:focus-within {
      border-color: var(--c-text-1);
      box-shadow: 0 0 0 3px var(--c-focus-ring, rgba(0, 0, 0, 0.08));
    }
    .in-field-icon { color: var(--c-text-3); font-size: var(--fs-sm); flex-shrink: 0; }
    :host ::ng-deep .in-warehouse-select.p-select {
      flex: 1;
      border: none !important;
      background: transparent !important;
      box-shadow: none !important;
    }
    :host ::ng-deep .in-warehouse-select.p-select .p-select-label {
      padding: 0 !important;
      height: 28px !important;
      font-size: var(--fs-sm) !important;
      color: var(--c-text-1) !important;
      display: flex;
      align-items: center;
    }

    .in-reset {
      display: inline-flex;
      align-items: center;
      gap: .35rem;
      height: 32px;
      padding: 0 .75rem;
      background: transparent;
      border: 1px solid var(--c-divider);
      border-radius: 8px;
      color: var(--c-text-2);
      font-size: var(--fs-xs);
      font-weight: var(--fw-medium);
      cursor: pointer;
      transition: all 120ms var(--ease-standard);
    }
    .in-reset:hover {
      color: var(--c-text-1);
      border-color: var(--c-text-1);
      background: var(--c-surface-2);
    }

    /* ── ROW tinting: border-left sutil en vez de bg full-row ── */
    tr.in-row-low td:first-child,
    tr.in-row-zero td:first-child {
      position: relative;
    }
    tr.in-row-low td:first-child::before,
    tr.in-row-zero td:first-child::before {
      content: '';
      position: absolute;
      left: 0;
      top: 4px;
      bottom: 4px;
      width: 3px;
      border-radius: 2px;
    }
    tr.in-row-low td:first-child::before { background: var(--c-warn); }
    tr.in-row-zero td:first-child::before { background: var(--c-bad); }

    /* ── Warehouse cell: texto + icono ── */
    .in-warehouse-cell {
      display: inline-flex;
      align-items: center;
      gap: .4rem;
      font-size: var(--fs-sm);
      color: var(--c-text-1);
      white-space: nowrap;
    }
    .in-warehouse-cell i {
      color: var(--c-text-3);
      font-size: var(--fs-xs);
    }

    /* ── Numéricos: on_hand y reserved soft, available prominente ── */
    .in-num-soft { color: var(--c-text-2); font-variant-numeric: tabular-nums; }
    .in-avail-cell { font-variant-numeric: tabular-nums; }
    .in-avail-pill {
      font-size: var(--fs-body);
      font-weight: var(--fw-bold);
      min-width: 48px;
      justify-content: center;
    }

    /* ── EMPTY STATE inline en tabla ── */
    .in-empty-cell { padding: 0 !important; }
    .in-empty {
      text-align: center;
      padding: 3rem 1.5rem;
      max-width: 420px;
      margin: 0 auto;
    }
    .in-empty-icon {
      width: 56px;
      height: 56px;
      margin: 0 auto 1rem;
      border-radius: 14px;
      background: var(--c-surface-2);
      color: var(--c-text-2);
      display: grid;
      place-items: center;
      font-size: 1.5rem;
    }
    .in-empty h3 {
      margin: 0 0 .375rem;
      font-size: var(--fs-h3);
      font-weight: var(--fw-bold);
      color: var(--c-text-1);
    }
    .in-empty p {
      margin: 0 0 1rem;
      color: var(--c-text-2);
      font-size: var(--fs-sm);
      line-height: 1.4;
    }

    /* ── DIALOG ajuste de saldo ── */
    .adjust-body { display: flex; flex-direction: column; gap: 1rem; }
    .adjust-info {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: .5rem;
      padding: .75rem 1rem;
      background: var(--c-surface-2);
      border: 1px solid var(--c-divider);
      border-radius: 8px;
    }
    .adjust-info > div {
      display: flex;
      flex-direction: column;
      gap: .15rem;
      font-size: var(--fs-sm);
    }
    .adjust-info span { font-size: var(--fs-micro); color: var(--c-text-2); text-transform: uppercase; letter-spacing: .06em; font-weight: var(--fw-bold); }
    .adjust-info strong { font-size: var(--fs-body); font-weight: var(--fw-bold); color: var(--c-text-1); font-variant-numeric: tabular-nums; }
    .adjust-field {
      display: flex;
      flex-direction: column;
      gap: .3rem;
      font-size: var(--fs-micro);
      color: var(--c-text-2);
      font-weight: var(--fw-bold);
      text-transform: uppercase;
      letter-spacing: .06em;
    }
    .delta-preview {
      padding: .65rem .75rem;
      background: var(--c-surface-2);
      border: 1px solid var(--c-divider);
      border-radius: 8px;
      text-align: center;
      font-size: var(--fs-sm);
      color: var(--c-text-2);
    }
    .delta-preview strong { font-weight: var(--fw-bold); font-variant-numeric: tabular-nums; font-size: var(--fs-body); }
    .delta-preview .up { color: var(--c-ok); }
    .delta-preview .down { color: var(--c-bad); }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComercialInventoryComponent {
  private readonly api = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly auth = inject(AuthService);

  readonly canAdjust = computed(() => {
    return this.auth.user()?.permissions?.[Permission.COMMERCIAL_INVENTORY_AJUSTAR] === true;
  });

  readonly rows = signal<StockRow[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly pageSize = signal(20);
  readonly loading = signal(false);

  readonly warehouses = signal<Warehouse[]>([]);
  warehouseFilter: string | null = null;

  readonly summaryAll = signal<StockRow[]>([]);
  readonly kpis = computed(() => {
    const list = this.summaryAll();
    return {
      lines: list.length,
      critical: list.filter((r) => r.available > 0 && r.available < 20).length,
      zero: list.filter((r) => r.available <= 0).length,
      totalUnits: list.reduce((s, r) => s + Number(r.on_hand || 0), 0),
    };
  });

  readonly adjusting = signal<StockRow | null>(null);
  dialogVisible = false;
  readonly saving = signal(false);
  newQuantity: number | null = null;
  adjustNotes = '';

  constructor() {
    this.api.listWarehouses(true).subscribe({
      next: (r) => this.warehouses.set(Array.isArray(r) ? r : []),
      error: () => this.warehouses.set([]),
    });
    this.load();
    this.loadSummary();
  }

  private loadSummary(): void {
    this.api.listStock({ pageSize: 9999 }).subscribe({
      next: (r) => this.summaryAll.set(r.data || []),
      error: () => this.summaryAll.set([]),
    });
  }

  fmtUnits(n: number): string {
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(Math.round(n));
  }

  load(): void {
    this.loading.set(true);
    this.api
      .listStock({
        warehouse_id: this.warehouseFilter || undefined,
        page: this.page(),
        pageSize: this.pageSize(),
      })
      .subscribe({
        next: (r) => {
          this.rows.set(r.data || []);
          this.total.set(r.pagination?.total || 0);
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
          this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar inventario' });
        },
      });
  }

  reload(): void {
    this.page.set(1);
    this.load();
  }

  clearFilter(): void {
    this.warehouseFilter = null;
    this.reload();
  }

  /** Clase de comm-pill según disponibilidad. */
  stockPillClass(qty: number): string {
    if (qty <= 0) return 'is-bad';
    if (qty < 20) return 'is-warn';
    return 'is-active';
  }

  onLazyLoad(e: { first?: number | null; rows?: number | null }): void {
    const first = e.first ?? 0;
    const rows = e.rows ?? this.pageSize();
    this.page.set(Math.floor(first / rows) + 1);
    this.pageSize.set(rows);
    this.load();
  }

  openAdjust(s: StockRow): void {
    this.adjusting.set(s);
    this.newQuantity = s.on_hand;
    this.adjustNotes = '';
    this.dialogVisible = true;
  }

  delta(): number {
    const a = this.adjusting();
    return a && this.newQuantity !== null ? this.newQuantity - a.on_hand : 0;
  }

  applyAdjust(): void {
    const a = this.adjusting();
    if (!a || this.newQuantity === null) return;
    this.saving.set(true);
    this.api
      .adjustStock({
        warehouse_id: a.warehouse_id,
        product_id: a.product_id,
        new_quantity: this.newQuantity,
        notes: this.adjustNotes || undefined,
      })
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.dialogVisible = false;
          this.toast.add({ severity: 'success', summary: 'Stock ajustado' });
          this.load();
          this.loadSummary();
        },
        error: (err) => {
          this.saving.set(false);
          const detail = err?.error?.message || 'No se pudo ajustar';
          this.toast.add({ severity: 'error', summary: 'Error', detail });
        },
      });
  }
}
