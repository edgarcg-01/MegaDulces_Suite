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
import { SkeletonModule } from 'primeng/skeleton';
import { TagModule } from 'primeng/tag';
import { environment } from '../../../../environments/environment';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';

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
  totals: { mdb_ingreso: number; mdb_gasto: number; wb_ingreso: number; wb_gasto: number; delta_ingreso: number; delta_gasto: number; dias: number; dias_wb: number; dias_descuadre: number; wb_disponible: boolean };
  por_dia: { fecha: string; mdb_ingreso: number; mdb_gasto: number; mdb_n: number; wb_ingreso: number; wb_gasto: number; wb_n: number; delta_ingreso: number; delta_gasto: number; wb_vacio: boolean; cuadra: boolean }[];
  eps: number;
}
interface WbMov { id: string; fecha: string; concepto: string | null; sucursal: string | null; codigo: string | null; ingreso: number; gasto: number }
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
  imports: [CommonModule, FormsModule, ButtonModule, InputTextModule, IconFieldModule, InputIconModule, TableModule, SelectModule, SkeletonModule, TagModule, MetricStripComponent],
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

      <nav class="cg-views" role="tablist" aria-label="Vistas de caja">
        @for (v of VIEWS; track v.key) {
          <button role="tab" [attr.aria-selected]="view()===v.key" class="cg-view" [class.on]="view()===v.key" [class.legacy]="v.legacy" (click)="setView(v.key)"><span class="pi {{v.icon}}" aria-hidden="true"></span>&nbsp;{{ v.label }}@if (v.legacy) { <span class="cg-hist" title="Fuente histórica (Base Movimientos, ≤ ene-2026)">histórico</span> }</button>
        }
      </nav>

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
        @if (loading() && !cg()) { <div class="cg-skel">@for (i of skel; track i) { <p-skeleton height="2rem" styleClass="cg-skel-row" /> }</div> }
        @else if (cg(); as d) {
          <app-metric-strip [items]="cgKpis(d)" ariaLabel="Totales de caja general" />
          <div class="cg-two">
            <div class="cg-bd cg-bd-wide">
              <span class="cg-bd-title">Por cuenta (ingreso / gasto) — top 40</span>
              <p-table [value]="d.por_cuenta" styleClass="p-datatable-sm surf-table" [rowHover]="true" [scrollable]="true" scrollHeight="22rem" [paginator]="d.por_cuenta.length>40" [rows]="40">
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
          <p-table [value]="d.movimientos" dataKey="uid" [expandedRowKeys]="expanded()" styleClass="p-datatable-sm surf-table surf-table--sticky" [rowHover]="true" [scrollable]="true" scrollHeight="flex" [paginator]="d.movimientos.length>100" [rows]="100">
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

      <!-- ===== CUADRE (caja general: entra = sale?) ===== -->
      @if (view()==='cuadre') {
        @if (loading() && !cq()) { <div class="cg-skel">@for (i of skel; track i) { <p-skeleton height="2rem" styleClass="cg-skel-row" /> }</div> }
        @else if (cq(); as d) {
          <div class="cg-verdict" [class.ok]="d.totals.cuadra" [class.warn]="!d.totals.cuadra">
            @if (d.totals.cuadra) { <i class="pi pi-check-circle" aria-hidden="true"></i> <b>Caja cuadra</b> — entró y salió casi lo mismo (pass-through sano). }
            @else { <i class="pi pi-exclamation-triangle" aria-hidden="true"></i> <b>Descuadre {{ money(d.totals.neto) }}</b> — la diferencia entre lo que entró y lo que salió/depositó. }
          </div>
          <app-metric-strip [items]="cqKpis(d)" ariaLabel="Cuadre de caja general" />
          <p class="cg-note" style="margin:.2rem 0 .8rem">La caja general es un <b>hub de efectivo</b>: la venta de ruta <b>entra</b> (ingreso) y sale a <b>remisiones/gastos</b> + <b>depósito al banco</b> (gasto). Cuadra si <b>ingreso ≈ gasto</b> (todo lo que entró salió). El <b>neto</b> es el efectivo que quedó/faltó. El <b>arqueo</b> (mayor conteo físico del día) es testigo del efectivo real. Tolerancia ±2%.</p>

          <div class="cg-origen">
            <span class="cg-bd-title">Ingreso por origen — ¿de dónde viene el efectivo?</span>
            <div class="cg-origen-grid">
              <div class="cg-ocell"><span class="cg-ol">Sucursal (POS)</span><span class="cg-ov">{{ money(d.ingreso_origen.sucursal.monto) }}</span><span class="cg-os">{{ d.ingreso_origen.sucursal.n }} movs</span></div>
              <div class="cg-ocell"><span class="cg-ol">Ruta</span><span class="cg-ov">{{ money(d.ingreso_origen.ruta.monto) }}</span><span class="cg-os">{{ d.ingreso_origen.ruta.n }} movs</span></div>
              <div class="cg-ocell"><span class="cg-ol">Otros <span class="muted">(directivos/nómina)</span></span><span class="cg-ov">{{ money(d.ingreso_origen.otros.monto) }}</span><span class="cg-os">{{ d.ingreso_origen.otros.n }} movs</span></div>
              <div class="cg-ocell cg-ocell-pos"><span class="cg-ol">Testigo POS <span class="muted">(cortes Kepler)</span></span><span class="cg-ov">{{ money(d.pos_efectivo.efectivo) }}</span><span class="cg-os">{{ d.pos_efectivo.n }} cortes · efectivo</span></div>
            </div>
            <p class="cg-note" style="margin-top:.5rem">El ingreso de <b>sucursal</b> ({{ money(d.ingreso_origen.sucursal.monto) }}) debería acercarse al <b>efectivo de los cortes POS</b> ({{ money(d.pos_efectivo.efectivo) }}) — ambos son efectivo de piso. La diferencia = timing / rutas sin POS / merma. La <b>ruta</b> (Canindo, Vecinal…) no tiene POS, por eso no cruza. Clasificación heurística por texto.</p>
          </div>
          <p-table [value]="d.por_dia" dataKey="fecha" [expandedRowKeys]="cqExp()" styleClass="p-datatable-sm surf-table surf-table--sticky" [rowHover]="true" [scrollable]="true" scrollHeight="flex" [paginator]="d.por_dia.length>60" [rows]="60">
            <ng-template #header><tr><th class="cg-w-x"></th><th class="cg-w-date">Día</th><th class="ta-r">Ingreso</th><th class="ta-r">Gasto</th><th class="ta-r">Depósito banco</th><th class="ta-r">Neto</th><th class="cg-w-e">Estado</th><th class="ta-r">Arqueo</th></tr></ng-template>
            <ng-template #body let-r>
              <tr class="cg-row-click" (click)="toggleCqDay(r)" [class.cg-row-open]="cqIsExp(r)">
                <td><i class="pi cg-chev" [class.pi-chevron-right]="!cqIsExp(r)" [class.pi-chevron-down]="cqIsExp(r)" aria-hidden="true"></i></td>
                <td class="cg-mono">{{ dmy(r.fecha) }} <span class="muted">· {{ r.n }}</span></td>
                <td class="ta-r num strong">{{ money(r.ingreso) }}</td>
                <td class="ta-r num muted">{{ money(r.gasto) }}</td>
                <td class="ta-r num muted">{{ r.deposito ? money(r.deposito) : '—' }}</td>
                <td class="ta-r num" [class.cg-in]="netoState(r)==='sobra'" [class.cg-eg]="netoState(r)==='falta'">{{ money(r.neto) }}</td>
                <td class="cg-w-e">
                  @if (netoState(r)==='sobra') { <p-tag value="sobra" severity="success" styleClass="cg-tag" /> }
                  @else if (netoState(r)==='falta') { <p-tag value="falta" severity="danger" styleClass="cg-tag" /> }
                  @else { <span class="muted">cuadra</span> }
                </td>
                <td class="ta-r num muted">{{ r.arqueo_efectivo != null ? money(r.arqueo_efectivo) : '—' }}</td>
              </tr>
            </ng-template>
            <ng-template #expandedrow let-r>
              <tr class="cg-detail-row"><td colspan="8">
                @if (cqDayLoad()[key(r)]) { <div class="muted" style="padding:.5rem">Cargando movimientos del día…</div> }
                @else if (cqDayMovs()[key(r)]; as ms) {
                  <div class="cg-daywrap">
                    <table class="cg-daytbl">
                      <thead><tr><th>Cuenta</th><th>Cliente / Concepto</th><th class="ta-r">Egreso</th><th class="ta-r">Ingreso</th></tr></thead>
                      <tbody>
                        @for (m of ms; track m.uid) {
                          <tr><td class="cg-emp" [title]="m.cuenta_nombre">{{ m.cuenta_nombre || '—' }} <span class="muted">#{{ m.cuenta }}</span></td>
                              <td class="cg-emp" [title]="m.nombre_cliente">{{ m.nombre_cliente || '—' }}@if (m.concepto) { <span class="muted"> · {{ m.concepto }}</span> }</td>
                              <td class="ta-r num cg-eg">{{ m.gasto ? money(m.gasto) : '—' }}</td>
                              <td class="ta-r num cg-in">{{ m.ingreso ? money(m.ingreso) : '—' }}</td></tr>
                        }
                        @if (!ms.length) { <tr><td colspan="4" class="muted" style="padding:.5rem">Sin movimientos.</td></tr> }
                      </tbody>
                    </table>
                  </div>
                } @else { <div class="muted" style="padding:.5rem">—</div> }
              </td></tr>
            </ng-template>
            <ng-template #emptymessage><tr><td colspan="8"><div class="cg-empty"><i class="pi pi-inbox" aria-hidden="true"></i><span>Sin movimientos en el periodo.</span></div></td></tr></ng-template>
          </p-table>
        }
      }

      <!-- ===== VS WORKBOOK (.mdb operativo vs copia manual) ===== -->
      @if (view()==='workbook') {
        @if (loading() && !wbc()) { <div class="cg-skel">@for (i of skel; track i) { <p-skeleton height="2rem" styleClass="cg-skel-row" /> }</div> }
        @else if (wbc(); as d) {
          <p class="cg-note" style="margin:.2rem 0 .6rem">Concilia la caja <b>viva</b> (.mdb/Doctos — lo que de verdad se movió) contra la <b>copia manual</b> del workbook (hoja CAJA GENERAL del Sheet). El <b>Δ</b> = error u omisión de captura del Excel. No es "caja vs banco" (la caja no deposita) — es el mismo dato por dos caminos. Tolerancia ±{{ money(d.eps) }}/día.</p>
          @if (!d.totals.wb_disponible) {
            <div class="cg-legacy-note" role="note"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span>No hay <b>copia manual</b> del workbook en este periodo (la hoja CAJA GENERAL del Sheet está vacía). Llénala en el Excel para conciliar — o usa <b>General/Cuadre</b>: la caja viva no depende del manual.</span></div>
          } @else {
            <div class="cg-verdict" [class.ok]="d.totals.dias_descuadre===0" [class.warn]="d.totals.dias_descuadre>0">
              @if (d.totals.dias_descuadre===0) { <i class="pi pi-check-circle" aria-hidden="true"></i> <b>Cuadra</b> — el manual empata con el .mdb en los {{ d.totals.dias_wb }} días capturados. }
              @else { <i class="pi pi-exclamation-triangle" aria-hidden="true"></i> <b>{{ d.totals.dias_descuadre }} día(s) con diferencia</b> entre el manual y el .mdb — revísalos abajo. }
            </div>
            <app-metric-strip [items]="wbKpis(d)" ariaLabel="Conciliación .mdb vs workbook" />
          }
          <p-table [value]="d.por_dia" dataKey="fecha" [expandedRowKeys]="wbExp()" styleClass="p-datatable-sm surf-table surf-table--sticky" [rowHover]="true" [scrollable]="true" scrollHeight="flex" [paginator]="d.por_dia.length>60" [rows]="60">
            <ng-template #header><tr>
              <th class="cg-w-x"></th>
              <th class="cg-w-date">Día</th>
              <th class="ta-r">.mdb Ingreso</th><th class="ta-r">Manual</th><th class="ta-r">Δ</th>
              <th class="ta-r">.mdb Gasto</th><th class="ta-r">Manual</th><th class="ta-r">Δ</th>
              <th class="cg-w-e">Estado</th>
            </tr></ng-template>
            <ng-template #body let-r>
              <tr class="cg-row-click" (click)="toggleWbDay(r)" [class.cg-row-open]="wbIsExp(r)">
                <td><i class="pi cg-chev" [class.pi-chevron-right]="!wbIsExp(r)" [class.pi-chevron-down]="wbIsExp(r)" aria-hidden="true"></i></td>
                <td class="cg-mono">{{ dmy(r.fecha) }} <span class="muted">· {{ r.mdb_n }}</span></td>
                <td class="ta-r num strong">{{ money(r.mdb_ingreso) }}</td>
                <td class="ta-r num muted">{{ r.wb_vacio ? '—' : money(r.wb_ingreso) }}</td>
                <td class="ta-r num" [class.warn]="!r.wb_vacio && abs(r.delta_ingreso)>d.eps">{{ r.wb_vacio ? '—' : money(r.delta_ingreso) }}</td>
                <td class="ta-r num strong">{{ money(r.mdb_gasto) }}</td>
                <td class="ta-r num muted">{{ r.wb_vacio ? '—' : money(r.wb_gasto) }}</td>
                <td class="ta-r num" [class.warn]="!r.wb_vacio && abs(r.delta_gasto)>d.eps">{{ r.wb_vacio ? '—' : money(r.delta_gasto) }}</td>
                <td class="cg-w-e">
                  @if (r.wb_vacio) { <span class="muted">sin manual</span> }
                  @else if (r.cuadra) { <p-tag value="cuadra" severity="success" styleClass="cg-tag" /> }
                  @else { <p-tag value="revisar" severity="warn" styleClass="cg-tag" /> }
                </td>
              </tr>
            </ng-template>
            <ng-template #expandedrow let-r>
              <tr class="cg-detail-row"><td colspan="9">
                @if (wbDayLoad()[key(r)]) { <div class="muted" style="padding:.5rem">Cargando movimientos del día…</div> }
                @else {
                  <div class="cg-wbcmp">
                    <div class="cg-wbside">
                      <div class="cg-wbside-t">.mdb (operativo) · <span class="muted">{{ (wbDayMdb()[key(r)] || []).length }} movs</span></div>
                      <div class="cg-daywrap">
                        <table class="cg-daytbl">
                          <thead><tr><th>Cuenta</th><th>Cliente / Concepto</th><th class="ta-r">Egreso</th><th class="ta-r">Ingreso</th></tr></thead>
                          <tbody>
                            @for (m of wbDayMdb()[key(r)] || []; track m.uid) {
                              <tr><td class="cg-emp" [title]="m.cuenta_nombre">{{ m.cuenta_nombre || '—' }} <span class="muted">#{{ m.cuenta }}</span></td>
                                  <td class="cg-emp" [title]="m.nombre_cliente">{{ m.nombre_cliente || '—' }}@if (m.concepto) { <span class="muted"> · {{ m.concepto }}</span> }</td>
                                  <td class="ta-r num cg-eg">{{ m.gasto ? money(m.gasto) : '—' }}</td>
                                  <td class="ta-r num cg-in">{{ m.ingreso ? money(m.ingreso) : '—' }}</td></tr>
                            }
                            @if (!(wbDayMdb()[key(r)] || []).length) { <tr><td colspan="4" class="muted" style="padding:.4rem">Sin movimientos.</td></tr> }
                          </tbody>
                        </table>
                      </div>
                    </div>
                    <div class="cg-wbside">
                      <div class="cg-wbside-t">Manual (workbook) · <span class="muted">{{ (wbDayWb()[key(r)] || []).length }} movs</span></div>
                      <div class="cg-daywrap">
                        <table class="cg-daytbl">
                          <thead><tr><th>Suc / Código</th><th>Concepto</th><th class="ta-r">Egreso</th><th class="ta-r">Ingreso</th></tr></thead>
                          <tbody>
                            @for (m of wbDayWb()[key(r)] || []; track m.id) {
                              <tr><td class="cg-mono muted">{{ m.sucursal || '—' }}@if (m.codigo) { <span class="muted"> ·{{ m.codigo }}</span> }</td>
                                  <td class="cg-emp" [title]="m.concepto">{{ m.concepto || '—' }}</td>
                                  <td class="ta-r num cg-eg">{{ m.gasto ? money(m.gasto) : '—' }}</td>
                                  <td class="ta-r num cg-in">{{ m.ingreso ? money(m.ingreso) : '—' }}</td></tr>
                            }
                            @if (!(wbDayWb()[key(r)] || []).length) { <tr><td colspan="4" class="muted" style="padding:.4rem">Sin copia manual este día.</td></tr> }
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                }
              </td></tr>
            </ng-template>
            <ng-template #emptymessage><tr><td colspan="9"><div class="cg-empty"><i class="pi pi-inbox" aria-hidden="true"></i><span>Sin movimientos en el periodo.</span></div></td></tr></ng-template>
          </p-table>
        }
      }

      <!-- ===== RESUMEN ===== -->
      @if (view()==='resumen') {
        @if (loading() && !ov()) { <div class="cg-skel">@for (i of skel; track i) { <p-skeleton height="2rem" styleClass="cg-skel-row" /> }</div> }
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
            <p-table [value]="rows" styleClass="p-datatable-sm surf-table surf-table--sticky" [rowHover]="true" [scrollable]="true" scrollHeight="flex">
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
        @if (loading() && !dep()) { <div class="cg-skel">@for (i of skel; track i) { <p-skeleton height="2rem" styleClass="cg-skel-row" /> }</div> }
        @else if (dep(); as d) {
          <app-metric-strip [items]="depKpis(d)" ariaLabel="Totales de depósitos" />
          <div class="cg-bd">
            <span class="cg-bd-title">Por banco (real)</span>
            @for (b of d.by_bank; track b.banco) { <div class="cg-bd-row"><span class="cg-bd-k">{{ b.banco || '—' }}</span><span class="cg-bd-v">{{ money(b.total_real) }}</span><span class="cg-bd-n">{{ b.n }}</span></div> }
          </div>
          <p-table [value]="d.rows" styleClass="p-datatable-sm surf-table surf-table--sticky" [rowHover]="true" [scrollable]="true" scrollHeight="flex" [paginator]="d.rows.length>200" [rows]="200">
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
        @if (loading() && !arq()) { <div class="cg-skel">@for (i of skel; track i) { <p-skeleton height="2rem" styleClass="cg-skel-row" /> }</div> }
        @else if (arq(); as d) {
          <div class="cg-bd">
            <span class="cg-bd-title">Por tipo</span>
            @for (t of d.by_tipo; track t.tipo) { <div class="cg-bd-row"><span class="cg-bd-k">{{ t.tipo || '—' }}</span><span class="cg-bd-v">{{ money(t.monto) }}</span><span class="cg-bd-n">{{ t.n }}</span></div> }
          </div>
          <p-table [value]="d.rows" styleClass="p-datatable-sm surf-table surf-table--sticky" [rowHover]="true" [scrollable]="true" scrollHeight="flex" [paginator]="d.rows.length>200" [rows]="200">
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
        @if (loading() && !conc()) { <div class="cg-skel">@for (i of skel; track i) { <p-skeleton height="2rem" styleClass="cg-skel-row" /> }</div> }
        @else if (conc(); as d) {
          <app-metric-strip [items]="concKpis(d)" ariaLabel="Conciliación 3 vías caja/workbook/kepler" />
          <p-table [value]="d.por_banco" styleClass="p-datatable-sm surf-table surf-table--sticky" [rowHover]="true" [scrollable]="true" scrollHeight="flex">
            <ng-template #header>
              <tr>
                <th rowspan="2">Banco</th>
                <th class="ta-r" colspan="2">Caja <span class="cg-sub">(operativo)</span></th>
                <th class="ta-r" colspan="2">Workbook</th>
                <th class="ta-r" colspan="2">Kepler</th>
                <th class="ta-r" colspan="2">ContPAQi <span class="cg-sub">(fiscal)</span></th>
                <th class="ta-r" rowspan="2">Δ caja–wb</th>
                <th class="cg-w-e" rowspan="2">Cuadre</th>
              </tr>
              <tr>
                <th class="ta-r cg-sub">Depositado</th><th class="ta-c cg-w-d cg-sub">#</th>
                <th class="ta-r cg-sub">Ingresos</th><th class="ta-c cg-w-d cg-sub">#</th>
                <th class="ta-r cg-sub">Entradas</th><th class="ta-c cg-w-d cg-sub">#</th>
                <th class="ta-r cg-sub">Libros</th><th class="ta-c cg-w-d cg-sub">#</th>
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
              <p-table [value]="cd.caja_only" styleClass="p-datatable-sm surf-table" [rowHover]="true" [scrollable]="true" scrollHeight="18rem" [paginator]="cd.caja_only.length>100" [rows]="100">
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
        @if (loading() && !xw()) { <div class="cg-skel">@for (i of skel; track i) { <p-skeleton height="2rem" styleClass="cg-skel-row" /> }</div> }
        @else if (xw(); as rows) {
          <p class="cg-note" style="margin:.2rem 0 .8rem">Mapea cada <b>cuenta interna de Caja</b> a su <b>cuenta de banco real</b> (account_label, la llave que comparten Bancos y Kepler). La sugerencia se deriva <b>vía Kepler</b> (match de depósitos por monto+fecha, mismo banco) — es dispersa, por eso se <b>confirma a mano</b>. Confirmar habilita la conciliación exacta por cuenta (en vez de por nombre de banco).</p>
          <p-table [value]="rows" styleClass="p-datatable-sm surf-table surf-table--sticky" [rowHover]="true" [scrollable]="true" scrollHeight="flex">
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
  `,
  styles: [`
    :host { display:block; }
    .surf-page-head { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap; }
    .cg-head-actions { display:flex; gap:.5rem; align-items:center; }
    :host ::ng-deep .cg-sel { min-width:8.5rem; }
    .cg-views { display:flex; gap:.3rem; flex-wrap:wrap; margin:1rem 0 .8rem; border-bottom:1px solid var(--border-color); }
    .cg-view { background:none; border:none; border-bottom:2px solid transparent; padding:.5rem .8rem; font-size:.85rem; color:var(--text-muted); cursor:pointer; }
    .cg-view:hover { color:var(--text-main); }
    .cg-view.on { color:var(--text-main); border-bottom-color:var(--action); font-weight:600; }
    .cg-view.legacy { color:var(--text-faint); }
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
    .cg-verdict { display:flex; align-items:center; gap:.5rem; padding:.6rem .85rem; margin:.4rem 0 .2rem; border:1px solid var(--border-color); border-left:3px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); font-size:.85rem; }
    .cg-verdict.ok { border-left-color:var(--ok-fg); } .cg-verdict.ok .pi { color:var(--ok-fg); }
    .cg-verdict.warn { border-left-color:var(--warn-fg); } .cg-verdict.warn .pi { color:var(--warn-fg); }
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
    .cg-daywrap { overflow-x:auto; } .cg-daytbl { width:100%; border-collapse:collapse; font-size:.78rem; }
    .cg-wbcmp { display:grid; grid-template-columns:repeat(auto-fit, minmax(20rem,1fr)); gap:.8rem; }
    .cg-wbside-t { font-size:.72rem; text-transform:uppercase; letter-spacing:.03em; color:var(--text-muted); margin-bottom:.3rem; }
    .cg-daytbl th { text-align:left; font-size:var(--fs-xs); text-transform:uppercase; letter-spacing:.03em; color:var(--text-muted); padding:3px 8px; border-bottom:1px solid var(--border-color); }
    .cg-daytbl td { padding:3px 8px; border-bottom:1px solid var(--border-color); }
    .ta-r { text-align:right; } .ta-c { text-align:center; }
    .cg-sub { font-weight:500 !important; font-size:.68rem !important; color:var(--text-faint) !important; }
    .num, .cg-mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .strong { font-weight:700; } .muted { color:var(--text-faint); } .warn { color:var(--warn-fg); font-weight:700; }
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
    .cg-empty { display:flex; flex-direction:column; align-items:center; gap:.4rem; padding:2rem 1rem; text-align:center; color:var(--text-muted); }
    .cg-empty .pi { font-size:1.6rem; color:var(--text-faint); }
    .cg-skel { display:flex; flex-direction:column; gap:.4rem; margin-top:1rem; }
  `],
})
export class FinanzasCajaComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly base = `${environment.apiUrl}/finance/caja`;

  // `legacy` = lee el Base Movimientos de Finanzas (caja_ventas_diarias / caja_depositos),
  // que dejó de alimentarse (ventas 08/abr-2026, depósitos ene-2026). Datos completos solo
  // ≤ ene-2026 → banner honesto + badge. La caja VIVA es General/Cuadre (Doctos). Arqueos vivo.
  readonly VIEWS: { key: View; label: string; icon: string; legacy?: boolean }[] = [
    { key: 'general', label: 'General', icon: 'pi-wallet' },
    { key: 'cuadre', label: 'Cuadre', icon: 'pi-check-square' },
    { key: 'workbook', label: 'Vs Workbook', icon: 'pi-book' },
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
  readonly wbExp = signal<Record<string, boolean>>({});
  readonly wbDayMdb = signal<Record<string, CajaGeneral['movimientos']>>({});
  readonly wbDayWb = signal<Record<string, WbMov[]>>({});
  readonly wbDayLoad = signal<Record<string, boolean>>({});
  readonly cqExp = signal<Record<string, boolean>>({});
  readonly cqDayMovs = signal<Record<string, CajaGeneral['movimientos']>>({});
  readonly cqDayLoad = signal<Record<string, boolean>>({});
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
    this.http.get<Facets>(`${this.base}/facets`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (f) => { this.f.set(f); if (f.meses?.length) this.month.set(f.meses[0]); this.reload(); },
      error: () => { this.err.set('No se pudieron cargar los filtros.'); this.reload(); },
    });
  }

  setView(v: View): void { if (v === this.view()) return; this.view.set(v); this.reload(); }
  onMonth(v: string | null): void { this.month.set(v); this.cg.set(null); this.cq.set(null); this.wbc.set(null); this.wbExp.set({}); this.wbDayMdb.set({}); this.wbDayWb.set({}); this.cqExp.set({}); this.cqDayMovs.set({}); this.ov.set(null); this.suc.set(null); this.dep.set(null); this.arq.set(null); this.conc.set(null); this.reload(); }
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
      this.http.get<CajaCuadre>(`${this.base}/cuadre${this.qs()}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (d) => { this.cq.set(d); done(); }, error: fail });
    } else if (v === 'workbook') {
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
  abs(n: number): number { return Math.abs(n || 0); }
  wbKpis(d: CajaWb): MetricStripItem[] {
    return [
      { label: '.mdb (operativo)', value: d.totals.mdb_ingreso, format: 'currency-short', tone: 'default', sub: `ingreso · ${d.totals.dias} días` },
      { label: 'Manual (workbook)', value: d.totals.wb_ingreso, format: 'currency-short', tone: 'default', sub: `ingreso · ${d.totals.dias_wb} días` },
      { label: 'Δ Ingreso', value: d.totals.delta_ingreso, format: 'currency-short', tone: Math.abs(d.totals.delta_ingreso) > 1000 ? 'warn' : 'ok' },
      { label: 'Δ Gasto', value: d.totals.delta_gasto, format: 'currency-short', tone: Math.abs(d.totals.delta_gasto) > 1000 ? 'warn' : 'ok' },
    ];
  }
  key(r: { fecha: string }): string { return String(r.fecha).slice(0, 10); }
  netoState(r: { ingreso: number; neto: number }): 'sobra' | 'falta' | 'cuadra' {
    const tol = Math.max((r.ingreso || 0) * 0.05, 1000);
    if (r.neto > tol) return 'sobra';
    if (r.neto < -tol) return 'falta';
    return 'cuadra';
  }
  cqIsExp(r: { fecha: string }): boolean { return !!this.cqExp()[r.fecha]; }
  wbIsExp(r: { fecha: string }): boolean { return !!this.wbExp()[r.fecha]; }
  /** Desglose de un día en Vs Workbook: trae los movimientos del .mdb Y del manual (workbook). */
  toggleWbDay(r: { fecha: string }): void {
    const rk = r.fecha; const e = { ...this.wbExp() };
    if (e[rk]) { delete e[rk]; this.wbExp.set(e); return; }
    e[rk] = true; this.wbExp.set(e);
    const dk = this.key(r);
    if ((dk in this.wbDayWb()) || this.wbDayLoad()[dk]) return;
    this.wbDayLoad.set({ ...this.wbDayLoad(), [dk]: true });
    let pending = 2;
    const done = () => { if (--pending === 0) this.wbDayLoad.set({ ...this.wbDayLoad(), [dk]: false }); };
    this.http.get<CajaGeneral>(`${this.base}/general?from=${dk}&to=${dk}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.wbDayMdb.set({ ...this.wbDayMdb(), [dk]: d.movimientos }); done(); },
      error: () => { this.wbDayMdb.set({ ...this.wbDayMdb(), [dk]: [] }); done(); },
    });
    this.http.get<{ movimientos: WbMov[] }>(`${this.base}/workbook-movimientos?from=${dk}&to=${dk}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.wbDayWb.set({ ...this.wbDayWb(), [dk]: d.movimientos }); done(); },
      error: () => { this.wbDayWb.set({ ...this.wbDayWb(), [dk]: [] }); done(); },
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
        error: () => this.cqDayLoad.set({ ...this.cqDayLoad(), [dk]: false }),
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
  money(n: number): string { return Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  /**
   * Fecha SIN voltear de TZ. El API serializa las columnas `date` como ISO a
   * medianoche UTC (contenedor UTC) → el pipe `| date` las mueve un día atrás en
   * el navegador MX. Extraemos la parte de fecha del string (o del Date) directo.
   */
  dmy(v: any): string {
    if (v instanceof Date && !isNaN(v.getTime())) return `${String(v.getDate()).padStart(2, '0')}/${String(v.getMonth() + 1).padStart(2, '0')}/${String(v.getFullYear()).slice(2)}`;
    const m = String(v ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1].slice(2)}` : (v ? String(v) : '—');
  }
  dmyLong(v: any): string {
    if (v instanceof Date && !isNaN(v.getTime())) return `${String(v.getDate()).padStart(2, '0')}/${String(v.getMonth() + 1).padStart(2, '0')}/${v.getFullYear()}`;
    const m = String(v ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : (v ? String(v) : '—');
  }
}
