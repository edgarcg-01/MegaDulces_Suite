import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { SelectModule } from 'primeng/select';
import { CheckboxModule } from 'primeng/checkbox';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { MessageService } from 'primeng/api';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { FINANZAS_TABS } from '../finanzas-tabs';
import { BankService, BankAccount, MovementCategory, BankStatement, BankMovement, Concentrado, Reconciliation, MatchResult, Differences, Balances, Diagnostico, KeplerAccount } from '../bank.service';
import {
  BankView as View, BankAdminTab as AdminTab, MONTHS_ES, WORK_VIEWS,
  GROUP_LABELS, GROUP_ORDER, GROUP_COLOR,
} from './bancos/bancos-shared';
import { BancosConcentradoComponent } from './bancos/bancos-concentrado.component';

/**
 * CB.3 — Conciliación bancaria (ADR-033). Reemplaza el workbook Excel: tablero
 * CONCENTRADO (pivote cuenta × grupo), grid de movimientos con reclasificación
 * inline, y lista de cuentas. Surface Operations (denso, quiet-luxury, dark-first).
 */
@Component({
  selector: 'app-finanzas-bancos',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, ToastModule, SelectModule, CheckboxModule,
    InputNumberModule, InputTextModule, IconFieldModule, InputIconModule,
    PageTabsComponent, MetricStripComponent, LoadStateComponent, FreshnessPillComponent, ContextHelpComponent,
    BancosConcentradoComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in fb-page">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="tabs" />

      <header class="surf-page-head fb-head">
        <div class="surf-page-head-text">
          <div class="fb-title-row"><h1>Bancos</h1><app-context-help topic="bancos" /></div>
          <p class="surf-page-sub">Conciliación bancaria: estados de cuenta clasificados contra el catálogo alineado a Kepler. Reemplaza el Excel manual.</p>
        </div>
        <div class="fb-head-actions">
          <label class="fb-period">
            <span>Periodo</span>
            <p-select [options]="periods()" [ngModel]="period()" (ngModelChange)="setPeriod($event)"
                      appendTo="body" styleClass="fb-sel sel-liquid" [style]="{ minWidth: '8rem' }" ariaLabel="Periodo"></p-select>
          </label>
          <input #fileInput type="file" accept=".xlsx" hidden (change)="onFile($event)">
          <button pButton type="button" label="Subir estado de cuenta" icon="pi pi-upload"
                  class="p-button-sm p-button-outlined" [loading]="uploading()" (click)="fileInput.click()"></button>
        </div>
      </header>

      <!-- Barra de estado del cierre (answer-first: dónde va el periodo de un vistazo) -->
      <div class="fb-status" aria-label="Estado del cierre">
        <button type="button" class="fb-status-chip" (click)="view.set('cuentas')" title="Ver cuentas y su cuadre de saldos">
          <i class="pi pi-inbox"></i> Importado <b class="mono">{{ importStatus().loaded }}/{{ importStatus().total }}</b> cuentas</button>
        <button type="button" class="fb-status-chip" [class.warn]="(classifiedPct() ?? 100) < 100"
                (click)="fGroup.set(''); fUncat.set(true); view.set('movimientos'); reloadMovements()" title="Ver los movimientos sin clasificar">
          <i class="pi pi-tags"></i> Clasificado <b class="mono">{{ classifiedPct() == null ? '—' : classifiedPct() + '%' }}</b></button>
        <button type="button" class="fb-status-chip" [class.warn]="reconciledPct() != null && reconciledPct()! < 80"
                (click)="view.set('conciliacion')" title="Ver la conciliación contra Kepler">
          <i class="pi pi-sync"></i> Conciliado <b class="mono">{{ reconciledPct() == null ? 'sin correr' : reconciledPct() + '%' }}</b></button>
        <app-freshness-pill [since]="lastImported()" />
      </div>

      <div class="fb-viewseg" role="tablist">
        @for (v of WORK_VIEWS; track v.key) {
          <button role="tab" [attr.aria-selected]="view()===v.key" [class.active]="view()===v.key" (click)="view.set(v.key)">
            <i [class]="v.icon"></i> {{ v.label }}
            @if (v.key === 'cierre' && diagnostico() && !diagnostico()!.cuadra) { <span class="fb-seg-count">{{ diagnostico()!.items.length }}</span> }
          </button>
        }
        <button role="tab" class="fb-seg-config" [attr.aria-selected]="view()==='admin'" [class.active]="view()==='admin'"
                (click)="openAdmin()" aria-label="Configuración" title="Configuración: reglas, categorías y cuentas"><i class="pi pi-cog"></i></button>
      </div>

      @if (loading()) {
        <div class="fb-skeleton" aria-busy="true">
          @for (i of [1,2,3,4,5,6]; track i) { <div class="fb-skel-row"></div> }
        </div>
      } @else {

      <!-- ── CIERRE (home): veredicto + resumen del dinero + qué falta (accionable) ── -->
      @if (view() === 'cierre') {
        @if (diagError()) {
          <app-load-state [error]="diagError()" (retry)="setPeriod(period())"></app-load-state>
        } @else {
          @if (diagnostico(); as d) {
          <div class="fb-diag-head" [class.ok]="d.cuadra" [class.bad]="!d.cuadra">
            @if (d.cuadra) {
              <i class="pi pi-check-circle"></i>
              <div><h2>Todo cuadra</h2><p>Los {{ d.movimientos | number }} movimientos de {{ d.period }} están clasificados y las {{ d.cuentas_total }} cuentas cierran su saldo.</p></div>
            } @else {
              <i class="pi pi-exclamation-triangle"></i>
              <div><h2>{{ d.items.length }} cosa(s) por resolver para que cuadre</h2><p>Ordenadas por impacto. Cada una salta al lugar exacto para arreglarla.</p></div>
            }
          </div>

          <app-metric-strip [items]="cierreKpis(d)" ariaLabel="Resumen del periodo" />

          <label class="fb-toggle">
            <p-checkbox [ngModel]="countTransfers()" [binary]="true" inputId="ctTr" (onChange)="countTransfers.set($event.checked)" />
            <span>Contar traspasos internos en el neto</span>
            <span class="muted">— por default se excluyen (son movimientos entre cuentas propias, no flujo del negocio); el neto muestra solo lo operativo.</span>
          </label>

          @if (!d.tiene_balanza_kepler) {
            <p class="fb-diag-note muted"><i class="pi pi-info-circle"></i> La balanza de Kepler no está cargada para {{ d.period }}, así que el cruce contable no se está evaluando (solo el cuadre interno de saldos y la clasificación).</p>
          }

          @if (d.items.length) {
            <h3 class="fb-card-title fb-cierre-h3">Qué falta <span class="muted">— por impacto</span></h3>
            <div class="fb-diag-list">
              @for (it of d.items; track it.titulo) {
                <div class="fb-diag-item" [class]="'sev-' + it.severidad">
                  <div class="fb-diag-item-head">
                    <span class="fb-diag-dot"></span>
                    <span class="fb-diag-title">{{ it.titulo }}</span>
                    @if (helpTopic(it.tipo); as ht) { <app-context-help [topic]="ht" /> }
                    @if (it.importe > 0) { <span class="fb-diag-amt mono">{{ it.importe | currency:'MXN':'symbol-narrow':'1.0-0' }}</span> }
                    <button pButton type="button" class="p-button-sm p-button-outlined fb-diag-cta"
                            [label]="itemActionLabel(it)" icon="pi pi-arrow-right" iconPos="right" (click)="itemAction(it)"></button>
                  </div>
                  <p class="fb-diag-detalle">{{ it.detalle }}</p>
                  @if (it.evidencia?.length) {
                    <ul class="fb-diag-ev">
                      @for (e of it.evidencia; track e.label) {
                        <li>
                          <span class="fb-diag-ev-label">{{ e.label }}</span>
                          @if (e.count) { <span class="fb-diag-ev-meta">{{ e.count }} mov</span> }
                          @if (e.folio) { <span class="fb-diag-ev-folio">{{ e.folio }}</span> }
                          @if (e.monto != null) { <span class="fb-diag-ev-monto mono">{{ e.monto | currency:'MXN':'symbol-narrow':'1.0-0' }}</span> }
                        </li>
                      }
                    </ul>
                  }
                  <p class="fb-diag-accion"><i class="pi pi-info-circle"></i> {{ it.accion }}</p>
                </div>
              }
            </div>
          }
          } @else {
            <div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin datos para {{ period() }}. Sube un estado de cuenta para empezar.</p></div>
          }
        }
      }

      <!-- ── CONCENTRADO ── -->
      @if (view() === 'concentrado') {
        @if (concError()) {
          <app-load-state [error]="concError()" (retry)="setPeriod(period())"></app-load-state>
        } @else {
          @if (concentrado(); as c) {
            <bancos-concentrado [concentrado]="c" [accountOpts]="accountOpts()" />
          } @else {
            <div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin estados de cuenta para {{ period() }}.</p></div>
          }
        }
      }

      <!-- ── MOVIMIENTOS: la tabla de todos los ingresos y egresos ── -->
      @if (view() === 'movimientos') {
        <div class="fb-filters">
          <p-select [options]="accountOpts()" optionLabel="label" optionValue="value" [filter]="true"
                    [ngModel]="fAccount()" (ngModelChange)="fAccount.set($event); reloadMovements()"
                    appendTo="body" styleClass="fb-sel sel-liquid" ariaLabel="Cuenta"></p-select>
          <p-select [options]="groupOpts()" optionLabel="label" optionValue="value"
                    [ngModel]="fGroup()" (ngModelChange)="fGroup.set($event); reloadMovements()"
                    appendTo="body" styleClass="fb-sel sel-liquid" ariaLabel="Grupo"></p-select>
          <p-select [options]="reconOpts" optionLabel="label" optionValue="value"
                    [ngModel]="fRecon()" (ngModelChange)="fRecon.set($event); reloadMovements()"
                    appendTo="body" styleClass="fb-sel sel-liquid" ariaLabel="Estado de conciliación"></p-select>
          <span class="fb-check">
            <p-checkbox [ngModel]="fUncat()" [binary]="true" inputId="fUncat" (onChange)="fUncat.set($event.checked); reloadMovements()"></p-checkbox>
            <label for="fUncat">Solo sin clasificar</label>
          </span>
          <span class="fb-check">
            <p-checkbox [ngModel]="colorByGroup()" [binary]="true" inputId="fColor" (onChange)="colorByGroup.set($event.checked)"></p-checkbox>
            <label for="fColor">Color por grupo</label>
          </span>
          <p-iconfield iconPosition="left" class="fb-search">
            <p-inputicon styleClass="pi pi-search" />
            <input pInputText type="text" [ngModel]="fSearch()" (ngModelChange)="onSearch($event)"
                   placeholder="Buscar concepto / código…" aria-label="Buscar" />
          </p-iconfield>
          <span class="fb-count muted">
            @if (movTotal() > movements().length) { Mostrando {{ movements().length | number }} de {{ movTotal() | number }} }
            @else { {{ movTotal() | number }} movimientos }
          </span>
        </div>
        @if (colorByGroup()) {
          <div class="fb-legend" aria-label="Colores por grupo — clic para filtrar">
            @for (g of GROUP_ORDER; track g) {
              <button type="button" class="fb-legend-item" [class.active]="fGroup() === g" [style.--g]="groupColorVar(g)"
                      (click)="fGroup.set(fGroup() === g ? '' : g); reloadMovements()" [attr.aria-pressed]="fGroup() === g">
                <span class="fb-legend-dot"></span>{{ label(g) }}
              </button>
            }
          </div>
        }
        <div class="card-premium card-flat fb-tablewrap">
          <p-table [value]="movements()" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="58vh"
                   [paginator]="movements().length > 50" [rows]="50" [rowsPerPageOptions]="[50, 100, 200]">
            <ng-template pTemplate="header">
              <tr>
                <th class="col-w6" pSortableColumn="movement_date">Fecha <p-sortIcon field="movement_date" /></th>
                <th class="col-w7">Cuenta</th>
                <th>Concepto</th>
                <th class="col-w11">Categoría</th>
                <th class="ta-r col-w8" pSortableColumn="amount_in">Depósito <p-sortIcon field="amount_in" /></th>
                <th class="ta-r col-w8" pSortableColumn="amount_out">Retiro <p-sortIcon field="amount_out" /></th>
                <th class="col-w25" title="Conciliación"></th>
              </tr>
            </ng-template>
            <ng-template pTemplate="body" let-m>
              <tr class="fb-mov-row" [class.fb-colored]="colorByGroup()"
                  [style.--g]="colorByGroup() ? groupColorVar(m.group_key) : null"
                  [class.fb-uncat]="!m.category_id && !colorByGroup()">
                <td class="mono">{{ dmy(m.movement_date) }}</td>
                <td class="muted">{{ m.account_label }}</td>
                <td class="fb-concept" [title]="m.concept">{{ m.concept || '—' }}</td>
                <td>
                  <!-- Read-only: la clasificación se hace en Kepler, no aquí (el motor la
                       aplica al importar). Chip informativo con la categoría vigente. -->
                  @if (m.category_name) { <span class="fb-cat-chip">{{ m.category_name }}</span> }
                  @else { <span class="fb-cat-chip fb-cat-none">sin clasificar</span> }
                </td>
                <td class="ta-r mono">{{ m.amount_in ? (m.amount_in | currency:'MXN':'symbol-narrow':'1.2-2') : '' }}</td>
                <td class="ta-r mono">{{ m.amount_out ? (m.amount_out | currency:'MXN':'symbol-narrow':'1.2-2') : '' }}</td>
                <td class="ta-c">
                  @if (m.recon_status === 'matched') { <i class="pi pi-check-circle fb-rec-ok" title="Conciliado con Kepler"></i> }
                  @else if (m.recon_status === 'unmatched') { <i class="pi pi-circle fb-rec-no" title="Sin conciliar"></i> }
                </td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage">
              <tr><td colspan="7"><div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin movimientos con estos filtros.</p></div></td></tr>
            </ng-template>
          </p-table>
        </div>
      }

      <!-- ── CONCILIACIÓN banco ↔ Kepler (answer-first: veredicto → sin conciliar → evidencia) ── -->
      @if (view() === 'conciliacion') {
        @if (reconError()) {
          <app-load-state [error]="reconError()" (retry)="setPeriod(period())"></app-load-state>
        } @else {
          @if (reconciliation(); as rc) {
          <!-- 1. Veredicto: match rate + caja vs 102 -->
          <div class="card-premium card-flat fb-match">
            <div class="fb-match-head">
              <h3 class="fb-card-title">Conciliación por transacción <span class="muted">— retiros del banco ↔ pagos del 102 en Kepler</span></h3>
              <div class="fb-match-actions">
                <button pButton type="button" label="Enviar a Hallazgos" icon="pi pi-flag" class="p-button-sm p-button-text" [loading]="syncing()" (click)="syncFindings()" title="Empuja las diferencias a la bandeja de /finanzas/hallazgos"></button>
                <button pButton type="button" label="Conciliar" icon="pi pi-bolt" class="p-button-sm p-button-outlined" [loading]="matching()" (click)="runMatch()"></button>
              </div>
            </div>
            @if (matchResult(); as mr) {
              <div class="fb-match-res">
                <span class="fb-match-rate mono" [class.ok]="amtPct(mr) >= 70" [class.warn]="amtPct(mr) < 70">{{ amtPct(mr) }}%</span>
                <span class="muted"><b>del monto conciliado</b> — {{ mr.matched_amount | currency:'MXN':'symbol-narrow':'1.0-0' }} de {{ mr.bank_amount | currency:'MXN':'symbol-narrow':'1.0-0' }} · {{ mr.matched | number }} de {{ mr.bank_movements | number }} retiros ({{ mr.match_rate }}% por conteo)</span>
                <span class="muted">· {{ mr.unmatched_bank | number }} sin conciliar en banco · {{ mr.unmatched_kepler | number }} pagos Kepler sin conciliar</span>
              </div>
              <p class="fb-plain">{{ matchRead(mr) }}</p>
            } @else { <p class="fb-recon-note muted">Ejecuta la conciliación para vincular cada retiro con su pago en Kepler (monto + fecha).</p> }
          </div>
          <div class="card-premium card-flat fb-recon-cash">
            <h3 class="fb-card-title">Caja — banco vs Kepler 102 <span class="muted">(excluye traspasos internos)</span><app-context-help topic="bancos_caja" /></h3>
            <div class="fb-recon-grid">
              <div class="fb-recon-cell">
                <span class="fb-recon-l">Depósitos (entra) <span class="muted">· memo</span></span>
                <span class="fb-recon-v mono">{{ rc.cash.bank_in | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
                <span class="fb-recon-vs mono muted">vs 102 cargos {{ rc.cash.kepler_102_cargos | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
                <span class="fb-recon-delta mono muted" [class.ok]="cuadra(rc.cash.delta_in)" title="El efectivo de CAJA GENERAL y la cobranza de otras sucursales no son cargo al 102 de banco; la columna de depósitos no es espejo del mayor 102. Δ informativo, no un gap.">Δ {{ rc.cash.delta_in | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
              </div>
              <div class="fb-recon-cell">
                <span class="fb-recon-l">Retiros (sale)</span>
                <span class="fb-recon-v mono">{{ rc.cash.bank_out | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
                <span class="fb-recon-vs mono muted">vs 102 abonos {{ rc.cash.kepler_102_abonos | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
                <span class="fb-recon-delta mono" [class.bad]="!cuadra(rc.cash.delta_out)" [class.ok]="cuadra(rc.cash.delta_out)">Δ {{ rc.cash.delta_out | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
              </div>
            </div>
            <p class="fb-plain">{{ cajaRead(rc) }}</p>
            @if (rc.sin_clasificar > 0) { <p class="fb-recon-note muted"><i class="pi pi-exclamation-triangle"></i> {{ rc.sin_clasificar | currency:'MXN':'symbol-narrow':'1.0-0' }} en movimientos sin clasificar — sí están contados en los totales, pero sin categoría no se les atribuye concepto. En el tab Cierre está el detalle y cómo resolverlos en Kepler.</p> }
          </div>

          <!-- 2. Lo accionable: lo que no casó por ambos lados -->
          @if (differences(); as df) {
            <div class="fb-diff-grid">
              <div class="card-premium card-flat fb-tablewrap">
                <h3 class="fb-card-title fb-pnl-title">Retiros del banco sin conciliar <span class="muted">(top {{ df.bank_unmatched.length }})</span><app-context-help topic="bancos_retiros_sin_casar" /></h3>
                <p-table [value]="df.bank_unmatched" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="40vh">
                  <ng-template pTemplate="header"><tr><th class="col-w6">Fecha</th><th>Concepto</th><th>Categoría</th><th class="ta-r">Monto</th></tr></ng-template>
                  <ng-template pTemplate="body" let-r>
                    <tr><td class="mono">{{ dmy(r.movement_date) }}</td><td class="fb-concept" [title]="r.concept">{{ r.concept || '—' }}</td>
                      <td class="muted">{{ r.category_name || 'sin clasificar' }}</td><td class="ta-r mono">{{ r.amount_out | currency:'MXN':'symbol-narrow':'1.0-0' }}</td></tr>
                  </ng-template>
                  <ng-template pTemplate="emptymessage"><tr><td colspan="4"><div class="surf-empty"><i class="pi pi-check-circle"></i><p>Todo conciliado.</p></div></td></tr></ng-template>
                </p-table>
              </div>
              <div class="card-premium card-flat fb-tablewrap">
                <h3 class="fb-card-title fb-pnl-title">Pagos Kepler (102) sin conciliar <span class="muted">(top {{ df.kepler_unmatched.length }})</span><app-context-help topic="bancos_kepler_sin_casar" /></h3>
                <p-table [value]="df.kepler_unmatched" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="40vh">
                  <ng-template pTemplate="header"><tr><th class="col-w6">Fecha</th><th>Beneficiario</th><th class="col-w5">Doc</th><th class="ta-r">Monto</th></tr></ng-template>
                  <ng-template pTemplate="body" let-r>
                    <tr><td class="mono">{{ dmy(r.fecha) }}</td><td class="fb-concept" [title]="r.contraparte">{{ r.contraparte || '—' }}</td>
                      <td class="mono muted">{{ r.doc_tipo }}</td><td class="ta-r mono">{{ r.importe | currency:'MXN':'symbol-narrow':'1.0-0' }}</td></tr>
                  </ng-template>
                  <ng-template pTemplate="emptymessage"><tr><td colspan="4"><div class="surf-empty"><i class="pi pi-check-circle"></i><p>Todo conciliado.</p></div></td></tr></ng-template>
                </p-table>
              </div>
            </div>
          }

          <!-- 3. La conciliación real es el matching por-transacción (arriba). El P&L
               "categoría → mayor Kepler" se retiró (CB.13): los mapeos eran adivinados
               (602=vehículos no traslado, 608=misc, 611-003=$600) y daban deltas falsos. -->
          } @else {
            <div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin datos de conciliación para {{ period() }}.</p></div>
          }
        }
      }

      <!-- ── CUENTAS: cuadre de saldos por cuenta (clic → sus movimientos) ── -->
      @if (view() === 'cuentas') {
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
                    (click)="verCuentaMovs(a)" (keyup.enter)="verCuentaMovs(a)"
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
                  <td><span class="fb-kind">{{ kindLabel(s.kind) }}</span></td>
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
      }

      <!-- ── ADMIN: catálogo + reglas de clasificación ── -->
      @if (view() === 'admin') {
        <div class="fb-adminseg" role="tablist">
          <button role="tab" [class.active]="adminTab()==='catalogo'" (click)="adminTab.set('catalogo')">Catálogo Kepler</button>
          <button role="tab" [class.active]="adminTab()==='cuentas'" (click)="adminTab.set('cuentas')">Cuentas de banco</button>
        </div>

        <!-- Catálogo real de cuentas de Kepler (búsqueda) -->
        @if (adminTab() === 'catalogo') {
          <div class="fb-admin-bar">
            <p class="fb-admin-note muted">Catálogo REAL de cuentas de Kepler (almacén 00). Úsalo para saber qué mayor/subcuenta es cada cosa — NO adivines. Busca por clave (611) o descripción (comisión).</p>
            <p-iconfield iconPosition="left" class="fb-search">
              <p-inputicon styleClass="pi pi-search" />
              <input pInputText type="text" [ngModel]="kaSearch()" (ngModelChange)="onKaSearch($event)"
                     placeholder="Buscar cuenta: clave o descripción…" aria-label="Buscar cuenta Kepler" />
            </p-iconfield>
          </div>
          <div class="card-premium card-flat fb-tablewrap">
            <p-table [value]="keplerAccounts()" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="60vh">
              <ng-template pTemplate="header">
                <tr><th class="col-w8">Clave</th><th>Descripción</th><th class="col-w6">Mayor</th></tr>
              </ng-template>
              <ng-template pTemplate="body" let-a>
                <tr><td class="mono" [class.ok]="a.es_mayor">{{ a.cuenta }}</td><td>{{ a.cuenta_nombre || '—' }}</td><td class="mono muted">{{ a.cuenta_mayor }}</td></tr>
              </ng-template>
              <ng-template pTemplate="emptymessage">
                <tr><td colspan="3"><div class="surf-empty"><i class="pi pi-search"></i><p>{{ kaSearch() ? 'Sin resultados.' : 'Escribe para buscar en el catálogo.' }}</p></div></td></tr>
              </ng-template>
            </p-table>
          </div>
        }

        <!-- Cuentas de banco (setup): alta/edición con PrimeNG -->
        @if (adminTab() === 'cuentas') {
          <div class="fb-admin-bar">
            <p class="fb-admin-note muted">Cuentas del catálogo (banco/caja/factoraje). Alias = nombre de la hoja en el Excel. Necesario para importar y cuadrar.</p>
          </div>
          <div class="card-premium card-flat fb-tablewrap">
            <p-table [value]="accounts()" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="60vh">
              <ng-template pTemplate="header">
                <tr><th class="col-w8">Banco</th><th class="col-w6">Cuenta</th><th class="col-w10">Alias (hoja Excel)</th><th class="col-w7">Tipo</th><th>Vínculo Kepler</th><th class="col-w4 ta-c">Activa</th></tr>
              </ng-template>
              <ng-template pTemplate="body" let-a>
                <tr [class.fb-inactive]="!a.active">
                  <td>{{ a.bank }}</td>
                  <td class="mono">{{ a.account_label }}</td>
                  <td><input pInputText class="fb-pin mono" [ngModel]="a.alias" (change)="patchAccount(a, { alias: $any($event.target).value })" placeholder="—" /></td>
                  <td><p-select [options]="kindOpts" optionLabel="label" optionValue="value" [ngModel]="a.kind" (ngModelChange)="patchAccount(a, { kind: $event })" appendTo="body" styleClass="fb-sel sel-liquid" /></td>
                  <td><input pInputText class="fb-pin" [ngModel]="a.kepler_link" (change)="patchAccount(a, { kepler_link: $any($event.target).value })" placeholder="cómo mapea al 102" /></td>
                  <td class="ta-c"><p-checkbox [ngModel]="a.active" [binary]="true" (onChange)="patchAccount(a, { active: $event.checked })" /></td>
                </tr>
              </ng-template>
              <ng-template pTemplate="footer">
                <tr class="fb-newrow">
                  <td><input pInputText class="fb-pin" [(ngModel)]="naBank" placeholder="BANCO" /></td>
                  <td><input pInputText class="fb-pin mono" [(ngModel)]="naLabel" placeholder="0000" /></td>
                  <td><input pInputText class="fb-pin mono" [(ngModel)]="naAlias" placeholder="hoja Excel" /></td>
                  <td><p-select [options]="kindOpts" optionLabel="label" optionValue="value" [(ngModel)]="naKind" appendTo="body" styleClass="fb-sel sel-liquid" /></td>
                  <td><input pInputText class="fb-pin" [(ngModel)]="naKepler" placeholder="opcional" /></td>
                  <td class="ta-c"><button pButton type="button" icon="pi pi-plus" class="p-button-sm p-button-text" [disabled]="addingAcct()" (click)="addAccount()"></button></td>
                </tr>
              </ng-template>
            </p-table>
          </div>
        }
      }
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .fb-head-actions { display: flex; align-items: center; gap: var(--sp-3); }
    .fb-period { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-xs); color: var(--text-muted); }
    /* p-select compacto (header + filtros) */
    :host ::ng-deep .fb-sel.p-select { font-size: var(--fs-sm); }
    :host ::ng-deep .fb-sel .p-select-label { padding: var(--sp-1) var(--sp-2); }
    :host ::ng-deep .fb-search .p-inputtext { width: 100%; font-size: var(--fs-sm); }
    .fb-viewseg { display: flex; gap: var(--sp-1); margin: var(--sp-3) 0; border-bottom: 1px solid var(--border-color); }
    .fb-viewseg button {
      display: inline-flex; align-items: center; gap: var(--sp-1); background: none; border: none;
      color: var(--text-muted); font: inherit; font-size: var(--fs-sm); font-weight: 500;
      padding: var(--sp-2) var(--sp-3); border-bottom: 2px solid transparent; cursor: pointer;
    }
    .fb-viewseg button.active { color: var(--action); border-bottom-color: var(--action); }
    .fb-viewseg button:focus-visible { outline: 2px solid var(--action-ring); outline-offset: -2px; }
    .fb-seg-config { margin-left: auto; }
    .fb-title-row { display: inline-flex; align-items: center; gap: var(--sp-1); }
    /* Barra de estado del cierre */
    .fb-status { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-3); margin: var(--sp-2) 0 0; }
    .fb-status-chip { display: inline-flex; align-items: center; gap: var(--sp-1); font: inherit; font-size: var(--fs-xs);
      color: var(--text-muted); background: none; border: 1px solid transparent; border-radius: var(--r-pill);
      padding: 2px var(--sp-2); cursor: pointer; transition: background-color 120ms ease, border-color 120ms ease; }
    .fb-status-chip:hover { background: var(--hover-bg); border-color: var(--border-color); }
    .fb-status-chip:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 1px; }
    .fb-status-chip i { font-size: .8rem; color: var(--text-faint); }
    .fb-status-chip b { color: var(--text-main); font-weight: 600; }
    .fb-status-chip.warn { color: var(--warn-fg); }
    .fb-status-chip.warn i, .fb-status-chip.warn b { color: var(--warn-fg); }
    /* Checklist accionable (Cierre) */
    .fb-cierre-h3 { margin: var(--sp-4) 0 var(--sp-2); }
    .fb-diag-cta { flex: none; }
    .fb-row-click { cursor: pointer; }
    .fb-row-click:focus-visible { outline: 2px solid var(--action-ring); outline-offset: -2px; }
    .fb-filters { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-3); }
    .fb-search { min-width: 16rem; flex: 1; }
    .fb-check { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-sm); color: var(--text-muted); }
    .fb-toggle { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; font-size: var(--fs-sm); color: var(--text-main); margin: var(--sp-1) 0 var(--sp-3); }
    .fb-toggle .muted { font-size: var(--fs-xs); }
    .fb-count { margin-left: auto; font-size: var(--fs-xs); }
    .fb-tablewrap { padding: 0; overflow: hidden; }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .ta-r { text-align: right; }
    .muted { color: var(--text-muted); }
    .fb-strong { font-weight: 600; color: var(--text-main); }
    .fb-acct { font-weight: 500; }
    .fb-sticky-col { position: sticky; left: 0; background: var(--card-bg); z-index: 1; }
    .fb-total-row { font-weight: 600; border-top: 2px solid var(--border-color); background: var(--surface-ground); }
    .fb-concept { max-width: 28rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* Chip de categoría de solo lectura (la clasificación se hace en Kepler, no aquí). */
    .fb-cat-chip { display: inline-block; font-size: var(--fs-xs); color: var(--text-muted); }
    .fb-cat-chip.fb-cat-none { color: var(--warn-fg); }
    .fb-uncat { background: color-mix(in srgb, var(--warn-fg) 5%, transparent); }
    /* Anchos de columna (evita style="width" inline — antipatrón DESIGN). */
    .col-w25 { width: 2.5rem; } .col-w4 { width: 4rem; } .col-w5 { width: 5rem; }
    .col-w6 { width: 6rem; } .col-w7 { width: 7rem; } .col-w8 { width: 8rem; }
    .col-w10 { width: 10rem; } .col-w11 { width: 11rem; }
    /* pInputText compacto para edición inline en Admin. */
    :host ::ng-deep .fb-pin.p-inputtext { width: 100%; font-size: var(--fs-xs); padding: 2px var(--sp-2); }
    /* CC — color por grupo (el color = la clasificación; sutil, dark-safe, --g inyectado por fila) */
    .fb-colored > td { background: color-mix(in srgb, var(--g, transparent) 8%, transparent); }
    .fb-colored > td:first-child { box-shadow: inset 3px 0 0 var(--g, transparent); }
    .fb-legend { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-2); margin-bottom: var(--sp-2); }
    .fb-legend-item { display: inline-flex; align-items: center; gap: var(--sp-1); font: inherit; font-size: var(--fs-xs);
      color: var(--text-muted); background: none; border: 1px solid transparent; border-radius: var(--r-pill);
      padding: 2px var(--sp-2); cursor: pointer; transition: background-color 120ms ease, border-color 120ms ease; }
    .fb-legend-item:hover { background: var(--hover-bg); }
    .fb-legend-item.active { border-color: var(--g); color: var(--text-main); background: color-mix(in srgb, var(--g) 8%, transparent); }
    .fb-legend-item:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 1px; }
    .fb-legend-dot { width: 10px; height: 10px; border-radius: 3px; background: var(--g, var(--text-faint)); flex: none; }
    .fb-ghead { display: inline-flex; align-items: center; gap: 4px; }
    .fb-kind { font-size: var(--fs-xs); text-transform: capitalize; color: var(--text-muted); }
    .fb-skeleton { display: flex; flex-direction: column; gap: var(--sp-2); margin-top: var(--sp-4); }
    .fb-skel-row { height: var(--row-h-md, 40px); border-radius: var(--r-sm); background: var(--hover-bg); animation: fb-pulse 1.4s ease-in-out infinite; }
    @keyframes fb-pulse { 0%,100% { opacity: .5; } 50% { opacity: .9; } }
    @media (prefers-reduced-motion: reduce) { .fb-skel-row { animation: none; } }
    .surf-empty { display: flex; flex-direction: column; align-items: center; gap: var(--sp-2); padding: var(--sp-8); color: var(--text-muted); }
    .surf-empty i { font-size: 1.5rem; }
    .fb-subtable { border-collapse: collapse; font-size: var(--fs-sm); }
    .fb-subtable th { text-align: left; font-weight: 600; color: var(--text-muted); padding: 4px var(--sp-3); border-bottom: 1px solid var(--border-color); }
    .fb-subtable td { padding: 4px var(--sp-3); border-bottom: 1px solid var(--border-color); }
    .ok { color: var(--ok-fg); }
    .bad { color: var(--bad-fg); }
    .fb-card-title { font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); margin: 0 0 var(--sp-3); }
    .fb-recon-cash { margin-bottom: var(--sp-3); }
    .fb-recon-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: var(--sp-3); }
    .fb-recon-cell { display: flex; flex-direction: column; gap: 2px; padding: var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md); }
    .fb-recon-l { font-size: var(--fs-xs); color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
    .fb-recon-v { font-size: var(--fs-lg, 1.125rem); font-weight: 600; }
    .fb-recon-vs { font-size: var(--fs-xs); }
    .fb-recon-delta { font-size: var(--fs-sm); font-weight: 600; margin-top: 2px; }
    .fb-recon-note { font-size: var(--fs-xs); margin: var(--sp-3) 0 0; }
    /* Lectura en lenguaje llano ("explica el número") */
    .fb-plain { font-size: var(--fs-sm); color: var(--text-main); margin: var(--sp-2) 0 0; line-height: 1.4; }
    /* Renglones donde salta el saldo (expansión en Cuentas) — "dónde está la diferencia" */
    .fb-break-row > td { background: var(--surface-ground); }
    .fb-breaks { display: flex; flex-direction: column; gap: 2px; padding: var(--sp-2) var(--sp-3); }
    .fb-breaks-h { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-xs); font-weight: 700; color: var(--text-main); text-transform: uppercase; letter-spacing: .04em; margin-bottom: var(--sp-1); }
    .fb-break { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-3); font-size: var(--fs-xs); padding: 2px 0; border-bottom: 1px solid var(--border-color); }
    .fb-break-l { color: var(--text-main); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fb-break-m { font-weight: 600; color: var(--text-main); flex: none; }
    .fb-breaks-note { font-size: var(--fs-xs); margin: var(--sp-2) 0 0; }
    .fb-pnl-title { padding: var(--sp-3) var(--sp-3) 0; }
    .fb-match { margin-bottom: var(--sp-3); }
    .fb-match-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); flex-wrap: wrap; }
    .fb-match-actions { display: flex; align-items: center; gap: var(--sp-1); flex-wrap: wrap; }
    .fb-bal { margin-bottom: var(--sp-3); }
    .fb-bal-badge { font-size: var(--fs-xs); font-weight: 600; padding: 1px var(--sp-2); border-radius: var(--r-sm); margin-left: var(--sp-2); }
    .fb-bal-badge.ok { color: var(--ok-fg); background: color-mix(in srgb, var(--ok-fg) 12%, transparent); }
    .fb-bal-badge.bad { color: var(--bad-fg); background: color-mix(in srgb, var(--bad-fg) 12%, transparent); }
    .fb-bal-badge.warn { color: var(--warn-fg); background: color-mix(in srgb, var(--warn-fg) 12%, transparent); }
    .fb-bal-sinsaldo { opacity: 0.55; }
    .fb-seg-count { display: inline-flex; align-items: center; justify-content: center; min-width: 1.1rem; height: 1.1rem; padding: 0 4px; margin-left: 4px; font-size: var(--fs-2xs, 0.7rem); font-weight: 700; border-radius: var(--r-pill); background: var(--warn-fg); color: var(--stone-950); }
    /* Banner de cuadre (Movimientos) */
    .fb-cuadre { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-4); flex-wrap: wrap;
      padding: var(--sp-3) var(--sp-4); margin-bottom: var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md); border-left-width: 3px; }
    .fb-cuadre.ok { border-left-color: var(--ok-fg); }
    .fb-cuadre.bad { border-left-color: var(--warn-fg); }
    .fb-cuadre-nums { display: flex; gap: var(--sp-5); flex-wrap: wrap; }
    .fb-cuadre-kpi { display: flex; flex-direction: column; gap: 1px; }
    .fb-cuadre-l { font-size: var(--fs-xs); color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
    .fb-cuadre-v { font-size: var(--fs-lg, 1.125rem); font-weight: 600; }
    .fb-cuadre-verdict { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); font-weight: 500; }
    .fb-cuadre.ok .fb-cuadre-verdict { color: var(--ok-fg); }
    .fb-cuadre.bad .fb-cuadre-verdict { color: var(--warn-fg); }
    .fb-cuadre-link { background: none; border: none; color: var(--action); font: inherit; font-weight: 600; cursor: pointer; padding: 0; }
    .fb-cuadre-link:hover { text-decoration: underline; }
    /* Diagnóstico */
    .fb-diag-head { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-4); margin-bottom: var(--sp-3);
      border: 1px solid var(--border-color); border-radius: var(--r-md); border-left-width: 3px; }
    .fb-diag-head.ok { border-left-color: var(--ok-fg); }
    .fb-diag-head.bad { border-left-color: var(--warn-fg); }
    .fb-diag-head i { font-size: 1.5rem; }
    .fb-diag-head.ok i { color: var(--ok-fg); }
    .fb-diag-head.bad i { color: var(--warn-fg); }
    .fb-diag-head h2 { font-size: var(--fs-md, 1rem); font-weight: 700; margin: 0; color: var(--text-main); }
    .fb-diag-head p { font-size: var(--fs-sm); color: var(--text-muted); margin: 2px 0 0; }
    .fb-diag-note { font-size: var(--fs-xs); margin: 0 0 var(--sp-3); }
    .fb-diag-list { display: flex; flex-direction: column; gap: var(--sp-2); }
    .fb-diag-item { padding: var(--sp-3) var(--sp-4); border: 1px solid var(--border-color); border-radius: var(--r-md); border-left-width: 3px; }
    .fb-diag-item.sev-bad { border-left-color: var(--bad-fg); }
    .fb-diag-item.sev-warn { border-left-color: var(--warn-fg); }
    .fb-diag-item-head { display: flex; align-items: center; gap: var(--sp-2); }
    .fb-diag-dot { width: 8px; height: 8px; border-radius: var(--r-pill); flex: none; }
    .sev-bad .fb-diag-dot { background: var(--bad-fg); }
    .sev-warn .fb-diag-dot { background: var(--warn-fg); }
    .fb-diag-title { flex: 1; min-width: 0; font-weight: 600; color: var(--text-main); }
    .fb-diag-amt { font-weight: 700; }
    .fb-diag-detalle { font-size: var(--fs-sm); color: var(--text-main); margin: var(--sp-2) 0 var(--sp-1); }
    .fb-diag-accion { font-size: var(--fs-sm); color: var(--text-muted); margin: 0; display: flex; align-items: baseline; gap: var(--sp-1); }
    .fb-diag-accion i { color: var(--action); font-size: 0.75rem; }
    .fb-diag-ev { list-style: none; margin: 0 0 var(--sp-2); padding: var(--sp-2) var(--sp-3); display: flex; flex-direction: column; gap: 2px;
      background: var(--surface-ground); border: 1px solid var(--border-color); border-radius: var(--r-sm); }
    .fb-diag-ev li { display: flex; align-items: baseline; gap: var(--sp-2); font-size: var(--fs-xs); }
    .fb-diag-ev-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); color: var(--text-main); }
    .fb-diag-ev-meta { color: var(--text-muted); }
    .fb-diag-ev-folio { color: var(--text-muted); font-family: var(--font-mono); }
    .fb-diag-ev-monto { font-weight: 600; color: var(--text-main); min-width: 6rem; text-align: right; }
    .fb-match-res { display: flex; align-items: baseline; gap: var(--sp-2); flex-wrap: wrap; margin-top: var(--sp-2); font-size: var(--fs-sm); }
    .fb-match-rate { font-size: var(--fs-lg, 1.125rem); font-weight: 700; }
    .fb-match-rate.warn { color: var(--warn-fg); } .fb-match-rate.ok { color: var(--ok-fg); }
    .warn { color: var(--warn-fg); }
    .ta-c { text-align: center; }
    .fb-rec-ok { color: var(--ok-fg); font-size: 0.85rem; }
    .fb-rec-no { color: var(--text-faint); font-size: 0.7rem; }
    .fb-diff-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(22rem, 1fr)); gap: var(--sp-3); margin-top: var(--sp-3); }
    .fb-adminseg { display: flex; gap: var(--sp-1); margin-bottom: var(--sp-3); }
    .fb-adminseg button { background: none; border: 1px solid var(--border-color); color: var(--text-muted); font: inherit; font-size: var(--fs-xs); font-weight: 500; padding: var(--sp-1) var(--sp-3); border-radius: var(--r-sm); cursor: pointer; }
    .fb-adminseg button.active { color: var(--action); border-color: var(--action); background: color-mix(in srgb, var(--action) 8%, transparent); }
    .fb-admin-bar { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); margin-bottom: var(--sp-3); flex-wrap: wrap; }
    .fb-admin-note { font-size: var(--fs-xs); max-width: 48rem; margin: 0; }
    .fb-in { font: inherit; font-size: var(--fs-xs); width: 100%; padding: 2px var(--sp-1); background: var(--card-bg); color: var(--text-main); border: 1px solid transparent; border-radius: var(--r-sm); }
    .fb-in:hover, .fb-in:focus { border-color: var(--border-color); }
    .fb-in-num { text-align: right; }
    .fb-newrow { background: var(--surface-ground); }
    .fb-newrow .fb-in { border-color: var(--border-color); }
    .fb-inactive { opacity: 0.5; }
    .btn-ghost-danger { background: none; border: none; color: var(--text-faint); cursor: pointer; padding: 2px var(--sp-1); border-radius: var(--r-sm); }
    .btn-ghost-danger:hover { color: var(--bad-fg); background: color-mix(in srgb, var(--bad-fg) 10%, transparent); }
  `],
})
export class FinanzasBancosComponent implements OnInit {
  private readonly api = inject(BankService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly tabs = FINANZAS_TABS;
  readonly GROUP_ORDER = GROUP_ORDER;
  readonly WORK_VIEWS = WORK_VIEWS;

  @ViewChild('fileInput') fileInput?: ElementRef<HTMLInputElement>;

  readonly view = signal<View>('cierre');
  readonly loading = signal(true);
  readonly periods = signal<string[]>([]);
  readonly period = signal<string>('');
  readonly accounts = signal<BankAccount[]>([]);
  readonly categories = signal<MovementCategory[]>([]);
  readonly statements = signal<BankStatement[]>([]);
  readonly concentrado = signal<Concentrado | null>(null);
  readonly reconciliation = signal<Reconciliation | null>(null);
  readonly balances = signal<Balances | null>(null);
  readonly diagnostico = signal<Diagnostico | null>(null);
  readonly matchResult = signal<MatchResult | null>(null);
  readonly differences = signal<Differences | null>(null);
  readonly matching = signal(false);
  readonly syncing = signal(false);
  readonly movements = signal<BankMovement[]>([]);
  readonly movTotal = signal(0);

  readonly fAccount = signal('');
  readonly fGroup = signal('');
  readonly fUncat = signal(false);
  readonly colorByGroup = signal(true);
  /** Cierre: contar (o no) los traspasos internos en Ingresos/Egresos/Neto. Default = NO. */
  readonly countTransfers = signal(false);
  readonly fSearch = signal('');
  readonly fRecon = signal('');
  readonly uploading = signal(false);
  private searchTimer: any = null;

  readonly reconOpts = [
    { label: 'Conciliación: todos', value: '' },
    { label: 'Conciliados', value: 'matched' },
    { label: 'Sin conciliar', value: 'unmatched' },
  ];

  // ── Admin (read-only + setup de cuentas) ──
  readonly adminTab = signal<AdminTab>('catalogo');
  readonly kindOpts = [
    { label: 'Banco', value: 'bank' }, { label: 'Caja', value: 'cash' }, { label: 'Factoraje', value: 'factoraje' },
  ];
  // CB.13 — buscador del catálogo real de cuentas Kepler.
  readonly kaSearch = signal('');
  readonly keplerAccounts = signal<KeplerAccount[]>([]);
  // nueva cuenta
  naBank = ''; naLabel = ''; naAlias = ''; naKind = 'bank'; naKepler = '';

  // Errores por vista (banner + Reintentar; separa "no cargó" de "vacío" — DESIGN §6).
  readonly concError = signal<string | null>(null);
  readonly movError = signal<string | null>(null);
  readonly reconError = signal<string | null>(null);
  readonly diagError = signal<string | null>(null);
  // Auto-disable síncrono del alta de cuenta (anti doble-submit — DESIGN §13).
  readonly addingAcct = signal(false);

  // Opciones para los p-select (label/value).
  readonly accountOpts = computed(() => [
    { label: 'Todas las cuentas', value: '' },
    ...this.accounts().map((a) => ({ label: `${a.bank} ${a.account_label}`, value: a.id })),
  ]);
  readonly groupOpts = computed(() => [
    { label: 'Todos los grupos', value: '' },
    ...GROUP_ORDER.map((g) => ({ label: GROUP_LABELS[g] || g, value: g })),
  ]);

  /** Última importación del periodo (para la píldora de frescura). */
  readonly lastImported = computed(() => {
    const ds = this.statements().map((s) => s.imported_at).filter(Boolean) as string[];
    return ds.length ? ds.sort().reverse()[0] : null;
  });

  // ── Estado del cierre para la barra de comando (chips answer-first) ──
  readonly importStatus = computed(() => {
    const total = this.accounts().filter((a) => a.active).length;
    return { loaded: this.statements().length, total };
  });
  readonly classifiedPct = computed(() => {
    const d = this.diagnostico();
    if (!d || !d.movimientos) return null;
    const sc = this.concentrado()?.groupTotals?.['sin_clasificar']?.movs ?? 0;
    return Math.max(0, Math.round(((d.movimientos - sc) / d.movimientos) * 100));
  });
  // % por MONTO (no por conteo): es el que importa — el dinero grande casa, las
  // comisiones/nómina chiquitas que Kepler agrupa no, y subvenden el conteo.
  amtPct(mr: { matched_amount: number; bank_amount: number }): number {
    return mr?.bank_amount ? Math.round((mr.matched_amount / mr.bank_amount) * 100) : 0;
  }
  readonly reconciledPct = computed(() => {
    const mr = this.matchResult(); if (!mr) return null;
    return this.amtPct(mr);
  });

  ngOnInit(): void {
    this.api.periods().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (ps) => {
        this.periods.set(ps);
        this.period.set(ps[0] || '');
        this.api.categories().pipe(takeUntilDestroyed(this.destroyRef)).subscribe((cs) => this.categories.set(cs));
        this.api.accounts().pipe(takeUntilDestroyed(this.destroyRef)).subscribe((as) => this.accounts.set(as));
        if (this.period()) this.loadPeriod();
        else this.loading.set(false);
      },
      error: () => this.fail('No se pudieron cargar los periodos.'),
    });
  }

  setPeriod(p: string): void { this.period.set(p); this.loadPeriod(); }

  private loadPeriod(): void {
    this.loading.set(true);
    this.matchResult.set(null);
    this.differences.set(null);
    this.concError.set(null);
    this.reconError.set(null);
    this.diagError.set(null);
    const p = this.period();
    this.api.concentrado(p).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (c) => { this.concentrado.set(c); this.loading.set(false); },
      error: () => { this.concError.set('No se pudo cargar el concentrado del periodo.'); this.loading.set(false); },
    });
    this.api.statements(p).pipe(takeUntilDestroyed(this.destroyRef)).subscribe((s) => this.statements.set(s));
    this.api.reconciliation(p).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (rc) => this.reconciliation.set(rc), error: () => { this.reconciliation.set(null); this.reconError.set('No se pudo cargar la conciliación del periodo.'); } });
    this.api.balances(p).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (b) => this.balances.set(b), error: () => this.balances.set(null) });
    this.api.diagnostico(p).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (d) => this.diagnostico.set(d), error: () => { this.diagnostico.set(null); this.diagError.set('No se pudo cargar el diagnóstico del periodo.'); } });
    this.reloadMovements();
  }

  reloadMovements(): void {
    const p = this.period();
    if (!p) { this.loading.set(false); return; }
    this.movError.set(null);
    this.api.movements({
      period: p, account_id: this.fAccount() || undefined, group_key: this.fGroup() || undefined,
      uncategorized: this.fUncat() || undefined, recon_status: this.fRecon() || undefined,
      search: this.fSearch() || undefined, limit: 500,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.movements.set(r.rows); this.movTotal.set(r.total); this.loading.set(false); },
      error: () => { this.movError.set('No se pudieron cargar los movimientos.'); this.loading.set(false); },
    });
  }

  onSearch(v: string): void {
    this.fSearch.set(v);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.reloadMovements(), 300);
  }

  /** Sube un workbook Excel: deriva el periodo del nombre (o usa el seleccionado) e importa. */
  onFile(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const upper = file.name.toUpperCase();
    const m = upper.match(/(ENERO|FEBRERO|MARZO|ABRIL|MAYO|JUNIO|JULIO|AGOSTO|SEPTIEMBRE|OCTUBRE|NOVIEMBRE|DICIEMBRE)\s+(\d{4})/);
    const period = m ? `${m[2]}-${MONTHS_ES[m[1]]}` : this.period();
    if (!period) { this.fail('No pude derivar el periodo del nombre; selecciona un periodo primero.'); input.value = ''; return; }

    this.uploading.set(true);
    const reader = new FileReader();
    reader.onload = () => {
      const b64 = String(reader.result || '');
      this.api.importWorkbook(b64, period, file.name).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (res) => {
          this.uploading.set(false);
          input.value = '';
          this.toast.add({ severity: 'success', summary: `Importado ${res.period}`, detail: `${res.total} movimientos · ${res.sin_clasificar} sin clasificar`, life: 4000 });
          if (!this.periods().includes(res.period)) this.periods.update((ps) => [res.period, ...ps].sort().reverse());
          this.setPeriod(res.period);
        },
        error: () => { this.uploading.set(false); input.value = ''; this.fail('No se pudo importar el Excel.'); },
      });
    };
    reader.onerror = () => { this.uploading.set(false); input.value = ''; this.fail('No se pudo leer el archivo.'); };
    reader.readAsDataURL(file);
  }

  /** Totales del cierre según el toggle "contar traspasos": por default EXCLUYE los
   *  traspasos internos (flujo operativo real); si se activan, muestra el bruto. */
  cierreTotals(d: Diagnostico): { ingresos: number; egresos: number; neto: number } {
    const tr = this.concentrado()?.groupTotals?.['traspaso'];
    if (this.countTransfers() || !tr) return { ingresos: d.ingresos, egresos: d.egresos, neto: d.neto };
    const ingresos = d.ingresos - (tr.deposits || 0);
    const egresos = d.egresos - (tr.withdrawals || 0);
    return { ingresos, egresos, neto: Math.round((ingresos - egresos) * 100) / 100 };
  }
  /** KPIs del dinero para la vista Cierre (ingresos/egresos/neto/movs + traspasos aparte). */
  cierreKpis(d: Diagnostico): MetricStripItem[] {
    const t = this.cierreTotals(d);
    const items: MetricStripItem[] = [
      { label: 'Ingresos', value: t.ingresos, format: 'currency', tone: 'ok' },
      { label: 'Egresos', value: t.egresos, format: 'currency' },
      { label: 'Neto', value: t.neto, format: 'currency', tone: t.neto >= 0 ? 'ok' : 'bad' },
      { label: 'Movimientos', value: d.movimientos, format: 'number' },
    ];
    const tr = this.balances()?.traspasos;
    if (tr) items.push({ label: 'Traspasos', value: tr.entra, format: 'currency', tone: this.cuadra(tr.delta) ? 'ok' : 'warn' });
    return items;
  }

  /** Corre el matching por-transacción del periodo y recarga los movimientos (recon_status). */
  runMatch(): void {
    if (!this.period()) return;
    this.matching.set(true);
    this.api.runMatch(this.period()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (mr) => {
        this.matching.set(false);
        this.matchResult.set(mr);
        this.toast.add({ severity: 'success', summary: `Conciliación ${mr.match_rate}%`, detail: `${mr.matched} de ${mr.bank_movements} retiros conciliados`, life: 3500 });
        this.api.differences(this.period()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (df) => this.differences.set(df), error: () => this.differences.set(null) });
        this.refreshDiagnostico();
        this.reloadMovements();
      },
      error: () => { this.matching.set(false); this.fail('No se pudo correr la conciliación.'); },
    });
  }

  /** CB.7 — Empuja las diferencias del periodo a la bandeja de hallazgos de Maat. */
  syncFindings(): void {
    if (!this.period()) return;
    this.syncing.set(true);
    this.api.syncFindings(this.period()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.syncing.set(false);
        this.toast.add({ severity: 'success', summary: `${r.pushed} diferencias enviadas`, detail: `${r.inserted} nuevas en /finanzas/hallazgos · ${r.skipped} omitidas`, life: 4000 });
      },
      error: () => { this.syncing.set(false); this.fail('No se pudieron enviar las diferencias a Hallazgos.'); },
    });
  }

  /** Refresca el diagnóstico + balances del periodo (tras reclasificar / conciliar). */
  private refreshDiagnostico(): void {
    const p = this.period();
    if (!p) return;
    this.api.diagnostico(p).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (d) => this.diagnostico.set(d), error: () => {} });
    this.api.balances(p).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (b) => this.balances.set(b), error: () => {} });
  }

  /** Tolerancia de cuadre: ±$1,000 (o ~0.5%) se considera cuadrado. */
  cuadra(delta: number): boolean { return Math.abs(delta) < 1000; }

  /** About "cómo se resuelve" por tipo de item del Cierre (topic del diccionario, o null). */
  helpTopic(tipo: string): string | null {
    const map: Record<string, string> = {
      sin_clasificar: 'bancos_sin_clasificar',
      saldo_no_cuadra: 'bancos_saldo_no_cuadra',
      traspaso_descuadre: 'bancos_traspaso_descuadre',
      cuenta_sin_cargar: 'bancos_cuenta_sin_cargar',
      kepler_pnl: 'bancos_caja',
    };
    return map[tipo] ?? null;
  }

  private money0(v: number): string {
    return Number(v || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  }
  /** Lectura en llano del cuadre de caja (banco vs 102 de Kepler). Lado retiros = la
   *  conciliación real; lado depósitos = memo (por eso se explica por qué difiere). */
  cajaRead(rc: Reconciliation): string {
    const dOut = Math.abs(rc.cash.delta_out);
    const salida = this.cuadra(rc.cash.delta_out)
      ? `Los ${this.money0(rc.cash.bank_out)} que salieron del banco cuadran con los abonos del 102 en Kepler.`
      : `De los ${this.money0(rc.cash.bank_out)} que salieron del banco, Kepler reconoce ${this.money0(rc.cash.kepler_102_abonos)} en el 102 — difieren ${this.money0(dOut)}. Esta es la conciliación que importa (el detalle por pago está abajo).`;
    if (this.cuadra(rc.cash.delta_in)) return salida;
    const dIn = Math.abs(rc.cash.delta_in);
    return `${salida} El lado de depósitos difiere ${this.money0(dIn)}, pero es memo, no un gap: mezcla los depósitos de banco con el efectivo de CAJA GENERAL (que Kepler asienta en caja, no en el 102) y con cobranza que entra por otra sucursal — la columna de depósitos no es espejo del mayor 102, así que ese Δ no se persigue 1 a 1.`;
  }
  /** Lectura en llano del matching por-transacción. */
  matchRead(mr: MatchResult): string {
    if (mr.unmatched_bank === 0) return `Todos los retiros del banco ya tienen su pago en Kepler (100%).`;
    const ap = this.amtPct(mr);
    return `Ya concilió el ${ap}% del dinero (${this.money0(mr.matched_amount)} de ${this.money0(mr.bank_amount)}). Los ${mr.unmatched_bank} retiros sin conciliar son en su mayoría comisiones y nómina chicas que Kepler agrupa (no concilian 1 a 1) — por eso el % por conteo (${mr.match_rate}%) se ve más bajo que el % por monto.`;
  }
  label(group: string): string { return GROUP_LABELS[group] || group; }
  kindLabel(kind: string): string { return kind === 'bank' ? 'Banco' : kind === 'cash' ? 'Caja' : 'Factoraje'; }
  /** Color del grupo (CC.1) como referencia CSS var, para tinte de fila / dot de leyenda. */
  groupColorVar(group?: string | null): string { return GROUP_COLOR[group || 'sin_clasificar'] || 'transparent'; }
  /** Fecha dd/MM/yy sin conversión de TZ (string puro; evita el off-by-one del date pipe con fechas date). */
  dmy(v: unknown): string {
    const m = String(v ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1].slice(2)}` : String(v ?? '');
  }

  /** Checklist accionable: salta al lugar exacto para resolver cada descuadre del diagnóstico. */
  itemAction(it: { tipo?: string }): void {
    switch (it?.tipo) {
      case 'sin_clasificar': this.view.set('movimientos'); this.fGroup.set(''); this.fUncat.set(true); this.reloadMovements(); break;
      case 'traspaso_descuadre': this.view.set('movimientos'); this.fUncat.set(false); this.fGroup.set('traspaso'); this.reloadMovements(); break;
      case 'saldo_no_cuadra': this.view.set('cuentas'); break;
      case 'kepler_pnl': this.view.set('conciliacion'); break;
      case 'cuenta_sin_cargar': this.fileInput?.nativeElement.click(); break;
      default: this.view.set('movimientos'); this.reloadMovements();
    }
  }
  /** Renglones donde salta el saldo de una cuenta (del diagnóstico): "dónde está la diferencia". */
  breaksFor(a: { bank: string; account_label: string }): { label: string; monto?: number }[] {
    const key = `${a.bank} ${a.account_label}:`;
    const it = this.diagnostico()?.items.find((x) => x.tipo === 'saldo_no_cuadra' && x.titulo.startsWith(key));
    return it?.evidencia ?? [];
  }
  /** Desde Cuentas: salta a Movimientos filtrado a esa cuenta. */
  verCuentaMovs(a: { bank: string; account_label: string }): void {
    const acct = this.accounts().find((x) => x.bank === a.bank && x.account_label === a.account_label);
    this.fAccount.set(acct?.id || '');
    this.fGroup.set('');
    this.fUncat.set(false);
    this.view.set('movimientos');
    this.reloadMovements();
  }
  itemActionLabel(it: { tipo?: string }): string {
    switch (it?.tipo) {
      case 'sin_clasificar': return 'Ver sin clasificar';
      case 'traspaso_descuadre': return 'Ver traspasos';
      case 'saldo_no_cuadra': return 'Ver cuenta';
      case 'kepler_pnl': return 'Ver conciliación';
      case 'cuenta_sin_cargar': return 'Subir estado';
      default: return 'Revisar';
    }
  }

  // CB.13 — búsqueda en el catálogo real de cuentas de Kepler.
  onKaSearch(v: string): void {
    this.kaSearch.set(v);
    const s = (v || '').trim();
    if (!s) { this.keplerAccounts.set([]); return; }
    this.api.keplerAccounts(s).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => this.keplerAccounts.set(r), error: () => this.keplerAccounts.set([]),
    });
  }

  // ── Admin ──
  openAdmin(): void { this.view.set('admin'); }

  private ok(summary: string): void { this.toast.add({ severity: 'success', summary, life: 1500 }); }

  patchAccount(a: BankAccount, patch: Partial<BankAccount>): void {
    this.accounts.update((as) => as.map((x) => x.id === a.id ? { ...x, ...patch } : x));
    this.api.updateAccount(a.id, patch).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: () => this.ok('Cuenta actualizada'), error: () => this.fail('No se pudo actualizar la cuenta.') });
  }
  addAccount(): void {
    if (this.addingAcct()) return;
    if (!this.naBank || !this.naLabel) { this.fail('Banco y cuenta requeridos.'); return; }
    this.addingAcct.set(true);
    this.api.createAccount({ bank: this.naBank, account_label: this.naLabel, alias: this.naAlias || null, kind: this.naKind, kepler_link: this.naKepler || null } as any)
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: () => { this.addingAcct.set(false); this.naBank = this.naLabel = this.naAlias = this.naKepler = ''; this.api.accounts().pipe(takeUntilDestroyed(this.destroyRef)).subscribe((as) => this.accounts.set(as)); this.ok('Cuenta agregada'); },
        error: () => { this.addingAcct.set(false); this.fail('No se pudo agregar la cuenta.'); },
      });
  }

  private fail(msg: string): void {
    this.loading.set(false);
    this.toast.add({ severity: 'error', summary: 'Error', detail: msg, life: 4000 });
  }
}
