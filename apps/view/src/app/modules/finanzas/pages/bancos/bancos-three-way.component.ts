import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { DialogModule } from 'primeng/dialog';
import { ButtonModule } from 'primeng/button';
import { BankService, ThreeWay, ThreeWayRow, ThreeWayAccount, ChequesTransito, ThreeWayDetail, BankMovDetail, BankMovSource } from '../../bank.service';
import { money, dmShort } from './bancos-shared';
import { SortState, toggleSort, sortIcon, ariaSort, sortRows } from '../../../../shared/util';
import { exportXlsx, XlsxSheet } from '../../../../shared/export/xlsx-export';
import { BANCOS_STYLES } from './bancos.styles';
import { FINANZAS_SHARED_STYLES } from '../finanzas-shared.styles';
import { ExplainAccount, ExplainMovement, PAIR_META, TwPair, TwRow,
         explainAccounts, explainMovements, totalDelta } from './three-way-explain';

/**
 * CB.24 — Cuadre 3 vías. Enfrenta las TRES fuentes de verdad del banco en el periodo:
 *   • Workbook  = el estado de cuenta (lo que realmente movió el banco).
 *   • Kepler 102 = las pólizas de banco del ERP operativo.
 *   • ContPAQi  = los libros fiscales (con folio de póliza).
 * Nivel 1 (control-total): 2 filas Ingresos/Egresos × 3 fuentes + deltas por par + semáforo.
 * Nivel 2 (por cuenta): las 3 fuentes por banco (Kepler sale de tesorería kdm1, que sí
 * desglosa; el 102 contable estaba lumped). El veredicto y el orden de la tabla miran las
 * fuentes DISPONIBLES de cada cuenta — no sólo ContPAQi — y publican la peor desviación
 * contra el banco como cifra, no como tinte.
 * Presentacional: recibe el payload de threeWay(); sin estado propio.
 */
@Component({
  selector: 'bancos-three-way',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, DialogModule, ButtonModule],
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

      <!-- CB.32 — Cobertura/frescura por fuente: captura pendiente ≠ descuadre.
           La barra mide DÍAS del periodo capturados, no cuántos movimientos trae cada fuente:
           el banco registra en bulto lo que Kepler parte por venta, así que comparar conteos
           entre fuentes marcaba atraso donde sólo había granularidad distinta.
           Va colapsada cuando las 3 van al día: es metadato de confianza, no la conclusión, y
           así ocupaba una card entera con tres barras llenas por encima del cuadre. Se abre
           sola cuando hay atraso — ahí sí es lo que explica el descuadre. -->
      <div class="tw-cov" [class.warn]="anyStale(d)" [class.tw-cov-shut]="!covOpen(d)">
        <button type="button" class="tw-cov-head" (click)="covToggled.set(!covOpen(d))"
                [attr.aria-expanded]="covOpen(d)">
          <i class="pi pi-database" aria-hidden="true"></i>
          <span>Cobertura del periodo <span class="tw-cov-sub">— días capturados</span></span>
          @if (!covOpen(d)) { <span class="tw-cov-sum">{{ covSummary(d) }}</span> }
          @if (d.coverage.is_current_month) { <span class="tw-tag muted-tag">mes en curso</span> }
          <i class="tw-cov-chev pi" [class.pi-chevron-down]="!covOpen(d)" [class.pi-chevron-up]="covOpen(d)" aria-hidden="true"></i>
        </button>
        @if (covOpen(d)) {
        <div class="tw-cov-sources">
          @for (s of covSources(d); track s.key) {
            <div class="tw-cov-src" [class.stale]="s.stale || s.sin_datos">
              <div class="tw-cov-lbl">{{ s.label }}
                @if (s.sin_datos) { <span class="tw-tag warn-tag">sin datos</span> }
                @else if (s.stale) { <span class="tw-tag warn-tag">{{ s.days_target - s.days_covered }} días atrás</span> }
              </div>
              <div class="tw-cov-bar" role="img" [attr.aria-label]="covAria(s)">
                <div class="tw-cov-fill" [style.width.%]="s.pct"></div>
              </div>
              <div class="tw-cov-meta muted" [attr.title]="covAria(s)">
                @if (s.sin_datos) { sin movimientos del periodo }
                @else { día {{ s.days_covered }} de {{ s.days_target }} · {{ s.movs }} movs<span *ngIf="s.last"> · al {{ dmShort(s.last) }}</span> }
              </div>
            </div>
          }
        </div>
        @if (anyStale(d)) {
          <p class="tw-cov-note muted"><i class="pi pi-info-circle"></i> Una fuente va rezagada en captura: sus diferencias son <b>captura pendiente</b>, no descuadre. Se cierran cuando esa fuente se pone al día. El banco (Workbook) va al día.</p>
        }
        }
      </div>

      <!-- Nivel 1 — control-total: aquí cuadran las 3 -->
      <div class="card-premium card-flat tw-card">
        <h3 class="tw-card-title">Control-total <span class="muted">— las 3 fuentes en {{ d.period }} (tolerancia ±{{ d.tolerance | currency:'MXN':'symbol-narrow':'1.2-2' }})</span></h3>
        <div class="tw-wrap">
          <table class="tw-tbl">
            <thead>
              <tr>
                <th scope="col"></th>
                <th scope="col" class="ta-r"><i class="pi pi-building"></i> Workbook</th>
                <th scope="col" class="ta-r"><i class="pi pi-database"></i> Kepler (tesorería)</th>
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
                  <td class="ta-r mono">{{ row.workbook | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  <td class="ta-r mono">{{ row.kepler | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  <td class="ta-r mono">{{ row.contpaqi | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  <td class="ta-r mono" [class.bad]="!cuad(row.delta_wk)" [class.ok]="cuad(row.delta_wk)">
                    @if (cuad(row.delta_wk)) { {{ row.delta_wk | currency:'MXN':'symbol-narrow':'1.2-2' }} }
                    @else {
                      <button type="button" class="tw-dlink" (click)="explain(d, row, 'wk')"
                              [attr.aria-label]="'Ver qué explica el descuadre de ' + row.label + ' entre ' + PAIR_META.wk.a + ' y ' + PAIR_META.wk.b">
                        {{ row.delta_wk | currency:'MXN':'symbol-narrow':'1.2-2' }}<i class="pi pi-search-plus" aria-hidden="true"></i>
                      </button>
                    }
                  </td>
                  <td class="ta-r mono" [class.bad]="!cuad(row.delta_wc)" [class.ok]="cuad(row.delta_wc)">
                    @if (cuad(row.delta_wc)) { {{ row.delta_wc | currency:'MXN':'symbol-narrow':'1.2-2' }} }
                    @else {
                      <button type="button" class="tw-dlink" (click)="explain(d, row, 'wc')"
                              [attr.aria-label]="'Ver qué explica el descuadre de ' + row.label + ' entre ' + PAIR_META.wc.a + ' y ' + PAIR_META.wc.b">
                        {{ row.delta_wc | currency:'MXN':'symbol-narrow':'1.2-2' }}<i class="pi pi-search-plus" aria-hidden="true"></i>
                      </button>
                    }
                  </td>
                  <td class="ta-r mono" [class.bad]="!cuad(row.delta_kc)" [class.ok]="cuad(row.delta_kc)">
                    @if (cuad(row.delta_kc)) { {{ row.delta_kc | currency:'MXN':'symbol-narrow':'1.2-2' }} }
                    @else {
                      <button type="button" class="tw-dlink" (click)="explain(d, row, 'kc')"
                              [attr.aria-label]="'Ver qué explica el descuadre de ' + row.label + ' entre ' + PAIR_META.kc.a + ' y ' + PAIR_META.kc.b">
                        {{ row.delta_kc | currency:'MXN':'symbol-narrow':'1.2-2' }}<i class="pi pi-search-plus" aria-hidden="true"></i>
                      </button>
                    }
                  </td>
                  <td class="ta-c">
                    @if (row.cuadra) { <i class="pi pi-check-circle ok" title="Cuadra dentro de la tolerancia"></i> }
                    @else { <i class="pi pi-exclamation-triangle bad" title="No cuadra — revisa el detalle por cuenta"></i> }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <p class="tw-note muted"><i class="pi pi-info-circle"></i>
          <b>Workbook</b> = tu estado de cuenta (lo que movió el banco). <b>Kepler (tesorería)</b> = movimientos de banco del ERP por cuenta (kdm1, {{ d.kepler_movs }} movs) — <b>misma fuente que la pestaña Conciliación</b>. <b>ContPAQi</b> = libros fiscales ({{ d.kepler_linked }} cuentas enlazadas).
        </p>
      </div>

      <!-- Nivel 2 — por cuenta: las 3 fuentes (Kepler desde tesorería kdm1) -->
      <div class="card-premium card-flat tw-tablewrap">
        <h3 class="tw-card-title tw-pnl-title">Por cuenta
          <span class="muted">— {{ d.kepler_por_cuenta ? 'las 3 fuentes por banco (Kepler desde tesorería)' : 'Workbook ↔ ContPAQi (Kepler aún sin datos del periodo)' }}</span>
          <button type="button" class="tw-xls tw-xls-head" [disabled]="exporting()" (click)="exportCuadre(d)"
                  title="Descarga el control-total y el detalle por cuenta">
            <i class="pi" [class.pi-file-excel]="!exporting()" [class.pi-spin]="exporting()" [class.pi-spinner]="exporting()" aria-hidden="true"></i> Excel
          </button></h3>
        <div class="tw-wrap">
          <p-table [value]="d.por_cuenta" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="46vh">
            <ng-template #header>
              <tr>
                <th rowspan="2" pSortableColumn="bank" title="Banco y número de cuenta">Cuenta <p-sorticon field="bank" /></th>
                <th colspan="3" class="ta-c tw-grp"><i class="pi pi-arrow-down-left tw-in-ico"></i> Depósitos</th>
                <th colspan="3" class="ta-c tw-grp"><i class="pi pi-arrow-up-right"></i> Retiros</th>
                <th rowspan="2" class="ta-r tw-col-dif" pSortableColumn="worst_abs"
                    title="Peor desviación contra el banco entre las fuentes disponibles">Diferencia <p-sorticon field="worst_abs" /></th>
              </tr>
              <tr>
                <th class="ta-r" pSortableColumn="wb_in" title="Estado de cuenta (Workbook)">WB <p-sorticon field="wb_in" /></th>
                <th class="ta-r tw-kep" pSortableColumn="kep_in" title="Kepler tesorería (kdm1, por banco)">Kepler <p-sorticon field="kep_in" /></th>
                <th class="ta-r" pSortableColumn="cp_in" title="Libros ContPAQi">CPQ <p-sorticon field="cp_in" /></th>
                <th class="ta-r" pSortableColumn="wb_out" title="Estado de cuenta (Workbook)">WB <p-sorticon field="wb_out" /></th>
                <th class="ta-r tw-kep" pSortableColumn="kep_out" title="Kepler tesorería (kdm1, por banco)">Kepler <p-sorticon field="kep_out" /></th>
                <th class="ta-r" pSortableColumn="cp_out" title="Libros ContPAQi">CPQ <p-sorticon field="cp_out" /></th>
              </tr>
            </ng-template>
            <ng-template #body let-r>
              <tr class="tw-clickable" [attr.data-acct]="r.account_label" [class.tw-hl]="hlAcct() === r.account_label"
                  (click)="openDrill(d.period, r)" title="Ver detalle a nivel movimiento (Excel ↔ Kepler ↔ ContPAQi)">
                <td><span class="tw-strong">{{ r.bank }}</span> <span class="muted mono">{{ r.account_label }}</span>
                  @if (!r.linked) { <span class="tw-tag muted-tag" title="La cuenta no está enlazada a una cuenta de ContPAQi: se compara sólo contra Kepler">sin enlazar</span> }
                  <i class="pi pi-search-plus tw-drill-ico"></i></td>
                <td class="ta-r mono">{{ r.wb_in | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td class="ta-r mono tw-kep" [class.bad]="r.kep_has && !cuad(r.delta_wk_in)">{{ r.kep_has ? (r.kep_in | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }}</td>
                <td class="ta-r mono" [class.bad]="r.linked && !cuad(r.delta_in)">{{ r.cp_in | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td class="ta-r mono">{{ r.wb_out | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td class="ta-r mono tw-kep" [class.bad]="r.kep_has && !cuad(r.delta_wk_out)">{{ r.kep_has ? (r.kep_out | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }}</td>
                <td class="ta-r mono" [class.bad]="r.linked && !cuad(r.delta_out)">{{ r.cp_out | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <!-- La diferencia se muestra como CIFRA, no sólo como tinte: antes había que
                     restar mentalmente entre columnas separadas para saber cuánto faltaba, y
                     el color era el único portador del problema (§Q.2 / §Q.6). -->
                <td class="ta-r tw-col-dif">
                  @if (!r.comparable) {
                    <span class="tw-tag muted-tag" title="No hay contra qué comparar: la cuenta no está enlazada a ContPAQi y Kepler no tiene movimientos suyos en el periodo">sin comparar</span>
                  } @else if (r.cuadra) {
                    <i class="pi pi-check-circle ok" [attr.title]="'Cuadra contra las fuentes disponibles (±' + money(tol()) + ')'"></i>
                  } @else {
                    <span class="tw-dif">
                      <span class="mono bad">{{ r.worst_delta | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
                      <span class="tw-tag warn-tag">vs {{ r.worst_src === 'K' ? 'Kepler' : 'ContPAQi' }}</span>
                    </span>
                  }
                </td>
              </tr>
            </ng-template>
            <ng-template #emptymessage><tr><td colspan="8"><div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin cuentas para {{ d.period }}.</p></div></td></tr></ng-template>
          </p-table>
        </div>
      </div>
      <!-- CB.30 — Cheques en tránsito: el gap de timing banco↔Kepler -->
      @if (cheques(); as ch) {
        @if (ch.total.cheques_n > 0) {
          <div class="card-premium card-flat tw-card" id="tw-cheques">
            <h3 class="tw-card-title tw-pnl-title">Cheques en tránsito <span class="muted">— Kepler los registra al emitir; el banco, al cobrarse</span></h3>
            <div class="tw-chq-kpis">
              <div class="tw-chq-kpi bad"><span class="tw-chq-v">{{ ch.total.en_transito_monto | currency:'MXN':'symbol-narrow':'1.2-2' }}</span><span class="tw-chq-l">en tránsito · {{ ch.total.en_transito_n }} cheques</span></div>
              <div class="tw-chq-kpi ok"><span class="tw-chq-v">{{ ch.total.cobrado_monto | currency:'MXN':'symbol-narrow':'1.2-2' }}</span><span class="tw-chq-l">ya cobrados · {{ ch.total.cobrado_n }}</span></div>
            </div>
            <p class="tw-note muted"><i class="pi pi-info-circle"></i> Lo <b>en tránsito</b> explica por qué Kepler puede mostrar más salida que el banco: el cheque ya salió en Kepler pero el banco aún no lo cobra. No es descuadre.</p>
            @if (ch.total.en_transito_n > 0) {
              <div class="tw-wrap">
                <table class="tw-tbl tw-chq-tbl">
                  <thead><tr><th>Cuenta</th><th>Doc</th><th>Beneficiario</th><th class="ta-r">Importe</th><th>Emitido</th></tr></thead>
                  <tbody>
                    @for (q of transito(ch); track q.folio) {
                      <tr><td class="mono">{{ q.account_label }}</td><td class="mono muted">{{ q.doc_tipo }} {{ q.folio }}</td>
                        <td class="tw-concept">{{ q.beneficiario || '—' }}</td>
                        <td class="ta-r mono">{{ q.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                        <td class="mono muted">{{ dmShort(q.fecha) }}</td></tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          </div>
        }
      }
    } @else {
      <div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin datos de cuadre para {{ period() }}.</p></div>
    }

    <!-- CB.38 — Qué explica un descuadre del control-total.
         Dos niveles, y el orden importa: primero el reparto POR CUENTA, que suma
         el total exacto, y recién después los movimientos, que ilustran pero no
         cuadran solos (un movimiento casado con importe distinto también mueve
         el Δ). Presentarlos al revés haría creer que la lista de movimientos ES
         el descuadre. -->
    <p-dialog [visible]="expOpen()" (visibleChange)="expOpen.set($event)" [modal]="true" [dismissableMask]="true"
              [style]="{ width: '58rem', maxWidth: '96vw' }" [draggable]="false" [header]="expTitle()">
      @if (expCtx(); as ctx) {
        <p class="dlg-lead">
          Faltan <b class="bad mono">{{ ctx.delta | currency:'MXN':'symbol-narrow':'1.2-2' }}</b> entre
          <b>{{ ctx.a }}</b> y <b>{{ ctx.b }}</b> en {{ ctx.rowLabel | lowercase }} de {{ period() }}.
          Se reparte así entre las cuentas.
          @if (!expResidual()) { <b>Las contribuciones suman el total exacto.</b> }
        </p>

        <!-- Los cheques en tránsito son LA explicación estructural del Δ Workbook−Kepler en
             egresos, y vivían al final de la pantalla, después de una tabla con scroll propio.
             Acá aparecen donde se hace la pregunta. -->
        @if (chequesHint(); as h) {
          <p class="tw-exp-hint">
            <i class="pi pi-info-circle" aria-hidden="true"></i>
            <span><b class="mono">{{ h.monto | currency:'MXN':'symbol-narrow':'1.2-2' }}</b> de esta diferencia
            son <b>{{ h.n }} cheques emitidos y todavía no cobrados</b>: Kepler los descuenta al
            emitirlos, el banco cuando se presentan. No es descuadre.
            <button type="button" class="tw-exp-go tw-hint-go" (click)="goToCheques()">Ver cheques <i class="pi pi-arrow-right" aria-hidden="true"></i></button></span>
          </p>
        }

        @if (expResidual(); as resto) {
          <p class="tw-exp-resid">
            <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
            <span><b class="mono">{{ resto | currency:'MXN':'symbol-narrow':'1.2-2' }}</b> del descuadre
            no cae en ninguna cuenta del desglose: alguna fuente tiene movimientos en una cuenta
            que no está en el catálogo de bancos. Revisá el enlace de cuentas en Configuración.</span>
          </p>
        }

        @if (expAccounts().length) {
          <ol class="tw-exp">
            @for (a of expAccounts(); track a.account_label) {
              <li class="tw-exp-acct">
                <div class="tw-exp-head">
                  <span class="tw-exp-name">
                    <span class="tw-strong">{{ a.bank }}</span>
                    <span class="muted mono">{{ a.account_label }}</span>
                    @if (a.falta_en) { <span class="tw-tag warn-tag">sin datos en {{ a.falta_en }}</span> }
                  </span>
                  <span class="tw-exp-d mono bad">{{ a.delta | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
                  <span class="tw-exp-pct muted">{{ a.pct }}%</span>
                  <button type="button" class="tw-exp-go" (click)="goToAccount(a.account_label)"
                          [attr.aria-label]="'Ir a la cuenta ' + a.account_label + ' en Por cuenta'">
                    Ver en Por cuenta <i class="pi pi-arrow-right" aria-hidden="true"></i>
                  </button>
                </div>

                @if (expMovs()[a.account_label]; as movs) {
                  @if (movs.length) {
                    <table class="tw-tbl tw-exp-tbl">
                      <tbody>
                        @for (m of movs; track $index) {
                          <tr class="tw-clickable" (click)="goToAccount(a.account_label)"
                              [attr.title]="'Ir a ' + a.account_label + ' en Por cuenta y abrir su detalle'">
                            <td class="mono muted nowrap">{{ dmShort(m.fecha) }}</td>
                            <td class="ta-r mono">{{ m.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                            <td><span class="tw-tag muted-tag">falta en {{ m.falta_en }}</span></td>
                            <td class="tw-concept">{{ m.concepto }}</td>
                            <td class="ta-r"><i class="pi pi-arrow-right tw-drill-ico" aria-hidden="true"></i></td>
                          </tr>
                        }
                      </tbody>
                    </table>
                  } @else {
                    <p class="tw-exp-none muted">
                      Ningún movimiento falta por completo en una fuente: la diferencia
                      viene de importes que no coinciden. Se ven en el Detalle 3 vías.
                    </p>
                  }
                } @else if (expLoading()) {
                  <p class="tw-exp-none muted"><i class="pi pi-spin pi-spinner"></i> Cargando movimientos…</p>
                }
              </li>
            }
          </ol>
          @if (expRest() > 0) {
            <p class="tw-exp-rest muted">
              Se muestran las {{ expAccounts().length }} cuentas de mayor aporte
              (cubren el {{ expShownPct() }}% de la diferencia bruta). Quedan {{ expRest() }} con aportes menores.
            </p>
          }
          <p class="tw-note muted"><i class="pi pi-info-circle"></i>
            Los movimientos listados son los que <b>faltan por completo</b> en una de las dos fuentes
            ({{ ctx.hint }}). No suman el Δ por sí solos: un movimiento presente en ambas con importe
            distinto también lo mueve, y ese aparece marcado en el Detalle 3 vías de la cuenta.
          </p>
        } @else {
          <div class="surf-empty"><i class="pi pi-inbox"></i><p>Ninguna cuenta aporta al descuadre por encima de un centavo.</p></div>
        }
      }
    </p-dialog>

    <!-- CB.33 — Drill por cuenta a nivel movimiento -->
    <p-dialog [visible]="drillOpen()" (visibleChange)="drillOpen.set($event)" [modal]="true" [dismissableMask]="true"
              [style]="{ width: '64rem', maxWidth: '96vw' }" [draggable]="false" [header]="drillTitle()">
      @if (drillLoading()) { <div class="surf-empty"><i class="pi pi-spin pi-spinner"></i><p>Cargando movimientos…</p></div> }
      @else if (drillErr()) { <div class="surf-empty"><i class="pi pi-exclamation-triangle bad"></i><p>{{ drillErr() }}</p></div> }
      @else if (drill(); as dd) {
        <p class="dlg-lead">Cada movimiento del <b>banco</b> (Excel) marca si <b>Kepler</b> (tesorería) y <b>ContPAQi</b> (libros) lo tienen, por monto+dirección. Abajo, lo que Kepler o ContPAQi registran y el banco no movió (huérfanos).</p>
        <div class="tw-drill-kpis">
          <span><b>{{ dd.totals.excel_n }}</b> movs banco</span>
          <span class="ok"><b>{{ dd.totals.excel_en_kepler }}</b> en Kepler</span>
          <span class="ok"><b>{{ dd.totals.excel_en_contpaqi }}</b> en ContPAQi</span>
          @if (dd.totals.kepler_only_n) { <span class="warn"><b>{{ dd.totals.kepler_only_n }}</b> solo Kepler ({{ dd.totals.kepler_only_monto | currency:'MXN':'symbol-narrow':'1.2-2' }})</span> }
          @if (dd.totals.contpaqi_only_n) { <span class="warn"><b>{{ dd.totals.contpaqi_only_n }}</b> solo ContPAQi ({{ dd.totals.contpaqi_only_monto | currency:'MXN':'symbol-narrow':'1.2-2' }})</span> }
        </div>
        <div class="tw-drill-filters">
          <div class="tw-fg" role="group" aria-label="Dirección">
            <button type="button" [class.on]="dfDir()===''" (click)="dfDir.set('')">Todos</button>
            <button type="button" [class.on]="dfDir()==='in'" (click)="dfDir.set('in')">Depósitos</button>
            <button type="button" [class.on]="dfDir()==='out'" (click)="dfDir.set('out')">Retiros</button>
          </div>
          <div class="tw-fg" role="group" aria-label="Estado">
            <button type="button" [class.on]="dfEstado()===''" (click)="dfEstado.set('')">Todos</button>
            <button type="button" [class.on]="dfEstado()==='casado'" (click)="dfEstado.set('casado')">En las 3</button>
            <button type="button" [class.on]="dfEstado()==='descuadre'" (click)="dfEstado.set('descuadre')">Falta en alguna</button>
          </div>
          <input type="text" class="tw-fsearch" [ngModel]="dfSearch()" (ngModelChange)="dfSearch.set($event)" placeholder="Buscar concepto / monto…" aria-label="Buscar" />
          <span class="muted tw-fcount">{{ drillRows().length }} de {{ dd.excel.length }}</span>
          <button type="button" class="tw-xls" [disabled]="exporting()" (click)="exportDrill(dd)"
                  title="Descarga lo que estas viendo: con los filtros y el orden puestos">
            <i class="pi" [class.pi-file-excel]="!exporting()" [class.pi-spin]="exporting()" [class.pi-spinner]="exporting()" aria-hidden="true"></i> Excel
          </button>
        </div>
        <div class="tw-wrap">
          <table class="tw-tbl tw-drill-tbl">
            <thead><tr>
              @for (c of DRILL_COLS; track c.field) {
                <th [class]="c.cls" [attr.aria-sort]="ariaSort(drillSort(), c.field)">
                  <button type="button" class="surf-sort" (click)="sortDrill(c.field)"
                          [attr.aria-label]="'Ordenar por ' + c.label">
                    {{ c.label }}<i [class]="sortIcon(drillSort(), c.field)" aria-hidden="true"></i>
                  </button>
                </th>
              }
            </tr></thead>
            <tbody>
              @for (e of drillRows(); track e.id) {
                <tr>
                  <td class="mono muted nowrap">{{ dmShort(e.fecha) }}</td>
                  <td class="ta-c"><i [class]="e.dir === 'in' ? 'pi pi-arrow-down-left tw-in-ico' : 'pi pi-arrow-up-right tw-out-ico'"></i></td>
                  <td class="ta-r mono"><button type="button" class="tw-dlink" (click)="openMov('workbook', e.key)" title="Ver detalle (estado de cuenta)">{{ e.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</button></td>
                  <td class="ta-r mono">@if (e.kepler) { <button type="button" class="tw-dlink" [title]="'Ver detalle (Kepler) · ' + (e.kepler_doc || '')" [class.tw-cent]="e.kepler_importe !== e.importe" (click)="openMov('kepler', e.kepler_key)">{{ e.kepler_importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</button> } @else { <i class="pi pi-minus tw-faint"></i> }</td>
                  <td class="ta-r mono">@if (e.contpaqi) { <button type="button" class="tw-dlink" [title]="'Ver detalle (ContPAQi) · ' + (e.contpaqi_poliza || '')" [class.tw-cent]="e.contpaqi_importe !== e.importe" (click)="openMov('contpaqi', e.contpaqi_key)">{{ e.contpaqi_importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</button> } @else { <i class="pi pi-minus tw-faint"></i> }</td>
                  <td class="tw-concept">{{ e.concepto || '—' }}</td>
                </tr>
              }
              @if (!drillRows().length) { <tr><td colspan="6" class="ta-c muted tw-empty">Sin movimientos con estos filtros.</td></tr> }
            </tbody>
          </table>
        </div>
        @if (dd.kepler_only.length || dd.contpaqi_only.length) {
          <div class="tw-orphans">
            @if (dd.kepler_only.length) {
              <div class="tw-orphan">
                <h4><i class="pi pi-database"></i> En Kepler, sin banco ({{ dd.kepler_only.length }})</h4>
                <table class="tw-tbl"><tbody>
                  @for (k of dd.kepler_only; track k.doc) { <tr class="tw-clickable" (click)="openMov('kepler', k.key)" title="Ver detalle (Kepler)"><td class="mono muted nowrap">{{ dmShort(k.fecha) }}</td><td class="ta-r mono">{{ k.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</td><td class="tw-concept">{{ k.concepto || k.doc }}<i class="pi pi-search-plus tw-drill-ico" aria-hidden="true"></i></td></tr> }
                </tbody></table>
              </div>
            }
            @if (dd.contpaqi_only.length) {
              <div class="tw-orphan">
                <h4><i class="pi pi-book"></i> En ContPAQi, sin banco ({{ dd.contpaqi_only.length }})</h4>
                <table class="tw-tbl"><tbody>
                  @for (c of dd.contpaqi_only; track c.poliza) { <tr class="tw-clickable" (click)="openMov('contpaqi', c.key)" title="Ver detalle (ContPAQi)"><td class="mono muted nowrap">{{ dmShort(c.fecha) }}</td><td class="ta-r mono">{{ c.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</td><td class="tw-concept">{{ c.concepto || c.poliza }}<i class="pi pi-search-plus tw-drill-ico" aria-hidden="true"></i></td></tr> }
                </tbody></table>
              </div>
            }
          </div>
        }
      }
    </p-dialog>

    <!-- CB.40 — Detalle completo de un movimiento (click en cualquier vía del drill) -->
    <p-dialog [visible]="movOpen()" (visibleChange)="movOpen.set($event)" [modal]="true" [dismissableMask]="true"
              [style]="{ width: '34rem', maxWidth: '94vw' }" [draggable]="false" [header]="mov()?.title || 'Movimiento'">
      @if (movLoading()) { <div class="surf-empty"><i class="pi pi-spin pi-spinner"></i><p>Cargando detalle…</p></div> }
      @else if (movErr()) { <div class="surf-empty"><i class="pi pi-exclamation-triangle bad"></i><p>{{ movErr() }}</p></div> }
      @else if (mov(); as m) {
        <dl class="bmv">
          @for (f of m.fields; track f.label) {
            @if (f.value !== null && f.value !== '') { <div class="bmv-row"><dt>{{ f.label }}</dt><dd>{{ f.value }}</dd></div> }
          }
        </dl>
      }
    </p-dialog>
  `,
  styles: [BANCOS_STYLES, FINANZAS_SHARED_STYLES, `
    .bmv { margin: 0; }
    .bmv-row { display: grid; grid-template-columns: 11rem 1fr; gap: var(--sp-2); padding: var(--sp-2) 2px; border-bottom: 1px solid var(--border-color); }
    .bmv-row:last-child { border-bottom: none; }
    .bmv-row dt { color: var(--text-muted); font-size: var(--fs-xs); }
    .bmv-row dd { margin: 0; font-weight: 600; font-variant-numeric: tabular-nums; word-break: break-word; }

    /* Columna Diferencia: cifra + fuente en una línea, alineadas a la derecha como el resto
       de los números. El ancho fijo evita que la tabla salte al cambiar de periodo. */
    .tw-col-dif { min-width: 12rem; }
    .tw-dif { display: inline-flex; align-items: center; gap: var(--sp-2); justify-content: flex-end; }
    /* CB.32 — barra de cobertura/frescura */
    .tw-cov { border: 1px solid var(--border-color); border-radius: var(--r-md); border-left-width: 3px; border-left-color: var(--ok-fg); padding: var(--sp-3) var(--sp-4); margin-bottom: var(--sp-3); }
    .tw-cov.warn { border-left-color: var(--warn-fg); }
    .tw-cov-head { display: flex; align-items: center; gap: var(--sp-2); width: 100%; background: none; border: none;
      font: inherit; font-size: var(--fs-xs); font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
      color: var(--text-muted); margin-bottom: var(--sp-2); padding: 0; cursor: pointer; text-align: left; }
    .tw-cov-head:hover { color: var(--text-main); }
    .tw-cov-head:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; border-radius: var(--r-sm); }
    /* Colapsada no lleva margen bajo el encabezado: la card queda de una línea. */
    .tw-cov-shut .tw-cov-head { margin-bottom: 0; }
    .tw-cov-chev { margin-left: auto; font-size: .7rem; opacity: .6; }
    /* Qué mide la barra, en el encabezado: sin esto "cobertura %" se lee como completitud. */
    .tw-cov-sub { font-weight: 500; text-transform: none; letter-spacing: 0; color: var(--text-faint); }
    /* Resumen que reemplaza a las 3 barras cuando todo va al día. */
    .tw-cov-sum { font-weight: 500; text-transform: none; letter-spacing: 0; color: var(--text-faint); min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tw-cov.warn .tw-cov-sum { color: var(--warn-fg); }
    .tw-cov-sources { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: var(--sp-3); }
    .tw-cov-src { display: flex; flex-direction: column; gap: 3px; }
    .tw-cov-lbl { font-size: var(--fs-xs); font-weight: 600; color: var(--text-main); display: flex; align-items: center; gap: var(--sp-2); }
    .tw-cov-bar { height: 5px; border-radius: var(--r-pill); background: var(--hover-bg); overflow: hidden; }
    .tw-cov-fill { height: 100%; background: var(--ok-fg); border-radius: var(--r-pill); }
    .tw-cov-src.stale .tw-cov-fill { background: var(--warn-fg); }
    .tw-cov-meta { font-size: var(--fs-micro); font-variant-numeric: tabular-nums; }
    .tw-cov-note { font-size: var(--fs-xs); margin: var(--sp-2) 0 0; }
    /* CB.33 — filas clicables (drill) */
    /* CB.30 — cheques en tránsito */
    .tw-chq-kpis { display: flex; gap: var(--sp-4); flex-wrap: wrap; padding: 0 var(--sp-3) var(--sp-2); }
    .tw-chq-kpi { display: flex; flex-direction: column; gap: 1px; }
    .tw-chq-v { font-size: var(--fs-lg); font-weight: 700; font-variant-numeric: tabular-nums; }
    .tw-chq-kpi.bad .tw-chq-v { color: var(--warn-fg); }
    .tw-chq-kpi.ok .tw-chq-v { color: var(--ok-fg); }
    .tw-chq-l { font-size: var(--fs-xs); color: var(--text-muted); }
    .tw-chq-tbl th, .tw-chq-tbl td { padding: var(--sp-1) var(--sp-3); }
    /* CB.33 — dialog drill */
    /* CB.38 — el Δ que no cuadra es un botón: el número que evidencia algo lleva a su arreglo */
    .tw-dlink { font: inherit; font-variant-numeric: tabular-nums; color: inherit; background: none; border: none; padding: 0; cursor: pointer; display: inline-flex; align-items: center; gap: var(--sp-1); text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 3px; }
    .tw-dlink i { font-size: .7rem; opacity: 0; transition: opacity 120ms ease; }
    .tw-dlink:hover i { opacity: .8; }
    .tw-dlink:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; border-radius: var(--r-sm); }
    /* Resalte de la cuenta a la que se llegó desde el panel.
       Va como anillo y no como fondo a propósito: el fondo tendría que ganarle al
       hover de PrimeNG (specificity alta) y eso pedía !important, además de dejar
       la fila sin respuesta al mouse mientras dura el resalte. */
    tr.tw-hl > td { box-shadow: inset 0 1px 0 var(--action), inset 0 -1px 0 var(--action); }
    tr.tw-hl > td:first-child { box-shadow: inset 3px 0 0 var(--action), inset 0 1px 0 var(--action), inset 0 -1px 0 var(--action); }
    tr.tw-hl > td:last-child { box-shadow: inset -1px 0 0 var(--action), inset 0 1px 0 var(--action), inset 0 -1px 0 var(--action); }
    /* Panel de explicación */
    .tw-exp { list-style: none; margin: 0; padding: 0; counter-reset: acct; }
    .tw-exp-acct { border: 1px solid var(--border-color); border-radius: var(--r-md); margin-bottom: var(--sp-2); overflow: hidden; }
    .tw-exp-head { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-2) var(--sp-3); background: var(--surface-ground); flex-wrap: wrap; }
    .tw-exp-name { display: inline-flex; align-items: center; gap: var(--sp-2); min-width: 0; }
    .tw-exp-d { font-weight: 700; margin-left: auto; }
    .tw-exp-pct { font-size: var(--fs-xs); font-variant-numeric: tabular-nums; min-width: 3rem; text-align: right; }
    .tw-exp-go { font: inherit; font-size: var(--fs-xs); color: var(--text-muted); background: none; border: 1px solid var(--border-color); border-radius: var(--r-md); padding: 2px var(--sp-2); cursor: pointer; white-space: nowrap; }
    .tw-exp-go:hover { color: var(--action); border-color: var(--action); }
    .tw-exp-go:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    .tw-exp-tbl td { padding: 3px var(--sp-3); font-size: var(--fs-xs); }
    .tw-exp-none { font-size: var(--fs-xs); padding: var(--sp-2) var(--sp-3); margin: 0; }
    .tw-exp-rest { font-size: var(--fs-xs); margin: var(--sp-2) 0 0; }
    .tw-exp-resid { display: flex; gap: var(--sp-2); align-items: flex-start; font-size: var(--fs-xs); color: var(--text-muted); background: color-mix(in srgb, var(--warn-fg) 10%, transparent); border-radius: var(--r-md); padding: var(--sp-2) var(--sp-3); margin: 0 0 var(--sp-3); }
    .tw-exp-resid i { color: var(--warn-fg); margin-top: 2px; flex: none; }
    .tw-exp-resid b { color: var(--text-main); }
    /* Pista de cheques: informativa, no alarma — por eso neutra y no ámbar como el residuo. */
    .tw-exp-hint { display: flex; gap: var(--sp-2); align-items: flex-start; font-size: var(--fs-xs);
      color: var(--text-muted); background: var(--surface-ground); border-radius: var(--r-md);
      padding: var(--sp-2) var(--sp-3); margin: 0 0 var(--sp-3); }
    .tw-exp-hint i { color: var(--text-faint); margin-top: 2px; flex: none; }
    .tw-exp-hint b { color: var(--text-main); }
    .tw-hint-go { margin-left: var(--sp-2); vertical-align: baseline; }
  `],
})
export class BancosThreeWayComponent {
  readonly data = input.required<ThreeWay | null>();
  readonly period = input<string>('');

  private readonly api = inject(BankService);
  private readonly destroyRef = inject(DestroyRef);

  // CB.30 — cheques en tránsito (se traen al cambiar el periodo).
  readonly cheques = signal<ChequesTransito | null>(null);
  // CB.33 — drill por cuenta a nivel movimiento.
  readonly drillOpen = signal(false);
  readonly drillLoading = signal(false);
  readonly drillErr = signal<string | null>(null);
  readonly drill = signal<ThreeWayDetail | null>(null);
  private drillAcct = '';
  // CB.40 — detalle completo de UN movimiento (click en cualquier vía del drill).
  readonly movOpen = signal(false);
  readonly movLoading = signal(false);
  readonly movErr = signal<string | null>(null);
  readonly mov = signal<BankMovDetail | null>(null);
  openMov(source: BankMovSource, key: string | null): void {
    if (!key) return;
    this.mov.set(null); this.movErr.set(null); this.movOpen.set(true); this.movLoading.set(true);
    this.api.bankMovement(source, key).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.mov.set(d); this.movLoading.set(false); },
      error: (e) => { this.movErr.set(e?.status === 404 ? 'El API no tiene /bank/movement (404) — falta redeploy.' : 'No se pudo cargar el detalle.'); this.movLoading.set(false); },
    });
  }
  // CB.37 — filtros del detalle 3 vías.
  readonly dfDir = signal<'' | 'in' | 'out'>('');
  readonly dfEstado = signal<'' | 'casado' | 'descuadre'>('');
  readonly dfSearch = signal('');
  /** Columnas del Detalle 3 vías: etiqueta + campo por el que ordena. */
  readonly DRILL_COLS = [
    { field: 'fecha',            label: 'Fecha',     cls: '' },
    { field: 'dir',              label: 'Dir',       cls: 'ta-c' },
    { field: 'importe',          label: 'Workbook',  cls: 'ta-r' },
    { field: 'kepler_importe',   label: 'Kepler',    cls: 'ta-r' },
    { field: 'contpaqi_importe', label: 'ContPAQi',  cls: 'ta-r' },
    { field: 'concepto',         label: 'Concepto',  cls: '' },
  ];
  readonly drillSort = signal<SortState | null>(null);
  readonly sortIcon = sortIcon;
  readonly ariaSort = ariaSort;
  sortDrill(field: string): void { this.drillSort.set(toggleSort(this.drillSort(), field)); }

  readonly drillRows = computed(() => {
    const dd = this.drill(); if (!dd) return [];
    const dir = this.dfDir(), est = this.dfEstado(), q = this.dfSearch().trim().toLowerCase();
    const filtered = dd.excel.filter((e) => {
      if (dir && e.dir !== dir) return false;
      if (est === 'casado' && !(e.kepler && e.contpaqi)) return false;
      if (est === 'descuadre' && e.kepler && e.contpaqi) return false;
      if (q && !`${e.concepto || ''} ${e.importe}`.toLowerCase().includes(q)) return false;
      return true;
    });
    // Sin orden elegido se respeta el del backend (cronológico).
    return sortRows(filtered, this.drillSort(), (r, f) => (r as unknown as Record<string, unknown>)[f]);
  });

  constructor() {
    effect(() => {
      const d = this.data();
      this.cheques.set(null);
      this.covToggled.set(null);   // periodo nuevo → la cobertura vuelve a decidir sola
      if (d?.period) {
        this.api.chequesTransito(d.period).pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe({ next: (c) => this.cheques.set(c), error: () => this.cheques.set(null) });
      }
    });
  }

  // ── CB.38 — Qué explica un descuadre del control-total ────────────────────
  /** Cuántas cuentas se detallan. Más de seis deja de ser una explicación. */
  private readonly EXP_TOP = 6;

  readonly PAIR_META = PAIR_META;
  readonly expOpen = signal(false);
  readonly expLoading = signal(false);
  readonly expCtx = signal<{ row: TwRow; pair: TwPair; rowLabel: string; a: string; b: string; hint: string; delta: number } | null>(null);
  /** Reparto por cuenta: exacto, suma el Δ del control-total. */
  readonly expAccounts = signal<ExplainAccount[]>([]);
  /** Movimientos por cuenta; llegan después, en paralelo. */
  readonly expMovs = signal<Record<string, ExplainMovement[]>>({});
  /** Cuentas con aporte que quedaron fuera del top. */
  readonly expRest = signal(0);
  /** Qué parte de la diferencia BRUTA cubren las cuentas mostradas. */
  readonly expShownPct = signal(0);
  /**
   * Δ del control-total menos la suma de TODAS las cuentas.
   *
   * Debería ser cero: el total y el desglose salen del mismo periodo. Pero el
   * total de Kepler suma todas sus cuentas mientras `por_cuenta` sale del cruce
   * Workbook↔ContPAQi, así que una cuenta que exista en Kepler y no en nuestro
   * catálogo entraría al total sin caer en ninguna fila. No pude descartarlo con
   * datos (el feed de Kepler está vacío en local), así que en vez de confiar se
   * calcula y se muestra cuando aparece: el panel no puede afirmar de más.
   */
  readonly expResidual = signal(0);
  /** Cuenta a resaltar en "Por cuenta" al volver del panel. */
  readonly hlAcct = signal<string | null>(null);

  /**
   * Cheques en tránsito, sólo cuando son pertinentes al descuadre que se está mirando: el par
   * Workbook↔Kepler en egresos. En cualquier otro par no explican nada y ofrecerlos sería ruido.
   */
  readonly chequesHint = computed(() => {
    const c = this.expCtx(), ch = this.cheques();
    if (!c || c.pair !== 'wk' || c.row !== 'egresos') return null;
    if (!ch || !ch.total.en_transito_n) return null;
    return { n: ch.total.en_transito_n, monto: ch.total.en_transito_monto };
  });

  /** Del panel al bloque de cheques: cierra y lo trae a la vista. */
  goToCheques(): void {
    this.expOpen.set(false);
    setTimeout(() => document.getElementById('tw-cheques')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60);
  }

  readonly expTitle = computed(() => {
    const c = this.expCtx();
    return c ? `Qué explica el descuadre — ${c.rowLabel} · ${c.a} vs ${c.b}` : 'Descuadre';
  });

  /** Abre el panel para un Δ del control-total. */
  explain(d: ThreeWay, row: ThreeWayRow, pair: TwPair): void {
    const key: TwRow = row.label.toLowerCase().startsWith('ing') ? 'ingresos' : 'egresos';
    const meta = PAIR_META[pair];
    const all = explainAccounts(d, key, pair);
    const top = all.slice(0, this.EXP_TOP);
    const totalAbs = all.reduce((s2, a) => s2 + Math.abs(a.delta), 0) || 1;
    const shown = top.reduce((s2, a) => s2 + Math.abs(a.delta), 0);
    const suma = all.reduce((s2, a) => s2 + a.delta, 0);
    this.expResidual.set(Math.round((totalDelta(row, pair) - suma) * 100) / 100);

    this.expCtx.set({ row: key, pair, rowLabel: row.label, a: meta.a, b: meta.b, hint: meta.hint, delta: totalDelta(row, pair) });
    this.expAccounts.set(top);
    this.expRest.set(all.length - top.length);
    this.expShownPct.set(Math.round((shown / totalAbs) * 100));
    this.expMovs.set({});
    this.expOpen.set(true);
    this.loadExpMovs(d.period, key, pair, top);
  }

  /**
   * Trae el detalle de cada cuenta en paralelo. Una cuenta que falle no tumba al
   * resto: queda sin lista y el reparto —que es lo que explica el número— sigue
   * en pie.
   */
  private loadExpMovs(period: string, row: TwRow, pair: TwPair, accts: ExplainAccount[]): void {
    if (!accts.length) return;
    this.expLoading.set(true);
    forkJoin(
      accts.map((a) =>
        this.api.threeWayDetail(period, a.account_label).pipe(catchError(() => of(null))),
      ),
    )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((res) => {
        const map: Record<string, ExplainMovement[]> = {};
        res.forEach((dd, i) => {
          if (dd) map[accts[i].account_label] = explainMovements(dd as ThreeWayDetail, row, pair);
        });
        this.expMovs.set(map);
        this.expLoading.set(false);
      });
  }

  /**
   * Del panel a la cuenta: cierra, resalta la fila en "Por cuenta", la trae a la
   * vista y abre su detalle a nivel movimiento. El resalte se apaga solo — dejarlo
   * fijo confundiría con un filtro puesto.
   */
  goToAccount(accountLabel: string): void {
    const d = this.data();
    const acct = d?.por_cuenta.find((a) => a.account_label === accountLabel);
    this.expOpen.set(false);
    this.hlAcct.set(accountLabel);
    setTimeout(() => {
      document.querySelector(`[data-acct="${CSS.escape(accountLabel)}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (d && acct) this.openDrill(d.period, acct);
    }, 60);
    setTimeout(() => this.hlAcct.set(null), 4000);
  }

  transito(ch: ChequesTransito) { return ch.cheques.filter((q) => !q.cobrado).slice(0, 50); }

  // -- Export ---------------------------------------------------------------
  // Se exporta LO QUE SE VE: `drillRows()` ya trae filtros + orden aplicados.
  // Los importes van como numero con formato de moneda, no como texto: en Excel
  // se suman. El subtitulo deja escrito que filtros estaban puestos, para que la
  // hoja no mienta cuando alguien la abra fuera de contexto.
  readonly exporting = signal(false);

  private filterNote(dd: ThreeWayDetail): string {
    const f: string[] = [];
    if (this.dfDir()) f.push(this.dfDir() === 'in' ? 'solo depositos' : 'solo retiros');
    if (this.dfEstado()) f.push(this.dfEstado() === 'casado' ? 'solo los que estan en las 3' : 'solo los que faltan en alguna');
    if (this.dfSearch().trim()) f.push('busqueda "' + this.dfSearch().trim() + '"');
    const so = this.drillSort();
    if (so) f.push('orden ' + so.field + ' ' + (so.dir === 'asc' ? 'ascendente' : 'descendente'));
    const base = this.drillAcct + ' - ' + dd.period + ' - ' + this.drillRows().length + ' de ' + dd.excel.length + ' movimientos';
    return f.length ? base + ' - filtros: ' + f.join(', ') : base;
  }

  async exportDrill(dd: ThreeWayDetail): Promise<void> {
    this.exporting.set(true);
    try {
      const sheets: XlsxSheet<any>[] = [{
        name: 'Detalle 3 vias',
        subtitle: this.filterNote(dd),
        rows: this.drillRows(),
        cols: [
          { header: 'Fecha', get: (r: any) => r.fecha, type: 'date', width: 12 },
          { header: 'Direccion', get: (r: any) => (r.dir === 'in' ? 'Deposito' : 'Retiro'), width: 11 },
          { header: 'Workbook', get: (r: any) => r.importe, type: 'money', total: true },
          { header: 'Kepler', get: (r: any) => r.kepler_importe, type: 'money', total: true },
          { header: 'Doc Kepler', get: (r: any) => r.kepler_doc, width: 16 },
          { header: 'ContPAQi', get: (r: any) => r.contpaqi_importe, type: 'money', total: true },
          { header: 'Poliza ContPAQi', get: (r: any) => r.contpaqi_poliza, width: 16 },
          { header: 'Concepto', get: (r: any) => r.concepto, width: 46 },
        ],
      }];
      if (dd.kepler_only.length) {
        sheets.push({
          name: 'En Kepler sin banco', rows: dd.kepler_only,
          cols: [
            { header: 'Fecha', get: (r: any) => r.fecha, type: 'date', width: 12 },
            { header: 'Doc', get: (r: any) => r.doc, width: 16 },
            { header: 'Importe', get: (r: any) => r.importe, type: 'money', total: true },
            { header: 'Metodo', get: (r: any) => r.metodo, width: 14 },
            { header: 'Concepto', get: (r: any) => r.concepto, width: 46 },
          ],
        });
      }
      if (dd.contpaqi_only.length) {
        sheets.push({
          name: 'En ContPAQi sin banco', rows: dd.contpaqi_only,
          cols: [
            { header: 'Fecha', get: (r: any) => r.fecha, type: 'date', width: 12 },
            { header: 'Poliza', get: (r: any) => r.poliza, width: 16 },
            { header: 'Importe', get: (r: any) => r.importe, type: 'money', total: true },
            { header: 'Concepto', get: (r: any) => r.concepto, width: 46 },
          ],
        });
      }
      await exportXlsx('Detalle 3 vias ' + this.drillAcct + ' ' + dd.period, sheets);
    } finally { this.exporting.set(false); }
  }

  async exportCuadre(d: ThreeWay): Promise<void> {
    this.exporting.set(true);
    try {
      await exportXlsx('Cuadre 3 vias ' + d.period, [
        {
          name: 'Control-total', subtitle: d.period + ' - tolerancia +/-' + d.tolerance,
          rows: this.rows(d),
          cols: [
            { header: '', get: (r: any) => r.label, width: 18 },
            { header: 'Workbook', get: (r: any) => r.workbook, type: 'money', total: true },
            { header: 'Kepler (tesoreria)', get: (r: any) => r.kepler, type: 'money', total: true },
            { header: 'ContPAQi', get: (r: any) => r.contpaqi, type: 'money', total: true },
            { header: 'Delta W-K', get: (r: any) => r.delta_wk, type: 'money', total: true },
            { header: 'Delta W-C', get: (r: any) => r.delta_wc, type: 'money', total: true },
            { header: 'Delta K-C', get: (r: any) => r.delta_kc, type: 'money', total: true },
          ],
        },
        {
          name: 'Por cuenta', rows: d.por_cuenta,
          cols: [
            { header: 'Banco', get: (r: any) => r.bank, width: 20 },
            { header: 'Cuenta', get: (r: any) => r.account_label, width: 16 },
            { header: 'Dep. Workbook', get: (r: any) => r.wb_in, type: 'money', total: true },
            { header: 'Dep. Kepler', get: (r: any) => (r.kep_has ? r.kep_in : null), type: 'money', total: true },
            { header: 'Dep. ContPAQi', get: (r: any) => r.cp_in, type: 'money', total: true },
            { header: 'Ret. Workbook', get: (r: any) => r.wb_out, type: 'money', total: true },
            { header: 'Ret. Kepler', get: (r: any) => (r.kep_has ? r.kep_out : null), type: 'money', total: true },
            { header: 'Ret. ContPAQi', get: (r: any) => r.cp_out, type: 'money', total: true },
            { header: 'Diferencia', get: (r: any) => (r.comparable && !r.cuadra ? r.worst_delta : null), type: 'money', total: true },
            { header: 'Diferencia vs', get: (r: any) => (r.comparable && !r.cuadra ? (r.worst_src === 'K' ? 'Kepler' : 'ContPAQi') : ''), width: 14 },
            { header: 'Enlazada a ContPAQi', get: (r: any) => (r.linked ? 'Si' : 'No'), width: 18 },
          ],
        },
      ]);
    } finally { this.exporting.set(false); }
  }

  drillTitle(): string { return this.drillAcct ? `Detalle 3 vías — ${this.drillAcct}` : 'Detalle'; }
  openDrill(period: string, r: ThreeWayAccount): void {
    this.drillAcct = `${r.bank} ${r.account_label}`;
    this.dfDir.set(''); this.dfEstado.set(''); this.dfSearch.set(''); this.drillSort.set(null);
    this.drill.set(null); this.drillErr.set(null); this.drillOpen.set(true); this.drillLoading.set(true);
    this.api.threeWayDetail(period, r.account_label).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (dd) => { this.drill.set(dd); this.drillLoading.set(false); },
      error: () => { this.drillErr.set('No se pudo cargar el detalle de la cuenta.'); this.drillLoading.set(false); },
    });
  }

  /**
   * Tolerancia de cuadre: la manda el servidor. El encabezado imprimía `d.tolerance` mientras
   * las celdas semaforeaban con el 1000 hardcodeado de `cuadra()`; el día que el backend mueva
   * TOL, la pantalla decía "±$X" y pintaba con otro número. El fallback es el mismo valor.
   */
  tol(): number { return this.data()?.tolerance ?? 1000; }
  cuad(delta: number): boolean { return Math.abs(delta) < this.tol(); }
  money = money;
  dmShort = dmShort;

  rows(d: ThreeWay): ThreeWayRow[] { return [d.total.ingresos, d.total.egresos]; }

  verdict(d: ThreeWay): string {
    if (d.cuadra) return `Las 3 fuentes cuadran en ${d.period} (dentro de ±${money(d.tolerance)}).`;
    const gaps: string[] = [];
    const i = d.total.ingresos, e = d.total.egresos;
    if (!i.cuadra) gaps.push(`ingresos (mayor Δ ${money(this.maxDelta(i))})`);
    if (!e.cuadra) gaps.push(`egresos (mayor Δ ${money(this.maxDelta(e))})`);
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

  /**
   * Estado abierto/cerrado del bloque de cobertura. `null` = como venga el periodo: cerrado
   * si las 3 fuentes van al día, abierto si alguna está atrasada. Un clic fija la decisión
   * hasta que cambie el periodo (el effect del constructor lo devuelve a `null`).
   */
  readonly covToggled = signal<boolean | null>(null);
  covOpen(d: ThreeWay): boolean { return this.covToggled() ?? this.anyStale(d); }

  /** Lo que reemplaza a las 3 barras cuando el bloque está cerrado. */
  covSummary(d: ThreeWay): string {
    const mal = this.covSources(d)
      .filter((s) => s.sin_datos || s.stale)
      .map((s) => `${s.label.split(' ')[0]} ${s.sin_datos ? 'sin datos' : `${s.days_target - s.days_covered} días atrás`}`);
    if (mal.length) return mal.join(' · ');
    const wb = d.coverage.workbook;
    return `las 3 fuentes al día${wb.last ? ` (al ${dmShort(wb.last)})` : ''}`;
  }

  /** Lectura en llano de la barra — también es su etiqueta accesible: sola no dice nada. */
  covAria(s: { label: string; sin_datos?: boolean; days_covered: number; days_target: number; movs: number }): string {
    if (s.sin_datos) return `${s.label}: sin movimientos capturados en el periodo.`;
    const falta = s.days_target - s.days_covered;
    const base = `${s.label}: capturado hasta el día ${s.days_covered} de ${s.days_target} esperados (${s.movs} movimientos)`;
    return falta > 0 ? `${base}; van ${falta} días sin captura.` : `${base}; al día.`;
  }
  anyStale(d: ThreeWay): boolean {
    const c = d.coverage;
    return !!(c.kepler.stale || c.contpaqi.stale || c.kepler.sin_datos || c.contpaqi.sin_datos);
  }
}
