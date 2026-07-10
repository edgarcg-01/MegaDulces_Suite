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
import { TableModule } from 'primeng/table';
import { TooltipModule } from 'primeng/tooltip';
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
import { ProductSearchComponent, ProductHit } from '../components/product-search.component';
import { REPORTS_TABS } from '../reports-tabs';

type PeriodMode = 'year' | 'd7' | 'd15' | 'd21' | 'range';

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
    InputTextModule, DatePickerModule, ToastModule, TableModule, TooltipModule,
    PageTabsComponent, SegmentedComponent, ProductSearchComponent,
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
          <app-product-search placeholder="SKU (5 díg.) o descripción…" (productSelected)="onProductPick($event)" />
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
            <p-table [value]="r.rows" [loading]="loading()" [rowHover]="true"
                     [scrollable]="true" scrollHeight="65vh"
                     [paginator]="true" [rows]="50" [rowsPerPageOptions]="[50, 100, 200]"
                     sortField="venta_total" [sortOrder]="-1"
                     styleClass="p-datatable-sm surf-table sl-ptable">
              <ng-template pTemplate="header">
                <tr>
                  <th scope="col" pFrozenColumn style="min-width:150px" pSortableColumn="warehouse_name">Sucursal <p-sortIcon field="warehouse_name" /></th>
                  <th scope="col" pFrozenColumn style="min-width:110px" pSortableColumn="sku">Clave <p-sortIcon field="sku" /></th>
                  <th scope="col" pFrozenColumn style="min-width:240px" pSortableColumn="nombre">Descripción <p-sortIcon field="nombre" /></th>
                  <th scope="col" class="comm-num" pSortableColumn="pack_size" pTooltip="Piezas por paquete (Kepler c81)">Pz/Paq <p-sortIcon field="pack_size" /></th>
                  <th scope="col" class="comm-num" pSortableColumn="box_size" pTooltip="Piezas por caja (Kepler c84)">Pz/Cja <p-sortIcon field="box_size" /></th>
                  <th scope="col" pSortableColumn="unit_sale">Unidad <p-sortIcon field="unit_sale" /></th>
                  <th scope="col" pSortableColumn="brand">Marca <p-sortIcon field="brand" /></th>
                  <th scope="col" pSortableColumn="categoria">Categoría <p-sortIcon field="categoria" /></th>
                  <th scope="col" pSortableColumn="rotation_tier">Rot. <p-sortIcon field="rotation_tier" /></th>
                  <th scope="col" class="comm-num" pSortableColumn="exist_paq">Exist. Pza <p-sortIcon field="exist_paq" /></th>
                  <th scope="col" class="comm-num" pSortableColumn="exist_paquete">Exist. Paq <p-sortIcon field="exist_paquete" /></th>
                  <th scope="col" class="comm-num" pSortableColumn="exist_caja">Exist. Cja <p-sortIcon field="exist_caja" /></th>
                  <th scope="col" class="comm-num" pSortableColumn="costo_caja">Costo x Caja <p-sortIcon field="costo_caja" /></th>
                  @if (isRange()) {
                    <th scope="col" class="comm-num sl-strong" pSortableColumn="venta_total">Venta <p-sortIcon field="venta_total" /></th>
                    <th scope="col" class="comm-num" pSortableColumn="venta_prev">Anterior <p-sortIcon field="venta_prev" /></th>
                    <th scope="col" class="comm-num" pSortableColumn="venta_delta_pct">Var % <p-sortIcon field="venta_delta_pct" /></th>
                    <th scope="col" class="comm-num sl-sec" pSortableColumn="costo_total">Costo <p-sortIcon field="costo_total" /></th>
                  } @else {
                    @for (m of r.months; track m) {
                      <th scope="col" class="comm-num" [pSortableColumn]="'monthly.' + m + '.venta'">Venta {{ mes(m) }} <p-sortIcon [field]="'monthly.' + m + '.venta'" /></th>
                      <th scope="col" class="comm-num sl-sec" [pSortableColumn]="'monthly.' + m + '.costo'">Costo {{ mes(m) }} <p-sortIcon [field]="'monthly.' + m + '.costo'" /></th>
                    }
                    <th scope="col" class="comm-num sl-strong" pSortableColumn="venta_total">Venta TOTAL <p-sortIcon field="venta_total" /></th>
                  }
                  <th scope="col" class="comm-num" pSortableColumn="venta_paquetes">Venta paq <p-sortIcon field="venta_paquetes" /></th>
                  <th scope="col" class="comm-num" pSortableColumn="venta_cajas">Venta cja <p-sortIcon field="venta_cajas" /></th>
                  <th scope="col" class="comm-num" pSortableColumn="dias_cobertura">Cobertura <p-sortIcon field="dias_cobertura" /></th>
                </tr>
              </ng-template>
              <ng-template pTemplate="body" let-row>
                <tr>
                  <td pFrozenColumn class="comm-cell-strong">{{ row.warehouse_name }}</td>
                  <td pFrozenColumn><code class="comm-code">{{ row.sku }}</code></td>
                  <td pFrozenColumn class="sl-name" [pTooltip]="row.nombre" tooltipPosition="top">{{ row.nombre }}</td>
                  <td class="comm-num comm-muted">{{ row.pack_size == null ? '—' : (row.pack_size | number:'1.0-0') }}</td>
                  <td class="comm-num comm-muted">{{ row.box_size == null ? '—' : (row.box_size | number:'1.0-0') }}</td>
                  <td class="sl-unit" [class.sl-unit-warn]="!isPieza(row.unit_sale)">{{ row.unit_sale ?? '—' }}</td>
                  <td class="sl-clip">{{ row.brand ?? '—' }}</td>
                  <td class="sl-clip comm-muted">{{ row.categoria ?? '—' }}</td>
                  <td class="sl-rot comm-muted">{{ row.rotation_tier ?? '—' }}</td>
                  <td class="comm-num">{{ row.exist_paq | number:'1.0-0' }}</td>
                  <td class="comm-num">{{ row.exist_paquete == null ? '—' : (row.exist_paquete | number:'1.0-2') }}</td>
                  <td class="comm-num">{{ row.exist_caja == null ? '—' : (row.exist_caja | number:'1.0-2') }}</td>
                  <td class="comm-num">{{ row.costo_caja | currency:'MXN':'symbol-narrow':'1.0-2' }}</td>
                  @if (isRange()) {
                    <td class="comm-num sl-strong">{{ row.venta_total != null ? (row.venta_total | number:'1.0-0') : '·' }}</td>
                    <td class="comm-num comm-muted">{{ row.venta_prev != null ? (row.venta_prev | number:'1.0-0') : '·' }}</td>
                    <td class="comm-num sl-delta" [class.up]="(row.venta_delta_pct ?? 0) > 0" [class.down]="(row.venta_delta_pct ?? 0) < 0">{{ row.venta_delta_pct == null ? '—' : ((row.venta_delta_pct > 0 ? '+' : '') + (row.venta_delta_pct | number:'1.0-1') + '%') }}</td>
                    <td class="comm-num sl-sec">{{ row.costo_total != null ? (row.costo_total | currency:'MXN':'symbol-narrow':'1.0-0') : '·' }}</td>
                  } @else {
                    @for (m of r.months; track m) {
                      <td class="comm-num">{{ cell(row, m)?.venta != null ? (cell(row, m)!.venta | number:'1.0-0') : '·' }}</td>
                      <td class="comm-num sl-sec">{{ cell(row, m)?.costo != null ? (cell(row, m)!.costo | currency:'MXN':'symbol-narrow':'1.0-0') : '·' }}</td>
                    }
                    <td class="comm-num sl-strong">{{ row.venta_total | number:'1.0-0' }}</td>
                  }
                  <td class="comm-num">{{ row.venta_paquetes != null ? (row.venta_paquetes | number:'1.0-1') : '—' }}</td>
                  <td class="comm-num">{{ row.venta_cajas != null ? (row.venta_cajas | number:'1.0-1') : '—' }}</td>
                  <td class="comm-num comm-muted">{{ row.dias_cobertura == null ? '—' : (row.dias_cobertura | number:'1.0-0') }}</td>
                </tr>
              </ng-template>
            </p-table>
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
    :host { display:block; }
    .sl-filters { display:flex; flex-wrap:wrap; gap:.75rem 1rem; align-items:flex-end; margin-bottom:1rem; }
    .sl-field { display:flex; flex-direction:column; gap:.3rem; }
    .sl-field > label { font-size:.72rem; font-weight:600; color:var(--text-muted); text-transform:uppercase; letter-spacing:.03em; }
    .sl-year { max-width:110px; }
    .sl-brand { flex:0 1 240px; min-width:190px; }
    .sl-search { flex:1 1 240px; max-width:340px; }
    .sl-search app-product-search { display:block; width:100%; }
    :host ::ng-deep .sl-search .ps-ac,
    :host ::ng-deep .sl-search .ps-ac .p-autocomplete-input { width:100%; min-width:0; }
    .sl-actions { margin-left:auto; }
    .so-actions-bar { display:flex; align-items:center; justify-content:space-between; gap:1rem; margin-bottom:1rem; }
    .so-dl { display:flex; gap:.5rem; }
    .sl-table-card { padding:1.25rem; }
    /* Tweaks sobre p-table (sticky/frozen/tema los da PrimeNG + surf-table). */
    .sl-name { max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .sl-clip { max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .sl-rot { text-transform:capitalize; }
    .sl-unit { text-transform:uppercase; font-variant-numeric:tabular-nums; }
    .sl-unit-warn { color:var(--warn-fg); font-weight:600; }
    /* Jerarquía: Venta = primario (fuerte), Costo = secundario (muted). */
    .sl-strong { font-weight:700; }
    .sl-sec { color:var(--text-muted); }
    .sl-delta.up { color:var(--ok-fg); font-weight:600; }
    .sl-delta.down { color:var(--bad-fg); font-weight:600; }
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
    { label: '21 días', value: 'd21' },
    { label: 'Personalizado', value: 'range' },
  ];

  brands = signal<SellOutBrandRow[]>([]);
  warehouseOpts = signal<SellOutWarehouseRow[]>([]);
  loading = signal(false);
  dl = signal(false);
  report = signal<SalidasReport | null>(null);
  periodMode = signal<PeriodMode>('d15');

  readonly today = new Date();
  year = new Date().getFullYear();
  warehouses: string[] = [];
  brandId: string | null = null;
  search = '';
  rangeDates: Date[] | null = null;

  yearOpts = computed(() => { const y = new Date().getFullYear(); return [y, y - 1, y - 2]; });
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

  /** Autocomplete de producto: al elegir uno, filtra por su SKU (5 díg.) y recarga en vivo. */
  onProductPick(hit: ProductHit | null): void {
    this.search = hit ? (hit.sku || hit.label) : '';
    this.load();
  }

  private iso(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  private rangeFor(mode: PeriodMode): { from: string; to: string } | null {
    if (mode === 'd7' || mode === 'd15' || mode === 'd21') {
      const n = mode === 'd7' ? 7 : mode === 'd15' ? 15 : 21;
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
      // p-multiSelect con [showClear] deja `warehouses` en null al limpiar → guard con ?.
      warehouses: this.warehouses?.length ? this.warehouses : undefined,
      brand_id: this.brandId ?? undefined,
      search: this.search?.trim() || undefined,
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
    this.svc.salidas(this.params())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.report.set(r); this.loading.set(false); },
        error: (e) => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error al consultar', detail: e?.error?.message }); },
      });
  }

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

  /** Unidad de venta en pieza → la conversión a cajas aplica. CJA/KGS/otras se
   * resaltan (cajas = "—") para que se vea de un vistazo que no hay error, es unidad. */
  isPieza(u: string | null): boolean {
    const s = (u ?? '').trim().toUpperCase();
    return s === '' || s === 'PZA' || s === 'PZAS' || s === 'PIEZA' || s === 'PZ';
  }
}
