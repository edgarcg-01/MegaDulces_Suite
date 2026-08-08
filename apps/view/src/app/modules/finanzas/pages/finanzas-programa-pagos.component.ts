import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { SkeletonModule } from 'primeng/skeleton';
import { TagModule } from 'primeng/tag';
import { environment } from '../../../../environments/environment';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';

interface PPRow {
  id: string; source_month: string; pay_date: string | null; clearing_date: string | null;
  supplier_text: string | null; supplier_name: string | null; sucursal_code: string | null;
  tipo: string | null; method: string | null; method_ref: string | null; bank_text: string | null;
  amount: number; invoice_folios: string | null; kepler_flag: boolean | null;
  credit_days: number | null;
}
interface PPResponse {
  rows: PPRow[];
  totals: { n: number; monto: number; kep_si: number; kep_no: number; sin_resolver: number };
  by_bank: { bank: string; n: number; monto: number }[];
  by_method: { method: string; n: number; monto: number }[];
}
interface PPFacets { months: string[]; banks: string[]; methods: string[]; tipos: string[] }
interface PPReconMonth { month: string; program: number; program_n: number; flag_si: number; flag_no: number; flag_na: number; monto_no: number; kepler201: number; bank_cb: number | null }
interface PPRecon { months: PPReconMonth[] }

/**
 * Fase PP.3 — Programa de Pagos (Tesorería). Espejo del Excel de pagos: qué se paga, a quién,
 * de qué banco, con qué método, cuándo, y si está en Kepler. Read-only sobre finance.payment_program.
 * Operations mode, PrimeNG-first.
 */
@Component({
  selector: 'app-finanzas-programa-pagos',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule, FormsModule, ButtonModule, InputTextModule, IconFieldModule, InputIconModule,
    TableModule, SelectModule, SkeletonModule, TagModule, MetricStripComponent,
  ],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Programa de Pagos</h1>
          <p class="surf-page-sub">Ejecución de pagos de Tesorería <b>vs</b> el ERP: qué ya se pagó (banco, método, cuándo) y qué <b>aún no está asentado en Kepler</b> (columna KEPLER). Útil sobre todo para el mes en curso —lo ya posteado se ve al detalle en <b>Pagos a proveedor</b>. Espejo read-only del programa.</p>
        </div>
        <div class="pp-head-actions">
          <button pButton type="button" class="p-button-sm" [class.p-button-outlined]="!showRecon()" (click)="toggleRecon()"><span class="pi pi-check-square" aria-hidden="true"></span>&nbsp;Conciliación</button>
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="loading()" (click)="reload()"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Actualizar</span></button>
        </div>
      </header>

      @if (showRecon()) {
        <section class="pp-recon">
          <h2 class="pp-recon-h">Conciliación mensual</h2>
          @if (recon(); as rc) {
            <div class="pp-recon-scroll">
              <table class="pp-recon-tbl">
                <thead><tr><th>Mes</th><th class="ta-r">Programa</th><th class="ta-r">Kepler 201 (pagos)</th><th class="ta-r">Bancos (CB)</th><th class="ta-r">Pagado no en Kepler</th></tr></thead>
                <tbody>
                  @for (m of rc.months; track m.month) {
                    <tr>
                      <td class="pp-mono">{{ m.month }}</td>
                      <td class="ta-r pp-num">{{ money(m.program) }} <span class="pp-recon-n">{{ m.program_n }}</span></td>
                      <td class="ta-r pp-num muted">{{ money(m.kepler201) }}</td>
                      <td class="ta-r pp-num muted">{{ m.bank_cb === null ? '—' : money(m.bank_cb) }}</td>
                      <td class="ta-r pp-num" [class.pp-warn]="m.flag_no > 0">{{ m.flag_no > 0 || m.flag_si > 0 ? (money(m.monto_no) + ' · ' + m.flag_no) : 's/dato' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            <p class="pp-recon-note">Los tres universos <b>no son iguales</b> — es informativo, no un descuadre: <b>Kepler 201</b> incluye nómina/inter-sucursal/gastos (superset); <b>Bancos CB</b> son todos los egresos del estado de cuenta (solo meses cargados). La señal <b>confiable</b> de "pagado pero no asentado en el ERP" es <b>Pagado no en Kepler</b> (columna KEPLER de Tesorería, $ · #), disponible donde el Excel la trae (jul/ago). "s/dato" = ese mes no traía la columna.</p>
          } @else { <p class="pp-empty">Cargando conciliación…</p> }
        </section>
      }

      <div class="pp-filters">
        <p-select [options]="f().months" [ngModel]="month()" (onChange)="onFilter('month', $event.value)" placeholder="Mes" [showClear]="true" styleClass="pp-sel" ariaLabel="Mes" />
        <p-select [options]="f().banks" [ngModel]="bank()" (onChange)="onFilter('bank', $event.value)" placeholder="Banco" [showClear]="true" styleClass="pp-sel" ariaLabel="Banco" />
        <p-select [options]="f().methods" [ngModel]="method()" (onChange)="onFilter('method', $event.value)" placeholder="Método" [showClear]="true" styleClass="pp-sel" ariaLabel="Método" />
        <p-select [options]="f().tipos" [ngModel]="tipo()" (onChange)="onFilter('tipo', $event.value)" placeholder="Tipo" [showClear]="true" styleClass="pp-sel" ariaLabel="Tipo" />
        <p-select [options]="keplerOpts" [ngModel]="kepler()" (onChange)="onFilter('kepler', $event.value)" optionLabel="label" optionValue="value" placeholder="Kepler" [showClear]="true" styleClass="pp-sel" ariaLabel="Estado Kepler" />
        <p-iconfield styleClass="pp-search">
          <p-inputicon styleClass="pi pi-search" />
          <input pInputText type="text" placeholder="Proveedor…" [ngModel]="search()" (ngModelChange)="onSearch($event)" class="p-inputtext-sm" aria-label="Buscar proveedor" />
        </p-iconfield>
        @if (hasFilters()) { <button pButton type="button" class="p-button-sm p-button-text" (click)="clearFilters()"><span class="pi pi-filter-slash" aria-hidden="true"></span>&nbsp;Limpiar</button> }
      </div>

      @if (err(); as e) {
        <div class="pp-errbox" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span class="pp-errbox-txt">{{ e }}</span><button pButton type="button" class="p-button-sm p-button-outlined" (click)="reload()" label="Reintentar"></button></div>
      }

      @if (data(); as d) {
        <app-metric-strip [items]="kpis(d)" ariaLabel="Totales del programa de pagos" />
        <div class="pp-breakdown">
          <div class="pp-bd-col">
            <span class="pp-bd-title">Por banco</span>
            @for (b of d.by_bank; track b.bank) { <div class="pp-bd-row"><span class="pp-bd-k">{{ b.bank || '—' }}</span><span class="pp-bd-v">{{ money(b.monto) }}</span><span class="pp-bd-n">{{ b.n }}</span></div> }
          </div>
          <div class="pp-bd-col">
            <span class="pp-bd-title">Por método</span>
            @for (m of d.by_method; track m.method) { <div class="pp-bd-row"><span class="pp-bd-k">{{ m.method || '—' }}</span><span class="pp-bd-v">{{ money(m.monto) }}</span><span class="pp-bd-n">{{ m.n }}</span></div> }
          </div>
        </div>
      }

      @if (loading()) {
        <div class="pp-skel">@for (i of skelRows; track i) { <p-skeleton height="2rem" styleClass="pp-skel-row" /> }</div>
      } @else if (data(); as d) {
        <p-table [value]="d.rows" styleClass="p-datatable-sm surf-table surf-table--sticky pp-table" [rowHover]="true" [scrollable]="true" scrollHeight="flex" [paginator]="d.rows.length > 200" [rows]="200">
          <ng-template #header>
            <tr>
              <th class="pp-w-date">Fecha</th>
              <th>Proveedor</th>
              <th class="pp-w-suc">Suc</th>
              <th class="pp-w-tipo">Tipo</th>
              <th class="pp-w-met">Método</th>
              <th class="pp-w-bank">Banco</th>
              <th class="pp-w-fol">Facturas</th>
              <th class="ta-r pp-w-amt">Monto</th>
              <th class="pp-w-kep">Kepler</th>
            </tr>
          </ng-template>
          <ng-template #body let-r>
            <tr>
              <td class="pp-mono">{{ r.pay_date || '—' }}</td>
              <td class="pp-prov" [title]="r.supplier_name || r.supplier_text">
                {{ r.supplier_name || r.supplier_text || '—' }}
                @if (!r.supplier_name && r.supplier_text) { <span class="pp-unres" aria-hidden="true" title="proveedor sin resolver">·?</span> }
              </td>
              <td class="pp-mono muted">{{ r.sucursal_code || '—' }}</td>
              <td>@if (r.tipo) { <p-tag [value]="r.tipo" [severity]="r.tipo==='compra'?'info':r.tipo==='gasto'?'warn':'secondary'" styleClass="pp-tag" /> }</td>
              <td class="pp-mono muted">{{ r.method || '—' }}@if (r.method_ref) { <span class="pp-ref"> {{ r.method_ref }}</span> }</td>
              <td class="pp-mono">{{ r.bank_text || '—' }}</td>
              <td class="pp-mono muted pp-fol" [title]="r.invoice_folios">{{ r.invoice_folios || '—' }}</td>
              <td class="ta-r pp-num pp-strong">{{ money(r.amount) }}</td>
              <td>
                @if (r.kepler_flag === true) { <p-tag value="✓" severity="success" styleClass="pp-tag" /> }
                @else if (r.kepler_flag === false) { <p-tag value="no" severity="danger" styleClass="pp-tag" /> }
                @else { <span class="muted">—</span> }
              </td>
            </tr>
          </ng-template>
          <ng-template #emptymessage>
            <tr><td colspan="9"><div class="pp-empty-op"><i class="pi pi-inbox" aria-hidden="true"></i><span class="pp-empty-op-title">Sin pagos</span><span class="pp-empty-op-sub">Ningún pago coincide con los filtros.</span></div></td></tr>
          </ng-template>
        </p-table>
        <p class="pp-foot">Espejo del <b>Programa de Pagos</b> de Tesorería (finance.payment_program). <b>Valor único:</b> los pagos con KEPLER=<b>no</b> son ejecutados por Tesorería y <b>aún no asentados en el ERP</b> (en agosto: la mayoría, por el rezago de posteo). Lo ya posteado vive con más detalle en <b>Pagos a proveedor</b> (analytics.erp_supplier_payments) y la política de descuento en Compras. <b>Método</b>: transferencia/cheque/factoraje/anticipo. "·?" = proveedor no resuelto. Máx {{ d.rows.length }} filas.</p>
      }
    </div>
  `,
  styles: [`
    :host { display:block; }
    .surf-page-head { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap; }
    .pp-head-actions { display:flex; gap:.5rem; }
    .pp-filters { display:flex; flex-wrap:wrap; gap:.6rem; align-items:center; margin:1rem 0 .6rem; }
    :host ::ng-deep .pp-sel { min-width:9rem; }
    .pp-search input { min-width:200px; }
    app-metric-strip { display:block; margin:.9rem 0 .6rem; }
    .pp-breakdown { display:flex; gap:1.4rem; flex-wrap:wrap; margin:.2rem 0 .8rem; }
    .pp-bd-col { flex:1; min-width:220px; border:1px solid var(--border-color); border-radius:var(--r-md); padding:.55rem .7rem; }
    .pp-bd-title { font-size:.72rem; text-transform:uppercase; letter-spacing:.03em; color:var(--text-muted); }
    .pp-bd-row { display:flex; align-items:baseline; gap:.6rem; font-size:.8rem; padding:.15rem 0; }
    .pp-bd-k { flex:1; color:var(--text-main); }
    .pp-bd-v { font-family:var(--font-mono); font-variant-numeric:tabular-nums; }
    .pp-bd-n { color:var(--text-faint); font-size:.72rem; min-width:2.5rem; text-align:right; }
    .pp-table { margin-top:.4rem; }
    .ta-r { text-align:right; }
    .pp-num, .pp-mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .pp-strong { font-weight:700; }
    .muted { color:var(--text-faint); }
    .pp-prov { max-width:300px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .pp-unres { color:var(--warn-fg); font-weight:700; margin-left:.2rem; }
    .pp-ref { color:var(--text-faint); }
    .pp-fol { max-width:150px; overflow:hidden; text-overflow:ellipsis; }
    .pp-w-date { width:6.2rem; } .pp-w-suc { width:3.2rem; } .pp-w-tipo { width:5.5rem; } .pp-w-met { width:9rem; }
    .pp-w-bank { width:6rem; } .pp-w-fol { width:9rem; } .pp-w-amt { width:8rem; } .pp-w-kep { width:4rem; }
    :host ::ng-deep .pp-tag { font-size:.64rem; }
    .pp-foot { margin-top:1rem; font-size:.74rem; color:var(--text-faint); line-height:1.5; }
    .pp-errbox { display:flex; align-items:center; gap:.6rem; padding:.7rem .85rem; margin:.2rem 0 .6rem; border:1px solid var(--border-color); border-left:3px solid var(--bad-fg); border-radius:var(--r-md); background:var(--card-bg); }
    .pp-errbox .pi { color:var(--bad-fg); } .pp-errbox-txt { flex:1; font-size:.84rem; }
    .pp-empty-op { display:flex; flex-direction:column; align-items:center; gap:.4rem; padding:2.4rem 1rem; text-align:center; }
    .pp-empty-op .pi { font-size:1.6rem; color:var(--text-faint); }
    .pp-empty-op-title { font-weight:600; }
    .pp-empty-op-sub { font-size:.84rem; color:var(--text-muted); }
    .pp-skel { display:flex; flex-direction:column; gap:.4rem; margin-top:1rem; }
    .pp-recon { border:1px solid var(--border-color); border-radius:var(--r-md); padding:.8rem 1rem; margin:.6rem 0 1rem; background:var(--card-bg); }
    .pp-recon-h { font-size:.9rem; font-weight:700; margin:0 0 .6rem; }
    .pp-recon-scroll { overflow-x:auto; }
    .pp-recon-tbl { width:100%; border-collapse:collapse; font-size:.8rem; }
    .pp-recon-tbl th, .pp-recon-tbl td { padding:.32rem .5rem; border-bottom:1px solid var(--border-color); white-space:nowrap; }
    .pp-recon-tbl th { color:var(--text-muted); font-weight:600; text-align:left; }
    .pp-recon-n { color:var(--text-faint); font-size:.72rem; margin-left:.3rem; }
    .pp-warn { color:var(--warn-fg); font-weight:700; }
    .pp-recon-note { font-size:.72rem; color:var(--text-faint); line-height:1.5; margin:.6rem 0 0; }
    .pp-empty { padding:1rem; text-align:center; color:var(--text-faint); font-size:.85rem; }
  `],
})
export class FinanzasProgramaPagosComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly base = `${environment.apiUrl}/finance/payment-program`;

  readonly data = signal<PPResponse | null>(null);
  readonly f = signal<PPFacets>({ months: [], banks: [], methods: [], tipos: [] });
  readonly loading = signal(false);
  readonly err = signal<string | null>(null);
  readonly month = signal<string | null>(null);
  readonly bank = signal<string | null>(null);
  readonly method = signal<string | null>(null);
  readonly tipo = signal<string | null>(null);
  readonly kepler = signal<string | null>(null);
  readonly search = signal('');
  readonly skelRows = Array.from({ length: 10 });
  readonly keplerOpts = [{ label: 'En Kepler', value: 'si' }, { label: 'No en Kepler', value: 'no' }, { label: 'Sin dato', value: 'na' }];
  readonly showRecon = signal(false);
  readonly recon = signal<PPRecon | null>(null);
  private searchTimer: any;

  toggleRecon(): void {
    const next = !this.showRecon(); this.showRecon.set(next);
    if (next && !this.recon()) {
      this.http.get<PPRecon>(`${this.base}/recon`).pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({ next: (r) => this.recon.set(r), error: () => this.recon.set({ months: [] }) });
    }
  }

  ngOnInit(): void {
    this.http.get<PPFacets>(`${this.base}/facets`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (f) => { this.f.set(f); if (f.months?.length) this.month.set(f.months[0]); this.reload(); },
      error: () => { this.err.set('No se pudieron cargar los filtros.'); this.reload(); },
    });
  }

  private query(): Observable<PPResponse> {
    const p = new URLSearchParams();
    if (this.month()) p.set('month', this.month()!);
    if (this.bank()) p.set('bank', this.bank()!);
    if (this.method()) p.set('method', this.method()!);
    if (this.tipo()) p.set('tipo', this.tipo()!);
    if (this.kepler()) p.set('kepler', this.kepler()!);
    if (this.search().trim()) p.set('search', this.search().trim());
    const qs = p.toString();
    return this.http.get<PPResponse>(`${this.base}${qs ? '?' + qs : ''}`);
  }

  reload(): void {
    this.loading.set(true); this.err.set(null);
    this.query().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.data.set(d); this.loading.set(false); },
      error: () => { this.loading.set(false); this.err.set('No se pudo cargar el programa de pagos.'); },
    });
  }

  onFilter(which: 'month' | 'bank' | 'method' | 'tipo' | 'kepler', v: string | null): void {
    ({ month: this.month, bank: this.bank, method: this.method, tipo: this.tipo, kepler: this.kepler })[which].set(v);
    this.reload();
  }
  onSearch(v: string): void { this.search.set(v); if (this.searchTimer) clearTimeout(this.searchTimer); this.searchTimer = setTimeout(() => this.reload(), 320); }
  hasFilters(): boolean { return !!(this.bank() || this.method() || this.tipo() || this.kepler() || this.search().trim()); }
  clearFilters(): void { this.bank.set(null); this.method.set(null); this.tipo.set(null); this.kepler.set(null); this.search.set(''); this.reload(); }

  kpis(d: PPResponse): MetricStripItem[] {
    return [
      { label: 'Pagado', value: d.totals.monto, format: 'currency-short', tone: 'default', sub: `${d.totals.n} pagos` },
      { label: 'En Kepler', value: d.totals.kep_si, format: 'number', tone: 'ok' },
      { label: 'No en Kepler', value: d.totals.kep_no, format: 'number', tone: d.totals.kep_no > 0 ? 'warn' : 'default' },
      { label: 'Sin resolver', value: d.totals.sin_resolver, format: 'number', tone: 'default', sub: 'proveedor' },
    ];
  }
  money(n: number): string { return Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
}
