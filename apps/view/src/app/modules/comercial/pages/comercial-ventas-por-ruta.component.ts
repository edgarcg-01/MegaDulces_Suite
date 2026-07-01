import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import {
  ComercialService,
  SalesByRouteParams,
  SalesByRouteReport,
  SalesByRouteRow,
  SellOutWarehouseRow,
} from '../comercial.service';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { REPORTS_TABS } from '../reports-tabs';

const MES: Record<string, string> = {
  '01': 'Ene', '02': 'Feb', '03': 'Mar', '04': 'Abr', '05': 'May', '06': 'Jun',
  '07': 'Jul', '08': 'Ago', '09': 'Sep', '10': 'Oct', '11': 'Nov', '12': 'Dic',
};

/** RR — Ventas por Ruta (venta mensual por sucursal×ruta, serie de folio Kepler). */
@Component({
  selector: 'app-comercial-ventas-por-ruta',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, SelectModule, MultiSelectModule,
    ToastModule, PageTabsComponent,
  ],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="reportTabs" />

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Ventas por ruta</h1>
          <p class="surf-page-sub">Venta real por sucursal y ruta, mes a mes · importe · tickets · exporta XLSX</p>
        </div>
      </header>

      <div class="rr-filters card-premium card-flat">
        <div class="rr-field rr-year">
          <label>Año</label>
          <p-select [options]="yearOpts()" [(ngModel)]="year" appendTo="body" (onChange)="load()" />
        </div>
        <div class="rr-field rr-wh">
          <label>Sucursales</label>
          <p-multiSelect [options]="warehouseOpts()" [(ngModel)]="warehouses" optionLabel="name" optionValue="code"
                         placeholder="Todas" [showClear]="true" appendTo="body" styleClass="w-full" (onPanelHide)="load()" />
        </div>
        <div class="rr-actions">
          <button pButton label="Consultar" icon="pi pi-search" size="small" [loading]="loading()" (click)="load()"></button>
        </div>
      </div>

      @if (report(); as r) {
        @if (r.rows.length) {
          <div class="rr-kpis">
            <div class="rr-kpi"><span class="rr-kpi-l">Venta total</span><span class="rr-kpi-v">{{ r.totals.revenue | currency:'MXN':'symbol-narrow':'1.0-0' }}</span></div>
            <div class="rr-kpi"><span class="rr-kpi-l">Rutas</span><span class="rr-kpi-v">{{ r.rows.length }}</span></div>
            <div class="rr-kpi"><span class="rr-kpi-l">Tickets</span><span class="rr-kpi-v">{{ r.totals.tickets | number }}</span></div>
            <div class="rr-kpi"><span class="rr-kpi-l">Unidades</span><span class="rr-kpi-v">{{ r.totals.units | number:'1.0-0' }}</span></div>
          </div>

          <div class="so-actions-bar">
            <span class="text-xs text-content-muted">{{ r.rows.length }} rutas · año {{ r.year }}</span>
            <button pButton label="XLSX" icon="pi pi-file-excel" size="small" severity="secondary" [outlined]="true"
                    [loading]="dl()" (click)="download()"></button>
          </div>

          <div class="card-premium card-flat rr-table-card">
            <div class="rr-wrap">
              <table class="rr-table">
                <thead>
                  <tr>
                    <th class="frz c0">Sucursal</th>
                    <th class="frz c1">Ruta</th>
                    @for (m of r.months; track m) { <th class="n">{{ mes(m) }}</th> }
                    <th class="n b">Total</th>
                    <th class="n">Share</th>
                    <th class="n">Tickets</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of r.rows; track row.warehouse_code + row.route_code) {
                    <tr>
                      <td class="frz c0">{{ row.warehouse_name }}</td>
                      <td class="frz c1 b">Ruta {{ row.route_no }}</td>
                      @for (m of r.months; track m) {
                        <td class="n">{{ cell(row, m)?.revenue ? (cell(row, m)!.revenue | currency:'MXN':'symbol-narrow':'1.0-0') : '·' }}</td>
                      }
                      <td class="n b">{{ row.revenue_total | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                      <td class="n share">{{ row.share_pct | number:'1.0-1' }}%</td>
                      <td class="n">{{ row.tickets_total | number }}</td>
                    </tr>
                  }
                </tbody>
                <tfoot>
                  <tr class="tot">
                    <td class="frz c0" colspan="2">TOTAL</td>
                    @for (m of r.months; track m) {
                      <td class="n">{{ r.monthly_totals[m]?.revenue ? (r.monthly_totals[m].revenue | currency:'MXN':'symbol-narrow':'1.0-0') : '·' }}</td>
                    }
                    <td class="n b">{{ r.totals.revenue | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                    <td class="n">100%</td>
                    <td class="n">{{ r.totals.tickets | number }}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        } @else {
          <div class="comm-empty"><div class="comm-empty-icon"><i class="pi pi-inbox"></i></div>
            <h3>Sin resultados</h3><p>No hay ventas de ruta para los filtros elegidos.</p></div>
        }
      } @else {
        <div class="comm-empty"><div class="comm-empty-icon"><i class="pi pi-directions"></i></div>
          <h3>Ventas por ruta</h3><p>Elegí año y sucursales; el reporte carga automáticamente.</p></div>
      }
    </div>
  `,
  styles: [`
    .rr-filters { display:flex; flex-wrap:wrap; gap:.75rem 1rem; align-items:flex-end; margin-bottom:1rem; }
    .rr-field { display:flex; flex-direction:column; gap:.3rem; }
    .rr-field > label { font-size:.72rem; font-weight:600; color:var(--text-muted); text-transform:uppercase; letter-spacing:.03em; }
    .rr-year { max-width:110px; } .rr-wh { min-width:240px; flex:1 1 240px; }
    .rr-actions { margin-left:auto; }
    .rr-kpis { display:flex; flex-wrap:wrap; gap:.75rem; margin-bottom:1rem; }
    .rr-kpi { flex:1 1 160px; border:1px solid var(--border); border-radius:var(--radius-md); padding:.6rem .85rem; background:var(--card-bg); }
    .rr-kpi-l { display:block; font-size:.68rem; font-weight:600; text-transform:uppercase; letter-spacing:.04em; color:var(--text-muted); }
    .rr-kpi-v { display:block; font-size:1.25rem; font-weight:700; margin-top:.15rem; font-variant-numeric:tabular-nums; }
    .so-actions-bar { display:flex; align-items:center; justify-content:space-between; gap:1rem; margin-bottom:1rem; }
    .rr-table-card { padding:1.25rem; }
    .rr-wrap { overflow-x:auto; border:1px solid var(--border); border-radius:var(--radius-md); }
    .rr-table { border-collapse:separate; border-spacing:0; font-size:.78rem; white-space:nowrap; width:100%; }
    .rr-table th, .rr-table td { border-bottom:1px solid var(--border); border-right:1px solid var(--border); padding:.35rem .6rem; }
    .rr-table thead th { background:var(--layout-bg); font-weight:700; text-align:center; position:sticky; top:0; z-index:2; }
    .rr-table td.n, .rr-table th.n { text-align:right; font-variant-numeric:tabular-nums; }
    .rr-table td.b, .rr-table th.b { font-weight:700; }
    .rr-table td.share { color:var(--text-muted); }
    .rr-table .frz { position:sticky; background:var(--card-bg); z-index:1; }
    .rr-table thead .frz { z-index:3; }
    .rr-table .c0 { left:0; } .rr-table .c1 { left:130px; }
    .rr-table tbody tr:hover td:not(.frz) { background:var(--table-hover,var(--layout-bg)); }
    .rr-table tfoot .tot td { font-weight:700; background:var(--layout-bg); position:sticky; bottom:0; }
    .rr-table tfoot .tot .frz { z-index:1; }
  `],
})
export class ComercialVentasPorRutaComponent {
  readonly reportTabs = REPORTS_TABS;
  private readonly svc = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  warehouseOpts = signal<SellOutWarehouseRow[]>([]);
  loading = signal(false);
  dl = signal(false);
  report = signal<SalesByRouteReport | null>(null);

  year = new Date().getFullYear();
  warehouses: string[] = [];

  yearOpts = computed(() => { const y = new Date().getFullYear(); return [y, y - 1, y - 2]; });

  constructor() {
    this.svc.sellOutWarehouses().pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (w) => this.warehouseOpts.set(w), error: () => undefined });
    this.load();
  }

  private params(): SalesByRouteParams {
    return { year: this.year, warehouses: this.warehouses.length ? this.warehouses : undefined };
  }

  load() {
    this.loading.set(true);
    this.svc.salesByRoute(this.params())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.report.set(r); this.loading.set(false); },
        error: (e) => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error al consultar', detail: e?.error?.message }); },
      });
  }

  download() {
    this.dl.set(true);
    this.svc.salesByRouteDownloadXlsx(this.params())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (resp) => {
          this.dl.set(false);
          const cd = resp.headers.get('content-disposition') || '';
          const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
          const name = m ? decodeURIComponent(m[1]) : `Ventas_por_Ruta_${this.year}.xlsx`;
          const url = URL.createObjectURL(resp.body!);
          const a = document.createElement('a'); a.href = url; a.download = name; a.click();
          URL.revokeObjectURL(url);
        },
        error: () => { this.dl.set(false); this.toast.add({ severity: 'error', summary: 'Error al descargar XLSX' }); },
      });
  }

  mes(m: string): string { return MES[m] ?? m; }
  cell(row: SalesByRouteRow, m: string) { return row.monthly[m]; }
}
