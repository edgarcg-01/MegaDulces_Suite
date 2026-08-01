import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ComercialService, RouteClosureReconciliation, RouteClosureIncidencia } from '../comercial.service';

/**
 * RR — Panel de incidencias de CIERRE DE RUTA (histórico D+1). Cruza el corte que
 * sube el vendedor (route_tickets, venta) contra la venta REAL por ruta (Wincaja +
 * Kepler PH). Colapsable, se inserta en /comercial/ventas-por-ruta. Solo lectura.
 */
@Component({
  selector: 'app-route-closure-recon',
  standalone: true,
  imports: [FormsModule],
  template: `
    <section class="rc-panel">
      <button type="button" class="rc-head" (click)="toggle()" [attr.aria-expanded]="open()">
        <i class="pi" [class.pi-chevron-right]="!open()" [class.pi-chevron-down]="open()" aria-hidden="true"></i>
        <span class="rc-title">Incidencias de cierre de ruta</span>
        @if (data(); as d) {
          <span class="rc-badges">
            @if (d.summary.descuadre) { <span class="rc-badge bad">{{ d.summary.descuadre }} descuadre</span> }
            @if (d.summary.cierre_faltante) { <span class="rc-badge warn">{{ d.summary.cierre_faltante }} sin cierre</span> }
            @if (d.summary.cierre_sin_venta) { <span class="rc-badge info">{{ d.summary.cierre_sin_venta }} sin venta</span> }
            @if (!total(d)) { <span class="rc-badge ok">sin incidencias</span> }
          </span>
        }
        <span class="rc-hint">corte del vendedor vs venta real · D+1</span>
      </button>

      @if (open()) {
        <div class="rc-body">
          <div class="rc-filters">
            <label>Desde <input type="date" [ngModel]="from()" (ngModelChange)="from.set($event); reload()" [max]="to()" /></label>
            <label>Hasta <input type="date" [ngModel]="to()" (ngModelChange)="to.set($event); reload()" [max]="today" /></label>
            @if (loading()) { <span class="rc-muted">cargando…</span> }
            @if (data(); as d) { <span class="rc-muted">{{ d.summary.routes }} rutas · real {{ money(d.summary.real_total) }} · cortes {{ money(d.summary.corte_total) }}</span> }
          </div>

          @if (data(); as d) {
            @if (d.incidencias.length) {
              <div class="rc-table-wrap">
                <table class="rc-table">
                  <thead><tr><th>Ruta</th><th>Fecha</th><th class="num">Venta real</th><th class="num">Corte vendedor</th><th class="num">Δ</th><th>Estado</th></tr></thead>
                  <tbody>
                    @for (i of d.incidencias; track i.route_no + '|' + i.date) {
                      <tr>
                        <td class="rc-route">R-{{ i.route_no }}</td>
                        <td class="rc-mono">{{ i.date }}</td>
                        <td class="num rc-mono">{{ i.real_revenue ? money(i.real_revenue) : '—' }}</td>
                        <td class="num rc-mono">{{ i.corte ? money(i.corte) : '—' }}</td>
                        <td class="num rc-mono" [class.neg]="i.diff < 0" [class.pos]="i.diff > 0">{{ i.corte && i.real_revenue ? money(i.diff) : '—' }}@if (i.diff_pct != null && i.corte && i.real_revenue) { <span class="rc-pct"> ({{ i.diff_pct }}%)</span> }</td>
                        <td><span class="rc-chip" [class]="i.status">{{ label(i) }}</span></td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
              <p class="rc-legend">
                <span class="rc-chip descuadre">descuadre</span> corte ≠ venta real ·
                <span class="rc-chip cierre_faltante">sin cierre</span> hubo venta, el vendedor no cerró ·
                <span class="rc-chip cierre_sin_venta">sin venta</span> cerró pero no hay venta real
              </p>
            } @else if (!loading()) {
              <p class="rc-empty">Sin incidencias en el periodo. Nota: los cierres los sube el vendedor (app), por eso puede estar casi vacío.</p>
            }
          } @else if (errored()) {
            <p class="rc-empty">No se pudo cargar la conciliación.</p>
          }
        </div>
      }
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display:block; }
    .rc-panel { border:1px solid var(--border-color); border-radius:var(--r-md,8px); margin-bottom:1rem; overflow:hidden; }
    .rc-head { width:100%; display:flex; align-items:center; gap:.5rem; padding:.6rem .8rem; border:0; background:var(--card-bg); font:inherit; cursor:pointer; text-align:left; }
    .rc-head:hover { background:var(--overlay-hover); }
    .rc-title { font-weight:var(--fw-bold); font-size:var(--fs-sm); color:var(--c-text-1); }
    .rc-badges { display:flex; gap:.3rem; flex-wrap:wrap; }
    .rc-badge { font-size:var(--fs-micro); font-weight:var(--fw-medium); padding:.1rem .45rem; border-radius:99px; }
    .rc-badge.bad { background:color-mix(in srgb, var(--bad-fg) 15%, transparent); color:var(--bad-fg); }
    .rc-badge.warn { background:color-mix(in srgb, var(--warn-fg) 15%, transparent); color:var(--warn-fg); }
    .rc-badge.info { background:var(--c-surface-2); color:var(--c-text-2); }
    .rc-badge.ok { background:color-mix(in srgb, var(--ok-fg) 15%, transparent); color:var(--ok-fg); }
    .rc-hint { margin-left:auto; font-size:var(--fs-micro); color:var(--c-text-3); }
    .rc-body { padding:.6rem .8rem .9rem; border-top:1px solid var(--c-divider); }
    .rc-filters { display:flex; gap:.9rem; align-items:center; flex-wrap:wrap; margin-bottom:.6rem; font-size:var(--fs-sm); }
    .rc-filters label { display:inline-flex; gap:.35rem; align-items:center; color:var(--c-text-2); }
    .rc-filters input { padding:.3rem .45rem; border:1px solid var(--border-color); border-radius:var(--r-sm,6px); background:var(--card-bg); color:var(--c-text-1); font:inherit; font-size:var(--fs-sm); }
    .rc-muted { color:var(--c-text-3); font-size:var(--fs-micro); }
    .rc-table-wrap { overflow-x:auto; }
    .rc-table { width:100%; border-collapse:collapse; font-size:var(--fs-sm); }
    .rc-table th { text-align:left; padding:.4rem .6rem; font-size:var(--fs-micro); text-transform:uppercase; letter-spacing:.05em; color:var(--c-text-3); font-weight:var(--fw-bold); border-bottom:1px solid var(--c-divider); white-space:nowrap; }
    .rc-table td { padding:.4rem .6rem; border-top:1px solid var(--c-divider); white-space:nowrap; }
    .rc-table th.num, .rc-table td.num { text-align:right; }
    .rc-mono { font-family:var(--font-mono,'Geist Mono',monospace); font-variant-numeric:tabular-nums; }
    .rc-route { font-weight:var(--fw-medium); }
    .num.neg { color:var(--bad-fg); } .num.pos { color:var(--ok-fg); }
    .rc-pct { color:var(--c-text-3); font-size:var(--fs-micro); }
    .rc-chip { font-size:var(--fs-micro); font-weight:var(--fw-bold); padding:.1rem .45rem; border-radius:99px; text-transform:uppercase; letter-spacing:.03em; }
    .rc-chip.descuadre { background:color-mix(in srgb, var(--bad-fg) 15%, transparent); color:var(--bad-fg); }
    .rc-chip.cierre_faltante { background:color-mix(in srgb, var(--warn-fg) 15%, transparent); color:var(--warn-fg); }
    .rc-chip.cierre_sin_venta { background:var(--c-surface-2); color:var(--c-text-2); }
    .rc-legend { margin:.6rem 0 0; font-size:var(--fs-micro); color:var(--c-text-3); display:flex; gap:.4rem; flex-wrap:wrap; align-items:center; }
    .rc-empty { color:var(--c-text-3); font-size:var(--fs-sm); margin:.4rem 0 0; }
  `],
})
export class RouteClosureReconComponent {
  private readonly api = inject(ComercialService);
  readonly today = new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 10);
  readonly from = signal<string>(new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10));
  readonly to = signal<string>(this.today);
  readonly open = signal(false);
  readonly loading = signal(false);
  readonly errored = signal(false);
  readonly data = signal<RouteClosureReconciliation | null>(null);

  private loadedOnce = false;

  /** Abre/cierra el panel; la primera apertura dispara la carga (lazy). */
  toggle() {
    const next = !this.open();
    this.open.set(next);
    if (next && !this.loadedOnce) { this.loadedOnce = true; this.reload(); }
  }

  reload() {
    this.loading.set(true);
    this.errored.set(false);
    this.api.routeClosureReconciliation(this.from(), this.to()).subscribe({
      next: (d) => { this.data.set(d); this.loading.set(false); },
      error: () => { this.errored.set(true); this.loading.set(false); },
    });
  }

  total(d: RouteClosureReconciliation) { return d.summary.descuadre + d.summary.cierre_faltante + d.summary.cierre_sin_venta; }
  label(i: RouteClosureIncidencia) {
    return i.status === 'descuadre' ? 'descuadre' : i.status === 'cierre_faltante' ? 'sin cierre' : 'sin venta';
  }
  money(n: number | null): string {
    if (n == null) return '—';
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(Number(n));
  }
}
