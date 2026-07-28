import { ChangeDetectionStrategy, Component, EventEmitter, Output, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { ContpaqiCompare, ContpaqiCompareRow, ContpaqiBankAccount } from '../../bank.service';
import { cuadra, money0 } from './bancos-shared';

/**
 * CP.2 (Fase CP, ADR-040) — Vista "vs ContPAQi". Compara el estado de cuenta (Excel/finance)
 * contra los LIBROS de ContPAQi (analytics.contpaqi_bank_movements) por cuenta y periodo.
 * A diferencia de "Conciliación" (que cruza contra el proxy Kepler-102), esto cruza contra la
 * contabilidad REAL con folio de póliza → la 3ª columna de verdad. Presentacional: recibe el
 * compare + flag de carga; emite `link` para que el shell autoenlace las cuentas.
 */
@Component({
  selector: 'bancos-contpaqi',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, SelectModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (compare(); as c) {
      <!-- Answer-first: ¿la contabilidad registró lo mismo que movió el banco? -->
      <div class="card-premium card-flat fb-kve">
        <div class="cpq-head">
          <h3 class="fb-card-title">Banco vs Contabilidad (ContPAQi) <span class="muted">— ¿los libros registran lo mismo que movió el banco en {{ c.period }}?</span></h3>
          <button pButton type="button" label="Enlazar cuentas" icon="pi pi-link" class="p-button-sm p-button-text"
                  [loading]="linking()" (click)="link.emit()" title="Auto-enlaza cada cuenta de banco con su cuenta contable 102xxx de ContPAQi"></button>
        </div>
        <div class="fb-kve-wrap">
          <table class="fb-kve">
            <thead>
              <tr><th scope="col"></th><th scope="col" class="ta-r">Excel (banco)</th><th scope="col" class="ta-r">ContPAQi (libros)</th><th scope="col" class="ta-r">Diferencia</th><th scope="col" class="ta-c">Estado</th></tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row"><i class="pi pi-arrow-down-left fb-in-ico"></i> Depósitos <span class="muted">(entra)</span></th>
                <td class="ta-r mono">{{ c.totals.excel_in | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                <td class="ta-r mono">{{ c.totals.contpaqi_in | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                <td class="ta-r mono" [class.bad]="!cuad(c.totals.delta_in)" [class.ok]="cuad(c.totals.delta_in)">Δ {{ c.totals.delta_in | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                <td class="ta-c">
                  @if (cuad(c.totals.delta_in)) { <i class="pi pi-check-circle ok" title="Cuadra"></i> }
                  @else { <i class="pi pi-exclamation-triangle bad" title="No cuadra — revisa el detalle por cuenta"></i> }
                </td>
              </tr>
              <tr>
                <th scope="row"><i class="pi pi-arrow-up-right fb-out-ico"></i> Retiros <span class="muted">(sale)</span></th>
                <td class="ta-r mono">{{ c.totals.excel_out | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                <td class="ta-r mono">{{ c.totals.contpaqi_out | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                <td class="ta-r mono" [class.bad]="!cuad(c.totals.delta_out)" [class.ok]="cuad(c.totals.delta_out)">Δ {{ c.totals.delta_out | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                <td class="ta-c">
                  @if (cuad(c.totals.delta_out)) { <i class="pi pi-check-circle ok" title="Cuadra"></i> }
                  @else { <i class="pi pi-exclamation-triangle bad" title="No cuadra — revisa el detalle por cuenta"></i> }
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="fb-plain">{{ read(c) }}</p>
        @if (c.linked === 0) {
          <p class="fb-recon-note muted"><i class="pi pi-exclamation-triangle"></i> Ninguna cuenta está enlazada a ContPAQi todavía. Presiona <b>Enlazar cuentas</b> para casar cada banco con su cuenta contable 102xxx.</p>
        } @else {
          <p class="fb-recon-note muted"><i class="pi pi-info-circle"></i> <b>{{ c.linked }}</b> de {{ c.rows.length }} cuentas enlazadas a ContPAQi. ContPAQi son tus <b>libros fiscales</b> (con folio de póliza), no un proxy — por eso el Δ vs banco es el que importa.</p>
          @if (c.linked < c.rows.length) {
            <p class="fb-recon-note muted"><i class="pi pi-link"></i> Quedan <b>{{ c.rows.length - c.linked }}</b> sin enlazar automáticamente (distinta convención de número entre el Excel y ContPAQi). Enlázalas a mano con el selector de la columna <b>Estado</b>.</p>
          }
        }
      </div>

      <!-- Detalle por cuenta -->
      <div class="card-premium card-flat fb-tablewrap">
        <h3 class="fb-card-title fb-pnl-title">Detalle por cuenta</h3>
        <p-table [value]="c.rows" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="52vh">
          <ng-template pTemplate="header">
            <tr>
              <th>Cuenta</th><th>Libro ContPAQi</th>
              <th class="ta-r">Dep. Excel</th><th class="ta-r">Dep. ContPAQi</th><th class="ta-r">Δ dep.</th>
              <th class="ta-r">Ret. Excel</th><th class="ta-r">Ret. ContPAQi</th><th class="ta-r">Δ ret.</th>
              <th class="ta-c">Estado</th>
            </tr>
          </ng-template>
          <ng-template pTemplate="body" let-r>
            <tr>
              <td><span class="fb-strong">{{ r.bank }}</span> <span class="muted mono">{{ r.account_label }}</span></td>
              <td class="mono muted" [title]="r.contpaqi_cuenta_nombre || ''">{{ r.contpaqi_cuenta || '—' }}</td>
              <td class="ta-r mono">{{ r.excel_in | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
              <td class="ta-r mono">{{ r.contpaqi_in | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
              <td class="ta-r mono" [class.bad]="r.linked && !cuad(r.delta_in)">{{ r.delta_in | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
              <td class="ta-r mono">{{ r.excel_out | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
              <td class="ta-r mono">{{ r.contpaqi_out | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
              <td class="ta-r mono" [class.bad]="r.linked && !cuad(r.delta_out)">{{ r.delta_out | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
              <td class="ta-c">
                @if (!r.linked) {
                  <p-select [options]="availOpts()" [ngModel]="null" (onChange)="onPick(r, $event.value)"
                            placeholder="Enlazar a…" appendTo="body" [filter]="true" filterBy="label"
                            styleClass="cpq-picker" [style]="{ minWidth: '15rem' }" scrollHeight="16rem"
                            emptyMessage="Sin cuentas ContPAQi disponibles" title="Elige la cuenta contable ContPAQi que corresponde a este banco"></p-select>
                }
                @else if (noExcel(r)) { <span class="cpq-tag muted-tag" title="No hay estado de cuenta cargado para el periodo">sin Excel</span> }
                @else if (cuad(r.delta_in) && cuad(r.delta_out)) { <i class="pi pi-check-circle ok" title="Cuadra"></i> }
                @else { <i class="pi pi-exclamation-triangle bad" title="No cuadra"></i> }
              </td>
            </tr>
          </ng-template>
          <ng-template pTemplate="emptymessage"><tr><td colspan="9"><div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin cuentas.</p></div></td></tr></ng-template>
        </p-table>
      </div>
    } @else {
      <div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin comparación para {{ period() }}.</p></div>
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
    .fb-plain { font-size: var(--fs-sm); color: var(--text-main); margin: var(--sp-2) 0 0; line-height: 1.4; }
    .fb-recon-note { font-size: var(--fs-xs); margin: var(--sp-2) 0 0; }
    .fb-kve { margin-bottom: var(--sp-3); }
    .fb-kve-wrap { overflow-x: auto; }
    .cpq-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); flex-wrap: wrap; }
    table.fb-kve { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    table.fb-kve th, table.fb-kve td { padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--border-color); }
    table.fb-kve thead th { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .04em; color: var(--text-faint); font-weight: 700; white-space: nowrap; }
    table.fb-kve tbody th[scope=row] { text-align: left; font-weight: 600; color: var(--text-main); white-space: nowrap; }
    table.fb-kve tbody tr:last-child td, table.fb-kve tbody tr:last-child th { border-bottom: none; }
    .fb-in-ico { color: var(--ok-fg); font-size: .8rem; margin-right: 4px; }
    .fb-out-ico { color: var(--text-faint); font-size: .8rem; margin-right: 4px; }
    .cpq-tag { display: inline-block; font-size: var(--fs-2xs, .7rem); font-weight: 700; padding: 1px var(--sp-2); border-radius: var(--r-pill); text-transform: uppercase; letter-spacing: .03em; }
    .muted-tag { background: color-mix(in srgb, var(--text-faint) 15%, transparent); color: var(--text-muted); }
    .surf-empty { display: flex; flex-direction: column; align-items: center; gap: var(--sp-2); padding: var(--sp-8); color: var(--text-muted); }
    .surf-empty i { font-size: 1.5rem; }
  `],
})
export class BancosContpaqiComponent {
  readonly compare = input.required<ContpaqiCompare | null>();
  readonly linking = input<boolean>(false);
  readonly period = input<string>('');
  readonly available = input<ContpaqiBankAccount[]>([]);
  @Output() link = new EventEmitter<void>();
  @Output() manualLink = new EventEmitter<{ bankAccountId: string; cuenta: string | null }>();

  cuad = cuadra;
  noExcel(r: ContpaqiCompareRow): boolean { return r.excel_in === 0 && r.excel_out === 0; }

  /** Opciones del selector manual: cuentas ContPAQi de banco aún libres (más movs primero). */
  readonly availOpts = computed(() =>
    this.available()
      .filter((a) => !a.taken)
      .sort((x, y) => y.movs - x.movs)
      .map((a) => ({ label: `${a.cuenta_nombre} · ${a.movs} movs`, value: a.cuenta })));

  onPick(r: ContpaqiCompareRow, cuenta: string | null): void {
    if (!cuenta) return;
    this.manualLink.emit({ bankAccountId: r.id, cuenta });
  }

  read(c: ContpaqiCompare): string {
    if (c.linked === 0) return 'Enlaza las cuentas para comparar el estado de cuenta contra los libros de ContPAQi.';
    const okIn = cuadra(c.totals.delta_in), okOut = cuadra(c.totals.delta_out);
    if (okIn && okOut) return `Los libros de ContPAQi registran lo mismo que movió el banco: ${money0(c.totals.contpaqi_in)} de depósitos y ${money0(c.totals.contpaqi_out)} de retiros. Cuadra.`;
    const gaps: string[] = [];
    if (!okIn) gaps.push(`${money0(Math.abs(c.totals.delta_in))} en depósitos`);
    if (!okOut) gaps.push(`${money0(Math.abs(c.totals.delta_out))} en retiros`);
    return `Diferencia de ${gaps.join(' y ')} entre el banco (Excel) y los libros de ContPAQi. Revisa por cuenta abajo: puede ser un estado de cuenta sin cargar, o un movimiento que la contabilidad no registró.`;
  }
}
