import { ChangeDetectionStrategy, Component, EventEmitter, Output, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { Balances, BankStatement, Diagnostico } from '../../bank.service';
import { cuadra, kindLabel } from './bancos-shared';

/**
 * CB.14 — Vista CUENTAS (cuadre de saldos por cuenta + fallback estados de cuenta).
 * Presentacional: recibe balances/statements/diagnóstico; emite `openAccount` para
 * que el shell navegue a Movimientos filtrado por esa cuenta.
 */
@Component({
  selector: 'bancos-cuentas',
  standalone: true,
  imports: [CommonModule, ButtonModule, TableModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (balances(); as bal) {
      <div class="card-premium card-flat fb-tablewrap fb-bal">
        <h3 class="fb-card-title fb-pnl-title">Cuadre de saldos <span class="muted">— inicial + depósitos − retiros = final · clic en una cuenta para ver sus movimientos</span>
          @if (bal.cuentas_descuadradas > 0) { <span class="fb-bal-badge bad">{{ bal.cuentas_descuadradas }} sin cuadrar</span> }
          @else if (bal.cuentas_sin_saldo === bal.accounts.length) { <span class="fb-bal-badge warn">sin saldos</span> }
          @else { <span class="fb-bal-badge ok">todo cuadra</span> }
        </h3>
        <p-table [value]="bal.accounts" dataKey="statement_id" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="60vh">
          <ng-template pTemplate="header">
            <tr><th class="col-w25"></th><th>Cuenta</th><th class="ta-r">Inicial</th><th class="ta-r">Depósitos</th><th class="ta-r">Retiros</th><th class="ta-r">Calculado</th><th class="ta-r">Final</th><th class="ta-r">Δ</th><th class="col-w5 ta-c">Estado</th></tr>
          </ng-template>
          <ng-template pTemplate="body" let-a let-expanded="expanded">
            <tr class="fb-row-click" [class.fb-bal-sinsaldo]="a.sin_saldo" tabindex="0" role="button"
                (click)="openAccount.emit(a)" (keyup.enter)="openAccount.emit(a)"
                [attr.aria-label]="'Ver movimientos de ' + a.bank + ' ' + a.account_label">
              <td class="ta-c">
                @if (!a.cuadra && !a.sin_saldo && breaksFor(a).length) {
                  <button type="button" pButton [pRowToggler]="a" (click)="$event.stopPropagation()"
                          [icon]="expanded ? 'pi pi-chevron-down' : 'pi pi-chevron-right'"
                          class="p-button-text p-button-sm" aria-label="Ver dónde salta el saldo"></button>
                }
              </td>
              <td>{{ a.bank }} <span class="muted mono">{{ a.account_label }}</span></td>
              <td class="ta-r mono">{{ a.opening | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
              <td class="ta-r mono">{{ a.total_in | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
              <td class="ta-r mono">{{ a.total_out | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
              <td class="ta-r mono muted">{{ a.computed_closing | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
              <td class="ta-r mono fb-strong">{{ a.closing | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
              <td class="ta-r mono">
                @if (a.sin_saldo) { <span class="muted">—</span> }
                @else { <span [class.bad]="!a.cuadra" [class.ok]="a.cuadra">{{ a.delta | currency:'MXN':'symbol-narrow':'1.0-0' }}</span> }
              </td>
              <td class="ta-c">
                @if (a.sin_saldo) { <span class="fb-kind">sin saldo</span> }
                @else if (a.cuadra) { <i class="pi pi-check-circle ok" title="Cuadra"></i> }
                @else { <i class="pi pi-exclamation-triangle bad" title="No cuadra"></i> }
              </td>
            </tr>
          </ng-template>
          <ng-template pTemplate="rowexpansion" let-a>
            <tr class="fb-break-row"><td colspan="9">
              <div class="fb-breaks">
                <span class="fb-breaks-h"><i class="pi pi-search-plus"></i> Dónde salta el saldo</span>
                @for (b of breaksFor(a); track b.label) {
                  <div class="fb-break">
                    <span class="fb-break-l mono">{{ b.label }}</span>
                    <span class="fb-break-m mono" [class.bad]="(b.monto || 0) < 0">{{ b.monto | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
                  </div>
                }
                <p class="fb-breaks-note muted">En estos renglones el saldo del estado de cuenta salta más de lo que explica el movimiento: ahí falta capturar algo, o el saldo quedó mal tecleado.</p>
              </div>
            </td></tr>
          </ng-template>
          <ng-template pTemplate="emptymessage">
            <tr><td colspan="9"><div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin cuentas cargadas para {{ period() }}.</p></div></td></tr>
          </ng-template>
        </p-table>
        <p class="fb-recon-note muted">
          Traspasos internos (TI=TE): entra {{ bal.traspasos.entra | currency:'MXN':'symbol-narrow':'1.0-0' }} vs sale {{ bal.traspasos.sale | currency:'MXN':'symbol-narrow':'1.0-0' }}
          <span [class.bad]="!cuadra(bal.traspasos.delta)" [class.ok]="cuadra(bal.traspasos.delta)">(Δ {{ bal.traspasos.delta | currency:'MXN':'symbol-narrow':'1.0-0' }})</span>.
          @if (bal.cuentas_sin_saldo > 0) { · {{ bal.cuentas_sin_saldo }} cuenta(s) sin columna SALDO en el Excel (no verificable). }
        </p>
      </div>
    } @else {
      <div class="card-premium card-flat fb-tablewrap fb-bal">
        <h3 class="fb-card-title fb-pnl-title">Cuentas del periodo <span class="muted">— estados de cuenta cargados (sin saldos para verificar el cuadre)</span></h3>
        <p-table [value]="statements()" styleClass="p-datatable-sm" [rowHover]="true">
          <ng-template pTemplate="header">
            <tr><th>Banco</th><th>Cuenta</th><th>Tipo</th><th class="ta-r">Depósitos</th><th class="ta-r">Retiros</th><th class="ta-r">Saldo final</th></tr>
          </ng-template>
          <ng-template pTemplate="body" let-s>
            <tr>
              <td>{{ s.bank }}</td>
              <td class="mono">{{ s.account_label }}</td>
              <td><span class="fb-kind">{{ kind(s.kind) }}</span></td>
              <td class="ta-r mono">{{ s.total_in | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
              <td class="ta-r mono">{{ s.total_out | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
              <td class="ta-r mono fb-strong">{{ s.closing_balance | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
            </tr>
          </ng-template>
          <ng-template pTemplate="emptymessage">
            <tr><td colspan="6"><div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin cuentas cargadas para {{ period() }}.</p></div></td></tr>
          </ng-template>
        </p-table>
      </div>
    }
  `,
  styles: [`
    :host { display: block; }
    .fb-tablewrap { padding: 0; overflow: hidden; }
    .fb-bal { margin-bottom: var(--sp-3); }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .ta-r { text-align: right; } .ta-c { text-align: center; }
    .muted { color: var(--text-muted); }
    .ok { color: var(--ok-fg); } .bad { color: var(--bad-fg); }
    .fb-strong { font-weight: 600; color: var(--text-main); }
    .col-w25 { width: 2.5rem; } .col-w5 { width: 5rem; }
    .fb-card-title { font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); margin: 0 0 var(--sp-3); }
    .fb-pnl-title { padding: var(--sp-3) var(--sp-3) 0; }
    .fb-kind { font-size: var(--fs-xs); text-transform: capitalize; color: var(--text-muted); }
    .fb-row-click { cursor: pointer; }
    .fb-row-click:focus-visible { outline: 2px solid var(--action-ring); outline-offset: -2px; }
    .fb-bal-sinsaldo { opacity: 0.55; }
    .fb-bal-badge { font-size: var(--fs-xs); font-weight: 600; padding: 1px var(--sp-2); border-radius: var(--r-sm); margin-left: var(--sp-2); }
    .fb-bal-badge.ok { color: var(--ok-fg); background: color-mix(in srgb, var(--ok-fg) 12%, transparent); }
    .fb-bal-badge.bad { color: var(--bad-fg); background: color-mix(in srgb, var(--bad-fg) 12%, transparent); }
    .fb-bal-badge.warn { color: var(--warn-fg); background: color-mix(in srgb, var(--warn-fg) 12%, transparent); }
    .fb-recon-note { font-size: var(--fs-xs); margin: var(--sp-3) 0 0; }
    .fb-break-row > td { background: var(--surface-ground); }
    .fb-breaks { display: flex; flex-direction: column; gap: 2px; padding: var(--sp-2) var(--sp-3); }
    .fb-breaks-h { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-xs); font-weight: 700; color: var(--text-main); text-transform: uppercase; letter-spacing: .04em; margin-bottom: var(--sp-1); }
    .fb-break { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-3); font-size: var(--fs-xs); padding: 2px 0; border-bottom: 1px solid var(--border-color); }
    .fb-break-l { color: var(--text-main); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fb-break-m { font-weight: 600; color: var(--text-main); flex: none; }
    .fb-breaks-note { font-size: var(--fs-xs); margin: var(--sp-2) 0 0; }
    .surf-empty { display: flex; flex-direction: column; align-items: center; gap: var(--sp-2); padding: var(--sp-8); color: var(--text-muted); }
    .surf-empty i { font-size: 1.5rem; }
  `],
})
export class BancosCuentasComponent {
  readonly balances = input.required<Balances | null>();
  readonly statements = input.required<BankStatement[]>();
  readonly diagnostico = input.required<Diagnostico | null>();
  readonly period = input<string>('');
  @Output() openAccount = new EventEmitter<{ bank: string; account_label: string }>();

  cuadra = cuadra;
  kind(k: string): string { return kindLabel(k); }

  breaksFor(a: { bank: string; account_label: string }): { label: string; monto?: number }[] {
    const key = `${a.bank} ${a.account_label}:`;
    const it = this.diagnostico()?.items.find((x) => x.tipo === 'saldo_no_cuadra' && x.titulo.startsWith(key));
    return it?.evidencia ?? [];
  }
}
