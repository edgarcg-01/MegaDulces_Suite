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
  SalesByRouteDetail,
  SalesByRouteOption,
  SalesByRouteParams,
  SalesByRouteReport,
  SalesByRouteRow,
} from '../comercial.service';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { REPORTS_TABS } from '../reports-tabs';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';

type DetailTab = 'productos' | 'dias' | 'clientes' | 'tickets';

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
    ToastModule, TableModule, PageTabsComponent, SidePeekComponent,
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
          <label>Rutas</label>
          <p-multiSelect [options]="routeOpts()" [(ngModel)]="routes" optionLabel="label" optionValue="value"
                         placeholder="Todas" [showClear]="true" [filter]="true" appendTo="body" styleClass="w-full" (onPanelHide)="load()" />
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
                <tr class="rr-row" (click)="openRoute(row)" title="Ver desglose de la ruta">
                  <td pFrozenColumn class="comm-cell-strong">{{ row.warehouse_name }}</td>
                  <td pFrozenColumn class="rr-strong"><span class="rr-link">Ruta {{ row.route_no }}</span></td>
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
          <h3>Ventas por ruta</h3><p>Elegí las rutas; el reporte carga automáticamente.</p></div>
      }

      <app-side-peek [(open)]="peekOpen"
                     [title]="detail()?.warehouse_name || 'Ruta'"
                     [subtitle]="detail() ? ('Ruta ' + detail()!.route_no + ' · ' + detail()!.year) : null">
        @if (detailLoading()) {
          <div class="rr-detail-loading"><i class="pi pi-spin pi-spinner"></i> Cargando desglose…</div>
        }
        @if (detail(); as d) {
          <div class="rr-dkpis">
            <div class="rr-dkpi"><span>Venta</span><b>{{ d.totals.revenue | currency:'MXN':'symbol-narrow':'1.0-0' }}</b></div>
            <div class="rr-dkpi"><span>Tickets</span><b>{{ d.totals.tickets | number }}</b></div>
            <div class="rr-dkpi"><span>Unidades</span><b>{{ d.totals.units | number:'1.0-0' }}</b></div>
            <div class="rr-dkpi"><span>SKUs</span><b>{{ d.totals.skus | number }}</b></div>
            <div class="rr-dkpi"><span>Clientes</span><b>{{ d.totals.clients | number }}</b></div>
          </div>

          <div class="rr-tabs" role="tablist">
            <button type="button" role="tab" [class.on]="tab()==='productos'" [attr.aria-selected]="tab()==='productos'" (click)="tab.set('productos')">Productos</button>
            <button type="button" role="tab" [class.on]="tab()==='dias'" [attr.aria-selected]="tab()==='dias'" (click)="tab.set('dias')">Por día</button>
            <button type="button" role="tab" [class.on]="tab()==='clientes'" [attr.aria-selected]="tab()==='clientes'" (click)="tab.set('clientes')">Clientes</button>
            <button type="button" role="tab" [class.on]="tab()==='tickets'" [attr.aria-selected]="tab()==='tickets'" (click)="tab.set('tickets')">Tickets</button>
          </div>

          @switch (tab()) {
            @case ('productos') {
              <p-table [value]="detail()!.products" styleClass="p-datatable-sm surf-table" [scrollable]="true" scrollHeight="52vh">
                <ng-template pTemplate="header"><tr>
                  <th scope="col">Producto</th><th scope="col" class="comm-num">Unid</th>
                  <th scope="col" class="comm-num">Importe</th><th scope="col" class="comm-num">%</th></tr>
                </ng-template>
                <ng-template pTemplate="body" let-p><tr>
                  <td class="rr-prod"><span class="rr-sku">{{ p.sku }}</span> {{ p.name }}</td>
                  <td class="comm-num">{{ p.units | number:'1.0-0' }}</td>
                  <td class="comm-num rr-strong">{{ p.revenue | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  <td class="comm-num comm-muted">{{ p.share_pct | number:'1.0-1' }}%</td></tr>
                </ng-template>
              </p-table>
              <p class="rr-note">Top 50 por importe.</p>
            }
            @case ('dias') {
              <p-table [value]="detail()!.daily" styleClass="p-datatable-sm surf-table" [scrollable]="true" scrollHeight="52vh">
                <ng-template pTemplate="header"><tr>
                  <th scope="col">Día</th><th scope="col" class="comm-num">Tickets</th>
                  <th scope="col" class="comm-num">Venta</th><th scope="col" class="rr-barcol"></th></tr>
                </ng-template>
                <ng-template pTemplate="body" let-x><tr>
                  <td>{{ x.date }}</td>
                  <td class="comm-num">{{ x.tickets | number }}</td>
                  <td class="comm-num rr-strong">{{ x.revenue | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  <td class="rr-barcol"><span class="rr-bar" [style.width.%]="barPct(x.revenue)"></span></td></tr>
                </ng-template>
              </p-table>
            }
            @case ('clientes') {
              <p-table [value]="detail()!.clients" styleClass="p-datatable-sm surf-table" [scrollable]="true" scrollHeight="52vh">
                <ng-template pTemplate="header"><tr>
                  <th scope="col">Cliente</th><th scope="col" class="comm-num">Tickets</th>
                  <th scope="col" class="comm-num">Importe</th></tr>
                </ng-template>
                <ng-template pTemplate="body" let-c><tr>
                  <td>{{ c.name }} @if (c.is_public) {<span class="rr-tag">público</span>}</td>
                  <td class="comm-num">{{ c.tickets | number }}</td>
                  <td class="comm-num rr-strong">{{ c.revenue | currency:'MXN':'symbol-narrow':'1.0-0' }}</td></tr>
                </ng-template>
              </p-table>
              <p class="rr-note">Top 50 por importe. "Público" = venta a bordo sin cliente identificado.</p>
            }
            @case ('tickets') {
              <p-table [value]="detail()!.tickets" styleClass="p-datatable-sm surf-table" [scrollable]="true" scrollHeight="52vh">
                <ng-template pTemplate="header"><tr>
                  <th scope="col">Folio</th><th scope="col">Fecha</th>
                  <th scope="col" class="comm-num">Líneas</th><th scope="col" class="comm-num">Importe</th></tr>
                </ng-template>
                <ng-template pTemplate="body" let-t><tr>
                  <td class="rr-mono">{{ t.folio }}</td><td>{{ t.date }}</td>
                  <td class="comm-num">{{ t.lines | number }}</td>
                  <td class="comm-num rr-strong">{{ t.revenue | currency:'MXN':'symbol-narrow':'1.0-0' }}</td></tr>
                </ng-template>
              </p-table>
              <p class="rr-note">Últimos 100 tickets.</p>
            }
          }
        }
      </app-side-peek>
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
    .rr-kpi { flex:1 1 160px; border:1px solid var(--border-color); border-radius:var(--r-md); padding:.6rem .85rem; background:var(--card-bg); }
    .rr-kpi-l { display:block; font-size:.68rem; font-weight:600; text-transform:uppercase; letter-spacing:.04em; color:var(--text-muted); }
    .rr-kpi-v { display:block; font-size:1.25rem; font-weight:700; margin-top:.15rem; font-variant-numeric:tabular-nums; }
    .so-actions-bar { display:flex; align-items:center; justify-content:space-between; gap:1rem; margin-bottom:1rem; }
    .rr-table-card { padding:1.25rem; }
    /* Sticky/frozen/tema los da PrimeNG + surf-table; sólo jerarquía visual acá. */
    .rr-strong { font-weight:700; }
    .rr-foot td { font-weight:700; }
    .rr-row { cursor:pointer; }
    .rr-link { color:var(--action); text-underline-offset:2px; }
    .rr-row:hover .rr-link { text-decoration:underline; }
    /* Detalle (side-peek) */
    .rr-detail-loading { color:var(--text-muted); font-size:.85rem; padding:1rem 0; display:flex; align-items:center; gap:.5rem; }
    .rr-dkpis { display:grid; grid-template-columns:repeat(2,1fr); gap:.5rem; margin-bottom:1rem; }
    .rr-dkpi { border:1px solid var(--border-color); border-radius:var(--r-md); padding:.5rem .7rem; background:var(--card-bg); }
    .rr-dkpi span { display:block; font-size:.64rem; font-weight:600; text-transform:uppercase; letter-spacing:.04em; color:var(--text-muted); }
    .rr-dkpi b { display:block; font-size:1.05rem; margin-top:.1rem; font-variant-numeric:tabular-nums; }
    .rr-tabs { display:flex; gap:.25rem; border-bottom:1px solid var(--border-color); margin-bottom:.75rem; }
    .rr-tabs button { appearance:none; background:none; border:none; border-bottom:2px solid transparent; padding:.5rem .6rem; font-size:.8rem; font-weight:600; color:var(--text-muted); cursor:pointer; }
    .rr-tabs button:hover { color:var(--text-main); }
    .rr-tabs button.on { color:var(--text-main); border-bottom-color:var(--action); }
    .rr-tabs button:focus-visible { outline:2px solid var(--action); outline-offset:2px; }
    .rr-prod { max-width:230px; }
    .rr-sku { color:var(--text-muted); font-variant-numeric:tabular-nums; margin-right:.35rem; }
    .rr-mono { font-variant-numeric:tabular-nums; }
    .rr-tag { display:inline-block; margin-left:.4rem; font-size:.62rem; padding:.05rem .35rem; border-radius:var(--r-sm); background:var(--hover-bg); color:var(--text-muted); text-transform:uppercase; letter-spacing:.03em; }
    .rr-note { margin:.5rem 0 0; font-size:.68rem; color:var(--text-muted); }
    .rr-barcol { width:80px; }
    .rr-bar { display:block; height:8px; border-radius:4px; background:var(--action); opacity:.55; }
  `],
})
export class ComercialVentasPorRutaComponent {
  readonly reportTabs = REPORTS_TABS;
  private readonly svc = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  routeOpts = signal<SalesByRouteOption[]>([]);
  loading = signal(false);
  dl = signal(false);
  report = signal<SalesByRouteReport | null>(null);

  year = new Date().getFullYear();
  routes: string[] = [];

  // Desglose (side-peek)
  peekOpen = signal(false);
  detail = signal<SalesByRouteDetail | null>(null);
  detailLoading = signal(false);
  tab = signal<DetailTab>('productos');
  private dailyMax = 1;

  yearOpts = computed(() => { const y = new Date().getFullYear(); return [y, y - 1, y - 2]; });

  constructor() {
    this.svc.salesByRouteRoutes().pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (r) => this.routeOpts.set(r), error: () => undefined });
    this.load();
  }

  private params(): SalesByRouteParams {
    return { year: this.year, routes: this.routes.length ? this.routes : undefined };
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

  openRoute(row: SalesByRouteRow) {
    this.tab.set('productos');
    this.detail.set(null);
    this.detailLoading.set(true);
    this.peekOpen.set(true);
    this.svc.salesByRouteDetail(row.route_code, this.year)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (d) => {
          this.dailyMax = Math.max(1, ...d.daily.map((x) => x.revenue));
          this.detail.set(d);
          this.detailLoading.set(false);
        },
        error: (e) => {
          this.detailLoading.set(false);
          this.peekOpen.set(false);
          this.toast.add({ severity: 'error', summary: 'Error al cargar el desglose', detail: e?.error?.message });
        },
      });
  }

  barPct(v: number): number { return this.dailyMax > 0 ? Math.round((v / this.dailyMax) * 100) : 0; }

  mes(m: string): string { return MES[m] ?? m; }
  cell(row: SalesByRouteRow, m: string) { return row.monthly[m]; }
}
