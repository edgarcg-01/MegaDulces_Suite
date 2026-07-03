import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { MultiSelectModule } from 'primeng/multiselect';
import { DatePickerModule } from 'primeng/datepicker';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import {
  ComercialService,
  ExpensesReport,
  ExpenseCuentaRow,
} from '../comercial.service';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { REPORTS_TABS } from '../reports-tabs';

/**
 * GX — Egresos contables (pólizas de gastos + compras). Agrupa por cuenta
 * contable (categoría) con drill-down a beneficiario + documentos. Fuente:
 * analytics.expense_entries (feed Kepler kdc2YYMM).
 */
@Component({
  selector: 'app-comercial-egresos',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, MultiSelectModule, DatePickerModule,
    TableModule, ToastModule, PageTabsComponent, SegmentedComponent,
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
          <p class="surf-page-sub">Pólizas de gastos (6xx) y compras (5xx) por cuenta contable · fuente Kepler</p>
        </div>
        <button pButton type="button" label="Exportar CSV" icon="pi pi-download"
                class="p-button-sm p-button-outlined" (click)="exportCsv()" [disabled]="!report()"></button>
      </header>

      <!-- Filtros -->
      <div class="ex-filters card-premium card-flat">
        <div class="ex-field">
          <label>Rango</label>
          <p-datePicker [(ngModel)]="rangeDates" selectionMode="range" dateFormat="dd/mm/yy"
                        [showIcon]="true" appendTo="body" (onClose)="load()" />
        </div>
        <div class="ex-field">
          <label>Sucursales</label>
          <p-multiSelect [options]="sucursales()" [(ngModel)]="sucursal" optionLabel="label" optionValue="code"
                         placeholder="Todas" [showClear]="true" appendTo="body" styleClass="w-full"
                         (onPanelHide)="load()" />
        </div>
        <div class="ex-field">
          <label>Tipo</label>
          <app-segmented [options]="familiaOpts" [value]="familia()" (valueChange)="setFamilia($event)" ariaLabel="Tipo de egreso" />
        </div>
      </div>

      @if (loading()) {
        <div class="ex-empty">Cargando…</div>
      } @else if (report()) {
        @if (report(); as r) {
        <!-- KPIs -->
        <div class="ex-kpis">
          <div class="ex-kpi">
            <span class="ex-kpi-label">Egreso total</span>
            <span class="ex-kpi-val">{{ money(r.total) }}</span>
            <span class="ex-kpi-sub">{{ r.movimientos | number }} movimientos · {{ r.from }} → {{ r.to }}</span>
          </div>
          @for (f of r.by_familia; track f.familia) {
            <div class="ex-kpi">
              <span class="ex-kpi-label">{{ f.label }}</span>
              <span class="ex-kpi-val">{{ money(f.total) }}</span>
              <span class="ex-kpi-sub">{{ f.movs | number }} movs · {{ pct(f.total, r.total) }}%</span>
            </div>
          }
        </div>

        @if (!drill()) {
          <!-- Nivel: por cuenta contable (categoría) -->
          <p-table [value]="r.by_cuenta" [scrollable]="true" scrollHeight="flex" styleClass="p-datatable-sm ex-table"
                   [rowHover]="true" [paginator]="r.by_cuenta.length > 40" [rows]="40"
                   sortField="total" [sortOrder]="-1">
            <ng-template pTemplate="header">
              <tr>
                <th style="width:5rem" pSortableColumn="familia">Tipo</th>
                <th pSortableColumn="cuenta">Cuenta</th>
                <th pSortableColumn="cuenta_nombre">Categoría</th>
                <th class="ta-r" style="width:7rem" pSortableColumn="movs">Movs</th>
                <th class="ta-r" style="width:11rem" pSortableColumn="total">Importe</th>
                <th class="ta-r" style="width:7rem" pSortableColumn="share_pct">%</th>
                <th style="width:3rem"></th>
              </tr>
            </ng-template>
            <ng-template pTemplate="body" let-row>
              <tr class="ex-row" (click)="openCuenta(row)">
                <td><span class="ex-tag" [class.fam5]="row.familia === '5'" [class.fam6]="row.familia === '6'">{{ row.familia === '5' ? 'Compra' : 'Gasto' }}</span></td>
                <td class="mono">{{ row.cuenta }}</td>
                <td>{{ row.cuenta_nombre || '—' }}</td>
                <td class="ta-r">{{ row.movs | number }}</td>
                <td class="ta-r strong">{{ money(row.total) }}</td>
                <td class="ta-r muted">{{ row.share_pct }}%</td>
                <td class="ta-r"><i class="pi pi-angle-right muted"></i></td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage">
              <tr><td colspan="7" class="ex-empty">Sin egresos en el período.</td></tr>
            </ng-template>
          </p-table>
        } @else {
          <!-- Drill: beneficiarios + documentos de la cuenta -->
          <div class="ex-drill-head">
            <button pButton type="button" icon="pi pi-arrow-left" label="Volver" class="p-button-text p-button-sm" (click)="closeCuenta()"></button>
            <span class="ex-drill-title"><span class="mono">{{ selectedCuenta()?.cuenta }}</span> {{ selectedCuenta()?.cuenta_nombre || '' }}</span>
            <span class="ex-drill-total">{{ money(selectedCuenta()?.total || 0) }}</span>
          </div>

          <div class="ex-drill-grid">
            <div>
              <h3 class="ex-h3">Por beneficiario</h3>
              <p-table [value]="drill()!.by_beneficiario" styleClass="p-datatable-sm ex-table" [rowHover]="true"
                       [paginator]="drill()!.by_beneficiario.length > 25" [rows]="25">
                <ng-template pTemplate="header">
                  <tr><th>Beneficiario</th><th class="ta-r" style="width:6rem">Movs</th><th class="ta-r" style="width:10rem">Importe</th></tr>
                </ng-template>
                <ng-template pTemplate="body" let-b>
                  <tr><td>{{ b.beneficiario }}</td><td class="ta-r">{{ b.movs | number }}</td><td class="ta-r strong">{{ money(b.total) }}</td></tr>
                </ng-template>
              </p-table>
            </div>
            <div>
              <h3 class="ex-h3">Documentos</h3>
              <p-table [value]="drill()!.items" styleClass="p-datatable-sm ex-table" [rowHover]="true"
                       [scrollable]="true" scrollHeight="480px" [paginator]="drill()!.items.length > 100" [rows]="100">
                <ng-template pTemplate="header">
                  <tr><th style="width:6rem">Fecha</th><th>Documento</th><th>Sucursal</th><th>Beneficiario</th><th class="ta-r" style="width:9rem">Importe</th></tr>
                </ng-template>
                <ng-template pTemplate="body" let-it>
                  <tr>
                    <td>{{ it.fecha | date:'dd/MM/yy' }}</td>
                    <td class="mono">{{ it.doc_tipo }}-{{ it.doc_folio }}</td>
                    <td>{{ it.sucursal_nombre || it.sucursal }}</td>
                    <td>{{ it.beneficiario || '—' }}</td>
                    <td class="ta-r strong">{{ money(it.importe) }}</td>
                  </tr>
                </ng-template>
              </p-table>
            </div>
          </div>
        }
        }
      } @else {
        <div class="ex-empty">Sin datos.</div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .ex-filters { display: flex; flex-wrap: wrap; gap: 1rem; align-items: flex-end; margin-bottom: 1rem; padding: 1rem; }
    .ex-field { display: flex; flex-direction: column; gap: .35rem; }
    .ex-field label { font-size: .72rem; font-weight: 600; color: var(--text-muted, #78716c); text-transform: uppercase; letter-spacing: .03em; }
    .ex-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: .75rem; margin-bottom: 1rem; }
    .ex-kpi { border: 1px solid var(--border, #e7e5e4); border-radius: var(--radius-md, 10px); padding: .85rem 1rem; background: var(--card-bg, #fff); }
    .ex-kpi-label { display: block; font-size: .72rem; font-weight: 600; color: var(--text-muted, #78716c); text-transform: uppercase; letter-spacing: .03em; }
    .ex-kpi-val { display: block; font-size: 1.4rem; font-weight: 700; margin-top: .15rem; }
    .ex-kpi-sub { display: block; font-size: .74rem; color: var(--text-muted, #78716c); margin-top: .1rem; }
    .ex-table { font-variant-numeric: tabular-nums; }
    .ta-r { text-align: right; }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .85em; }
    .strong { font-weight: 700; }
    .muted { color: var(--text-muted, #78716c); }
    .ex-row { cursor: pointer; }
    .ex-tag { display: inline-block; font-size: .7rem; font-weight: 600; padding: .1rem .45rem; border-radius: 999px; border: 1px solid var(--border, #e7e5e4); color: var(--text-muted, #78716c); }
    .ex-tag.fam5 { color: #9a3412; border-color: #fed7aa; background: #fff7ed; }
    .ex-tag.fam6 { color: #3730a3; border-color: #c7d2fe; background: #eef2ff; }
    .ex-empty { padding: 2rem; text-align: center; color: var(--text-muted, #78716c); }
    .ex-drill-head { display: flex; align-items: center; gap: 1rem; margin-bottom: .75rem; }
    .ex-drill-title { font-weight: 600; }
    .ex-drill-total { margin-left: auto; font-weight: 700; font-size: 1.1rem; }
    .ex-drill-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); gap: 1.25rem; }
    .ex-h3 { font-size: .8rem; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted, #78716c); margin: 0 0 .5rem; }
    @media (max-width: 900px) { .ex-drill-grid { grid-template-columns: 1fr; } }
  `],
})
export class ComercialEgresosComponent {
  private readonly svc = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly reportTabs = REPORTS_TABS;
  readonly familiaOpts = [
    { label: 'Todo', value: '' },
    { label: 'Compras', value: '5' },
    { label: 'Gastos', value: '6' },
  ];

  readonly report = signal<ExpensesReport | null>(null);
  readonly drill = signal<ExpensesReport | null>(null);
  readonly selectedCuenta = signal<ExpenseCuentaRow | null>(null);
  readonly loading = signal(false);
  readonly sucursales = signal<{ code: string; label: string }[]>([]);

  readonly familia = signal<'' | '5' | '6'>('');
  sucursal: string[] = [];
  rangeDates: Date[] = [(() => { const d = new Date(); d.setDate(d.getDate() - 90); return d; })(), new Date()];

  constructor() {
    this.svc.expensesSucursales()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((rows) => this.sucursales.set(
        rows.map((s) => ({ code: s.code, label: s.name ? `${s.code} · ${s.name}` : s.code })),
      ));
    this.load();
  }

  setFamilia(v: string) {
    this.familia.set((v as '' | '5' | '6') || '');
    this.load();
  }

  private range(): { from?: string; to?: string } {
    const [a, b] = this.rangeDates || [];
    const fmt = (d?: Date) => (d ? d.toISOString().slice(0, 10) : undefined);
    return { from: fmt(a), to: fmt(b) };
  }

  load() {
    this.loading.set(true);
    this.drill.set(null);
    this.selectedCuenta.set(null);
    const { from, to } = this.range();
    this.svc.expenses({ from, to, sucursal: this.sucursal, familia: this.familia() || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.report.set(r); this.loading.set(false); },
        error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar egresos' }); },
      });
  }

  openCuenta(row: ExpenseCuentaRow) {
    this.selectedCuenta.set(row);
    const { from, to } = this.range();
    this.svc.expenses({ from, to, sucursal: this.sucursal, familia: this.familia() || undefined, cuenta: row.cuenta })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => this.drill.set(r),
        error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar el detalle' }),
      });
  }

  closeCuenta() { this.drill.set(null); this.selectedCuenta.set(null); }

  money(v: number): string {
    return (v || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  }
  pct(part: number, total: number): number {
    return total ? +((part / total) * 100).toFixed(1) : 0;
  }

  exportCsv() {
    const r = this.report();
    if (!r) return;
    const rows: string[] = ['tipo,cuenta,categoria,movimientos,importe,share_pct'];
    for (const c of r.by_cuenta) {
      const cat = (c.cuenta_nombre || '').replace(/"/g, '""');
      rows.push(`${c.familia === '5' ? 'Compra' : 'Gasto'},${c.cuenta},"${cat}",${c.movs},${c.total},${c.share_pct}`);
    }
    const blob = new Blob(['﻿' + rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `egresos_${r.from}_${r.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
}
