import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { MultiSelectModule } from 'primeng/multiselect';
import { DatePickerModule } from 'primeng/datepicker';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { TableModule } from 'primeng/table';
import { ChartModule } from 'primeng/chart';
import { ToastModule } from 'primeng/toast';
import { DialogModule } from 'primeng/dialog';
import { MessageService } from 'primeng/api';
import {
  ComercialService,
  ExpensesReport,
  ExpenseRow,
  ExpenseDocRow,
  ExpensesParams,
  ExpenseGroupBy,
  ExpenseDocumentDetail,
} from '../comercial.service';

/**
 * GX.4 — Explorador de detalle de egresos (una superficie por "cosa").
 * Recibe un slice por query params (type=cuenta|cuenta_mayor|beneficiario|area|
 * sucursal|doc_tipo, key, label) + filtros heredados (from/to/suc) y muestra su
 * 360: KPIs, tendencia, desglose por la dimensión adecuada, y la tabla de
 * documentos con drill al documento fuente. Tiene sus PROPIOS filtros.
 */
type SliceType = 'cuenta' | 'cuenta_mayor' | 'beneficiario' | 'area' | 'sucursal' | 'doc_tipo';

@Component({
  selector: 'app-comercial-egreso-detalle',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, MultiSelectModule, DatePickerModule,
    InputNumberModule, InputTextModule, TableModule, ChartModule, ToastModule, DialogModule,
  ],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>

      <header class="surf-page-head ed-head">
        <button pButton type="button" icon="pi pi-arrow-left" label="Volver" class="p-button-text p-button-sm"
                (click)="back()"></button>
        <div class="surf-page-head-text">
          <h1>{{ title() }}</h1>
          <p class="surf-page-sub">{{ subtitle() }}</p>
        </div>
        <button pButton type="button" label="Exportar CSV" icon="pi pi-download"
                class="p-button-sm p-button-outlined" (click)="exportCsv()" [disabled]="!report()"></button>
      </header>

      <!-- Filtros propios del detalle -->
      <div class="ed-filters card-premium card-flat">
        <div class="ed-field"><label>Rango</label>
          <p-datePicker [(ngModel)]="rangeDates" selectionMode="range" dateFormat="dd/mm/yy" [showIcon]="true" appendTo="body" (onClose)="reload()" /></div>
        <div class="ed-field"><label>Sucursales</label>
          <p-multiSelect [options]="sucursales()" [(ngModel)]="sucursal" optionLabel="label" optionValue="code" placeholder="Todas" [showClear]="true" appendTo="body" styleClass="w-full" (onPanelHide)="reload()" /></div>
        <div class="ed-field"><label>Beneficiario</label>
          <input pInputText [(ngModel)]="beneficiario" placeholder="Buscar…" (keyup.enter)="reload()" (blur)="reload()" /></div>
        <div class="ed-field ed-narrow"><label>Monto ≥</label>
          <p-inputNumber [(ngModel)]="minImporte" mode="currency" currency="MXN" [min]="0" (onBlur)="reload()" /></div>
      </div>

      @if (loading()) {
        <div class="ed-empty">Cargando…</div>
      } @else {
        @if (report(); as r) {
        <!-- KPIs -->
        <div class="ed-kpis">
          <div class="ed-kpi"><span class="ed-kpi-label">Total</span><span class="ed-kpi-val">{{ money(r.total) }}</span>
            @if (r.rows.length && deltaTotal() !== null) { <span class="ed-kpi-sub" [class.up]="deltaTotal()! > 0" [class.down]="deltaTotal()! < 0">{{ deltaTotal()! > 0 ? '+' : '' }}{{ deltaTotal() }}% vs prev</span> }
          </div>
          <div class="ed-kpi"><span class="ed-kpi-label">Movimientos</span><span class="ed-kpi-val">{{ r.movimientos | number }}</span></div>
          <div class="ed-kpi"><span class="ed-kpi-label">Documentos</span><span class="ed-kpi-val">{{ docs().length | number }}{{ docs().length >= 3000 ? '+' : '' }}</span></div>
          <div class="ed-kpi"><span class="ed-kpi-label">{{ breakdownLabel() }}</span><span class="ed-kpi-val">{{ r.rows.length | number }}</span></div>
          <div class="ed-kpi"><span class="ed-kpi-label">Ticket prom.</span><span class="ed-kpi-val">{{ money(ticket()) }}</span></div>
        </div>

        <div class="ed-grid">
          <!-- Tendencia -->
          <div class="card-premium card-flat ed-card">
            <h3 class="ed-card-title">Tendencia mensual</h3>
            <p-chart type="bar" [data]="chartData()" [options]="chartOpts" height="240px"></p-chart>
          </div>

          <!-- Desglose por dimensión -->
          <div class="card-premium card-flat ed-card">
            <h3 class="ed-card-title">Por {{ breakdownLabel() }} <span class="muted">(top {{ topRows().length }})</span></h3>
            <p-table [value]="topRows()" styleClass="p-datatable-sm ed-table" [rowHover]="true" [scrollable]="true" scrollHeight="300px">
              <ng-template pTemplate="header">
                <tr><th>{{ breakdownLabel() }}</th><th class="ta-r" style="width:8rem">Importe</th><th class="ta-r" style="width:5rem">%</th></tr>
              </ng-template>
              <ng-template pTemplate="body" let-row>
                <tr class="ed-clickable" (click)="drillInto(row)">
                  <td>{{ row.label }}</td>
                  <td class="ta-r strong">{{ money(row.total) }}</td>
                  <td class="ta-r muted">{{ row.share_pct }}%</td>
                </tr>
              </ng-template>
              <ng-template pTemplate="emptymessage"><tr><td colspan="3" class="ed-empty">Sin datos.</td></tr></ng-template>
            </p-table>
          </div>
        </div>

        <!-- Documentos -->
        <div class="card-premium card-flat ed-card">
          <div class="ed-docs-head">
            <h3 class="ed-card-title">Documentos <span class="muted">({{ docs().length }}{{ docs().length >= 3000 ? '+, acotado' : '' }})</span></h3>
          </div>
          <p-table [value]="docs()" styleClass="p-datatable-sm ed-table" [rowHover]="true" [scrollable]="true" scrollHeight="480px"
                   [paginator]="docs().length > 100" [rows]="100">
            <ng-template pTemplate="header">
              <tr><th style="width:6rem">Fecha</th><th>Documento</th><th>Sucursal</th><th>Cuenta</th><th>Beneficiario</th><th class="ta-r" style="width:9rem">Importe</th><th style="width:2.5rem"></th></tr>
            </ng-template>
            <ng-template pTemplate="body" let-d>
              <tr class="ed-clickable" (click)="openDocument(d)">
                <td>{{ d.fecha | date:'dd/MM/yy' }}</td>
                <td class="mono">{{ d.doc_tipo }}-{{ d.doc_folio }}</td>
                <td>{{ d.sucursal_nombre || d.sucursal }}</td>
                <td>{{ d.cuenta_nombre || d.cuenta }}</td>
                <td>{{ d.beneficiario || '—' }}</td>
                <td class="ta-r strong">{{ money(d.importe) }}</td>
                <td class="ta-r"><i class="pi pi-angle-right muted"></i></td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage"><tr><td colspan="7" class="ed-empty">Sin documentos.</td></tr></ng-template>
          </p-table>
        </div>
        } @else {
          <div class="ed-empty">Sin información para este filtro.</div>
        }
      }

      <!-- Drill al documento fuente -->
      <p-dialog [visible]="docDetailOpen()" (visibleChange)="docDetailOpen.set($event)" [modal]="true" [dismissableMask]="true"
                appendTo="body" [style]="{ width: '54rem', maxWidth: '95vw' }" [header]="docDetailTitle()">
        @if (docDetailLoading()) {
          <div class="ed-empty">Cargando documento…</div>
        } @else {
          @if (docDetail(); as dd) {
          @if (dd.header; as h) {
            <div class="ed-dochdr-grid">
              <div><span class="ed-dl">Beneficiario</span><span class="ed-dv">{{ h.beneficiario || '—' }}</span></div>
              <div><span class="ed-dl">RFC</span><span class="ed-dv mono">{{ h.rfc || '—' }}</span></div>
              <div><span class="ed-dl">Concepto</span><span class="ed-dv">{{ h.concepto || '—' }}</span></div>
              <div><span class="ed-dl">Área</span><span class="ed-dv">{{ h.area || '—' }}</span></div>
              <div><span class="ed-dl">Fecha</span><span class="ed-dv">{{ (h.fecha_doc || h.fecha) | date:'dd/MM/yyyy' }}</span></div>
              <div><span class="ed-dl">Sucursal</span><span class="ed-dv">{{ h.sucursal_nombre || h.sucursal }}</span></div>
              <div><span class="ed-dl">Total</span><span class="ed-dv strong">{{ money(h.importe) }}</span></div>
              <div><span class="ed-dl">IVA</span><span class="ed-dv">{{ money(h.iva) }}</span></div>
            </div>
          } @else {
            <div class="ed-empty">Sin cabecera (póliza de diario/presupuesto sin factura).</div>
          }
          @if (dd.lines.length) {
            <h4 class="ed-dsec">Productos ({{ dd.lines.length }})</h4>
            <p-table [value]="dd.lines" styleClass="p-datatable-sm ed-table" [scrollable]="true" scrollHeight="280px">
              <ng-template pTemplate="header">
                <tr><th style="width:5rem">SKU</th><th>Producto</th><th class="ta-r" style="width:6rem">Cant.</th><th style="width:4rem">Pres.</th><th class="ta-r" style="width:7rem">Costo u.</th><th class="ta-r" style="width:8rem">Importe</th></tr>
              </ng-template>
              <ng-template pTemplate="body" let-l>
                <tr>
                  <td class="mono">{{ l.sku || '—' }}</td><td>{{ l.producto || '—' }}</td>
                  <td class="ta-r">{{ l.cantidad != null ? (l.cantidad | number:'1.0-0') : '—' }}</td>
                  <td class="muted">{{ l.presentacion || '—' }}</td>
                  <td class="ta-r">{{ l.costo_unitario != null ? money(l.costo_unitario) : '—' }}</td>
                  <td class="ta-r strong">{{ money(l.importe) }}</td>
                </tr>
              </ng-template>
            </p-table>
          } @else {
            <p class="muted">Sin desglose de producto (típico de gastos).</p>
          }
          @if (dd.postings.length) {
            <h4 class="ed-dsec">Posturas contables ({{ dd.postings.length }})</h4>
            <p-table [value]="dd.postings" styleClass="p-datatable-sm ed-table">
              <ng-template pTemplate="header"><tr><th style="width:3rem">#</th><th>Cuenta</th><th class="ta-r" style="width:9rem">Importe</th></tr></ng-template>
              <ng-template pTemplate="body" let-p>
                <tr><td class="muted">{{ p.linea }}</td><td><span class="mono">{{ p.cuenta }}</span> <span class="muted">{{ p.cuenta_nombre || '' }}</span></td><td class="ta-r strong">{{ money(p.importe) }}</td></tr>
              </ng-template>
            </p-table>
          }
          } @else {
            <div class="ed-empty">No se encontró el documento.</div>
          }
        }
      </p-dialog>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .ed-head { display: flex; align-items: center; gap: 1rem; }
    .ed-filters { display: flex; flex-wrap: wrap; gap: .9rem; align-items: flex-end; margin-bottom: 1rem; padding: 1rem; }
    .ed-field { display: flex; flex-direction: column; gap: .35rem; }
    .ed-field label { font-size: .72rem; font-weight: 600; color: var(--text-muted, #78716c); text-transform: uppercase; letter-spacing: .03em; }
    .ed-narrow { max-width: 10rem; }
    .ed-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: .75rem; margin-bottom: 1rem; }
    .ed-kpi { border: 1px solid var(--border, #e7e5e4); border-radius: var(--radius-md, 10px); padding: .85rem 1rem; background: var(--card-bg, #fff); }
    .ed-kpi-label { display: block; font-size: .72rem; font-weight: 600; color: var(--text-muted, #78716c); text-transform: uppercase; letter-spacing: .03em; }
    .ed-kpi-val { display: block; font-size: 1.35rem; font-weight: 700; margin-top: .15rem; }
    .ed-kpi-sub { display: block; font-size: .74rem; margin-top: .1rem; color: var(--text-muted, #78716c); }
    .ed-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1rem; }
    @media (max-width: 900px) { .ed-grid { grid-template-columns: 1fr; } }
    .ed-card { padding: 1rem; }
    .ed-card-title { margin: 0 0 .6rem; font-size: .85rem; font-weight: 700; }
    .ed-docs-head { display: flex; align-items: center; gap: 1rem; margin-bottom: .5rem; }
    .ed-table { font-variant-numeric: tabular-nums; }
    .ta-r { text-align: right; }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .85em; }
    .strong { font-weight: 700; }
    .muted { color: var(--text-muted, #78716c); }
    .up { color: var(--bad-fg); font-weight: 600; }
    .down { color: var(--ok-fg); font-weight: 600; }
    .ed-clickable { cursor: pointer; }
    .ed-empty { padding: 2rem; text-align: center; color: var(--text-muted, #78716c); }
    .ed-dochdr-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: .75rem 1.25rem; margin-bottom: 1rem; }
    .ed-dochdr-grid > div { display: flex; flex-direction: column; gap: .15rem; }
    .ed-dl { font-size: .68rem; font-weight: 600; color: var(--text-muted, #78716c); text-transform: uppercase; letter-spacing: .03em; }
    .ed-dv { font-size: .92rem; }
    .ed-dsec { margin: 1.1rem 0 .5rem; font-size: .8rem; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted, #78716c); }
  `],
})
export class ComercialEgresoDetalleComponent {
  private readonly svc = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly report = signal<ExpensesReport | null>(null);
  readonly docs = signal<ExpenseDocRow[]>([]);
  readonly loading = signal(false);
  readonly sucursales = signal<{ code: string; label: string }[]>([]);
  readonly docDetail = signal<ExpenseDocumentDetail | null>(null);
  readonly docDetailOpen = signal(false);
  readonly docDetailLoading = signal(false);
  readonly docDetailTitle = signal('');

  // slice actual (del query param)
  private sliceType: SliceType = 'cuenta';
  private sliceKey = '';
  private sliceLabel = '';

  // filtros propios
  sucursal: string[] = [];
  beneficiario = '';
  minImporte: number | null = null;
  rangeDates: Date[] = [(() => { const d = new Date(); d.setDate(d.getDate() - 90); return d; })(), new Date()];

  readonly title = computed(() => this.sliceLabel || this.sliceKey || 'Detalle de egresos');
  readonly subtitle = computed(() => {
    const map: Record<SliceType, string> = {
      cuenta: 'Cuenta contable', cuenta_mayor: 'Cuenta mayor', beneficiario: 'Beneficiario / proveedor',
      area: 'Área / departamento', sucursal: 'Sucursal', doc_tipo: 'Tipo de documento',
    };
    return `${map[this.sliceType]} · ${this.sliceKey}`;
  });
  readonly breakdownDim = computed<ExpenseGroupBy>(() => {
    switch (this.sliceType) {
      case 'cuenta': case 'cuenta_mayor': return 'beneficiario';
      case 'beneficiario': case 'area': return 'cuenta';
      case 'sucursal': case 'doc_tipo': return 'cuenta_mayor';
      default: return 'cuenta';
    }
  });
  readonly breakdownLabel = computed(() => {
    const m: Record<string, string> = { beneficiario: 'Beneficiario', cuenta: 'Cuenta', cuenta_mayor: 'Cuenta mayor' };
    return m[this.breakdownDim()] || 'Desglose';
  });
  readonly topRows = computed(() => (this.report()?.rows || []).slice(0, 50));
  readonly ticket = computed(() => { const n = this.docs().length; return n ? (this.report()?.total || 0) / n : 0; });
  readonly deltaTotal = computed(() => {
    const rows = this.report()?.rows || [];
    const t = this.report()?.total || 0;
    const prev = rows.reduce((a, r) => a + (r.prev_total || 0), 0);
    return prev ? +(((t - prev) / prev) * 100).toFixed(1) : null;
  });
  readonly chartData = computed(() => {
    const s = this.report()?.series || [];
    return {
      labels: s.map((p) => p.mes),
      datasets: [
        { label: 'Compras / Costo', data: s.map((p) => p.compras), backgroundColor: '#FB923C' },
        { label: 'Gastos', data: s.map((p) => p.gastos), backgroundColor: '#60A5FA' },
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
    this.route.queryParams.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((q) => {
      this.sliceType = (q['type'] as SliceType) || 'cuenta';
      this.sliceKey = q['key'] || '';
      this.sliceLabel = q['label'] || '';
      if (q['from'] && q['to']) this.rangeDates = [new Date(q['from'] + 'T00:00:00'), new Date(q['to'] + 'T00:00:00')];
      if (q['suc']) this.sucursal = String(q['suc']).split(',').filter(Boolean);
      this.reload();
    });
  }

  private sliceFilter(): Partial<ExpensesParams> {
    switch (this.sliceType) {
      case 'cuenta': return { cuenta: this.sliceKey };
      case 'cuenta_mayor': return { cuenta_mayor: this.sliceKey };
      case 'beneficiario': return this.sliceKey === '(sin beneficiario)' ? { beneficiario_null: true } : { beneficiario_eq: this.sliceKey };
      case 'area': return this.sliceKey === '(sin área)' ? { area_null: true } : { area: this.sliceKey };
      case 'sucursal': return { sucursal: [this.sliceKey] };
      case 'doc_tipo': return { doc_tipo: this.sliceKey };
      default: return {};
    }
  }

  private params(extra: Partial<ExpensesParams> = {}): ExpensesParams {
    const [a, b] = this.rangeDates || [];
    const fmt = (d?: Date) => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : undefined;
    return {
      from: fmt(a), to: fmt(b),
      sucursal: this.sucursal?.length ? this.sucursal : undefined,
      beneficiario: this.beneficiario || undefined,
      min_importe: this.minImporte ?? undefined,
      ...this.sliceFilter(),
      ...extra,
    };
  }

  private repSub?: Subscription;
  private docsSub?: Subscription;

  reload() {
    if (!this.sliceKey) { this.report.set(null); return; }
    this.loading.set(true);
    this.repSub?.unsubscribe();
    this.repSub = this.svc.expenses(this.params({ group_by: this.breakdownDim(), compare: true }))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.report.set(r); this.loading.set(false); },
        error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar el detalle' }); },
      });
    this.docsSub?.unsubscribe();
    this.docsSub = this.svc.expenseDocuments(this.params()).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (d) => this.docs.set(d), error: () => {} });
  }

  /** Pivotar a la entidad del renglón de desglose (drill encadenado). */
  drillInto(row: ExpenseRow) {
    const type = this.breakdownDim();
    const [a, b] = this.rangeDates || [];
    const fmt = (d?: Date) => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : undefined;
    this.router.navigate([], {
      queryParams: { type, key: row.key, label: row.label, from: fmt(a), to: fmt(b), suc: this.sucursal.join(',') || null },
      queryParamsHandling: 'replace',
    });
  }

  back() { this.router.navigate(['/comercial/egresos']); }

  private docDetailSub?: Subscription;
  openDocument(d: ExpenseDocRow) {
    if (!d?.sucursal || !d.doc_tipo || !d.doc_folio) return;
    this.docDetailTitle.set(`${d.doc_tipo}-${d.doc_folio}`);
    this.docDetail.set(null);
    this.docDetailOpen.set(true);
    this.docDetailLoading.set(true);
    this.docDetailSub?.unsubscribe();
    this.docDetailSub = this.svc.expenseDocument(d.sucursal, d.doc_tipo, d.doc_folio)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (dd) => { this.docDetail.set(dd); this.docDetailLoading.set(false); },
        error: () => { this.docDetailLoading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar el documento' }); },
      });
  }

  money(v: number): string { return (v || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }

  exportCsv() {
    const r = this.report();
    if (!r) return;
    const lines = ['label,importe,share_pct'];
    for (const row of r.rows) lines.push(`"${(row.label || '').replace(/"/g, '""')}",${row.total},${row.share_pct}`);
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `egreso_${this.sliceType}_${this.sliceKey}.csv`; link.click();
    URL.revokeObjectURL(url);
  }
}
