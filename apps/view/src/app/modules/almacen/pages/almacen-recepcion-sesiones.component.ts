import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { DialogModule } from 'primeng/dialog';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { ComercialService, Warehouse } from '../../comercial/comercial.service';
import { ReceivingSessionService, ReceivingSessionListItem } from '../receiving-session.service';

/**
 * Fase WMS-REC (Pieza 1, ADR-044) — Lista de Vales de entrada (sesiones de recepción)
 * + apertura de una nueva (manual o desde orden de entrada del ERP).
 */
@Component({
  selector: 'app-almacen-recepcion-sesiones',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, TagModule, SelectModule, InputTextModule, DialogModule, ToastModule],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Recepción · Vales de entrada</h1>
          <p class="surf-page-sub">Escaneo caja→pieza contra lo esperado; faltantes y sobrantes por sesión</p>
        </div>
        <div class="rs-head-actions">
          <p-select [options]="statusOptions" [(ngModel)]="statusFilter" optionLabel="label" optionValue="value" (onChange)="reload()" styleClass="rs-status"></p-select>
          <button pButton size="small" (click)="openNew()"><span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span> Nueva sesión</button>
        </div>
      </header>

      <p-table [value]="sessions()" [loading]="loading()" styleClass="p-datatable-sm surf-table surf-table--zebra"
        [scrollable]="true" scrollHeight="flex" [paginator]="true" [rows]="25" [rowsPerPageOptions]="[25,50,100]">
        <ng-template #header>
          <tr>
            <th scope="col">Folio</th><th scope="col">Almacén</th><th scope="col">Proveedor</th><th scope="col">Origen</th>
            <th scope="col">Estado</th><th scope="col" class="num">Líneas</th><th scope="col" class="num">Discrep.</th><th scope="col">Creada</th>
          </tr>
        </ng-template>
        <ng-template #body let-s>
          <tr class="rs-row" (click)="openSession(s)">
            <td class="rs-mono">{{ s.folio }}</td>
            <td class="rs-mono">{{ s.warehouse_code }}</td>
            <td class="rs-mono">{{ s.supplier_code || '—' }}</td>
            <td>{{ s.source_kind === 'erp_receipt' ? ('ERP · ' + (s.source_ref || '')) : 'Manual' }}</td>
            <td><p-tag [value]="statusLabel(s.status)" [severity]="statusSeverity(s.status)"></p-tag></td>
            <td class="num">{{ s.line_count }}</td>
            <td class="num">
              @if (+s.discrepancy_count > 0) { <p-tag [value]="s.discrepancy_count" severity="warn"></p-tag> } @else { — }
            </td>
            <td class="rs-mono">{{ s.created_at | date:'dd/MM/yy HH:mm' }}</td>
          </tr>
        </ng-template>
        <ng-template #emptymessage>
          <tr><td colspan="8" class="comm-empty-cell"><div class="comm-empty"><div class="comm-empty-icon"><i class="pi pi-inbox" aria-hidden="true"></i></div><h3>Sin sesiones</h3><p>Abrí una nueva sesión de recepción para empezar a escanear.</p></div></td></tr>
        </ng-template>
      </p-table>

      <p-dialog [visible]="newOpen()" (visibleChange)="newOpen.set($event)" [modal]="true" [style]="{ width: '520px' }" header="Nueva sesión de recepción" [dismissableMask]="true">
        <div class="rs-form">
          <label class="rs-field"><span>Almacén *</span>
            <p-select [options]="warehouseOptions()" [(ngModel)]="newWarehouse" optionLabel="label" optionValue="value" placeholder="Elegí un almacén" styleClass="rs-w"></p-select>
          </label>
          <label class="rs-field"><span>Proveedor (código)</span><input pInputText [(ngModel)]="newSupplier" placeholder="ej. C001" /></label>
          <label class="rs-field"><span>Origen</span>
            <p-select [options]="sourceOptions" [(ngModel)]="newSource" optionLabel="label" optionValue="value" styleClass="rs-w"></p-select>
          </label>
          @if (newSource === 'erp_receipt') {
            <div class="rs-row">
              <label class="rs-field"><span>Sucursal ERP</span><input pInputText [(ngModel)]="newErpSucursal" placeholder="ej. 00" /></label>
              <label class="rs-field"><span>Folio orden entrada</span><input pInputText [(ngModel)]="newErpFolio" placeholder="ej. 12345" /></label>
            </div>
            <small class="rs-hint">Precarga las líneas esperadas desde la orden de entrada (X-A-40) del ERP.</small>
          }
          <button pButton (click)="create()" [disabled]="!newWarehouse" [loading]="creating()"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span> Abrir sesión</button>
        </div>
      </p-dialog>
    </div>
  `,
  styles: [`
    .rs-head-actions { display: flex; gap: .5rem; align-items: center; }
    :host ::ng-deep .rs-status { min-width: 160px; }
    :host ::ng-deep .rs-w { width: 100%; }
    .rs-row { cursor: pointer; }
    .rs-mono { font-family: var(--font-mono, monospace); }
    .rs-form { display: flex; flex-direction: column; gap: .25rem; }
    .rs-field { display: flex; flex-direction: column; gap: .25rem; margin-bottom: .75rem; }
    .rs-field > span { font-size: .8rem; color: var(--text-color-secondary); font-weight: 600; }
    .rs-field input[pInputText] { width: 100%; }
    .rs-row-form { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; }
    .rs-row { }
    .rs-hint { font-size: .78rem; color: var(--text-color-secondary); margin-bottom: .75rem; display: block; }
  `],
})
export class AlmacenRecepcionSesionesComponent implements OnInit {
  private readonly svc = inject(ReceivingSessionService);
  private readonly comercial = inject(ComercialService);
  private readonly router = inject(Router);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly sessions = signal<ReceivingSessionListItem[]>([]);
  readonly loading = signal(false);
  statusFilter = 'open';
  readonly statusOptions = [
    { label: 'Abiertas', value: 'open' },
    { label: 'Cerradas', value: 'closed' },
    { label: 'Canceladas', value: 'cancelled' },
    { label: 'Todas', value: '' },
  ];

  readonly warehouses = signal<Warehouse[]>([]);
  readonly warehouseOptions = computed(() => this.warehouses().map((w) => ({ label: `${w.code} · ${w.name}`, value: w.id })));
  readonly newOpen = signal(false);
  readonly creating = signal(false);
  newWarehouse = '';
  newSupplier = '';
  newSource: 'manual' | 'erp_receipt' = 'manual';
  newErpSucursal = '';
  newErpFolio = '';
  readonly sourceOptions = [
    { label: 'Manual (escaneo libre)', value: 'manual' },
    { label: 'Desde orden de entrada (ERP)', value: 'erp_receipt' },
  ];

  ngOnInit(): void {
    this.comercial.listWarehouses().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (ws: Warehouse[]) => this.warehouses.set(ws || []),
      error: () => this.warehouses.set([]),
    });
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.svc.list({ status: this.statusFilter || undefined, limit: 100 }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => { this.sessions.set(rows || []); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }

  openNew(): void { this.newOpen.set(true); }

  create(): void {
    if (!this.newWarehouse) return;
    if (this.newSource === 'erp_receipt' && (!this.newErpSucursal.trim() || !this.newErpFolio.trim())) {
      this.toast.add({ severity: 'warn', summary: 'Falta origen', detail: 'Indicá sucursal y folio de la orden de entrada' });
      return;
    }
    this.creating.set(true);
    this.svc.open({
      warehouse_id: this.newWarehouse,
      supplier_code: this.newSupplier?.trim() || undefined,
      source_kind: this.newSource,
      erp_sucursal: this.newSource === 'erp_receipt' ? this.newErpSucursal.trim() : undefined,
      erp_folio: this.newSource === 'erp_receipt' ? this.newErpFolio.trim() : undefined,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (s) => { this.creating.set(false); this.newOpen.set(false); this.router.navigate(['/almacen/inventory/recepcion-sesiones', s.id]); },
      error: (e) => { this.creating.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo abrir' }); },
    });
  }

  openSession(s: ReceivingSessionListItem): void {
    this.router.navigate(['/almacen/inventory/recepcion-sesiones', s.id]);
  }

  statusLabel(s: string): string {
    return s === 'open' ? 'Abierta' : s === 'closed' ? 'Cerrada' : s === 'validating' ? 'Validando' : 'Cancelada';
  }
  statusSeverity(s: string): 'success' | 'secondary' | 'warn' | 'danger' {
    return s === 'open' ? 'success' : s === 'closed' ? 'secondary' : s === 'validating' ? 'warn' : 'danger';
  }
}
