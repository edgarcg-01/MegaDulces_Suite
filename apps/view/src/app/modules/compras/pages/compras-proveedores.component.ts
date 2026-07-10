import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { InputTextModule } from 'primeng/inputtext';
import { MessageService } from 'primeng/api';
import { ComprasService, SupplierParam } from '../compras.service';

/**
 * RA-PRO.3 — Parámetros de compra por proveedor. Kepler NO codifica lead time real
 * (verificado: 73% de OC→entrada el mismo día, promedio negativo → las fechas son
 * artefacto de captura), así que lead time y mínimo de pedido se capturan aquí. Ambos
 * alimentan el motor: punto de reorden = avg×lead + safety; safety = Z(servicio)×σ×√lead.
 * Superficie Operations (PrimeNG denso, quiet-luxury).
 */
@Component({
  selector: 'app-compras-proveedores',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, ToastModule, InputTextModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in cp-page">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Parámetros de compra</h1>
          <p class="surf-page-sub">Lead time y pedido mínimo por proveedor. Kepler no los trae; se capturan aquí y alimentan el punto de reorden y el safety stock.</p>
        </div>
      </header>

      <div class="cp-filters">
        <span class="p-input-icon-left cp-search">
          <input pInputText type="text" [(ngModel)]="search" (keyup.enter)="load()" placeholder="Buscar proveedor…" />
        </span>
        <button pButton type="button" icon="pi pi-search" class="p-button-sm p-button-text" (click)="load()"></button>
        <span class="cp-count">{{ rows().length | number }} proveedores</span>
      </div>

      <p-table [value]="rows()" [loading]="loading()" [scrollable]="true" scrollHeight="flex"
               [paginator]="true" [rows]="50" [rowsPerPageOptions]="[50, 100, 200]"
               styleClass="p-datatable-sm cp-table">
        <ng-template pTemplate="header">
          <tr>
            <th>Proveedor</th>
            <th class="cp-r">Productos</th>
            <th class="cp-r">Lead time (días)</th>
            <th class="cp-r">Mínimo (cajas)</th>
            <th style="width:3rem"></th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-r>
          <tr>
            <td>{{ r.name }}</td>
            <td class="cp-r cp-muted">{{ r.product_count | number }}</td>
            <td class="cp-r">
              <input pInputText type="number" min="0" max="365" [(ngModel)]="r.lead_time_days"
                     (change)="saveLead(r)" class="cp-num" [class.cp-unset]="r.lead_time_days == null"
                     placeholder="7*" />
            </td>
            <td class="cp-r">
              <input pInputText type="number" min="0" [(ngModel)]="r.min_order_boxes"
                     (change)="saveBoxes(r)" class="cp-num" [class.cp-unset]="r.min_order_boxes == null"
                     placeholder="—" />
            </td>
            <td class="cp-r">@if (savedId() === r.id) { <i class="pi pi-check cp-ok"></i> }</td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="5" class="cp-empty">Sin proveedores.</td></tr>
        </ng-template>
      </p-table>
      <p class="cp-foot">* Sin lead time capturado, el motor usa el default de {{ 7 }} días.</p>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .cp-filters { display: flex; gap: .5rem; align-items: center; margin-bottom: .75rem; }
    .cp-search input { min-width: 16rem; }
    .cp-count { margin-left: auto; font-size: .8rem; color: var(--text-muted, #8a8580); }
    .cp-table { font-size: .84rem; }
    .cp-r { text-align: right; font-variant-numeric: tabular-nums; }
    .cp-muted { color: var(--text-muted, #8a8580); }
    .cp-num { width: 6rem; text-align: right; }
    .cp-unset { color: var(--text-muted, #8a8580); }
    .cp-ok { color: var(--action, #c2410c); }
    .cp-empty { color: var(--text-muted, #8a8580); padding: 1rem; text-align: center; }
    .cp-foot { font-size: .72rem; color: var(--text-muted, #8a8580); margin-top: .5rem; }
  `],
})
export class ComprasProveedoresComponent implements OnInit {
  private readonly api = inject(ComprasService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  rows = signal<SupplierParam[]>([]);
  loading = signal(false);
  savedId = signal<string | null>(null);
  search = '';

  ngOnInit(): void { this.load(); }

  load(): void {
    this.loading.set(true);
    this.api.listSuppliers(this.search || undefined).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.rows.set(r); this.loading.set(false); },
      error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar los proveedores.' }); },
    });
  }

  private flash(id: string) { this.savedId.set(id); setTimeout(() => this.savedId.set(null), 1500); }

  saveLead(r: SupplierParam): void {
    const v = r.lead_time_days == null || (r.lead_time_days as unknown as string) === '' ? null : Number(r.lead_time_days);
    this.api.setSupplierLeadTime(r.id, v).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => this.flash(r.id),
      error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo guardar el lead time.' }),
    });
  }

  saveBoxes(r: SupplierParam): void {
    const v = r.min_order_boxes == null || (r.min_order_boxes as unknown as string) === '' ? null : Number(r.min_order_boxes);
    this.api.setSupplierMinBoxes(r.id, v).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => this.flash(r.id),
      error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo guardar el mínimo.' }),
    });
  }
}
