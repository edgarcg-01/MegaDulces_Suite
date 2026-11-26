import { ChangeDetectionStrategy, Component, EventEmitter, Output, computed, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { BalanceRow, Balances, BankStatement, Diagnostico } from '../../bank.service';
import { cuadra, dmShort, kindLabel } from './bancos-shared';
import { exportXlsx } from '../../../../shared/export/xlsx-export';
import { MetricStripComponent, MetricStripItem } from '../../../../shared/components/metric-strip/metric-strip.component';
import { BANCOS_STYLES } from './bancos.styles';

/**
 * CB.14 — Vista CUENTAS (cuadre de saldos por cuenta + fallback estados de cuenta).
 * Presentacional: recibe balances/statements/diagnóstico; emite `openAccount` para
 * que el shell abra la VENTANA de Movimientos de esa cuenta (CB.64: Movimientos ya no es pestaña).
 */
@Component({
  selector: 'bancos-cuentas',
  standalone: true,
  imports: [CommonModule, ButtonModule, TableModule, MetricStripComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- [BFU.4.5.13] Cuentas contesta UNA pregunta: ¿cierran los saldos? De dónde viene y a dónde va cada peso vive en
         «Ingresos y egresos» (Edgar, 2026-11-25: «para no hacer tanto scroll»). La tira nace con su valor (sin conteo). -->
    @if (cifrasSaldos().length) {
      <app-metric-strip class="fb-cta-tira" [items]="cifrasSaldos()" density="compact" [instant]="true"
                        ariaLabel="Saldos de las cuentas" (drill)="onDrill($event)" />
    }
    @if (balances(); as bal) {
      <div class="card-premium card-flat fb-tablewrap fb-bal">
        <h3 class="fb-card-title fb-pnl-title">Cuadre de saldos <span class="muted">— inicial + depósitos − retiros = final, con la fuente de cada cuenta · clic en una cuenta para ver sus movimientos</span><button type="button" class="fb-xls" [disabled]="exporting()" (click)="exportXls()" title="Descarga el cuadre de saldos y los estados cargados"><i class="pi" [class.pi-file-excel]="!exporting()" [class.pi-spin]="exporting()" [class.pi-spinner]="exporting()" aria-hidden="true"></i> Excel</button>
          <!-- [BFU.4.5.13] «N no cierran» ya lo dice la tira de arriba: no se repite aquí. -->
          @if (bal.cuentas_sin_saldo === bal.accounts.length) { <span class="fb-bal-badge warn">sin saldos</span> }
          <!-- [BFU.0.1] «todo cuadra» con el libro al 10-nov afirmaba que el banco cuadraba: lo que cierra es la fuente
               de cada cuenta consigo misma, y el resumen dice cuál es. -->
          @if (fuentes(bal); as fz) { <span class="fb-bal-fuente">{{ fz }}</span> }
        </h3>
        <p-table [value]="cuentasOrdenadas()" dataKey="statement_id" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="60vh">
          <ng-template #header>
            <tr><th class="col-w25"><span class="sr-only">Detalle</span></th><th pSortableColumn="bank">Cuenta <p-sorticon field="bank" /></th><th pSortableColumn="hasta">De dónde sale <p-sorticon field="hasta" /></th><th class="ta-r" pSortableColumn="opening">Inicial <p-sorticon field="opening" /></th><th class="ta-r" pSortableColumn="total_in">Depósitos <p-sorticon field="total_in" /></th><th class="ta-r" pSortableColumn="total_out">Retiros <p-sorticon field="total_out" /></th><th class="ta-r" pSortableColumn="computed_closing">Calculado <p-sorticon field="computed_closing" /></th><th class="ta-r" pSortableColumn="closing">Final <p-sorticon field="closing" /></th><th class="ta-r" pSortableColumn="delta">Δ <p-sorticon field="delta" /></th><th class="ta-c" pSortableColumn="cuadra">Cierra <p-sorticon field="cuadra" /></th></tr>
          </ng-template>
          <ng-template #body let-a let-expanded="expanded">
            <tr class="fb-row-click" [class.fb-bal-sinsaldo]="a.sin_saldo" tabindex="0"
                (click)="openAccount.emit(a)" (keydown.enter)="openAccount.emit(a)" (keydown.space)="$event.preventDefault(); openAccount.emit(a)">
              <td class="ta-c">
                @if (!a.cuadra && !a.sin_saldo && breaksFor(a).length) {
                  <p-button type="button" [pRowToggler]="a" (click)="$event.stopPropagation()"
                          [icon]="expanded ? 'pi pi-chevron-down' : 'pi pi-chevron-right'"
                          styleClass="p-button-text p-button-sm" aria-label="Ver dónde salta el saldo"></p-button>
                }
              </td>
              <td>{{ a.bank }} <span class="muted mono">{{ a.account_label }}</span><span class="sr-only">, abre sus movimientos</span></td>
              <td class="fb-fuente">
                @if (a.sin_saldo) { <span class="muted">—</span> }
                @else if (a.fuente) {
                  <span class="fb-fuente-l" [class.fb-fuente-banco]="a.fuente === 'banco'">{{ a.fuente === 'banco' ? 'Banco' : 'Libro de Tesorería' }}</span>
                  @if (a.hasta) { <span class="mono"> al {{ dm(a.hasta) }}</span> }
                  @if (bancoAdelante(a); as bh) { <span class="fb-fuente-sub">el banco ya trae al {{ dm(bh) }}</span> }
                } @else { <span class="muted" title="La API todavía no dice la fuente">no medido</span> }
              </td>
              <td class="ta-r mono">{{ a.opening | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
              <td class="ta-r mono">{{ a.total_in | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
              <td class="ta-r mono">{{ a.total_out | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
              <td class="ta-r mono muted">{{ a.computed_closing | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
              <td class="ta-r mono fb-strong">{{ a.closing | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
              <td class="ta-r mono">
                @if (a.sin_saldo) { <span class="muted">—</span> }
                @else if (a.cuadra) { <span class="muted">—</span> }
                @else { <span class="bad">{{ a.delta | currency:'MXN':'symbol-narrow':'1.2-2' }}</span> }
              </td>
              <td class="ta-c">
                @if (a.sin_saldo) { <span class="fb-kind">sin saldo</span> }
                @else if (a.cuadra) { <span class="fb-cierra muted"><i class="pi pi-check-circle" aria-hidden="true"></i> cierra</span> }
                @else { <span class="fb-cierra bad"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> no cierra</span> }
              </td>
            </tr>
          </ng-template>
          <ng-template #expandedrow let-a>
            <tr class="fb-break-row"><td colspan="10">
              <div class="fb-breaks">
                <span class="fb-breaks-h"><i class="pi pi-search-plus"></i> Dónde salta el saldo</span>
                @for (b of breaksFor(a); track b.label) {
                  <div class="fb-break">
                    <span class="fb-break-l mono">{{ b.label }}</span>
                    <span class="fb-break-m mono" [class.bad]="(b.monto || 0) < 0">{{ b.monto | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
                  </div>
                }
                <p class="fb-breaks-note muted">En estos renglones el saldo del estado de cuenta salta más de lo que explica el movimiento: ahí falta capturar algo, o el saldo quedó mal tecleado.</p>
              </div>
            </td></tr>
          </ng-template>
          <ng-template #emptymessage>
            <tr><td colspan="10"><div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin cuentas cargadas para {{ period() }}.</p></div></td></tr>
          </ng-template>
        </p-table>
        <p class="fb-recon-note muted">
          Traspasos internos (TI=TE): entra {{ bal.traspasos.entra | currency:'MXN':'symbol-narrow':'1.2-2' }} vs sale {{ bal.traspasos.sale | currency:'MXN':'symbol-narrow':'1.2-2' }}
          <span [class.bad]="!cuadra(bal.traspasos.delta)">(Δ {{ bal.traspasos.delta | currency:'MXN':'symbol-narrow':'1.2-2' }})</span>.
          @if (bal.cuentas_sin_saldo > 0) { · {{ bal.cuentas_sin_saldo }} {{ bal.cuentas_sin_saldo === 1 ? 'cuenta' : 'cuentas' }} sin saldo ni movimientos en el periodo (no hay qué verificar). }
          «Cierra» compara el saldo final con inicial + depósitos − retiros <b>de la fuente de cada cuenta</b>: con el libro, el libro contra sí mismo; con el banco, el saldo del banco.
        </p>
        <!-- [BFU.0.2] Si el banco ya trae más días que el libro, se dice dónde se pasa la cuenta. -->
        @if (adelantadas(bal); as n) {
          <p class="fb-bal-pasar">
            <i class="pi pi-info-circle" aria-hidden="true"></i>
            En {{ n }} {{ n === 1 ? 'cuenta' : 'cuentas' }} la descarga del banco ya trae más días que el libro. Para que su saldo salga del banco, pásala en Estados de cuenta.
            <button type="button" class="fb-xls" (click)="irAEstados.emit()">Ir a Estados de cuenta <i class="pi pi-arrow-right" aria-hidden="true"></i></button>
          </p>
        }
      </div>
    } @else {
      <div class="card-premium card-flat fb-tablewrap fb-bal">
        <h3 class="fb-card-title fb-pnl-title">Cuentas del periodo <span class="muted">— estados de cuenta cargados (sin saldos para verificar el cuadre)</span></h3>
        <p-table [value]="statements()" styleClass="p-datatable-sm" [rowHover]="true">
          <ng-template #header>
            <tr><th pSortableColumn="bank">Banco <p-sorticon field="bank" /></th><th pSortableColumn="account_label">Cuenta <p-sorticon field="account_label" /></th><th pSortableColumn="kind">Tipo <p-sorticon field="kind" /></th><th class="ta-r" pSortableColumn="total_in">Depósitos <p-sorticon field="total_in" /></th><th class="ta-r" pSortableColumn="total_out">Retiros <p-sorticon field="total_out" /></th><th class="ta-r" pSortableColumn="closing_balance">Saldo final <p-sorticon field="closing_balance" /></th></tr>
          </ng-template>
          <ng-template #body let-s>
            <tr>
              <td>{{ s.bank }}</td>
              <td class="mono">{{ s.account_label }}</td>
              <td><span class="fb-kind">{{ kind(s.kind) }}</span></td>
              <td class="ta-r mono">{{ s.total_in | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
              <td class="ta-r mono">{{ s.total_out | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
              <td class="ta-r mono fb-strong">{{ s.closing_balance | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
            </tr>
          </ng-template>
          <ng-template #emptymessage>
            <tr><td colspan="6"><div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin cuentas cargadas para {{ period() }}.</p></div></td></tr>
          </ng-template>
        </p-table>
      </div>
    }
  `,
  styles: [BANCOS_STYLES, `
    /* Boton de export: ghost, discreto -- accion secundaria. */
    .fb-xls { display: inline-flex; align-items: center; gap: 4px; background: none; border: 1px solid var(--border-color);
      border-radius: var(--r-sm); color: var(--text-muted); font: inherit; font-size: var(--fs-xs);
      padding: 2px var(--sp-2); cursor: pointer; margin-left: var(--sp-2); vertical-align: middle; }
    .fb-xls:hover:not(:disabled) { color: var(--text-main); background: var(--hover-bg); }
    .fb-xls:disabled { opacity: .6; cursor: default; }
    .fb-xls:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }

    .fb-bal { margin-bottom: var(--sp-3); }
    .fb-kind { font-size: var(--fs-xs); text-transform: capitalize; color: var(--text-muted); }
    .fb-bal-sinsaldo { opacity: 0.55; }
    .fb-bal-badge { font-size: var(--fs-xs); font-weight: 600; padding: 1px var(--sp-2); border-radius: var(--r-sm); margin-left: var(--sp-2); }
    .fb-bal-badge.ok { color: var(--ok-soft-fg); background: color-mix(in srgb, var(--ok-fg) 12%, transparent); }
    .fb-bal-badge.bad { color: var(--bad-fg); background: color-mix(in srgb, var(--bad-fg) 12%, transparent); }
    .fb-bal-badge.warn { color: var(--warn-soft-fg); background: color-mix(in srgb, var(--warn-fg) 12%, transparent); }
    .fb-bal-fuente { font-size: var(--fs-xs); font-weight: 500; color: var(--text-muted); margin-left: var(--sp-2); }
    .fb-fuente { white-space: nowrap; font-size: var(--fs-xs); }
    .fb-fuente-l { color: var(--text-muted); }
    .fb-fuente-l.fb-fuente-banco { color: var(--text-main); font-weight: 600; }
    .fb-fuente-sub { display: block; color: var(--text-muted); }
    .fb-cierra { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-xs); white-space: nowrap; }
    .fb-bal-pasar { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-2); font-size: var(--fs-xs); color: var(--text-main); margin: var(--sp-2) 0 0; }
    tr.fb-row-click:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    .fb-break-row > td { background: var(--surface-ground); }
    .fb-breaks { display: flex; flex-direction: column; gap: 2px; padding: var(--sp-2) var(--sp-3); }
    .fb-breaks-h { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-xs); font-weight: 700; color: var(--text-main); text-transform: uppercase; letter-spacing: .04em; margin-bottom: var(--sp-1); }
    .fb-break { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-3); font-size: var(--fs-xs); padding: 2px 0; border-bottom: 1px solid var(--border-color); }
    .fb-break-l { color: var(--text-main); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fb-break-m { font-weight: 600; color: var(--text-main); flex: none; }
    .fb-breaks-note { font-size: var(--fs-xs); margin: var(--sp-2) 0 0; }

    /* [BFU.4.5.13] La tira de saldos, arriba del cuadre. */
    .fb-cta-tira { display: block; margin-bottom: var(--sp-3); }
    .muted { color: var(--text-muted); }
  `],
})
export class BancosCuentasComponent {
  readonly exporting = signal(false);
  async exportXls(): Promise<void> {
    this.exporting.set(true);
    try {
      const b = this.balances();
      await exportXlsx('Cuentas ' + this.period(), [
        {
          name: 'Cuadre de saldos', subtitle: this.period(), rows: b?.accounts ?? [],
          cols: [
            { header: 'Banco', get: (r: any) => r.bank, width: 20 },
            { header: 'Cuenta', get: (r: any) => r.account_label, width: 16 },
            { header: 'Fuente', get: (r: any) => (r.fuente === 'banco' ? 'Banco' : r.fuente === 'libro' ? 'Libro de Tesoreria' : 'no medido'), width: 18 },
            { header: 'Hasta', get: (r: any) => r.hasta, type: 'date', width: 12 },
            { header: 'Banco trae hasta', get: (r: any) => r.banco_hasta, type: 'date', width: 14 },
            { header: 'Inicial', get: (r: any) => r.opening, type: 'money' },
            { header: 'Depositos', get: (r: any) => r.total_in, type: 'money', total: true },
            { header: 'Retiros', get: (r: any) => r.total_out, type: 'money', total: true },
            { header: 'Calculado', get: (r: any) => r.computed_closing, type: 'money' },
            { header: 'Final', get: (r: any) => r.closing, type: 'money' },
            { header: 'Diferencia', get: (r: any) => r.delta, type: 'money', total: true },
            { header: 'Cierra (en su fuente)', get: (r: any) => (r.sin_saldo ? 'Sin saldo' : r.cuadra ? 'Si' : 'No'), width: 18 },
          ],
        },
        {
          name: 'Estados cargados', rows: this.statements() ?? [],
          cols: [
            { header: 'Banco', get: (r: any) => r.bank, width: 20 },
            { header: 'Cuenta', get: (r: any) => r.account_label, width: 16 },
            { header: 'Tipo', get: (r: any) => r.kind, width: 12 },
            { header: 'Depositos', get: (r: any) => r.total_in, type: 'money', total: true },
            { header: 'Retiros', get: (r: any) => r.total_out, type: 'money', total: true },
            { header: 'Saldo final', get: (r: any) => r.closing_balance, type: 'money' },
          ],
        },
      ]);
    } finally { this.exporting.set(false); }
  }

  readonly balances = input.required<Balances | null>();
  readonly statements = input.required<BankStatement[]>();
  readonly diagnostico = input.required<Diagnostico | null>();
  readonly period = input<string>('');
  @Output() openAccount = new EventEmitter<{ bank: string; account_label: string }>();
  /** [BFU.0.2] El shell lleva a Estados de cuenta, donde se pasa una cuenta al banco. */
  @Output() irAEstados = new EventEmitter<void>();
  /** [BFU.4.5.13] «Falta explicar» lleva a la vista Ingresos y egresos. */
  @Output() irAIngresos = new EventEmitter<void>();
  dm = dmShort;

  // ── [BFU.4.5.13] Los saldos, en una tira, y las cuentas que piden algo primero ─────────────────────
  readonly cifrasSaldos = computed<MetricStripItem[]>(() => {
    const b = this.balances();
    if (!b) return [];
    const con = b.accounts.filter((a) => !a.sin_saldo);
    const cierran = con.filter((a) => a.cuadra).length, no = con.length - cierran, sin = b.accounts.length - con.length;
    const items: MetricStripItem[] = [
      { label: 'Saldos', value: `${cierran} de ${con.length} cierran`, format: 'text', sub: 'abajo, cuenta por cuenta' },
      { label: 'No cierran', value: no, format: 'number', tone: no ? 'bad' : 'default', sub: no ? 'arriba en la tabla' : 'ninguna' },
      { label: 'Sin movimientos', value: sin, format: 'number', sub: sin ? 'no hay qué verificar' : 'ninguna' },
    ];
    const e = this.diagnostico()?.cobertura_categoria?.explicado;
    if (e) items.push({ label: 'Falta explicar', value: millones(e.por_ligar.monto), format: 'text', drill: 'ingresos',
      drillLabel: 'Ver lo que falta explicar en Ingresos y egresos', sub: `${num(e.por_ligar.n)} movimientos · ver en Ingresos y egresos` });
    return items;
  });
  /** Lo que pide algo arriba: la que no cierra, la que sale del libro o va atrasada contra el banco, la que no tiene saldo. */
  readonly cuentasOrdenadas = computed<BalanceRow[]>(() => {
    const b = this.balances();
    if (!b) return [];
    const peso = (a: BalanceRow) => (!a.sin_saldo && !a.cuadra ? 0 : a.fuente === 'libro' || this.bancoAdelante(a) ? 1 : a.sin_saldo ? 2 : 3);
    return b.accounts.map((a, i) => ({ a, i })).sort((x, y) => peso(x.a) - peso(y.a) || x.i - y.i).map((x) => x.a);
  });
  onDrill(k: string): void { if (k === 'ingresos') this.irAIngresos.emit(); }

  /** [BFU.0.1] Día hasta donde trae el banco, sólo si va adelante de lo que se muestra (cuenta con el libro). */
  bancoAdelante(a: BalanceRow): string | null {
    return a.fuente === 'libro' && a.banco_hasta && (!a.hasta || a.banco_hasta > a.hasta) ? a.banco_hasta : null;
  }
  adelantadas(bal: Balances): number { return bal.accounts.filter((a) => !!this.bancoAdelante(a)).length; }
  /** El resumen de fuentes del encabezado: cuántas cuentas salen del banco y cuántas del libro. */
  fuentes(bal: Balances): string | null {
    const con = bal.accounts.filter((a) => !a.sin_saldo && a.fuente);
    if (!con.length) return null;
    const b = con.filter((a) => a.fuente === 'banco').length, l = con.length - b;
    return [b ? `${b} con el banco` : '', l ? `${l} con el libro de Tesorería` : ''].filter(Boolean).join(' · ');
  }

  cuadra = cuadra;
  kind(k: string): string { return kindLabel(k); }

  breaksFor(a: { bank: string; account_label: string }): { label: string; monto?: number }[] {
    const key = `${a.bank} ${a.account_label}:`;
    const it = this.diagnostico()?.items.find((x) => x.tipo === 'saldo_no_cuadra' && x.titulo.startsWith(key));
    return it?.evidencia ?? [];
  }
}

const num = (v: number) => new Intl.NumberFormat('es-MX').format(Number(v || 0));

/** `[BFU.4.5.6]` Pesos en millones para una cifra («$35.4 M»); debajo del millón, completo. */
function millones(v: number): string {
  const n = Number(v || 0);
  return Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)} M`
    : new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(n);
}
