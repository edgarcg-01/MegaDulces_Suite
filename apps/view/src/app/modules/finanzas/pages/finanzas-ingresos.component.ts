import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subscription } from 'rxjs';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { MultiSelectModule } from 'primeng/multiselect';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { TableModule } from 'primeng/table';
import { TreeTableModule } from 'primeng/treetable';
import { ChartModule } from 'primeng/chart';
import { TreeNode } from 'primeng/api';
import {
  ComercialService, IncomeGroupBy, IncomeParams, IncomeReport, IncomeRow, IncomeSources, IncomeTree, IncomeTreeNode,
} from '../../comercial/comercial.service';
import { SALES_CANAL_ORDER, SALES_CANAL_SHORT, salesCanalLabel, type SalesCanal } from '@megadulces/contracts';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { ThemeService } from '../../../core/services/theme.service';
import { egresChartOptions, egresChartSeries } from '../../comercial/pages/egresos-chart-opts';

/**
 * `[IG.2]` Ingresos contables — el otro lado del libro de `/finanzas/egresos`.
 *
 * ── POR QUÉ NO ES LA MISMA PANTALLA, AUNQUE LO PAREZCA ───────────────────────────────────
 * Reusa los mismos organismos (métricas, segmentado, píldora de frescura, opciones de gráfica,
 * banda de cobertura) pero **no las mismas dimensiones**, porque del lado del ingreso casi ninguna
 * mide. Medido en prod el 2026-09-25:
 *
 *   · la `sucursal` es SIEMPRE `00` — la venta se contabiliza centralizada en el CEDIS, y es el
 *     filtro que evita contar la misma venta hasta 7 veces (+69 %);
 *   · `área`, `departamento` y `concepto` vienen del ciclo de solicitud de gasto → vacíos;
 *   · el nombre de la cuenta MIENTE: `401-002` se llama «VENTA FLETES A TERCEROS» y no es fletes;
 *     `401-003` es «VECINAL» en unas sucursales y «MAYOREO» en otras.
 *
 * Lo que sí discrimina —y de ahí salen el árbol y la tabla— es **canal → plaza**, que vive en el
 * concepto `c6` de la póliza.
 *
 * La fuente es `analytics.income_entries_src()`: derivación viva sobre el ODS, no una tabla de
 * importer, así que la frescura es de minutos y no de la noche anterior.
 */
@Component({
  selector: 'app-finanzas-ingresos',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, MultiSelectModule, SelectModule,
    DatePickerModule, InputNumberModule, InputTextModule, ToggleSwitchModule,
    TableModule, TreeTableModule, ChartModule,
    SegmentedComponent, MetricStripComponent, LoadStateComponent, FreshnessPillComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <div style="display:inline-flex;align-items:center;gap:.4rem">
            <h1>Ingresos contables</h1>
            @if (report(); as r) { <app-freshness-pill measures="data" [freshness]="r.freshness" label="ingresos" /> }
          </div>
          <p class="surf-page-sub">Pólizas de venta (401) del CEDIS · desglose por canal y plaza · derivado del ODS al minuto</p>
        </div>
        <button pButton type="button" class="p-button-sm p-button-outlined" (click)="exportCsv()" [disabled]="!report()"><span class="p-button-icon p-button-icon-left pi pi-download" aria-hidden="true"></span><span class="p-button-label">Exportar CSV</span></button>
      </header>

      <div class="in-filters card-premium card-flat">
        <div class="in-field"><label>Canal</label>
          <p-multiselect [options]="canalOpts" [(ngModel)]="canal" optionLabel="label" optionValue="value" placeholder="Todos" [showClear]="true" appendTo="body" styleClass="w-full" (onPanelHide)="queueFilter()" /></div>
        <div class="in-field"><label>Mes</label>
          <p-select [options]="mesOpts" [(ngModel)]="mesSel" optionLabel="label" optionValue="value" [showClear]="true" placeholder="—" appendTo="body" (onChange)="pickMes($event.value)" styleClass="w-full" [filter]="true" /></div>
        <div class="in-field"><label>Rango</label>
          <p-datepicker [(ngModel)]="rangeDates" selectionMode="range" dateFormat="dd/mm/yy" [showIcon]="true" appendTo="body" (onClose)="onRangeChange()" /></div>
        <div class="in-field"><label>Concepto / cliente</label>
          <input pInputText [(ngModel)]="concepto" placeholder="Buscar…" (keyup.enter)="applyFilters()" (blur)="queueFilter()" /></div>
        <div class="in-field in-narrow"><label>Monto ≥</label>
          <p-inputnumber [(ngModel)]="minImporte" mode="currency" currency="MXN" [min]="0" (onBlur)="queueFilter()" /></div>
        <div class="in-field in-toggle"><label>Comparar</label>
          <p-toggleswitch [(ngModel)]="compare" (ngModelChange)="queueFilter()" /></div>
      </div>

      @if (report()) { <app-metric-strip [items]="kpiItems()" ariaLabel="Resumen de ingresos" /> }

      <!-- Cobertura declarada: mismo motor que Egresos, etiquetado en PLAZAS. -->
      @if (coverageAviso(); as cov) {
        <div class="in-cov" role="note">
          <i class="pi pi-info-circle" aria-hidden="true"></i>
          <div class="in-cov-body">
            @if (cov.comp; as c) {
              <div class="in-cov-delta">
                <span>Δ vs período previo: <strong class="in-cov-all">{{ signo(c.delta_pct) }}</strong> con todas las plazas,
                  <strong class="in-cov-ok">{{ signo(c.delta_pct_comparable) }}</strong> con las que reportan en ambos períodos.</span>
              </div>
              @if (c.solo_actual.length) {
                <div>Plazas nuevas en este período: <strong>{{ lista(c.solo_actual) }}</strong> — su venta sube el total sin que las demás hayan vendido más.</div>
              }
              @if (c.solo_previo.length) {
                <div>Dejaron de reportar: <strong>{{ c.solo_previo.join(', ') }}</strong>.</div>
              }
            }
            <div>{{ cov.note }}</div>
            @if (cov.meses_parciales.length) {
              <div>Meses incompletos en la tendencia: <strong>{{ cov.meses_parciales.join(', ') }}</strong> — su barra es más baja por calendario.</div>
            }
            @if (cov.pct !== null) {
              <div class="muted">Comparable mes a mes: <strong>{{ cov.pct }}%</strong> del importe del rango ({{ cov.grupos_todos.length }} de {{ cov.grupos.length }} plazas en todos los meses).</div>
            }
          </div>
        </div>
      }

      <div class="in-viewbar">
        <app-segmented [options]="viewOpts" [value]="view()" (valueChange)="setView($event)" ariaLabel="Vista" />
        @if (view() === 'tabla') {
          <div class="in-dim">
            <label>Agrupar por</label>
            <p-select [options]="groupByOpts" [ngModel]="groupBy()" (ngModelChange)="setGroupBy($event)" optionLabel="label" optionValue="value" appendTo="body" />
          </div>
        }
      </div>

      @if (loading()) {
        <div class="in-empty">Cargando…</div>
      } @else if (error()) {
        <app-load-state [error]="error()" (retry)="reload()"></app-load-state>
      } @else {
        @if (view() === 'arbol') {
          <p-treetable [value]="treeNodes()" [scrollable]="true" styleClass="p-treetable-sm in-table">
            <ng-template #header>
              <tr><th>Canal / plaza</th><th class="ta-r" style="width:8rem">Docs</th><th class="ta-r" style="width:12rem">Importe</th><th class="ta-r" style="width:7rem">%</th></tr>
            </ng-template>
            <ng-template #body let-rowNode let-rowData="rowData">
              <tr [ttRow]="rowNode">
                <td>
                  <p-treetabletoggler [rowNode]="rowNode" />
                  <span [class.strong]="rowData.level === 'canal'">{{ rowData.label }}</span>
                  @if (rowData.residuo) { <span class="in-tag">residuo</span> }
                </td>
                <td class="ta-r">{{ rowData.movs | number }}</td>
                <td class="ta-r strong">{{ money(rowData.total) }}</td>
                <td class="ta-r muted">{{ rowData.share_pct }}%</td>
              </tr>
            </ng-template>
            <ng-template #emptymessage><tr><td colspan="4" class="in-empty">Sin ingresos en el período.</td></tr></ng-template>
          </p-treetable>
        }

        @if (view() === 'tabla' && report(); as r) {
          <p-table [value]="r.rows" [scrollable]="true" scrollHeight="flex" styleClass="p-datatable-sm in-table" [rowHover]="true"
                   [paginator]="r.rows.length > 50" [rows]="50" sortField="total" [sortOrder]="-1">
            <ng-template #header>
              <tr>
                <th pSortableColumn="label">{{ groupByLabel() }}</th>
                <th class="ta-r" style="width:7rem" pSortableColumn="movs">Docs</th>
                <th class="ta-r" style="width:12rem" pSortableColumn="total">Importe</th>
                <th class="ta-r" style="width:7rem" pSortableColumn="share_pct">%</th>
                @if (compare()) { <th class="ta-r" style="width:8rem" pSortableColumn="delta_pct">Δ vs prev</th> }
              </tr>
            </ng-template>
            <ng-template #body let-row>
              <tr>
                <td>
                  {{ row.label }}
                  @if (canalShort(row.canal); as tag) { <span class="in-tag">{{ tag }}</span> }
                </td>
                <td class="ta-r">{{ row.movs | number }}</td>
                <td class="ta-r strong">{{ money(row.total) }}</td>
                <td class="ta-r muted">{{ row.share_pct }}%</td>
                @if (compare()) {
                  <td class="ta-r" [class.up]="row.delta_pct > 0" [class.down]="row.delta_pct < 0">
                    {{ row.delta_pct === null ? '—' : (row.delta_pct > 0 ? '+' : '') + row.delta_pct + '%' }}
                  </td>
                }
              </tr>
            </ng-template>
            <ng-template #emptymessage><tr><td [attr.colspan]="compare() ? 5 : 4" class="in-empty">Sin ingresos en el período.</td></tr></ng-template>
          </p-table>
        }

        @if (view() === 'tendencia') {
          <div class="card-premium card-flat in-chart">
            <p-chart type="bar" [data]="chartData()" [options]="chartOpts()" height="360px"></p-chart>
          </div>
        }

        <!-- [IG.3] CUADRE DE FUENTES — cuatro caminos al mismo peso de venta. -->
        @if (view() === 'cuadre') {
          @if (sources(); as s) {
            <div class="card-premium card-flat">
              <p-table [value]="s.fuentes" styleClass="p-datatable-sm in-table">
                <ng-template #header>
                  <tr><th>Fuente</th><th class="ta-r" style="width:13rem">Importe</th><th class="ta-r" style="width:8rem">Δ vs contable</th><th>Qué significa</th></tr>
                </ng-template>
                <ng-template #body let-f>
                  <tr [class.in-nocomp]="!f.comparable">
                    <td class="strong">{{ f.label }}</td>
                    <td class="ta-r strong">{{ f.monto === null ? 'NO MEDIDO' : money(f.monto) }}</td>
                    <td class="ta-r" [class.muted]="!f.comparable">
                      {{ f.monto === null || !f.comparable ? '—' : signo(f.delta_pct) }}
                    </td>
                    <td class="muted">{{ f.nota }}</td>
                  </tr>
                </ng-template>
              </p-table>
            </div>
          } @else {
            <div class="in-empty">Cargando el cuadre…</div>
          }
        }
      }
    </div>
  `,
  styles: [`
    .in-filters { display: flex; flex-wrap: wrap; gap: .9rem; align-items: flex-end; margin-bottom: 1rem; padding: 1rem; }
    .in-field { display: flex; flex-direction: column; gap: .3rem; min-width: 11rem; }
    .in-field > label { font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted, #78716c); }
    .in-narrow { min-width: 8rem; }
    .in-toggle { min-width: 6rem; }
    .in-viewbar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin: 1rem 0 .8rem; flex-wrap: wrap; }
    .in-dim { display: flex; align-items: center; gap: .5rem; font-size: .8rem; color: var(--text-muted, #78716c); }
    .in-table { font-size: .84rem; }
    .in-empty { padding: 2rem; text-align: center; color: var(--text-muted, #78716c); }
    .in-chart { padding: 1rem; }
    .in-tag { margin-left: .45rem; font-size: .66rem; padding: .08rem .35rem; border-radius: var(--r-pill, 999px);
      background: color-mix(in srgb, currentColor 10%, transparent); color: var(--text-muted, #78716c); }
    /* La fila no comparable se atenúa: está ahí para dar contexto, no para restarla. */
    .in-nocomp { opacity: .78; }
    /* Banda de cobertura — gemela de la de Egresos. Tono warn: no está roto, está declarado. */
    .in-cov { display: flex; gap: .6rem; align-items: flex-start; margin: 0 0 1rem;
      font-size: .82rem; line-height: 1.45; color: var(--text-strong, inherit);
      background: color-mix(in srgb, var(--warn-fg) 8%, transparent);
      border: 1px solid color-mix(in srgb, var(--warn-fg) 28%, transparent);
      border-radius: var(--r-sm, .4rem); padding: .6rem .8rem; }
    .in-cov > .pi { color: var(--warn-fg); margin-top: .15rem; flex: none; }
    .in-cov-body { display: flex; flex-direction: column; gap: .25rem; }
    .in-cov-delta { font-size: .88rem; }
    .in-cov-all { color: var(--text-muted, #78716c); }
    .in-cov-ok { color: var(--ok-fg); }
    .in-cov .muted { color: var(--text-muted, #78716c); }
  `],
})
export class FinanzasIngresosComponent {
  private readonly svc = inject(ComercialService);
  private readonly theme = inject(ThemeService);
  private readonly destroyRef = inject(DestroyRef);

  readonly viewOpts = [
    { label: 'Árbol', value: 'arbol' }, { label: 'Tabla', value: 'tabla' },
    { label: 'Tendencia', value: 'tendencia' }, { label: '¿Cuadra?', value: 'cuadre' },
  ];
  readonly groupByOpts: Array<{ label: string; value: IncomeGroupBy }> = [
    { label: 'Canal', value: 'canal' }, { label: 'Plaza', value: 'plaza' },
    { label: 'Documento', value: 'documento' }, { label: 'Mes', value: 'mes' },
  ];
  /** Las etiquetas salen del contrato, no de una lista a mano (ADR-056). */
  readonly canalOpts = SALES_CANAL_ORDER.map((c) => ({ label: salesCanalLabel(c), value: c }));

  readonly report = signal<IncomeReport | null>(null);
  readonly tree = signal<IncomeTree | null>(null);
  readonly sources = signal<IncomeSources | null>(null);
  readonly error = signal<string | null>(null);
  readonly loading = signal(false);
  readonly view = signal<'arbol' | 'tabla' | 'tendencia' | 'cuadre'>('arbol');
  readonly groupBy = signal<IncomeGroupBy>('canal');
  readonly compare = signal(false);

  canal: string[] = [];
  concepto = '';
  minImporte: number | null = null;
  rangeDates: Date[] = [(() => { const d = new Date(); d.setDate(d.getDate() - 90); return d; })(), new Date()];
  mesSel: string | null = null;

  /** Últimos 18 meses. ⚠️ 2025 fue PRESUPUESTO (sin UD1301): la banda de cobertura lo declara. */
  readonly mesOpts = (() => {
    const out: { label: string; value: string }[] = [];
    const d = new Date();
    for (let i = 0; i < 18; i++) {
      const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const lbl = d.toLocaleDateString('es-MX', { month: 'long', year: 'numeric' });
      out.push({ label: lbl.charAt(0).toUpperCase() + lbl.slice(1), value: val });
      d.setMonth(d.getMonth() - 1);
    }
    return out;
  })();

  readonly kpiItems = computed<MetricStripItem[]>(() => {
    const r = this.report();
    if (!r) return [];
    const items: MetricStripItem[] = [
      { label: 'Ingreso total', value: r.total, format: 'currency', tone: 'brand', sub: `${r.movimientos} docs` },
    ];
    for (const c of r.by_canal) {
      items.push({ label: c.label, value: c.total, format: 'currency', sub: `${c.movs} docs · ${this.pct(c.total, r.total)}%` });
    }
    return items;
  });

  readonly treeNodes = computed<TreeNode[]>(() => (this.tree()?.tree || []).map((n) => this.toNode(n, true)));
  readonly groupByLabel = computed(() => this.groupByOpts.find((o) => o.value === this.groupBy())?.label || 'Canal');

  readonly chartData = computed(() => {
    const s = this.report()?.series || [];
    return {
      labels: s.map((p) => (p.parcial ? `${p.mes} ·parcial` : p.mes)),
      datasets: [
        { label: 'Mostrador', data: s.map((p) => p.mostrador), backgroundColor: egresChartSeries()[0] },
        { label: 'Telemarketing', data: s.map((p) => p.telemarketing), backgroundColor: egresChartSeries()[1] },
        { label: 'Ruta', data: s.map((p) => p.ruta), backgroundColor: egresChartSeries()[2] },
        { label: 'Reparto vecinal', data: s.map((p) => p.vecinal), backgroundColor: egresChartSeries()[3] },
        { label: 'Contado', data: s.map((p) => p.contado), backgroundColor: egresChartSeries()[4] },
        { label: 'Sin canal declarado', data: s.map((p) => p.otro), backgroundColor: egresChartSeries()[5] },
      ],
    };
  });
  readonly chartOpts = computed(() => egresChartOptions(
    this.theme.isMonochrome(),
    new Map((this.report()?.series || []).map((p) => [p.mes, { parcial: p.parcial, sucursales: p.plazas }])),
  ));

  /** Mismo criterio que en Egresos: el aviso sale sólo cuando hay algo que declarar. */
  readonly coverageAviso = computed(() => {
    const r = this.report();
    if (!r?.coverage?.measured) return null;
    const c = r.coverage;
    const comp = r.comparativo?.universo_cambio ? r.comparativo : null;
    if (!comp && !c.grupos_parciales.length && !c.meses_parciales.length) return null;
    return { ...c, comp };
  });

  /**
   * Nombra unos pocos y cuenta el resto. La banda ya publicó una vez «237 plazas» seguido de
   * doscientos nombres de cliente: un aviso que no se puede leer no avisa. El arreglo de fondo es
   * que el residuo cuente como UN grupo (lo hace el servidor), esto es el cinturón.
   */
  lista(xs: string[], n = 5): string {
    return xs.slice(0, n).join(', ') + (xs.length > n ? ` y ${xs.length - n} más` : '');
  }

  signo(v: number | null): string { return v === null ? 'sin base' : `${v > 0 ? '+' : ''}${v}%`; }
  canalShort(c: string | null): string { return c ? (SALES_CANAL_SHORT[c as SalesCanal] ?? '') : ''; }
  money(v: number | string | null | undefined): string { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  pct(part: number, total: number): number { return total ? +((part / total) * 100).toFixed(1) : 0; }

  private toNode(n: IncomeTreeNode, expanded = false): TreeNode {
    return {
      data: { ...n, residuo: n.key === 'otro' },
      expanded,
      children: (n.children || []).map((c) => this.toNode(c)),
      leaf: !n.children?.length,
    };
  }

  private fresh = { report: false, tree: false, sources: false };
  private filterTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() { this.showView(); }

  setView(v: string) { this.view.set(v as 'arbol'); this.showView(); }
  setGroupBy(v: IncomeGroupBy) { this.groupBy.set(v); this.fresh.report = false; this.showView(); }

  pickMes(v: string | null) {
    this.mesSel = v || null;
    if (v) {
      const [y, m] = v.split('-').map(Number);
      this.rangeDates = [new Date(y, m - 1, 1), new Date(y, m, 0)];
    }
    this.applyFilters();
  }
  onRangeChange() { this.mesSel = null; this.queueFilter(); }
  queueFilter() {
    if (this.filterTimer) clearTimeout(this.filterTimer);
    this.filterTimer = setTimeout(() => this.applyFilters(), 300);
  }
  applyFilters() {
    if (this.filterTimer) { clearTimeout(this.filterTimer); this.filterTimer = null; }
    this.fresh = { report: false, tree: false, sources: false };
    this.showView();
  }
  reload() { this.error.set(null); this.applyFilters(); }

  private showView() {
    if (!this.fresh.report) this.loadReport();
    if (this.view() === 'arbol' && !this.fresh.tree) this.loadTree();
    if (this.view() === 'cuadre' && !this.fresh.sources) this.loadSources();
  }

  private params(extra: Partial<IncomeParams> = {}): IncomeParams {
    const [a, b] = this.rangeDates || [];
    // Formateo LOCAL (no toISOString): con UTC-6 el día se corre y el rango pide otro mes.
    const fmt = (d?: Date) =>
      d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : undefined;
    return {
      from: fmt(a), to: fmt(b),
      canal: this.canal, concepto: this.concepto || undefined,
      min_importe: this.minImporte ?? undefined,
      ...extra,
    };
  }

  private reportSub?: Subscription;
  private treeSub?: Subscription;
  private sourcesSub?: Subscription;

  private loadReport() {
    this.loading.set(true);
    this.error.set(null);
    this.reportSub?.unsubscribe();
    this.reportSub = this.svc.income(this.params({ group_by: this.groupBy(), compare: this.compare() }))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.report.set(r); this.fresh.report = true; this.loading.set(false); },
        error: () => { this.loading.set(false); this.error.set('No se pudieron cargar los ingresos del período.'); },
      });
  }

  private loadTree() {
    this.treeSub?.unsubscribe();
    this.treeSub = this.svc.incomeTree(this.params()).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (t) => { this.tree.set(t); this.fresh.tree = true; },
        // Declara, no se calla: «sin ingresos» y «no se pudo cargar» se leen igual (lección GX.19).
        error: () => { this.tree.set(null); this.fresh.tree = false; this.error.set('No se pudo cargar el desglose por canal.'); },
      });
  }

  private loadSources() {
    this.sourcesSub?.unsubscribe();
    this.sourcesSub = this.svc.incomeSources(this.params()).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (s) => { this.sources.set(s); this.fresh.sources = true; },
        error: () => { this.sources.set(null); this.error.set('No se pudo cargar el cuadre de fuentes.'); },
      });
  }

  exportCsv() {
    const r = this.report();
    if (!r) return;
    const head = ['concepto', 'docs', 'importe', 'share_pct', ...(this.compare() ? ['delta_pct'] : [])];
    const lines = [head.join(',')];
    for (const row of r.rows as IncomeRow[]) {
      const label = (row.label || '').replace(/"/g, '""');
      const base: (string | number)[] = [`"${label}"`, row.movs, row.total, row.share_pct];
      if (this.compare()) base.push(row.delta_pct ?? '');
      lines.push(base.join(','));
    }
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ingresos_${r.group_by}_${r.from}_${r.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
}
