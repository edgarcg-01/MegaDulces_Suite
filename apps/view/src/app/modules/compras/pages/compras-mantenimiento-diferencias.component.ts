import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, effect, inject, linkedSignal, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { rxResource } from '@angular/core/rxjs-interop';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { ButtonModule } from 'primeng/button';
import {
  CAMPOS_FICHA,
  type CampoFicha,
  type DiferenciaCampoFicha,
  type FilaFichaSucursales,
  type RespuestaFichaSucursales,
} from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { makeDebouncedSearch, makeLazyLoad } from '../../../shared/util';
import { CatalogoLatidoService } from '../catalogo-latido.service';
import { PreciosService } from '../precios.service';

const NOMBRE_CAMPO = Object.fromEntries(CAMPOS_FICHA.map((c) => [c.campo, c.nombre])) as Record<CampoFicha, string>;
const QUE_ES_CAMPO = Object.fromEntries(CAMPOS_FICHA.map((c) => [c.campo, c.que_es])) as Record<CampoFicha, string>;

/** El carril del ODS empuja la ficha cada ~10 s: media hora sin pasada ya es un espejo detenido. */
const ESPEJO_DETENIDO_SEG = 30 * 60;

/**
 * `[CAT-PRECIO.1]` — **Mantenimiento · Diferencias entre sucursales.**
 *
 * La ficha de venta de Kepler, campo por campo (precios por unidad, volumen, unidades, IVA/IEPS,
 * línea/tipo/grupo, descripción y códigos), con la sucursal que se sale. Reemplaza a «Precios
 * distintos» (`[CAT.3]`), que sólo miraba pieza y mayoreo y se quedaba en 300 filas sin decirlo.
 *
 * La pantalla no decide nada: la mayoría, quién se sale y quién cambió al último vienen del servidor
 * (`compararFicha`). La referencia es la mayoría y es PROVISIONAL —lo que manda es el Concentrador,
 * que no llega a la Suite—, y la pantalla lo dice siempre.
 *
 * Hereda de `[CAT.7]`/`[CAT.8]` el latido: avisa cuando alguien corrige en Kepler, pero no recarga
 * sola, para no cambiarle el renglón a quien lo está leyendo.
 */
@Component({
  selector: 'app-compras-mantenimiento-diferencias',
  standalone: true,
  imports: [
    CommonModule, FormsModule, TableModule, SelectModule, TagModule, TooltipModule, ButtonModule,
    LoadStateComponent, MetricStripComponent, FreshnessPillComponent, SidePeekComponent, ContextHelpComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pd">
      <div class="pd-cabeza">
        @if (datos(); as d) {
          <p class="pd-titular">
            {{ n(d.con_diferencias) }} productos no tienen la misma ficha en todas las sucursales
            @if (!q()) { <span class="pd-titular-sub">de {{ n(d.productos_comparados) }} que se venden en más de una</span> }
          </p>
          @if (kpis().length) {
            <app-metric-strip [items]="kpis()" mode="strip" density="compact" ariaLabel="Coincidencia de la ficha" />
          }
        }
        <div class="pd-cabeza-der">
          <span class="pd-vivo" [class.is-off]="!enVivo()"
                [pTooltip]="enVivo() ? 'Te avisa aquí cuando alguien corrija una ficha en Kepler' : 'El aviso de cambios no responde: recarga para ver si cambió algo'"
                tooltipPosition="bottom">
            <span class="pd-punto" aria-hidden="true"></span>{{ enVivo() ? 'Vigilando Kepler' : 'Sin aviso de cambios' }}
          </span>
          @if (datos(); as d) {
            <app-freshness-pill measures="data" [since]="d.ficha_al" [staleAfterSec]="espejoDetenido" label="ficha de Kepler" />
          }
          <app-context-help topic="precios-sucursales" />
        </div>
      </div>

      <div class="pd-aviso" role="note">
        <i class="pi pi-info-circle" aria-hidden="true"></i>
        <p>
          <strong>Referencia provisional: la mayoría de las sucursales.</strong>
          Lo que manda es el Sistema Concentrador, que todavía no llega a la Suite. La mayoría puede ser la que
          se quedó con el valor viejo: revisa qué sucursal cambió al último antes de corregir.
        </p>
      </div>

      @if (hayCambios()) {
        <div class="pd-nuevo" role="status" aria-live="polite">
          <i class="pi pi-bell" aria-hidden="true"></i>
          <p>
            <strong>Cambiaron fichas en Kepler.</strong>
            @if (horaCambio()) { El último cambio entró a las {{ horaCambio() }}. }
            Lo que ves es de antes.
          </p>
          <button pButton type="button" size="small" [loading]="cargando()" (click)="recargar()">
            <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span>
            <span class="p-button-label">Cargar los nuevos</span>
          </button>
        </div>
      }

      <app-load-state [loading]="cargando() && !datos()" [error]="error()" [isEmpty]="sinDiferencias()"
                      emptyIcon="pi-check-circle" emptyTitle="Todas las fichas coinciden entre sucursales"
                      [emptyHint]="q() ? 'Con esta búsqueda no hay ningún producto con diferencias.' : null"
                      (retry)="recargar()">
        <section class="pd-barra" aria-label="Filtros">
          @if (datos(); as d) {
            <div class="pd-chips" role="group" aria-label="Filtrar por campo">
              <button type="button" class="pd-chip" [class.is-sel]="campo() === null" [attr.aria-pressed]="campo() === null"
                      (click)="onCampo(null)">
                <span>Todos</span><span class="pd-chip-n">{{ n(d.con_diferencias) }}</span>
              </button>
              @for (c of campos; track c.campo) {
                @if (d.resumen[c.campo] > 0 || campo() === c.campo) {
                  <button type="button" class="pd-chip" [class.is-sel]="campo() === c.campo"
                          [attr.aria-pressed]="campo() === c.campo" [pTooltip]="c.que_es" tooltipPosition="top"
                          (click)="onCampo(c.campo)">
                    <span>{{ c.nombre }}</span><span class="pd-chip-n">{{ n(d.resumen[c.campo]) }}</span>
                  </button>
                }
              }
            </div>
          }
          <label class="pd-f">
            <span class="sr-only">Buscar producto</span>
            <input type="search" [value]="busqueda" (input)="onBuscar($any($event.target).value)"
                   placeholder="SKU, nombre o código de barras" autocomplete="off" spellcheck="false" />
          </label>
          <label class="pd-f">
            <span class="sr-only">Sucursal que se sale</span>
            <p-select [options]="opcionesSucursal()" optionLabel="label" optionValue="value"
                      [ngModel]="sucursal()" (onChange)="onSucursal($event.value)"
                      [showClear]="true" placeholder="Sucursal que se sale" appendTo="body"
                      ariaLabel="Sucursal que se sale" class="pd-sel" />
          </label>
        </section>

        <div class="pd-tabla dt-scope">
          <p-table [value]="filas()" [loading]="cargando()" [lazy]="true" [paginator]="true"
                   [rows]="tamano()" [totalRecords]="total()" [first]="(pagina() - 1) * tamano()"
                   [rowsPerPageOptions]="[50, 100, 200]" (onLazyLoad)="onPagina($event)"
                   size="small" class="surf-table surf-table--plain surf-table--sticky surf-table--frozen-first dt-stack">
            <ng-template #header>
              <tr>
                <th scope="col">Producto</th>
                <th scope="col">Qué no coincide</th>
                <th scope="col">Se sale</th>
                <th scope="col">Cambió al último</th>
                <th scope="col" class="comm-num">Venta 30 d</th>
              </tr>
            </ng-template>
            <ng-template #body let-f>
              <tr>
                <td role="cell" data-label="Producto">
                  <div class="pd-prod-celda">
                    <button type="button" class="pd-prod" (click)="abrir(f)"
                            [attr.aria-label]="'Ver la ficha de ' + f.nombre + ' en cada sucursal'">{{ f.nombre }}</button>
                    <div class="pd-meta"><span class="pd-mono">{{ f.sku }}</span> · en {{ f.plazas }} sucursales</div>
                  </div>
                </td>
                <td role="cell" data-label="Qué no coincide">
                  <div class="pd-tags">
                    @for (c of f.campos; track c.campo) {
                      <p-tag [value]="etiquetaCampo(c)" [severity]="c.veredicto === 'distinto' ? 'warn' : 'secondary'"
                             [pTooltip]="tipCampo(c)" tooltipPosition="top" />
                    }
                  </div>
                </td>
                <td class="pd-nowrap" role="cell" data-label="Se sale">
                  <span>
                    @for (s of seSalen(f); track s) {
                      <span class="pd-suc" [pTooltip]="nombreSucursal(s)" tooltipPosition="top">{{ s }}</span>
                    } @empty {
                      <span class="pd-tenue" pTooltip="Empate: no hay mayoría contra la cual medir" tooltipPosition="top">empate</span>
                    }
                  </span>
                </td>
                <td class="pd-nowrap" role="cell" data-label="Cambió al último">
                  <span>
                    @if (f.cambio_mas_reciente; as c) {
                      <span class="pd-suc" [pTooltip]="nombreSucursal(c.sucursal)" tooltipPosition="top">{{ c.sucursal }}</span>
                      <span class="pd-tenue">{{ fechaCorta(c.fecha) }}</span>
                    } @else {
                      <span class="pd-tenue" pTooltip="Sin cambios en la bitácora, o varias sucursales cambiaron el mismo día" tooltipPosition="top">—</span>
                    }
                  </span>
                </td>
                <td class="comm-num" role="cell" data-label="Venta 30 d"><span class="pd-mono">{{ dinero(f.venta_30d) }}</span></td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="5" class="pd-vacio">{{ cargando() ? 'Cargando…' : 'Ningún producto coincide con los filtros.' }}</td></tr>
            </ng-template>
          </p-table>
        </div>

        <footer class="pd-notas">
          <p>Se comparan las sucursales que venden al público; el CEDIS no pone precio a nadie y no entra. Los precios
            se comparan al centavo y con impuestos incluidos. El precio por volumen es el estándar (nivel 0).
            «Cambió al último» sale de la bitácora de precios de Kepler, que trae historia desde octubre de 2024.</p>
          <p>Ordenado por venta de los últimos 30 días en la red: primero lo que más se vende.</p>
        </footer>
      </app-load-state>

      <app-side-peek [open]="!!elegida()" (openChange)="!$event && elegida.set(null)"
                     [title]="elegida()?.nombre ?? ''" [subtitle]="elegida() ? 'SKU ' + elegida()!.sku : null">
        @if (elegida(); as f) {
          <div class="pk">
            <p class="pk-ultimo">
              @if (f.cambio_mas_reciente; as c) {
                <i class="pi pi-history" aria-hidden="true"></i>
                <span><strong>{{ nombreSucursal(c.sucursal) }}</strong> fue la última en cambiar un precio: {{ fechaLarga(c.fecha) }}.</span>
              } @else {
                <i class="pi pi-history" aria-hidden="true"></i>
                <span>Ninguna sucursal cambió el precio después que las demás.</span>
              }
            </p>

            @for (c of f.campos; track c.campo) {
              <section class="pk-campo" [attr.aria-label]="nombreCampo(c.campo)">
                <header class="pk-campo-cab">
                  <h3>{{ nombreCampo(c.campo) }}</h3>
                  <p-tag [value]="c.veredicto === 'distinto' ? 'Fuera de la mayoría' : 'Sin mayoría'"
                         [severity]="c.veredicto === 'distinto' ? 'warn' : 'secondary'" />
                </header>
                <p class="pk-mayoria">
                  @if (c.mayoria !== null) { Mayoría: <strong>{{ c.mayoria }}</strong> }
                  @else { Empate entre sucursales: confirma en el Concentrador cuál es el bueno. }
                  @if (c.diferencia_pct !== null) { <span class="pd-tenue">· brecha {{ c.diferencia_pct }} %</span> }
                </p>
                <ul class="pk-lista">
                  @for (v of c.valores; track v.sucursal) {
                    <li [class.is-fuera]="v.fuera">
                      <span class="pk-suc">{{ nombreSucursal(v.sucursal) }}</span>
                      <span class="pk-val">
                        @for (p of piezas(v.texto, v.fuera ? c.mayoria : null); track $index) {
                          <span class="pk-pieza" [class.is-distinta]="p.distinta">{{ p.texto }}</span>
                        }
                      </span>
                      @if (v.fuera) { <span class="pk-marca"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> se sale</span> }
                    </li>
                  }
                </ul>
              </section>
            }

            <section class="pk-campo" aria-label="Último cambio de precio por sucursal">
              <header class="pk-campo-cab"><h3>Último cambio de precio por sucursal</h3></header>
              <ul class="pk-lista">
                @for (c of f.cambios; track c.sucursal) {
                  <li>
                    <span class="pk-suc">{{ nombreSucursal(c.sucursal) }}</span>
                    <span class="pk-val">{{ c.fecha ? fechaLarga(c.fecha) : 'sin registro en la bitácora' }}</span>
                  </li>
                }
              </ul>
            </section>
          </div>
        }
      </app-side-peek>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .pd { display: flex; flex-direction: column; gap: .625rem; container-type: inline-size; }
    .pd-cabeza { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; }
    .pd-titular { flex: 1 1 24rem; margin: 0; font-size: var(--fs-body); font-weight: var(--fw-bold); color: var(--c-text-1); line-height: 1.3; }
    .pd-titular-sub { font-weight: var(--fw-regular, 400); color: var(--c-text-2); }
    .pd-cabeza-der { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
    .pd-vivo { display: inline-flex; align-items: center; gap: .4rem; font-size: var(--fs-xs); color: var(--c-text-2); }
    .pd-punto { width: .45rem; height: .45rem; border-radius: 50%; background: var(--ok-fg); flex: none; }
    .pd-vivo.is-off .pd-punto { background: var(--c-text-3); }
    .pd-aviso, .pd-nuevo { display: flex; align-items: flex-start; gap: .6rem; padding: .55rem .75rem;
      border: 1px solid var(--c-divider); border-radius: 8px; font-size: var(--fs-xs); color: var(--c-text-2); }
    .pd-aviso { border-left: 3px solid var(--warn-fg); background: var(--warn-soft-bg); }
    .pd-nuevo { align-items: center; border-color: var(--action); border-left-width: 3px; background: var(--c-surface-1); }
    .pd-aviso p, .pd-nuevo p { margin: 0; flex: 1; min-width: 0; line-height: 1.45; }
    .pd-aviso strong, .pd-nuevo strong { color: var(--c-text-1); }
    .pd-aviso i { margin-top: .15rem; }
    .pd-nuevo i { color: var(--action); }
    .pd-barra { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
    .pd-chips { display: flex; flex-wrap: wrap; gap: .375rem; margin-right: auto; }
    .pd-chip { display: inline-flex; align-items: center; gap: .5rem; min-height: 2rem; padding: 0 .625rem;
      border: 1px solid var(--c-divider); border-radius: 999px; background: var(--c-surface-1);
      color: var(--c-text-1); font: inherit; font-size: var(--fs-sm); cursor: pointer; }
    .pd-chip:hover { background: var(--hover-bg); }
    .pd-chip:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .pd-chip.is-sel { border-color: var(--action); background: var(--hover-bg); font-weight: var(--fw-bold); }
    .pd-chip-n { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--warn-fg); }
    .pd-f { display: flex; flex-direction: column; font-size: var(--fs-xs); color: var(--c-text-2); }
    .pd-f input { height: 2.25rem; width: 15rem; max-width: 100%; border: 1px solid var(--c-divider); border-radius: 8px;
      padding: 0 .6rem; font: inherit; font-size: var(--fs-sm); background: var(--c-surface-1); color: var(--c-text-1); }
    .pd-f input:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    .pd-sel { min-width: 13rem; }
    .pd-tabla { background: var(--c-surface-1); border: 1px solid var(--c-divider); border-radius: 10px; overflow-x: auto; }
    .pd-tabla td:first-child, .pd-tabla th:first-child { min-width: 20rem; }
    .pd-mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .pd-prod { font-weight: var(--fw-bold); color: var(--c-text-1); background: none; border: none; padding: 0; font: inherit;
      text-align: left; cursor: pointer; text-decoration: underline; text-decoration-color: var(--c-divider); text-underline-offset: 3px; }
    .pd-prod:hover { text-decoration-color: var(--c-text-2); }
    .pd-prod:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .pd-meta { font-size: var(--fs-xs); color: var(--c-text-3); }
    .pd-tags { display: flex; flex-wrap: wrap; gap: .25rem; }
    .pd-nowrap { white-space: nowrap; }
    .pd-suc { display: inline-block; margin-right: .3rem; font-family: var(--font-mono); font-size: var(--fs-xs);
      font-weight: var(--fw-bold); color: var(--c-text-1); }
    .pd-tenue { font-size: var(--fs-xs); color: var(--c-text-3); }
    .pd-vacio { text-align: center; padding: 1.5rem; color: var(--c-text-2); }
    .pd-notas { margin-top: 1rem; font-size: var(--fs-xs); color: var(--c-text-2); line-height: 1.5; }
    .pd-notas p { margin: 0 0 .35rem; max-width: 60rem; }

    .pk { display: flex; flex-direction: column; gap: 1rem; }
    .pk-ultimo { display: flex; gap: .5rem; align-items: flex-start; margin: 0; font-size: var(--fs-sm); color: var(--c-text-1); }
    .pk-ultimo i { margin-top: .2rem; color: var(--c-text-2); }
    .pk-campo { border: 1px solid var(--c-divider); border-radius: 8px; padding: .6rem .75rem; }
    .pk-campo-cab { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
    .pk-campo-cab h3 { margin: 0; font-size: var(--fs-sm); font-weight: var(--fw-bold); color: var(--c-text-1); }
    .pk-mayoria { margin: .35rem 0 .5rem; font-size: var(--fs-xs); color: var(--c-text-2); }
    .pk-mayoria strong { color: var(--c-text-1); }
    .pk-lista { list-style: none; margin: 0; padding: 0; }
    .pk-lista li { display: grid; grid-template-columns: 9rem 1fr auto; gap: .5rem; align-items: baseline;
      padding: .3rem .4rem; border-top: 1px solid var(--c-divider); font-size: var(--fs-xs); }
    .pk-lista li:first-child { border-top: 0; }
    .pk-lista li.is-fuera { background: var(--warn-soft-bg); }
    .pk-suc { color: var(--c-text-2); }
    .pk-val { display: flex; flex-direction: column; color: var(--c-text-1); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
    .pk-pieza.is-distinta { font-weight: var(--fw-bold); text-decoration: underline; text-decoration-color: var(--warn-fg);
      text-decoration-thickness: 2px; text-underline-offset: 3px; }
    .pk-marca { color: var(--warn-fg); font-weight: var(--fw-bold); white-space: nowrap; }

    /* Apilado (dt-stack, menos de 34rem de contenedor). Las reglas viejas de styles.css para
       p-datatable en pantalla chica llevan !important: fijan la última celda a la derecha como
       table-cell y, por debajo de 30rem de ventana, esconden de la cuarta celda en adelante. Aquí
       eso dejaría «Venta 30 d» pegada a su rótulo y escondería «Cambió al último». Se neutralizan
       sólo en esta tabla y sólo apilada; el arreglo de fondo va en el CSS compartido (deuda con
       nombre en CAT-PRECIO.1: afecta también a «Contra último costo»). */
    @container densetable (max-width: 34rem) {
      .pd-tabla.dt-scope td[data-label] { display: flex !important; position: static !important;
        box-shadow: none !important; min-width: 0 !important; }
      .pd-tabla.dt-scope td[data-label]::before { font-family: var(--font-body); }
      .pd-prod-celda { min-width: 0; text-align: right; }
      .pd-prod { text-align: right; }
    }
    @container (max-width: 48rem) {
      .pd-f input, .pd-sel { width: 100%; min-width: 0; }
      .pd-f { flex: 1 1 100%; }
      .pd-tabla td:first-child, .pd-tabla th:first-child { min-width: 0; }
    }
  `],
})
export class ComprasMantenimientoDiferenciasComponent implements OnInit, OnDestroy {
  readonly campos = CAMPOS_FICHA;
  readonly espejoDetenido = ESPEJO_DETENIDO_SEG;
  private readonly api = inject(PreciosService);
  private readonly latido = inject(CatalogoLatidoService);

  readonly pagina = signal(1);
  readonly tamano = signal(100);
  busqueda = '';
  readonly q = signal('');
  readonly campo = signal<CampoFicha | null>(null);
  readonly sucursal = signal<string | null>(null);
  readonly elegida = signal<FilaFichaSucursales | null>(null);

  private readonly res = rxResource({
    params: () => ({
      q: this.q() || undefined,
      campo: this.campo() ?? undefined,
      sucursal: this.sucursal() ?? undefined,
      limite: this.tamano(),
      desplazamiento: (this.pagina() - 1) * this.tamano(),
    }),
    stream: ({ params }) => this.api.diferencias(params),
  });

  /**
   * El último dato bueno se conserva mientras se recarga: cambiar un filtro no puede desmontar la barra
   * de filtros (el buscador perdía el foco). Antes de la primera carga es `undefined`: nunca se pintan
   * ceros que no se midieron.
   */
  readonly datos = linkedSignal<RespuestaFichaSucursales | undefined, RespuestaFichaSucursales | undefined>({
    source: () => (this.res.error() ? undefined : this.res.value()),
    computation: (nuevo, previo) => nuevo ?? previo?.value,
  });
  readonly cargando = computed(() => this.res.isLoading());
  readonly error = computed(() => (this.res.error() ? 'No se pudieron comparar las fichas entre sucursales.' : null));
  readonly sinDiferencias = computed(() => {
    const d = this.datos();
    return !!d && d.con_diferencias === 0;
  });
  readonly total = computed(() => this.datos()?.total ?? 0);
  readonly filas = computed(() => this.datos()?.filas ?? []);
  private readonly nombres = computed(() => new Map((this.datos()?.sucursales ?? []).map((s) => [s.codigo, s.nombre])));
  readonly opcionesSucursal = computed(() =>
    (this.datos()?.sucursales ?? []).map((s) => ({ label: `${s.codigo} · ${s.nombre}`, value: s.codigo })),
  );

  /** La proporción de fichas iguales sólo tiene denominador sin búsqueda: con búsqueda se omite, no se inventa. */
  readonly kpis = computed<MetricStripItem[]>(() => {
    const d = this.datos();
    if (!d || this.q() || !d.productos_comparados) return [];
    const iguales = d.productos_comparados - d.con_diferencias;
    return [
      { label: 'fichas iguales', value: Math.round((1000 * iguales) / d.productos_comparados) / 10, format: 'percent', tone: 'ok',
        sub: `${this.n(iguales)} de ${this.n(d.productos_comparados)}` },
    ];
  });

  readonly enVivo = this.latido.enVivo;
  /** `[CAT.8]` La versión del catálogo que corresponde a lo que la tabla muestra ahora. */
  private readonly versionVista = signal(0);
  readonly hayCambios = computed(() => this.latido.version() > this.versionVista());
  readonly horaCambio = computed(() => {
    const t = this.latido.ultimoCambio();
    return t ? t.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) : null;
  });

  /** Cada carga terminada sella la versión: lo que se ve corresponde a este latido y el aviso se apaga. */
  private readonly sellar = effect(() => {
    if (this.res.value() !== undefined && !this.res.isLoading()) this.versionVista.set(this.latido.version());
  });

  readonly onPagina = makeLazyLoad(this.pagina, this.tamano, () => undefined);
  private readonly buscarDebounced = makeDebouncedSearch((v) => {
    this.q.set(v.trim());
    this.pagina.set(1);
  });

  ngOnInit(): void { this.latido.escuchar(); }
  ngOnDestroy(): void { this.latido.dejarDeEscuchar(); }

  recargar(): void { this.res.reload(); }
  onBuscar(v: string): void {
    this.busqueda = v;
    this.buscarDebounced(v);
  }
  onCampo(c: CampoFicha | null): void { this.campo.set(c); this.pagina.set(1); }
  onSucursal(v: string | null): void { this.sucursal.set(v); this.pagina.set(1); }
  abrir(f: FilaFichaSucursales): void { this.elegida.set(f); }

  nombreCampo(c: CampoFicha): string { return NOMBRE_CAMPO[c]; }
  nombreSucursal(codigo: string): string {
    const n = this.nombres().get(codigo);
    return n ? `${codigo} · ${n}` : codigo;
  }
  etiquetaCampo(c: DiferenciaCampoFicha): string {
    return c.veredicto === 'distinto' ? NOMBRE_CAMPO[c.campo] : `${NOMBRE_CAMPO[c.campo]} (empate)`;
  }
  tipCampo(c: DiferenciaCampoFicha): string {
    if (c.veredicto === 'sin_mayoria') return `${QUE_ES_CAMPO[c.campo]} Hay empate entre sucursales.`;
    const quien = c.sucursales_fuera.map((s) => this.nombreSucursal(s)).join(', ');
    return `Mayoría: ${c.mayoria}. Se sale: ${quien}.`;
  }
  /**
   * Un valor compuesto (volumen, unidades, códigos) viene en tramos separados por « · ». Cada tramo va
   * en su renglón, y en la sucursal que se sale se marca SÓLO el tramo que la mayoría no tiene: si no,
   * la diferencia de un precio de caja se pierde entre tres tramos iguales. La marca es subrayado y
   * negrita, no sólo color (Alto Contraste).
   */
  piezas(texto: string, mayoria: string | null): { texto: string; distinta: boolean }[] {
    const deLaMayoria = mayoria === null ? null : new Set(mayoria.split(' · '));
    return texto.split(' · ').map((t) => ({ texto: t, distinta: deLaMayoria !== null && !deLaMayoria.has(t) }));
  }

  /** Las sucursales que se salen en algún campo, sin repetir. */
  seSalen(f: FilaFichaSucursales): string[] {
    return [...new Set(f.campos.flatMap((c) => c.sucursales_fuera))].sort();
  }

  fechaCorta(iso: string): string {
    const [y, m, d] = iso.split('-').map(Number);
    return new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', year: '2-digit' }).format(new Date(y, m - 1, d));
  }
  fechaLarga(iso: string): string {
    const [y, m, d] = iso.split('-').map(Number);
    return new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(y, m - 1, d));
  }
  dinero(v: number | string): string {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(Number(v));
  }
  n(v: number): string {
    return new Intl.NumberFormat('es-MX').format(Number(v));
  }
}
