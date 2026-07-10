import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule, TableLazyLoadEvent } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { ComprasService, RequisitionRow, RequisitionEstado } from '../compras.service';

type Sev = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';

/** Fase RA (ADR-030) — bandeja de requisiciones de compra. */
@Component({
  selector: 'app-compras-requisiciones',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, SelectModule, TagModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in rq-page">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Requisiciones</h1>
          <p class="surf-page-sub">Requisiciones de compra generadas del sugerido de reabastecimiento.</p>
        </div>
      </header>

      <div class="rq-filters">
        <p-select [options]="estadoOpts" [(ngModel)]="fEstado" (onChange)="reload()"
                  optionLabel="label" optionValue="value" placeholder="Todos los estados" [showClear]="true" styleClass="rq-sel"></p-select>
      </div>

      <p-table [value]="rows()" [loading]="loading()" styleClass="p-datatable-sm rq-table"
               [paginator]="true" [rows]="50" [totalRecords]="total()" [lazy]="true" (onLazyLoad)="onPage($event)">
        <ng-template pTemplate="header">
          <tr>
            <th>Folio</th><th>Almacén</th><th>Proveedor</th>
            <th class="rq-r">Líneas</th><th class="rq-r">Unidades</th><th class="rq-r">Costo</th>
            <th>Estado</th><th>Fecha</th><th></th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-r>
          <tr class="rq-row" (click)="open(r)">
            <td class="rq-mono">{{ r.folio }}</td>
            <td>{{ r.warehouse_code || '—' }}</td>
            <td class="rq-muted">{{ r.supplier_name || 'Varios' }}</td>
            <td class="rq-r">{{ r.total_lines | number }}</td>
            <td class="rq-r">{{ r.total_units | number:'1.0-0' }}</td>
            <td class="rq-r">{{ money(r.total_cost) }}</td>
            <td><p-tag [value]="estadoLabel(r.estado)" [severity]="estadoSev(r.estado)"></p-tag></td>
            <td class="rq-muted">{{ r.created_at | date:'dd/MM/yy HH:mm' }}</td>
            <td><i class="pi pi-angle-right rq-muted"></i></td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="9" class="rq-empty">Sin requisiciones todavía. Genera una desde Existencia crítica.</td></tr>
        </ng-template>
      </p-table>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .rq-filters { margin-bottom: .75rem; } .rq-sel { min-width: 14rem; }
    .rq-table { font-size: .84rem; }
    .rq-row { cursor: pointer; } .rq-row:hover { background: var(--surface-hover-bg); }
    .rq-r { text-align: right; font-variant-numeric: tabular-nums; }
    .rq-mono { font-family: var(--font-mono, ui-monospace, monospace); font-weight: 600; }
    .rq-muted { color: var(--text-muted); }
    .rq-empty { color: var(--text-muted); padding: 1rem; text-align: center; }
  `],
})
export class ComprasRequisicionesComponent implements OnInit {
  private readonly api = inject(ComprasService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  rows = signal<RequisitionRow[]>([]);
  total = signal(0);
  loading = signal(false);
  page = signal(1);
  fEstado = '';

  estadoOpts = [
    { label: 'Pendiente de aprobar', value: 'pending_approval' },
    { label: 'Aprobada', value: 'approved' },
    { label: 'Ordenada', value: 'ordered' },
    { label: 'Recibida', value: 'received' },
    { label: 'Cancelada', value: 'cancelled' },
  ];

  ngOnInit(): void { this.reload(); }
  reload(): void { this.page.set(1); this.load(); }

  private load(): void {
    this.loading.set(true);
    this.api.listRequisitions({ estado: this.fEstado || undefined, page: this.page(), pageSize: 50 })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => { this.rows.set(r.rows); this.total.set(r.total); this.loading.set(false); },
        error: () => this.loading.set(false),
      });
  }

  onPage(e: TableLazyLoadEvent): void {
    this.page.set(Math.floor((e.first || 0) / (e.rows || 50)) + 1);
    this.load();
  }

  open(r: RequisitionRow): void { this.router.navigate(['/compras/requisiciones', r.id]); }

  money(v: number | string | null | undefined) { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  estadoLabel(e: RequisitionEstado) { return ({ draft: 'Borrador', pending_approval: 'Pendiente', approved: 'Aprobada', ordered: 'Ordenada', received: 'Recibida', cancelled: 'Cancelada' } as Record<RequisitionEstado, string>)[e]; }
  estadoSev(e: RequisitionEstado): Sev { return ({ draft: 'secondary', pending_approval: 'warn', approved: 'success', ordered: 'info', received: 'success', cancelled: 'danger' } as Record<RequisitionEstado, Sev>)[e]; }
}
