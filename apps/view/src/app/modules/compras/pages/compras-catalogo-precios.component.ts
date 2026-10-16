import { ChangeDetectionStrategy, Component, computed, effect, inject, linkedSignal, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { rxResource, toSignal } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { CheckboxModule } from 'primeng/checkbox';
import { DatePickerModule } from 'primeng/datepicker';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import type { FilaListaPrecios, OpcionClasificacion, OrdenListaPrecios, PrecioUnidad, RespuestaListaPrecios } from '@megadulces/contracts';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { isoLocalDate, makeDebouncedSearch, makeLazyLoad } from '../../../shared/util';
import { CATALOGO_TABS } from '../catalogo-tabs';
import { PreciosService } from '../precios.service';
import { NOMBRE_ORDEN, generarPdfPrecios } from '../precios-lista-pdf';
import { ComprasPreciosHistoriaComponent } from './compras-precios-historia.component';

/** El carril del ODS empuja la ficha cada ~10 s: media hora sin pasada ya es un espejo detenido. */
const ESPEJO_DETENIDO_SEG = 30 * 60;
const ORDENES: OrdenListaPrecios[] = ['articulo', 'linea', 'tipo', 'grupo'];

/**
 * `[CAT-PRECIO.2]`–`[CAT-PRECIO.4]` — **Compras › Catálogo › Precios.**
 *
 * El catálogo de precios de UNA sucursal, como la hoja de Compras (2026-10-16): por producto, el precio
 * de cada unidad (base, 2 y 3) y debajo el «cambio automático» (precio por volumen). Clic en un precio
 * abre su historia. «Sólo los que cambiaron» deja los que movieron precio un día, contra el anterior.
 *
 * La sucursal es obligatoria (mezclar plazas daría precios que no existen) y se recorta al alcance: quien
 * tiene una sola no ve selector. El margen se ve aquí para que el vendedor lo entienda; el PDF, que es
 * para el cliente, sale sin margen ni costo. La pantalla no calcula nada: todo viene del servidor.
 */
@Component({
  selector: 'app-compras-catalogo-precios',
  standalone: true,
  imports: [
    FormsModule, TableModule, SelectModule, CheckboxModule, DatePickerModule, ButtonModule, TooltipModule, ToastModule,
    PageTabsComponent, LoadStateComponent, MetricStripComponent, FreshnessPillComponent, SidePeekComponent,
    ContextHelpComponent, ComprasPreciosHistoriaComponent,
  ],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-toast />
    <div class="surf-page lp">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Precios</h1>
          <p class="surf-page-sub">El catálogo de precios de una sucursal, con su cambio automático. Da clic en un precio para ver cómo ha cambiado.</p>
        </div>
      </header>

      <app-page-tabs [tabs]="tabs" />

      <div class="lp-cabeza">
        @if (datos(); as d) {
          @if (d.sucursal_fija && d.sucursal) {
            <p class="lp-suc-fija"><i class="pi pi-shop" aria-hidden="true"></i> {{ d.sucursal.codigo }} · {{ d.sucursal.nombre }}</p>
          } @else {
            <label class="lp-f lp-suc">
              <span class="sr-only">Sucursal</span>
              <p-select [options]="opcionesSucursal()" optionLabel="label" optionValue="value" [ngModel]="sucursalElegida()"
                        (onChange)="onSucursal($event.value)" placeholder="Elige la sucursal" appendTo="body"
                        ariaLabel="Sucursal" class="lp-sel" />
            </label>
          }
          @if (d.sucursal) {
            <p class="lp-titular">
              {{ n(d.total) }} productos
              @if (soloCambios() && fechaCambios()) { cambiaron de precio el {{ fechaLarga(fechaCambios()!) }} }
            </p>
            @if (kpis().length) {
              <app-metric-strip [items]="kpis()" mode="strip" density="compact" ariaLabel="Lista de precios" />
            }
          }
        }
        <div class="lp-cabeza-der">
          @if (datos()?.sucursal) {
            <app-freshness-pill measures="data" [since]="datos()!.ficha_al" [staleAfterSec]="espejoDetenido" label="ficha de Kepler" />
          }
          <app-context-help topic="precios-catalogo" />
        </div>
      </div>

      <app-load-state [loading]="cargando() && !datos()" [error]="error()" [isEmpty]="sinSucursal()"
                      emptyIcon="pi-shop" emptyTitle="Elige una sucursal"
                      emptyHint="Los precios son por sucursal: mezclar plazas daría precios que no existen."
                      (retry)="recargar()">
        <section class="lp-barra" aria-label="Filtros">
          <label class="lp-f">
            <span class="sr-only">Buscar producto</span>
            <input type="search" [value]="busqueda" (input)="onBuscar($any($event.target).value)"
                   placeholder="SKU, nombre o código de barras" autocomplete="off" spellcheck="false" />
          </label>
          <label class="lp-f"><span class="sr-only">Línea</span>
            <p-select [options]="opciones(datos()?.lineas)" optionLabel="label" optionValue="value" [ngModel]="linea()"
                      (onChange)="onFiltro('linea', $event.value)" [filter]="true" filterBy="label" [showClear]="true"
                      placeholder="Línea" appendTo="body" ariaLabel="Línea" class="lp-sel" />
          </label>
          <label class="lp-f"><span class="sr-only">Tipo</span>
            <p-select [options]="opciones(datos()?.tipos)" optionLabel="label" optionValue="value" [ngModel]="tipo()"
                      (onChange)="onFiltro('tipo', $event.value)" [showClear]="true"
                      placeholder="Tipo" appendTo="body" ariaLabel="Tipo" class="lp-sel" />
          </label>
          <label class="lp-f"><span class="sr-only">Grupo</span>
            <p-select [options]="opciones(datos()?.grupos)" optionLabel="label" optionValue="value" [ngModel]="grupo()"
                      (onChange)="onFiltro('grupo', $event.value)" [filter]="true" filterBy="label" [showClear]="true"
                      placeholder="Grupo" appendTo="body" ariaLabel="Grupo" class="lp-sel" />
          </label>
          <label class="lp-f"><span class="sr-only">Ordenar por</span>
            <p-select [options]="opcionesOrden" optionLabel="label" optionValue="value" [ngModel]="orden()"
                      (onChange)="onOrden($event.value)" appendTo="body" ariaLabel="Ordenar por" class="lp-sel lp-sel-chica" />
          </label>
          <span class="lp-cambios">
            <label class="lp-chk" [pTooltip]="sinBitacora() ? 'Esta sucursal no tiene bitácora de precios: no hay cambios que mostrar' : ''" tooltipPosition="bottom">
              <p-checkbox [binary]="true" inputId="lp-cambios" [ngModel]="soloCambios()" (ngModelChange)="onSoloCambios($event)"
                          [disabled]="sinBitacora()" />
              <span>Sólo los que cambiaron</span>
            </label>
            @if (soloCambios() && !sinBitacora()) {
              <p-datepicker [ngModel]="fechaCambiosComoFecha()" (ngModelChange)="onFechaCambios($event)" dateFormat="dd/mm/yy"
                            [maxDate]="hoyComoFecha" appendTo="body" ariaLabel="Día de los cambios" inputStyleClass="lp-dp" />
            }
          </span>
          <button pButton type="button" size="small" [loading]="imprimiendo()" [disabled]="!total()" (click)="pdf()"
                  pTooltip="Lista para el cliente: sin margen ni costo" tooltipPosition="bottom">
            <span class="p-button-icon p-button-icon-left pi pi-file-pdf" aria-hidden="true"></span>
            <span class="p-button-label">PDF para cliente</span>
          </button>
        </section>

        @if (soloCambios() && datos(); as d) {
          @if (d.cambios_centavo_ocultos > 0) {
            <p class="lp-nota-chica">Se ocultaron {{ n(d.cambios_centavo_ocultos) }} cambios de un centavo (Kepler recalcula y no mueven la etiqueta).
              @if (d.bitacora_hasta) { La bitácora de esta sucursal llega hasta el {{ fechaLarga(d.bitacora_hasta) }}. }</p>
          }
        }

        <div class="lp-tabla">
          <p-table [value]="filas()" [loading]="cargando()" [lazy]="true" [paginator]="true"
                   [rows]="tamano()" [totalRecords]="total()" [first]="(pagina() - 1) * tamano()"
                   [rowsPerPageOptions]="[50, 100, 200]" (onLazyLoad)="onPagina($event)"
                   size="small" class="surf-table surf-table--plain surf-table--sticky">
            <ng-template #header>
              <tr>
                <th scope="col">Código</th>
                <th scope="col">Producto</th>
                <th scope="col" class="comm-num">Unidad base</th>
                <th scope="col" class="comm-num">Unidad 2</th>
                <th scope="col" class="comm-num">Unidad 3</th>
              </tr>
            </ng-template>
            <ng-template #body let-f>
              <tr class="lp-fila">
                <td class="lp-mono lp-sku">{{ f.sku }}</td>
                <td>
                  <div class="lp-nombre">{{ f.nombre }}</div>
                  <div class="lp-meta">{{ clasif(f) }}</div>
                  <div class="lp-meta">{{ impuesto(f) }}</div>
                </td>
                @for (n of [1, 2, 3]; track n) {
                  <td class="comm-num lp-u">
                    @if (unidad(f, n); as u) {
                      <button type="button" class="lp-precio" (click)="abrirHistoria(f, u)"
                              [attr.aria-label]="'Historia del precio de ' + f.nombre + ' por ' + u.unidad">
                        <span class="lp-unidad">{{ u.unidad }}</span>
                        <span class="lp-mono">{{ u.precio === null ? 'sin precio' : dinero(u.precio) }}</span>
                      </button>
                      @if (u.n > 1) {
                        <div class="lp-conv">{{ u.conversion ?? 'sin factor en la ficha' }}</div>
                      }
                      @if (u.cambio; as c) {
                        <div class="lp-cambio" [class.is-sube]="c.nuevo > c.anterior">
                          <i [class]="c.nuevo > c.anterior ? 'pi pi-arrow-up' : 'pi pi-arrow-down'" aria-hidden="true"></i>
                          {{ c.ajuste_pct === null ? 'antes sin precio' : pct(c.ajuste_pct) }} · antes {{ dinero(c.anterior) }}
                        </div>
                      }
                      @if (u.margen_pct !== null) {
                        <div class="lp-margen" pTooltip="Margen de Kepler: ganancia sobre el costo estándar, con el precio sin impuestos. No sale en el PDF." tooltipPosition="top">margen {{ pct1(u.margen_pct) }}</div>
                      }
                      @for (c of u.codigos; track c) { <div class="lp-cb lp-mono">{{ c }}</div> }
                    } @else {
                      <span class="lp-tenue">—</span>
                    }
                  </td>
                }
              </tr>
              <tr class="lp-auto">
                <td></td>
                <td class="lp-auto-k">Cambio automático</td>
                @for (n of [1, 2, 3]; track n) {
                  <td class="comm-num lp-mono">
                    @if (unidad(f, n); as u) {
                      @for (t of u.volumen; track $index) { <div>desde {{ t.desde }}: {{ dinero(t.precio) }}</div> }
                      @empty { <span class="lp-tenue">—</span> }
                    }
                  </td>
                }
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="5" class="lp-vacio">
                @if (cargando()) { Cargando… }
                @else if (soloCambios()) { Ningún precio cambió ese día con estos filtros. }
                @else { Ningún producto coincide con los filtros. }
              </td></tr>
            </ng-template>
          </p-table>
        </div>

        <footer class="lp-notas">
          <p>Precios de la ficha de Kepler de la sucursal, con impuestos incluidos salvo que se indique. «Cambio automático»
            es el precio estándar por volumen (nivel 0) de cada unidad. El margen es el de Kepler: ganancia sobre el costo
            estándar con el precio sin impuestos; puede no coincidir con el «%Margen» guardado en la ficha cuando ese campo
            quedó viejo (pasa en ~15 % de las fichas). El PDF es para el cliente y sale sin margen ni costo.</p>
        </footer>
      </app-load-state>

      <app-side-peek [open]="!!historia()" (openChange)="!$event && historia.set(null)"
                     [title]="historia()?.nombre ?? ''" [subtitle]="historia() ? historia()!.unidad + ' · ' + nombreSucursal() : null">
        @if (historia(); as h) {
          <app-compras-precios-historia [sku]="h.sku" [sucursal]="h.sucursal" [unidad]="h.unidad" />
        }
      </app-side-peek>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .lp { display: flex; flex-direction: column; gap: .75rem; container-type: inline-size; }
    .lp-cabeza { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; }
    .lp-titular { flex: 1 1 18rem; margin: 0; font-size: var(--fs-body); font-weight: var(--fw-bold); color: var(--c-text-1); }
    .lp-cabeza-der { display: flex; align-items: center; gap: .5rem; }
    .lp-suc-fija { display: inline-flex; align-items: center; gap: .4rem; margin: 0; font-weight: var(--fw-bold); }
    .lp-barra { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
    .lp-f { display: flex; flex-direction: column; font-size: var(--fs-xs); color: var(--c-text-2); }
    .lp-f input { height: 2.25rem; width: 15rem; max-width: 100%; border: 1px solid var(--c-divider); border-radius: 8px;
      padding: 0 .6rem; font: inherit; font-size: var(--fs-sm); background: var(--c-surface-1); color: var(--c-text-1); }
    .lp-f input:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    .lp-sel { min-width: 11rem; }
    .lp-sel-chica { min-width: 9rem; }
    .lp-suc .lp-sel { min-width: 15rem; }
    .lp-cambios { display: inline-flex; align-items: center; gap: .5rem; }
    .lp-chk { display: inline-flex; align-items: center; gap: .5rem; min-height: 2.25rem; font-size: var(--fs-sm); color: var(--c-text-1); }
    .lp-nota-chica { margin: 0; font-size: var(--fs-xs); color: var(--c-text-2); }
    .lp-tabla { background: var(--c-surface-1); border: 1px solid var(--c-divider); border-radius: 10px; overflow-x: auto; }
    .lp-mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .lp-sku { color: var(--c-text-2); white-space: nowrap; }
    .lp-nombre { font-weight: var(--fw-bold); color: var(--c-text-1); }
    .lp-meta { font-size: var(--fs-xs); color: var(--c-text-3); }
    .lp-fila > td { border-bottom: 0; }
    .lp-u { white-space: nowrap; }
    .lp-precio { display: inline-flex; align-items: baseline; gap: .4rem; background: none; border: 0; padding: .1rem .2rem;
      margin: -.1rem -.2rem; border-radius: 4px; color: var(--c-text-1); font: inherit; cursor: pointer;
      text-decoration: underline; text-decoration-color: var(--c-divider); text-underline-offset: 3px; }
    .lp-precio:hover { background: var(--hover-bg); text-decoration-color: var(--c-text-2); }
    .lp-precio:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .lp-precio .lp-mono { font-weight: var(--fw-bold); }
    .lp-unidad { font-size: var(--fs-xs); color: var(--c-text-2); }
    .lp-margen { font-size: var(--fs-xs); color: var(--c-text-3); }
    .lp-cb { font-size: var(--fs-xs); color: var(--c-text-3); }
    .lp-conv { font-size: var(--fs-xs); color: var(--c-text-2); }
    .lp-cambio { font-size: var(--fs-xs); font-weight: var(--fw-bold); color: var(--c-text-2); }
    .lp-cambio.is-sube { color: var(--c-text-1); }
    .lp-auto > td { font-size: var(--fs-xs); color: var(--c-text-2); padding-top: 0; }
    .lp-auto-k { font-style: italic; }
    .lp-tenue { color: var(--c-text-3); }
    .lp-vacio { text-align: center; padding: 1.5rem; color: var(--c-text-2); }
    .lp-notas { margin-top: 1rem; font-size: var(--fs-xs); color: var(--c-text-2); line-height: 1.5; }
    .lp-notas p { margin: 0; max-width: 64rem; }
    @container (max-width: 48rem) {
      .lp-f input, .lp-sel, .lp-suc .lp-sel { width: 100%; min-width: 0; }
      .lp-f { flex: 1 1 100%; }
    }
  `],
})
export class ComprasCatalogoPreciosComponent {
  readonly tabs = CATALOGO_TABS;
  readonly espejoDetenido = ESPEJO_DETENIDO_SEG;
  readonly hoyComoFecha = new Date();
  readonly opcionesOrden = ORDENES.map((o) => ({ label: `Por ${NOMBRE_ORDEN[o]}`, value: o }));
  private readonly api = inject(PreciosService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toast = inject(MessageService);

  private readonly query = toSignal(this.route.queryParamMap);
  /** La sucursal vive en la URL (`?suc=`): la lista se comparte y el botón Atrás funciona. */
  readonly sucursalElegida = computed(() => this.query()?.get('suc') || null);

  readonly pagina = signal(1);
  readonly tamano = signal(100);
  busqueda = '';
  readonly q = signal('');
  readonly linea = signal<string | null>(null);
  readonly tipo = signal<string | null>(null);
  readonly grupo = signal<string | null>(null);
  readonly orden = signal<OrdenListaPrecios>('articulo');
  readonly soloCambios = signal(false);
  readonly fechaCambios = signal<string | null>(null);
  readonly imprimiendo = signal(false);
  readonly historia = signal<{ sku: string; nombre: string; unidad: string; sucursal: string } | null>(null);

  private filtros() {
    return {
      sucursal: this.sucursalElegida() ?? undefined,
      q: this.q() || undefined,
      linea: this.linea() ?? undefined,
      tipo: this.tipo() ?? undefined,
      grupo: this.grupo() ?? undefined,
      cambio_fecha: this.soloCambios() ? (this.fechaCambios() ?? undefined) : undefined,
      orden: this.orden(),
    };
  }

  private readonly res = rxResource({
    params: () => ({ ...this.filtros(), limite: this.tamano(), desplazamiento: (this.pagina() - 1) * this.tamano() }),
    stream: ({ params }) => this.api.lista(params),
  });

  /**
   * El último dato bueno se conserva mientras se recarga: cambiar un filtro no puede desmontar la barra
   * de filtros (el buscador perdía el foco a media palabra). Mismo patrón que Productos nuevos. Antes
   * de la primera carga es `undefined`: nunca se pintan ceros que no se midieron.
   */
  readonly datos = linkedSignal<RespuestaListaPrecios | undefined, RespuestaListaPrecios | undefined>({
    source: () => (this.res.error() ? undefined : this.res.value()),
    computation: (nuevo, previo) => nuevo ?? previo?.value,
  });
  readonly cargando = computed(() => this.res.isLoading());
  readonly error = computed(() => {
    const e = this.res.error() as { status?: number } | undefined;
    if (!e) return null;
    return e.status === 403
      ? 'Esa sucursal no está en tu alcance. «Reintentar» te deja elegir una de las tuyas.'
      : 'No se pudo cargar la lista de precios.';
  });
  /** Varias sucursales y ninguna elegida: no hay lista que mostrar, y se pide elegir. */
  readonly sinSucursal = computed(() => {
    const d = this.datos();
    return !!d && !d.sucursal;
  });
  readonly total = computed(() => this.datos()?.total ?? 0);
  readonly filas = computed(() => this.datos()?.filas ?? []);
  readonly opcionesSucursal = computed(() =>
    (this.datos()?.sucursales ?? []).map((s) => ({ label: `${s.codigo} · ${s.nombre}`, value: s.codigo })),
  );
  readonly nombreSucursal = computed(() => {
    const s = this.datos()?.sucursal;
    return s ? `${s.codigo} · ${s.nombre}` : '';
  });
  readonly fechaCambiosComoFecha = computed(() => {
    const f = this.fechaCambios();
    if (!f) return null;
    const [y, m, d] = f.split('-').map(Number);
    return new Date(y, m - 1, d);
  });
  readonly kpis = computed<MetricStripItem[]>(() => {
    const r = this.datos()?.cambios_resumen;
    if (!r) return [];
    return [
      { label: 'precios suben', value: r.suben, format: 'number', tone: 'default' },
      { label: 'precios bajan', value: r.bajan, format: 'number', tone: 'default' },
    ];
  });

  /**
   * La sucursal no tiene bitácora: «sólo los que cambiaron» no puede filtrar nada, y prenderla sin fecha
   * listaba el catálogo completo como si fueran los cambios. Se deshabilita y se dice por qué.
   */
  readonly sinBitacora = computed(() => {
    const d = this.datos();
    return !!d?.sucursal && !d.bitacora_hasta;
  });

  /** Al prender «sólo los que cambiaron» sin fecha, se usa el último día que llegó la bitácora (no «hoy», que puede no haber llegado). */
  private readonly fechaPorDefecto = effect(() => {
    const d = this.datos();
    if (this.soloCambios() && !this.fechaCambios() && d?.bitacora_hasta) this.fechaCambios.set(d.bitacora_hasta);
  });

  readonly onPagina = makeLazyLoad(this.pagina, this.tamano, () => undefined);
  private readonly buscarDebounced = makeDebouncedSearch((v) => {
    this.q.set(v.trim());
    this.pagina.set(1);
  });

  /**
   * Con un 403 (un `?suc=` compartido que no está en tu alcance) reintentar lo mismo daría el mismo 403
   * y la pantalla no tendría salida: se suelta la sucursal y el servidor ofrece las tuyas.
   */
  recargar(): void {
    if ((this.res.error() as { status?: number } | undefined)?.status === 403) this.onSucursal(null);
    else this.res.reload();
  }
  onSucursal(v: string | null): void {
    this.linea.set(null); this.tipo.set(null); this.grupo.set(null); this.pagina.set(1);
    // La fecha de cambios es de la bitácora de ESA sucursal: no se arrastra a otra. Y la casilla se
    // apaga: prendida y sin fecha, la primera carga de la sucursal nueva listaría el catálogo completo.
    this.fechaCambios.set(null);
    this.soloCambios.set(false);
    this.router.navigate([], { relativeTo: this.route, queryParams: { suc: v || null }, queryParamsHandling: 'merge' });
  }
  onBuscar(v: string): void { this.busqueda = v; this.buscarDebounced(v); }
  onFiltro(campo: 'linea' | 'tipo' | 'grupo', v: string | null): void {
    this[campo].set(v);
    this.pagina.set(1);
  }
  onOrden(v: OrdenListaPrecios): void { this.orden.set(v); this.pagina.set(1); }
  onSoloCambios(v: boolean): void { this.soloCambios.set(!!v); this.pagina.set(1); }
  onFechaCambios(d: Date | null): void {
    if (!d) return;
    this.fechaCambios.set(isoLocalDate(d));
    this.pagina.set(1);
  }

  abrirHistoria(f: FilaListaPrecios, u: PrecioUnidad): void {
    const s = this.datos()?.sucursal;
    if (s) this.historia.set({ sku: f.sku, nombre: f.nombre, unidad: u.unidad, sucursal: s.codigo });
  }

  /** El PDF lleva TODA la lista filtrada (no sólo la página), en el orden elegido. */
  async pdf(): Promise<void> {
    const s = this.datos()?.sucursal;
    if (!s) return;
    this.imprimiendo.set(true);
    try {
      const r = await firstValueFrom(this.api.lista({ ...this.filtros(), todo: true }));
      const d = this.datos();
      const nombre = (lista: OpcionClasificacion[] | undefined, v: string | null) =>
        lista?.find((o) => (o.codigo || '_') === v)?.nombre ?? v;
      const filtros = [
        this.linea() && `Línea: ${nombre(d?.lineas, this.linea())}`,
        this.tipo() && `Tipo: ${nombre(d?.tipos, this.tipo())}`,
        this.grupo() && `Grupo: ${nombre(d?.grupos, this.grupo())}`,
        this.q() && `Búsqueda: ${this.q()}`,
        this.soloCambios() && this.fechaCambios() && `Cambiaron el ${this.fechaLarga(this.fechaCambios()!)}`,
      ].filter((x): x is string => !!x);
      await generarPdfPrecios({
        sucursal: s, filas: r.filas, orden: this.orden(), filtros,
        fichaAl: r.ficha_al ? new Date(r.ficha_al) : null,
      });
    } catch {
      this.toast.add({ severity: 'error', summary: 'No se pudo generar el PDF', detail: 'Vuelve a intentarlo; si sigue, avisa a Sistemas.' });
    } finally {
      this.imprimiendo.set(false);
    }
  }

  /** Las opciones de un filtro de clasificación. `_` = «sin asignar»: el código vacío no viaja por la URL. */
  opciones(lista: OpcionClasificacion[] | undefined): { label: string; value: string }[] {
    return (lista ?? []).map((o) => ({ label: `${o.nombre} (${this.n(o.productos)})`, value: o.codigo || '_' }));
  }
  unidad(f: FilaListaPrecios, n: number): PrecioUnidad | undefined { return f.unidades.find((u) => u.n === n); }
  clasif(f: FilaListaPrecios): string {
    return [f.linea.nombre ?? 'Sin línea', f.tipo.nombre ?? 'Sin tipo', f.grupo.nombre ?? 'Sin grupo'].join(' · ');
  }
  impuesto(f: FilaListaPrecios): string {
    const t = (n: string, v: number) => (v === 0 ? '' : `${n} ${Math.abs(v)} %${v < 0 ? ' incl.' : ''}`);
    return [t('IVA', f.iva), t('IEPS', f.ieps)].filter(Boolean).join(' · ') || 'Sin impuestos';
  }
  dinero(v: number): string {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 }).format(Number(v));
  }
  pct(v: number): string { return `${v > 0 ? '+' : ''}${new Intl.NumberFormat('es-MX', { maximumFractionDigits: 1 }).format(v)} %`; }
  pct1(v: number): string { return `${new Intl.NumberFormat('es-MX', { maximumFractionDigits: 1 }).format(v)} %`; }
  fechaLarga(iso: string): string {
    const [y, m, d] = iso.split('-').map(Number);
    return new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(y, m - 1, d));
  }
  n(v: number): string { return new Intl.NumberFormat('es-MX').format(Number(v)); }
}
