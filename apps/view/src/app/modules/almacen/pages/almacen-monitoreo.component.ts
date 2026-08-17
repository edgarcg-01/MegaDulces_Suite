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
import { MonitoreoService, Monitoring, MonitoringDetail } from '../monitoreo.service';

/**
 * Fase PREV.2 — Monitoreo intensivo + ventanas de pérdida (Apéndice B). Bandeja de
 * SKUs en monitoreo + captura de conteos rápidos; cada conteo acota la ventana temporal
 * de la pérdida. Ver = COMMERCIAL_PREVENTION_VER, operar = COMMERCIAL_PREVENTION_GESTIONAR.
 */
@Component({
  selector: 'app-almacen-monitoreo',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, TagModule, SelectModule, InputTextModule, DialogModule, ToastModule, ProductSearchComponent],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Monitoreo intensivo</h1>
          <p class="surf-page-sub">Conteos rápidos que acotan la ventana temporal de la pérdida</p>
        </div>
        <div class="mo-head-actions">
          <p-select [options]="statusOptions" [(ngModel)]="statusFilter" optionLabel="label" optionValue="value" (onChange)="reload()" styleClass="mo-status"></p-select>
          @if (canManage()) {
            <button pButton size="small" (click)="openStart()"><span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span> Iniciar monitoreo</button>
          }
        </div>
      </header>

      <div class="mo-layout">
        <!-- Master -->
        <section class="mo-master surf-card">
          <p-table [value]="items()" [loading]="loading()" styleClass="p-datatable-sm surf-table surf-table--zebra" [scrollable]="true" scrollHeight="flex" dataKey="id">
            <ng-template #header>
              <tr><th scope="col">Producto</th><th scope="col">Almacén</th><th scope="col" class="num">Hoy</th><th scope="col" class="num">Últ. dif.</th><th scope="col">Estado</th></tr>
            </ng-template>
            <ng-template #body let-m>
              <tr class="mo-row-click" (click)="select(m)" [class.mo-sel]="selected()?.id === m.id">
                <td class="mo-name">{{ m.product_name || m.product_id }}</td>
                <td class="mo-mono">{{ m.warehouse_code }}</td>
                <td class="num">
                  <p-tag [value]="m.counts_today + '/' + m.counts_per_day" [severity]="+m.counts_today >= m.counts_per_day ? 'success' : 'warn'"></p-tag>
                </td>
                <td class="num" [class.mo-neg]="+m.last_difference < 0">{{ m.last_difference == null ? '—' : m.last_difference }}</td>
                <td><p-tag [value]="m.status === 'active' ? 'Activo' : 'Cerrado'" [severity]="m.status === 'active' ? 'secondary' : 'contrast'"></p-tag></td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="5" class="comm-empty-cell"><div class="comm-empty"><div class="comm-empty-icon"><i class="pi pi-eye" aria-hidden="true"></i></div><h3>Sin monitoreos</h3><p>Iniciá uno manual o desde un expediente de pérdida no identificada.</p></div></td></tr>
            </ng-template>
          </p-table>
        </section>

        <!-- Detail -->
        <section class="mo-detail">
          @if (detail(); as d) {
            <div class="surf-card">
              <div class="mo-detail-head">
                <div>
                  <h2 class="mo-h2">{{ d.sku || '' }} · {{ d.product_name || d.product_id }}</h2>
                  <p class="mo-sub">{{ d.warehouse_code }} · {{ d.counts_per_day }} conteos/día · {{ d.reason || 'monitoreo' }}</p>
                </div>
                <p-tag [value]="d.status === 'active' ? 'Activo' : 'Cerrado'" [severity]="d.status === 'active' ? 'secondary' : 'contrast'"></p-tag>
              </div>

              @if (canManage() && d.status === 'active') {
                <div class="mo-count-form">
                  <label class="mo-field"><span>Físico contado</span><input pInputText type="number" min="0" [(ngModel)]="physicalQty" placeholder="cantidad" /></label>
                  <input pInputText [(ngModel)]="countNotes" placeholder="Notas (opcional)" class="mo-notes" />
                  <div class="mo-row">
                    <button pButton size="small" (click)="record(d)" [disabled]="physicalQty == null" [loading]="acting()"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span> Registrar conteo</button>
                    <button pButton size="small" severity="secondary" [outlined]="true" (click)="close(d)" [loading]="acting()">Cerrar monitoreo</button>
                  </div>
                </div>
              }

              <h3 class="mo-h3">Conteos y ventanas</h3>
              <p-table [value]="d.counts" styleClass="p-datatable-sm surf-table" [scrollable]="true" scrollHeight="360px">
                <ng-template #header>
                  <tr><th scope="col">Ventana</th><th scope="col" class="num">Sistema</th><th scope="col" class="num">Físico</th><th scope="col" class="num">Dif.</th></tr>
                </ng-template>
                <ng-template #body let-c>
                  <tr [class.mo-row-loss]="+c.difference < 0">
                    <td class="mo-mono mo-win">{{ (c.window_from | date:'dd/MM HH:mm') || 'inicio' }} → {{ c.window_to | date:'dd/MM HH:mm' }}</td>
                    <td class="num">{{ c.expected_qty }}</td>
                    <td class="num">{{ c.physical_qty }}</td>
                    <td class="num mo-strong" [class.mo-neg]="+c.difference < 0">{{ c.difference }}</td>
                  </tr>
                </ng-template>
                <ng-template #emptymessage><tr><td colspan="4" class="comm-empty-cell"><div class="comm-empty"><p>Sin conteos aún. Registrá el primero.</p></div></td></tr></ng-template>
              </p-table>
            </div>
          } @else {
            <div class="surf-card mo-placeholder"><div class="comm-empty"><div class="comm-empty-icon"><i class="pi pi-arrow-left" aria-hidden="true"></i></div><h3>Elegí un monitoreo</h3><p>Seleccioná un SKU para registrar conteos y ver sus ventanas de pérdida.</p></div></div>
          }
        </section>
      </div>

      <!-- Iniciar monitoreo manual -->
      <p-dialog [visible]="startOpen()" (visibleChange)="startOpen.set($event)" [modal]="true" [style]="{ width: '520px' }" header="Iniciar monitoreo intensivo" [dismissableMask]="true">
        <div class="mo-form">
          <label class="mo-field"><span>Almacén *</span>
            <p-select [options]="warehouseOptions()" [(ngModel)]="sWarehouse" optionLabel="label" optionValue="value" placeholder="Elegí" styleClass="mo-w"></p-select>
          </label>
          <label class="mo-field"><span>Producto *</span><app-product-search (productSelected)="sProduct = $event"></app-product-search></label>
          <div class="mo-row">
            <label class="mo-field"><span>Conteos/día</span><input pInputText type="number" min="1" [(ngModel)]="sPerDay" /></label>
            <label class="mo-field mo-grow"><span>Motivo</span><input pInputText [(ngModel)]="sReason" placeholder="ej. pérdida no identificada" /></label>
          </div>
          <button pButton (click)="createStart()" [disabled]="!sWarehouse || !sProduct" [loading]="acting()"><span class="p-button-icon p-button-icon-left pi pi-eye" aria-hidden="true"></span> Iniciar</button>
        </div>
      </p-dialog>
    </div>
  `,
  styles: [`
    .mo-head-actions { display: flex; gap: .5rem; align-items: center; }
    :host ::ng-deep .mo-status { min-width: 150px; }
    :host ::ng-deep .mo-w { width: 100%; }
    .mo-layout { display: grid; grid-template-columns: minmax(340px, 1fr) minmax(360px, 1fr); gap: 1rem; align-items: start; }
    @media (max-width: 980px) { .mo-layout { grid-template-columns: 1fr; } }
    .surf-card { background: var(--surface-card, var(--surface-0)); border: 1px solid var(--surface-border); border-radius: var(--radius-lg, 12px); padding: 1rem; margin-bottom: 1rem; }
    .mo-detail { display: flex; flex-direction: column; }
    .mo-h2 { font-size: .95rem; font-weight: 700; margin: 0 0 .25rem; }
    .mo-h3 { font-size: .85rem; font-weight: 700; margin: 1rem 0 .5rem; }
    .mo-sub { font-size: .82rem; color: var(--text-color-secondary); margin: 0; }
    .mo-detail-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: .75rem; }
    .mo-count-form { display: flex; flex-direction: column; gap: .5rem; background: var(--surface-ground, var(--surface-50)); border-radius: 8px; padding: .75rem; }
    .mo-row { display: flex; gap: .5rem; align-items: center; }
    .mo-field { display: flex; flex-direction: column; gap: .25rem; }
    .mo-field > span { font-size: .8rem; color: var(--text-color-secondary); font-weight: 600; }
    .mo-field input[pInputText] { width: 100%; }
    .mo-grow { flex: 1; }
    .mo-notes { width: 100%; }
    .mo-form { display: flex; flex-direction: column; gap: .75rem; }
    .mo-form .mo-row { align-items: flex-end; }
    .mo-mono { font-family: var(--font-mono, monospace); }
    .mo-win { font-size: .8rem; }
    .mo-name { max-width: 220px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .mo-strong { font-weight: 700; }
    .mo-neg { color: var(--bad-fg, #b91c1c); }
    .mo-row-loss { background: var(--bad-soft-bg, #fef2f2); }
    .mo-sel { background: var(--highlight-bg, rgba(0,0,0,.04)); }
    .mo-row-click { cursor: pointer; }
    .mo-placeholder { min-height: 200px; display: flex; align-items: center; justify-content: center; }
  `],
})
export class AlmacenMonitoreoComponent implements OnInit {
  private readonly svc = inject(MonitoreoService);
  private readonly comercial = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);

  readonly items = signal<Monitoring[]>([]);
  readonly detail = signal<MonitoringDetail | null>(null);
  readonly selected = signal<Monitoring | null>(null);
  readonly loading = signal(false);
  readonly acting = signal(false);
  statusFilter = 'active';
  physicalQty: number | null = null;
  countNotes = '';

  readonly statusOptions = [
    { label: 'Activos', value: 'active' },
    { label: 'Cerrados', value: 'closed' },
    { label: 'Todos', value: 'all' },
  ];

  // start manual
  readonly startOpen = signal(false);
  readonly warehouses = signal<Warehouse[]>([]);
  readonly warehouseOptions = computed(() => this.warehouses().map((w) => ({ label: `${w.code} · ${w.name}`, value: w.id })));
  sWarehouse = '';
  sProduct: ProductHit | null = null;
  sPerDay = 2;
  sReason = '';

  ngOnInit(): void {
    this.comercial.listWarehouses().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (ws: Warehouse[]) => this.warehouses.set(ws || []),
      error: () => this.warehouses.set([]),
    });
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.svc.list({ status: this.statusFilter, limit: 200 }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => { this.items.set(rows || []); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }

  select(m: Monitoring): void {
    this.selected.set(m);
    this.physicalQty = null;
    this.countNotes = '';
    this.svc.detail(m.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => this.detail.set(d),
      error: (e) => this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo cargar' }),
    });
  }

  record(d: MonitoringDetail): void {
    if (this.physicalQty == null) return;
    this.acting.set(true);
    this.svc.recordCount(d.id, { physical_qty: Number(this.physicalQty), notes: this.countNotes?.trim() || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: () => { this.acting.set(false); this.physicalQty = null; this.countNotes = ''; this.toast.add({ severity: 'success', summary: 'Conteo registrado' }); this.select(d); this.reload(); },
        error: (e) => { this.acting.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo registrar' }); },
      });
  }

  close(d: MonitoringDetail): void {
    this.acting.set(true);
    this.svc.close(d.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => { this.acting.set(false); this.detail.set(res); this.toast.add({ severity: 'info', summary: 'Monitoreo cerrado' }); this.reload(); },
      error: (e) => { this.acting.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo cerrar' }); },
    });
  }

  openStart(): void { this.startOpen.set(true); }
  createStart(): void {
    if (!this.sWarehouse || !this.sProduct) return;
    this.acting.set(true);
    this.svc.start({
      warehouse_id: this.sWarehouse,
      product_id: this.sProduct.id,
      counts_per_day: Number(this.sPerDay) || 2,
      reason: this.sReason?.trim() || undefined,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.acting.set(false); this.startOpen.set(false); this.sProduct = null; this.sReason = ''; this.toast.add({ severity: 'success', summary: 'Monitoreo iniciado' }); this.reload(); },
      error: (e) => { this.acting.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo iniciar' }); },
    });
  }

  canManage(): boolean {
    return this.perms.can('manage', 'all') || !!this.auth.user()?.permissions?.[Permission.COMMERCIAL_PREVENTION_GESTIONAR];
  }
}
