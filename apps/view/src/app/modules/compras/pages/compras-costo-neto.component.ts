import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { ComprasService, LandedCostResponse } from '../compras.service';

/**
 * CXP.4 — "Costo neto" (landed cost) por proveedor. El costo REAL de comprarle a cada
 * proveedor = compras − descuentos efectivos (pronto pago c84 + notas comerciales). Le
 * dice al comprador que su costo con X es ~rate% menor que la lista → decidir el reabasto
 * con el costo verdadero, no el bruto. Read-only sobre analytics.*. Operations mode.
 */
@Component({
  selector: 'app-compras-costo-neto',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ButtonModule, InputTextModule, MetricStripComponent],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Costo neto por proveedor</h1>
          <p class="surf-page-sub">Tu costo REAL con cada proveedor = compras − descuentos efectivos (pronto pago + notas comerciales). El reabasto debería decidirse con este costo, no con el de lista.</p>
        </div>
        <div class="cn-head-actions">
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="loading()" (click)="reload()"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Actualizar</span></button>
        </div>
      </header>

      <div class="cn-filters">
        <span class="p-input-icon-left cn-search">
          <i class="pi pi-search" aria-hidden="true"></i>
          <input pInputText type="text" placeholder="Proveedor…" [ngModel]="search()" (ngModelChange)="onSearch($event)" class="p-inputtext-sm" />
        </span>
        <label class="cn-chk"><input type="checkbox" [ngModel]="soloRelevantes()" (ngModelChange)="soloRelevantes.set($event); reload()" /> Solo con compras ≥ $100k</label>
      </div>

      @if (data(); as d) {
        <app-metric-strip [items]="kpiItems(d)" ariaLabel="Costo neto total" />

        <div class="cn-tablewrap">
          <table class="cn-table">
            <thead>
              <tr>
                <th>Proveedor</th>
                <th class="ta-r">Compras (bruto)</th>
                <th class="ta-r">Descuento efectivo</th>
                <th class="ta-r">%</th>
                <th class="ta-r">Costo neto</th>
              </tr>
            </thead>
            <tbody>
              @for (r of d.rows; track r.proveedor_code) {
                <tr>
                  <td class="cn-prov" [title]="r.proveedor_nombre">{{ r.proveedor_nombre || r.proveedor_code || '—' }}</td>
                  <td class="ta-r cn-num">{{ money(r.compras) }}</td>
                  <td class="ta-r cn-num" [class.cn-pos]="r.descuento > 0">{{ r.descuento > 0 ? '−' + money(r.descuento) : '—' }}</td>
                  <td class="ta-r cn-num">
                    <span [class.cn-anom]="r.anomalo">{{ pct(r.rate) }}</span>
                    @if (r.anomalo) { <i class="pi pi-exclamation-triangle cn-warn" title="Tasa alta (>20%): probablemente incluye devoluciones/errores, no solo descuento" aria-hidden="true"></i> }
                  </td>
                  <td class="ta-r cn-num cn-strong">{{ money(r.costo_neto) }}</td>
                </tr>
              } @empty {
                <tr><td colspan="5" class="cn-empty">Sin proveedores con compras (o falta el feed).</td></tr>
              }
            </tbody>
          </table>
        </div>
        <p class="cn-foot">Muestra los {{ d.rows.length }} proveedores con más compras. El <b>%</b> con ⚠ (&gt;20%) probablemente incluye devoluciones o errores de captura, no solo descuento — revisar antes de usarlo como costo. Para reabasto: costo real ≈ costo de lista × (1 − %).</p>
      } @else if (loading()) {
        <p class="cn-empty" style="margin-top:1.2rem">Cargando…</p>
      }
    </div>
  `,
  styles: [`
    :host { display:block; }
    .cn-head-actions { display:flex; gap:.5rem; }
    .cn-filters { display:flex; flex-wrap:wrap; gap:.8rem; align-items:center; margin:1rem 0 .4rem; }
    .cn-search input { min-width:220px; }
    .cn-chk { display:inline-flex; align-items:center; gap:.4rem; font-size:.8rem; color:var(--text-muted); cursor:pointer; }
    .cn-tablewrap { overflow-x:auto; margin-top:1.2rem; border:1px solid var(--border-color); border-radius:var(--radius-md,8px); }
    .cn-table { width:100%; border-collapse:collapse; font-size:.82rem; }
    .cn-table thead th { text-align:left; font-size:.68rem; font-weight:600; text-transform:uppercase; letter-spacing:.05em; color:var(--text-muted); padding:.55rem .7rem; border-bottom:1px solid var(--border-color); white-space:nowrap; }
    .cn-table tbody td { padding:.5rem .7rem; border-bottom:1px solid var(--border-color); color:var(--text-main); }
    .cn-table tbody tr:last-child td { border-bottom:none; }
    .cn-table tbody tr:hover td { background:var(--overlay-hover,color-mix(in srgb,var(--border-color) 25%,transparent)); }
    .ta-r { text-align:right; }
    .cn-num { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .cn-strong { font-weight:700; }
    .cn-pos { color:var(--ok-fg); }
    .cn-anom { color:var(--warn-fg); font-weight:700; }
    .cn-warn { color:var(--warn-fg); margin-left:.3rem; font-size:.75rem; }
    .cn-prov { max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .cn-empty { padding:1.4rem; text-align:center; color:var(--text-faint); font-size:.85rem; }
    .cn-foot { margin-top:1.2rem; font-size:.74rem; color:var(--text-faint); line-height:1.55; }
  `],
})
export class ComprasCostoNetoComponent implements OnInit {
  private readonly svc = inject(ComprasService);
  readonly data = signal<LandedCostResponse | null>(null);
  readonly loading = signal(false);
  readonly search = signal('');
  readonly soloRelevantes = signal(true);
  private searchTimer: any;

  ngOnInit(): void { this.reload(); }

  reload(): void {
    this.loading.set(true);
    this.svc.landedCost({ search: this.search() || undefined, min_compras: this.soloRelevantes() ? 100000 : undefined }).subscribe({
      next: (d) => { this.data.set(d); this.loading.set(false); },
      error: () => { this.loading.set(false); },
    });
  }

  onSearch(v: string): void {
    this.search.set(v);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.reload(), 320);
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
