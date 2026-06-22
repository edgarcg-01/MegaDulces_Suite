import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { TabsModule } from 'primeng/tabs';
import { DatePickerModule } from 'primeng/datepicker';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { forkJoin } from 'rxjs';
import {
  AnalyticsOverview,
  FleetUtilizationRow,
  KpiSummary,
  LogisticaService,
  RoiSummary,
  ShipmentProfitabilityRow,
} from '../logistica.service';

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
    ButtonModule, CardModule, TableModule, TagModule, TabsModule,
    DatePickerModule, ToastModule,
  ],
  providers: [MessageService],
  template: `
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
        <button pButton icon="pi pi-file-pdf" label="PDF ejecutivo" severity="secondary" (click)="downloadExecutivePdf()"></button>
      </div>
    </header>

    <p-tabs value="overview">
      <p-tablist>
        <p-tab value="overview"><i class="pi pi-th-large"></i> Overview</p-tab>
        <p-tab value="shipments"><i class="pi pi-truck"></i> Por embarque ({{ shipmentRows().length }})</p-tab>
        <p-tab value="fleet"><i class="pi pi-car"></i> Por unidad ({{ fleetRows().length }})</p-tab>
        <p-tab value="roi"><i class="pi pi-dollar"></i> ROI</p-tab>
      </p-tablist>
      <p-tabpanels>

        <!-- ──── Tab 1: Overview KPI ──── -->
        <p-tabpanel value="overview">
          <ng-container *ngIf="kpi() as k">
            <div class="kpi-grid">
              <p-card>
                <div class="kpi-label">Embarques totales</div>
                <div class="kpi-value">{{ k.shipments.total }}</div>
                <div class="kpi-sub">
                  <span class="badge ok">✓ {{ k.shipments.cerrados }}</span>
                  <span class="badge danger">✕ {{ k.shipments.cancelados }}</span>
                  <span class="badge warn">⏳ {{ k.shipments.activos }}</span>
                </div>
              </p-card>

              <p-card>
                <div class="kpi-label">Revenue flete</div>
                <div class="kpi-value">\${{ k.financial.revenue | number:'1.2-2' }}</div>
                <div class="kpi-sub muted">Fletes cobrados</div>
              </p-card>

              <p-card>
                <div class="kpi-label">Margen del período</div>
                <div class="kpi-value" [class.neg]="k.financial.margen < 0">
                  \${{ k.financial.margen | number:'1.2-2' }}
                </div>
                <div class="kpi-sub muted">Revenue − Costos − Comisiones</div>
              </p-card>

              <p-card>
                <div class="kpi-label">Costo / km</div>
                <div class="kpi-value">\${{ k.financial.costo_promedio_km | number:'1.2-2' }}</div>
                <div class="kpi-sub muted">{{ k.operations.km_total }} km totales</div>
              </p-card>
            </div>

            <div class="detail-grid">
              <p-card>
                <h3>Operación</h3>
                <div class="row"><span>Km totales</span><strong>{{ k.operations.km_total }}</strong></div>
                <div class="row"><span>Cajas movidas</span><strong>{{ k.operations.cajas }}</strong></div>
              </p-card>

              <p-card>
                <h3>Desglose financiero</h3>
                <div class="row"><span>Revenue flete</span><strong>\${{ k.financial.revenue | number:'1.2-2' }}</strong></div>
                <div class="row"><span>Total costos</span><strong>\${{ k.financial.total_costos | number:'1.2-2' }}</strong></div>
                <div class="row"><span>· Combustible</span><strong>\${{ k.financial.combustible | number:'1.2-2' }}</strong></div>
                <div class="row"><span>· Casetas</span><strong>\${{ k.financial.casetas | number:'1.2-2' }}</strong></div>
                <div class="row"><span>Comisiones pagadas</span><strong>\${{ k.financial.comisiones | number:'1.2-2' }}</strong></div>
                <div class="row"><span>Viáticos</span><strong>\${{ k.financial.viaticos | number:'1.2-2' }}</strong></div>
              </p-card>
            </div>
          </ng-container>
        </p-tabpanel>

        <!-- ──── Tab 2: Por embarque ──── -->
        <p-tabpanel value="shipments">
          <div class="tab-toolbar">
            <span class="muted small">{{ shipmentRows().length }} embarques en el período</span>
            <button pButton icon="pi pi-file-pdf" label="Exportar PDF (cliente)" severity="secondary" size="small" (click)="exportShipmentsPdf()"></button>
          </div>

          <p-card>
            <p-table [value]="shipmentRows()" [loading]="loading()" responsiveLayout="scroll" styleClass="p-datatable-sm" [paginator]="true" [rows]="15" sortMode="single">
              <ng-template pTemplate="header">
                <tr>
                  <th pSortableColumn="folio">Folio <p-sortIcon field="folio"></p-sortIcon></th>
                  <th pSortableColumn="shipment_date">Fecha <p-sortIcon field="shipment_date"></p-sortIcon></th>
                  <th>Ruta</th>
                  <th pSortableColumn="km" class="num">Km <p-sortIcon field="km"></p-sortIcon></th>
                  <th pSortableColumn="revenue" class="num">Ingreso <p-sortIcon field="revenue"></p-sortIcon></th>
                  <th pSortableColumn="cost" class="num">Costo <p-sortIcon field="cost"></p-sortIcon></th>
                  <th pSortableColumn="margin" class="num">Margen <p-sortIcon field="margin"></p-sortIcon></th>
                  <th pSortableColumn="margin_pct" class="num">% Margen <p-sortIcon field="margin_pct"></p-sortIcon></th>
                  <th class="num">Ing/km</th>
                </tr>
              </ng-template>
              <ng-template pTemplate="body" let-r>
                <tr>
                  <td><code>{{ r.folio }}</code></td>
                  <td>{{ r.shipment_date | date:'shortDate' }}</td>
                  <td class="small">{{ r.route_name || '—' }}</td>
                  <td class="num">{{ r.km | number:'1.0-0' }}</td>
                  <td class="num">\${{ r.revenue | number:'1.2-2' }}</td>
                  <td class="num">\${{ r.cost | number:'1.2-2' }}</td>
                  <td class="num" [class.pos]="r.margin >= 0" [class.neg]="r.margin < 0">\${{ r.margin | number:'1.2-2' }}</td>
                  <td class="num" [class.pos]="r.margin_pct >= 0" [class.neg]="r.margin_pct < 0">{{ r.margin_pct | number:'1.1-1' }}%</td>
                  <td class="num">\${{ revenuePerKm(r) | number:'1.2-2' }}</td>
                </tr>
              </ng-template>
              <ng-template pTemplate="emptymessage">
                <tr><td colspan="9" class="muted">Sin embarques en el período.</td></tr>
              </ng-template>
            </p-table>
          </p-card>
        </p-tabpanel>

        <!-- ──── Tab 3: Por unidad ──── -->
        <p-tabpanel value="fleet">
          <div class="tab-toolbar">
            <span class="muted small">{{ fleetRows().length }} unidades activas en el período</span>
            <button pButton icon="pi pi-file-pdf" label="Exportar PDF (cliente)" severity="secondary" size="small" (click)="exportFleetPdf()"></button>
          </div>

          <p-card>
            <p-table [value]="fleetRows()" [loading]="loading()" responsiveLayout="scroll" styleClass="p-datatable-sm" sortMode="single">
              <ng-template pTemplate="header">
                <tr>
                  <th pSortableColumn="plate">Placa <p-sortIcon field="plate"></p-sortIcon></th>
                  <th>Modelo</th>
                  <th pSortableColumn="shipments_count" class="num"># Embarques <p-sortIcon field="shipments_count"></p-sortIcon></th>
                  <th pSortableColumn="total_km" class="num">Km <p-sortIcon field="total_km"></p-sortIcon></th>
                  <th pSortableColumn="total_revenue" class="num">Ingreso <p-sortIcon field="total_revenue"></p-sortIcon></th>
                  <th pSortableColumn="total_cost" class="num">Costo <p-sortIcon field="total_cost"></p-sortIcon></th>
                  <th pSortableColumn="margin" class="num">Margen <p-sortIcon field="margin"></p-sortIcon></th>
                  <th class="num">Ing/km</th>
                </tr>
              </ng-template>
              <ng-template pTemplate="body" let-v>
                <tr>
                  <td><code>{{ v.plate }}</code></td>
                  <td class="small">{{ v.model || '—' }}</td>
                  <td class="num">{{ v.shipments_count }}</td>
                  <td class="num">{{ v.total_km | number:'1.0-0' }}</td>
                  <td class="num">\${{ v.total_revenue | number:'1.2-2' }}</td>
                  <td class="num">\${{ v.total_cost | number:'1.2-2' }}</td>
                  <td class="num" [class.pos]="v.margin >= 0" [class.neg]="v.margin < 0">\${{ v.margin | number:'1.2-2' }}</td>
                  <td class="num">\${{ revenuePerKmFleet(v) | number:'1.2-2' }}</td>
                </tr>
              </ng-template>
              <ng-template pTemplate="emptymessage">
                <tr><td colspan="8" class="muted">Sin unidades activas en el período.</td></tr>
              </ng-template>
            </p-table>
          </p-card>
        </p-tabpanel>

        <!-- ──── Tab 4: ROI / historia de ahorro ──── -->
        <p-tabpanel value="roi">
          <ng-container *ngIf="roi() as r">
            <div class="kpi-grid">
              <p-card>
                <div class="kpi-label">Costo / km</div>
                <div class="kpi-value">\${{ r.cost_per_km | number:'1.2-2' }}</div>
                <div class="kpi-sub muted">{{ r.km | number:'1.0-0' }} km · {{ r.shipments }} embarques</div>
              </p-card>
              <p-card>
                <div class="kpi-label">Margen</div>
                <div class="kpi-value" [class.neg]="r.margin < 0">\${{ r.margin | number:'1.2-2' }}</div>
                <div class="kpi-sub muted">{{ r.margin_pct | number:'1.1-1' }}% del flete</div>
              </p-card>
              <p-card>
                <div class="kpi-label">Combustible</div>
                <div class="kpi-value">\${{ r.fuel_cost | number:'1.2-2' }}</div>
                <div class="kpi-sub muted">{{ r.fuel_pct_of_operating | number:'1.0-0' }}% del costo operativo</div>
              </p-card>
              <p-card>
                <div class="kpi-label">Mantenimiento</div>
                <div class="kpi-value">\${{ r.maintenance_cost | number:'1.2-2' }}</div>
                <div class="kpi-sub muted">Servicios del período</div>
              </p-card>
            </div>

            <div class="detail-grid">
              <p-card>
                <h3>Desglose de costo operativo</h3>
                <div class="row"><span>Combustible</span><strong>\${{ r.cost_breakdown.fuel | number:'1.2-2' }}</strong></div>
                <div class="row"><span>Casetas</span><strong>\${{ r.cost_breakdown.tolls | number:'1.2-2' }}</strong></div>
                <div class="row"><span>Viáticos chofer</span><strong>\${{ r.cost_breakdown.driver_per_diem | number:'1.2-2' }}</strong></div>
                <div class="row"><span>Maniobras</span><strong>\${{ r.cost_breakdown.handling | number:'1.2-2' }}</strong></div>
                <div class="row"><span>Talachas</span><strong>\${{ r.cost_breakdown.repairs | number:'1.2-2' }}</strong></div>
                <div class="row"><span>Otros</span><strong>\${{ r.cost_breakdown.otros | number:'1.2-2' }}</strong></div>
              </p-card>
              <p-card>
                <h3>Historia del período</h3>
                <div class="row"><span>Flete cobrado</span><strong>\${{ r.revenue_freight | number:'1.2-2' }}</strong></div>
                <div class="row"><span>Costo total de viajes</span><strong>\${{ r.cost_total | number:'1.2-2' }}</strong></div>
                <div class="row"><span>Mantenimiento</span><strong>\${{ r.maintenance_cost | number:'1.2-2' }}</strong></div>
                <div class="row"><span>Margen</span><strong [class.neg]="r.margin < 0">\${{ r.margin | number:'1.2-2' }}</strong></div>
              </p-card>
            </div>
          </ng-container>
        </p-tabpanel>
      </p-tabpanels>
    </p-tabs>
  `,
  styles: [`
    :host { display:block; }
    .muted { color: var(--text-color-secondary); font-size:.85rem; margin:0; }
    .small { font-size:.75rem; }
    .filter-bar { display:flex; gap:.5rem; align-items:flex-end; flex-wrap:wrap; }

    .kpi-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:1rem; margin-top:1rem; }
    .kpi-label { color: var(--text-color-secondary); font-size:.8rem; text-transform:uppercase; letter-spacing:.05em; }
    .kpi-value { font-size:1.75rem; font-weight:700; margin-top:.25rem; }
    .kpi-value.neg { color: #dc2626; }
    .kpi-sub { display:flex; gap:.5rem; flex-wrap:wrap; margin-top:.5rem; font-size:.75rem; }
    .badge { padding:.15rem .5rem; border-radius:8px; background: var(--surface-100); }
    .badge.ok { background: var(--green-50, #dcfce7); color: var(--green-700, #15803d); }
    .badge.danger { background: var(--red-50, #fee2e2); color: var(--red-700, #b91c1c); }
    .badge.warn { background: var(--orange-50, #ffedd5); color: var(--orange-700, #c2410c); }

    .detail-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap:1rem; margin-top:1rem; }
    .detail-grid h3 { margin:0 0 .75rem; font-size:1rem; }
    .row { display:flex; justify-content:space-between; padding:.4rem 0; border-bottom: 1px dashed var(--surface-200); }
    .row:last-child { border-bottom: 0; }

    .tab-toolbar { display:flex; justify-content:space-between; align-items:center; margin: 1rem 0; }
    .num { text-align:right; font-variant-numeric: tabular-nums; }
    .num.pos { color: #16a34a; font-weight: 600; }
    .num.neg { color: #dc2626; font-weight: 600; }
    code { background: var(--surface-100); padding:.1rem .35rem; border-radius:3px; font-size:.85rem; }
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
  readonly loading = signal(false);

  constructor() {
    this.reload();
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
    const f = this.fmtDate(this.from);
    const t = this.fmtDate(this.to);
    forkJoin({
      kpi: this.api.kpiSummary(f, t),
      ov: this.api.analyticsOverview(f, t),
      ships: this.api.shipmentProfitability({ from: f, to: t, limit: 200 }),
      fleet: this.api.fleetUtilization(f, t),
      roi: this.api.analyticsRoi(f, t),
    }).subscribe({
      next: ({ kpi, ov, ships, fleet, roi }) => {
        this.kpi.set(kpi);
        this.overview.set(ov);
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
      headStyles: { fillColor: [245, 166, 35], textColor: 255 },
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
      headStyles: { fillColor: [245, 166, 35], textColor: 255 },
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
