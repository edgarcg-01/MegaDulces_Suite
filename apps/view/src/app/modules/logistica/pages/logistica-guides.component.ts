import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { InputTextModule } from 'primeng/inputtext';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import {
  DeliveryGuide,
  Driver,
  GuideStatus,
  LogisticaService,
} from '../logistica.service';
import { MetricCardComponent } from '../../../shared/components/metric-card/metric-card.component';

type Severity = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';

interface GuideRow extends DeliveryGuide {
  driver_name?: string;
  helper1_name?: string;
  helper2_name?: string;
  total_commissions?: number;
}

/**
 * J.9.3 — Guides page dedicada.
 *
 * Migrado del repo origen. Vista global de todas las guías de entrega
 * (vs solo dentro del shipment-detail). KPIs por estado, filtros por
 * chofer/estado, drill-down al shipment owner.
 */
@Component({
  selector: 'app-logistica-guides',
  standalone: true,
  imports: [
    CommonModule, FormsModule, RouterLink,
    ButtonModule, TableModule, SelectModule, TagModule, InputTextModule, ToastModule,
    MetricCardComponent,
  ],
  providers: [MessageService],
  template: `
    <div class="surf-page logg">
    <p-toast></p-toast>

    <header class="surf-page-head">
      <div class="surf-page-head-text">
        <h1>Guías de entrega</h1>
        <p class="surf-page-sub">Listado global de todas las guías. Para crear una, abrí el embarque correspondiente.</p>
      </div>
    </header>

    <!-- KPIs por estado (J14/J15: jerarquía + color + gauge + count-up) -->
    <div class="surf-grid">
      <app-metric-card class="panel-col-6" [large]="true"
        label="Total guías" [value]="guides().length" format="number"
        accent="var(--chart-2)" sub="guías de entrega registradas"></app-metric-card>
      <app-metric-card class="panel-col-3"
        label="Pendientes" [value]="countByStatus('pendiente')" format="number" accent="var(--warn-fg)"></app-metric-card>
      <app-metric-card class="panel-col-3"
        label="En ruta" [value]="countByStatus('en_ruta')" format="number" accent="var(--action)"></app-metric-card>
      <app-metric-card class="panel-col-6"
        label="Entregadas" variant="gauge"
        [value]="countByStatus('entregada')" [gaugeMax]="guides().length || 1"
        accent="var(--ok-fg)" [sub]="countByStatus('entregada') + ' de ' + guides().length"></app-metric-card>
      <app-metric-card class="panel-col-6"
        label="Comisiones acumuladas" [value]="totalCommissions()" format="currency" accent="var(--chart-6)"></app-metric-card>
    </div>

    <!-- Filtros + tabla -->
    <div class="filter-row">
      <input pInputText type="search" [(ngModel)]="search" (input)="onSearch()" placeholder="Buscar por número de guía"
             inputmode="search" enterkeyhint="search" autocapitalize="none" autocorrect="off" spellcheck="false" />
      <p-select [(ngModel)]="statusFilter" [options]="statusOptions" optionLabel="label" optionValue="value"
                (onChange)="applyFilters()" placeholder="Estado" [showClear]="true" styleClass="filter-select"></p-select>
      <p-select [(ngModel)]="driverFilter" [options]="driverOptions()" optionLabel="full_name" optionValue="id"
                (onChange)="applyFilters()" placeholder="Chofer" [showClear]="true" styleClass="filter-select"></p-select>
      <span class="muted small">{{ filtered().length }} / {{ guides().length }}</span>
    </div>

    <section class="surf-panel">
      <div class="surf-panel-body is-flush">
      <p-table [value]="filtered()" [loading]="loading()" responsiveLayout="scroll" styleClass="surf-table surf-table--sticky surf-table--frozen-first surf-table--zebra" [paginator]="true" [rows]="25" [rowsPerPageOptions]="[25, 50, 100, 200]">
        <ng-template pTemplate="header">
          <tr>
            <th scope="col">Número</th>
            <th scope="col">Embarque</th>
            <th scope="col">Chofer</th>
            <th scope="col">Ayudantes</th>
            <th scope="col" class="num">Comisiones</th>
            <th scope="col" class="num">Viáticos</th>
            <th scope="col">Estado</th>
            <th scope="col"><span class="sr-only">Acciones</span></th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-g>
          <tr>
            <td><code class="comm-code">{{ g.number }}</code></td>
            <td>
              <a [routerLink]="['/logistica/shipments', g.shipment_id]" class="link"><i class="pi pi-external-link"></i></a>
            </td>
            <td>{{ g.driver_name || '—' }}</td>
            <td class="helpers">
              <span *ngIf="g.helper1_name">{{ g.helper1_name }}</span>
              <span *ngIf="g.helper2_name"> · {{ g.helper2_name }}</span>
              <span *ngIf="!g.helper1_name && !g.helper2_name" class="muted">—</span>
            </td>
            <td class="num">{{ g.total_commissions | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
            <td class="num">{{ g.per_diem_total | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
            <td><p-tag [severity]="severityStatus(g.status)" [value]="g.status"></p-tag></td>
            <td class="actions">
              <a pButton icon="pi pi-eye" size="small" severity="secondary" [text]="true" [routerLink]="['/logistica/shipments', g.shipment_id]"></a>
            </td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr>
            <td colspan="8">
              <div class="comm-empty">
                <i class="pi pi-inbox comm-empty-icon"></i>
                <span>Sin guías que coincidan con el filtro.</span>
              </div>
            </td>
          </tr>
        </ng-template>
      </p-table>
      </div>
    </section>
    </div>
  `,
  styles: [`
    :host { display:block; }
    .muted { color: var(--c-text-2); font-size: var(--fs-sm); }
    .small { font-size: var(--fs-xs); }

    .filter-row { display:flex; gap:.75rem; align-items:center; flex-wrap:wrap; }
    .filter-row input { min-width: 220px; }
    :host ::ng-deep .filter-select { min-width: 180px; }

    .num { text-align:right; font-variant-numeric: tabular-nums; font-family: var(--font-mono); }
    .helpers { font-size: var(--fs-sm); }
    .actions { display:flex; gap:.25rem; justify-content:flex-end; }
    .link { color: var(--action); }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogisticaGuidesComponent {
  private readonly api = inject(LogisticaService);
  private readonly toast = inject(MessageService);

  readonly guides = signal<GuideRow[]>([]);
  readonly drivers = signal<Driver[]>([]);
  readonly loading = signal(false);

  search = '';
  statusFilter: GuideStatus | null = null;
  driverFilter: string | null = null;
  private searchTimeout: any = null;

  readonly statusOptions: { label: string; value: GuideStatus }[] = [
    { label: 'Pendiente', value: 'pendiente' },
    { label: 'En ruta', value: 'en_ruta' },
    { label: 'Entregada', value: 'entregada' },
    { label: 'Cancelada', value: 'cancelada' },
  ];

  readonly driverOptions = computed(() => this.drivers().filter((d) => d.active));

  readonly filtered = computed(() => {
    let list = this.guides();
    if (this.search) {
      const s = this.search.toLowerCase();
      list = list.filter((g) => g.number.toLowerCase().includes(s));
    }
    if (this.statusFilter) list = list.filter((g) => g.status === this.statusFilter);
    if (this.driverFilter) {
      list = list.filter((g) =>
        g.driver_id === this.driverFilter ||
        g.helper1_id === this.driverFilter ||
        g.helper2_id === this.driverFilter,
      );
    }
    return list;
  });

  readonly totalCommissions = computed(() =>
    this.guides().reduce((acc, g) => acc + (g.total_commissions || 0), 0)
  );

  constructor() {
    this.api.listDrivers().subscribe((d) => this.drivers.set(d || []));
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.api.listGuides().subscribe({
      next: (list) => {
        const drivers = this.drivers();
        const driverById = new Map(drivers.map((d) => [d.id, d.full_name]));
        const enriched = (list || []).map((g) => ({
          ...g,
          driver_name: g.driver_id ? driverById.get(g.driver_id) : undefined,
          helper1_name: g.helper1_id ? driverById.get(g.helper1_id) : undefined,
          helper2_name: g.helper2_id ? driverById.get(g.helper2_id) : undefined,
          total_commissions: (g.driver_commission || 0) + (g.helper1_commission || 0) + (g.helper2_commission || 0),
        } as GuideRow));
        this.guides.set(enriched);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se cargaron las guías' });
      },
    });
  }

  onSearch(): void {
    if (this.searchTimeout) clearTimeout(this.searchTimeout);
    this.searchTimeout = setTimeout(() => { /* computed se recalcula vía signal */ }, 200);
  }

  applyFilters(): void {
    // No-op: filtered() es computed y se recalcula al cambiar signals via [(ngModel)]
    // Necesitamos forzar trigger del computed asignando el mismo array
    this.guides.set([...this.guides()]);
  }

  countByStatus(status: GuideStatus): number {
    return this.guides().filter((g) => g.status === status).length;
  }

  severityStatus(s: GuideStatus): Severity {
    if (s === 'pendiente') return 'info';
    if (s === 'en_ruta') return 'warn';
    if (s === 'entregada') return 'success';
    return 'danger';
  }
}
