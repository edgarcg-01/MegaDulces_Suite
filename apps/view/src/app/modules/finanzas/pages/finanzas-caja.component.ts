import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
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

type View = 'resumen' | 'depositos' | 'arqueos' | 'conciliacion';
interface Overview {
  period: { from: string; to: string; instance: string };
  venta_total: number; dias: number; sucursales: number; vendido: number; depositado: number; descuadre: number;
  depositos: { n: number; total: number; total_real: number; comision: number };
  tenders: { tender: string; vendido: number; depositado: number; descuadre: number }[];
}
interface SucursalRow { almacen: string; empresa: string | null; nombre: string | null; dias: number; venta: number; depositado: number; descuadre: number; pct_depositado: number; ultima: string }
interface DepRow { deposito_id: string; almacen: string; banco_name: string | null; banco_cuenta: string | null; deposito_date: string; deposito_date_real: string | null; tipo_pago: string | null; total_deposito: number; total_deposito_real: number; comision: number; observaciones: string | null }
interface DepResp { rows: DepRow[]; totals: { n: number; total: number; total_real: number; comision: number }; by_bank: { banco: string; n: number; total_real: number }[] }
interface ArqRow { mov_id: string; source_caja: string; folio: string | null; tipo: string | null; arqueo_date: string; capturo: string | null; total_efectivo: number; total_cheques: number; total_tarjeta: number; mov_total: number; revisado: boolean; cancelado: boolean; observaciones: string | null }
interface ArqResp { rows: ArqRow[]; by_tipo: { tipo: string; n: number; monto: number }[] }
interface ConcRow { banco: string; caja_n: number; caja_real: number; cb_n: number; cb_in: number; delta: number; cuadra: boolean; cb_disponible: boolean }
interface Conc { period: { from: string; to: string; instance: string }; totals: { caja_real: number; cb_in: number; delta: number; cb_disponible: boolean }; por_banco: ConcRow[]; cuadre_eps: number }
interface Facets { meses: string[]; bancos: string[]; empresas: string[]; cajas: string[] }
const TENDER_LABEL: Record<string, string> = { efectivo: 'Efectivo', morralla: 'Morralla', cheques: 'Cheques', tarjeta: 'Tarjeta', caja_chica: 'Caja chica', sobregiro: 'Sobregiro' };

/**
 * Fase CG.4 — Caja General (Tesorería). Espejo del sistema Access de Finanzas:
 * venta diaria por sucursal → depósito bancario, arqueo por denominación, y
 * conciliación de depósitos vs el estado de cuenta (CB). Read-only, Operations mode.
 */
@Component({
  selector: 'app-finanzas-caja',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ButtonModule, InputTextModule, IconFieldModule, InputIconModule, TableModule, SelectModule, SkeletonModule, TagModule, MetricStripComponent],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Caja General</h1>
          <p class="surf-page-sub">Control de <b>venta diaria → depósito bancario</b> por sucursal (la capa entre el punto de venta y el banco), arqueo de caja por denominación, y conciliación de depósitos contra el estado de cuenta. Espejo read-only del sistema de Finanzas.</p>
        </div>
        <div class="cg-head-actions">
          <p-select [options]="f().meses" [ngModel]="month()" (onChange)="onMonth($event.value)" placeholder="Mes" styleClass="cg-sel" ariaLabel="Mes" />
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="loading()" (click)="reload()"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Actualizar</span></button>
        </div>
      </header>

      <nav class="cg-views" role="tablist" aria-label="Vistas de caja">
        @for (v of VIEWS; track v.key) {
          <button role="tab" [attr.aria-selected]="view()===v.key" class="cg-view" [class.on]="view()===v.key" (click)="setView(v.key)"><span class="pi {{v.icon}}" aria-hidden="true"></span>&nbsp;{{ v.label }}</button>
        }
      </nav>

      @if (err(); as e) { <div class="cg-errbox" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span class="cg-errbox-txt">{{ e }}</span><button pButton type="button" class="p-button-sm p-button-outlined" (click)="reload()" label="Reintentar"></button></div> }

      <!-- ===== RESUMEN ===== -->
      @if (view()==='resumen') {
        @if (loading() && !ov()) { <div class="cg-skel">@for (i of skel; track i) { <p-skeleton height="2rem" styleClass="cg-skel-row" /> }</div> }
        @else if (ov(); as d) {
          <app-metric-strip [items]="ovKpis(d)" ariaLabel="Totales de caja" />
          <div class="cg-tenders">
            <span class="cg-bd-title">Venta vs depositado por forma de pago</span>
            <table class="cg-mini">
              <thead><tr><th>Forma</th><th class="ta-r">Vendido</th><th class="ta-r">Depositado</th><th class="ta-r">Descuadre</th></tr></thead>
              <tbody>
                @for (t of d.tenders; track t.tender) {
                  <tr><td>{{ tLabel(t.tender) }}</td><td class="ta-r num">{{ money(t.vendido) }}</td><td class="ta-r num muted">{{ money(t.depositado) }}</td><td class="ta-r num" [class.warn]="t.descuadre>1000">{{ money(t.descuadre) }}</td></tr>
                }
              </tbody>
            </table>
            <p class="cg-note">El <b>depositado</b> por forma de pago viene de las columnas de captura; el <b>ledger de depósitos</b> (pestaña Depósitos) tiene {{ money(d.depositos.total_real) }} reales ({{ d.depositos.n }}). Que las tres vistas —venta, columnas y ledger— no coincidan es <b>la señal</b>, no un error.</p>
          </div>
          @if (suc(); as rows) {
            <p-table [value]="rows" styleClass="p-datatable-sm surf-table surf-table--sticky" [rowHover]="true" [scrollable]="true" scrollHeight="flex">
              <ng-template #header><tr><th>Sucursal</th><th>Empresa</th><th class="ta-c cg-w-d">Días</th><th class="ta-r">Venta</th><th class="ta-r">Depositado</th><th class="ta-r">Descuadre</th><th class="ta-c cg-w-p">% dep</th><th class="cg-w-u">Última</th></tr></ng-template>
              <ng-template #body let-r>
                <tr>
                  <td class="cg-mono">{{ r.nombre || r.almacen }} <span class="muted">{{ r.almacen }}</span></td>
                  <td class="muted cg-emp" [title]="r.empresa">{{ r.empresa || '—' }}</td>
                  <td class="ta-c muted">{{ r.dias }}</td>
                  <td class="ta-r num strong">{{ money(r.venta) }}</td>
                  <td class="ta-r num muted">{{ money(r.depositado) }}</td>
                  <td class="ta-r num" [class.warn]="r.descuadre>1000">{{ money(r.descuadre) }}</td>
                  <td class="ta-c num" [class.warn]="r.pct_depositado<80">{{ r.pct_depositado }}%</td>
                  <td class="cg-mono muted">{{ r.ultima | date:'dd/MM/yy' }}</td>
                </tr>
              </ng-template>
            </p-table>
          }
        }
      }

      <!-- ===== DEPOSITOS ===== -->
      @if (view()==='depositos') {
        <div class="cg-filters">
          <p-select [options]="f().bancos" [ngModel]="banco()" (onChange)="onFilter('banco',$event.value)" placeholder="Banco" [showClear]="true" styleClass="cg-sel" ariaLabel="Banco" />
          <p-iconfield styleClass="cg-search"><p-inputicon styleClass="pi pi-search" /><input pInputText type="text" placeholder="Banco/cuenta/obs…" [ngModel]="search()" (ngModelChange)="onSearch($event)" class="p-inputtext-sm" aria-label="Buscar" /></p-iconfield>
          @if (banco() || search().trim()) { <button pButton type="button" class="p-button-sm p-button-text" (click)="clearDep()"><span class="pi pi-filter-slash" aria-hidden="true"></span>&nbsp;Limpiar</button> }
        </div>
        @if (loading() && !dep()) { <div class="cg-skel">@for (i of skel; track i) { <p-skeleton height="2rem" styleClass="cg-skel-row" /> }</div> }
        @else if (dep(); as d) {
          <app-metric-strip [items]="depKpis(d)" ariaLabel="Totales de depósitos" />
          <div class="cg-bd">
            <span class="cg-bd-title">Por banco (real)</span>
            @for (b of d.by_bank; track b.banco) { <div class="cg-bd-row"><span class="cg-bd-k">{{ b.banco || '—' }}</span><span class="cg-bd-v">{{ money(b.total_real) }}</span><span class="cg-bd-n">{{ b.n }}</span></div> }
          </div>
          <p-table [value]="d.rows" styleClass="p-datatable-sm surf-table surf-table--sticky" [rowHover]="true" [scrollable]="true" scrollHeight="flex" [paginator]="d.rows.length>200" [rows]="200">
            <ng-template #header><tr><th class="cg-w-date">Depósito</th><th class="cg-w-date">Real</th><th>Banco</th><th class="cg-w-suc">Suc</th><th class="cg-w-met">Método</th><th class="ta-r">Depósito</th><th class="ta-r">Real</th><th class="ta-r cg-w-com">Comisión</th></tr></ng-template>
            <ng-template #body let-r>
              <tr>
                <td class="cg-mono">{{ r.deposito_date | date:'dd/MM/yy' }}</td>
                <td class="cg-mono muted">{{ r.deposito_date_real ? (r.deposito_date_real | date:'dd/MM/yy') : '—' }}</td>
                <td>{{ r.banco_name || '—' }}@if (r.banco_cuenta) { <span class="muted"> ·{{ r.banco_cuenta }}</span> }</td>
                <td class="cg-mono muted">{{ r.almacen || '—' }}</td>
                <td class="muted">{{ r.tipo_pago || '—' }}</td>
                <td class="ta-r num muted">{{ money(r.total_deposito) }}</td>
                <td class="ta-r num strong">{{ money(r.total_deposito_real) }}</td>
                <td class="ta-r num muted">{{ r.comision ? money(r.comision) : '—' }}</td>
              </tr>
            </ng-template>
            <ng-template #emptymessage><tr><td colspan="8"><div class="cg-empty"><i class="pi pi-inbox" aria-hidden="true"></i><span>Sin depósitos en el periodo.</span></div></td></tr></ng-template>
          </p-table>
        }
      }

      <!-- ===== ARQUEOS ===== -->
      @if (view()==='arqueos') {
        <div class="cg-filters">
          <p-select [options]="tipoOpts" [ngModel]="tipo()" (onChange)="onFilter('tipo',$event.value)" placeholder="Tipo" [showClear]="true" styleClass="cg-sel" ariaLabel="Tipo" />
          <p-select [options]="f().cajas" [ngModel]="caja()" (onChange)="onFilter('caja',$event.value)" placeholder="Caja" [showClear]="true" styleClass="cg-sel" ariaLabel="Caja" />
        </div>
        @if (loading() && !arq()) { <div class="cg-skel">@for (i of skel; track i) { <p-skeleton height="2rem" styleClass="cg-skel-row" /> }</div> }
        @else if (arq(); as d) {
          <div class="cg-bd">
            <span class="cg-bd-title">Por tipo</span>
            @for (t of d.by_tipo; track t.tipo) { <div class="cg-bd-row"><span class="cg-bd-k">{{ t.tipo || '—' }}</span><span class="cg-bd-v">{{ money(t.monto) }}</span><span class="cg-bd-n">{{ t.n }}</span></div> }
          </div>
          <p-table [value]="d.rows" styleClass="p-datatable-sm surf-table surf-table--sticky" [rowHover]="true" [scrollable]="true" scrollHeight="flex" [paginator]="d.rows.length>200" [rows]="200">
            <ng-template #header><tr><th class="cg-w-date">Fecha</th><th class="cg-w-fol">Folio</th><th>Tipo</th><th class="cg-w-suc">Caja</th><th class="ta-r">Efectivo</th><th class="ta-r">Cheques</th><th class="ta-r">Tarjeta</th><th class="ta-r">Total</th><th class="cg-w-e">Estado</th></tr></ng-template>
            <ng-template #body let-r>
              <tr [class.cg-cancel]="r.cancelado">
                <td class="cg-mono">{{ r.arqueo_date | date:'dd/MM/yy' }}</td>
                <td class="cg-mono">{{ r.folio || '—' }}</td>
                <td><p-tag [value]="r.tipo || '?'" [severity]="tipoSev(r.tipo)" styleClass="cg-tag" /></td>
                <td class="cg-mono muted">{{ r.source_caja }}</td>
                <td class="ta-r num">{{ money(r.total_efectivo) }}</td>
                <td class="ta-r num muted">{{ r.total_cheques ? money(r.total_cheques) : '—' }}</td>
                <td class="ta-r num muted">{{ r.total_tarjeta ? money(r.total_tarjeta) : '—' }}</td>
                <td class="ta-r num strong">{{ money(r.mov_total) }}</td>
                <td>@if (r.cancelado) { <p-tag value="cancelado" severity="danger" styleClass="cg-tag" /> } @else if (r.revisado) { <p-tag value="✓" severity="success" styleClass="cg-tag" /> } @else { <span class="muted">—</span> }</td>
              </tr>
            </ng-template>
            <ng-template #emptymessage><tr><td colspan="9"><div class="cg-empty"><i class="pi pi-inbox" aria-hidden="true"></i><span>Sin arqueos en el periodo.</span></div></td></tr></ng-template>
          </p-table>
        }
      }

      <!-- ===== CONCILIACION ===== -->
      @if (view()==='conciliacion') {
        @if (loading() && !conc()) { <div class="cg-skel">@for (i of skel; track i) { <p-skeleton height="2rem" styleClass="cg-skel-row" /> }</div> }
        @else if (conc(); as d) {
          <app-metric-strip [items]="concKpis(d)" ariaLabel="Conciliación caja vs banco" />
          <p-table [value]="d.por_banco" styleClass="p-datatable-sm surf-table surf-table--sticky" [rowHover]="true" [scrollable]="true" scrollHeight="flex">
            <ng-template #header><tr><th>Banco</th><th class="ta-r">Depósitos caja</th><th class="ta-c cg-w-d">#</th><th class="ta-r">Ingresos banco (CB)</th><th class="ta-c cg-w-d">#</th><th class="ta-r">Delta</th><th class="cg-w-e">Cuadre</th></tr></ng-template>
            <ng-template #body let-r>
              <tr>
                <td class="cg-mono">{{ r.banco || '—' }}</td>
                <td class="ta-r num strong">{{ money(r.caja_real) }}</td>
                <td class="ta-c muted">{{ r.caja_n }}</td>
                <td class="ta-r num muted">{{ r.cb_disponible ? money(r.cb_in) : '—' }}</td>
                <td class="ta-c muted">{{ r.cb_disponible ? r.cb_n : '' }}</td>
                <td class="ta-r num" [class.warn]="!r.cuadra && r.cb_disponible">{{ r.cb_disponible ? money(r.delta) : '—' }}</td>
                <td>@if (!r.cb_disponible) { <span class="muted">s/CB</span> } @else if (r.cuadra) { <p-tag value="cuadra" severity="success" styleClass="cg-tag" /> } @else { <p-tag value="revisar" severity="warn" styleClass="cg-tag" /> }</td>
              </tr>
            </ng-template>
          </p-table>
          <p class="cg-note">Los <b>depósitos de caja</b> (lo que Finanzas registró depositar) vs los <b>ingresos del estado de cuenta</b> (CB, donde haya periodo cargado). Los universos <b>no son idénticos</b> —el banco recibe también transferencias de clientes, cobranza, etc.— así que el <b>delta es informativo</b>, no un descuadre estricto. Cuadre por totales con tolerancia ±{{ money(d.cuadre_eps) }}. "s/CB" = ese banco no tiene estado de cuenta cargado en Bancos.</p>
        }
      }
    </div>
  `,
  styles: [`
    :host { display:block; }
    .surf-page-head { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap; }
    .cg-head-actions { display:flex; gap:.5rem; align-items:center; }
    :host ::ng-deep .cg-sel { min-width:8.5rem; }
    .cg-views { display:flex; gap:.3rem; flex-wrap:wrap; margin:1rem 0 .8rem; border-bottom:1px solid var(--border-color); }
    .cg-view { background:none; border:none; border-bottom:2px solid transparent; padding:.5rem .8rem; font-size:.85rem; color:var(--text-muted); cursor:pointer; }
    .cg-view:hover { color:var(--text-main); }
    .cg-view.on { color:var(--text-main); border-bottom-color:var(--action); font-weight:600; }
    app-metric-strip { display:block; margin:.6rem 0; }
    .cg-filters { display:flex; flex-wrap:wrap; gap:.6rem; align-items:center; margin:.4rem 0 .6rem; }
    .cg-search input { min-width:200px; }
    .cg-tenders { border:1px solid var(--border-color); border-radius:var(--r-md); padding:.6rem .8rem; margin:.4rem 0 .8rem; }
    .cg-mini { width:100%; border-collapse:collapse; font-size:.8rem; margin-top:.4rem; }
    .cg-mini th, .cg-mini td { padding:.28rem .5rem; border-bottom:1px solid var(--border-color); white-space:nowrap; }
    .cg-mini th { color:var(--text-muted); font-weight:600; text-align:left; }
    .cg-bd { border:1px solid var(--border-color); border-radius:var(--r-md); padding:.55rem .7rem; margin:.4rem 0 .7rem; max-width:520px; }
    .cg-bd-title { font-size:.72rem; text-transform:uppercase; letter-spacing:.03em; color:var(--text-muted); }
    .cg-bd-row { display:flex; align-items:baseline; gap:.6rem; font-size:.8rem; padding:.15rem 0; }
    .cg-bd-k { flex:1; } .cg-bd-v { font-family:var(--font-mono); font-variant-numeric:tabular-nums; }
    .cg-bd-n { color:var(--text-faint); font-size:.72rem; min-width:2.5rem; text-align:right; }
    .ta-r { text-align:right; } .ta-c { text-align:center; }
    .num, .cg-mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .strong { font-weight:700; } .muted { color:var(--text-faint); } .warn { color:var(--warn-fg); font-weight:700; }
    .cg-emp { max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .cg-cancel { opacity:.5; text-decoration:line-through; }
    .cg-w-d { width:3.5rem; } .cg-w-p { width:4rem; } .cg-w-u { width:5rem; } .cg-w-date { width:6rem; } .cg-w-suc { width:3.4rem; }
    .cg-w-met { width:7rem; } .cg-w-com { width:6rem; } .cg-w-fol { width:6rem; } .cg-w-e { width:6rem; }
    :host ::ng-deep .cg-tag { font-size:.64rem; }
    .cg-note { margin-top:.6rem; font-size:.74rem; color:var(--text-faint); line-height:1.5; }
    .cg-errbox { display:flex; align-items:center; gap:.6rem; padding:.7rem .85rem; margin:.2rem 0 .6rem; border:1px solid var(--border-color); border-left:3px solid var(--bad-fg); border-radius:var(--r-md); background:var(--card-bg); }
    .cg-errbox .pi { color:var(--bad-fg); } .cg-errbox-txt { flex:1; font-size:.84rem; }
    .cg-empty { display:flex; flex-direction:column; align-items:center; gap:.4rem; padding:2rem 1rem; text-align:center; color:var(--text-muted); }
    .cg-empty .pi { font-size:1.6rem; color:var(--text-faint); }
    .cg-skel { display:flex; flex-direction:column; gap:.4rem; margin-top:1rem; }
  `],
})
export class FinanzasCajaComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly base = `${environment.apiUrl}/finance/caja`;

  readonly VIEWS: { key: View; label: string; icon: string }[] = [
    { key: 'resumen', label: 'Resumen', icon: 'pi-chart-bar' },
    { key: 'depositos', label: 'Depósitos', icon: 'pi-building-columns' },
    { key: 'arqueos', label: 'Arqueos', icon: 'pi-calculator' },
    { key: 'conciliacion', label: 'Conciliación', icon: 'pi-sync' },
  ];
  readonly tipoOpts = ['Arqueo', 'Retiro', 'Corte', 'Deposito', 'Fondo Caja'];
  readonly skel = Array.from({ length: 8 });

  readonly view = signal<View>('resumen');
  readonly f = signal<Facets>({ meses: [], bancos: [], empresas: [], cajas: [] });
  readonly month = signal<string | null>(null);
  readonly banco = signal<string | null>(null);
  readonly tipo = signal<string | null>(null);
  readonly caja = signal<string | null>(null);
  readonly search = signal('');
  readonly loading = signal(false);
  readonly err = signal<string | null>(null);
  readonly ov = signal<Overview | null>(null);
  readonly suc = signal<SucursalRow[] | null>(null);
  readonly dep = signal<DepResp | null>(null);
  readonly arq = signal<ArqResp | null>(null);
  readonly conc = signal<Conc | null>(null);
  private searchTimer: any;

  ngOnInit(): void {
    this.http.get<Facets>(`${this.base}/facets`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (f) => { this.f.set(f); if (f.meses?.length) this.month.set(f.meses[0]); this.reload(); },
      error: () => { this.err.set('No se pudieron cargar los filtros.'); this.reload(); },
    });
  }

  setView(v: View): void { if (v === this.view()) return; this.view.set(v); this.reload(); }
  onMonth(v: string | null): void { this.month.set(v); this.ov.set(null); this.suc.set(null); this.dep.set(null); this.arq.set(null); this.conc.set(null); this.reload(); }
  onFilter(which: 'banco' | 'tipo' | 'caja', v: string | null): void { ({ banco: this.banco, tipo: this.tipo, caja: this.caja })[which].set(v); this.reload(); }
  onSearch(v: string): void { this.search.set(v); if (this.searchTimer) clearTimeout(this.searchTimer); this.searchTimer = setTimeout(() => this.reload(), 320); }
  clearDep(): void { this.banco.set(null); this.search.set(''); this.reload(); }

  private qs(extra: Record<string, string | null> = {}): string {
    const p = new URLSearchParams();
    if (this.month()) p.set('month', this.month()!);
    for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : '';
  }

  reload(): void {
    this.loading.set(true); this.err.set(null);
    const done = () => this.loading.set(false);
    const fail = () => { this.loading.set(false); this.err.set('No se pudo cargar la caja.'); };
    const v = this.view();
    if (v === 'resumen') {
      this.http.get<Overview>(`${this.base}/overview${this.qs()}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (d) => { this.ov.set(d); done(); }, error: fail });
      this.http.get<SucursalRow[]>(`${this.base}/por-sucursal${this.qs()}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (d) => this.suc.set(d), error: () => this.suc.set([]) });
    } else if (v === 'depositos') {
      this.http.get<DepResp>(`${this.base}/depositos${this.qs({ banco: this.banco(), search: this.search().trim() || null })}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (d) => { this.dep.set(d); done(); }, error: fail });
    } else if (v === 'arqueos') {
      this.http.get<ArqResp>(`${this.base}/arqueos${this.qs({ tipo: this.tipo(), almacen: this.caja() })}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (d) => { this.arq.set(d); done(); }, error: fail });
    } else {
      this.http.get<Conc>(`${this.base}/conciliacion${this.qs()}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (d) => { this.conc.set(d); done(); }, error: fail });
    }
  }

  ovKpis(d: Overview): MetricStripItem[] {
    return [
      { label: 'Venta', value: d.venta_total, format: 'currency-short', tone: 'default', sub: `${d.dias} días · ${d.sucursales} suc` },
      { label: 'Depositado', value: d.depositado, format: 'currency-short', tone: 'default' },
      { label: 'Descuadre', value: d.descuadre, format: 'currency-short', tone: Math.abs(d.descuadre) > 1000 ? 'warn' : 'ok' },
      { label: 'Depósitos', value: d.depositos.total_real, format: 'currency-short', tone: 'default', sub: `${d.depositos.n} · $${Math.round(d.depositos.comision).toLocaleString('es-MX')} com.` },
    ];
  }
  depKpis(d: DepResp): MetricStripItem[] {
    return [
      { label: 'Depositado (real)', value: d.totals.total_real, format: 'currency-short', tone: 'default', sub: `${d.totals.n} depósitos` },
      { label: 'Registrado', value: d.totals.total, format: 'currency-short', tone: 'default' },
      { label: 'Comisiones', value: d.totals.comision, format: 'currency-short', tone: 'default' },
    ];
  }
  concKpis(d: Conc): MetricStripItem[] {
    return [
      { label: 'Depósitos caja', value: d.totals.caja_real, format: 'currency-short', tone: 'default' },
      { label: 'Ingresos banco (CB)', value: d.totals.cb_in, format: 'currency-short', tone: d.totals.cb_disponible ? 'default' : 'muted' as any },
      { label: 'Delta', value: d.totals.delta, format: 'currency-short', tone: 'default' },
    ];
  }
  tLabel(t: string): string { return TENDER_LABEL[t] || t; }
  tipoSev(t: string | null): 'warn' | 'info' | 'success' | 'secondary' { return t === 'Retiro' ? 'warn' : t === 'Corte' ? 'info' : t === 'Deposito' ? 'success' : 'secondary'; }
  money(n: number): string { return Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
}
