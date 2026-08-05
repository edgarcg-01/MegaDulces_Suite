import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { DialogModule } from 'primeng/dialog';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { ComprasService, Compras360Row, Compras360Response, AdjustmentForEntradaRow } from '../compras.service';

/**
 * CXP.3 — "Compras 360": el Excel de recepciones en una interfaz. Una fila por orden
 * de entrada / factura de Kepler con su OC, la factura, el ajuste ligado exacto
 * (devoluciones/notas confirmadas) y el neto. El detalle abre los ajustes que explican
 * el descuadre (exacto o proveedor+fecha). Read-only sobre analytics.*. Operations mode.
 */
@Component({
  selector: 'app-compras-compras360',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ButtonModule, InputTextModule, DialogModule, MetricStripComponent],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Compras 360</h1>
          <p class="surf-page-sub">Todas las órdenes de entrada y facturas de compra en una vista, con su OC, ajustes (devoluciones/notas ligadas) y neto. El "Excel" de recepción, vivo y filtrable.</p>
        </div>
        <div class="c3-head-actions">
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="exporting()" (click)="exportCsv()"><span class="p-button-icon p-button-icon-left pi pi-download" aria-hidden="true"></span><span class="p-button-label">Exportar CSV</span></button>
        </div>
      </header>

      <div class="c3-filters">
        <span class="p-input-icon-left c3-search">
          <i class="pi pi-search" aria-hidden="true"></i>
          <input pInputText type="text" placeholder="Proveedor, OC o folio…" [ngModel]="search()" (ngModelChange)="onSearch($event)" class="p-inputtext-sm" />
        </span>
        <input pInputText type="date" [ngModel]="dateFrom()" (ngModelChange)="dateFrom.set($event); reload()" class="p-inputtext-sm" aria-label="Desde" />
        <input pInputText type="date" [ngModel]="dateTo()" (ngModelChange)="dateTo.set($event); reload()" class="p-inputtext-sm" aria-label="Hasta" />
        <label class="c3-chk"><input type="checkbox" [ngModel]="conAjuste()" (ngModelChange)="conAjuste.set($event); reload()" /> Solo con ajuste</label>
      </div>

      @if (data(); as d) {
        <app-metric-strip [items]="kpiItems(d)" ariaLabel="Totales de compras" />

        <div class="c3-tablewrap">
          <table class="c3-table">
            <thead>
              <tr>
                <th>Fecha</th><th>Suc.</th><th>Proveedor</th><th>OC</th><th>Folio</th>
                <th class="ta-r">Factura</th><th class="ta-r">Ajuste</th><th class="ta-r">Neto</th>
              </tr>
            </thead>
            <tbody>
              @for (r of d.rows; track r.sucursal + r.folio) {
                <tr (click)="openDetail(r)" class="c3-row" [class.has-adj]="r.ajuste !== 0">
                  <td class="c3-mono">{{ r.receipt_date ? r.receipt_date.slice(0,10) : '—' }}</td>
                  <td class="c3-mono">{{ r.sucursal }}</td>
                  <td class="c3-prov" [title]="r.proveedor_nombre">{{ r.proveedor_nombre || r.proveedor_code || '—' }}</td>
                  <td class="c3-mono muted">{{ r.oc_folio || '—' }}</td>
                  <td class="c3-mono muted">{{ r.folio }}</td>
                  <td class="ta-r c3-num">{{ money(r.factura) }}</td>
                  <td class="ta-r c3-num" [class.c3-neg]="r.ajuste !== 0">{{ r.ajuste ? '−' + money(r.ajuste) : '—' }}</td>
                  <td class="ta-r c3-num c3-strong">{{ money(r.neto) }}</td>
                </tr>
              } @empty {
                <tr><td colspan="8" class="c3-empty">Sin recepciones con esos filtros.</td></tr>
              }
            </tbody>
          </table>
        </div>

        <div class="c3-pager">
          <span class="muted">{{ d.total | number }} recepción(es) · página {{ d.page }}</span>
          <span class="c3-pager-btns">
            <button pButton type="button" class="p-button-sm p-button-text" [disabled]="d.page <= 1" (click)="goPage(d.page - 1)"><span class="pi pi-chevron-left"></span></button>
            <button pButton type="button" class="p-button-sm p-button-text" [disabled]="d.page * d.pageSize >= d.total" (click)="goPage(d.page + 1)"><span class="pi pi-chevron-right"></span></button>
          </span>
        </div>
      } @else if (loading()) {
        <p class="c3-empty" style="margin-top:1.2rem">Cargando…</p>
      }
    </div>

    <p-dialog [visible]="!!detail()" (visibleChange)="!$event && closeDetail()" [modal]="true" [dismissableMask]="true" [style]="{ width: '640px', maxWidth: '95vw' }" [header]="detailHeader()">
      @if (detail(); as r) {
        <div class="c3-dt">
          <div class="c3-dt-grid">
            <div><span class="c3-dt-l">Proveedor</span><span class="c3-dt-v">{{ r.proveedor_nombre || r.proveedor_code }}</span></div>
            <div><span class="c3-dt-l">OC</span><span class="c3-dt-v c3-mono">{{ r.oc_folio || '—' }}</span></div>
            <div><span class="c3-dt-l">Vale</span><span class="c3-dt-v c3-mono">{{ r.vale_folio || '—' }}</span></div>
            <div><span class="c3-dt-l">Factura</span><span class="c3-dt-v c3-num">{{ money(r.factura) }}</span></div>
            <div><span class="c3-dt-l">Ajuste (exacto)</span><span class="c3-dt-v c3-num">{{ r.ajuste ? '−' + money(r.ajuste) : '—' }}</span></div>
            <div><span class="c3-dt-l">Neto</span><span class="c3-dt-v c3-num c3-strong">{{ money(r.neto) }}</span></div>
          </div>

          <h4 class="c3-dt-h">Ajustes que explican el descuadre</h4>
          @if (explainsLoading()) {
            <p class="c3-empty">Cargando ajustes…</p>
          } @else if (explains().length === 0) {
            <p class="c3-empty">Sin ajustes ligados a esta recepción.</p>
          } @else {
            <table class="c3-table c3-dt-table">
              <thead><tr><th>Fecha</th><th>Tipo</th><th>Motivo</th><th class="ta-r">Monto</th><th>Match</th></tr></thead>
              <tbody>
                @for (a of explains(); track a.folio) {
                  <tr>
                    <td class="c3-mono">{{ a.adjustment_date ? a.adjustment_date.slice(0,10) : '—' }}</td>
                    <td class="c3-mono">{{ a.doctype }}</td>
                    <td [title]="a.motivo">{{ a.categoria || a.motivo || '—' }}</td>
                    <td class="ta-r c3-num">{{ money(a.monto) }}</td>
                    <td><span class="c3-match" [class.exact]="a.match === 'exacto'">{{ a.match }}</span></td>
                  </tr>
                }
              </tbody>
            </table>
            <p class="c3-dt-note">Total ajustes ligados: <b>{{ money(explainsTotal()) }}</b>. Los match "proveedor+fecha" son heurísticos (Kepler no liga la nota a la entrada) — revisar.</p>
          }
        </div>
      }
    </p-dialog>
  `,
  styles: [`
    :host { display:block; }
    .c3-head-actions { display:flex; gap:.5rem; }
    .c3-filters { display:flex; flex-wrap:wrap; gap:.6rem; align-items:center; margin:1rem 0 .4rem; }
    .c3-search input { min-width:230px; }
    .c3-chk { display:inline-flex; align-items:center; gap:.4rem; font-size:.8rem; color:var(--text-muted); cursor:pointer; }
    .c3-tablewrap { overflow-x:auto; margin-top:1.2rem; border:1px solid var(--border-color); border-radius:var(--radius-md,8px); }
    .c3-table { width:100%; border-collapse:collapse; font-size:.82rem; }
    .c3-table thead th { text-align:left; font-size:.68rem; font-weight:600; text-transform:uppercase; letter-spacing:.05em; color:var(--text-muted); padding:.55rem .7rem; border-bottom:1px solid var(--border-color); background:var(--surface-hover-bg,transparent); white-space:nowrap; }
    .c3-table tbody td { padding:.5rem .7rem; border-bottom:1px solid var(--border-color); color:var(--text-main); }
    .c3-table tbody tr:last-child td { border-bottom:none; }
    .c3-row { cursor:pointer; }
    .c3-row:hover td { background:var(--overlay-hover,color-mix(in srgb,var(--border-color) 25%,transparent)); }
    .ta-r { text-align:right; }
    .c3-mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .c3-num { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .c3-strong { font-weight:700; }
    .c3-neg { color:var(--bad-fg); }
    .c3-prov { max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .muted { color:var(--text-faint); }
    .c3-empty { padding:1.4rem; text-align:center; color:var(--text-faint); font-size:.85rem; }
    .c3-pager { display:flex; align-items:center; justify-content:space-between; margin-top:.7rem; font-size:.78rem; }
    .c3-pager-btns { display:flex; gap:.2rem; }
    /* detalle */
    .c3-dt-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:.8rem 1rem; margin-bottom:1rem; }
    .c3-dt-grid > div { display:flex; flex-direction:column; gap:.15rem; }
    .c3-dt-l { font-size:.66rem; text-transform:uppercase; letter-spacing:.04em; color:var(--text-faint); }
    .c3-dt-v { font-size:.9rem; color:var(--text-main); }
    .c3-dt-h { font-size:.82rem; font-weight:700; margin:.4rem 0 .5rem; color:var(--text-main); }
    .c3-dt-table { font-size:.78rem; }
    .c3-dt-note { font-size:.72rem; color:var(--text-faint); margin-top:.6rem; line-height:1.5; }
    .c3-match { font-size:.66rem; padding:.05rem .35rem; border-radius:4px; background:var(--warn-soft-bg); color:var(--warn-fg); }
    .c3-match.exact { background:var(--ok-soft-bg,var(--bad-soft-bg)); color:var(--ok-fg); }
    @media (max-width:560px) { .c3-dt-grid { grid-template-columns:repeat(2,1fr); } }
  `],
})
export class ComprasCompras360Component implements OnInit {
  private readonly svc = inject(ComprasService);
  readonly data = signal<Compras360Response | null>(null);
  readonly loading = signal(false);
  readonly exporting = signal(false);
  readonly search = signal('');
  readonly dateFrom = signal('');
  readonly dateTo = signal('');
  readonly conAjuste = signal(false);
  private page = 1;
  private searchTimer: any;

  readonly detail = signal<Compras360Row | null>(null);
  readonly explains = signal<AdjustmentForEntradaRow[]>([]);
  readonly explainsLoading = signal(false);
  readonly explainsTotal = signal(0);
  readonly detailHeader = computed(() => { const r = this.detail(); return r ? `Entrada ${r.folio}` : ''; });

  ngOnInit(): void { this.reload(); }

  private query(all = false) {
    return { search: this.search() || undefined, date_from: this.dateFrom() || undefined, date_to: this.dateTo() || undefined, con_ajuste: this.conAjuste(), page: this.page, all };
  }

  reload(): void {
    this.loading.set(true);
    this.svc.compras360(this.query()).subscribe({
      next: (d) => { this.data.set(d); this.loading.set(false); },
      error: () => { this.loading.set(false); },
    });
  }

  onSearch(v: string): void {
    this.search.set(v);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => { this.page = 1; this.reload(); }, 320);
  }

  goPage(p: number): void { this.page = Math.max(1, p); this.reload(); }

  openDetail(r: Compras360Row): void {
    this.detail.set(r);
    this.explains.set([]); this.explainsTotal.set(0); this.explainsLoading.set(true);
    this.svc.adjustmentsForEntrada({ proveedor_code: r.proveedor_code, entrada_folio: r.folio, date: r.receipt_date?.slice(0, 10), window_days: 15 }).subscribe({
      next: (res) => { this.explains.set(res.rows || []); this.explainsTotal.set(res.total_monto || 0); this.explainsLoading.set(false); },
      error: () => { this.explainsLoading.set(false); },
    });
  }
  closeDetail(): void { this.detail.set(null); }

  exportCsv(): void {
    this.exporting.set(true);
    this.svc.compras360(this.query(true)).subscribe({
      next: (d) => {
        const head = ['Fecha', 'Sucursal', 'Proveedor', 'Codigo', 'OC', 'Folio', 'Factura', 'Ajuste', 'Neto'];
        const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const lines = [head.join(',')].concat(d.rows.map((r) => [r.receipt_date?.slice(0, 10) || '', r.sucursal, r.proveedor_nombre || '', r.proveedor_code || '', r.oc_folio || '', r.folio, r.factura, r.ajuste, r.neto].map(esc).join(',')));
        const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'compras-360.csv'; a.click(); URL.revokeObjectURL(a.href);
        this.exporting.set(false);
      },
      error: () => this.exporting.set(false),
    });
  }

  kpiItems(d: Compras360Response): MetricStripItem[] {
    return [
      { label: 'Recepciones', value: d.total, format: 'number', tone: 'default' },
      { label: 'Factura total', value: d.totals.factura, format: 'currency-short', tone: 'default' },
      { label: 'Ajustes ligados', value: d.totals.ajuste, format: 'currency-short', tone: 'warn' },
      { label: 'Neto', value: d.totals.neto, format: 'currency-short', tone: 'brand' },
    ];
  }

  money(n: number): string { return Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
}
