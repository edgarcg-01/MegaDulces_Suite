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
  BankView as View, MONTHS_ES, WORK_VIEWS,
  GROUP_LABELS, GROUP_ORDER,
} from './bancos/bancos-shared';
import { BancosConcentradoComponent } from './bancos/bancos-concentrado.component';
import { BancosConciliacionComponent } from './bancos/bancos-conciliacion.component';
import { BancosCuentasComponent } from './bancos/bancos-cuentas.component';
import { BancosCierreComponent } from './bancos/bancos-cierre.component';
import { BancosMovimientosComponent } from './bancos/bancos-movimientos.component';
import { BancosAdminComponent } from './bancos/bancos-admin.component';

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
    BancosConcentradoComponent, BancosConciliacionComponent, BancosCuentasComponent, BancosCierreComponent,
    BancosMovimientosComponent, BancosAdminComponent],
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
          <bancos-cierre [diagnostico]="diagnostico()" [concentrado]="concentrado()" [balances]="balances()"
            [period]="period()" (itemAction)="itemAction($event)" />
        }
      }

      <!-- ── CONCENTRADO ── -->
      @if (view() === 'concentrado') {
        @if (concError()) {
          <app-load-state [error]="concError()" (retry)="setPeriod(period())"></app-load-state>
        } @else {
          @if (concentrado(); as c) {
            <bancos-concentrado [concentrado]="c" [balances]="balances()" [accountOpts]="accountOpts()" />
          } @else {
            <div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin estados de cuenta para {{ period() }}.</p></div>
          }
        }
      }

      <!-- ── MOVIMIENTOS: la tabla de todos los ingresos y egresos ── -->
      @if (view() === 'movimientos') {
        <bancos-movimientos [movements]="movements()" [movTotal]="movTotal()"
          [accountOpts]="accountOpts()" [groupOpts]="groupOpts()" [reconOpts]="reconOpts"
          [fAccount]="fAccount()" [fGroup]="fGroup()" [fRecon]="fRecon()" [fUncat]="fUncat()" [fSearch]="fSearch()"
          (filter)="onMovFilter($event)" (searchChange)="onSearch($event)" />
      }

      <!-- ── CONCILIACIÓN banco ↔ Kepler (answer-first: veredicto → sin conciliar → evidencia) ── -->
      @if (view() === 'conciliacion') {
        @if (reconError()) {
          <app-load-state [error]="reconError()" (retry)="setPeriod(period())"></app-load-state>
        } @else {
          <bancos-conciliacion [reconciliation]="reconciliation()" [matchResult]="matchResult()"
            [differences]="differences()" [matching]="matching()" [syncing]="syncing()" [period]="period()"
            (runMatch)="runMatch()" (syncFindings)="syncFindings()" />
        }
      }

      <!-- ── CUENTAS: cuadre de saldos por cuenta (clic → sus movimientos) ── -->
      @if (view() === 'cuentas') {
        <bancos-cuentas [balances]="balances()" [statements]="statements()" [diagnostico]="diagnostico()"
          [period]="period()" (openAccount)="verCuentaMovs($event)" />
      }

      <!-- ── ADMIN: catálogo real Kepler (read-only) + setup de cuentas de banco ── -->
      @if (view() === 'admin') {
        <bancos-admin [keplerAccounts]="keplerAccounts()" [accounts]="accounts()"
          [kaSearch]="kaSearch()" [addingAcct]="addingAcct()"
          (search)="onKaSearch($event)" (patchAccount)="patchAccount($event.a, $event.patch)"
          (addAccount)="addAccount($event)" />
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

  // Filtros de Movimientos (el shell los posee para poder recargar al cambiar de periodo).
  readonly fAccount = signal('');
  readonly fGroup = signal('');
  readonly fUncat = signal(false);
  readonly fSearch = signal('');
  readonly fRecon = signal('');
  readonly uploading = signal(false);
  private searchTimer: any = null;

  readonly reconOpts = [
    { label: 'Conciliación: todos', value: '' },
    { label: 'Conciliados', value: 'matched' },
    { label: 'Sin conciliar', value: 'unmatched' },
  ];

  // CB.13 — buscador del catálogo real de cuentas Kepler (resultados los posee el shell).
  readonly kaSearch = signal('');
  readonly keplerAccounts = signal<KeplerAccount[]>([]);

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

  /** Cambio de filtro emitido por <bancos-movimientos>: setea el signal y recarga. */
  onMovFilter(e: { field: string; value: any }): void {
    switch (e.field) {
      case 'account': this.fAccount.set(e.value || ''); break;
      case 'group': this.fGroup.set(e.value || ''); break;
      case 'recon': this.fRecon.set(e.value || ''); break;
      case 'uncat': this.fUncat.set(!!e.value); break;
    }
    this.reloadMovements();
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
  /** Desde Cuentas: salta a Movimientos filtrado a esa cuenta. */
  verCuentaMovs(a: { bank: string; account_label: string }): void {
    const acct = this.accounts().find((x) => x.bank === a.bank && x.account_label === a.account_label);
    this.fAccount.set(acct?.id || '');
    this.fGroup.set('');
    this.fUncat.set(false);
    this.view.set('movimientos');
    this.reloadMovements();
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
  addAccount(p: { bank: string; account_label: string; alias: string; kind: string; kepler_link: string }): void {
    if (this.addingAcct()) return;
    if (!p.bank || !p.account_label) { this.fail('Banco y cuenta requeridos.'); return; }
    this.addingAcct.set(true);
    this.api.createAccount({ bank: p.bank, account_label: p.account_label, alias: p.alias || null, kind: p.kind, kepler_link: p.kepler_link || null } as any)
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: () => { this.addingAcct.set(false); this.api.accounts().pipe(takeUntilDestroyed(this.destroyRef)).subscribe((as) => this.accounts.set(as)); this.ok('Cuenta agregada'); },
        error: () => { this.addingAcct.set(false); this.fail('No se pudo agregar la cuenta.'); },
      });
  }

  private fail(msg: string): void {
    this.loading.set(false);
    this.toast.add({ severity: 'error', summary: 'Error', detail: msg, life: 4000 });
  }
}
