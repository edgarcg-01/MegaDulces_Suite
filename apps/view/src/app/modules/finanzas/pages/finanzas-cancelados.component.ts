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
import { TagModule } from 'primeng/tag';
import { environment } from '../../../../environments/environment';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FINANZAS_SHARED_STYLES } from './finanzas-shared.styles';
import { money, dmy } from './finanzas-format';

interface CancRow { sucursal: string; doc_tipo: string; doc_prefix: string | null; categoria: string | null; folio: string; fecha: string; monto: number; contraparte_code: string | null; contraparte_nombre: string | null; concepto: string | null; metodo: string | null }
interface CancResp { period: { from: string; to: string }; totals: { n: number }; by_categoria: Record<string, { n: number; monto: number }>; rows: CancRow[] }
interface Facets { meses: string[]; categorias: string[] }

const CAT_LABEL: Record<string, string> = { pago: 'Pago a proveedor', entrada: 'Orden de entrada', cobro: 'Cobro' };

/**
 * Documentos cancelados de Kepler (c43='C') — el apartado para AUDITAR lo que las vistas
 * derive-no-copy excluyen de los cuadres (pagos/entradas/cobros). Read-only, Operations mode.
 * OJO: Kepler pone el importe en $0 al cancelar → el monto suele venir en cero; lo que sirve
 * del apartado es saber QUÉ se canceló (folio/proveedor/fecha/concepto).
 */
@Component({
  selector: 'app-finanzas-cancelados',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ButtonModule, InputTextModule, IconFieldModule, InputIconModule, TableModule, SelectModule, TagModule, MetricStripComponent],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Documentos cancelados</h1>
          <p class="surf-page-sub">Los documentos de Kepler <b>cancelados</b> (<code>c43='C'</code>) que se excluyen de los cuadres de Caja y Bancos — pagos a proveedor, órdenes de entrada y cobros. Espejo read-only del ODS.</p>
        </div>
        <div class="cg-head-actions">
          <p-select [options]="f().meses" [ngModel]="month()" (onChange)="onMonth($event.value)" placeholder="Mes" styleClass="cg-sel" ariaLabel="Mes" />
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="loading()" (click)="reload()"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Actualizar</span></button>
        </div>
      </header>

      <div class="cg-filters">
        <p-select [options]="catOpts" optionLabel="label" optionValue="value" [ngModel]="categoria()" (onChange)="onCat($event.value)" placeholder="Categoría" [showClear]="true" styleClass="cg-sel" ariaLabel="Categoría" />
        <p-iconfield styleClass="cg-search"><p-inputicon styleClass="pi pi-search" /><input pInputText type="text" placeholder="Folio / proveedor / concepto…" [ngModel]="search()" (ngModelChange)="onSearch($event)" class="p-inputtext-sm" aria-label="Buscar" /></p-iconfield>
      </div>

      @if (err(); as e) { <div class="cg-errbox" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span class="cg-errbox-txt">{{ e }}</span><button pButton type="button" class="p-button-sm p-button-outlined" (click)="reload()" label="Reintentar"></button></div> }

      @if (loading() && !data()) { <div class="fb-skeleton" aria-busy="true">@for (i of skel; track i) { <div class="fb-skel-row"></div> }</div> }
      @else if (data(); as d) {
        <app-metric-strip [items]="kpis(d)" ariaLabel="Totales de cancelados" />
        <p-table [value]="d.rows" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="62vh" [paginator]="d.rows.length>200" [rows]="200">
          <ng-template #header><tr><th class="cg-w-date">Fecha</th><th class="cg-w-cat">Categoría</th><th class="cg-w-fol">Documento</th><th class="cg-w-suc">Suc</th><th>Contraparte</th><th>Concepto</th><th class="cg-w-met">Método</th><th class="ta-r cg-w-mon">Importe</th></tr></ng-template>
          <ng-template #body let-r>
            <tr>
              <td class="cg-mono">{{ dmy(r.fecha) }}</td>
              <td><p-tag [value]="catLabel(r.categoria)" [severity]="catSev(r.categoria)" styleClass="cg-tag" /></td>
              <td class="cg-mono">{{ r.doc_prefix || r.doc_tipo }} <span class="muted">{{ r.folio }}</span></td>
              <td class="cg-mono muted">{{ r.sucursal }}</td>
              <td class="cg-emp" [title]="r.contraparte_nombre">{{ r.contraparte_nombre || '—' }}@if (r.contraparte_code) { <span class="muted"> #{{ r.contraparte_code }}</span> }</td>
              <td class="cg-emp" [title]="r.concepto">{{ r.concepto || '—' }}</td>
              <td class="muted">{{ r.metodo || '—' }}</td>
              <td class="ta-r num" [class.muted]="!r.monto">{{ r.monto ? money(r.monto) : '$0' }}</td>
            </tr>
          </ng-template>
          <ng-template #emptymessage><tr><td colspan="8"><div class="cg-empty"><i class="pi pi-check-circle" aria-hidden="true"></i><span>Sin documentos cancelados en el periodo.</span></div></td></tr></ng-template>
        </p-table>
        <p class="cg-note">Kepler pone el importe en <b>cero</b> al cancelar, así que el <b>Importe</b> casi siempre sale en $0 — el valor de este apartado es saber <b>qué</b> se canceló (folio, proveedor, fecha), no cuánto. Estos documentos <b>no</b> cuentan en los cuadres.</p>
      }
    </div>
  `,
  styles: [FINANZAS_SHARED_STYLES, `
    :host { display:block; }
    .surf-page-head { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap; }
    .cg-head-actions { display:flex; gap:.5rem; align-items:center; }
    :host ::ng-deep .cg-sel { min-width:9rem; }
    .cg-filters { display:flex; flex-wrap:wrap; gap:.6rem; align-items:center; margin:.4rem 0 .6rem; }
    .cg-search input { min-width:220px; }
    app-metric-strip { display:block; margin:.6rem 0; }
    code { font-family:var(--font-mono); font-size:.9em; }
    .ta-r { text-align:right; }
    .num, .cg-mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .muted { color:var(--text-muted); }
    .cg-emp { max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .cg-w-date { width:6rem; } .cg-w-cat { width:9rem; } .cg-w-fol { width:9rem; } .cg-w-suc { width:3.4rem; } .cg-w-met { width:7rem; } .cg-w-mon { width:7rem; }
    :host ::ng-deep .cg-tag { font-size:.64rem; }
    .cg-note { margin-top:.6rem; font-size:.74rem; color:var(--text-faint); line-height:1.5; }
    .cg-errbox { display:flex; align-items:center; gap:.6rem; padding:.7rem .85rem; margin:.2rem 0 .6rem; border:1px solid var(--border-color); border-left:3px solid var(--bad-fg); border-radius:var(--r-md); background:var(--card-bg); }
    .cg-errbox .pi { color:var(--bad-fg); } .cg-errbox-txt { flex:1; font-size:.84rem; }
    .cg-empty { display:flex; flex-direction:column; align-items:center; gap:var(--sp-2); padding:var(--sp-8); text-align:center; color:var(--text-muted); }
    .cg-empty .pi { font-size:1.5rem; color:var(--ok-fg); }
  `],
})
export class FinanzasCanceladosComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly base = `${environment.apiUrl}/finance/cancelled-docs`;

  readonly skel = Array.from({ length: 8 });
  readonly catOpts = [
    { label: 'Pago a proveedor', value: 'pago' },
    { label: 'Orden de entrada', value: 'entrada' },
    { label: 'Cobro', value: 'cobro' },
  ];
  readonly f = signal<Facets>({ meses: [], categorias: [] });
  readonly month = signal<string | null>(null);
  readonly categoria = signal<string | null>(null);
  readonly search = signal('');
  readonly loading = signal(false);
  readonly err = signal<string | null>(null);
  readonly data = signal<CancResp | null>(null);
  private searchTimer: any;

  readonly money = money;
  readonly dmy = dmy;

  ngOnInit(): void {
    this.http.get<Facets>(`${this.base}/facets`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (f) => { this.f.set(f); if (f.meses?.length) this.month.set(f.meses[0]); this.reload(); },
      error: () => { this.err.set('No se pudieron cargar los filtros.'); this.reload(); },
    });
  }

  onMonth(v: string | null): void { this.month.set(v); this.data.set(null); this.reload(); }
  onCat(v: string | null): void { this.categoria.set(v); this.reload(); }
  onSearch(v: string): void { this.search.set(v); if (this.searchTimer) clearTimeout(this.searchTimer); this.searchTimer = setTimeout(() => this.reload(), 320); }

  reload(): void {
    this.loading.set(true); this.err.set(null);
    const p = new URLSearchParams();
    if (this.month()) p.set('month', this.month()!);
    if (this.categoria()) p.set('categoria', this.categoria()!);
    if (this.search().trim()) p.set('search', this.search().trim());
    const qs = p.toString() ? `?${p.toString()}` : '';
    this.http.get<CancResp>(`${this.base}${qs}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.data.set(d); this.loading.set(false); },
      error: () => { this.loading.set(false); this.err.set('No se pudieron cargar los cancelados.'); },
    });
  }

  kpis(d: CancResp): MetricStripItem[] {
    const c = d.by_categoria || {};
    return [
      { label: 'Cancelados', value: d.totals.n, format: 'number', tone: 'default', sub: 'en el periodo' },
      { label: 'Pagos', value: c['pago']?.n || 0, format: 'number', tone: 'default' },
      { label: 'Entradas', value: c['entrada']?.n || 0, format: 'number', tone: 'default' },
      { label: 'Cobros', value: c['cobro']?.n || 0, format: 'number', tone: 'default' },
    ];
  }
  catLabel(c: string | null): string { return c ? (CAT_LABEL[c] || c) : '—'; }
  catSev(c: string | null): 'warn' | 'info' | 'success' | 'secondary' { return c === 'pago' ? 'warn' : c === 'entrada' ? 'info' : c === 'cobro' ? 'success' : 'secondary'; }
}
