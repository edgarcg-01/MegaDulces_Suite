import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import {
  ContabilidadContpaqiService, BalanzaResp, BankResp, EfosResp, LibrosVsOpResp, BalanzaGroupBy, BankGroupBy, CfdiVsContabResp,
  BalanzaRow, BankRow, BalanzaRenglones, BankMovimientos, CfdisProveedor, CfdiRiesgo,
} from '../contabilidad-contpaqi.service';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { CfdiVisorComponent } from '../../../shared/components/cfdi-visor/cfdi-visor.component';

/** LC.21: lo que está abierto en el panel lateral. */
type Panel =
  | { tipo: 'renglones'; cuenta: string; nombre: string; from_mes?: string; to_mes?: string }
  | { tipo: 'movs'; cuenta: string | null; mes: string | null; flujo: 'deposito' | 'retiro' | null; etiqueta: string }
  | { tipo: 'cfdis'; period: string; rfc: string; nombre: string };
/** LC.21: el grupo de la balanza que se abrió (sus cuentas). */
interface FiltroBalanza { familia?: string; mes?: string; agrupador_sat?: string; etiqueta: string }

type View = 'balanza' | 'bancos' | 'efos' | 'libros' | 'cfdi';

/**
 * Fase CP (ADR-040) — ContPAQi en el proyecto Contabilidad. Los LIBROS FISCALES reales
 * (SQL Server ContPAQi): balanza, auxiliar bancario por banco, proveedores en lista negra
 * SAT (EFOS) y contraste libros-vs-operación. Superficie directa (no vía el chat de Maat).
 * Operations: denso, tokens, dark-safe, answer-first. Carga perezosa por vista.
 */
@Component({
  selector: 'app-contabilidad-contpaqi',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, SelectModule, SidePeekComponent, CfdiVisorComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in cp-page">

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>ContPAQi — Libros fiscales</h1>
          <p class="surf-page-sub">Los libros de la contabilidad (ContPAQi) dentro de la plataforma: balanza, bancos, riesgo SAT y contraste con la operación. Verdad fiscal consolidada.</p>
        </div>
      </header>

      <div class="cp-seg" role="radiogroup">
        @for (v of VIEWS; track v.key) {
          <button role="radio" [attr.aria-checked]="view()===v.key" [class.active]="view()===v.key" (click)="go(v.key)">
            <i [class]="v.icon"></i> {{ v.label }}
          </button>
        }
      </div>

      @if (view() === 'cfdi') {
        <div class="cp-controls">
          <label>Periodo
            <p-select [options]="periodOpts" [ngModel]="period()" (ngModelChange)="setPeriod($event)" appendTo="body" styleClass="cp-sel" [style]="{ minWidth: '9rem' }"></p-select>
          </label>
        </div>
      }

      @if (loading()) {
        <div class="cp-skel" aria-busy="true">@for (i of [1,2,3,4,5]; track i) { <div class="cp-skel-row"></div> }</div>
      } @else {

      <!-- ── BALANZA ── -->
      @if (view() === 'balanza') {
        <div class="cp-controls">
          <label>Agrupar por
            <p-select [options]="balanzaGroups" [ngModel]="balanzaBy()" (ngModelChange)="setBalanzaBy($event)" appendTo="body" styleClass="cp-sel" [style]="{ minWidth: '11rem' }"></p-select>
          </label>
          <!-- LC.21: el camino del desglose (grupo → sus cuentas → los renglones de cada una). -->
          @if (balanzaFiltro(); as f) {
            <span class="cp-crumb">› {{ f.etiqueta }}: sus cuentas
              <button type="button" class="cp-link" (click)="quitarFiltroBalanza()">Volver a {{ balanzaBy() }}</button></span>
          }
        </div>
        @if (balanza(); as b) {
          <div class="card-premium card-flat cp-tablewrap">
            <p-table [value]="b.rows" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="60vh">
              <ng-template #header><tr><th>{{ balanzaFiltro() ? 'cuenta' : balanzaBy() }}</th><th class="ta-r">Cargos</th><th class="ta-r">Abonos</th><th class="ta-r">Neto</th></tr></ng-template>
              <ng-template #body let-r>
                <!-- LC.21: la fila se abre. Un grupo abre sus cuentas; una cuenta, sus renglones de poliza. -->
                <tr class="cp-row-btn" tabindex="0" (click)="abrirBalanza(r)" (keydown.enter)="abrirBalanza(r)"
                    [attr.aria-label]="'Ver el detalle de ' + r[balanzaGrupoVisible()]">
                  <td class="cp-key">{{ r[balanzaGrupoVisible()] }}</td>
                  <td class="ta-r mono">{{ r.cargos | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  <td class="ta-r mono">{{ r.abonos | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  <td class="ta-r mono" [class.bad]="r.neto < 0">{{ r.neto | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                </tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="4"><div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin datos. ¿Corriste el importer de balanza?</p></div></td></tr></ng-template>
            </p-table>
            <!-- LC.21: antes mostraba los 30 grupos mas grandes SIN decirlo (por cuenta son ~990). -->
            <p class="cp-note muted">{{ b.fuente }} · {{ b.from_mes }} → {{ b.to_mes }}
              @if ((b.total_grupos ?? 0) > b.rows.length) {
                · mostrando {{ b.rows.length }} de {{ b.total_grupos | number }}
                <button type="button" class="cp-link" [disabled]="cargandoMas()" (click)="masBalanza()">Cargar más</button>
              }</p>
          </div>
        }
      }

      <!-- ── BANCOS (auxiliar por banco) ── -->
      @if (view() === 'bancos') {
        <div class="cp-controls">
          <label>Agrupar por
            <p-select [options]="bankGroups" [ngModel]="bankBy()" (ngModelChange)="setBankBy($event)" appendTo="body" styleClass="cp-sel" [style]="{ minWidth: '9rem' }"></p-select>
          </label>
        </div>
        @if (bank(); as b) {
          <div class="card-premium card-flat cp-tablewrap">
            <p-table [value]="b.rows" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="60vh">
              <ng-template #header><tr><th>{{ bankBy()==='mes' ? 'Mes' : 'Banco' }}</th><th class="ta-r">Depósitos</th><th class="ta-r">Retiros</th><th class="ta-r">Neto</th><th class="ta-r">Movs</th></tr></ng-template>
              <ng-template #body let-r>
                <!-- LC.21: Depositos, Retiros y Movs abren los movimientos que los forman. -->
                <tr>
                  <td class="cp-key">{{ bankBy()==='mes' ? r.mes : r.banco }}</td>
                  <td class="ta-r mono"><button type="button" class="cp-link" (click)="verMovimientos(r, 'deposito')" [attr.aria-label]="'Ver los depósitos de ' + (r.banco || r.mes)">{{ r.depositos | currency:'MXN':'symbol-narrow':'1.0-0' }}</button></td>
                  <td class="ta-r mono"><button type="button" class="cp-link" (click)="verMovimientos(r, 'retiro')" [attr.aria-label]="'Ver los retiros de ' + (r.banco || r.mes)">{{ r.retiros | currency:'MXN':'symbol-narrow':'1.0-0' }}</button></td>
                  <td class="ta-r mono" [class.bad]="r.neto < 0">{{ r.neto | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  <td class="ta-r mono muted"><button type="button" class="cp-link" (click)="verMovimientos(r, null)" [attr.aria-label]="'Ver los ' + r.movs + ' movimientos de ' + (r.banco || r.mes)">{{ r.movs | number }}</button></td>
                </tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="5"><div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin movimientos bancarios importados.</p></div></td></tr></ng-template>
            </p-table>
            <p class="cp-note muted">Resuelve el "17 bancos comparten el 102" de Kepler · {{ b.from_mes }} → {{ b.to_mes }}
              @if ((b.total_grupos ?? 0) > b.rows.length) {
                · mostrando {{ b.rows.length }} de {{ b.total_grupos | number }}
                <button type="button" class="cp-link" [disabled]="cargandoMas()" (click)="masBancos()">Cargar más</button>
              }</p>
          </div>
        }
      }

      <!-- ── EFOS (proveedores en lista negra SAT) ── -->
      @if (view() === 'efos') {
        @if (efos(); as e) {
          <div class="card-premium card-flat cp-verdict" [class.bad]="e.en_69b > 0">
            <i [class]="e.en_69b > 0 ? 'pi pi-exclamation-triangle' : 'pi pi-shield'"></i>
            <div>
              <!-- LC.21: los dos numeros abren su lista (todos / solo 69B). El total ya no sale de la pagina. -->
              <div class="cp-verdict-h"><button type="button" class="cp-link" (click)="setSoloEfos(false)">{{ e.total }} proveedor(es)</button> de la contabilidad en listas del SAT — <b [class.bad]="e.en_69b>0"><button type="button" class="cp-link" (click)="setSoloEfos(true)">{{ e.en_69b }} en 69B (EFOS)</button></b></div>
              <p class="cp-note muted">{{ e.nota }}</p>
            </div>
            <label class="cp-check"><input type="checkbox" [ngModel]="soloEfos()" (ngModelChange)="setSoloEfos($event)"> Solo EFOS (69B)</label>
          </div>
          <div class="card-premium card-flat cp-tablewrap">
            <p-table [value]="e.rows" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="55vh" [paginator]="e.rows.length > 50" [rows]="50">
              <ng-template #header><tr><th class="col-lista">Lista</th><th>RFC</th><th>Proveedor</th><th>Situación SAT</th></tr></ng-template>
              <ng-template #body let-r>
                <tr [class.cp-efos]="r.lista==='69B'">
                  <td><span class="cp-tag" [class.crit]="r.lista==='69B'">{{ r.lista }}</span></td>
                  <td class="mono">{{ r.rfc }}</td>
                  <td>{{ r.nombre }}</td>
                  <td class="muted">{{ r.situacion }}</td>
                </tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="4"><div class="surf-empty"><i class="pi pi-check-circle"></i><p>Ningún proveedor en listas del SAT.</p></div></td></tr></ng-template>
            </p-table>
            <!-- LC.21: el encabezado decia «50» con 109; ahora el total es real y el resto se carga. -->
            @if (e.total > e.rows.length) {
              <p class="cp-note muted">Mostrando {{ e.rows.length }} de {{ e.total | number }}
                <button type="button" class="cp-link" [disabled]="cargandoMas()" (click)="masEfos()">Cargar más</button></p>
            }
          </div>
        }
      }

      <!-- ── LIBROS vs OPERACIÓN ── -->
      @if (view() === 'libros') {
        @if (libros(); as l) {
          <div class="card-premium card-flat cp-verdict">
            <i class="pi pi-chart-line"></i>
            <div>
              <div class="cp-verdict-h">Ingresos {{ l.from_mes }} → {{ l.to_mes }}: operación (Kepler) <b class="mono">{{ l.operacion_kepler_total | currency:'MXN':'symbol-narrow':'1.0-0' }}</b> vs libros (ContPAQi) <b class="mono">{{ l.libros_contpaqi_total | currency:'MXN':'symbol-narrow':'1.0-0' }}</b> · ratio <b>{{ l.ratio_pct }}%</b></div>
              <p class="cp-note muted">{{ l.nota }}</p>
            </div>
          </div>
          <div class="card-premium card-flat cp-tablewrap">
            <p-table [value]="l.rows" styleClass="p-datatable-sm" [rowHover]="true">
              <ng-template #header><tr><th>Mes</th><th class="ta-r">Operación (Kepler)</th><th class="ta-r">Libros (ContPAQi)</th><th class="ta-r">Δ</th><th class="ta-r">Ratio</th></tr></ng-template>
              <ng-template #body let-r>
                <tr>
                  <td class="mono">{{ r.mes }}</td>
                  <td class="ta-r mono">{{ r.operacion_kepler | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  <!-- LC.21: Libros (ContPAQi) = abonos - cargos de la familia 4 del mes: abre esas cuentas en la balanza. -->
                  <td class="ta-r mono"><button type="button" class="cp-link" (click)="verLibrosMes(r.mes)" [attr.aria-label]="'Ver las cuentas de ingresos de ' + r.mes">{{ r.libros_contpaqi | currency:'MXN':'symbol-narrow':'1.0-0' }}</button></td>
                  <td class="ta-r mono muted">{{ r.delta | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  <td class="ta-r mono">{{ r.ratio_pct }}%</td>
                </tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="5"><div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin datos para el contraste.</p></div></td></tr></ng-template>
            </p-table>
          </div>
        }
      }

      <!-- ── CFDI vs CONTABILIDAD (materialidad / deducibilidad) ── -->
      @if (view() === 'cfdi') {
        @if (cfdi(); as d) {
          <!-- LC.21: cada tarjeta filtra la tabla de abajo a los proveedores que suma. -->
          <div class="cp-kpis">
            <button type="button" class="cp-kpi cp-kpi-btn" [class.sel]="filtroRiesgo() === 'todos'" (click)="filtrarRiesgo('todos')">
              <span class="cp-kpi-label">CFDI recibidos</span>
              <span class="cp-kpi-val mono">{{ d.summary.cfdi_total | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
              <span class="cp-kpi-sub muted">{{ d.summary.cfdi_count }} CFDIs · {{ d.summary.proveedores }} proveedores</span>
            </button>
            <button type="button" class="cp-kpi cp-kpi-btn" [class.bad]="d.summary.efos_count > 0" [class.sel]="filtroRiesgo() === 'efos'" (click)="filtrarRiesgo('efos')">
              <span class="cp-kpi-label">EFOS (69B) — no deducible</span>
              <span class="cp-kpi-val mono" [class.bad]="d.summary.efos_count > 0">{{ d.summary.efos_monto | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
              <span class="cp-kpi-sub muted">{{ d.summary.efos_count }} proveedor(es) en lista negra</span>
            </button>
            <button type="button" class="cp-kpi cp-kpi-btn" [class.warn]="d.summary.lista69_count > 0" [class.sel]="filtroRiesgo() === 'lista69'" (click)="filtrarRiesgo('lista69')">
              <span class="cp-kpi-label">Art. 69 CFF — riesgo</span>
              <span class="cp-kpi-val mono">{{ d.summary.lista69_monto | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
              <span class="cp-kpi-sub muted">{{ d.summary.lista69_count }} incumplido/no localizado</span>
            </button>
            <button type="button" class="cp-kpi cp-kpi-btn" [class.warn]="d.summary.no_registrados > 0" [class.sel]="filtroRiesgo() === 'no_registrado'" (click)="filtrarRiesgo('no_registrado')">
              <span class="cp-kpi-label">Sin registrar en ContPAQi</span>
              <span class="cp-kpi-val mono">{{ d.summary.no_registrados_monto | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
              <span class="cp-kpi-sub muted">{{ d.summary.no_registrados }} proveedor(es) sin alta</span>
            </button>
          </div>

          <div class="card-premium card-flat cp-tablewrap">
            <div class="cp-tabletop">
              <h3 class="cp-h3">Proveedores con CFDI recibido
                @if (filtroRiesgo() !== 'todos') { <span class="muted">· {{ etiquetaRiesgo() }} ({{ cfdiRows(d).length }}) <button type="button" class="cp-link" (click)="filtrarRiesgo('todos')">Ver todos</button></span> }
              </h3>
              <label class="cp-check"><input type="checkbox" [ngModel]="soloRiesgoCfdi()" (ngModelChange)="setSoloRiesgoCfdi($event)"> Solo riesgo</label>
            </div>
            <p-table [value]="cfdiRows(d)" styleClass="p-datatable-sm" [rowHover]="true" [scrollable]="true" scrollHeight="52vh" [paginator]="cfdiRows(d).length > 50" [rows]="50">
              <ng-template #header>
                <tr>
                  <th class="col-riesgo">Riesgo</th><th>RFC</th><th>Proveedor</th>
                  <th class="ta-r">CFDIs</th><th class="ta-r">Total</th>
                  <th class="ta-c">En ContPAQi</th><th>Situación SAT</th>
                </tr>
              </ng-template>
              <ng-template #body let-r>
                <tr [class.cp-efos]="r.riesgo==='efos'">
                  <td>
                    @switch (r.riesgo) {
                      @case ('efos') { <span class="cp-tag crit" title="Proveedor EFOS (69B): CFDI NO deducible">EFOS</span> }
                      @case ('lista69') { <span class="cp-tag warn" title="Art. 69 CFF: incumplido / no localizado">Art.69</span> }
                      @case ('no_registrado') { <span class="cp-tag warn" title="CFDI de proveedor no dado de alta en ContPAQi">Sin alta</span> }
                      @default { <i class="pi pi-check-circle ok" title="Sin riesgo"></i> }
                    }
                  </td>
                  <td class="mono">{{ r.rfc }}</td>
                  <td>{{ r.nombre }}</td>
                  <!-- LC.21: CFDIs y Total abren los CFDI del proveedor en el periodo (y cada uno, su factura). -->
                  <td class="ta-r mono muted"><button type="button" class="cp-link" (click)="verCfdis(d.period, r.rfc, r.nombre)" [attr.aria-label]="'Ver los ' + r.num_cfdis + ' CFDI de ' + r.nombre">{{ r.num_cfdis }}</button></td>
                  <td class="ta-r mono"><button type="button" class="cp-link" (click)="verCfdis(d.period, r.rfc, r.nombre)" [attr.aria-label]="'Ver los CFDI de ' + r.nombre">{{ r.total | currency:'MXN':'symbol-narrow':'1.0-0' }}</button></td>
                  <td class="ta-c">
                    @if (r.en_contpaqi) { <i class="pi pi-check ok" title="Registrado como proveedor en ContPAQi"></i> }
                    @else { <i class="pi pi-times bad" title="No está de alta en ContPAQi"></i> }
                  </td>
                  <td class="muted">{{ r.sat_situacion || '—' }}</td>
                </tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="7"><div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin CFDI recibidos en {{ d.period }}.</p></div></td></tr></ng-template>
            </p-table>
            <p class="cp-note muted"><i class="pi pi-info-circle"></i> Cruza los CFDI recibidos ({{ d.period }}) contra el padrón de proveedores de ContPAQi y la lista negra del SAT. Un CFDI de proveedor <b>EFOS (69B) no es deducible</b> ni acreditable de IVA.</p>
          </div>
        }
      }
      }

      <!-- LC.21: el desglose de cualquier numero de la pantalla, en un panel lateral. -->
      <app-side-peek [open]="!!panel()" (openChange)="cerrarPanel($event)" [width]="760"
                     [title]="tituloPanel()" [subtitle]="subtituloPanel()">
        @if (cargandoPanel() && !panelListo()) { <p class="cp-note muted">Cargando…</p> }
        @if (errorPanel()) { <p class="cp-note bad">No se pudo cargar el detalle.</p> }
        @switch (panel()?.tipo) {
          @case ('renglones') {
            @if (renglones(); as r) {
              <p class="cp-note">
                <strong>{{ r.renglones | number }}</strong> renglones de póliza · cargos <span class="mono">{{ r.cargos | currency:'MXN':'symbol-narrow':'1.2-2' }}</span> · abonos <span class="mono">{{ r.abonos | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>.
                @if (r.cuadra) { <span class="ok">Cuadra con la balanza.</span> }
                @else {
                  <span class="bad">No cuadra con la balanza</span>, que dice cargos <span class="mono">{{ r.balanza.cargos | currency:'MXN':'symbol-narrow':'1.2-2' }}</span> y abonos <span class="mono">{{ r.balanza.abonos | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>: la diferencia está en pólizas que ContPAQi tiene y nosotros no importamos.
                }
              </p>
              <p-table [value]="r.filas" styleClass="p-datatable-sm" [scrollable]="true" scrollHeight="60vh">
                <ng-template #header><tr><th>Mes</th><th>Póliza</th><th class="ta-r">Cargo</th><th class="ta-r">Abono</th><th>Concepto / referencia</th></tr></ng-template>
                <ng-template #body let-f>
                  <tr>
                    <td class="mono">{{ f.anio_mes }}</td>
                    <td class="mono">{{ tipoPoliza(f.tipo_pol) }} {{ f.folio }} · {{ f.num_movto }}</td>
                    <td class="ta-r mono">{{ f.cargo_abono === 'C' ? (f.importe | currency:'MXN':'symbol-narrow':'1.2-2') : '' }}</td>
                    <td class="ta-r mono">{{ f.cargo_abono === 'A' ? (f.importe | currency:'MXN':'symbol-narrow':'1.2-2') : '' }}</td>
                    <td class="muted">{{ f.concepto || f.referencia || '—' }}</td>
                  </tr>
                </ng-template>
              </p-table>
              @if (r.filas.length < r.renglones) {
                <p class="cp-note muted">Mostrando {{ r.filas.length }} de {{ r.renglones | number }} <button type="button" class="cp-link" [disabled]="cargandoPanel()" (click)="masPanel()">Cargar más</button></p>
              }
            }
          }
          @case ('movs') {
            @if (movimientos(); as m) {
              <p class="cp-note">
                <strong>{{ m.movs | number }}</strong> movimientos
                @if (m.flujo !== 'retiro') { · depósitos <span class="mono">{{ m.depositos | currency:'MXN':'symbol-narrow':'1.2-2' }}</span> }
                @if (m.flujo !== 'deposito') { · retiros <span class="mono">{{ m.retiros | currency:'MXN':'symbol-narrow':'1.2-2' }}</span> }
              </p>
              <p-table [value]="m.filas" styleClass="p-datatable-sm" [scrollable]="true" scrollHeight="60vh">
                <ng-template #header><tr><th>Fecha</th>@if (!m.cuenta) { <th>Banco</th> }<th>Tipo</th><th class="ta-r">Importe</th><th>Concepto</th><th>Póliza</th></tr></ng-template>
                <ng-template #body let-f>
                  <tr>
                    <td class="mono">{{ f.fecha || '—' }}</td>
                    @if (!m.cuenta) { <td>{{ f.banco }}</td> }
                    <td>{{ f.flujo === 'deposito' ? 'Depósito' : 'Retiro' }}@if (f.conciliado) { <span class="muted"> · conciliado</span> }</td>
                    <td class="ta-r mono">{{ f.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                    <td class="muted">{{ f.concepto || f.referencia || '—' }}</td>
                    <td class="mono muted">{{ f.poliza || '—' }}</td>
                  </tr>
                </ng-template>
              </p-table>
              @if (m.filas.length < m.movs) {
                <p class="cp-note muted">Mostrando {{ m.filas.length }} de {{ m.movs | number }} <button type="button" class="cp-link" [disabled]="cargandoPanel()" (click)="masPanel()">Cargar más</button></p>
              }
            }
          }
          @case ('cfdis') {
            @if (cfdiAbierto(); as u) {
              <button type="button" class="cp-link" (click)="cfdiAbierto.set(null)">‹ Volver a la lista</button>
              <app-cfdi-visor [uuid]="u" />
            } @else if (cfdisProv(); as c) {
              <p class="cp-note"><strong>{{ c.num_cfdis }}</strong> CFDI en {{ c.period }} por <span class="mono">{{ c.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</span> (recibidos, ingreso o egreso, no cancelados).</p>
              <p-table [value]="c.cfdis" styleClass="p-datatable-sm" [scrollable]="true" scrollHeight="60vh">
                <ng-template #header><tr><th>Folio</th><th>Fecha</th><th>Tipo</th><th class="ta-r">Total</th><th>SAT</th></tr></ng-template>
                <ng-template #body let-x>
                  <tr>
                    <td><button type="button" class="cp-link mono" (click)="cfdiAbierto.set(x.uuid)" [attr.aria-label]="'Ver la factura ' + (x.folio || x.uuid)">{{ x.serie || '' }} {{ x.folio || (x.uuid | slice:0:8) }}</button></td>
                    <td class="mono">{{ x.fecha || '—' }}</td>
                    <td>{{ x.tipo === 'E' ? 'Egreso' : 'Ingreso' }}@if (x.metodo_pago) { <span class="muted"> · {{ x.metodo_pago }}</span> }</td>
                    <td class="ta-r mono">{{ x.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                    <td class="muted">{{ x.estatus_sat }}</td>
                  </tr>
                </ng-template>
              </p-table>
            }
          }
        }
      </app-side-peek>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .ta-r { text-align: right; }
    .muted { color: var(--text-muted); }
    .bad { color: var(--bad-fg); }
    .ok { color: var(--ok-fg); }
    .cp-tablewrap { padding: 0; overflow: hidden; }
    .cp-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: var(--sp-3); margin-bottom: var(--sp-3); }
    .cp-kpi { display: flex; flex-direction: column; gap: 2px; padding: var(--sp-3); background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md, 8px); border-left: 3px solid var(--border-color); }
    .cp-kpi.bad { border-left-color: var(--bad-fg); }
    .cp-kpi.warn { border-left-color: var(--warn-fg, #d97706); }
    .cp-kpi-label { font-size: var(--fs-2xs, .7rem); text-transform: uppercase; letter-spacing: .04em; color: var(--text-faint); font-weight: 700; }
    .cp-kpi-val { font-size: var(--fs-lg, 1.15rem); font-weight: 700; color: var(--text-main); }
    .cp-kpi-sub { font-size: var(--fs-xs); }
    .cp-tabletop { display: flex; align-items: center; justify-content: space-between; padding: var(--sp-3) var(--sp-3) 0; }
    .cp-h3 { font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); margin: 0; }
    .cp-tag.warn { background: color-mix(in srgb, var(--warn-fg, #d97706) 16%, transparent); color: var(--warn-fg, #d97706); }
    .col-riesgo { width: 5.5rem; }
    .cp-key { font-weight: 500; color: var(--text-main); }
    .cp-note { font-size: var(--fs-xs); margin: var(--sp-2) var(--sp-3) var(--sp-3); }
    .cp-controls { display: flex; align-items: center; gap: var(--sp-2); margin: var(--sp-3) 0; }
    .cp-controls label { display: inline-flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-xs); color: var(--text-muted); }
    :host ::ng-deep .cp-sel.p-select { font-size: var(--fs-sm); }
    .cp-seg { display: flex; gap: 2px; margin: var(--sp-3) 0; padding: 4px; background: var(--surface-ground); border: 1px solid var(--border-color); border-radius: var(--r-pill); overflow-x: auto; }
    .cp-seg button { display: inline-flex; align-items: center; gap: var(--sp-1); background: none; border: none; border-radius: var(--r-pill); color: var(--text-muted); font: inherit; font-size: var(--fs-sm); font-weight: 500; padding: var(--sp-1) var(--sp-3); cursor: pointer; white-space: nowrap; transition: background-color 200ms ease, color 200ms ease; }
    .cp-seg button:not(.active):hover { color: var(--text-main); }
    .cp-seg button.active { color: var(--action); background: var(--card-bg); box-shadow: 0 1px 2px rgba(0,0,0,0.06); }
    .cp-seg button:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    .cp-verdict { display: flex; align-items: flex-start; gap: var(--sp-3); margin-bottom: var(--sp-3); border-left: 3px solid var(--border-color); }
    .cp-verdict.bad { border-left-color: var(--bad-fg); }
    .cp-verdict > i { font-size: 1.4rem; color: var(--text-faint); margin-top: 2px; }
    .cp-verdict.bad > i { color: var(--bad-fg); }
    .cp-verdict-h { font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); }
    .cp-check { margin-left: auto; display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--text-muted); white-space: nowrap; }
    .cp-tag { display: inline-block; font-size: var(--fs-2xs, .7rem); font-weight: 700; padding: 1px var(--sp-2); border-radius: var(--r-pill); background: color-mix(in srgb, var(--text-faint) 15%, transparent); color: var(--text-muted); }
    .cp-tag.crit { background: color-mix(in srgb, var(--bad-fg) 15%, transparent); color: var(--bad-fg); }
    .cp-efos > td { background: color-mix(in srgb, var(--bad-fg) 5%, transparent); }
    .cp-skel { display: flex; flex-direction: column; gap: var(--sp-2); margin-top: var(--sp-4); }
    .cp-skel-row { height: var(--row-h-md, 40px); border-radius: var(--r-sm); background: var(--hover-bg); animation: cp-pulse 1.4s ease-in-out infinite; }
    @keyframes cp-pulse { 0%,100% { opacity: .5; } 50% { opacity: .9; } }
    @media (prefers-reduced-motion: reduce) { .cp-skel-row { animation: none; } }
    .surf-empty { display: flex; flex-direction: column; align-items: center; gap: var(--sp-2); padding: var(--sp-8); color: var(--text-muted); }
    .surf-empty i { font-size: 1.5rem; }
    .col-lista { width: 5rem; }
    /* LC.21: lo que se abre. Botones que se leen como el numero de siempre, con foco y cursor. */
    .cp-link { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; text-decoration: underline dotted; text-underline-offset: 3px; }
    .cp-link:hover { text-decoration: underline; }
    .cp-link:focus-visible, .cp-kpi-btn:focus-visible, .cp-row-btn:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .cp-kpi-btn { font: inherit; text-align: left; cursor: pointer; }
    .cp-kpi-btn.sel { box-shadow: inset 0 0 0 1px var(--action); }
    .cp-row-btn { cursor: pointer; }
    .cp-crumb { font-size: var(--fs-xs); color: var(--text-muted); display: inline-flex; gap: var(--sp-2); align-items: baseline; }
  `],
})
export class ContabilidadContpaqiComponent implements OnInit {
  private readonly api = inject(ContabilidadContpaqiService);
  private readonly destroyRef = inject(DestroyRef);

  readonly VIEWS: { key: View; label: string; icon: string }[] = [
    { key: 'balanza', label: 'Balanza', icon: 'pi pi-book' },
    { key: 'bancos', label: 'Bancos', icon: 'pi pi-wallet' },
    { key: 'efos', label: 'Proveedores SAT', icon: 'pi pi-shield' },
    { key: 'cfdi', label: 'CFDI vs Contab.', icon: 'pi pi-file-check' },
    { key: 'libros', label: 'Libros vs Operación', icon: 'pi pi-chart-line' },
  ];

  readonly view = signal<View>('balanza');
  readonly loading = signal(false);
  readonly balanza = signal<BalanzaResp | null>(null);
  readonly bank = signal<BankResp | null>(null);
  readonly efos = signal<EfosResp | null>(null);
  readonly libros = signal<LibrosVsOpResp | null>(null);
  readonly cfdi = signal<CfdiVsContabResp | null>(null);
  readonly balanzaBy = signal<BalanzaGroupBy>('familia');
  readonly bankBy = signal<BankGroupBy>('banco');
  readonly soloEfos = signal(false);
  readonly soloRiesgoCfdi = signal(false);
  readonly period = signal<string>(this.currentPeriod());
  readonly periodOpts = this.buildPeriods();

  readonly balanzaGroups = [
    { label: 'Familia', value: 'familia' }, { label: 'Cuenta', value: 'cuenta' },
    { label: 'Mes', value: 'mes' }, { label: 'Agrupador SAT', value: 'agrupador_sat' },
  ];
  readonly bankGroups = [{ label: 'Banco', value: 'banco' }, { label: 'Mes', value: 'mes' }];

  ngOnInit(): void { this.load(); }

  go(v: View): void { if (v === this.view()) return; this.view.set(v); this.load(); }
  setBalanzaBy(v: BalanzaGroupBy): void { this.balanzaBy.set(v); this.balanzaFiltro.set(null); this.load(); }
  setBankBy(v: BankGroupBy): void { this.bankBy.set(v); this.load(); }
  setSoloEfos(v: boolean): void { this.soloEfos.set(v); this.load(); }
  setPeriod(v: string): void { this.period.set(v); this.load(); }
  setSoloRiesgoCfdi(v: boolean): void { this.soloRiesgoCfdi.set(v); }

  cfdiRows(d: CfdiVsContabResp) {
    const f = this.filtroRiesgo();
    const rs = f === 'todos' ? d.rows : d.rows.filter((r) => r.riesgo === f);
    return this.soloRiesgoCfdi() ? rs.filter((r) => r.riesgo !== 'ok') : rs;
  }

  /* ── LC.21: desglose ────────────────────────────────────────────────────────────────── */
  readonly cargandoMas = signal(false);
  readonly balanzaFiltro = signal<FiltroBalanza | null>(null);
  /** La columna que se pinta: con un grupo abierto, la balanza muestra sus cuentas. */
  readonly balanzaGrupoVisible = computed(() => (this.balanzaFiltro() ? 'cuenta' : this.balanzaBy()));
  readonly filtroRiesgo = signal<'todos' | Exclude<CfdiRiesgo, 'ok'>>('todos');
  readonly etiquetaRiesgo = computed(() => ({ todos: 'todos', efos: 'EFOS (69B)', lista69: 'Art. 69 CFF', no_registrado: 'sin alta en ContPAQi' })[this.filtroRiesgo()]);
  readonly panel = signal<Panel | null>(null);
  readonly cargandoPanel = signal(false);
  readonly errorPanel = signal(false);
  readonly renglones = signal<BalanzaRenglones | null>(null);
  readonly movimientos = signal<BankMovimientos | null>(null);
  readonly cfdisProv = signal<CfdisProveedor | null>(null);
  readonly cfdiAbierto = signal<string | null>(null);
  readonly panelListo = computed(() => !!(this.renglones() || this.movimientos() || this.cfdisProv()));
  readonly tituloPanel = computed(() => {
    const p = this.panel();
    return !p ? '' : p.tipo === 'renglones' ? 'Renglones de póliza' : p.tipo === 'movs' ? 'Movimientos bancarios' : 'CFDI del proveedor';
  });
  readonly subtituloPanel = computed(() => {
    const p = this.panel();
    if (!p) return null;
    if (p.tipo === 'renglones') return `${p.cuenta} · ${p.nombre}${p.from_mes ? ` · ${p.from_mes} → ${p.to_mes}` : ''}`;
    if (p.tipo === 'movs') return p.etiqueta;
    return `${p.nombre} · ${p.rfc} · ${p.period}`;
  });

  filtrarRiesgo(f: 'todos' | Exclude<CfdiRiesgo, 'ok'>): void { this.filtroRiesgo.set(f); }
  tipoPoliza(t: string): string { return ({ '1': 'Ingreso', '2': 'Egreso', '3': 'Diario' } as Record<string, string>)[t] ?? `Tipo ${t}`; }

  /** Una fila de la balanza: un grupo abre sus cuentas; una cuenta, sus renglones de póliza. */
  abrirBalanza(r: BalanzaRow): void {
    const by = this.balanzaFiltro() ? 'cuenta' : this.balanzaBy();
    const clave = r.clave ?? '';
    if (!clave) return;
    if (by === 'cuenta') {
      const f = this.balanzaFiltro(); const b = this.balanza();
      const nombre = String(r.cuenta ?? clave).replace(clave, '').trim();
      this.abrirPanel({ tipo: 'renglones', cuenta: clave, nombre,
        from_mes: f?.mes ?? b?.from_mes, to_mes: f?.mes ?? b?.to_mes });
      return;
    }
    const etiqueta = String((r as unknown as Record<string, unknown>)[by] ?? clave);
    this.balanzaFiltro.set(by === 'familia' ? { familia: clave, etiqueta } : by === 'mes' ? { mes: clave, etiqueta } : { agrupador_sat: clave, etiqueta });
    this.load();
  }
  quitarFiltroBalanza(): void { this.balanzaFiltro.set(null); this.load(); }
  /** «Libros (ContPAQi)» de un mes = abonos − cargos de la familia 4: esas cuentas, en la balanza. */
  verLibrosMes(mes: string): void {
    this.view.set('balanza');
    this.balanzaFiltro.set({ familia: '4', mes, etiqueta: `4 Ingresos · ${mes}` });
    this.load();
  }

  verMovimientos(r: BankRow, flujo: 'deposito' | 'retiro' | null): void {
    const porMes = this.bankBy() === 'mes';
    const quien = porMes ? String(r.mes) : String(r.banco);
    this.abrirPanel({ tipo: 'movs', cuenta: porMes ? null : (r.cuenta ?? null), mes: porMes ? (r.mes ?? null) : null, flujo,
      etiqueta: `${quien}${flujo ? (flujo === 'deposito' ? ' · depósitos' : ' · retiros') : ''}` });
  }
  verCfdis(period: string, rfc: string, nombre: string): void { this.abrirPanel({ tipo: 'cfdis', period, rfc, nombre }); }

  cerrarPanel(abierto: boolean): void {
    if (abierto) return;
    this.panel.set(null); this.renglones.set(null); this.movimientos.set(null); this.cfdisProv.set(null); this.cfdiAbierto.set(null);
  }
  private abrirPanel(p: Panel): void {
    this.cerrarPanel(false);
    this.panel.set(p);
    this.pedirPanel(1);
  }
  masPanel(): void {
    const r = this.renglones(); const m = this.movimientos();
    this.pedirPanel((r?.page ?? m?.page ?? 1) + 1);
  }
  private pedirPanel(page: number): void {
    const p = this.panel(); if (!p) return;
    this.cargandoPanel.set(true); this.errorPanel.set(false);
    const mismo = () => this.panel() === p;
    const fin = () => this.cargandoPanel.set(false);
    const fallo = () => { fin(); if (mismo()) this.errorPanel.set(true); };
    if (p.tipo === 'renglones') {
      this.api.balanzaRenglones({ cuenta: p.cuenta, from_mes: p.from_mes, to_mes: p.to_mes, page }).pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({ next: (d) => { fin(); if (!mismo()) return; const prev = page > 1 ? this.renglones()?.filas ?? [] : []; this.renglones.set({ ...d, filas: [...prev, ...d.filas] }); }, error: fallo });
    } else if (p.tipo === 'movs') {
      const b = this.bank();
      this.api.bankMovimientos({ cuenta: p.cuenta, mes: p.mes, flujo: p.flujo, from_mes: p.mes ? undefined : b?.from_mes, to_mes: p.mes ? undefined : b?.to_mes, page })
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({ next: (d) => { fin(); if (!mismo()) return; const prev = page > 1 ? this.movimientos()?.filas ?? [] : []; this.movimientos.set({ ...d, filas: [...prev, ...d.filas] }); }, error: fallo });
    } else {
      this.api.cfdisProveedor(p.period, p.rfc).pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({ next: (d) => { fin(); if (mismo()) this.cfdisProv.set(d); }, error: fallo });
    }
  }

  /** «Cargar más»: la página siguiente del mismo pedido, pegada a lo que ya se ve. */
  masBalanza(): void {
    const b = this.balanza(); if (!b) return;
    this.cargandoMas.set(true);
    this.api.balanza({ ...this.pedidoBalanza(), offset: b.rows.length, limit: 100 }).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (r) => { this.cargandoMas.set(false); this.balanza.set({ ...r, rows: [...b.rows, ...r.rows] }); }, error: () => this.cargandoMas.set(false) });
  }
  masBancos(): void {
    const b = this.bank(); if (!b) return;
    this.cargandoMas.set(true);
    this.api.bank({ group_by: this.bankBy(), offset: b.rows.length }).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (r) => { this.cargandoMas.set(false); this.bank.set({ ...r, rows: [...b.rows, ...r.rows] }); }, error: () => this.cargandoMas.set(false) });
  }
  masEfos(): void {
    const e = this.efos(); if (!e) return;
    this.cargandoMas.set(true);
    this.api.efos({ solo_69b: this.soloEfos(), offset: e.rows.length }).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (r) => { this.cargandoMas.set(false); this.efos.set({ ...r, rows: [...e.rows, ...r.rows] }); }, error: () => this.cargandoMas.set(false) });
  }
  private pedidoBalanza(): Parameters<ContabilidadContpaqiService['balanza']>[0] {
    const f = this.balanzaFiltro();
    if (!f) return { group_by: this.balanzaBy() };
    return { group_by: 'cuenta', familia: f.familia, agrupador_sat: f.agrupador_sat, from_mes: f.mes, to_mes: f.mes };
  }

  private currentPeriod(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  private buildPeriods(): { label: string; value: string }[] {
    const out: { label: string; value: string }[] = [];
    const d = new Date();
    for (let i = 0; i < 12; i++) {
      const dt = new Date(d.getFullYear(), d.getMonth() - i, 1);
      out.push({ label: `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`, value: `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}` });
    }
    return out;
  }

  private load(): void {
    this.loading.set(true);
    const done = () => this.loading.set(false);
    const v = this.view();
    if (v === 'balanza') {
      this.api.balanza(this.pedidoBalanza()).pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({ next: (r) => { this.balanza.set(r); done(); }, error: done });
    } else if (v === 'bancos') {
      this.api.bank({ group_by: this.bankBy() }).pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({ next: (r) => { this.bank.set(r); done(); }, error: done });
    } else if (v === 'efos') {
      this.api.efos({ solo_69b: this.soloEfos() }).pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({ next: (r) => { this.efos.set(r); done(); }, error: done });
    } else if (v === 'cfdi') {
      this.api.cfdiVsContab(this.period()).pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({ next: (r) => { this.cfdi.set(r); done(); }, error: done });
    } else {
      this.api.librosVsOperacion().pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({ next: (r) => { this.libros.set(r); done(); }, error: done });
    }
  }
}
