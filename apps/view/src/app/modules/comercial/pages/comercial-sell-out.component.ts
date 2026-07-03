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
  SellOutCell,
  SellOutParams,
  SellOutReport,
  SellOutWarehouseRow,
} from '../comercial.service';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { REPORTS_TABS } from '../reports-tabs';

type PeriodMode = 'month' | 'quarter' | 'year' | 'range';
type Measure = 'cajas' | 'monto' | 'ambas';

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
    DatePickerModule, ToggleSwitchModule, ToastModule, PageTabsComponent, SegmentedComponent,
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
      <div class="so-filters card-premium card-flat">
        <div class="so-field so-empresa">
          <label>Empresa</label>
          <p-select [options]="brands()" [ngModel]="brandId()" (ngModelChange)="brandId.set($event)" optionLabel="nombre" optionValue="id"
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
          <app-segmented [options]="modeOpts" [value]="periodMode()" (valueChange)="setMode($event)" ariaLabel="Periodo" />
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
          <label>Almacenes</label>
          <p-multiSelect [options]="warehouseOpts()" [(ngModel)]="warehouses" optionLabel="name" optionValue="code"
                         placeholder="Todos" [showClear]="true" [loading]="loadingWarehouses()"
                         appendTo="body" styleClass="w-full" />
        </div>

        <div class="so-field">
          <label>Canales</label>
          <p-multiSelect [options]="channelOpts" [(ngModel)]="channels" optionLabel="label" optionValue="value"
                         placeholder="Todos" [showClear]="true" appendTo="body" styleClass="w-full" />
        </div>

        <div class="so-field">
          <label>Medida</label>
          <app-segmented [options]="measureOpts" [value]="measure()" (valueChange)="setMeasure($event)" ariaLabel="Medida" />
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

      @if (loading()) {
        <div class="so-skel" aria-hidden="true">
          <div class="so-skel-bar shim"></div>
          <div class="so-kpi-grid">
            <div class="so-skel-card shim"></div>
            <div class="so-skel-card shim"></div>
            <div class="so-skel-card shim"></div>
            <div class="so-skel-card shim"></div>
          </div>
          <div class="so-skel-table">
            @for (i of skelRows; track i) { <div class="so-skel-row shim"></div> }
          </div>
        </div>
      } @else {
        @if (report(); as r) {
        <!-- Eco de la consulta + descargas -->
        <div class="so-actions-bar">
          @if (meta(); as m) {
            <div class="so-echo">
              <strong>{{ m.brand }}</strong>
              <span class="so-echo-sep">·</span><span>{{ m.period }}</span>
              <span class="so-echo-sep">·</span><span>{{ m.channels }}</span>
            </div>
          }
          <div class="so-dl">
            <button pButton label="XLSX" icon="pi pi-file-excel" size="small" severity="secondary" [outlined]="true"
                    [loading]="dl() === 'xlsx'" (click)="download('xlsx')"></button>
            <button pButton label="PDF" icon="pi pi-file-pdf" size="small" severity="secondary" [outlined]="true"
                    [loading]="dl() === 'pdf'" (click)="download('pdf')"></button>
          </div>
        </div>

        <!-- KPI cards (lenguaje visual de /dashboard/reports) -->
        <div class="so-kpi-grid">
          <div class="card-premium card-flat rk-card">
            <div class="rk-body">
              <div class="rk-top"><span class="rk-label">Monto total</span></div>
              <div class="rk-value">{{ r.grand_total.monto | currency:'MXN':'symbol-narrow':'1.0-0' }}</div>
              <div class="rk-metaline">Sell-out del periodo</div>
            </div>
          </div>
          <div class="card-premium card-flat rk-card">
            <div class="rk-body">
              <div class="rk-top"><span class="rk-label">Cajas</span></div>
              <div class="rk-value">{{ r.grand_total.cajas | number:'1.0-1' }}</div>
              <div class="rk-metaline">Unidades ÷ UXC</div>
            </div>
          </div>
          <div class="card-premium card-flat rk-card">
            <div class="rk-body">
              <div class="rk-top"><span class="rk-label">Productos</span></div>
              <div class="rk-value">{{ r.rows.length }}</div>
              <div class="rk-metaline">Con venta en el periodo</div>
            </div>
          </div>
          <div class="card-premium card-flat rk-card">
            <div class="rk-body">
              <div class="rk-top"><span class="rk-label">Sucursales</span></div>
              <div class="rk-value">{{ r.coverage.branches_with_data.length }}</div>
              <div class="rk-metaline">Con venta · {{ r.columns.length }} columnas</div>
            </div>
          </div>
        </div>

        @if (r.coverage.note) {
          <p class="so-note"><i class="pi pi-info-circle"></i> {{ r.coverage.note }}</p>
        }

        @if (r.rows.length) {
          <!-- Matriz (dentro de card premium, como las secciones de reports) -->
          <div class="card-premium card-flat so-matrix-card">
            <div class="so-matrix-head">
              <h3 class="text-sm font-bold text-content-main">Detalle por producto</h3>
              <span class="text-xs text-content-muted">{{ r.rows.length }} productos · {{ r.columns.length }} columnas</span>
            </div>
          <div class="so-matrix-wrap">
            <table class="so-matrix">
              <thead>
                <tr>
                  <th class="frz c0" rowspan="2">Código</th>
                  <th class="frz c1" rowspan="2">Descripción</th>
                  <th class="frz c2" rowspan="2">UXC</th>
                  @for (c of r.columns; track c.key) { <th [attr.colspan]="grpColspan()" class="grp">{{ colLabel(c) }}</th> }
                  <th [attr.colspan]="grpColspan()" class="grp tot">TOTAL</th>
                </tr>
                <tr>
                  @for (c of r.columns; track c.key) {
                    @if (showCajas()) { <th class="sub">Cajas</th> }
                    @if (showMonto()) { <th class="sub m">Monto</th> }
                  }
                  @if (showCajas()) { <th class="sub">Cajas</th> }
                  @if (showMonto()) { <th class="sub m">Monto</th> }
                </tr>
              </thead>
              <tbody>
                @for (row of r.rows; track row.product_id) {
                  <tr>
                    <td class="frz c0 mono">{{ row.sku }}</td>
                    <td class="frz c1 name">{{ row.nombre }}</td>
                    <td class="frz c2 n">{{ row.uxc ?? '—' }}</td>
                    @for (c of r.columns; track c.key) {
                      @if (showCajas()) { <td class="n">{{ cell(row, c.key)?.cajas != null ? (cell(row, c.key)!.cajas | number:'1.0-2') : '·' }}</td> }
                      @if (showMonto()) { <td class="n m">{{ cell(row, c.key)?.monto != null ? (cell(row, c.key)!.monto | currency:'MXN':'symbol-narrow':'1.0-0') : '·' }}</td> }
                    }
                    @if (showCajas()) { <td class="n b">{{ row.total.cajas | number:'1.0-2' }}</td> }
                    @if (showMonto()) { <td class="n m b">{{ row.total.monto | currency:'MXN':'symbol-narrow':'1.0-0' }}</td> }
                  </tr>
                }
              </tbody>
              <tfoot>
                <tr class="tot-row">
                  <td class="frz c0" colspan="3">TOTAL</td>
                  @for (c of r.columns; track c.key) {
                    @if (showCajas()) { <td class="n">{{ colTotal(r, c.key).cajas | number:'1.0-2' }}</td> }
                    @if (showMonto()) { <td class="n m">{{ colTotal(r, c.key).monto | currency:'MXN':'symbol-narrow':'1.0-0' }}</td> }
                  }
                  @if (showCajas()) { <td class="n">{{ r.grand_total.cajas | number:'1.0-2' }}</td> }
                  @if (showMonto()) { <td class="n m">{{ r.grand_total.monto | currency:'MXN':'symbol-narrow':'1.0-0' }}</td> }
                </tr>
              </tfoot>
            </table>
          </div>
          </div>
        } @else {
          <div class="comm-empty"><div class="comm-empty-icon"><i class="pi pi-inbox"></i></div>
            <h3>Sin venta en el periodo</h3><p>No hay ventas de esta empresa en el rango elegido.</p></div>
        }
        } @else {
          <div class="comm-empty"><div class="comm-empty-icon"><i class="pi pi-file-excel"></i></div>
            <h3>Generá un reporte</h3><p>Elegí empresa y periodo, luego «Generar».</p></div>
        }
      }
    </div>
  `,
  styles: [`
    :host { display:block; }
    .so-filters { display:flex; flex-wrap:wrap; gap:.75rem 1rem; align-items:flex-end; margin-bottom:1rem; }
    .so-field { display:flex; flex-direction:column; gap:.3rem; }
    .so-field > label { font-size:.72rem; font-weight:600; color:var(--text-muted); text-transform:uppercase; letter-spacing:.03em; }
    .so-empresa { min-width:280px; flex:1 1 280px; }
    .so-year { max-width:110px; }
    .so-badge { margin-left:.5rem; font-size:.7rem; color:var(--text-muted); }
    /* segmented → app-segmented (átomo compartido) */
    .so-toggles { flex-direction:row; gap:1rem; align-items:center; }
    .so-toggle { display:inline-flex; align-items:center; gap:.4rem; font-size:.8rem; color:var(--text); }
    .so-actions { margin-left:auto; }
    .so-actions-bar { display:flex; align-items:center; justify-content:space-between; gap:1rem; flex-wrap:wrap; margin-bottom:1rem; }
    .so-echo { display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; font-size:.85rem; color:var(--text-muted); }
    .so-echo strong { color:var(--text-main); font-weight:700; }
    .so-echo-sep { color:var(--text-faint); }
    .so-dl { display:flex; gap:.5rem; margin-left:auto; }
    /* KPI grid — mismo lenguaje que /dashboard/reports (card-premium + rk-card). */
    .so-kpi-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:1rem; margin-bottom:1rem; }
    .so-note { font-size:.78rem; color:var(--text-muted); background:var(--layout-bg); border:1px solid var(--border);
      border-radius:var(--radius-sm); padding:.5rem .7rem; margin:0 0 1rem; display:flex; gap:.4rem; align-items:baseline; }
    .so-matrix-card { padding:1.25rem; }
    .so-matrix-head { display:flex; align-items:baseline; justify-content:space-between; gap:.75rem; margin-bottom:.75rem; }
    .so-matrix-wrap { overflow-x:auto; border:1px solid var(--border); border-radius:var(--radius-md); }
    .so-matrix { border-collapse:separate; border-spacing:0; font-size:.78rem; white-space:nowrap; min-width:100%; --so-h1:2.15rem; }
    /* Reglas horizontales solamente; verticales SOLO en fronteras de grupo (look de reporte, no de hoja de cálculo). */
    .so-matrix th, .so-matrix td { border-bottom:1px solid var(--border); padding:.34rem .6rem; }
    .so-matrix thead th { background:var(--layout-bg); font-weight:700; text-align:center; position:sticky; top:0; z-index:2; }
    /* Header de 2 niveles: la sub-fila (Cajas/Monto) baja bajo la fila de grupos, si no se solapan al hacer scroll. */
    .so-matrix thead tr:first-child th { height:var(--so-h1); top:0; }
    .so-matrix thead tr:nth-child(2) th { top:var(--so-h1); border-bottom:2px solid var(--border-color); }
    .so-matrix thead th.c0, .so-matrix thead th.c1 { text-align:left; }
    .so-matrix thead th.c2 { text-align:right; }
    .so-matrix thead th.grp { text-align:center; font-size:.72rem; border-right:1px solid var(--border); }
    .so-matrix thead th.grp.tot { background:var(--surface-selected-bg); }
    /* Sub-headers Cajas/Monto: micro-label alineado a su número. */
    .so-matrix .sub { font-size:.66rem; font-weight:700; color:var(--text-muted); text-transform:uppercase; letter-spacing:.04em; text-align:right; }
    /* Separador continuo en cada frontera de grupo-sucursal (fin de cada Monto). */
    .so-matrix .m { border-right:1px solid var(--border); }
    /* Números: Cajas = secundario (muted), Monto = primario (fuerte). */
    .so-matrix td.n { text-align:right; font-variant-numeric:tabular-nums; min-width:64px; }
    .so-matrix td.n:not(.m):not(.b) { color:var(--text-muted); }
    .so-matrix td.name { max-width:280px; overflow:hidden; text-overflow:ellipsis; }
    .so-matrix td.mono { font-family:var(--font-mono); font-size:.74rem; }
    .so-matrix td.b { font-weight:700; }
    /* Bloque congelado: identidad del producto; divisores internos suaves + sombra de borde. */
    .so-matrix .frz { position:sticky; background:var(--card-bg); z-index:1; }
    .so-matrix thead .frz { z-index:3; }
    .so-matrix .c0, .so-matrix .c1 { border-right:1px solid var(--border); }
    .so-matrix .c0 { left:0; } .so-matrix .c1 { left:70px; } .so-matrix .c2 { left:350px; }
    .so-matrix .c2 { box-shadow:6px 0 6px -4px rgba(0,0,0,.16); }
    /* Columna TOTAL: resumen destacado (tinte + borde izquierdo marcado, header→foot). */
    .so-matrix tbody td:last-child, .so-matrix tbody td:nth-last-child(2),
    .so-matrix tfoot td:last-child, .so-matrix tfoot td:nth-last-child(2) { background:var(--surface-selected-bg); }
    .so-matrix tbody td:nth-last-child(2),
    .so-matrix tfoot td:nth-last-child(2),
    .so-matrix thead tr:first-child th.tot,
    .so-matrix thead tr:nth-child(2) th:nth-last-child(2) { border-left:2px solid var(--border-color); }
    .so-matrix tbody tr:hover td:not(.frz) { background:var(--table-hover); }
    .so-matrix tbody tr:hover td.frz { background:var(--hover-bg); }
    .so-matrix tfoot td { position:sticky; bottom:0; background:var(--surface-selected-bg); font-weight:700; z-index:2; }
    /* Skeleton de carga (mientras se genera el reporte) */
    .so-skel { display:flex; flex-direction:column; gap:1rem; }
    .so-skel-bar { height:2rem; width:min(420px,60%); border-radius:var(--radius-sm); }
    .so-skel-card { height:104px; border-radius:var(--radius-md); }
    .so-skel-table { display:flex; flex-direction:column; gap:.4rem; border:1px solid var(--border); border-radius:var(--radius-md); padding:.75rem; }
    .so-skel-row { height:1.9rem; border-radius:var(--radius-sm); }
    .shim { position:relative; overflow:hidden; background:var(--skeleton-bg); }
    .shim::after { content:''; position:absolute; inset:0; transform:translateX(-100%);
      background:linear-gradient(90deg,transparent,rgba(255,255,255,.22),transparent); animation:so-shim 1.2s infinite; }
    @keyframes so-shim { 100% { transform:translateX(100%); } }
    /* Congelado responsive: en móvil solo Código queda fijo (los px de c1/c2 comen el viewport). */
    @media (max-width:640px) {
      .so-matrix .c1, .so-matrix .c2 { position:static; }
      .so-matrix .c2 { box-shadow:none; }
      .so-matrix .c0 { box-shadow:6px 0 6px -4px rgba(0,0,0,.16); }
    }
    @media (prefers-reduced-motion:reduce) { .shim::after { animation:none; } }
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
  meta = signal<{ brand: string; period: string; channels: string } | null>(null);
  readonly skelRows = [0, 1, 2, 3, 4, 5, 6];
  readonly modeOpts = this.modes.map((m) => ({ label: m.label, value: m.key }));

  // form state
  brandId = signal<string | null>(null);
  periodMode = signal<PeriodMode>('month');
  // Medida visible en la matriz (display-only; el backend siempre trae cajas+monto).
  measure = signal<Measure>('ambas');
  readonly measureOpts = [
    { label: 'Cajas', value: 'cajas' },
    { label: 'Monto', value: 'monto' },
    { label: 'Ambas', value: 'ambas' },
  ];
  showCajas = computed(() => this.measure() !== 'monto');
  showMonto = computed(() => this.measure() !== 'cajas');
  grpColspan = computed(() => (this.measure() === 'ambas' ? 2 : 1));
  setMeasure(m: string) { this.measure.set(m as Measure); }
  monthDate: Date = new Date();
  rangeDates: Date[] | null = null;
  quarter = 1;
  year = new Date().getFullYear();
  channels: string[] = [];
  warehouses: string[] = [];
  byChannel = true;
  includeZeros = false;

  warehouseOpts = signal<SellOutWarehouseRow[]>([]);
  loadingWarehouses = signal(false);

  private curFrom = '';
  private curTo = '';

  yearOpts = computed(() => {
    const y = new Date().getFullYear();
    return [y, y - 1, y - 2, y - 3];
  });

  canGenerate = computed(() => !!this.brandId());

  constructor() {
    const now = new Date();
    // Default = mes anterior (cerrado). El mes en curso casi no tiene venta
    // consolidada todavía → arrancar ahí daba "sin venta" en todas las marcas.
    this.monthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    this.year = this.monthDate.getFullYear();
    this.quarter = Math.floor(this.monthDate.getMonth() / 3) + 1;
    this.syncPeriod();
    this.loadBrands();
    this.loadWarehouses();
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

  private loadWarehouses() {
    this.loadingWarehouses.set(true);
    this.svc.sellOutWarehouses()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (w) => { this.warehouseOpts.set(w); this.loadingWarehouses.set(false); },
        error: () => { this.loadingWarehouses.set(false); },
      });
  }

  setMode(m: string) { this.periodMode.set(m as PeriodMode); this.syncPeriod(); }

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

  private fmtDMY(iso: string): string {
    const [y, m, d] = iso.split('-');
    return d ? `${d}/${m}/${y}` : iso;
  }

  private buildMeta(): { brand: string; period: string; channels: string } {
    const brand = this.brands().find((b) => b.id === this.brandId())?.nombre ?? '—';
    const period = this.curFrom === this.curTo
      ? this.fmtDMY(this.curFrom)
      : `${this.fmtDMY(this.curFrom)} – ${this.fmtDMY(this.curTo)}`;
    const channels = this.channels.length
      ? this.channels.map((c) => this.channelOpts.find((o) => o.value === c)?.label ?? c).join(', ')
      : 'Todos los canales';
    return { brand, period, channels };
  }

  private buildParams(): SellOutParams {
    return {
      brand_id: this.brandId()!,
      from: this.curFrom,
      to: this.curTo,
      group_by: this.byChannel ? 'branch_channel' : 'branch',
      channels: this.channels.length ? this.channels : undefined,
      warehouses: this.warehouses.length ? this.warehouses : undefined,
      include_zeros: this.includeZeros,
    };
  }

  generate() {
    this.syncPeriod();
    if (!this.brandId() || !this.curFrom || !this.curTo) {
      this.toast.add({ severity: 'warn', summary: 'Falta empresa o periodo' });
      return;
    }
    this.loading.set(true);
    this.svc.sellOut(this.buildParams())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.report.set(r); this.meta.set(this.buildMeta()); this.loading.set(false); },
        error: (e) => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error al generar', detail: e?.error?.message }); },
      });
  }

  download(fmt: 'xlsx' | 'pdf') {
    if (!this.brandId()) return;
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

  cell(row: SellOutReport['rows'][number], key: string): SellOutCell | undefined {
    return row.cells[key];
  }

  colTotal(r: SellOutReport, key: string) {
    return r.column_totals[key] ?? { cajas: 0, monto: 0 };
  }
}
