import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
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

/**
 * El grupo es LO QUE HAY QUE HACER. La lista se lee por tarea: la acción va una vez en el encabezado
 * del grupo, no repetida en cada renglón.
 */
type Grupo = 'capturar' | 'libro' | 'contabilidad' | 'sucursal' | 'ruta' | 'direccion' | 'aparte';
const GRUPOS: Record<Grupo, { orden: number; titulo: string }> = {
  capturar: { orden: 1, titulo: 'Capturar en el libro' },
  libro: { orden: 2, titulo: 'Corregir o ligar en el libro' },
  contabilidad: { orden: 3, titulo: 'Pedir a contabilidad que lo corrija en Kepler' },
  sucursal: { orden: 4, titulo: 'Pedir a la sucursal que cobre el corte' },
  ruta: { orden: 5, titulo: 'Pedir a la ruta lo que vendió y no cobró' },
  direccion: { orden: 6, titulo: 'Revisar con Dirección' },
  aparte: { orden: 7, titulo: 'Aparte: no suma a lo que falta' },
};
/** Un renglón de la lista: un hueco, o los días de una misma ruta juntos (32 días eran 10 rutas). */
interface Fila {
  key: string; grupo: Grupo; fecha: string; desde: string; monto: number; n: number;
  titulo: string; detalle: string; sucursal: string | null; certeza: Certeza; huecos: Hueco[];
}

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
/** Lo que es cada hueco, en palabras de quien opera la caja (el texto del servidor va al detalle). */
const TITULO_TIPO: Record<string, string> = {
  kepler_sin_libro: 'Cobro sin capturar',
  captura_distinta: 'Capturado con otro importe',
  captura_doble: 'Capturado dos veces',
  libro_sin_kepler: 'Captura que Kepler no tiene',
  libro_sin_ligar: 'Captura sin su documento',
  cuenta_no_caja: 'Cobrado a una cuenta que no es caja',
  corte_sin_cobro: 'Corte de caja sin cobrar',
  salida_sin_documento: 'Salida sin documento',
  bulto_sin_contar: 'Morralla sin contar',
  sin_direccion: 'Documento sin dirección',
};
const HUECO_NO_MEDIDO_TXT: Record<string, string> = {
  salida_sin_documento: 'las salidas que sólo anota Control',
  captura_doble: 'las capturas dobles',
};

// ── Los días (`conciliacion-workbook` y `conciliacion-dia`) ─────────────────────────────────────

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
interface DiaTotals { kepler_disponible: boolean; ruta_cobros_disponible?: boolean }
interface ConcDia { vs_kepler: { ingresos: ReconSide; gastos: ReconSide }; rows: DiaRow[]; totals: DiaTotals }
/**
 * Un renglón del detalle del día: lo de la caja con su par de Kepler, y lo que sólo Kepler tiene,
 * en UNA tabla. Antes eran dos (la segunda abajo, fuera de la vista) y había que cruzarlas a ojo.
 */
interface DetRow {
  key: string; dir: 'in' | 'out'; concepto: string; libro: boolean;
  caja: number | null; kepler: number | null;
  /** `true` = tiene su par con certeza (documento, identidad o la camioneta). */
  casado: boolean; par: string; parAviso: boolean;
  cajaMov: { source: MovSource; key: string } | null; keplerMov: { source: MovSource; key: string } | null;
}
interface MovDetail { source: MovSource; title: string; fields: { label: string; value: string | number | null }[] }
interface Facets { meses: string[]; relevo?: { control_ultimo_fecha: string | null; libro_desde: string | null } }

/**
 * ⭐⭐ `[LE.CU.4]` **El Cuadre de Caja General: qué efectivo no tiene explicación todavía, y a quién
 * le toca.** Diseño completo (los doce pasos de la skill `diseno`) en
 * `docs/IMPLEMENTACION/FASES/FASE_LE_ANEXO_CUADRE.md`; los números, en `VERDAD_ABSOLUTA.md` §36.
 *
 * Antes el nivel 0 era el DÍA («17 de 23 días cuadran»), y un día rojo mezclaba siete causas con
 * siete dueños. Ahora el nivel 0 es el HUECO, agrupado por lo que hay que hacer, y el día queda
 * como segundo modo (lo abren 129 de 146 visitas, y es la unidad de cierre).
 *
 * `[LE.CU.4b]` Auditoría del PM (2026-11-05: *«el diseño de las tablas es poco amigable»; «nada de
 * Excel»*). Medido sobre los 87 huecos de prod: el renglón mostraba el texto técnico del servidor
 * (códigos de Kepler en 46, hasta 175 caracteres), la misma acción repetida en cada fila, una fila
 * por día de ruta (32 días = 10 rutas), seis columnas con tres de metadatos, y los avisos en ámbar a
 * 2.15:1. Ahora: tres columnas, el renglón dice qué es en palabras, la acción una vez por grupo, la
 * ruta una vez con sus días, los testigos en el detalle, y el texto de color en los tonos `-soft-fg`.
 *
 * Las cinco preguntas (skill diseno §0b):
 *  1. Qué ve primero: cuánto falta explicar y de quién es; la línea del efectivo contado; la lista
 *     por tarea, lo más nuevo primero dentro de cada una.
 *  2. Qué no: el total del mes Caja/Kepler, el método (al `context-help`), los testigos y el folio
 *     largo (al detalle).
 *  3. Accesibilidad: cada monto del veredicto filtra la lista; la fila abre su detalle con Enter; la
 *     certeza se dice con texto; la sucursal por su nombre; buscable por cualquier folio.
 *  4. Liga: cada hueco abre su documento y lleva a donde se cierra (Captura, Arqueos, Cortes).
 *  5. Le toca: es la revisión del libro de caja contra sus testigos; los cortes que van a banco no.
 *
 * Jerarquía: primario = el monto sin explicar · secundario = su reparto y la línea física ·
 * terciario = el renglón de cada hueco (su folio y su sucursal, en gris).
 *
 * ⛔ Lo que casó SÓLO por importe sale «por confirmar» y sigue sumando a lo que falta (§36.7).
 */
/** El mes en curso en México (YYYY-MM): el reloj del navegador en UTC cambia de mes seis horas antes. */
const mesMx = (): string => (diaMxDeInstante(new Date()) ?? new Date().toISOString()).slice(0, 7);

@Component({
  selector: 'app-finanzas-caja-cuadre',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, RouterLink, ButtonModule, TableModule, SelectModule, DialogModule, InputTextModule,
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
          <p class="cc-fisico">
            @if (bal(); as b) {
              @if (!b.balance) { <span class="muted">Sin cortes cerrados en el periodo: el efectivo contado no se compara todavía.</span> }
              @else if (!b.balance.medible) { <span class="warn">Efectivo contado contra el libro: no medido (falta la bóveda de un extremo).</span> }
              @else {
                <span>Efectivo contado (cajón y bóveda) contra el libro:</span>
                <b class="num" [class.bad]="(b.balance.diferencia ?? 0) < -1">{{ signo(b.balance.diferencia) }}</b>
                <span>{{ (b.balance.diferencia ?? 0) < -1 ? 'falta' : (b.balance.diferencia ?? 0) > 1 ? 'sobra' : 'cuadra' }}</span>
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

          <div class="cc-barra">
            <app-segmented [options]="opcionesVista(h)" [value]="vista()" (valueChange)="setVista($event)" ariaLabel="Ver huecos o días" />
            @if (vista() === 'huecos') {
              <input pInputText type="search" class="cc-buscar" [ngModel]="q()" (ngModelChange)="q.set($event)"
                     placeholder="Buscar folio, ruta, sucursal o monto…" aria-label="Buscar en los huecos" />
            }
          </div>

          @if (vista() === 'huecos') {
            @if (filtro() !== 'falta') {
              <p class="cc-mostrando">Mostrando: {{ textoFiltro() }} ·
                <button type="button" class="tw-mlink" (click)="filtro.set('falta')">volver a todo lo que falta</button></p>
            }
            <div class="card-premium card-flat tw-tablewrap dt-scope">
              <p-table [value]="filas()" size="small" dataKey="key" [rowHover]="true" selectionMode="single" [metaKeySelection]="false"
                       rowGroupMode="subheader" groupRowsBy="grupo"
                       (onRowSelect)="abrirFila($event.data)" (onRowUnselect)="abrirFila($event.data)"
                       class="surf-table surf-table--plain surf-table--sticky dt-stack">
                <ng-template #header>
                  <tr>
                    <th class="cg-w-date">Fecha</th>
                    <th>Qué es</th>
                    <th class="ta-r comm-num cc-w-monto">Monto</th>
                  </tr>
                </ng-template>
                <ng-template #groupheader let-r>
                  <tr class="cc-grupo">
                    <td colspan="3" role="cell">
                      <div class="cc-grupo-in">
                        <span class="cc-grupo-t">{{ tituloGrupo(r) }}</span>
                        <span class="muted">{{ resumenGrupo(r) }}</span>
                        @if (ligaGrupo(r); as l) {
                          <a [routerLink]="l.ruta" class="cc-accion" (click)="$event.stopPropagation()">{{ l.label }}</a>
                        }
                      </div>
                    </td>
                  </tr>
                </ng-template>
                <ng-template #body let-r>
                  <tr [pSelectableRow]="r" class="tw-clickable">
                    <td role="cell" data-label="Fecha" class="cg-mono dt-id">{{ textoFecha(r) }}</td>
                    <td role="cell" data-label="Qué es">
                      <span class="cc-titulo">{{ r.titulo }}</span>
                      @if (r.certeza !== 'alta') { <span class="cc-cert">{{ certezaTxt(r) }}</span> }
                      <span class="cc-det">{{ r.detalle }}@if (r.sucursal) { · {{ r.sucursal }} }</span>
                    </td>
                    <td role="cell" data-label="Monto" class="ta-r num comm-num dt-num">{{ money(r.monto) }}</td>
                  </tr>
                </ng-template>
                <ng-template #emptymessage><tr><td colspan="3"><div class="cg-empty"><i class="pi pi-check-circle" aria-hidden="true"></i>
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
                <div class="cc-barra">
                  <app-segmented [options]="opcionesEstado(d)" [value]="estado()" (valueChange)="setEstado($event)" ariaLabel="Estado del día" />
                </div>
                <div class="card-premium card-flat tw-tablewrap dt-scope">
                  <p-table [value]="diasVista(d)" size="small" dataKey="fecha" [rowHover]="true" selectionMode="single" [metaKeySelection]="false"
                           (onRowSelect)="alElegir($event.data)" (onRowUnselect)="alElegir($event.data)" class="surf-table surf-table--plain surf-table--sticky dt-stack">
                    <ng-template #header>
                      <tr>
                        <th class="cg-w-date">Día</th>
                        <th>Estado</th>
                        <th class="ta-r comm-num">Diferencia al entrar</th>
                        <th class="ta-r comm-num">Diferencia al salir</th>
                      </tr>
                    </ng-template>
                    <ng-template #body let-r>
                      <tr [pSelectableRow]="r" class="tw-clickable">
                        <td role="cell" data-label="Día" class="cg-mono dt-id">{{ dmy(r.fecha) }}</td>
                        <td role="cell" data-label="Estado">
                          @switch (estadoDe(r)) {
                            @case ('sin_kepler') { <span class="muted">sin Kepler</span> }
                            @case ('cuadra') { <span class="ok"><i class="pi pi-check" aria-hidden="true"></i> cuadra</span> }
                            @case ('por_capturar') {
                              <a routerLink="/finanzas/caja-general" class="cc-cola" (click)="$event.stopPropagation()"
                                 [attr.aria-label]="'Falta capturar ' + (r.cola_n ?? 0) + ' movimientos del día: ir a la cola'">
                                falta capturar {{ r.cola_n }} · {{ money((r.cola_ingreso ?? 0) + (r.cola_gasto ?? 0)) }}</a>
                            }
                            @default { <span class="bad">no cuadra</span> }
                          }
                          <span class="cc-det">{{ r.mdb_n }} movimientos{{ r.caja_fuente === 'libro' ? ' del libro' : r.caja_fuente === 'control' ? ' de Control' : '' }}</span>
                        </td>
                        <td role="cell" data-label="Diferencia al entrar" class="ta-r num comm-num dt-num" [class.bad]="fuera(r.delta_kep_ingreso, r)" [class.muted]="!fuera(r.delta_kep_ingreso, r)">{{ r.kp_n ? money(r.delta_kep_ingreso) : '—' }}</td>
                        <td role="cell" data-label="Diferencia al salir" class="ta-r num comm-num dt-num" [class.bad]="fuera(r.delta_kep_gasto, r)" [class.muted]="!fuera(r.delta_kep_gasto, r)">{{ r.kp_n ? money(r.delta_kep_gasto) : '—' }}</td>
                      </tr>
                    </ng-template>
                    <ng-template #emptymessage><tr><td colspan="4"><div class="cg-empty"><i class="pi pi-inbox" aria-hidden="true"></i><span>Ningún día con este filtro.</span></div></td></tr></ng-template>
                  </p-table>
                </div>
              }
            </app-load-state>
          }
        }
      </app-load-state>
    </div>

    <!-- Un renglón de la lista: qué es, quién lo cierra, por qué esa certeza y su documento. -->
    <app-side-peek [open]="!!sel()" (openChange)="cerrarFila($event)" [title]="sel() ? sel()!.titulo : 'Hueco'"
                   [subtitle]="sel() ? money(sel()!.monto) + (sel()!.sucursal ? ' · ' + sel()!.sucursal : '') : null">
      @if (sel(); as f) {
        @if (f.n === 1) {
          @if (f.huecos[0]; as s) {
            <p class="pk-que">{{ s.etiqueta }}</p>
            <p class="pk-falta" [class.bad]="s.falta">{{ textoFalta(s) }}</p>

            <h3 class="pk-h">Quién lo cierra</h3>
            <p class="pk-txt"><b>{{ DUENO_TXT[s.dueno] }}.</b> {{ ACCION_TXT[s.accion] || '' }}</p>
            @if (ligaAccion(s); as l) {
              <p class="pk-txt"><a [routerLink]="l.ruta" [queryParams]="l.qp" class="cc-accion">{{ l.label }}</a></p>
            }

            <h3 class="pk-h">Quién lo vio</h3>
            <dl class="cg-movd">
              @for (t of testigosDe(s); track t.k) {
                <div class="cg-movd-row"><dt>{{ t.label }}</dt>
                  <dd [class.ok]="t.v === 'si'" [class.bad]="t.v === 'no'" [class.warn]="t.v === 'difiere'">{{ TESTIGO_TXT[t.v] }}</dd></div>
              }
              @if (!testigosDe(s).length) { <div class="cg-movd-row"><dt>Testigos</dt><dd class="muted">ninguno lo puede confirmar todavía</dd></div> }
            </dl>
            @if (s.atraso_dias != null && s.atraso_p90 != null) {
              <p class="pk-nota">El corte lleva {{ s.atraso_dias }} días sin cobrarse; en esta sucursal lo normal es hasta {{ s.atraso_p90 }} (9 de cada 10 cortes).</p>
            }

            <h3 class="pk-h">Certeza: {{ CERTEZA_TXT[s.certeza] }}</h3>
            <p class="pk-txt">{{ razonCerteza(s) }}</p>

            <h3 class="pk-h">El documento</h3>
            <p class="pk-txt"><span class="cg-mono">{{ folioDe(s) }}</span>
              @if (movDe(s); as m) { · <button type="button" class="tw-mlink" (click)="openMovement(m.source, m.key)">ver el detalle</button> }
            </p>
            <p class="pk-nota muted">Ningún eslabón de esta cadena guarda archivo (PDF o imagen): se ubica por su folio.</p>
          }
        } @else {
          <p class="pk-que">{{ f.titulo }} en {{ f.n }} días, del {{ dmy(f.desde) }} al {{ dmy(f.fecha) }}.</p>
          <p class="pk-txt">La camioneta registró la venta y ningún cobro la recibe. <b>{{ DUENO_TXT[f.huecos[0].dueno] }}.</b> {{ ACCION_TXT[f.huecos[0].accion] || '' }}</p>
          <h3 class="pk-h">Los días</h3>
          <dl class="cg-movd">
            @for (s of f.huecos; track s.ref) {
              <div class="cg-movd-row"><dt>{{ dmy(s.fecha) }}</dt><dd class="num">{{ money(s.monto) }}</dd></div>
            }
          </dl>
          <p class="pk-nota muted">Testigos de cada día: la venta de la camioneta lo tiene; el cobro, no.</p>
        }
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

    <!-- El detalle de un día: lo de la caja con su par de Kepler y lo que sólo Kepler tiene, en una
         sola tabla, lo que no tiene par primero. En panel lateral para no perder la lista de días. -->
    <app-side-peek [open]="dayOpen()" (openChange)="dayOpen.set($event)" [title]="dayTitle()" [subtitle]="daySub()" [width]="880">
      @if (wbDayLoad()[dayKey()]) { <div class="cg-empty"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i><span>Casando movimientos del día…</span></div> }
      @else if (wbDayErr()[dayKey()]; as e) { <div class="cg-empty"><i class="pi pi-exclamation-triangle bad" aria-hidden="true"></i><span>{{ e }}</span></div> }
      @else if (wbDayDia()[dayKey()]; as cd) {
        @if (!cd.totals.kepler_disponible) { <p class="cc-aviso" role="status">Kepler no tiene datos de este día: nada se puede casar.</p> }
        @if (cd.totals.ruta_cobros_disponible === false) { <p class="cc-aviso" role="status">No se pudieron leer los cobros de camioneta: la columna Kepler está incompleta.</p> }
        <div class="cc-barra">
          <app-segmented [options]="opcionesDet(cd)" [value]="dfEstado()" (valueChange)="setDfEstado($event)" ariaLabel="Movimientos con o sin su par" />
          <input pInputText type="search" class="cc-buscar" [ngModel]="dfSearch()" (ngModelChange)="dfSearch.set($event)"
                 placeholder="Buscar concepto o monto…" aria-label="Buscar en el día" />
        </div>
        <p-table [value]="detVista(cd)" size="small" dataKey="key" class="surf-table surf-table--plain dt-stack">
          <ng-template #header>
            <tr>
              <th>Movimiento</th>
              <th class="ta-r comm-num">Caja</th>
              <th class="ta-r comm-num">Kepler</th>
              <th>Par</th>
            </tr>
          </ng-template>
          <ng-template #body let-e>
            <tr>
              <td role="cell" data-label="Movimiento">
                <span class="cc-titulo">{{ e.concepto }}</span>
                <span class="cc-det">{{ e.dir === 'in' ? 'Entra' : 'Sale' }}{{ e.libro ? ' · libro' : '' }}</span>
              </td>
              <td role="cell" data-label="Caja" class="ta-r num comm-num dt-num">
                @if (e.caja != null) { <button type="button" class="tw-mlink" (click)="abrirMov(e.cajaMov)">{{ money(e.caja) }}</button> } @else { <span class="muted">—</span> }
              </td>
              <td role="cell" data-label="Kepler" class="ta-r num comm-num dt-num">
                @if (e.kepler != null) { <button type="button" class="tw-mlink" (click)="abrirMov(e.keplerMov)">{{ money(e.kepler) }}</button> } @else { <span class="muted">—</span> }
              </td>
              <td role="cell" data-label="Par" [class.ok]="e.casado" [class.warn]="e.parAviso">{{ e.par }}</td>
            </tr>
          </ng-template>
          <ng-template #emptymessage><tr><td colspan="4" class="ta-c muted tw-empty">Sin movimientos con este filtro.</td></tr></ng-template>
        </p-table>
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
    .cc-barra { display:flex; gap:var(--sp-3); flex-wrap:wrap; align-items:center; margin:0 0 var(--sp-2); }
    .cc-buscar { flex:1 1 16rem; max-width:24rem; }
    .cc-mostrando { font-size:var(--fs-sm); font-weight:600; margin:0 0 var(--sp-2); }
    .cc-dias { font-size:var(--fs-sm); font-weight:600; margin:0 0 var(--sp-2); }
    .cc-aviso { display:flex; gap:var(--sp-2); align-items:center; font-size:var(--fs-sm); color:var(--warn-soft-fg); margin:0 0 var(--sp-3); }
    /* El encabezado del grupo agrupa con espacio y peso, no con otra caja. */
    .cc-grupo td { background:var(--card-bg); padding-top:var(--sp-4); }
    .cc-grupo-in { display:flex; gap:var(--sp-3); align-items:baseline; flex-wrap:wrap; }
    .cc-grupo-t { font-size:var(--fs-sm); font-weight:700; color:var(--text-main); }
    .cc-titulo { font-weight:600; color:var(--text-main); }
    .cc-cert { margin-left:var(--sp-2); font-size:var(--fs-xs); font-weight:600; color:var(--warn-soft-fg); }
    .cc-det { display:block; font-size:var(--fs-xs); color:var(--text-muted); }
    .cc-w-monto { width:9rem; }
    .cc-accion { color:var(--action); font-weight:600; text-decoration:none; white-space:nowrap; margin-right:var(--sp-3); }
    .cc-accion:hover { text-decoration:underline; }
    .cc-accion:focus-visible { outline:2px solid var(--focus-ring); outline-offset:2px; border-radius:var(--r-sm); }
    .cc-cola { color:var(--warn-soft-fg); font-weight:600; text-decoration:none; }
    .cc-cola:hover { text-decoration:underline; }
    .cc-cola:focus-visible { outline:2px solid var(--focus-ring); outline-offset:2px; border-radius:var(--r-sm); }
    .pk-que { font-size:var(--fs-md); font-weight:600; margin:0 0 var(--sp-1); }
    .pk-falta { font-size:var(--fs-sm); margin:0 0 var(--sp-3); }
    .pk-h { font-size:var(--fs-sm); font-weight:700; margin:var(--sp-4) 0 var(--sp-1); }
    .pk-txt { font-size:var(--fs-sm); margin:0 0 var(--sp-2); }
    .pk-nota { font-size:var(--fs-xs); margin:var(--sp-2) 0; }
    .pk-total dt, .pk-total dd { font-weight:700; }
    .ta-r { text-align:right; } .ta-c { text-align:center; }
    .num, .cg-mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .muted { color:var(--text-muted); }
    /* Texto de estado en los tonos -soft-fg: --warn-fg (2.15:1) y --ok-fg (3.30:1) no llegan a AA en claro. */
    .warn { color:var(--warn-soft-fg); font-weight:600; }
    .ok { color:var(--ok-soft-fg); }
    .bad { color:var(--bad-fg); }
    .cg-w-date { width:7.5rem; }
    .cg-empty { display:flex; flex-direction:column; align-items:center; gap:var(--sp-2); padding:var(--sp-8); text-align:center; color:var(--text-muted); }
    .cg-empty .pi { font-size:1.5rem; }
    .tw-mlink { font:inherit; font-variant-numeric:tabular-nums; color:inherit; background:none; border:none; padding:0; cursor:pointer; text-decoration:underline; text-decoration-style:dotted; text-underline-offset:3px; }
    .tw-mlink:hover { color:var(--action); }
    .tw-mlink:focus-visible { outline:2px solid var(--focus-ring); outline-offset:2px; border-radius:var(--r-sm); }
    .cg-movd { margin:0; }
    .cg-movd-row { display:grid; grid-template-columns:11rem 1fr; gap:var(--sp-2); padding:var(--sp-1) 0; border-bottom:1px solid var(--border-color); }
    .cg-movd-row:last-child { border-bottom:none; }
    .cg-movd-row dt { color:var(--text-muted); font-size:var(--fs-sm); }
    .cg-movd-row dd { margin:0; font-weight:600; font-variant-numeric:tabular-nums; word-break:break-word; }
    @container (max-width: 40rem) { .cg-movd-row { grid-template-columns:1fr; } }
  `],
})
export class FinanzasCajaCuadreComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly base = `${environment.apiUrl}/finance/caja`;

  readonly money = money;
  readonly dmy = dmy;
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
  readonly sel = signal<Fila | null>(null);

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
      case 'caja': return 'lo que le toca a la caja';
      case 'kepler': return 'lo que se corrige en Kepler o en la sucursal';
      case 'ruta': return 'lo que las rutas vendieron y no cobraron';
      case 'por_ligar': return 'lo capturado sin su documento';
      case 'sin_contar': return 'lo declarado sin contar';
      case 'todo': return 'todos los huecos';
      default: return 'todo lo que falta explicar';
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
    return h.huecos.filter((x) => this.pasaFiltro(x) && coincideBusqueda(q, x.etiqueta, x.ref, x.monto, this.sucursalDe(x), TITULO_TIPO[x.tipo]));
  });

  /** Los renglones: un hueco por fila, salvo la venta de ruta sin cobro, que junta sus días. */
  readonly filas = computed<Fila[]>(() => {
    const out: Fila[] = [];
    const rutas = new Map<string, Fila>();
    for (const h of this.huecosVista()) {
      const grupo = this.grupoDe(h);
      if (h.tipo === 'venta_sin_cobro') {
        const ruta = h.ref.split('|')[0];
        const ya = rutas.get(ruta);
        if (ya) {
          ya.huecos.push(h); ya.n += 1; ya.monto = Math.round((ya.monto + h.monto) * 100) / 100;
          if (h.fecha > ya.fecha) ya.fecha = h.fecha;
          if (h.fecha < ya.desde) ya.desde = h.fecha;
          continue;
        }
        const f: Fila = { key: ruta, grupo, fecha: h.fecha, desde: h.fecha, monto: h.monto, n: 1, titulo: `${ruta[0].toUpperCase()}${ruta.slice(1)} vendió y no cobró`, detalle: '', sucursal: null, certeza: h.certeza, huecos: [h] };
        rutas.set(ruta, f); out.push(f);
        continue;
      }
      out.push({ key: h.ref, grupo, fecha: h.fecha, desde: h.fecha, monto: h.monto, n: 1, titulo: TITULO_TIPO[h.tipo] ?? h.tipo,
        detalle: this.detalleDe(h), sucursal: this.sucursalDe(h), certeza: h.certeza, huecos: [h] });
    }
    for (const f of rutas.values()) {
      f.huecos.sort((a, b) => b.fecha.localeCompare(a.fecha));
      f.detalle = f.n === 1 ? '1 día' : `${f.n} días · del ${dmy(f.desde)} al ${dmy(f.fecha)}`;
    }
    // p-table agrupa filas CONTIGUAS: el orden del grupo va primero.
    return out.sort((a, b) => GRUPOS[a.grupo].orden - GRUPOS[b.grupo].orden || b.fecha.localeCompare(a.fecha) || b.monto - a.monto);
  });

  /** Totales por grupo de lo que se ve (filtro y búsqueda puestos). */
  private readonly totalesGrupo = computed(() => {
    const m = new Map<Grupo, { filas: number; monto: number }>();
    for (const f of this.filas()) {
      const t = m.get(f.grupo) ?? { filas: 0, monto: 0 };
      t.filas += 1; t.monto = Math.round((t.monto + f.monto) * 100) / 100;
      m.set(f.grupo, t);
    }
    return m;
  });

  grupoDe(h: Hueco): Grupo {
    if (!h.falta) return 'aparte';
    switch (h.accion) {
      case 'capturar': return 'capturar';
      case 'ligar': case 'corregir': return 'libro';
      case 'pedir_kepler': return 'contabilidad';
      case 'pedir_sucursal': return 'sucursal';
      case 'pedir_ruta': return 'ruta';
      case 'revisar': return 'direccion';
      default: return 'aparte';
    }
  }
  tituloGrupo(f: Fila): string { return GRUPOS[f.grupo].titulo; }
  resumenGrupo(f: Fila): string {
    const t = this.totalesGrupo().get(f.grupo);
    return t ? `${t.filas} · ${money(t.monto)}` : '';
  }
  /** La acción de todo el grupo, una vez. Sólo donde la otra pantalla la puede cumplir para todo el grupo. */
  ligaGrupo(f: Fila): { label: string; ruta: string } | null {
    switch (f.grupo) {
      case 'capturar': return { label: 'Ir a la cola de Captura', ruta: '/finanzas/caja-general' };
      case 'sucursal': return { label: 'Ver en Cortes/Sucursales', ruta: '/finanzas/cortes-sucursales' };
      default: return null;
    }
  }

  textoFecha(f: Fila): string { return f.n > 1 ? `${dmy(f.fecha)} (${f.n})` : dmy(f.fecha); }
  /** La fila de `p-table` llega sin tipo (`let-r`): el índice va por un método tipado. */
  certezaTxt(f: Fila): string { return CERTEZA_TXT[f.certeza]; }

  /** El renglón gris: el folio que la persona busca, y lo único que el título no dice. */
  detalleDe(h: Hueco): string {
    const folio = this.folioDe(h);
    switch (h.tipo) {
      case 'cuenta_no_caja': {
        const cuenta = /«([^»]+)»/.exec(h.etiqueta)?.[1];
        return cuenta ? `${folio} · a «${cuenta}»` : folio;
      }
      case 'corte_sin_cobro':
        return h.atraso_dias != null ? `${folio} · ${h.atraso_dias} días sin cobrar` : folio;
      case 'captura_distinta':
        return `${folio} · difiere ${money(h.monto)}`;
      case 'libro_sin_ligar':
        return h.via === 'importe' ? `${folio} · sólo coincide el importe` : `${folio} · ya se sabe de qué es`;
      default:
        return folio;
    }
  }

  abrirFila(f: Fila | Fila[] | undefined): void { if (f && !Array.isArray(f)) this.sel.set(f); }
  cerrarFila(abierto: boolean): void { if (!abierto) this.sel.set(null); }

  textoFalta(h: Hueco): string {
    if (h.falta) return 'Cuenta en lo que falta explicar.';
    if (h.tipo === 'bulto_sin_contar') return 'Va aparte: nadie lo ha contado, no se sabe si falta.';
    if (h.tipo === 'libro_sin_ligar') return 'Va aparte: ya está capturado y se sabe de qué es; falta su liga.';
    return 'Va aparte.';
  }

  /** La sucursal por su NOMBRE: la manda el hueco, o la lleva la llave de Kepler (`07|U-A-5|…`, `01-003|…`). */
  sucursalDe(h: Hueco): string | null {
    const c = h.sucursal ?? (/^\d{2}(?=[|-])/.exec(h.ref)?.[0] ?? null);
    return c ? warehouseName(c) : null;
  }

  testigosDe(h: Hueco): { k: Eslabon; label: string; v: Testigo }[] {
    return ESLABONES.map((e) => ({ ...e, v: h.testigos?.[e.k] ?? 'na' })).filter((t) => t.v !== 'na');
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
    return p[0];
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

  // ── El balance físico ──────────────────────────────────────────────────────────────────────

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
  opcionesEstado(d: CajaWb): SegOption[] {
    const c = this.cuenta(d);
    return [
      { label: 'Todos', value: '', count: d.por_dia.length },
      { label: 'No cuadran', value: 'no_cuadra', count: c.no_cuadra },
      { label: 'Falta capturar', value: 'por_capturar', count: c.por_capturar },
      { label: 'Cuadran', value: 'cuadra', count: c.cuadra },
    ];
  }
  setEstado(v: string): void { this.estado.set(this.estado() === v && v ? '' : v); }
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
  readonly dayRow = signal<DiaCuadre | null>(null);
  readonly dfEstado = signal<'' | 'sin' | 'con'>('');
  readonly dfSearch = signal('');

  dayTitle(): string { return this.dayKey() ? `El ${this.dmy(this.dayKey())}` : 'El día'; }
  /** Los totales del día van al subtítulo: la tabla de días ya no los repite en seis columnas. */
  daySub(): string | null {
    const r = this.dayRow();
    if (!r) return null;
    const k = r.kp_n ? ` · Kepler entró ${money(r.kp_ingreso)} y salió ${money(r.kp_gasto)}` : ' · Kepler sin datos';
    return `Caja entró ${money(r.mdb_ingreso)} y salió ${money(r.mdb_gasto)}${k}`;
  }

  /** La fila elegida con clic, Enter o Espacio (pSelectableRow) abre su día; volver a elegirla también. */
  alElegir(d: DiaCuadre | DiaCuadre[] | undefined): void { if (d && !Array.isArray(d)) this.openDay(d); }

  openDay(r: DiaCuadre): void {
    const dk = String(r.fecha).slice(0, 10);
    this.dayKey.set(dk); this.dayRow.set(r);
    this.dfEstado.set(''); this.dfSearch.set('');
    this.dayOpen.set(true);
    if ((dk in this.wbDayDia()) || this.wbDayLoad()[dk]) return;
    this.wbDayLoad.set({ ...this.wbDayLoad(), [dk]: true });
    this.http.get<ConcDia>(`${this.base}/conciliacion-dia?from=${dk}&to=${dk}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.wbDayDia.set({ ...this.wbDayDia(), [dk]: d }); this.wbDayLoad.set({ ...this.wbDayLoad(), [dk]: false }); },
      error: (e) => { this.wbDayErr.set({ ...this.wbDayErr(), [dk]: this.httpMsg(e, '/caja/conciliacion-dia') }); this.wbDayLoad.set({ ...this.wbDayLoad(), [dk]: false }); },
    });
  }

  /**
   * El día en UNA tabla: cada movimiento de la caja con su par, y lo que sólo Kepler tiene. Lo que no
   * tiene par va primero, del mayor al menor. ⛔ Lo casado sólo por importe NO cuenta como casado.
   */
  detalle(cd: ConcDia): DetRow[] {
    const caja: DetRow[] = cd.rows.map((e) => {
      const casado = e.kepler && (e.kepler_origen === 'llave' || e.kepler_origen === 'identidad' || e.kepler_origen === 'ruta');
      let par: string;
      if (e.kepler && e.kepler_origen === 'llave') par = 'igual, por el documento';
      else if (e.kepler && e.kepler_origen === 'identidad') par = 'igual, misma ruta y día';
      else if (e.kepler && e.kepler_origen === 'ruta') par = 'venta de la camioneta';
      else if (e.kepler) par = e.kepler_ambiguo ? 'por confirmar: sólo el importe, y hay más de un candidato' : 'por confirmar: sólo coincide el importe';
      else par = e.kepler_motivo || 'Kepler no lo tiene';
      if (e.kepler && e.kepler_delta) par += ` · ${e.kepler_delta < 0 ? 'entró ' + money(Math.abs(e.kepler_delta)) + ' menos' : 'entró ' + money(e.kepler_delta) + ' más'}`;
      return {
        key: 'c|' + e.key + e.dir, dir: e.dir, concepto: e.concepto || e.extra || '—', libro: e.source === 'libro',
        caja: e.importe, kepler: e.kepler ? e.kepler_importe : null, casado, par, parAviso: !casado,
        cajaMov: { source: e.source ?? 'control', key: e.key },
        keplerMov: e.kepler && e.kepler_source && e.kepler_key ? { source: e.kepler_source, key: e.kepler_key } : null,
      };
    });
    const v = cd.vs_kepler;
    const soloKepler: DetRow[] = [...v.ingresos.other_only.map((o) => ({ ...o, dir: 'in' as const })), ...v.gastos.other_only.map((o) => ({ ...o, dir: 'out' as const }))]
      .map((o) => ({
        key: 'k|' + o.key + o.dir, dir: o.dir, concepto: o.concepto || o.extra || '—', libro: false, caja: null, kepler: o.importe,
        casado: !!o.en_libro, par: o.en_libro ? `sólo en Kepler; ya está en el libro (${o.en_libro.folio})` : 'sólo en Kepler: falta capturarlo',
        parAviso: !o.en_libro, cajaMov: null, keplerMov: { source: o.source, key: o.key },
      }));
    const monto = (r: DetRow) => Math.max(r.caja ?? 0, r.kepler ?? 0);
    return [...caja, ...soloKepler].sort((a, b) => Number(a.casado) - Number(b.casado) || monto(b) - monto(a));
  }
  opcionesDet(cd: ConcDia): SegOption[] {
    const rs = this.detalle(cd);
    const sin = rs.filter((r) => !r.casado).length;
    return [{ label: 'Todos', value: '', count: rs.length }, { label: 'Sin par', value: 'sin', count: sin }, { label: 'Con su par', value: 'con', count: rs.length - sin }];
  }
  setDfEstado(v: string): void { this.dfEstado.set(v === 'sin' || v === 'con' ? v : ''); }
  detVista(cd: ConcDia): DetRow[] {
    const est = this.dfEstado(), q = this.dfSearch();
    return this.detalle(cd).filter((r) => (!est || (est === 'sin' ? !r.casado : r.casado)) && coincideBusqueda(q, r.concepto, r.caja, r.kepler));
  }
  abrirMov(m: { source: MovSource; key: string } | null): void { if (m) this.openMovement(m.source, m.key); }

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
