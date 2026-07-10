import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule, TableLazyLoadEvent } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { ComprasService, PurchaseOrderRow, PurchaseOrderEstado } from '../compras.service';

type Sev = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';

/**
 * RA.15 (ADR-031) — Órdenes de compra. Documento que se manda al proveedor (espejo
 * Kepler X-A-35). Progreso de recepción (recibido/pedido) + link al detalle donde se
 * registran las órdenes de entrada (OE). Superficie Operations (PrimeNG densa).
 */
@Component({
  selector: 'app-compras-ordenes',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, TagModule, SelectModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in oc-page">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Órdenes de compra</h1>
          <p class="surf-page-sub">Lo que se pide al proveedor. La recepción (orden de entrada) se registra en el detalle y mueve existencia.</p>
        </div>
      </header>

      <div class="oc-filters">
        <p-select [options]="estadoOpts" [(ngModel)]="fEstado" (onChange)="reload()"
                  optionLabel="label" optionValue="value" placeholder="Todos los estados" [showClear]="true" styleClass="oc-sel"></p-select>
      </div>

      <p-table [value]="rows()" [loading]="loading()" [scrollable]="true" scrollHeight="flex"
               [paginator]="true" [rows]="pageSize" [totalRecords]="total()" [lazy]="true" (onLazyLoad)="onPage($event)"
               styleClass="p-datatable-sm oc-table" [rowsPerPageOptions]="[50, 100, 200]"
               [rowHover]="true" (onRowSelect)="open($event.data)" selectionMode="single">
        <ng-template pTemplate="header">
          <tr>
            <th>Folio</th><th>Estado</th><th>Origen</th><th>Proveedor / origen</th><th>Almacén</th>
            <th class="oc-r">Líneas</th><th class="oc-r">Pedido</th><th class="oc-r">Recibido</th><th class="oc-r">Avance</th>
            <th class="oc-r">Costo</th><th>Esperada</th><th>Creada</th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-r>
          <tr [pSelectableRow]="r">
            <td class="oc-mono">{{ r.folio }}</td>
            <td><p-tag [value]="estadoLabel(r.estado)" [severity]="estadoSev(r.estado)"></p-tag></td>
            <td class="oc-muted">{{ r.source_type === 'branch' ? 'Traspaso' : 'Compra' }}</td>
            <td>{{ r.source_type === 'branch' ? (r.source_code || '—') : (r.supplier_name || '—') }}</td>
            <td class="oc-muted">{{ r.warehouse_code }}</td>
            <td class="oc-r oc-muted">{{ r.total_lines }}</td>
            <td class="oc-r">{{ r.total_units | number:'1.0-0' }}</td>
            <td class="oc-r">{{ r.received_units | number:'1.0-0' }}</td>
            <td class="oc-r"><span class="oc-fill">{{ fill(r) | percent:'1.0-0' }}</span></td>
            <td class="oc-r">{{ money(r.total_cost) }}</td>
            <td class="oc-muted">{{ r.expected_date ? (r.expected_date | date:'dd/MM/yy') : '—' }}</td>
            <td class="oc-muted">{{ r.created_at | date:'dd/MM/yy' }}</td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="12" class="oc-empty">Sin órdenes de compra con estos filtros. Genera una desde una requisición aprobada.</td></tr>
        </ng-template>
      </p-table>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .oc-filters { display: flex; gap: .5rem; margin-bottom: .75rem; }
    .oc-sel { min-width: 14rem; }
    .oc-table { font-size: .84rem; }
    .oc-r { text-align: right; font-variant-numeric: tabular-nums; }
    .oc-mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .8rem; font-weight: 600; }
    .oc-muted { color: var(--text-muted); }
    .oc-fill { font-weight: 600; }
    .oc-empty { color: var(--text-muted); padding: 1.5rem; text-align: center; }
  `],
})
export class ComprasOrdenesComponent implements OnInit {
  private readonly api = inject(ComprasService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly pageSize = 50;
  rows = signal<PurchaseOrderRow[]>([]);
  total = signal(0);
  loading = signal(false);
  page = signal(1);
  fEstado = '';

  estadoOpts = [
    { label: 'Abierta', value: 'open' },
    { label: 'Parcial', value: 'partial' },
    { label: 'Recibida', value: 'received' },
    { label: 'Cancelada', value: 'cancelled' },
  ];

  ngOnInit(): void { this.load(); }

  reload(): void { this.page.set(1); this.load(); }

  private load(): void {
    this.loading.set(true);
    this.api.listPurchaseOrders({ estado: this.fEstado || undefined, page: this.page(), pageSize: this.pageSize })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => { this.rows.set(r.rows); this.total.set(r.total); this.loading.set(false); },
        error: () => { this.loading.set(false); },
      });
  }

  onPage(e: TableLazyLoadEvent): void {
    const size = e.rows || this.pageSize;
    this.page.set(Math.floor((e.first || 0) / size) + 1);
    this.load();
  }

  open(r: PurchaseOrderRow): void { this.router.navigate(['/compras/ordenes', r.id]); }

  fill(r: PurchaseOrderRow): number { return Number(r.total_units) > 0 ? Number(r.received_units) / Number(r.total_units) : 0; }
  money(v: number | string | null | undefined) { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  estadoLabel(e: PurchaseOrderEstado) { return ({ open: 'Abierta', partial: 'Parcial', received: 'Recibida', cancelled: 'Cancelada' } as Record<PurchaseOrderEstado, string>)[e]; }
  estadoSev(e: PurchaseOrderEstado): Sev { return ({ open: 'info', partial: 'warn', received: 'success', cancelled: 'danger' } as Record<PurchaseOrderEstado, Sev>)[e]; }
}
