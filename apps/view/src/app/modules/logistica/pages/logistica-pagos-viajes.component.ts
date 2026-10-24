import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { CheckboxModule } from 'primeng/checkbox';
import { RadioButtonModule } from 'primeng/radiobutton';
import { DatePickerModule } from 'primeng/datepicker';
import type { BandejaDeViajes, CompletarGuiaBody, FaltaDelViaje, ViajePorCompletar } from '@megadulces/contracts';
// Por subruta, no por el barrel: ver tsconfig.base.json (bundle inicial).
import { corteVecino, FALTA_LABEL, TIPO_VIAJE_LABEL } from '@megadulces/contracts/http/cierre-viaje';
import { coincideBusqueda } from '@megadulces/ui-web';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { SegmentedComponent, SegOption } from '../../../shared/components/segmented/segmented.component';
import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';
import { Driver, LogisticaService } from '../logistica.service';
import { CierreViajeComponent } from '../components/cierre-viaje.component';

type Vista = 'pendientes' | 'completos' | 'todos';
type TipoEntrega = 'route' | 'long_trip';

/** Lo que cada falta pide hacer, en la columna y en el panel. */
const FALTA_TONO: Record<FaltaDelViaje, 'warn' | 'danger'> = { tomar: 'danger', chofer: 'warn', horario: 'warn', cargadores: 'warn' };
const llave = (v: Pick<ViajePorCompletar, 'sucursal' | 'guia'>) => `${v.sucursal}|${v.guia}`;
const hhmm = (d: Date | null): string | null =>
  d ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : null;

/**
 * `[EMB.43]` — **Logística › Pagos de viaje › Por completar.**
 *
 * La pregunta que contesta: ¿a qué viajes de Kepler de la catorcena les falta algo para poder
 * pagarse? El viaje ya existe en Kepler (la guía), así que nadie lo «crea»: aparece solo. Aquí se
 * captura únicamente lo que Kepler no sabe —quién más fue, el horario y quién cargó— en un panel
 * lateral, sin perder la lista.
 *
 * Jerarquía: primario = cuántos viajes faltan y qué les falta; secundario = la lista; terciario =
 * guía, importe y destinos de cada fila.
 */
@Component({
  selector: 'app-logistica-pagos-viajes',
  standalone: true,
  imports: [
    CurrencyPipe, FormsModule, TableModule, SelectModule, ButtonModule, TagModule, CheckboxModule, RadioButtonModule,
    DatePickerModule, LoadStateComponent, MetricStripComponent, FreshnessPillComponent, SidePeekComponent,
    SegmentedComponent, SucursalPipe, CierreViajeComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page pv">
      <div class="pv-cabeza">
        <div class="pv-corte" role="group" aria-label="Catorcena">
          <button pButton type="button" [text]="true" size="small" (click)="mover(-1)"
                  [disabled]="!data()" aria-label="Catorcena anterior"><span class="p-button-icon pi pi-chevron-left" aria-hidden="true"></span></button>
          <span class="pv-corte-txt">
            @if (data(); as d) { Catorcena {{ fechaCorta(d.corte.desde) }} – {{ fechaCorta(d.corte.hasta) }} · se paga el {{ fechaCorta(d.corte.pago) }} }
            @else { Catorcena }
          </span>
          <button pButton type="button" [text]="true" size="small" (click)="mover(1)"
                  [disabled]="!data()" aria-label="Catorcena siguiente"><span class="p-button-icon pi pi-chevron-right" aria-hidden="true"></span></button>
        </div>
        @if (data(); as d) {
          <app-freshness-pill measures="fetch" [since]="d.leido_at" label="viajes de Kepler" />
        }
      </div>

      @if (data(); as d) {
        <p class="pv-titular">{{ titular() }}</p>
        <app-metric-strip [items]="kpis()" mode="strip" density="compact" ariaLabel="Viajes de la catorcena" />
      }

      <app-load-state [loading]="cargando() && !data()" [error]="error()" [isEmpty]="!!data() && !data()!.viajes.length"
                      emptyIcon="pi-truck" emptyTitle="Sin viajes de Kepler en esta catorcena"
                      emptyHint="Sólo cuentan traspasos y entregas a cliente; las cargas a camión de ruta no pagan comisión ni viático."
                      (retry)="cargar()">
        <section class="pv-barra" aria-label="Filtros">
          <app-segmented [options]="vistas()" [value]="vista()" (valueChange)="vista.set($any($event))" ariaLabel="Qué viajes ver" />
          <p-select [options]="sucursales()" optionLabel="label" optionValue="value" [ngModel]="sucursal()"
                    (ngModelChange)="sucursal.set($event)" [showClear]="true" placeholder="Todas las sucursales"
                    ariaLabel="Sucursal" appendTo="body" class="pv-sel" />
          <label class="pv-buscar">
            <span class="sr-only">Buscar viaje</span>
            <input type="search" [value]="busqueda()" (input)="busqueda.set($any($event.target).value)"
                   placeholder="Guía, destino o chofer" autocomplete="off" spellcheck="false" />
          </label>
          <span class="pv-cuenta">{{ filtrados().length }} de {{ data()?.viajes?.length ?? 0 }} viajes</span>
        </section>

        <div class="dt-scope">
          <p-table [value]="filtrados()" dataKey="clave" selectionMode="single" [selection]="seleccion()"
                   (onRowSelect)="alSeleccionar($event.data)" [paginator]="filtrados().length > 50" [rows]="50"
                   [showCurrentPageReport]="true" currentPageReportTemplate="{first}–{last} de {totalRecords}"
                   size="small" class="surf-table surf-table--plain surf-table--sticky surf-table--frozen-first dt-stack"
                   [tableStyle]="{ 'min-width': '52rem' }">
            <ng-template #header>
              <tr>
                <th scope="col">Guía</th>
                <th scope="col">Fecha</th>
                <th scope="col">Tipo</th>
                <th scope="col">Destinos</th>
                <th scope="col">Chofer en Kepler</th>
                <th scope="col" class="comm-num">Importe</th>
                <th scope="col">Qué falta</th>
              </tr>
            </ng-template>
            <ng-template #body let-v>
              <tr [pSelectableRow]="v" [attr.aria-label]="'Abrir la guía ' + v.guia + ' de ' + (v.sucursal | sucursal)">
                <td data-label="Guía">
                  <span class="pv-guia">{{ v.guia }}</span>
                  <span class="pv-sub">{{ v.sucursal | sucursal }}@if (v.shipment_folio) { · {{ v.shipment_folio }} }</span>
                </td>
                <td data-label="Fecha">{{ fechaCorta(v.fecha) }}</td>
                <td data-label="Tipo">{{ tipoLabel(v.tipo) }}</td>
                <td data-label="Destinos" class="pv-destinos">{{ v.destinos || '—' }}</td>
                <td data-label="Chofer en Kepler">{{ v.chofer_kepler || '—' }}</td>
                <td data-label="Importe" class="comm-num">{{ v.importe | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                <td data-label="Qué falta">
                  @for (f of v.faltan; track f) { <p-tag [value]="faltaLabel(f)" [severity]="faltaTono(f)" class="pv-tag" /> }
                  @empty { <p-tag value="Completo" severity="success" /> }
                </td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="7" class="pv-vacio">Ningún viaje con este filtro.</td></tr>
            </ng-template>
          </p-table>
        </div>
      </app-load-state>

      <app-side-peek [open]="peek()" (openChange)="!$event && cerrar()" [width]="640"
                     [title]="viaje() ? 'Guía ' + viaje()!.guia : ''"
                     [subtitle]="viaje() ? subtituloPeek(viaje()!) : null">
        @if (viaje(); as v) {
          <div class="pv-peek">
            <dl class="pv-datos">
              <div><dt>Destinos</dt><dd>{{ v.destinos || '—' }}</dd></div>
              <div><dt>Chofer en Kepler</dt><dd>{{ v.chofer_kepler || 'Kepler no lo trae' }}</dd></div>
              <div><dt>Importe</dt><dd>{{ v.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</dd></div>
            </dl>

            @if (avisoPeek(); as a) { <div class="pv-msg pv-msg-ok" role="status">{{ a }}</div> }
            @if (errorPeek(); as e) { <div class="pv-msg pv-msg-bad" role="alert">{{ e }}</div> }

            <!-- 1. Tomar el viaje: la hoja de la Suite que guarda lo que Kepler no sabe. -->
            @if (!v.shipment_id) {
              <section class="pv-paso" aria-labelledby="pv-paso-1">
                <h3 id="pv-paso-1"><span class="pv-num">1</span> Tomar el viaje</h3>
                <p class="pv-sub">Este viaje todavía no tiene hoja en la Suite. Al tomarlo se crea con sus paradas de Kepler; después se captura la tripulación y quién cargó.</p>
                <fieldset class="pv-radios">
                  <legend>Tipo de entrega</legend>
                  <label><p-radiobutton name="pv-tipo" value="route" [ngModel]="tipoEntrega()" (ngModelChange)="tipoEntrega.set($event)" inputId="pv-tipo-ruta" /> Por ruta</label>
                  <label><p-radiobutton name="pv-tipo" value="long_trip" [ngModel]="tipoEntrega()" (ngModelChange)="tipoEntrega.set($event)" inputId="pv-tipo-largo" /> Viaje largo</label>
                </fieldset>
                <button pButton type="button" [loading]="tomando()"
                        [disabled]="!tipoEntrega() || tomando()" (click)="tomar(v)"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">Tomar viaje</span></button>
              </section>
            } @else {
              <!-- 2. Tripulación y horario: de aquí salen la comisión y los viáticos. -->
              <section class="pv-paso" aria-labelledby="pv-paso-2">
                <h3 id="pv-paso-2"><span class="pv-num">2</span> Quién fue y a qué hora</h3>
                @if (!v.guide_id) {
                  <p class="pv-sub">El viaje no tiene guía de entrega activa: revísalo en Embarques.</p>
                } @else if (guiaCompleta(v)) {
                  <dl class="pv-datos">
                    <div><dt>Chofer</dt><dd>{{ nombre(v.driver_id) }}</dd></div>
                    <div><dt>Ayudantes</dt><dd>{{ ayudantes(v) }}</dd></div>
                    <div><dt>Salida · llegada</dt><dd>{{ v.departure_time }} – {{ v.arrival_time }}@if (v.overnight) { · durmió fuera }</dd></div>
                  </dl>
                  <p class="pv-sub">La guía ya está completa: con eso se calcularon la comisión y los viáticos (no se edita).</p>
                } @else {
                  <div class="pv-form">
                    <label for="pv-chofer">Chofer</label>
                    @if (v.driver_id) {
                      <p class="pv-fijo" id="pv-chofer">{{ nombre(v.driver_id) }} <span class="pv-sub">(viene de Kepler)</span></p>
                    } @else {
                      <p-select inputId="pv-chofer" [options]="personas()" optionLabel="full_name" optionValue="id" [filter]="true"
                                [ngModel]="chofer()" (ngModelChange)="chofer.set($event)" placeholder="Elige al chofer" appendTo="body" />
                    }
                    <label for="pv-ay1">Ayudante 1 <span class="pv-sub">(opcional)</span></label>
                    <p-select inputId="pv-ay1" [options]="personas()" optionLabel="full_name" optionValue="id" [filter]="true" [showClear]="true"
                              [ngModel]="ayudante1()" (ngModelChange)="ayudante1.set($event)" placeholder="Nadie" appendTo="body" />
                    <label for="pv-ay2">Ayudante 2 <span class="pv-sub">(opcional)</span></label>
                    <p-select inputId="pv-ay2" [options]="personas()" optionLabel="full_name" optionValue="id" [filter]="true" [showClear]="true"
                              [ngModel]="ayudante2()" (ngModelChange)="ayudante2.set($event)" placeholder="Nadie" appendTo="body" />
                    <div class="pv-horas">
                      <div>
                        <label for="pv-salida">Salida</label>
                        <p-datepicker inputId="pv-salida" [timeOnly]="true" hourFormat="24" [ngModel]="salida()" (ngModelChange)="salida.set($event)" appendTo="body" />
                      </div>
                      <div>
                        <label for="pv-llegada">Llegada</label>
                        <p-datepicker inputId="pv-llegada" [timeOnly]="true" hourFormat="24" [ngModel]="llegada()" (ngModelChange)="llegada.set($event)" appendTo="body" />
                      </div>
                    </div>
                    <label class="pv-check"><p-checkbox [binary]="true" inputId="pv-noche" [ngModel]="durmio()" (ngModelChange)="durmio.set($event)" /> Durmió fuera</label>
                    @if (erroresGuia(v).length) {
                      <ul class="pv-errs">@for (e of erroresGuia(v); track e) { <li>{{ e }}</li> }</ul>
                    }
                    <button pButton type="button" [loading]="guardandoGuia()"
                            [disabled]="erroresGuia(v).length > 0 || guardandoGuia()" (click)="guardarGuia(v)"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">Guardar tripulación y horario</span></button>
                    <p class="pv-sub">Se guarda una sola vez: con esto se calculan la comisión (por la ruta) y los viáticos (por el horario).</p>
                  </div>
                }
              </section>

              <!-- 3. Quién cargó, paradas y lo que se libera: el mismo bloque de «Cierre y pago». -->
              <section class="pv-paso" aria-labelledby="pv-paso-3">
                <h3 id="pv-paso-3"><span class="pv-num">3</span> Quién cargó y cierre de paradas</h3>
                <app-cierre-viaje [shipmentId]="v.shipment_id" [drivers]="padron()" />
              </section>
            }
          </div>
        }
      </app-side-peek>
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
    .pv-buscar input { min-width: 16rem; padding: var(--sp-2); border: 1px solid var(--border-color); border-radius: var(--r-md); background: transparent; color: inherit; font: inherit; }
    .pv-buscar input:focus-visible { outline: 2px solid var(--action); outline-offset: 1px; }
    .pv-cuenta { margin-left: auto; font-size: var(--fs-sm); color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .pv-guia { display: block; font-family: var(--font-mono); font-weight: var(--fw-medium); }
    .pv-sub { display: block; font-size: var(--fs-xs); color: var(--text-muted); }
    .pv-destinos { max-width: 22rem; }
    .pv-tag { margin: 0 var(--sp-1) var(--sp-1) 0; }
    .pv-vacio { padding: var(--sp-4); color: var(--text-muted); }
    .pv-peek { display: flex; flex-direction: column; gap: var(--sp-4); }
    .pv-datos { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: var(--sp-2) var(--sp-4); margin: 0; }
    .pv-datos dt { font-size: var(--fs-xs); color: var(--text-muted); }
    .pv-datos dd { margin: 0; font-weight: var(--fw-medium); }
    .pv-paso { display: flex; flex-direction: column; gap: var(--sp-2); padding-top: var(--sp-3); border-top: 1px solid var(--border-color); }
    .pv-paso h3 { margin: 0; font-size: var(--fs-body); font-weight: var(--fw-bold); display: flex; align-items: center; gap: var(--sp-2); }
    .pv-num { display: inline-grid; place-items: center; width: 1.5rem; height: 1.5rem; border-radius: var(--r-pill); border: 1px solid var(--border-color); font-size: var(--fs-xs); font-variant-numeric: tabular-nums; }
    .pv-radios { border: 0; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: var(--sp-4); }
    .pv-radios legend { font-size: var(--fs-sm); font-weight: var(--fw-medium); margin-bottom: var(--sp-1); }
    .pv-radios label, .pv-check { display: inline-flex; align-items: center; gap: var(--sp-2); min-height: 32px; }
    .pv-form { display: flex; flex-direction: column; gap: var(--sp-1); }
    .pv-form > label { font-size: var(--fs-sm); font-weight: var(--fw-medium); margin-top: var(--sp-2); }
    .pv-fijo { margin: 0; font-weight: var(--fw-medium); }
    .pv-horas { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-3); margin-top: var(--sp-2); }
    .pv-horas label { display: block; font-size: var(--fs-sm); font-weight: var(--fw-medium); margin-bottom: var(--sp-1); }
    .pv-errs { margin: var(--sp-2) 0 0; padding-left: 1.1rem; color: var(--bad-soft-fg); font-size: var(--fs-xs); }
    .pv-msg { padding: var(--sp-2) var(--sp-3); border-radius: var(--r-md); font-size: var(--fs-sm); }
    .pv-msg-ok { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .pv-msg-bad { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    @container (max-width: 40rem) { .pv-cuenta { margin-left: 0; } }
  `],
})
export class LogisticaPagosViajesComponent {
  private readonly api = inject(LogisticaService);
  private readonly sucursalPipe = new SucursalPipe();

  readonly data = signal<BandejaDeViajes | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly vista = signal<Vista>('pendientes');
  readonly sucursal = signal<string | null>(null);
  readonly busqueda = signal('');

  readonly peek = signal(false);
  private readonly clave = signal<string | null>(null);
  readonly avisoPeek = signal<string | null>(null);
  readonly errorPeek = signal<string | null>(null);
  readonly tipoEntrega = signal<TipoEntrega | null>(null);
  readonly tomando = signal(false);
  readonly chofer = signal<string | null>(null);
  readonly ayudante1 = signal<string | null>(null);
  readonly ayudante2 = signal<string | null>(null);
  readonly salida = signal<Date | null>(null);
  readonly llegada = signal<Date | null>(null);
  readonly durmio = signal(false);
  readonly guardandoGuia = signal(false);

  /** Las filas con su llave, para la selección de la tabla. */
  readonly viajes = computed(() => (this.data()?.viajes ?? []).map((v) => ({ ...v, clave: llave(v) })));
  readonly viaje = computed(() => this.viajes().find((v) => v.clave === this.clave()) ?? null);
  readonly seleccion = computed(() => (this.peek() ? this.viaje() : null));

  readonly personas = computed(() => this.data()?.personas ?? []);
  /** El padrón con la forma que pide `app-cierre-viaje` (ya viene sólo lo activo). */
  readonly padron = computed<Driver[]>(() => this.personas().map((p) => ({
    id: p.id, full_name: p.full_name, roles: p.roles as Driver['roles'], employee_type: 'interno', status: 'activo', active: true,
  })));

  readonly filtrados = computed(() => {
    const vista = this.vista();
    const suc = this.sucursal();
    const q = this.busqueda();
    return this.viajes().filter((v) =>
      (vista === 'todos' || (vista === 'completos' ? !v.faltan.length : v.faltan.length > 0))
      && (!suc || v.sucursal === suc)
      && coincideBusqueda(q, v.guia, v.destinos, v.chofer_kepler, v.shipment_folio, this.sucursalPipe.transform(v.sucursal)));
  });

  private readonly cuenta = computed(() => {
    const vs = this.viajes();
    const con = (f: FaltaDelViaje) => vs.filter((v) => v.faltan.includes(f)).length;
    return {
      total: vs.length,
      completos: vs.filter((v) => !v.faltan.length).length,
      tomar: con('tomar'),
      guia: vs.filter((v) => v.faltan.includes('chofer') || v.faltan.includes('horario')).length,
      cargadores: con('cargadores'),
    };
  });

  readonly titular = computed(() => {
    const c = this.cuenta();
    if (!c.total) return 'No hay viajes de traspaso ni de entrega a cliente en esta catorcena.';
    const faltan = c.total - c.completos;
    return faltan
      ? `De ${c.total} viajes de la catorcena, ${c.completos} están completos y a ${faltan} les falta algo para poder pagarse.`
      : `Los ${c.total} viajes de la catorcena están completos: ya se pueden pagar en cuanto cierren sus paradas.`;
  });

  readonly kpis = computed<MetricStripItem[]>(() => {
    const c = this.cuenta();
    return [
      { label: 'Viajes', value: c.total, format: 'number', sub: 'traspaso y cliente' },
      { label: 'Completos', value: c.completos, format: 'number', tone: c.completos === c.total && c.total ? 'ok' : 'default' },
      { label: 'Sin hoja en la Suite', value: c.tomar, format: 'number', tone: c.tomar ? 'bad' : 'muted' },
      { label: 'Falta chofer u horario', value: c.guia, format: 'number', tone: c.guia ? 'warn' : 'muted' },
      { label: 'Falta quién cargó', value: c.cargadores, format: 'number', tone: c.cargadores ? 'warn' : 'muted' },
      { label: 'Cargas a ruta', value: this.data()?.fuera_de_alcance ?? 0, format: 'number', tone: 'muted', sub: 'no pagan · fuera' },
    ];
  });

  readonly vistas = computed<SegOption[]>(() => {
    const c = this.cuenta();
    return [
      { label: 'Por completar', value: 'pendientes', count: c.total - c.completos },
      { label: 'Completos', value: 'completos', count: c.completos },
      { label: 'Todos', value: 'todos', count: c.total },
    ];
  });

  readonly sucursales = computed(() => {
    const codigos = [...new Set(this.viajes().map((v) => v.sucursal))].sort();
    return codigos.map((c) => ({ value: c, label: this.sucursalPipe.transform(c) }));
  });

  constructor() {
    this.cargar();
  }

  cargar(corte?: { desde: string; hasta: string }): void {
    this.cargando.set(true);
    this.error.set(null);
    const pedido = corte ?? (this.data() ? { desde: this.data()!.corte.desde, hasta: this.data()!.corte.hasta } : undefined);
    this.api.getBandejaViajes(pedido).subscribe({
      next: (d) => { this.data.set(d); this.cargando.set(false); },
      error: (e) => { this.cargando.set(false); this.error.set(e?.error?.message ?? 'No se pudieron leer los viajes de Kepler.'); },
    });
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
  alSeleccionar(d: ViajePorCompletar | ViajePorCompletar[] | undefined): void {
    if (d && !Array.isArray(d)) this.abrir(d);
  }

  abrir(v: ViajePorCompletar): void {
    this.clave.set(llave(v));
    this.avisoPeek.set(null);
    this.errorPeek.set(null);
    this.tipoEntrega.set(null);
    this.chofer.set(v.driver_id);
    this.ayudante1.set(v.helper1_id);
    this.ayudante2.set(v.helper2_id);
    this.salida.set(null);
    this.llegada.set(null);
    this.durmio.set(v.overnight);
    this.peek.set(true);
  }

  /** Al cerrar el panel se relee la bandeja: lo capturado (cargadores, cierre) cambia lo que falta. */
  cerrar(): void {
    const habiaPanel = this.peek();
    this.peek.set(false);
    this.clave.set(null);
    if (habiaPanel) this.cargar();
  }

  tomar(v: ViajePorCompletar): void {
    const tipo = this.tipoEntrega();
    if (!tipo || this.tomando()) return;
    this.tomando.set(true);
    this.errorPeek.set(null);
    this.api.createShipmentFromKepler(v.sucursal, v.guia, { delivery_type: tipo }).subscribe({
      next: (r) => {
        this.tomando.set(false);
        this.avisoPeek.set(`Viaje tomado: hoja ${r.shipment.folio} con ${r.destinatarios} parada${r.destinatarios === 1 ? '' : 's'}. Ahora captura quién fue y a qué hora.`);
        this.cargar();
      },
      error: (e) => { this.tomando.set(false); this.errorPeek.set(e?.error?.message ?? 'No se pudo tomar el viaje.'); },
    });
  }

  guiaCompleta(v: ViajePorCompletar): boolean {
    return !!v.driver_id && !!v.departure_time && !!v.arrival_time;
  }

  /** Lo que falta en el formulario, en llano. El servidor vuelve a validar (tarifas incluidas). */
  erroresGuia(v: ViajePorCompletar): string[] {
    const e: string[] = [];
    if (!v.driver_id && !this.chofer()) e.push('Elige al chofer.');
    if (!this.salida()) e.push('Captura la hora de salida.');
    if (!this.llegada()) e.push('Captura la hora de llegada.');
    const quien = [v.driver_id ?? this.chofer(), this.ayudante1(), this.ayudante2()].filter(Boolean);
    if (new Set(quien).size !== quien.length) e.push('Una persona no puede ir dos veces en el mismo viaje.');
    return e;
  }

  guardarGuia(v: ViajePorCompletar): void {
    if (!v.guide_id || this.erroresGuia(v).length || this.guardandoGuia()) return;
    const body: CompletarGuiaBody = {
      helper1_id: this.ayudante1(),
      helper2_id: this.ayudante2(),
      departure_time: hhmm(this.salida()),
      arrival_time: hhmm(this.llegada()),
      overnight: this.durmio(),
      // El chofer sólo se manda si Kepler no lo trajo: la guía no se lo deja cambiar.
      ...(v.driver_id ? {} : { driver_id: this.chofer() }),
    };
    this.guardandoGuia.set(true);
    this.errorPeek.set(null);
    this.api.completeGuide(v.guide_id, body).subscribe({
      next: (g) => {
        this.guardandoGuia.set(false);
        const total = Number(g.driver_commission ?? 0) + Number(g.helper1_commission ?? 0) + Number(g.helper2_commission ?? 0);
        this.avisoPeek.set(`Guía completa: comisión ${this.dinero(total)} y viáticos ${this.dinero(Number(g.per_diem_total ?? 0))}. Falta quién cargó, si no lo has registrado.`);
        this.cargar();
      },
      error: (e) => { this.guardandoGuia.set(false); this.errorPeek.set(e?.error?.message ?? 'No se pudo guardar la guía.'); },
    });
  }

  nombre(id: string | null): string {
    if (!id) return '—';
    return this.personas().find((p) => p.id === id)?.full_name ?? 'Persona fuera del padrón activo';
  }
  ayudantes(v: ViajePorCompletar): string {
    const n = [v.helper1_id, v.helper2_id].filter(Boolean).map((id) => this.nombre(id));
    return n.length ? n.join(' · ') : 'Ninguno';
  }
  subtituloPeek(v: ViajePorCompletar): string {
    return `${this.sucursalPipe.transform(v.sucursal)} · ${this.fechaCorta(v.fecha)} · ${this.tipoLabel(v.tipo)}`;
  }
  tipoLabel(t: ViajePorCompletar['tipo']): string { return TIPO_VIAJE_LABEL[t] ?? t; }
  faltaLabel(f: FaltaDelViaje): string { return FALTA_LABEL[f]; }
  faltaTono(f: FaltaDelViaje): 'warn' | 'danger' { return FALTA_TONO[f]; }
  fechaCorta(iso: string): string {
    const d = new Date(iso + 'T12:00:00');
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' });
  }
  private dinero(n: number): string {
    return n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  }
}
