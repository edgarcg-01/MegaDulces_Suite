import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
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
import { ToastModule } from 'primeng/toast';
import { MessageService, TreeNode } from 'primeng/api';
import {
  ComercialService,
  ExpensesReport,
  ExpensesTree,
  ExpenseTreeNode,
  ExpenseDocRow,
  ExpenseRow,
  ExpensesParams,
  ExpenseGroupBy,
} from '../comercial.service';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { REPORTS_TABS } from '../reports-tabs';

/**
 * GX v2 — Egresos contables (pólizas gastos + compras) con desglose jerárquico
 * tipo menú (Familia→Mayor→Subcuenta), tabla dinámica por dimensión, tendencia
 * mensual, filtros ampliados, comparativo de período y drill a documentos.
 */
@Component({
  selector: 'app-comercial-egresos',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, MultiSelectModule, SelectModule,
    DatePickerModule, InputNumberModule, InputTextModule, ToggleSwitchModule,
    TableModule, TreeTableModule, ChartModule, ToastModule,
    PageTabsComponent, SegmentedComponent,
  ],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="reportTabs" />

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Egresos contables</h1>
          <p class="surf-page-sub">Pólizas de gastos (6xx) y compras (5xx) · desglose por cuenta, beneficiario, sucursal y más · fuente Kepler</p>
        </div>
        <button pButton type="button" label="Exportar CSV" icon="pi pi-download"
                class="p-button-sm p-button-outlined" (click)="exportCsv()" [disabled]="!report()"></button>
      </header>

      <!-- Filtros -->
      <div class="ex-filters card-premium card-flat">
        <div class="ex-field"><label>Rango</label>
          <p-datePicker [(ngModel)]="rangeDates" selectionMode="range" dateFormat="dd/mm/yy" [showIcon]="true" appendTo="body" (onClose)="load()" /></div>
        <div class="ex-field"><label>Sucursales</label>
          <p-multiSelect [options]="sucursales()" [(ngModel)]="sucursal" optionLabel="label" optionValue="code" placeholder="Todas" [showClear]="true" appendTo="body" styleClass="w-full" (onPanelHide)="load()" /></div>
        <div class="ex-field"><label>Tipo</label>
          <app-segmented [options]="familiaOpts" [value]="familia()" (valueChange)="setStr(familia, $event)" ariaLabel="Tipo de egreso" /></div>
        <div class="ex-field"><label>Tipo doc</label>
          <p-select [options]="docTipoOpts()" [(ngModel)]="docTipo" [showClear]="true" placeholder="Todos" appendTo="body" (onChange)="load()" styleClass="w-full" /></div>
        <div class="ex-field"><label>Área</label>
          <p-select [options]="areaOpts()" [(ngModel)]="area" [showClear]="true" placeholder="Todas" appendTo="body" (onChange)="load()" styleClass="w-full" [filter]="true" /></div>
        <div class="ex-field"><label>Beneficiario</label>
          <input pInputText [(ngModel)]="beneficiario" placeholder="Buscar…" (keyup.enter)="load()" (blur)="load()" /></div>
        <div class="ex-field ex-narrow"><label>Monto ≥</label>
          <p-inputNumber [(ngModel)]="minImporte" mode="currency" currency="MXN" [min]="0" (onBlur)="load()" /></div>
        <div class="ex-field ex-toggle"><label>Comparar</label>
          <p-toggleSwitch [(ngModel)]="compare" (ngModelChange)="load()" /></div>
      </div>

      <!-- KPIs -->
      @if (report(); as r) {
        <div class="ex-kpis">
          <div class="ex-kpi">
            <span class="ex-kpi-label">Egreso total</span>
            <span class="ex-kpi-val">{{ money(r.total) }}</span>
            <span class="ex-kpi-sub">{{ r.movimientos | number }} movs · {{ r.from }} → {{ r.to }}</span>
          </div>
          @for (f of r.by_familia; track f.familia) {
            <div class="ex-kpi">
              <span class="ex-kpi-label">{{ f.label }}</span>
              <span class="ex-kpi-val">{{ money(f.total) }}</span>
              <span class="ex-kpi-sub">{{ f.movs | number }} movs · {{ pct(f.total, r.total) }}%</span>
            </div>
          }
        </div>
      }

      <!-- Vista -->
      <div class="ex-viewbar">
        <app-segmented [options]="viewOpts" [value]="view()" (valueChange)="setView($event)" ariaLabel="Vista" />
        @if (view() === 'tabla') {
          <div class="ex-dim">
            <label>Agrupar por</label>
            <p-select [options]="groupByOpts" [ngModel]="groupBy()" (ngModelChange)="setGroupBy($event)" optionLabel="label" optionValue="value" appendTo="body" />
          </div>
        }
      </div>

      @if (loading()) {
        <div class="ex-empty">Cargando…</div>
      } @else {
        <!-- ÁRBOL -->
        @if (view() === 'arbol') {
          <p-treeTable [value]="treeNodes()" [scrollable]="true" styleClass="p-treetable-sm ex-table">
            <ng-template pTemplate="header">
              <tr><th>Concepto</th><th class="ta-r" style="width:8rem">Movs</th><th class="ta-r" style="width:12rem">Importe</th><th class="ta-r" style="width:7rem">%</th></tr>
            </ng-template>
            <ng-template pTemplate="body" let-rowNode let-rowData="rowData">
              <tr [ttRow]="rowNode" [class.ex-clickable]="rowData.level === 'cuenta'" (click)="rowData.level === 'cuenta' && openCuenta(rowData.key, rowData.label)">
                <td>
                  <p-treeTableToggler [rowNode]="rowNode" />
                  <span [class.strong]="rowData.level === 'familia'" [class.muted]="rowData.level === 'cuenta'">{{ rowData.label }}</span>
                  @if (rowData.level === 'cuenta') { <span class="mono ex-code">{{ rowData.key }}</span> }
                </td>
                <td class="ta-r">{{ rowData.movs | number }}</td>
                <td class="ta-r strong">{{ money(rowData.total) }}</td>
                <td class="ta-r muted">{{ rowData.share_pct }}%</td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage"><tr><td colspan="4" class="ex-empty">Sin egresos.</td></tr></ng-template>
          </p-treeTable>
        }

        <!-- TABLA DINÁMICA -->
        @if (view() === 'tabla' && report(); as r) {
          <p-table [value]="r.rows" [scrollable]="true" scrollHeight="flex" styleClass="p-datatable-sm ex-table" [rowHover]="true"
                   [paginator]="r.rows.length > 50" [rows]="50" sortField="total" [sortOrder]="-1">
            <ng-template pTemplate="header">
              <tr>
                <th pSortableColumn="label">{{ groupByLabel() }}</th>
                <th class="ta-r" style="width:7rem" pSortableColumn="movs">Movs</th>
                <th class="ta-r" style="width:12rem" pSortableColumn="total">Importe</th>
                <th class="ta-r" style="width:7rem" pSortableColumn="share_pct">%</th>
                @if (compare()) { <th class="ta-r" style="width:8rem" pSortableColumn="delta_pct">Δ vs prev</th> }
                <th style="width:3rem"></th>
              </tr>
            </ng-template>
            <ng-template pTemplate="body" let-row>
              <tr class="ex-clickable" (click)="drillRow(row)">
                <td>
                  {{ row.label }}
                  @if (row.familia === '5') { <span class="ex-tag fam5">Compra</span> }
                  @else if (row.familia === '6') { <span class="ex-tag fam6">Gasto</span> }
                </td>
                <td class="ta-r">{{ row.movs | number }}</td>
                <td class="ta-r strong">{{ money(row.total) }}</td>
                <td class="ta-r muted">{{ row.share_pct }}%</td>
                @if (compare()) {
                  <td class="ta-r" [class.up]="row.delta_pct > 0" [class.down]="row.delta_pct < 0">
                    {{ row.delta_pct === null ? '—' : (row.delta_pct > 0 ? '+' : '') + row.delta_pct + '%' }}
                  </td>
                }
                <td class="ta-r"><i class="pi pi-angle-right muted"></i></td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage"><tr><td [attr.colspan]="compare() ? 6 : 5" class="ex-empty">Sin egresos en el período.</td></tr></ng-template>
          </p-table>
        }

        <!-- TENDENCIA -->
        @if (view() === 'tendencia') {
          <div class="card-premium card-flat ex-chart">
            <p-chart type="bar" [data]="chartData()" [options]="chartOpts" height="360px"></p-chart>
          </div>
        }
      }

      <!-- Drill: documentos -->
      @if (docsTitle()) {
        <div class="ex-docs card-premium card-flat">
          <div class="ex-docs-head">
            <span class="ex-docs-title">{{ docsTitle() }}</span>
            <span class="ex-docs-total">{{ docsTotal() }} · {{ money(docsSum()) }}</span>
            <button pButton type="button" icon="pi pi-times" class="p-button-text p-button-sm" (click)="closeDocs()"></button>
          </div>
          <p-table [value]="docs()" styleClass="p-datatable-sm ex-table" [rowHover]="true" [scrollable]="true" scrollHeight="420px"
                   [paginator]="docs().length > 100" [rows]="100">
            <ng-template pTemplate="header">
              <tr><th style="width:6rem">Fecha</th><th>Documento</th><th>Sucursal</th><th>Cuenta</th><th>Beneficiario</th><th class="ta-r" style="width:9rem">Importe</th></tr>
            </ng-template>
            <ng-template pTemplate="body" let-d>
              <tr>
                <td>{{ d.fecha | date:'dd/MM/yy' }}</td>
                <td class="mono">{{ d.doc_tipo }}-{{ d.doc_folio }}</td>
                <td>{{ d.sucursal_nombre || d.sucursal }}</td>
                <td>{{ d.cuenta_nombre || d.cuenta }}</td>
                <td>{{ d.beneficiario || '—' }}</td>
                <td class="ta-r strong">{{ money(d.importe) }}</td>
              </tr>
            </ng-template>
          </p-table>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .ex-filters { display: flex; flex-wrap: wrap; gap: .9rem; align-items: flex-end; margin-bottom: 1rem; padding: 1rem; }
    .ex-field { display: flex; flex-direction: column; gap: .35rem; }
    .ex-field label { font-size: .72rem; font-weight: 600; color: var(--text-muted, #78716c); text-transform: uppercase; letter-spacing: .03em; }
    .ex-narrow { max-width: 10rem; }
    .ex-toggle { align-items: center; }
    .ex-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: .75rem; margin-bottom: 1rem; }
    .ex-kpi { border: 1px solid var(--border, #e7e5e4); border-radius: var(--radius-md, 10px); padding: .85rem 1rem; background: var(--card-bg, #fff); }
    .ex-kpi-label { display: block; font-size: .72rem; font-weight: 600; color: var(--text-muted, #78716c); text-transform: uppercase; letter-spacing: .03em; }
    .ex-kpi-val { display: block; font-size: 1.4rem; font-weight: 700; margin-top: .15rem; }
    .ex-kpi-sub { display: block; font-size: .74rem; color: var(--text-muted, #78716c); margin-top: .1rem; }
    .ex-viewbar { display: flex; align-items: center; gap: 1.5rem; margin-bottom: .75rem; flex-wrap: wrap; }
    .ex-dim { display: flex; align-items: center; gap: .5rem; }
    .ex-dim label { font-size: .72rem; font-weight: 600; color: var(--text-muted, #78716c); text-transform: uppercase; }
    .ex-table { font-variant-numeric: tabular-nums; }
    .ta-r { text-align: right; }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .85em; }
    .ex-code { color: var(--text-muted, #78716c); margin-left: .5rem; }
    .strong { font-weight: 700; }
    .muted { color: var(--text-muted, #78716c); }
    .up { color: #b91c1c; font-weight: 600; }
    .down { color: #15803d; font-weight: 600; }
    .ex-clickable { cursor: pointer; }
    .ex-tag { display: inline-block; font-size: .68rem; font-weight: 600; padding: .05rem .4rem; border-radius: 999px; margin-left: .5rem; border: 1px solid var(--border, #e7e5e4); }
    .ex-tag.fam5 { color: #9a3412; border-color: #fed7aa; background: #fff7ed; }
    .ex-tag.fam6 { color: #3730a3; border-color: #c7d2fe; background: #eef2ff; }
    .ex-empty { padding: 2rem; text-align: center; color: var(--text-muted, #78716c); }
    .ex-chart { padding: 1rem; }
    .ex-docs { margin-top: 1.25rem; padding: 1rem; }
    .ex-docs-head { display: flex; align-items: center; gap: 1rem; margin-bottom: .5rem; }
    .ex-docs-title { font-weight: 700; }
    .ex-docs-total { margin-left: auto; color: var(--text-muted, #78716c); font-weight: 600; }
  `],
})
export class ComercialEgresosComponent {
  private readonly svc = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly reportTabs = REPORTS_TABS;
  readonly familiaOpts = [{ label: 'Todo', value: '' }, { label: 'Compras', value: '5' }, { label: 'Gastos', value: '6' }];
  readonly viewOpts = [{ label: 'Árbol', value: 'arbol' }, { label: 'Tabla', value: 'tabla' }, { label: 'Tendencia', value: 'tendencia' }];
  readonly groupByOpts = [
    { label: 'Cuenta', value: 'cuenta' }, { label: 'Cuenta mayor', value: 'cuenta_mayor' },
    { label: 'Beneficiario', value: 'beneficiario' }, { label: 'Sucursal', value: 'sucursal' },
    { label: 'Tipo de documento', value: 'doc_tipo' }, { label: 'Área', value: 'area' }, { label: 'Mes', value: 'mes' },
  ];

  readonly report = signal<ExpensesReport | null>(null);
  readonly tree = signal<ExpensesTree | null>(null);
  readonly docs = signal<ExpenseDocRow[]>([]);
  readonly docsTitle = signal<string>('');
  readonly loading = signal(false);
  readonly sucursales = signal<{ code: string; label: string }[]>([]);
  readonly docTipoOpts = signal<string[]>([]);
  readonly areaOpts = signal<string[]>([]);

  readonly view = signal<'arbol' | 'tabla' | 'tendencia'>('arbol');
  readonly groupBy = signal<ExpenseGroupBy>('cuenta');
  readonly familia = signal<string>('');
  readonly compare = signal(false);
  sucursal: string[] = [];
  docTipo: string | null = null;
  area: string | null = null;
  beneficiario = '';
  minImporte: number | null = null;
  rangeDates: Date[] = [(() => { const d = new Date(); d.setDate(d.getDate() - 90); return d; })(), new Date()];

  readonly treeNodes = computed<TreeNode[]>(() => (this.tree()?.tree || []).map((n) => this.toNode(n, true)));
  readonly groupByLabel = computed(() => this.groupByOpts.find((o) => o.value === this.groupBy())?.label || 'Concepto');
  readonly docsTotal = computed(() => `${this.docs().length} docs`);
  readonly docsSum = computed(() => this.docs().reduce((a, d) => a + d.importe, 0));
  readonly chartData = computed(() => {
    const s = this.report()?.series || [];
    return {
      labels: s.map((p) => p.mes),
      datasets: [
        { label: 'Compras / Costo', data: s.map((p) => p.compras), backgroundColor: '#fb923c' },
        { label: 'Gastos', data: s.map((p) => p.gastos), backgroundColor: '#818cf8' },
      ],
    };
  });
  readonly chartOpts = {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { position: 'bottom' } },
    scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: (v: any) => '$' + Number(v).toLocaleString('es-MX') } } },
  };

  constructor() {
    this.svc.expensesSucursales().pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((rows) => this.sucursales.set(rows.map((s) => ({ code: s.code, label: s.name ? `${s.code} · ${s.name}` : s.code }))));
    this.svc.expensesFilters().pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((f) => { this.docTipoOpts.set(f.doc_tipos); this.areaOpts.set(f.areas); });
    this.load();
  }

  private params(extra: Partial<ExpensesParams> = {}): ExpensesParams {
    const [a, b] = this.rangeDates || [];
    const fmt = (d?: Date) => (d ? d.toISOString().slice(0, 10) : undefined);
    return {
      from: fmt(a), to: fmt(b),
      sucursal: this.sucursal, familia: (this.familia() || undefined) as '5' | '6' | undefined,
      doc_tipo: this.docTipo || undefined, area: this.area || undefined,
      beneficiario: this.beneficiario || undefined,
      min_importe: this.minImporte ?? undefined,
      ...extra,
    };
  }

  setStr(sig: { set: (v: string) => void }, v: string) { sig.set(v || ''); this.load(); }
  setView(v: string) { this.view.set(v as any); this.load(); }
  setGroupBy(v: string) { this.groupBy.set(v as ExpenseGroupBy); this.closeDocs(); this.load(); }

  load() {
    this.loading.set(true);
    this.svc.expenses(this.params({ group_by: this.groupBy(), compare: this.compare() }))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.report.set(r); this.loading.set(false); },
        error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar egresos' }); },
      });
    if (this.view() === 'arbol') {
      this.svc.expensesTree(this.params()).pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({ next: (t) => this.tree.set(t), error: () => {} });
    }
  }

  private toNode(n: ExpenseTreeNode, expanded = false): TreeNode {
    return {
      data: n,
      expanded,
      leaf: !n.children || n.children.length === 0,
      children: (n.children || []).map((c) => this.toNode(c, false)),
    };
  }

  /** Click en fila de tabla dinámica → drill: si es cuenta/beneficiario carga documentos. */
  drillRow(row: ExpenseRow) {
    const gb = this.groupBy();
    const extra: Partial<ExpensesParams> = {};
    if (gb === 'cuenta') extra.cuenta = row.key;
    else if (gb === 'cuenta_mayor') extra.cuenta_mayor = row.key;
    else if (gb === 'beneficiario') extra.beneficiario = row.key;
    else if (gb === 'sucursal') extra.sucursal = [row.key];
    else if (gb === 'doc_tipo') extra.doc_tipo = row.key;
    else if (gb === 'area') extra.area = row.key;
    else return; // 'mes' no drillea a doc
    this.loadDocs(extra, `${this.groupByLabel()}: ${row.label}`);
  }

  openCuenta(cuenta: string, label: string) {
    this.loadDocs({ cuenta }, `Cuenta ${cuenta} · ${label}`);
  }

  private loadDocs(extra: Partial<ExpensesParams>, title: string) {
    this.docsTitle.set(title);
    this.svc.expenseDocuments(this.params(extra)).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (d) => this.docs.set(d), error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar documentos' }) });
  }

  closeDocs() { this.docsTitle.set(''); this.docs.set([]); }

  money(v: number): string { return (v || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  pct(part: number, total: number): number { return total ? +((part / total) * 100).toFixed(1) : 0; }

  exportCsv() {
    const r = this.report();
    if (!r) return;
    const head = ['concepto', 'movs', 'importe', 'share_pct', ...(this.compare() ? ['delta_pct'] : [])];
    const lines = [head.join(',')];
    for (const row of r.rows) {
      const label = (row.label || '').replace(/"/g, '""');
      const base = [`"${label}"`, row.movs, row.total, row.share_pct];
      if (this.compare()) base.push(row.delta_pct ?? '');
      lines.push(base.join(','));
    }
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `egresos_${r.group_by}_${r.from}_${r.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
}
