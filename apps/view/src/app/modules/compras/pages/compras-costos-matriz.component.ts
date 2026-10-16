import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { rxResource } from '@angular/core/rxjs-interop';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { CheckboxModule } from 'primeng/checkbox';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { DatePickerModule } from 'primeng/datepicker';
import {
  COSTOS_KEPLER,
  CeldaMatrizCostos,
  ETIQUETA_VEREDICTO_MATRIZ,
  FilaMatrizCostos,
  TipoCostoKepler,
  VeredictoMatrizCostos,
} from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { isoLocalDate, makeDebouncedSearch, makeLazyLoad } from '../../../shared/util';
import { CostoEstandarService } from '../costo-estandar.service';

/** Los chips, en el orden en que hay que atenderlos. «Iguales» al final: es la meta, no la tarea. */
const CHIPS: { id: VeredictoMatrizCostos | ''; tono: 'bad' | 'warn' | 'info' | 'ok' | 'base' }[] = [
  { id: '', tono: 'base' },
  { id: 'distinto', tono: 'bad' },
  { id: 'sin_mayoria', tono: 'warn' },
  { id: 'unidad_distinta', tono: 'info' },
  { id: 'igual', tono: 'ok' },
];

const SEVERIDAD: Record<VeredictoMatrizCostos, 'danger' | 'warn' | 'info' | 'success' | 'secondary'> = {
  distinto: 'danger',
  sin_mayoria: 'warn',
  unidad_distinta: 'info',
  igual: 'success',
  una_plaza: 'secondary',
};

/** El costo se recalcula de noche: pasado un día y poco, ya no es de hoy. */
const UN_DIA_Y_POCO = 26 * 3600;

interface FilaVista extends FilaMatrizCostos {
  porSucursal: Record<string, CeldaMatrizCostos | undefined>;
}

/** `YYYY-MM-DD` ± días, en fecha local (sin pasar por UTC). */
function sumarDias(fecha: string, dias: number): string {
  const [y, m, d] = fecha.split('-').map(Number);
  return isoLocalDate(new Date(y, m - 1, d + dias));
}

/**
 * `[CAT-COSTO.10]` — **Costos · la matriz de un costo, día por día.**
 *
 * La hoja que pidió Compras (2026-10-15): un producto por renglón, una columna por almacén (00 CEDIS
 * a 08) con el costo que tenía ESE día, y la coincidencia contra la mayoría. Una instancia por tipo
 * de costo (estándar · promedio · último).
 *
 * La pantalla no decide nada: el costo vigente, la mayoría y lo que no se compara vienen del servidor
 * (`filaMatriz` sobre `analytics.mv_kepler_costos_cambios`). Un almacén que ese día todavía estaba
 * en Wincaja se dice «sin dato», nunca se pinta en cero.
 */
@Component({
  selector: 'app-compras-costos-matriz',
  standalone: true,
  imports: [
    CommonModule, FormsModule, TableModule, SelectModule, CheckboxModule, TagModule, TooltipModule, DatePickerModule,
    LoadStateComponent, MetricStripComponent, FreshnessPillComponent, ContextHelpComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cm">
      <div class="cm-cabeza">
        <div class="cm-dia" role="group" aria-label="Día que se está viendo">
          <button type="button" class="cm-flecha" (click)="moverDia(-1)" [disabled]="!puedeAtras()"
                  aria-label="Día anterior"><i class="pi pi-chevron-left" aria-hidden="true"></i></button>
          <p-datepicker [ngModel]="fechaComoFecha()" (ngModelChange)="onFecha($event)" dateFormat="dd/mm/yy"
                        [maxDate]="hoyComoFecha" [minDate]="minimaComoFecha()" appendTo="body"
                        ariaLabel="Día" inputStyleClass="cm-dp" />
          <button type="button" class="cm-flecha" (click)="moverDia(1)" [disabled]="!puedeAdelante()"
                  aria-label="Día siguiente"><i class="pi pi-chevron-right" aria-hidden="true"></i></button>
          @if (fecha() !== hoy) {
            <button type="button" class="cm-hoy" (click)="irAHoy()">Hoy</button>
          }
        </div>
        @if (datosDisponibles(); as d) {
          <p class="cm-titular" [title]="queEs()">
            {{ n(d.resumen.distinto) }} productos tienen un almacén con {{ nombreCosto().toLowerCase() }} distinto al de la mayoría
            el {{ fechaLarga(d.fecha) }}
          </p>
          <app-metric-strip [items]="kpis()" mode="strip" density="compact" [ariaLabel]="'Coincidencia de ' + nombreCosto()" />
        }
        <div class="cm-cabeza-der">
          @if (datos()?.disponible) {
            <app-freshness-pill measures="data" [since]="datos()?.calculado_al ?? null" [staleAfterSec]="unDia" label="costos" />
          }
          <app-context-help topic="costos-kepler" />
        </div>
      </div>

      <app-load-state [loading]="cargando() && !datos()" [error]="error()" [isEmpty]="noDisponible()"
                      emptyIcon="pi-clock" emptyTitle="La historia de costos todavía no se ha calculado"
                      emptyHint="Se calcula cada noche desde Kepler. Vuelve a entrar mañana." (retry)="recargar()">
        <section class="cm-barra" aria-label="Filtros">
        @if (datosDisponibles(); as d) {
          <div class="cm-chips" role="group" aria-label="Filtrar por resultado">
            @for (ch of chips; track ch.id) {
              <button type="button" [class]="'cm-chip cm-tono-' + ch.tono"
                      [class.is-sel]="veredicto() === ch.id" [attr.aria-pressed]="veredicto() === ch.id"
                      (click)="onVeredicto(ch.id)">
                <span>{{ ch.id === '' ? 'Todos' : etiqueta(ch.id) }}</span>
                <span class="cm-chip-n">{{ n(conteo(ch.id)) }}</span>
              </button>
            }
          </div>
        }

          <label class="cm-f">
            <span class="sr-only">Buscar producto</span>
            <input type="search" [value]="busqueda" (input)="onBuscar($any($event.target).value)"
                   placeholder="Buscar SKU o nombre" autocomplete="off" spellcheck="false" />
          </label>
          <label class="cm-f">
            <span class="sr-only">Proveedor</span>
            <p-select [options]="opcionesProveedor()" optionLabel="label" optionValue="value"
                      [ngModel]="proveedor()" (onChange)="onProveedor($event.value)"
                      [filter]="true" filterBy="label" [showClear]="true" placeholder="Todos los proveedores"
                      appendTo="body" ariaLabel="Proveedor" class="cm-sel" />
          </label>
          <label class="cm-f">
            <span class="sr-only">Almacén que se sale</span>
            <p-select [options]="opcionesSucursal()" optionLabel="label" optionValue="value"
                      [ngModel]="sucursal()" (onChange)="onSucursal($event.value)"
                      [showClear]="true" placeholder="Almacén que se sale" appendTo="body" ariaLabel="Almacén" class="cm-sel" />
          </label>
          <label class="cm-chk">
            <p-checkbox [binary]="true" [inputId]="'cm-venta-' + tipo()" [ngModel]="soloConVenta()" (ngModelChange)="onSoloConVenta($event)" />
            <span>Sólo almacenes con venta 30 d</span>
          </label>
        </section>

        <div class="cm-tabla">
          <p-table [value]="filas()" [loading]="cargando()" [lazy]="true" [paginator]="true"
                   [rows]="tamano()" [totalRecords]="total()" [first]="(pagina() - 1) * tamano()"
                   [rowsPerPageOptions]="[50, 100, 200]" (onLazyLoad)="onPagina($event)"
                   size="small" class="surf-table surf-table--plain surf-table--sticky surf-table--frozen-first dt-matrix-ok">
            <ng-template #header>
              <tr>
                <th scope="col">Producto</th>
                @for (s of sucursales(); track s.codigo) {
                  <th scope="col" class="comm-num" [class.cm-sin-hist]="sinDatoEse(s.desde)"
                      [pTooltip]="tipColumna(s)" tooltipPosition="top">{{ s.codigo }}</th>
                }
                <th scope="col" class="comm-num">Mayoría</th>
                <th scope="col" class="comm-num">Coincidencia</th>
                <th scope="col">Resultado</th>
              </tr>
            </ng-template>
            <ng-template #body let-f>
              <tr>
                <td>
                  <button type="button" class="cm-prod" (click)="skuElegido.emit(f.sku)"
                          [attr.aria-label]="'Ver historial de costos de ' + (f.nombre || f.sku)">{{ f.nombre || 'Sin nombre en catálogo' }}</button>
                  <div class="cm-meta"><span class="cm-mono">{{ f.sku }}</span> · {{ unidad(f) }} · {{ f.proveedor || 'sin proveedor' }}</div>
                </td>
                @for (s of sucursales(); track s.codigo) {
                  @if (f.porSucursal[s.codigo]; as c) {
                    <td class="comm-num cm-mono cm-celda" [class.is-fuera]="c.fuera" [class.is-deducido]="c.fuente === 'venta'"
                        [pTooltip]="tipCelda(c)" tooltipPosition="top">{{ dinero(c.costo) }}</td>
                  } @else if (sinDatoEse(s.desde)) {
                    <td class="comm-num cm-vacia" [pTooltip]="porQueSinDato(s.desde)">sin dato</td>
                  } @else {
                    <td class="comm-num cm-vacia" [pTooltip]="'Sin ' + nombreCosto().toLowerCase() + ' en este almacén ese día'">—</td>
                  }
                }
                <td class="comm-num cm-mono cm-fuerte">{{ f.mayoria === null ? '—' : dinero(f.mayoria) }}</td>
                <td class="comm-num cm-mono">{{ f.coincidencia_pct === null ? '—' : f.coincidencia_pct + ' %' }}</td>
                <td class="cm-res"><p-tag [value]="etiqueta(f.veredicto)" [severity]="severidad(f.veredicto)" /></td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td [attr.colspan]="sucursales().length + 4" class="cm-vacio">
                {{ cargando() ? 'Cargando…' : 'Ningún producto coincide con los filtros.' }}
              </td></tr>
            </ng-template>
          </p-table>
        </div>

        <footer class="cm-notas">
          <p>{{ nota() }}</p>
          <p>Celda en ámbar: ese almacén se sale de la mayoría. Celda en cursiva: estándar deducido de la venta (antes de que
            se empezara a guardar la foto de la ficha). «sin dato»: ese día no hay historia de ese costo en ese almacén
            (todavía estaba en Wincaja, o no vende); el motivo está al pasar el cursor. Dos costos se cuentan iguales si
            difieren menos de {{ datos()?.tolerancia_pct ?? 0.5 }} %. La venta de 30 días es la de hoy.</p>
        </footer>
      </app-load-state>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .cm { display: flex; flex-direction: column; gap: .625rem; container-type: inline-size; }
    .cm-cabeza { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; }
    .cm-cabeza .cm-titular { flex: 1 1 24rem; }
    .cm-cabeza-der { display: flex; align-items: center; gap: .5rem; }
    .cm-dia { display: inline-flex; align-items: center; gap: .35rem; }
    .cm-flecha, .cm-hoy { min-height: 2.25rem; min-width: 2.25rem; padding: 0 .6rem; border: 1px solid var(--c-divider);
      border-radius: 8px; background: var(--c-surface-1); color: var(--c-text-1); font: inherit; font-size: var(--fs-sm); cursor: pointer; }
    .cm-flecha:hover:not(:disabled), .cm-hoy:hover { background: var(--hover-bg); }
    .cm-flecha:disabled { opacity: .4; cursor: default; }
    .cm-flecha:focus-visible, .cm-hoy:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .cm-titular { margin: 0; font-size: var(--fs-body); font-weight: var(--fw-bold); color: var(--c-text-1); line-height: 1.3; }
    .cm-barra { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
    .cm-chips { display: flex; flex-wrap: wrap; gap: .375rem; margin-right: auto; }
    .cm-chip { display: inline-flex; align-items: center; gap: .5rem; min-height: 2rem; padding: 0 .625rem;
      border: 1px solid var(--c-divider); border-radius: 999px; background: var(--c-surface-1);
      color: var(--c-text-1); font: inherit; font-size: var(--fs-sm); cursor: pointer; }
    .cm-chip:hover { background: var(--hover-bg); }
    .cm-chip:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .cm-chip.is-sel { border-color: var(--action); background: var(--hover-bg); font-weight: var(--fw-bold); }
    .cm-chip-n { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--c-text-2); }
    .cm-tono-bad .cm-chip-n { color: var(--bad-fg); }
    .cm-tono-warn .cm-chip-n { color: var(--warn-fg); }
    .cm-tono-ok .cm-chip-n { color: var(--ok-fg); }
    .cm-f { display: flex; flex-direction: column; font-size: var(--fs-xs); color: var(--c-text-2); }
    .cm-f input { height: 2.25rem; width: 13rem; max-width: 100%; border: 1px solid var(--c-divider); border-radius: 8px;
      padding: 0 .6rem; font: inherit; font-size: var(--fs-sm); background: var(--c-surface-1); color: var(--c-text-1); }
    .cm-f input:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    .cm-sel { min-width: 12rem; }
    .cm-chk { display: inline-flex; align-items: center; gap: .5rem; min-height: 2.25rem; font-size: var(--fs-sm); color: var(--c-text-1); }
    .cm-tabla { background: var(--c-surface-1); border: 1px solid var(--c-divider); border-radius: 10px; overflow-x: auto; }
    .cm-tabla td:first-child, .cm-tabla th:first-child { min-width: 22rem; }
    .cm-mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .cm-fuerte { font-weight: var(--fw-bold); }
    .cm-prod { font-weight: var(--fw-bold); color: var(--c-text-1); background: none; border: none; padding: 0; font: inherit;
      text-align: left; cursor: pointer; text-decoration: underline; text-decoration-color: var(--c-divider); text-underline-offset: 3px; }
    .cm-prod:hover { text-decoration-color: var(--c-text-2); }
    .cm-prod:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .cm-meta { font-size: var(--fs-xs); color: var(--c-text-3); }
    .cm-celda.is-fuera { background: var(--warn-soft-bg); color: var(--c-text-1); font-weight: var(--fw-bold); }
    .cm-celda.is-deducido { font-style: italic; color: var(--c-text-2); }
    .cm-vacia { color: var(--c-text-3); background: var(--hover-bg); font-size: var(--fs-xs); white-space: nowrap; }
    .cm-res { white-space: nowrap; }
    .cm-sin-hist { color: var(--c-text-3); }
    .cm-vacio { text-align: center; padding: 1.5rem; color: var(--c-text-2); }
    .cm-notas { margin-top: 1rem; font-size: var(--fs-xs); color: var(--c-text-2); line-height: 1.5; }
    .cm-notas p { margin: 0 0 .35rem; max-width: 60rem; }
    @container (max-width: 48rem) {
      .cm-f input, .cm-sel { width: 100%; min-width: 0; }
      .cm-f { flex: 1 1 100%; }
      .cm-tabla td:first-child, .cm-tabla th:first-child { max-width: 9.5rem; min-width: 9.5rem; white-space: normal; }
      .cm-prod { font-size: var(--fs-xs); }
    }
  `],
})
export class ComprasCostosMatrizComponent {
  /** Qué costo pinta esta instancia. */
  readonly tipo = input.required<TipoCostoKepler>();
  /** Clic en un producto: el padre abre su historial. */
  readonly skuElegido = output<string>();

  readonly chips = CHIPS;
  readonly unDia = UN_DIA_Y_POCO;
  readonly hoy = isoLocalDate(new Date());
  readonly hoyComoFecha = new Date();
  private readonly api = inject(CostoEstandarService);

  readonly fecha = signal(this.hoy);
  readonly pagina = signal(1);
  readonly tamano = signal(100);
  busqueda = '';
  readonly q = signal('');
  readonly proveedor = signal<string | null>(null);
  readonly sucursal = signal<string | null>(null);
  readonly veredicto = signal<VeredictoMatrizCostos | ''>('');
  readonly soloConVenta = signal(false);

  private readonly res = rxResource({
    params: () => ({
      tipo: this.tipo(),
      fecha: this.fecha(),
      q: this.q() || undefined,
      proveedor_id: this.proveedor() || undefined,
      sucursal: this.sucursal() || undefined,
      veredicto: this.veredicto() || undefined,
      solo_con_venta: this.soloConVenta() || undefined,
      limite: this.tamano(),
      desplazamiento: (this.pagina() - 1) * this.tamano(),
    }),
    stream: ({ params }) => this.api.matriz(params),
  });

  /** `undefined` mientras carga y tras un error: nunca se pintan ceros que no se midieron. */
  readonly datos = computed(() => (this.res.error() ? undefined : this.res.value()));
  readonly cargando = computed(() => this.res.isLoading());
  readonly error = computed(() => (this.res.error() ? 'No se pudo cargar la matriz de costos.' : null));
  /** La respuesta sólo si la historia está calculada: el titular y los conteos no se pintan sobre la nada. */
  readonly datosDisponibles = computed(() => {
    const d = this.datos();
    return d?.disponible ? d : undefined;
  });
  readonly noDisponible = computed(() => {
    const d = this.datos();
    return !!d && !d.disponible;
  });
  readonly total = computed(() => this.datos()?.total ?? 0);
  readonly sucursales = computed(() => this.datos()?.sucursales ?? []);
  readonly filas = computed<FilaVista[]>(() =>
    (this.datos()?.filas ?? []).map((f) => ({ ...f, porSucursal: Object.fromEntries(f.celdas.map((c) => [c.sucursal, c])) })),
  );
  readonly opcionesProveedor = computed(() =>
    (this.datos()?.proveedores ?? []).map((p) => ({ label: `${p.nombre} (${p.productos})`, value: p.id })),
  );
  readonly opcionesSucursal = computed(() =>
    this.sucursales().map((s) => ({ label: s.nombre ? `${s.codigo} · ${s.nombre}` : s.codigo, value: s.codigo })),
  );
  readonly nombreCosto = computed(() => COSTOS_KEPLER[this.tipo()].nombre);
  readonly queEs = computed(() => COSTOS_KEPLER[this.tipo()].que_es);
  readonly fechaComoFecha = computed(() => {
    const [y, m, d] = this.fecha().split('-').map(Number);
    return new Date(y, m - 1, d);
  });
  readonly minimaComoFecha = computed(() => {
    const p = this.datos()?.primera_fecha;
    if (!p) return null;
    const [y, m, d] = p.split('-').map(Number);
    return new Date(y, m - 1, d);
  });
  readonly puedeAtras = computed(() => {
    const p = this.datos()?.primera_fecha;
    return !p || this.fecha() > p;
  });
  readonly puedeAdelante = computed(() => this.fecha() < this.hoy);

  /**
   * Los conteos por resultado ya van en los chips; la tira (compacta, en el renglón del titular) sólo lleva
   * lo que los chips no dicen: la proporción de iguales y los productos de un solo almacén.
   */
  readonly kpis = computed<MetricStripItem[]>(() => {
    const r = this.datos()?.resumen;
    if (!r) return [];
    const comparables = r.distinto + r.igual;
    return [
      { label: 'iguales', value: comparables ? Math.round((1000 * r.igual) / comparables) / 10 : 0, format: 'percent', tone: 'ok',
        sub: `${this.n(r.igual)} de ${this.n(comparables)}`,
        ...(comparables ? {} : { state: 'no_medido' as const, stateNote: 'no hay productos comparables con estos filtros' }) },
      { label: 'en un solo almacén', value: r.una_plaza, format: 'number', tone: 'muted', sub: 'sin con qué comparar' },
    ];
  });

  readonly nota = computed(() => {
    const t = this.tipo();
    if (t === 'estandar') return 'El costo estándar es el de la ficha del catálogo de Kepler; se guarda una foto cada noche. Los días anteriores a la primera foto se deducen de lo que congeló la venta, y los días sin venta conservan el último valor visto.';
    if (t === 'promedio') return 'El costo promedio es el que el kardex de Kepler le puso a las salidas de ese día. Es contra el que Kepler mide la utilidad. Naturalmente varía entre almacenes: cada uno promedia sus propias entradas.';
    return 'El último costo es el de la última compra (XA2001 Aplica Orden Entrada) que tenía ese almacén ese día. Los traspasos y los ajustes no lo mueven.';
  });

  readonly onPagina = makeLazyLoad(this.pagina, this.tamano, () => undefined);
  private readonly buscarDebounced = makeDebouncedSearch((v) => {
    this.q.set(v.trim());
    this.pagina.set(1);
  });

  recargar(): void { this.res.reload(); }
  moverDia(dias: number): void {
    const nueva = sumarDias(this.fecha(), dias);
    if (nueva > this.hoy) return;
    this.fecha.set(nueva);
    this.pagina.set(1);
  }
  irAHoy(): void {
    this.fecha.set(this.hoy);
    this.pagina.set(1);
  }
  onFecha(d: Date | null): void {
    if (!d) return;
    this.fecha.set(isoLocalDate(d));
    this.pagina.set(1);
  }
  onBuscar(v: string): void {
    this.busqueda = v;
    this.buscarDebounced(v);
  }
  onProveedor(v: string | null): void { this.proveedor.set(v); this.pagina.set(1); }
  onSucursal(v: string | null): void { this.sucursal.set(v); this.pagina.set(1); }
  onVeredicto(v: VeredictoMatrizCostos | ''): void { this.veredicto.set(v); this.pagina.set(1); }
  onSoloConVenta(v: boolean): void { this.soloConVenta.set(!!v); this.pagina.set(1); }

  /** «Todos» suma el universo entero; cada chip, su resultado. */
  conteo(id: VeredictoMatrizCostos | ''): number {
    const r = this.datos()?.resumen;
    if (!r) return 0;
    return id === '' ? Object.values(r).reduce((s, n) => s + n, 0) : r[id];
  }
  etiqueta(v: VeredictoMatrizCostos): string { return ETIQUETA_VEREDICTO_MATRIZ[v]; }
  severidad(v: VeredictoMatrizCostos): 'danger' | 'warn' | 'info' | 'success' | 'secondary' { return SEVERIDAD[v]; }

  /** El almacén todavía no tenía historia de este costo ese día (estaba en Wincaja). */
  sinDatoEse(desde: string | null): boolean {
    return !desde || desde > this.fecha();
  }
  tipColumna(s: { codigo: string; nombre: string | null; desde: string | null }): string {
    const nombre = s.nombre || s.codigo;
    if (!s.desde) return `${nombre}: ${this.porQueSinDato(null)}`;
    return this.sinDatoEse(s.desde) ? `${nombre}: con dato desde el ${this.fechaLarga(s.desde)}` : nombre;
  }
  /**
   * Por qué una columna no tiene dato. Son dos ausencias distintas y no se pintan igual:
   * el almacén no tiene NINGUNA historia de este costo, o su historia empieza después de ese día.
   */
  porQueSinDato(desde: string | null): string {
    if (desde) return `La historia de este costo en este almacén empieza el ${this.fechaLarga(desde)}`;
    if (this.tipo() === 'estandar') {
      return 'Sin historia del costo estándar: antes de la foto nocturna de la ficha se deduce de la venta, y este almacén no vende';
    }
    return 'Este almacén no tiene historia de este costo';
  }
  tipCelda(c: CeldaMatrizCostos): string {
    const partes = [`desde el ${this.fechaLarga(c.desde)}`];
    if (c.referencia) partes.push(c.referencia);
    if (c.fuente === 'venta') partes.push('deducido de la venta');
    if (c.desviacion_pct !== null && c.fuera) partes.push(`${c.desviacion_pct > 0 ? '+' : ''}${c.desviacion_pct} % contra la mayoría`);
    return partes.join(' · ');
  }
  unidad(f: FilaMatrizCostos): string {
    const us = [...new Set(f.celdas.map((c) => c.unidad || 'sin rótulo'))];
    return us.join(' / ');
  }

  fechaLarga(iso: string): string {
    const [y, m, d] = iso.split('-').map(Number);
    return new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(y, m - 1, d));
  }
  dinero(v: number | string): string {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v));
  }
  n(v: number): string {
    return new Intl.NumberFormat('es-MX').format(Number(v));
  }
}
