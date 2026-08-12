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

      <!-- Nivel 2 — por cuenta (Workbook ↔ ContPAQi) -->
      <div class="card-premium card-flat fb-tablewrap">
        <h3 class="fb-card-title fb-pnl-title">Por cuenta <span class="muted">— Workbook ↔ ContPAQi (Kepler 102 no se desglosa por banco)</span></h3>
        <p-table [value]="d.por_cuenta" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="46vh">
          <ng-template #header>
            <tr>
              <th title="Banco y número de cuenta">Cuenta</th>
              <th class="ta-r" title="Depósitos según tu estado de cuenta (Workbook)">Dep. Workbook</th>
              <th class="ta-r" title="Depósitos en los libros de ContPAQi">Dep. ContPAQi</th>
              <th class="ta-r" title="Diferencia de depósitos (Workbook − ContPAQi)">Δ dep.</th>
              <th class="ta-r" title="Retiros según tu estado de cuenta (Workbook)">Ret. Workbook</th>
              <th class="ta-r" title="Retiros en los libros de ContPAQi">Ret. ContPAQi</th>
              <th class="ta-r" title="Diferencia de retiros (Workbook − ContPAQi)">Δ ret.</th>
              <th class="ta-c" title="✓ cuadra · ⚠ no cuadra · sin enlazar">Estado</th>
            </tr>
          </ng-template>
          <ng-template #body let-r>
            <tr>
              <td><span class="fb-strong">{{ r.bank }}</span> <span class="muted mono">{{ r.account_label }}</span></td>
              <td class="ta-r mono">{{ r.wb_in | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
              <td class="ta-r mono">{{ r.cp_in | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
              <td class="ta-r mono" [class.bad]="r.linked && !cuad(r.delta_in)">{{ r.delta_in | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
              <td class="ta-r mono">{{ r.wb_out | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
              <td class="ta-r mono">{{ r.cp_out | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
              <td class="ta-r mono" [class.bad]="r.linked && !cuad(r.delta_out)">{{ r.delta_out | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
              <td class="ta-c">
                @if (!r.linked) { <span class="tw-tag muted-tag" title="Cuenta no enlazada a ContPAQi">sin enlazar</span> }
                @else if (r.cuadra) { <i class="pi pi-check-circle ok" title="Cuadra"></i> }
                @else { <i class="pi pi-exclamation-triangle bad" title="No cuadra"></i> }
              </td>
            </tr>
          </ng-template>
          <ng-template #emptymessage><tr><td colspan="8"><div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin cuentas para {{ d.period }}.</p></div></td></tr></ng-template>
        </p-table>
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
}
