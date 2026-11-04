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
  untracked,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { ToastModule } from 'primeng/toast';
import { SelectModule } from 'primeng/select';
import { FormsModule } from '@angular/forms';
import { MessageService } from 'primeng/api';
import { rxResource } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { esNombreDescontinuado, nombreSinMarcaDescontinuado, warehouseName } from '@megadulces/contracts';
import { makeDebouncedSearch, makeLazyLoad } from '../../../shared/util';
import { AuthService } from '../../../core/services/auth.service';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import {
  CatalogoLista, CatalogoListaDetallada, CatalogoProductosService, ConteosCatalogo, DireccionOrden, FilaCatalogoDetallada,
  FilaCatalogoProducto, FiltroDetallado, LanzamientoFila, MostrarCatalogo, OrdenDetallado, ResultadoLanzamiento, UltimoCosto, UnidadPrecio,
} from '../catalogo-productos.service';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { RESULTADOS_LANZAMIENTO, VEREDICTOS, celdaFunciono, diaLanzamiento, etiquetaResultado, resultadoValido } from '../productos-nuevos-vista';
import { CatalogoMenuComponent } from './catalogo-menu.component';
import { ProductoFichaComponent, dineroFicha, fechaFicha } from './producto-ficha.component';
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
  /**
   * `[NP.22]` ¿Es un producto nuevo? true = el renglón lo dice; false = el renglón dice que no (la ficha no lo pide);
   * null = no se sabe (Sencillo sin el filtro): la ficha lo pregunta y pinta «Lanzamiento» sólo si lo es.
   */
  esNuevo: boolean | null;
}

/** Las dos vistas de Productos. Sencillo es la de default; Detallado suma venta del mes, etiquetas y qué hacer. */
export type VistaCatalogo = 'sencillo' | 'detallado';

/** `[NP.22]` «Mostrar» de Sencillo: los 4 de su servidor + Productos nuevos (esa lista la sirve Detallado). */
export type MostrarSencillo = MostrarCatalogo | 'nuevos';

/** `[NP.22]` La lista de Sencillo; con «Productos nuevos» trae además el resultado del lanzamiento y sus conteos. */
export interface ListaSencillo extends Omit<CatalogoLista, 'mostrar' | 'filas'> {
  mostrar: MostrarSencillo;
  filas: Array<FilaCatalogoProducto & { lanzamiento?: LanzamientoFila | null }>;
  resultado?: ResultadoLanzamiento | null;
  conteos_lanzamiento?: Record<ResultadoLanzamiento, number> | null;
}

/**
 * `[NP.22]` Sencillo con «Productos nuevos»: la respuesta de Detallado (la única que filtra por lanzamiento) en la forma
 * de Sencillo. Los renglones son los mismos (Detallado extiende el de Sencillo); los conteos se pasan a sus nombres.
 * Si el servidor no pudo aplicar «nuevos» (Productos nuevos sin calcular), lo dice `mostrar` y la pantalla lo declara.
 */
export function listaSencilloDeDetallado(d: CatalogoListaDetallada): ListaSencillo {
  const c = d.conteos;
  return {
    sucursal: d.sucursal,
    total: d.total,
    filas: d.filas,
    calculado_al: d.calculado_al,
    conteos: { todos: c.todos ?? 0, variosCodigos: c.varios_codigos ?? 0, sinCodigo: c.sin_codigo ?? 0, sinPrecio: c.sin_precio ?? null, nuevos: c.nuevos ?? null },
    mostrar: d.mostrar === 'nuevos' ? 'nuevos' : 'todos',
    costo_visible: d.costo_visible,
    costo_medido: d.costo_medido,
    resultado: d.resultado ?? null,
    conteos_lanzamiento: d.conteos_lanzamiento ?? null,
  };
}

/** La última vista que eligió ESTA persona (comodidad de este navegador; sin almacenamiento, Sencillo). */
export const claveVista = (usuario: string | null | undefined) => 'compras.catalogo.vista:' + (usuario || 'anon');
export function leerVista(usuario: string | null | undefined): VistaCatalogo {
  try { return localStorage.getItem(claveVista(usuario)) === 'detallado' ? 'detallado' : 'sencillo'; } catch { return 'sencillo'; }
}
function guardarVista(usuario: string | null | undefined, v: VistaCatalogo): void {
  try { localStorage.setItem(claveVista(usuario), v); } catch { /* sin almacenamiento: no pasa nada */ }
}

/** «Mostrar» de la vista Sencillo, con la clave de su conteo. */
export const OPCIONES_MOSTRAR: ReadonlyArray<{ id: MostrarSencillo; label: string; conteo: keyof ConteosCatalogo }> = [
  { id: 'todos', label: 'Todos', conteo: 'todos' },
  { id: 'varios_codigos', label: 'Con varios códigos', conteo: 'variosCodigos' },
  { id: 'sin_codigo', label: 'Sin código de barras', conteo: 'sinCodigo' },
  { id: 'sin_precio', label: 'Alguna unidad sin precio', conteo: 'sinPrecio' },
  // [NP.22] La que antes era su propia pantalla en el menú «Ver» (decisión de David, 2026-11-04).
  { id: 'nuevos', label: 'Productos nuevos', conteo: 'nuevos' },
];

/** `[NP.22]` El vacío de Productos nuevos dice cuál resultado quedó vacío y a dónde ir; null = no es Productos nuevos. */
export function vacioNuevos(mostrar: string, r: ResultadoLanzamiento): { titulo: string; pista: string | null } | null {
  if (mostrar !== 'nuevos') return null;
  if (r === 'seguimiento') {
    return { titulo: 'Ningún producto nuevo en seguimiento', pista: 'Mira «Dados de alta, sin movimiento», o quita la búsqueda.' };
  }
  return { titulo: `Ningún producto nuevo en «${etiquetaResultado(r)}»`, pista: 'Elige «Todos en seguimiento» para ver el resto.' };
}

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

/** `[PF.12.3]` La celda «Último costo» ya dicha en texto: la plantilla no decide nada. */
export interface CeldaCosto {
  /**
   * `sin_compras` = sin entradas; `sin_costo` = la entrada no trae costo; `costo` = hay costo; `sin_dato` = el
   * servidor no pudo leerlo ahora (no es «Sin compras»).
   */
  tipo: 'sin_compras' | 'sin_costo' | 'costo' | 'sin_dato';
  /** Convertido: una línea por unidad, alineada con Unidades y Precio. Sin convertir: una, en la unidad de la entrada. */
  lineas: Array<{ unidad: string; texto: string; bajo: boolean }>;
  /** La unidad de la entrada cuando NO está entre las del renglón: el costo se queda en ella. */
  sinConvertir: string | null;
  /** «Precio bajo costo» (o «… en CJA» si no son todas las que tienen precio) y su evidencia. */
  bajoCosto: { texto: string; detalle: string } | null;
  /** Cuándo y dónde fue la entrada: «8 oct 2026 · Morelia Abastos» (la sucursal por NOMBRE). */
  origen: string | null;
  /** El renglón de la entrada no dice si el costo trae impuestos. */
  impuestoSinDato: boolean;
}

/**
 * `[PF.12.3]` Del `ultimoCosto` del servidor a la celda. Sin entradas dice «Sin compras», nunca $0; la unidad
 * que no está en la escalera se queda en la suya («sin convertir»); el bajo costo nombra la unidad y trae su
 * evidencia (precio sin impuestos contra costo).
 */
export function celdaCosto(c: UltimoCosto | null | undefined, medido = true): CeldaCosto {
  const vacia = { lineas: [], sinConvertir: null, bajoCosto: null, origen: null, impuestoSinDato: false };
  // Sin leer no es sin compras: un renglón sin `ultimoCosto` porque la lectura falló se dice «Sin dato».
  if (!medido) return { ...vacia, tipo: 'sin_dato' };
  if (!c) return { ...vacia, tipo: 'sin_compras' };
  const dinero = (v: number | null) => dineroFicha(v) ?? '';
  const origen = [fechaFicha(c.fecha), warehouseName(c.sucursal)].filter((x) => !!x).join(' · ') || null;
  if (c.costo === null || c.costo === undefined) return { ...vacia, tipo: 'sin_costo', origen };
  const impuestoSinDato = c.impuesto === 'sin_dato';
  const porUnidad = c.porUnidad ?? [];
  if (!porUnidad.length) {
    return { ...vacia, tipo: 'costo', lineas: [{ unidad: c.unidad, texto: dinero(c.costo), bajo: false }], sinConvertir: c.unidad, origen, impuestoSinDato };
  }
  const bajas = porUnidad.filter((u) => u.bajoCosto === true);
  const comparadas = porUnidad.filter((u) => u.bajoCosto !== null);
  const bajoCosto = bajas.length
    ? {
        texto: bajas.length === comparadas.length ? 'Precio bajo costo' : 'Precio bajo costo en ' + bajas.map((u) => u.unidad).join(', '),
        detalle: bajas.map((u) => u.unidad + ': precio sin impuestos ' + dinero(u.precioSinImpuestos) + ', último costo ' + dinero(u.costo)).join(' · '),
      }
    : null;
  return {
    tipo: 'costo',
    lineas: porUnidad.map((u) => ({ unidad: u.unidad, texto: dinero(u.costo), bajo: u.bajoCosto === true })),
    sinConvertir: null,
    bajoCosto,
    origen,
    impuestoSinDato,
  };
}

@Component({
  selector: 'app-compras-catalogo',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    SelectModule,
    ToastModule,
    TableModule,
    TagModule,
    LoadStateComponent,
    FreshnessPillComponent,
    CatalogoMenuComponent,
    SidePeekComponent,
    ProductoFichaComponent,
    ProductoFichaDetalladaComponent,
    ContextHelpComponent,
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
          <!-- [PF.21] De que sucursal es el PRECIO (solo el precio: Este mes, Que hacer y el ultimo costo son de toda la red).
               Las opciones son las de tu alcance; con una sola, se dice cual es y no se ofrece elegir. -->
          @if (opcionesSucursalD().length > 1) {
            <label class="cd-suc">
              <span class="cs-sel-eti">Precios de</span>
              <p-select [options]="opcionesSucursalD()" optionLabel="label" optionValue="value" [ngModel]="listaD()?.sucursal"
                        (onChange)="elegirSucursalD($event.value)" appendTo="body" ariaLabel="Precios de la sucursal" styleClass="cd-suc-sel" />
            </label>
          } @else if (listaD()?.sucursal; as s) {
            <span class="cd-suc"><span class="cs-sel-eti">Precios de</span>&ngsp;<b>{{ nombreSucursalD(s) }}</b></span>
          }
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

      <!-- [NP.22] Los resultados del lanzamiento, con cuantos de la busqueda van en cada uno (los cuenta el servidor). -->
      @if (nuevosActivo()) {
        <div class="cn-res" role="group" aria-label="Resultado del lanzamiento">
          @for (r of resultados; track r.id) {
            @if (r.id === 'sin_venta_30') { <span class="cn-sep" aria-hidden="true"></span> }
            <button type="button" class="cn-chip" [class]="'cn-chip cn-tono-' + tonoResultado(r.veredicto)" [class.is-sel]="resultado() === r.id"
                    [attr.aria-pressed]="resultado() === r.id" (click)="elegirResultado(r.id)">
              @if (r.veredicto) { <i [class]="iconoResultado(r.veredicto)" aria-hidden="true"></i> }
              <span>{{ r.label }}</span>
              <b class="cs-n">{{ conteoResultado(r.id) }}</b>
            </button>
          }
        </div>
        <!-- Lo indispensable para no mentir, en una linea: David retiro el bloque de resumen (2026-11-04). -->
        <p class="cn-nota">
          <p-tag severity="secondary" value="Preliminar" />
          <span>Lo nuevo se reconoce por su primera entrada o venta en Kepler (su fecha de alta no está decodificada). El resultado
            compara venta sin impuestos contra compra sin impuestos.</span>
          <app-context-help topic="productos-nuevos" />
        </p>
        @if (nuevosNoAplicado()) {
          <p class="cd-aviso" role="status">Productos nuevos se está calculando: la lista muestra todo el catálogo mientras tanto. Vuelve a intentar en unos minutos.</p>
        }
      }

      <!-- [NP.22] Las celdas del lanzamiento (solo con Productos nuevos): UNA definicion para Sencillo y Detallado. -->
      <ng-template #celdaFunciono let-f>
        @if (funciono(f); as c) {
          <p-tag [value]="c.label" [icon]="c.icon ?? undefined" [severity]="severidad(c.tono)" />
          @if (c.motivo) { <small class="cn-motivo">{{ c.motivo }}</small> }
        } @else { <span class="cs-sin">Sin dato</span> }
      </ng-template>
      <ng-template #celdaDia let-f>
        @if (diaDe(f); as d) {
          <span class="cn-dia">{{ d.dia }}</span>
          @if (d.etapa) { <small class="cn-motivo">{{ d.etapa }}</small> }
        } @else { <span class="cs-sin">Sin dato</span> }
      </ng-template>

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
      <!-- La celda Ultimo costo: UNA definicion para Sencillo y Detallado. Una linea por unidad (alineada con su
           precio); en angosto, con su unidad y su etiqueta. -->
      <ng-template #celdaCosto let-f let-medido="medido">
        @let k = costoDe(f, medido);
        @switch (k.tipo) {
          @case ('sin_compras') { <span class="cs-sin">Sin compras</span> }
          @case ('sin_costo') { <span class="cs-sin">Sin costo en la entrada</span> }
          @case ('sin_dato') { <span class="cs-sin">Sin dato</span> }
          @default {
            <span class="cs-pila">
              @for (l of k.lineas; track l.unidad) {
                <span class="cs-lin" [class.is-bajo]="l.bajo">
                  <span class="cs-chip" [class.cs-m-ud]="!k.sinConvertir">{{ l.unidad }}</span>&ngsp;<span class="cs-costo">{{ l.texto }}</span>
                </span>
              }
            </span>
            @if (k.sinConvertir) { <small class="cs-cos-nota">Sin convertir: {{ k.sinConvertir }} no está entre sus unidades</small> }
            @if (k.impuestoSinDato) { <small class="cs-cos-nota">Sin saber si trae impuestos</small> }
          }
        }
        @if (k.bajoCosto; as b) {
          <span class="cs-bajo" [attr.title]="b.detalle"><p-tag severity="warn" [value]="b.texto" /></span>
        }
        @if (k.origen) { <small class="cs-cos-org">{{ k.origen }}</small> }
      </ng-template>
      <!-- Lo que significa la columna, a la vista (no en un title: ese solo lo alcanza quien tiene mouse). -->
      <ng-template #defCosto let-medido>
        Último costo: lo que se pagó en la última entrada de compra de cualquier sucursal (abajo, cuándo y dónde), sin IVA ni IEPS
        y llevado a cada unidad con su equivalencia. Precio bajo costo: el precio de lista, sin sus impuestos, queda debajo de ese costo.
        @if (!medido) { El último costo no se pudo leer ahora: dice «Sin dato» (no quiere decir que no haya compras) y se vuelve a intentar en la siguiente recarga. }
      </ng-template>

      <ng-template #defNuevos>
        ¿Funcionó?: el resultado del lanzamiento según Productos nuevos, con su razón principal (abre el producto para ver sus cortes
        de 30, 60 y 90 días y cada sucursal). Día: los días desde su primera entrada o venta; se sigue hasta el día 180.
      </ng-template>

      <!-- Productos, vista Sencillo: nombre, proveedor, unidades, su precio y su ultimo costo. Pagina el servidor. -->
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
                <tr class="cs-cab cs-cab--s">
                  <th scope="col" class="cs-w-prod">Producto</th>
                  @if (nuevosActivo()) {
                    <th scope="col">¿Funcionó?</th>
                    <th scope="col">Día</th>
                  }
                  <th scope="col" class="cs-w-prov">Proveedor</th>
                  <th scope="col" class="cs-w-ud">Unidades de medida</th>
                  <th scope="col" class="comm-num cs-w-num">Precio</th>
                  @if (costoVisible()) {
                    <th scope="col" class="comm-num cs-cos-th cs-w-num">Último costo <small class="cs-th-nota">sin IVA ni IEPS</small></th>
                  }
                </tr>
              </ng-template>
              <ng-template #body let-f>
                <tr class="cs-fila" tabindex="0" [class.is-sel]="abierto()?.id === f.id" [attr.aria-label]="'Ver ficha de ' + nombreFila(f)"
                    (click)="abrirFicha(f)" (keydown)="teclaFila($event, f)">
                  <td class="cs-prod">
                    <!-- [PF.20] Descontinuado: la etiqueta en lugar de la marca «* DESCONTINUADO» (el servidor ya los manda al final). -->
                    @if (esDescontinuado(f)) {
                      <div class="cs-nom"><span class="cd-tag cd-tag--desc">Descontinuado</span>&ngsp;@if (nombreSinMarca(f); as n) { {{ n }} } @else { <span class="cs-sin">Sin nombre en Kepler</span> }</div>
                    } @else {
                      <div class="cs-nom">{{ nombreFila(f) }}</div>
                    }
                    @if (f.sku) { <div class="cs-sku">{{ f.sku }}</div> }
                    @if (nuevosActivo() && f.lanzamiento?.posible_recodificacion) {
                      <div class="cd-tags"><span class="cd-tag cd-tag--recod">Posible recodificación</span></div>
                    }
                    @if (f.razon) { <div class="cs-razon">Coincide por {{ f.razon }}</div> }
                  </td>
                  @if (nuevosActivo()) {
                    <td class="cn-fun" data-label="¿Funcionó?"><ng-container *ngTemplateOutlet="celdaFunciono; context: { $implicit: f }" /></td>
                    <td class="cn-d" data-label="Día"><ng-container *ngTemplateOutlet="celdaDia; context: { $implicit: f }" /></td>
                  }
                  <td class="cs-prov">
                    @if (f.proveedor) { {{ provNombre(f.proveedor.nombre) }} } @else { <span class="cs-sin">Sin proveedor</span> }
                  </td>
                  <td class="cs-ud"><ng-container *ngTemplateOutlet="celdaUnidades; context: { $implicit: f }" /></td>
                  <td class="cs-pre comm-num"><ng-container *ngTemplateOutlet="celdaPrecio; context: { $implicit: f }" /></td>
                  @if (costoVisible()) {
                    <td class="cs-cos comm-num"><ng-container *ngTemplateOutlet="celdaCosto; context: { $implicit: f, medido: costoMedido() }" /></td>
                  }
                </tr>
              </ng-template>
            </p-table>
          </app-load-state>
          @if (costoVisible()) {
            <p class="cd-pie"><ng-container *ngTemplateOutlet="defCosto; context: { $implicit: costoMedido() }" /></p>
          }
          @if (nuevosActivo()) { <p class="cd-pie"><ng-container *ngTemplateOutlet="defNuevos" /></p> }
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
                  @if (nuevosActivo()) {
                    <th scope="col" [attr.aria-sort]="ariaSort('lanzamiento')">
                      <button type="button" class="cd-ord" (click)="ordenar('lanzamiento')">¿Funcionó? <i [class]="flecha('lanzamiento')" aria-hidden="true"></i></button>
                    </th>
                    <th scope="col">Día</th>
                  }
                  <th scope="col">Proveedor</th>
                  <th scope="col">Unidades de medida</th>
                  <th scope="col" class="comm-num">Precio</th>
                  @if (costoVisibleD()) {
                    <th scope="col" class="comm-num cs-cos-th">Último costo <small class="cs-th-nota">sin IVA ni IEPS</small></th>
                  }
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
                    @if (f.lider !== null || f.nuevo || f.caducidad || (nuevosActivo() && f.lanzamiento?.posible_recodificacion)) {
                      <div class="cd-tags">
                        @if (f.lider !== null) { <span class="cd-tag cd-tag--lider">Top venta #{{ f.lider }}</span> }
                        <!-- Con Productos nuevos el dia ya va en su columna: la etiqueta no se repite. -->
                        @if (f.nuevo && !nuevosActivo()) { <span class="cd-tag cd-tag--nuevo">{{ f.nuevo }}</span> }
                        @if (nuevosActivo() && f.lanzamiento?.posible_recodificacion) { <span class="cd-tag cd-tag--recod">Posible recodificación</span> }
                        @if (f.caducidad) { <span class="cd-tag cd-tag--cad">{{ f.caducidad === 'caducado' ? 'Caducado' : 'Caduca pronto' }}</span> }
                      </div>
                    }
                    @if (f.razon) { <div class="cs-razon">Coincide por {{ f.razon }}</div> }
                  </td>
                  @if (nuevosActivo()) {
                    <td class="cn-fun" data-label="¿Funcionó?"><ng-container *ngTemplateOutlet="celdaFunciono; context: { $implicit: f }" /></td>
                    <td class="cn-d" data-label="Día"><ng-container *ngTemplateOutlet="celdaDia; context: { $implicit: f }" /></td>
                  }
                  <td class="cs-prov">
                    @if (f.proveedor) { {{ provNombre(f.proveedor.nombre) }} } @else { <span class="cs-sin">Sin proveedor</span> }
                  </td>
                  <td class="cs-ud"><ng-container *ngTemplateOutlet="celdaUnidades; context: { $implicit: f }" /></td>
                  <td class="cs-pre comm-num"><ng-container *ngTemplateOutlet="celdaPrecio; context: { $implicit: f }" /></td>
                  @if (costoVisibleD()) {
                    <td class="cs-cos comm-num"><ng-container *ngTemplateOutlet="celdaCosto; context: { $implicit: f, medido: costoMedidoD() }" /></td>
                  }
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
            Top venta: está entre los productos que juntos hacen la mitad de nuestra venta en la red en 90 días (no es participación de mercado).
            @if (costoVisibleD()) { <ng-container *ngTemplateOutlet="defCosto; context: { $implicit: costoMedidoD() }" /> }
            @if (nuevosActivo()) { <ng-container *ngTemplateOutlet="defNuevos" /> }
          </p>
        </section>
      }

      <!-- La ficha del producto: la de Sencillo o la de Detallado (sin Editar: el usuario lo quito). -->
      <app-side-peek [open]="abierto() !== null" (openChange)="$event ? null : cerrarFlujo()" [width]="abierto()?.tipo === 'ficha' ? 760 : 880"
                     [title]="abierto()?.nombre || ''" [subtitle]="abierto() ? ((abierto()!.sku || '') + (abierto()!.proveedor ? ' · ' + abierto()!.proveedor : '')) : null">
        @if (abierto(); as a) {
          @if (a.tipo === 'ficha') {
            <app-producto-ficha [productId]="a.id" [esNuevo]="a.esNuevo" />
          } @else {
            <app-producto-ficha-detallada [productId]="a.id" [etiquetas]="a.etiquetas ?? null" [esNuevo]="a.esNuevo" [sucursal]="listaD()?.sucursal ?? null" />
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

    /* Ultimo costo (PF.12.3): secundario frente al precio; la fecha y la sucursal, terciarias. */
    .cs-th-nota { display: block; font-size: var(--fs-micro); font-weight: normal; color: var(--text-faint); text-transform: none; letter-spacing: normal; }
    .cs-cos .cs-lin { justify-content: flex-end; }
    .cs-costo { font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--text-muted); }
    .cs-lin.is-bajo .cs-costo { color: var(--warn-soft-fg); font-weight: var(--fw-bold); }
    .cs-m-ud { display: none; }
    .cs-cos-nota, .cs-cos-org { display: block; margin-top: var(--sp-1); font-size: var(--fs-xs); color: var(--text-muted); font-family: var(--font-body); white-space: normal; }
    .cs-cos-org { color: var(--text-faint); }
    .cs-bajo { display: inline-block; margin-top: var(--sp-1); }
    /* [PF.12] Orden visual: lo numérico (encabezado, cifras, «Sin compras», la fecha y el aviso) alineado a la derecha,
       pegado a su precio; anchos fijos para que el costo no quede lejos (pedido de David: «se ve desordenado»). */
    .cs-cab > th.comm-num { text-align: right; }
    .cs-cab--s > th.cs-w-prod { width: 30%; }
    .cs-cab--s > th.cs-w-prov { width: 17%; }
    .cs-cab--s > th.cs-w-ud { width: 19%; }
    .cs-cab--s > th.cs-w-num { width: 17%; }
    td.cs-cos { text-align: right; }
    td.cs-cos > .cs-sin { display: inline-block; min-height: 1.5rem; line-height: 1.5rem; }

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
    .cd-tag--desc { color: var(--text-muted); margin-right: var(--sp-1); }
    .cd-suc { display: inline-flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); }
    .cd-tag--cad { color: var(--bad-soft-fg); background: var(--bad-soft-bg); border-color: var(--bad-border); }
    .cd-tag--recod { color: var(--warn-soft-fg); background: var(--warn-soft-bg); border-color: var(--warn-border); }

    /* [NP.22] Productos nuevos: los resultados del lanzamiento y sus dos columnas */
    .cn-res { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1); margin: 0 0 var(--sp-2); }
    .cn-sep { width: 1px; align-self: stretch; margin: 0 var(--sp-1); background: var(--border-color); }
    .cn-chip { display: inline-flex; align-items: center; gap: var(--sp-1); min-height: 2rem; padding: 0 var(--sp-3);
      border: 1px solid var(--border-color); border-radius: var(--r-pill); background: var(--card-bg); color: var(--text-main);
      font: inherit; font-size: var(--fs-sm); cursor: pointer; }
    .cn-chip:hover { background: var(--overlay-hover); }
    .cn-chip.is-sel { background: var(--overlay-selected); border-color: var(--action); font-weight: var(--fw-bold); }
    .cn-chip:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .cn-chip .pi { font-size: var(--fs-xs); }
    .cn-tono-ok .pi { color: var(--ok-fg); }
    .cn-tono-warn .pi { color: var(--warn-fg); }
    .cn-tono-bad .pi { color: var(--bad-fg); }
    .cn-tono-info .pi, .cn-tono-muted .pi { color: var(--text-muted); }
    .cn-nota { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin: 0 0 var(--sp-2); font-size: var(--fs-xs); color: var(--text-muted); }
    .cn-nota span { flex: 1 1 18rem; }
    .cn-fun { min-width: 11rem; max-width: 18rem; }
    .cn-motivo { display: block; margin-top: var(--sp-1); font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.35; white-space: normal; }
    .cn-dia { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-weight: var(--fw-bold); color: var(--text-main); white-space: nowrap; }
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
      .cs-fila > td.cs-cos { text-align: left; }
      .cs-fila > td.cn-d { display: flex; gap: var(--sp-2); align-items: baseline; }
      .cs-fila > td.cn-d::before { content: 'Día'; color: var(--text-muted); font-size: var(--fs-xs); }
      .cs-fila > td.cn-d .cn-motivo { display: inline; margin: 0; }
      .cs-fila > td.cs-cos::before { content: 'Último costo, sin IVA ni IEPS'; display: block; color: var(--text-muted); font-size: var(--fs-xs); }
      .cs-cos .cs-lin { justify-content: flex-start; }
      .cs-m-ud { display: inline; }
      .cs-fila > td.cd-mes { display: flex; gap: var(--sp-2); align-items: baseline; text-align: left; }
      .cs-fila > td.cd-mes::before { content: 'Este mes'; color: var(--text-muted); font-size: var(--fs-xs); }
      .cd-mes-v, .cd-var { display: inline; }
    }
    @media (pointer: coarse) { .cs-sel, .cs-op, .cp-vista-btn, .cn-chip { min-height: 44px; } }
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

  // ── [NP.22] «Mostrar › Productos nuevos»: uno para las dos vistas, partido por el resultado del lanzamiento, en la URL ──
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  readonly resultados = RESULTADOS_LANZAMIENTO;
  readonly resultado = signal<ResultadoLanzamiento>('seguimiento');
  /** ¿Se está mostrando Productos nuevos en la vista de ahora? (Las dos vistas se mantienen iguales en esto.) */
  readonly nuevosActivo = computed(() => {
    const d = this.detallado();
    const s = this.mostrar();
    const dd = this.mostrarD();
    return d ? dd === 'nuevos' : s === 'nuevos';
  });
  /** Se pidió Productos nuevos y el servidor no lo pudo aplicar (sin calcular): se dice, la lista no se hace pasar por él. */
  readonly nuevosNoAplicado = computed(() => {
    const activo = this.nuevosActivo();
    const d = this.detallado();
    const l = this.lista();
    const ld = this.listaD();
    const cargando = d ? this.detRes.isLoading() : this.listaRes.isLoading();
    const aplicado = d ? ld?.mostrar : l?.mostrar;
    return activo && !cargando && aplicado !== undefined && aplicado !== 'nuevos';
  });
  private readonly conteosLanzamiento = computed(() => {
    const d = this.detallado();
    const l = this.lista();
    const ld = this.listaD();
    return (d ? ld?.conteos_lanzamiento : l?.conteos_lanzamiento) ?? null;
  });
  conteoResultado(id: ResultadoLanzamiento): string {
    const c = this.conteosLanzamiento();
    if (!c) return '';
    const v = c[id];
    return v === null || v === undefined ? 'sin medir' : new Intl.NumberFormat('es-MX').format(v);
  }
  elegirResultado(id: ResultadoLanzamiento): void { this.resultado.set(id); }
  tonoResultado(v: string | null): string { return v ? VEREDICTOS[v as keyof typeof VEREDICTOS]?.tono ?? 'muted' : 'muted'; }
  iconoResultado(v: string): string { return VEREDICTOS[v as keyof typeof VEREDICTOS]?.icon ?? ''; }
  funciono(f: { lanzamiento?: LanzamientoFila | null }) { return celdaFunciono(f.lanzamiento); }
  diaDe(f: { lanzamiento?: LanzamientoFila | null }) { return diaLanzamiento(f.lanzamiento); }
  severidad(tono: string): 'success' | 'warn' | 'danger' | 'info' | 'secondary' {
    return tono === 'ok' ? 'success' : tono === 'warn' ? 'warn' : tono === 'bad' ? 'danger' : tono === 'info' ? 'info' : 'secondary';
  }

  /** Entra o sale de Productos nuevos en LAS DOS vistas (cambiar de vista no lo pierde) y acomoda el orden de Detallado. */
  private ponerNuevos(activo: boolean): void {
    if (activo) {
      this.mostrar.set('nuevos');
      if (this.mostrarD() !== 'nuevos') {
        this.mostrarD.set('nuevos');
        // Lo que pide atención primero, como lo ordenaba Productos nuevos.
        this.ordenD.set({ col: 'lanzamiento', dir: 'asc' });
      }
      return;
    }
    if (this.mostrar() === 'nuevos') this.mostrar.set('todos');
    if (this.mostrarD() === 'nuevos') this.mostrarD.set('todos');
    if (this.ordenD().col === 'lanzamiento') this.ordenD.set({ col: 'mes', dir: 'desc' });
    this.resultado.set('seguimiento');
  }

  /** La URL manda al entrar (y si cambia por fuera: un enlace, el menú lateral): `?mostrar=nuevos&resultado=…`. */
  private aplicarUrl(mostrar: string | null, resultado: string | null): void {
    const quiere = mostrar === 'nuevos';
    if (quiere) {
      this.ponerNuevos(true);
      const r = resultadoValido(resultado);
      if (this.resultado() !== r) this.resultado.set(r);
    } else if (this.mostrar() === 'nuevos' || this.mostrarD() === 'nuevos') {
      this.ponerNuevos(false);
    }
  }

  /** Lo que se eligió se escribe en la URL (sin apilar historia): un marcador o un enlace abre lo mismo. */
  private escribirUrl(activo: boolean, r: ResultadoLanzamiento): void {
    const qp = this.route.snapshot.queryParamMap;
    const mostrar = activo ? 'nuevos' : null;
    const resultado = activo && r !== 'seguimiento' ? r : null;
    if ((qp.get('mostrar') ?? null) === mostrar && (qp.get('resultado') ?? null) === resultado) return;
    if (!activo && qp.get('mostrar') !== 'nuevos' && !qp.has('resultado')) return;
    void this.router.navigate([], {
      relativeTo: this.route, queryParams: { mostrar, resultado }, queryParamsHandling: 'merge', replaceUrl: true,
    });
  }

  // ── Búsqueda: una para las dos vistas ──
  busqueda = '';
  readonly busquedaSenal = signal('');
  onBusqueda(v: string): void { this.busqueda = v; this.buscarDebounced(v); }
  private readonly buscarDebounced = makeDebouncedSearch((v) => this.busquedaSenal.set((v || '').trim()));
  limpiarBusqueda(): void { this.busqueda = ''; this.busquedaSenal.set(''); }

  // ── Sencillo: la lista paginada por el servidor ──
  readonly opcionesMostrar = OPCIONES_MOSTRAR;
  readonly mostrar = signal<MostrarSencillo>('todos');
  readonly tamanoSencillo = signal(PAGINA_SENCILLO);
  /** Otra búsqueda, otro «Mostrar» u otro resultado del lanzamiento vuelve a la página 1. */
  readonly pagina = linkedSignal({ source: () => ({ q: this.busquedaSenal(), m: this.mostrar(), r: this.resultado() }), computation: () => 1 });
  readonly onPagina = makeLazyLoad(this.pagina, this.tamanoSencillo, () => undefined);
  readonly listaRes = rxResource({
    params: () => {
      const r = this.resultado();
      return this.detallado()
        ? undefined
        : { search: this.busquedaSenal(), mostrar: this.mostrar(), resultado: r, page: this.pagina(), pageSize: this.tamanoSencillo(), v: this.recarga() };
    },
    // [NP.22] Productos nuevos lo filtra el servidor de Detallado (el único que sabe del lanzamiento); los renglones son
    // los mismos de Sencillo y se pintan con sus columnas. Ordenado como Productos nuevos: lo que pide atención primero.
    stream: ({ params }) => (params.mostrar === 'nuevos'
      ? this.catalogoApi.detallado({
          search: params.search, mostrar: 'nuevos', resultado: params.resultado, orden: 'lanzamiento', dir: 'asc',
          page: params.page, pageSize: params.pageSize,
        }).pipe(map(listaSencilloDeDetallado))
      : this.catalogoApi.lista({ search: params.search, mostrar: params.mostrar, page: params.page, pageSize: params.pageSize })
        .pipe(map((l): ListaSencillo => l))),
  });
  /** Lo último que llegó: buscar o paginar no vacía la tabla mientras carga; una recarga que falla tampoco. */
  readonly lista = linkedSignal<ListaSencillo | undefined, ListaSencillo | null>({
    source: () => (this.listaRes.error() ? undefined : this.listaRes.value()),
    computation: (nuevo, previo) => nuevo ?? previo?.value ?? null,
  });
  readonly filasSencillo = computed<FilaCatalogoProducto[]>(() => this.lista()?.filas ?? []);
  readonly totalSencillo = computed(() => this.lista()?.total ?? 0);
  /** `[PF.12.3]` La columna «Último costo» sólo si el servidor la manda (lo decide `puedeVerCostoCatalogo`). */
  readonly costoVisible = computed(() => this.lista()?.costo_visible === true);
  /** `[PF.12.3]` false = el servidor no pudo leer el costo ahora: las celdas dicen «Sin dato». */
  readonly costoMedido = computed(() => this.lista()?.costo_medido !== false);
  readonly listaCargando = computed(() => this.listaRes.isLoading() && !this.lista());
  readonly listaError = computed(() => (this.listaRes.error() && !this.lista() ? 'Revisa la conexión y vuelve a intentar.' : null));
  readonly listaVacia = computed(() => !!this.lista() && !this.listaRes.isLoading() && this.filasSencillo().length === 0);
  readonly vacioTitulo = computed(() => {
    const q = this.busquedaSenal();
    if (q && !this.lista()?.conteos.todos) return '«' + q + '» no está en el catálogo';
    return vacioNuevos(this.mostrar(), this.resultado())?.titulo ?? (this.mostrar() !== 'todos' ? 'Ningún producto con este filtro' : 'Sin productos activos');
  });
  readonly vacioPista = computed(() => {
    const q = this.busquedaSenal();
    if (q && !this.lista()?.conteos.todos) {
      return 'Se buscó en nombre, SKU, todos los códigos de barras, proveedor y unidades. Prueba con menos palabras o con el código.';
    }
    return vacioNuevos(this.mostrar(), this.resultado())?.pista ?? (this.mostrar() !== 'todos' ? 'Cambia «Mostrar» a Todos para ver el resto.' : null);
  });
  readonly opcionMostrar = computed(() => OPCIONES_MOSTRAR.find((o) => o.id === this.mostrar()) ?? OPCIONES_MOSTRAR[0]);
  /**
   * El conteo de una opción: número, «sin medir» (null del servidor), o nada mientras no hay respuesta. `[NP.22]`
   * «Productos nuevos» sin medir se puede elegir igual: su lista la calcula Detallado, que sí espera a tenerlo.
   */
  conteoTexto(id: MostrarSencillo): string {
    const c = this.lista()?.conteos;
    if (!c) return '';
    const v = c[OPCIONES_MOSTRAR.find((o) => o.id === id)!.conteo];
    return v === null || v === undefined ? 'sin medir' : new Intl.NumberFormat('es-MX').format(v);
  }
  /** «Alguna unidad sin precio» no se puede medir sin precio por sucursal: se declara y no se elige. */
  noMedible(id: MostrarSencillo): boolean {
    const c = this.lista()?.conteos;
    return id === 'sin_precio' && !!c && c.sinPrecio === null;
  }

  // ── Detallado: la lista paginada, filtrada, contada y ordenada por el servidor ──
  readonly gruposDetallado = GRUPOS_DETALLADO;
  readonly mostrarD = signal<FiltroDetallado>('todos');
  /** Default: lo que más vende este mes primero (como la maqueta aprobada). */
  readonly ordenD = signal<{ col: OrdenDetallado; dir: DireccionOrden }>({ col: 'mes', dir: 'desc' });
  readonly tamanoDetallado = signal(PAGINA_SENCILLO);
  /** `[PF.21]` La sucursal del precio que eligió la persona (null = la que diga el servidor). Cambiarla vuelve a la página 1. */
  readonly sucursalD = signal<string | null>(null);
  readonly paginaD = linkedSignal({
    source: () => ({ q: this.busquedaSenal(), m: this.mostrarD(), o: this.ordenD(), r: this.resultado(), s: this.sucursalD() }), computation: () => 1,
  });
  readonly onPaginaD = makeLazyLoad(this.paginaD, this.tamanoDetallado, () => undefined);
  readonly detRes = rxResource({
    params: () => {
      const r = this.resultado();
      return this.detallado()
        ? { search: this.busquedaSenal(), mostrar: this.mostrarD(), resultado: r, orden: this.ordenD(), page: this.paginaD(), pageSize: this.tamanoDetallado(), suc: this.sucursalD(), v: this.recarga() }
        : undefined;
    },
    stream: ({ params }) => this.catalogoApi.detallado({
      search: params.search, mostrar: params.mostrar, orden: params.orden.col, dir: params.orden.dir, page: params.page, pageSize: params.pageSize,
      ...(params.suc ? { sucursal: params.suc } : {}),
      ...(params.mostrar === 'nuevos' ? { resultado: params.resultado } : {}),
    }),
  });
  readonly listaD = linkedSignal<CatalogoListaDetallada | undefined, CatalogoListaDetallada | null>({
    source: () => (this.detRes.error() ? undefined : this.detRes.value()),
    computation: (nuevo, previo) => nuevo ?? previo?.value ?? null,
  });
  readonly filasDetallado = computed<FilaCatalogoDetallada[]>(() => this.listaD()?.filas ?? []);
  /** `[PF.21]` Las sucursales de tu alcance, como «01 · Padre Hidalgo». */
  readonly opcionesSucursalD = computed(() =>
    (this.listaD()?.sucursales ?? []).map((s) => ({ label: `${s.codigo} · ${nombrePropio(s.nombre)}`, value: s.codigo })));
  nombreSucursalD(codigo: string): string {
    return this.opcionesSucursalD().find((o) => o.value === codigo)?.label || warehouseName(codigo) || codigo;
  }
  elegirSucursalD(codigo: string | null): void { if (codigo) this.sucursalD.set(codigo); }
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
  /** `[PF.12.3]` La columna «Último costo» de Detallado, con la misma regla que Sencillo (la decide el servidor). */
  readonly costoVisibleD = computed(() => this.listaD()?.costo_visible === true);
  readonly costoMedidoD = computed(() => this.listaD()?.costo_medido !== false);
  readonly vacioTituloD = computed(() => {
    const q = this.busquedaSenal();
    const l = this.listaD();
    if (q && !l?.conteos.todos) return '«' + q + '» no está en el catálogo';
    return vacioNuevos(this.mostrarAplicado(), this.resultado())?.titulo
      ?? (this.mostrarAplicado() !== 'todos' ? 'Ningún producto con este filtro' : 'Sin productos activos');
  });
  readonly vacioPistaD = computed(() => {
    const q = this.busquedaSenal();
    const l = this.listaD();
    if (q && !l?.conteos.todos) {
      return 'Se buscó en nombre, SKU, todos los códigos de barras, proveedor y unidades. Prueba con menos palabras o con el código.';
    }
    return vacioNuevos(this.mostrarAplicado(), this.resultado())?.pista
      ?? (this.mostrarAplicado() !== 'todos' ? 'Cambia «Mostrar» a Todos para ver el resto.' : null);
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
    if (id === 'nuevos') this.ponerNuevos(true);
    else {
      if (this.mostrarD() === 'nuevos') this.ponerNuevos(false);
      this.mostrarD.set(id);
    }
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
    // [NP.22] Si el servidor midió «nuevo» y el renglón trae la llave, la ficha sabe si es nuevo sin preguntar.
    const sabe = f.lanzamiento !== undefined && this.listaD()?.etiquetas.nuevo === true;
    this.abierto.set({
      id: f.id, nombre: this.nombreFila(f), sku: f.sku, proveedor: f.proveedor ? nombreProveedor(f.proveedor.nombre) : null, tipo: 'detallado',
      etiquetas: { lider: f.lider, nuevo: f.nuevo, caducidad: f.caducidad },
      esNuevo: sabe ? !!f.lanzamiento : null,
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
  elegirMostrar(id: MostrarSencillo): void {
    if (this.noMedible(id)) return;
    if (id === 'nuevos') this.ponerNuevos(true);
    else {
      if (this.mostrar() === 'nuevos') this.ponerNuevos(false);
      this.mostrar.set(id);
    }
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
  /** `[PF.20]` La regla única del contrato: Kepler marca el descontinuado en el nombre. */
  esDescontinuado(f: Pick<FilaCatalogoProducto, 'nombre'>): boolean { return esNombreDescontinuado(f.nombre); }
  /** El nombre sin la marca; `''` = Kepler no dejó otro nombre (la pantalla lo dice). */
  nombreSinMarca(f: Pick<FilaCatalogoProducto, 'nombre'>): string { return nombrePropio(nombreSinMarcaDescontinuado(f.nombre)); }
  equivale(u: UnidadPrecio): string { return equivaleTexto(u); }
  precio(v: number): string { return dineroFicha(v) ?? ''; }
  /** `[PF.12.3]` La celda de las DOS vistas: misma función, cada una con su «se pudo leer». */
  costoDe(f: FilaCatalogoProducto, medido: boolean): CeldaCosto { return celdaCosto(f.ultimoCosto, medido); }
  readonly provNombre = nombreProveedor;
  abrirFicha(f: FilaCatalogoProducto & { lanzamiento?: LanzamientoFila | null }): void {
    this.abierto.set({
      id: f.id, nombre: this.nombreFila(f), sku: f.sku, proveedor: f.proveedor ? nombreProveedor(f.proveedor.nombre) : null, tipo: 'ficha',
      // [NP.22] Con Productos nuevos el renglón lo dice; sin el filtro no se sabe y la ficha lo pregunta.
      esNuevo: f.lanzamiento ? true : null,
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
    // [NP.22] La URL manda al entrar y cuando cambia por fuera (un enlace viejo a /compras/catalogo/nuevos llega aquí
    // con ?mostrar=nuevos); lo que se elige en pantalla se escribe de vuelta, sin apilar historia.
    const sub = this.route.queryParamMap.subscribe((qp) => this.aplicarUrl(qp.get('mostrar'), qp.get('resultado')));
    this.destroyRef.onDestroy(() => sub.unsubscribe());
    effect(() => {
      const activo = this.nuevosActivo();
      const r = this.resultado();
      untracked(() => this.escribirUrl(activo, r));
    });
  }

  refresh(): void { this.recarga.update((n) => n + 1); }
}
