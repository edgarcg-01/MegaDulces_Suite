import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { InputTextModule } from 'primeng/inputtext';
import { DatePickerModule } from 'primeng/datepicker';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import {
  ComercialService,
  SalidasParams,
  SalidasReport,
  SellOutBrandRow,
  SellOutWarehouseRow,
} from '../comercial.service';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { REPORTS_TABS } from '../reports-tabs';

type PeriodMode = 'year' | 'd7' | 'd15' | 'd30' | 'range';

const MES: Record<string, string> = {
  '01': 'Ene', '02': 'Feb', '03': 'Mar', '04': 'Abr', '05': 'May', '06': 'Jun',
  '07': 'Jul', '08': 'Ago', '09': 'Sep', '10': 'Oct', '11': 'Nov', '12': 'Dic',
};

/** SAL — Salidas/Ventas por Producto. Modo Año (columnas por mes) o Rango
 * (Últimos 7/15/30 días + personalizado → una Venta/Costo del período). */
@Component({
  selector: 'app-comercial-salidas',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, SelectModule, MultiSelectModule,
    InputTextModule, DatePickerModule, ToastModule, PageTabsComponent, SegmentedComponent,
  ],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="reportTabs" />

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Salidas por producto</h1>
          <p class="surf-page-sub">Venta real por producto y sucursal · existencia + costos · exporta XLSX</p>
        </div>
      </header>

      <div class="sl-filters card-premium card-flat">
        <div class="sl-field">
          <label>Periodo</label>
          <app-segmented [options]="modeOpts" [value]="periodMode()" (valueChange)="setMode($event)" ariaLabel="Periodo" />
        </div>
        @switch (periodMode()) {
          @case ('year') {
            <div class="sl-field sl-year">
              <label>Año</label>
              <p-select [options]="yearOpts()" [(ngModel)]="year" appendTo="body" (onChange)="load()" />
            </div>
          }
          @case ('range') {
            <div class="sl-field">
              <label>Rango</label>
              <p-datePicker [(ngModel)]="rangeDates" selectionMode="range" dateFormat="dd/mm/yy" [showIcon]="true"
                            [maxDate]="today" appendTo="body" (onSelect)="onRangePick()" (onClose)="onRangePick()" />
            </div>
          }
        }
        <div class="sl-field">
          <label>Sucursales</label>
          <p-multiSelect [options]="warehouseOpts()" [(ngModel)]="warehouses" optionLabel="name" optionValue="code"
                         placeholder="Todas" [showClear]="true" appendTo="body" styleClass="w-full" (onPanelHide)="load()" />
        </div>
        <div class="sl-field sl-brand">
          <label>Marca</label>
          <p-select [options]="brands()" [(ngModel)]="brandId" optionLabel="nombre" optionValue="id"
                    [filter]="true" filterBy="nombre" [showClear]="true" placeholder="Todas las marcas" appendTo="body"
                    styleClass="w-full" (onChange)="load()" (onClear)="load()" />
        </div>
        <div class="sl-field sl-search">
          <label>Buscar producto</label>
          <input pInputText [(ngModel)]="search" placeholder="SKU o descripción…" (keyup.enter)="load()" />
        </div>
        <div class="sl-actions">
          <button pButton label="Consultar" icon="pi pi-search" size="small" [loading]="loading()" (click)="load()"></button>
        </div>
      </div>

      @if (report(); as r) {
        <div class="so-actions-bar">
          <span class="text-xs text-content-muted">{{ r.rows.length | number }} filas · {{ periodLabel() }}</span>
          <div class="so-dl">
            <button pButton label="XLSX" icon="pi pi-file-excel" size="small" severity="secondary" [outlined]="true"
                    [loading]="dl()" (click)="download()"></button>
          </div>
        </div>

        @if (r.rows.length) {
          <div class="card-premium card-flat sl-table-card">
            <div class="sl-wrap">
              <table class="sl-table">
                <thead>
                  <tr>
                    <th class="frz c0">Sucursal</th>
                    <th class="frz c1">Clave</th>
                    <th class="frz c2">Descripción</th>
                    <th class="n">UXC</th>
                    <th>Marca</th>
                    <th class="n">Exist. Cja</th>
                    <th class="n">Costo Caja</th>
                    @if (isRange()) {
                      <th class="n">Venta</th><th class="n mm">Costo</th>
                    } @else {
                      @for (m of r.months; track m) { <th class="n">Venta {{ mes(m) }}</th><th class="n mm">Costo {{ mes(m) }}</th> }
                      <th class="n b">Venta TOTAL</th>
                    }
                  </tr>
                </thead>
                <tbody>
                  @for (row of visible(); track row.warehouse_code + row.product_id) {
                    <tr>
                      <td class="frz c0">{{ row.warehouse_name }}</td>
                      <td class="frz c1 mono">{{ row.sku }}</td>
                      <td class="frz c2 name">{{ row.nombre }}</td>
                      <td class="n">{{ row.uxc ?? '—' }}</td>
                      <td class="brand">{{ row.brand ?? '—' }}</td>
                      <td class="n">{{ row.exist_cja | number:'1.0-2' }}</td>
                      <td class="n">{{ row.costo_caja | currency:'MXN':'symbol-narrow':'1.0-2' }}</td>
                      @if (isRange()) {
                        <td class="n b">{{ row.venta_total ? (row.venta_total | number:'1.0-0') : '·' }}</td>
                        <td class="n mm">{{ row.costo_total ? (row.costo_total | currency:'MXN':'symbol-narrow':'1.0-0') : '·' }}</td>
                      } @else {
                        @for (m of r.months; track m) {
                          <td class="n">{{ cell(row, m)?.venta ? (cell(row, m)!.venta | number:'1.0-0') : '·' }}</td>
                          <td class="n mm">{{ cell(row, m)?.costo ? (cell(row, m)!.costo | currency:'MXN':'symbol-narrow':'1.0-0') : '·' }}</td>
                        }
                        <td class="n b">{{ row.venta_total | number:'1.0-0' }}</td>
                      }
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            @if (report()!.rows.length > visible().length) {
              <div class="sl-more">
                <button pButton [label]="'Mostrar más (' + (report()!.rows.length - visible().length) + ' restantes)'"
                        size="small" [text]="true" (click)="showMore()"></button>
              </div>
            }
          </div>
        } @else {
          <div class="comm-empty"><div class="comm-empty-icon"><i class="pi pi-inbox"></i></div>
            <h3>Sin resultados</h3><p>No hay ventas para los filtros elegidos.</p></div>
        }
      } @else {
        <div class="comm-empty"><div class="comm-empty-icon"><i class="pi pi-box"></i></div>
          <h3>Consultá el reporte</h3><p>Elegí el período y filtros; el reporte carga solo.</p></div>
      }
    </div>
  `,
  styles: [`
    .sl-filters { display:flex; flex-wrap:wrap; gap:.75rem 1rem; align-items:flex-end; margin-bottom:1rem; }
    .sl-field { display:flex; flex-direction:column; gap:.3rem; }
    .sl-field > label { font-size:.72rem; font-weight:600; color:var(--text-muted); text-transform:uppercase; letter-spacing:.03em; }
    .sl-year { max-width:110px; } .sl-brand { min-width:220px; flex:1 1 220px; } .sl-search { min-width:200px; flex:1 1 200px; }
    .sl-actions { margin-left:auto; }
    .so-actions-bar { display:flex; align-items:center; justify-content:space-between; gap:1rem; margin-bottom:1rem; }
    .so-dl { display:flex; gap:.5rem; }
    .sl-table-card { padding:1.25rem; }
    .sl-wrap { overflow-x:auto; border:1px solid var(--border); border-radius:var(--radius-md); }
    .sl-table { border-collapse:separate; border-spacing:0; font-size:.76rem; white-space:nowrap; }
    .sl-table th, .sl-table td { border-bottom:1px solid var(--border); border-right:1px solid var(--border); padding:.3rem .5rem; }
    .sl-table thead th { background:var(--layout-bg); font-weight:700; text-align:center; position:sticky; top:0; z-index:2; }
    .sl-table td.n, .sl-table th.n { text-align:right; font-variant-numeric:tabular-nums; }
    .sl-table .mm { border-right:1px solid var(--border-strong,#c9c6bf); }
    .sl-table td.name { max-width:260px; overflow:hidden; text-overflow:ellipsis; }
    .sl-table td.brand { max-width:160px; overflow:hidden; text-overflow:ellipsis; }
    .sl-table td.mono { font-family:var(--font-mono,monospace); }
    .sl-table td.b, .sl-table th.b { font-weight:700; }
    .sl-table .frz { position:sticky; background:var(--card-bg); z-index:1; }
    .sl-table thead .frz { z-index:3; }
    .sl-table .c0 { left:0; } .sl-table .c1 { left:120px; } .sl-table .c2 { left:210px; }
    .sl-table tbody tr:hover td:not(.frz) { background:var(--table-hover,var(--layout-bg)); }
    .sl-more { text-align:center; margin-top:.5rem; }
  `],
})
export class ComercialSalidasComponent {
  readonly reportTabs = REPORTS_TABS;
  private readonly svc = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly modeOpts = [
    { label: 'Año', value: 'year' },
    { label: '7 días', value: 'd7' },
    { label: '15 días', value: 'd15' },
    { label: '30 días', value: 'd30' },
    { label: 'Personalizado', value: 'range' },
  ];

  brands = signal<SellOutBrandRow[]>([]);
  warehouseOpts = signal<SellOutWarehouseRow[]>([]);
  loading = signal(false);
  dl = signal(false);
  report = signal<SalidasReport | null>(null);
  periodMode = signal<PeriodMode>('d30');
  private limit = signal(200);

  readonly today = new Date();
  year = new Date().getFullYear();
  warehouses: string[] = [];
  brandId: string | null = null;
  search = '';
  rangeDates: Date[] | null = null;

  yearOpts = computed(() => { const y = new Date().getFullYear(); return [y, y - 1, y - 2]; });
  visible = computed(() => (this.report()?.rows ?? []).slice(0, this.limit()));
  isRange = computed(() => this.report()?.mode === 'range');
  periodLabel = computed(() => {
    const r = this.report();
    if (!r) return '';
    if (r.mode === 'year') return `año ${r.year}`;
    const f = (s?: string) => (s ? s.split('-').reverse().join('/') : '');
    return `${f(r.from)} – ${f(r.to)}`;
  });

  constructor() {
    this.svc.sellOutWarehouses().pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (w) => this.warehouseOpts.set(w), error: () => undefined });
    this.svc.sellOutBrands().pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (b) => this.brands.set(b), error: () => undefined });
    this.load();
  }

  setMode(m: string) {
    this.periodMode.set(m as PeriodMode);
    // Presets y Año cargan al instante; Personalizado espera a que se elija el rango.
    if (m !== 'range') this.load();
  }

  onRangePick() {
    if (this.rangeDates?.[0] && this.rangeDates?.[1]) this.load();
  }

  private iso(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  private rangeFor(mode: PeriodMode): { from: string; to: string } | null {
    if (mode === 'd7' || mode === 'd15' || mode === 'd30') {
      const n = mode === 'd7' ? 7 : mode === 'd15' ? 15 : 30;
      const to = new Date();
      const from = new Date(); from.setDate(to.getDate() - n);
      return { from: this.iso(from), to: this.iso(to) };
    }
    if (mode === 'range' && this.rangeDates?.[0] && this.rangeDates?.[1]) {
      return { from: this.iso(this.rangeDates[0]), to: this.iso(this.rangeDates[1]) };
    }
    return null;
  }

  private params(): SalidasParams {
    const base = {
      warehouses: this.warehouses.length ? this.warehouses : undefined,
      brand_id: this.brandId ?? undefined,
      search: this.search.trim() || undefined,
    };
    if (this.periodMode() === 'year') return { ...base, year: this.year };
    const r = this.rangeFor(this.periodMode());
    return r ? { ...base, from: r.from, to: r.to } : { ...base, year: this.year };
  }

  load() {
    if (this.periodMode() === 'range' && !(this.rangeDates?.[0] && this.rangeDates?.[1])) {
      this.toast.add({ severity: 'info', summary: 'Elegí un rango de fechas' });
      return;
    }
    this.loading.set(true);
    this.limit.set(200);
    this.svc.salidas(this.params())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.report.set(r); this.loading.set(false); },
        error: (e) => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error al consultar', detail: e?.error?.message }); },
      });
  }

  showMore() { this.limit.update((n) => n + 300); }

  download() {
    this.dl.set(true);
    this.svc.salidasDownloadXlsx(this.params())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (resp) => {
          this.dl.set(false);
          const cd = resp.headers.get('content-disposition') || '';
          const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
          const name = m ? decodeURIComponent(m[1]) : `Salidas_por_Producto.xlsx`;
          const url = URL.createObjectURL(resp.body!);
          const a = document.createElement('a'); a.href = url; a.download = name; a.click();
          URL.revokeObjectURL(url);
        },
        error: () => { this.dl.set(false); this.toast.add({ severity: 'error', summary: 'Error al descargar XLSX' }); },
      });
  }

  mes(m: string): string { return MES[m] ?? m; }
  cell(row: SalidasReport['rows'][number], m: string): { venta: number; costo: number } | undefined { return row.monthly[m]; }
}
