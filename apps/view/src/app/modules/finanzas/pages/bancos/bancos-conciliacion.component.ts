import { ChangeDetectionStrategy, Component, EventEmitter, Output, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { DialogModule } from 'primeng/dialog';
import { ContextHelpComponent } from '../../../../shared/context-help/context-help.component';
import { Reconciliation, MatchResult, Differences } from '../../bank.service';
import { CajaIngresoRefComponent } from './caja-ingreso-ref.component';
import { amtPct, cuadra, money, dmy, groupLabel } from './bancos-shared';
import { exportXlsx } from '../../../../shared/export/xlsx-export';
import { BANCOS_STYLES } from './bancos.styles';

/**
 * CB.14 — Vista CONCILIACIÓN (matching por-transacción + caja vs 102 + diferencias).
 * Presentacional: recibe recon/match/differences + flags de carga; emite runMatch y
 * syncFindings para que el shell ejecute las acciones.
 */
@Component({
  selector: 'bancos-conciliacion',
  standalone: true,
  imports: [CommonModule, ButtonModule, TableModule, DialogModule, ContextHelpComponent, CajaIngresoRefComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (reconciliation(); as rc) {
      <!-- CB.15.1 — Answer-first: ¿cuánto dice el Excel vs cuánto dice Kepler? -->
      <div class="card-premium card-flat fb-kve">
        <h3 class="fb-card-title">Kepler vs Excel <span class="muted">— ¿coincide lo que movió el banco con lo que registró Kepler en tesorería? (misma fuente que el Cuadre)</span><app-context-help topic="bancos_caja" /></h3>
        <div class="fb-kve-wrap">
          <table class="fb-kve">
            <thead>
              <tr><th scope="col"></th><th scope="col" class="ta-r">Excel (banco)</th><th scope="col" class="ta-r">Kepler ({{ rc.cash.kepler_source === 'contable' ? '102 contable' : 'tesorería' }})</th><th scope="col" class="ta-r">Diferencia</th><th scope="col" class="ta-c">Estado</th></tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row"><i class="pi pi-arrow-down-left fb-in-ico"></i> Ingresos <span class="muted">(entra)</span></th>
                <td class="ta-r mono">{{ rc.cash.bank_in | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td class="ta-r mono">{{ rc.cash.kepler_102_cargos | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td class="ta-r mono muted">Δ {{ rc.cash.delta_in | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td class="ta-c"><span class="fb-kve-tag memo" title="Los depósitos NO son espejo del 102: mezclan efectivo de CAJA GENERAL y cobranza de otras sucursales. Se cuadra por total, no 1 a 1. Δ informativo, no un gap.">memo</span></td>
              </tr>
              <tr>
                <th scope="row"><i class="pi pi-arrow-up-right fb-out-ico"></i> Egresos <span class="muted">(sale)</span></th>
                <td class="ta-r mono">{{ rc.cash.bank_out | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td class="ta-r mono">{{ rc.cash.kepler_102_abonos | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td class="ta-r mono" [class.bad]="!cuadra(rc.cash.delta_out)" [class.ok]="cuadra(rc.cash.delta_out)">Δ {{ rc.cash.delta_out | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td class="ta-c">
                  @if (cuadra(rc.cash.delta_out)) { <i class="pi pi-check-circle ok" title="Cuadra"></i> }
                  @else { <i class="pi pi-exclamation-triangle bad" title="No cuadra — revisa el detalle abajo"></i> }
                </td>
              </tr>
              @if (rc.factoraje && rc.factoraje.total > 0) {
                <tr class="fb-kve-memo-row">
                  <th scope="row"><i class="pi pi-credit-card fb-fac-ico"></i> Financiamiento <span class="muted">(factoraje)</span></th>
                  <td class="ta-r mono">{{ rc.factoraje.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  <td class="ta-r mono muted">fuera del 102</td>
                  <td class="ta-r mono muted">—</td>
                  <td class="ta-c"><span class="fb-kve-tag memo" title="Factoraje = financiamiento, no pasa por el 102. Se muestra aparte, no entra al cuadre de egresos.">memo</span></td>
                </tr>
              }
              @if (rc.caja && rc.caja.total > 0) {
                <tr class="fb-kve-memo-row">
                  <th scope="row"><i class="pi pi-wallet fb-fac-ico"></i> Caja general <span class="muted">(no fiscal)</span></th>
                  <td class="ta-r mono">{{ rc.caja.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  <td class="ta-r mono muted">fuera del 102</td>
                  <td class="ta-r mono muted">—</td>
                  <td class="ta-c"><span class="fb-kve-tag memo" title="CAJA GENERAL es efectivo NO fiscal: no pasa por el 102. Se muestra aparte y no entra al cuadre (igual que en el CONCENTRADO de contabilidad).">memo</span></td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        @if (rc.factoraje && rc.factoraje.total > 0) {
          <p class="fb-plain fb-fac-note"><i class="pi pi-info-circle"></i> <b>Factoraje {{ rc.factoraje.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</b> = financiamiento (el factor adelanta el dinero), NO cuenta en el cuadre de egresos vs 102. De eso, <b>{{ rc.factoraje.compra | currency:'MXN':'symbol-narrow':'1.2-2' }}</b> es compra que pagó el factor (no salió de tu banco) y <b>{{ rc.factoraje.pago | currency:'MXN':'symbol-narrow':'1.2-2' }}</b> es pago real al factor desde tu banco (pendiente de amarrar contra la cuenta del factor en Kepler).</p>
        }
        @if (rc.caja && rc.caja.total > 0) {
          <p class="fb-plain fb-fac-note"><i class="pi pi-info-circle"></i> <b>Caja general {{ rc.caja.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</b> es efectivo <b>no fiscal</b> — no pasa por el 102, por eso queda fuera del cuadre (igual que en el CONCENTRADO de contabilidad). Se sigue viendo en Movimientos y Concentrado.</p>
        }
        <p class="fb-plain">{{ cajaRead(rc) }}</p>
        @if (rc.sin_clasificar > 0) { <p class="fb-recon-note muted"><i class="pi pi-exclamation-triangle"></i> {{ rc.sin_clasificar | currency:'MXN':'symbol-narrow':'1.2-2' }} en movimientos sin clasificar — sí están contados en los totales, pero sin categoría no se les atribuye concepto. En el tab Cierre está el detalle y cómo resolverlos en Kepler.</p> }
      </div>

      <!-- Referencia (CG.9) — el "memo" de ingresos, descompuesto en Caja General. -->
      <caja-ingreso-ref [period]="period()" />

      <div class="card-premium card-flat fb-match">
        <div class="fb-match-head">
          <h3 class="fb-card-title">Conciliación por transacción <span class="muted">— retiros del banco ↔ pagos del 102 en Kepler</span></h3>
          <div class="fb-match-actions">
            <button pButton type="button" class="p-button-sm p-button-text" [loading]="syncing()" (click)="syncFindings.emit()" title="Empuja las diferencias a la bandeja de /finanzas/hallazgos"><span class="p-button-icon p-button-icon-left pi pi-flag" aria-hidden="true"></span><span class="p-button-label">Enviar a Hallazgos</span></button>
            <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="matching()" (click)="runMatch.emit()"><span class="p-button-icon p-button-icon-left pi pi-bolt" aria-hidden="true"></span><span class="p-button-label">Conciliar</span></button>
          </div>
        </div>
        @if (matchResult(); as mr) {
          <div class="fb-match-res">
            <span class="fb-match-rate mono" [class.ok]="pct(mr) >= 70" [class.warn]="pct(mr) < 70">{{ pct(mr) }}%</span>
            <span class="muted"><b>del monto conciliado</b> — {{ mr.matched_amount | currency:'MXN':'symbol-narrow':'1.2-2' }} de {{ mr.bank_amount | currency:'MXN':'symbol-narrow':'1.2-2' }} · {{ mr.matched | number }} de {{ mr.bank_movements | number }} retiros ({{ mr.match_rate }}% por conteo)</span>
            <span class="muted">· {{ mr.unmatched_bank | number }} sin conciliar en banco · {{ mr.unmatched_kepler | number }} pagos Kepler sin conciliar</span>
          </div>
          <p class="fb-plain">{{ matchRead(mr) }}</p>
        } @else { <p class="fb-recon-note muted">Ejecuta la conciliación para vincular cada retiro con su pago en Kepler (monto + fecha).</p> }
      </div>

      @if (differences(); as df) {
        <div class="fb-diff-grid">
          <div class="card-premium card-flat fb-tablewrap">
            <h3 class="fb-card-title fb-pnl-title">Retiros del banco sin conciliar
              <span class="muted">— {{ df.bank_total.count | number }} · {{ df.bank_total.amount | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
              <app-context-help topic="bancos_retiros_sin_casar" /></h3>
            <p-table [value]="df.bank_unmatched" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="40vh"
                     [paginator]="df.bank_unmatched.length > 25" [rows]="25" [rowsPerPageOptions]="[25, 50, 100]">
              <ng-template #header><tr><th class="col-w6" pSortableColumn="movement_date">Fecha <p-sorticon field="movement_date" /></th><th pSortableColumn="concept">Concepto <p-sorticon field="concept" /></th><th pSortableColumn="category_name">Categoría <p-sorticon field="category_name" /></th><th class="ta-r" pSortableColumn="amount_out">Monto <p-sorticon field="amount_out" /></th></tr></ng-template>
              <ng-template #body let-r>
                <tr class="fb-row-click" (click)="openBank(r)" tabindex="0" role="button" (keyup.enter)="openBank(r)">
                  <td class="mono">{{ dm(r.movement_date) }}</td><td class="fb-concept" [title]="r.concept">{{ r.concept || '—' }}</td>
                  <td class="muted">{{ r.category_name || 'sin clasificar' }}</td><td class="ta-r mono">{{ r.amount_out | currency:'MXN':'symbol-narrow':'1.2-2' }}</td></tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="4"><div class="surf-empty"><i class="pi pi-check-circle"></i><p>Todo conciliado.</p></div></td></tr></ng-template>
            </p-table>
          </div>
          <div class="card-premium card-flat fb-tablewrap">
            <h3 class="fb-card-title fb-pnl-title">Pagos de Kepler sin conciliar
              <span class="muted">— {{ df.kepler_total.count | number }} · {{ df.kepler_total.amount | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
              <app-context-help topic="bancos_kepler_sin_casar" /><button type="button" class="fb-xls" [disabled]="exporting()" (click)="exportXls()" title="Descarga las dos listas sin conciliar"><i class="pi" [class.pi-file-excel]="!exporting()" [class.pi-spin]="exporting()" [class.pi-spinner]="exporting()" aria-hidden="true"></i> Excel</button></h3>
            <p-table [value]="df.kepler_unmatched" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="40vh"
                     [paginator]="df.kepler_unmatched.length > 25" [rows]="25" [rowsPerPageOptions]="[25, 50, 100]">
              <ng-template #header><tr><th class="col-w6" pSortableColumn="fecha">Fecha <p-sorticon field="fecha" /></th><th pSortableColumn="contraparte">Beneficiario <p-sorticon field="contraparte" /></th><th class="col-w5" pSortableColumn="folio">Doc <p-sorticon field="folio" /></th><th class="ta-r" pSortableColumn="importe">Monto <p-sorticon field="importe" /></th></tr></ng-template>
              <ng-template #body let-r>
                <tr class="fb-row-click" (click)="openKepler(r)" tabindex="0" role="button" (keyup.enter)="openKepler(r)">
                  <td class="mono">{{ dm(r.fecha) }}</td><td class="fb-concept" [title]="r.contraparte">{{ r.contraparte || '—' }}</td>
                  <td class="mono muted">{{ r.doc_tipo }} {{ r.folio }}</td><td class="ta-r mono">{{ r.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</td></tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="4"><div class="surf-empty"><i class="pi pi-check-circle"></i><p>Todo conciliado.</p></div></td></tr></ng-template>
            </p-table>
          </div>
        </div>
      }
    } @else {
      <div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin datos de conciliación para {{ period() }}.</p></div>
    }

    <!-- Detalle del renglón (clic en una fila sin conciliar) -->
    <p-dialog [visible]="!!detail()" (visibleChange)="detail.set(null)" [modal]="true" [dismissableMask]="true"
              [header]="detail()?.title || 'Detalle'" [style]="{ width: '30rem' }">
      @if (detail(); as d) {
        <dl class="fb-dl">
          @for (f of d.fields; track f.k) { <div class="fb-dl-row"><dt>{{ f.k }}</dt><dd [class.mono]="f.mono">{{ f.v }}</dd></div> }
        </dl>
        <p class="fb-dl-note muted"><i class="pi pi-info-circle"></i> {{ d.note }}</p>
      }
    </p-dialog>
  `,
  styles: [BANCOS_STYLES, `
    /* Boton de export: ghost, discreto -- accion secundaria. */
    .fb-xls { display: inline-flex; align-items: center; gap: 4px; background: none; border: 1px solid var(--border-color);
      border-radius: var(--r-sm); color: var(--text-muted); font: inherit; font-size: var(--fs-xs);
      padding: 2px var(--sp-2); cursor: pointer; margin-left: var(--sp-2); vertical-align: middle; }
    .fb-xls:hover:not(:disabled) { color: var(--text-main); background: var(--hover-bg); }
    .fb-xls:disabled { opacity: .6; cursor: default; }
    .fb-xls:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 1px; }

    .fb-match { margin-bottom: var(--sp-3); }
    .fb-match-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); flex-wrap: wrap; }
    .fb-match-actions { display: flex; align-items: center; gap: var(--sp-1); flex-wrap: wrap; }
    .fb-match-res { display: flex; align-items: baseline; gap: var(--sp-2); flex-wrap: wrap; margin-top: var(--sp-2); font-size: var(--fs-sm); }
    .fb-match-rate { font-size: var(--fs-lg); font-weight: 700; }
    .fb-match-rate.warn { color: var(--warn-fg); } .fb-match-rate.ok { color: var(--ok-fg); }
    .fb-recon-cash { margin-bottom: var(--sp-3); }
    .fb-recon-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: var(--sp-3); }
    .fb-recon-cell { display: flex; flex-direction: column; gap: 2px; padding: var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md); }
    .fb-recon-l { font-size: var(--fs-xs); color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
    .fb-recon-v { font-size: var(--fs-lg); font-weight: 600; }
    .fb-recon-vs { font-size: var(--fs-xs); }
    .fb-recon-delta { font-size: var(--fs-sm); font-weight: 600; margin-top: 2px; }
    /* CB.15.1 — tabla Kepler vs Excel (answer-first, densa, quiet-luxury). */
    .fb-kve { margin-bottom: var(--sp-3); }
    .fb-kve-wrap { overflow-x: auto; }
    table.fb-kve { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    table.fb-kve th, table.fb-kve td { padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--border-color); }
    table.fb-kve thead th { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .04em; color: var(--text-faint); font-weight: 700; white-space: nowrap; }
    table.fb-kve tbody th[scope=row] { text-align: left; font-weight: 600; color: var(--text-main); white-space: nowrap; }
    table.fb-kve tbody tr:last-child td, table.fb-kve tbody tr:last-child th { border-bottom: none; }
    .fb-fac-ico { color: var(--text-faint); font-size: .8rem; margin-right: 4px; }
    .fb-kve-memo-row td, .fb-kve-memo-row th { border-top: 1px dashed var(--border-color); }
    .fb-fac-note { margin-top: var(--sp-2); }
    .fb-kve-tag { display: inline-block; font-size: var(--fs-micro); font-weight: 700; padding: 1px var(--sp-2); border-radius: var(--r-pill);
      background: color-mix(in srgb, var(--text-faint) 15%, transparent); color: var(--text-muted); text-transform: uppercase; letter-spacing: .03em; }
    .fb-diff-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(22rem, 1fr)); gap: var(--sp-3); margin-top: var(--sp-3); }
    .fb-dl { margin: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
    .fb-dl-row { display: grid; grid-template-columns: 8rem 1fr; gap: var(--sp-2); align-items: baseline; }
    .fb-dl-row dt { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .04em; color: var(--text-faint); font-weight: 700; }
    .fb-dl-row dd { margin: 0; font-size: var(--fs-sm); color: var(--text-main); }
    .fb-dl-note { font-size: var(--fs-xs); margin: var(--sp-4) 0 0; display: flex; align-items: baseline; gap: var(--sp-1); }
  `],
})
export class BancosConciliacionComponent {
  readonly exporting = signal(false);
  async exportXls(): Promise<void> {
    const df = this.differences(); if (!df) return;
    this.exporting.set(true);
    try {
      await exportXlsx('Sin conciliar ' + this.period(), [
        {
          name: 'Banco sin conciliar', subtitle: this.period(), rows: df.bank_unmatched,
          cols: [
            { header: 'Fecha', get: (r: any) => r.movement_date, type: 'date', width: 12 },
            { header: 'Concepto', get: (r: any) => r.concept, width: 48 },
            { header: 'Categoria', get: (r: any) => r.category_name || 'sin clasificar', width: 22 },
            { header: 'Monto', get: (r: any) => r.amount_out, type: 'money', total: true },
          ],
        },
        {
          name: 'Kepler sin conciliar', rows: df.kepler_unmatched,
          cols: [
            { header: 'Fecha', get: (r: any) => r.fecha, type: 'date', width: 12 },
            { header: 'Beneficiario', get: (r: any) => r.contraparte, width: 40 },
            { header: 'Doc', get: (r: any) => (r.doc_tipo || '') + ' ' + (r.folio || ''), width: 18 },
            { header: 'Importe', get: (r: any) => r.importe, type: 'money', total: true },
          ],
        },
      ]);
    } finally { this.exporting.set(false); }
  }

  readonly reconciliation = input.required<Reconciliation | null>();
  readonly matchResult = input.required<MatchResult | null>();
  readonly differences = input.required<Differences | null>();
  readonly matching = input<boolean>(false);
  readonly syncing = input<boolean>(false);
  readonly period = input<string>('');
  @Output() runMatch = new EventEmitter<void>();
  @Output() syncFindings = new EventEmitter<void>();

  cuadra = cuadra;
  pct(mr: { matched_amount: number; bank_amount: number }): number { return amtPct(mr); }
  dm(v: any): string { return dmy(v); }

  /** Detalle del renglón clicado (dialog). El doc real vive en Kepler. */
  readonly detail = signal<{ title: string; fields: { k: string; v: string; mono?: boolean }[]; note: string } | null>(null);
  openBank(r: any): void {
    this.detail.set({
      title: 'Retiro del banco sin conciliar',
      fields: [
        { k: 'Fecha', v: dmy(r.movement_date), mono: true },
        { k: 'Concepto', v: r.concept || '—' },
        { k: 'Tipo (Excel)', v: r.raw_type || '—', mono: true },
        { k: 'Código (Excel)', v: r.raw_code || '—', mono: true },
        { k: 'Categoría', v: r.category_name || 'sin clasificar' },
        { k: 'Grupo', v: r.group_key ? groupLabel(r.group_key) : '—' },
        { k: 'Cuenta Kepler', v: r.kepler_account || '—', mono: true },
        { k: 'Monto', v: money(r.amount_out), mono: true },
      ],
      note: 'Salió del banco pero no se encontró su pago en el 102. En Kepler, búscalo en el auxiliar del 102 por beneficiario + monto + fecha; si no existe, captúralo en la cuenta correcta.',
    });
  }
  openKepler(r: any): void {
    this.detail.set({
      title: `Pago Kepler ${r.doc_tipo || ''} ${r.folio || ''}`.trim(),
      fields: [
        { k: 'Documento', v: `${r.doc_tipo || ''} ${r.folio || ''}`.trim(), mono: true },
        { k: 'Fecha', v: dmy(r.fecha), mono: true },
        { k: 'Beneficiario', v: r.contraparte || '—' },
        { k: 'Importe', v: money(r.importe), mono: true },
      ],
      note: 'Kepler registró este pago en el 102 pero no casó con ningún retiro del banco. Ábrelo en Kepler por su folio (columna Doc) para ver la póliza y verificar de qué banco/fecha salió.',
    });
  }

  matchRead(mr: MatchResult): string {
    if (mr.unmatched_bank === 0) return `Todos los retiros del banco ya tienen su pago en Kepler (100%).`;
    const ap = amtPct(mr);
    return `Ya concilió el ${ap}% del dinero (${money(mr.matched_amount)} de ${money(mr.bank_amount)}). Los ${mr.unmatched_bank} retiros sin conciliar son en su mayoría comisiones y nómina chicas que Kepler agrupa (no concilian 1 a 1) — por eso el % por conteo (${mr.match_rate}%) se ve más bajo que el % por monto.`;
  }
  cajaRead(rc: Reconciliation): string {
    const dOut = Math.abs(rc.cash.delta_out);
    const salida = cuadra(rc.cash.delta_out)
      ? `Los ${money(rc.cash.bank_out)} que salieron del banco cuadran con los abonos del 102 en Kepler.`
      : `De los ${money(rc.cash.bank_out)} que salieron del banco, Kepler reconoce ${money(rc.cash.kepler_102_abonos)} en el 102 — difieren ${money(dOut)}. Esta es la conciliación que importa (el detalle por pago está abajo).`;
    if (cuadra(rc.cash.delta_in)) return salida;
    const dIn = Math.abs(rc.cash.delta_in);
    return `${salida} El lado de depósitos difiere ${money(dIn)}, pero es memo, no un gap: mezcla los depósitos de banco con el efectivo de CAJA GENERAL (que Kepler asienta en caja, no en el 102) y con cobranza que entra por otra sucursal — la columna de depósitos no es espejo del mayor 102, así que ese Δ no se persigue 1 a 1.`;
  }
}
