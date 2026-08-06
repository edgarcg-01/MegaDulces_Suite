import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { DatePickerModule } from 'primeng/datepicker';
import { CheckboxModule } from 'primeng/checkbox';
import { DialogModule } from 'primeng/dialog';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { makeLazyLoad } from '../../../shared/util';
import { ComprasService, Compras360Row, Compras360Response, AdjustmentForEntradaRow } from '../compras.service';

/**
 * CXP.3 — "Compras 360": el Excel de recepciones en una interfaz. Una fila por orden
 * de entrada / factura de Kepler (XA2001) con su OC, la factura, el ajuste ligado exacto
 * (devoluciones X-D-40 / notas X-D-55 confirmadas) y el neto. El detalle abre los ajustes
 * que explican el descuadre (exacto o proveedor+fecha heurístico) y navega a Descuentos.
 * Read-only sobre analytics.*. Operations mode, PrimeNG-first (p-table lazy server-paginado).
 */
@Component({
  selector: 'app-compras-compras360',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule, FormsModule, ButtonModule, InputTextModule, IconFieldModule, InputIconModule,
    TableModule, TagModule, DatePickerModule, CheckboxModule, DialogModule, MetricStripComponent, ContextHelpComponent,
  ],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1 style="display:inline-flex;align-items:center;gap:.4rem">Compras 360 <app-context-help topic="compras-360" /></h1>
          <p class="surf-page-sub">Todas las órdenes de entrada y facturas de compra en una vista, con su OC, ajustes (devoluciones/notas ligadas) y neto. El "Excel" de recepción, vivo y filtrable.</p>
        </div>
        <div class="c3-head-actions">
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="exporting()" (click)="exportCsv()"><span class="p-button-icon p-button-icon-left pi pi-download" aria-hidden="true"></span><span class="p-button-label">Exportar CSV</span></button>
        </div>
      </header>

      <div class="c3-filters">
        <p-iconfield styleClass="c3-search">
          <p-inputicon styleClass="pi pi-search" />
          <input pInputText type="text" placeholder="Proveedor, OC o folio…" [ngModel]="search()" (ngModelChange)="onSearch($event)" class="p-inputtext-sm" aria-label="Buscar por proveedor, OC o folio" />
        </p-iconfield>
        <p-datepicker [ngModel]="dateFrom()" (onSelect)="onDate('from', $event)" (onClear)="onDate('from', null)" dateFormat="yy-mm-dd" [showIcon]="true" [showClear]="true" appendTo="body" placeholder="Desde" styleClass="c3-dp" ariaLabel="Desde" />
        <p-datepicker [ngModel]="dateTo()" (onSelect)="onDate('to', $event)" (onClear)="onDate('to', null)" dateFormat="yy-mm-dd" [showIcon]="true" [showClear]="true" appendTo="body" placeholder="Hasta" styleClass="c3-dp" ariaLabel="Hasta" />
        <label class="c3-chk"><p-checkbox [ngModel]="conAjuste()" (ngModelChange)="onToggleAdj($event)" [binary]="true" inputId="c3-adj" /> <span>Solo con ajuste</span></label>
      </div>

      @if (err(); as e) {
        <div class="c3-errbox" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span class="c3-errbox-txt">{{ e }}</span>
          <button pButton type="button" class="p-button-sm p-button-outlined" (click)="retry()" label="Reintentar"></button>
        </div>
      }

      @if (data(); as d) {
        <app-metric-strip [items]="kpiItems(d)" ariaLabel="Totales de compras" />
      }

      <p-table
        [value]="data()?.rows || []"
        [loading]="loading()"
        [lazy]="true"
        [paginator]="true"
        [rows]="pageSize()"
        [totalRecords]="total()"
        [first]="(page() - 1) * pageSize()"
        [rowsPerPageOptions]="[25, 50, 100, 200]"
        (onLazyLoad)="onLazyLoad($event)"
        styleClass="p-datatable-sm surf-table surf-table--sticky c3-table"
        [rowHover]="true"
        [scrollable]="true"
        scrollHeight="flex"
        currentPageReportTemplate="{first}–{last} de {totalRecords}"
        [showCurrentPageReport]="true">
        <ng-template #header>
          <tr>
            <th class="c3-w-date">Fecha</th><th class="c3-w-suc">Suc.</th><th>Proveedor</th><th class="c3-w-oc">OC</th><th class="c3-w-oc">Folio</th>
            <th class="ta-r c3-w-amt">Factura</th><th class="ta-r c3-w-amt">Ajuste</th><th class="ta-r c3-w-amt">Neto</th>
          </tr>
        </ng-template>
        <ng-template #body let-r>
          <tr class="c3-row" [class.has-adj]="r.ajuste !== 0" role="button" tabindex="0"
              [attr.aria-label]="'Ver ajustes de la entrada ' + r.folio + ' de ' + (r.proveedor_nombre || r.proveedor_code || '')"
              (click)="openDetail(r)"
              (keydown.enter)="openDetail(r)"
              (keydown.space)="$event.preventDefault(); openDetail(r)">
            <td class="c3-mono">{{ r.receipt_date ? r.receipt_date.slice(0,10) : '—' }}</td>
            <td class="c3-mono">{{ r.sucursal }}</td>
            <td class="c3-prov" [title]="r.proveedor_nombre">{{ r.proveedor_nombre || r.proveedor_code || '—' }}</td>
            <td class="c3-mono muted">{{ r.oc_folio || '—' }}</td>
            <td class="c3-mono muted">{{ r.folio }}</td>
            <td class="ta-r c3-num">{{ money(r.factura) }}</td>
            <td class="ta-r c3-num" [class.c3-neg]="r.ajuste !== 0">{{ r.ajuste ? '−' + money(r.ajuste) : '—' }}</td>
            <td class="ta-r c3-num c3-strong">{{ money(r.neto) }}</td>
          </tr>
        </ng-template>
        <ng-template #emptymessage>
          <tr><td colspan="8">
            <div class="c3-empty-op">
              <i class="pi pi-inbox" aria-hidden="true"></i>
              <span class="c3-empty-op-title">Sin recepciones</span>
              @if (hasFilters()) {
                <span class="c3-empty-op-sub">Ninguna orden de entrada coincide con los filtros actuales.</span>
                <button pButton type="button" class="p-button-sm p-button-outlined" (click)="clearFilters()" label="Quitar filtros"></button>
              } @else {
                <span class="c3-empty-op-sub">No hay órdenes de entrada ni facturas de compra cargadas en el periodo.</span>
              }
            </div>
          </td></tr>
        </ng-template>
      </p-table>
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
          } @else if (explainsErr()) {
            <p class="c3-empty c3-dt-err">No se pudieron cargar los ajustes de esta recepción. <button type="button" class="c3-linkbtn" (click)="openDetail(detail()!)">Reintentar</button></p>
          } @else if (explains().length === 0) {
            <p class="c3-empty">Sin ajustes ligados a esta recepción.</p>
          } @else {
            <p-table [value]="explains()" styleClass="p-datatable-sm surf-table c3-dt-table" [scrollable]="true" scrollHeight="40vh">
              <ng-template #header>
                <tr><th class="c3-w-date">Fecha</th><th class="c3-w-doc">Tipo</th><th>Motivo</th><th class="ta-r c3-w-amt">Monto</th><th class="c3-w-match">Match</th></tr>
              </ng-template>
              <ng-template #body let-a>
                <tr>
                  <td class="c3-mono">{{ a.adjustment_date ? a.adjustment_date.slice(0,10) : '—' }}</td>
                  <td class="c3-mono">{{ a.doctype }}</td>
                  <td [title]="a.motivo">{{ a.categoria || a.motivo || '—' }}</td>
                  <td class="ta-r c3-num">{{ money(a.monto) }}</td>
                  <td><p-tag [value]="a.match" [severity]="a.match === 'exacto' ? 'success' : 'warn'" /></td>
                </tr>
              </ng-template>
            </p-table>
            <p class="c3-dt-note">Total ajustes ligados: <b>{{ money(explainsTotal()) }}</b>. Los match "proveedor+fecha" son heurísticos (Kepler no liga la nota a la entrada) — revisar.</p>
          }

          <div class="c3-dt-actions">
            <button pButton type="button" class="p-button-sm p-button-text" (click)="drillToDescuentos(r)">
              <span class="pi pi-arrow-up-right" aria-hidden="true"></span>&nbsp;Ver ajustes de este proveedor en Descuentos
            </button>
          </div>
        </div>
      }
    </p-dialog>
  `,
  styles: [`
    :host { display:block; }
    .surf-page-head { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap; }
    .c3-head-actions { display:flex; gap:.5rem; }
    .c3-filters { display:flex; flex-wrap:wrap; gap:.6rem; align-items:center; margin:1rem 0 .6rem; }
    .c3-search input { min-width:230px; }
    .c3-chk { display:inline-flex; align-items:center; gap:.45rem; font-size:.8rem; color:var(--text-muted); cursor:pointer; }
    .c3-table { margin-top:.6rem; }
    .c3-row { cursor:pointer; }
    .c3-row:focus-visible { outline:2px solid var(--action-ring); outline-offset:-2px; }
    /* fila con ajuste = señalar la fila exacta (punto 15) */
    .c3-row.has-adj > td:first-child { box-shadow:inset 3px 0 0 var(--warn-fg); }
    .ta-r { text-align:right; }
    .c3-mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .c3-num { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .c3-strong { font-weight:700; }
    .c3-neg { color:var(--bad-fg); }
    .c3-prov { max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .muted { color:var(--text-faint); }
    .c3-w-date { width:6rem; } .c3-w-suc { width:4rem; } .c3-w-oc { width:7rem; } .c3-w-amt { width:8rem; } .c3-w-doc { width:5rem; } .c3-w-match { width:6rem; }
    .c3-empty { padding:1.4rem; text-align:center; color:var(--text-faint); font-size:.85rem; }
    /* error de red (banner + reintento) — Empty ≠ error */
    .c3-errbox { display:flex; align-items:center; gap:.6rem; padding:.7rem .85rem; margin:.2rem 0 .6rem; border:1px solid var(--bad-border, var(--border-color)); border-left:3px solid var(--bad-fg); border-radius:var(--r-md); background:var(--card-bg); }
    .c3-errbox .pi { color:var(--bad-fg); }
    .c3-errbox-txt { flex:1; font-size:.84rem; color:var(--text-main); }
    /* empty operacional: icono + título + microcopy + CTA */
    .c3-empty-op { display:flex; flex-direction:column; align-items:center; gap:.4rem; padding:2.4rem 1rem; text-align:center; }
    .c3-empty-op .pi { font-size:1.6rem; color:var(--text-faint); }
    .c3-empty-op-title { font-weight:600; color:var(--text-main); }
    .c3-empty-op-sub { font-size:.84rem; color:var(--text-muted); max-width:32rem; }
    app-metric-strip { display:block; margin:.9rem 0; }
    /* detalle */
    .c3-dt-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:.8rem 1rem; margin-bottom:1rem; }
    .c3-dt-grid > div { display:flex; flex-direction:column; gap:.15rem; }
    .c3-dt-l { font-size:.66rem; text-transform:uppercase; letter-spacing:.04em; color:var(--text-faint); }
    .c3-dt-v { font-size:.9rem; color:var(--text-main); }
    .c3-dt-h { font-size:.82rem; font-weight:700; margin:.4rem 0 .5rem; color:var(--text-main); }
    .c3-dt-table { font-size:.78rem; }
    .c3-dt-note { font-size:.72rem; color:var(--text-faint); margin-top:.6rem; line-height:1.5; }
    .c3-dt-err { color:var(--bad-fg); }
    .c3-linkbtn { background:none; border:0; color:var(--action); cursor:pointer; font:inherit; text-decoration:underline; padding:0; }
    .c3-dt-actions { margin-top:1rem; padding-top:.7rem; border-top:1px solid var(--border-color); display:flex; justify-content:flex-end; }
    @media (max-width:560px) { .c3-dt-grid { grid-template-columns:repeat(2,1fr); } }
  `],
})
export class ComprasCompras360Component implements OnInit {
  private readonly svc = inject(ComprasService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly data = signal<Compras360Response | null>(null);
  readonly loading = signal(false);
  readonly exporting = signal(false);
  /** Error de red de la lista (banner + reintento). Empty ≠ error. */
  readonly err = signal<string | null>(null);
  readonly search = signal('');
  readonly dateFrom = signal<Date | null>(null);
  readonly dateTo = signal<Date | null>(null);
  readonly conAjuste = signal(false);
  readonly page = signal(1);
  readonly pageSize = signal(50);
  readonly total = signal(0);
  private searchTimer: any;

  readonly detail = signal<Compras360Row | null>(null);
  readonly explains = signal<AdjustmentForEntradaRow[]>([]);
  readonly explainsLoading = signal(false);
  readonly explainsErr = signal(false);
  readonly explainsTotal = signal(0);
  readonly detailHeader = computed(() => { const r = this.detail(); return r ? `Entrada ${r.folio}` : ''; });

  /** onLazyLoad de p-table → page/pageSize + recarga (helper compartido). */
  readonly onLazyLoad = makeLazyLoad(this.page, this.pageSize, () => this.reload());

  ngOnInit(): void {
    // Estado en URL: rehidratar filtros + página (F5 y deep-link).
    const q = this.route.snapshot.queryParamMap;
    this.search.set(q.get('q') || '');
    this.dateFrom.set(this.fromIso(q.get('from')));
    this.dateTo.set(this.fromIso(q.get('to')));
    this.conAjuste.set(q.get('adj') === '1');
    const p = parseInt(q.get('page') || '1', 10);
    this.page.set(!Number.isFinite(p) || p < 1 ? 1 : p);
    // La carga inicial la dispara el onLazyLoad de la p-table.
  }

  /** Date → 'YYYY-MM-DD' (local, sin correr por TZ). */
  private toIso(d: Date | null): string | undefined {
    if (!d) return undefined;
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  }
  /** 'YYYY-MM-DD' → Date (local). */
  private fromIso(s: string | null): Date | null {
    if (!s) return null;
    const [y, m, d] = s.split('-').map(Number);
    return y && m && d ? new Date(y, m - 1, d) : null;
  }

  private query(all = false) {
    return { search: this.search().trim() || undefined, date_from: this.toIso(this.dateFrom()), date_to: this.toIso(this.dateTo()), con_ajuste: this.conAjuste(), page: this.page(), pageSize: this.pageSize(), all };
  }

  /** Refleja filtros + página en la URL (replaceUrl → no ensucia el historial). */
  private syncUrl(): void {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        q: this.search().trim() || null,
        from: this.toIso(this.dateFrom()) || null,
        to: this.toIso(this.dateTo()) || null,
        adj: this.conAjuste() ? '1' : null,
        page: this.page() > 1 ? this.page() : null,
      },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  reload(): void {
    this.loading.set(true); this.err.set(null);
    this.svc.compras360(this.query()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.data.set(d); this.total.set(d.total); this.loading.set(false); },
      error: () => { this.loading.set(false); this.err.set('No se pudieron cargar las recepciones.'); },
    });
  }

  /** Reintento del banner de error. */
  retry(): void { this.err.set(null); this.reload(); }

  onSearch(v: string): void {
    this.search.set(v);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => { this.page.set(1); this.syncUrl(); this.reload(); }, 320);
  }

  onDate(which: 'from' | 'to', v: Date | null): void {
    (which === 'from' ? this.dateFrom : this.dateTo).set(v);
    this.page.set(1); this.syncUrl(); this.reload();
  }

  onToggleAdj(v: boolean): void {
    this.conAjuste.set(v); this.page.set(1); this.syncUrl(); this.reload();
  }

  hasFilters(): boolean { return !!(this.search().trim() || this.dateFrom() || this.dateTo() || this.conAjuste()); }

  clearFilters(): void {
    this.search.set(''); this.dateFrom.set(null); this.dateTo.set(null); this.conAjuste.set(false);
    this.page.set(1); this.syncUrl(); this.reload();
  }

  openDetail(r: Compras360Row): void {
    this.detail.set(r);
    this.explains.set([]); this.explainsTotal.set(0); this.explainsErr.set(false); this.explainsLoading.set(true);
    this.svc.adjustmentsForEntrada({ proveedor_code: r.proveedor_code, entrada_folio: r.folio, date: r.receipt_date?.slice(0, 10), window_days: 15 }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => { this.explains.set(res.rows || []); this.explainsTotal.set(res.total_monto || 0); this.explainsLoading.set(false); },
      error: () => { this.explainsLoading.set(false); this.explainsErr.set(true); },
    });
  }
  closeDetail(): void { this.detail.set(null); }

  /** Q.4 — navega a Descuentos filtrando por el proveedor (su lugar de arreglo). */
  drillToDescuentos(r: Compras360Row): void {
    const prov = r.proveedor_nombre || r.proveedor_code || '';
    this.closeDetail();
    this.router.navigate(['/compras/descuentos'], { queryParams: { q: prov } });
  }

  exportCsv(): void {
    this.exporting.set(true);
    this.svc.compras360(this.query(true)).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
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
      { label: 'Ajustes ligados', value: d.totals.ajuste, format: 'currency-short', tone: 'warn', sub: 'devoluciones + notas' },
      { label: 'Neto', value: d.totals.neto, format: 'currency-short', tone: 'brand', sub: 'factura − ajuste' },
    ];
  }

  money(n: number): string { return Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
}
