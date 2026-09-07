import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { TableModule } from 'primeng/table';
import { CheckboxModule } from 'primeng/checkbox';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { SkeletonModule } from 'primeng/skeleton';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { DATE_PRESET_OPTIONS, datePresetRange } from '../../../shared/util';
import { ComprasService, LandedCostResponse } from '../compras.service';

/**
 * CXP.4 — "Costo neto" (landed cost) por proveedor. El costo REAL de comprarle a cada
 * proveedor = compras − descuentos efectivos (pronto pago c84 + notas comerciales). Le
 * dice al comprador que su costo con X es ~rate% menor que la lista → decidir el reabasto
 * con el costo verdadero, no el bruto. Read-only sobre analytics.*. Operations, PrimeNG-first.
 */
@Component({
  selector: 'app-compras-costo-neto',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule, FormsModule, RouterLink, ButtonModule, InputTextModule, IconFieldModule, InputIconModule,
    TableModule, CheckboxModule, SelectModule, DatePickerModule, SkeletonModule, MetricStripComponent, ContextHelpComponent,
  ],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1 style="display:inline-flex;align-items:center;gap:.4rem">Costo por proveedor <app-context-help topic="compras-costo-neto" /></h1>
          <p class="surf-page-sub">Tu <strong>costo neto</strong> con cada proveedor = compras − descuentos efectivos (pronto pago + notas comerciales). El reabasto debería decidirse con este costo, no con el de lista. Compra por compra, en <a routerLink="/compras/compras-360">Costo por compra</a>.</p>
        </div>
        <div class="cn-head-actions">
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="loading()" (click)="reload()"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Actualizar</span></button>
        </div>
      </header>

      <div class="cn-filters">
        <p-iconfield styleClass="cn-search">
          <p-inputicon styleClass="pi pi-search" />
          <input pInputText type="text" placeholder="Proveedor…" [ngModel]="search()" (ngModelChange)="onSearch($event)" class="p-inputtext-sm" aria-label="Buscar proveedor" />
        </p-iconfield>
        <p-select [options]="presetOpts" [ngModel]="preset()" (onChange)="onPreset($event.value)" optionLabel="label" optionValue="value" placeholder="Rango rápido" [showClear]="true" styleClass="cn-sel" ariaLabel="Rango de fecha rápido" appendTo="body" />
        <p-datepicker [ngModel]="dateFrom()" (onSelect)="onDate('from', $event)" (onClear)="onDate('from', null)" dateFormat="yy-mm-dd" [showIcon]="true" [showClear]="true" appendTo="body" placeholder="Desde" styleClass="cn-dp" ariaLabel="Desde" />
        <p-datepicker [ngModel]="dateTo()" (onSelect)="onDate('to', $event)" (onClear)="onDate('to', null)" dateFormat="yy-mm-dd" [showIcon]="true" [showClear]="true" appendTo="body" placeholder="Hasta" styleClass="cn-dp" ariaLabel="Hasta" />
        <label class="cn-chk"><p-checkbox [ngModel]="soloRelevantes()" (ngModelChange)="onToggleRelevantes($event)" [binary]="true" inputId="cn-rel" /> <span>Solo ≥ $100k</span></label>
        <label class="cn-chk"><p-checkbox [ngModel]="soloAnomalos()" (ngModelChange)="onToggleAnomalos($event)" [binary]="true" inputId="cn-anom" /> <span>Solo anómalos ⚠</span></label>
      </div>

      @if (err(); as e) {
        <div class="cn-errbox" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span class="cn-errbox-txt">{{ e }}</span>
          <button pButton type="button" class="p-button-sm p-button-outlined" (click)="retry()" label="Reintentar"></button>
        </div>
      }

      @if (data(); as d) {
        <app-metric-strip [items]="kpiItems(d)" ariaLabel="Costo neto total" />
      }

      @if (loading()) {
        <div class="cn-skel">
          @for (i of skelRows; track i) { <p-skeleton height="2rem" styleClass="cn-skel-row" /> }
        </div>
      } @else if (data(); as d) {
        <p-table [value]="d.rows" [loading]="false" styleClass="p-datatable-sm surf-table surf-table--sticky cn-table"
                 [rowHover]="true" [scrollable]="true" scrollHeight="flex">
          <ng-template #header>
            <tr>
              <th>Proveedor</th>
              <th class="ta-r cn-w-amt">Compras (bruto)</th>
              <th class="ta-r cn-w-amt">Descuento efectivo</th>
              <th class="ta-r cn-w-pct">%</th>
              <th class="ta-r cn-w-amt">Costo neto</th>
            </tr>
          </ng-template>
          <ng-template #body let-r>
            <tr class="cn-row" [class.is-anom]="r.anomalo" role="button" tabindex="0"
                [attr.aria-label]="'Ver descuentos y ajustes de ' + (r.proveedor_nombre || r.proveedor_code || '')"
                (click)="drillToDescuentos(r)"
                (keydown.enter)="drillToDescuentos(r)"
                (keydown.space)="$event.preventDefault(); drillToDescuentos(r)">
              <td class="cn-prov" [title]="r.proveedor_nombre">{{ r.proveedor_nombre || r.proveedor_code || '—' }} <span class="cn-drillhint" aria-hidden="true">→ descuentos</span></td>
              <td class="ta-r cn-num">{{ money(r.compras) }}</td>
              <td class="ta-r cn-num" [class.cn-pos]="r.descuento > 0">{{ r.descuento > 0 ? '−' + money(r.descuento) : '—' }}</td>
              <td class="ta-r cn-num">
                <span [class.cn-anom]="r.anomalo">{{ pct(r.rate) }}</span>
                @if (r.anomalo) { <i class="pi pi-exclamation-triangle cn-warn" title="Tasa alta (>20%): probablemente incluye devoluciones/errores, no solo descuento"></i><span class="cn-sr">tasa anómala, revisar</span> }
              </td>
              <td class="ta-r cn-num cn-strong">{{ money(r.costo_neto) }}</td>
            </tr>
          </ng-template>
          <ng-template #emptymessage>
            <tr><td colspan="5">
              <div class="cn-empty-op">
                <i class="pi pi-inbox" aria-hidden="true"></i>
                <span class="cn-empty-op-title">Sin proveedores</span>
                @if (hasFilters()) {
                  <span class="cn-empty-op-sub">Ningún proveedor coincide con los filtros actuales.</span>
                  <button pButton type="button" class="p-button-sm p-button-outlined" (click)="clearFilters()" label="Quitar filtros"></button>
                } @else {
                  <span class="cn-empty-op-sub">No hay proveedores con compras en el periodo (o falta el feed).</span>
                }
              </div>
            </td></tr>
          </ng-template>
        </p-table>
        <p class="cn-foot">Muestra los {{ d.rows.length }} proveedores con más compras. El <b>%</b> con ⚠ (&gt;20%) probablemente incluye devoluciones o errores de captura, no solo descuento — revisar antes de usarlo como costo. Para reabasto: costo real ≈ costo de lista × (1 − %).</p>
      }
    </div>
  `,
  styles: [`
    :host { display:block; }
    .surf-page-head { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap; }
    .cn-head-actions { display:flex; gap:.5rem; }
    .cn-filters { display:flex; flex-wrap:wrap; gap:.8rem; align-items:center; margin:1rem 0 .6rem; }
    .cn-search input { min-width:220px; }
    :host ::ng-deep .cn-sel { min-width:11rem; }
    .cn-chk { display:inline-flex; align-items:center; gap:.45rem; font-size:.8rem; color:var(--text-muted); cursor:pointer; }
    .cn-table { margin-top:.6rem; }
    .cn-row { cursor:pointer; }
    .cn-row:focus-visible { outline:2px solid var(--action-ring); outline-offset:-2px; }
    /* fila anómala = señalar la fila exacta (punto 15) */
    .cn-row.is-anom > td:first-child { box-shadow:inset 3px 0 0 var(--warn-fg); }
    .ta-r { text-align:right; }
    .cn-num { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .cn-strong { font-weight:700; }
    .cn-pos { color:var(--ok-fg); }
    .cn-anom { color:var(--warn-fg); font-weight:700; }
    .cn-warn { color:var(--warn-fg); margin-left:.3rem; font-size:.75rem; }
    .cn-w-amt { width:9rem; } .cn-w-pct { width:6rem; }
    .cn-prov { max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .cn-drillhint { font-size:.72rem; color:var(--text-faint); margin-left:.35rem; }
    /* solo lectores de pantalla (el ⚠ es visual; el texto lo hace accesible) */
    .cn-sr { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
    .cn-empty { padding:1.4rem; text-align:center; color:var(--text-faint); font-size:.85rem; }
    .cn-foot { margin-top:1.2rem; font-size:.74rem; color:var(--text-faint); line-height:1.55; }
    /* error de red (banner + reintento) — Empty ≠ error */
    .cn-errbox { display:flex; align-items:center; gap:.6rem; padding:.7rem .85rem; margin:.2rem 0 .6rem; border:1px solid var(--bad-border, var(--border-color)); border-left:3px solid var(--bad-fg); border-radius:var(--r-md); background:var(--card-bg); }
    .cn-errbox .pi { color:var(--bad-fg); }
    .cn-errbox-txt { flex:1; font-size:.84rem; color:var(--text-main); }
    /* empty operacional: icono + título + microcopy + CTA */
    .cn-empty-op { display:flex; flex-direction:column; align-items:center; gap:.4rem; padding:2.4rem 1rem; text-align:center; }
    .cn-empty-op .pi { font-size:1.6rem; color:var(--text-faint); }
    .cn-empty-op-title { font-weight:600; color:var(--text-main); }
    .cn-empty-op-sub { font-size:.84rem; color:var(--text-muted); max-width:32rem; }
    /* skeleton de carga */
    .cn-skel { display:flex; flex-direction:column; gap:.4rem; margin-top:1.2rem; padding:.3rem 0; }
    app-metric-strip { display:block; margin:.9rem 0; }
  `],
})
export class ComprasCostoNetoComponent implements OnInit {
  private readonly svc = inject(ComprasService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly data = signal<LandedCostResponse | null>(null);
  readonly loading = signal(false);
  /** Error de red (banner + reintento). Empty ≠ error. */
  readonly err = signal<string | null>(null);
  readonly search = signal('');
  readonly soloRelevantes = signal(true);
  readonly soloAnomalos = signal(false);
  readonly dateFrom = signal<Date | null>(null);
  readonly dateTo = signal<Date | null>(null);
  readonly preset = signal<string>('');
  readonly presetOpts = DATE_PRESET_OPTIONS;
  private searchTimer: any;

  /** Filas skeleton mientras carga la tabla. */
  readonly skelRows = Array.from({ length: 8 });

  ngOnInit(): void {
    // Estado en URL: rehidratar filtros (F5 y deep-link).
    const q = this.route.snapshot.queryParamMap;
    this.search.set(q.get('q') || '');
    // ?all=1 → mostrar todos (sin el piso de $100k). Ausente = default (solo ≥$100k).
    this.soloRelevantes.set(q.get('all') !== '1');
    this.soloAnomalos.set(q.get('anom') === '1');
    this.dateFrom.set(this.fromIso(q.get('from')));
    this.dateTo.set(this.fromIso(q.get('to')));
    this.reload();
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

  reload(): void {
    this.loading.set(true); this.err.set(null);
    this.svc.landedCost({
      search: this.search() || undefined,
      min_compras: this.soloRelevantes() ? 100000 : undefined,
      date_from: this.toIso(this.dateFrom()),
      date_to: this.toIso(this.dateTo()),
      only_anomalo: this.soloAnomalos() || undefined,
    })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (d) => { this.data.set(d); this.loading.set(false); },
        error: () => { this.loading.set(false); this.err.set('No se pudo cargar el costo neto por proveedor.'); },
      });
  }

  /** Reintento del banner de error. */
  retry(): void { this.err.set(null); this.reload(); }

  /** Refleja filtros en la URL (replaceUrl → no ensucia el historial). */
  private syncUrl(): void {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        q: this.search().trim() || null,
        all: this.soloRelevantes() ? null : '1',
        anom: this.soloAnomalos() ? '1' : null,
        from: this.toIso(this.dateFrom()) || null,
        to: this.toIso(this.dateTo()) || null,
      },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  onSearch(v: string): void {
    this.search.set(v);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => { this.syncUrl(); this.reload(); }, 320);
  }

  onToggleRelevantes(v: boolean): void { this.soloRelevantes.set(v); this.syncUrl(); this.reload(); }
  onToggleAnomalos(v: boolean): void { this.soloAnomalos.set(v); this.syncUrl(); this.reload(); }

  onDate(which: 'from' | 'to', v: Date | null): void {
    (which === 'from' ? this.dateFrom : this.dateTo).set(v);
    this.preset.set(''); // cambio manual de fecha → deja de ser un preset
    this.syncUrl(); this.reload();
  }

  /** Rango rápido: fija Desde/Hasta según el preset. */
  onPreset(key: string | null): void {
    this.preset.set(key || '');
    const r = key ? datePresetRange(key) : null;
    if (!r) return;
    this.dateFrom.set(r.from); this.dateTo.set(r.to);
    this.syncUrl(); this.reload();
  }

  hasFilters(): boolean { return !!(this.search().trim() || !this.soloRelevantes() || this.soloAnomalos() || this.dateFrom() || this.dateTo()); }

  clearFilters(): void {
    this.search.set(''); this.soloRelevantes.set(true); this.soloAnomalos.set(false);
    this.dateFrom.set(null); this.dateTo.set(null); this.preset.set('');
    this.syncUrl(); this.reload();
  }

  /** Q.4 — navega a Descuentos filtrando por el proveedor (donde vive el detalle que explica el %). */
  drillToDescuentos(r: { proveedor_nombre?: string | null; proveedor_code?: string | null }): void {
    const prov = r.proveedor_nombre || r.proveedor_code || '';
    this.router.navigate(['/compras/descuentos'], { queryParams: { q: prov } });
  }

  kpiItems(d: LandedCostResponse): MetricStripItem[] {
    return [
      { label: 'Compras (bruto)', value: d.summary.compras, format: 'currency-short', tone: 'default' },
      { label: 'Descuento efectivo', value: d.summary.descuento, format: 'currency-short', tone: 'ok' },
      { label: 'Costo neto', value: d.summary.costo_neto, format: 'currency-short', tone: 'brand' },
      { label: 'Tasa efectiva', value: d.summary.rate * 100, format: 'decimal1', tone: 'default', sub: `${d.summary.suppliers} proveedor(es)` },
    ];
  }

  money(n: number): string { return Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  pct(r: number): string { return (Number(r || 0) * 100).toFixed(1) + '%'; }
}
