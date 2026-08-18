import { ChangeDetectionStrategy, Component, DestroyRef, EventEmitter, Output, computed, inject, signal, input } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { DialogModule } from 'primeng/dialog';
import { BankService, ContpaqiCompare, ContpaqiCompareRow, ContpaqiBankAccount, ContpaqiDetail, CpqReconSide, FactorajeCompare } from '../../bank.service';
import { cuadra, money, dmShort } from './bancos-shared';
import { exportXlsx } from '../../../../shared/export/xlsx-export';
import { BANCOS_STYLES } from './bancos.styles';

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
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, SelectModule, DialogModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (compare(); as c) {
      <!-- Answer-first: ¿la contabilidad registró lo mismo que movió el banco? -->
      <div class="card-premium card-flat fb-kve">
        <div class="cpq-head">
          <h3 class="fb-card-title">Banco vs Contabilidad (ContPAQi) <span class="muted">— ¿los libros registran lo mismo que movió el banco en {{ c.period }}?</span></h3>
          <button pButton type="button" class="p-button-sm p-button-text" [loading]="linking()" (click)="link.emit()" title="Auto-enlaza cada cuenta de banco con su cuenta contable 102xxx de ContPAQi"><span class="p-button-icon p-button-icon-left pi pi-link" aria-hidden="true"></span><span class="p-button-label">Enlazar cuentas</span></button>
        </div>

        <!-- Qué significa cada columna (comprehension-first: explicar antes de comparar). -->
        <dl class="cpq-legend">
          <div><dt><i class="pi pi-building fb-in-ico"></i> Excel (banco)</dt><dd>Lo que <b>realmente se movió</b> en la cuenta según tu estado de cuenta del banco (el workbook que subiste). Es la realidad del dinero.</dd></div>
          <div><dt><i class="pi pi-book"></i> ContPAQi (libros)</dt><dd>Lo que <b>la contabilidad registró</b> en pólizas para esa misma cuenta (cuenta 102xxx). Es la verdad fiscal, con folio de póliza.</dd></div>
          <div><dt><i class="pi pi-arrows-h"></i> Diferencia (Δ)</dt><dd>Banco − libros. Si es <b>$0 cuadra</b>: ambos dicen lo mismo. Si no, la contabilidad registró de más o de menos que el banco.</dd></div>
          <div><dt><i class="pi pi-arrow-down-left fb-in-ico"></i> Depósitos / <i class="pi pi-arrow-up-right fb-out-ico"></i> Retiros</dt><dd>Dinero que <b>entró</b> (depósitos) y que <b>salió</b> (retiros) de la cuenta en {{ c.period }}.</dd></div>
        </dl>
        <div class="fb-kve-wrap">
          <table class="fb-kve">
            <thead>
              <tr><th scope="col"></th><th scope="col" class="ta-r">Excel (banco)</th><th scope="col" class="ta-r">ContPAQi (libros)</th><th scope="col" class="ta-r">Diferencia</th><th scope="col" class="ta-c">Estado</th></tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row"><i class="pi pi-arrow-down-left fb-in-ico"></i> Depósitos <span class="muted">(entra)</span></th>
                <td class="ta-r mono">{{ c.totals.excel_in | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td class="ta-r mono">{{ c.totals.contpaqi_in | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td class="ta-r mono" [class.bad]="!cuad(c.totals.delta_in)" [class.ok]="cuad(c.totals.delta_in)">Δ {{ c.totals.delta_in | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td class="ta-c">
                  @if (cuad(c.totals.delta_in)) { <i class="pi pi-check-circle ok" title="Cuadra"></i> }
                  @else { <i class="pi pi-exclamation-triangle bad" title="No cuadra — revisa el detalle por cuenta"></i> }
                </td>
              </tr>
              <tr>
                <th scope="row"><i class="pi pi-arrow-up-right fb-out-ico"></i> Retiros <span class="muted">(sale)</span></th>
                <td class="ta-r mono">{{ c.totals.excel_out | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td class="ta-r mono">{{ c.totals.contpaqi_out | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td class="ta-r mono" [class.bad]="!cuad(c.totals.delta_out)" [class.ok]="cuad(c.totals.delta_out)">Δ {{ c.totals.delta_out | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
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
        <p class="fb-recon-note muted"><i class="pi pi-info-circle"></i> Se comparan solo <b>cuentas bancarias</b>. <b>CAJA</b> (efectivo) y <b>FACTORAJE</b> (financiamiento) quedan fuera: no son cuentas de banco 102xxx en ContPAQi, así que se concilian en sus propios flujos.</p>
      </div>

      <!-- Detalle por cuenta -->
      <div class="card-premium card-flat fb-tablewrap">
        <h3 class="fb-card-title fb-pnl-title">Detalle por cuenta<button type="button" class="fb-xls" [disabled]="exporting()" (click)="exportXls()" title="Descarga la comparacion por cuenta"><i class="pi" [class.pi-file-excel]="!exporting()" [class.pi-spin]="exporting()" [class.pi-spinner]="exporting()" aria-hidden="true"></i> Excel</button></h3>
        <p-table [value]="c.rows" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="52vh">
          <ng-template #header>
            <tr>
              <th pSortableColumn="bank" title="Banco y número de cuenta (según tu Excel bancario)">Cuenta <p-sorticon field="bank" /></th>
              <th pSortableColumn="contpaqi_cuenta" title="Cuenta contable 102xxx de ContPAQi enlazada a esta cuenta de banco">Libro ContPAQi <p-sorticon field="contpaqi_cuenta" /></th>
              <th class="ta-r" pSortableColumn="excel_in" title="Depósitos según tu estado de cuenta del banco (Excel)">Dep. Excel <p-sorticon field="excel_in" /></th>
              <th class="ta-r" pSortableColumn="contpaqi_in" title="Depósitos que la contabilidad registró en pólizas (ContPAQi)">Dep. ContPAQi <p-sorticon field="contpaqi_in" /></th>
              <th class="ta-r" pSortableColumn="delta_in" title="Diferencia de depósitos: banco − libros. $0 = cuadra">Δ dep. <p-sorticon field="delta_in" /></th>
              <th class="ta-r" pSortableColumn="excel_out" title="Retiros según tu estado de cuenta del banco (Excel)">Ret. Excel <p-sorticon field="excel_out" /></th>
              <th class="ta-r" pSortableColumn="contpaqi_out" title="Retiros que la contabilidad registró en pólizas (ContPAQi)">Ret. ContPAQi <p-sorticon field="contpaqi_out" /></th>
              <th class="ta-r" pSortableColumn="delta_out" title="Diferencia de retiros: banco − libros. $0 = cuadra">Δ ret. <p-sorticon field="delta_out" /></th>
              <th class="ta-c" pSortableColumn="linked" title="✓ cuadra · ⚠ no cuadra · sin enlazar · sin Excel">Estado <p-sorticon field="linked" /></th>
              <th class="ta-c" title="Abre el detalle movimiento a movimiento: dónde está el error"></th>
            </tr>
          </ng-template>
          <ng-template #body let-r>
            <tr>
              <td><span class="fb-strong">{{ r.bank }}</span> <span class="muted mono">{{ r.account_label }}</span></td>
              <td class="mono muted" [title]="r.contpaqi_cuenta_nombre || ''">{{ r.contpaqi_cuenta || '—' }}</td>
              <td class="ta-r mono">{{ r.excel_in | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
              <td class="ta-r mono">{{ r.contpaqi_in | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
              <td class="ta-r mono" [class.bad]="r.linked && !cuad(r.delta_in)">{{ r.delta_in | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
              <td class="ta-r mono">{{ r.excel_out | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
              <td class="ta-r mono">{{ r.contpaqi_out | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
              <td class="ta-r mono" [class.bad]="r.linked && !cuad(r.delta_out)">{{ r.delta_out | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
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
              <td class="ta-c">
                @if (r.linked) {
                  <p-button type="button" icon="pi pi-search-plus" styleClass="p-button-text p-button-sm btn-where"
                          [label]="(!cuad(r.delta_in) || !cuad(r.delta_out)) ? 'Ver dónde' : ''"
                          (click)="openDetail(r)" title="Detalle movimiento a movimiento: dónde está el descuadre"></p-button>
                }
              </td>
            </tr>
          </ng-template>
          <ng-template #emptymessage><tr><td colspan="10"><div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin cuentas.</p></div></td></tr></ng-template>
        </p-table>
      </div>

      <!-- Factoraje a proveedores: compras factoradas del Excel vs el proveedor en ContPAQi. -->
      @if (factoraje(); as f) {
        <div class="card-premium card-flat fb-tablewrap">
          <h3 class="fb-card-title fb-pnl-title">Factoraje a proveedores <span class="muted">— compras liquidadas por factoraje (no tocan banco), contra el proveedor en ContPAQi</span></h3>
          <p class="fb-plain fjt-lead">El factoraje del Excel son <b>compras con factoraje</b> a proveedores: se pagan vía una línea de factoraje, no desde un banco, por eso no están en «Banco vs Contabilidad». Aquí las contrastamos contra ese proveedor en ContPAQi (su costo y su cuenta por pagar). Es <b>contexto</b> —los montos difieren por IVA y momento de registro—, no un cuadre exacto.</p>
          @if (!f.rows.length) {
            <div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin compras con factoraje en {{ f.period }}.</p></div>
          } @else {
            <p-table [value]="f.rows" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="40vh">
              <ng-template #header>
                <tr>
                  <th title="Proveedor al que se le compró con factoraje (según el Excel)">Proveedor</th>
                  <th class="ta-r" title="Total de compras con factoraje del Excel en el mes">Factoraje (Excel)</th>
                  <th class="ta-c" title="Número de movimientos factorados">Movs</th>
                  <th title="Cuenta por pagar del proveedor en ContPAQi (212x)">CxP ContPAQi</th>
                  <th class="ta-r" title="Compra registrada en la cuenta de costo del proveedor (50x) en el mes">Costo ContPAQi</th>
                  <th class="ta-c" title="¿Se identificó el proveedor en ContPAQi?">Match</th>
                </tr>
              </ng-template>
              <ng-template #body let-r>
                <tr>
                  <td><span class="fb-strong">{{ r.proveedor }}</span></td>
                  <td class="ta-r mono">{{ r.excel_out | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  <td class="ta-c mono muted">{{ r.movs }}</td>
                  <td class="mono muted" [title]="r.cxp_nombre || ''">
                    @if (r.cxp_cuenta) { {{ r.cxp_cuenta }} <span class="fjt-mini">(mes: {{ r.cxp_cargos | currency:'MXN':'symbol-narrow':'1.2-2' }})</span> }
                    @else { — }
                  </td>
                  <td class="ta-r mono">
                    @if (r.costo_cuentas) { {{ r.costo_cargos | currency:'MXN':'symbol-narrow':'1.2-2' }} }
                    @else { <span class="muted">—</span> }
                  </td>
                  <td class="ta-c">
                    @if (r.matched) { <i class="pi pi-check-circle ok" title="Proveedor identificado en ContPAQi"></i> }
                    @else { <span class="cpq-tag muted-tag" title="No se encontró el proveedor en ContPAQi">sin match</span> }
                  </td>
                </tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="6"><div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin factoraje.</p></div></td></tr></ng-template>
            </p-table>
            <p class="fb-recon-note muted fjt-foot"><i class="pi pi-info-circle"></i> <b>{{ f.matched }}</b> de {{ f.rows.length }} proveedores identificados en ContPAQi · Total factoraje Excel {{ f.totals.excel_out | currency:'MXN':'symbol-narrow':'1.2-2' }} · Costo ContPAQi de esos proveedores {{ f.totals.costo_cargos | currency:'MXN':'symbol-narrow':'1.2-2' }}.</p>
          }
        </div>
      }
    } @else {
      <div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin comparación para {{ period() }}.</p></div>
    }

    <!-- Drill: DÓNDE está el descuadre — movimiento a movimiento, huérfanos de cada lado. -->
    <p-dialog [visible]="detailOpen()" (visibleChange)="detailOpen.set($event)" [modal]="true" [dismissableMask]="true"
              [style]="{ width: '62rem', maxWidth: '96vw' }" [draggable]="false" [header]="detailTitle()">
      @if (detailLoading()) {
        <div class="surf-empty"><i class="pi pi-spin pi-spinner"></i><p>Cargando movimientos…</p></div>
      } @else if (detailErr()) {
        <div class="surf-empty"><i class="pi pi-exclamation-triangle bad"></i><p>{{ detailErr() }}</p></div>
      } @else if (detail()) {
        @if (detail(); as d) {
        <p class="dlg-lead">Enfrentamos cada movimiento del <b>banco</b> contra las <b>pólizas de ContPAQi</b> de esta cuenta en {{ d.period }}. Lo que casa por importe desaparece; <b>lo que queda es el descuadre</b>: o el banco lo movió y la contabilidad no lo registró, o la contabilidad registró algo que el banco no movió.</p>

        @for (side of sides(d); track side.key) {
          <div class="dlg-side">
            <div class="dlg-side-head">
              <h4><i [class]="side.icon"></i> {{ side.title }}</h4>
              @if (cuad(side.data.delta)) {
                <span class="cpq-tag ok-tag"><i class="pi pi-check"></i> Cuadra</span>
              } @else {
                <span class="cpq-tag bad-tag">Δ {{ side.data.delta | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
              }
            </div>
            <p class="dlg-side-sub muted">
              Banco {{ side.data.bank_total | currency:'MXN':'symbol-narrow':'1.2-2' }} ·
              ContPAQi {{ side.data.contpaqi_total | currency:'MXN':'symbol-narrow':'1.2-2' }} ·
              {{ side.data.matched_count }} movs casados
            </p>

            @if (!side.data.bank_only.length && !side.data.contpaqi_only.length) {
              <p class="dlg-clean muted"><i class="pi pi-check-circle ok"></i> Todo casa: cada movimiento del banco tiene su póliza.</p>
            } @else {
              <div class="dlg-cols">
                <!-- Banco sin póliza -->
                <div class="dlg-col">
                  <div class="dlg-col-head bank"><i class="pi pi-building"></i> En el banco, <b>sin póliza</b> ({{ side.data.bank_only.length }}) · {{ side.data.bank_only_amount | currency:'MXN':'symbol-narrow':'1.2-2' }}</div>
                  <p class="dlg-col-hint muted">La contabilidad no registró estos movimientos (o los puso en otra cuenta/mes).</p>
                  @if (side.data.bank_only.length) {
                    <table class="dlg-mini"><tbody>
                      @for (m of side.data.bank_only; track m.id) {
                        <tr><td class="mono nowrap">{{ dmShort(m.fecha) }}</td>
                            <td class="mono ta-r">{{ m.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                            <td class="dlg-concept" [title]="m.concepto || ''">{{ m.concepto || m.categoria || '—' }}</td></tr>
                      }
                    </tbody></table>
                  } @else { <p class="dlg-none muted">— nada —</p> }
                </div>
                <!-- Póliza sin banco -->
                <div class="dlg-col">
                  <div class="dlg-col-head book"><i class="pi pi-book"></i> En ContPAQi, <b>sin banco</b> ({{ side.data.contpaqi_only.length }}) · {{ side.data.contpaqi_only_amount | currency:'MXN':'symbol-narrow':'1.2-2' }}</div>
                  <p class="dlg-col-hint muted">La contabilidad registró estas pólizas que el banco no movió (registro de más, o de otro mes).</p>
                  @if (side.data.contpaqi_only.length) {
                    <table class="dlg-mini"><tbody>
                      @for (m of side.data.contpaqi_only; track m.id) {
                        <tr><td class="mono nowrap">{{ dmShort(m.fecha) }}</td>
                            <td class="mono ta-r">{{ m.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                            <td class="dlg-concept" [title]="m.concepto || ''">
                              @if (m.poliza_folio) { <span class="muted mono">#{{ m.poliza_folio }}</span> }
                              {{ m.concepto || '—' }}
                            </td></tr>
                      }
                    </tbody></table>
                  } @else { <p class="dlg-none muted">— nada —</p> }
                </div>
              </div>
            }
          </div>
        }
        }
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

    .fb-kve { margin-bottom: var(--sp-3); }
    .fb-kve-wrap { overflow-x: auto; }
    .cpq-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); flex-wrap: wrap; }
    .cpq-legend { display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: var(--sp-2) var(--sp-4); margin: 0 0 var(--sp-3); padding: var(--sp-3); background: var(--surface-ground)); border: 1px solid var(--border-color); border-radius: var(--r-md); }
    .cpq-legend > div { display: flex; flex-direction: column; gap: 2px; }
    .cpq-legend dt { font-size: var(--fs-xs); font-weight: 700; color: var(--text-main); }
    .cpq-legend dt i { margin-right: 4px; }
    .cpq-legend dd { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.4; }
    table.fb-kve { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    table.fb-kve th, table.fb-kve td { padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--border-color); }
    table.fb-kve thead th { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .04em; color: var(--text-faint); font-weight: 700; white-space: nowrap; }
    table.fb-kve tbody th[scope=row] { text-align: left; font-weight: 600; color: var(--text-main); white-space: nowrap; }
    table.fb-kve tbody tr:last-child td, table.fb-kve tbody tr:last-child th { border-bottom: none; }
    .cpq-tag { display: inline-block; font-size: var(--fs-micro); font-weight: 700; padding: 1px var(--sp-2); border-radius: var(--r-pill); text-transform: uppercase; letter-spacing: .03em; }
    .muted-tag { background: color-mix(in srgb, var(--text-faint) 15%, transparent); color: var(--text-muted); }
    .ok-tag { background: color-mix(in srgb, var(--ok-fg) 16%, transparent); color: var(--ok-fg); }
    .bad-tag { background: color-mix(in srgb, var(--bad-fg) 16%, transparent); color: var(--bad-fg); font-variant-numeric: tabular-nums; }
    .btn-where :is(.p-button-label) { font-size: var(--fs-xs); }
    /* Drill dialog */
    .dlg-lead { font-size: var(--fs-sm); color: var(--text-main); line-height: 1.5; margin: 0 0 var(--sp-4); }
    .dlg-side { margin-bottom: var(--sp-5); }
    .dlg-side-head { display: flex; align-items: center; gap: var(--sp-2); }
    .dlg-side-head h4 { font-size: var(--fs-sm); font-weight: 700; color: var(--text-main); margin: 0; }
    .dlg-side-sub { font-size: var(--fs-xs); margin: 2px 0 var(--sp-2); }
    .dlg-clean { font-size: var(--fs-sm); margin: var(--sp-2) 0; }
    .dlg-cols { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-3); }
    @media (max-width: 720px) { .dlg-cols { grid-template-columns: 1fr; } }
    .dlg-col { border: 1px solid var(--border-color); border-radius: var(--r-md); overflow: hidden; }
    .dlg-col-head { font-size: var(--fs-xs); font-weight: 700; padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--border-color); }
    .dlg-col-head.bank { background: color-mix(in srgb, var(--action) 10%, transparent); color: var(--text-main); }
    .dlg-col-head.book { background: color-mix(in srgb, var(--text-faint) 10%, transparent); color: var(--text-main); }
    .dlg-col-hint { font-size: var(--fs-micro); margin: var(--sp-2) var(--sp-3) 0; line-height: 1.35; }
    .dlg-mini { width: 100%; border-collapse: collapse; font-size: var(--fs-xs); margin-top: var(--sp-2); }
    .dlg-mini td { padding: 3px var(--sp-3); border-top: 1px solid var(--border-color); vertical-align: top; }
    .dlg-concept { color: var(--text-muted); max-width: 16rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dlg-none { font-size: var(--fs-xs); padding: var(--sp-2) var(--sp-3); }
    .nowrap { white-space: nowrap; }
    /* Factoraje */
    .fjt-lead { padding: 0 var(--sp-3); margin: 0 0 var(--sp-3); }
    .fjt-mini { font-size: var(--fs-micro); color: var(--text-faint); }
    .fjt-foot { padding: 0 var(--sp-3) var(--sp-3); }
  `],
})
export class BancosContpaqiComponent {
  readonly exporting = signal(false);
  async exportXls(): Promise<void> {
    const c = this.compare(); if (!c) return;
    this.exporting.set(true);
    try {
      await exportXlsx('Banco vs ContPAQi ' + c.period, [{
        name: 'Por cuenta', subtitle: c.period, rows: c.rows,
        cols: [
          { header: 'Banco', get: (r: any) => r.bank, width: 20 },
          { header: 'Cuenta', get: (r: any) => r.account_label, width: 16 },
          { header: 'Libro ContPAQi', get: (r: any) => r.contpaqi_cuenta, width: 16 },
          { header: 'Dep. Excel', get: (r: any) => r.excel_in, type: 'money', total: true },
          { header: 'Dep. ContPAQi', get: (r: any) => r.contpaqi_in, type: 'money', total: true },
          { header: 'Delta dep.', get: (r: any) => r.delta_in, type: 'money', total: true },
          { header: 'Ret. Excel', get: (r: any) => r.excel_out, type: 'money', total: true },
          { header: 'Ret. ContPAQi', get: (r: any) => r.contpaqi_out, type: 'money', total: true },
          { header: 'Delta ret.', get: (r: any) => r.delta_out, type: 'money', total: true },
          { header: 'Enlazada', get: (r: any) => (r.linked ? 'Si' : 'No'), width: 11 },
        ],
      }]);
    } finally { this.exporting.set(false); }
  }

  readonly compare = input.required<ContpaqiCompare | null>();
  readonly linking = input<boolean>(false);
  readonly period = input<string>('');
  readonly available = input<ContpaqiBankAccount[]>([]);
  readonly factoraje = input<FactorajeCompare | null>(null);
  @Output() link = new EventEmitter<void>();
  @Output() manualLink = new EventEmitter<{ bankAccountId: string; cuenta: string | null }>();

  private readonly api = inject(BankService);
  private readonly destroyRef = inject(DestroyRef);

  cuad = cuadra;
  dmShort = dmShort;
  noExcel(r: ContpaqiCompareRow): boolean { return r.excel_in === 0 && r.excel_out === 0; }

  // Drill "¿dónde está el error?" — carga bajo demanda al abrir el diálogo.
  readonly detailOpen = signal(false);
  readonly detailLoading = signal(false);
  readonly detailErr = signal<string | null>(null);
  readonly detail = signal<ContpaqiDetail | null>(null);
  private readonly detailRow = signal<ContpaqiCompareRow | null>(null);

  readonly detailTitle = computed(() => {
    const r = this.detailRow();
    return r ? `¿Dónde está el descuadre? — ${r.bank} ${r.account_label}` : 'Detalle';
  });

  sides(d: ContpaqiDetail): { key: string; title: string; icon: string; data: CpqReconSide }[] {
    return [
      { key: 'dep', title: 'Depósitos (entra)', icon: 'pi pi-arrow-down-left ok', data: d.deposits },
      { key: 'ret', title: 'Retiros (sale)', icon: 'pi pi-arrow-up-right', data: d.withdrawals },
    ];
  }

  openDetail(r: ContpaqiCompareRow): void {
    this.detailRow.set(r);
    this.detail.set(null);
    this.detailErr.set(null);
    this.detailOpen.set(true);
    this.detailLoading.set(true);
    this.api.contpaqiDetail(this.period(), r.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.detail.set(d); this.detailLoading.set(false); },
      error: () => { this.detailErr.set('No se pudo cargar el detalle de la cuenta.'); this.detailLoading.set(false); },
    });
  }

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
    if (okIn && okOut) return `Los libros de ContPAQi registran lo mismo que movió el banco: ${money(c.totals.contpaqi_in)} de depósitos y ${money(c.totals.contpaqi_out)} de retiros. Cuadra.`;
    const gaps: string[] = [];
    if (!okIn) gaps.push(`${money(Math.abs(c.totals.delta_in))} en depósitos`);
    if (!okOut) gaps.push(`${money(Math.abs(c.totals.delta_out))} en retiros`);
    return `Diferencia de ${gaps.join(' y ')} entre el banco (Excel) y los libros de ContPAQi. Revisa por cuenta abajo: puede ser un estado de cuenta sin cargar, o un movimiento que la contabilidad no registró.`;
  }
}
