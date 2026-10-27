import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { rxResource } from '@angular/core/rxjs-interop';
import { TableModule } from 'primeng/table';
import { makeDebouncedSearch, makeLazyLoad } from '../../../shared/util';
import { AuthService } from '../../../core/services/auth.service';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import {
  CatalogoLista, CatalogoListaDetallada, CatalogoProductosService, ConteosCatalogo, DireccionOrden, FilaCatalogoDetallada,
  FilaCatalogoProducto, FiltroDetallado, MostrarCatalogo, OrdenDetallado, UnidadPrecio,
} from '../catalogo-productos.service';
import { CatalogoMenuComponent } from './catalogo-menu.component';
import { ProductoFichaComponent, dineroFicha } from './producto-ficha.component';
import { ProductoFichaDetalladaComponent } from './producto-ficha-detallada.component';
import { nombrePropio, nombreProveedor } from '../catalogo-proveedor';
import {
  EtiquetasProducto, GRUPOS_DETALLADO, GrupoDetallado, celdaMes, conteoDetallado, etiquetaFiltro, noMedibleDetallado,
} from '../catalogo-detallado';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';

/** Lo que se abre en el panel lateral. */
interface AbiertoFicha {
  id: string;
  nombre: string | null;
  sku: string | null;
  /** El proveedor, para el subtítulo. */
  proveedor?: string | null;
  /** Qué ficha se pinta adentro: la de Sencillo o la de Detallado. */
  tipo: 'ficha' | 'detallado';
  /** Detallado: las etiquetas del renglón (la ficha muestra las mismas). */
  etiquetas?: EtiquetasProducto;
}

/** Las dos vistas de Productos. Sencillo es la de default; Detallado suma venta del mes, etiquetas y qué hacer. */
export type VistaCatalogo = 'sencillo' | 'detallado';

/** La última vista que eligió ESTA persona (comodidad de este navegador; sin almacenamiento, Sencillo). */
export const claveVista = (usuario: string | null | undefined) => 'compras.catalogo.vista:' + (usuario || 'anon');
export function leerVista(usuario: string | null | undefined): VistaCatalogo {
  try { return localStorage.getItem(claveVista(usuario)) === 'detallado' ? 'detallado' : 'sencillo'; } catch { return 'sencillo'; }
}
function guardarVista(usuario: string | null | undefined, v: VistaCatalogo): void {
  try { localStorage.setItem(claveVista(usuario), v); } catch { /* sin almacenamiento: no pasa nada */ }
}

/** «Mostrar» de la vista Sencillo, con la clave de su conteo. */
export const OPCIONES_MOSTRAR: ReadonlyArray<{ id: MostrarCatalogo; label: string; conteo: keyof ConteosCatalogo }> = [
  { id: 'todos', label: 'Todos', conteo: 'todos' },
  { id: 'varios_codigos', label: 'Con varios códigos', conteo: 'variosCodigos' },
  { id: 'sin_codigo', label: 'Sin código de barras', conteo: 'sinCodigo' },
  { id: 'sin_precio', label: 'Alguna unidad sin precio', conteo: 'sinPrecio' },
];

/** «20 PAQ» o «base»: a qué equivale una unidad. */
export function equivaleTexto(u: Pick<UnidadPrecio, 'equivale'>): string {
  return u.equivale ? `${u.equivale.cantidad} ${u.equivale.unidad}` : 'base';
}

/** El orden de una columna de Detallado al hacer clic: la misma columna se invierte; otra empieza en su natural. */
export function siguienteOrden(actual: { col: OrdenDetallado; dir: DireccionOrden }, col: OrdenDetallado): { col: OrdenDetallado; dir: DireccionOrden } {
  if (actual.col === col) return { col, dir: actual.dir === 'asc' ? 'desc' : 'asc' };
  return { col, dir: col === 'producto' ? 'asc' : 'desc' };
}

/** El tamaño de página de las dos vistas (lo pagina el servidor). */
const PAGINA_SENCILLO = 50;

@Component({
  selector: 'app-compras-catalogo',
  standalone: true,
  imports: [
    CommonModule,
    ToastModule,
    TableModule,
    LoadStateComponent,
    FreshnessPillComponent,
    CatalogoMenuComponent,
    SidePeekComponent,
    ProductoFichaComponent,
    ProductoFichaDetalladaComponent,
  ],
  providers: [MessageService],
  template: `
    <div class="surf-page cp">
      <p-toast></p-toast>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Catálogo de productos</h1>
        </div>
        <div class="cp-head-actions">
          <button type="button" class="cp-vista-btn" [attr.aria-pressed]="detallado()" (click)="alternarVista()">
            <i class="pi pi-bars" aria-hidden="true"></i>
            <span>{{ detallado() ? 'Sencillo' : 'Detallado' }}</span>
          </button>
        </div>
      </header>

      <!-- Un solo menu para elegir el apartado del catalogo; a su lado, el filtro Mostrar de cada vista. -->
      <div class="cp-controles">
        <app-catalogo-menu />
        @if (!detallado()) {
          <div class="cs-mostrar" #mostrarCaja>
            <button #mostrarBtn type="button" class="cs-sel" aria-haspopup="menu" [attr.aria-expanded]="mostrarAbierto()" aria-controls="cs-mostrar-menu"
                    (click)="alternarMostrar()" (keydown.arrowdown)="$event.preventDefault(); abrirMostrar()">
              <span class="cs-sel-eti">Mostrar</span>
              <b>{{ opcionMostrar().label }}</b>
              @if (conteoTexto(opcionMostrar().id); as n) { <span class="cs-n">{{ n }}</span> }
              <i class="pi pi-chevron-down" aria-hidden="true"></i>
            </button>
            @if (mostrarAbierto()) {
              <div id="cs-mostrar-menu" class="cs-menu" role="menu" aria-label="Mostrar" #mostrarMenu (keydown)="tecladoMostrar($event)">
                @for (o of opcionesMostrar; track o.id) {
                  <button type="button" role="menuitemradio" class="cs-op" [class.is-on]="mostrar() === o.id"
                          [attr.aria-checked]="mostrar() === o.id" [attr.aria-disabled]="noMedible(o.id) ? 'true' : null"
                          [title]="noMedible(o.id) ? 'No se puede medir: esta base no tiene el precio por sucursal' : ''"
                          (click)="elegirMostrar(o.id)">
                    <span>{{ o.label }}</span>
                    <span class="cs-n">{{ conteoTexto(o.id) }}</span>
                  </button>
                }
              </div>
            }
          </div>
          <app-freshness-pill class="cs-fresco" measures="fetch" [since]="lista()?.calculado_al ?? null" />
        } @else {
          <!-- Detallado: Mostrar agrupado (que hacer, para cuidar hoy, catalogo), con conteos de la busqueda entera. -->
          <div class="cs-mostrar" #mostrarCaja>
            <button #mostrarBtn type="button" class="cs-sel" aria-haspopup="menu" [attr.aria-expanded]="mostrarAbierto()" aria-controls="cs-mostrar-menu"
                    (click)="alternarMostrar()" (keydown.arrowdown)="$event.preventDefault(); abrirMostrar()">
              <span class="cs-sel-eti">Mostrar</span>
              <b>{{ etiquetaD(mostrarAplicado()) }}</b>
              @if (conteoD(mostrarAplicado()); as n) { <span class="cs-n">{{ n }}</span> }
              <i class="pi pi-chevron-down" aria-hidden="true"></i>
            </button>
            @if (mostrarAbierto()) {
              <div id="cs-mostrar-menu" class="cs-menu cd-menu" role="menu" aria-label="Mostrar" #mostrarMenu (keydown)="tecladoMostrar($event)">
                @for (g of gruposDetallado; track g.titulo) {
                  <div class="cd-grupo" role="group" [attr.aria-label]="g.titulo">
                    <p class="cd-grupo-t" aria-hidden="true">{{ g.titulo }}</p>
                    @if (notaGrupo(g); as ng) { <p class="cd-nota">{{ ng }}</p> }
                    @for (o of g.opciones; track o.id) {
                      <button type="button" role="menuitemradio" class="cs-op" [class.is-on]="mostrarAplicado() === o.id"
                              [attr.aria-checked]="mostrarAplicado() === o.id" [attr.aria-disabled]="noMedibleD(o.id) ? 'true' : null"
                              (click)="elegirMostrarD(o.id)">
                        <span class="cd-op-t">{{ o.label }}
                          @if (notaOpcion(g, o.id); as no) { <small class="cd-nota">{{ no }}</small> }
                        </span>
                        <span class="cs-n">{{ conteoD(o.id) }}</span>
                      </button>
                    }
                  </div>
                }
              </div>
            }
          </div>
          <app-freshness-pill class="cs-fresco" measures="fetch" [since]="listaD()?.venta?.calculado_al ?? listaD()?.calculado_al ?? null" />
        }
      </div>

      <!-- Un solo buscador para Sencillo y Detallado: lo escrito se conserva al cambiar de vista. -->
      <div class="cp-buscar">
        <i class="pi pi-search" aria-hidden="true"></i>
        <input type="search" [value]="busqueda" (input)="onBusqueda($any($event.target).value)"
          placeholder="Busca por nombre, SKU, cualquier código de barras, proveedor o unidad (caja, kilo…)"
          inputmode="search" autocomplete="off" spellcheck="false" aria-label="Buscar producto" />
        @if (busqueda) {
          <button type="button" class="cp-x" (click)="limpiarBusqueda()" aria-label="Limpiar búsqueda"><i class="pi pi-times" aria-hidden="true"></i></button>
        }
      </div>

      <!-- Las celdas Unidades y Precio: UNA definicion para Sencillo y Detallado. -->
      <ng-template #celdaUnidades let-f>
        <span class="cs-pila">
          @for (u of f.unidades; track u.unidad) {
            <span class="cs-lin">
              <span class="cs-chip">{{ u.unidad }}</span>
              <small class="cs-eq">{{ equivale(u) }}</small>
              <!-- En celular el precio va pegado a su unidad (la columna Precio se oculta). -->
              <span class="cs-m-precio">
                @if (u.precio !== null) { {{ precio(u.precio) }} } @else { <span class="cs-sin">Sin precio</span> }
              </span>
            </span>
          } @empty {
            <span class="cs-sin">Sin unidades registradas</span>
          }
        </span>
      </ng-template>
      <ng-template #celdaPrecio let-f>
        <span class="cs-pila">
          @for (u of f.unidades; track u.unidad) {
            <span class="cs-lin">
              @if (u.precio !== null) { <span class="cs-precio">{{ precio(u.precio) }}</span> } @else { <span class="cs-sin">Sin precio</span> }
            </span>
          }
        </span>
      </ng-template>

      <!-- Productos, vista Sencillo: nombre, proveedor, unidades y su precio. Pagina el servidor. -->
      @if (!detallado()) {
        <section class="cs" aria-label="Productos">
          <app-load-state [loading]="listaCargando()" [error]="listaError()" [isEmpty]="listaVacia()" [skeletonRows]="10"
                          errorTitle="No se pudo cargar el catálogo" emptyIcon="pi-search"
                          [emptyTitle]="vacioTitulo()" [emptyHint]="vacioPista()" (retry)="refresh()">
            <p-table [value]="filasSencillo()" [lazy]="true" [paginator]="totalSencillo() > tamanoSencillo()" [rows]="tamanoSencillo()"
                     [totalRecords]="totalSencillo()" [first]="(pagina() - 1) * tamanoSencillo()" (onLazyLoad)="onPagina($event)"
                     [loading]="listaRes.isLoading()" [showCurrentPageReport]="true" currentPageReportTemplate="{first}–{last} de {totalRecords}"
                     dataKey="id" class="surf-table surf-table--plain surf-table--sticky" styleClass="cs-tabla" [tableStyle]="{ width: '100%' }">
              <ng-template #header>
                <tr class="cs-cab">
                  <th scope="col">Producto</th>
                  <th scope="col">Proveedor</th>
                  <th scope="col">Unidades de medida</th>
                  <th scope="col" class="comm-num">Precio</th>
                </tr>
              </ng-template>
              <ng-template #body let-f>
                <tr class="cs-fila" tabindex="0" [class.is-sel]="abierto()?.id === f.id" [attr.aria-label]="'Ver ficha de ' + nombreFila(f)"
                    (click)="abrirFicha(f)" (keydown)="teclaFila($event, f)">
                  <td class="cs-prod">
                    <div class="cs-nom">{{ nombreFila(f) }}</div>
                    @if (f.sku) { <div class="cs-sku">{{ f.sku }}</div> }
                    @if (f.razon) { <div class="cs-razon">Coincide por {{ f.razon }}</div> }
                  </td>
                  <td class="cs-prov">
                    @if (f.proveedor) { {{ provNombre(f.proveedor.nombre) }} } @else { <span class="cs-sin">Sin proveedor</span> }
                  </td>
                  <td class="cs-ud"><ng-container *ngTemplateOutlet="celdaUnidades; context: { $implicit: f }" /></td>
                  <td class="cs-pre comm-num"><ng-container *ngTemplateOutlet="celdaPrecio; context: { $implicit: f }" /></td>
                </tr>
              </ng-template>
            </p-table>
          </app-load-state>
        </section>
      }

      <!-- Productos, vista Detallado: lo de Sencillo + Este mes y etiquetas. Filtra, cuenta, ordena y pagina el servidor. -->
      @if (detallado()) {
        <section class="cs cd" aria-label="Productos">
          @if (avisoEtiquetas(); as av) { <p class="cd-aviso" role="status">{{ av }}</p> }
          <app-load-state [loading]="listaDCargando()" [error]="listaDError()" [isEmpty]="listaDVacia()" [skeletonRows]="10"
                          errorTitle="No se pudo cargar el catálogo" emptyIcon="pi-search"
                          [emptyTitle]="vacioTituloD()" [emptyHint]="vacioPistaD()" (retry)="refresh()">
            <p-table [value]="filasDetallado()" [lazy]="true" [paginator]="totalDetallado() > tamanoDetallado()" [rows]="tamanoDetallado()"
                     [totalRecords]="totalDetallado()" [first]="(paginaD() - 1) * tamanoDetallado()" (onLazyLoad)="onPaginaD($event)"
                     [loading]="detRes.isLoading()" [showCurrentPageReport]="true" currentPageReportTemplate="{first}–{last} de {totalRecords}"
                     dataKey="id" class="surf-table surf-table--plain surf-table--sticky" styleClass="cs-tabla" [tableStyle]="{ width: '100%' }">
              <ng-template #header>
                <tr class="cs-cab">
                  <th scope="col" [attr.aria-sort]="ariaSort('producto')">
                    <button type="button" class="cd-ord" (click)="ordenar('producto')">Producto <i [class]="flecha('producto')" aria-hidden="true"></i></button>
                  </th>
                  <th scope="col">Proveedor</th>
                  <th scope="col">Unidades de medida</th>
                  <th scope="col" class="comm-num">Precio</th>
                  <th scope="col" class="comm-num" [attr.aria-sort]="ariaSort('mes')">
                    @if (ventaMedida()) {
                      <button type="button" class="cd-ord" (click)="ordenar('mes')">
                        Este mes <i [class]="flecha('mes')" aria-hidden="true"></i></button>
                    } @else {
                      <span>Este mes</span>
                    }
                  </th>
                </tr>
              </ng-template>
              <ng-template #body let-f>
                <tr class="cs-fila" tabindex="0" [class.is-sel]="abierto()?.id === f.id" [attr.aria-label]="'Ver ficha de ' + nombreFila(f)"
                    (click)="abrirDetallada(f)" (keydown)="teclaFilaD($event, f)">
                  <td class="cs-prod">
                    <div class="cs-nom">{{ nombreFila(f) }}</div>
                    @if (f.sku) { <div class="cs-sku">{{ f.sku }}</div> }
                    @if (f.lider !== null || f.nuevo || f.caducidad) {
                      <div class="cd-tags">
                        @if (f.lider !== null) { <span class="cd-tag cd-tag--lider">Líder #{{ f.lider }}</span> }
                        @if (f.nuevo) { <span class="cd-tag cd-tag--nuevo">{{ f.nuevo }}</span> }
                        @if (f.caducidad) { <span class="cd-tag cd-tag--cad">{{ f.caducidad === 'caducado' ? 'Caducado' : 'Caduca pronto' }}</span> }
                      </div>
                    }
                    @if (f.razon) { <div class="cs-razon">Coincide por {{ f.razon }}</div> }
                  </td>
                  <td class="cs-prov">
                    @if (f.proveedor) { {{ provNombre(f.proveedor.nombre) }} } @else { <span class="cs-sin">Sin proveedor</span> }
                  </td>
                  <td class="cs-ud"><ng-container *ngTemplateOutlet="celdaUnidades; context: { $implicit: f }" /></td>
                  <td class="cs-pre comm-num"><ng-container *ngTemplateOutlet="celdaPrecio; context: { $implicit: f }" /></td>
                  @let m = mesDe(f);
                  <td class="cd-mes comm-num" [title]="m.titulo ?? ''">
                    <span class="cd-mes-v" [class.cs-sin]="m.tipo !== 'monto'">{{ m.texto }}</span>
                    @if (m.variacion; as v) { <small class="cd-var" [class]="'cd-var cd-var--' + v.tono">{{ v.texto }}</small> }
                  </td>
                </tr>
              </ng-template>
            </p-table>
          </app-load-state>
          <!-- Las definiciones a la vista (no en un title: ese solo lo alcanza quien tiene mouse). -->
          <p class="cd-pie">
            @if (ventaMedida()) { Este mes: venta con impuestos del 1 a hoy; la flecha la compara con los mismos días del mes anterior. }
            @else { La venta del mes no se pudo medir ahora: la columna dice «Sin dato» y no se puede ordenar por ella. }
            Líder: está entre los productos que juntos hacen la mitad de la venta de la red en 90 días.
          </p>
        </section>
      }

      <!-- La ficha del producto: la de Sencillo o la de Detallado (sin Editar: el usuario lo quito). -->
      <app-side-peek [open]="abierto() !== null" (openChange)="$event ? null : cerrarFlujo()" [width]="abierto()?.tipo === 'ficha' ? 760 : 880"
                     [title]="abierto()?.nombre || ''" [subtitle]="abierto() ? ((abierto()!.sku || '') + (abierto()!.proveedor ? ' · ' + abierto()!.proveedor : '')) : null">
        @if (abierto(); as a) {
          @if (a.tipo === 'ficha') {
            <app-producto-ficha [productId]="a.id" />
          } @else {
            <app-producto-ficha-detallada [productId]="a.id" [etiquetas]="a.etiquetas ?? null" />
          }
        }
      </app-side-peek>
    </div>
    `,
  styles: [`
    :host { display: block; }
    .cp-head-actions { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }

    .cp-buscar { display: flex; align-items: center; gap: .5rem; margin: 1rem 0 .75rem; height: 2.6rem; padding: 0 .85rem;
      border: 1px solid var(--c-divider); border-radius: 10px; background: var(--c-surface-1); }
    .cp-buscar:focus-within { border-color: var(--c-text-1); }
    .cp-buscar i { color: var(--c-text-3); }
    .cp-buscar input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; font: inherit; font-size: var(--fs-h3); color: var(--c-text-1); }
    .cp-buscar input::-webkit-search-cancel-button { display: none; }
    .cp-buscar input:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    .cp-x { border: 0; background: transparent; color: var(--c-text-3); cursor: pointer; width: 1.8rem; height: 1.8rem; border-radius: 6px; }
    .cp-x:hover { background: var(--hover-bg); color: var(--c-text-1); }

    /* Las dos vistas, el menu Ver y el filtro Mostrar (maqueta catalogo-produccion aprobada). */
    .cp-vista-btn { display: inline-flex; align-items: center; gap: var(--sp-2); min-height: 2.25rem; padding: 0 var(--sp-3);
      border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); color: var(--text-main);
      font: inherit; font-size: var(--fs-sm); font-weight: var(--fw-medium); cursor: pointer; }
    .cp-vista-btn:hover { background: var(--overlay-hover); }
    .cp-vista-btn[aria-pressed='true'] { background: var(--overlay-selected); }
    .cp-controles { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; margin-top: var(--sp-3); }
    .cs-fresco { margin-left: auto; }
    .cs-mostrar { position: relative; }
    .cs-sel { display: inline-flex; align-items: center; gap: var(--sp-2); min-height: 2.25rem; padding: 0 var(--sp-3);
      border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); color: var(--text-main);
      font: inherit; font-size: var(--fs-sm); cursor: pointer; }
    .cs-sel:hover { background: var(--overlay-hover); }
    .cs-sel-eti { color: var(--text-muted); }
    .cs-sel .pi { font-size: var(--fs-xs); color: var(--text-muted); }
    .cs-n { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-xs); color: var(--text-muted); }
    .cs-menu { position: absolute; z-index: 30; top: calc(100% + var(--sp-1)); left: 0; min-width: 16rem; padding: var(--sp-1);
      border: 1px solid var(--border-color); border-radius: var(--r-lg); background: var(--card-bg); box-shadow: var(--shadow-float); }
    .cs-op { display: flex; width: 100%; justify-content: space-between; align-items: center; gap: var(--sp-4); padding: var(--sp-2);
      border: 0; border-radius: var(--r-sm); background: transparent; color: var(--text-main); font: inherit; font-size: var(--fs-sm);
      text-align: left; cursor: pointer; }
    .cs-op:hover { background: var(--overlay-hover); }
    .cs-op.is-on { background: var(--overlay-selected); font-weight: var(--fw-bold); }
    .cs-op[aria-disabled='true'] { color: var(--text-faint); cursor: not-allowed; }
    .cp-vista-btn:focus-visible, .cs-sel:focus-visible, .cs-op:focus-visible, .cs-fila:focus-visible, .cd-ord:focus-visible {
      outline: 2px solid var(--focus-ring); outline-offset: -2px; }

    .cs { container-type: inline-size; margin-top: var(--sp-1); }
    .cs-fila { cursor: pointer; }
    .cs-fila:hover { background: var(--overlay-hover); }
    .cs-fila.is-sel { background: var(--overlay-selected); }
    .cs-fila > td { vertical-align: top; }
    .cs-nom { font-size: var(--fs-body); font-weight: var(--fw-bold); color: var(--text-main); }
    .cs-sku { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-muted); }
    .cs-razon { margin-top: 2px; font-size: var(--fs-xs); color: var(--text-muted); }
    .cs-prov { font-size: var(--fs-sm); color: var(--text-muted); }
    .cs-pila { display: flex; flex-direction: column; gap: var(--sp-1); }
    .cs-lin { display: flex; align-items: center; gap: var(--sp-2); min-height: 1.5rem; }
    .cs-pre .cs-lin { justify-content: flex-end; }
    .cs-chip { font-family: var(--font-mono); font-size: var(--fs-xs); font-weight: var(--fw-bold); color: var(--text-main);
      padding: 0 var(--sp-2); border: 1px solid var(--border-color); border-radius: var(--r-pill); }
    .cs-eq { font-size: var(--fs-xs); color: var(--text-muted); }
    .cs-precio, .cs-m-precio { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-weight: var(--fw-bold); color: var(--text-main); }
    .cs-sin { font-size: var(--fs-xs); color: var(--text-faint); font-weight: normal; font-family: inherit; }
    .cs-m-precio { display: none; }

    /* Detallado: menu agrupado, etiquetas, orden por columna y Este mes */
    .cd-menu { min-width: 19rem; max-height: min(70vh, 36rem); overflow-y: auto; }
    .cd-grupo + .cd-grupo { margin-top: var(--sp-1); padding-top: var(--sp-1); border-top: 1px solid var(--border-color); }
    .cd-grupo-t { margin: var(--sp-1) var(--sp-2) 0; font-size: var(--fs-micro); letter-spacing: .07em; text-transform: uppercase;
      color: var(--text-faint); font-weight: var(--fw-bold); }
    .cd-op-t { display: flex; flex-direction: column; }
    .cd-nota { margin: 0 var(--sp-2); font-size: var(--fs-xs); color: var(--text-muted); font-weight: normal; }
    .cd-op-t .cd-nota { margin: 0; }
    .cd-pie { margin: var(--sp-2) 0 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .cd-aviso { margin: 0 0 var(--sp-2); font-size: var(--fs-xs); color: var(--warn-soft-fg); }
    .cd-tags { display: flex; flex-wrap: wrap; gap: var(--sp-1); margin-top: var(--sp-1); }
    .cd-tag { font-size: var(--fs-xs); font-weight: var(--fw-bold); border-radius: var(--r-pill); padding: 0 var(--sp-2); border: 1px solid currentColor;
      line-height: 1.5; white-space: nowrap; }
    .cd-tag--lider { color: var(--action); }
    .cd-tag--nuevo { color: var(--text-muted); }
    .cd-tag--cad { color: var(--bad-soft-fg); background: var(--bad-soft-bg); border-color: var(--bad-border); }
    .cd-ord { border: 0; background: none; padding: 0; font: inherit; color: inherit; cursor: pointer; display: inline-flex; gap: var(--sp-1); align-items: center; }
    .cd-ord:hover { color: var(--text-main); }
    .cd-ord .pi { font-size: var(--fs-micro); }
    .cd-mes { white-space: nowrap; }
    .cd-mes-v { display: block; font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-weight: var(--fw-bold); color: var(--text-main); }
    .cd-mes-v.cs-sin { font-family: var(--font-body); font-weight: normal; }
    .cd-var { display: block; font-family: var(--font-mono); font-size: var(--fs-xs); }
    .cd-var--sube { color: var(--ok-fg); }
    .cd-var--baja { color: var(--bad-fg); }
    .cd-var--igual { color: var(--text-muted); }

    /* En angosto cada renglon es una tarjeta y el precio va pegado a su unidad. */
    @container (max-width: 40rem) {
      .cs-cab { display: none; }
      .cs-fila { display: flex; flex-direction: column; gap: var(--sp-1); padding: var(--sp-3) 0; border-bottom: 1px solid var(--border-color); }
      .cs-fila > td { display: block; border: 0; padding: 0 var(--sp-3); }
      .cs-fila > td.cs-pre { display: none; }
      .cs-m-precio { display: inline; margin-left: auto; }
      .cs-fila > td.cd-mes { display: flex; gap: var(--sp-2); align-items: baseline; text-align: left; }
      .cs-fila > td.cd-mes::before { content: 'Este mes'; color: var(--text-muted); font-size: var(--fs-xs); }
      .cd-mes-v, .cd-var { display: inline; }
    }
    @media (pointer: coarse) { .cs-sel, .cs-op, .cp-vista-btn { min-height: 44px; } }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComprasCatalogoComponent {
  private readonly destroyRef = inject(DestroyRef);
  private readonly toast = inject(MessageService);
  private readonly catalogoApi = inject(CatalogoProductosService);
  private readonly auth = inject(AuthService);

  // ── Sencillo / Detallado: el botón junto al título; se recuerda por persona ──
  private readonly usuario = this.auth.user()?.sub ?? null;
  readonly modo = signal<VistaCatalogo>(leerVista(this.usuario));
  readonly detallado = computed(() => this.modo() === 'detallado');
  alternarVista(): void {
    const v: VistaCatalogo = this.detallado() ? 'sencillo' : 'detallado';
    this.modo.set(v);
    guardarVista(this.usuario, v);
    // Cada vista abre su propia ficha: la de la otra no se queda colgada.
    this.abierto.set(null);
    this.mostrarAbierto.set(false);
  }

  /** Sube cada minuto (con la pestaña visible): recarga lo vivo sin vaciar la pantalla. */
  private readonly recarga = signal(0);

  // ── Búsqueda: una para las dos vistas ──
  busqueda = '';
  readonly busquedaSenal = signal('');
  onBusqueda(v: string): void { this.busqueda = v; this.buscarDebounced(v); }
  private readonly buscarDebounced = makeDebouncedSearch((v) => this.busquedaSenal.set((v || '').trim()));
  limpiarBusqueda(): void { this.busqueda = ''; this.busquedaSenal.set(''); }

  // ── Sencillo: la lista paginada por el servidor ──
  readonly opcionesMostrar = OPCIONES_MOSTRAR;
  readonly mostrar = signal<MostrarCatalogo>('todos');
  readonly tamanoSencillo = signal(PAGINA_SENCILLO);
  /** Otra búsqueda u otro «Mostrar» vuelve a la página 1. */
  readonly pagina = linkedSignal({ source: () => ({ q: this.busquedaSenal(), m: this.mostrar() }), computation: () => 1 });
  readonly onPagina = makeLazyLoad(this.pagina, this.tamanoSencillo, () => undefined);
  readonly listaRes = rxResource({
    params: () => (this.detallado()
      ? undefined
      : { search: this.busquedaSenal(), mostrar: this.mostrar(), page: this.pagina(), pageSize: this.tamanoSencillo(), v: this.recarga() }),
    stream: ({ params }) => this.catalogoApi.lista({ search: params.search, mostrar: params.mostrar, page: params.page, pageSize: params.pageSize }),
  });
  /** Lo último que llegó: buscar o paginar no vacía la tabla mientras carga; una recarga que falla tampoco. */
  readonly lista = linkedSignal<CatalogoLista | undefined, CatalogoLista | null>({
    source: () => (this.listaRes.error() ? undefined : this.listaRes.value()),
    computation: (nuevo, previo) => nuevo ?? previo?.value ?? null,
  });
  readonly filasSencillo = computed<FilaCatalogoProducto[]>(() => this.lista()?.filas ?? []);
  readonly totalSencillo = computed(() => this.lista()?.total ?? 0);
  readonly listaCargando = computed(() => this.listaRes.isLoading() && !this.lista());
  readonly listaError = computed(() => (this.listaRes.error() && !this.lista() ? 'Revisa la conexión y vuelve a intentar.' : null));
  readonly listaVacia = computed(() => !!this.lista() && !this.listaRes.isLoading() && this.filasSencillo().length === 0);
  readonly vacioTitulo = computed(() => {
    const q = this.busquedaSenal();
    if (q && !this.lista()?.conteos.todos) return '«' + q + '» no está en el catálogo';
    return this.mostrar() !== 'todos' ? 'Ningún producto con este filtro' : 'Sin productos activos';
  });
  readonly vacioPista = computed(() => {
    const q = this.busquedaSenal();
    if (q && !this.lista()?.conteos.todos) {
      return 'Se buscó en nombre, SKU, todos los códigos de barras, proveedor y unidades. Prueba con menos palabras o con el código.';
    }
    return this.mostrar() !== 'todos' ? 'Cambia «Mostrar» a Todos para ver el resto.' : null;
  });
  readonly opcionMostrar = computed(() => OPCIONES_MOSTRAR.find((o) => o.id === this.mostrar()) ?? OPCIONES_MOSTRAR[0]);
  /** El conteo de una opción: número, «sin medir» (null del servidor), o nada mientras no hay respuesta. */
  conteoTexto(id: MostrarCatalogo): string {
    const c = this.lista()?.conteos;
    if (!c) return '';
    const v = c[OPCIONES_MOSTRAR.find((o) => o.id === id)!.conteo];
    return v === null || v === undefined ? 'sin medir' : new Intl.NumberFormat('es-MX').format(v);
  }
  /** «Alguna unidad sin precio» no se puede medir sin precio por sucursal: se declara y no se elige. */
  noMedible(id: MostrarCatalogo): boolean {
    const c = this.lista()?.conteos;
    return id === 'sin_precio' && !!c && c.sinPrecio === null;
  }

  // ── Detallado: la lista paginada, filtrada, contada y ordenada por el servidor ──
  readonly gruposDetallado = GRUPOS_DETALLADO;
  readonly mostrarD = signal<FiltroDetallado>('todos');
  /** Default: lo que más vende este mes primero (como la maqueta aprobada). */
  readonly ordenD = signal<{ col: OrdenDetallado; dir: DireccionOrden }>({ col: 'mes', dir: 'desc' });
  readonly tamanoDetallado = signal(PAGINA_SENCILLO);
  readonly paginaD = linkedSignal({ source: () => ({ q: this.busquedaSenal(), m: this.mostrarD(), o: this.ordenD() }), computation: () => 1 });
  readonly onPaginaD = makeLazyLoad(this.paginaD, this.tamanoDetallado, () => undefined);
  readonly detRes = rxResource({
    params: () => (this.detallado()
      ? { search: this.busquedaSenal(), mostrar: this.mostrarD(), orden: this.ordenD(), page: this.paginaD(), pageSize: this.tamanoDetallado(), v: this.recarga() }
      : undefined),
    stream: ({ params }) => this.catalogoApi.detallado({
      search: params.search, mostrar: params.mostrar, orden: params.orden.col, dir: params.orden.dir, page: params.page, pageSize: params.pageSize,
    }),
  });
  readonly listaD = linkedSignal<CatalogoListaDetallada | undefined, CatalogoListaDetallada | null>({
    source: () => (this.detRes.error() ? undefined : this.detRes.value()),
    computation: (nuevo, previo) => nuevo ?? previo?.value ?? null,
  });
  readonly filasDetallado = computed<FilaCatalogoDetallada[]>(() => this.listaD()?.filas ?? []);
  readonly totalDetallado = computed(() => this.listaD()?.total ?? 0);
  readonly listaDCargando = computed(() => this.detRes.isLoading() && !this.listaD());
  readonly listaDError = computed(() => (this.detRes.error() && !this.listaD() ? 'Revisa la conexión y vuelve a intentar.' : null));
  readonly listaDVacia = computed(() => !!this.listaD() && !this.detRes.isLoading() && this.filasDetallado().length === 0);
  /** Lo que el servidor APLICÓ (un filtro sin medir cae a «Todos»; sin venta medida, el orden cae a Producto). */
  readonly mostrarAplicado = computed<FiltroDetallado>(() => this.listaD()?.mostrar ?? this.mostrarD());
  readonly ordenAplicado = computed(() => {
    const l = this.listaD();
    return l ? { col: l.orden, dir: l.dir } : this.ordenD();
  });
  readonly ventaMedida = computed(() => this.listaD()?.venta.medida ?? true);
  readonly vacioTituloD = computed(() => {
    const q = this.busquedaSenal();
    const l = this.listaD();
    if (q && !l?.conteos.todos) return '«' + q + '» no está en el catálogo';
    return this.mostrarAplicado() !== 'todos' ? 'Ningún producto con este filtro' : 'Sin productos activos';
  });
  readonly vacioPistaD = computed(() => {
    const q = this.busquedaSenal();
    const l = this.listaD();
    if (q && !l?.conteos.todos) {
      return 'Se buscó en nombre, SKU, todos los códigos de barras, proveedor y unidades. Prueba con menos palabras o con el código.';
    }
    return this.mostrarAplicado() !== 'todos' ? 'Cambia «Mostrar» a Todos para ver el resto.' : null;
  });
  /** Si una familia de etiquetas no se pudo medir, se dice: un renglón sin etiqueta no quiere decir «no es». */
  readonly avisoEtiquetas = computed(() => {
    const e = this.listaD()?.etiquetas;
    if (!e) return null;
    const faltan = [!e.lider ? 'líder' : null, !e.caducidad ? 'caducidad' : null, !e.nuevo ? 'nuevo' : null].filter((x): x is string => !!x);
    return faltan.length ? `Sin etiquetas de ${faltan.join(', ')}: no se pudieron calcular ahora. Que un producto no la tenga no quiere decir que no lo sea.` : null;
  });
  etiquetaD(id: FiltroDetallado): string { return etiquetaFiltro(id); }
  conteoD(id: FiltroDetallado): string { return conteoDetallado(this.listaD(), id); }
  noMedibleD(id: FiltroDetallado): boolean { return noMedibleDetallado(this.listaD(), id); }
  /** La nota que comparten TODAS las opciones de un grupo (p. ej. «Qué hacer» con una búsqueda grande) va una vez. */
  notaGrupo(g: GrupoDetallado): string | null {
    const notas = this.listaD()?.notas ?? {};
    const xs = g.opciones.map((o) => notas[o.id] ?? null);
    return xs.length > 1 && xs[0] && xs.every((x) => x === xs[0]) ? xs[0] : null;
  }
  notaOpcion(g: GrupoDetallado, id: FiltroDetallado): string | null {
    return this.notaGrupo(g) ? null : this.listaD()?.notas?.[id] ?? null;
  }
  elegirMostrarD(id: FiltroDetallado): void {
    if (this.noMedibleD(id)) return;
    this.mostrarD.set(id);
    this.cerrarMostrar(true);
  }
  ordenar(col: OrdenDetallado): void { this.ordenD.set(siguienteOrden(this.ordenAplicado(), col)); }
  ariaSort(col: OrdenDetallado): 'ascending' | 'descending' | 'none' {
    const o = this.ordenAplicado();
    return o.col !== col ? 'none' : o.dir === 'asc' ? 'ascending' : 'descending';
  }
  flecha(col: OrdenDetallado): string {
    const o = this.ordenAplicado();
    return o.col !== col ? 'pi pi-sort-alt' : o.dir === 'asc' ? 'pi pi-sort-amount-up-alt' : 'pi pi-sort-amount-down';
  }
  mesDe(f: FilaCatalogoDetallada) { return celdaMes(f, this.listaD()?.venta.periodos ?? null); }
  abrirDetallada(f: FilaCatalogoDetallada): void {
    this.abierto.set({
      id: f.id, nombre: this.nombreFila(f), sku: f.sku, proveedor: f.proveedor ? nombreProveedor(f.proveedor.nombre) : null, tipo: 'detallado',
      etiquetas: { lider: f.lider, nuevo: f.nuevo, caducidad: f.caducidad },
    });
  }
  teclaFilaD(e: KeyboardEvent, f: FilaCatalogoDetallada): void { this.teclaRenglon(e, () => this.abrirDetallada(f)); }

  // ── El menú «Mostrar» (uno a la vez: el de Sencillo o el de Detallado) ──
  readonly mostrarAbierto = signal(false);
  private readonly mostrarCaja = viewChild<ElementRef<HTMLElement>>('mostrarCaja');
  private readonly mostrarBtn = viewChild<ElementRef<HTMLButtonElement>>('mostrarBtn');
  private readonly mostrarMenu = viewChild<ElementRef<HTMLElement>>('mostrarMenu');
  alternarMostrar(): void { if (this.mostrarAbierto()) this.cerrarMostrar(true); else this.abrirMostrar(); }
  abrirMostrar(): void {
    this.mostrarAbierto.set(true);
    setTimeout(() => {
      const xs = this.opcionesDelMenu();
      (xs.find((b) => b.getAttribute('aria-checked') === 'true') ?? xs[0])?.focus();
    });
  }
  cerrarMostrar(devolverFoco: boolean): void {
    if (!this.mostrarAbierto()) return;
    this.mostrarAbierto.set(false);
    if (devolverFoco) this.mostrarBtn()?.nativeElement.focus();
  }
  elegirMostrar(id: MostrarCatalogo): void {
    if (this.noMedible(id)) return;
    this.mostrar.set(id);
    this.cerrarMostrar(true);
  }
  tecladoMostrar(e: KeyboardEvent): void {
    const xs = this.opcionesDelMenu();
    const i = xs.indexOf(document.activeElement as HTMLElement);
    const ir = (n: number) => { e.preventDefault(); xs[(n + xs.length) % xs.length]?.focus(); };
    if (e.key === 'ArrowDown') ir(i + 1);
    else if (e.key === 'ArrowUp') ir(i - 1);
    else if (e.key === 'Home') ir(0);
    else if (e.key === 'End') ir(xs.length - 1);
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.cerrarMostrar(true); }
    else if (e.key === 'Tab') this.cerrarMostrar(false);
  }
  @HostListener('document:click', ['$event'])
  clicFuera(e: MouseEvent): void {
    const caja = this.mostrarCaja()?.nativeElement;
    if (this.mostrarAbierto() && caja && !caja.contains(e.target as Node)) this.cerrarMostrar(false);
  }
  private opcionesDelMenu(): HTMLElement[] {
    return Array.from(this.mostrarMenu()?.nativeElement.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []);
  }

  // ── El renglón (las dos vistas) ──
  nombreFila(f: Pick<FilaCatalogoProducto, 'nombre' | 'sku'>): string { return nombrePropio(f.nombre) || f.sku || ''; }
  equivale(u: UnidadPrecio): string { return equivaleTexto(u); }
  precio(v: number): string { return dineroFicha(v) ?? ''; }
  readonly provNombre = nombreProveedor;
  abrirFicha(f: FilaCatalogoProducto): void {
    this.abierto.set({
      id: f.id, nombre: this.nombreFila(f), sku: f.sku, proveedor: f.proveedor ? nombreProveedor(f.proveedor.nombre) : null, tipo: 'ficha',
    });
  }
  /** Enter o espacio abre la ficha; las flechas pasan al renglón de arriba o de abajo. */
  teclaFila(e: KeyboardEvent, f: FilaCatalogoProducto): void { this.teclaRenglon(e, () => this.abrirFicha(f)); }
  private teclaRenglon(e: KeyboardEvent, abrir: () => void): void {
    const tr = e.currentTarget as HTMLElement;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrir(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); (tr.nextElementSibling as HTMLElement | null)?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (tr.previousElementSibling as HTMLElement | null)?.focus(); }
  }

  // ── El panel lateral ──
  readonly abierto = signal<AbiertoFicha | null>(null);
  cerrarFlujo(): void { this.abierto.set(null); }

  constructor() {
    const id = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') this.recarga.update((n) => n + 1);
    }, 60_000);
    this.destroyRef.onDestroy(() => clearInterval(id));
    // Si falla una recarga con datos ya en pantalla, se avisa (la tabla no se vacía ni se pinta como vacía).
    effect(() => {
      if (this.listaRes.error() && this.lista()) {
        this.toast.add({ severity: 'warn', summary: 'No se pudo actualizar', detail: 'Se muestra la última lista que llegó.' });
      }
    });
    effect(() => {
      if (this.detRes.error() && this.listaD()) {
        this.toast.add({ severity: 'warn', summary: 'No se pudo actualizar', detail: 'Se muestra la última lista que llegó.' });
      }
    });
  }

  refresh(): void { this.recarga.update((n) => n + 1); }
}
