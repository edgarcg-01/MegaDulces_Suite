import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TableModule } from 'primeng/table';
import { ThreeWay, ThreeWayRow } from '../../bank.service';
import { cuadra, money0 } from './bancos-shared';

/**
 * CB.24 — Cuadre 3 vías. Enfrenta las TRES fuentes de verdad del banco en el periodo:
 *   • Workbook  = el estado de cuenta (lo que realmente movió el banco).
 *   • Kepler 102 = las pólizas de banco del ERP operativo.
 *   • ContPAQi  = los libros fiscales (con folio de póliza).
 * Nivel 1 (control-total): 2 filas Ingresos/Egresos × 3 fuentes + deltas por par + semáforo.
 * Nivel 2 (por cuenta): Workbook ↔ ContPAQi (el 102 de Kepler no se desglosa por banco).
 * Presentacional: recibe el payload de threeWay(); sin estado propio.
 */
@Component({
  selector: 'bancos-three-way',
  standalone: true,
  imports: [CommonModule, TableModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (data(); as d) {
      <!-- Veredicto answer-first -->
      <div class="tw-verdict" [class.ok]="d.cuadra" [class.bad]="!d.cuadra">
        <i [class]="d.cuadra ? 'pi pi-check-circle' : 'pi pi-exclamation-triangle'"></i>
        <div>
          <h3>{{ verdict(d) }}</h3>
          <p class="muted">{{ d.nota }}</p>
        </div>
      </div>

      <!-- CB.32 — Cobertura/frescura por fuente: captura pendiente ≠ descuadre -->
      <div class="tw-cov" [class.warn]="anyStale(d)">
        <div class="tw-cov-head">
          <span><i class="pi pi-database"></i> Cobertura del periodo</span>
          @if (d.coverage.is_current_month) { <span class="tw-tag muted-tag">mes en curso</span> }
        </div>
        <div class="tw-cov-sources">
          @for (s of covSources(d); track s.key) {
            <div class="tw-cov-src" [class.stale]="s.stale || s.sin_datos">
              <div class="tw-cov-lbl">{{ s.label }}
                @if (s.sin_datos) { <span class="tw-tag warn-tag">sin datos</span> }
                @else if (s.stale) { <span class="tw-tag warn-tag">captura pendiente</span> }
              </div>
              <div class="tw-cov-bar"><div class="tw-cov-fill" [style.width.%]="s.pct"></div></div>
              <div class="tw-cov-meta muted">{{ s.movs }} movs · {{ s.pct }}%<span *ngIf="s.last"> · al {{ s.last | date:'dd/MM' }}</span></div>
            </div>
          }
        </div>
        @if (anyStale(d)) {
          <p class="tw-cov-note muted"><i class="pi pi-info-circle"></i> Una fuente va rezagada en captura: sus diferencias son <b>captura pendiente</b>, no descuadre. Se cierran cuando esa fuente se pone al día. El banco (Workbook) va al día.</p>
        }
      </div>

      <!-- Nivel 1 — control-total: aquí cuadran las 3 -->
      <div class="card-premium card-flat tw-card">
        <h3 class="fb-card-title">Control-total <span class="muted">— las 3 fuentes en {{ d.period }} (tolerancia ±{{ d.tolerance | currency:'MXN':'symbol-narrow':'1.0-0' }})</span></h3>
        <div class="tw-wrap">
          <table class="tw-tbl">
            <thead>
              <tr>
                <th scope="col"></th>
                <th scope="col" class="ta-r"><i class="pi pi-building"></i> Workbook</th>
                <th scope="col" class="ta-r"><i class="pi pi-database"></i> Kepler 102</th>
                <th scope="col" class="ta-r"><i class="pi pi-book"></i> ContPAQi</th>
                <th scope="col" class="ta-r" title="Workbook − Kepler">Δ W–K</th>
                <th scope="col" class="ta-r" title="Workbook − ContPAQi">Δ W–C</th>
                <th scope="col" class="ta-r" title="Kepler − ContPAQi">Δ K–C</th>
                <th scope="col" class="ta-c">Estado</th>
              </tr>
            </thead>
            <tbody>
              @for (row of rows(d); track row.label) {
                <tr>
                  <th scope="row">{{ row.label }}</th>
                  <td class="ta-r mono">{{ row.workbook | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  <td class="ta-r mono">{{ row.kepler | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  <td class="ta-r mono">{{ row.contpaqi | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  <td class="ta-r mono" [class.bad]="!cuad(row.delta_wk)" [class.ok]="cuad(row.delta_wk)">{{ row.delta_wk | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  <td class="ta-r mono" [class.bad]="!cuad(row.delta_wc)" [class.ok]="cuad(row.delta_wc)">{{ row.delta_wc | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  <td class="ta-r mono" [class.bad]="!cuad(row.delta_kc)" [class.ok]="cuad(row.delta_kc)">{{ row.delta_kc | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  <td class="ta-c">
                    @if (row.cuadra) { <i class="pi pi-check-circle ok" title="Cuadra dentro de la tolerancia"></i> }
                    @else { <i class="pi pi-exclamation-triangle bad" title="No cuadra — revisa el detalle por cuenta"></i> }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <p class="fb-recon-note muted"><i class="pi pi-info-circle"></i>
          <b>Workbook</b> = tu estado de cuenta (lo que movió el banco). <b>Kepler 102</b> = pólizas de banco del ERP ({{ d.kepler_movs }} movs). <b>ContPAQi</b> = libros fiscales ({{ d.kepler_linked }} cuentas enlazadas).
        </p>
      </div>

      <!-- Nivel 2 — por cuenta: las 3 fuentes (Kepler desde tesorería kdm1) -->
      <div class="card-premium card-flat fb-tablewrap">
        <h3 class="fb-card-title fb-pnl-title">Por cuenta
          <span class="muted">— {{ d.kepler_por_cuenta ? 'las 3 fuentes por banco (Kepler desde tesorería)' : 'Workbook ↔ ContPAQi (Kepler aún sin datos del periodo)' }}</span></h3>
        <div class="tw-wrap">
          <p-table [value]="d.por_cuenta" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="46vh">
            <ng-template #header>
              <tr>
                <th rowspan="2" title="Banco y número de cuenta">Cuenta</th>
                <th colspan="3" class="ta-c tw-grp"><i class="pi pi-arrow-down-left fb-in-ico"></i> Depósitos</th>
                <th colspan="3" class="ta-c tw-grp"><i class="pi pi-arrow-up-right"></i> Retiros</th>
                <th rowspan="2" class="ta-c" title="✓ cuadra Workbook↔ContPAQi · ⚠ no cuadra · sin enlazar">Estado</th>
              </tr>
              <tr>
                <th class="ta-r" title="Estado de cuenta (Workbook)">WB</th>
                <th class="ta-r tw-kep" title="Kepler tesorería (kdm1, por banco)">Kepler</th>
                <th class="ta-r" title="Libros ContPAQi">CPQ</th>
                <th class="ta-r" title="Estado de cuenta (Workbook)">WB</th>
                <th class="ta-r tw-kep" title="Kepler tesorería (kdm1, por banco)">Kepler</th>
                <th class="ta-r" title="Libros ContPAQi">CPQ</th>
              </tr>
            </ng-template>
            <ng-template #body let-r>
              <tr>
                <td><span class="fb-strong">{{ r.bank }}</span> <span class="muted mono">{{ r.account_label }}</span></td>
                <td class="ta-r mono">{{ r.wb_in | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                <td class="ta-r mono tw-kep" [class.bad]="r.kep_has && !cuad(r.delta_wk_in)">{{ r.kep_has ? (r.kep_in | currency:'MXN':'symbol-narrow':'1.0-0') : '—' }}</td>
                <td class="ta-r mono" [class.bad]="r.linked && !cuad(r.delta_in)">{{ r.cp_in | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                <td class="ta-r mono">{{ r.wb_out | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                <td class="ta-r mono tw-kep" [class.bad]="r.kep_has && !cuad(r.delta_wk_out)">{{ r.kep_has ? (r.kep_out | currency:'MXN':'symbol-narrow':'1.0-0') : '—' }}</td>
                <td class="ta-r mono" [class.bad]="r.linked && !cuad(r.delta_out)">{{ r.cp_out | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                <td class="ta-c">
                  @if (!r.linked) { <span class="tw-tag muted-tag" title="Cuenta no enlazada a ContPAQi">sin enlazar</span> }
                  @else if (r.cuadra) { <i class="pi pi-check-circle ok" title="Cuadra Workbook↔ContPAQi"></i> }
                  @else { <i class="pi pi-exclamation-triangle bad" title="No cuadra"></i> }
                </td>
              </tr>
            </ng-template>
            <ng-template #emptymessage><tr><td colspan="8"><div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin cuentas para {{ d.period }}.</p></div></td></tr></ng-template>
          </p-table>
        </div>
      </div>
    } @else {
      <div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin datos de cuadre para {{ period() }}.</p></div>
    }
  `,
  styles: [`
    :host { display: block; }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .ta-r { text-align: right; } .ta-c { text-align: center; }
    .muted { color: var(--text-muted); }
    .ok { color: var(--ok-fg); } .bad { color: var(--bad-fg); }
    .fb-strong { font-weight: 600; color: var(--text-main); }
    .fb-tablewrap { padding: 0; overflow: hidden; }
    .fb-card-title { font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); margin: 0 0 var(--sp-3); }
    .fb-pnl-title { padding: var(--sp-3) var(--sp-3) 0; }
    .fb-recon-note { font-size: var(--fs-xs); margin: var(--sp-2) 0 0; }
    .surf-empty { display: flex; flex-direction: column; align-items: center; gap: var(--sp-2); padding: var(--sp-8); color: var(--text-muted); }
    .surf-empty i { font-size: 1.5rem; }
    /* Veredicto */
    .tw-verdict { display: flex; align-items: flex-start; gap: var(--sp-3); padding: var(--sp-4);
      border: 1px solid var(--border-color); border-radius: var(--r-md); border-left-width: 3px; margin-bottom: var(--sp-3); }
    .tw-verdict.ok { border-left-color: var(--ok-fg); }
    .tw-verdict.bad { border-left-color: var(--warn-fg); }
    .tw-verdict > i { font-size: 1.5rem; }
    .tw-verdict.ok > i { color: var(--ok-fg); }
    .tw-verdict.bad > i { color: var(--warn-fg); }
    .tw-verdict h3 { font-size: var(--fs-md, 1rem); font-weight: 700; margin: 0; color: var(--text-main); }
    .tw-verdict p { font-size: var(--fs-xs); margin: 2px 0 0; line-height: 1.4; }
    .tw-card { margin-bottom: var(--sp-3); }
    .tw-wrap { overflow-x: auto; }
    table.tw-tbl { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    table.tw-tbl th, table.tw-tbl td { padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--border-color); white-space: nowrap; }
    table.tw-tbl thead th { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .04em; color: var(--text-faint); font-weight: 700; }
    table.tw-tbl thead th i { margin-right: 4px; }
    table.tw-tbl tbody th[scope=row] { text-align: left; font-weight: 600; color: var(--text-main); }
    table.tw-tbl tbody tr:last-child td, table.tw-tbl tbody tr:last-child th { border-bottom: none; }
    .tw-tag { display: inline-block; font-size: var(--fs-2xs, .7rem); font-weight: 700; padding: 1px var(--sp-2); border-radius: var(--r-pill); text-transform: uppercase; letter-spacing: .03em; }
    .muted-tag { background: color-mix(in srgb, var(--text-faint) 15%, transparent); color: var(--text-muted); }
    /* Cabecera agrupada Depósitos/Retiros + resalte de la columna Kepler (la fuente nueva) */
    .tw-grp { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .04em; color: var(--text-faint); font-weight: 700; border-bottom: 1px solid var(--border-color); }
    .tw-grp i { margin-right: 4px; }
    :host ::ng-deep th.tw-kep, .tw-kep { background: color-mix(in srgb, var(--chart-2, #6366f1) 6%, transparent); }
    .fb-in-ico { color: var(--ok-fg); font-size: .8rem; }
    .fb-out-ico { color: var(--text-faint); font-size: .8rem; }
    .warn-tag { background: color-mix(in srgb, var(--warn-fg) 16%, transparent); color: var(--warn-fg); }
    /* CB.32 — barra de cobertura/frescura */
    .tw-cov { border: 1px solid var(--border-color); border-radius: var(--r-md); border-left-width: 3px; border-left-color: var(--ok-fg); padding: var(--sp-3) var(--sp-4); margin-bottom: var(--sp-3); }
    .tw-cov.warn { border-left-color: var(--warn-fg); }
    .tw-cov-head { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-xs); font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); margin-bottom: var(--sp-2); }
    .tw-cov-sources { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: var(--sp-3); }
    .tw-cov-src { display: flex; flex-direction: column; gap: 3px; }
    .tw-cov-lbl { font-size: var(--fs-xs); font-weight: 600; color: var(--text-main); display: flex; align-items: center; gap: var(--sp-2); }
    .tw-cov-bar { height: 5px; border-radius: var(--r-pill); background: var(--hover-bg); overflow: hidden; }
    .tw-cov-fill { height: 100%; background: var(--ok-fg); border-radius: var(--r-pill); }
    .tw-cov-src.stale .tw-cov-fill { background: var(--warn-fg); }
    .tw-cov-meta { font-size: var(--fs-2xs, .7rem); font-variant-numeric: tabular-nums; }
    .tw-cov-note { font-size: var(--fs-xs); margin: var(--sp-2) 0 0; }
  `],
})
export class BancosThreeWayComponent {
  readonly data = input.required<ThreeWay | null>();
  readonly period = input<string>('');

  cuad = cuadra;

  rows(d: ThreeWay): ThreeWayRow[] { return [d.total.ingresos, d.total.egresos]; }

  verdict(d: ThreeWay): string {
    if (d.cuadra) return `Las 3 fuentes cuadran en ${d.period} (dentro de ±${money0(d.tolerance)}).`;
    const gaps: string[] = [];
    const i = d.total.ingresos, e = d.total.egresos;
    if (!i.cuadra) gaps.push(`ingresos (mayor Δ ${money0(this.maxDelta(i))})`);
    if (!e.cuadra) gaps.push(`egresos (mayor Δ ${money0(this.maxDelta(e))})`);
    return `Descuadre en ${gaps.join(' y ')}. Revisa el detalle por cuenta abajo.`;
  }
  private maxDelta(r: ThreeWayRow): number {
    return Math.max(Math.abs(r.delta_wk), Math.abs(r.delta_wc), Math.abs(r.delta_kc));
  }

  // CB.32 — cobertura por fuente (para la barra de frescura).
  covSources(d: ThreeWay) {
    const c = d.coverage;
    return [
      { key: 'wb', label: 'Workbook (banco)', ...c.workbook },
      { key: 'kep', label: 'Kepler (tesorería)', ...c.kepler },
      { key: 'cpq', label: 'ContPAQi (libros)', ...c.contpaqi },
    ];
  }
  anyStale(d: ThreeWay): boolean {
    const c = d.coverage;
    return !!(c.kepler.stale || c.contpaqi.stale || c.kepler.sin_datos || c.contpaqi.sin_datos);
  }
}
