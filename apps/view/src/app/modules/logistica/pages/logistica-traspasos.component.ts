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
  TransfersParams,
  TransfersReport,
  TransfersRow,
  SellOutWarehouseRow,
} from '../../comercial/comercial.service';

const MES: Record<string, string> = {
  '01': 'Ene', '02': 'Feb', '03': 'Mar', '04': 'Abr', '05': 'May', '06': 'Jun',
  '07': 'Jul', '08': 'Ago', '09': 'Sep', '10': 'Oct', '11': 'Nov', '12': 'Dic',
};

/** Fase T — Traspasos: movimientos que NO son venta (consolidación UD06, recepción UA50, traspasos). */
@Component({
  selector: 'app-logistica-traspasos',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, SelectModule, MultiSelectModule, ToastModule,
  ],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Traspasos</h1>
          <p class="surf-page-sub">Movimientos que <strong>NO son venta</strong> — consolidación interna, recepción y traspasos entre sucursales · por sucursal y tipo, mes a mes</p>
        </div>
      </header>

      <div class="tr-note">
        <i class="pi pi-info-circle"></i>
        <span>Estas cifras se excluyen a propósito de los reportes de venta (Sell-Out, Ventas por ruta, Command Center). <strong>Los tipos NO se suman entre sí</strong>: son la misma mercancía en etapas distintas (CEDIS despacha → la sucursal consolida/recibe). Sumarlos = doble conteo.</span>
      </div>

      <div class="tr-filters card-premium card-flat">
        <div class="tr-field tr-year">
          <label>Año</label>
          <p-select [options]="yearOpts()" [(ngModel)]="year" appendTo="body" (onChange)="load()" />
        </div>
        <div class="tr-field tr-wh">
          <label>Sucursales</label>
          <p-multiSelect [options]="warehouseOpts()" [(ngModel)]="warehouses" optionLabel="name" optionValue="code"
                         placeholder="Todas" [showClear]="true" appendTo="body" styleClass="w-full" (onPanelHide)="load()" />
        </div>
        <div class="tr-actions">
          <button pButton label="Consultar" icon="pi pi-search" size="small" [loading]="loading()" (click)="load()"></button>
        </div>
      </div>

      @if (report(); as r) {
        @if (r.rows.length) {
          <div class="tr-kpis">
            @for (k of r.by_kind; track k.kind) {
              <div class="tr-kpi"><span class="tr-kpi-l">{{ k.kind_label }}</span><span class="tr-kpi-v">{{ k.value | currency:'MXN':'symbol-narrow':'1.0-0' }}</span></div>
            }
            <div class="tr-kpi tr-kpi-muted"><span class="tr-kpi-l">Documentos</span><span class="tr-kpi-v">{{ r.totals.docs | number }}</span></div>
          </div>

          <div class="so-actions-bar">
            <span class="text-xs text-content-muted">Año {{ r.year }}</span>
            <button pButton label="XLSX" icon="pi pi-file-excel" size="small" severity="secondary" [outlined]="true"
                    [loading]="dl()" (click)="download()"></button>
          </div>

          <!-- ① Distribución CEDIS → destino (salida_cedis: suma válida dentro de la sección) -->
          @if (salidaRows().length) {
            <section class="tr-sec">
              <div class="tr-sec-head">
                <div class="tr-sec-badge">①</div>
                <div>
                  <h2>Distribución de CEDIS → destino</h2>
                  <span class="tr-sec-sub">Mercancía que CEDIS <strong>despacha</strong> (salida por traspaso) · {{ salidaRows().length }} destinos · <strong>{{ salidaTotal() | currency:'MXN':'symbol-narrow':'1.0-0' }}</strong></span>
                </div>
              </div>
              <div class="card-premium card-flat tr-table-card">
                <div class="tr-wrap">
                  <table class="tr-table">
                    <thead>
                      <tr>
                        <th class="frz c0 wide">Destino (P.V. / TLMKT / Ruta)</th>
                        @for (m of r.months; track m) { <th class="n">{{ mes(m) }}</th> }
                        <th class="n b">Total</th>
                        <th class="n">Share</th>
                        <th class="n">Docs</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (row of salidaRows(); track row.dest_label) {
                        <tr>
                          <td class="frz c0 wide">{{ row.dest_label }}</td>
                          @for (m of r.months; track m) {
                            <td class="n">{{ cell(row, m)?.value ? (cell(row, m)!.value | currency:'MXN':'symbol-narrow':'1.0-0') : '·' }}</td>
                          }
                          <td class="n b">{{ row.value_total | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                          <td class="n share">{{ row.share_pct | number:'1.0-1' }}%</td>
                          <td class="n">{{ row.docs_total | number }}</td>
                        </tr>
                      }
                    </tbody>
                    <tfoot>
                      <tr class="tot">
                        <td class="frz c0 wide">TOTAL despachado por CEDIS</td>
                        @for (m of r.months; track m) {
                          <td class="n">{{ salidaMonthly()[m] ? (salidaMonthly()[m] | currency:'MXN':'symbol-narrow':'1.0-0') : '·' }}</td>
                        }
                        <td class="n b">{{ salidaTotal() | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                        <td class="n">100%</td>
                        <td class="n"></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            </section>
          }

          <!-- ② Movimientos por sucursal (consolidación + recepción: lado receptor) -->
          @if (branchRows().length) {
            <section class="tr-sec">
              <div class="tr-sec-head">
                <div class="tr-sec-badge">②</div>
                <div>
                  <h2>Movimientos por sucursal</h2>
                  <span class="tr-sec-sub">Consolidación interna diaria y recepción de traspaso, por sucursal · <strong>lado receptor — NO sumar con ①</strong> (es la misma mercancía)</span>
                </div>
              </div>
              <div class="card-premium card-flat tr-table-card">
                <div class="tr-wrap">
                  <table class="tr-table">
                    <thead>
                      <tr>
                        <th class="frz c0">Sucursal</th>
                        <th class="frz c1">Tipo</th>
                        @for (m of r.months; track m) { <th class="n">{{ mes(m) }}</th> }
                        <th class="n b">Total</th>
                        <th class="n">Share tipo</th>
                        <th class="n">Docs</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (row of branchRows(); track row.warehouse_code + row.kind) {
                        <tr>
                          <td class="frz c0">{{ row.warehouse_name }}</td>
                          <td class="frz c1">{{ row.kind_label }}</td>
                          @for (m of r.months; track m) {
                            <td class="n">{{ cell(row, m)?.value ? (cell(row, m)!.value | currency:'MXN':'symbol-narrow':'1.0-0') : '·' }}</td>
                          }
                          <td class="n b">{{ row.value_total | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                          <td class="n share">{{ row.share_pct | number:'1.0-1' }}%</td>
                          <td class="n">{{ row.docs_total | number }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          }
        } @else {
          <div class="comm-empty"><div class="comm-empty-icon"><i class="pi pi-inbox"></i></div>
            <h3>Sin traspasos</h3><p>No hay movimientos de traspaso para los filtros elegidos. Corré el feed <code>import-transfers-monthly.js</code>.</p></div>
        }
      } @else {
        <div class="comm-empty"><div class="comm-empty-icon"><i class="pi pi-sync"></i></div>
          <h3>Traspasos</h3><p>Elegí año y sucursales; el reporte carga automáticamente.</p></div>
      }
    </div>
  `,
  styles: [`
    .tr-note { display:flex; align-items:center; gap:.5rem; font-size:.8rem; color:var(--text-muted);
      background:var(--layout-bg); border:1px solid var(--border); border-radius:var(--radius-md); padding:.6rem .85rem; margin-bottom:1rem; }
    .tr-note i { color:var(--action, #b45309); }
    .tr-filters { display:flex; flex-wrap:wrap; gap:.75rem 1rem; align-items:flex-end; margin-bottom:1rem; }
    .tr-field { display:flex; flex-direction:column; gap:.3rem; }
    .tr-field > label { font-size:.72rem; font-weight:600; color:var(--text-muted); text-transform:uppercase; letter-spacing:.03em; }
    .tr-year { max-width:110px; } .tr-wh { min-width:240px; flex:1 1 240px; }
    .tr-actions { margin-left:auto; }
    .tr-kpis { display:flex; flex-wrap:wrap; gap:.75rem; margin-bottom:1rem; }
    .tr-kpi { flex:1 1 160px; border:1px solid var(--border); border-radius:var(--radius-md); padding:.6rem .85rem; background:var(--card-bg); }
    .tr-kpi-l { display:block; font-size:.68rem; font-weight:600; text-transform:uppercase; letter-spacing:.04em; color:var(--text-muted); }
    .tr-kpi-v { display:block; font-size:1.25rem; font-weight:700; margin-top:.15rem; font-variant-numeric:tabular-nums; }
    .tr-kpi-muted { opacity:.72; }
    .tr-sec { margin-bottom:1.75rem; }
    .tr-sec-head { display:flex; align-items:flex-start; gap:.6rem; margin-bottom:.6rem; }
    .tr-sec-badge { flex:0 0 auto; width:1.55rem; height:1.55rem; border-radius:50%; background:var(--action,#b45309); color:#fff; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:.8rem; }
    .tr-sec-head h2 { font-size:1rem; font-weight:700; margin:0; line-height:1.55rem; }
    .tr-sec-sub { font-size:.78rem; color:var(--text-muted); }
    .tr-table .c0.wide { min-width:230px; }
    .tr-kinds { display:flex; flex-wrap:wrap; gap:.6rem; margin-bottom:1rem; }
    .tr-kind { display:flex; flex-direction:column; border:1px solid var(--border); border-radius:var(--radius-md); padding:.45rem .7rem; background:var(--card-bg); min-width:150px; }
    .tr-kind-l { font-size:.7rem; color:var(--text-muted); }
    .tr-kind-v { font-weight:700; font-variant-numeric:tabular-nums; }
    .tr-kind-s { font-size:.7rem; color:var(--text-muted); }
    .so-actions-bar { display:flex; align-items:center; justify-content:space-between; gap:1rem; margin-bottom:1rem; }
    .tr-table-card { padding:1.25rem; }
    .tr-wrap { overflow-x:auto; border:1px solid var(--border); border-radius:var(--radius-md); }
    .tr-table { border-collapse:separate; border-spacing:0; font-size:.78rem; white-space:nowrap; width:100%; }
    .tr-table th, .tr-table td { border-bottom:1px solid var(--border); border-right:1px solid var(--border); padding:.35rem .6rem; }
    .tr-table thead th { background:var(--layout-bg); font-weight:700; text-align:center; position:sticky; top:0; z-index:2; }
    .tr-table td.n, .tr-table th.n { text-align:right; font-variant-numeric:tabular-nums; }
    .tr-table td.b, .tr-table th.b { font-weight:700; }
    .tr-table td.share { color:var(--text-muted); }
    .tr-table .tr-dest { color:var(--text-muted); font-weight:400; margin-left:.35rem; }
    .tr-table .frz { position:sticky; background:var(--card-bg); z-index:1; }
    .tr-table thead .frz { z-index:3; }
    .tr-table .c0 { left:0; } .tr-table .c1 { left:130px; }
    .tr-table tbody tr:hover td:not(.frz) { background:var(--table-hover,var(--layout-bg)); }
    .tr-table tfoot .tot td { font-weight:700; background:var(--layout-bg); position:sticky; bottom:0; }
    .tr-table tfoot .tot .frz { z-index:1; }
  `],
})
export class LogisticaTraspasosComponent {
  private readonly svc = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  warehouseOpts = signal<SellOutWarehouseRow[]>([]);
  loading = signal(false);
  dl = signal(false);
  report = signal<TransfersReport | null>(null);

  // ① salida de CEDIS (misma kind → suma válida). ② lado receptor (consolidación + recepción).
  salidaRows = computed(() => (this.report()?.rows ?? []).filter((r) => r.kind === 'salida_cedis'));
  branchRows = computed(() => (this.report()?.rows ?? []).filter((r) => r.kind !== 'salida_cedis'));
  salidaTotal = computed(() => this.report()?.by_kind.find((k) => k.kind === 'salida_cedis')?.value ?? 0);
  salidaMonthly = computed<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    for (const row of this.salidaRows())
      for (const [m, cell] of Object.entries(row.monthly)) out[m] = (out[m] || 0) + cell.value;
    return out;
  });

  year = new Date().getFullYear();
  warehouses: string[] = [];

  yearOpts = computed(() => { const y = new Date().getFullYear(); return [y, y - 1, y - 2]; });

  constructor() {
    this.svc.sellOutWarehouses().pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (w) => this.warehouseOpts.set(w), error: () => undefined });
    this.load();
  }

  private params(): TransfersParams {
    return { year: this.year, warehouses: this.warehouses.length ? this.warehouses : undefined };
  }

  load() {
    this.loading.set(true);
    this.svc.transfers(this.params())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.report.set(r); this.loading.set(false); },
        error: (e) => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error al consultar', detail: e?.error?.message }); },
      });
  }

  download() {
    this.dl.set(true);
    this.svc.transfersDownloadXlsx(this.params())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (resp) => {
          this.dl.set(false);
          const url = URL.createObjectURL(resp.body!);
          const a = document.createElement('a'); a.href = url; a.download = `Traspasos_${this.year}.xlsx`; a.click();
          URL.revokeObjectURL(url);
        },
        error: () => { this.dl.set(false); this.toast.add({ severity: 'error', summary: 'Error al descargar XLSX' }); },
      });
  }

  mes(m: string): string { return MES[m] ?? m; }
  cell(row: TransfersRow, m: string) { return row.monthly[m]; }
}
