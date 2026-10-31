import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { coincideBusqueda } from '@megadulces/ui-web';
import { environment } from '../../../../../environments/environment';
import { MetricStripComponent, MetricStripItem } from '../../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../../shared/components/freshness-pill/freshness-pill.component';
import { LoadStateComponent } from '../../../../shared/components/load-state/load-state.component';
import { ContextHelpComponent } from '../../../../shared/context-help/context-help.component';
import { SegmentedComponent, type SegOption } from '../../../../shared/components/segmented/segmented.component';
import { SortState, toggleSort, sortIcon, ariaSort, sortRows } from '../../../../shared/util';
import { exportXlsx, XlsxSheet } from '../../../../shared/export/xlsx-export';
import { FINANZAS_SHARED_STYLES } from '../finanzas-shared.styles';
import { CajaTabsComponent } from '../../caja-tabs.component';
import { money, dmy } from '../finanzas-format';
import { diaMxDeInstante } from '@megadulces/contracts';

/**
 * `[CGA-A.66]` De qué está hecho cada día: cuadra · sólo falta capturar lo que está en la cola ·
 * no cuadra aunque se capture la cola · Kepler no tiene nada ese día. Opcional porque un servidor
 * anterior al despliegue no lo manda; entonces se deriva de `cuadra`.
 */
type EstadoDia = 'sin_kepler' | 'cuadra' | 'por_capturar' | 'no_cuadra';
interface DiaCuadre {
  fecha: string; caja_fuente?: 'control' | 'libro';
  mdb_ingreso: number; mdb_gasto: number; mdb_n: number; kp_ingreso: number; kp_gasto: number; kp_n: number;
  delta_kep_ingreso: number; delta_kep_gasto: number; tol: number; sin_kepler: boolean; cuadra: boolean;
  estado?: EstadoDia; cola_n?: number; cola_ingreso?: number; cola_gasto?: number; resto_ingreso?: number; resto_gasto?: number;
}
interface CajaWb {
  period: { from: string; to: string };
  /** `[CGA-A.66]` Edad de Kepler y de la cola (el carril ods_live_caja). `null` = sin medir. */
  datos_al?: string | null;
  totals: {
    mdb_ingreso: number; mdb_gasto: number; kp_ingreso: number; kp_gasto: number; delta_kep_ingreso: number; delta_kep_gasto: number;
    dias: number; dias_con_kepler: number; dias_descuadre: number; kep_disponible: boolean;
    dias_por_capturar?: number; dias_no_cuadra?: number;
    cola?: { disponible: boolean; n: number; ingreso: number; gasto: number };
    libro_desde?: string | null; dias_libro?: number; ruta_disponible?: boolean;
  };
  por_dia: DiaCuadre[];
  eps: number; eps_total: number;
}
type MovSource = 'control' | 'workbook' | 'kepler' | 'ruta' | 'libro';
interface EnLibro { folio: string; estado: string; via: 'vinculo' | 'declarado' }
interface OrphanMov { id: string; source: MovSource; key: string; fecha: string; importe: number; concepto: string | null; extra: string | null; dir?: 'in' | 'out'; en_libro?: EnLibro | null }
interface ReconSide { other_only: OrphanMov[] }
interface DiaRow {
  id: string; key: string; fecha: string; dir: 'in' | 'out'; importe: number; concepto: string | null; extra: string | null;
  source?: 'control' | 'libro';
  kepler: boolean; kepler_importe: number | null; kepler_ref: string | null; kepler_key: string | null;
  kepler_origen: 'identidad' | 'llave' | 'importe' | 'ruta' | null; kepler_source: MovSource | null; kepler_motivo: string | null;
  kepler_ambiguo: boolean; kepler_delta: number | null;
}
interface DiaTotals {
  control_n: number; en_kepler: number;
  kepler_only_en_libro_n?: number; kepler_only_en_libro_monto?: number;
  kepler_only_pendiente_n?: number; kepler_only_pendiente_monto?: number;
  ruta_cobros_disponible?: boolean;
  kepler_ambiguos_n: number; kepler_disponible: boolean; tolerancia: number;
  ruta_declarados: number; ruta_casados: number; ruta_sin_venta: number; ruta_no_reconocidas: string[];
  kepler_por_identidad: number; caja_fuente?: 'control' | 'libro' | 'mixto'; kepler_por_llave?: number;
}
interface ConcDia { vs_kepler: { ingresos: ReconSide; gastos: ReconSide }; rows: DiaRow[]; totals: DiaTotals }
interface MovDetail { source: MovSource; title: string; fields: { label: string; value: string | number | null }[] }
interface Facets { meses: string[]; relevo?: { control_ultimo_fecha: string | null; libro_desde: string | null } }

/**
 * ⭐⭐ `[CGA-A.67]` **El Cuadre de la caja, en las pestañas de Caja.**
 *
 * Vivía como una vista de `/finanzas/caja`, que se llama «Control (histórico)» y es el espejo del
 * Access. Pero desde el 12-oct lo que compara es **el libro nuevo contra Kepler**: era la única
 * revisión diaria del libro y quedaba fuera de la barra de quien opera la caja (Captura · Arqueos ·
 * Caja Fuerte), detrás de un nombre que decía «histórico».
 *
 * Las cinco preguntas (skill diseno §0b), contestadas antes de escribirla:
 *  1. Qué ve primero: el veredicto partido (cuadra / falta capturar / no cuadra) con su dinero, y los
 *     días del más nuevo al más viejo.
 *  2. Qué no: el rojo por trabajo que ya está en la cola — eso es ámbar y lleva a la cola.
 *  3. Accesibilidad: el estado se dice con texto, no sólo con color; cada cifra del veredicto filtra
 *     la tabla; el día abre su detalle con un clic.
 *  4. Liga: la cola es la canónica de Captura (la misma consulta), no una copia.
 *  5. Le toca: es la revisión del libro de caja, así que vive con la caja.
 *
 * Jerarquía: primario = el veredicto · secundario = días por estado y el control-total ·
 * terciario = las diferencias de cada día.
 */
/** El mes en curso en México (YYYY-MM): el reloj del navegador en UTC cambia de mes seis horas antes. */
const mesMx = (): string => (diaMxDeInstante(new Date()) ?? new Date().toISOString()).slice(0, 7);

@Component({
  selector: 'app-finanzas-caja-cuadre',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, RouterLink, ButtonModule, TableModule, SelectModule, TagModule, DialogModule,
    MetricStripComponent, FreshnessPillComponent, LoadStateComponent, ContextHelpComponent, SegmentedComponent, CajaTabsComponent],
  template: `
    <app-caja-tabs />
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Cuadre de Caja General</h1>
          <p class="surf-page-sub">La caja contra la Caja General de Kepler, día por día.</p>
        </div>
        <div class="cc-acciones">
          <app-context-help topic="caja-cuadre" />
          <app-freshness-pill measures="data" [since]="wbc()?.datos_al ?? null" label="Kepler" />
          <p-select [options]="meses()" [ngModel]="month()" (onChange)="onMonth($event.value)" placeholder="Mes"
                    styleClass="cc-sel" ariaLabel="Mes" />
          <p-button size="small" icon="pi pi-refresh" severity="secondary" [text]="true" label="Actualizar"
                    [loading]="loading()" (onClick)="reload()" />
        </div>
      </header>

      <app-load-state [loading]="loading() && !wbc()" [error]="err()" [isEmpty]="!!wbc() && !wbc()!.por_dia.length"
                      errorTitle="No se pudo leer el cuadre" emptyTitle="Sin movimientos en el mes" (retry)="reload()">
        @if (wbc(); as d) {
          <!-- Primario: la respuesta en una frase. El color no la carga sola: el texto dice cuál es cuál. -->
          <p class="cc-veredicto" [class.cc-veredicto--mal]="cuenta(d).no_cuadra > 0">{{ verdict(d) }}</p>

          <!-- Secundario: los dias por estado. Cada cifra filtra la tabla de abajo (desglose). -->
          <app-metric-strip [items]="kpis(d)" ariaLabel="Días del mes por estado" density="compact"
                            [instant]="true" (drill)="setEstado($event)" />

          @if (d.totals.cola && !d.totals.cola.disponible) {
            <p class="cc-aviso" role="status"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
              No se pudo leer la cola de Captura: ningún día se marca «falta capturar», así que lo que esperaba captura sale como «no cuadra».</p>
          }

          <div class="card-premium card-flat tw-card">
            <h2 class="tw-card-title">Total del mes <span class="muted">— caja contra Kepler en {{ month() }} (tolerancia ±{{ money(roundTol(monthN(d))) }}: 10 centavos por movimiento)</span></h2>
            <div class="tw-wrap">
              <table class="tw-tbl">
                <thead>
                  <tr>
                    <th scope="col"><span class="sr-only">Concepto</span></th>
                    <th scope="col" class="ta-r">Caja</th>
                    <th scope="col" class="ta-r">Kepler</th>
                    <th scope="col" class="ta-r">Diferencia</th>
                    <th scope="col" class="ta-c">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of ctRows(d); track row.label) {
                    <tr>
                      <th scope="row">{{ row.label }} <span class="muted">({{ row.dir==='in' ? 'entra' : 'sale' }})</span></th>
                      <td class="ta-r num">{{ money(row.control) }}</td>
                      <td class="ta-r num">{{ row.kep_ok ? money(row.kepler) : '—' }}</td>
                      <td class="ta-r num" [class.bad]="row.kep_ok && !row.cuadra">{{ row.kep_ok ? money(row.d_ck) : '—' }}</td>
                      <td class="ta-c">
                        @if (!row.kep_ok) { <p-tag value="sin Kepler" severity="secondary" styleClass="cg-tag" /> }
                        @else if (row.cuadra) { <span class="ok"><i class="pi pi-check" aria-hidden="true"></i> cuadra</span> }
                        @else { <span class="bad"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> no cuadra</span> }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            <p class="tw-note muted">
              <b>Caja</b> = hasta el día anterior al primer corte del libro, el Control (Access); desde ese día, el libro nuevo, por la fecha del documento.
              <b>Kepler</b> = Caja General del ERP más los cobros de camioneta.
              @if (!d.totals.kep_disponible) { <b> Sin Kepler en el periodo.</b> }
              @if (d.totals.ruta_disponible === false) { <b> No se pudieron leer los cobros de camioneta: la columna Kepler está incompleta.</b> }
            </p>
          </div>

          <div class="card-premium card-flat tw-tablewrap">
            <h2 class="tw-card-title tw-pnl-title">Por día <span class="muted">— clic en un día para ver qué movimientos faltan de cada lado</span></h2>
            <div class="cc-filtros">
              <app-segmented [options]="opcionesEstado(d)" [value]="estado()" (valueChange)="setEstado($event)" ariaLabel="Estado del día" />
              <app-segmented [options]="opcionesDir" [value]="cuadreDir()" (valueChange)="setDir($event)" ariaLabel="Dirección (se hereda al abrir el día)" />
            </div>
            <p-table [value]="diasVista(d)" size="small" dataKey="fecha" [rowHover]="true" selectionMode="single" [metaKeySelection]="false"
                     (onRowSelect)="alElegir($event.data)" (onRowUnselect)="alElegir($event.data)" class="surf-table surf-table--plain surf-table--sticky surf-table--frozen-first">
              <ng-template #header>
                <tr>
                  <th class="cg-w-date">Día</th>
                  @if (cuadreDir() !== 'out') { <th class="ta-r comm-num">Caja entra</th><th class="ta-r comm-num">Kepler entra</th><th class="ta-r comm-num">Diferencia</th> }
                  @if (cuadreDir() !== 'in') { <th class="ta-r comm-num">Caja sale</th><th class="ta-r comm-num">Kepler sale</th><th class="ta-r comm-num">Diferencia</th> }
                  <th class="cc-w-estado">Estado</th>
                </tr>
              </ng-template>
              <ng-template #body let-r>
                <tr [pSelectableRow]="r" class="tw-clickable">
                  <td class="cg-mono">{{ dmy(r.fecha) }} <span class="muted">· {{ r.mdb_n }}</span>@if (r.caja_fuente === 'libro') { <p-tag value="libro" severity="secondary" styleClass="cg-tag" /> }</td>
                  @if (cuadreDir() !== 'out') {
                    <td class="ta-r num comm-num">{{ money(r.mdb_ingreso) }}</td>
                    <td class="ta-r num comm-num">{{ r.kp_n ? money(r.kp_ingreso) : '—' }}</td>
                    <td class="ta-r num comm-num" [class.bad]="fuera(r.delta_kep_ingreso, r)">{{ r.kp_n ? money(r.delta_kep_ingreso) : '—' }}</td>
                  }
                  @if (cuadreDir() !== 'in') {
                    <td class="ta-r num comm-num">{{ money(r.mdb_gasto) }}</td>
                    <td class="ta-r num comm-num">{{ r.kp_n ? money(r.kp_gasto) : '—' }}</td>
                    <td class="ta-r num comm-num" [class.bad]="fuera(r.delta_kep_gasto, r)">{{ r.kp_n ? money(r.delta_kep_gasto) : '—' }}</td>
                  }
                  <td class="cc-w-estado">
                    @switch (estadoDe(r)) {
                      @case ('sin_kepler') { <p-tag value="sin Kepler" severity="secondary" styleClass="cg-tag" /> }
                      @case ('cuadra') { <span class="ok"><i class="pi pi-check" aria-hidden="true"></i> cuadra</span> }
                      @case ('por_capturar') {
                        <a routerLink="/finanzas/caja-general" class="cc-cola" (click)="$event.stopPropagation()"
                           [attr.aria-label]="'Falta capturar ' + (r.cola_n ?? 0) + ' movimientos del día: ir a la cola'">
                          <p-tag value="falta capturar" severity="warn" styleClass="cg-tag" />
                          <span class="num">{{ r.cola_n }} · {{ money((r.cola_ingreso ?? 0) + (r.cola_gasto ?? 0)) }}</span>
                        </a>
                      }
                      @default {
                        <p-tag value="no cuadra" severity="danger" styleClass="cg-tag" />
                        @if (r.cola_n) { <span class="muted cc-resto">aun capturando la cola: {{ money(r.resto_ingreso ?? 0) }} / {{ money(r.resto_gasto ?? 0) }}</span> }
                      }
                    }
                  </td>
                </tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="8"><div class="cg-empty"><i class="pi pi-inbox" aria-hidden="true"></i><span>Ningún día con este filtro.</span></div></td></tr></ng-template>
            </p-table>
          </div>
        }
      </app-load-state>
    </div>

    <!-- Detalle del día: lead, tira de conteos, filtros, una fila por movimiento de la caja con su
         par de Kepler, y abajo lo que Kepler tiene y la caja no. -->
    <p-dialog [visible]="dayOpen()" (visibleChange)="dayOpen.set($event)" [modal]="true" [dismissableMask]="true"
              [style]="{ width: '64rem', maxWidth: '96vw' }" [draggable]="false" [header]="dayTitle()">
      @if (wbDayLoad()[dayKey()]) { <div class="cg-empty"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i><span>Casando movimientos del día…</span></div> }
      @else if (wbDayErr()[dayKey()]; as e) { <div class="cg-empty"><i class="pi pi-exclamation-triangle bad" aria-hidden="true"></i><span>{{ e }}</span></div> }
      @else if (wbDayDia()[dayKey()]; as cd) {
        <!-- [CGA-A.69] El borde del relevo sale de los datos (facets.relevo), no de una fecha escrita. -->
        <p class="dlg-lead">Cada movimiento de la <b>caja</b> ({{ textoRelevo() }}) marca si <b>Kepler</b> lo tiene. Abajo, lo que Kepler registra y la caja no tiene.</p>
        <p class="dlg-lead muted">El <b>Control</b> no guarda el folio de Kepler: sus movimientos casan <b>por importe</b>
          ±{{ money(cd.totals.tolerancia) }}, y los marcados con <b>~</b> tenían más de un candidato. El <b>libro</b> sí lo
          guarda: casa por su documento <i class="pi pi-link tw-ident" aria-hidden="true"></i>, y sólo lo capturado sin documento va por importe.
          La <b>venta de ruta</b> casa por identidad (la ruta y el día declarados de los dos lados); si la tesorería no registró el cobro,
          la celda trae la venta del Kepler de la camioneta <i class="pi pi-truck tw-ident" aria-hidden="true"></i>.</p>

        <div class="tw-drill-kpis">
          <span><b>{{ cd.totals.control_n }}</b> movs {{ cd.totals.caja_fuente === 'libro' ? 'del libro' : cd.totals.caja_fuente === 'mixto' ? 'de caja (Control y libro)' : 'Control' }}</span>
          @if (cd.totals.kepler_por_llave) { <span class="ok"><b>{{ cd.totals.kepler_por_llave }}</b> casados por el documento del libro</span> }
          @if (cd.totals.kepler_disponible) { <span class="ok"><b>{{ cd.totals.en_kepler }}</b> en Kepler</span> }
          @else { <span class="muted">Kepler sin datos en el periodo</span> }
          @if (cd.totals.kepler_only_pendiente_n) { <span class="warn"><b>{{ cd.totals.kepler_only_pendiente_n }}</b> de Kepler por capturar ({{ money(cd.totals.kepler_only_pendiente_monto ?? 0) }})</span> }
          @if (cd.totals.kepler_only_en_libro_n) { <span class="ok"><b>{{ cd.totals.kepler_only_en_libro_n }}</b> de Kepler ya en el libro nuevo ({{ money(cd.totals.kepler_only_en_libro_monto ?? 0) }})</span> }
          @if (cd.totals.ruta_cobros_disponible === false) { <span class="warn">no se pudieron leer los cobros de camioneta: la columna Kepler está incompleta</span> }
          @if (cd.totals.kepler_por_identidad) { <span class="ok"><b>{{ cd.totals.kepler_por_identidad }}</b> por identidad</span> }
          @if (cd.totals.ruta_declarados) { <span class="ok"><b>{{ cd.totals.ruta_casados }}</b> de {{ cd.totals.ruta_declarados }} ventas de ruta ligadas</span> }
          @if (cd.totals.ruta_sin_venta) { <span class="warn"><b>{{ cd.totals.ruta_sin_venta }}</b> sin venta en la ruta</span> }
          @if (cd.totals.ruta_no_reconocidas.length) { <span class="warn">ruta no reconocida: {{ cd.totals.ruta_no_reconocidas.join(', ') }}</span> }
          @if (cd.totals.kepler_ambiguos_n) { <span class="warn"><b>{{ cd.totals.kepler_ambiguos_n }}</b> casamientos ambiguos</span> }
        </div>

        <div class="tw-drill-filters">
          <div class="tw-fg" role="group" aria-label="Dirección">
            <button type="button" [class.on]="dfDir()===''" (click)="dfDir.set('')">Todos</button>
            <button type="button" [class.on]="dfDir()==='in'" (click)="dfDir.set('in')">Ingresos</button>
            <button type="button" [class.on]="dfDir()==='out'" (click)="dfDir.set('out')">Gastos</button>
          </div>
          <div class="tw-fg" role="group" aria-label="Estado">
            <button type="button" [class.on]="dfEstado()===''" (click)="dfEstado.set('')">Todos</button>
            <button type="button" [class.on]="dfEstado()==='casado'" (click)="dfEstado.set('casado')">Con Kepler</button>
            <button type="button" [class.on]="dfEstado()==='descuadre'" (click)="dfEstado.set('descuadre')">Sin Kepler</button>
          </div>
          <input type="text" class="tw-fsearch" [ngModel]="dfSearch()" (ngModelChange)="dfSearch.set($event)" placeholder="Buscar concepto / monto…" aria-label="Buscar" />
          <span class="muted tw-fcount">{{ dayRows(cd).length }} de {{ cd.rows.length }}</span>
          <button type="button" class="tw-xls" [disabled]="exporting()" (click)="exportDay(cd)">
            <i class="pi" [class.pi-file-excel]="!exporting()" [class.pi-spin]="exporting()" [class.pi-spinner]="exporting()" aria-hidden="true"></i> Excel
          </button>
        </div>

        <div class="tw-wrap">
          <table class="tw-tbl tw-drill-tbl">
            <thead><tr>
              @for (c of DAY_COLS; track c.field) {
                <th [class]="c.cls" [attr.aria-sort]="ariaSort(daySort(), c.field)">
                  <button type="button" class="surf-sort" (click)="sortDay(c.field)" [attr.aria-label]="'Ordenar por ' + c.label">
                    {{ c.label }}<i [class]="sortIcon(daySort(), c.field)" aria-hidden="true"></i>
                  </button>
                </th>
              }
            </tr></thead>
            <tbody>
              @for (e of dayRows(cd); track e.key + e.dir) {
                <tr>
                  <td class="cg-mono muted">{{ dmy(e.fecha) }}</td>
                  <td class="ta-c"><i [class]="e.dir === 'in' ? 'pi pi-arrow-down-left tw-in-ico' : 'pi pi-arrow-up-right tw-out-ico'" aria-hidden="true"></i><span class="sr-only">{{ e.dir === 'in' ? 'Ingreso' : 'Gasto' }}</span></td>
                  <td class="ta-r num"><button type="button" class="tw-mlink" (click)="openMovement(e.source ?? 'control', e.key)">{{ money(e.importe) }}</button>@if (e.source === 'libro') { <p-tag value="libro" severity="secondary" styleClass="cg-tag" /> }</td>
                  <!-- La virgulilla marca el par que casó teniendo MAS DE UN candidato al mismo importe. -->
                  <td class="ta-r num tw-kep">@if (e.kepler) { <button type="button" class="tw-mlink" [attr.aria-label]="tituloKepler(e)" (click)="openMovement(e.kepler_source!, e.kepler_key)">{{ money(e.kepler_importe ?? 0) }}</button>@if (e.kepler_origen === 'identidad' || e.kepler_origen === 'llave') { <i class="pi pi-link tw-ident" aria-hidden="true"></i> } @else if (e.kepler_origen === 'ruta') { <i class="pi pi-truck tw-ident" aria-hidden="true"></i> } @if (e.kepler_ambiguo) { <span class="tw-amb" aria-label="casamiento ambiguo">~</span> } } @else if (e.kepler_motivo) { <span class="warn"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ e.kepler_motivo }}</span> } @else { <span class="muted">no está</span> }</td>
                  <td class="tw-concept">{{ e.concepto || e.extra || '—' }}</td>
                </tr>
              }
              @if (!dayRows(cd).length) { <tr><td colspan="5" class="ta-c muted tw-empty">Sin movimientos con estos filtros.</td></tr> }
            </tbody>
          </table>
        </div>

        @if (dayOrphans(cd); as orp) {
          @if (orp.length) {
            <div class="tw-orphans">
              <div class="tw-orphan">
                <h3><i class="pi pi-database" aria-hidden="true"></i> En Kepler, sin caja ({{ orp.length }})</h3>
                <table class="tw-tbl"><tbody>
                  @for (m of orp; track m.key) {
                    <tr class="tw-clickable" (click)="openMovement(m.source, m.key)">
                      <td class="ta-c"><i [class]="m.dir === 'in' ? 'pi pi-arrow-down-left tw-in-ico' : 'pi pi-arrow-up-right tw-out-ico'" aria-hidden="true"></i><span class="sr-only">{{ m.dir === 'in' ? 'Ingreso' : 'Egreso' }}</span></td>
                      <td class="ta-r num">{{ money(m.importe) }}</td>
                      <td class="tw-concept">{{ m.concepto || m.extra || '—' }}</td>
                      <td class="ta-r">@if (m.en_libro; as l) { <p-tag [value]="(l.via === 'declarado' ? 'declarado en ' : 'en libro ') + l.folio" severity="success" styleClass="cg-tag" /> } @else { <p-tag value="por capturar" severity="warn" styleClass="cg-tag" /> }</td>
                    </tr>
                  }
                </tbody></table>
              </div>
            </div>
          }
        }
      }
    </p-dialog>

    <p-dialog [visible]="movOpen()" (visibleChange)="movOpen.set($event)" [modal]="true" [dismissableMask]="true"
              [style]="{ width: '34rem', maxWidth: '94vw' }" [draggable]="false" [header]="mov()?.title || 'Movimiento'">
      @if (movLoad()) { <div class="cg-empty"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i><span>Cargando detalle…</span></div> }
      @else if (movErr(); as e) { <div class="cg-empty"><i class="pi pi-exclamation-triangle bad" aria-hidden="true"></i><span>{{ e }}</span></div> }
      @else if (mov(); as m) {
        <dl class="cg-movd">
          @for (f of m.fields; track f.label) {
            @if (f.value !== null && f.value !== '') { <div class="cg-movd-row"><dt>{{ f.label }}</dt><dd>{{ f.value }}</dd></div> }
          }
        </dl>
      }
    </p-dialog>
  `,
  styles: [FINANZAS_SHARED_STYLES, `
    :host { display:block; container-type:inline-size; }
    .surf-page-head { display:flex; justify-content:space-between; align-items:flex-start; gap:var(--sp-4); flex-wrap:wrap; }
    .cc-acciones { display:flex; gap:var(--sp-2); align-items:center; flex-wrap:wrap; }
    :host ::ng-deep .cc-sel { min-width:8.5rem; }
    .cc-veredicto { font-size:var(--fs-lg); font-weight:700; color:var(--text-main); margin:var(--sp-2) 0 0; }
    .cc-veredicto--mal { color:var(--bad-fg); }
    app-metric-strip { display:block; margin:var(--sp-2) 0 var(--sp-3); }
    .cc-aviso { display:flex; gap:var(--sp-2); align-items:center; font-size:var(--fs-sm); color:var(--warn-fg); margin:0 0 var(--sp-3); }
    .cc-filtros { display:flex; gap:var(--sp-3); flex-wrap:wrap; align-items:center; margin:0 0 var(--sp-2); }
    .cc-w-estado { min-width:12rem; }
    .cc-cola { display:inline-flex; gap:var(--sp-2); align-items:center; color:inherit; text-decoration:none; }
    .cc-cola:hover .num, .cc-cola:focus-visible .num { text-decoration:underline; }
    .cc-cola:focus-visible { outline:2px solid var(--action); outline-offset:2px; border-radius:var(--r-sm); }
    .cc-resto { display:block; font-size:var(--fs-xs); }
    .ta-r { text-align:right; } .ta-c { text-align:center; }
    .num, .cg-mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .muted { color:var(--text-muted); }
    .warn { color:var(--warn-fg); font-weight:700; }
    .ok { color:var(--ok-fg); }
    .bad { color:var(--bad-fg); }
    .cg-w-date { width:7rem; }
    :host ::ng-deep .cg-tag { font-size:var(--fs-xs); }
    .cg-empty { display:flex; flex-direction:column; align-items:center; gap:var(--sp-2); padding:var(--sp-8); text-align:center; color:var(--text-muted); }
    .cg-empty .pi { font-size:1.5rem; }
    .tw-mlink { font:inherit; font-variant-numeric:tabular-nums; color:inherit; background:none; border:none; padding:0; cursor:pointer; text-decoration:underline; text-decoration-style:dotted; text-underline-offset:3px; }
    .tw-mlink:hover { color:var(--action); }
    .tw-mlink:focus-visible { outline:2px solid var(--action); outline-offset:2px; border-radius:var(--r-sm); }
    .tw-amb { color:var(--warn-fg); font-weight:700; margin-left:2px; }
    .tw-ident { color:var(--text-muted); font-size:var(--fs-xs); margin-left:4px; }
    .cg-movd { margin:0; }
    .cg-movd-row { display:grid; grid-template-columns:11rem 1fr; gap:var(--sp-2); padding:var(--sp-1) 0; border-bottom:1px solid var(--border-color); }
    .cg-movd-row:last-child { border-bottom:none; }
    .cg-movd-row dt { color:var(--text-muted); font-size:var(--fs-sm); }
    .cg-movd-row dd { margin:0; font-weight:600; font-variant-numeric:tabular-nums; word-break:break-word; }
    @container (max-width: 40rem) { .cg-movd-row { grid-template-columns:1fr; } .cc-w-estado { min-width:0; } }
  `],
})
export class FinanzasCajaCuadreComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly base = `${environment.apiUrl}/finance/caja`;

  readonly money = money;
  readonly dmy = dmy;
  readonly sortIcon = sortIcon;
  readonly ariaSort = ariaSort;

  readonly f = signal<Facets>({ meses: [] });
  readonly month = signal<string | null>(null);
  readonly wbc = signal<CajaWb | null>(null);
  readonly loading = signal(false);
  readonly err = signal<string | null>(null);

  /**
   * `[CGA-A.67]` Los meses del Cuadre: los que las facetas publican, y siempre el mes en curso
   * aunque el Control ya no tenga movimientos de él — el libro sí.
   */
  readonly meses = computed(() => {
    const hoy = mesMx();
    const m = this.f().meses ?? [];
    return m.includes(hoy) ? m : [hoy, ...m];
  });

  ngOnInit(): void {
    this.month.set(mesMx());
    this.http.get<Facets>(`${this.base}/facets`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (f) => this.f.set(f),
      error: () => undefined, // sin facetas queda el mes en curso; el Cuadre no depende de ellas
    });
    this.reload();
  }

  onMonth(v: string | null): void {
    this.month.set(v);
    this.wbc.set(null);
    this.wbDayDia.set({}); this.wbDayErr.set({});
    this.reload();
  }

  reload(): void {
    this.loading.set(true); this.err.set(null);
    const q = this.month() ? `?month=${this.month()}` : '';
    this.http.get<CajaWb>(`${this.base}/conciliacion-workbook${q}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.wbc.set(d); this.loading.set(false); },
      error: (e) => { this.loading.set(false); this.err.set(this.httpMsg(e, '/caja/conciliacion-workbook')); },
    });
  }

  // ── El estado del día y el veredicto ────────────────────────────────────────────────────────

  /** `[CGA-A.66]` El estado que manda el servidor; uno anterior sólo trae `cuadra`, y se deriva. */
  estadoDe(r: DiaCuadre): EstadoDia {
    return r.estado ?? (r.sin_kepler ? 'sin_kepler' : r.cuadra ? 'cuadra' : 'no_cuadra');
  }

  cuenta(d: CajaWb): Record<EstadoDia, number> & { cola_n: number; cola_monto: number; resto: number } {
    const c = { sin_kepler: 0, cuadra: 0, por_capturar: 0, no_cuadra: 0, cola_n: 0, cola_monto: 0, resto: 0 };
    for (const r of d.por_dia) {
      const e = this.estadoDe(r);
      c[e]++;
      if (e === 'por_capturar') { c.cola_n += r.cola_n ?? 0; c.cola_monto += (r.cola_ingreso ?? 0) + (r.cola_gasto ?? 0); }
      // Lo que no cuadra se mide DESPUÉS de capturar la cola: es el dinero sin explicación.
      if (e === 'no_cuadra') c.resto += Math.abs(r.resto_ingreso ?? r.delta_kep_ingreso) + Math.abs(r.resto_gasto ?? r.delta_kep_gasto);
    }
    return c;
  }

  /** Primario: la respuesta en una frase, con su número. */
  verdict(d: CajaWb): string {
    const c = this.cuenta(d);
    const total = c.cuadra + c.por_capturar + c.no_cuadra;
    if (!total) return 'Sin Kepler en el periodo: no hay contra qué cuadrar la caja.';
    const partes = [`${c.cuadra} de ${total} días cuadran con Kepler`];
    if (c.por_capturar) partes.push(`en ${c.por_capturar} sólo falta capturar lo que está en la cola`);
    if (c.no_cuadra) partes.push(`${c.no_cuadra} no ${c.no_cuadra === 1 ? 'cuadra' : 'cuadran'} aunque se capture la cola`);
    return partes.join(' · ') + '.';
  }

  kpis(d: CajaWb): MetricStripItem[] {
    const c = this.cuenta(d);
    const items: MetricStripItem[] = [
      { label: 'Cuadran', value: c.cuadra, format: 'number', tone: 'default', sub: `de ${c.cuadra + c.por_capturar + c.no_cuadra} días con Kepler`, drill: 'cuadra' },
      { label: 'Falta capturar', value: c.por_capturar, format: 'number', tone: c.por_capturar ? 'warn' : 'default',
        sub: c.por_capturar ? `${c.cola_n} movs · ${money(c.cola_monto)} en la cola` : 'nada en la cola', drill: 'por_capturar' },
      { label: 'No cuadran', value: c.no_cuadra, format: 'number', tone: c.no_cuadra ? 'bad' : 'default',
        sub: c.no_cuadra ? `${money(c.resto)} sin explicar` : 'ningún día', drill: 'no_cuadra' },
    ];
    if (c.sin_kepler) items.push({ label: 'Sin Kepler', value: c.sin_kepler, format: 'number', tone: 'muted', sub: 'días sin contra qué medir', drill: 'sin_kepler' });
    return items;
  }

  // ── La tabla por día ───────────────────────────────────────────────────────────────────────

  readonly estado = signal<string>('');
  readonly cuadreDir = signal<'' | 'in' | 'out'>('');
  readonly opcionesDir: SegOption[] = [{ label: 'Ambos', value: '' }, { label: 'Ingresos', value: 'in' }, { label: 'Gastos', value: 'out' }];
  opcionesEstado(d: CajaWb): SegOption[] {
    const c = this.cuenta(d);
    return [
      { label: 'Todos', value: '', count: d.por_dia.length },
      { label: 'Cuadran', value: 'cuadra', count: c.cuadra },
      { label: 'Falta capturar', value: 'por_capturar', count: c.por_capturar },
      { label: 'No cuadran', value: 'no_cuadra', count: c.no_cuadra },
    ];
  }
  setEstado(v: string): void { this.estado.set(this.estado() === v && v ? '' : v); }
  setDir(v: string): void { this.cuadreDir.set(v === 'in' || v === 'out' ? v : ''); }
  diasVista(d: CajaWb): DiaCuadre[] {
    const e = this.estado();
    return e ? d.por_dia.filter((r) => this.estadoDe(r) === e) : d.por_dia;
  }
  /** Una diferencia fuera de la tolerancia del día (la manda el servidor, una sola definición). */
  fuera(delta: number, r: DiaCuadre): boolean { return !!r.kp_n && Math.abs(delta || 0) > r.tol; }

  /** Tolerancia del total del mes: 10 centavos por movimiento del periodo, piso de $2. */
  roundTol(n: number): number { return Math.max(2, 0.10 * (n || 0)); }
  monthN(d: CajaWb): number { return (d.por_dia || []).reduce((s, r) => s + (r.mdb_n || 0), 0); }
  ctRows(d: CajaWb) {
    const t = d.totals, kep = t.kep_disponible, tol = this.roundTol(this.monthN(d));
    const mk = (label: string, dir: 'in' | 'out', control: number, kepler: number, d_ck: number) => ({
      label, dir, control, kepler, kep_ok: kep, d_ck, cuadra: kep && Math.abs(d_ck || 0) <= tol,
    });
    return [
      mk('Ingresos', 'in', t.mdb_ingreso, t.kp_ingreso, t.delta_kep_ingreso),
      mk('Gastos', 'out', t.mdb_gasto, t.kp_gasto, t.delta_kep_gasto),
    ];
  }

  // ── Detalle del día ────────────────────────────────────────────────────────────────────────

  readonly wbDayDia = signal<Record<string, ConcDia>>({});
  readonly wbDayLoad = signal<Record<string, boolean>>({});
  readonly wbDayErr = signal<Record<string, string>>({});
  readonly dayOpen = signal(false);
  readonly dayKey = signal('');
  readonly dfDir = signal<'' | 'in' | 'out'>('');
  readonly dfEstado = signal<'' | 'casado' | 'descuadre'>('');
  readonly dfSearch = signal('');
  readonly daySort = signal<SortState | null>(null);
  readonly exporting = signal(false);
  readonly DAY_COLS = [
    { field: 'fecha', label: 'Fecha', cls: '' },
    { field: 'dir', label: 'Dir', cls: 'ta-c' },
    { field: 'importe', label: 'Caja', cls: 'ta-r' },
    { field: 'kepler_importe', label: 'Kepler', cls: 'ta-r' },
    { field: 'concepto', label: 'Concepto', cls: '' },
  ];

  dayTitle(): string { return this.dayKey() ? `Detalle del día — ${this.dmy(this.dayKey())}` : 'Detalle del día'; }

  /** `[CGA-A.69]` «el Control hasta el 10-oct» estaba escrito a mano; ahora sale de las facetas. */
  textoRelevo(): string {
    const r = this.f().relevo;
    if (r?.control_ultimo_fecha && r.libro_desde) return `el Control hasta el ${this.dmy(r.control_ultimo_fecha)}; desde el ${this.dmy(r.libro_desde)}, el libro nuevo`;
    return 'el Control hasta el relevo; desde el primer corte, el libro nuevo';
  }

  /** La fila elegida con clic, Enter o Espacio (pSelectableRow) abre su día; volver a elegirla también. */
  alElegir(d: DiaCuadre | DiaCuadre[] | undefined): void { if (d && !Array.isArray(d)) this.openDay(d); }

  sortDay(field: string): void { this.daySort.set(toggleSort(this.daySort(), field)); }

  openDay(r: { fecha: string }): void {
    const dk = String(r.fecha).slice(0, 10);
    this.dayKey.set(dk);
    this.dfDir.set(this.cuadreDir()); this.dfEstado.set(''); this.dfSearch.set(''); this.daySort.set(null);
    this.dayOpen.set(true);
    if ((dk in this.wbDayDia()) || this.wbDayLoad()[dk]) return;
    this.wbDayLoad.set({ ...this.wbDayLoad(), [dk]: true });
    this.http.get<ConcDia>(`${this.base}/conciliacion-dia?from=${dk}&to=${dk}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.wbDayDia.set({ ...this.wbDayDia(), [dk]: d }); this.wbDayLoad.set({ ...this.wbDayLoad(), [dk]: false }); },
      error: (e) => { this.wbDayErr.set({ ...this.wbDayErr(), [dk]: this.httpMsg(e, '/caja/conciliacion-dia') }); this.wbDayLoad.set({ ...this.wbDayLoad(), [dk]: false }); },
    });
  }

  /** Filas visibles: filtros + orden. La búsqueda es la canónica (tokens, sin acentos, en cualquier orden). */
  dayRows(cd: ConcDia): DiaRow[] {
    const dir = this.dfDir(), est = this.dfEstado(), q = this.dfSearch();
    const filtered = cd.rows.filter((e) => {
      if (dir && e.dir !== dir) return false;
      if (est === 'casado' && !e.kepler) return false;
      if (est === 'descuadre' && e.kepler) return false;
      return coincideBusqueda(q, e.concepto, e.extra, e.importe);
    });
    return sortRows(filtered, this.daySort(), (r, f) => (r as unknown as Record<string, unknown>)[f]);
  }

  /** Lo que Kepler tiene y la caja no, ingresos y gastos juntos, del mayor al menor. */
  dayOrphans(cd: ConcDia): OrphanMov[] {
    const v = cd.vs_kepler;
    return [...v.ingresos.other_only.map((o) => ({ ...o, dir: 'in' as const })),
      ...v.gastos.other_only.map((o) => ({ ...o, dir: 'out' as const }))].sort((a, b) => b.importe - a.importe);
  }

  /** Lo primero que dice es CON QUÉ MÉTODO casó: un par por identidad y uno por importe no valen igual. */
  tituloKepler(e: DiaRow): string {
    const p: string[] = [];
    if (e.kepler_origen === 'identidad') p.push('Cobro del ERP, casado por identidad (misma ruta y mismo día)');
    else if (e.kepler_origen === 'llave') p.push('Kepler, casado por el documento del libro');
    else if (e.kepler_origen === 'ruta') p.push('Sin cobro en tesorería: venta del Kepler de la camioneta');
    else p.push('Kepler, casado por importe dentro de la tolerancia');
    if (e.kepler_ref) p.push(e.kepler_ref);
    if (e.kepler_ambiguo) p.push('había más de un candidato con este importe');
    if (e.kepler_delta) p.push(e.kepler_delta < 0 ? `entró ${this.money(Math.abs(e.kepler_delta))} menos` : `entró ${this.money(e.kepler_delta)} más`);
    p.push('ver el detalle');
    return p.join(' · ');
  }

  /** Se exporta LO QUE SE VE: dayRows() ya trae filtros y orden. Los importes van como número. */
  async exportDay(cd: ConcDia): Promise<void> {
    this.exporting.set(true);
    try {
      const f: string[] = [];
      if (this.dfDir()) f.push(this.dfDir() === 'in' ? 'solo ingresos' : 'solo gastos');
      if (this.dfEstado()) f.push(this.dfEstado() === 'casado' ? 'solo los que estan en Kepler' : 'solo los que no estan en Kepler');
      if (this.dfSearch().trim()) f.push('busqueda "' + this.dfSearch().trim() + '"');
      const rows = this.dayRows(cd);
      const base = `${this.dayKey()} - ${rows.length} de ${cd.rows.length} movimientos de la caja`;
      const orp = this.dayOrphans(cd);
      const sheets: XlsxSheet<any>[] = [{
        name: 'Detalle del dia',
        subtitle: f.length ? base + ' - filtros: ' + f.join(', ') : base,
        rows,
        cols: [
          { header: 'Fecha', get: (r: DiaRow) => r.fecha, type: 'date', width: 12 },
          { header: 'Direccion', get: (r: DiaRow) => (r.dir === 'in' ? 'Ingreso' : 'Gasto'), width: 11 },
          { header: 'Caja', get: (r: DiaRow) => r.importe, type: 'money', total: true },
          { header: 'Fuente', get: (r: DiaRow) => (r.source === 'libro' ? 'libro' : 'Control'), width: 9 },
          { header: 'Kepler', get: (r: DiaRow) => r.kepler_importe, type: 'money', total: true },
          { header: 'Origen Kepler', get: (r: DiaRow) => r.kepler_origen, width: 12 },
          // [CGA-A.69] Iban DOS columnas «Ref Kepler» (una con el motivo y otra sin él): una sola,
          // con la referencia, y el motivo en la suya — una celda vacía no distingue los dos casos.
          { header: 'Ref Kepler', get: (r: DiaRow) => r.kepler_ref, width: 24 },
          { header: 'Motivo', get: (r: DiaRow) => r.kepler_motivo, width: 26 },
          { header: 'Concepto', get: (r: DiaRow) => r.concepto, width: 46 },
        ],
      }];
      if (orp.length) sheets.push({ name: 'En Kepler sin caja', rows: orp, cols: [
        { header: 'Importe', get: (r: OrphanMov) => r.importe, type: 'money', total: true },
        { header: 'Concepto', get: (r: OrphanMov) => r.concepto, width: 46 },
        { header: 'Referencia', get: (r: OrphanMov) => r.extra, width: 24 },
        { header: 'Documento', get: (r: OrphanMov) => r.key, width: 26 },
        { header: 'Libro nuevo', get: (r: OrphanMov) => (r.en_libro ? (r.en_libro.via === 'declarado' ? 'declarado en ' : 'en libro ') + r.en_libro.folio : 'por capturar'), width: 22 },
      ] });
      await exportXlsx('Detalle del dia ' + this.dayKey(), sheets);
    } finally { this.exporting.set(false); }
  }

  // ── Detalle de un movimiento ───────────────────────────────────────────────────────────────

  readonly movOpen = signal(false);
  readonly movLoad = signal(false);
  readonly movErr = signal<string | null>(null);
  readonly mov = signal<MovDetail | null>(null);
  openMovement(source: MovSource, key: string | null): void {
    if (!key) return;
    this.mov.set(null); this.movErr.set(null); this.movOpen.set(true); this.movLoad.set(true);
    this.http.get<MovDetail>(`${this.base}/movement?source=${source}&key=${encodeURIComponent(key)}`)
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (d) => { this.mov.set(d); this.movLoad.set(false); },
        error: (e) => { this.movErr.set(this.httpMsg(e, '/caja/movement')); this.movLoad.set(false); },
      });
  }

  /** Un fallo HTTP en algo accionable. El 404 se nombra aparte: un API atrás del código lo da así. */
  private httpMsg(e: { status?: number }, ruta: string): string {
    if (e?.status === 404) return `El API no tiene ${ruta} (404) — quedó atrás del código. Hace falta redesplegarlo.`;
    if (e?.status === 403) return `Sin permiso para ${ruta} (403).`;
    if (e?.status === 0) return `Sin conexión con el API al pedir ${ruta}.`;
    return `Falló ${ruta}${e?.status ? ` (${e.status})` : ''}.`;
  }
}
