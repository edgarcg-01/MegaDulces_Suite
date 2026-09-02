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
import { BinLocationService, WarehouseBin, LotLocation, UnlocatedLot } from '../bin-location.service';

/**
 * Fase WMS-REC (Pieza 3 — Ubicación bin-level, ADR-044). Auxiliar de ubicaciones
 * (dónde está cada lote) + put-away (ubicar lo recibido) + admin de bins.
 */
@Component({
  selector: 'app-almacen-ubicaciones',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, TagModule, SelectModule, InputTextModule, DialogModule, ToastModule, ProductSearchComponent],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Ubicaciones</h1>
          <p class="surf-page-sub">Auxiliar de ubicaciones lote×posición + put-away de lo recibido (FEFO)</p>
        </div>
        <div class="ub-head-actions">
          <p-select [options]="warehouseOptions()" [(ngModel)]="warehouseId" optionLabel="label" optionValue="value" placeholder="Almacén" (onChange)="reload()" styleClass="ub-w"></p-select>
          @if (canAssign()) {
            <button pButton [text]="true" size="small" severity="secondary" (click)="openBins()"><span class="p-button-icon p-button-icon-left pi pi-th-large" aria-hidden="true"></span> Bins</button>
          }
        </div>
      </header>

      @if (!warehouseId) {
        <div class="comm-empty"><div class="comm-empty-icon"><i class="pi pi-map-marker" aria-hidden="true"></i></div><h3>Elegí un almacén</h3><p>Seleccioná un almacén para ver y administrar ubicaciones.</p></div>
      } @else {
        <div class="ub-layout">
          <section class="ub-left">
            @if (canReceive()) {
              <div class="surf-card">
                <h2 class="ub-h2">Ubicar (put-away)</h2>
                <label class="ub-field"><span>Producto</span>
                  <app-product-search (productSelected)="onPuProduct($event)"></app-product-search>
                  @if (puProductLabel()) { <small class="ub-hint">{{ puProductLabel() }}</small> }
                </label>
                <div class="ub-row">
                  <label class="ub-field"><span>Lote</span><input pInputText [(ngModel)]="puLot" placeholder="NA" /></label>
                  <label class="ub-field"><span>Caducidad</span><input pInputText type="date" [(ngModel)]="puExpiry" /></label>
                </div>
                <div class="ub-row">
                  <label class="ub-field"><span>Bin</span>
                    <p-select [options]="binOptions()" [(ngModel)]="puBin" optionLabel="label" optionValue="value" placeholder="Elegí un bin" [filter]="true" styleClass="ub-w"></p-select>
                  </label>
                  <label class="ub-field"><span>Cantidad</span><input pInputText type="number" min="1" [(ngModel)]="puQty" /></label>
                </div>
                <button pButton (click)="doPutAway()" [disabled]="!canDoPutAway()" [loading]="placing()"><span class="p-button-icon p-button-icon-left pi pi-arrow-down" aria-hidden="true"></span> Ubicar</button>
              </div>
            }

            <div class="surf-card">
              <div class="ub-side-head"><h2 class="ub-h2">Por ubicar</h2>
                <button pButton [text]="true" size="small" severity="secondary" (click)="reload()" [loading]="loading()"><span class="p-button-icon pi pi-refresh" aria-hidden="true"></span></button>
              </div>
              <p-table [value]="unlocated()" styleClass="p-datatable-sm surf-table" [scrollable]="true" scrollHeight="300px">
                <ng-template #header><tr><th scope="col">Producto</th><th scope="col">Lote</th><th scope="col">Caduca</th><th scope="col" class="num">Por ubicar</th></tr></ng-template>
                <ng-template #body let-u>
                  <tr class="ub-row-click" (click)="prefillFromUnlocated(u)">
                    <td class="ub-name">{{ u.product_name || u.product_id }}</td>
                    <td class="ub-mono">{{ u.lot_code }}</td>
                    <td class="ub-mono">{{ u.expiry_date || '—' }}</td>
                    <td class="num ub-strong">{{ u.to_locate }}</td>
                  </tr>
                </ng-template>
                <ng-template #emptymessage><tr><td colspan="4" class="comm-empty-cell"><div class="comm-empty"><p>Nada por ubicar. Todo lo recibido está colocado.</p></div></td></tr></ng-template>
              </p-table>
            </div>
          </section>

          <section class="ub-right surf-card">
            <div class="ub-side-head">
              <h2 class="ub-h2">Auxiliar de ubicaciones</h2>
              <app-product-search (productSelected)="onFilterProduct($event)"></app-product-search>
            </div>
            <p-table [value]="locations()" styleClass="p-datatable-sm surf-table surf-table--zebra" [scrollable]="true" scrollHeight="flex" [paginator]="true" [rows]="50" [rowsPerPageOptions]="[50,100,200]">
              <ng-template #header>
                <tr><th scope="col">Producto</th><th scope="col">Lote</th><th scope="col">Caduca</th><th scope="col">Bin</th><th scope="col" class="num">Cant.</th></tr>
              </ng-template>
              <ng-template #body let-l>
                <tr>
                  <td class="ub-name">{{ l.product_name || l.product_id }}</td>
                  <td class="ub-mono">{{ l.lot_code }}</td>
                  <td class="ub-mono">
                    {{ l.expiry_date || '—' }}
                    @if (l.days_to_expiry != null && l.days_to_expiry <= 30) { <p-tag [value]="l.days_to_expiry + 'd'" [severity]="l.days_to_expiry < 0 ? 'danger' : 'warn'"></p-tag> }
                  </td>
                  <td class="ub-mono ub-strong">{{ l.bin_code }}</td>
                  <td class="num">{{ l.quantity }}</td>
                </tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="5" class="comm-empty-cell"><div class="comm-empty"><h3>Sin ubicaciones</h3><p>Ubicá lotes recibidos con el put-away para verlos aquí (orden FEFO).</p></div></td></tr></ng-template>
            </p-table>
          </section>
        </div>
      }

      <!-- Admin de bins -->
      <p-dialog [visible]="binsOpen()" (visibleChange)="binsOpen.set($event)" [modal]="true" [style]="{ width: '600px' }" header="Bins del almacén" [dismissableMask]="true">
        <div class="ub-bin-form">
          <div class="ub-row">
            <label class="ub-field"><span>Código *</span><input pInputText [(ngModel)]="newBinCode" placeholder="ej. R12-N03-B" /></label>
            <label class="ub-field"><span>Etiqueta</span><input pInputText [(ngModel)]="newBinLabel" placeholder="ej. Rack 12" /></label>
          </div>
          <button pButton size="small" (click)="createBin()" [disabled]="!newBinCode.trim()" [loading]="savingBin()"><span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span> Crear bin</button>
        </div>
        <p-table [value]="bins()" styleClass="p-datatable-sm surf-table" [scrollable]="true" scrollHeight="280px">
          <ng-template #header><tr><th scope="col">Código</th><th scope="col">Etiqueta</th><th scope="col" class="num">Unidades</th><th scope="col"></th></tr></ng-template>
          <ng-template #body let-b>
            <tr>
              <td class="ub-mono ub-strong">{{ b.code }}</td>
              <td>{{ b.label || '—' }}</td>
              <td class="num">{{ b.units }}</td>
              <td><button pButton size="small" severity="danger" [text]="true" (click)="deleteBin(b)" title="Eliminar" [disabled]="+b.units > 0"><span class="pi pi-trash" aria-hidden="true"></span></button></td>
            </tr>
          </ng-template>
          <ng-template #emptymessage><tr><td colspan="4" class="comm-empty-cell"><div class="comm-empty"><p>Sin bins. Creá el primero.</p></div></td></tr></ng-template>
        </p-table>
      </p-dialog>
    </div>
  `,
  styles: [`
    .ub-head-actions { display: flex; gap: .5rem; align-items: center; }
    :host ::ng-deep .ub-w { width: 100%; min-width: 200px; }
    .ub-layout { display: grid; grid-template-columns: minmax(320px, 420px) 1fr; gap: 1rem; align-items: start; }
    @media (max-width: 900px) { .ub-layout { grid-template-columns: 1fr; } }
    .surf-card { background: var(--surface-card, var(--surface-0)); border: 1px solid var(--surface-border); border-radius: var(--radius-lg, 12px); padding: 1rem; margin-bottom: 1rem; }
    .ub-left { display: flex; flex-direction: column; }
    .ub-h2 { font-size: .95rem; font-weight: 700; margin: 0 0 .75rem; }
    .ub-side-head { display: flex; justify-content: space-between; align-items: center; gap: .5rem; margin-bottom: .5rem; flex-wrap: wrap; }
    .ub-field { display: flex; flex-direction: column; gap: .25rem; margin-bottom: .75rem; }
    .ub-field > span { font-size: .8rem; color: var(--text-color-secondary); font-weight: 600; }
    .ub-field input[pInputText], .ub-field input[type=number], .ub-field input[type=date] { width: 100%; }
    .ub-row { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; }
    .ub-hint { font-size: .78rem; color: var(--text-color-secondary); }
    .ub-mono { font-family: var(--font-mono, monospace); }
    .ub-strong { font-weight: 700; }
    .ub-name { max-width: 240px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ub-row-click { cursor: pointer; }
    .ub-bin-form { margin-bottom: 1rem; }
  `],
})
export class AlmacenUbicacionesComponent implements OnInit {
  private readonly svc = inject(BinLocationService);
  private readonly comercial = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);

  readonly warehouses = signal<Warehouse[]>([]);
  readonly warehouseOptions = computed(() => this.warehouses().map((w) => ({ label: `${w.code} · ${w.name}`, value: w.id })));
  warehouseId = '';

  readonly locations = signal<LotLocation[]>([]);
  readonly unlocated = signal<UnlocatedLot[]>([]);
  readonly bins = signal<WarehouseBin[]>([]);
  readonly binOptions = computed(() => this.bins().map((b) => ({ label: `${b.code}${b.label ? ' · ' + b.label : ''}`, value: b.id })));
  readonly loading = signal(false);
  filterProductId = '';

  // put-away
  readonly puProductLabel = signal<string>('');
  puProductId = '';
  puLot = '';
  puExpiry = '';
  puBin = '';
  puQty: number | null = null;
  readonly placing = signal(false);

  // bins admin
  readonly binsOpen = signal(false);
  readonly savingBin = signal(false);
  newBinCode = '';
  newBinLabel = '';

  ngOnInit(): void {
    this.comercial.listWarehouses().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (ws: Warehouse[]) => this.warehouses.set(ws || []),
      error: () => this.warehouses.set([]),
    });
  }

  reload(): void {
    if (!this.warehouseId) return;
    this.loading.set(true);
    this.svc.locations(this.warehouseId, this.filterProductId || undefined).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.locations.set(r || []); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
    this.svc.unlocated(this.warehouseId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => this.unlocated.set(r || []),
      error: () => this.unlocated.set([]),
    });
    this.svc.listBins(this.warehouseId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => this.bins.set(r || []),
      error: () => this.bins.set([]),
    });
  }

  onPuProduct(hit: ProductHit | null): void {
    this.puProductId = hit?.id || '';
    this.puProductLabel.set(hit ? `${hit.sku || ''} · ${hit.label}` : '');
  }

  onFilterProduct(hit: ProductHit | null): void {
    this.filterProductId = hit?.id || '';
    this.reload();
  }

  prefillFromUnlocated(u: UnlocatedLot): void {
    this.puProductId = u.product_id;
    this.puProductLabel.set(`${u.sku || ''} · ${u.product_name || u.product_id}`);
    this.puLot = u.lot_code;
    this.puExpiry = u.expiry_date || '';
    this.puQty = Number(u.to_locate);
    this.toast.add({ severity: 'info', summary: 'Precargado', detail: 'Elegí el bin y confirmá' });
  }

  canDoPutAway(): boolean {
    return !!this.warehouseId && !!this.puProductId && !!this.puBin && !!this.puQty && this.puQty > 0;
  }

  doPutAway(): void {
    if (!this.canDoPutAway()) return;
    this.placing.set(true);
    this.svc.putAway({
      warehouse_id: this.warehouseId,
      product_id: this.puProductId,
      lot_code: this.puLot?.trim() || undefined,
      expiry_date: this.puExpiry || undefined,
      bin_id: this.puBin,
      quantity: Number(this.puQty),
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.placing.set(false);
        this.toast.add({ severity: 'success', summary: 'Ubicado', detail: `${this.puQty} en el bin` });
        this.puLot = ''; this.puExpiry = ''; this.puQty = null;
        this.reload();
      },
      error: (e) => { this.placing.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo ubicar' }); },
    });
  }

  // bins admin
  canReceive(): boolean {
    return this.perms.isAdmin() || !!this.auth.user()?.permissions?.[Permission.COMMERCIAL_INVENTORY_RECIBIR];
  }
  canAssign(): boolean {
    return this.perms.isAdmin() || !!this.auth.user()?.permissions?.[Permission.COMMERCIAL_INVENTORY_ASIGNAR];
  }
  openBins(): void { this.binsOpen.set(true); if (!this.bins().length) this.reload(); }

  createBin(): void {
    if (!this.newBinCode.trim() || !this.warehouseId) return;
    this.savingBin.set(true);
    this.svc.createBin({ warehouse_id: this.warehouseId, code: this.newBinCode.trim(), label: this.newBinLabel?.trim() || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: () => { this.savingBin.set(false); this.newBinCode = ''; this.newBinLabel = ''; this.toast.add({ severity: 'success', summary: 'Bin creado' }); this.reload(); },
        error: (e) => { this.savingBin.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo crear' }); },
      });
  }

  deleteBin(b: WarehouseBin): void {
    this.svc.deleteBin(b.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.toast.add({ severity: 'info', summary: 'Bin eliminado' }); this.reload(); },
      error: (e) => this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo eliminar' }),
    });
  }
}
