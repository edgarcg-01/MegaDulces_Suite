import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { TableModule } from 'primeng/table';
import { DatePickerModule } from 'primeng/datepicker';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService } from 'primeng/api';
import { forkJoin } from 'rxjs';
import {
  AnalyticsOverview,
  FleetUtilizationRow,
  LogisticaService,
  PendingByRouteRow,
  ShipmentProfitabilityRow,
} from '../logistica.service';

/**
 * J.9.1 — Dashboard logística operacional.
 *
 * Migrado del repo `_imported/logistica/.../features/dashboard/`:
 * KPI cards (volumen, ingreso, costo, margen) + top embarques por rentabilidad
 * + utilización por unidad. Con shimmer loading state mientras carga.
 */
@Component({
  selector: 'app-logistica-dashboard',
  standalone: true,
  imports: [
    CommonModule, FormsModule, RouterLink,
    ButtonModule, CardModule, TableModule, DatePickerModule, TagModule, ToastModule, TooltipModule,
  ],
  providers: [MessageService],
  template: `
    <p-toast></p-toast>

    <div class="header-row">
      <div>
        <h2>Dashboard Operativo</h2>
        <p class="muted">Vista en tiempo real del período. Refrescá si querés data actualizada.</p>
      </div>
      <div class="filter-bar">
        <p-datepicker [(ngModel)]="from" dateFormat="yy-mm-dd" placeholder="Desde" [showButtonBar]="true"></p-datepicker>
        <p-datepicker [(ngModel)]="to" dateFormat="yy-mm-dd" placeholder="Hasta" [showButtonBar]="true"></p-datepicker>
        <button pButton icon="pi pi-refresh" label="Actualizar" (click)="reload()" [loading]="loading()"></button>
      </div>
    </div>

    <!-- KPI Grid (4 columns) -->
    <div class="kpi-grid">
      <div class="kpi-card kpi-purple" [class.skeleton]="loading()">
        <div class="kpi-icon"><i class="pi pi-truck"></i></div>
        <div class="kpi-label">Volumen operativo</div>
        <div class="kpi-value" *ngIf="!loading()">{{ overview()?.shipments?.count || 0 }}</div>
        <div class="kpi-value shimmer-bar" *ngIf="loading()"></div>
        <div class="kpi-sub">
          <span *ngIf="!loading()">{{ overview()?.shipments?.total_boxes || 0 }} cajas · {{ overview()?.shipments?.total_km || 0 | number:'1.0-0' }} km</span>
          <span class="shimmer-text" *ngIf="loading()"></span>
        </div>
      </div>

      <div class="kpi-card kpi-green" [class.skeleton]="loading()">
        <div class="kpi-icon"><i class="pi pi-arrow-up-right"></i></div>
        <div class="kpi-label">Ingreso flete</div>
        <div class="kpi-value" *ngIf="!loading()">\${{ overview()?.revenue?.freight || 0 | number:'1.2-2' }}</div>
        <div class="kpi-value shimmer-bar" *ngIf="loading()"></div>
        <div class="kpi-sub">
          <span *ngIf="!loading()">Valor mercancía: \${{ overview()?.revenue?.cargo_value_moved || 0 | number:'1.2-2' }}</span>
          <span class="shimmer-text" *ngIf="loading()"></span>
        </div>
      </div>

      <div class="kpi-card kpi-orange" [class.skeleton]="loading()">
        <div class="kpi-icon"><i class="pi pi-money-bill"></i></div>
        <div class="kpi-label">Costo operativo</div>
        <div class="kpi-value" *ngIf="!loading()">\${{ overview()?.cost?.total || 0 | number:'1.2-2' }}</div>
        <div class="kpi-value shimmer-bar" *ngIf="loading()"></div>
        <div class="kpi-sub">
          <span *ngIf="!loading()">\${{ overview()?.cost?.per_km || 0 | number:'1.2-2' }}/km</span>
          <span class="shimmer-text" *ngIf="loading()"></span>
        </div>
      </div>

      <div class="kpi-card" [class.kpi-positive]="(overview()?.margin?.gross || 0) >= 0" [class.kpi-negative]="(overview()?.margin?.gross || 0) < 0" [class.skeleton]="loading()">
        <div class="kpi-icon"><i class="pi pi-chart-line"></i></div>
        <div class="kpi-label">Margen operativo</div>
        <div class="kpi-value" *ngIf="!loading()">\${{ overview()?.margin?.gross || 0 | number:'1.2-2' }}</div>
        <div class="kpi-value shimmer-bar" *ngIf="loading()"></div>
        <div class="kpi-sub">
          <span *ngIf="!loading()">{{ overview()?.margin?.gross_pct || 0 | number:'1.1-1' }}% margen bruto</span>
          <span class="shimmer-text" *ngIf="loading()"></span>
        </div>
      </div>
    </div>

    <!-- Pipeline: pedidos confirmados/por aprobar sin embarque, agrupados por ruta -->
    <p-card styleClass="pipeline-card">
      <div class="pipeline-head">
        <div>
          <h3>Pedidos por embarcar</h3>
          <p class="muted">
            Pedidos en <code>confirmed</code>/<code>pending_approval</code> sin shipment activo. Atacá la ruta con más cola primero.
          </p>
        </div>
        <div class="pipeline-totals" *ngIf="!loading()">
          <div class="pt-block">
            <span class="pt-label">Pedidos</span>
            <span class="pt-value">{{ pipelineTotals().count }}</span>
          </div>
          <div class="pt-block">
            <span class="pt-label">Valor</span>
            <span class="pt-value">\${{ pipelineTotals().value | number:'1.2-2' }}</span>
          </div>
        </div>
      </div>
      <p-table [value]="pendingRows()" [loading]="loading()" responsiveLayout="scroll" styleClass="p-datatable-sm">
        <ng-template pTemplate="header">
          <tr>
            <th>Ruta</th>
            <th class="num">Pedidos</th>
            <th class="num">Confirmados</th>
            <th class="num">Por aprobar</th>
            <th class="num">Valor total</th>
            <th>Más antiguo</th>
            <th></th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-r>
          <tr>
            <td>
              <strong *ngIf="r.route_id">{{ r.route_name }}</strong>
              <span class="muted" *ngIf="!r.route_id">{{ r.route_name }}</span>
            </td>
            <td class="num strong">{{ r.orders_count }}</td>
            <td class="num">{{ r.orders_confirmed }}</td>
            <td class="num">
              <span *ngIf="r.orders_pending_approval > 0" class="badge-warn">
                {{ r.orders_pending_approval }}
              </span>
              <span *ngIf="r.orders_pending_approval === 0" class="muted">0</span>
            </td>
            <td class="num">\${{ r.total_value | number:'1.2-2' }}</td>
            <td>
              <span [pTooltip]="(r.oldest_order_at | date:'medium') || ''">
                {{ ageOf(r.oldest_order_at) }}
              </span>
            </td>
            <td class="num">
              <a *ngIf="r.route_id" pButton
                 icon="pi pi-plus" label="Embarque"
                 size="small"
                 [routerLink]="['/logistica/shipments']"
                 [queryParams]="{ route_id: r.route_id }"
                 pTooltip="Crear embarque para esta ruta"></a>
              <span *ngIf="!r.route_id" class="muted is-small">Asigná ruta al cliente</span>
            </td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="7" class="muted">Nada esperando embarque. Pipeline limpio. </td></tr>
        </ng-template>
      </p-table>
    </p-card>

    <!-- Two-column section -->
    <div class="two-col">
      <p-card>
        <h3>Top embarques por margen</h3>
        <p-table [value]="topShipments()" [loading]="loading()" responsiveLayout="scroll" styleClass="p-datatable-sm">
          <ng-template pTemplate="header">
            <tr>
              <th>Folio</th>
              <th>Ruta</th>
              <th class="num">Km</th>
              <th class="num">Ingreso</th>
              <th class="num">Costo</th>
              <th class="num">Margen</th>
            </tr>
          </ng-template>
          <ng-template pTemplate="body" let-r>
            <tr>
              <td><code>{{ r.folio }}</code></td>
              <td>{{ r.route_name || '—' }}</td>
              <td class="num">{{ r.km | number:'1.0-0' }}</td>
              <td class="num">\${{ r.revenue | number:'1.2-2' }}</td>
              <td class="num">\${{ r.cost | number:'1.2-2' }}</td>
              <td class="num" [class.pos]="r.margin >= 0" [class.neg]="r.margin < 0">
                \${{ r.margin | number:'1.2-2' }}
                <small class="muted">({{ r.margin_pct | number:'1.1-1' }}%)</small>
              </td>
            </tr>
          </ng-template>
          <ng-template pTemplate="emptymessage">
            <tr><td colspan="6" class="muted">Sin data en el período.</td></tr>
          </ng-template>
        </p-table>
      </p-card>

      <p-card>
        <h3>Utilización por unidad</h3>
        <p-table [value]="fleetRows()" [loading]="loading()" responsiveLayout="scroll" styleClass="p-datatable-sm">
          <ng-template pTemplate="header">
            <tr>
              <th>Placa</th>
              <th class="num">Embarques</th>
              <th class="num">Km</th>
              <th class="num">Ingreso</th>
              <th class="num">Margen</th>
            </tr>
          </ng-template>
          <ng-template pTemplate="body" let-v>
            <tr>
              <td><code>{{ v.plate }}</code></td>
              <td class="num">{{ v.shipments_count }}</td>
              <td class="num">{{ v.total_km | number:'1.0-0' }}</td>
              <td class="num">\${{ v.total_revenue | number:'1.2-2' }}</td>
              <td class="num" [class.pos]="v.margin >= 0" [class.neg]="v.margin < 0">
                \${{ v.margin | number:'1.2-2' }}
              </td>
            </tr>
          </ng-template>
          <ng-template pTemplate="emptymessage">
            <tr><td colspan="5" class="muted">Sin unidades activas en el período.</td></tr>
          </ng-template>
        </p-table>
      </p-card>
    </div>
  `,
  styles: [`
    :host { display:block; }
    .header-row { display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:1rem; margin-bottom:1rem; }
    .header-row h2 { margin:0 0 .25rem; font-size:1.25rem; }
    .muted { color: var(--text-color-secondary); font-size:.85rem; margin:0; }
    .filter-bar { display:flex; gap:.5rem; align-items:center; flex-wrap:wrap; }

    .kpi-grid {
      display:grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap:1rem;
      margin-bottom:1.5rem;
    }
    .kpi-card {
      background: var(--surface-card, var(--surface-50));
      border-left: 4px solid var(--surface-300);
      border-radius: 8px;
      padding: 1rem 1.25rem;
      position: relative;
    }
    .kpi-purple { border-left-color: var(--chart-3); }
    .kpi-purple .kpi-icon { color: var(--chart-3); }
    .kpi-green { border-left-color: var(--ok-fg); }
    .kpi-green .kpi-icon { color: var(--ok-fg); }
    .kpi-orange { border-left-color: var(--warn-fg); }
    .kpi-orange .kpi-icon { color: var(--warn-fg); }
    .kpi-positive { border-left-color: var(--ok-fg); }
    .kpi-positive .kpi-icon { color: var(--ok-fg); }
    .kpi-negative { border-left-color: var(--bad-fg); }
    .kpi-negative .kpi-icon { color: var(--bad-fg); }
    .kpi-icon { font-size:1.25rem; margin-bottom:.5rem; }
    .kpi-label { font-size:.75rem; text-transform:uppercase; letter-spacing:.05em; color: var(--text-color-secondary); }
    .kpi-value { font-size:1.75rem; font-weight:700; margin-top:.25rem; }
    .kpi-sub { font-size:.75rem; color: var(--text-color-secondary); margin-top:.5rem; }
    .pos { color: var(--ok-fg); font-weight: 600; }
    .neg { color: var(--bad-fg); font-weight: 600; }

    /* Shimmer loading state */
    .shimmer-bar, .shimmer-text {
      display: inline-block;
      background: linear-gradient(90deg, var(--surface-100) 0%, var(--surface-200) 50%, var(--surface-100) 100%);
      background-size: 200% 100%;
      animation: shimmer 1.5s infinite linear;
      border-radius: 4px;
    }
    .shimmer-bar { height: 1.75rem; width: 60%; }
    .shimmer-text { height: .75rem; width: 80%; margin-top: .25rem; }
    @keyframes shimmer {
      0%   { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }

    :host ::ng-deep .p-card.pipeline-card { margin-bottom: 1rem; }
    .pipeline-head { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; margin-bottom:.75rem; flex-wrap:wrap; }
    .pipeline-head h3 { margin:0 0 .25rem; font-size:1rem; }
    .pipeline-head .muted code { background: var(--surface-100); padding:0 .3rem; border-radius:3px; font-size:.78rem; }
    .pipeline-totals { display:flex; gap:1.25rem; }
    .pt-block { display:flex; flex-direction:column; align-items:flex-end; }
    .pt-label { font-size:.7rem; text-transform:uppercase; letter-spacing:.05em; color: var(--text-color-secondary); }
    .pt-value { font-size:1.1rem; font-weight:700; }
    .badge-warn { background: var(--warn-soft-bg, rgba(245,158,11,.15)); color: var(--warn-fg, #b45309); font-weight:600; padding:.1rem .55rem; border-radius:999px; font-size:.82rem; }
    .strong { font-weight:600; }
    .is-small { font-size:.78rem; }

    .two-col {
      display:grid;
      grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
      gap:1rem;
    }
    h3 { margin: 0 0 .75rem; font-size: 1rem; }
    .num { text-align: right; }
    code { background: var(--surface-100); padding:.1rem .35rem; border-radius:3px; font-size:.85rem; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogisticaDashboardComponent {
  private readonly api = inject(LogisticaService);
  private readonly toast = inject(MessageService);

  from: Date | null = (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d; })();
  to: Date | null = new Date();

  readonly overview = signal<AnalyticsOverview | null>(null);
  readonly topShipments = signal<ShipmentProfitabilityRow[]>([]);
  readonly fleetRows = signal<FleetUtilizationRow[]>([]);
  readonly pendingRows = signal<PendingByRouteRow[]>([]);
  readonly loading = signal(false);

  readonly pipelineTotals = computed(() => {
    const rows = this.pendingRows();
    return {
      count: rows.reduce((acc, r) => acc + r.orders_count, 0),
      value: rows.reduce((acc, r) => acc + (Number(r.total_value) || 0), 0),
    };
  });

  /** Antigüedad humana del pedido más viejo de una ruta (para alertar colas frías). */
  ageOf(iso: string): string {
    if (!iso) return '—';
    const ms = Date.now() - new Date(iso).getTime();
    const days = Math.floor(ms / 86400000);
    if (days >= 1) return `${days}d`;
    const hours = Math.floor(ms / 3600000);
    if (hours >= 1) return `${hours}h`;
    const mins = Math.max(1, Math.floor(ms / 60000));
    return `${mins}m`;
  }

  constructor() {
    this.reload();
  }

  fmtDate(d: Date | null): string | undefined {
    if (!d) return undefined;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  reload(): void {
    this.loading.set(true);
    const f = this.fmtDate(this.from);
    const t = this.fmtDate(this.to);
    forkJoin({
      ov: this.api.analyticsOverview(f, t),
      top: this.api.shipmentProfitability({ from: f, to: t, limit: 10 }),
      fleet: this.api.fleetUtilization(f, t),
      // El pipeline (pedidos sin embarque) NO depende del rango — es el snapshot
      // actual de la cola operacional, así el operador siempre lo ve completo.
      pending: this.api.pendingByRoute(),
    }).subscribe({
      next: ({ ov, top, fleet, pending }) => {
        this.overview.set(ov);
        this.topShipments.set(top || []);
        this.fleetRows.set(fleet || []);
        this.pendingRows.set(pending || []);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar el dashboard' });
      },
    });
  }
}
