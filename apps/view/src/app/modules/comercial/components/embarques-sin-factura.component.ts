import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { SegmentedComponent, SegOption } from '../../../shared/components/segmented/segmented.component';
import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';
import { EmbarqueSinFactura, EmbarquesSinFacturaReport, SalesDocumentsService } from '../sales-documents.service';

const MXN = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });

/** Suma en centavos enteros: sumar `numeric` como float acumula error. */
function sumar(f: EmbarqueSinFactura[]): number {
  return f.reduce((s, e) => s + Math.round(Number(e.total_embarcado) * 100), 0) / 100;
}

/** Un renglón del desglose por sucursal. */
export interface DesgloseSucursal {
  sucursal: string;
  nunca: number;
  nuncaMonto: number;
  enCero: number;
  enCeroMonto: number;
  total: number;
}

/**
 * `[AX.18]` Embarques de telemarketing que salieron y no tienen factura viva.
 *
 * Es lo SECUNDARIO de Facturación TM, así que va como Edgar fijó el 2026-10-29 para lo secundario
 * de una pantalla de trabajo (`[CGA-A.63]`): un botón en el encabezado que ya dice cuánto falta y
 * abre una ventana ENCIMA — no empuja la tabla de facturas, que es la tarea.
 *
 * `[AX.19]` (2026-11-06) El botón quedaba flotando a media pantalla: con `:host { display: contents }`
 * el botón y el `p-dialog` entraban como DOS hijos del `surf-page-head` (flex, space-between) y el
 * botón caía al centro. Ahora el host es un bloque y se alinea a la derecha del título. Y el botón
 * desglosa sin abrir nada: cuántos nunca se facturaron y cuántos tienen la factura en $0, con su
 * ventana de días. La ventana suma el desglose por sucursal y por situación, y la antigüedad.
 *
 * Cuestionario de diseño (skill `diseno` §0b):
 *  1. Qué ve y en qué orden: en el botón, cuánto dinero y cuántos embarques, y de qué tipo; en la
 *     ventana, el resumen, el desglose por sucursal (cada renglón filtra la lista) y la lista del
 *     embarque más reciente al más viejo, con los días que lleva sin factura.
 *  2. Qué no: ni los que sí cuadran ni las diferencias de centavos (eso es el detalle de cada
 *     factura, `[AX.17]`); ni la serie 2 (traspaso), ni el cargo directo de La Piedad Abastos.
 *  3. Accesibilidad: el número y su desglose sin abrir nada; la lista a un clic, por nombre de
 *     sucursal y de cliente; filtrable por situación y por sucursal; recorrible con flechas.
 *  4. Ligado a otro proceso: la factura se emite en Kepler (la Suite no escribe ahí). Las facturas
 *     en $0 se nombran por folio para encontrarlas allá.
 *  5. ¿Le toca a esta pantalla? Sí: es la mitad que falta de «lo que se facturó».
 *
 * La fuente es `analytics.erp_shipment_billing`, la misma vista y diagnóstico que el detector
 * de Finanzas `cxc_embarcado_sin_facturar`: las dos pantallas dicen lo mismo.
 */
@Component({
  selector: 'app-embarques-sin-factura',
  standalone: true,
  imports: [CommonModule, ButtonModule, DialogModule, TableModule, TagModule,
    MetricStripComponent, LoadStateComponent, FreshnessPillComponent, SegmentedComponent, SucursalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button pButton type="button" severity="secondary" [outlined]="true" class="esf-btn"
            [class.esf-btn--hay]="filas().length > 0"
            [attr.aria-label]="ariaBoton()" (click)="abierta.set(true)">
      <i class="pi pi-truck esf-btn-ico" aria-hidden="true"></i>
      <span class="esf-btn-txt">
        <span class="esf-btn-tit">Embarques sin factura <span class="esf-btn-win">· {{ dias() }} días</span></span>
        <span class="esf-btn-val mono">{{ resumen() }}</span>
        @if (!loading() && !error() && filas().length) {
          <span class="esf-btn-des">{{ nunca().length }} nunca facturado{{ nunca().length === 1 ? '' : 's' }}
            · {{ enCero().length }} con factura {{ todasCanceladas() ? 'cancelada' : 'en $0' }}</span>
        }
      </span>
    </button>

    <p-dialog header="Embarques sin factura" [visible]="abierta()" (visibleChange)="abierta.set($event)"
              [modal]="true" [dismissableMask]="true" [draggable]="false" [style]="{ width: 'min(64rem, 96vw)' }">
      <div class="esf dt-scope">
        <div class="esf-top">
          <p class="esf-sub">Embarques de telemarketing de los últimos {{ dias() }} días que salieron
            y no tienen una factura viva en Kepler.</p>
          <app-freshness-pill measures="fetch" [since]="cargadoAt()" [staleAfterSec]="600" />
        </div>

        <app-load-state [loading]="loading()" [error]="error()"
                        [isEmpty]="!loading() && !error() && filas().length === 0"
                        emptyIcon="pi-check-circle" emptyTitle="Todos los embarques tienen factura"
                        [emptyHint]="'Ningún embarque de los últimos ' + dias() + ' días quedó sin facturar.'"
                        (retry)="cargar()">
          <app-metric-strip [items]="kpis()" />

          @if (hayDeHoy()) {
            <p class="esf-nota"><i class="pi pi-info-circle" aria-hidden="true"></i>
              Hay embarques de hoy: la factura suele salir 15 a 25 minutos después del embarque,
              así que pueden estar por facturarse.</p>
          }

          <!-- [AX.19] Lo que se sabe y lo que no: lo que no se pudo medir se DECLARA (ADR-056). -->
          <section class="esf-sabe" aria-label="Lo que se sabe y lo que no">
            <h3 class="esf-h">Lo que se sabe y lo que no</h3>
            <ul>
              @if (embarcados(); as m) {
                <li><i class="pi pi-check" aria-hidden="true"></i>
                  <span><b>La mercancía salió.</b> {{ m.si }} de {{ m.de }} embarques siguen como «EMBARCADO» en Kepler:
                    no se canceló la salida, sólo falta la factura.</span></li>
              }
              @if (estadoCero(); as k) {
                <li><i class="pi" [class.pi-check]="!k.sinSaber" [class.pi-question-circle]="k.sinSaber" aria-hidden="true"></i>
                  <span><b>Facturas en $0:</b> {{ k.canceladas }} de {{ k.total }} están canceladas en Kepler@if (k.vivas) {, {{ k.vivas }} siguen vivas en $0}@if (k.sinSaber) {; de {{ k.sinSaber }} no se pudo saber}.</span></li>
              }
              <li><i class="pi pi-question-circle" aria-hidden="true"></i>
                <span><b>¿Se volvió a facturar?</b> Ninguna factura viva está ligada a estos embarques. Buscarla
                  por importe no sirve: medido el 6-nov-2026, aparecen tantas coincidencias antes del embarque
                  como después. Hay que preguntarlo a Facturación.</span></li>
              <li><i class="pi pi-question-circle" aria-hidden="true"></i>
                <span><b>¿Por qué se canceló?</b> El motivo no está en lo que la Suite lee de Kepler.</span></li>
            </ul>
          </section>

          <!-- Desglose por sucursal: sólo cuando hay más de una. Cada renglón filtra la lista. -->
          @if (porSucursal().length > 1) {
            <section class="esf-des" aria-label="Desglose por sucursal">
              <h3 class="esf-h">Por sucursal</h3>
              <p-table [value]="porSucursal()" dataKey="sucursal" size="small" selectionMode="single"
                       [selection]="sucursalSel()" (selectionChange)="elegirSucursal($event)"
                       class="surf-table surf-table--plain">
                <ng-template #header>
                  <tr>
                    <th scope="col">Sucursal</th>
                    <th scope="col" class="r comm-num">Nunca se facturó</th>
                    <th scope="col" class="r comm-num">Factura en $0</th>
                    <th scope="col" class="r comm-num">Total sin factura</th>
                  </tr>
                </ng-template>
                <ng-template #body let-s>
                  <tr [pSelectableRow]="s">
                    <td>{{ s.sucursal | sucursal }}</td>
                    <td class="r mono comm-num">
                      @if (s.nunca) { {{ s.nunca }} · {{ s.nuncaMonto | currency: 'MXN':'symbol-narrow':'1.2-2':'es-MX' }} }
                      @else { <span class="sub">—</span> }
                    </td>
                    <td class="r mono comm-num">
                      @if (s.enCero) { {{ s.enCero }} · {{ s.enCeroMonto | currency: 'MXN':'symbol-narrow':'1.2-2':'es-MX' }} }
                      @else { <span class="sub">—</span> }
                    </td>
                    <td class="r mono comm-num fuerte">{{ s.total | currency: 'MXN':'symbol-narrow':'1.2-2':'es-MX' }}</td>
                  </tr>
                </ng-template>
              </p-table>
            </section>
          }

          <div class="esf-filtros">
            <app-segmented [options]="opcionesSituacion()" [value]="situacion()"
                           ariaLabel="Filtrar por situación" (valueChange)="situacion.set($event)" />
            @if (sucursalSel(); as s) {
              <p-button [label]="(s.sucursal | sucursal) + ' · quitar filtro'" icon="pi pi-times" iconPos="right"
                        size="small" [text]="true" severity="secondary" (onClick)="elegirSucursal(null)" />
            }
          </div>

          <p-table [value]="vista()" dataKey="folio_digital" size="small" selectionMode="single"
                   [selection]="marcado()" (selectionChange)="marcado.set($event)"
                   class="surf-table surf-table--plain dt-stack" [tableStyle]="{ 'min-width': '48rem' }">
            <ng-template #header>
              <tr>
                <th scope="col">Embarque</th>
                <th scope="col" style="width:6.5rem">Fecha</th>
                <th scope="col" class="r comm-num" style="width:5.5rem">Días</th>
                <th scope="col">Cliente</th>
                <th scope="col" class="r comm-num" style="width:9rem">Embarcado</th>
                <th scope="col" style="width:14rem">Situación</th>
              </tr>
            </ng-template>
            <ng-template #body let-e>
              <tr [pSelectableRow]="e">
                <td class="dt-id" role="cell">
                  <span class="mono">UD41{{ serie(e) }}-{{ e.folio }}</span>
                  <span class="sub">{{ e.sucursal | sucursal }}</span>
                </td>
                <td class="mono" role="cell" data-label="Fecha">{{ e.fecha | date: 'dd/MM/yy' }}</td>
                <td class="r mono comm-num" role="cell" data-label="Días sin factura">{{ diasSinFactura(e) }}</td>
                <td role="cell" data-label="Cliente">
                  <span class="nom">{{ e.cliente_nombre || 'Sin nombre en Kepler' }}</span>
                  <span class="sub mono">{{ e.cliente_code }}</span>
                </td>
                <td class="r mono comm-num" role="cell" data-label="Embarcado">
                  {{ +e.total_embarcado | currency: 'MXN':'symbol-narrow':'1.2-2':'es-MX' }}</td>
                <td role="cell" data-label="Situación">
                  @if (e.situacion === 'sin_factura') {
                    <p-tag severity="danger" value="Nunca se facturó" />
                  } @else if (cancelacion(e) === 'canceladas') {
                    <p-tag severity="warn" [value]="e.facturas.length === 1 ? 'Su factura se canceló' : 'Sus ' + e.facturas.length + ' facturas se cancelaron'" />
                    <span class="sub mono">{{ e.facturas.join(', ') }}</span>
                  } @else {
                    <p-tag severity="warn" [value]="e.facturas.length === 1 ? 'Su factura quedó en $0' : 'Sus ' + e.facturas.length + ' facturas quedaron en $0'" />
                    <span class="sub mono">{{ e.facturas.join(', ') }}</span>
                    @if (cancelacion(e) === 'no_se_sabe') { <span class="sub">no se sabe si se canceló</span> }
                  }
                </td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="6" class="sub">Ningún embarque con este filtro.</td></tr>
            </ng-template>
          </p-table>
        </app-load-state>
      </div>
    </p-dialog>
  `,
  styles: [`
    :host { display: block; }
    .esf-btn { display: inline-flex; align-items: center; gap: var(--sp-3, .75rem); text-align: left;
      padding: var(--sp-2, .5rem) var(--sp-3, .75rem); }
    .esf-btn-ico { font-size: var(--fs-body); color: var(--text-muted); }
    .esf-btn--hay .esf-btn-ico { color: var(--bad-fg, var(--text-main)); }
    .esf-btn-txt { display: flex; flex-direction: column; gap: 1px; line-height: 1.2; }
    .esf-btn-tit { font-size: var(--fs-xs, .75rem); font-weight: 600; color: var(--text-muted); }
    .esf-btn-win { font-weight: 400; }
    .esf-btn-val { font-size: var(--fs-body); font-weight: 700; color: var(--text-main); }
    .esf-btn-des { font-size: var(--fs-xs, .75rem); color: var(--text-muted); }

    .esf { display: flex; flex-direction: column; gap: var(--sp-3, .75rem); }
    .esf-top { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3, .75rem); flex-wrap: wrap; }
    .esf-sub { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
    .esf-nota { display: flex; align-items: flex-start; gap: .4rem; margin: 0; font-size: var(--fs-xs, .75rem); color: var(--text-muted); }
    .esf-h { margin: 0 0 var(--sp-1, .25rem); font-size: var(--fs-sm); font-weight: 700; color: var(--text-main); }
    .esf-sabe ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-1, .25rem); }
    .esf-sabe li { display: flex; align-items: flex-start; gap: var(--sp-2, .5rem); font-size: var(--fs-sm); color: var(--text-muted); }
    .esf-sabe li b { color: var(--text-main); font-weight: 600; }
    .esf-sabe .pi { margin-top: .2rem; font-size: var(--fs-xs, .75rem); }
    .esf-filtros { display: flex; align-items: center; gap: var(--sp-2, .5rem); flex-wrap: wrap; }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-variant-numeric: tabular-nums; }
    .nom { display: block; font-weight: 600; line-height: 1.25; }
    .sub { display: block; font-size: var(--fs-xs, .75rem); color: var(--text-muted); margin-top: 1px; }
    .fuerte { font-weight: 700; }
    .r { text-align: right; }
  `],
})
export class EmbarquesSinFacturaComponent {
  private readonly svc = inject(SalesDocumentsService);
  private readonly destroyRef = inject(DestroyRef);

  /** Sucursal que tiene puesta la pantalla (código). El backend la recorta a tu alcance. */
  readonly sucursal = input<string | null>(null);

  readonly abierta = signal(false);
  readonly report = signal<EmbarquesSinFacturaReport | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly cargadoAt = signal<Date | null>(null);
  /** Sólo para recorrer la lista con el teclado: marcar un renglón no hace nada más. */
  readonly marcado = signal<EmbarqueSinFactura | null>(null);
  /** Filtros de la ventana: situación y sucursal (ésta, desde el desglose). */
  /** `todos` · `sin_factura` · `facturas_en_cero` (string: es lo que emite `app-segmented`). */
  readonly situacion = signal<string>('todos');
  readonly sucursalSel = signal<DesgloseSucursal | null>(null);
  private peticion = 0;

  readonly filas = computed(() => this.report()?.embarques ?? []);
  readonly dias = computed(() => this.report()?.dias ?? 365);
  readonly nunca = computed(() => this.filas().filter((e) => e.situacion === 'sin_factura'));
  readonly enCero = computed(() => this.filas().filter((e) => e.situacion === 'facturas_en_cero'));

  /** Lo que el botón dice sin abrir nada. Lo no medido se declara, no se dibuja como cero. */
  readonly resumen = computed(() => {
    if (this.error()) return 'sin medir';
    const r = this.report();
    if (this.loading() || !r) return 'midiendo…';
    if (!r.embarques.length) return 'ninguno';
    return `${r.embarques.length} · ${MXN.format(Number(r.total))}`;
  });

  /** El nombre accesible repite el desglose: el lector de pantalla no ve el renglón de abajo. */
  readonly ariaBoton = computed(() => {
    const base = `Embarques sin factura de los últimos ${this.dias()} días: ${this.resumen()}`;
    if (this.loading() || this.error() || !this.filas().length) return base;
    const cero = this.todasCanceladas() ? 'con factura cancelada' : 'con factura en cero';
    return `${base}. ${this.nunca().length} nunca facturados, ${this.enCero().length} ${cero}. Abrir la lista.`;
  });

  readonly kpis = computed<MetricStripItem[]>(() => {
    const f = this.filas();
    const nunca = this.nunca();
    const enCero = this.enCero();
    return [
      { label: 'Embarcado sin factura', value: Number(this.report()?.total ?? 0), format: 'currency',
        tone: f.length ? 'bad' : undefined, sub: `${f.length} embarque${f.length === 1 ? '' : 's'}` },
      { label: 'Nunca se facturaron', value: sumar(nunca), format: 'currency',
        sub: `${nunca.length} embarque${nunca.length === 1 ? '' : 's'}` },
      { label: this.todasCanceladas() ? 'Factura cancelada' : 'Factura en $0', value: sumar(enCero), format: 'currency',
        sub: `${enCero.length} embarque${enCero.length === 1 ? '' : 's'}` },
      { label: 'El más viejo', value: f.length ? Math.max(...f.map((e) => this.diasSinFactura(e))) : 0,
        format: 'number', sub: 'días sin factura' },
    ];
  });

  /** Desglose por sucursal, de la que más dinero debe a la que menos. */
  readonly porSucursal = computed<DesgloseSucursal[]>(() => {
    const m = new Map<string, EmbarqueSinFactura[]>();
    for (const e of this.filas()) m.set(e.sucursal, [...(m.get(e.sucursal) ?? []), e]);
    return [...m.entries()].map(([sucursal, f]) => {
      const nunca = f.filter((e) => e.situacion === 'sin_factura');
      const enCero = f.filter((e) => e.situacion === 'facturas_en_cero');
      return { sucursal, nunca: nunca.length, nuncaMonto: sumar(nunca),
        enCero: enCero.length, enCeroMonto: sumar(enCero), total: sumar(f) };
    }).sort((a, b) => b.total - a.total);
  });

  readonly opcionesSituacion = computed<SegOption[]>(() => {
    const f = this.porSucursalFiltrada();
    return [
      { label: 'Todos', value: 'todos', count: f.length },
      { label: 'Nunca se facturó', value: 'sin_factura', count: f.filter((e) => e.situacion === 'sin_factura').length },
      { label: 'Factura en $0', value: 'facturas_en_cero', count: f.filter((e) => e.situacion === 'facturas_en_cero').length },
    ];
  });

  private readonly porSucursalFiltrada = computed(() => {
    const s = this.sucursalSel();
    const f = this.filas();
    return s ? f.filter((e) => e.sucursal === s.sucursal) : f;
  });

  /** Lo que muestra la lista: el desglose elegido, del embarque más reciente al más viejo. */
  readonly vista = computed(() => {
    const sit = this.situacion();
    const f = this.porSucursalFiltrada();
    return sit === 'todos' ? f : f.filter((e) => e.situacion === sit);
  });

  /**
   * `[AX.19]` Las facturas en $0, por su estado en Kepler. `sinSaber` cuenta las que la API no
   * pudo casar (o una API anterior que no manda el detalle): nunca se suman a las canceladas.
   */
  readonly estadoCero = computed(() => {
    const e = this.enCero();
    if (!e.length) return null;
    let canceladas = 0, vivas = 0, sinSaber = 0;
    for (const x of e) {
      if (!x.facturas_detalle) { sinSaber += x.facturas.length; continue; }
      for (const f of x.facturas_detalle) {
        if (f.cancelada === true) canceladas++;
        else if (f.cancelada === false) vivas++;
        else sinSaber++;
      }
    }
    return { total: canceladas + vivas + sinSaber, canceladas, vivas, sinSaber };
  });

  readonly todasCanceladas = computed(() => {
    const k = this.estadoCero();
    return !!k && k.canceladas === k.total;
  });

  /** `[AX.19]` Cuántos embarques siguen EMBARCADO; `null` si la API no manda el estatus. */
  readonly embarcados = computed(() => {
    const f = this.filas();
    if (!f.length || f.some((e) => e.estatus_embarque === undefined)) return null;
    return { si: f.filter((e) => e.estatus_embarque === 'EMBARCADO').length, de: f.length };
  });

  cancelacion(e: EmbarqueSinFactura): 'canceladas' | 'vivas' | 'no_se_sabe' {
    const d = e.facturas_detalle;
    if (!d?.length || d.some((f) => f.cancelada === null)) return 'no_se_sabe';
    return d.every((f) => f.cancelada) ? 'canceladas' : 'vivas';
  }

  readonly hayDeHoy = computed(() => this.filas().some((e) => e.fecha === this.hoy()));

  constructor() {
    // Se mide al entrar (el botón dice cuánto falta sin abrir nada) y cada vez que cambia la
    // sucursal de la pantalla. Leer `sucursal()` fuera del `untracked` es lo que lo vuelve reactivo.
    effect(() => {
      this.sucursal();
      untracked(() => this.cargar());
    });
  }

  /** La serie del embarque en dos dígitos (`UD4101-…`): esta lista es sólo serie 1. */
  serie(e: EmbarqueSinFactura): string {
    return e.folio_digital.slice(6, 8);
  }

  /** Días desde el embarque, en la zona de México (la fecha llega como `YYYY-MM-DD`). */
  diasSinFactura(e: EmbarqueSinFactura): number {
    const ms = Date.parse(this.hoy() + 'T00:00:00Z') - Date.parse(e.fecha + 'T00:00:00Z');
    return Math.max(0, Math.round(ms / 86_400_000));
  }

  elegirSucursal(s: DesgloseSucursal | null): void {
    this.sucursalSel.set(s && this.sucursalSel()?.sucursal !== s.sucursal ? s : null);
  }

  private hoy(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
  }

  cargar(): void {
    const mia = ++this.peticion;
    this.loading.set(true);
    this.error.set(null);
    this.svc.embarquesSinFactura(this.sucursal()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        if (mia !== this.peticion) return; // llegó tarde: manda la consulta nueva
        this.report.set(r);
        this.sucursalSel.set(null);
        this.cargadoAt.set(new Date());
        this.loading.set(false);
      },
      error: (e) => {
        if (mia !== this.peticion) return;
        this.error.set(e?.error?.message || 'No se pudo medir qué embarques quedaron sin factura.');
        this.loading.set(false);
      },
    });
  }
}
