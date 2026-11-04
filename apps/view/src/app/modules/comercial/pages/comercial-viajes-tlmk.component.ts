import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { TagModule } from 'primeng/tag';
import type { EstadoCostoViaje, ViajeTlmk, ViajesTlmkResponse } from '@megadulces/contracts';
import { ESTADO_COSTO_VIAJE_LABEL } from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { SegmentedComponent, SegOption } from '../../../shared/components/segmented/segmented.component';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';
import { PermissionsService } from '../../../core/services/permissions.service';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import { ComercialService } from '../comercial.service';
import { RUTA_DIRECTA_TABS } from '../ruta-directa-tabs';

type Filtro = 'todos' | EstadoCostoViaje;

const SEV: Record<EstadoCostoViaje, 'success' | 'warn' | 'secondary'> = {
  capturado: 'success', a_medias: 'warn', sin_captura: 'secondary',
};

/** `Date` local → `YYYY-MM-DD` sin pasar por UTC (un `toISOString` corre la fecha un día de noche). */
function aIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** `YYYY-MM-DD` → `Date` local a mediodía (lejos de medianoche, ver nota de fechas abajo). */
function deIso(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

/**
 * `[FCT.3.1]` — **Viajes TM**: cuánto le cuesta a la empresa entregar cada viaje de Telemarketing,
 * contra lo que se vendió en él. Reemplaza la hoja «RENTABILIDAD TLMKT 2026».
 *
 * El diseño, por escrito antes de la plantilla, está en
 * `FASE_FC_ANEXO_RENTABILIDAD_TLMK_2026-11-04.md` §C3 (los 12 pasos de la skill `diseno`).
 *
 *  · Jerarquía (Q.5): primario = cuántos viajes tienen su costo capturado; secundario = la tabla
 *    de viajes; terciario = la guía de Kepler y las paradas.
 *  · Nunca se dibuja un costo de $0 sin captura: el viaje dice «Sin capturar en Logística» y su
 *    celda de costo queda vacía con el motivo. La camioneta se declara «sin dato» hasta que corra
 *    Costo por unidad.
 *  · Sólo lectura. El acto que cierra el ciclo vive en Logística › Pagos de viaje (capturar quién
 *    fue y su horario); esta pantalla lleva hasta él con la operación ya abierta.
 *
 * ⚠️ Las fechas del servidor llegan como texto `YYYY-MM-DD` y se muestran CORTANDO la cadena: un
 * `new Date('2026-10-16')` es medianoche UTC, o sea el 15 en hora de México.
 */
@Component({
  selector: 'app-comercial-viajes-tlmk',
  standalone: true,
  imports: [
    CurrencyPipe, DecimalPipe, FormsModule, RouterLink, TableModule, SelectModule, DatePickerModule, TagModule,
    LoadStateComponent, MetricStripComponent, FreshnessPillComponent, SidePeekComponent, SegmentedComponent,
    PageTabsComponent, SucursalPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page vt">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Viajes de Telemarketing</h1>
          <p class="surf-page-sub">Cada viaje de entrega con su venta (de Kepler) y lo que costó (lo que Logística capturó del viaje). Reemplaza la hoja de rentabilidad de Telemarketing.</p>
        </div>
      </header>
      <app-page-tabs [tabs]="tabs" ariaLabel="Pantallas de Ruta Directa y Telemarketing" />

      <section class="vt-barra" aria-label="Periodo y sucursal">
        <p-datepicker [ngModel]="desdeFecha()" (ngModelChange)="cambiarFecha('desde', $event)" dateFormat="dd/mm/yy"
                      [showIcon]="true" inputId="vt-desde" ariaLabel="Desde" appendTo="body" class="vt-fecha" />
        <p-datepicker [ngModel]="hastaFecha()" (ngModelChange)="cambiarFecha('hasta', $event)" dateFormat="dd/mm/yy"
                      [showIcon]="true" inputId="vt-hasta" ariaLabel="Hasta" appendTo="body" class="vt-fecha" />
        <p-select [options]="opcionesSucursal()" optionLabel="label" optionValue="value" [ngModel]="sucursal()"
                  (ngModelChange)="elegirSucursal($event)" ariaLabel="Sucursal" appendTo="body" class="vt-sel" />
        <span class="vt-espacio"></span>
        @if (leidoAt(); as t) { <app-freshness-pill measures="fetch" [since]="t" label="viajes de Kepler" /> }
      </section>

      @if (data(); as d) {
        <p class="vt-titular">{{ titular() }}</p>
        @if (d.resumen.por_estado.sin_captura.viajes) {
          <p class="vt-aviso" role="note">
            {{ d.resumen.por_estado.sin_captura.viajes | number }} viaje{{ d.resumen.por_estado.sin_captura.viajes === 1 ? '' : 's' }}
            sin capturar en Logística: su costo no se puede calcular hasta que alguien registre quién fue y a qué hora salió y llegó.
            @if (puedeIrALogistica()) {
              <a routerLink="/logistica/pagos/viajes" [queryParams]="{ desde: desde(), hasta: hasta() }">Ir a Pagos de viaje</a>
            }
          </p>
        }
        <app-metric-strip [items]="kpis()" mode="strip" density="compact" ariaLabel="Viajes de Telemarketing en el periodo" />
        <app-segmented [options]="filtros()" [value]="filtro()" (valueChange)="filtro.set($any($event))"
                       ariaLabel="Filtrar por estado del costo" />
      }

      <app-load-state [loading]="cargando() && !data()" [error]="error()" [isEmpty]="!!data() && !filas().length"
                      emptyIcon="pi-truck" [emptyTitle]="vacioTitulo()" [emptyHint]="vacioPista()" (retry)="cargar()">
        <div class="dt-scope">
          <p-table [value]="filas()" dataKey="clave" selectionMode="single" [selection]="seleccion()"
                   (onRowSelect)="abrir($any($event.data))" size="small" sortMode="single"
                   class="surf-table surf-table--plain surf-table--sticky surf-table--frozen-first dt-stack"
                   [tableStyle]="{ 'min-width': '62rem' }">
            <ng-template #header>
              <tr>
                <th scope="col" pSortableColumn="fecha">Fecha <p-sort-icon field="fecha" /></th>
                <th scope="col">Sucursal</th>
                <th scope="col">Destinos</th>
                <th scope="col">Vendedor</th>
                <th scope="col" class="comm-num">Paradas</th>
                <th scope="col" class="comm-num" pSortableColumn="venta">Venta <p-sort-icon field="venta" /></th>
                <th scope="col">Costo del viaje</th>
                <th scope="col" class="comm-num" pSortableColumn="registrado">Gasto registrado <p-sort-icon field="registrado" /></th>
                <th scope="col" class="comm-num" pSortableColumn="pct">% de la venta <p-sort-icon field="pct" /></th>
              </tr>
            </ng-template>
            <ng-template #body let-v>
              <tr [pSelectableRow]="v" [attr.aria-label]="'Abrir el viaje ' + v.guia_digital">
                <td data-label="Fecha">
                  {{ fechaCorta(v.fecha) }}
                  <span class="vt-sub">guía {{ v.guia_digital }}</span>
                </td>
                <td data-label="Sucursal">{{ v.sucursal_nombre ?? (v.sucursal | sucursal) }}</td>
                <td data-label="Destinos">
                  {{ v.destinos }}
                  @if (v.ciudades.length > 2) { <span class="vt-sub">y {{ v.ciudades.length - 2 }} más</span> }
                </td>
                <td data-label="Vendedor">
                  {{ v.vendedor }}
                  @if (v.vendedores.length > 1) { <span class="vt-sub">y {{ v.vendedores.length - 1 }} más</span> }
                </td>
                <td data-label="Paradas" class="comm-num">{{ v.paradas }}</td>
                <td data-label="Venta" class="comm-num vt-fuerte">{{ v.venta | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td data-label="Costo del viaje"><p-tag [value]="etiqueta(v.estado_costo)" [severity]="sev(v.estado_costo)" /></td>
                <td data-label="Gasto registrado" class="comm-num">
                  @if (v.costo) { {{ v.costo.registrado | currency:'MXN':'symbol-narrow':'1.2-2' }} }
                  @else { <span class="vt-falta">sin dato</span> }
                </td>
                <td data-label="% de la venta" class="comm-num">
                  @if (v.pct_registrado != null) { {{ v.pct_registrado | number:'1.2-2' }} % } @else { — }
                </td>
              </tr>
            </ng-template>
          </p-table>
        </div>
        <p class="vt-pie">
          El gasto registrado es lo que Logística capturó del viaje: comisión del chofer y de los auxiliares, viáticos y gastos de ruta.
          No incluye la camioneta (desgaste, seguro, sueldo): eso saldrá de Costo por unidad. Venta: el total de los embarques de la guía en Kepler.
          @if (coberturaTexto(); as c) { {{ c }} }
        </p>
      </app-load-state>

      <app-side-peek [open]="!!abierto()" (openChange)="!$event && cerrar()" [width]="560"
                     [title]="abierto() ? ('Viaje ' + abierto()!.guia_digital) : ''"
                     [subtitle]="abierto() ? (fechaCorta(abierto()!.fecha) + ' · ' + (abierto()!.sucursal_nombre ?? (abierto()!.sucursal | sucursal))) : null">
        @if (abierto(); as v) {
          <div class="vt-peek">
            <div>
              <span class="vt-total">{{ v.venta | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
              <span class="vt-sub">venta del viaje · {{ v.paradas }} paradas · {{ v.clientes }} clientes</span>
            </div>

            <h3>Costo del viaje</h3>
            <p-tag [value]="etiqueta(v.estado_costo)" [severity]="sev(v.estado_costo)" />
            @if (v.costo; as c) {
              <dl class="vt-dl">
                <dt>Comisión del chofer</dt><dd>{{ c.comision_chofer | currency:'MXN':'symbol-narrow':'1.2-2' }}</dd>
                <dt>Comisión de auxiliares</dt><dd>{{ c.comision_auxiliares | currency:'MXN':'symbol-narrow':'1.2-2' }}</dd>
                <dt>Viáticos</dt><dd>{{ c.viaticos | currency:'MXN':'symbol-narrow':'1.2-2' }}</dd>
                <dt>Gastos de ruta</dt>
                <dd>@if (c.gastos_ruta != null) { {{ c.gastos_ruta | currency:'MXN':'symbol-narrow':'1.2-2' }} } @else { <span class="vt-falta">sin dato: no se capturaron</span> }</dd>
                <dt>Camioneta</dt><dd><span class="vt-falta">sin dato: saldrá de Costo por unidad</span></dd>
                <dt class="vt-fuerte">Gasto registrado</dt><dd class="vt-fuerte">{{ c.registrado | currency:'MXN':'symbol-narrow':'1.2-2' }}</dd>
                <dt>Kilómetros</dt><dd>@if (v.km != null) { {{ v.km | number:'1.0-0' }} km } @else { <span class="vt-falta">sin dato</span> }</dd>
              </dl>
            } @else {
              <p class="vt-motivo">
                @if (v.estado_costo === 'a_medias') {
                  Logística ya tomó el viaje, pero a alguna guía le falta el chofer o el horario: hasta completarla, su comisión y sus viáticos valen cero, así que el costo no se publica.
                } @else {
                  Nadie ha capturado este viaje en Logística: no se sabe quién fue, ni cuánto se le pagó.
                }
              </p>
              @if (puedeIrALogistica()) {
                <a class="vt-link" routerLink="/logistica/pagos/viajes"
                   [queryParams]="{ op: v.sucursal + '|' + v.guia, desde: v.fecha, hasta: v.fecha_hasta }">Abrir el viaje en Pagos de viaje</a>
              } @else {
                <p class="vt-sub">Se captura en Logística › Pagos de viaje.</p>
              }
            }

            <h3>Quién vendió</h3>
            <dl class="vt-dl">
              @for (x of v.vendedores; track x.code) {
                <dt>{{ x.nombre ?? 'Sin vendedor en Kepler' }}</dt><dd>{{ x.venta | currency:'MXN':'symbol-narrow':'1.2-2' }}</dd>
              }
            </dl>

            <h3>A dónde fue</h3>
            <p class="vt-ciudades">{{ v.ciudades.length ? v.ciudades.join(' · ') : 'Kepler no trae la ciudad de destino' }}</p>
            @if (v.fecha !== v.fecha_hasta) {
              <p class="vt-sub">La guía tiene embarques del {{ fechaCorta(v.fecha) }} al {{ fechaCorta(v.fecha_hasta) }}.</p>
            }
          </div>
        }
      </app-side-peek>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .vt { display: flex; flex-direction: column; gap: var(--sp-3); container-type: inline-size; }
    .vt-barra { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
    .vt-sel { min-width: 14rem; }
    .vt-fecha { width: 10rem; }
    .vt-espacio { flex: 1; }
    .vt-titular { margin: 0; font-size: var(--fs-lg); font-weight: var(--fw-bold); color: var(--text-main); }
    .vt-aviso { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-md); font-size: var(--fs-sm); background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .vt-sub { display: block; font-size: var(--fs-xs); color: var(--text-muted); }
    .vt-falta { font-size: var(--fs-xs); color: var(--text-muted); font-style: italic; }
    .vt-fuerte { font-weight: var(--fw-bold); }
    .vt-pie { margin: var(--sp-2) 0 0; font-size: var(--fs-xs); color: var(--text-muted); max-width: 70rem; }
    .vt-peek { display: flex; flex-direction: column; gap: var(--sp-2); }
    .vt-peek h3 { margin: var(--sp-3) 0 var(--sp-1); font-size: var(--fs-sm); font-weight: var(--fw-bold); }
    .vt-total { display: block; font-size: var(--fs-h2); font-weight: var(--fw-bold); font-variant-numeric: tabular-nums; }
    .vt-dl { display: grid; grid-template-columns: 1fr auto; gap: var(--sp-1) var(--sp-3); margin: 0; font-size: var(--fs-sm); }
    .vt-dl dt { color: var(--text-muted); }
    .vt-dl dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
    .vt-motivo { margin: 0; font-size: var(--fs-sm); color: var(--text-main); }
    .vt-ciudades { margin: 0; font-size: var(--fs-sm); }
    .vt-link { font-size: var(--fs-sm); }
  `],
})
export class ComercialViajesTlmkComponent {
  private readonly api = inject(ComercialService);
  private readonly perms = inject(PermissionsService);
  private readonly auth = inject(AuthService);
  readonly tabs = RUTA_DIRECTA_TABS;

  readonly data = signal<ViajesTlmkResponse | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly leidoAt = signal<Date | null>(null);
  readonly filtro = signal<Filtro>('todos');
  readonly sucursal = signal<string | null>(null);
  readonly abierto = signal<(ViajeTlmk & { clave: string; guia_digital: string }) | null>(null);

  private readonly hoy = new Date();
  readonly desde = signal(aIso(new Date(this.hoy.getFullYear(), this.hoy.getMonth(), 1)));
  readonly hasta = signal(aIso(this.hoy));
  readonly desdeFecha = computed(() => deIso(this.desde()));
  readonly hastaFecha = computed(() => deIso(this.hasta()));

  /** Pagos de viaje pide su propio permiso: el enlace sólo aparece si la puerta se abre. */
  readonly puedeIrALogistica = computed(() => {
    if (this.perms.isAdmin()) return true;
    return (this.auth.user()?.permissions ?? {})[Permission.LOGISTICS_PAGOS_VER] === true;
  });

  readonly opcionesSucursal = computed(() => {
    const d = this.data();
    const sucs = d?.sucursales ?? [];
    return [
      { label: 'Todas las sucursales', value: null },
      ...sucs.map((s) => ({ label: s.nombre ?? s.code, value: s.code })),
    ];
  });

  private readonly todas = computed(() => (this.data()?.viajes ?? []).map((v) => ({
    ...v,
    clave: `${v.sucursal}|${v.guia}`,
    guia_digital: `${v.sucursal}-G${v.guia}`,
    destinos: v.ciudades.slice(0, 2).join(', ') || 'sin ciudad',
    vendedor: v.vendedores[0]?.nombre ?? 'sin vendedor',
    registrado: v.costo?.registrado ?? null,
    pct: v.pct_registrado,
  })));

  readonly filas = computed(() => {
    const f = this.filtro();
    const t = this.todas();
    return f === 'todos' ? t : t.filter((v) => v.estado_costo === f);
  });

  readonly seleccion = computed(() => {
    const a = this.abierto();
    return a ? this.filas().find((v) => v.clave === a.clave) ?? null : null;
  });

  readonly filtros = computed<SegOption[]>(() => {
    const r = this.data()?.resumen;
    return [
      { label: 'Todos', value: 'todos', count: r?.viajes ?? 0 },
      { label: 'Sin capturar', value: 'sin_captura', count: r?.por_estado.sin_captura.viajes ?? 0 },
      { label: 'A medias', value: 'a_medias', count: r?.por_estado.a_medias.viajes ?? 0 },
      { label: 'Capturados', value: 'capturado', count: r?.por_estado.capturado.viajes ?? 0 },
    ];
  });

  /** Q.1 — la respuesta en una línea, antes de las cifras. */
  readonly titular = computed(() => {
    const r = this.data()?.resumen;
    if (!r) return '';
    if (!r.viajes) return 'No hay viajes de Telemarketing en el periodo.';
    const cap = r.por_estado.capturado.viajes;
    if (!cap) return `Ninguno de los ${r.viajes} viajes tiene su costo capturado en Logística: la rentabilidad del periodo no se puede calcular todavía.`;
    const pct = r.capturados_pct != null ? `${r.capturados_pct.toFixed(2)} %` : 'sin dato';
    return `${cap} de ${r.viajes} viajes tienen su costo capturado; en ésos, el gasto registrado es el ${pct} de su venta (sin la camioneta).`;
  });

  readonly kpis = computed<MetricStripItem[]>(() => {
    const r = this.data()?.resumen;
    if (!r) return [];
    const cap = r.por_estado.capturado;
    return [
      { label: 'Viajes', value: r.viajes, format: 'number' },
      { label: 'Venta de los viajes', value: r.venta, format: 'currency-short', sub: 'total de los embarques en Kepler' },
      {
        label: 'Con costo capturado', value: `${cap.viajes} de ${r.viajes}`, format: 'text',
        tone: cap.viajes < r.viajes ? 'warn' : 'ok', sub: 'capturados en Logística',
      },
      cap.viajes
        ? { label: 'Gasto registrado', value: r.capturados_registrado, format: 'currency', state: 'parcial',
            stateNote: 'Sólo los viajes capturados, sin la camioneta', sub: `${r.capturados_pct?.toFixed(2) ?? '—'} % de su venta` }
        : { label: 'Gasto registrado', value: 'sin dato', format: 'text', state: 'no_medido',
            stateNote: 'Ningún viaje del periodo tiene su costo capturado' },
    ];
  });

  readonly vacioTitulo = computed(() => this.filtro() === 'todos'
    ? 'No hay viajes de Telemarketing en el periodo' : 'Ningún viaje en este estado');
  readonly vacioPista = computed(() => this.filtro() === 'todos'
    ? 'Un viaje es una guía de embarque de Telemarketing en Kepler. Prueba con otro rango o sucursal.' : 'Cambia el filtro a «Todos».');

  /** Antes de esta fecha el ODS no trae embarques de esa sucursal: «no hay viajes» sería falso. */
  readonly coberturaTexto = computed(() => {
    const d = this.data();
    if (!d) return null;
    const suc = d.sucursal;
    const tarde = d.cobertura.filter((c) => c.desde && c.desde > d.desde && (!suc || c.sucursal === suc));
    if (!tarde.length) return null;
    const nombres = tarde.map((c) => `${d.sucursales.find((s) => s.code === c.sucursal)?.nombre ?? new SucursalPipe().transform(c.sucursal)} desde el ${this.fechaCorta(c.desde as string)}`);
    return `Kepler trae embarques de ${nombres.join(', ')}: antes de esa fecha no hay dato, no es que no hubiera viajes.`;
  });

  constructor() {
    this.cargar();
  }

  cargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.api.viajesTlmk({ desde: this.desde(), hasta: this.hasta(), sucursal: this.sucursal() }).subscribe({
      next: (r) => {
        this.data.set(r);
        this.leidoAt.set(new Date());
        this.cargando.set(false);
      },
      error: (e) => {
        this.error.set(e?.error?.message ?? 'No se pudieron leer los viajes de Telemarketing.');
        this.cargando.set(false);
      },
    });
  }

  cambiarFecha(cual: 'desde' | 'hasta', v: Date | null): void {
    if (!v) return;
    (cual === 'desde' ? this.desde : this.hasta).set(aIso(v));
    this.cargar();
  }

  elegirSucursal(code: string | null): void {
    this.sucursal.set(code);
    this.cargar();
  }

  abrir(v: ViajeTlmk & { clave: string; guia_digital: string }): void {
    this.abierto.set(v);
  }

  cerrar(): void {
    this.abierto.set(null);
  }

  etiqueta(e: EstadoCostoViaje): string {
    return ESTADO_COSTO_VIAJE_LABEL[e];
  }

  sev(e: EstadoCostoViaje): 'success' | 'warn' | 'secondary' {
    return SEV[e];
  }

  /** `2026-10-16` → `16-oct`, cortando la cadena (ver nota de fechas en el encabezado). */
  fechaCorta(iso: string): string {
    const meses = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
    const [, m, d] = iso.split('-');
    return `${Number(d)}-${meses[Number(m) - 1]}`;
  }
}
