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
import { MetricCardComponent } from '../../../shared/components/metric-card/metric-card.component';

/**
 * P2.2c — POR VENCER: lotes con caducidad próxima o ya vencida (FEFO), con valor
 * en riesgo al costo. Accionable para rotar primero / retirar lo vencido.
 */
@Component({
  selector: 'app-comercial-inventory-expiring',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, TagModule, SelectModule, ToastModule, PageTabsComponent, MetricCardComponent],
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

      <div class="surf-grid ex-bento" *ngIf="lots().length > 0">
        <app-metric-card class="panel-col-6" [large]="true"
          label="Valor en riesgo (costo)" [value]="totalValue()" format="currency"
          accent="var(--bad-fg)"
          [variant]="risk().buckets.length > 1 ? 'bars' : 'plain'"
          [series]="risk().buckets" [seriesLabels]="risk().labels" [highlightLast]="false"
          [sub]="'al costo · ' + lots().length + (lots().length === 1 ? ' lote' : ' lotes')"></app-metric-card>

        <app-metric-card class="panel-col-3"
          label="Lotes en ventana" [value]="lots().length" format="number"
          accent="var(--chart-2)" sub="con caducidad capturada"></app-metric-card>

        <app-metric-card class="panel-col-3" variant="progress"
          label="Ya vencidos" [value]="expiredCount()" [goal]="lots().length" format="number"
          accent="var(--bad-fg)" sub="retirar de inventario"></app-metric-card>
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
    .ex-bento { margin-bottom: 1rem; }
    .ex-mono { font-family: var(--font-mono,monospace); }
    .ex-name { max-width: 280px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ex-num { text-align: right; font-variant-numeric: tabular-nums; }
    .ex-cap { font-weight: 700; }
    .ex-row-expired { background: var(--bad-soft-bg); }
    .ex-empty { text-align: center; padding: 2rem; color: var(--c-text-2); }
  `],
})
export class ComercialInventoryExpiringComponent {
  readonly inventoryTabs: PageTab[] = [
    { label: 'Existencias', route: '/comercial/inventory', icon: 'pi pi-box', permission: Permission.COMMERCIAL_INVENTORY_VER },
    { label: 'Folios', route: '/comercial/inventory/sessions', icon: 'pi pi-clipboard', permission: Permission.COMMERCIAL_INVENTORY_SUPERVISAR },
    { label: 'Por vencer', route: '/comercial/inventory/expiring', icon: 'pi pi-calendar-times', permission: Permission.COMMERCIAL_INVENTORY_VER },
    { label: 'Cíclico', route: '/comercial/inventory/abc', icon: 'pi pi-sync', permission: Permission.COMMERCIAL_INVENTORY_SUPERVISAR },
    { label: 'Pasillos', route: '/comercial/inventory/aisles', icon: 'pi pi-th-large', permission: Permission.COMMERCIAL_INVENTORY_ASIGNAR },
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

  /** Valor en riesgo por urgencia (costo) → barras del hero. */
  readonly risk = computed(() => {
    const buckets = [0, 0, 0, 0, 0]; // vencido · ≤7 · ≤15 · ≤30 · >30
    for (const l of this.lots()) {
      const d = Number(l.days_to_expiry);
      const v = Number(l.value_at_cost || 0);
      if (d < 0) buckets[0] += v;
      else if (d <= 7) buckets[1] += v;
      else if (d <= 15) buckets[2] += v;
      else if (d <= 30) buckets[3] += v;
      else buckets[4] += v;
    }
    return { buckets: buckets.map((n) => Math.round(n)), labels: ['Vencido', '≤7d', '≤15d', '≤30d', '>30d'] };
  });

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
