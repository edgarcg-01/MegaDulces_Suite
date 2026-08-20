import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { environment } from '../../../../environments/environment';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { BancosSocketService } from '../bancos-socket.service';
import { FINANZAS_SHARED_STYLES } from './finanzas-shared.styles';
import { SortState, toggleSort, sortIcon, ariaSort, sortRows } from './finanzas-sort';
import { money, dmy } from './finanzas-format';
import { exportXlsx, XlsxSheet } from '../../../shared/export/xlsx-export';

type View = 'general' | 'cuadre' | 'workbook' | 'resumen' | 'depositos' | 'arqueos' | 'conciliacion' | 'enlace';
interface OrigenCell { n: number; monto: number }
interface CajaCuadre {
  period: { from: string; to: string };
  totals: { ingreso: number; gasto: number; deposito: number; remisiones_gastos: number; neto: number; cuadra: boolean; dias: number };
  ingreso_origen: { sucursal: OrigenCell; ruta: OrigenCell; otros: OrigenCell };
  pos_efectivo: { efectivo: number; n: number };
  por_dia: { fecha: string; ingreso: number; gasto: number; deposito: number; neto: number; n: number; arqueo_efectivo: number | null; arqueo_n: number }[];
}
interface CajaWb {
  period: { from: string; to: string };
  totals: { mdb_ingreso: number; mdb_gasto: number; wb_ingreso: number; wb_gasto: number; kp_ingreso: number; kp_gasto: number; delta_ingreso: number; delta_gasto: number; delta_kep_ingreso: number; delta_kep_gasto: number; dias: number; dias_wb: number; dias_descuadre: number; wb_disponible: boolean; kep_disponible: boolean };
  /** ±$ por DÍA (captura exacta) y ±$ de TOTALES (absorbe el redondeo de ~30 días). */
  eps_total: number;
  por_dia: { fecha: string; mdb_ingreso: number; mdb_gasto: number; mdb_n: number; wb_ingreso: number; wb_gasto: number; wb_n: number; kp_ingreso: number; kp_gasto: number; kp_n: number; delta_ingreso: number; delta_gasto: number; delta_kep_ingreso: number; delta_kep_gasto: number; wb_vacio: boolean; cuadra: boolean }[];
  eps: number;
}
interface WbMov { id: string; fecha: string; concepto: string | null; sucursal: string | null; codigo: string | null; ingreso: number; gasto: number }
interface OrphanMov { id: string; fecha: string; importe: number; concepto: string | null; extra: string | null }
interface ReconSide { caja_total: number; other_total: number; delta: number; matched_count: number; matched_amount: number; caja_only: OrphanMov[]; other_only: OrphanMov[]; caja_only_amount: number; other_only_amount: number }
/** Una fila del detalle del día: un movimiento del Control con lo que casó en cada fuente. */
interface DiaRow {
  id: string; fecha: string; dir: 'in' | 'out'; importe: number; concepto: string | null; extra: string | null;
  manual: boolean; manual_importe: number | null; manual_ref: string | null;
  kepler: boolean; kepler_importe: number | null; kepler_ref: string | null;
}
interface DiaTotals {
  control_n: number; control_monto: number; en_manual: number; en_kepler: number;
  manual_only_n: number; manual_only_monto: number; kepler_only_n: number; kepler_only_monto: number;
}
interface ConcDia {
  period: { from: string; to: string };
  vs_manual: { ingresos: ReconSide; gastos: ReconSide };
  vs_kepler: { ingresos: ReconSide; gastos: ReconSide };
  rows: DiaRow[]; totals: DiaTotals;
}
interface CajaGeneral {
  period: { from: string; to: string };
  totals: { ingreso: number; gasto: number; neto: number; n: number; saldo: number; saldo_fecha: string | null };
  por_mes: { mes: string; ingreso: number; gasto: number; n: number }[];
  por_cuenta: { cuenta: string; cuenta_nombre: string | null; ingreso: number; gasto: number; n: number }[];
  movimientos: { uid: string; mov_id: string; tipo_dto: number; tipo: string | null; fecha: string; hora: string | null; usuario: string | null; cuenta: string; cuenta_nombre: string | null; nombre_cliente: string | null; concepto: string | null; ingreso: number; gasto: number; saldo: number; denom: Record<string, number> | null }[];
}
interface Overview {
  period: { from: string; to: string; instance: string };
  venta_total: number; dias: number; sucursales: number; vendido: number; depositado: number; descuadre: number;
  depositos: { n: number; total: number; total_real: number; comision: number };
  tenders: { tender: string; vendido: number; depositado: number; descuadre: number }[];
}
interface SucursalRow { almacen: string; empresa: string | null; nombre: string | null; dias: number; venta: number; depositado: number; descuadre: number; pct_depositado: number; ultima: string }
interface DepRow { deposito_id: string; almacen: string; banco_name: string | null; banco_cuenta: string | null; deposito_date: string; deposito_date_real: string | null; tipo_pago: string | null; total_deposito: number; total_deposito_real: number; comision: number; observaciones: string | null }
interface DepResp { rows: DepRow[]; totals: { n: number; total: number; total_real: number; comision: number }; by_bank: { banco: string; n: number; total_real: number }[] }
interface ArqRow { mov_id: string; source_caja: string; folio: string | null; tipo: string | null; arqueo_date: string; capturo: string | null; total_efectivo: number; total_cheques: number; total_tarjeta: number; mov_total: number; revisado: boolean; cancelado: boolean; observaciones: string | null }
interface ArqResp { rows: ArqRow[]; by_tipo: { tipo: string; n: number; monto: number }[] }
interface ConcRow { banco: string; caja: number; caja_n: number; wb: number; wb_n: number; kep: number; kep_n: number; cpq: number; cpq_n: number; delta_caja_wb: number; delta_caja_cpq: number; cuadra_caja_wb: boolean; cuadra_wb_kep: boolean; cuadra_wb_cpq: boolean }
interface Conc { period: { from: string; to: string; instance: string }; totals: { caja: number; wb: number; kep: number; cpq: number; wb_disponible: boolean; kep_disponible: boolean; cpq_disponible: boolean }; por_banco: ConcRow[]; cuadre_eps: number }
interface CDet {
  totals: { matched_n: number; matched: number; caja_only_n: number; caja_only: number; cobranza_n: number; cobranza: number; residual_n: number; residual: number; bank_only_n: number; bank_only: number };
  matched: { banco: string; almacen: string; fecha: string; monto: number }[];
  caja_only: { banco: string; almacen: string; fecha: string; monto: number }[];
  bank_only: { label: string; fecha: string; monto: number; concept: string }[];
}
interface Facets { meses: string[]; bancos: string[]; empresas: string[]; cajas: string[] }
interface XwRow { banco_code: string; banco_name: string; canon_bank: string; deposits: number; monto: number; current_label: string | null; confirmed_by: string | null; suggested_label: string | null; suggested_matches: number; suggested_reason: 'kepler' | 'unica_cuenta' | null; alternatives: { label: string; n: number }[]; cb_options: string[] }
const TENDER_LABEL: Record<string, string> = { efectivo: 'Efectivo', morralla: 'Morralla', cheques: 'Cheques', tarjeta: 'Tarjeta', caja_chica: 'Caja chica', sobregiro: 'Sobregiro' };

/**
 * Fase CG.4 — Caja General (Tesorería). Espejo del sistema Access de Finanzas:
 * venta diaria por sucursal → depósito bancario, arqueo por denominación, y
 * conciliación de depósitos vs el estado de cuenta (CB). Read-only, Operations mode.
 */
@Component({
  selector: 'app-finanzas-caja',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ButtonModule, InputTextModule, IconFieldModule, InputIconModule, TableModule, SelectModule, TagModule, DialogModule, MetricStripComponent],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Caja General</h1>
          <p class="surf-page-sub">Control de <b>venta diaria → depósito bancario</b> por sucursal (la capa entre el punto de venta y el banco), arqueo de caja por denominación, y conciliación de depósitos contra el estado de cuenta. Espejo read-only del sistema de Finanzas.</p>
        </div>
        <div class="cg-head-actions">
          <p-select [options]="f().meses" [ngModel]="month()" (onChange)="onMonth($event.value)" placeholder="Mes" styleClass="cg-sel" ariaLabel="Mes" />
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="loading()" (click)="reload()"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Actualizar</span></button>
        </div>
      </header>

      <!-- Mismo segmentado que Bancos (fb-viewseg): la misma app no puede navegar de dos
           formas distintas según la pantalla. Lo propio de Caja es el badge "histórico". -->
      <div class="fb-viewseg" role="tablist" aria-label="Vistas de caja">
        @for (v of VIEWS; track v.key) {
          <button role="tab" [attr.aria-selected]="view()===v.key" [class.active]="view()===v.key" [class.legacy]="v.legacy" (click)="setView(v.key)">
            <span class="pi {{v.icon}}" aria-hidden="true"></span> {{ v.label }}@if (v.legacy) { <span class="cg-hist" title="Fuente histórica (Base Movimientos, ≤ ene-2026)">histórico</span> }
          </button>
        }
      </div>

      @if (isLegacy()) {
        <div class="cg-legacy-note" role="note">
          <i class="pi pi-clock" aria-hidden="true"></i>
          <span>Esta vista usa el <b>Base Movimientos</b> de Finanzas, que <b>dejó de alimentarse</b> (ventas 08/abr-2026, depósitos ene-2026). Los datos están completos <b>solo hasta ene-2026</b>; para meses recientes saldrá vacía. La caja <b>viva</b> es <b>General</b> y <b>Cuadre</b> (Doctos).</span>
        </div>
      }

      @if (err(); as e) { <div class="cg-errbox" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span class="cg-errbox-txt">{{ e }}</span><button pButton type="button" class="p-button-sm p-button-outlined" (click)="reload()" label="Reintentar"></button></div> }

      <!-- ===== CAJA GENERAL (Doctos, viva) ===== -->
      @if (view()==='general') {
        <div class="cg-filters">
          <p-select [options]="['Ingreso','Gasto']" [ngModel]="cgTipo()" (onChange)="onCgTipo($event.value)" placeholder="Tipo" [showClear]="true" styleClass="cg-sel" ariaLabel="Tipo" />
          <p-iconfield styleClass="cg-search"><p-inputicon styleClass="pi pi-search" /><input pInputText type="text" placeholder="Cuenta/cliente/concepto…" [ngModel]="search()" (ngModelChange)="onSearch($event)" class="p-inputtext-sm" aria-label="Buscar" /></p-iconfield>
        </div>
        @if (loading() && !cg()) { <div class="fb-skeleton" aria-busy="true">@for (i of skel; track i) { <div class="fb-skel-row"></div> }</div> }
        @else if (cg(); as d) {
          <app-metric-strip [items]="cgKpis(d)" ariaLabel="Totales de caja general" />
          <div class="cg-two">
            <div class="cg-bd cg-bd-wide">
              <span class="cg-bd-title">Por cuenta (ingreso / gasto) — top 40</span>
              <p-table [value]="d.por_cuenta" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="46vh" [paginator]="d.por_cuenta.length>40" [rows]="40">
                <ng-template #header><tr><th>Cuenta</th><th class="ta-r">Ingreso</th><th class="ta-r">Gasto</th><th class="ta-c cg-w-d">#</th></tr></ng-template>
                <ng-template #body let-r>
                  <tr>
                    <td>{{ r.cuenta_nombre || '—' }} <span class="muted">#{{ r.cuenta }}</span></td>
                    <td class="ta-r num" [class.strong]="r.ingreso>0">{{ r.ingreso ? money(r.ingreso) : '—' }}</td>
                    <td class="ta-r num" [class.strong]="r.gasto>0">{{ r.gasto ? money(r.gasto) : '—' }}</td>
                    <td class="ta-c muted">{{ r.n }}</td>
                  </tr>
                </ng-template>
              </p-table>
            </div>
          </div>
          <p-table [value]="d.movimientos" dataKey="uid" [expandedRowKeys]="expanded()" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="58vh" [paginator]="d.movimientos.length>100" [rows]="100">
            <ng-template #header><tr><th class="cg-w-x"></th><th class="cg-w-date">Fecha</th><th>Cuenta</th><th>Cliente / Concepto</th><th class="ta-r">Egreso</th><th class="ta-r">Ingreso</th></tr></ng-template>
            <ng-template #body let-r>
              <tr class="cg-row-click" (click)="toggleRow(r)" [class.cg-row-open]="isExp(r)">
                <td><i class="pi cg-chev" [class.pi-chevron-right]="!isExp(r)" [class.pi-chevron-down]="isExp(r)" aria-hidden="true"></i></td>
                <td class="cg-mono">{{ dmy(r.fecha) }}</td>
                <td class="cg-emp" [title]="r.cuenta_nombre">{{ r.cuenta_nombre || '—' }} <span class="muted">#{{ r.cuenta }}</span></td>
                <td class="cg-emp" [title]="r.nombre_cliente">{{ r.nombre_cliente || '—' }}@if (r.concepto) { <span class="muted"> · {{ r.concepto }}</span> }</td>
                <td class="ta-r num cg-eg" [class.strong]="r.gasto>0">{{ r.gasto ? money(r.gasto) : '—' }}</td>
                <td class="ta-r num cg-in" [class.strong]="r.ingreso>0">{{ r.ingreso ? money(r.ingreso) : '—' }}</td>
              </tr>
            </ng-template>
            <ng-template #expandedrow let-r>
              <tr class="cg-detail-row"><td colspan="6">
                <div class="cg-detail">
                  <div class="cg-detail-meta">
                    <span><b>{{ r.tipo }}</b> · folio {{ r.mov_id }}</span>
                    <span>{{ dmyLong(r.fecha) }} {{ r.hora || '' }}</span>
                    @if (r.usuario) { <span>capturó: <b>{{ r.usuario }}</b></span> }
                    <span>cuenta: <b>{{ r.cuenta_nombre }}</b> <span class="muted">#{{ r.cuenta }}</span></span>
                    <span class="cg-detail-amt" [class.cg-in]="r.ingreso>0" [class.cg-eg]="r.gasto>0">{{ r.ingreso>0 ? '+'+money(r.ingreso) : '−'+money(r.gasto) }}</span>
                  </div>
                  @if (denomList(r.denom).length) {
                    <div class="cg-denom">
                      <span class="cg-denom-t">Denominación:</span>
                      @for (dn of denomList(r.denom); track dn.k) { <span class="cg-denom-c"><b>{{ dn.n }}</b>×{{ dn.label }}</span> }
                    </div>
                  } @else { <div class="cg-denom muted">Sin desglose de denominación.</div> }
                  @if (r.concepto) { <div class="cg-detail-obs">{{ r.concepto }}</div> }
                </div>
              </td></tr>
            </ng-template>
            <ng-template #emptymessage><tr><td colspan="6"><div class="cg-empty"><i class="pi pi-inbox" aria-hidden="true"></i><span>Sin movimientos en el periodo.</span></div></td></tr></ng-template>
          </p-table>
          <p class="cg-note">Caja general <b>viva</b> de Comisionistas (sistema operativo <code>Doctos</code>): la venta de ruta <b>entra</b> (ingreso) y sale a <b>pagar proveedores</b> (remisiones), comisiones y gastos por sucursal. Reemplaza el Base Movimientos (abandonado abr-2026). Saldo actual: <b>{{ money(d.totals.saldo) }}</b>@if (d.totals.saldo_fecha) { <span class="muted"> (al {{ dmy(d.totals.saldo_fecha) }})</span> }. Mostrando hasta 500 movimientos del periodo.</p>
        }
      }

      <!-- ===== CUADRE (conciliación 3 fuentes: .mdb operativo vs Manual vs Kepler) ===== -->
      @if (view()==='cuadre') {
        @if (loading() && !wbc()) { <div class="fb-skeleton" aria-busy="true">@for (i of skel; track i) { <div class="fb-skel-row"></div> }</div> }
        @else if (wbc(); as d) {

          <!-- Veredicto answer-first (mismo organismo que el Cuadre de Bancos) -->
          @if (!d.totals.wb_disponible) {
            <div class="tw-verdict bad">
              <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
              <div>
                <h3>Sin workbook para este periodo</h3>
                <p class="muted">La hoja CAJA GENERAL del Sheet está vacía: no hay copia manual contra la cual conciliar. Llénala en el Excel, o usá <b>General</b> — el Control no depende del manual.</p>
              </div>
            </div>
          } @else {
            <div class="tw-verdict" [class.ok]="d.totals.dias_descuadre===0" [class.bad]="d.totals.dias_descuadre>0">
              <i [class]="d.totals.dias_descuadre===0 ? 'pi pi-check-circle' : 'pi pi-exclamation-triangle'" aria-hidden="true"></i>
              <div>
                <h3>{{ verdict(d) }}</h3>
                <p class="muted">El <b>Control</b> (caja viva Doctos) es lo que de verdad se movió; el <b>workbook</b> es la copia manual del Excel y <b>Kepler</b> el CAJA GENERAL del ERP. Tolerancia ±{{ money(d.eps) }}/día.</p>
              </div>
            </div>
          }

          <!-- Nivel 1 — control-total: las 3 fuentes del periodo.
               Las dos filas salen de ctRows(d) y no escritas a mano: duplicadas eran 20
               líneas donde cada arreglo había que hacerlo dos veces. Mismo patrón que Bancos. -->
          <div class="card-premium card-flat tw-card">
            <h3 class="tw-card-title">Control-total <span class="muted">— las 3 fuentes en {{ month() }} (tolerancia ±{{ money(d.eps_total) }})</span></h3>
            <div class="tw-wrap">
              <table class="tw-tbl">
                <thead>
                  <tr>
                    <th scope="col"></th>
                    <th scope="col" class="ta-r"><i class="pi pi-wallet"></i> Control</th>
                    <th scope="col" class="ta-r"><i class="pi pi-file-excel"></i> Workbook</th>
                    <th scope="col" class="ta-r"><i class="pi pi-database"></i> Kepler</th>
                    <th scope="col" class="ta-r" title="Control − Workbook">Δ C–W</th>
                    <th scope="col" class="ta-r" title="Control − Kepler">Δ C–K</th>
                    <th scope="col" class="ta-r" title="Workbook − Kepler">Δ W–K</th>
                    <th scope="col" class="ta-c">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of ctRows(d); track row.label) {
                    <tr>
                      <th scope="row"><i class="pi" [class.pi-arrow-down-left]="row.dir==='in'" [class.tw-in-ico]="row.dir==='in'" [class.pi-arrow-up-right]="row.dir==='out'" [class.tw-out-ico]="row.dir==='out'" aria-hidden="true"></i> {{ row.label }} <span class="muted">({{ row.dir==='in' ? 'entra' : 'sale' }})</span></th>
                      <td class="ta-r num">{{ money(row.control) }}</td>
                      <td class="ta-r num">{{ row.wb_ok ? money(row.workbook) : '—' }}</td>
                      <td class="ta-r num">{{ row.kep_ok ? money(row.kepler) : '—' }}</td>
                      <td class="ta-r num" [class.bad]="row.wb_ok && !cuadT(row.d_cw, d)" [class.ok]="row.wb_ok && cuadT(row.d_cw, d)">{{ row.wb_ok ? money(row.d_cw) : '—' }}</td>
                      <td class="ta-r num" [class.bad]="row.kep_ok && !cuadT(row.d_ck, d)" [class.ok]="row.kep_ok && cuadT(row.d_ck, d)">{{ row.kep_ok ? money(row.d_ck) : '—' }}</td>
                      <td class="ta-r num" [class.bad]="row.wb_ok && row.kep_ok && !cuadT(row.d_wk, d)" [class.ok]="row.wb_ok && row.kep_ok && cuadT(row.d_wk, d)">{{ row.wb_ok && row.kep_ok ? money(row.d_wk) : '—' }}</td>
                      <td class="ta-c">
                        @if (!row.wb_ok && !row.kep_ok) { <span class="tw-tag muted-tag">sin comparar</span> }
                        @else if (row.cuadra) { <i class="pi pi-check-circle ok" title="Cuadra contra las fuentes disponibles"></i> }
                        @else { <i class="pi pi-exclamation-triangle bad" title="No cuadra — revisa el detalle por día"></i> }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            <p class="tw-note muted"><i class="pi pi-info-circle"></i>
              <b>Control</b> = caja viva de Comisionistas (Doctos), lo que de verdad se movió. <b>Workbook</b> = copia manual del Excel; el <b>Δ C–W</b> es la comparación exacta y caza errores de captura. <b>Kepler</b> = CAJA GENERAL del ERP, más grueso (registra lo capturado, no cada movimiento) → su diferencia es informativa. Semáforo ±{{ money(d.eps_total) }} sobre el total del mes; el cuadre día por día usa ±{{ money(d.eps) }}.@if (!d.totals.kep_disponible) { <b> Sin feed Kepler en el periodo.</b> }
            </p>
          </div>


          <!-- Nivel 2 — por día: clic en una fila abre qué movimientos no casan -->
          <div class="card-premium card-flat tw-tablewrap">
            <h3 class="tw-card-title tw-pnl-title">Por día <span class="muted">— clic en un día para ver qué movimientos faltan de cada lado</span></h3>
            <div class="tw-wrap">
            <p-table [value]="d.por_dia" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="58vh" [paginator]="d.por_dia.length>60" [rows]="60">
              <ng-template #header>
                <tr>
                  <th class="cg-w-date" rowspan="2">Día</th>
                  <th class="ta-c tw-grp" colspan="4"><i class="pi pi-arrow-down-left tw-in-ico"></i> Ingreso</th>
                  <th class="ta-c tw-grp" colspan="4"><i class="pi pi-arrow-up-right tw-out-ico"></i> Gasto</th>
                  <th class="cg-w-e ta-c" rowspan="2">Estado</th>
                </tr>
                <tr>
                  <th class="ta-r">Control</th><th class="ta-r">Workbook</th><th class="ta-r tw-kep">Kepler</th><th class="ta-r">Δ C–W</th>
                  <th class="ta-r">Control</th><th class="ta-r">Workbook</th><th class="ta-r tw-kep">Kepler</th><th class="ta-r">Δ C–W</th>
                </tr>
              </ng-template>
              <ng-template #body let-r>
                <tr class="tw-clickable" (click)="openDay(r)">
                  <td class="cg-mono">{{ dmy(r.fecha) }} <span class="muted">· {{ r.mdb_n }}</span><i class="pi pi-search-plus tw-drill-ico"></i></td>
                  <td class="ta-r num">{{ money(r.mdb_ingreso) }}</td>
                  <td class="ta-r num muted">{{ r.wb_vacio ? '—' : money(r.wb_ingreso) }}</td>
                  <td class="ta-r num tw-kep" [class.warn]="r.kp_n && abs(r.delta_kep_ingreso)>d.eps" [title]="'Δ control–kepler: ' + money(r.delta_kep_ingreso)">{{ r.kp_n ? money(r.kp_ingreso) : '—' }}</td>
                  <td class="ta-r num" [class.bad]="!r.wb_vacio && abs(r.delta_ingreso)>d.eps">{{ r.wb_vacio ? '—' : money(r.delta_ingreso) }}</td>
                  <td class="ta-r num">{{ money(r.mdb_gasto) }}</td>
                  <td class="ta-r num muted">{{ r.wb_vacio ? '—' : money(r.wb_gasto) }}</td>
                  <td class="ta-r num tw-kep" [class.warn]="r.kp_n && abs(r.delta_kep_gasto)>d.eps" [title]="'Δ control–kepler: ' + money(r.delta_kep_gasto)">{{ r.kp_n ? money(r.kp_gasto) : '—' }}</td>
                  <td class="ta-r num" [class.bad]="!r.wb_vacio && abs(r.delta_gasto)>d.eps">{{ r.wb_vacio ? '—' : money(r.delta_gasto) }}</td>
                  <td class="cg-w-e ta-c">
                    @if (r.wb_vacio) { <span class="tw-tag muted-tag">sin workbook</span> }
                    @else if (r.cuadra) { <i class="pi pi-check-circle ok" title="Cuadra"></i> }
                    @else { <i class="pi pi-exclamation-triangle bad" title="No cuadra — abre el día"></i> }
                  </td>
                </tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="10"><div class="cg-empty"><i class="pi pi-inbox" aria-hidden="true"></i><span>Sin movimientos en el periodo.</span></div></td></tr></ng-template>
            </p-table>
            </div>
          </div>
        }
      }

      <!-- ===== RESUMEN ===== -->
      @if (view()==='resumen') {
        @if (loading() && !ov()) { <div class="fb-skeleton" aria-busy="true">@for (i of skel; track i) { <div class="fb-skel-row"></div> }</div> }
        @else if (ov(); as d) {
          <app-metric-strip [items]="ovKpis(d)" ariaLabel="Totales de caja" />
          <div class="cg-tenders">
            <span class="cg-bd-title">Venta vs depositado por forma de pago</span>
            <table class="cg-mini">
              <thead><tr><th>Forma</th><th class="ta-r">Vendido</th><th class="ta-r">Depositado</th><th class="ta-r">Descuadre</th></tr></thead>
              <tbody>
                @for (t of d.tenders; track t.tender) {
                  <tr><td>{{ tLabel(t.tender) }}</td><td class="ta-r num">{{ money(t.vendido) }}</td><td class="ta-r num muted">{{ money(t.depositado) }}</td><td class="ta-r num" [class.warn]="t.descuadre>1000">{{ money(t.descuadre) }}</td></tr>
                }
              </tbody>
            </table>
            <p class="cg-note">El <b>depositado</b> por forma de pago viene de las columnas de captura; el <b>ledger de depósitos</b> (pestaña Depósitos) tiene {{ money(d.depositos.total_real) }} reales ({{ d.depositos.n }}). Que las tres vistas —venta, columnas y ledger— no coincidan es <b>la señal</b>, no un error.</p>
          </div>
          @if (suc(); as rows) {
            <p-table [value]="rows" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="58vh">
              <ng-template #header><tr><th>Sucursal</th><th>Empresa</th><th class="ta-c cg-w-d">Días</th><th class="ta-r">Venta</th><th class="ta-r">Depositado</th><th class="ta-r">Descuadre</th><th class="ta-c cg-w-p">% dep</th><th class="cg-w-u">Última</th></tr></ng-template>
              <ng-template #body let-r>
                <tr>
                  <td class="cg-mono">{{ r.nombre || r.almacen }} <span class="muted">{{ r.almacen }}</span></td>
                  <td class="muted cg-emp" [title]="r.empresa">{{ r.empresa || '—' }}</td>
                  <td class="ta-c muted">{{ r.dias }}</td>
                  <td class="ta-r num strong">{{ money(r.venta) }}</td>
                  <td class="ta-r num muted">{{ money(r.depositado) }}</td>
                  <td class="ta-r num" [class.warn]="r.descuadre>1000">{{ money(r.descuadre) }}</td>
                  <td class="ta-c num" [class.warn]="r.pct_depositado<80">{{ r.pct_depositado }}%</td>
                  <td class="cg-mono muted">{{ dmy(r.ultima) }}</td>
                </tr>
              </ng-template>
            </p-table>
          }
        }
      }

      <!-- ===== DEPOSITOS ===== -->
      @if (view()==='depositos') {
        <div class="cg-filters">
          <p-select [options]="f().bancos" [ngModel]="banco()" (onChange)="onFilter('banco',$event.value)" placeholder="Banco" [showClear]="true" styleClass="cg-sel" ariaLabel="Banco" />
          <p-iconfield styleClass="cg-search"><p-inputicon styleClass="pi pi-search" /><input pInputText type="text" placeholder="Banco/cuenta/obs…" [ngModel]="search()" (ngModelChange)="onSearch($event)" class="p-inputtext-sm" aria-label="Buscar" /></p-iconfield>
          @if (banco() || search().trim()) { <button pButton type="button" class="p-button-sm p-button-text" (click)="clearDep()"><span class="pi pi-filter-slash" aria-hidden="true"></span>&nbsp;Limpiar</button> }
        </div>
        @if (loading() && !dep()) { <div class="fb-skeleton" aria-busy="true">@for (i of skel; track i) { <div class="fb-skel-row"></div> }</div> }
        @else if (dep(); as d) {
          <app-metric-strip [items]="depKpis(d)" ariaLabel="Totales de depósitos" />
          <div class="cg-bd">
            <span class="cg-bd-title">Por banco (real)</span>
            @for (b of d.by_bank; track b.banco) { <div class="cg-bd-row"><span class="cg-bd-k">{{ b.banco || '—' }}</span><span class="cg-bd-v">{{ money(b.total_real) }}</span><span class="cg-bd-n">{{ b.n }}</span></div> }
          </div>
          <p-table [value]="d.rows" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="58vh" [paginator]="d.rows.length>200" [rows]="200">
            <ng-template #header><tr><th class="cg-w-date">Depósito</th><th class="cg-w-date">Real</th><th>Banco</th><th class="cg-w-suc">Suc</th><th class="cg-w-met">Método</th><th class="ta-r">Depósito</th><th class="ta-r">Real</th><th class="ta-r cg-w-com">Comisión</th></tr></ng-template>
            <ng-template #body let-r>
              <tr>
                <td class="cg-mono">{{ dmy(r.deposito_date) }}</td>
                <td class="cg-mono muted">{{ r.deposito_date_real ? dmy(r.deposito_date_real) : '—' }}</td>
                <td>{{ r.banco_name || '—' }}@if (r.banco_cuenta) { <span class="muted"> ·{{ r.banco_cuenta }}</span> }</td>
                <td class="cg-mono muted">{{ r.almacen || '—' }}</td>
                <td class="muted">{{ r.tipo_pago || '—' }}</td>
                <td class="ta-r num muted">{{ money(r.total_deposito) }}</td>
                <td class="ta-r num strong">{{ money(r.total_deposito_real) }}</td>
                <td class="ta-r num muted">{{ r.comision ? money(r.comision) : '—' }}</td>
              </tr>
            </ng-template>
            <ng-template #emptymessage><tr><td colspan="8"><div class="cg-empty"><i class="pi pi-inbox" aria-hidden="true"></i><span>Sin depósitos en el periodo.</span></div></td></tr></ng-template>
          </p-table>
        }
      }

      <!-- ===== ARQUEOS ===== -->
      @if (view()==='arqueos') {
        <div class="cg-filters">
          <p-select [options]="tipoOpts" [ngModel]="tipo()" (onChange)="onFilter('tipo',$event.value)" placeholder="Tipo" [showClear]="true" styleClass="cg-sel" ariaLabel="Tipo" />
          <p-select [options]="f().cajas" [ngModel]="caja()" (onChange)="onFilter('caja',$event.value)" placeholder="Caja" [showClear]="true" styleClass="cg-sel" ariaLabel="Caja" />
        </div>
        @if (loading() && !arq()) { <div class="fb-skeleton" aria-busy="true">@for (i of skel; track i) { <div class="fb-skel-row"></div> }</div> }
        @else if (arq(); as d) {
          <div class="cg-bd">
            <span class="cg-bd-title">Por tipo</span>
            @for (t of d.by_tipo; track t.tipo) { <div class="cg-bd-row"><span class="cg-bd-k">{{ t.tipo || '—' }}</span><span class="cg-bd-v">{{ money(t.monto) }}</span><span class="cg-bd-n">{{ t.n }}</span></div> }
          </div>
          <p-table [value]="d.rows" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="58vh" [paginator]="d.rows.length>200" [rows]="200">
            <ng-template #header><tr><th class="cg-w-date">Fecha</th><th class="cg-w-fol">Folio</th><th>Tipo</th><th class="cg-w-suc">Caja</th><th class="ta-r">Efectivo</th><th class="ta-r">Cheques</th><th class="ta-r">Tarjeta</th><th class="ta-r">Total</th><th class="cg-w-e">Estado</th></tr></ng-template>
            <ng-template #body let-r>
              <tr [class.cg-cancel]="r.cancelado">
                <td class="cg-mono">{{ dmy(r.arqueo_date) }}</td>
                <td class="cg-mono">{{ r.folio || '—' }}</td>
                <td><p-tag [value]="r.tipo || '?'" [severity]="tipoSev(r.tipo)" styleClass="cg-tag" /></td>
                <td class="cg-mono muted">{{ r.source_caja }}</td>
                <td class="ta-r num">{{ money(r.total_efectivo) }}</td>
                <td class="ta-r num muted">{{ r.total_cheques ? money(r.total_cheques) : '—' }}</td>
                <td class="ta-r num muted">{{ r.total_tarjeta ? money(r.total_tarjeta) : '—' }}</td>
                <td class="ta-r num strong">{{ money(r.mov_total) }}</td>
                <td>@if (r.cancelado) { <p-tag value="cancelado" severity="danger" styleClass="cg-tag" /> } @else if (r.revisado) { <p-tag value="✓" severity="success" styleClass="cg-tag" /> } @else { <span class="muted">—</span> }</td>
              </tr>
            </ng-template>
            <ng-template #emptymessage><tr><td colspan="9"><div class="cg-empty"><i class="pi pi-inbox" aria-hidden="true"></i><span>Sin arqueos en el periodo.</span></div></td></tr></ng-template>
          </p-table>
        }
      }

      <!-- ===== CONCILIACION ===== -->
      @if (view()==='conciliacion') {
        @if (loading() && !conc()) { <div class="fb-skeleton" aria-busy="true">@for (i of skel; track i) { <div class="fb-skel-row"></div> }</div> }
        @else if (conc(); as d) {
          <app-metric-strip [items]="concKpis(d)" ariaLabel="Conciliación 3 vías caja/workbook/kepler" />
          <p-table [value]="d.por_banco" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="58vh">
            <ng-template #header>
              <tr>
                <th rowspan="2">Banco</th>
                <th class="ta-c tw-grp" colspan="2" title="Caja operativa">Caja</th>
                <th class="ta-c tw-grp" colspan="2">Workbook</th>
                <th class="ta-c tw-grp tw-kep" colspan="2">Kepler</th>
                <th class="ta-c tw-grp" colspan="2" title="Libros fiscales">ContPAQi</th>
                <th class="ta-r" rowspan="2">Δ caja–wb</th>
                <th class="cg-w-e ta-c" rowspan="2">Cuadre</th>
              </tr>
              <tr>
                <th class="ta-r">Depositado</th><th class="ta-c cg-w-d">#</th>
                <th class="ta-r">Ingresos</th><th class="ta-c cg-w-d">#</th>
                <th class="ta-r tw-kep">Entradas</th><th class="ta-c cg-w-d tw-kep">#</th>
                <th class="ta-r">Libros</th><th class="ta-c cg-w-d">#</th>
              </tr>
            </ng-template>
            <ng-template #body let-r>
              <tr>
                <td class="cg-mono">{{ r.banco || '—' }}</td>
                <td class="ta-r num strong">{{ r.caja ? money(r.caja) : '—' }}</td>
                <td class="ta-c muted">{{ r.caja_n || '' }}</td>
                <td class="ta-r num muted">{{ r.wb ? money(r.wb) : '—' }}</td>
                <td class="ta-c muted">{{ r.wb_n || '' }}</td>
                <td class="ta-r num muted">{{ r.kep ? money(r.kep) : '—' }}</td>
                <td class="ta-c muted">{{ r.kep_n || '' }}</td>
                <td class="ta-r num muted">{{ r.cpq ? money(r.cpq) : '—' }}</td>
                <td class="ta-c muted">{{ r.cpq_n || '' }}</td>
                <td class="ta-r num" [class.warn]="!r.cuadra_caja_wb && r.wb">{{ r.wb ? money(r.delta_caja_wb) : '—' }}</td>
                <td>@if (!r.wb) { <span class="muted">s/wb</span> } @else if (r.cuadra_caja_wb) { <p-tag value="cuadra" severity="success" styleClass="cg-tag" /> } @else { <p-tag value="revisar" severity="warn" styleClass="cg-tag" /> }</td>
              </tr>
            </ng-template>
          </p-table>
          <p class="cg-note">La escalera de lo <b>operativo</b> a lo <b>fiscal</b>, por banco: <b>Caja</b> (lo que la tienda depositó) → <b>Workbook</b> (estado de cuenta real) → <b>Kepler</b> (tesorería del ERP) → <b>ContPAQi</b> (libros/fiscal). El brinco de los extremos <b>Caja↔ContPAQi</b> = el gap operativo-vs-declarado (ContPAQi está consolidado, cuadra a nivel banco, no por tienda). Los universos <b>no son idénticos</b> —banco/Kepler/libros reciben también cobranza y transferencias de cliente— así que los <b>deltas son informativos</b>. Cuadre por totales ±{{ money(d.cuadre_eps) }}. @if (!d.totals.wb_disponible) { <b>Sin workbook en el periodo.</b> } @if (!d.totals.kep_disponible) { <b>Sin feed Kepler.</b> } @if (!d.totals.cpq_disponible) { <b>Sin libros ContPAQi.</b> }</p>
          @if (cdet(); as cd) {
            <h3 class="cg-h3">Ingresos a nivel movimiento — depósito de Caja ↔ ingreso del banco</h3>
            <app-metric-strip [items]="cdetKpis(cd)" ariaLabel="Conciliación de ingresos por movimiento" />
            @if (cd.caja_only.length) {
              <p class="cg-note" style="margin:.4rem 0 .3rem"><b>Depósitos de Caja sin ingreso en el banco</b> (posible fuga o rezago) — lo accionable:</p>
              <p-table [value]="cd.caja_only" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="40vh" [paginator]="cd.caja_only.length>100" [rows]="100">
                <ng-template #header><tr><th class="cg-w-date">Fecha</th><th>Banco</th><th class="cg-w-suc">Suc</th><th class="ta-r">Monto</th></tr></ng-template>
                <ng-template #body let-r>
                  <tr>
                    <td class="cg-mono">{{ dmy(r.fecha) }}</td>
                    <td>{{ r.banco || '—' }}</td>
                    <td class="cg-mono muted">{{ r.almacen || '—' }}</td>
                    <td class="ta-r num strong warn">{{ money(r.monto) }}</td>
                  </tr>
                </ng-template>
              </p-table>
            } @else { <p class="cg-note" style="margin-top:.4rem">✓ Todos los depósitos de Caja del periodo aparecen en el banco.</p> }
          }
        }
      }

      <!-- ===== ENLACE DE CUENTAS ===== -->
      @if (view()==='enlace') {
        @if (loading() && !xw()) { <div class="fb-skeleton" aria-busy="true">@for (i of skel; track i) { <div class="fb-skel-row"></div> }</div> }
        @else if (xw(); as rows) {
          <p class="cg-note" style="margin:.2rem 0 .8rem">Mapea cada <b>cuenta interna de Caja</b> a su <b>cuenta de banco real</b> (account_label, la llave que comparten Bancos y Kepler). La sugerencia se deriva <b>vía Kepler</b> (match de depósitos por monto+fecha, mismo banco) — es dispersa, por eso se <b>confirma a mano</b>. Confirmar habilita la conciliación exacta por cuenta (en vez de por nombre de banco).</p>
          <p-table [value]="rows" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="58vh">
            <ng-template #header><tr><th>Cuenta Caja</th><th>Banco</th><th class="ta-r">Depósitos</th><th class="ta-c cg-w-d">#</th><th>Sugerencia (Kepler)</th><th class="cg-w-sel">Cuenta banco</th><th class="cg-w-e"></th></tr></ng-template>
            <ng-template #body let-r>
              <tr>
                <td class="cg-mono">{{ r.banco_name || '—' }} <span class="muted">#{{ r.banco_code }}</span></td>
                <td class="muted">{{ r.canon_bank }}</td>
                <td class="ta-r num strong">{{ money(r.monto) }}</td>
                <td class="ta-c muted">{{ r.deposits }}</td>
                <td>
                  @if (r.suggested_label) {
                    <span class="cg-mono">{{ r.suggested_label }}</span>
                    @if (r.suggested_reason === 'unica_cuenta') {
                      <p-tag value="única cuenta" severity="info" styleClass="cg-tag" />
                    } @else {
                      <p-tag [value]="r.suggested_matches + ' match'" [severity]="r.suggested_matches>=5?'success':'warn'" styleClass="cg-tag" />
                    }
                    @for (a of r.alternatives; track a.label) { <span class="cg-alt">{{ a.label }}·{{ a.n }}</span> }
                  } @else { <span class="muted">sin sugerencia</span> }
                </td>
                <td>
                  <p-select [options]="r.cb_options" [ngModel]="pick()[r.banco_code]" (onChange)="setPick(r.banco_code, $event.value)" placeholder="—" [showClear]="true" styleClass="cg-sel" [ariaLabel]="'Cuenta banco para ' + r.banco_name" />
                </td>
                <td>
                  <button pButton type="button" class="p-button-sm p-button-outlined" (click)="saveXw(r)" [disabled]="(pick()[r.banco_code]||'') === (r.current_label||'')" title="Guardar enlace"><span class="pi pi-check" aria-hidden="true"></span></button>
                  @if (r.confirmed_by) { <span class="cg-ok" [title]="'Confirmado por ' + r.confirmed_by"><i class="pi pi-lock" aria-hidden="true"></i></span> }
                </td>
              </tr>
            </ng-template>
            <ng-template #emptymessage><tr><td colspan="7"><div class="cg-empty"><i class="pi pi-inbox" aria-hidden="true"></i><span>Sin cuentas de Caja con depósitos.</span></div></td></tr></ng-template>
          </p-table>
        }
      }
    </div>

    <!-- Detalle del día — misma ventana y mismo formato que el drill del Cuadre de Bancos:
         lead → tira de conteos → filtros → una fila por movimiento del Control con una
         columna por fuente → huérfanos abajo. -->
    <p-dialog [visible]="dayOpen()" (visibleChange)="dayOpen.set($event)" [modal]="true" [dismissableMask]="true"
              [style]="{ width: '64rem', maxWidth: '96vw' }" [draggable]="false" [header]="dayTitle()">
      @if (wbDayLoad()[dayKey()]) { <div class="cg-empty"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i><span>Casando movimientos del día…</span></div> }
      @else if (wbDayErr()[dayKey()]?.dia; as e) { <div class="cg-empty"><i class="pi pi-exclamation-triangle bad" aria-hidden="true"></i><span>{{ e }}</span></div> }
      @else if (wbDayDia()[dayKey()]; as cd) {
        <p class="dlg-lead">Cada movimiento del <b>Control</b> (caja real) marca si <b>Workbook</b> (copia manual)
          y <b>Kepler</b> (ERP) lo tienen, casando por importe ±$1 dentro de su dirección. Abajo, lo que esas
          fuentes registran y el Control no movió (huérfanos).</p>

        <div class="tw-drill-kpis">
          <span><b>{{ cd.totals.control_n }}</b> movs Control</span>
          <span class="ok"><b>{{ cd.totals.en_manual }}</b> en Workbook</span>
          <span class="ok"><b>{{ cd.totals.en_kepler }}</b> en Kepler</span>
          @if (cd.totals.manual_only_n) { <span class="warn"><b>{{ cd.totals.manual_only_n }}</b> solo Workbook ({{ money(cd.totals.manual_only_monto) }})</span> }
          @if (cd.totals.kepler_only_n) { <span class="warn"><b>{{ cd.totals.kepler_only_n }}</b> solo Kepler ({{ money(cd.totals.kepler_only_monto) }})</span> }
        </div>

        <div class="tw-drill-filters">
          <div class="tw-fg" role="group" aria-label="Dirección">
            <button type="button" [class.on]="dfDir()===''" (click)="dfDir.set('')">Todos</button>
            <button type="button" [class.on]="dfDir()==='in'" (click)="dfDir.set('in')">Ingresos</button>
            <button type="button" [class.on]="dfDir()==='out'" (click)="dfDir.set('out')">Gastos</button>
          </div>
          <div class="tw-fg" role="group" aria-label="Estado">
            <button type="button" [class.on]="dfEstado()===''" (click)="dfEstado.set('')">Todos</button>
            <button type="button" [class.on]="dfEstado()==='casado'" (click)="dfEstado.set('casado')">En las 3</button>
            <button type="button" [class.on]="dfEstado()==='descuadre'" (click)="dfEstado.set('descuadre')">Falta en alguna</button>
          </div>
          <input type="text" class="tw-fsearch" [ngModel]="dfSearch()" (ngModelChange)="dfSearch.set($event)" placeholder="Buscar concepto / monto…" aria-label="Buscar" />
          <span class="muted tw-fcount">{{ dayRows(cd).length }} de {{ cd.rows.length }}</span>
          <button type="button" class="tw-xls" [disabled]="exporting()" (click)="exportDay(cd)"
                  title="Descarga lo que estás viendo: con los filtros y el orden puestos">
            <i class="pi" [class.pi-file-excel]="!exporting()" [class.pi-spin]="exporting()" [class.pi-spinner]="exporting()" aria-hidden="true"></i> Excel
          </button>
        </div>

        <div class="tw-wrap">
          <table class="tw-tbl tw-drill-tbl">
            <thead><tr>
              @for (c of DAY_COLS; track c.field) {
                <th [class]="c.cls" [attr.aria-sort]="ariaSort(daySort(), c.field)">
                  <button type="button" class="tw-sort" (click)="sortDay(c.field)" [attr.aria-label]="'Ordenar por ' + c.label">
                    {{ c.label }}<i [class]="sortIcon(daySort(), c.field)" aria-hidden="true"></i>
                  </button>
                </th>
              }
            </tr></thead>
            <tbody>
              @for (e of dayRows(cd); track e.id + e.dir) {
                <tr>
                  <td class="cg-mono muted">{{ dmy(e.fecha) }}</td>
                  <td class="ta-c"><i [class]="e.dir === 'in' ? 'pi pi-arrow-down-left tw-in-ico' : 'pi pi-arrow-up-right tw-out-ico'" [attr.title]="e.dir === 'in' ? 'Ingreso' : 'Gasto'"></i></td>
                  <td class="ta-r num">{{ money(e.importe) }}</td>
                  <td class="ta-r num">@if (e.manual) { <span [title]="e.manual_ref || ''" [class.tw-cent]="e.manual_importe !== e.importe">{{ money(e.manual_importe) }}</span> } @else { <i class="pi pi-minus tw-faint" title="No está en el Workbook"></i> }</td>
                  <td class="ta-r num tw-kep">@if (e.kepler) { <span [title]="e.kepler_ref || ''" [class.tw-cent]="e.kepler_importe !== e.importe">{{ money(e.kepler_importe) }}</span> } @else { <i class="pi pi-minus tw-faint" title="No está en Kepler"></i> }</td>
                  <td class="tw-concept" [title]="(e.extra || '') + ' ' + (e.concepto || '')">{{ e.concepto || e.extra || '—' }}</td>
                </tr>
              }
              @if (!dayRows(cd).length) { <tr><td colspan="6" class="ta-c muted tw-empty">Sin movimientos con estos filtros.</td></tr> }
            </tbody>
          </table>
        </div>

        @if (dayOrphans(cd); as orp) {
          @if (orp.manual.length || orp.kepler.length) {
            <div class="tw-orphans">
              @if (orp.manual.length) {
                <div class="tw-orphan">
                  <h4><i class="pi pi-file-excel"></i> En Workbook, sin Control ({{ orp.manual.length }})</h4>
                  <table class="tw-tbl"><tbody>
                    @for (m of orp.manual; track m.id) {
                      <tr><td class="ta-r num">{{ money(m.importe) }}</td><td class="tw-concept" [title]="(m.extra || '') + ' ' + (m.concepto || '')">{{ m.concepto || m.extra || '—' }}</td></tr>
                    }
                  </tbody></table>
                </div>
              }
              @if (orp.kepler.length) {
                <div class="tw-orphan">
                  <h4><i class="pi pi-database"></i> En Kepler, sin Control ({{ orp.kepler.length }})</h4>
                  <table class="tw-tbl"><tbody>
                    @for (m of orp.kepler; track m.id) {
                      <tr><td class="ta-r num">{{ money(m.importe) }}</td><td class="tw-concept" [title]="(m.extra || '') + ' ' + (m.concepto || '')">{{ m.concepto || m.extra || '—' }}</td></tr>
                    }
                  </tbody></table>
                </div>
              }
            </div>
          }
        }
      }
    </p-dialog>

  `,
  styles: [FINANZAS_SHARED_STYLES, `
    /* El desglose de un día que falla lo DICE. Antes el catch guardaba [] y se leía
       igual que un día sin movimientos: un 404 del API, un 403 o el 22007 por una
       fecha mal formada eran indistinguibles de "no hubo nada". */

    :host { display:block; }
    .surf-page-head { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap; }
    .cg-head-actions { display:flex; gap:.5rem; align-items:center; }
    :host ::ng-deep .cg-sel { min-width:8.5rem; }
    .fb-viewseg button.legacy { color: var(--text-faint); }
    .cg-hist { margin-left:.35rem; font-size:.58rem; text-transform:uppercase; letter-spacing:.04em; color:var(--text-faint); border:1px solid var(--border-color); border-radius:var(--r-sm); padding:0 .28rem; vertical-align:middle; }
    .cg-legacy-note { display:flex; align-items:center; gap:.55rem; padding:.55rem .8rem; margin:.1rem 0 .7rem; border:1px solid var(--border-color); border-left:3px solid var(--warn-fg); border-radius:var(--r-md); background:var(--card-bg); font-size:.78rem; color:var(--text-muted); line-height:1.45; }
    .cg-legacy-note .pi { color:var(--warn-fg); }
    .cg-legacy-note b { color:var(--text-main); }
    app-metric-strip { display:block; margin:.6rem 0; }
    .cg-filters { display:flex; flex-wrap:wrap; gap:.6rem; align-items:center; margin:.4rem 0 .6rem; }
    .cg-search input { min-width:200px; }
    .cg-tenders { border:1px solid var(--border-color); border-radius:var(--r-md); padding:.6rem .8rem; margin:.4rem 0 .8rem; }
    .cg-mini { width:100%; border-collapse:collapse; font-size:.8rem; margin-top:.4rem; }
    .cg-mini th, .cg-mini td { padding:.28rem .5rem; border-bottom:1px solid var(--border-color); white-space:nowrap; }
    .cg-mini th { color:var(--text-muted); font-weight:600; text-align:left; }
    .cg-bd { border:1px solid var(--border-color); border-radius:var(--r-md); padding:.55rem .7rem; margin:.4rem 0 .7rem; max-width:520px; }
    .cg-bd-title { font-size:.72rem; text-transform:uppercase; letter-spacing:.03em; color:var(--text-muted); }
    .cg-bd-row { display:flex; align-items:baseline; gap:.6rem; font-size:.8rem; padding:.15rem 0; }
    .cg-bd-k { flex:1; } .cg-bd-v { font-family:var(--font-mono); font-variant-numeric:tabular-nums; }
    .cg-bd-n { color:var(--text-faint); font-size:.72rem; min-width:2.5rem; text-align:right; }
    .cg-two { margin:.4rem 0 .8rem; } .cg-bd-wide { max-width:none; padding:.4rem .5rem; }
    code { font-family:var(--font-mono); font-size:.9em; }
    .cg-w-x { width:2.2rem; }
    .cg-row-click { cursor:pointer; } .cg-row-click:hover { background:var(--hover-bg); }
    .cg-row-open { background:color-mix(in srgb, var(--action) 5%, transparent); }
    .cg-chev { font-size:.7rem; color:var(--text-faint); }
    .cg-eg { color:var(--warn-fg); } .cg-in { color:var(--ok-fg); }
    .cg-detail-row > td { background:var(--surface-ground, var(--card-bg)); padding:.6rem .9rem !important; }
    .cg-detail { display:flex; flex-direction:column; gap:.4rem; font-size:.78rem; }
    .cg-detail-meta { display:flex; flex-wrap:wrap; gap:.9rem; align-items:baseline; color:var(--text-muted); }
    .cg-detail-meta b { color:var(--text-main); }
    .cg-detail-amt { margin-left:auto; font-family:var(--font-mono); font-weight:700; font-size:.95rem; }
    .cg-denom { display:flex; flex-wrap:wrap; gap:.5rem; align-items:baseline; }
    .cg-denom-t { font-size:.72rem; text-transform:uppercase; letter-spacing:.03em; color:var(--text-faint); }
    .cg-denom-c { font-family:var(--font-mono); font-size:.76rem; padding:1px .4rem; border:1px solid var(--border-color); border-radius:var(--r-sm); }
    .cg-detail-obs { font-style:italic; color:var(--text-muted); }
    .cg-origen { border:1px solid var(--border-color); border-radius:var(--r-md); padding:.6rem .8rem; margin:.4rem 0 .9rem; }
    .cg-origen-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(11rem,1fr)); gap:.6rem; margin-top:.5rem; }
    .cg-ocell { display:flex; flex-direction:column; gap:1px; padding:.5rem .6rem; border:1px solid var(--border-color); border-radius:var(--r-md); }
    .cg-ocell-pos { border-style:dashed; background:color-mix(in srgb, var(--action) 4%, transparent); }
    .cg-ol { font-size:var(--fs-xs); color:var(--text-muted); text-transform:uppercase; letter-spacing:.03em; }
    .cg-ov { font-size:var(--fs-lg, 1.05rem); font-weight:700; font-family:var(--font-mono); font-variant-numeric:tabular-nums; }
    .cg-os { font-size:var(--fs-xs); color:var(--text-faint); }
    .cg-wbcmp { display:grid; grid-template-columns:repeat(auto-fit, minmax(20rem,1fr)); gap:.8rem; }
    .cg-wbside-t { font-size:.72rem; text-transform:uppercase; letter-spacing:.03em; color:var(--text-muted); margin-bottom:.3rem; }
    .ta-r { text-align:right; } .ta-c { text-align:center; }
    .num, .cg-mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .strong { font-weight:700; }
    /* Alineado con Bancos (BANCOS_STYLES): antes era --text-faint y el mismo organismo se
       veia mas apagado en Caja que en Bancos. */
    .muted { color:var(--text-muted); }
    .warn { color:var(--warn-fg); font-weight:700; }
    /* Semanticos de celda, mismos que Bancos: color sin peso extra. */
    .ok { color:var(--ok-fg); }
    .bad { color:var(--bad-fg); }
    .cg-emp { max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .cg-cancel { opacity:.5; text-decoration:line-through; }
    .cg-w-d { width:3.5rem; } .cg-w-p { width:4rem; } .cg-w-u { width:5rem; } .cg-w-date { width:6rem; } .cg-w-suc { width:3.4rem; }
    .cg-w-met { width:7rem; } .cg-w-com { width:6rem; } .cg-w-fol { width:6rem; } .cg-w-e { width:6rem; } .cg-w-sel { width:10rem; }
    .cg-h3 { font-size:.9rem; font-weight:700; margin:1.2rem 0 .5rem; }
    .cg-alt { font-family:var(--font-mono); font-size:.68rem; color:var(--text-faint); margin-left:.4rem; }
    .cg-ok { color:var(--ok-fg); margin-left:.4rem; }
    :host ::ng-deep .cg-tag { font-size:.64rem; }
    .cg-note { margin-top:.6rem; font-size:.74rem; color:var(--text-faint); line-height:1.5; }
    .cg-errbox { display:flex; align-items:center; gap:.6rem; padding:.7rem .85rem; margin:.2rem 0 .6rem; border:1px solid var(--border-color); border-left:3px solid var(--bad-fg); border-radius:var(--r-md); background:var(--card-bg); }
    .cg-errbox .pi { color:var(--bad-fg); } .cg-errbox-txt { flex:1; font-size:.84rem; }
    /* Mismos valores que .surf-empty de Bancos, para que el estado vacio se lea igual. */
    .cg-empty { display:flex; flex-direction:column; align-items:center; gap:var(--sp-2); padding:var(--sp-8); text-align:center; color:var(--text-muted); }
    .cg-empty .pi { font-size:1.5rem; }
  `],
})
export class FinanzasCajaComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly bancosSock = inject(BancosSocketService);
  private readonly base = `${environment.apiUrl}/finance/caja`;

  // `legacy` = lee el Base Movimientos de Finanzas (caja_ventas_diarias / caja_depositos),
  // que dejó de alimentarse (ventas 08/abr-2026, depósitos ene-2026). Datos completos solo
  // ≤ ene-2026 → banner honesto + badge. La caja VIVA es General/Cuadre (Doctos). Arqueos vivo.
  readonly VIEWS: { key: View; label: string; icon: string; legacy?: boolean }[] = [
    { key: 'general', label: 'General', icon: 'pi-wallet' },
    { key: 'cuadre', label: 'Cuadre', icon: 'pi-check-square' },
    { key: 'arqueos', label: 'Arqueos', icon: 'pi-calculator' },
    { key: 'resumen', label: 'Resumen', icon: 'pi-chart-bar', legacy: true },
    { key: 'depositos', label: 'Depósitos', icon: 'pi-building-columns', legacy: true },
    { key: 'conciliacion', label: 'Conciliación', icon: 'pi-sync', legacy: true },
    { key: 'enlace', label: 'Enlace de cuentas', icon: 'pi-link', legacy: true },
  ];
  private readonly LEGACY = new Set<View>(['resumen', 'depositos', 'conciliacion', 'enlace']);
  readonly isLegacy = computed(() => this.LEGACY.has(this.view()));
  readonly tipoOpts = ['Arqueo', 'Retiro', 'Corte', 'Deposito', 'Fondo Caja'];
  readonly skel = Array.from({ length: 8 });

  readonly view = signal<View>('general');
  readonly cgTipo = signal<string | null>(null);
  readonly cg = signal<CajaGeneral | null>(null);
  readonly cq = signal<CajaCuadre | null>(null);
  readonly wbc = signal<CajaWb | null>(null);
  readonly wbDayDia = signal<Record<string, ConcDia>>({});
  readonly wbDayLoad = signal<Record<string, boolean>>({});
  /**
   * Error del desglose de un día, por lado.
   *
   * Antes los dos `catch` guardaban `[]` y la pantalla decía "Sin movimientos":
   * un 404, un 403 o un 500 se veían EXACTAMENTE igual que un día sin nada. Con
   * `workbook-movimientos` recién agregado, un API atrasado respecto de HEAD
   * devuelve 404 y el desglose quedaba mudo, sin forma de saber por qué.
   */
  readonly wbDayErr = signal<Record<string, { dia?: string }>>({});
  readonly cqExp = signal<Record<string, boolean>>({});
  readonly cqDayMovs = signal<Record<string, CajaGeneral['movimientos']>>({});
  readonly cqDayLoad = signal<Record<string, boolean>>({});
  /** Mismo caso que `wbDayErr`: el catch de Cuadre tampoco decía nada. */
  readonly cqDayErr = signal<Record<string, string>>({});
  readonly expanded = signal<Record<string, boolean>>({});
  readonly DENOM_LABEL: Record<string, string> = { B1000: '$1000', B500: '$500', B200: '$200', B100: '$100', B50: '$50', B20: '$20', M20: '$20m', M10: '$10', M5: '$5', M2: '$2', M1: '$1', M05: '50¢', M02: '20¢', M01: '10¢', Mor: 'morralla' };
  readonly f = signal<Facets>({ meses: [], bancos: [], empresas: [], cajas: [] });
  readonly month = signal<string | null>(null);
  readonly banco = signal<string | null>(null);
  readonly tipo = signal<string | null>(null);
  readonly caja = signal<string | null>(null);
  readonly search = signal('');
  readonly loading = signal(false);
  readonly err = signal<string | null>(null);
  readonly ov = signal<Overview | null>(null);
  readonly suc = signal<SucursalRow[] | null>(null);
  readonly dep = signal<DepResp | null>(null);
  readonly arq = signal<ArqResp | null>(null);
  readonly conc = signal<Conc | null>(null);
  readonly cdet = signal<CDet | null>(null);
  readonly xw = signal<XwRow[] | null>(null);
  readonly pick = signal<Record<string, string>>({});
  private searchTimer: any;

  ngOnInit(): void {
    // Al actualizar el LIBRO en Bancos (sheet-sync o upload) se reescribe también el
    // Workbook de CAJA GENERAL (kind='cash'); nos enganchamos al mismo WS para refrescar
    // el Cuadre en vivo sin recargar. El feed Control (.mdb/Doctos) va aparte (on-prem).
    this.bancosSock.connect();
    this.destroyRef.onDestroy(() => this.bancosSock.disconnect());
    this.bancosSock.change$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((e) => {
      if (e.action === 'sheet_synced' || e.action === 'imported') this.reload();
    });
    this.http.get<Facets>(`${this.base}/facets`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (f) => { this.f.set(f); if (f.meses?.length) this.month.set(f.meses[0]); this.reload(); },
      error: () => { this.err.set('No se pudieron cargar los filtros.'); this.reload(); },
    });
  }

  setView(v: View): void { if (v === this.view()) return; this.view.set(v); this.reload(); }
  onMonth(v: string | null): void { this.month.set(v); this.cg.set(null); this.cq.set(null); this.wbc.set(null); this.wbDayDia.set({}); this.wbDayErr.set({}); this.cqExp.set({}); this.cqDayMovs.set({}); this.cqDayErr.set({}); this.ov.set(null); this.suc.set(null); this.dep.set(null); this.arq.set(null); this.conc.set(null); this.reload(); }
  onFilter(which: 'banco' | 'tipo' | 'caja', v: string | null): void { ({ banco: this.banco, tipo: this.tipo, caja: this.caja })[which].set(v); this.reload(); }
  onCgTipo(v: string | null): void { this.cgTipo.set(v); this.expanded.set({}); this.reload(); }
  toggleRow(r: { uid: string }): void { const e = { ...this.expanded() }; if (e[r.uid]) { delete e[r.uid]; } else { e[r.uid] = true; } this.expanded.set(e); }
  isExp(r: { uid: string }): boolean { return !!this.expanded()[r.uid]; }
  denomList(denom: Record<string, number> | null): { k: string; label: string; n: number }[] {
    if (!denom) return [];
    return Object.keys(this.DENOM_LABEL).filter((k) => Number(denom[k]) > 0).map((k) => ({ k, label: this.DENOM_LABEL[k], n: Number(denom[k]) }));
  }
  onSearch(v: string): void { this.search.set(v); if (this.searchTimer) clearTimeout(this.searchTimer); this.searchTimer = setTimeout(() => this.reload(), 320); }
  clearDep(): void { this.banco.set(null); this.search.set(''); this.reload(); }

  private qs(extra: Record<string, string | null> = {}): string {
    const p = new URLSearchParams();
    if (this.month()) p.set('month', this.month()!);
    for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : '';
  }

  reload(): void {
    this.loading.set(true); this.err.set(null);
    const done = () => this.loading.set(false);
    const fail = () => { this.loading.set(false); this.err.set('No se pudo cargar la caja.'); };
    const v = this.view();
    if (v === 'general') {
      this.http.get<CajaGeneral>(`${this.base}/general${this.qs({ tipo: this.cgTipo(), search: this.search().trim() || null })}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (d) => { this.cg.set(d); done(); }, error: fail });
    } else if (v === 'cuadre') {
      // Cuadre = conciliación 3 fuentes (.mdb operativo vs Manual vs Kepler), espejo de Bancos.
      this.http.get<CajaWb>(`${this.base}/conciliacion-workbook${this.qs()}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (d) => { this.wbc.set(d); done(); }, error: fail });
    } else if (v === 'resumen') {
      this.http.get<Overview>(`${this.base}/overview${this.qs()}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (d) => { this.ov.set(d); done(); }, error: fail });
      this.http.get<SucursalRow[]>(`${this.base}/por-sucursal${this.qs()}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (d) => this.suc.set(d), error: () => this.suc.set([]) });
    } else if (v === 'depositos') {
      this.http.get<DepResp>(`${this.base}/depositos${this.qs({ banco: this.banco(), search: this.search().trim() || null })}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (d) => { this.dep.set(d); done(); }, error: fail });
    } else if (v === 'arqueos') {
      this.http.get<ArqResp>(`${this.base}/arqueos${this.qs({ tipo: this.tipo(), almacen: this.caja() })}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (d) => { this.arq.set(d); done(); }, error: fail });
    } else if (v === 'conciliacion') {
      this.http.get<Conc>(`${this.base}/conciliacion${this.qs()}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (d) => { this.conc.set(d); done(); }, error: fail });
      this.http.get<CDet>(`${this.base}/conciliacion-detalle${this.qs()}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (d) => this.cdet.set(d), error: () => this.cdet.set(null) });
    } else {
      this.http.get<XwRow[]>(`${this.base}/crosswalk`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (d) => { this.xw.set(d); const p: Record<string, string> = {}; d.forEach((r) => { p[r.banco_code] = r.current_label || r.suggested_label || ''; }); this.pick.set(p); done(); }, error: fail });
    }
  }

  saveXw(r: XwRow): void {
    const label = this.pick()[r.banco_code] || null;
    const matches = label && label === r.suggested_label ? r.suggested_matches : 0;
    this.http.post(`${this.base}/crosswalk`, { banco_code: r.banco_code, account_label: label, matches }).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: () => this.reload(), error: () => this.err.set('No se pudo guardar el enlace.') });
  }
  setPick(code: string, label: string): void { this.pick.set({ ...this.pick(), [code]: label }); }

  cqKpis(d: CajaCuadre): MetricStripItem[] {
    return [
      { label: 'Ingresos', value: d.totals.ingreso, format: 'currency-short', tone: 'ok', sub: `${d.totals.dias} días` },
      { label: 'Gastos', value: d.totals.gasto, format: 'currency-short', tone: 'default', sub: `${Math.round(d.totals.remisiones_gastos / 1000).toLocaleString('es-MX')}k remis/gastos` },
      { label: 'Depósito banco', value: d.totals.deposito, format: 'currency-short', tone: 'default' },
      { label: 'Neto (quedó/faltó)', value: d.totals.neto, format: 'currency-short', tone: d.totals.cuadra ? 'ok' : 'warn' },
    ];
  }
  readonly money = money;
  readonly dmy = dmy;
  abs(n: number): number { return Math.abs(n || 0); }

  /**
   * Tolerancia del CONTROL-TOTAL: la manda el servidor (`eps_total`). Antes el título imprimía
   * `eps` (la del día, ±$1) mientras las celdas comparaban contra un 1 hardcodeado: un mes
   * entero salía "no cuadra" por el redondeo acumulado de 30 días aunque cada día cuadrara.
   */
  cuadT(delta: number, d: CajaWb): boolean { return Math.abs(delta || 0) < (d.eps_total ?? 1000); }

  /**
   * Las dos filas del control-total, armadas acá y no duplicadas en el template.
   *
   * `cuadra` mira TODAS las fuentes disponibles, no sólo el Workbook: antes una fila con
   * Kepler desviado salía con palomita verde porque el semáforo era de 2 vías en una tabla
   * de 3 — el mismo defecto que ya se corrigió en el "Por cuenta" de Bancos.
   */
  ctRows(d: CajaWb) {
    const t = d.totals, wb = t.wb_disponible, kep = t.kep_disponible;
    const mk = (label: string, dir: 'in' | 'out', control: number, workbook: number, kepler: number,
                d_cw: number, d_ck: number) => ({
      label, dir, control, workbook, kepler, wb_ok: wb, kep_ok: kep,
      d_cw, d_ck, d_wk: Math.round((workbook - kepler) * 100) / 100,
      cuadra: (!wb || this.cuadT(d_cw, d)) && (!kep || this.cuadT(d_ck, d)),
    });
    return [
      mk('Ingresos', 'in', t.mdb_ingreso, t.wb_ingreso, t.kp_ingreso, t.delta_ingreso, t.delta_kep_ingreso),
      mk('Gastos', 'out', t.mdb_gasto, t.wb_gasto, t.kp_gasto, t.delta_gasto, t.delta_kep_gasto),
    ];
  }

  /**
   * Lectura del cuadre en una línea. Mismo rol que `verdict()` del Cuadre de Bancos: la
   * conclusión va arriba y con nombre propio, no un semáforo que hay que interpretar.
   */
  verdict(d: { totals: { dias_descuadre: number; dias_wb: number } }): string {
    const { dias_descuadre: mal, dias_wb: total } = d.totals;
    if (!mal) return `El workbook empata con el Control en los ${total} días capturados.`;
    return `${mal} de ${total} días capturados no empatan entre el workbook y el Control.`;
  }
  wbKpis(d: CajaWb): MetricStripItem[] {
    return [
      { label: '.mdb (operativo)', value: d.totals.mdb_ingreso, format: 'currency-short', tone: 'default', sub: `ingreso · ${d.totals.dias} días` },
      { label: 'Manual (workbook)', value: d.totals.wb_ingreso, format: 'currency-short', tone: 'default', sub: `ingreso · ${d.totals.dias_wb} días` },
      { label: 'Kepler (ERP)', value: d.totals.kp_ingreso, format: 'currency-short', tone: 'default', sub: d.totals.kep_disponible ? 'ingreso · tesorería' : 'sin feed' },
      { label: 'Δ Ingreso', value: d.totals.delta_ingreso, format: 'currency-short', tone: Math.abs(d.totals.delta_ingreso) > 1000 ? 'warn' : 'ok', sub: 'mdb–manual' },
      { label: 'Δ Gasto', value: d.totals.delta_gasto, format: 'currency-short', tone: Math.abs(d.totals.delta_gasto) > 1000 ? 'warn' : 'ok', sub: 'mdb–manual' },
    ];
  }
  key(r: { fecha: string }): string { return String(r.fecha).slice(0, 10); }
  /**
   * Traduce un fallo HTTP a algo accionable. El 404 se nombra aparte porque es el
   * caso real más probable acá: el endpoint del desglose es nuevo y un API que
   * quedó atrás de HEAD lo devuelve así.
   */
  private httpMsg(e: { status?: number }, ruta: string): string {
    if (e?.status === 404) return `El API no tiene ${ruta} (404) — quedó atrás del código. Hace falta redesplegarlo.`;
    if (e?.status === 403) return `Sin permiso para ${ruta} (403).`;
    if (e?.status === 0) return `Sin conexión con el API al pedir ${ruta}.`;
    return `Falló ${ruta}${e?.status ? ` (${e.status})` : ''}.`;
  }
  netoState(r: { ingreso: number; neto: number }): 'sobra' | 'falta' | 'cuadra' {
    const tol = Math.max((r.ingreso || 0) * 0.05, 1000);
    if (r.neto > tol) return 'sobra';
    if (r.neto < -tol) return 'falta';
    return 'cuadra';
  }
  cqIsExp(r: { fecha: string }): boolean { return !!this.cqExp()[r.fecha]; }
  /** Espejo del drill de Bancos: casa .mdb ↔ Manual y .mdb ↔ Kepler → huérfanos por día. */
  pairings(cd: ConcDia): { key: string; title: string; short: string; sides: { key: string; name: string; data: ReconSide }[] }[] {
    return [
      { key: 'manual', title: 'Workbook', short: 'workbook', sides: [
        { key: 'ing', name: 'Ingresos', data: cd.vs_manual.ingresos },
        { key: 'gas', name: 'Gastos', data: cd.vs_manual.gastos } ] },
      { key: 'kepler', title: 'Kepler (ERP)', short: 'Kepler', sides: [
        { key: 'ing', name: 'Ingresos', data: cd.vs_kepler.ingresos },
        { key: 'gas', name: 'Gastos', data: cd.vs_kepler.gastos } ] },
    ];
  }
  /** Desglose de un día: corre el match server-side (.mdb↔Manual y .mdb↔Kepler). */
  // ── Detalle del día: filtros, orden y export (mismo contrato que el drill de Bancos) ──
  readonly dfDir = signal<'' | 'in' | 'out'>('');
  readonly dfEstado = signal<'' | 'casado' | 'descuadre'>('');
  readonly dfSearch = signal('');
  readonly daySort = signal<SortState | null>(null);
  readonly sortIcon = sortIcon;
  readonly ariaSort = ariaSort;
  sortDay(field: string): void { this.daySort.set(toggleSort(this.daySort(), field)); }

  /** Columnas del detalle: etiqueta + campo por el que ordena. */
  readonly DAY_COLS = [
    { field: 'fecha',          label: 'Fecha',    cls: '' },
    { field: 'dir',            label: 'Dir',      cls: 'ta-c' },
    { field: 'importe',        label: 'Control',  cls: 'ta-r' },
    { field: 'manual_importe', label: 'Workbook', cls: 'ta-r' },
    { field: 'kepler_importe', label: 'Kepler',   cls: 'ta-r' },
    { field: 'concepto',       label: 'Concepto', cls: '' },
  ];

  /** Filas visibles: filtros + orden. Sin orden elegido manda el del backend (fecha, monto). */
  dayRows(cd: ConcDia): DiaRow[] {
    const dir = this.dfDir(), est = this.dfEstado(), q = this.dfSearch().trim().toLowerCase();
    const filtered = cd.rows.filter((e) => {
      if (dir && e.dir !== dir) return false;
      if (est === 'casado' && !(e.manual && e.kepler)) return false;
      if (est === 'descuadre' && e.manual && e.kepler) return false;
      if (q && !`${e.concepto || ''} ${e.extra || ''} ${e.importe}`.toLowerCase().includes(q)) return false;
      return true;
    });
    return sortRows(filtered, this.daySort(), (r, f) => (r as unknown as Record<string, unknown>)[f]);
  }

  /**
   * Huérfanos de cada fuente, juntando ingresos y gastos. El backend los devuelve partidos por
   * dirección porque el casado corre por dirección; para leerlos da igual de qué lado vinieron.
   */
  dayOrphans(cd: ConcDia): { manual: OrphanMov[]; kepler: OrphanMov[] } {
    const join = (v: { ingresos: ReconSide; gastos: ReconSide }) =>
      [...v.ingresos.other_only, ...v.gastos.other_only].sort((a, b) => b.importe - a.importe);
    return { manual: join(cd.vs_manual), kepler: join(cd.vs_kepler) };
  }

  // Se exporta LO QUE SE VE: dayRows() ya trae filtros y orden. Los importes van como número
  // con formato de moneda, no como texto: en Excel se suman.
  readonly exporting = signal(false);

  async exportDay(cd: ConcDia): Promise<void> {
    this.exporting.set(true);
    try {
      const f: string[] = [];
      if (this.dfDir()) f.push(this.dfDir() === 'in' ? 'solo ingresos' : 'solo gastos');
      if (this.dfEstado()) f.push(this.dfEstado() === 'casado' ? 'solo los que estan en las 3' : 'solo los que faltan en alguna');
      if (this.dfSearch().trim()) f.push('busqueda "' + this.dfSearch().trim() + '"');
      const rows = this.dayRows(cd);
      const base = `${this.dayKey()} - ${rows.length} de ${cd.rows.length} movimientos del Control`;
      const orp = this.dayOrphans(cd);
      const sheets: XlsxSheet<any>[] = [{
        name: 'Detalle del dia',
        subtitle: f.length ? base + ' - filtros: ' + f.join(', ') : base,
        rows,
        cols: [
          { header: 'Fecha', get: (r: any) => r.fecha, type: 'date', width: 12 },
          { header: 'Direccion', get: (r: any) => (r.dir === 'in' ? 'Ingreso' : 'Gasto'), width: 11 },
          { header: 'Control', get: (r: any) => r.importe, type: 'money', total: true },
          { header: 'Workbook', get: (r: any) => r.manual_importe, type: 'money', total: true },
          { header: 'Ref Workbook', get: (r: any) => r.manual_ref, width: 20 },
          { header: 'Kepler', get: (r: any) => r.kepler_importe, type: 'money', total: true },
          { header: 'Ref Kepler', get: (r: any) => r.kepler_ref, width: 20 },
          { header: 'Concepto', get: (r: any) => r.concepto, width: 46 },
        ],
      }];
      const orphanCols = [
        { header: 'Importe', get: (r: any) => r.importe, type: 'money' as const, total: true },
        { header: 'Concepto', get: (r: any) => r.concepto, width: 46 },
        { header: 'Referencia', get: (r: any) => r.extra, width: 24 },
      ];
      if (orp.manual.length) sheets.push({ name: 'En Workbook sin Control', rows: orp.manual, cols: orphanCols });
      if (orp.kepler.length) sheets.push({ name: 'En Kepler sin Control', rows: orp.kepler, cols: orphanCols });
      await exportXlsx('Detalle del dia ' + this.dayKey(), sheets);
    } finally { this.exporting.set(false); }
  }

  /** Día abierto en la ventana de detalle (clave YYYY-MM-DD). */
  readonly dayOpen = signal(false);
  readonly dayKey = signal('');
  dayTitle(): string { return this.dayKey() ? `Detalle del día — ${this.dmy(this.dayKey())}` : 'Detalle del día'; }

  /**
   * Abre el detalle de un día. El resultado se cachea por fecha: reabrir un día ya visto no
   * vuelve a pegarle al API, y cambiar de mes limpia el cache (ver `onMonth`).
   */
  openDay(r: { fecha: string }): void {
    const dk = this.key(r);
    this.dayKey.set(dk);
    this.dfDir.set(''); this.dfEstado.set(''); this.dfSearch.set(''); this.daySort.set(null);
    this.dayOpen.set(true);
    if ((dk in this.wbDayDia()) || this.wbDayLoad()[dk]) return;
    this.wbDayLoad.set({ ...this.wbDayLoad(), [dk]: true });
    this.http.get<ConcDia>(`${this.base}/conciliacion-dia?from=${dk}&to=${dk}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.wbDayDia.set({ ...this.wbDayDia(), [dk]: d }); this.wbDayLoad.set({ ...this.wbDayLoad(), [dk]: false }); },
      error: (err) => { this.wbDayErr.set({ ...this.wbDayErr(), [dk]: { dia: this.httpMsg(err, '/caja/conciliacion-dia') } }); this.wbDayLoad.set({ ...this.wbDayLoad(), [dk]: false }); },
    });
  }

  toggleCqDay(r: { fecha: string }): void {
    const rk = r.fecha; const e = { ...this.cqExp() };
    if (e[rk]) { delete e[rk]; this.cqExp.set(e); return; }
    e[rk] = true; this.cqExp.set(e);
    const dk = this.key(r);
    if (!this.cqDayMovs()[dk] && !this.cqDayLoad()[dk]) {
      this.cqDayLoad.set({ ...this.cqDayLoad(), [dk]: true });
      this.http.get<CajaGeneral>(`${this.base}/general?from=${dk}&to=${dk}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (d) => { this.cqDayMovs.set({ ...this.cqDayMovs(), [dk]: d.movimientos }); this.cqDayLoad.set({ ...this.cqDayLoad(), [dk]: false }); },
        error: (e) => {
          this.cqDayMovs.set({ ...this.cqDayMovs(), [dk]: [] });
          this.cqDayErr.set({ ...this.cqDayErr(), [dk]: this.httpMsg(e, '/caja/general') });
          this.cqDayLoad.set({ ...this.cqDayLoad(), [dk]: false });
        },
      });
    }
  }
  cgKpis(d: CajaGeneral): MetricStripItem[] {
    return [
      { label: 'Ingresos', value: d.totals.ingreso, format: 'currency-short', tone: 'ok', sub: `${d.totals.n} movs` },
      { label: 'Gastos', value: d.totals.gasto, format: 'currency-short', tone: 'default' },
      { label: 'Neto', value: d.totals.neto, format: 'currency-short', tone: d.totals.neto >= 0 ? 'ok' : 'warn' },
      { label: 'Saldo caja', value: d.totals.saldo, format: 'currency-short', tone: 'default', sub: d.totals.saldo_fecha ? 'actual' : undefined },
    ];
  }
  ovKpis(d: Overview): MetricStripItem[] {
    return [
      { label: 'Venta', value: d.venta_total, format: 'currency-short', tone: 'default', sub: `${d.dias} días · ${d.sucursales} suc` },
      { label: 'Depositado', value: d.depositado, format: 'currency-short', tone: 'default' },
      { label: 'Descuadre', value: d.descuadre, format: 'currency-short', tone: Math.abs(d.descuadre) > 1000 ? 'warn' : 'ok' },
      { label: 'Depósitos', value: d.depositos.total_real, format: 'currency-short', tone: 'default', sub: `${d.depositos.n} · $${Math.round(d.depositos.comision).toLocaleString('es-MX')} com.` },
    ];
  }
  depKpis(d: DepResp): MetricStripItem[] {
    return [
      { label: 'Depositado (real)', value: d.totals.total_real, format: 'currency-short', tone: 'default', sub: `${d.totals.n} depósitos` },
      { label: 'Registrado', value: d.totals.total, format: 'currency-short', tone: 'default' },
      { label: 'Comisiones', value: d.totals.comision, format: 'currency-short', tone: 'default' },
    ];
  }
  concKpis(d: Conc): MetricStripItem[] {
    return [
      { label: 'Caja (operativo)', value: d.totals.caja, format: 'currency-short', tone: 'default' },
      { label: 'Workbook (banco)', value: d.totals.wb, format: 'currency-short', tone: d.totals.wb_disponible ? 'default' : ('muted' as any), sub: d.totals.wb_disponible ? undefined : 'sin cargar' },
      { label: 'Kepler', value: d.totals.kep, format: 'currency-short', tone: d.totals.kep_disponible ? 'default' : ('muted' as any), sub: d.totals.kep_disponible ? undefined : 'sin feed' },
      { label: 'ContPAQi (fiscal)', value: d.totals.cpq, format: 'currency-short', tone: d.totals.cpq_disponible ? 'default' : ('muted' as any), sub: d.totals.cpq_disponible ? undefined : 'sin libros' },
    ];
  }
  cdetKpis(d: CDet): MetricStripItem[] {
    return [
      { label: 'Caja → banco', value: d.totals.matched, format: 'currency-short', tone: 'ok', sub: `${d.totals.matched_n} · tienda` },
      { label: 'Caja sin banco', value: d.totals.caja_only, format: 'currency-short', tone: d.totals.caja_only > 0 ? 'warn' : 'ok', sub: `${d.totals.caja_only_n} · fuga/rezago` },
      { label: 'Cobranza → banco', value: d.totals.cobranza, format: 'currency-short', tone: 'default', sub: `${d.totals.cobranza_n} · cobros cliente` },
      { label: 'Residual', value: d.totals.residual, format: 'currency-short', tone: 'default', sub: `${d.totals.residual_n} · directo/financiero` },
    ];
  }
  tLabel(t: string): string { return TENDER_LABEL[t] || t; }
  tipoSev(t: string | null): 'warn' | 'info' | 'success' | 'secondary' { return t === 'Retiro' ? 'warn' : t === 'Corte' ? 'info' : t === 'Deposito' ? 'success' : 'secondary'; }
  /**
   * Fecha SIN voltear de TZ. El API serializa las columnas `date` como ISO a
   * medianoche UTC (contenedor UTC) → el pipe `| date` las mueve un día atrás en
   * el navegador MX. Extraemos la parte de fecha del string (o del Date) directo.
   */
  dmyLong(v: any): string {
    if (v instanceof Date && !isNaN(v.getTime())) return `${String(v.getDate()).padStart(2, '0')}/${String(v.getMonth() + 1).padStart(2, '0')}/${v.getFullYear()}`;
    const m = String(v ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : (v ? String(v) : '—');
  }
}
