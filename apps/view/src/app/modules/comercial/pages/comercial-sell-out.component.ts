import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { DatePickerModule } from 'primeng/datepicker';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import {
  ComercialService,
  SellOutBrandRow,
  SellOutParams,
  SellOutReport,
} from '../comercial.service';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { REPORTS_TABS } from '../reports-tabs';

type PeriodMode = 'month' | 'quarter' | 'year' | 'range';

const CHANNEL_OPTS = [
  { label: 'Mostrador', value: 'mostrador' },
  { label: 'Ruta', value: 'ruta' },
  { label: 'Crédito', value: 'credito' },
  { label: 'Otro', value: 'otro' },
];

/** RS — Generador de reportes Sell-Out por empresa (marca/proveedor). */
@Component({
  selector: 'app-comercial-sell-out',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, SelectModule, MultiSelectModule,
    DatePickerModule, ToggleSwitchModule, ToastModule, PageTabsComponent,
  ],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="reportTabs" />

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Sell-Out por empresa</h1>
          <p class="surf-page-sub">Venta real consolidada (Kepler) por producto y sucursal · exporta XLSX / PDF</p>
        </div>
      </header>

      <!-- Controles -->
      <div class="so-filters">
        <div class="so-field so-empresa">
          <label>Empresa</label>
          <p-select [options]="brands()" [(ngModel)]="brandId" optionLabel="nombre" optionValue="id"
                    [filter]="true" filterBy="nombre,code" [showClear]="true" placeholder="Elegí una empresa…"
                    [loading]="loadingBrands()" appendTo="body" styleClass="w-full">
            <ng-template let-b pTemplate="item">
              <span>{{ b.nombre }}</span>
              <span class="so-badge">{{ b.products }}</span>
            </ng-template>
          </p-select>
        </div>

        <div class="so-field">
          <label>Periodo</label>
          <div class="so-segment">
            @for (m of modes; track m.key) {
              <button type="button" [class.on]="periodMode() === m.key" (click)="setMode(m.key)">{{ m.label }}</button>
            }
          </div>
        </div>

        @switch (periodMode()) {
          @case ('month') {
            <div class="so-field">
              <label>Mes</label>
              <p-datePicker [(ngModel)]="monthDate" view="month" dateFormat="MM yy" [showIcon]="true"
                            appendTo="body" (onSelect)="syncPeriod()" (onClose)="syncPeriod()" />
            </div>
          }
          @case ('quarter') {
            <div class="so-field">
              <label>Trimestre</label>
              <p-select [options]="quarterOpts" [(ngModel)]="quarter" optionLabel="label" optionValue="value"
                        appendTo="body" (onChange)="syncPeriod()" />
            </div>
            <div class="so-field so-year">
              <label>Año</label>
              <p-select [options]="yearOpts()" [(ngModel)]="year" appendTo="body" (onChange)="syncPeriod()" />
            </div>
          }
          @case ('year') {
            <div class="so-field so-year">
              <label>Año</label>
              <p-select [options]="yearOpts()" [(ngModel)]="year" appendTo="body" (onChange)="syncPeriod()" />
            </div>
          }
          @case ('range') {
            <div class="so-field">
              <label>Rango</label>
              <p-datePicker [(ngModel)]="rangeDates" selectionMode="range" dateFormat="dd/mm/yy"
                            [showIcon]="true" appendTo="body" (onSelect)="syncPeriod()" (onClose)="syncPeriod()" />
            </div>
          }
        }

        <div class="so-field">
          <label>Canales</label>
          <p-multiSelect [options]="channelOpts" [(ngModel)]="channels" optionLabel="label" optionValue="value"
                         placeholder="Todos" [showClear]="true" appendTo="body" styleClass="w-full" />
        </div>

        <div class="so-field so-toggles">
          <label class="so-toggle"><p-toggleSwitch [(ngModel)]="byChannel" /> <span>Desglosar canal</span></label>
          <label class="so-toggle"><p-toggleSwitch [(ngModel)]="includeZeros" /> <span>Incluir sin venta</span></label>
        </div>

        <div class="so-actions">
          <button pButton label="Generar" icon="pi pi-search" size="small"
                  [disabled]="!canGenerate()" [loading]="loading()" (click)="generate()"></button>
        </div>
      </div>

      @if (report(); as r) {
        <!-- Resumen + descargas -->
        <div class="so-summary">
          <div class="so-kpis">
            <div class="so-kpi"><span class="v">{{ r.grand_total.monto | currency:'MXN':'symbol-narrow':'1.0-0' }}</span><span class="l">Monto total</span></div>
            <div class="so-kpi"><span class="v">{{ r.grand_total.cajas | number:'1.0-1' }}</span><span class="l">Cajas</span></div>
            <div class="so-kpi"><span class="v">{{ r.rows.length }}</span><span class="l">Productos</span></div>
            <div class="so-kpi"><span class="v">{{ r.columns.length }}</span><span class="l">Columnas</span></div>
          </div>
          <div class="so-dl">
            <button pButton label="XLSX" icon="pi pi-file-excel" size="small" severity="success"
                    [loading]="dl() === 'xlsx'" (click)="download('xlsx')"></button>
            <button pButton label="PDF" icon="pi pi-file-pdf" size="small" severity="danger"
                    [loading]="dl() === 'pdf'" (click)="download('pdf')"></button>
          </div>
        </div>

        @if (r.coverage?.note) {
          <p class="so-note"><i class="pi pi-info-circle"></i> {{ r.coverage.note }}</p>
        }

        @if (r.rows.length) {
          <!-- Matriz -->
          <div class="so-matrix-wrap">
            <table class="so-matrix">
              <thead>
                <tr>
                  <th class="frz c0" rowspan="2">Código</th>
                  <th class="frz c1" rowspan="2">Descripción</th>
                  <th class="frz c2" rowspan="2">UXC</th>
                  @for (c of r.columns; track c.key) { <th colspan="2" class="grp">{{ colLabel(c) }}</th> }
                  <th colspan="2" class="grp tot">TOTAL</th>
                </tr>
                <tr>
                  @for (c of r.columns; track c.key) { <th class="sub">Cajas</th><th class="sub m">Monto</th> }
                  <th class="sub">Cajas</th><th class="sub m">Monto</th>
                </tr>
              </thead>
              <tbody>
                @for (row of r.rows; track row.product_id) {
                  <tr>
                    <td class="frz c0 mono">{{ row.sku }}</td>
                    <td class="frz c1 name">{{ row.nombre }}</td>
                    <td class="frz c2 n">{{ row.uxc ?? '—' }}</td>
                    @for (c of r.columns; track c.key) {
                      <td class="n">{{ cell(row, c.key)?.cajas ? (cell(row, c.key)!.cajas | number:'1.0-2') : '·' }}</td>
                      <td class="n m">{{ cell(row, c.key)?.monto ? (cell(row, c.key)!.monto | currency:'MXN':'symbol-narrow':'1.0-0') : '·' }}</td>
                    }
                    <td class="n b">{{ row.total.cajas | number:'1.0-2' }}</td>
                    <td class="n m b">{{ row.total.monto | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  </tr>
                }
              </tbody>
              <tfoot>
                <tr class="tot-row">
                  <td class="frz c0" colspan="3">TOTAL</td>
                  @for (c of r.columns; track c.key) {
                    <td class="n">{{ colTotal(r, c.key).cajas | number:'1.0-2' }}</td>
                    <td class="n m">{{ colTotal(r, c.key).monto | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  }
                  <td class="n">{{ r.grand_total.cajas | number:'1.0-2' }}</td>
                  <td class="n m">{{ r.grand_total.monto | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        } @else {
          <div class="comm-empty"><div class="comm-empty-icon"><i class="pi pi-inbox"></i></div>
            <h3>Sin venta en el periodo</h3><p>No hay ventas de esta empresa en el rango elegido.</p></div>
        }
      } @else {
        <div class="comm-empty"><div class="comm-empty-icon"><i class="pi pi-file-excel"></i></div>
          <h3>Generá un reporte</h3><p>Elegí empresa y periodo, luego «Generar».</p></div>
      }
    </div>
  `,
  styles: [`
    .so-filters { display:flex; flex-wrap:wrap; gap:.75rem 1rem; align-items:flex-end; padding:1rem;
      background:var(--card-bg); border:1px solid var(--border); border-radius:var(--radius-md); margin-bottom:1rem; }
    .so-field { display:flex; flex-direction:column; gap:.3rem; }
    .so-field > label { font-size:.72rem; font-weight:600; color:var(--text-muted); text-transform:uppercase; letter-spacing:.03em; }
    .so-empresa { min-width:280px; flex:1 1 280px; }
    .so-year { max-width:110px; }
    .so-badge { margin-left:.5rem; font-size:.7rem; color:var(--text-muted); }
    .so-segment { display:inline-flex; border:1px solid var(--border); border-radius:var(--radius-sm); overflow:hidden; }
    .so-segment button { border:0; background:transparent; padding:.4rem .7rem; font-size:.8rem; cursor:pointer; color:var(--text-muted); }
    .so-segment button.on { background:var(--action); color:#fff; }
    .so-toggles { flex-direction:row; gap:1rem; align-items:center; }
    .so-toggle { display:inline-flex; align-items:center; gap:.4rem; font-size:.8rem; color:var(--text); }
    .so-actions { margin-left:auto; }
    .so-summary { display:flex; align-items:center; justify-content:space-between; gap:1rem; flex-wrap:wrap; margin-bottom:.75rem; }
    .so-kpis { display:flex; gap:1.5rem; }
    .so-kpi { display:flex; flex-direction:column; }
    .so-kpi .v { font-size:1.25rem; font-weight:700; font-variant-numeric:tabular-nums; }
    .so-kpi .l { font-size:.72rem; color:var(--text-muted); text-transform:uppercase; }
    .so-dl { display:flex; gap:.5rem; }
    .so-note { font-size:.78rem; color:var(--text-muted); background:var(--layout-bg); border:1px solid var(--border);
      border-radius:var(--radius-sm); padding:.5rem .7rem; margin:0 0 .75rem; display:flex; gap:.4rem; align-items:baseline; }
    .so-matrix-wrap { overflow-x:auto; border:1px solid var(--border); border-radius:var(--radius-md); }
    .so-matrix { border-collapse:separate; border-spacing:0; font-size:.78rem; white-space:nowrap; }
    .so-matrix th, .so-matrix td { border-bottom:1px solid var(--border); border-right:1px solid var(--border); padding:.3rem .5rem; }
    .so-matrix thead th { background:var(--layout-bg); font-weight:700; text-align:center; position:sticky; top:0; z-index:2; }
    .so-matrix thead th.grp { text-align:center; }
    .so-matrix thead th.grp.tot { background:var(--action-subtle,#f1f0ec); }
    .so-matrix .sub { font-size:.7rem; font-weight:600; color:var(--text-muted); }
    .so-matrix .m { border-right:1px solid var(--border-strong,#c9c6bf); }
    .so-matrix td.n { text-align:right; font-variant-numeric:tabular-nums; }
    .so-matrix td.name { max-width:280px; overflow:hidden; text-overflow:ellipsis; }
    .so-matrix td.mono { font-family:var(--font-mono,monospace); }
    .so-matrix td.b { font-weight:700; }
    .so-matrix .frz { position:sticky; background:var(--card-bg); z-index:1; }
    .so-matrix thead .frz { z-index:3; }
    .so-matrix .c0 { left:0; } .so-matrix .c1 { left:70px; } .so-matrix .c2 { left:350px; }
    .so-matrix tbody tr:nth-child(even) td:not(.frz) { background:var(--layout-bg); }
    .so-matrix tfoot td { position:sticky; bottom:0; background:var(--action-subtle,#f1f0ec); font-weight:700; z-index:2; }
  `],
})
export class ComercialSellOutComponent {
  readonly reportTabs = REPORTS_TABS;
  readonly channelOpts = CHANNEL_OPTS;
  readonly modes: { key: PeriodMode; label: string }[] = [
    { key: 'month', label: 'Mes' },
    { key: 'quarter', label: 'Trimestre' },
    { key: 'year', label: 'Año' },
    { key: 'range', label: 'Rango' },
  ];
  readonly quarterOpts = [
    { label: 'Q1 (Ene–Mar)', value: 1 },
    { label: 'Q2 (Abr–Jun)', value: 2 },
    { label: 'Q3 (Jul–Sep)', value: 3 },
    { label: 'Q4 (Oct–Dic)', value: 4 },
  ];

  private readonly svc = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  brands = signal<SellOutBrandRow[]>([]);
  loadingBrands = signal(false);
  loading = signal(false);
  dl = signal<'' | 'xlsx' | 'pdf'>('');
  report = signal<SellOutReport | null>(null);

  // form state
  brandId: string | null = null;
  periodMode = signal<PeriodMode>('month');
  monthDate: Date = new Date();
  rangeDates: Date[] | null = null;
  quarter = 1;
  year = new Date().getFullYear();
  channels: string[] = [];
  byChannel = true;
  includeZeros = false;

  private curFrom = '';
  private curTo = '';

  yearOpts = computed(() => {
    const y = new Date().getFullYear();
    return [y, y - 1, y - 2, y - 3];
  });

  canGenerate = computed(() => !!this.brandId);

  constructor() {
    this.year = new Date().getFullYear();
    this.quarter = Math.floor(new Date().getMonth() / 3) + 1;
    this.syncPeriod();
    this.loadBrands();
  }

  private loadBrands() {
    this.loadingBrands.set(true);
    this.svc.sellOutBrands()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (b) => { this.brands.set(b); this.loadingBrands.set(false); },
        error: () => { this.loadingBrands.set(false); this.toast.add({ severity: 'error', summary: 'Error al cargar empresas' }); },
      });
  }

  setMode(m: PeriodMode) { this.periodMode.set(m); this.syncPeriod(); }

  private iso(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /** Recalcula from/to según el modo de periodo activo. */
  syncPeriod() {
    const mode = this.periodMode();
    if (mode === 'month' && this.monthDate) {
      const d = this.monthDate;
      this.curFrom = this.iso(new Date(d.getFullYear(), d.getMonth(), 1));
      this.curTo = this.iso(new Date(d.getFullYear(), d.getMonth() + 1, 0));
    } else if (mode === 'quarter') {
      const m0 = (this.quarter - 1) * 3;
      this.curFrom = this.iso(new Date(this.year, m0, 1));
      this.curTo = this.iso(new Date(this.year, m0 + 3, 0));
    } else if (mode === 'year') {
      this.curFrom = this.iso(new Date(this.year, 0, 1));
      this.curTo = this.iso(new Date(this.year, 11, 31));
    } else if (mode === 'range' && this.rangeDates?.[0] && this.rangeDates?.[1]) {
      this.curFrom = this.iso(this.rangeDates[0]);
      this.curTo = this.iso(this.rangeDates[1]);
    }
  }

  private buildParams(): SellOutParams {
    return {
      brand_id: this.brandId!,
      from: this.curFrom,
      to: this.curTo,
      group_by: this.byChannel ? 'branch_channel' : 'branch',
      channels: this.channels.length ? this.channels : undefined,
      include_zeros: this.includeZeros,
    };
  }

  generate() {
    this.syncPeriod();
    if (!this.brandId || !this.curFrom || !this.curTo) {
      this.toast.add({ severity: 'warn', summary: 'Falta empresa o periodo' });
      return;
    }
    this.loading.set(true);
    this.svc.sellOut(this.buildParams())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.report.set(r); this.loading.set(false); },
        error: (e) => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error al generar', detail: e?.error?.message }); },
      });
  }

  download(fmt: 'xlsx' | 'pdf') {
    if (!this.brandId) return;
    this.dl.set(fmt);
    this.svc.sellOutDownload(this.buildParams(), fmt)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (resp) => {
          this.dl.set('');
          const blob = resp.body!;
          const cd = resp.headers.get('content-disposition') || '';
          const name = this.filenameFrom(cd, fmt);
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = name; a.click();
          URL.revokeObjectURL(url);
        },
        error: () => { this.dl.set(''); this.toast.add({ severity: 'error', summary: `Error al descargar ${fmt.toUpperCase()}` }); },
      });
  }

  private filenameFrom(contentDisposition: string, fmt: string): string {
    const star = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition);
    if (star) { try { return decodeURIComponent(star[1]); } catch { /* noop */ } }
    const plain = /filename="?([^";]+)"?/i.exec(contentDisposition);
    if (plain) return plain[1];
    return `sell-out.${fmt}`;
  }

  colLabel(c: { branch_name: string; channel_label?: string }): string {
    return c.channel_label ? `${c.branch_name} · ${c.channel_label}` : c.branch_name;
  }

  cell(row: SellOutReport['rows'][number], key: string) {
    return row.cells[key];
  }

  colTotal(r: SellOutReport, key: string) {
    return r.column_totals[key] ?? { cajas: 0, monto: 0 };
  }
}
