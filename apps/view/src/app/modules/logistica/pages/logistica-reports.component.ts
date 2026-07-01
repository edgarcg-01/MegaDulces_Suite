import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TabsModule } from 'primeng/tabs';
import { DatePickerModule } from 'primeng/datepicker';
import { SelectModule } from 'primeng/select';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { forkJoin } from 'rxjs';
import {
  AnalyticsOverview,
  ErpShipmentsResponse,
  FleetUtilizationRow,
  KpiCards,
  KpiSummary,
  LogisticaService,
  RoiSummary,
  ShipmentProfitabilityRow,
} from '../logistica.service';
import { MetricCardComponent } from '../../../shared/components/metric-card/metric-card.component';

type Severity = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';

/**
 * J.9.5 — Reports avanzado.
 *
 * Migrado del repo `_imported/logistica/.../features/reports/`. Reemplaza la
 * versión básica (solo KPIs) con 3 tabs:
 *   1. Overview — KPI cards + período + descarga PDF
 *   2. Por embarque — tabla con margen, ingreso/km, costo/km por shipment
 *   3. Por unidad — utilización por vehicle (count, km, revenue, margen)
 *
 * jsPDF en frontend para descarga directa (sin pasar por backend). Reusa el
 * backend KPI PDF para el reporte ejecutivo principal.
 */
@Component({
  selector: 'app-logistica-reports',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    ButtonModule, TableModule, TabsModule,
    DatePickerModule, SelectModule, ToastModule,
    MetricCardComponent,
  ],
  providers: [MessageService],
  template: `
    <div class="surf-page logr">
      <p-toast></p-toast>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Reportes Logística</h1>
          <p class="surf-page-sub">Análisis de rentabilidad por embarque + utilización por unidad. Exportación PDF.</p>
        </div>
        <div class="filter-bar">
          <p-datepicker [(ngModel)]="from" dateFormat="yy-mm-dd" placeholder="Desde" [showButtonBar]="true"></p-datepicker>
          <p-datepicker [(ngModel)]="to" dateFormat="yy-mm-dd" placeholder="Hasta" [showButtonBar]="true"></p-datepicker>
          <button pButton icon="pi pi-refresh" label="Aplicar" (click)="reload()" [loading]="loading()"></button>
          <button pButton icon="pi pi-file-pdf" label="PDF ejecutivo" severity="secondary" [outlined]="true" (click)="downloadExecutivePdf()"></button>
        </div>
      </header>

      <p-tabs value="overview">
        <p-tablist>
          <p-tab value="overview"><i class="pi pi-th-large"></i> Overview</p-tab>
          <p-tab value="shipments"><i class="pi pi-truck"></i> Por embarque ({{ shipmentRows().length }})</p-tab>
          <p-tab value="fleet"><i class="pi pi-car"></i> Por unidad ({{ fleetRows().length }})</p-tab>
          <p-tab value="roi"><i class="pi pi-dollar"></i> ROI</p-tab>
          <p-tab value="erp"><i class="pi pi-database"></i> Embarques ERP</p-tab>
        </p-tablist>
        <p-tabpanels>

          <!-- ──── Tab 1: Overview KPI ──── -->
          <p-tabpanel value="overview">
            <ng-container *ngIf="kpi() as k">
              <div class="surf-grid logr-kpis">
                <app-metric-card class="panel-col-6" [large]="true"
                  label="Margen del período" variant="sparkline" accent="var(--action)"
                  [value]="k.financial.margen" format="currency"
                  [delta]="kpis()?.margin?.delta_pct ?? null"
                  [series]="kpis()?.margin?.series || []"
                  sub="Revenue − Costos − Comisiones"></app-metric-card>
                <app-metric-card class="panel-col-3"
                  label="Revenue flete" variant="sparkline" accent="var(--chart-2)"
                  [value]="k.financial.revenue" format="currency"
                  [delta]="kpis()?.revenue?.delta_pct ?? null"
                  [series]="kpis()?.revenue?.series || []" sub="Fletes cobrados"></app-metric-card>
                <app-metric-card class="panel-col-3"
                  label="Costo / km" accent="var(--warn-fg)"
                  [value]="k.financial.costo_promedio_km" format="currency"
                  [sub]="k.operations.km_total + ' km totales'"></app-metric-card>
                <app-metric-card class="panel-col-12"
                  label="Embarques totales" variant="bars" accent="var(--chart-6)"
                  [value]="k.shipments.total" format="number"
                  [series]="kpis()?.shipments?.series || []"
                  [sub]="'✓ ' + k.shipments.cerrados + ' cerrados · ✕ ' + k.shipments.cancelados + ' cancelados · ⏳ ' + k.shipments.activos + ' activos'"></app-metric-card>
              </div>

              <div class="surf-grid logr-detail">
                <section class="surf-panel panel-col-6">
                  <div class="surf-panel-head"><h3><i class="pi pi-cog" aria-hidden="true"></i> Operación</h3></div>
                  <div class="surf-panel-body">
                    <div class="rep-row"><span>Km totales</span><strong>{{ k.operations.km_total }}</strong></div>
                    <div class="rep-row"><span>Cajas movidas</span><strong>{{ k.operations.cajas }}</strong></div>
                  </div>
                </section>

                <section class="surf-panel panel-col-6">
                  <div class="surf-panel-head"><h3><i class="pi pi-wallet" aria-hidden="true"></i> Desglose financiero</h3></div>
                  <div class="surf-panel-body">
                    <div class="rep-row"><span>Revenue flete</span><strong>{{ k.financial.revenue | currency:'MXN':'symbol-narrow':'1.2-2' }}</strong></div>
                    <div class="rep-row"><span>Total costos</span><strong>{{ k.financial.total_costos | currency:'MXN':'symbol-narrow':'1.2-2' }}</strong></div>
                    <div class="rep-row is-sub"><span>· Combustible</span><strong>{{ k.financial.combustible | currency:'MXN':'symbol-narrow':'1.2-2' }}</strong></div>
                    <div class="rep-row is-sub"><span>· Casetas</span><strong>{{ k.financial.casetas | currency:'MXN':'symbol-narrow':'1.2-2' }}</strong></div>
                    <div class="rep-row"><span>Comisiones pagadas</span><strong>{{ k.financial.comisiones | currency:'MXN':'symbol-narrow':'1.2-2' }}</strong></div>
                    <div class="rep-row"><span>Viáticos</span><strong>{{ k.financial.viaticos | currency:'MXN':'symbol-narrow':'1.2-2' }}</strong></div>
                  </div>
                </section>
              </div>
            </ng-container>
          </p-tabpanel>

          <!-- ──── Tab 2: Por embarque ──── -->
          <p-tabpanel value="shipments">
            <div class="tab-toolbar">
              <span class="comm-muted is-small">{{ shipmentRows().length }} embarques en el período</span>
              <button pButton icon="pi pi-file-pdf" label="Exportar PDF (cliente)" severity="secondary" [outlined]="true" size="small" (click)="exportShipmentsPdf()"></button>
            </div>

            <section class="surf-panel">
              <div class="surf-panel-body is-flush">
                <p-table [value]="shipmentRows()" [loading]="loading()" responsiveLayout="scroll" styleClass="surf-table surf-table--sticky surf-table--frozen-first surf-table--zebra p-datatable-sm" [paginator]="true" [rows]="25" [rowsPerPageOptions]="[25, 50, 100, 200]" sortMode="single">
                  <ng-template pTemplate="header">
                    <tr>
                      <th scope="col" pSortableColumn="folio">Folio <p-sortIcon field="folio"></p-sortIcon></th>
                      <th scope="col" pSortableColumn="shipment_date">Fecha <p-sortIcon field="shipment_date"></p-sortIcon></th>
                      <th scope="col">Ruta</th>
                      <th scope="col" pSortableColumn="km" class="comm-num">Km <p-sortIcon field="km"></p-sortIcon></th>
                      <th scope="col" pSortableColumn="revenue" class="comm-num">Ingreso <p-sortIcon field="revenue"></p-sortIcon></th>
                      <th scope="col" pSortableColumn="cost" class="comm-num">Costo <p-sortIcon field="cost"></p-sortIcon></th>
                      <th scope="col" pSortableColumn="margin" class="comm-num">Margen <p-sortIcon field="margin"></p-sortIcon></th>
                      <th scope="col" pSortableColumn="margin_pct" class="comm-num">% Margen <p-sortIcon field="margin_pct"></p-sortIcon></th>
                      <th scope="col" class="comm-num">Ing/km</th>
                    </tr>
                  </ng-template>
                  <ng-template pTemplate="body" let-r>
                    <tr>
                      <td><code class="comm-code">{{ r.folio }}</code></td>
                      <td>{{ r.shipment_date | date:'shortDate' }}</td>
                      <td class="is-small">{{ r.route_name || '—' }}</td>
                      <td class="comm-num">{{ r.km | number:'1.0-0' }}</td>
                      <td class="comm-num">{{ r.revenue | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                      <td class="comm-num">{{ r.cost | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                      <td class="comm-num" [class.pos]="r.margin >= 0" [class.neg]="r.margin < 0">{{ r.margin | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                      <td class="comm-num" [class.pos]="r.margin_pct >= 0" [class.neg]="r.margin_pct < 0">{{ r.margin_pct | number:'1.1-1' }}%</td>
                      <td class="comm-num">{{ revenuePerKm(r) | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                    </tr>
                  </ng-template>
                  <ng-template pTemplate="emptymessage">
                    <tr>
                      <td colspan="9" class="comm-empty-cell">
                        <div class="comm-empty">
                          <i class="pi pi-truck comm-empty-icon" aria-hidden="true"></i>
                          <span>Sin embarques en el período.</span>
                        </div>
                      </td>
                    </tr>
                  </ng-template>
                </p-table>
              </div>
            </section>
          </p-tabpanel>

          <!-- ──── Tab 3: Por unidad ──── -->
          <p-tabpanel value="fleet">
            <div class="tab-toolbar">
              <span class="comm-muted is-small">{{ fleetRows().length }} unidades activas en el período</span>
              <button pButton icon="pi pi-file-pdf" label="Exportar PDF (cliente)" severity="secondary" [outlined]="true" size="small" (click)="exportFleetPdf()"></button>
            </div>

            <section class="surf-panel">
              <div class="surf-panel-body is-flush">
                <p-table [value]="fleetRows()" [loading]="loading()" responsiveLayout="scroll" styleClass="surf-table surf-table--sticky surf-table--frozen-first surf-table--zebra p-datatable-sm" sortMode="single">
                  <ng-template pTemplate="header">
                    <tr>
                      <th scope="col" pSortableColumn="plate">Placa <p-sortIcon field="plate"></p-sortIcon></th>
                      <th scope="col">Modelo</th>
                      <th scope="col" pSortableColumn="shipments_count" class="comm-num"># Embarques <p-sortIcon field="shipments_count"></p-sortIcon></th>
                      <th scope="col" pSortableColumn="total_km" class="comm-num">Km <p-sortIcon field="total_km"></p-sortIcon></th>
                      <th scope="col" pSortableColumn="total_revenue" class="comm-num">Ingreso <p-sortIcon field="total_revenue"></p-sortIcon></th>
                      <th scope="col" pSortableColumn="total_cost" class="comm-num">Costo <p-sortIcon field="total_cost"></p-sortIcon></th>
                      <th scope="col" pSortableColumn="margin" class="comm-num">Margen <p-sortIcon field="margin"></p-sortIcon></th>
                      <th scope="col" class="comm-num">Ing/km</th>
                    </tr>
                  </ng-template>
                  <ng-template pTemplate="body" let-v>
                    <tr>
                      <td><code class="comm-code">{{ v.plate }}</code></td>
                      <td class="is-small">{{ v.model || '—' }}</td>
                      <td class="comm-num">{{ v.shipments_count }}</td>
                      <td class="comm-num">{{ v.total_km | number:'1.0-0' }}</td>
                      <td class="comm-num">{{ v.total_revenue | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                      <td class="comm-num">{{ v.total_cost | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                      <td class="comm-num" [class.pos]="v.margin >= 0" [class.neg]="v.margin < 0">{{ v.margin | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                      <td class="comm-num">{{ revenuePerKmFleet(v) | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                    </tr>
                  </ng-template>
                  <ng-template pTemplate="emptymessage">
                    <tr>
                      <td colspan="8" class="comm-empty-cell">
                        <div class="comm-empty">
                          <i class="pi pi-car comm-empty-icon" aria-hidden="true"></i>
                          <span>Sin unidades activas en el período.</span>
                        </div>
                      </td>
                    </tr>
                  </ng-template>
                </p-table>
              </div>
            </section>
          </p-tabpanel>

          <!-- ──── Tab 4: ROI / historia de ahorro ──── -->
          <p-tabpanel value="roi">
            <ng-container *ngIf="roi() as r">
              <div class="surf-grid logr-kpis">
                <app-metric-card class="panel-col-6" [large]="true"
                  label="Margen" accent="var(--action)"
                  [value]="r.margin" format="currency"
                  [sub]="(r.margin_pct | number:'1.1-1') + '% del flete'"></app-metric-card>
                <app-metric-card class="panel-col-3"
                  label="Costo / km" accent="var(--warn-fg)"
                  [value]="r.cost_per_km" format="currency"
                  [sub]="(r.km | number:'1.0-0') + ' km · ' + r.shipments + ' embarques'"></app-metric-card>
                <app-metric-card class="panel-col-3"
                  label="Combustible" accent="var(--chart-2)"
                  [value]="r.fuel_cost" format="currency"
                  [sub]="(r.fuel_pct_of_operating | number:'1.0-0') + '% del costo operativo'"></app-metric-card>
                <app-metric-card [class]="r.km_saved_optimization ? 'panel-col-6' : 'panel-col-12'"
                  label="Mantenimiento" accent="var(--c-text-3)"
                  [value]="r.maintenance_cost" format="currency" sub="Servicios del período"></app-metric-card>
                <app-metric-card *ngIf="r.km_saved_optimization" class="panel-col-6"
                  label="Km ahorrados (ruteo)" variant="ember"
                  [value]="r.km_saved_optimization" format="number" [decimals]="1"
                  sub="vs ruta sin optimizar"></app-metric-card>
              </div>

              <div class="surf-grid logr-detail">
                <section class="surf-panel panel-col-6">
                  <div class="surf-panel-head"><h3><i class="pi pi-money-bill" aria-hidden="true"></i> Desglose de costo operativo</h3></div>
                  <div class="surf-panel-body">
                    <div class="rep-row"><span>Combustible</span><strong>{{ r.cost_breakdown.fuel | currency:'MXN':'symbol-narrow':'1.2-2' }}</strong></div>
                    <div class="rep-row"><span>Casetas</span><strong>{{ r.cost_breakdown.tolls | currency:'MXN':'symbol-narrow':'1.2-2' }}</strong></div>
                    <div class="rep-row"><span>Viáticos chofer</span><strong>{{ r.cost_breakdown.driver_per_diem | currency:'MXN':'symbol-narrow':'1.2-2' }}</strong></div>
                    <div class="rep-row"><span>Maniobras</span><strong>{{ r.cost_breakdown.handling | currency:'MXN':'symbol-narrow':'1.2-2' }}</strong></div>
                    <div class="rep-row"><span>Talachas</span><strong>{{ r.cost_breakdown.repairs | currency:'MXN':'symbol-narrow':'1.2-2' }}</strong></div>
                    <div class="rep-row"><span>Otros</span><strong>{{ r.cost_breakdown.otros | currency:'MXN':'symbol-narrow':'1.2-2' }}</strong></div>
                  </div>
                </section>
                <section class="surf-panel panel-col-6">
                  <div class="surf-panel-head"><h3><i class="pi pi-history" aria-hidden="true"></i> Historia del período</h3></div>
                  <div class="surf-panel-body">
                    <div class="rep-row"><span>Flete cobrado</span><strong>{{ r.revenue_freight | currency:'MXN':'symbol-narrow':'1.2-2' }}</strong></div>
                    <div class="rep-row"><span>Costo total de viajes</span><strong>{{ r.cost_total | currency:'MXN':'symbol-narrow':'1.2-2' }}</strong></div>
                    <div class="rep-row"><span>Mantenimiento</span><strong>{{ r.maintenance_cost | currency:'MXN':'symbol-narrow':'1.2-2' }}</strong></div>
                    <div class="rep-row"><span>Margen</span><strong [class.neg]="r.margin < 0">{{ r.margin | currency:'MXN':'symbol-narrow':'1.2-2' }}</strong></div>
                  </div>
                </section>
              </div>
            </ng-container>
          </p-tabpanel>

          <!-- ──── Tab 5: Embarques ERP (KV.8 — histórico Kepler, read-only) ──── -->
          <p-tabpanel value="erp">
            <div class="tab-toolbar">
              <div class="erp-controls">
                <p-select [options]="erpDims" [(ngModel)]="erpGroupBy" optionLabel="label" optionValue="value"
                          (onChange)="loadErp()" styleClass="erp-dim"></p-select>
                <span class="comm-muted is-small">Fuente: <strong>ERP Kepler</strong> (embarques reales, read-only). Distinto de los embarques operativos de la app.</span>
              </div>
              <button pButton icon="pi pi-refresh" [text]="true" severity="secondary" size="small" (click)="loadErp()" [loading]="erpLoading()"></button>
            </div>

            <ng-container *ngIf="erp() as e">
              <div class="surf-grid logr-kpis">
                <app-metric-card class="panel-col-3" label="Folios de embarque" [value]="e.totals.folios" format="number" accent="var(--action)"
                  [sub]="e.totals.embarcados + ' EMBARCADO'"></app-metric-card>
                <app-metric-card class="panel-col-3" label="Unidades embarcadas" [value]="e.totals.units" format="number" accent="var(--chart-2)"></app-metric-card>
                <app-metric-card class="panel-col-3" label="Líneas" [value]="e.totals.lines" format="number" accent="var(--chart-6)"></app-metric-card>
                <app-metric-card class="panel-col-3" label="Rango de datos" [value]="0" format="number" accent="var(--c-text-3)"
                  [sub]="(e.totals.date_from || '—') + ' → ' + (e.totals.date_to || '—')"></app-metric-card>
              </div>

              <section class="surf-panel" style="margin-top:1rem;">
                <div class="surf-panel-body is-flush">
                  <p-table [value]="e.rows" [loading]="erpLoading()" responsiveLayout="scroll" styleClass="surf-table surf-table--sticky surf-table--frozen-first surf-table--zebra p-datatable-sm" [paginator]="e.rows.length > 25" [rows]="25" sortMode="single">
                    <ng-template pTemplate="header">
                      <tr>
                        <th scope="col">{{ erpDimLabel() }}</th>
                        <th scope="col" pSortableColumn="folios" class="comm-num">Folios <p-sortIcon field="folios"></p-sortIcon></th>
                        <th scope="col" pSortableColumn="units" class="comm-num">Unidades <p-sortIcon field="units"></p-sortIcon></th>
                        <th scope="col" pSortableColumn="lines" class="comm-num">Líneas <p-sortIcon field="lines"></p-sortIcon></th>
                      </tr>
                    </ng-template>
                    <ng-template pTemplate="body" let-r>
                      <tr>
                        <td>{{ r.label }}</td>
                        <td class="comm-num">{{ r.folios | number:'1.0-0' }}</td>
                        <td class="comm-num">{{ r.units | number:'1.0-0' }}</td>
                        <td class="comm-num">{{ r.lines | number:'1.0-0' }}</td>
                      </tr>
                    </ng-template>
                    <ng-template pTemplate="emptymessage">
                      <tr>
                        <td colspan="4" class="comm-empty-cell">
                          <div class="comm-empty">
                            <i class="pi pi-database comm-empty-icon" aria-hidden="true"></i>
                            <span>Sin embarques del ERP en el período. ¿Ya corriste el feed KV.8?</span>
                          </div>
                        </td>
                      </tr>
                    </ng-template>
                  </p-table>
                </div>
              </section>
            </ng-container>
          </p-tabpanel>
        </p-tabpanels>
      </p-tabs>
    </div>
  `,
  styles: [`
    :host { display:block; }
    .is-small { font-size: var(--fs-xs); color: var(--c-text-2); }
    .filter-bar { display:flex; gap:.5rem; align-items:flex-end; flex-wrap:wrap; }

    /* KPIs en metric-tiles + paneles canónicos (margen top porque van dentro del tab). */
    .logr-kpis, .logr-detail { margin-top: 1rem; }
    .logr-badges { display:flex; gap:.4rem; flex-wrap:wrap; }

    /* Filas de desglose dentro de surf-panel-body */
    .rep-row {
      display:flex; justify-content:space-between; gap:1rem;
      padding:.45rem 0; border-bottom:1px dashed var(--c-divider);
      font-size: var(--fs-sm);
    }
    .rep-row:last-child { border-bottom: 0; }
    .rep-row.is-sub { color: var(--c-text-2); padding-left: .5rem; }
    .rep-row strong { font-variant-numeric: tabular-nums; font-weight: var(--fw-bold); }

    .tab-toolbar { display:flex; justify-content:space-between; align-items:center; margin: 0 0 1rem; gap: 1rem; flex-wrap: wrap; }
    .erp-controls { display:flex; align-items:center; gap:.75rem; flex-wrap:wrap; }
    :host ::ng-deep .erp-dim { min-width: 170px; }

    /* Dirección crítica del margen en celdas numéricas */
    .pos { color: var(--c-ok); font-weight: var(--fw-medium); }
    .neg { color: var(--c-bad); font-weight: var(--fw-medium); }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogisticaReportsComponent {
  private readonly api = inject(LogisticaService);
  private readonly toast = inject(MessageService);

  from: Date | null = (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d; })();
  to: Date | null = new Date();

  readonly kpi = signal<KpiSummary | null>(null);
  readonly overview = signal<AnalyticsOverview | null>(null);
  readonly shipmentRows = signal<ShipmentProfitabilityRow[]>([]);
  readonly fleetRows = signal<FleetUtilizationRow[]>([]);
  readonly roi = signal<RoiSummary | null>(null);
  readonly kpis = signal<KpiCards | null>(null);
  readonly loading = signal(false);

  // KV.8 — Embarques ERP (histórico Kepler, read-only).
  readonly erp = signal<ErpShipmentsResponse | null>(null);
  readonly erpLoading = signal(false);
  erpGroupBy = 'route';
  readonly erpDims = [
    { label: 'Por ruta', value: 'route' },
    { label: 'Por estado', value: 'status' },
    { label: 'Por almacén', value: 'warehouse' },
    { label: 'Por día', value: 'day' },
    { label: 'Por producto', value: 'product' },
  ];

  constructor() {
    this.reload();
  }

  erpDimLabel(): string {
    return this.erpDims.find((d) => d.value === this.erpGroupBy)?.label.replace('Por ', '') ?? 'Dimensión';
  }

  loadErp(): void {
    this.erpLoading.set(true);
    this.api.erpShipments({ group_by: this.erpGroupBy, from: this.fmtDate(this.from), to: this.fmtDate(this.to) }).subscribe({
      next: (r) => { this.erp.set(r); this.erpLoading.set(false); },
      error: () => { this.erpLoading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se cargaron los embarques ERP' }); },
    });
  }

  fmtDate(d: Date | null): string | undefined {
    if (!d) return undefined;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  reload(): void {
    this.loading.set(true);
    this.loadErp();
    const f = this.fmtDate(this.from);
    const t = this.fmtDate(this.to);
    forkJoin({
      kpi: this.api.kpiSummary(f, t),
      ov: this.api.analyticsOverview(f, t),
      kpis: this.api.analyticsKpiCards(f, t),
      ships: this.api.shipmentProfitability({ from: f, to: t, limit: 200 }),
      fleet: this.api.fleetUtilization(f, t),
      roi: this.api.analyticsRoi(f, t),
    }).subscribe({
      next: ({ kpi, ov, kpis, ships, fleet, roi }) => {
        this.kpi.set(kpi);
        this.overview.set(ov);
        this.kpis.set(kpis);
        this.shipmentRows.set(ships || []);
        this.fleetRows.set(fleet || []);
        this.roi.set(roi);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se cargaron los reportes' });
      },
    });
  }

  revenuePerKm(r: ShipmentProfitabilityRow): number {
    return r.km > 0 ? r.revenue / r.km : 0;
  }
  revenuePerKmFleet(v: FleetUtilizationRow): number {
    return v.total_km > 0 ? v.total_revenue / v.total_km : 0;
  }

  /** Descarga PDF ejecutivo (backend jspdf). */
  downloadExecutivePdf(): void {
    this.api.downloadKpiPdf(this.fmtDate(this.from), this.fmtDate(this.to)).subscribe({
      next: (blob) => this.triggerDownload(blob, `kpi-logistica-${this.fmtDate(this.from) || 'ini'}-${this.fmtDate(this.to) || 'fin'}.pdf`),
      error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se descargó PDF' }),
    });
  }

  /** Exporta tabla "Por embarque" como PDF generado en el cliente (jsPDF). */
  async exportShipmentsPdf(): Promise<void> {
    const rows = this.shipmentRows();
    if (rows.length === 0) {
      this.toast.add({ severity: 'warn', summary: 'Sin data', detail: 'No hay embarques para exportar' });
      return;
    }
    const { jsPDF } = await import('jspdf');
    const autoTableMod = await import('jspdf-autotable');
    const autoTable = (autoTableMod.default || autoTableMod) as any;

    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    doc.setFontSize(16);
    doc.text('Rentabilidad por embarque', 40, 50);
    doc.setFontSize(10);
    doc.setTextColor(120);
    doc.text(`Período: ${this.fmtDate(this.from) || 'inicio'}  →  ${this.fmtDate(this.to) || 'fin'}`, 40, 68);
    doc.text(`Generado: ${new Date().toLocaleString('es-MX')}`, 40, 82);
    doc.setTextColor(0);

    autoTable(doc, {
      startY: 100,
      head: [['Folio', 'Fecha', 'Ruta', 'Km', 'Ingreso', 'Costo', 'Margen', '% Margen', 'Ing/km']],
      body: rows.map((r) => [
        r.folio,
        new Date(r.shipment_date).toLocaleDateString('es-MX'),
        r.route_name || '—',
        String(r.km || 0),
        this.fmtMoney(r.revenue),
        this.fmtMoney(r.cost),
        this.fmtMoney(r.margin),
        `${(r.margin_pct || 0).toFixed(1)}%`,
        this.fmtMoney(this.revenuePerKm(r)),
      ]),
      styles: { fontSize: 8, cellPadding: 3 },
      headStyles: { fillColor: [240, 90, 40], textColor: 255 },
      columnStyles: {
        3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' },
        6: { halign: 'right' }, 7: { halign: 'right' }, 8: { halign: 'right' },
      },
    });

    // Total row al final
    const totalRevenue = rows.reduce((a, r) => a + (Number(r.revenue) || 0), 0);
    const totalCost = rows.reduce((a, r) => a + (Number(r.cost) || 0), 0);
    const totalMargin = totalRevenue - totalCost;
    doc.setFontSize(10);
    const yPos = (doc as any).lastAutoTable.finalY + 16;
    doc.setFont('helvetica', 'bold');
    doc.text(
      `Total: Ingreso ${this.fmtMoney(totalRevenue)}  ·  Costo ${this.fmtMoney(totalCost)}  ·  Margen ${this.fmtMoney(totalMargin)}`,
      40, yPos,
    );

    const arrayBuffer = doc.output('arraybuffer');
    this.triggerDownload(new Blob([arrayBuffer], { type: 'application/pdf' }), `reporte-embarques.pdf`);
  }

  /** Exporta tabla "Por unidad" como PDF generado en el cliente (jsPDF). */
  async exportFleetPdf(): Promise<void> {
    const rows = this.fleetRows();
    if (rows.length === 0) {
      this.toast.add({ severity: 'warn', summary: 'Sin data', detail: 'No hay unidades activas' });
      return;
    }
    const { jsPDF } = await import('jspdf');
    const autoTableMod = await import('jspdf-autotable');
    const autoTable = (autoTableMod.default || autoTableMod) as any;

    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    doc.setFontSize(16);
    doc.text('Utilización por unidad', 40, 50);
    doc.setFontSize(10);
    doc.setTextColor(120);
    doc.text(`Período: ${this.fmtDate(this.from) || 'inicio'}  →  ${this.fmtDate(this.to) || 'fin'}`, 40, 68);
    doc.text(`Generado: ${new Date().toLocaleString('es-MX')}`, 40, 82);
    doc.setTextColor(0);

    autoTable(doc, {
      startY: 100,
      head: [['Placa', 'Modelo', '# Embarques', 'Km', 'Ingreso', 'Costo', 'Margen', 'Ing/km']],
      body: rows.map((v) => [
        v.plate,
        v.model || '—',
        String(v.shipments_count || 0),
        String(v.total_km || 0),
        this.fmtMoney(v.total_revenue),
        this.fmtMoney(v.total_cost),
        this.fmtMoney(v.margin),
        this.fmtMoney(this.revenuePerKmFleet(v)),
      ]),
      styles: { fontSize: 8, cellPadding: 3 },
      headStyles: { fillColor: [240, 90, 40], textColor: 255 },
      columnStyles: {
        2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' },
        5: { halign: 'right' }, 6: { halign: 'right' }, 7: { halign: 'right' },
      },
    });

    const arrayBuffer = doc.output('arraybuffer');
    this.triggerDownload(new Blob([arrayBuffer], { type: 'application/pdf' }), `reporte-unidades.pdf`);
  }

  private triggerDownload(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  private fmtMoney(n: number): string {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(n) || 0);
  }
}
