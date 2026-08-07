import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { TableModule } from 'primeng/table';
import { SkeletonModule } from 'primeng/skeleton';
import { TagModule } from 'primeng/tag';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { ComprasService, ContpaqiPayablesResponse } from '../compras.service';

/**
 * CXP.10 — "Deuda a proveedores (ContPAQi)": lo que se le debe a cada proveedor según el SoR
 * fiscal, tomado de la BALANZA (`contpaqi_ledger_monthly`, con saldo de apertura). saldo = lo que
 * se debe. `stale` = saldo viejo sin movimiento reciente (aging). Clic en una fila → cuadre 3-vías.
 * Read-only. Operations mode, PrimeNG-first.
 */
@Component({
  selector: 'app-compras-deuda-contpaqi',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule, FormsModule, ButtonModule, InputTextModule, IconFieldModule, InputIconModule,
    TableModule, SkeletonModule, TagModule, MetricStripComponent,
  ],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Deuda a proveedores (ContPAQi)</h1>
          <p class="surf-page-sub">Lo que se le debe a cada proveedor según los <b>libros fiscales de ContPAQi</b> (saldo real de la cuenta 201/2120 Proveedores, con saldo de apertura). @if (data(); as d) { <span class="dc-asof">al cierre de {{ d.as_of }}</span> }</p>
        </div>
        <div class="dc-head-actions">
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="loading()" (click)="reload()"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Actualizar</span></button>
        </div>
      </header>

      <div class="dc-filters">
        <p-iconfield styleClass="dc-search">
          <p-inputicon styleClass="pi pi-search" />
          <input pInputText type="text" placeholder="Proveedor…" [ngModel]="search()" (ngModelChange)="onSearch($event)" class="p-inputtext-sm" aria-label="Buscar proveedor" />
        </p-iconfield>
        <button pButton type="button" class="p-button-sm" [class.p-button-outlined]="!onlyStale()" (click)="toggleStale()">
          <span class="pi pi-clock" aria-hidden="true"></span>&nbsp;Solo saldos viejos
        </button>
        @if (hasFilters()) {
          <button pButton type="button" class="p-button-sm p-button-text" (click)="clearFilters()"><span class="pi pi-filter-slash" aria-hidden="true"></span>&nbsp;Limpiar</button>
        }
      </div>

      @if (err(); as e) {
        <div class="dc-errbox" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span class="dc-errbox-txt">{{ e }}</span>
          <button pButton type="button" class="p-button-sm p-button-outlined" (click)="reload()" label="Reintentar"></button>
        </div>
      }

      @if (data(); as d) {
        <app-metric-strip [items]="kpiItems(d)" ariaLabel="Totales de deuda a proveedores ContPAQi" />
      }

      @if (loading()) {
        <div class="dc-skel">
          @for (i of skelRows; track i) { <p-skeleton height="2rem" styleClass="dc-skel-row" /> }
        </div>
      } @else if (data(); as d) {
        <p-table [value]="d.rows" styleClass="p-datatable-sm surf-table surf-table--sticky dc-table"
                 [rowHover]="true" [scrollable]="true" scrollHeight="flex" [paginator]="d.rows.length > 100" [rows]="100">
          <ng-template #header>
            <tr>
              <th>Proveedor</th>
              <th class="ta-r dc-w-amt">Se debe</th>
              <th class="dc-w-mes">Último mov.</th>
            </tr>
          </ng-template>
          <ng-template #body let-r>
            <tr class="dc-row" role="button" tabindex="0"
                [attr.aria-label]="'Ver cuadre de ' + (r.proveedor || 'proveedor')"
                (click)="openCuadre(r)" (keydown.enter)="openCuadre(r)">
              <td class="dc-prov" [title]="r.proveedor">{{ r.proveedor || '—' }} <span class="dc-drillhint" aria-hidden="true">→ cuadre</span></td>
              <td class="ta-r dc-num" [class.dc-neg]="r.saldo < 0">{{ money(r.saldo) }}</td>
              <td class="dc-w-mes">
                <span class="dc-mono muted">{{ r.hasta }}</span>
                @if (r.stale) { <p-tag value="viejo" severity="warn" styleClass="dc-tag" /> }
              </td>
            </tr>
          </ng-template>
          <ng-template #emptymessage>
            <tr><td colspan="3">
              <div class="dc-empty">
                <i class="pi pi-inbox" aria-hidden="true"></i>
                <span class="dc-empty-title">Sin saldos</span>
                @if (hasFilters()) {
                  <span class="dc-empty-sub">Ningún proveedor coincide con los filtros.</span>
                  <button pButton type="button" class="p-button-sm p-button-outlined" (click)="clearFilters()" label="Quitar filtros"></button>
                } @else {
                  <span class="dc-empty-sub">No hay saldos de proveedores en ContPAQi (o falta cargar la balanza en este entorno).</span>
                }
              </div>
            </td></tr>
          </ng-template>
        </p-table>
        <p class="dc-foot">Saldo <b>acreedor</b> de la cuenta de proveedores en la balanza de ContPAQi = <b>lo que se debe</b> (apertura del ejercicio + Σ facturado − pagado del año). Un saldo <b class="dc-neg">negativo</b> = pagado de más / saldo a favor. <b>Viejo</b> = sin movimiento en el último mes cargado (saldo colgado, posible antigüedad a revisar). Clic en una fila para ver el cuadre 3-vías (Kepler operativo / contable 201 / ContPAQi). Consolidado fiscal; no atado al peso con la operación de Kepler.</p>
      }
    </div>
  `,
  styles: [`
    :host { display:block; }
    .surf-page-head { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap; }
    .dc-asof { color:var(--text-faint); }
    .dc-head-actions { display:flex; gap:.5rem; }
    .dc-filters { display:flex; flex-wrap:wrap; gap:.6rem; align-items:center; margin:1rem 0 .6rem; }
    .dc-search input { min-width:240px; }
    .dc-table { margin-top:.6rem; }
    .dc-row { cursor:pointer; }
    .dc-row:focus-visible { outline:2px solid var(--action-ring); outline-offset:-2px; }
    .dc-drillhint { font-size:.72rem; color:var(--text-faint); margin-left:.35rem; }
    .ta-r { text-align:right; }
    .dc-num { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; font-weight:600; }
    .dc-neg { color:var(--ok-fg); }
    .dc-mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; }
    .muted { color:var(--text-faint); }
    .dc-w-amt { width:10rem; } .dc-w-mes { width:9rem; }
    .dc-prov { max-width:420px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    :host ::ng-deep .dc-tag { font-size:.62rem; margin-left:.4rem; }
    .dc-foot { margin-top:1.2rem; font-size:.74rem; color:var(--text-faint); line-height:1.55; }
    .dc-errbox { display:flex; align-items:center; gap:.6rem; padding:.7rem .85rem; margin:.2rem 0 .6rem; border:1px solid var(--border-color); border-left:3px solid var(--bad-fg); border-radius:var(--r-md); background:var(--card-bg); }
    .dc-errbox .pi { color:var(--bad-fg); } .dc-errbox-txt { flex:1; font-size:.84rem; }
    .dc-empty { display:flex; flex-direction:column; align-items:center; gap:.4rem; padding:2.4rem 1rem; text-align:center; }
    .dc-empty .pi { font-size:1.6rem; color:var(--text-faint); }
    .dc-empty-title { font-weight:600; color:var(--text-main); } .dc-empty-sub { font-size:.84rem; color:var(--text-muted); max-width:32rem; }
    .dc-skel { display:flex; flex-direction:column; gap:.4rem; margin-top:1.2rem; }
    app-metric-strip { display:block; margin:.9rem 0; }
  `],
})
export class ComprasDeudaContpaqiComponent implements OnInit {
  private readonly svc = inject(ComprasService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);

  readonly data = signal<ContpaqiPayablesResponse | null>(null);
  readonly loading = signal(false);
  readonly err = signal<string | null>(null);
  readonly search = signal('');
  readonly onlyStale = signal(false);
  private searchTimer: any;
  readonly skelRows = Array.from({ length: 10 });

  ngOnInit(): void { this.reload(); }

  reload(): void {
    this.loading.set(true); this.err.set(null);
    this.svc.contpaqiPayables({ search: this.search() || undefined, only_stale: this.onlyStale() })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (d) => { this.data.set(d); this.loading.set(false); },
        error: () => { this.loading.set(false); this.err.set('No se pudo cargar la deuda de ContPAQi.'); },
      });
  }

  onSearch(v: string): void {
    this.search.set(v);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.reload(), 320);
  }
  toggleStale(): void { this.onlyStale.set(!this.onlyStale()); this.reload(); }
  hasFilters(): boolean { return !!(this.search().trim() || this.onlyStale()); }
  clearFilters(): void { this.search.set(''); this.onlyStale.set(false); this.reload(); }

  /** Abre el cuadre 3-vías del proveedor (busca por su primera palabra distintiva para tolerar grafía). */
  openCuadre(r: { proveedor: string | null }): void {
    const q = (r.proveedor || '').split(/\s+/).find((w) => w.replace(/[^A-Za-z0-9]/g, '').length >= 4) || r.proveedor || '';
    this.router.navigate(['/compras/cuadre-proveedor'], { queryParams: { q } });
  }

  kpiItems(d: ContpaqiPayablesResponse): MetricStripItem[] {
    return [
      { label: 'Se debe (total)', value: d.total_debe, format: 'currency-short', tone: 'brand', sub: `${d.n} proveedor(es)` },
      { label: 'Saldo a favor', value: Math.abs(d.total_favor), format: 'currency-short', tone: 'ok' },
      { label: 'Saldos viejos', value: d.n_stale, format: 'number', tone: 'warn', sub: 'sin mov. reciente' },
    ];
  }

  money(n: number): string { return Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
}
