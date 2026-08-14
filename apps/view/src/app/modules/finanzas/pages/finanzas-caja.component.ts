import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
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

type View = 'general' | 'cuadre' | 'resumen' | 'depositos' | 'arqueos' | 'conciliacion' | 'enlace';
interface CajaCuadre {
  period: { from: string; to: string };
  totals: { ingreso: number; gasto: number; deposito: number; remisiones_gastos: number; neto: number; cuadra: boolean; dias: number };
  por_dia: { fecha: string; ingreso: number; gasto: number; deposito: number; neto: number; n: number; arqueo_efectivo: number | null; arqueo_n: number }[];
}
interface CajaGeneral {
  period: { from: string; to: string };
  totals: { ingreso: number; gasto: number; neto: number; n: number; saldo: number; saldo_fecha: string | null };
  por_mes: { mes: string; ingreso: number; gasto: number; n: number }[];
  por_cuenta: { cuenta: string; cuenta_nombre: string | null; ingreso: number; gasto: number; n: number }[];
  movimientos: { mov_id: string; tipo_dto: number; tipo: string | null; fecha: string; hora: string | null; cuenta: string; cuenta_nombre: string | null; nombre_cliente: string | null; concepto: string | null; ingreso: number; gasto: number; saldo: number }[];
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
          <button role="tab" [attr.aria-selected]="view()===v.key" class="cg-view" [class.on]="view()===v.key" (click)="setView(v.key)"><span class="pi {{v.icon}}" aria-hidden="true"></span>&nbsp;{{ v.label }}</button>
        }
      </nav>

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
          <p-table [value]="d.movimientos" styleClass="p-datatable-sm surf-table surf-table--sticky" [rowHover]="true" [scrollable]="true" scrollHeight="flex" [paginator]="d.movimientos.length>100" [rows]="100">
            <ng-template #header><tr><th class="cg-w-date">Fecha</th><th class="cg-w-e">Tipo</th><th>Cuenta</th><th>Cliente / Concepto</th><th class="ta-r">Ingreso</th><th class="ta-r">Gasto</th><th class="ta-r">Saldo</th></tr></ng-template>
            <ng-template #body let-r>
              <tr>
                <td class="cg-mono">{{ r.fecha | date:'dd/MM/yy' }}</td>
                <td><p-tag [value]="r.tipo || '?'" [severity]="r.tipo==='Ingreso'?'success':(r.tipo==='Gasto'?'warn':'secondary')" styleClass="cg-tag" /></td>
                <td class="cg-emp" [title]="r.cuenta_nombre">{{ r.cuenta_nombre || '—' }} <span class="muted">#{{ r.cuenta }}</span></td>
                <td class="cg-emp" [title]="r.nombre_cliente">{{ r.nombre_cliente || '—' }}@if (r.concepto) { <span class="muted"> · {{ r.concepto }}</span> }</td>
                <td class="ta-r num" [class.strong]="r.ingreso>0">{{ r.ingreso ? money(r.ingreso) : '—' }}</td>
                <td class="ta-r num" [class.strong]="r.gasto>0">{{ r.gasto ? money(r.gasto) : '—' }}</td>
                <td class="ta-r num muted">{{ money(r.saldo) }}</td>
              </tr>
            </ng-template>
            <ng-template #emptymessage><tr><td colspan="7"><div class="cg-empty"><i class="pi pi-inbox" aria-hidden="true"></i><span>Sin movimientos en el periodo.</span></div></td></tr></ng-template>
          </p-table>
          <p class="cg-note">Caja general <b>viva</b> de Comisionistas (sistema operativo <code>Doctos</code>): la venta de ruta <b>entra</b> (ingreso) y sale a <b>pagar proveedores</b> (remisiones), comisiones y gastos por sucursal. Reemplaza el Base Movimientos (abandonado abr-2026). Saldo actual: <b>{{ money(d.totals.saldo) }}</b>@if (d.totals.saldo_fecha) { <span class="muted"> (al {{ d.totals.saldo_fecha | date:'dd/MM/yy' }})</span> }. Mostrando hasta 500 movimientos del periodo.</p>
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
          <p-table [value]="d.por_dia" styleClass="p-datatable-sm surf-table surf-table--sticky" [rowHover]="true" [scrollable]="true" scrollHeight="flex" [paginator]="d.por_dia.length>60" [rows]="60">
            <ng-template #header><tr><th class="cg-w-date">Día</th><th class="ta-c cg-w-d">Movs</th><th class="ta-r">Ingreso</th><th class="ta-r">Gasto</th><th class="ta-r">Depósito banco</th><th class="ta-r">Neto</th><th class="ta-r">Arqueo (testigo)</th></tr></ng-template>
            <ng-template #body let-r>
              <tr>
                <td class="cg-mono">{{ r.fecha | date:'dd/MM/yy' }}</td>
                <td class="ta-c muted">{{ r.n }}</td>
                <td class="ta-r num strong">{{ money(r.ingreso) }}</td>
                <td class="ta-r num muted">{{ money(r.gasto) }}</td>
                <td class="ta-r num muted">{{ r.deposito ? money(r.deposito) : '—' }}</td>
                <td class="ta-r num" [class.warn]="abs(r.neto) > r.ingreso*0.05 && abs(r.neto)>1000">{{ money(r.neto) }}</td>
                <td class="ta-r num muted">{{ r.arqueo_efectivo != null ? money(r.arqueo_efectivo) : '—' }}@if (r.arqueo_n) { <span class="muted"> ({{ r.arqueo_n }})</span> }</td>
              </tr>
            </ng-template>
            <ng-template #emptymessage><tr><td colspan="7"><div class="cg-empty"><i class="pi pi-inbox" aria-hidden="true"></i><span>Sin movimientos en el periodo.</span></div></td></tr></ng-template>
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
                  <td class="cg-mono muted">{{ r.ultima | date:'dd/MM/yy' }}</td>
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
                <td class="cg-mono">{{ r.deposito_date | date:'dd/MM/yy' }}</td>
                <td class="cg-mono muted">{{ r.deposito_date_real ? (r.deposito_date_real | date:'dd/MM/yy') : '—' }}</td>
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
                <td class="cg-mono">{{ r.arqueo_date | date:'dd/MM/yy' }}</td>
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
                    <td class="cg-mono">{{ r.fecha | date:'dd/MM/yy' }}</td>
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

  readonly VIEWS: { key: View; label: string; icon: string }[] = [
    { key: 'general', label: 'General', icon: 'pi-wallet' },
    { key: 'cuadre', label: 'Cuadre', icon: 'pi-check-square' },
    { key: 'resumen', label: 'Resumen', icon: 'pi-chart-bar' },
    { key: 'depositos', label: 'Depósitos', icon: 'pi-building-columns' },
    { key: 'arqueos', label: 'Arqueos', icon: 'pi-calculator' },
    { key: 'conciliacion', label: 'Conciliación', icon: 'pi-sync' },
    { key: 'enlace', label: 'Enlace de cuentas', icon: 'pi-link' },
  ];
  readonly tipoOpts = ['Arqueo', 'Retiro', 'Corte', 'Deposito', 'Fondo Caja'];
  readonly skel = Array.from({ length: 8 });

  readonly view = signal<View>('general');
  readonly cgTipo = signal<string | null>(null);
  readonly cg = signal<CajaGeneral | null>(null);
  readonly cq = signal<CajaCuadre | null>(null);
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
  onMonth(v: string | null): void { this.month.set(v); this.cg.set(null); this.cq.set(null); this.ov.set(null); this.suc.set(null); this.dep.set(null); this.arq.set(null); this.conc.set(null); this.reload(); }
  onFilter(which: 'banco' | 'tipo' | 'caja', v: string | null): void { ({ banco: this.banco, tipo: this.tipo, caja: this.caja })[which].set(v); this.reload(); }
  onCgTipo(v: string | null): void { this.cgTipo.set(v); this.reload(); }
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
}
