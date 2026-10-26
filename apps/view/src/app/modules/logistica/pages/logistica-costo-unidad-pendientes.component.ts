import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { ButtonModule } from 'primeng/button';
import { DatePickerModule } from 'primeng/datepicker';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import type { AlcanceBandeja, AsignacionGasto, EstadoLineaFlota, LineaGastoFlota, RubroCodigo } from '@megadulces/contracts';
import { ESTADO_LINEA_FLOTA_LABEL, RUBROS_COSTO_UNIDAD } from '@megadulces/contracts';
import { coincideBusqueda } from '@megadulces/ui-web';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { SegmentedComponent, SegOption } from '../../../shared/components/segmented/segmented.component';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { LogisticaService, PendientesCostoUnidad } from '../logistica.service';
import { COSTO_UNIDAD_TABS } from '../costo-unidad-tabs';
import { aIso, deIso, rangoDe } from '../costo-unidad-fechas';

const RUBRO_LABEL = Object.fromEntries(RUBROS_COSTO_UNIDAD.map((r) => [r.codigo, r.etiqueta])) as Record<RubroCodigo, string>;
const ESTADO_SEV: Record<EstadoLineaFlota, 'info' | 'warn' | 'secondary' | 'success'> = {
  sugerido: 'info', ambiguo: 'warn', sin_unidad: 'secondary', confirmado: 'success', no_es_flota: 'secondary',
};

/**
 * `[FCU.3.5]` Qué hacer con los renglones seleccionados. `confirmar` = aceptar la unidad que sugirió
 * el texto (sólo los que la tienen); `asignar` = a la unidad elegida; `no_es_flota` = sacarlos;
 * `quitar` = deshacer lo decidido (el renglón vuelve a sugerido, ambiguo o sin unidad).
 */
export type AccionBandeja = 'confirmar' | 'asignar' | 'no_es_flota' | 'quitar';
export function asignacionesDe(sel: LineaGastoFlota[], accion: AccionBandeja, unidad: string | null): AsignacionGasto[] {
  if (accion === 'quitar') return sel.map((l) => ({ linea_clave: l.linea_clave, decision: 'quitar', vehicle_id: null }));
  if (accion === 'no_es_flota') return sel.map((l) => ({ linea_clave: l.linea_clave, decision: 'no_es_flota', vehicle_id: null }));
  if (accion === 'asignar') return unidad ? sel.map((l) => ({ linea_clave: l.linea_clave, decision: 'unidad', vehicle_id: unidad })) : [];
  return sel.filter((l) => !!l.sugerido_vehicle_id).map((l) => ({ linea_clave: l.linea_clave, decision: 'unidad', vehicle_id: l.sugerido_vehicle_id }));
}

/**
 * `[FCU.3.5]` — **Gastos sin unidad: la bandeja.**
 *
 * La pregunta que contesta: ¿qué gastos de flota de Kepler todavía no sé de qué unidad son? Kepler
 * no tiene campo de unidad: el sistema la SUGIERE leyendo el texto del gasto (los alias de la ficha)
 * y aquí una persona la confirma, la cambia, o dice «no es de flota». Lo que dice «nombra dos
 * unidades» nunca se adivina.
 *
 * Por defecto muestra lo de Logística (sugeridos a una unidad de Transportes, ambiguos, y sin unidad
 * en sus centros de costo); «Todos» suma los sin unidad de otras flotillas.
 *
 * Jerarquía: primario = cuánto falta confirmar; secundario = los renglones; terciario = su texto.
 */
@Component({
  selector: 'app-logistica-costo-unidad-pendientes',
  standalone: true,
  imports: [
    CurrencyPipe, FormsModule, TableModule, SelectModule, ButtonModule, DatePickerModule, TagModule, ToastModule, LoadStateComponent,
    MetricStripComponent, FreshnessPillComponent, SegmentedComponent, PageTabsComponent, SucursalPipe, ContextHelpComponent,
  ],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page cp">
      <p-toast />
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Costo por unidad</h1>
          <p class="surf-page-sub">Gastos de flota de Kepler que todavía no se sabe de qué unidad son. El sistema sugiere la unidad por el texto del gasto; aquí se confirma.</p>
        </div>
        <app-context-help topic="costo-unidad" />
      </header>
      <app-page-tabs [tabs]="tabs" ariaLabel="Pantallas de costo por unidad" />

      <section class="cp-barra" aria-label="Periodo y alcance">
        <p-datepicker [ngModel]="desdeFecha()" (ngModelChange)="cambiarFecha('desde', $event)" dateFormat="dd/mm/yy" [showIcon]="true" ariaLabel="Desde" appendTo="body" class="cp-fecha" />
        <p-datepicker [ngModel]="hastaFecha()" (ngModelChange)="cambiarFecha('hasta', $event)" dateFormat="dd/mm/yy" [showIcon]="true" ariaLabel="Hasta" appendTo="body" class="cp-fecha" />
        <app-segmented [options]="alcances" [value]="alcance()" (valueChange)="cambiarAlcance($event)" ariaLabel="Qué gastos ver" />
        <span class="cp-espacio"></span>
        @if (data()) { <app-freshness-pill measures="fetch" [since]="leido()" label="gastos de Kepler" /> }
      </section>

      @if (data(); as d) {
        <p class="cp-titular">{{ titular() }}</p>
        <app-metric-strip [items]="kpis()" mode="strip" density="compact" ariaLabel="Gastos por confirmar" />
      }

      <app-load-state [loading]="cargando() && !data()" [error]="error()" [isEmpty]="!!data() && !data()!.lineas.length"
                      emptyIcon="pi-check-circle" [emptyTitle]="decididos() ? 'Nada decidido en el periodo' : 'Nada por confirmar en el periodo'"
                      [emptyHint]="decididos() ? 'Nadie ha asignado ni marcado como no de flota ningún gasto de estas fechas.' : 'Todos los gastos de flota de Kepler del periodo ya tienen unidad (o se marcaron como no de flota).'"
                      (retry)="cargar()">
        <section class="cp-barra" aria-label="Filtros">
          <p-select [options]="estados()" optionLabel="label" optionValue="value" [ngModel]="estado()" (ngModelChange)="estado.set($event)"
                    [showClear]="true" placeholder="Cualquier estado" ariaLabel="Estado" appendTo="body" class="cp-sel" />
          <p-select [options]="rubros()" optionLabel="label" optionValue="value" [ngModel]="rubro()" (ngModelChange)="rubro.set($event)"
                    [showClear]="true" placeholder="Cualquier rubro" ariaLabel="Rubro" appendTo="body" class="cp-sel" />
          <label class="cp-buscar"><span class="sr-only">Buscar</span>
            <input type="search" [value]="busqueda()" (input)="busqueda.set($any($event.target).value)" placeholder="Texto, folio o proveedor" autocomplete="off" spellcheck="false" />
          </label>
          <span class="cp-cuenta">{{ filtradas().length }} de {{ data()?.lineas?.length ?? 0 }} renglones</span>
        </section>

        @if (puedeGestionar && decididos()) {
          <section class="cp-acciones" aria-label="Qué hacer con los seleccionados">
            <span class="cp-sub">{{ seleccion().length }} seleccionado{{ seleccion().length === 1 ? '' : 's' }}</span>
            <button pButton type="button" size="small" [outlined]="true" [disabled]="!seleccion().length || guardando()" (click)="aplicar('quitar')">
              <span class="p-button-label">Deshacer lo decidido</span></button>
          </section>
        } @else if (puedeGestionar) {
          <section class="cp-acciones" aria-label="Qué hacer con los seleccionados">
            <span class="cp-sub">{{ seleccion().length }} seleccionado{{ seleccion().length === 1 ? '' : 's' }}</span>
            <button pButton type="button" size="small" [disabled]="!confirmables() || guardando()" (click)="aplicar('confirmar')">
              <span class="p-button-label">Confirmar lo sugerido ({{ confirmables() }})</span></button>
            <p-select [options]="unidades()" optionLabel="label" optionValue="value" [ngModel]="unidad()" (ngModelChange)="unidad.set($event)"
                      placeholder="Elegir unidad" ariaLabel="Unidad a la que se asignan" appendTo="body" class="cp-sel" [filter]="true" />
            <button pButton type="button" size="small" [outlined]="true" [disabled]="!seleccion().length || !unidad() || guardando()" (click)="aplicar('asignar')">
              <span class="p-button-label">Asignar a esa unidad</span></button>
            <span class="cp-espacio"></span>
            <button pButton type="button" size="small" [text]="true" severity="secondary" [disabled]="!seleccion().length || guardando()" (click)="aplicar('no_es_flota')">
              <span class="p-button-label">No es de flota</span></button>
          </section>
        }

        <div class="dt-scope">
          <p-table [value]="filtradas()" dataKey="linea_clave" [selectionMode]="puedeGestionar ? 'multiple' : null" [selection]="seleccion()"
                   (selectionChange)="seleccion.set($event ?? [])" [metaKeySelection]="false" size="small"
                   class="surf-table surf-table--plain surf-table--sticky surf-table--frozen-first dt-stack" [tableStyle]="{ 'min-width': '64rem' }">
            <ng-template #header>
              <tr>
                @if (puedeGestionar) { <th scope="col" class="cp-chk"><p-tableheadercheckbox ariaLabel="Seleccionar todos" /></th> }
                <th scope="col">Fecha</th>
                <th scope="col">Folio</th>
                <th scope="col">Texto en Kepler</th>
                <th scope="col">Rubro</th>
                <th scope="col" class="comm-num">Importe</th>
                <th scope="col">Estado</th>
                <th scope="col">Unidad</th>
              </tr>
            </ng-template>
            <ng-template #body let-l>
              <tr [pSelectableRow]="l">
                @if (puedeGestionar) { <td class="cp-chk"><p-tablecheckbox [value]="l" [ariaLabel]="'Seleccionar el folio ' + l.folio" /></td> }
                <td data-label="Fecha">{{ l.fecha }}</td>
                <td data-label="Folio" class="cp-mono">{{ l.folio }}<span class="cp-sub">{{ l.sucursal | sucursal }}</span></td>
                <td data-label="Texto en Kepler">{{ l.cabecera }}<span class="cp-sub">{{ l.texto }}{{ l.proveedor ? ' · ' + l.proveedor : '' }}</span></td>
                <td data-label="Rubro">{{ l.rubro ? rubroLabel(l.rubro) : '—' }}<span class="cp-sub">concepto {{ l.concepto }}{{ l.centro ? ' · centro ' + l.centro : '' }}</span></td>
                <td data-label="Importe" class="comm-num">{{ l.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td data-label="Estado"><p-tag [value]="estadoLabel(l.estado)" [severity]="estadoSev(l.estado)" /></td>
                <td data-label="Unidad">{{ unidadDe(l) }}</td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td [attr.colspan]="puedeGestionar ? 8 : 7" class="cp-vacio">Ningún renglón con esos filtros.</td></tr>
            </ng-template>
          </p-table>
        </div>
      </app-load-state>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .cp { display: flex; flex-direction: column; gap: var(--sp-3); container-type: inline-size; }
    .cp-barra, .cp-acciones { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
    .cp-acciones { padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md); }
    .cp-fecha { width: 10rem; }
    .cp-sel { min-width: 12rem; }
    .cp-espacio { flex: 1; }
    .cp-titular { margin: 0; font-size: var(--fs-lg); font-weight: var(--fw-bold); color: var(--fg-1); }
    .cp-buscar input { min-width: 16rem; padding: var(--sp-2); border: 1px solid var(--border-color); border-radius: var(--r-md); background: transparent; color: inherit; font: inherit; }
    .cp-buscar input:focus-visible { outline: 2px solid var(--action); outline-offset: 1px; }
    .cp-cuenta { margin-left: auto; font-size: var(--fs-sm); color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .cp-sub { display: block; font-size: var(--fs-xs); color: var(--text-muted); }
    .cp-acciones .cp-sub { display: inline; }
    .cp-mono { font-family: var(--font-mono); }
    .cp-chk { width: 2.5rem; }
    .cp-vacio { padding: var(--sp-4); color: var(--text-muted); }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    @container (max-width: 40rem) { .cp-cuenta { margin-left: 0; } .cp-espacio { display: none; } }
  `],
})
export class LogisticaCostoUnidadPendientesComponent {
  private readonly api = inject(LogisticaService);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(MessageService);
  private readonly ruta = inject(ActivatedRoute);

  readonly tabs = [...COSTO_UNIDAD_TABS];
  /** Gestionar: la clave exacta, o rol de plataforma (lo mismo que decide el backend). */
  get puedeGestionar(): boolean { return this.perms.has(Permission.LOGISTICS_COSTO_UNIDAD_GESTIONAR); }
  readonly alcances: SegOption[] = [{ label: 'De Logística', value: 'logistica' }, { label: 'Todos', value: 'todos' }, { label: 'Ya decididos', value: 'decididos' }];

  private readonly q = this.ruta.snapshot.queryParamMap;
  readonly desde = signal(/^\d{4}-\d{2}-\d{2}$/.test(this.q.get('desde') ?? '') ? String(this.q.get('desde')) : rangoDe('mes', new Date()).desde);
  readonly hasta = signal(/^\d{4}-\d{2}-\d{2}$/.test(this.q.get('hasta') ?? '') ? String(this.q.get('hasta')) : rangoDe('mes', new Date()).hasta);
  readonly desdeFecha = computed(() => deIso(this.desde()));
  readonly hastaFecha = computed(() => deIso(this.hasta()));
  readonly alcance = signal<AlcanceBandeja>('logistica');
  readonly decididos = computed(() => this.alcance() === 'decididos');
  readonly estados = computed(() => ((this.decididos() ? ['confirmado', 'no_es_flota'] : ['sugerido', 'ambiguo', 'sin_unidad']) as EstadoLineaFlota[])
    .map((e) => ({ value: e, label: ESTADO_LINEA_FLOTA_LABEL[e] })));

  readonly data = signal<PendientesCostoUnidad | null>(null);
  readonly leido = signal(new Date().toISOString());
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly guardando = signal(false);

  readonly estado = signal<EstadoLineaFlota | null>(null);
  readonly rubro = signal<RubroCodigo | null>(null);
  readonly busqueda = signal('');
  readonly seleccion = signal<LineaGastoFlota[]>([]);
  readonly unidad = signal<string | null>(null);

  readonly unidades = computed(() => (this.data()?.unidades ?? []).map((u) => ({ value: u.vehicle_id, label: `${u.economic_number ?? ''} ${u.nombre} · ${u.plate}`.trim() })));
  readonly rubros = computed(() => {
    const presentes = new Set((this.data()?.lineas ?? []).map((l) => l.rubro).filter(Boolean));
    return RUBROS_COSTO_UNIDAD.filter((r) => presentes.has(r.codigo)).map((r) => ({ value: r.codigo, label: r.etiqueta }));
  });
  readonly filtradas = computed(() => (this.data()?.lineas ?? []).filter((l) =>
    (!this.estado() || l.estado === this.estado()) && (!this.rubro() || l.rubro === this.rubro())
    && coincideBusqueda(this.busqueda(), l.cabecera, l.texto, l.folio, l.proveedor)));
  readonly confirmables = computed(() => this.seleccion().filter((l) => !!l.sugerido_vehicle_id).length);

  private cuenta(e: EstadoLineaFlota) {
    const ls = (this.data()?.lineas ?? []).filter((l) => l.estado === e);
    return { n: ls.length, importe: Math.round(ls.reduce((a, l) => a + l.importe, 0) * 100) / 100 };
  }
  readonly titular = computed(() => {
    const d = this.data();
    if (!d) return '';
    const total = d.lineas.reduce((a, l) => a + l.importe, 0);
    const s = this.cuenta('sugerido'); const a = this.cuenta('ambiguo'); const u = this.cuenta('sin_unidad');
    if (this.decididos()) {
      const c = this.cuenta('confirmado'); const n = this.cuenta('no_es_flota');
      if (!d.lineas.length) return 'Nadie ha decidido todavía ningún gasto del periodo.';
      return `${d.lineas.length} gasto${d.lineas.length === 1 ? '' : 's'} ya decidido${d.lineas.length === 1 ? '' : 's'}: ${c.n} asignado${c.n === 1 ? '' : 's'} a una unidad y ${n.n} marcado${n.n === 1 ? '' : 's'} como no de flota. «Deshacer lo decidido» los regresa a la bandeja.`;
    }
    if (!d.lineas.length) return 'Nada por confirmar en el periodo.';
    return `${d.lineas.length} gasto${d.lineas.length === 1 ? '' : 's'} de flota por confirmar ($${total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}): `
      + `${s.n} con unidad sugerida por el texto, ${a.n} que nombran dos unidades y ${u.n} sin unidad.`;
  });
  readonly kpis = computed<MetricStripItem[]>(() => {
    const s = this.cuenta('sugerido'); const a = this.cuenta('ambiguo'); const u = this.cuenta('sin_unidad');
    const $ = (x: number) => `$${x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (this.decididos()) {
      const c = this.cuenta('confirmado'); const n = this.cuenta('no_es_flota');
      return [
        { label: 'Asignados a una unidad', value: c.n, format: 'number', sub: $(c.importe) },
        { label: 'No es de flota', value: n.n, format: 'number', sub: $(n.importe) },
      ];
    }
    return [
      { label: 'Sugeridos por el texto', value: s.n, format: 'number', tone: s.n ? 'warn' : 'ok', sub: $(s.importe) },
      { label: 'Nombran dos unidades', value: a.n, format: 'number', tone: a.n ? 'warn' : 'ok', sub: $(a.importe) },
      { label: 'Sin unidad', value: u.n, format: 'number', tone: u.n ? 'warn' : 'ok', sub: $(u.importe) },
    ];
  });

  constructor() { this.cargar(); }

  cargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.api.costoUnidadPendientes(this.desde(), this.hasta(), this.alcance()).subscribe({
      next: (d) => { this.data.set(d); this.leido.set(new Date().toISOString()); this.seleccion.set([]); this.cargando.set(false); },
      error: (e) => { this.cargando.set(false); this.error.set(e?.error?.message ?? 'No se pudieron leer los gastos de Kepler.'); },
    });
  }

  cambiarFecha(cual: 'desde' | 'hasta', d: Date | null): void {
    if (!d) return;
    (cual === 'desde' ? this.desde : this.hasta).set(aIso(d));
    if (this.desde() <= this.hasta()) { this.data.set(null); this.cargar(); }
  }

  cambiarAlcance(v: string): void {
    this.alcance.set(v === 'todos' || v === 'decididos' ? v : 'logistica');
    this.estado.set(null);
    this.data.set(null);
    this.cargar();
  }

  aplicar(accion: AccionBandeja): void {
    if (this.guardando()) return;
    const items = asignacionesDe(this.seleccion(), accion, this.unidad());
    if (!items.length) return;
    this.guardando.set(true);
    this.api.costoUnidadAsignar(items).subscribe({
      next: (r) => {
        this.guardando.set(false);
        this.toast.add({ severity: 'success', summary: `${r.guardadas} renglón${r.guardadas === 1 ? '' : 'es'} guardado${r.guardadas === 1 ? '' : 's'}`, life: 2500 });
        this.cargar();
      },
      // Se guarda todo o nada (una transacción): si falla, la selección se queda para reintentar.
      error: (e) => { this.guardando.set(false); this.toast.add({ severity: 'error', summary: 'No se guardó ninguno', detail: e?.error?.message ?? '' }); },
    });
  }

  nombreUnidad(id: string): string {
    const u = this.data()?.unidades.find((x) => x.vehicle_id === id);
    return u ? `${u.economic_number ?? ''} ${u.nombre}`.trim() : 'otra unidad (no de Transportes)';
  }
  /** La unidad del renglón: la asignada (confirmado) se distingue de la que sólo sugiere el texto. */
  unidadDe(l: LineaGastoFlota): string {
    if (l.estado === 'confirmado' && l.vehicle_id) return this.nombreUnidad(l.vehicle_id);
    if (l.estado === 'sugerido' && l.sugerido_vehicle_id) return `${this.nombreUnidad(l.sugerido_vehicle_id)} (sugerida)`;
    if (l.estado === 'ambiguo') return `nombra ${l.candidatos} unidades`;
    return '—';
  }
  rubroLabel(r: RubroCodigo): string { return RUBRO_LABEL[r] ?? r; }
  estadoLabel(e: EstadoLineaFlota): string { return ESTADO_LINEA_FLOTA_LABEL[e]; }
  estadoSev(e: EstadoLineaFlota) { return ESTADO_SEV[e]; }
}
