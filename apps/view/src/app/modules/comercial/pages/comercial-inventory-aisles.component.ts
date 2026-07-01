import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { MessageService, ConfirmationService } from 'primeng/api';
import { ComercialService, WarehouseAisle, AisleBrand, Warehouse } from '../comercial.service';
import { Permission } from '../../../core/constants/permissions';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { INVENTORY_TABS } from '../inventory-tabs';

/**
 * Fase PA.1b — Editor 2D de pasillos. Surface Operations (DESIGN.md): page-head
 * Hanken bold, grilla CSS (celda = pasillo, sin librería de mapas), in-page sin
 * sombra, tabular-nums, acción sunset / ghost. Define el LAYOUT (pasillos + posición
 * + mapeo bulk SKU→pasillo). El staffing por folio es PA.3.
 */
@Component({
  selector: 'app-comercial-inventory-aisles',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, SelectModule, DialogModule, InputTextModule, InputNumberModule, TagModule, ToastModule, ConfirmDialogModule, PageTabsComponent],
  providers: [MessageService, ConfirmationService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <p-confirmDialog></p-confirmDialog>
      <app-page-tabs [tabs]="inventoryTabs" />

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Pasillos</h1>
          <p class="surf-page-sub">Layout 2D del almacén — ubicá los pasillos y mapeá qué SKUs viven en cada uno</p>
        </div>
        <div class="pa-head-actions">
          <p-select [options]="whOptions()" [(ngModel)]="warehouseId" optionLabel="label" optionValue="value"
                    placeholder="Elegí un almacén" (onChange)="load()" styleClass="pa-wh" ariaLabel="Almacén"></p-select>
          <button pButton type="button" label="Nuevo pasillo" icon="pi pi-plus" size="small"
                  (click)="openCreate()" [disabled]="!warehouseId()"></button>
        </div>
      </header>

      @if (!warehouseId()) {
        <div class="pa-empty">Elegí un almacén para ver y editar sus pasillos.</div>
      } @else {
        <div class="pa-body">
          <!-- Grilla 2D -->
          <div class="pa-grid-wrap">
            @if (aisles().length === 0) {
              <div class="pa-empty">Este almacén no tiene pasillos. Creá el primero con <b>Nuevo pasillo</b>; luego mapeá SKUs (por marca / clase ABC / rango).</div>
            } @else {
              <div class="pa-grid" [style.gridTemplateColumns]="'repeat(' + cols() + ', minmax(120px, 1fr))'">
                @for (a of aisles(); track a.id) {
                  <button type="button" class="pa-cell" [class.sel]="selected()?.id === a.id"
                          [style.gridColumn]="(a.grid_col + 1) + ' / span ' + a.span_cols"
                          [style.gridRow]="(a.grid_row + 1) + ' / span ' + a.span_rows"
                          (click)="select(a)" [attr.aria-pressed]="selected()?.id === a.id">
                    <span class="pa-cell-code">{{ a.code }}</span>
                    <span class="pa-cell-name">{{ a.name || '—' }}</span>
                    <span class="pa-cell-load">{{ a.units || 0 }} u · {{ a.sku_count || 0 }} SKU</span>
                    <span class="pa-loadbar"><span class="pa-loadbar-fill" [style.width.%]="loadPct(a)"></span></span>
                  </button>
                }
              </div>
            }
            <div class="pa-unassigned" [class.warn]="(unassigned().sku_count || 0) > 0">
              <span class="pa-un-l">Sin pasillo</span>
              <span class="pa-un-v">{{ unassigned().sku_count || 0 }} SKU · {{ unassigned().units || 0 }} u</span>
            </div>
          </div>

          <!-- Panel del pasillo seleccionado -->
          @if (selected(); as sel) {
            <aside class="pa-panel">
              <div class="pa-panel-head">
                <h2>{{ sel.code }}</h2>
                <button pButton type="button" icon="pi pi-times" [text]="true" size="small" (click)="selected.set(null)" ariaLabel="Cerrar"></button>
              </div>
              <p class="pa-panel-load">{{ sel.units || 0 }} unidades · {{ sel.sku_count || 0 }} SKUs</p>

              <label class="pa-fld">Nombre
                <input pInputText [(ngModel)]="editName" />
              </label>
              <div class="pa-fld-row">
                <label class="pa-fld">Fila <p-inputNumber [(ngModel)]="editRow" [min]="0" [showButtons]="false" inputStyleClass="pa-num"></p-inputNumber></label>
                <label class="pa-fld">Col <p-inputNumber [(ngModel)]="editCol" [min]="0" [showButtons]="false" inputStyleClass="pa-num"></p-inputNumber></label>
              </div>
              <div class="pa-panel-actions">
                <button pButton type="button" label="Guardar" icon="pi pi-check" size="small" (click)="saveEdit()" [loading]="working()"></button>
                <button pButton type="button" label="Borrar" icon="pi pi-trash" [text]="true" severity="danger" size="small" (click)="confirmDelete()"></button>
              </div>

              <hr class="pa-sep" />

              <h3 class="pa-asg-h">Asignar SKUs a {{ sel.code }}</h3>
              <p-select [options]="assignModes" [(ngModel)]="assignMode" optionLabel="label" optionValue="value" styleClass="pa-mode" ariaLabel="Tipo de filtro"></p-select>
              @switch (assignMode()) {
                @case ('brand') {
                  <p-select [options]="brands()" [(ngModel)]="brandId" optionLabel="nombre" optionValue="id" [filter]="true"
                            placeholder="Elegí una marca" styleClass="pa-mode" ariaLabel="Marca"></p-select>
                }
                @case ('abc') {
                  <p-select [options]="abcOptions" [(ngModel)]="abcClass" optionLabel="label" optionValue="value" styleClass="pa-mode" ariaLabel="Clase ABC"></p-select>
                }
                @case ('range') {
                  <div class="pa-fld-row">
                    <input pInputText [(ngModel)]="skuFrom" placeholder="SKU desde" />
                    <input pInputText [(ngModel)]="skuTo" placeholder="SKU hasta" />
                  </div>
                }
              }
              <label class="pa-chk"><input type="checkbox" [(ngModel)]="onlyUnassigned" /> Solo SKUs sin pasillo</label>
              <button pButton type="button" label="Asignar a este pasillo" icon="pi pi-arrow-right" size="small" class="pa-asg-btn"
                      (click)="doAssign()" [loading]="working()"></button>
              <p class="pa-asg-hint">Mueve los SKUs que matcheen el filtro a <b>{{ sel.code }}</b> (los saca de su pasillo actual).</p>
            </aside>
          }
        </div>
      }

      <!-- Dialog nuevo pasillo -->
      <p-dialog header="Nuevo pasillo" [(visible)]="showCreate" [modal]="true" [style]="{ width: '26rem' }">
        <div class="pa-dlg">
          <label class="pa-fld">Código <input pInputText [(ngModel)]="newCode" placeholder="P-01" /></label>
          <label class="pa-fld">Nombre <input pInputText [(ngModel)]="newName" placeholder="Pasillo 1" /></label>
          <div class="pa-fld-row">
            <label class="pa-fld">Fila <p-inputNumber [(ngModel)]="newRow" [min]="0" inputStyleClass="pa-num"></p-inputNumber></label>
            <label class="pa-fld">Col <p-inputNumber [(ngModel)]="newCol" [min]="0" inputStyleClass="pa-num"></p-inputNumber></label>
          </div>
        </div>
        <ng-template pTemplate="footer">
          <button pButton type="button" label="Cancelar" [text]="true" size="small" (click)="showCreate.set(false)"></button>
          <button pButton type="button" label="Crear" icon="pi pi-check" size="small" (click)="saveCreate()" [loading]="working()" [disabled]="!newCode().trim()"></button>
        </ng-template>
      </p-dialog>
    </div>
  `,
  styles: [`
    .pa-head-actions { display: flex; gap: .5rem; align-items: center; }
    :host ::ng-deep .pa-wh { min-width: 240px; }
    .pa-empty { text-align: center; padding: 2.5rem 1rem; color: var(--text-muted); line-height: 1.5; border: 1px dashed var(--border-color); border-radius: var(--r-md, 12px); }
    .pa-body { display: flex; gap: 1rem; align-items: flex-start; }
    .pa-grid-wrap { flex: 1; min-width: 0; }
    .pa-grid { display: grid; gap: .5rem; margin-bottom: 1rem; }
    .pa-cell { display: flex; flex-direction: column; align-items: flex-start; gap: .15rem; text-align: left; cursor: pointer;
      background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md, 12px); padding: .6rem .7rem; min-height: 76px; transition: border-color 120ms, box-shadow 120ms; }
    .pa-cell:hover { border-color: var(--action); }
    .pa-cell.sel { border-color: var(--action); box-shadow: 0 0 0 2px var(--action-ring); }
    .pa-cell-code { font-weight: 700; font-size: .9rem; color: var(--text-main); }
    .pa-cell-name { font-size: .75rem; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
    .pa-cell-load { font-size: .7rem; color: var(--text-faint); font-variant-numeric: tabular-nums; font-family: var(--font-mono, monospace); margin-top: auto; }
    .pa-loadbar { width: 100%; height: 4px; border-radius: 999px; background: var(--surface-ground); overflow: hidden; }
    .pa-loadbar-fill { display: block; height: 100%; background: var(--action); }
    .pa-unassigned { display: inline-flex; flex-direction: column; gap: .15rem; border: 1px dashed var(--border-color); border-radius: var(--r-md, 12px); padding: .5rem .8rem; }
    .pa-unassigned.warn { border-color: var(--warn-fg); }
    .pa-un-l { font-size: .6875rem; text-transform: uppercase; letter-spacing: .05em; color: var(--text-muted); font-weight: 600; }
    .pa-un-v { font-variant-numeric: tabular-nums; font-family: var(--font-mono, monospace); font-size: .85rem; }
    .pa-panel { width: 300px; flex-shrink: 0; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md, 12px); padding: 1rem; position: sticky; top: 1rem; }
    .pa-panel-head { display: flex; justify-content: space-between; align-items: center; }
    .pa-panel-head h2 { font-size: 1.1rem; font-weight: 700; margin: 0; }
    .pa-panel-load { font-size: .8rem; color: var(--text-muted); font-variant-numeric: tabular-nums; margin: .15rem 0 .75rem; }
    .pa-fld { display: flex; flex-direction: column; gap: .2rem; font-size: .75rem; color: var(--text-muted); margin-bottom: .5rem; }
    .pa-fld input, :host ::ng-deep .pa-fld .p-inputnumber input { width: 100%; }
    .pa-fld-row { display: flex; gap: .5rem; }
    .pa-panel-actions { display: flex; gap: .5rem; margin-top: .25rem; }
    .pa-sep { border: none; border-top: 1px solid var(--border-color); margin: 1rem 0; }
    .pa-asg-h { font-size: .8125rem; font-weight: 600; margin: 0 0 .5rem; }
    :host ::ng-deep .pa-mode { width: 100%; margin-bottom: .5rem; }
    .pa-chk { display: flex; align-items: center; gap: .4rem; font-size: .8rem; color: var(--text-muted); margin: .25rem 0 .6rem; }
    .pa-asg-btn { width: 100%; }
    .pa-asg-hint { font-size: .7rem; color: var(--text-faint); margin-top: .5rem; line-height: 1.4; }
    .pa-dlg { display: flex; flex-direction: column; gap: .25rem; padding-top: .5rem; }
  `],
})
export class ComercialInventoryAislesComponent {
  readonly inventoryTabs = INVENTORY_TABS;
  readonly assignModes = [
    { label: 'Por marca', value: 'brand' },
    { label: 'Por clase ABC', value: 'abc' },
    { label: 'Por rango de SKU', value: 'range' },
    { label: 'Todo lo sin pasillo', value: 'unassigned' },
  ];
  readonly abcOptions = [{ label: 'A', value: 'A' }, { label: 'B', value: 'B' }, { label: 'C', value: 'C' }];

  private readonly svc = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);
  private readonly destroyRef = inject(DestroyRef);

  loading = signal(false);
  working = signal(false);
  warehouseId = signal<string | null>(null);
  whOptions = signal<{ label: string; value: string }[]>([]);
  aisles = signal<WarehouseAisle[]>([]);
  unassigned = signal<{ sku_count: number; units: number | string }>({ sku_count: 0, units: 0 });
  brands = signal<AisleBrand[]>([]);
  selected = signal<WarehouseAisle | null>(null);

  cols = computed(() => Math.max(4, ...this.aisles().map((a) => a.grid_col + a.span_cols)));
  private maxUnits = computed(() => Math.max(1, ...this.aisles().map((a) => Number(a.units) || 0)));

  // create dialog
  showCreate = signal(false);
  newCode = signal(''); newName = signal(''); newRow = signal(0); newCol = signal(0);
  // edit panel
  editName = signal<string>(''); editRow = signal(0); editCol = signal(0);
  // assign form
  assignMode = signal<'brand' | 'abc' | 'range' | 'unassigned'>('brand');
  brandId = signal<string | null>(null); abcClass = signal<string | null>(null);
  skuFrom = signal(''); skuTo = signal(''); onlyUnassigned = signal(false);

  constructor() {
    this.svc.listWarehouses()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (ws: Warehouse[]) => this.whOptions.set(ws.map((w) => ({ label: `${w.code} · ${w.name}`, value: w.id }))) });
  }

  load() {
    const wh = this.warehouseId();
    this.selected.set(null);
    if (!wh) { this.aisles.set([]); return; }
    this.loading.set(true);
    this.svc.listAisles(wh).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.aisles.set(r.aisles || []); this.unassigned.set(r.unassigned || { sku_count: 0, units: 0 }); this.loading.set(false); },
      error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error al cargar pasillos' }); },
    });
    this.svc.aisleBrands(wh).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (b) => this.brands.set(b || []) });
  }

  loadPct(a: WarehouseAisle): number { return Math.round((Number(a.units) || 0) / this.maxUnits() * 100); }

  select(a: WarehouseAisle) {
    this.selected.set(a);
    this.editName.set(a.name || ''); this.editRow.set(a.grid_row); this.editCol.set(a.grid_col);
    this.assignMode.set('brand'); this.brandId.set(null); this.abcClass.set(null);
    this.skuFrom.set(''); this.skuTo.set(''); this.onlyUnassigned.set(false);
  }

  openCreate() {
    this.newCode.set(''); this.newName.set(''); this.newRow.set(0); this.newCol.set(0);
    this.showCreate.set(true);
  }

  saveCreate() {
    const wh = this.warehouseId(); if (!wh) return;
    this.working.set(true);
    this.svc.createAisle({ warehouse_id: wh, code: this.newCode().trim(), name: this.newName().trim() || undefined, grid_row: this.newRow(), grid_col: this.newCol() })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: () => { this.working.set(false); this.showCreate.set(false); this.toast.add({ severity: 'success', summary: 'Pasillo creado' }); this.load(); },
        error: (e) => { this.working.set(false); this.toast.add({ severity: 'error', summary: 'No se pudo crear', detail: e?.error?.message }); },
      });
  }

  saveEdit() {
    const sel = this.selected(); if (!sel) return;
    this.working.set(true);
    this.svc.updateAisle(sel.id, { name: this.editName(), grid_row: this.editRow(), grid_col: this.editCol() })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: () => { this.working.set(false); this.toast.add({ severity: 'success', summary: 'Guardado' }); this.load(); },
        error: () => { this.working.set(false); this.toast.add({ severity: 'error', summary: 'No se pudo guardar' }); },
      });
  }

  confirmDelete() {
    const sel = this.selected(); if (!sel) return;
    this.confirm.confirm({
      header: 'Borrar pasillo',
      message: `¿Borrar el pasillo ${sel.code}? Sus SKUs quedarán "Sin pasillo" (no se borra stock).`,
      acceptLabel: 'Borrar', rejectLabel: 'Cancelar',
      accept: () => {
        this.working.set(true);
        this.svc.deleteAisle(sel.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
          next: () => { this.working.set(false); this.selected.set(null); this.toast.add({ severity: 'success', summary: 'Pasillo borrado' }); this.load(); },
          error: (e) => { this.working.set(false); this.toast.add({ severity: 'error', summary: 'No se pudo borrar', detail: e?.error?.message }); },
        });
      },
    });
  }

  doAssign() {
    const sel = this.selected(); const wh = this.warehouseId(); if (!sel || !wh) return;
    const mode = this.assignMode();
    const filter: any = {};
    if (mode === 'brand') { if (!this.brandId()) return this.toast.add({ severity: 'warn', summary: 'Elegí una marca' }); filter.brand_id = this.brandId(); }
    else if (mode === 'abc') { if (!this.abcClass()) return this.toast.add({ severity: 'warn', summary: 'Elegí una clase' }); filter.abc_class = this.abcClass(); }
    else if (mode === 'range') { if (!this.skuFrom() || !this.skuTo()) return this.toast.add({ severity: 'warn', summary: 'Completá el rango' }); filter.sku_from = this.skuFrom(); filter.sku_to = this.skuTo(); }
    else if (mode === 'unassigned') { filter.only_unassigned = true; }
    if (this.onlyUnassigned() && mode !== 'unassigned') filter.only_unassigned = true;
    this.working.set(true);
    this.svc.assignSkusToAisle({ warehouse_id: wh, aisle_id: sel.id, filter })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => { this.working.set(false); this.toast.add({ severity: 'success', summary: `${r.updated} SKUs asignados a ${sel.code}` }); this.load(); },
        error: (e) => { this.working.set(false); this.toast.add({ severity: 'error', summary: 'No se pudo asignar', detail: e?.error?.message }); },
      });
  }
}
