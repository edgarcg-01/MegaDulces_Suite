import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { DatePickerModule } from 'primeng/datepicker';
import { SkeletonModule } from 'primeng/skeleton';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService } from 'primeng/api';
import { forkJoin } from 'rxjs';
import {
  AnalyticsOverview,
  FleetUtilizationRow,
  KpiCards,
  LogisticaService,
  PendingByRouteRow,
  ShipmentProfitabilityRow,
} from '../logistica.service';
import { MetricCardComponent } from '../../../shared/components/metric-card/metric-card.component';

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
    ButtonModule, TableModule, DatePickerModule, SkeletonModule, ToastModule, TooltipModule,
    MetricCardComponent,
  ],
  providers: [MessageService],
  template: `
    <div class="surf-page logd">
      <p-toast></p-toast>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Dashboard Operativo</h1>
          <p class="surf-page-sub">Vista en tiempo real del período. Refrescá si querés data actualizada.</p>
        </div>
        <div class="filter-bar">
          <div class="filter-daterange" role="group" aria-label="Rango de fechas">
            <label class="filter-label" for="ld-from">Desde</label>
            <p-datepicker inputId="ld-from" [(ngModel)]="from" dateFormat="yy-mm-dd" placeholder="Desde" [showButtonBar]="true"></p-datepicker>
            <i class="pi pi-arrow-right filter-arrow" aria-hidden="true"></i>
            <label class="filter-label" for="ld-to">Hasta</label>
            <p-datepicker inputId="ld-to" [(ngModel)]="to" dateFormat="yy-mm-dd" placeholder="Hasta" [showButtonBar]="true"></p-datepicker>
          </div>
          <button pButton icon="pi pi-refresh" label="Actualizar" styleClass="btn-spin-hover" (click)="reload()" [loading]="loading()"></button>
        </div>
      </header>

      <!-- KPI Grid (J14: tarjetas ricas con micro-gráficas, jerarquía bento) -->
      <p-skeleton *ngIf="loading()" height="172px"></p-skeleton>
      <div *ngIf="!loading()" class="surf-grid">
        <!-- HERO: Margen (bottom line) — col-6 + large -->
        <app-metric-card class="panel-col-6"
          label="Margen operativo" variant="sparkline" [large]="true"
          accent="var(--action)"
          [value]="kpis()?.margin?.value || (overview()?.margin?.gross || 0)"
          format="currency"
          [delta]="kpis()?.margin?.delta_pct ?? null"
          [series]="kpis()?.margin?.series || []"
          [sub]="(kpis()?.margin?.pct ?? overview()?.margin?.gross_pct ?? 0 | number:'1.1-1') + '% margen bruto'">
        </app-metric-card>

        <!-- Secundarias chicas -->
        <app-metric-card class="panel-col-3"
          label="Ingreso flete" variant="sparkline" accent="var(--chart-2)"
          [value]="kpis()?.revenue?.value || (overview()?.revenue?.freight || 0)"
          format="currency"
          [delta]="kpis()?.revenue?.delta_pct ?? null"
          [series]="kpis()?.revenue?.series || []"
          sub="Flete cobrado">
        </app-metric-card>

        <app-metric-card class="panel-col-3"
          label="Volumen operativo" variant="bars" accent="var(--chart-6)"
          [value]="kpis()?.shipments?.value || (overview()?.shipments?.count || 0)"
          format="number"
          [delta]="kpis()?.shipments?.delta_pct ?? null"
          [series]="(kpis()?.shipments?.series || []).slice(-10)"
          [sub]="(overview()?.shipments?.total_boxes || 0) + ' cajas'">
        </app-metric-card>

        <!-- Banner ancho: Costo (tendencia larga) — col-12 -->
        <app-metric-card class="panel-col-12"
          label="Costo operativo" variant="sparkline" accent="var(--chart-3)"
          [value]="kpis()?.cost?.value || (overview()?.cost?.total || 0)"
          format="currency"
          [series]="kpis()?.cost?.series || []"
          [sub]="(overview()?.cost?.per_km || 0 | currency:'MXN':'symbol-narrow':'1.2-2') + '/km · tendencia del período'">
        </app-metric-card>
      </div>

      <!-- Pipeline: pedidos confirmados/por aprobar sin embarque, agrupados por ruta -->
      <section class="surf-panel">
        <div class="surf-panel-head logd-pipe-head">
          <h3><i class="pi pi-inbox" aria-hidden="true"></i> Pedidos por embarcar</h3>
          <div class="pipeline-totals" *ngIf="!loading()">
            <div class="pt-block">
              <span class="pt-label">Pedidos</span>
              <span class="pt-value">{{ pipelineTotals().count }}</span>
            </div>
            <div class="pt-block">
              <span class="pt-label">Valor</span>
              <span class="pt-value">{{ pipelineTotals().value | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
            </div>
          </div>
        </div>
        <div class="surf-panel-body is-flush">
          <p-table [value]="pendingRows()" [loading]="loading()" responsiveLayout="scroll" styleClass="p-datatable-sm">
            <ng-template pTemplate="header">
              <tr>
                <th>Ruta</th>
                <th class="comm-num">Pedidos</th>
                <th class="comm-num">Confirmados</th>
                <th class="comm-num">Por aprobar</th>
                <th class="comm-num">Valor total</th>
                <th>Más antiguo</th>
                <th></th>
              </tr>
            </ng-template>
            <ng-template pTemplate="body" let-r>
              <tr>
                <td>
                  <strong *ngIf="r.route_id">{{ r.route_name }}</strong>
                  <span class="comm-muted" *ngIf="!r.route_id">{{ r.route_name }}</span>
                </td>
                <td class="comm-num is-strong">{{ r.orders_count }}</td>
                <td class="comm-num">{{ r.orders_confirmed }}</td>
                <td class="comm-num">
                  <span *ngIf="r.orders_pending_approval > 0" class="comm-pill is-warn no-dot">
                    {{ r.orders_pending_approval }}
                  </span>
                  <span *ngIf="r.orders_pending_approval === 0" class="comm-muted">0</span>
                </td>
                <td class="comm-num">{{ r.total_value | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td>
                  <span [pTooltip]="(r.oldest_order_at | date:'medium') || ''">
                    {{ ageOf(r.oldest_order_at) }}
                  </span>
                </td>
                <td class="comm-num">
                  <a *ngIf="r.route_id" pButton
                     icon="pi pi-plus" label="Embarque"
                     size="small"
                     [routerLink]="['/logistica/shipments']"
                     [queryParams]="{ route_id: r.route_id }"
                     pTooltip="Crear embarque para esta ruta"></a>
                  <span *ngIf="!r.route_id" class="comm-muted is-small">Asigná ruta al cliente</span>
                </td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage">
              <tr><td colspan="7" class="comm-muted logd-empty">Nada esperando embarque. Pipeline limpio.</td></tr>
            </ng-template>
          </p-table>
        </div>
      </section>

      <!-- Two-column section -->
      <div class="surf-grid">
        <section class="surf-panel panel-col-6">
          <div class="surf-panel-head"><h3><i class="pi pi-chart-line" aria-hidden="true"></i> Top embarques por margen</h3></div>
          <div class="surf-panel-body is-flush">
            <p-table [value]="topShipments()" [loading]="loading()" responsiveLayout="scroll" styleClass="p-datatable-sm">
              <ng-template pTemplate="header">
                <tr>
                  <th>Folio</th>
                  <th>Ruta</th>
                  <th class="comm-num">Km</th>
                  <th class="comm-num">Ingreso</th>
                  <th class="comm-num">Costo</th>
                  <th class="comm-num">Margen</th>
                </tr>
              </ng-template>
              <ng-template pTemplate="body" let-r>
                <tr>
                  <td><code class="comm-code">{{ r.folio }}</code></td>
                  <td>{{ r.route_name || '—' }}</td>
                  <td class="comm-num">{{ r.km | number:'1.0-0' }}</td>
                  <td class="comm-num">{{ r.revenue | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  <td class="comm-num">{{ r.cost | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  <td class="comm-num" [class.pos]="r.margin >= 0" [class.neg]="r.margin < 0">
                    {{ r.margin | currency:'MXN':'symbol-narrow':'1.2-2' }}
                    <small class="comm-muted">({{ r.margin_pct | number:'1.1-1' }}%)</small>
                  </td>
                </tr>
              </ng-template>
              <ng-template pTemplate="emptymessage">
                <tr><td colspan="6" class="comm-muted logd-empty">Sin embarques cerrados en este rango. Probá ampliar las fechas.</td></tr>
              </ng-template>
            </p-table>
          </div>
        </section>

        <section class="surf-panel panel-col-6">
          <div class="surf-panel-head"><h3><i class="pi pi-truck" aria-hidden="true"></i> Utilización por unidad</h3></div>
          <div class="surf-panel-body is-flush">
            <p-table [value]="fleetRows()" [loading]="loading()" responsiveLayout="scroll" styleClass="p-datatable-sm">
              <ng-template pTemplate="header">
                <tr>
                  <th>Placa</th>
                  <th class="comm-num">Embarques</th>
                  <th class="comm-num">Km</th>
                  <th class="comm-num">Ingreso</th>
                  <th class="comm-num">Margen</th>
                </tr>
              </ng-template>
              <ng-template pTemplate="body" let-v>
                <tr>
                  <td><code class="comm-code">{{ v.plate }}</code></td>
                  <td class="comm-num">{{ v.shipments_count }}</td>
                  <td class="comm-num">{{ v.total_km | number:'1.0-0' }}</td>
                  <td class="comm-num">{{ v.total_revenue | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  <td class="comm-num" [class.pos]="v.margin >= 0" [class.neg]="v.margin < 0">
                    {{ v.margin | currency:'MXN':'symbol-narrow':'1.2-2' }}
                  </td>
                </tr>
              </ng-template>
              <ng-template pTemplate="emptymessage">
                <tr><td colspan="5" class="comm-muted logd-empty">Aún no se asignaron unidades en este período.</td></tr>
              </ng-template>
            </p-table>
          </div>
        </section>
      </div>
    </div>
  `,
  styles: [`
    :host { display:block; }

    /* ── FILTER BAR (rango de fechas + refresh) ── */
    .filter-bar { display:flex; gap:.5rem; align-items:flex-end; flex-wrap:wrap; }
    .filter-daterange {
      display:inline-flex;
      align-items:flex-end;
      gap:.5rem;
      padding: .5rem .75rem;
      background: var(--c-surface-1);
      border: 1px solid var(--c-divider);
      border-radius: 10px;
    }
    .filter-label {
      display: block;
      font-size: var(--fs-micro);
      font-weight: var(--fw-bold);
      text-transform: uppercase;
      letter-spacing: .08em;
      color: var(--c-text-2);
      margin-bottom: .25rem;
    }
    .filter-arrow {
      color: var(--c-text-3);
      font-size: .7rem;
      padding-bottom: .65rem;
    }

    /* Margen: dirección crítica (verde/rojo) en celda numérica. */
    .pos { color: var(--c-ok); font-weight: var(--fw-medium); }
    .neg { color: var(--c-bad); font-weight: var(--fw-medium); }

    /* ── PIPELINE panel head (con totales a la derecha) ── */
    .logd-pipe-head { flex-wrap: wrap; }
    .pipeline-totals { display:flex; gap:1.5rem; }
    .pt-block { display:flex; flex-direction:column; align-items:flex-end; }
    .pt-label { font-size:var(--fs-micro); text-transform:uppercase; letter-spacing:.06em; color: var(--c-text-2); font-weight: var(--fw-bold); }
    .pt-value { font-size:var(--fs-h3); font-weight:var(--fw-bold); font-variant-numeric: tabular-nums; }

    .is-small { font-size: var(--fs-xs); }
    .logd-empty { padding: 1.5rem !important; text-align: center !important; }

    /* Micro-hover: el icono de Actualizar gira (Design Spell: Stripe/Supabase). */
    :host ::ng-deep .btn-spin-hover .p-button-icon { transition: transform .35s var(--ease-out, cubic-bezier(.23,1,.32,1)); }
    :host ::ng-deep .btn-spin-hover:not(:disabled):hover .p-button-icon { transform: rotate(180deg); }
    @media (prefers-reduced-motion: reduce) { :host ::ng-deep .btn-spin-hover .p-button-icon { transition:none; } }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogisticaDashboardComponent {
  private readonly api = inject(LogisticaService);
  private readonly toast = inject(MessageService);

  from: Date | null = (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d; })();
  to: Date | null = new Date();

  readonly overview = signal<AnalyticsOverview | null>(null);
  readonly kpis = signal<KpiCards | null>(null);
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
      kpis: this.api.analyticsKpiCards(f, t),
      top: this.api.shipmentProfitability({ from: f, to: t, limit: 10 }),
      fleet: this.api.fleetUtilization(f, t),
      // El pipeline (pedidos sin embarque) NO depende del rango — es el snapshot
      // actual de la cola operacional, así el operador siempre lo ve completo.
      pending: this.api.pendingByRoute(),
    }).subscribe({
      next: ({ ov, kpis, top, fleet, pending }) => {
        this.overview.set(ov);
        this.kpis.set(kpis);
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
