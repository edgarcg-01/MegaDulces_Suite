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
import { InputTextModule } from 'primeng/inputtext';
import { coincideBusqueda } from '@megadulces/ui-web';
import { warehouseName, diaMxDeInstante } from '@megadulces/contracts';
import { environment } from '../../../../../environments/environment';
import { MetricStripComponent, MetricStripItem } from '../../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../../shared/components/freshness-pill/freshness-pill.component';
import { LoadStateComponent } from '../../../../shared/components/load-state/load-state.component';
import { ContextHelpComponent } from '../../../../shared/context-help/context-help.component';
import { SegmentedComponent, type SegOption } from '../../../../shared/components/segmented/segmented.component';
import { SidePeekComponent } from '../../../../shared/components/side-peek/side-peek.component';
import { SortState, toggleSort, sortIcon, ariaSort, sortRows } from '../../../../shared/util';
import { exportXlsx, XlsxSheet } from '../../../../shared/export/xlsx-export';
import { FINANZAS_SHARED_STYLES } from '../finanzas-shared.styles';
import { CajaTabsComponent } from '../../caja-tabs.component';
import { money, dmy } from '../finanzas-format';

// ── Los huecos (`GET /finance/caja/cuadre-huecos`, motor `caja-huecos.engine.ts`) ────────────────

type Dueno = 'caja' | 'kepler' | 'sucursal' | 'ruta' | 'direccion' | 'conteo' | 'desarrollo';
type Certeza = 'alta' | 'media' | 'por_confirmar';
type Testigo = 'si' | 'no' | 'difiere' | 'na';
type Eslabon = 'venta' | 'corte' | 'cobro' | 'boveda' | 'libro' | 'control';
interface Hueco {
  tipo: string; fecha: string; monto: number; ref: string; etiqueta: string;
  testigos: Record<Eslabon, Testigo>; via?: 'llave' | 'identidad' | 'importe';
  atraso_dias?: number; atraso_p90?: number; sucursal?: string; ruta_dia?: string;
  dueno: Dueno; certeza: Certeza; accion: string; falta: boolean;
}
interface Suma { n: number; monto: number }
interface CuadreHuecos {
  period: { from: string; to: string }; datos_al: string | null; huecos: Hueco[];
  resumen: { falta: Suma; por_dueno: Record<Dueno, Suma>; por_ligar: Suma; sin_contar: Suma; por_confirmar_n: number };
  no_medido: string[];
}
interface CuadreBalance {
  period: { from: string; to: string };
  balance: { esperado: number | null; contado: number | null; diferencia: number | null; bulto: number; diferencia_si_bulto_es_efectivo: number | null; medible: boolean } | null;
  entrada?: { inicial: { cajon: number; boveda: number | null }; ingresos: number; gastos: number; final: { conteo: { piezas: number; morralla: number }; boveda: number | null } };
  inicio?: { instante: string | null; fuente: 'corte_anterior' | 'arqueo_control' | 'sin_dato'; boveda_fuente: string };
  fin?: { corte: string | null; instante: string | null; boveda_fuente: string };
  replay?: { pares: number; cierran: number; fallas_mismo_evento: number; fallas_reales: number };
  cortes?: { folio: string; fecha: string; bulto: number }[];
}
/** El filtro de la lista: lo que falta (default), su reparto por dueño, o lo que se declara aparte. */
type FiltroHuecos = 'falta' | 'caja' | 'kepler' | 'ruta' | 'por_ligar' | 'sin_contar' | 'todo';

const ESLABONES: { k: Eslabon; label: string }[] = [
  { k: 'venta', label: 'Venta' }, { k: 'corte', label: 'Corte' }, { k: 'cobro', label: 'Cobro' },
  { k: 'boveda', label: 'Bóveda' }, { k: 'libro', label: 'Libro' }, { k: 'control', label: 'Control' },
];
const TESTIGO_TXT: Record<Testigo, string> = { si: 'lo tiene', no: 'no lo tiene', difiere: 'lo tiene distinto', na: 'no aplica' };
const CERTEZA_TXT: Record<Certeza, string> = { alta: 'alta', media: 'media', por_confirmar: 'por confirmar' };
const DUENO_TXT: Record<Dueno, string> = {
  caja: 'Caja', kepler: 'Kepler (contabilidad)', sucursal: 'La sucursal', ruta: 'La ruta',
  direccion: 'Dirección', conteo: 'Conteo del cajón', desarrollo: 'Desarrollo',
};
/** Lo que la acción pide, en una frase: dice QUIÉN y QUÉ, y no promete lo que la liga no hace. */
const ACCION_TXT: Record<string, string> = {
  capturar: 'Capturarlo en el libro: está en Kepler y el libro no lo tiene.',
  ligar: 'Ligarlo a su documento: ya está capturado, falta decir de qué cobro es.',
  corregir: 'Corregir la captura: el libro y el documento no dicen lo mismo.',
  pedir_kepler: 'Pedir a contabilidad que lo corrija en Kepler.',
  pedir_sucursal: 'Pedir a la sucursal que cobre el corte a Caja General.',
  pedir_ruta: 'Pedir a la ruta el cobro de lo que vendió.',
  contar: 'Contarlo pieza por pieza en el siguiente arqueo.',
  revisar: 'Lo revisa Dirección: no tiene documento en ningún lado.',
  ninguna: 'Nada todavía: falta saber si entra o sale.',
};
const HUECO_NO_MEDIDO_TXT: Record<string, string> = {
  salida_sin_documento: 'las salidas que sólo anota Control',
  captura_doble: 'las capturas dobles',
};

// ── Los días (lo de antes: `conciliacion-workbook` y `conciliacion-dia`) ─────────────────────────

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
  datos_al?: string | null;
  totals: {
    dias: number; dias_con_kepler: number; dias_descuadre: number; kep_disponible: boolean;
    cola?: { disponible: boolean; n: number; ingreso: number; gasto: number };
    ruta_disponible?: boolean;
  };
  por_dia: DiaCuadre[];
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
  kepler_only_pendiente_n?: number; kepler_only_pendiente_monto?: number;
  ruta_cobros_disponible?: boolean;
  kepler_ambiguos_n: number; kepler_disponible: boolean; tolerancia: number;
  caja_fuente?: 'control' | 'libro' | 'mixto';
}
interface ConcDia { vs_kepler: { ingresos: ReconSide; gastos: ReconSide }; rows: DiaRow[]; totals: DiaTotals }
interface MovDetail { source: MovSource; title: string; fields: { label: string; value: string | number | null }[] }
interface Facets { meses: string[]; relevo?: { control_ultimo_fecha: string | null; libro_desde: string | null } }

/**
 * ⭐⭐ `[LE.CU.4]` **El Cuadre de Caja General: qué efectivo no tiene explicación todavía, y a quién
 * le toca.** Diseño completo (los doce pasos de la skill `diseno`) en
 * `docs/IMPLEMENTACION/FASES/FASE_LE_ANEXO_CUADRE.md`; los números, en `VERDAD_ABSOLUTA.md` §36.
 *
 * Antes el nivel 0 era el DÍA («17 de 23 días cuadran»), y un día rojo mezclaba siete causas con
 * siete dueños: nadie sabía qué hacer con él. Ahora el nivel 0 es el HUECO — cada peso sin
 * explicación, con los testigos que lo vieron, su dueño, su certeza y la acción que lo cierra — y
 * el día queda como segundo modo (lo abren 129 de 146 visitas, y es la unidad de cierre).
 *
 * Las cinco preguntas (skill diseno §0b):
 *  1. Qué ve primero: cuánto falta explicar y de quién es; la línea del efectivo contado; la lista,
 *     lo más nuevo primero.
 *  2. Qué no: el total del mes Caja/Kepler (un total sin dueño no decide nada) y el párrafo de
 *     método (al `context-help`).
 *  3. Accesibilidad: cada monto del veredicto filtra la lista; la fila abre su cadena con Enter; la
 *     certeza y los testigos se dicen con texto; la sucursal por su nombre; buscable por cualquier
 *     folio.
 *  4. Liga: cada hueco abre su documento (Kepler o libro) y lleva a donde se cierra (Captura,
 *     Arqueos, Cortes/Sucursales).
 *  5. Le toca: es la revisión del libro de caja contra todos sus testigos; los cortes que van a
 *     banco no son de aquí.
 *
 * Jerarquía: primario = el monto sin explicar · secundario = su reparto por dueño y la línea física
 * · terciario = los testigos de cada fila.
 *
 * ⛔ Lo que casó SÓLO por importe sale «por confirmar» y sigue sumando a lo que falta (§36.7): el
 * importe no se distingue de una coincidencia.
 */
/** El mes en curso en México (YYYY-MM): el reloj del navegador en UTC cambia de mes seis horas antes. */
const mesMx = (): string => (diaMxDeInstante(new Date()) ?? new Date().toISOString()).slice(0, 7);

@Component({
  selector: 'app-finanzas-caja-cuadre',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, RouterLink, ButtonModule, TableModule, SelectModule, TagModule, DialogModule, InputTextModule,
    MetricStripComponent, FreshnessPillComponent, LoadStateComponent, ContextHelpComponent, SegmentedComponent, SidePeekComponent, CajaTabsComponent],
  template: `
    <app-caja-tabs />
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Cuadre de Caja General</h1>
          <p class="surf-page-sub">Qué efectivo no tiene explicación todavía, y a quién le toca.</p>
        </div>
        <div class="cc-acciones">
          <app-context-help topic="caja-cuadre" />
          <app-freshness-pill measures="data" [since]="hc()?.datos_al ?? wbc()?.datos_al ?? null" label="Kepler" />
          <p-select [options]="meses()" [ngModel]="month()" (onChange)="onMonth($event.value)" placeholder="Mes"
                    styleClass="cc-sel" ariaLabel="Mes" />
          <p-button size="small" icon="pi pi-refresh" severity="secondary" [text]="true" label="Actualizar"
                    [loading]="loading()" (onClick)="reload()" />
        </div>
      </header>

      <app-load-state [loading]="loading() && !hc()" [error]="err()" [isEmpty]="false"
                      errorTitle="No se pudo leer el cuadre" (retry)="reload()">
        @if (hc(); as h) {
          <!-- Primario: cuánto falta explicar. El color acompaña; el texto lo dice. -->
          <p class="cc-veredicto" [class.cc-veredicto--mal]="h.resumen.falta.n > 0">{{ veredicto(h) }}</p>

          <!-- Secundario: el reparto por dueño. Cada cifra filtra la lista (desglose). -->
          <app-metric-strip [items]="kpis(h)" ariaLabel="Lo que falta explicar, por dueño" density="compact"
                            [instant]="true" (drill)="setFiltro($event)" />

          <!-- Secundario: el único testigo que no depende de nadie, el efectivo contado. -->
          <p class="cc-fisico" role="status">
            @if (bal(); as b) {
              @if (!b.balance) { <span class="muted">Sin cortes cerrados en el periodo: el efectivo contado no se compara todavía.</span> }
              @else if (!b.balance.medible) { <span class="warn">Efectivo contado contra el libro: no medido (falta la bóveda de un extremo).</span> }
              @else {
                <span>Efectivo contado (cajón y bóveda) contra el libro:</span>
                <b class="num" [class.bad]="(b.balance.diferencia ?? 0) < -1" [class.ok]="abs(b.balance.diferencia) <= 1">{{ signo(b.balance.diferencia) }}</b>
                <span class="muted">{{ (b.balance.diferencia ?? 0) < -1 ? 'falta' : (b.balance.diferencia ?? 0) > 1 ? 'sobra' : 'cuadra' }}</span>
                @if (b.balance.bulto > 0) { <span class="muted">· {{ money(b.balance.bulto) }} declarados sin contar</span> }
              }
              @if (b.balance) { <button type="button" class="tw-mlink" (click)="balOpen.set(true)">ver el balance</button> }
            } @else if (balErr(); as e) { <span class="warn">{{ e }}</span> }
            @else { <span class="muted">Midiendo el efectivo contado…</span> }
          </p>

          @if (h.no_medido.length) {
            <p class="cc-nomedido"><i class="pi pi-info-circle" aria-hidden="true"></i>
              No medido todavía: {{ textoNoMedido(h) }}. No están en la cifra de arriba; no es que no existan.</p>
          }

          <div class="cc-modo">
            <app-segmented [options]="opcionesVista(h)" [value]="vista()" (valueChange)="setVista($event)" ariaLabel="Ver huecos o días" />
          </div>

          @if (vista() === 'huecos') {
            <div class="card-premium card-flat tw-tablewrap dt-scope">
              <div class="cc-filtros">
                <span class="cc-mostrando">{{ textoFiltro() }}
                  @if (filtro() !== 'falta') { <button type="button" class="tw-mlink" (click)="filtro.set('falta')">ver todo lo que falta</button> }
                </span>
                <input pInputText type="search" class="cc-buscar" [ngModel]="q()" (ngModelChange)="q.set($event)"
                       placeholder="Buscar folio, ruta, sucursal o monto…" aria-label="Buscar en los huecos" />
                <span class="muted tw-fcount">{{ huecosVista().length }} de {{ h.huecos.length }}</span>
                <button type="button" class="tw-xls" [disabled]="exporting()" (click)="exportHuecos()">
                  <i class="pi" [class.pi-file-excel]="!exporting()" [class.pi-spin]="exporting()" [class.pi-spinner]="exporting()" aria-hidden="true"></i> Excel
                </button>
              </div>
              <p-table [value]="huecosVista()" size="small" dataKey="ref" [rowHover]="true" selectionMode="single" [metaKeySelection]="false"
                       (onRowSelect)="abrirHueco($event.data)" (onRowUnselect)="abrirHueco($event.data)"
                       class="surf-table surf-table--plain surf-table--sticky dt-stack">
                <ng-template #header>
                  <tr>
                    <th class="cg-w-date" pSortableColumn="fecha">Fecha <p-sortIcon field="fecha" /></th>
                    <th>Qué es</th>
                    <th>Testigos</th>
                    <th class="ta-r comm-num" pSortableColumn="monto">Monto <p-sortIcon field="monto" /></th>
                    <th>Certeza</th>
                    <th>Qué se hace</th>
                  </tr>
                </ng-template>
                <ng-template #body let-r>
                  <tr [pSelectableRow]="r" class="tw-clickable">
                    <td role="cell" data-label="Fecha" class="cg-mono dt-id">{{ dmy(r.fecha) }}</td>
                    <td role="cell" data-label="Qué es" class="cc-que">
                      <span>{{ r.etiqueta }}</span>
                      @if (sucursalDe(r); as s) { <span class="muted cc-suc">{{ s }}</span> }
                    </td>
                    <td role="cell" data-label="Testigos" class="cc-testigos">
                      @for (t of testigosDe(r); track t.k) {
                        <span class="cc-t" [class.ok]="t.v === 'si'" [class.bad]="t.v === 'no'" [class.warn]="t.v === 'difiere'">
                          <i [class]="iconoTestigo(t.v)" aria-hidden="true"></i>{{ t.label }}<span class="sr-only"> {{ TESTIGO_TXT[t.v] }}</span>
                        </span>
                      }
                    </td>
                    <td role="cell" data-label="Monto" class="ta-r num comm-num dt-num">{{ money(r.monto) }}
                      @if (!r.falta) { <span class="cc-aparte">aparte</span> }
                    </td>
                    <td role="cell" data-label="Certeza">
                      <span [class.warn]="r.certeza === 'por_confirmar'" [class.muted]="r.certeza === 'alta'">{{ CERTEZA_TXT[r.certeza] }}</span>
                    </td>
                    <td role="cell" data-label="Qué se hace">
                      @if (ligaAccion(r); as l) {
                        <a [routerLink]="l.ruta" [queryParams]="l.qp" class="cc-accion" (click)="$event.stopPropagation()"
                           [attr.aria-label]="l.label + ': ' + r.etiqueta">{{ l.label }}</a>
                      } @else { <span class="muted">{{ quienCorto(r) }}</span> }
                    </td>
                  </tr>
                </ng-template>
                <ng-template #emptymessage><tr><td colspan="6"><div class="cg-empty"><i class="pi pi-check-circle" aria-hidden="true"></i>
                  <span>{{ h.huecos.length ? 'Ningún hueco con este filtro.' : 'Nada sin explicar en el periodo, con lo que hoy se mide.' }}</span></div></td></tr></ng-template>
              </p-table>
            </div>
          } @else {
            <app-load-state [loading]="wbLoading() && !wbc()" [error]="wbErr()" [isEmpty]="!!wbc() && !wbc()!.por_dia.length"
                            errorTitle="No se pudieron leer los días" emptyTitle="Sin movimientos en el mes" (retry)="cargarDias()">
              @if (wbc(); as d) {
                <p class="cc-dias">{{ verdictDias(d) }}</p>
                @if (d.totals.cola && !d.totals.cola.disponible) {
                  <p class="cc-aviso" role="status"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                    No se pudo leer la cola de Captura: ningún día se marca «falta capturar», así que lo que esperaba captura sale como «no cuadra».</p>
                }
                @if (d.totals.ruta_disponible === false) {
                  <p class="cc-aviso" role="status"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                    No se pudieron leer los cobros de camioneta: la columna Kepler está incompleta.</p>
                }
                <div class="card-premium card-flat tw-tablewrap dt-scope">
                  <div class="cc-filtros">
                    <app-segmented [options]="opcionesEstado(d)" [value]="estado()" (valueChange)="setEstado($event)" ariaLabel="Estado del día" />
                    <app-segmented [options]="opcionesDir" [value]="cuadreDir()" (valueChange)="setDir($event)" ariaLabel="Dirección (se hereda al abrir el día)" />
                  </div>
                  <p-table [value]="diasVista(d)" size="small" dataKey="fecha" [rowHover]="true" selectionMode="single" [metaKeySelection]="false"
                           (onRowSelect)="alElegir($event.data)" (onRowUnselect)="alElegir($event.data)" class="surf-table surf-table--plain surf-table--sticky surf-table--frozen-first dt-stack">
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
                        <td role="cell" data-label="Día" class="cg-mono dt-id">{{ dmy(r.fecha) }} <span class="muted">· {{ r.mdb_n }}</span>@if (r.caja_fuente === 'libro') { <p-tag value="libro" severity="secondary" styleClass="cg-tag" /> }</td>
                        @if (cuadreDir() !== 'out') {
                          <td role="cell" data-label="Caja entra" class="ta-r num comm-num dt-num">{{ money(r.mdb_ingreso) }}</td>
                          <td role="cell" data-label="Kepler entra" class="ta-r num comm-num dt-num">{{ r.kp_n ? money(r.kp_ingreso) : '—' }}</td>
                          <td role="cell" data-label="Diferencia entra" class="ta-r num comm-num dt-num" [class.bad]="fuera(r.delta_kep_ingreso, r)">{{ r.kp_n ? money(r.delta_kep_ingreso) : '—' }}</td>
                        }
                        @if (cuadreDir() !== 'in') {
                          <td role="cell" data-label="Caja sale" class="ta-r num comm-num dt-num">{{ money(r.mdb_gasto) }}</td>
                          <td role="cell" data-label="Kepler sale" class="ta-r num comm-num dt-num">{{ r.kp_n ? money(r.kp_gasto) : '—' }}</td>
                          <td role="cell" data-label="Diferencia sale" class="ta-r num comm-num dt-num" [class.bad]="fuera(r.delta_kep_gasto, r)">{{ r.kp_n ? money(r.delta_kep_gasto) : '—' }}</td>
                        }
                        <td role="cell" data-label="Estado" class="cc-w-estado">
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
          }
        }
      </app-load-state>
    </div>

    <!-- Un hueco: la cadena de testigos, quién lo cierra y su documento. -->
    <app-side-peek [open]="!!sel()" (openChange)="cerrarHueco($event)" [title]="sel() ? money(sel()!.monto) : 'Hueco'"
                   [subtitle]="sel() ? dmy(sel()!.fecha) + (sucursalDe(sel()!) ? ' · ' + sucursalDe(sel()!) : '') : null">
      @if (sel(); as s) {
        <p class="pk-que">{{ s.etiqueta }}</p>
        <p class="pk-falta" [class.bad]="s.falta">
          {{ s.falta ? 'Cuenta en lo que falta explicar.' : s.tipo === 'bulto_sin_contar' ? 'Se declara aparte: nadie lo ha contado, no se sabe si falta.' : s.tipo === 'libro_sin_ligar' ? 'Se declara aparte: ya está capturado; falta su liga.' : 'Se declara aparte.' }}
        </p>

        <h3 class="pk-h">La cadena</h3>
        <dl class="cg-movd">
          @for (t of testigosDe(s); track t.k) {
            <div class="cg-movd-row"><dt>{{ t.label }}</dt>
              <dd [class.ok]="t.v === 'si'" [class.bad]="t.v === 'no'" [class.warn]="t.v === 'difiere'"><i [class]="iconoTestigo(t.v)" aria-hidden="true"></i> {{ TESTIGO_TXT[t.v] }}</dd></div>
          }
          @if (!testigosDe(s).length) { <div class="cg-movd-row"><dt>Testigos</dt><dd class="muted">ninguno lo puede confirmar todavía</dd></div> }
        </dl>
        @if (s.atraso_dias != null && s.atraso_p90 != null) {
          <p class="pk-nota">El corte lleva {{ s.atraso_dias }} días sin cobrarse; en esta sucursal lo normal es hasta {{ s.atraso_p90 }} (9 de cada 10 cortes).</p>
        }

        <h3 class="pk-h">Quién lo cierra</h3>
        <p class="pk-txt"><b>{{ DUENO_TXT[s.dueno] }}.</b> {{ ACCION_TXT[s.accion] || '' }}</p>
        @if (ligaAccion(s); as l) {
          <a [routerLink]="l.ruta" [queryParams]="l.qp" class="cc-accion">{{ l.label }}</a>
        }

        <h3 class="pk-h">Certeza: {{ CERTEZA_TXT[s.certeza] }}</h3>
        <p class="pk-txt">{{ razonCerteza(s) }}</p>

        <h3 class="pk-h">El documento</h3>
        <p class="pk-txt"><span class="cg-mono">{{ folioDe(s) }}</span>
          @if (movDe(s); as m) { · <button type="button" class="tw-mlink" (click)="openMovement(m.source, m.key)">ver el detalle</button> }
        </p>
        <p class="pk-nota muted">Ningún eslabón de esta cadena guarda archivo (PDF o imagen): se ubica por su folio.</p>
      }
    </app-side-peek>

    <!-- El balance del efectivo contado: de dónde sale la línea física. -->
    <app-side-peek [open]="balOpen()" (openChange)="balOpen.set($event)" [title]="'Efectivo contado contra el libro'"
                   [subtitle]="bal() ? dmy(bal()!.period.from) + ' al ' + dmy(bal()!.period.to) : null">
      @if (bal(); as b) {
        @if (b.balance && b.entrada) {
          <dl class="cg-movd">
            <div class="cg-movd-row"><dt>Al empezar</dt><dd class="muted">{{ textoInicio(b) }}</dd></div>
            <div class="cg-movd-row"><dt>Cajón</dt><dd class="num">{{ money(b.entrada!.inicial.cajon) }}</dd></div>
            <div class="cg-movd-row"><dt>Bóveda</dt><dd class="num">{{ b.entrada!.inicial.boveda == null ? 'no medido' : money(b.entrada!.inicial.boveda) }} <span class="muted">({{ textoFuenteBoveda(b.inicio?.boveda_fuente) }})</span></dd></div>
            <div class="cg-movd-row"><dt>+ Entradas del libro</dt><dd class="num">{{ money(b.entrada!.ingresos) }}</dd></div>
            <div class="cg-movd-row"><dt>− Salidas del libro</dt><dd class="num">{{ money(b.entrada!.gastos) }}</dd></div>
            <div class="cg-movd-row pk-total"><dt>= Debería haber</dt><dd class="num">{{ b.balance.esperado == null ? 'no medido' : money(b.balance.esperado) }}</dd></div>
            <div class="cg-movd-row"><dt>Contado en el cajón</dt><dd class="num">{{ money(b.entrada!.final.conteo.piezas) }} <span class="muted">(pieza por pieza, corte {{ b.fin?.corte || '—' }})</span></dd></div>
            <div class="cg-movd-row"><dt>En la bóveda</dt><dd class="num">{{ b.entrada!.final.boveda == null ? 'no medido' : money(b.entrada!.final.boveda) }} <span class="muted">({{ textoFuenteBoveda(b.fin?.boveda_fuente) }})</span></dd></div>
            <div class="cg-movd-row pk-total"><dt>= Hay</dt><dd class="num">{{ b.balance.contado == null ? 'no medido' : money(b.balance.contado) }}</dd></div>
            <div class="cg-movd-row pk-total"><dt>Diferencia</dt><dd class="num" [class.bad]="(b.balance.diferencia ?? 0) < -1">{{ signo(b.balance.diferencia) }}</dd></div>
          </dl>
          @if (b.balance.bulto > 0) {
            <p class="pk-nota">{{ money(b.balance.bulto) }} se teclearon como morralla sin desglose. No se suman a lo contado: nadie los contó.
              Si fueran efectivo, la diferencia sería {{ signo(b.balance.diferencia_si_bulto_es_efectivo) }}.</p>
          }
          @if (b.replay; as r) {
            <p class="pk-nota muted">La bóveda se reconstruye con sus movimientos entre conteos: {{ r.cierran }} de {{ r.pares }} tramos cierran al peso.
              @if (r.fallas_reales) { {{ r.fallas_reales }} no cierran y están sin explicar. }</p>
          }
          <p class="pk-txt">
            <a routerLink="/finanzas/caja-general/arqueos" class="cc-accion">Ver los arqueos</a>
            <a routerLink="/finanzas/caos" class="cc-accion">Ver Caja Fuerte</a>
          </p>
        }
      }
    </app-side-peek>

    <!-- Detalle del día: una fila por movimiento de la caja con su par de Kepler, y lo que Kepler
         tiene y la caja no. En panel lateral, para no perder la lista de días. -->
    <app-side-peek [open]="dayOpen()" (openChange)="dayOpen.set($event)" [title]="dayTitle()" [width]="1040">
      @if (wbDayLoad()[dayKey()]) { <div class="cg-empty"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i><span>Casando movimientos del día…</span></div> }
      @else if (wbDayErr()[dayKey()]; as e) { <div class="cg-empty"><i class="pi pi-exclamation-triangle bad" aria-hidden="true"></i><span>{{ e }}</span></div> }
      @else if (wbDayDia()[dayKey()]; as cd) {
        <p class="dlg-lead">Cada movimiento de la <b>caja</b> ({{ textoRelevo() }}) marca si <b>Kepler</b> lo tiene. Abajo, lo que Kepler registra y la caja no tiene.</p>

        <div class="tw-drill-kpis">
          <span><b>{{ cd.totals.control_n }}</b> movimientos {{ cd.totals.caja_fuente === 'libro' ? 'del libro' : cd.totals.caja_fuente === 'mixto' ? 'de caja (Control y libro)' : 'de Control' }}</span>
          @if (cd.totals.kepler_disponible) { <span class="ok"><b>{{ cd.totals.en_kepler }}</b> con su par en Kepler</span> }
          @else { <span class="muted">Kepler sin datos en el periodo</span> }
          @if (porImporte(cd); as n) { <span class="warn"><b>{{ n }}</b> casados sólo por importe: por confirmar</span> }
          @if (cd.totals.ruta_cobros_disponible === false) { <span class="warn">no se pudieron leer los cobros de camioneta</span> }
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
                  <!-- ⛔ §36.7: lo casado SÓLO por importe se dice «por confirmar», no se da por casado. -->
                  <td class="ta-r num tw-kep">@if (e.kepler) { <button type="button" class="tw-mlink" [attr.aria-label]="tituloKepler(e)" (click)="openMovement(e.kepler_source!, e.kepler_key)">{{ money(e.kepler_importe ?? 0) }}</button>@if (e.kepler_origen === 'identidad' || e.kepler_origen === 'llave') { <i class="pi pi-link tw-ident" aria-hidden="true"></i> } @else if (e.kepler_origen === 'ruta') { <i class="pi pi-truck tw-ident" aria-hidden="true"></i> } @else if (e.kepler_origen === 'importe') { <span class="tw-amb">por confirmar</span> } @if (e.kepler_ambiguo) { <span class="tw-amb" aria-label="había más de un candidato">~</span> } } @else if (e.kepler_motivo) { <span class="warn"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ e.kepler_motivo }}</span> } @else { <span class="muted">no está</span> }</td>
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
                    <tr class="tw-clickable" tabindex="0" (click)="openMovement(m.source, m.key)" (keydown.enter)="openMovement(m.source, m.key)">
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
    </app-side-peek>

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
    app-metric-strip { display:block; margin:var(--sp-2) 0 var(--sp-2); }
    .cc-fisico { display:flex; gap:var(--sp-2); align-items:baseline; flex-wrap:wrap; font-size:var(--fs-sm); margin:0 0 var(--sp-2); }
    .cc-fisico b { font-size:var(--fs-md); }
    .cc-nomedido { display:flex; gap:var(--sp-2); align-items:center; font-size:var(--fs-xs); color:var(--text-muted); margin:0 0 var(--sp-3); }
    .cc-modo { margin:0 0 var(--sp-2); }
    .cc-dias { font-size:var(--fs-sm); font-weight:600; margin:0 0 var(--sp-2); }
    .cc-aviso { display:flex; gap:var(--sp-2); align-items:center; font-size:var(--fs-sm); color:var(--warn-fg); margin:0 0 var(--sp-3); }
    .cc-filtros { display:flex; gap:var(--sp-3); flex-wrap:wrap; align-items:center; margin:0 0 var(--sp-2); }
    .cc-mostrando { font-size:var(--fs-sm); font-weight:600; display:flex; gap:var(--sp-2); align-items:baseline; }
    .cc-buscar { flex:1 1 16rem; max-width:24rem; }
    .cc-que { min-width:18rem; }
    .cc-que > span { display:block; }
    .cc-suc { font-size:var(--fs-xs); }
    .cc-testigos { white-space:nowrap; }
    .cc-t { display:inline-flex; align-items:center; gap:2px; font-size:var(--fs-xs); margin-right:var(--sp-2); }
    .cc-t .pi { font-size:.65rem; }
    .cc-aparte { display:block; font-size:var(--fs-xs); color:var(--text-muted); font-family:var(--font-sans); }
    .cc-accion { color:var(--action); font-weight:600; text-decoration:none; white-space:nowrap; margin-right:var(--sp-3); }
    .cc-accion:hover { text-decoration:underline; }
    .cc-accion:focus-visible { outline:2px solid var(--action); outline-offset:2px; border-radius:var(--r-sm); }
    .cc-w-estado { min-width:12rem; }
    .cc-cola { display:inline-flex; gap:var(--sp-2); align-items:center; color:inherit; text-decoration:none; }
    .cc-cola:hover .num, .cc-cola:focus-visible .num { text-decoration:underline; }
    .cc-cola:focus-visible { outline:2px solid var(--action); outline-offset:2px; border-radius:var(--r-sm); }
    .cc-resto { display:block; font-size:var(--fs-xs); }
    .pk-que { font-size:var(--fs-md); font-weight:600; margin:0 0 var(--sp-1); }
    .pk-falta { font-size:var(--fs-sm); margin:0 0 var(--sp-3); }
    .pk-h { font-size:var(--fs-sm); font-weight:700; margin:var(--sp-4) 0 var(--sp-1); }
    .pk-txt { font-size:var(--fs-sm); margin:0 0 var(--sp-2); }
    .pk-nota { font-size:var(--fs-xs); margin:var(--sp-2) 0; }
    .pk-total dt, .pk-total dd { font-weight:700; }
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
    .tw-amb { color:var(--warn-fg); font-weight:700; margin-left:4px; font-size:var(--fs-xs); font-family:var(--font-sans); }
    .tw-ident { color:var(--text-muted); font-size:var(--fs-xs); margin-left:4px; }
    .cg-movd { margin:0; }
    .cg-movd-row { display:grid; grid-template-columns:11rem 1fr; gap:var(--sp-2); padding:var(--sp-1) 0; border-bottom:1px solid var(--border-color); }
    .cg-movd-row:last-child { border-bottom:none; }
    .cg-movd-row dt { color:var(--text-muted); font-size:var(--fs-sm); }
    .cg-movd-row dd { margin:0; font-weight:600; font-variant-numeric:tabular-nums; word-break:break-word; }
    @container (max-width: 40rem) { .cg-movd-row { grid-template-columns:1fr; } .cc-w-estado, .cc-que { min-width:0; } .cc-testigos { white-space:normal; } }
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
  readonly TESTIGO_TXT = TESTIGO_TXT;
  readonly CERTEZA_TXT = CERTEZA_TXT;
  readonly DUENO_TXT = DUENO_TXT;
  readonly ACCION_TXT = ACCION_TXT;

  readonly f = signal<Facets>({ meses: [] });
  readonly month = signal<string | null>(null);
  readonly hc = signal<CuadreHuecos | null>(null);
  readonly loading = signal(false);
  readonly err = signal<string | null>(null);
  readonly bal = signal<CuadreBalance | null>(null);
  readonly balErr = signal<string | null>(null);
  readonly balOpen = signal(false);

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
    this.hc.set(null); this.bal.set(null); this.wbc.set(null); this.sel.set(null);
    this.wbDayDia.set({}); this.wbDayErr.set({});
    this.reload();
  }

  private q_(): string { return this.month() ? `?month=${this.month()}` : ''; }

  /** Huecos y balance siempre; los días sólo si se están viendo (se piden al cambiar de modo). */
  reload(): void {
    this.loading.set(true); this.err.set(null); this.balErr.set(null);
    this.http.get<CuadreHuecos>(`${this.base}/cuadre-huecos${this.q_()}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.hc.set(d); this.loading.set(false); },
      error: (e) => { this.loading.set(false); this.err.set(this.httpMsg(e, '/caja/cuadre-huecos')); },
    });
    this.http.get<CuadreBalance>(`${this.base}/cuadre-balance${this.q_()}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => this.bal.set(d),
      error: (e) => this.balErr.set(`El efectivo contado no se pudo medir: ${this.httpMsg(e, '/caja/cuadre-balance')}`),
    });
    if (this.vista() === 'dias' || this.wbc()) this.cargarDias();
  }

  // ── El veredicto y el reparto ──────────────────────────────────────────────────────────────

  /** Primario: cuánto falta explicar, en una frase con su número. */
  veredicto(h: CuadreHuecos): string {
    const r = h.resumen;
    if (!r.falta.n) return 'Todo el efectivo del periodo tiene explicación, con lo que hoy se mide.';
    const partes = [`Falta explicar ${money(r.falta.monto)} en ${r.falta.n} ${r.falta.n === 1 ? 'hueco' : 'huecos'}`];
    if (r.por_confirmar_n) partes.push(`${r.por_confirmar_n} por confirmar`);
    return partes.join(' · ') + '.';
  }

  kpis(h: CuadreHuecos): MetricStripItem[] {
    const r = h.resumen, d = r.por_dueno;
    const ks = { n: d.kepler.n + d.sucursal.n, monto: d.kepler.monto + d.sucursal.monto };
    const it = (label: string, s: Suma, sub: string, drill: FiltroHuecos, tone: MetricStripItem['tone'] = 'default'): MetricStripItem =>
      ({ label, value: s.monto, format: 'currency2', tone: s.n ? tone : 'default', sub: `${s.n} · ${sub}`, drill, drillLabel: `Ver ${label.toLowerCase()} en la lista` });
    return [
      it('Caja', d.caja, 'capturar, ligar o corregir', 'caja', 'bad'),
      it('Kepler y sucursales', ks, 'se corrige en Kepler', 'kepler', 'bad'),
      it('Rutas', d.ruta, 'vendieron y no cobraron', 'ruta', 'bad'),
      it('Por ligar', r.por_ligar, 'capturado, falta su documento', 'por_ligar', 'warn'),
      it('Sin contar', r.sin_contar, 'declarado sin desglose', 'sin_contar', 'warn'),
    ];
  }

  textoNoMedido(h: CuadreHuecos): string {
    return h.no_medido.map((t) => HUECO_NO_MEDIDO_TXT[t] ?? t).join(' y ');
  }

  // ── La lista de huecos ─────────────────────────────────────────────────────────────────────

  readonly vista = signal<'huecos' | 'dias'>('huecos');
  readonly filtro = signal<FiltroHuecos>('falta');
  readonly q = signal('');
  readonly sel = signal<Hueco | null>(null);
  readonly exporting = signal(false);

  opcionesVista(h: CuadreHuecos): SegOption[] {
    return [{ label: 'Huecos', value: 'huecos', count: h.resumen.falta.n }, { label: 'Días', value: 'dias' }];
  }
  setVista(v: string): void {
    this.vista.set(v === 'dias' ? 'dias' : 'huecos');
    if (v === 'dias' && !this.wbc() && !this.wbLoading()) this.cargarDias();
  }
  setFiltro(v: string): void {
    const f = v as FiltroHuecos;
    this.filtro.set(this.filtro() === f ? 'falta' : f);
    this.vista.set('huecos');
  }

  textoFiltro(): string {
    switch (this.filtro()) {
      case 'caja': return 'Lo que falta y le toca a la caja';
      case 'kepler': return 'Lo que falta y se corrige en Kepler o en la sucursal';
      case 'ruta': return 'Lo que las rutas vendieron y no cobraron';
      case 'por_ligar': return 'Capturado sin su documento ligado';
      case 'sin_contar': return 'Declarado sin contar';
      case 'todo': return 'Todos los huecos';
      default: return 'Todo lo que falta explicar';
    }
  }

  private pasaFiltro(h: Hueco): boolean {
    switch (this.filtro()) {
      case 'caja': return h.falta && h.dueno === 'caja';
      case 'kepler': return h.falta && (h.dueno === 'kepler' || h.dueno === 'sucursal');
      case 'ruta': return h.falta && h.dueno === 'ruta';
      case 'por_ligar': return h.tipo === 'libro_sin_ligar';
      case 'sin_contar': return h.tipo === 'bulto_sin_contar';
      case 'todo': return true;
      default: return h.falta;
    }
  }

  readonly huecosVista = computed(() => {
    const h = this.hc(); const q = this.q();
    if (!h) return [];
    return h.huecos.filter((x) => this.pasaFiltro(x) && coincideBusqueda(q, x.etiqueta, x.ref, x.monto, this.sucursalDe(x)));
  });

  abrirHueco(h: Hueco | Hueco[] | undefined): void { if (h && !Array.isArray(h)) this.sel.set(h); }
  cerrarHueco(abierto: boolean): void { if (!abierto) this.sel.set(null); }

  /** La sucursal por su NOMBRE: la manda el hueco, o la lleva la llave de Kepler (`07|U-A-5|…`, `01-003|…`). */
  sucursalDe(h: Hueco): string | null {
    const c = h.sucursal ?? (/^\d{2}(?=[|-])/.exec(h.ref)?.[0] ?? null);
    return c ? warehouseName(c) : null;
  }

  testigosDe(h: Hueco): { k: Eslabon; label: string; v: Testigo }[] {
    return ESLABONES.map((e) => ({ ...e, v: h.testigos?.[e.k] ?? 'na' })).filter((t) => t.v !== 'na');
  }
  iconoTestigo(v: Testigo): string {
    return v === 'si' ? 'pi pi-check' : v === 'no' ? 'pi pi-times' : 'pi pi-not-equal';
  }

  razonCerteza(h: Hueco): string {
    if (h.via === 'importe') return 'Casó sólo por importe: un importe igual no se distingue de una coincidencia. Sigue contando en lo que falta hasta que alguien lo confirme.';
    if (h.certeza === 'alta') {
      if (h.via === 'llave') return 'Casó por el documento: el folio de Kepler es el mismo de los dos lados.';
      if (h.via === 'identidad') return 'Casó por identidad: la misma ruta y el mismo día de los dos lados.';
      return 'Los testigos que lo vieron coinciden.';
    }
    if (h.tipo === 'captura_distinta') return 'Un solo testigo contradice al libro; para corregir con certeza hacen falta dos.';
    return 'Ningún testigo independiente lo confirma todavía.';
  }

  /** El folio que la persona busca: el del libro o el documento de Kepler. */
  folioDe(h: Hueco): string {
    const p = h.ref.split('|');
    if (p[0] === 'libro') return p[1];
    if (p.length >= 3 && /^[A-Z]-[A-Z]-\d+$/.test(p[1])) return `${p[1]} ${p[2]}`;
    return h.ref.replace(/\|/g, ' · ');
  }
  /** El detalle que `/movement` sabe abrir: un folio del libro, o un documento de Kepler con su cuenta. */
  movDe(h: Hueco): { source: MovSource; key: string } | null {
    const p = h.ref.split('|');
    if (p[0] === 'libro' && p[1]) return { source: 'libro', key: h.ref };
    if (p.length === 4 && /^[A-Z]-[A-Z]-\d+$/.test(p[1])) return { source: 'kepler', key: h.ref };
    return null;
  }

  /**
   * A dónde lleva la acción. ⛔ Una liga afirma que la otra pantalla lo permite: Captura busca en el
   * LIBRO por folio (`?q=`), así que ligar y corregir llevan con el folio puesto; capturar lleva a
   * la cola, que vive en Captura sin filtro por folio — y el rótulo lo dice.
   */
  ligaAccion(h: Hueco): { label: string; ruta: string; qp?: Record<string, string> } | null {
    const per = this.hc()?.period;
    const folioLibro = h.ref.startsWith('libro|') ? h.ref.slice(6) : null;
    switch (h.accion) {
      case 'capturar': return { label: 'Ir a la cola de Captura', ruta: '/finanzas/caja-general' };
      case 'ligar':
      case 'corregir':
        return folioLibro
          ? { label: h.accion === 'ligar' ? 'Ligar en el libro' : 'Corregir en el libro', ruta: '/finanzas/caja-general', qp: { q: folioLibro, ...(per ? { from: per.from, to: per.to } : {}) } }
          : null;
      case 'pedir_sucursal': return { label: 'Ver en Cortes/Sucursales', ruta: '/finanzas/cortes-sucursales' };
      case 'contar': return { label: 'Ir a Arqueos', ruta: '/finanzas/caja-general/arqueos' };
      default: return null;
    }
  }
  quienCorto(h: Hueco): string {
    switch (h.accion) {
      case 'pedir_kepler': return 'Pedir a contabilidad';
      case 'pedir_ruta': return 'Pedir a la ruta';
      case 'revisar': return 'Dirección';
      case 'ninguna': return '—';
      default: return DUENO_TXT[h.dueno];
    }
  }

  /** Se exporta LO QUE SE VE: filtro y búsqueda puestos. Los montos van como número. */
  async exportHuecos(): Promise<void> {
    const h = this.hc(); if (!h) return;
    this.exporting.set(true);
    try {
      const rows = this.huecosVista();
      const sub = `${h.period.from} a ${h.period.to} - ${this.textoFiltro()}${this.q().trim() ? ' - busqueda "' + this.q().trim() + '"' : ''} - ${rows.length} de ${h.huecos.length}`;
      await exportXlsx('Huecos de Caja General ' + (this.month() ?? ''), [{
        name: 'Huecos', subtitle: sub, rows,
        cols: [
          { header: 'Fecha', get: (r: Hueco) => r.fecha, type: 'date', width: 12 },
          { header: 'Que es', get: (r: Hueco) => r.etiqueta, width: 60 },
          { header: 'Sucursal', get: (r: Hueco) => this.sucursalDe(r), width: 18 },
          { header: 'Monto', get: (r: Hueco) => r.monto, type: 'money', total: true },
          { header: 'Cuenta en falta', get: (r: Hueco) => (r.falta ? 'si' : 'aparte'), width: 10 },
          { header: 'Dueno', get: (r: Hueco) => DUENO_TXT[r.dueno], width: 18 },
          { header: 'Certeza', get: (r: Hueco) => CERTEZA_TXT[r.certeza], width: 14 },
          { header: 'Testigos', get: (r: Hueco) => this.testigosDe(r).map((t) => `${t.label}: ${TESTIGO_TXT[t.v]}`).join('; '), width: 40 },
          { header: 'Documento', get: (r: Hueco) => this.folioDe(r), width: 22 },
        ],
      } as XlsxSheet<Hueco>]);
    } finally { this.exporting.set(false); }
  }

  // ── El balance físico ──────────────────────────────────────────────────────────────────────

  abs(n: number | null | undefined): number { return Math.abs(Number(n) || 0); }
  /** Con signo explícito: «−$48,047.70» falta, «+$…» sobra. `null` = no medido. */
  signo(n: number | null | undefined): string {
    if (n == null) return 'no medido';
    return (n < 0 ? '−' : n > 0 ? '+' : '') + money(Math.abs(n));
  }
  textoInicio(b: CuadreBalance): string {
    const i = b.inicio;
    if (!i || i.fuente === 'sin_dato') return 'sin conteo de arranque';
    const cuando = i.instante ? dmy(i.instante.slice(0, 10)) : '';
    return i.fuente === 'corte_anterior' ? `cierre del corte anterior ${cuando}` : `último arqueo del Control ${cuando}`;
  }
  textoFuenteBoveda(f: string | undefined): string {
    return f === 'conteo' ? 'contada' : f === 'replay' ? 'reconstruida con sus movimientos' : 'sin dato';
  }

  // ── Los días ───────────────────────────────────────────────────────────────────────────────

  readonly wbc = signal<CajaWb | null>(null);
  readonly wbLoading = signal(false);
  readonly wbErr = signal<string | null>(null);

  cargarDias(): void {
    this.wbLoading.set(true); this.wbErr.set(null);
    this.http.get<CajaWb>(`${this.base}/conciliacion-workbook${this.q_()}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.wbc.set(d); this.wbLoading.set(false); },
      error: (e) => { this.wbLoading.set(false); this.wbErr.set(this.httpMsg(e, '/caja/conciliacion-workbook')); },
    });
  }

  /** `[CGA-A.66]` El estado que manda el servidor; uno anterior sólo trae `cuadra`, y se deriva. */
  estadoDe(r: DiaCuadre): EstadoDia {
    return r.estado ?? (r.sin_kepler ? 'sin_kepler' : r.cuadra ? 'cuadra' : 'no_cuadra');
  }

  cuenta(d: CajaWb): Record<EstadoDia, number> {
    const c = { sin_kepler: 0, cuadra: 0, por_capturar: 0, no_cuadra: 0 };
    for (const r of d.por_dia) c[this.estadoDe(r)]++;
    return c;
  }

  verdictDias(d: CajaWb): string {
    const c = this.cuenta(d);
    const total = c.cuadra + c.por_capturar + c.no_cuadra;
    if (!total) return 'Sin Kepler en el periodo: no hay contra qué cuadrar los días.';
    const partes = [`${c.cuadra} de ${total} días cuadran con Kepler`];
    if (c.por_capturar) partes.push(`en ${c.por_capturar} sólo falta capturar lo que está en la cola`);
    if (c.no_cuadra) partes.push(`${c.no_cuadra} no ${c.no_cuadra === 1 ? 'cuadra' : 'cuadran'} aunque se capture la cola`);
    return partes.join(' · ') + '.';
  }

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

  /** Cuántos pares del día casaron sólo por importe (§36.7): se cuentan, no se dan por casados. */
  porImporte(cd: ConcDia): number { return cd.rows.filter((r) => r.kepler && r.kepler_origen === 'importe').length; }

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
    else p.push('Kepler, casado sólo por importe: por confirmar');
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
          { header: 'Origen Kepler', get: (r: DiaRow) => (r.kepler_origen === 'importe' ? 'importe (por confirmar)' : r.kepler_origen), width: 14 },
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
