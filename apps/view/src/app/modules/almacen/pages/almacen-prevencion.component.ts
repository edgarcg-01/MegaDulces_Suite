import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { DialogModule } from 'primeng/dialog';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { ComercialService, Warehouse } from '../../comercial/comercial.service';
import { ProductSearchComponent, ProductHit } from '../../comercial/components/product-search.component';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { PrevencionService, Investigation, InvestigationDetail, RootCause } from '../prevencion.service';
import { MonitoreoService } from '../monitoreo.service';

/**
 * Fase PREV.1 — Prevención de Inventarios (Apéndice B). Bandeja de expedientes de
 * investigación de diferencias + línea de tiempo del SKU + clasificación de causa raíz.
 * Segregación: ver = COMMERCIAL_PREVENTION_VER, operar = COMMERCIAL_PREVENTION_GESTIONAR.
 */
@Component({
  selector: 'app-almacen-prevencion',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, TagModule, SelectModule, InputTextModule, DialogModule, ToastModule, ProductSearchComponent],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Prevención de inventarios</h1>
          <p class="surf-page-sub">Expediente de investigación de diferencias — por qué falta + causa raíz + línea de tiempo</p>
        </div>
        <div class="pv-head-actions">
          <p-select [options]="statusOptions" [(ngModel)]="statusFilter" optionLabel="label" optionValue="value" (onChange)="reload()" styleClass="pv-status"></p-select>
          @if (canManage()) {
            <span class="pv-fromcount">
              <input pInputText [(ngModel)]="fromCountRef" placeholder="Folio de conteo (INV-…)" />
              <button pButton size="small" severity="secondary" [outlined]="true" (click)="importFromCount()" [loading]="importing()" [disabled]="!fromCountRef.trim()">Importar diferencias</button>
            </span>
            <button pButton size="small" (click)="openManual()"><span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span> Abrir</button>
          }
        </div>
      </header>

      <div class="pv-layout">
        <!-- Master -->
        <section class="pv-master surf-card">
          <p-table [value]="items()" [loading]="loading()" styleClass="p-datatable-sm surf-table surf-table--zebra" [scrollable]="true" scrollHeight="flex" dataKey="id">
            <ng-template #header>
              <tr><th scope="col">Folio</th><th scope="col">Producto</th><th scope="col" class="num">Dif.</th><th scope="col" class="num">Valor</th><th scope="col">Estado</th><th scope="col">Causa</th></tr>
            </ng-template>
            <ng-template #body let-i>
              <tr class="pv-row-click" (click)="select(i)" [class.pv-sel]="selected()?.id === i.id">
                <td class="pv-mono">{{ i.folio }}</td>
                <td class="pv-name">{{ i.product_name || i.product_id }}</td>
                <td class="num" [class.pv-neg]="+i.difference < 0">{{ i.difference }}</td>
                <td class="num">{{ i.value_at_cost | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                <td><p-tag [value]="statusLabel(i.status)" [severity]="statusSeverity(i.status)"></p-tag></td>
                <td class="pv-mono">{{ i.root_cause || '—' }}</td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="6" class="comm-empty-cell"><div class="comm-empty"><div class="comm-empty-icon"><i class="pi pi-shield" aria-hidden="true"></i></div><h3>Sin expedientes</h3><p>Importá las diferencias de un folio de conteo reconciliado o abrí uno manual.</p></div></td></tr>
            </ng-template>
          </p-table>
        </section>

        <!-- Detail -->
        <section class="pv-detail">
          @if (detail(); as d) {
            <div class="surf-card">
              <div class="pv-detail-head">
                <div>
                  <h2 class="pv-h2">{{ d.folio }}</h2>
                  <p class="pv-sub">{{ d.sku || '' }} · {{ d.product_name || d.product_id }} · {{ d.warehouse_code }}</p>
                </div>
                <p-tag [value]="statusLabel(d.status)" [severity]="statusSeverity(d.status)"></p-tag>
              </div>
              <div class="pv-facts">
                <div class="pv-fact"><span class="pv-fact-l">Teórico</span><span class="pv-fact-n">{{ d.expected_qty }}</span></div>
                <div class="pv-fact"><span class="pv-fact-l">Físico</span><span class="pv-fact-n">{{ d.physical_qty }}</span></div>
                <div class="pv-fact"><span class="pv-fact-l">Diferencia</span><span class="pv-fact-n" [class.pv-neg]="+d.difference < 0">{{ d.difference }}</span></div>
                <div class="pv-fact"><span class="pv-fact-l">Valor</span><span class="pv-fact-n">{{ d.value_at_cost | currency:'MXN':'symbol-narrow':'1.0-0' }}</span></div>
              </div>

              @if (canManage() && d.status !== 'resolved') {
                <div class="pv-actions">
                  <div class="pv-row">
                    <p-select [options]="rootCauseOptions" [(ngModel)]="chosenCause" optionLabel="label" optionValue="value" placeholder="Causa raíz" styleClass="pv-cause"></p-select>
                    <button pButton size="small" severity="secondary" (click)="classify(d)" [disabled]="!chosenCause" [loading]="acting()">Clasificar</button>
                  </div>
                  <input pInputText [(ngModel)]="resolveNotes" placeholder="Notas de resolución" class="pv-notes" />
                  <div class="pv-row">
                    <button pButton size="small" (click)="resolve(d)" [loading]="acting()"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span> Resolver</button>
                    <button pButton size="small" severity="warn" [outlined]="true" (click)="monitoring(d)" [loading]="acting()" title="Pérdida no identificada → monitoreo intensivo"><span class="p-button-icon p-button-icon-left pi pi-eye" aria-hidden="true"></span> Monitoreo (PNI)</button>
                  </div>
                </div>
              }
              @if (d.status === 'resolved') {
                <div class="pv-resolved"><i class="pi pi-check-circle" aria-hidden="true"></i> Resuelto — causa <strong>{{ d.root_cause }}</strong>. {{ d.resolution_notes }}</div>
              }
            </div>

            <div class="surf-card">
              <h2 class="pv-h2">Línea de tiempo del SKU</h2>
              <p-table [value]="d.timeline" styleClass="p-datatable-sm surf-table" [scrollable]="true" scrollHeight="380px">
                <ng-template #header><tr><th scope="col">Fecha</th><th scope="col">Movimiento</th><th scope="col" class="num">Cant.</th><th scope="col">Ref / Folio</th><th scope="col">Origen</th></tr></ng-template>
                <ng-template #body let-e>
                  <tr>
                    <td class="pv-mono">{{ e.ts | date:'dd/MM/yy HH:mm' }}</td>
                    <td>{{ e.kind }}</td>
                    <td class="num" [class.pv-neg]="+e.signed_qty < 0">{{ e.signed_qty != null ? e.signed_qty : e.quantity }}</td>
                    <td class="pv-mono">{{ e.folio || e.reference_type || '—' }}</td>
                    <td><p-tag [value]="e.source === 'erp' ? 'ERP' : 'App'" [severity]="e.source === 'erp' ? 'secondary' : 'info'"></p-tag></td>
                  </tr>
                </ng-template>
                <ng-template #emptymessage><tr><td colspan="5" class="comm-empty-cell"><div class="comm-empty"><p>Sin movimientos para este SKU en este almacén.</p></div></td></tr></ng-template>
              </p-table>
            </div>
          } @else {
            <div class="surf-card pv-placeholder"><div class="comm-empty"><div class="comm-empty-icon"><i class="pi pi-arrow-left" aria-hidden="true"></i></div><h3>Elegí un expediente</h3><p>Seleccioná una diferencia para investigar su línea de tiempo y clasificar la causa.</p></div></div>
          }
        </section>
      </div>

      <!-- Abrir manual -->
      <p-dialog [visible]="manualOpen()" (visibleChange)="manualOpen.set($event)" [modal]="true" [style]="{ width: '520px' }" header="Abrir expediente manual" [dismissableMask]="true">
        <div class="pv-form">
          <label class="pv-field"><span>Almacén *</span>
            <p-select [options]="warehouseOptions()" [(ngModel)]="mWarehouse" optionLabel="label" optionValue="value" placeholder="Elegí" styleClass="pv-cause"></p-select>
          </label>
          <label class="pv-field"><span>Producto *</span><app-product-search (productSelected)="mProduct = $event"></app-product-search></label>
          <div class="pv-row">
            <label class="pv-field"><span>Teórico</span><input pInputText type="number" [(ngModel)]="mExpected" /></label>
            <label class="pv-field"><span>Físico</span><input pInputText type="number" [(ngModel)]="mPhysical" /></label>
            <label class="pv-field"><span>Costo unit.</span><input pInputText type="number" [(ngModel)]="mCost" /></label>
          </div>
          <button pButton (click)="createManual()" [disabled]="!mWarehouse || !mProduct || mExpected == null || mPhysical == null" [loading]="acting()"><span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span> Abrir expediente</button>
        </div>
      </p-dialog>
    </div>
  `,
  styles: [`
    .pv-head-actions { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
    .pv-fromcount { display: flex; gap: .35rem; align-items: center; }
    .pv-fromcount input[pInputText] { width: 200px; }
    :host ::ng-deep .pv-status { min-width: 150px; }
    :host ::ng-deep .pv-cause { width: 100%; min-width: 180px; }
    .pv-layout { display: grid; grid-template-columns: minmax(360px, 1fr) minmax(360px, 1fr); gap: 1rem; align-items: start; }
    @media (max-width: 980px) { .pv-layout { grid-template-columns: 1fr; } }
    .surf-card { background: var(--surface-card, var(--surface-0)); border: 1px solid var(--surface-border); border-radius: var(--radius-lg, 12px); padding: 1rem; margin-bottom: 1rem; }
    .pv-detail { display: flex; flex-direction: column; }
    .pv-h2 { font-size: .95rem; font-weight: 700; margin: 0 0 .25rem; }
    .pv-sub { font-size: .82rem; color: var(--text-color-secondary); margin: 0; }
    .pv-detail-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: .75rem; }
    .pv-facts { display: grid; grid-template-columns: repeat(4, 1fr); gap: .5rem; margin-bottom: 1rem; }
    .pv-fact { display: flex; flex-direction: column; background: var(--surface-ground, var(--surface-50)); border-radius: 8px; padding: .5rem .6rem; }
    .pv-fact-l { font-size: .72rem; color: var(--text-color-secondary); text-transform: uppercase; letter-spacing: .03em; }
    .pv-fact-n { font-size: 1.15rem; font-weight: 800; font-variant-numeric: tabular-nums; }
    .pv-neg { color: var(--bad-fg, #b91c1c); }
    .pv-actions { display: flex; flex-direction: column; gap: .5rem; }
    .pv-row { display: flex; gap: .5rem; align-items: center; }
    .pv-notes { width: 100%; }
    .pv-resolved { background: var(--good-soft-bg, #ecfdf5); border-radius: 8px; padding: .6rem .75rem; font-size: .85rem; }
    .pv-mono { font-family: var(--font-mono, monospace); }
    .pv-name { max-width: 220px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pv-sel { background: var(--highlight-bg, rgba(0,0,0,.04)); }
    .pv-row-click { cursor: pointer; }
    .pv-form { display: flex; flex-direction: column; gap: .25rem; }
    .pv-field { display: flex; flex-direction: column; gap: .25rem; margin-bottom: .75rem; }
    .pv-field > span { font-size: .8rem; color: var(--text-color-secondary); font-weight: 600; }
    .pv-field input[pInputText] { width: 100%; }
    .pv-placeholder { min-height: 200px; display: flex; align-items: center; justify-content: center; }
  `],
})
export class AlmacenPrevencionComponent implements OnInit {
  private readonly svc = inject(PrevencionService);
  private readonly monitoreo = inject(MonitoreoService);
  private readonly comercial = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);

  readonly items = signal<Investigation[]>([]);
  readonly detail = signal<InvestigationDetail | null>(null);
  readonly selected = signal<Investigation | null>(null);
  selectedRow: Investigation | null = null;
  readonly loading = signal(false);
  readonly acting = signal(false);
  readonly importing = signal(false);
  statusFilter = 'open';
  fromCountRef = '';
  chosenCause: RootCause | null = null;
  resolveNotes = '';

  readonly statusOptions = [
    { label: 'Abiertos', value: 'open' },
    { label: 'En investigación', value: 'investigating' },
    { label: 'En monitoreo', value: 'monitoring' },
    { label: 'Resueltos', value: 'resolved' },
    { label: 'Todos', value: '' },
  ];
  readonly rootCauseOptions = [
    { label: 'EC · Error de conteo', value: 'EC' },
    { label: 'ER · Error de recepción', value: 'ER' },
    { label: 'EA · Error de aplicación', value: 'EA' },
    { label: 'DC · Devolución de cliente', value: 'DC' },
    { label: 'DP · Devolución a proveedor', value: 'DP' },
    { label: 'TR · Transferencia', value: 'TR' },
    { label: 'UB · Ubicación', value: 'UB' },
    { label: 'MR · Merma', value: 'MR' },
    { label: 'PNI · Pérdida no identificada', value: 'PNI' },
  ];

  // manual open
  readonly manualOpen = signal(false);
  readonly warehouses = signal<Warehouse[]>([]);
  readonly warehouseOptions = computed(() => this.warehouses().map((w) => ({ label: `${w.code} · ${w.name}`, value: w.id })));
  mWarehouse = '';
  mProduct: ProductHit | null = null;
  mExpected: number | null = null;
  mPhysical: number | null = null;
  mCost: number | null = null;

  ngOnInit(): void {
    this.comercial.listWarehouses().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (ws: Warehouse[]) => this.warehouses.set(ws || []),
      error: () => this.warehouses.set([]),
    });
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.svc.list({ status: this.statusFilter || undefined, limit: 200 }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => { this.items.set(rows || []); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }

  select(row: Investigation): void {
    this.selected.set(row);
    this.chosenCause = row.root_cause || null;
    this.resolveNotes = '';
    this.svc.detail(row.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => this.detail.set(d),
      error: (e) => this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo cargar' }),
    });
  }

  importFromCount(): void {
    if (!this.fromCountRef.trim()) return;
    this.importing.set(true);
    this.svc.fromCount(this.fromCountRef.trim()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.importing.set(false); this.toast.add({ severity: 'success', summary: 'Importado', detail: `${r.created} expediente(s) de ${r.count_folio}` }); this.fromCountRef = ''; this.reload(); },
      error: (e) => { this.importing.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo importar' }); },
    });
  }

  classify(d: InvestigationDetail): void {
    if (!this.chosenCause) return;
    this.acting.set(true);
    this.svc.classify(d.id, this.chosenCause, this.resolveNotes?.trim() || undefined).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => { this.acting.set(false); this.detail.set(res); this.toast.add({ severity: 'success', summary: 'Clasificado' }); this.reload(); },
      error: (e) => { this.acting.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo clasificar' }); },
    });
  }

  resolve(d: InvestigationDetail): void {
    this.acting.set(true);
    this.svc.resolve(d.id, { root_cause: this.chosenCause || undefined, resolution_notes: this.resolveNotes?.trim() || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (res) => { this.acting.set(false); this.detail.set(res); this.toast.add({ severity: 'success', summary: 'Resuelto' }); this.reload(); },
        error: (e) => { this.acting.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo resolver' }); },
      });
  }

  monitoring(d: InvestigationDetail): void {
    this.acting.set(true);
    // Inicia un monitoreo intensivo real del SKU; el backend marca el expediente como 'monitoring'.
    this.monitoreo.start({ source_investigation_id: d.id, warehouse_id: d.warehouse_id, product_id: d.product_id, reason: 'Pérdida no identificada' })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: () => { this.acting.set(false); this.toast.add({ severity: 'info', summary: 'En monitoreo intensivo', detail: 'Se abrió un monitoreo para el SKU' }); this.select(d); this.reload(); },
        error: (e) => { this.acting.set(false); this.toast.add({ severity: e?.status === 409 ? 'warn' : 'error', summary: e?.status === 409 ? 'Ya en monitoreo' : 'Error', detail: e?.error?.message || 'No se pudo' }); },
      });
  }

  openManual(): void { this.manualOpen.set(true); }
  createManual(): void {
    if (!this.mWarehouse || !this.mProduct || this.mExpected == null || this.mPhysical == null) return;
    this.acting.set(true);
    this.svc.open({
      warehouse_id: this.mWarehouse,
      product_id: this.mProduct.id,
      expected_qty: Number(this.mExpected),
      physical_qty: Number(this.mPhysical),
      unit_cost: this.mCost != null ? Number(this.mCost) : undefined,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (row) => {
        this.acting.set(false); this.manualOpen.set(false);
        this.mProduct = null; this.mExpected = null; this.mPhysical = null; this.mCost = null;
        this.toast.add({ severity: 'success', summary: 'Expediente abierto', detail: row.folio });
        this.reload();
      },
      error: (e) => { this.acting.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo abrir' }); },
    });
  }

  canManage(): boolean {
    return this.perms.can('manage', 'all') || !!this.auth.user()?.permissions?.[Permission.COMMERCIAL_PREVENTION_GESTIONAR];
  }

  statusLabel(s: string): string {
    return s === 'open' ? 'Abierto' : s === 'investigating' ? 'Investigando' : s === 'monitoring' ? 'Monitoreo' : 'Resuelto';
  }
  statusSeverity(s: string): 'danger' | 'warn' | 'secondary' | 'success' {
    return s === 'open' ? 'danger' : s === 'investigating' ? 'warn' : s === 'monitoring' ? 'secondary' : 'success';
  }
}
