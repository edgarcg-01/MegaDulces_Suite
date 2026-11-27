import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { CheckboxModule } from 'primeng/checkbox';
import { DatePickerModule } from 'primeng/datepicker';
import { InputNumberModule } from 'primeng/inputnumber';
import { TextareaModule } from 'primeng/textarea';
import type {
  AltaRapidaResultado, CompletarGuiaBody, DesgloseDeOperacion, FaltaDelViaje, GuiaDelMismoViaje, OperacionDelReporte,
  PersonaDelPadron, ReporteDePagos, SinCentro, TripulacionGuiaBody, TripulacionSugerida, ViajeGps,
} from '@megadulces/contracts';
// Por subruta, no por el barrel: ver tsconfig.base.json (bundle inicial).
import {
  corteVecino, esFecha, FALTA_LABEL, MOTIVO_MINIMO_REABRIR, SIN_CENTRO_LABEL, repartoDeCarga, ROL_LABEL, TIPO_VIAJE_LABEL, totalDeCarga,
} from '@megadulces/contracts/http/cierre-viaje';
import { coincideBusqueda } from '@megadulces/ui-web';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { SegmentedComponent, SegOption } from '../../../shared/components/segmented/segmented.component';
import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { LogisticaService } from '../logistica.service';
import { AltaPersonaComponent } from '../components/alta-persona.component';
import { DesgloseOperacionComponent } from '../components/desglose-operacion.component';

type Vista = 'pendientes' | 'completas' | 'todas';
/** `[EMB.52]` Qué le pasa a la operación (el filtro «Cualquier estado»). */
type EstadoFiltro = FaltaDelViaje | 'sin_tarifa' | 'sin_cajas' | 'sueltas';
type Orden = 'falta' | 'fecha_desc' | 'fecha_asc' | 'cajas' | 'carga' | 'comision' | 'asignado' | 'guia';

const ESTADOS_FILTRO: ReadonlyArray<{ value: EstadoFiltro; label: string }> = [
  { value: 'chofer', label: 'Falta el chofer' },
  { value: 'horario', label: 'Falta el horario' },
  { value: 'cargadores', label: 'Falta quién cargó' },
  { value: 'sin_tarifa', label: 'Ruta sin tarifa' },
  { value: 'sin_cajas', label: 'Sin cajas de Kepler' },
  { value: 'sueltas', label: 'Lleva unidades sueltas' },
];
const ORDENES: ReadonlyArray<{ value: Orden; label: string }> = [
  { value: 'falta', label: 'Orden: lo que más falta' },
  { value: 'fecha_desc', label: 'Orden: más recientes' },
  { value: 'fecha_asc', label: 'Orden: más antiguas' },
  { value: 'cajas', label: 'Orden: más cajas' },
  { value: 'carga', label: 'Orden: mayor carga' },
  { value: 'comision', label: 'Orden: mayor comisión' },
  { value: 'asignado', label: 'Orden: mayor asignado' },
  { value: 'guia', label: 'Orden: por guía' },
];

/** `[EMB.52]` Si la operación cumple el estado del filtro. */
export function cumpleEstado(o: OperacionDelReporte, e: EstadoFiltro): boolean {
  if (e === 'sin_tarifa') return o.comision_ruta.chofer == null;
  if (e === 'sin_cajas') return o.cajas == null;
  if (e === 'sueltas') return (o.sueltos ?? 0) > 0;
  return o.faltan.includes(e);
}

/** Todos los que tocan la operación: cobran algo, la manejan, ayudan o cargan. */
function personasDe(o: OperacionDelReporte): string[] {
  return [...o.renglones.map((r) => r.persona_id), o.driver_id, o.chofer_kepler_id, o.helper1_id, o.helper2_id, ...o.cargador_ids]
    .filter((x): x is string => !!x);
}

/** `[EMB.52]` El orden elegido; a igualdad, sucursal y guía, para que la lista no baile entre recargas. */
export function ordenar<T extends OperacionDelReporte>(xs: T[], orden: Orden): T[] {
  const n = (v: number | null | undefined): number => v ?? -1;
  const cmp: Record<Orden, (a: T, b: T) => number> = {
    falta: (a, b) => b.faltan.length - a.faltan.length || a.fecha.localeCompare(b.fecha),
    fecha_desc: (a, b) => b.fecha.localeCompare(a.fecha),
    fecha_asc: (a, b) => a.fecha.localeCompare(b.fecha),
    cajas: (a, b) => n(b.cajas) - n(a.cajas),
    carga: (a, b) => n(b.carga_total) - n(a.carga_total),
    comision: (a, b) => n(b.comision_ruta.chofer) - n(a.comision_ruta.chofer),
    asignado: (a, b) => b.repartido - a.repartido,
    guia: () => 0,
  };
  return [...xs].sort((a, b) => cmp[orden](a, b) || a.sucursal.localeCompare(b.sucursal) || a.guia.localeCompare(b.guia));
}
type Operacion = OperacionDelReporte & { clave: string };

const llave = (o: Pick<OperacionDelReporte, 'sucursal' | 'guia'>): string => `${o.sucursal}|${o.guia}`;
const hhmm = (d: Date | null): string | null =>
  d ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : null;
/** `HH:MM` → la fecha que espera el selector de hora (sólo cuentan la hora y los minutos). */
const aHora = (h: string): Date => {
  const [hh, mm] = h.split(':').map(Number);
  const d = new Date();
  d.setHours(hh, mm, 0, 0);
  return d;
};
/** `HH:MM` (24 h) → `h:MM AM/PM`, como lo muestran los campos de hora. */
export const hora12 = (h: string): string => {
  const [hh, mm] = h.split(':').map(Number);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return h;
  return `${hh % 12 === 0 ? 12 : hh % 12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
};
const mensaje = (e: unknown, def: string): string => {
  const x = e as { error?: { message?: string | string[] }; message?: string } | null;
  const m = x?.error?.message ?? x?.message;
  return (Array.isArray(m) ? m.join(' ') : m) || def;
};

/**
 * `[EMB.47]` — **Logística › Pagos de viaje › Operaciones.**
 *
 * La pregunta que contesta: de cada operación de la catorcena (traspaso o entrega a cliente),
 * ¿cuánto le toca a cada quien? Kepler ya sabe la operación y sus cajas; lo único que NO sabe es
 * quién fue. Aquí se agrega al chofer, a los ayudantes y a los cargadores —y si alguien no está en
 * el padrón, se da de alta en el momento— y el reparto sale solo. Las solicitudes de gasto se sacan
 * en «Por persona».
 *
 * Jerarquía: primario = cuánto ya está repartido y a cuántas operaciones les falta quién fue;
 * secundario = la lista; terciario = guía, destinos y cajas de cada fila.
 */
@Component({
  selector: 'app-logistica-pagos-viajes',
  standalone: true,
  imports: [
    CurrencyPipe, DecimalPipe, FormsModule, RouterLink, TableModule, SelectModule, MultiSelectModule, ButtonModule, TagModule,
    CheckboxModule, DatePickerModule, InputNumberModule, TextareaModule, LoadStateComponent, MetricStripComponent, FreshnessPillComponent, SidePeekComponent,
    SegmentedComponent, SucursalPipe, AltaPersonaComponent, DesgloseOperacionComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page pv">
      <div class="pv-cabeza">
        <div class="pv-corte" role="group" aria-label="Catorcena">
          <button pButton type="button" [text]="true" size="small" (click)="mover(-1)"
                  [disabled]="!data()" aria-label="Catorcena anterior"><span class="p-button-icon pi pi-chevron-left" aria-hidden="true"></span></button>
          <span class="pv-corte-txt">
            @if (data(); as d) { Catorcena {{ fechaCorta(d.corte.desde) }} a {{ fechaCorta(d.corte.hasta) }} · se paga el {{ fechaCorta(d.corte.pago) }} }
            @else { Catorcena }
          </span>
          <button pButton type="button" [text]="true" size="small" (click)="mover(1)"
                  [disabled]="!data()" aria-label="Catorcena siguiente"><span class="p-button-icon pi pi-chevron-right" aria-hidden="true"></span></button>
        </div>
        @if (data(); as d) {
          <app-freshness-pill measures="fetch" [since]="d.leido_at" label="operaciones de Kepler" />
        }
      </div>

      @if (data(); as d) {
        <p class="pv-titular">{{ titular() }}</p>
        @if (!enCierre()) {
          <p class="pv-sub pv-historial" role="note">
            <span class="pi pi-lock" aria-hidden="true"></span>
            Historial: aquí se consulta y no se edita. Los viajes se cierran en
            <a routerLink="/logistica/shipments" [queryParams]="{ vista: 'cerrar' }" class="pv-link">Embarques › Cerrar viajes</a>,
            cuando el camión regresa con su hoja de viaje.
          </p>
        }
        <app-metric-strip [items]="kpis()" mode="strip" density="compact" ariaLabel="Operaciones de la catorcena" />
      }

      <app-load-state [loading]="cargando() && !data()" [error]="error()" [isEmpty]="!!data() && !data()!.operaciones.length"
                      emptyIcon="pi-truck" emptyTitle="Sin operaciones de Kepler en esta catorcena"
                      emptyHint="Sólo cuentan traspasos y entregas a cliente; las cargas a camión de ruta no pagan comisión, viático ni carga."
                      (retry)="cargar()">
        <section class="pv-barra" aria-label="Filtros">
          <app-segmented [options]="vistas()" [value]="vista()" (valueChange)="vista.set($any($event))" ariaLabel="Qué operaciones ver" />
          <p-select [options]="sucursales()" optionLabel="label" optionValue="value" [ngModel]="sucursal()"
                    (ngModelChange)="sucursal.set($event)" [showClear]="true" placeholder="Todas las sucursales"
                    ariaLabel="Sucursal" appendTo="body" class="pv-sel" />
          <!-- [EMB.52] Filtros de la pantalla principal y el orden, que también manda en la vista de tarjetas. -->
          <p-select [options]="tipos" optionLabel="label" optionValue="value" [ngModel]="tipoFiltro()"
                    (ngModelChange)="tipoFiltro.set($event)" [showClear]="true" placeholder="Todos los tipos"
                    ariaLabel="Tipo de operación" appendTo="body" class="pv-sel-chico" />
          <p-select [options]="estados" optionLabel="label" optionValue="value" [ngModel]="estadoFiltro()"
                    (ngModelChange)="estadoFiltro.set($event)" [showClear]="true" placeholder="Cualquier estado"
                    ariaLabel="Qué le falta" appendTo="body" class="pv-sel-chico" />
          <p-select [options]="personasFiltro()" optionLabel="label" optionValue="value" [ngModel]="personaFiltro()" [filter]="true"
                    (ngModelChange)="personaFiltro.set($event)" [showClear]="true" placeholder="Cualquier persona"
                    ariaLabel="Persona" appendTo="body" class="pv-sel" />
          <p-select [options]="dias()" optionLabel="label" optionValue="value" [ngModel]="diaFiltro()"
                    (ngModelChange)="diaFiltro.set($event)" [showClear]="true" placeholder="Todos los días"
                    ariaLabel="Día" appendTo="body" class="pv-sel-chico" />
          <p-select [options]="ordenes" optionLabel="label" optionValue="value" [ngModel]="orden()"
                    (ngModelChange)="orden.set($event ?? 'falta')" ariaLabel="Ordenar por" appendTo="body" class="pv-sel" />
          <label class="pv-buscar">
            <span class="sr-only">Buscar operación</span>
            <input type="search" [value]="busqueda()" (input)="busqueda.set($any($event.target).value)"
                   placeholder="Guía, destino o persona" autocomplete="off" spellcheck="false" />
          </label>
          <span class="pv-cuenta">{{ filtrados().length }} de {{ data()?.operaciones?.length ?? 0 }} operaciones</span>
        </section>

        <div class="dt-scope">
          <p-table [value]="filtrados()" dataKey="clave" selectionMode="single" [selection]="seleccion()"
                   (onRowSelect)="alSeleccionar($event.data)" [paginator]="filtrados().length > 50" [rows]="50"
                   [showCurrentPageReport]="true" currentPageReportTemplate="{first}–{last} de {totalRecords}"
                   size="small" class="surf-table surf-table--plain surf-table--sticky surf-table--frozen-first dt-stack"
                   [tableStyle]="{ 'min-width': '72rem' }">
            <ng-template #header>
              <tr>
                <th scope="col">Guía</th>
                <th scope="col">Fecha</th>
                <th scope="col">Tipo</th>
                <th scope="col">Destinos</th>
                <th scope="col" class="comm-num">Cajas</th>
                <th scope="col" class="comm-num">Carga</th>
                <th scope="col" class="comm-num">Comisión chofer</th>
                <th scope="col">Quién fue</th>
                <th scope="col" class="comm-num">A pagar</th>
                <th scope="col">Qué falta</th>
              </tr>
            </ng-template>
            <ng-template #body let-o>
              <tr [pSelectableRow]="o" [attr.aria-label]="'Abrir la guía ' + o.guia + ' de ' + (o.sucursal | sucursal)">
                <td data-label="Guía">
                  <span class="pv-guia">{{ o.guia }}</span>
                  <span class="pv-sub">{{ o.sucursal | sucursal }}</span>
                </td>
                <td data-label="Fecha">{{ fechaCorta(o.fecha) }}</td>
                <td data-label="Tipo">{{ tipoLabel(o.tipo) }}</td>
                <td data-label="Destinos" class="pv-destinos">{{ o.destinos || '—' }}</td>
                <td data-label="Cajas" class="comm-num">
                  {{ o.cajas == null ? '—' : (o.cajas | number:'1.0-0') }}
                  @if (o.sueltos) { <span class="pv-sub">+{{ o.sueltos | number:'1.0-0' }} sueltas</span> }
                </td>
                <td data-label="Carga" class="comm-num">
                  @if (o.carga_total != null) { {{ o.carga_total | currency:'MXN':'symbol-narrow':'1.2-2' }} }
                  @else { <span class="pv-tenue">{{ o.tarifa_por_caja == null ? 'Sin tarifa' : 'Sin cajas' }}</span> }
                </td>
                <td data-label="Comisión chofer" class="comm-num">
                  @if (o.comision_ruta.chofer != null) {
                    {{ o.comision_ruta.chofer | currency:'MXN':'symbol-narrow':'1.0-2' }}
                    <span class="pv-sub">{{ o.comision_ruta.ruta }}</span>
                  } @else { <span class="pv-aviso">Ruta sin tarifa</span> }
                </td>
                <td data-label="Quién fue">
                  @if (choferDe(o); as ch) { {{ ch.nombre }}@if (ch.deKepler) { <span class="pv-tenue"> (Kepler)</span> } }
                  @else if (o.chofer_kepler) { <span class="pv-tenue">{{ o.chofer_kepler }} (Kepler, fuera del padrón)</span> }
                  @else { <span class="pv-tenue">—</span> }
                  <span class="pv-sub">{{ equipo(o) }}</span>
                </td>
                <td data-label="A pagar" class="comm-num">
                  {{ o.repartido | currency:'MXN':'symbol-narrow':'1.2-2' }}
                  @if (o.por_cerrar) { <span class="pv-sub">+{{ o.por_cerrar | currency:'MXN':'symbol-narrow':'1.2-2' }} por cerrar</span> }
                </td>
                <td data-label="Qué falta">
                  @for (f of o.faltan; track f) { <p-tag [value]="faltaLabel(f)" severity="warn" class="pv-tag" /> }
                  @empty { <p-tag value="Completa" severity="success" /> }
                </td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="10" class="pv-vacio">Ninguna operación con este filtro.</td></tr>
            </ng-template>
          </p-table>
        </div>
      </app-load-state>

      <app-side-peek [open]="peek()" (openChange)="!$event && cerrar()" [width]="640"
                     [title]="op() ? 'Guía ' + op()!.guia : ''"
                     [subtitle]="op() ? subtituloPeek(op()!) : null">
        @if (op(); as o) {
          <div class="pv-peek">
            <dl class="pv-datos">
              <div><dt>Destinos</dt><dd>{{ o.destinos || '—' }}</dd></div>
              <div><dt>Cajas</dt><dd>{{ o.cajas == null ? 'Kepler no las trae todavía' : (o.cajas | number:'1.0-0') }}</dd></div>
              <div><dt>Carga</dt><dd>{{ textoCarga(o) }}</dd></div>
              <div><dt>Comisión de la ruta</dt><dd>{{ textoComision(o) }}</dd></div>
              <div><dt>Centro de costo</dt><dd>{{ o.centro ? o.centro.codigo + ' · ' + o.centro.nombre : sinCentro(o.sin_centro) }}</dd></div>
              <div><dt>Chofer en Kepler</dt><dd>{{ o.chofer_kepler || 'Kepler no lo trae' }}</dd></div>
            </dl>
            @if (o.sueltos) {
              <p class="pv-sub">Además lleva {{ o.sueltos | number:'1.0-0' }} unidades en paquete, pieza o kilo: no pagan por caja.</p>
            }

            @if (avisoPeek(); as a) { <div class="pv-msg pv-msg-ok" role="status">{{ a }}</div> }
            @if (errorPeek(); as e) { <div class="pv-msg pv-msg-bad" role="alert">{{ e }}</div> }

            <!-- [EMB.50] El movimiento documento por documento: cajas, quién lo hizo y la recepción. -->
            <section class="pv-paso" aria-labelledby="pv-desglose">
              <h3 id="pv-desglose">Desglose del movimiento</h3>
              <app-load-state [loading]="cargandoDesglose()" [error]="errorDesglose()"
                              [isEmpty]="!!desglose() && !desglose()!.documentos.length" [skeletonRows]="3"
                              emptyIcon="pi-file" emptyTitle="Kepler no trae documentos de esta guía" (retry)="cargarDesglose(o)">
                <app-desglose-operacion [desglose]="desglose()" />
              </app-load-state>
            </section>

            <!-- Chofer y ayudantes: de aquí salen la comisión (por la ruta) y el viático (por el horario). -->
            <section class="pv-paso" aria-labelledby="pv-tripulacion">
              <h3 id="pv-tripulacion">Chofer y ayudantes</h3>
              @if (o.reabierta; as r) {
                <p class="pv-sub pv-sugerida" role="note">
                  <span class="pi pi-replay" aria-hidden="true"></span>
                  <span>Se reabrió el {{ fechaHora(r.en) }}: «{{ r.motivo }}».</span>
                </p>
              }
              @if (guiaCompleta(o)) {
                <dl class="pv-datos">
                  <div><dt>Chofer</dt><dd>{{ nombre(o.driver_id) }}</dd></div>
                  <div><dt>Ayudantes</dt><dd>{{ ayudantes(o) }}</dd></div>
                  <div><dt>Salida y llegada</dt><dd>{{ hora12(o.departure_time!) }} a {{ hora12(o.arrival_time!) }}@if (o.overnight) { · durmió fuera }</dd></div>
                  <div><dt>Km recorridos</dt><dd>{{ o.km == null ? 'No se capturaron' : (o.km | number:'1.0-0') + ' km' }}</dd></div>
                </dl>
                <p class="pv-sub">Viaje cerrado: con esto se calcularon la comisión y el viático.@if (!enCierre()) { Para corregirlo, se reabre con motivo. }</p>
                @if (puedeReabrir()) {
                  @if (!reabriendo()) {
                    <button pButton type="button" [text]="true" size="small" severity="secondary" class="pv-alta" (click)="reabriendo.set(true)"><span class="p-button-icon p-button-icon-left pi pi-replay" aria-hidden="true"></span><span class="p-button-label">Reabrir con motivo</span></button>
                  } @else {
                    <div class="pv-form pv-reabrir">
                      <label for="pv-motivo">¿Por qué se reabre?</label>
                      <textarea pTextarea id="pv-motivo" rows="2" [value]="motivo()" (input)="motivo.set($any($event.target).value)"
                                placeholder="Por ejemplo: el ayudante era otro, la hora de regreso estaba mal"></textarea>
                      <p class="pv-sub">Se borran el horario, la comisión y el viático; la tripulación se queda. Se vuelve a cerrar en Embarques › Cerrar viajes. Si ya se capturó en Kepler, corrígelo también allá.</p>
                      <div class="pv-acciones">
                        <button pButton type="button" size="small" severity="danger" [loading]="guardandoReabrir()"
                                [disabled]="motivo().trim().length < motivoMinimo || guardandoReabrir()" (click)="reabrir(o)"><span class="p-button-label">Reabrir viaje</span></button>
                        <button pButton type="button" size="small" [text]="true" (click)="reabriendo.set(false)"><span class="p-button-label">Cancelar</span></button>
                      </div>
                    </div>
                  }
                }
              } @else if (!puedeCapturar()) {
                @if (enCierre()) {
                  <p class="pv-sub">Falta capturarlos. Lo hace quien gestiona Pagos de viaje.</p>
                } @else {
                  <p class="pv-sub">Este viaje todavía no se cierra.
                    <a routerLink="/logistica/shipments" [queryParams]="ligaCierre(o)" class="pv-link">Cerrarlo en Embarques</a>
                  </p>
                }
              } @else {
                <div class="pv-form">
                  <label for="pv-chofer">Chofer</label>
                  @if (o.driver_id ?? o.chofer_kepler_id; as fijo) {
                    <p class="pv-fijo" id="pv-chofer">{{ nombre(fijo) }} <span class="pv-sub">(viene de Kepler)</span></p>
                  } @else {
                    <p-select inputId="pv-chofer" [options]="opciones()" optionLabel="full_name" optionValue="id" [filter]="true"
                              [ngModel]="chofer()" (ngModelChange)="chofer.set($event)"
                              placeholder="Elige al chofer" appendTo="body" />
                    @if (o.chofer_kepler) { <span class="pv-sub">Kepler dice «{{ o.chofer_kepler }}», pero no está en el padrón activo.</span> }
                  }
                  <label for="pv-ay1">Ayudante 1 <span class="pv-sub pv-inline">(opcional)</span></label>
                  <p-select inputId="pv-ay1" [options]="opciones()" optionLabel="full_name" optionValue="id" [filter]="true" [showClear]="true"
                            [ngModel]="ayudante1()" (ngModelChange)="ayudante1.set($event)" placeholder="Nadie" appendTo="body" />
                  <label for="pv-ay2">Ayudante 2 <span class="pv-sub pv-inline">(opcional)</span></label>
                  <p-select inputId="pv-ay2" [options]="opciones()" optionLabel="full_name" optionValue="id" [filter]="true" [showClear]="true"
                            [ngModel]="ayudante2()" (ngModelChange)="ayudante2.set($event)" placeholder="Nadie" appendTo="body" />
                  @if (sugeridaVigente(); as s) {
                    <p class="pv-sub pv-sugerida" role="note">
                      <span class="pi pi-history" aria-hidden="true"></span>
                      @if (s.helper1_id) { Los mismos ayudantes de su viaje del {{ fechaCorta(s.fecha) }}@if (s.guia) { (guía {{ s.guia }}) }. }
                      @else { En su viaje del {{ fechaCorta(s.fecha) }}@if (s.guia) { (guía {{ s.guia }}) } fue sin ayudantes. }
                      Revísalo antes de guardar.
                    </p>
                  }
                  <button pButton type="button" [text]="true" size="small" class="pv-alta" (click)="altaAyudante.set(true)"><span class="p-button-icon p-button-icon-left pi pi-user-plus" aria-hidden="true"></span><span class="p-button-label">Agregar ayudante nuevo</span></button>
                  <div class="pv-horas">
                    <div>
                      <label for="pv-salida">Salida</label>
                      <p-datepicker inputId="pv-salida" [timeOnly]="true" hourFormat="12" [ngModel]="salida()" (ngModelChange)="salida.set($event)" appendTo="body" />
                    </div>
                    <div>
                      <label for="pv-llegada">Llegada</label>
                      <p-datepicker inputId="pv-llegada" [timeOnly]="true" hourFormat="12" [ngModel]="llegada()" (ngModelChange)="llegada.set($event)" appendTo="body" />
                    </div>
                  </div>
                  <label class="pv-check"><p-checkbox [binary]="true" inputId="pv-noche" [ngModel]="durmio()" (ngModelChange)="durmio.set($event)" /> Durmió fuera</label>
                  <label for="pv-km">Km recorridos <span class="pv-sub pv-inline">(de la hoja de viaje, opcional)</span></label>
                  <p-inputnumber inputId="pv-km" [ngModel]="km()" (ngModelChange)="km.set($event)" [min]="0" [max]="5000"
                                 [useGrouping]="false" suffix=" km" placeholder="Sin capturar" />
                  @if (horarioGpsVigente(); as h) {
                    <p class="pv-sub pv-sugerida" role="note">
                      <span class="pi pi-map-marker" aria-hidden="true"></span>
                      Según el GPS de la unidad: salió@if (h.dia_salida) { el {{ fechaCorta(h.dia_salida) }} } a las {{ hora12(h.salida) }} y regresó a las {{ hora12(h.llegada) }}@if (h.duerme_fuera) { del día siguiente}@if (h.km != null) { ({{ h.km }} km)}.
                      Sin confirmar: revísalo antes de guardar.
                    </p>
                  } @else if (sinHorarioGps(); as motivo) {
                    <p class="pv-sub" role="note">Sin horario del GPS: {{ motivo }}</p>
                  }
                  @if (o.tripulacion_guardada_en) {
                    <p class="pv-sub" role="note">
                      <span class="pi pi-user" aria-hidden="true"></span>
                      Tripulación guardada al salir ({{ fechaHora(o.tripulacion_guardada_en) }}). Se puede corregir hasta capturar el horario.
                    </p>
                  }
                  @if (erroresTripulacion(o).length) {
                    <ul class="pv-errs">@for (e of erroresTripulacion(o); track e) { <li>{{ e }}</li> }</ul>
                  }
                  <button pButton type="button" [loading]="guardandoGuia()"
                          [disabled]="erroresTripulacion(o).length > 0 || guardandoGuia()" (click)="guardarTripulacion(o)"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">{{ soloTripulacion() ? 'Guardar tripulación' : 'Cerrar viaje y calcular comisiones' }}</span></button>
                  @if (soloTripulacion()) {
                    <p class="pv-sub">Al salir basta con quién va: se puede corregir hasta capturar el horario. Al regresar, con el horario se calculan la comisión y el viático.</p>
                  } @else {
                    <p class="pv-sub">Cierra el viaje: con esto se calculan la comisión (por la ruta) y el viático (por el horario). Si después hay un error, se reabre con motivo desde Pagos de viaje.</p>
                  }
                </div>
              }
            </section>

            <!-- Quién cargó: cajas × tarifa, en partes iguales. -->
            <section class="pv-paso" aria-labelledby="pv-carga">
              <h3 id="pv-carga">Quién cargó</h3>
              @if (o.tarifa_por_caja == null) {
                <div class="pv-msg pv-msg-warn">No hay tarifa de carga por caja vigente para esta fecha: captúrala en la pestaña Tarifas. Sin tarifa no se reparte: un cero sería no pagar.</div>
              } @else if (o.cajas == null) {
                <div class="pv-msg pv-msg-warn">Kepler todavía no trae los renglones de esta guía: no se sabe cuántas cajas lleva y la carga no se puede repartir.</div>
              } @else if (!puedeCapturar()) {
                <p class="pv-sub">{{ o.cargadores ? cargadoresTexto(o) : (enCierre() ? 'Falta registrar quién cargó. Lo hace quien gestiona Pagos de viaje.' : 'Falta registrar quién cargó: se hace al cerrar el viaje en Embarques.') }}</p>
              } @else {
                <div class="pv-ms">
                  <label class="sr-only" for="pv-cargadores">Cargadores</label>
                  <p-multiselect inputId="pv-cargadores" [options]="opciones()" optionLabel="full_name" optionValue="id"
                                 [ngModel]="cargadoresSel()" (ngModelChange)="cargadoresSel.set($event ?? [])" [filter]="true"
                                 placeholder="Elige a quienes cargaron" display="chip" appendTo="body" />
                </div>
                <button pButton type="button" [text]="true" size="small" class="pv-alta" (click)="altaCargador.set(true)"><span class="p-button-icon p-button-icon-left pi pi-user-plus" aria-hidden="true"></span><span class="p-button-label">Agregar cargador nuevo</span></button>
                @if (textoReparto(o); as t) { <p class="pv-sub" role="status">{{ t }}</p> }
                <button pButton type="button" [loading]="guardandoCarga()" [disabled]="guardandoCarga()" (click)="guardarCargadores(o)"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">Guardar cargadores</span></button>
              }
            </section>

            <!-- Lo que sale de esta operación, persona por persona. -->
            <section class="pv-paso" aria-labelledby="pv-reparto">
              <h3 id="pv-reparto">Cuánto le toca a cada quien</h3>
              <!-- [CML.J] D17 A: el mismo viaje físico se paga una vez (el GPS sugiere, una persona confirma). -->
              @if (o.mismo_viaje_confirmado?.length) {
                <p class="pv-sub pv-sugerida" role="note">
                  <span class="pi pi-link" aria-hidden="true"></span>
                  <span>Mismo viaje que la guía {{ guiasTexto(o.mismo_viaje_confirmado!) }}: a cada persona se le paga la comisión mayor y un solo viático. La carga sigue por guía.
                    @if (puedeCapturar() && o.mismo_viaje_liga) {
                      <button pButton type="button" [text]="true" size="small" [disabled]="guardandoLiga()" (click)="ligarMismoViaje(o, null)"><span class="p-button-label">Deshacer</span></button>
                    }
                  </span>
                </p>
              }
              @for (g of mismoViajeSinConfirmar(); track g.sucursal + g.guia) {
                <p class="pv-aviso" role="note">
                  <span class="pi pi-exclamation-triangle" aria-hidden="true"></span>
                  @if (g.por === 'hoja') {
                    Posiblemente el mismo viaje que la guía {{ g.guia }}: es de la misma unidad y Kepler la capturó@if (g.hora_captura) { a las {{ hora12(g.hora_captura) }}}, mientras el camión estaba fuera según la hoja de viaje. Revisa no pagar el viaje dos veces.
                  } @else {
                    Salió en el mismo viaje que la guía {{ g.guia }} (misma unidad y misma salida según el GPS). Revisa no pagar el viaje dos veces.
                  }
                  @if (puedeCapturar()) {
                    <button pButton type="button" size="small" [outlined]="true" [loading]="guardandoLiga()" [disabled]="guardandoLiga()"
                            (click)="ligarMismoViaje(o, g)"><span class="p-button-label">Es el mismo viaje: pagar una vez</span></button>
                  }
                  <button pButton type="button" [text]="true" size="small" (click)="abrirMismoViaje(g)"
                          [attr.aria-label]="'Ver la guía ' + g.guia"><span class="p-button-label">Ver guía {{ g.guia }}</span></button>
                </p>
              }
              <!-- [CML.J2] Sin GPS y con la unidad compartida: no se adivina cuál fue el desvío. -->
              @if (mismoViajeOmitidas(); as n) {
                <p class="pv-sub" role="note">
                  <span class="pi pi-info-circle" aria-hidden="true"></span>
                  Kepler le hizo {{ n }} guías a esta unidad mientras el camión estaba fuera según la hoja: la clave de unidad la usan varios camiones, así que no se sugiere cuál fue el mismo viaje. Si hubo desvío, revisa no pagar el viaje dos veces.
                </p>
              }
              @if (o.renglones.length) {
                <div class="dt-scope">
                  <p-table [value]="o.renglones" size="small" class="surf-table surf-table--plain dt-stack">
                    <ng-template #header>
                      <tr><th scope="col">Persona</th><th scope="col">Papel</th><th scope="col">Concepto en Kepler</th><th scope="col" class="comm-num">Importe</th></tr>
                    </ng-template>
                    <ng-template #body let-r>
                      <tr>
                        <td data-label="Persona">
                          <a [routerLink]="['/logistica/pagos/personas']" [queryParams]="{ persona: r.persona_id }" class="pv-link">{{ r.persona }}</a>
                          <span class="pv-sub">{{ r.calculo }}</span>
                        </td>
                        <td data-label="Papel">{{ rolLabel(r.rol) }}@if (r.fuente === 'kepler') { <p-tag value="Por cerrar" severity="warn" class="pv-tag" /> }</td>
                        <td data-label="Concepto en Kepler"><span class="pv-guia">{{ r.codigo }}</span> <span class="pv-sub">{{ r.nombre_concepto }}</span></td>
                        <td data-label="Importe" class="comm-num">{{ r.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                      </tr>
                    </ng-template>
                    <ng-template #footer>
                      <tr><td colspan="3">A pagar (viaje cerrado)</td><td class="comm-num">{{ o.repartido | currency:'MXN':'symbol-narrow':'1.2-2' }}</td></tr>
                      @if (o.por_cerrar) {
                        <tr><td colspan="3">Por cerrar: se paga al cerrar el viaje</td><td class="comm-num">{{ o.por_cerrar | currency:'MXN':'symbol-narrow':'1.2-2' }}</td></tr>
                      }
                    </ng-template>
                  </p-table>
                </div>
                <a routerLink="/logistica/pagos/personas" class="pv-link">Ver las solicitudes por persona</a>
              } @else {
                <p class="pv-sub">Todavía a nadie: falta capturar quién fue.</p>
              }
            </section>
          </div>
        }
      </app-side-peek>

      <app-alta-persona rol="ayudante" [visible]="altaAyudante()" (visibleChange)="altaAyudante.set($event)" (creada)="ayudanteCreado($event)" />
      <app-alta-persona rol="cargador" [visible]="altaCargador()" (visibleChange)="altaCargador.set($event)" (creada)="cargadorCreado($event)" />
    </div>
  `,
  styles: [`
    :host { display: block; }
    .pv { display: flex; flex-direction: column; gap: var(--sp-3); padding-top: var(--sp-4); }
    .pv-cabeza { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: var(--sp-2); }
    .pv-corte { display: flex; align-items: center; gap: var(--sp-1); }
    .pv-corte-txt { font-weight: var(--fw-medium); font-variant-numeric: tabular-nums; }
    .pv-titular { margin: 0; font-size: var(--fs-lg); font-weight: var(--fw-bold); color: var(--fg-1); }
    .pv-barra { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-2); }
    .pv-sel { min-width: 14rem; }
    .pv-sel-chico { min-width: 10rem; }
    .pv-buscar input { min-width: 16rem; padding: var(--sp-2); border: 1px solid var(--border-color); border-radius: var(--r-md); background: transparent; color: inherit; font: inherit; }
    .pv-buscar input:focus-visible { outline: 2px solid var(--action); outline-offset: 1px; }
    .pv-cuenta { margin-left: auto; font-size: var(--fs-sm); color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .pv-guia { font-family: var(--font-mono); font-weight: var(--fw-medium); }
    .pv-sub { display: block; font-size: var(--fs-xs); color: var(--text-muted); }
    .pv-sugerida { display: flex; gap: var(--sp-1); align-items: baseline; margin: 0; }
    .pv-inline { display: inline; }
    .pv-tenue { color: var(--text-muted); }
    .pv-aviso { color: var(--warn-soft-fg); font-size: var(--fs-sm); }
    .pv-destinos { max-width: 22rem; }
    .pv-tag { margin: 0 var(--sp-1) var(--sp-1) 0; }
    .pv-vacio { padding: var(--sp-4); color: var(--text-muted); }
    .pv-peek { display: flex; flex-direction: column; gap: var(--sp-4); }
    .pv-datos { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: var(--sp-2) var(--sp-4); margin: 0; }
    .pv-datos dt { font-size: var(--fs-xs); color: var(--text-muted); }
    .pv-datos dd { margin: 0; font-weight: var(--fw-medium); }
    .pv-paso { display: flex; flex-direction: column; gap: var(--sp-2); padding-top: var(--sp-3); border-top: 1px solid var(--border-color); }
    .pv-paso h3 { margin: 0; font-size: var(--fs-body); font-weight: var(--fw-bold); }
    .pv-check { display: inline-flex; align-items: center; gap: var(--sp-2); min-height: 32px; }
    .pv-form { display: flex; flex-direction: column; gap: var(--sp-1); }
    .pv-form > label { font-size: var(--fs-sm); font-weight: var(--fw-medium); margin-top: var(--sp-2); }
    .pv-fijo { margin: 0; font-weight: var(--fw-medium); }
    .pv-alta { align-self: flex-start; }
    .pv-horas { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-3); margin-top: var(--sp-2); }
    .pv-horas label { display: block; font-size: var(--fs-sm); font-weight: var(--fw-medium); margin-bottom: var(--sp-1); }
    .pv-ms ::ng-deep .p-multiselect { width: 100%; }
    .pv-errs { margin: var(--sp-2) 0 0; padding-left: 1.1rem; color: var(--bad-soft-fg); font-size: var(--fs-xs); }
    .pv-msg { padding: var(--sp-2) var(--sp-3); border-radius: var(--r-md); font-size: var(--fs-sm); }
    .pv-msg-ok { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .pv-msg-bad { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .pv-msg-warn { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .pv-link { font-size: var(--fs-sm); }
    .pv-historial { display: flex; gap: var(--sp-1); align-items: baseline; flex-wrap: wrap; margin: 0; font-size: var(--fs-sm); }
    .pv-reabrir textarea { width: 100%; font: inherit; }
    .pv-acciones { display: flex; gap: var(--sp-2); }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    @container (max-width: 40rem) { .pv-cuenta { margin-left: 0; } }
  `],
})
export class LogisticaPagosViajesComponent {
  private readonly api = inject(LogisticaService);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  private readonly ruta = inject(ActivatedRoute);
  /**
   * `[EMB.51]` `?op=SUCURSAL|GUIA&desde=&hasta=`: llegar desde otra pantalla (la solicitud de una
   * persona) con la operación ya abierta, en SU catorcena.
   */
  private ligaPendiente: string | null = this.ruta.snapshot.queryParamMap.get('op');
  /**
   * `[CML.K]` Una sola ventana para capturar: **cierre** vive en Embarques › Cerrar viajes (se captura
   * quién fue, el horario y los km, y se calculan las comisiones); **historial** es Pagos de viaje,
   * sólo consulta (lo cerrado se corrige reabriéndolo con motivo). Lo dice la ruta (`data.modo`) o
   * quien lo incrusta; sin nada, cierre.
   */
  readonly modo = input<'cierre' | 'historial' | null>(null);
  readonly enCierre = computed(() => (this.modo() ?? this.ruta.snapshot?.data?.['modo'] ?? 'cierre') !== 'historial');
  private readonly sucursalPipe = new SucursalPipe();

  readonly data = signal<ReporteDePagos | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly vista = signal<Vista>('pendientes');
  readonly sucursal = signal<string | null>(null);
  readonly busqueda = signal('');

  readonly peek = signal(false);
  private readonly clave = signal<string | null>(null);
  readonly avisoPeek = signal<string | null>(null);
  readonly errorPeek = signal<string | null>(null);
  readonly chofer = signal<string | null>(null);
  readonly ayudante1 = signal<string | null>(null);
  readonly ayudante2 = signal<string | null>(null);
  /** `[CML.T1]` La tripulación con que se precargó el formulario (la del viaje anterior del chofer). */
  readonly sugerida = signal<TripulacionSugerida | null>(null);
  /** El aviso sólo vale mientras los ayudantes sigan siendo los sugeridos: si alguien los cambia, ya no. */
  readonly sugeridaVigente = computed(() => {
    const s = this.sugerida();
    const a1 = this.ayudante1();
    const a2 = this.ayudante2();
    return s && a1 === s.helper1_id && a2 === s.helper2_id ? s : null;
  });
  readonly salida = signal<Date | null>(null);
  readonly llegada = signal<Date | null>(null);
  readonly durmio = signal(false);
  /** `[CML.K]` Km de la hoja de viaje (opcional; el GPS los precarga si los tiene). */
  readonly km = signal<number | null>(null);
  readonly reabriendo = signal(false);
  readonly motivo = signal('');
  readonly guardandoReabrir = signal(false);
  readonly motivoMinimo = MOTIVO_MINIMO_REABRIR;
  /** `[CML.H]` El horario con que se precargó el formulario (el del GPS de la unidad). */
  readonly horarioGps = signal<ViajeGps | null>(null);
  /** El aviso sólo vale mientras salida, llegada y «durmió fuera» sigan siendo las del GPS. */
  readonly horarioGpsVigente = computed(() => {
    const h = this.horarioGps();
    return h && hhmm(this.salida()) === h.salida && hhmm(this.llegada()) === h.llegada && this.durmio() === h.duerme_fuera ? h : null;
  });
  /** Por qué el GPS no da el horario (sólo mientras falte capturarlo). */
  readonly sinHorarioGps = computed(() => {
    const o = this.op();
    const motivo = this.desglose()?.horario_gps?.motivo ?? null;
    return motivo && o && !this.guiaCompleta(o) && !this.salida() && !this.llegada() ? motivo : null;
  });
  /**
   * `[CML.HV]` Sin salida ni llegada se guarda SÓLO la tripulación (al salir): no calcula nada y se
   * corrige hasta capturar el horario. Con las dos horas se completa la guía (al regresar).
   */
  readonly soloTripulacion = computed(() => !this.salida() && !this.llegada());
  /** `[CML.J]` Otras guías que salieron en el mismo viaje físico (misma unidad, misma salida del GPS). */
  readonly mismoViaje = computed<GuiaDelMismoViaje[]>(() => this.desglose()?.horario_gps?.mismo_viaje ?? []);
  /** `[CML.J2]` Guías capturadas mientras el camión estaba fuera que NO se sugieren (unidad compartida). */
  readonly mismoViajeOmitidas = computed<number>(() => this.desglose()?.horario_gps?.mismo_viaje_omitidas ?? 0);
  /** Las sugeridas por el GPS que todavía nadie confirmó (las confirmadas ya se pagan una vez). */
  readonly mismoViajeSinConfirmar = computed<GuiaDelMismoViaje[]>(() => {
    const ya = new Set(this.op()?.mismo_viaje_confirmado ?? []);
    return this.mismoViaje().filter((g) => !ya.has(llave(g)));
  });
  readonly guardandoLiga = signal(false);
  readonly guardandoGuia = signal(false);
  readonly cargadoresSel = signal<string[]>([]);
  readonly guardandoCarga = signal(false);
  readonly altaAyudante = signal(false);
  readonly altaCargador = signal(false);
  /** `[EMB.50]` El desglose de la operación abierta (se pide al abrir el panel). */
  readonly desglose = signal<DesgloseDeOperacion | null>(null);
  readonly cargandoDesglose = signal(false);
  readonly errorDesglose = signal<string | null>(null);
  /** Quien se dio de alta aquí mismo: entra a las listas sin esperar a releer el padrón. */
  private readonly altas = signal<PersonaDelPadron[]>([]);

  /** Capturar ESCRIBE: lo mismo que piden los endpoints (`LOGISTICS_PAGOS_GESTIONAR`). */
  private readonly gestiona = computed(() => {
    if (this.perms.isAdmin()) return true;
    return (this.auth.user()?.permissions ?? {})[Permission.LOGISTICS_PAGOS_GESTIONAR] === true;
  });
  /** `[CML.K]` Se captura sólo en la ventana de cierre (Embarques); el historial no se edita. */
  readonly puedeCapturar = computed(() => this.enCierre() && this.gestiona());
  /** `[CML.K]` Reabrir (con motivo) se hace desde el historial, con el mismo permiso. */
  readonly puedeReabrir = computed(() => !this.enCierre() && this.gestiona());

  /** Las filas con su llave, para la selección de la tabla. */
  readonly operaciones = computed<Operacion[]>(() => (this.data()?.operaciones ?? []).map((o) => ({ ...o, clave: llave(o) })));
  readonly op = computed(() => this.operaciones().find((o) => o.clave === this.clave()) ?? null);
  readonly seleccion = computed(() => (this.peek() ? this.op() : null));

  readonly opciones = computed<PersonaDelPadron[]>(() => {
    const base = this.data()?.personas ?? [];
    const nuevas = this.altas().filter((a) => !base.some((p) => p.id === a.id));
    return [...base, ...nuevas].sort((a, b) => a.full_name.localeCompare(b.full_name, 'es'));
  });
  private readonly nombres = computed(() => {
    const m = new Map(this.opciones().map((p) => [p.id, p.full_name]));
    for (const o of this.data()?.operaciones ?? []) for (const r of o.renglones) if (!m.has(r.persona_id)) m.set(r.persona_id, r.persona);
    return m;
  });

  // `[EMB.52]` Filtros de la pantalla principal y el orden (también ordena la vista de tarjetas).
  readonly tipoFiltro = signal<OperacionDelReporte['tipo'] | null>(null);
  readonly estadoFiltro = signal<EstadoFiltro | null>(null);
  readonly personaFiltro = signal<string | null>(null);
  readonly diaFiltro = signal<string | null>(null);
  readonly orden = signal<Orden>('falta');
  readonly tipos = (['traspaso', 'cliente', 'mixto'] as const).map((value) => ({ value, label: TIPO_VIAJE_LABEL[value] }));
  // Copias: p-select pide un arreglo mutable.
  readonly estados = [...ESTADOS_FILTRO];
  readonly ordenes = [...ORDENES];

  readonly filtrados = computed(() => {
    const vista = this.vista();
    const suc = this.sucursal();
    const q = this.busqueda();
    const tipo = this.tipoFiltro();
    const estado = this.estadoFiltro();
    const persona = this.personaFiltro();
    const dia = this.diaFiltro();
    const lista = this.operaciones().filter((o) =>
      (vista === 'todas' || (vista === 'completas' ? !o.faltan.length : o.faltan.length > 0))
      && (!suc || o.sucursal === suc)
      && (!tipo || o.tipo === tipo)
      && (!estado || cumpleEstado(o, estado))
      && (!persona || personasDe(o).includes(persona))
      && (!dia || o.fecha === dia)
      && coincideBusqueda(q, o.guia, o.destinos, o.chofer_kepler, this.sucursalPipe.transform(o.sucursal),
        ...o.renglones.map((r) => r.persona)));
    return ordenar(lista, this.orden());
  });

  /** Quienes aparecen en la catorcena (cobran algo, manejan, ayudan o cargan), por nombre. */
  readonly personasFiltro = computed(() => {
    const m = new Map<string, string>();
    for (const o of this.operaciones()) {
      for (const r of o.renglones) m.set(r.persona_id, r.persona);
      for (const id of personasDe(o)) if (!m.has(id)) m.set(id, this.nombre(id));
    }
    return [...m].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, 'es'));
  });
  readonly dias = computed(() => [...new Set(this.operaciones().map((o) => o.fecha))].sort()
    .map((value) => ({ value, label: this.fechaCorta(value) })));

  private readonly cuenta = computed(() => {
    const os = this.operaciones();
    const personas = new Set(os.flatMap((o) => o.renglones.filter((r) => r.fuente !== 'kepler').map((r) => r.persona_id)));
    const suma = (xs: number[]) => Math.round(xs.reduce((a, x) => a + x, 0) * 100) / 100;
    return {
      total: os.length,
      completas: os.filter((o) => !o.faltan.length).length,
      tripulacion: os.filter((o) => o.faltan.includes('chofer') || o.faltan.includes('horario')).length,
      cargadores: os.filter((o) => o.faltan.includes('cargadores')).length,
      cajas: os.reduce((a, o) => a + (o.cajas ?? 0), 0),
      sinCajas: os.filter((o) => o.cajas == null).length,
      // `[EMB.48]` Lo que ya se sabe sin capturar: la carga de cada operación y la comisión de su ruta.
      carga: suma(os.map((o) => o.carga_total ?? 0)),
      comision: suma(os.map((o) => o.comision_ruta.chofer ?? 0)),
      sinTarifa: os.filter((o) => o.comision_ruta.chofer == null).length,
      repartido: suma(os.map((o) => o.repartido)),
      // [CML.K] Lo de viajes sin cerrar: se sabe, pero no se paga todavía.
      porCerrar: suma(os.map((o) => o.por_cerrar ?? 0)),
      personas: personas.size,
    };
  });

  readonly titular = computed(() => {
    const c = this.cuenta();
    if (!c.total) return 'No hay traspasos ni entregas a cliente en esta catorcena.';
    const sabe = `${c.total} operaciones: ${this.dinero(c.carga)} de carga (${c.cajas.toLocaleString('es-MX')} cajas) y `
      + `${this.dinero(c.comision)} de comisión de choferes`;
    const asignado = `${this.dinero(c.repartido)} a pagar a ${c.personas} persona${c.personas === 1 ? '' : 's'} de viajes cerrados`
      + (c.porCerrar ? ` y ${this.dinero(c.porCerrar)} por cerrar` : '');
    return `${sabe}. ${asignado}${c.cargadores ? `; falta quién cargó en ${c.cargadores}` : ''}.`;
  });

  readonly kpis = computed<MetricStripItem[]>(() => {
    const c = this.cuenta();
    return [
      { label: 'Carga', value: c.carga, format: 'currency2', tone: 'brand', sub: `${c.cajas.toLocaleString('es-MX')} cajas × tarifa` },
      { label: 'Comisión de choferes', value: c.comision, format: 'currency2', tone: 'brand', sub: 'por la tarifa de la ruta' },
      { label: 'A pagar', value: c.repartido, format: 'currency2', sub: `${c.personas} personas · viajes cerrados` },
      { label: 'Por cerrar', value: c.porCerrar, format: 'currency2', tone: c.porCerrar ? 'warn' : 'muted', sub: 'se paga al cerrar el viaje' },
      { label: 'Ruta sin tarifa', value: c.sinTarifa, format: 'number', tone: c.sinTarifa ? 'warn' : 'muted', sub: 'su comisión no se sabe' },
      { label: 'Falta chofer u horario', value: c.tripulacion, format: 'number', tone: c.tripulacion ? 'warn' : 'muted' },
      { label: 'Falta quién cargó', value: c.cargadores, format: 'number', tone: c.cargadores ? 'warn' : 'muted' },
      { label: 'Fuera', value: (this.data()?.fuera_de_alcance ?? 0) + (this.data()?.solo_tiempo_aire ?? 0), format: 'number', tone: 'muted',
        sub: `${this.data()?.fuera_de_alcance ?? 0} cargas a ruta · ${this.data()?.solo_tiempo_aire ?? 0} sólo tiempo aire` },
    ];
  });

  readonly vistas = computed<SegOption[]>(() => {
    const c = this.cuenta();
    return [
      { label: 'Por completar', value: 'pendientes', count: c.total - c.completas },
      { label: 'Completas', value: 'completas', count: c.completas },
      { label: 'Todas', value: 'todas', count: c.total },
    ];
  });

  readonly sucursales = computed(() => {
    const codigos = [...new Set(this.operaciones().map((o) => o.sucursal))].sort();
    return codigos.map((c) => ({ value: c, label: this.sucursalPipe.transform(c) }));
  });

  constructor() {
    const q = this.ruta.snapshot.queryParamMap;
    const desde = q.get('desde');
    const hasta = q.get('hasta');
    if (this.ruta.snapshot?.data?.['modo'] === 'historial') this.vista.set('completas');
    this.cargar(esFecha(desde) && esFecha(hasta) ? { desde, hasta } : undefined);
  }

  private corteActual(): { desde: string; hasta: string } | undefined {
    const d = this.data();
    return d ? { desde: d.corte.desde, hasta: d.corte.hasta } : undefined;
  }

  cargar(corte?: { desde: string; hasta: string }): void {
    this.cargando.set(true);
    this.error.set(null);
    this.api.getReportePagos(corte ?? this.corteActual()).subscribe({
      next: (d) => { this.data.set(d); this.cargando.set(false); this.abrirLiga(); },
      error: (e) => { this.cargando.set(false); this.error.set(mensaje(e, 'No se pudieron leer las operaciones de Kepler.')); },
    });
  }

  /** `[EMB.51]` Abre la operación de la liga, una vez. Si no está en la catorcena cargada, no abre nada. */
  private abrirLiga(): void {
    const liga = this.ligaPendiente;
    if (!liga) return;
    this.ligaPendiente = null;
    const o = this.operaciones().find((x) => x.clave === liga);
    if (!o) return;
    if (o.faltan.length === 0) this.vista.set('todas');
    this.abrir(o);
  }

  /** Relee el reporte y devuelve la operación abierta tal como quedó. */
  private async releer(): Promise<Operacion | null> {
    const d = await firstValueFrom(this.api.getReportePagos(this.corteActual()));
    this.data.set(d);
    return this.op();
  }

  mover(paso: -1 | 1): void {
    const d = this.data();
    if (!d) return;
    const c = corteVecino(d.corte, paso);
    this.cerrar();
    this.data.set(null);
    this.cargar({ desde: c.desde, hasta: c.hasta });
  }

  /** La tabla entrega una fila, varias o ninguna: aquí la selección es de UNA fila. */
  alSeleccionar(d: Operacion | Operacion[] | undefined): void {
    if (d && !Array.isArray(d)) this.abrir(d);
  }

  abrir(o: OperacionDelReporte): void {
    this.clave.set(llave(o));
    this.avisoPeek.set(null);
    this.errorPeek.set(null);
    this.chofer.set(o.driver_id);
    // [CML.T1] Sin tripulación capturada, se precarga la del viaje anterior del chofer: sólo
    // precarga, no guarda nada. Lo que ya está capturado manda.
    const s = !this.guiaCompleta(o) && !o.helper1_id && !o.helper2_id ? o.tripulacion_sugerida ?? null : null;
    this.sugerida.set(s);
    this.ayudante1.set(s ? s.helper1_id : o.helper1_id);
    this.ayudante2.set(s ? s.helper2_id : o.helper2_id);
    this.salida.set(null);
    this.llegada.set(null);
    this.horarioGps.set(null);
    this.durmio.set(o.overnight);
    this.km.set(o.km ?? null);
    this.reabriendo.set(false);
    this.motivo.set('');
    this.cargadoresSel.set([...o.cargador_ids]);
    this.peek.set(true);
    this.cargarDesglose(o);
  }

  /** `[EMB.50]` Si se abre otra operación antes de que llegue, la respuesta vieja se descarta. */
  cargarDesglose(o: Pick<OperacionDelReporte, 'sucursal' | 'guia'>): void {
    const pedida = llave(o);
    this.desglose.set(null);
    this.errorDesglose.set(null);
    this.cargandoDesglose.set(true);
    this.api.getDesgloseOperacion(o.sucursal, o.guia).subscribe({
      next: (d) => {
        if (this.clave() !== pedida) return;
        this.desglose.set(d);
        this.cargandoDesglose.set(false);
        this.precargarHorario(d);
      },
      error: (e) => {
        if (this.clave() !== pedida) return;
        this.cargandoDesglose.set(false);
        this.errorDesglose.set(mensaje(e, 'No se pudo leer el desglose de Kepler.'));
      },
    });
  }

  /**
   * `[CML.H]` Sin horario capturado, se precarga el del GPS de la unidad: sólo precarga, no guarda.
   * Lo capturado manda, y también lo que la persona ya tecleó mientras llegaba el desglose.
   */
  private precargarHorario(d: DesgloseDeOperacion): void {
    const o = this.op();
    const v = d.horario_gps?.viaje ?? null;
    if (!v || !o || this.guiaCompleta(o) || o.departure_time || o.arrival_time || this.salida() || this.llegada()) return;
    this.salida.set(aHora(v.salida));
    this.llegada.set(aHora(v.llegada));
    this.durmio.set(v.duerme_fuera);
    if (this.km() == null && v.km != null) this.km.set(Math.round(v.km));
    this.horarioGps.set(v);
  }


  cerrar(): void {
    this.peek.set(false);
    this.clave.set(null);
  }

  /**
   * La hoja de la Suite que guarda lo que Kepler no sabe. Ya no se «toma» a mano: nace aquí, la
   * primera vez que se captura a alguien. El tipo de entrega no cambia el pago; se deriva de
   * «durmió fuera» (viaje largo) para no preguntar algo que no se usa.
   */
  private async asegurarHoja(o: Operacion): Promise<Operacion> {
    if (o.shipment_id) return o;
    try {
      await firstValueFrom(this.api.createShipmentFromKepler(o.sucursal, o.guia, { delivery_type: this.durmio() ? 'long_trip' : 'route' }));
    } catch (e) {
      // Si otra persona la acaba de crear, se sigue con la suya: lo que falta se captura igual.
      const fresca = await this.releer();
      if (fresca?.shipment_id) return fresca;
      throw e;
    }
    const fresca = await this.releer();
    if (!fresca?.shipment_id) throw new Error('La hoja de la Suite no apareció al releer. Recarga e intenta de nuevo.');
    return fresca;
  }

  guiaCompleta(o: OperacionDelReporte): boolean {
    return !!o.driver_id && !!o.departure_time && !!o.arrival_time;
  }

  /** Lo que falta en el formulario, en llano. El servidor vuelve a validar (tarifas incluidas). */
  erroresTripulacion(o: OperacionDelReporte): string[] {
    const e: string[] = [];
    if (!o.driver_id && !o.chofer_kepler_id && !this.chofer()) e.push('Elige al chofer.');
    // [CML.HV] Sin ninguna hora se guarda sólo la tripulación; con una sola, falta la otra.
    if (this.salida() && !this.llegada()) e.push('Captura la hora de llegada (o borra la salida para guardar sólo la tripulación).');
    if (!this.salida() && this.llegada()) e.push('Captura la hora de salida.');
    const quien = [o.driver_id ?? o.chofer_kepler_id ?? this.chofer(), this.ayudante1(), this.ayudante2()].filter(Boolean);
    if (new Set(quien).size !== quien.length) e.push('Una persona no puede ir dos veces en el mismo viaje.');
    return e;
  }

  async guardarTripulacion(inicial: Operacion): Promise<void> {
    if (this.erroresTripulacion(inicial).length || this.guardandoGuia()) return;
    this.guardandoGuia.set(true);
    this.errorPeek.set(null);
    this.avisoPeek.set(null);
    try {
      const o = await this.asegurarHoja(inicial);
      if (this.guiaCompleta(o)) { this.avisoPeek.set('Otra persona ya había capturado al chofer y su horario.'); return; }
      if (!o.guide_id) throw new Error('La operación no tiene guía de entrega activa: revísala en Embarques.');
      // [CML.K] Si la hoja nació sin chofer (Kepler lo trae en el viaje pero no en las paradas), se manda
      // el de Kepler que la pantalla ya muestra como fijo: si no, el coordinador se queda sin forma de elegirlo.
      const choferElegido = this.chofer() ?? o.chofer_kepler_id;
      if (!o.driver_id && !choferElegido) {
        throw new Error(`Kepler trae a ${o.chofer_kepler ?? 'un chofer'} pero no está en el padrón activo: elige al chofer.`);
      }
      if (this.soloTripulacion()) {
        // [CML.HV] Al salir: sólo quién va. El horario, la comisión y el viático llegan al regresar.
        const tripulacion: TripulacionGuiaBody = {
          helper1_id: this.ayudante1(),
          helper2_id: this.ayudante2(),
          ...(o.driver_id ? {} : { driver_id: choferElegido }),
        };
        await firstValueFrom(this.api.saveGuideCrew(o.guide_id, tripulacion));
        await this.releer();
        this.avisoPeek.set('Listo: tripulación guardada. Al regresar se captura el horario y entonces se calculan la comisión y el viático.');
        return;
      }
      const body: CompletarGuiaBody = {
        helper1_id: this.ayudante1(),
        helper2_id: this.ayudante2(),
        departure_time: hhmm(this.salida()),
        arrival_time: hhmm(this.llegada()),
        overnight: this.durmio(),
        // El chofer sólo se manda si Kepler no lo trajo: la guía no deja cambiarlo.
        ...(o.driver_id ? {} : { driver_id: choferElegido }),
      };
      const g = await firstValueFrom(this.api.completeGuide(o.guide_id, body));
      const comision = Number(g.driver_commission ?? 0) + Number(g.helper1_commission ?? 0) + Number(g.helper2_commission ?? 0);
      const kmNoGuardados = await this.guardarKm(o);
      await this.releer();
      // [CML.J] Con el horario de la hoja ya guardado, sin GPS se busca si otra guía es el mismo viaje.
      this.cargarDesglose(o);
      const distinto = o.driver_id && this.chofer() && this.chofer() !== o.driver_id ? ` El chofer quedó el de Kepler (${this.nombre(o.driver_id)}).` : '';
      this.avisoPeek.set(`Listo: viaje cerrado. Comisión ${this.dinero(comision)} y viático ${this.dinero(Number(g.per_diem_total ?? 0))}.${distinto}${kmNoGuardados}`);
    } catch (e) {
      this.errorPeek.set(mensaje(e, 'No se pudo guardar al chofer y los ayudantes.'));
    } finally {
      this.guardandoGuia.set(false);
    }
  }

  /**
   * `[CML.K]` Los km de la hoja de viaje van al embarque (`actual_km`). Son opcionales y no cambian
   * la comisión: si no se pueden guardar, el viaje ya quedó cerrado y se dice, sin tumbar el aviso.
   */
  private async guardarKm(o: Operacion): Promise<string> {
    const km = this.km();
    if (km == null || km === o.km || !o.shipment_id) return '';
    try {
      await firstValueFrom(this.api.updateShipment(o.shipment_id, { actual_km: km }));
      return ` Km: ${km}.`;
    } catch (e) {
      return ` Los km no se guardaron (${mensaje(e, 'error')}).`;
    }
  }

  /** `[CML.K]` Reabre el viaje cerrado con motivo: borra horario y montos; se vuelve a cerrar en Embarques. */
  async reabrir(o: Operacion): Promise<void> {
    const motivo = this.motivo().trim();
    if (!o.guide_id || motivo.length < MOTIVO_MINIMO_REABRIR || this.guardandoReabrir()) return;
    this.guardandoReabrir.set(true);
    this.errorPeek.set(null);
    this.avisoPeek.set(null);
    try {
      await firstValueFrom(this.api.reopenGuide(o.guide_id, { motivo }));
      await this.releer();
      this.reabriendo.set(false);
      this.motivo.set('');
      this.avisoPeek.set('Listo: el viaje se reabrió. Ciérralo otra vez en Embarques › Cerrar viajes con el horario correcto.');
    } catch (e) {
      this.errorPeek.set(mensaje(e, 'No se pudo reabrir el viaje.'));
    } finally {
      this.guardandoReabrir.set(false);
    }
  }

  /** `[CML.K]` La liga a Embarques › Cerrar viajes con esta operación abierta, en su catorcena. */
  ligaCierre(o: OperacionDelReporte): Record<string, string> {
    const c = this.corteActual();
    return { vista: 'cerrar', op: llave(o), ...(c ? { desde: c.desde, hasta: c.hasta } : {}) };
  }

  async guardarCargadores(inicial: Operacion): Promise<void> {
    if (this.guardandoCarga()) return;
    this.guardandoCarga.set(true);
    this.errorPeek.set(null);
    this.avisoPeek.set(null);
    try {
      const o = await this.asegurarHoja(inicial);
      await firstValueFrom(this.api.setCargadores(o.shipment_id as string, this.cargadoresSel()));
      const fresca = await this.releer();
      this.cargadoresSel.set([...(fresca?.cargador_ids ?? [])]);
      this.avisoPeek.set(fresca?.cargadores ? `Listo: ${this.cargadoresTexto(fresca)}` : 'Listo: la operación quedó sin cargadores.');
    } catch (e) {
      this.errorPeek.set(mensaje(e, 'No se pudieron guardar los cargadores.'));
    } finally {
      this.guardandoCarga.set(false);
    }
  }

  ayudanteCreado(r: AltaRapidaResultado & { mensaje: string }): void {
    this.agregarAlta(r);
    if (!this.ayudante1()) this.ayudante1.set(r.driver.id);
    else if (!this.ayudante2() && this.ayudante1() !== r.driver.id) this.ayudante2.set(r.driver.id);
    this.avisoPeek.set(`${r.mensaje} Falta «Guardar chofer y ayudantes».`);
  }

  cargadorCreado(r: AltaRapidaResultado & { mensaje: string }): void {
    this.agregarAlta(r);
    if (!this.cargadoresSel().includes(r.driver.id)) this.cargadoresSel.update((xs) => [...xs, r.driver.id]);
    this.avisoPeek.set(`${r.mensaje} Falta «Guardar cargadores».`);
  }

  private agregarAlta(r: AltaRapidaResultado): void {
    const p: PersonaDelPadron = { id: r.driver.id, full_name: r.driver.full_name, roles: r.driver.roles };
    this.altas.update((xs) => [...xs.filter((x) => x.id !== p.id), p]);
  }

  /**
   * Cuánto le tocaría a cada quien con los elegidos, con la MISMA regla del servidor
   * (`repartoDeCarga`). Al guardar se recalcula con las cajas de Kepler de ese momento.
   */
  textoReparto(o: OperacionDelReporte): string | null {
    const n = this.cargadoresSel().length;
    const total = totalDeCarga(o.cajas, o.tarifa_por_caja);
    if (!n || total == null) return null;
    if (total === 0) return 'Esta operación no lleva cajas: quien cargó queda registrado, pero la carga no paga.';
    const partes = repartoDeCarga(total, n);
    const max = Math.max(...partes);
    const min = Math.min(...partes);
    return max === min
      ? `Al guardar: ${this.dinero(max)} para ${n === 1 ? 'quien cargó' : `cada uno de los ${n}`}.`
      : `Al guardar: ${this.dinero(min)} a ${this.dinero(max)} por persona (el centavo que sobra va a los primeros).`;
  }

  /** Quién manejó: el de la guía, o el de Kepler ya casado con el padrón. */
  choferDe(o: OperacionDelReporte): { nombre: string; deKepler: boolean } | null {
    if (o.driver_id) return { nombre: this.nombre(o.driver_id), deKepler: false };
    if (o.chofer_kepler_id) return { nombre: this.nombre(o.chofer_kepler_id), deKepler: true };
    return null;
  }

  sinCentro(m: SinCentro | null): string {
    return m ? SIN_CENTRO_LABEL[m] : '—';
  }

  textoComision(o: OperacionDelReporte): string {
    const c = o.comision_ruta;
    if (c.chofer == null) {
      return c.sin_tarifa.length ? `Sin tarifa: ${c.sin_tarifa.join(', ')}` : 'Kepler no trae la ruta';
    }
    return `${this.dinero(c.chofer)} chofer · ${this.dinero(c.ayudante ?? 0)} ayudante (${c.ruta})`;
  }

  textoCarga(o: OperacionDelReporte): string {
    if (o.carga_total == null) return o.tarifa_por_caja == null ? 'Sin tarifa por caja' : 'Sin cajas de Kepler';
    const base = `${this.dinero(o.carga_total)}`;
    return o.cajas != null && o.tarifa_por_caja != null
      ? `${base} (${o.cajas.toLocaleString('es-MX')} cajas × ${this.dinero(o.tarifa_por_caja)})`
      : base;
  }

  cargadoresTexto(o: OperacionDelReporte): string {
    const nombres = o.cargador_ids.map((id) => this.nombre(id));
    return `${nombres.length} cargador${nombres.length === 1 ? '' : 'es'}: ${nombres.join(', ')}.`;
  }

  equipo(o: OperacionDelReporte): string {
    const ay = [o.helper1_id, o.helper2_id].filter(Boolean).length;
    const partes: string[] = [];
    if (ay) partes.push(`${ay} ayudante${ay === 1 ? '' : 's'}`);
    if (o.cargadores) partes.push(`${o.cargadores} cargador${o.cargadores === 1 ? '' : 'es'}`);
    return partes.join(' · ');
  }

  nombre(id: string | null): string {
    if (!id) return '—';
    return this.nombres().get(id) ?? 'Persona fuera del padrón activo';
  }
  ayudantes(o: OperacionDelReporte): string {
    const n = [o.helper1_id, o.helper2_id].filter(Boolean).map((id) => this.nombre(id));
    return n.length ? n.join(' · ') : 'Ninguno';
  }
  subtituloPeek(o: OperacionDelReporte): string {
    return `${this.sucursalPipe.transform(o.sucursal)} · ${this.fechaCorta(o.fecha)} · ${this.tipoLabel(o.tipo)}`;
  }
  tipoLabel(t: OperacionDelReporte['tipo']): string { return TIPO_VIAJE_LABEL[t] ?? t; }
  faltaLabel(f: FaltaDelViaje): string { return FALTA_LABEL[f]; }
  rolLabel(r: keyof typeof ROL_LABEL): string { return ROL_LABEL[r]; }
  fechaCorta(iso: string): string {
    const d = new Date(iso + 'T12:00:00');
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' });
  }
  /** Un instante ISO en hora de México: «lun 24 nov, 8:05 a.m.». */
  fechaHora(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('es-MX', {
      timeZone: 'America/Mexico_City', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    });
  }
  readonly hora12 = hora12;
  /** `00|0001060` → `0001060`; varias, separadas por coma. */
  guiasTexto(claves: string[]): string {
    return claves.map((k) => k.split('|')[1] ?? k).join(', ');
  }
  /**
   * `[CML.J]` Confirma (o deshace, con `null`) que esta operación es el mismo viaje que `g`. Crea la
   * hoja si no la hay (igual que al guardar la tripulación) y relee: el reporte paga una vez.
   */
  async ligarMismoViaje(inicial: Operacion, g: GuiaDelMismoViaje | null): Promise<void> {
    if (this.guardandoLiga()) return;
    this.guardandoLiga.set(true);
    this.errorPeek.set(null);
    this.avisoPeek.set(null);
    try {
      const o = await this.asegurarHoja(inicial);
      if (!o.guide_id) throw new Error('La operación no tiene guía de entrega activa: revísala en Embarques.');
      await firstValueFrom(this.api.confirmSameTrip(o.guide_id, { same_trip_as: g ? llave(g) : null }));
      await this.releer();
      this.avisoPeek.set(g
        ? `Listo: es el mismo viaje que la guía ${g.guia}. A cada persona se le paga la comisión mayor y un solo viático.`
        : 'Listo: ya no se trata como el mismo viaje; cada guía se paga por separado.');
    } catch (e) {
      this.errorPeek.set(mensaje(e, 'No se pudo guardar si es el mismo viaje.'));
    } finally {
      this.guardandoLiga.set(false);
    }
  }
  /** `[CML.J]` Abre la otra guía del mismo viaje si está en la catorcena cargada; si no, dice dónde buscarla. */
  abrirMismoViaje(g: GuiaDelMismoViaje): void {
    const o = this.operaciones().find((x) => x.clave === llave(g));
    if (o) { this.abrir(o); return; }
    this.avisoPeek.set(`La guía ${g.guia} (${this.fechaCorta(g.fecha)}) no está en esta catorcena o no paga comisión: búscala en la catorcena de esa fecha.`);
  }
  private dinero(n: number): string {
    return n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  }
}
