import { ChangeDetectionStrategy, Component, computed, inject, linkedSignal, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { rxResource } from '@angular/core/rxjs-interop';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { CheckboxModule } from 'primeng/checkbox';
import type { CampoEnCero, FilaEnCeros, RespuestaEnCeros } from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { makeDebouncedSearch, makeLazyLoad } from '../../../shared/util';
import { PreciosService } from '../precios.service';
import { dondeEnCero, etiquetasEnCero } from './en-ceros';

const NOMBRE: Record<CampoEnCero, string> = { precio: 'Precio en $0', costo: 'Costo en $0 o vacío' };
const CAMPOS: CampoEnCero[] = ['precio', 'costo'];
/** El carril del ODS empuja la ficha cada ~10 s: media hora sin pasada ya es un espejo detenido. */
const ESPEJO_DETENIDO_SEG = 30 * 60;

/**
 * `[CAT-PRECIO.6]` — **Mantenimiento · Costo o precio en cero.** (Edgar, 2026-11-20: «productos que tengan 0 en su
 * costo o precio».)
 *
 * Cada unidad EN USO de la ficha de Kepler (la base siempre; la caja y la tercera sólo con factor) con su costo o su
 * precio de venta en cero, en las sucursales que venden al público. Un precio en $0 se vende regalado; un costo en $0
 * o vacío rompe el margen y el costo de lo vendido. Se corrige en Kepler.
 *
 * Orden: primero lo que VENDE con precio en $0, luego por venta de 30 días. ⛔ No se ve ningún costo con valor: el
 * permiso del catálogo lo tiene también el cliente B2B; sólo se dice QUÉ está en cero y dónde.
 */
@Component({
  selector: 'app-compras-mantenimiento-en-ceros',
  standalone: true,
  imports: [
    FormsModule, TableModule, SelectModule, TagModule, CheckboxModule,
    LoadStateComponent, MetricStripComponent, FreshnessPillComponent, ContextHelpComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ec">
      <div class="ec-cabeza">
        @if (datos(); as d) {
          <p class="ec-titular">{{ n(d.con_cero) }} productos tienen costo o precio en cero en alguna sucursal</p>
          @if (kpis().length) {
            <app-metric-strip [items]="kpis()" mode="strip" density="compact" ariaLabel="Costo o precio en cero" />
          }
        }
        <div class="ec-cabeza-der">
          @if (datos(); as d) {
            <app-freshness-pill measures="data" [since]="d.ficha_al" [staleAfterSec]="espejoDetenido" label="ficha de Kepler" />
          }
          <app-context-help topic="precios-sucursales" />
        </div>
      </div>

      <app-load-state [loading]="cargando() && !datos()" [error]="error()" [isEmpty]="nadaEnCero()"
                      emptyIcon="pi-check-circle" emptyTitle="Ningún producto tiene costo ni precio en cero"
                      [emptyHint]="q() || conVenta() || linea() ? 'Con estos filtros no queda ninguno.' : null"
                      (retry)="recargar()">
        <section class="ec-barra" aria-label="Filtros">
          @if (datos(); as d) {
            <div class="ec-chips" role="group" aria-label="Qué está en cero">
              <button type="button" class="ec-chip" [class.is-sel]="falta() === null" [attr.aria-pressed]="falta() === null" (click)="onFalta(null)">
                <span>Todos</span><span class="ec-chip-n">{{ n(d.con_cero) }}</span>
              </button>
              @for (c of campos; track c) {
                <button type="button" class="ec-chip" [class.is-sel]="falta() === c" [attr.aria-pressed]="falta() === c" (click)="onFalta(c)">
                  <span>{{ nombre(c) }}</span><span class="ec-chip-n">{{ n(d.resumen[c]) }}</span>
                </button>
              }
            </div>
          }
          <label class="ec-f">
            <span class="sr-only">Buscar producto</span>
            <input type="search" [value]="busqueda" (input)="onBuscar($any($event.target).value)"
                   placeholder="SKU, nombre o código de barras" autocomplete="off" spellcheck="false" />
          </label>
          <label class="ec-f">
            <span class="sr-only">Línea</span>
            <p-select [options]="opcionesLinea()" optionLabel="label" optionValue="value" [ngModel]="linea()"
                      (onChange)="onLinea($event.value)" [filter]="true" filterBy="label" [showClear]="true"
                      placeholder="Todas las líneas" appendTo="body" ariaLabel="Línea" class="ec-sel" />
          </label>
          <label class="ec-chk">
            <p-checkbox [binary]="true" inputId="ec-venta" [ngModel]="conVenta()" (ngModelChange)="onConVenta($event)" />
            <span>Sólo con venta en 30 días</span>
          </label>
        </section>

        <div class="ec-tabla dt-scope">
          <p-table [value]="filas()" [loading]="cargando()" [lazy]="true" [paginator]="true"
                   [rows]="tamano()" [totalRecords]="total()" [first]="(pagina() - 1) * tamano()"
                   [rowsPerPageOptions]="[50, 100, 200]" (onLazyLoad)="onPagina($event)"
                   size="small" class="surf-table surf-table--plain surf-table--sticky surf-table--frozen-first dt-stack">
            <ng-template #header>
              <tr>
                <th scope="col">Producto</th>
                <th scope="col">En cero</th>
                <th scope="col">Dónde</th>
                <th scope="col" class="comm-num">Venta 30 d</th>
              </tr>
            </ng-template>
            <ng-template #body let-f>
              <tr>
                <td role="cell" data-label="Producto">
                  <div class="ec-prod">
                    <span class="ec-nombre">{{ f.nombre }}</span>
                    <span class="ec-meta"><span class="ec-mono">{{ f.sku }}</span> · {{ f.linea.nombre || 'Sin línea' }}</span>
                  </div>
                </td>
                <td role="cell" data-label="En cero">
                  <span class="ec-tags">
                    @for (t of etiquetas(f); track t.texto) { <p-tag [value]="t.texto" [severity]="t.grave ? 'danger' : 'warn'" /> }
                  </span>
                </td>
                <td role="cell" data-label="Dónde">
                  <ul class="ec-donde">
                    @for (l of donde(f); track l) { <li>{{ l }}</li> }
                  </ul>
                </td>
                <td class="comm-num" role="cell" data-label="Venta 30 d"><span class="ec-mono">{{ f.venta_30d > 0 ? dinero(f.venta_30d) : '—' }}</span></td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="4" class="ec-vacio">{{ cargando() ? 'Cargando…' : 'Ningún producto coincide con los filtros.' }}</td></tr>
            </ng-template>
          </p-table>
        </div>

        <footer class="ec-notas">
          <p>Se revisa cada unidad en uso de la ficha: la base siempre; la segunda y la tercera sólo si tienen factor (una
            unidad rotulada sin factor trae costo y precio en cero y no es un error). «Costo vacío» es el campo en blanco
            en la ficha, que Kepler muestra en cero. Sólo cuentan las sucursales que venden al público. Se corrige en Kepler.</p>
        </footer>
      </app-load-state>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .ec { display: flex; flex-direction: column; gap: .625rem; container-type: inline-size; }
    .ec-cabeza { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; }
    .ec-titular { flex: 1 1 24rem; margin: 0; font-size: var(--fs-body); font-weight: var(--fw-bold); color: var(--c-text-1); line-height: 1.3; }
    .ec-cabeza-der { display: flex; align-items: center; gap: .5rem; }
    .ec-barra { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
    .ec-chips { display: flex; flex-wrap: wrap; gap: .375rem; margin-right: auto; }
    .ec-chip { display: inline-flex; align-items: center; gap: .5rem; min-height: 2rem; padding: 0 .625rem;
      border: 1px solid var(--c-divider); border-radius: 999px; background: var(--c-surface-1);
      color: var(--c-text-1); font: inherit; font-size: var(--fs-sm); cursor: pointer; }
    .ec-chip:hover { background: var(--hover-bg); }
    .ec-chip:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .ec-chip.is-sel { border-color: var(--action); background: var(--hover-bg); font-weight: var(--fw-bold); }
    .ec-chip-n { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--warn-fg); }
    .ec-f { display: flex; flex-direction: column; font-size: var(--fs-xs); color: var(--c-text-2); }
    .ec-f input { height: 2.25rem; width: 16rem; max-width: 100%; border: 1px solid var(--c-divider); border-radius: 8px;
      padding: 0 .6rem; font: inherit; font-size: var(--fs-sm); background: var(--c-surface-1); color: var(--c-text-1); }
    .ec-f input:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    .ec-sel { min-width: 14rem; }
    .ec-chk { display: inline-flex; align-items: center; gap: .5rem; min-height: 2.25rem; font-size: var(--fs-sm); color: var(--c-text-1); }
    .ec-tabla { background: var(--c-surface-1); border: 1px solid var(--c-divider); border-radius: 10px; overflow-x: auto; }
    .ec-prod { display: flex; flex-direction: column; min-width: 0; }
    .ec-nombre { font-weight: var(--fw-bold); color: var(--c-text-1); }
    .ec-meta { font-size: var(--fs-xs); color: var(--c-text-3); }
    .ec-mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .ec-tags { display: inline-flex; flex-wrap: wrap; gap: .25rem; }
    .ec-donde { margin: 0; padding: 0; list-style: none; font-size: var(--fs-sm); color: var(--c-text-2); }
    .ec-vacio { text-align: center; padding: 1.5rem; color: var(--c-text-2); }
    .ec-notas { margin-top: 1rem; font-size: var(--fs-xs); color: var(--c-text-2); line-height: 1.5; }
    .ec-notas p { margin: 0; max-width: 60rem; }
    /* Apilado: las reglas viejas de p-datatable con !important (styles.css, pantalla chica) fijan la última
       celda y esconden de la cuarta en adelante. Mismo arreglo que Sin clasificar (deuda CAT-PRECIO.1.1). */
    @container densetable (max-width: 34rem) {
      .ec-tabla.dt-scope td[data-label] { display: flex !important; position: static !important;
        box-shadow: none !important; min-width: 0 !important; }
      .ec-tabla.dt-scope td[data-label]::before { font-family: var(--font-body); }
      .ec-prod, .ec-donde { text-align: right; }
    }
    @container (max-width: 48rem) {
      .ec-f input, .ec-sel { width: 100%; min-width: 0; }
      .ec-f { flex: 1 1 100%; }
    }
  `],
})
export class ComprasMantenimientoEnCerosComponent {
  readonly campos = CAMPOS;
  readonly espejoDetenido = ESPEJO_DETENIDO_SEG;
  private readonly api = inject(PreciosService);

  readonly pagina = signal(1);
  readonly tamano = signal(100);
  busqueda = '';
  readonly q = signal('');
  readonly falta = signal<CampoEnCero | null>(null);
  readonly linea = signal<string | null>(null);
  readonly conVenta = signal(false);

  private readonly res = rxResource({
    params: () => ({
      q: this.q() || undefined,
      falta: this.falta() ?? undefined,
      linea: this.linea() ?? undefined,
      con_venta: this.conVenta() || undefined,
      limite: this.tamano(),
      desplazamiento: (this.pagina() - 1) * this.tamano(),
    }),
    stream: ({ params }) => this.api.enCeros(params),
  });

  /** El último dato bueno se conserva mientras se recarga (el buscador no pierde el foco); antes de la primera carga es `undefined`. */
  readonly datos = linkedSignal<RespuestaEnCeros | undefined, RespuestaEnCeros | undefined>({
    source: () => (this.res.error() ? undefined : this.res.value()),
    computation: (nuevo, previo) => nuevo ?? previo?.value,
  });
  readonly cargando = computed(() => this.res.isLoading());
  readonly error = computed(() => (this.res.error() ? 'No se pudieron cargar los productos con costo o precio en cero.' : null));
  readonly nadaEnCero = computed(() => {
    const d = this.datos();
    return !!d && d.con_cero === 0;
  });
  readonly total = computed(() => this.datos()?.total ?? 0);
  readonly filas = computed(() => this.datos()?.filas ?? []);
  readonly opcionesLinea = computed(() =>
    // `_` = «sin línea»: el código vacío no viaja por la URL.
    (this.datos()?.lineas ?? []).map((l) => ({ label: `${l.nombre} (${this.n(l.productos)})`, value: l.codigo || '_' })),
  );
  readonly kpis = computed<MetricStripItem[]>(() => {
    const d = this.datos();
    if (!d) return [];
    return [
      { label: 'con precio en $0', value: d.resumen.precio, format: 'number', tone: 'bad' },
      { label: 'con costo en $0 o vacío', value: d.resumen.costo, format: 'number', tone: 'warn' },
    ];
  });

  readonly onPagina = makeLazyLoad(this.pagina, this.tamano, () => undefined);
  private readonly buscarDebounced = makeDebouncedSearch((v) => {
    this.q.set(v.trim());
    this.pagina.set(1);
  });

  recargar(): void { this.res.reload(); }
  onBuscar(v: string): void { this.busqueda = v; this.buscarDebounced(v); }
  onFalta(c: CampoEnCero | null): void { this.falta.set(c); this.pagina.set(1); }
  onLinea(v: string | null): void { this.linea.set(v); this.pagina.set(1); }
  onConVenta(v: boolean): void { this.conVenta.set(!!v); this.pagina.set(1); }

  nombre(c: CampoEnCero): string { return NOMBRE[c]; }
  etiquetas(f: FilaEnCeros) { return etiquetasEnCero(f); }
  donde(f: FilaEnCeros): string[] { return dondeEnCero(f); }
  dinero(v: number): string {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(Number(v));
  }
  n(v: number): string { return new Intl.NumberFormat('es-MX').format(Number(v)); }
}
