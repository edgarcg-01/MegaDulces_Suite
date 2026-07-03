import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { ToastModule } from 'primeng/toast';
import { TableModule } from 'primeng/table';
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
    ToastModule, TableModule, PageTabsComponent,
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
            <p-table [value]="r.rows" [loading]="loading()" [rowHover]="true"
                     [scrollable]="true" scrollHeight="60vh"
                     sortField="revenue_total" [sortOrder]="-1"
                     styleClass="p-datatable-sm surf-table rr-ptable">
              <ng-template pTemplate="header">
                <tr>
                  <th scope="col" pFrozenColumn style="min-width:150px" pSortableColumn="warehouse_name">Sucursal <p-sortIcon field="warehouse_name" /></th>
                  <th scope="col" pFrozenColumn style="min-width:120px" pSortableColumn="route_no">Ruta <p-sortIcon field="route_no" /></th>
                  @for (m of r.months; track m) {
                    <th scope="col" class="comm-num" [pSortableColumn]="'monthly.' + m + '.revenue'">{{ mes(m) }} <p-sortIcon [field]="'monthly.' + m + '.revenue'" /></th>
                  }
                  <th scope="col" class="comm-num rr-strong" pSortableColumn="revenue_total">Total <p-sortIcon field="revenue_total" /></th>
                  <th scope="col" class="comm-num" pSortableColumn="share_pct">Share <p-sortIcon field="share_pct" /></th>
                  <th scope="col" class="comm-num" pSortableColumn="tickets_total">Tickets <p-sortIcon field="tickets_total" /></th>
                </tr>
              </ng-template>
              <ng-template pTemplate="body" let-row>
                <tr>
                  <td pFrozenColumn class="comm-cell-strong">{{ row.warehouse_name }}</td>
                  <td pFrozenColumn class="rr-strong">Ruta {{ row.route_no }}</td>
                  @for (m of r.months; track m) {
                    <td class="comm-num">{{ cell(row, m)?.revenue != null ? (cell(row, m)!.revenue | currency:'MXN':'symbol-narrow':'1.0-0') : '·' }}</td>
                  }
                  <td class="comm-num rr-strong">{{ row.revenue_total | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  <td class="comm-num comm-muted">{{ row.share_pct | number:'1.0-1' }}%</td>
                  <td class="comm-num">{{ row.tickets_total | number }}</td>
                </tr>
              </ng-template>
              <ng-template pTemplate="footer">
                <tr class="rr-foot">
                  <td pFrozenColumn>TOTAL</td>
                  <td pFrozenColumn></td>
                  @for (m of r.months; track m) {
                    <td class="comm-num">{{ r.monthly_totals[m]?.revenue != null ? (r.monthly_totals[m].revenue | currency:'MXN':'symbol-narrow':'1.0-0') : '·' }}</td>
                  }
                  <td class="comm-num rr-strong">{{ r.totals.revenue | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  <td class="comm-num">100%</td>
                  <td class="comm-num">{{ r.totals.tickets | number }}</td>
                </tr>
              </ng-template>
            </p-table>
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
    :host { display:block; }
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
    /* Sticky/frozen/tema los da PrimeNG + surf-table; sólo jerarquía visual acá. */
    .rr-strong { font-weight:700; }
    .rr-foot td { font-weight:700; }
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
