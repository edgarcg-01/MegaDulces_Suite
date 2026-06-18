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
import { ComercialService, ExpiringLot, Warehouse } from '../comercial.service';
import { Permission } from '../../../core/constants/permissions';
import { PageTabsComponent, PageTab } from '../../../shared/components/page-tabs/page-tabs.component';

/**
 * P2.2c — POR VENCER: lotes con caducidad próxima o ya vencida (FEFO), con valor
 * en riesgo al costo. Accionable para rotar primero / retirar lo vencido.
 */
@Component({
  selector: 'app-comercial-inventory-expiring',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, TagModule, SelectModule, ToastModule, PageTabsComponent],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>

      <app-page-tabs [tabs]="inventoryTabs" />

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Por vencer</h1>
          <p class="surf-page-sub">Lotes con caducidad próxima o vencida — rotar primero (FEFO)</p>
        </div>
        <div class="ex-head-actions">
          <p-select [options]="dayOptions" [(ngModel)]="days" optionLabel="label" optionValue="value"
                    (onChange)="load()" styleClass="ex-days"></p-select>
          <p-select [options]="whOptions()" [(ngModel)]="warehouseId" optionLabel="label" optionValue="value"
                    placeholder="Todos los almacenes" [showClear]="true" (onChange)="load()" styleClass="ex-wh"></p-select>
          <button pButton icon="pi pi-refresh" [text]="true" severity="secondary" size="small" (click)="load()" [loading]="loading()"></button>
        </div>
      </header>

      <div class="ex-kpis">
        <div class="ex-kpi ex-kpi-bad">
          <span class="ex-kpi-v">{{ totalValue() | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
          <span class="ex-kpi-l">Valor en riesgo (costo)</span>
        </div>
        <div class="ex-kpi">
          <span class="ex-kpi-v">{{ lots().length }}</span>
          <span class="ex-kpi-l">Lotes</span>
        </div>
        <div class="ex-kpi" [class.ex-kpi-bad]="expiredCount() > 0">
          <span class="ex-kpi-v">{{ expiredCount() }}</span>
          <span class="ex-kpi-l">Ya vencidos</span>
        </div>
      </div>

      <p-table [value]="lots()" [loading]="loading()" styleClass="p-datatable-sm surf-table"
               [scrollable]="true" scrollHeight="flex" [paginator]="true" [rows]="50">
        <ng-template pTemplate="header">
          <tr>
            <th>Almacén</th><th>SKU</th><th>Producto</th><th>Lote</th><th>Caduca</th>
            <th class="ex-num">Días</th><th class="ex-num">Cantidad</th><th class="ex-num">Valor en riesgo</th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-it>
          <tr [class.ex-row-expired]="+it.days_to_expiry < 0">
            <td class="ex-mono">{{ it.warehouse_code }}</td>
            <td class="ex-mono">{{ it.sku || '—' }}</td>
            <td class="ex-name">{{ it.product_name || '—' }}</td>
            <td class="ex-mono">{{ it.lot_code }}</td>
            <td class="ex-mono">{{ it.expiry_date }}</td>
            <td class="ex-num">
              <p-tag [value]="dayLabel(+it.days_to_expiry)" [severity]="daySeverity(+it.days_to_expiry)"></p-tag>
            </td>
            <td class="ex-num">{{ it.quantity }}</td>
            <td class="ex-num ex-cap">{{ it.value_at_cost | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="8" class="ex-empty">Sin lotes por vencer en esta ventana. Capturá caducidad al recibir mercancía para verlos aquí.</td></tr>
        </ng-template>
      </p-table>
    </div>
  `,
  styles: [`
    .ex-head-actions { display: flex; gap: .5rem; align-items: center; }
    :host ::ng-deep .ex-wh { min-width: 220px; }
    :host ::ng-deep .ex-days { min-width: 150px; }
    .ex-kpis { display: flex; gap: .75rem; margin-bottom: 1rem; }
    .ex-kpi { background: var(--surface-card,#fff); border: 1px solid var(--surface-200,#e7e5e4); border-radius: 12px; padding: .85rem 1.25rem; display: flex; flex-direction: column; }
    .ex-kpi-v { font-size: 1.6rem; font-weight: 700; font-variant-numeric: tabular-nums; }
    .ex-kpi-l { font-size: .75rem; color: var(--text-muted,#78716c); text-transform: uppercase; letter-spacing: .03em; }
    .ex-kpi-bad .ex-kpi-v { color: var(--red-600,#dc2626); }
    .ex-mono { font-family: var(--font-mono,monospace); }
    .ex-name { max-width: 280px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ex-num { text-align: right; font-variant-numeric: tabular-nums; }
    .ex-cap { font-weight: 700; }
    .ex-row-expired { background: var(--red-50,#fef2f2); }
    .ex-empty { text-align: center; padding: 2rem; color: var(--text-muted,#78716c); }
  `],
})
export class ComercialInventoryExpiringComponent {
  readonly inventoryTabs: PageTab[] = [
    { label: 'Existencias', route: '/comercial/inventory', icon: 'pi pi-box', permission: Permission.COMMERCIAL_INVENTORY_VER },
    { label: 'Folios', route: '/comercial/inventory/sessions', icon: 'pi pi-clipboard', permission: Permission.COMMERCIAL_INVENTORY_SUPERVISAR },
    { label: 'Por vencer', route: '/comercial/inventory/expiring', icon: 'pi pi-calendar-times', permission: Permission.COMMERCIAL_INVENTORY_VER },
  ];

  readonly dayOptions = [
    { label: 'Próx. 7 días', value: 7 },
    { label: 'Próx. 15 días', value: 15 },
    { label: 'Próx. 30 días', value: 30 },
    { label: 'Próx. 60 días', value: 60 },
    { label: 'Próx. 90 días', value: 90 },
  ];

  private readonly svc = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  lots = signal<ExpiringLot[]>([]);
  loading = signal(false);
  days = signal(30);
  warehouseId = signal<string | null>(null);
  whOptions = signal<{ label: string; value: string }[]>([]);

  totalValue = computed(() => this.lots().reduce((s, l) => s + Number(l.value_at_cost || 0), 0));
  expiredCount = computed(() => this.lots().filter((l) => Number(l.days_to_expiry) < 0).length);

  constructor() {
    this.svc.listWarehouses()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (ws: Warehouse[]) => this.whOptions.set(ws.map((w) => ({ label: `${w.code} · ${w.name}`, value: w.id }))) });
    this.load();
  }

  load() {
    this.loading.set(true);
    this.svc.listExpiringLots({ days: this.days(), warehouse_id: this.warehouseId() || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (rows) => { this.lots.set(rows || []); this.loading.set(false); },
        error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error al cargar lotes por vencer' }); },
      });
  }

  dayLabel(d: number): string {
    if (d < 0) return `Vencido ${Math.abs(d)}d`;
    if (d === 0) return 'Hoy';
    return `${d} d`;
  }

  daySeverity(d: number): 'danger' | 'warn' | 'secondary' {
    if (d <= 7) return 'danger';
    if (d <= 15) return 'warn';
    return 'secondary';
  }
}
