import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
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
import { MessageService } from 'primeng/api';
import { ComercialService, StockRow, Warehouse } from '../comercial.service';

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
  ],
  providers: [MessageService],
  template: `
    <p-toast></p-toast>

    <div class="header-row">
      <div>
        <h2>Inventario</h2>
        <p class="muted">Saldo on-hand / reservado / disponible por almacén. {{ total() }} líneas de stock.</p>
      </div>
    </div>

    <p-card>
      <div class="filters">
        <label>
          Almacén
          <p-select
            [options]="warehouses()"
            [(ngModel)]="warehouseFilter"
            (onChange)="reload()"
            optionLabel="name"
            optionValue="id"
            [showClear]="true"
            placeholder="Todos"
            styleClass="filter-select"
          ></p-select>
        </label>
      </div>

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
            <th class="num">On hand</th>
            <th class="num">Reservado</th>
            <th class="num">Disponible</th>
            <th></th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-s>
          <tr [class.low]="s.available < 20 && s.available >= 0" [class.zero]="s.available <= 0">
            <td>{{ s.warehouse_name || s.warehouse_id }}</td>
            <td>
              <div class="strong">{{ s.product_name || s.product_id }}</div>
              <div class="muted small" *ngIf="s.brand_name">{{ s.brand_name }}</div>
            </td>
            <td class="num">{{ s.on_hand }}</td>
            <td class="num">{{ s.reserved }}</td>
            <td class="num strong">
              {{ s.available }}
              <p-tag *ngIf="s.available <= 0" severity="danger" value="Sin stock" styleClass="ml"></p-tag>
              <p-tag *ngIf="s.available > 0 && s.available < 20" severity="warn" value="Bajo" styleClass="ml"></p-tag>
            </td>
            <td class="actions">
              <button pButton icon="pi pi-pencil" size="small" severity="secondary" [text]="true"
                      pTooltip="Ajustar saldo"
                      (click)="openAdjust(s)"></button>
            </td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="6" class="muted">Sin stock registrado.</td></tr>
        </ng-template>
      </p-table>
    </p-card>

    <p-dialog
      [(visible)]="dialogVisible"
      [modal]="true"
      [draggable]="false"
      [style]="{ width: '440px' }"
      header="Ajustar saldo de stock"
    >
      <div class="adjust-body" *ngIf="adjusting() as a">
        <div class="adjust-info">
          <div><span class="muted">Almacén</span> <strong>{{ a.warehouse_name || a.warehouse_id }}</strong></div>
          <div><span class="muted">Producto</span> <strong>{{ a.product_name || a.product_id }}</strong></div>
          <div><span class="muted">Saldo actual on_hand</span> <strong>{{ a.on_hand }}</strong></div>
          <div><span class="muted">Reservado</span> <strong>{{ a.reserved }}</strong></div>
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
    .header-row h2 { margin:0 0 .25rem; font-size:1.25rem; }
    .muted { color: var(--text-color-secondary); }
    .muted.small { font-size:.8rem; }
    .strong { font-weight: 600; }
    .filters { display:flex; gap:1rem; align-items:flex-end; margin-bottom:1rem; flex-wrap:wrap; }
    .filters label { display:flex; flex-direction:column; gap:.25rem; font-size:.8rem; color:var(--text-color-secondary); }
    :host ::ng-deep .p-select.filter-select { min-width: 220px; }
    .num { text-align:right; }
    .actions { display:flex; gap:.25rem; justify-content:flex-end; }
    :host ::ng-deep .p-tag.ml { margin-left:.4rem; }
    tr.low { background: rgba(245, 158, 11, 0.08); }
    tr.zero { background: rgba(239, 68, 68, 0.12); }
    .adjust-body { display:flex; flex-direction:column; gap: 1rem; }
    .adjust-info { display:grid; grid-template-columns:1fr 1fr; gap:.5rem; padding: .75rem; background: var(--surface-100); border-radius: 6px; }
    .adjust-info > div { display:flex; flex-direction:column; gap:.15rem; font-size:.85rem; }
    .adjust-field { display:flex; flex-direction:column; gap:.25rem; font-size:.85rem; color:var(--text-color-secondary); }
    .delta-preview { padding: .5rem .75rem; background: var(--surface-100); border-radius: 6px; text-align:center; }
    .delta-preview .up { color: var(--ok-fg); }
    .delta-preview .down { color: var(--bad-fg); }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComercialInventoryComponent {
  private readonly api = inject(ComercialService);
  private readonly toast = inject(MessageService);

  readonly rows = signal<StockRow[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly pageSize = signal(20);
  readonly loading = signal(false);

  readonly warehouses = signal<Warehouse[]>([]);
  warehouseFilter: string | null = null;

  readonly adjusting = signal<StockRow | null>(null);
  dialogVisible = false;
  readonly saving = signal(false);
  newQuantity: number | null = null;
  adjustNotes = '';

  constructor() {
    this.api.listWarehouses(true).subscribe({
      next: (r) => this.warehouses.set(r.data || []),
      error: () => this.warehouses.set([]),
    });
    this.load();
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
        },
        error: (err) => {
          this.saving.set(false);
          const detail = err?.error?.message || 'No se pudo ajustar';
          this.toast.add({ severity: 'error', summary: 'Error', detail });
        },
      });
  }
}
