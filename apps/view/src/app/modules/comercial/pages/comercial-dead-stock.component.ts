import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { ComercialService, DeadStockReport, Warehouse } from '../comercial.service';

/**
 * Reporte de STOCK MUERTO: existencia > 0 sin venta en 90 días = capital parado
 * al costo. Accionable para compras (liquidar / dejar de surtir).
 */
@Component({
  selector: 'app-comercial-dead-stock',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, TagModule, SelectModule, ToastModule],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Stock muerto</h1>
          <p class="surf-page-sub">Existencia sin venta en 90 días — capital parado al costo</p>
        </div>
        <div class="ds-head-actions">
          <p-select [options]="whOptions()" [(ngModel)]="warehouseId" optionLabel="label" optionValue="value"
                    placeholder="Todos los almacenes" [showClear]="true" (onChange)="load()" styleClass="ds-wh"></p-select>
          <button pButton icon="pi pi-refresh" [text]="true" severity="secondary" size="small" (click)="load()" [loading]="loading()"></button>
        </div>
      </header>

      <!-- KPIs -->
      <div class="ds-kpis">
        <div class="ds-kpi ds-kpi-bad">
          <span class="ds-kpi-v">{{ (report()?.total_capital_parado ?? 0) | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
          <span class="ds-kpi-l">Capital parado</span>
        </div>
        <div class="ds-kpi">
          <span class="ds-kpi-v">{{ report()?.total_skus ?? 0 }}</span>
          <span class="ds-kpi-l">SKUs muertos</span>
        </div>
      </div>

      <!-- Resumen por almacén -->
      @if ((report()?.by_warehouse?.length ?? 0) > 1 && !warehouseId()) {
        <div class="ds-by-wh">
          @for (w of report()?.by_warehouse; track w.warehouse_code) {
            <div class="ds-wh-chip">
              <b>{{ w.warehouse_code }}</b>
              <span>{{ w.skus }} SKUs · {{ (+w.capital_parado) | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
            </div>
          }
        </div>
      }

      <!-- Tabla -->
      <p-table [value]="report()?.items ?? []" [loading]="loading()" styleClass="p-datatable-sm surf-table"
               [scrollable]="true" scrollHeight="flex" [paginator]="true" [rows]="50">
        <ng-template pTemplate="header">
          <tr>
            <th>Almacén</th><th>SKU</th><th>Producto</th><th>Marca</th><th>Rot.</th>
            <th class="ds-num">Existencia</th><th class="ds-num">Costo</th><th class="ds-num">Capital parado</th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-it>
          <tr>
            <td class="ds-mono">{{ it.warehouse_code }}</td>
            <td class="ds-mono">{{ it.sku }}</td>
            <td class="ds-name">{{ it.product_name }}</td>
            <td>{{ it.brand_name || '—' }}</td>
            <td><p-tag [value]="it.rotation_tier || 'muerto'" [severity]="it.rotation_tier ? 'warn' : 'danger'"></p-tag></td>
            <td class="ds-num">{{ it.quantity }} {{ it.unit_sale }}</td>
            <td class="ds-num">{{ it.cost_base | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
            <td class="ds-num ds-cap">{{ it.capital_parado | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="8" class="ds-empty">Sin stock muerto detectado (requiere rotación computada).</td></tr>
        </ng-template>
      </p-table>
    </div>
  `,
  styles: [`
    .ds-head-actions { display: flex; gap: .5rem; align-items: center; }
    :host ::ng-deep .ds-wh { min-width: 220px; }
    .ds-kpis { display: flex; gap: .75rem; margin-bottom: 1rem; }
    .ds-kpi { background: var(--surface-card,#fff); border: 1px solid var(--surface-200,#e7e5e4); border-radius: 12px; padding: .85rem 1.25rem; display: flex; flex-direction: column; }
    .ds-kpi-v { font-size: 1.6rem; font-weight: 700; font-variant-numeric: tabular-nums; }
    .ds-kpi-l { font-size: .75rem; color: var(--text-muted,#78716c); text-transform: uppercase; letter-spacing: .03em; }
    .ds-kpi-bad .ds-kpi-v { color: var(--red-600,#dc2626); }
    .ds-by-wh { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 1rem; }
    .ds-wh-chip { background: var(--surface-100,#f5f5f4); border-radius: 8px; padding: .4rem .7rem; font-size: .8rem; display: flex; gap: .5rem; align-items: baseline; }
    .ds-mono { font-family: var(--font-mono,monospace); }
    .ds-name { max-width: 280px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ds-num { text-align: right; font-variant-numeric: tabular-nums; }
    .ds-cap { font-weight: 700; color: var(--red-600,#dc2626); }
    .ds-empty { text-align: center; padding: 2rem; color: var(--text-muted,#78716c); }
  `],
})
export class ComercialDeadStockComponent {
  private readonly svc = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  report = signal<DeadStockReport | null>(null);
  loading = signal(false);
  warehouseId = signal<string | null>(null);
  whOptions = signal<{ label: string; value: string }[]>([]);

  constructor() {
    this.svc.listWarehouses()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (ws: Warehouse[]) => this.whOptions.set(ws.map((w) => ({ label: `${w.code} · ${w.name}`, value: w.id }))) });
    this.load();
  }

  load() {
    this.loading.set(true);
    this.svc.deadStock(this.warehouseId() || undefined, 1000)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.report.set(r); this.loading.set(false); },
        error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error al cargar stock muerto' }); },
      });
  }
}
