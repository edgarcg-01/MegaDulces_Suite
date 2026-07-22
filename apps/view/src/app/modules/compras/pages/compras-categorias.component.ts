import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { CheckboxModule, CheckboxChangeEvent } from 'primeng/checkbox';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService } from 'primeng/api';
import { ComprasService, CategoryAdmin } from '../compras.service';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';

/**
 * RA-PRO.12 — Normalización de categorías de compra (sourcing: Guadalajara/Arandas/plazas).
 * El campo `categoria` de Wincaja está sobrecargado (plaza + proveedor + tipo + estatus) y trae
 * duplicados de nombre. Aquí se ven todas (con # productos/# proveedores), se renombran, se
 * fusionan a mano y hay auto-fusión de nombres idénticos. Alimenta el filtro de Pedido/Existencia.
 * Operations: PrimeNG denso, tokens, monocromático (solo se marcan los duplicados).
 */
@Component({
  selector: 'app-compras-categorias',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, ToastModule, TagModule, DialogModule, InputTextModule, CheckboxModule, IconFieldModule, InputIconModule, TooltipModule, MetricStripComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in cat-page">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Categorías de compra</h1>
          <p class="surf-page-sub">Normaliza las categorías (plaza/sourcing). Fusiona duplicados y renombra — alimentan el filtro por categoría en Pedido y Existencia Crítica. Solo se fusionan nombres idénticos (Guadalajara ≠ Guadalajara 2).</p>
        </div>
        <div class="cat-head-actions">
          <button pButton type="button" label="Auto-fusionar duplicados" icon="pi pi-clone" class="p-button-sm p-button-outlined"
                  [loading]="deduping()" (click)="dedupeVisible.set(true)"></button>
        </div>
      </header>

      <app-metric-strip [items]="kpiItems()" ariaLabel="Resumen de categorías" />

      <div class="cat-toolbar">
        <p-iconfield styleClass="cat-search">
          <p-inputicon styleClass="pi pi-search" />
          <input pInputText type="text" [(ngModel)]="search" (ngModelChange)="onSearch($event)" placeholder="Buscar categoría o código…" aria-label="Buscar categoría" />
        </p-iconfield>
        @if (selCount() >= 2) {
          <div class="cat-mergebar">
            <span class="cat-mergebar-txt"><strong>{{ selCount() }}</strong> seleccionadas</span>
            <button pButton type="button" label="Fusionar seleccionadas" icon="pi pi-object-group" class="p-button-sm" (click)="openMerge()"></button>
            <button pButton type="button" label="Limpiar" icon="pi pi-times" class="p-button-sm p-button-text" (click)="clearSel()"></button>
          </div>
        }
      </div>

      <p-table [value]="rows()" [loading]="loading()" [scrollable]="true" scrollHeight="flex" styleClass="p-datatable-sm cat-table">
        <ng-template pTemplate="header">
          <tr>
            <th style="width:2.5rem"><p-checkbox [binary]="true" [ngModel]="allSel()" (onChange)="toggleAll($event)" ariaLabel="Seleccionar todo" /></th>
            <th style="width:6rem">Código</th>
            <th>Nombre</th>
            <th class="cat-r" style="width:8rem">Productos</th>
            <th class="cat-r" style="width:8rem">Proveedores</th>
            <th style="width:3rem"></th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-c>
          <tr [class.cat-sel]="isSel(c.id)">
            <td><p-checkbox [binary]="true" [ngModel]="isSel(c.id)" (onChange)="toggle(c.id)" [ariaLabel]="'Seleccionar ' + c.name" /></td>
            <td class="cat-mono">{{ c.code || '—' }}</td>
            <td>
              @if (editingId() === c.id) {
                <span class="cat-edit">
                  <input pInputText type="text" [(ngModel)]="editName" class="cat-edit-input" (keyup.enter)="saveRename(c)" (keyup.escape)="editingId.set(null)" />
                  <button pButton type="button" icon="pi pi-check" class="p-button-sm p-button-text" [loading]="renaming()" (click)="saveRename(c)"></button>
                  <button pButton type="button" icon="pi pi-times" class="p-button-sm p-button-text" (click)="editingId.set(null)"></button>
                </span>
              } @else {
                <span class="cat-name">{{ c.name }}</span>
                @if (c.is_duplicate) { <p-tag value="duplicado" severity="warn" styleClass="cat-dup"></p-tag> }
              }
            </td>
            <td class="cat-r">{{ c.n_products | number }}</td>
            <td class="cat-r cat-muted">{{ c.n_suppliers | number }}</td>
            <td>
              @if (editingId() !== c.id) {
                <button pButton type="button" icon="pi pi-pencil" class="p-button-sm p-button-text cat-ghost" (click)="startRename(c)" pTooltip="Renombrar" tooltipPosition="left"></button>
              }
            </td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage"><tr><td colspan="6" class="cat-empty">Sin categorías con ese filtro.</td></tr></ng-template>
      </p-table>
    </div>

    <!-- Fusionar seleccionadas -->
    <p-dialog [visible]="mergeVisible()" (visibleChange)="mergeVisible.set($event)" [modal]="true" appendTo="body"
              [style]="{ width: '36rem', maxWidth: '95vw' }" header="Fusionar categorías" [dismissableMask]="true">
      <p class="cat-dlg-sub">Elige la categoría que se <strong>conserva</strong>; las demás se fusionan en ella (sus productos se mueven y quedan inactivas).</p>
      <div class="cat-dlg-list">
        @for (c of selectedRows(); track c.id) {
          <label class="cat-dlg-row" [class.on]="mergeInto === c.id">
            <input type="radio" name="into" [value]="c.id" [(ngModel)]="mergeInto" />
            <span class="cat-mono">{{ c.code }}</span>
            <span class="cat-dlg-name">{{ c.name }}</span>
            <span class="cat-muted">{{ c.n_products }} prod</span>
          </label>
        }
      </div>
      <ng-template pTemplate="footer">
        <button pButton type="button" label="Cancelar" class="p-button-text p-button-sm" (click)="mergeVisible.set(false)"></button>
        <button pButton type="button" label="Fusionar" icon="pi pi-object-group" class="p-button-sm" [loading]="merging()" [disabled]="!mergeInto" (click)="doMerge()"></button>
      </ng-template>
    </p-dialog>

    <!-- Auto-fusionar duplicados -->
    <p-dialog [visible]="dedupeVisible()" (visibleChange)="dedupeVisible.set($event)" [modal]="true" appendTo="body"
              [style]="{ width: '34rem', maxWidth: '95vw' }" header="Auto-fusionar duplicados" [dismissableMask]="true">
      <p class="cat-dlg-sub">Fusiona automáticamente las categorías de <strong>nombre idéntico</strong>: conserva la de más productos, mueve sus productos y desactiva las demás. <strong>No toca nombres distintos</strong> (Guadalajara y Guadalajara 2 quedan separadas).</p>
      <ng-template pTemplate="footer">
        <button pButton type="button" label="Cancelar" class="p-button-text p-button-sm" (click)="dedupeVisible.set(false)"></button>
        <button pButton type="button" label="Fusionar duplicados" icon="pi pi-clone" class="p-button-sm" [loading]="deduping()" (click)="doAutoDedupe()"></button>
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    :host { display: block; }
    .cat-head-actions { display: flex; gap: .5rem; align-items: center; }
    app-metric-strip { display: block; margin-bottom: 1rem; }
    .cat-toolbar { display: flex; flex-wrap: wrap; gap: .75rem; align-items: center; margin-bottom: .75rem; }
    :host ::ng-deep .cat-search input { min-width: 18rem; }
    .cat-mergebar { display: flex; align-items: center; gap: .6rem; padding: .35rem .7rem; margin-left: auto;
      background: var(--action-ring, color-mix(in srgb, var(--action) 12%, transparent)); border-radius: var(--r-sm, 6px); }
    .cat-mergebar-txt { font-size: .82rem; color: var(--text-main); }
    .cat-table { font-size: .84rem; }
    .cat-r { text-align: right; font-variant-numeric: tabular-nums; }
    .cat-mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .78rem; color: var(--text-muted); }
    .cat-muted { color: var(--text-muted); }
    .cat-name { }
    .cat-sel { background: var(--surface-hover-bg); }
    :host ::ng-deep .cat-dup { font-size: .62rem !important; margin-left: .4rem; }
    .cat-ghost { color: var(--text-muted); }
    .cat-ghost:hover { color: var(--action); }
    .cat-edit { display: inline-flex; align-items: center; gap: .25rem; }
    :host ::ng-deep .cat-edit-input { width: 20rem; max-width: 60vw; font-size: .84rem; padding: .25rem .5rem; }
    .cat-empty { color: var(--text-muted); padding: 1rem; text-align: center; }
    .cat-dlg-sub { color: var(--text-muted); font-size: .85rem; margin-bottom: .6rem; line-height: 1.5; }
    .cat-dlg-list { display: flex; flex-direction: column; gap: .2rem; max-height: 24rem; overflow-y: auto; }
    .cat-dlg-row { display: flex; align-items: center; gap: .5rem; font-size: .84rem; padding: .35rem .5rem; border-radius: var(--r-sm, 6px); cursor: pointer; }
    .cat-dlg-row:hover { background: var(--surface-hover-bg); }
    .cat-dlg-row.on { background: var(--action-ring, color-mix(in srgb, var(--action) 12%, transparent)); }
    .cat-dlg-name { flex: 1; min-width: 0; }
  `],
})
export class ComprasCategoriasComponent implements OnInit {
  private readonly api = inject(ComprasService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  rows = signal<CategoryAdmin[]>([]);
  loading = signal(false);
  search = '';
  private selected = signal<Set<string>>(new Set());
  selCount = computed(() => this.selected().size);
  editingId = signal<string | null>(null);
  editName = '';
  renaming = signal(false);
  mergeVisible = signal(false);
  merging = signal(false);
  mergeInto = '';
  dedupeVisible = signal(false);
  deduping = signal(false);
  private readonly search$ = new Subject<string>();

  readonly kpiItems = computed<MetricStripItem[]>(() => {
    const r = this.rows();
    const dup = r.filter((c) => c.is_duplicate).length;
    return [
      { label: 'Categorías', value: r.length },
      { label: 'Con duplicado', value: dup, tone: dup > 0 ? 'warn' : 'default' },
      { label: 'Productos', value: r.reduce((s, c) => s + Number(c.n_products || 0), 0) },
    ];
  });

  ngOnInit(): void {
    this.search$.pipe(debounceTime(300), distinctUntilChanged(), takeUntilDestroyed(this.destroyRef)).subscribe(() => this.load());
    this.load();
  }

  private load(): void {
    this.loading.set(true);
    this.selected.set(new Set());
    this.api.listCategories(this.search || undefined).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.rows.set(r); this.loading.set(false); },
      error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar las categorías.' }); },
    });
  }

  onSearch(v: string): void { this.search$.next((v ?? '').trim()); }

  // Selección
  isSel(id: string): boolean { return this.selected().has(id); }
  toggle(id: string): void { this.selected.update((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
  allSel(): boolean { const r = this.rows(); return r.length > 0 && r.every((c) => this.selected().has(c.id)); }
  toggleAll(e: CheckboxChangeEvent): void { this.selected.set(e.checked ? new Set(this.rows().map((c) => c.id)) : new Set()); }
  clearSel(): void { this.selected.set(new Set()); }
  selectedRows(): CategoryAdmin[] { const s = this.selected(); return this.rows().filter((c) => s.has(c.id)).sort((a, b) => b.n_products - a.n_products); }

  // Renombrar
  startRename(c: CategoryAdmin): void { this.editingId.set(c.id); this.editName = c.name; }
  saveRename(c: CategoryAdmin): void {
    const name = (this.editName || '').trim();
    if (!name || name === c.name) { this.editingId.set(null); return; }
    this.renaming.set(true);
    this.api.renameCategory(c.id, name).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.renaming.set(false); this.editingId.set(null); this.toast.add({ severity: 'success', summary: 'Renombrada', detail: name }); this.load(); },
      error: (e) => { this.renaming.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo renombrar.' }); },
    });
  }

  // Fusionar seleccionadas
  openMerge(): void { const sr = this.selectedRows(); this.mergeInto = sr.length ? sr[0].id : ''; this.mergeVisible.set(true); }
  doMerge(): void {
    const into = this.mergeInto; if (!into) return;
    const from = this.selectedRows().map((c) => c.id).filter((id) => id !== into);
    if (!from.length) { this.toast.add({ severity: 'warn', summary: 'Nada que fusionar', detail: 'Selecciona 2 o más.' }); return; }
    this.merging.set(true);
    this.api.mergeCategories(into, from).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.merging.set(false); this.mergeVisible.set(false); this.toast.add({ severity: 'success', summary: `Fusionadas en ${r.into}`, detail: `${r.merged} categoría(s) · ${r.products_repointed} productos movidos` }); this.load(); },
      error: (e) => { this.merging.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo fusionar.' }); },
    });
  }

  // Auto-fusionar duplicados de nombre idéntico
  doAutoDedupe(): void {
    this.deduping.set(true);
    this.api.autoDedupCategories().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.deduping.set(false); this.dedupeVisible.set(false);
        this.toast.add({ severity: r.groups ? 'success' : 'info', summary: r.groups ? `${r.groups} grupo(s) fusionado(s)` : 'Sin duplicados', detail: r.groups ? `${r.merged} categorías · ${r.products_repointed} productos movidos` : 'No había nombres idénticos.' });
        this.load();
      },
      error: (e) => { this.deduping.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo auto-fusionar.' }); },
    });
  }
}
