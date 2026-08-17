import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { DialogModule } from 'primeng/dialog';
import { ButtonModule } from 'primeng/button';
import { BankService, ThreeWay, ThreeWayRow, ThreeWayAccount, ChequesTransito, ThreeWayDetail } from '../../bank.service';
import { cuadra, money, dmShort, SortState, toggleSort, sortIcon, ariaSort, sortRows } from './bancos-shared';
import { exportXlsx, XlsxSheet } from './bancos-export';
import { BANCOS_STYLES } from './bancos.styles';

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
              <div class="tw-cov-meta muted">{{ s.movs }} movs · {{ s.pct }}%<span *ngIf="s.last"> · al {{ dmShort(s.last) }}</span></div>
            </div>
          }
        </div>
        @if (anyStale(d)) {
          <p class="tw-cov-note muted"><i class="pi pi-info-circle"></i> Una fuente va rezagada en captura: sus diferencias son <b>captura pendiente</b>, no descuadre. Se cierran cuando esa fuente se pone al día. El banco (Workbook) va al día.</p>
        }
      </div>

      <!-- Nivel 1 — control-total: aquí cuadran las 3 -->
      <div class="card-premium card-flat tw-card">
        <h3 class="fb-card-title">Control-total <span class="muted">— las 3 fuentes en {{ d.period }} (tolerancia ±{{ d.tolerance | currency:'MXN':'symbol-narrow':'1.2-2' }})</span></h3>
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
                  <td class="ta-r mono" [class.bad]="!cuad(row.delta_wk)" [class.ok]="cuad(row.delta_wk)">{{ row.delta_wk | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  <td class="ta-r mono" [class.bad]="!cuad(row.delta_wc)" [class.ok]="cuad(row.delta_wc)">{{ row.delta_wc | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  <td class="ta-r mono" [class.bad]="!cuad(row.delta_kc)" [class.ok]="cuad(row.delta_kc)">{{ row.delta_kc | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
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
          <b>Workbook</b> = tu estado de cuenta (lo que movió el banco). <b>Kepler (tesorería)</b> = movimientos de banco del ERP por cuenta (kdm1, {{ d.kepler_movs }} movs) — <b>misma fuente que la pestaña Conciliación</b>. <b>ContPAQi</b> = libros fiscales ({{ d.kepler_linked }} cuentas enlazadas).
        </p>
      </div>

      <!-- Nivel 2 — por cuenta: las 3 fuentes (Kepler desde tesorería kdm1) -->
      <div class="card-premium card-flat fb-tablewrap">
        <h3 class="fb-card-title fb-pnl-title">Por cuenta
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
                <th colspan="3" class="ta-c tw-grp"><i class="pi pi-arrow-down-left fb-in-ico"></i> Depósitos</th>
                <th colspan="3" class="ta-c tw-grp"><i class="pi pi-arrow-up-right"></i> Retiros</th>
                <th rowspan="2" class="ta-c" pSortableColumn="linked" title="✓ cuadra Workbook↔ContPAQi · ⚠ no cuadra · sin enlazar">Estado <p-sorticon field="linked" /></th>
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
              <tr class="tw-clickable" (click)="openDrill(d.period, r)" title="Ver detalle a nivel movimiento (Excel ↔ Kepler ↔ ContPAQi)">
                <td><span class="fb-strong">{{ r.bank }}</span> <span class="muted mono">{{ r.account_label }}</span> <i class="pi pi-search-plus tw-drill-ico"></i></td>
                <td class="ta-r mono">{{ r.wb_in | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td class="ta-r mono tw-kep" [class.bad]="r.kep_has && !cuad(r.delta_wk_in)">{{ r.kep_has ? (r.kep_in | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }}</td>
                <td class="ta-r mono" [class.bad]="r.linked && !cuad(r.delta_in)">{{ r.cp_in | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td class="ta-r mono">{{ r.wb_out | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td class="ta-r mono tw-kep" [class.bad]="r.kep_has && !cuad(r.delta_wk_out)">{{ r.kep_has ? (r.kep_out | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }}</td>
                <td class="ta-r mono" [class.bad]="r.linked && !cuad(r.delta_out)">{{ r.cp_out | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
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
      <!-- CB.30 — Cheques en tránsito: el gap de timing banco↔Kepler -->
      @if (cheques(); as ch) {
        @if (ch.total.cheques_n > 0) {
          <div class="card-premium card-flat tw-card">
            <h3 class="fb-card-title fb-pnl-title">Cheques en tránsito <span class="muted">— Kepler los registra al emitir; el banco, al cobrarse</span></h3>
            <div class="tw-chq-kpis">
              <div class="tw-chq-kpi bad"><span class="tw-chq-v">{{ ch.total.en_transito_monto | currency:'MXN':'symbol-narrow':'1.2-2' }}</span><span class="tw-chq-l">en tránsito · {{ ch.total.en_transito_n }} cheques</span></div>
              <div class="tw-chq-kpi ok"><span class="tw-chq-v">{{ ch.total.cobrado_monto | currency:'MXN':'symbol-narrow':'1.2-2' }}</span><span class="tw-chq-l">ya cobrados · {{ ch.total.cobrado_n }}</span></div>
            </div>
            <p class="fb-recon-note muted"><i class="pi pi-info-circle"></i> Lo <b>en tránsito</b> explica por qué Kepler puede mostrar más salida que el banco: el cheque ya salió en Kepler pero el banco aún no lo cobra. No es descuadre.</p>
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
                  <button type="button" class="tw-sort" (click)="sortDrill(c.field)"
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
                  <td class="ta-c"><i [class]="e.dir === 'in' ? 'pi pi-arrow-down-left fb-in-ico' : 'pi pi-arrow-up-right fb-out-ico'"></i></td>
                  <td class="ta-r mono">{{ e.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  <td class="ta-r mono">@if (e.kepler) { <span [title]="e.kepler_doc || ''" [class.tw-cent]="e.kepler_importe !== e.importe">{{ e.kepler_importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</span> } @else { <i class="pi pi-minus tw-faint"></i> }</td>
                  <td class="ta-r mono">@if (e.contpaqi) { <span [title]="e.contpaqi_poliza || ''" [class.tw-cent]="e.contpaqi_importe !== e.importe">{{ e.contpaqi_importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</span> } @else { <i class="pi pi-minus tw-faint"></i> }</td>
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
                  @for (k of dd.kepler_only; track k.doc) { <tr><td class="mono muted nowrap">{{ dmShort(k.fecha) }}</td><td class="ta-r mono">{{ k.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</td><td class="tw-concept">{{ k.concepto || k.doc }}</td></tr> }
                </tbody></table>
              </div>
            }
            @if (dd.contpaqi_only.length) {
              <div class="tw-orphan">
                <h4><i class="pi pi-book"></i> En ContPAQi, sin banco ({{ dd.contpaqi_only.length }})</h4>
                <table class="tw-tbl"><tbody>
                  @for (c of dd.contpaqi_only; track c.poliza) { <tr><td class="mono muted nowrap">{{ dmShort(c.fecha) }}</td><td class="ta-r mono">{{ c.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</td><td class="tw-concept">{{ c.concepto || c.poliza }}</td></tr> }
                </tbody></table>
              </div>
            }
          </div>
        }
      }
    </p-dialog>
  `,
  styles: [BANCOS_STYLES, `
    /* Boton de export: ghost, discreto -- es una accion secundaria. */
    .tw-xls { display: inline-flex; align-items: center; gap: 4px; background: none; border: 1px solid var(--border-color);
      border-radius: var(--r-sm); color: var(--text-muted); font: inherit; font-size: var(--fs-xs);
      padding: 2px var(--sp-2); cursor: pointer; }
    .tw-xls:hover:not(:disabled) { color: var(--text-main); background: var(--hover-bg); }
    .tw-xls:disabled { opacity: .6; cursor: default; }
    .tw-xls:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 1px; }
    .tw-xls-head { margin-left: var(--sp-2); vertical-align: middle; }

    /* Encabezado ordenable de tabla cruda: el th completo es el objetivo de clic. */
    .tw-sort { display: inline-flex; align-items: center; gap: 4px; width: 100%; background: none; border: none;
      font: inherit; color: inherit; cursor: pointer; padding: 0; text-align: inherit; justify-content: inherit; }
    .ta-r .tw-sort { justify-content: flex-end; }
    .ta-c .tw-sort { justify-content: center; }
    .tw-sort i { font-size: .65rem; opacity: .45; }
    .tw-sort:hover i { opacity: .9; }
    .tw-sort:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; border-radius: var(--r-sm); }
    th[aria-sort]:not([aria-sort='none']) .tw-sort { color: var(--action); }
    th[aria-sort]:not([aria-sort='none']) .tw-sort i { opacity: 1; }

    /* Veredicto */
    .tw-verdict { display: flex; align-items: flex-start; gap: var(--sp-3); padding: var(--sp-4);
      border: 1px solid var(--border-color); border-radius: var(--r-md); border-left-width: 3px; margin-bottom: var(--sp-3); }
    .tw-verdict.ok { border-left-color: var(--ok-fg); }
    .tw-verdict.bad { border-left-color: var(--warn-fg); }
    .tw-verdict > i { font-size: 1.5rem; }
    .tw-verdict.ok > i { color: var(--ok-fg); }
    .tw-verdict.bad > i { color: var(--warn-fg); }
    .tw-verdict h3 { font-size: var(--fs-h3); font-weight: 700; margin: 0; color: var(--text-main); }
    .tw-verdict p { font-size: var(--fs-xs); margin: 2px 0 0; line-height: 1.4; }
    .tw-card { margin-bottom: var(--sp-3); }
    .tw-wrap { overflow-x: auto; }
    table.tw-tbl { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    table.tw-tbl th, table.tw-tbl td { padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--border-color); white-space: nowrap; }
    table.tw-tbl thead th { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .04em; color: var(--text-faint); font-weight: 700; }
    table.tw-tbl thead th i { margin-right: 4px; }
    table.tw-tbl tbody th[scope=row] { text-align: left; font-weight: 600; color: var(--text-main); }
    table.tw-tbl tbody tr:last-child td, table.tw-tbl tbody tr:last-child th { border-bottom: none; }
    .tw-tag { display: inline-block; font-size: var(--fs-micro); font-weight: 700; padding: 1px var(--sp-2); border-radius: var(--r-pill); text-transform: uppercase; letter-spacing: .03em; }
    .muted-tag { background: color-mix(in srgb, var(--text-faint) 15%, transparent); color: var(--text-muted); }
    /* Cabecera agrupada Depósitos/Retiros + resalte de la columna Kepler (la fuente nueva) */
    .tw-grp { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .04em; color: var(--text-faint); font-weight: 700; border-bottom: 1px solid var(--border-color); }
    .tw-grp i { margin-right: 4px; }
    :host ::ng-deep th.tw-kep, .tw-kep { background: color-mix(in srgb, var(--chart-2) 6%, transparent); }
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
    .tw-cov-meta { font-size: var(--fs-micro); font-variant-numeric: tabular-nums; }
    .tw-cov-note { font-size: var(--fs-xs); margin: var(--sp-2) 0 0; }
    /* CB.33 — filas clicables (drill) */
    .tw-clickable { cursor: pointer; }
    .tw-clickable:hover { background: var(--hover-bg); }
    .tw-drill-ico { font-size: .7rem; color: var(--text-faint); margin-left: 4px; opacity: 0; transition: opacity 120ms ease; }
    .tw-clickable:hover .tw-drill-ico { opacity: 1; }
    .tw-faint { color: var(--text-faint); font-size: .7rem; }
    .nowrap { white-space: nowrap; }
    .tw-concept { color: var(--text-muted); max-width: 22rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* CB.30 — cheques en tránsito */
    .tw-chq-kpis { display: flex; gap: var(--sp-4); flex-wrap: wrap; padding: 0 var(--sp-3) var(--sp-2); }
    .tw-chq-kpi { display: flex; flex-direction: column; gap: 1px; }
    .tw-chq-v { font-size: var(--fs-lg); font-weight: 700; font-variant-numeric: tabular-nums; }
    .tw-chq-kpi.bad .tw-chq-v { color: var(--warn-fg); }
    .tw-chq-kpi.ok .tw-chq-v { color: var(--ok-fg); }
    .tw-chq-l { font-size: var(--fs-xs); color: var(--text-muted); }
    .tw-chq-tbl th, .tw-chq-tbl td { padding: var(--sp-1) var(--sp-3); }
    /* CB.33 — dialog drill */
    .dlg-lead { font-size: var(--fs-sm); color: var(--text-main); line-height: 1.5; margin: 0 0 var(--sp-3); }
    .tw-drill-kpis { display: flex; gap: var(--sp-3); flex-wrap: wrap; font-size: var(--fs-xs); color: var(--text-muted); margin-bottom: var(--sp-3); }
    .tw-drill-kpis b { color: var(--text-main); }
    .tw-drill-tbl th, .tw-drill-tbl td { padding: var(--sp-1) var(--sp-3); }
    /* CB.37 — filtros del detalle */
    .tw-drill-filters { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-2); }
    .tw-fg { display: inline-flex; border: 1px solid var(--border-color); border-radius: var(--r-md); overflow: hidden; }
    .tw-fg button { background: var(--card-bg); border: none; border-right: 1px solid var(--border-color); padding: 3px var(--sp-3); font-size: var(--fs-xs); color: var(--text-muted); cursor: pointer; }
    .tw-fg button:last-child { border-right: none; }
    .tw-fg button:hover { color: var(--text-main); }
    .tw-fg button.on { background: color-mix(in srgb, var(--action) 10%, transparent); color: var(--action); font-weight: 600; }
    .tw-fsearch { padding: 3px var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); color: var(--text-main); font-size: var(--fs-xs); min-width: 12rem; }
    .tw-fcount { font-size: var(--fs-xs); margin-left: auto; }
    .tw-cent { color: var(--warn-fg); } /* monto de la fuente ≠ workbook (centavos/tolerancia) */
    .tw-empty { padding: var(--sp-4); }
    .tw-orphans { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-3); margin-top: var(--sp-3); }
    @media (max-width: 720px) { .tw-orphans { grid-template-columns: 1fr; } }
    .tw-orphan { border: 1px solid var(--border-color); border-radius: var(--r-md); overflow: hidden; }
    .tw-orphan h4 { font-size: var(--fs-xs); font-weight: 700; color: var(--text-main); margin: 0; padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--border-color); background: var(--surface-ground); }
    .tw-orphan table td { padding: 3px var(--sp-3); border-bottom: 1px solid var(--border-color); font-size: var(--fs-xs); }
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
      if (d?.period) {
        this.api.chequesTransito(d.period).pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe({ next: (c) => this.cheques.set(c), error: () => this.cheques.set(null) });
      }
    });
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

  cuad = cuadra;
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
  anyStale(d: ThreeWay): boolean {
    const c = d.coverage;
    return !!(c.kepler.stale || c.contpaqi.stale || c.kepler.sin_datos || c.contpaqi.sin_datos);
  }
}
