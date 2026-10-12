import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, FormsModule, ReactiveFormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { TextareaModule } from 'primeng/textarea';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageService } from 'primeng/api';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ComercialService, Product, ProductStats, UpdateProductDto } from '../../comercial/comercial.service';
import { makeDebouncedSearch } from '../../../shared/util';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { CATALOGO_TABS } from '../catalogo-tabs';
import { avisoDePrecio } from '../catalogo-precio-aviso';
import { ProductosNuevosService } from '../productos-nuevos.service';
import {
  CuidarRespuesta, FlujoLista, FlujoResumen, MotivoLider, NoSeVende, ProductoACuidar, ProductosFlujoService,
  ProductosProveedorRespuesta, ProveedorFlujo, ProveedoresRespuesta, TramoSinVenta, VeredictoCompra,
} from '../productos-flujo.service';
import {
  FILTRO_TEXTO, FilaCatalogo, FiltroCatalogo, OrdenCatalogo, coberturaAncho, coberturaTexto, contarFiltros, dineroCorto,
  filaDeResumen, filtrarYOrdenar, nombrePropio, nombreProveedor,
} from '../catalogo-proveedor';
import { coincideBusqueda } from '@megadulces/ui-web';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import {
  ProductoFlujoPanelComponent, VEREDICTO_CLASE, cantidadEnCajas, diasTexto, dinero, fechaCorta, margenTexto, variacionTexto,
} from './producto-flujo-panel.component';
import { catchError, of } from 'rxjs';

/** `[PF.1]` La situacion de compra en una palabra o dos, para la tabla. */
export const VEREDICTO_CORTO: Record<VeredictoCompra, string> = {
  comprar: 'Comprar', traspasar: 'Mover entre sucursales', esperar: 'Esperar', sobra: 'Sobra',
  no_comprar: 'No comprar', sin_movimiento: 'Sin movimiento',
};

/** `[PF.1]` "Estancado en 2 · Agotado en 1 · Caducado en 1" (o NULL si todo se mueve). */
export function alertasTexto(f: Pick<FlujoResumen, 'estancadas' | 'agotadas' | 'frenadas'> & Partial<Pick<FlujoResumen, 'caducidad'>>): string | null {
  const c = f.caducidad;
  const partes = [
    c && c.vencido > 0 ? `Caducado en ${c.plazas_vencido.length}` : null,
    c && c.en_riesgo > 0 ? `Caduca sin venderse en ${c.plazas_en_riesgo.length}` : null,
    f.estancadas.length ? `Estancado en ${f.estancadas.length}` : null,
    f.agotadas.length ? `Agotado en ${f.agotadas.length}` : null,
    f.frenadas.length ? `Se frenó en ${f.frenadas.length}` : null,
  ].filter((x): x is string => !!x);
  return partes.length ? partes.join(' · ') : null;
}

/** `[PF.2]` Por qué pide atención un líder, en palabras. */
export const MOTIVO_LIDER: Record<MotivoLider, string> = {
  agotado: 'Agotado en alguna sucursal', comprar: 'Comprar', mover: 'Mover entre sucursales', se_freno: 'Se frenó la venta',
};

/** `[PF.3]` La situación de caducidad de un producto en una frase, para "Para cuidar hoy". */
export function caducidadTexto(c: NonNullable<FlujoResumen['caducidad']>): { estado: 'caducado' | 'no_alcanza' | 'justo'; texto: string } {
  if (c.vencido > 0) return { estado: 'caducado', texto: `Caducado según el registro en ${c.plazas_vencido.join(', ')}` };
  if (c.en_riesgo > 0) return { estado: 'no_alcanza', texto: `No alcanza a venderse en ${c.plazas_en_riesgo.join(', ')}` };
  return { estado: 'justo', texto: 'Caduca pronto: ponerlo al frente' };
}

/** `[PF.4]` El tramo de días sin venta, en palabras. */
export const TRAMO_TEXTO: Record<TramoSinVenta, string> = {
  mes: '30 a 89 días', trimestre: '90 días o más', anio: 'Sin venta en el año',
};

/** `[PF.4]` "Sin vender hace 45 días" / "Sin una venta en el último año". */
export function sinVenderTexto(x: Pick<NoSeVende, 'dias_sin_venta'>, ventana: number): string {
  return x.dias_sin_venta === null
    ? (ventana >= 365 ? 'Sin una venta en el último año' : 'Sin una venta en ' + ventana + ' días')
    : 'Sin vender hace ' + x.dias_sin_venta + ' días';
}

/** Lo que se abre en el panel lateral. */
interface AbiertoFlujo {
  id: string;
  nombre: string | null;
  sku: string | null;
  /** El proveedor, para el subtítulo (desde un proveedor o desde la búsqueda). */
  proveedor?: string | null;
}

/** El proveedor que se eligió la última vez, para volver a él (sólo comodidad de este navegador). */
const CLAVE_PROVEEDOR = 'compras.catalogo.proveedor';
const leerGuardado = (): string | null => { try { return localStorage.getItem(CLAVE_PROVEEDOR); } catch { return null; } };
const guardar = (id: string) => { try { localStorage.setItem(CLAVE_PROVEEDOR, id); } catch { /* sin almacenamiento: no pasa nada */ } };

/** El id que el servidor usa para los productos sin proveedor. */
export const SIN_PROVEEDOR = 'sin';

@Component({
  selector: 'app-compras-catalogo',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ReactiveFormsModule,
    ButtonModule,
    DialogModule,
    InputTextModule,
    InputNumberModule,
    TextareaModule,
    ToggleSwitchModule,
    ToastModule,
    TooltipModule,
    SkeletonModule,
    PageTabsComponent,
    SidePeekComponent,
    ProductoFlujoPanelComponent,
  ],
  providers: [MessageService],
  template: `
    <div class="surf-page cp">
      <p-toast></p-toast>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Catálogo de productos</h1>
          <p class="surf-page-sub">
            @if (stats(); as s) { <b>{{ s.active | number }}</b> productos activos }
            @if (proveedoresLista().length) {
              <span class="cp-divider" aria-hidden="true">·</span> {{ proveedoresLista().length }} proveedores
            }
            <span class="cp-divider" aria-hidden="true">·</span> venta del 1 a hoy contra los mismos días del mes anterior, en vivo
          </p>
        </div>
        <div class="cp-head-actions">
          <div class="cp-seg" role="tablist" aria-label="Qué ver">
            <button type="button" role="tab" class="cp-seg-btn" [class.is-on]="vista() === 'proveedor'" [attr.aria-selected]="vista() === 'proveedor'"
              (click)="vista.set('proveedor')">Por proveedor</button>
            <button type="button" role="tab" class="cp-seg-btn" [class.is-on]="vista() === 'cuidar'" [attr.aria-selected]="vista() === 'cuidar'"
              (click)="vista.set('cuidar')">Para cuidar hoy
              @if (pendientesCuidar(); as n) { <span class="cp-seg-n" pTooltip="Líderes que piden atención y productos que caducan antes de venderse">{{ n }}</span> }</button>
          </div>
          <button pButton [text]="true" severity="secondary" size="small" (click)="refresh()" [loading]="cargandoAlgo()" pTooltip="Actualizar ahora" aria-label="Actualizar">
            <span class="p-button-icon pi pi-refresh" aria-hidden="true"></span></button>
        </div>
      </header>

      <app-page-tabs [tabs]="tabs" />

      <!--
        De donde sale el precio y que tan viejo es. Va arriba y sin boton de cerrar porque es una
        condicion del dato, no el resultado de una accion. (Sin acentos graves aca adentro: cierran el
        template literal de JS.)
      -->
      @if (avisoPrecio(); as a) {
        <div class="cp-aviso" [class.cp-aviso-warn]="a.viejo" role="status">
          <i [class]="a.viejo ? 'pi pi-clock' : 'pi pi-info-circle'" aria-hidden="true"></i>
          <div><strong>{{ a.titulo }}</strong> <span>{{ a.detalle }}</span></div>
        </div>
      }

      @if (vista() === 'proveedor') {
        <!-- Buscar en todo el catalogo: si hay texto, la tabla muestra lo encontrado en vez del proveedor. -->
        <div class="cp-buscar">
          <i class="pi pi-search" aria-hidden="true"></i>
          <input type="search" [value]="busqueda" (input)="onBusqueda($any($event.target).value)"
            placeholder="Buscar un producto en todo el catálogo: nombre, SKU o código de barras"
            inputmode="search" autocomplete="off" spellcheck="false" aria-label="Buscar en todo el catálogo" />
          @if (busqueda) {
            <button type="button" class="cp-x" (click)="limpiarBusqueda()" aria-label="Limpiar búsqueda"><i class="pi pi-times" aria-hidden="true"></i></button>
          }
        </div>

        <div class="cp-layout">
          <!-- Barra de proveedores -->
          <aside class="cp-rail" aria-label="Proveedores">
            <div class="cp-rail-head">
              <span class="cp-rail-t">Proveedores</span>
              <span class="cp-rail-sub">por venta del mes</span>
            </div>
            <div class="cp-rail-filtro">
              <i class="pi pi-filter" aria-hidden="true"></i>
              <input type="search" [ngModel]="filtroProveedor()" (ngModelChange)="filtroProveedor.set($event)"
                placeholder="Filtrar proveedores" aria-label="Filtrar proveedores" autocomplete="off" />
            </div>
            @if (proveedoresRes.value() === undefined && !proveedoresRes.error()) {
              <div class="cp-rail-lista">
                @for (i of esqueleto10; track i) { <div class="cp-rail-sk"><p-skeleton height="2.4rem"></p-skeleton></div> }
              </div>
            } @else if (proveedoresRes.error() && !proveedoresLista().length) {
              <p class="cp-nota" role="alert">No se pudieron cargar los proveedores.</p>
            } @else {
              <ul class="cp-rail-lista" role="listbox" aria-label="Elegir proveedor">
                @if (sinProveedor(); as sp) {
                  <li>
                    <button type="button" role="option" class="cp-prov is-sin" [class.is-on]="activo() === SIN" [attr.aria-selected]="activo() === SIN"
                      (click)="elegir(SIN)">
                      <span class="cp-prov-nom"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> Sin proveedor asignado</span>
                      <span class="cp-prov-det">{{ sp.productos | number }} productos · {{ sp.con_venta }} vendieron este mes</span>
                    </button>
                  </li>
                }
                @for (p of proveedoresVista(); track p.supplier_id) {
                  <li>
                    <button type="button" role="option" class="cp-prov" [class.is-on]="activo() === p.supplier_id" [attr.aria-selected]="activo() === p.supplier_id"
                      (click)="elegir(p.supplier_id!)">
                      <span class="cp-prov-fila">
                        <span class="cp-prov-nom" [title]="p.nombre">{{ provNombre(p.nombre) }}</span>
                        <span class="cp-prov-mes">{{ corto(p.mes) }}</span>
                      </span>
                      <span class="cp-prov-fila">
                        <span class="cp-prov-det">{{ p.productos | number }} productos</span>
                        @if (p.variacion !== null) {
                          <span class="cp-prov-var" [class.is-up]="p.variacion > 0" [class.is-down]="p.variacion < 0">{{ variacion(p.variacion) }}</span>
                        }
                      </span>
                    </button>
                  </li>
                } @empty {
                  <li class="cp-nota">Ningún proveedor con ese nombre.</li>
                }
              </ul>
            }
          </aside>

          <!-- Lo elegido -->
          <section class="cp-main" [attr.aria-busy]="cargandoTabla()">
            @if (busquedaActiva()) {
              <header class="cp-prov-head">
                <div>
                  <h2 class="cp-h2">Resultados de «{{ busquedaSenal() }}»</h2>
                  <p class="cp-sub">
                    @if (busquedaTotal() > filasBusqueda().length) { Se muestran {{ filasBusqueda().length }} de {{ busquedaTotal() | number }}; escribe más para afinar. }
                    @else { {{ busquedaTotal() | number }} producto{{ busquedaTotal() === 1 ? '' : 's' }} en todo el catálogo. }
                  </p>
                </div>
              </header>
            } @else if (proveedorDatos(); as d) {
              <header class="cp-prov-head">
                <div class="cp-prov-head-t">
                  <h2 class="cp-h2" [title]="d.proveedor.nombre">{{ d.proveedor.supplier_id ? provNombre(d.proveedor.nombre) : 'Sin proveedor asignado' }}</h2>
                  <p class="cp-sub">
                    {{ d.resumen.productos | number }} productos activos
                    <span class="cp-divider" aria-hidden="true">·</span> calculado a las {{ horaCorta(d.en_vivo_al) }}
                  </p>
                  @if (!d.proveedor.supplier_id) {
                    <p class="cp-alerta-sin">Estos productos no tienen proveedor en Kepler: nadie los está pidiendo. Se asignan en Kepler, en la ficha del producto.</p>
                  }
                </div>
                <dl class="cp-kpis">
                  <div class="cp-kpi">
                    <dt>Venta del mes</dt>
                    <dd>{{ dinero(d.resumen.mes) }}
                      @if (d.resumen.variacion !== null) {
                        <small [class.is-up]="d.resumen.variacion > 0" [class.is-down]="d.resumen.variacion < 0"
                          [pTooltip]="'Mismos días del mes anterior: ' + dinero(d.resumen.mes_anterior_mismo)">{{ variacion(d.resumen.variacion) }}</small>
                      }
                    </dd>
                  </div>
                  <div class="cp-kpi is-comprar"><dt>Para comprar</dt><dd>{{ d.resumen.por_veredicto.comprar }}</dd></div>
                  <div class="cp-kpi"><dt>Agotados en alguna sucursal</dt><dd>{{ d.resumen.agotados }}</dd></div>
                  <div class="cp-kpi"><dt>Líderes</dt><dd>{{ d.resumen.lideres }}</dd></div>
                </dl>
              </header>
            } @else if (proveedorError()) {
              <p class="cp-nota" role="alert">No se pudieron cargar los productos de este proveedor. Se vuelve a intentar en un minuto.</p>
            } @else {
              <header class="cp-prov-head"><div class="cp-prov-head-t">
                <p-skeleton width="16rem" height="1.6rem"></p-skeleton>
                <p class="cp-sub">Analizando sus productos sucursal por sucursal…</p>
              </div></header>
            }

            <!-- Filtros de la tabla -->
            <div class="cp-barra">
              <div class="cp-chips" role="group" aria-label="Filtrar por situación">
                <!-- Mientras carga no se cuenta nada: un "Todos 0" diria que el proveedor no tiene productos. -->
                @for (f of (cargandoTabla() && !filasBase().length ? [] : filtros); track f) {
                  @if (f === 'todos' || conteos()[f]) {
                    <button type="button" class="cp-chip" [ngClass]="'f-' + f" [class.is-on]="filtro() === f" [attr.aria-pressed]="filtro() === f"
                      (click)="filtro.set(f)">{{ filtroTexto(f) }} <span class="cp-chip-n">{{ conteos()[f] }}</span></button>
                  }
                }
              </div>
              <div class="cp-barra-der">
                @if (!busquedaActiva()) {
                  <div class="cp-dentro">
                    <i class="pi pi-search" aria-hidden="true"></i>
                    <input type="search" [ngModel]="textoTabla()" (ngModelChange)="textoTabla.set($event)"
                      placeholder="En este proveedor" aria-label="Buscar en este proveedor" autocomplete="off" />
                  </div>
                }
                <label class="cp-orden">Ordenar
                  <select [ngModel]="orden()" (ngModelChange)="orden.set($event)" aria-label="Ordenar">
                    <option value="venta">Más venta</option>
                    <option value="cobertura">Se acaba primero</option>
                    <option value="nombre">Nombre</option>
                  </select>
                </label>
              </div>
            </div>

            <!-- La tabla: un renglon por producto, en palabras. -->
            <div class="cp-tabla" role="table" aria-label="Productos" [class.con-margen]="costoVisible()">
              <div class="cp-tr cp-th" role="row">
                <span role="columnheader">Producto</span>
                <span role="columnheader" class="cp-num" pTooltip="Venta con impuestos del 1 a hoy, contra los mismos días del mes anterior.">Este mes</span>
                <span role="columnheader" pTooltip="Para cuántos días alcanza la existencia de toda la red al ritmo de los últimos 30 días.">Alcanza para</span>
                @if (costoVisible()) {
                  <span role="columnheader" class="cp-num" pTooltip="Margen real de los últimos 30 días cerrados: venta sin IVA ni IEPS contra el costo que Kepler registró en cada venta.">Margen</span>
                }
                <span role="columnheader">Qué hacer</span>
                <span role="columnheader"><span class="sr-only">Abrir</span></span>
              </div>
              @if (cargandoTabla() && !filasVista().length) {
                @for (i of esqueleto10; track i) {
                  <div class="cp-tr cp-sk" role="row"><p-skeleton height="2.6rem"></p-skeleton></div>
                }
              } @else {
                @for (f of filasVista(); track f.product_id) {
                  <div class="cp-tr cp-fila" role="row" tabindex="0" (click)="abrir(f)" (keydown.enter)="abrir(f)"
                    (keydown.space)="$event.preventDefault(); abrir(f)" [attr.aria-label]="'Ver cómo se vende ' + nombre(f)">
                    <span role="cell" class="cp-prod">
                      <span class="cp-prod-nom" [title]="f.nombre || ''">{{ nombre(f) }}</span>
                      <span class="cp-prod-det">
                        <code>{{ f.sku }}</code>
                        @if (f.lider; as l) { <span class="cp-tag is-lider" pTooltip="Entre los productos que juntos hacen la mitad de la venta de la red en 90 días">Líder #{{ l.rank }}</span> }
                        @if (nuevo(f.product_id); as nv) { <span class="cp-tag is-nuevo">{{ nv }}</span> }
                        @if (f.caducidad && (f.caducidad.vencido > 0 || f.caducidad.en_riesgo > 0)) {
                          <span class="cp-tag is-cad">{{ f.caducidad.vencido > 0 ? 'Caducado' : 'Caduca antes de venderse' }}</span>
                        }
                      </span>
                    </span>
                    <span role="cell" class="cp-num cp-mes">
                      <span>{{ f.mes ? dinero(f.mes) : '—' }}</span>
                      @if (f.variacion !== null) {
                        <small [class.is-up]="f.variacion > 0" [class.is-down]="f.variacion < 0">{{ variacion(f.variacion) }}</small>
                      }
                    </span>
                    <span role="cell" class="cp-cob">
                      @let ancho = cobAncho(f.cobertura_dias);
                      <span class="cp-cob-txt">{{ cobTexto(f.cobertura_dias) }}</span>
                      @if (ancho !== null) {
                        <span class="cp-cob-barra" aria-hidden="true"><span [ngClass]="claseVeredicto(f.veredicto)" [style.width.%]="ancho"></span></span>
                      }
                    </span>
                    @if (costoVisible()) {
                      <span role="cell" class="cp-num">
                        @if (f.margen_real?.pct != null) {
                          <span class="cp-margen" [class.is-down]="f.margen_real!.pct! < 0">{{ margenTxt(f.margen_real) }}</span>
                          @if ((f.margen_real!.cobertura ?? 0) < 0.995) { <small>cubre {{ pct(f.margen_real!.cobertura) }}</small> }
                        } @else { <span class="cp-tenue">—</span> }
                      </span>
                    }
                    <span role="cell" class="cp-que">
                      <span class="cp-ver" [ngClass]="claseVeredicto(f.veredicto)" [pTooltip]="f.titulo">{{ veredictoCorto(f.veredicto) }}</span>
                      <span class="cp-motivo">{{ f.motivo }}</span>
                    </span>
                    <span role="cell" class="cp-chev"><i class="pi pi-chevron-right" aria-hidden="true"></i></span>
                  </div>
                } @empty {
                  <div class="cp-vacio" role="row">
                    @if (busquedaActiva()) { Ningún producto con «{{ busquedaSenal() }}». }
                    @else if (filtro() !== 'todos' || textoTabla()) { Nada con este filtro. <button type="button" class="cp-link" (click)="quitarFiltros()">Ver todos</button> }
                    @else if (proveedorDatos()) { Este proveedor no tiene productos activos. }
                  </div>
                }
              }
            </div>
          </section>
        </div>
      }

      @if (vista() === 'cuidar') {
        <!-- [PF.2]/[PF.4] Para cuidar hoy: de un lado los lideres, del otro lo que no se vende (con lo que caduca). -->
        @if (cuidar(); as c) {
          @if (c.origen; as o) {
            <p class="pc-meta pc-origen" [class.is-vivo]="o.fuente === 'en_vivo'">
              @if (o.fuente === 'foto') { Calculado a las {{ horaCorta(o.calculado_at) }}; se actualiza cada minuto. }
              @else { Calculado en vivo a las {{ horaCorta(o.calculado_at) }}: la foto del servidor no está al día. }
            </p>
          }
          <section class="pc" aria-label="Para cuidar hoy">
            <article class="pc-card">
              <header class="pc-head">
                <h2 class="pc-t">Líderes</h2>
                <span class="pc-n">{{ c.lideres.total }} productos hacen la mitad de la venta</span>
              </header>
              <div class="pc-chips" role="group" aria-label="Filtrar líderes">
                <button type="button" class="pc-chip" [class.is-on]="motivo() === null" (click)="motivo.set(null)">Todos · {{ c.lideres.lista.length }}</button>
                @for (m of motivos; track m) {
                  @if (c.lideres.por_motivo[m]) {
                    <button type="button" class="pc-chip" [class.is-on]="motivo() === m" (click)="motivo.set(m)">{{ motivoTexto(m) }} · {{ c.lideres.por_motivo[m] }}</button>
                  }
                }
              </div>
              @if (lideresVista(); as ls) {
                <ul class="pc-lista">
                  @for (x of ls; track x.resumen.product_id) {
                    <li>
                      <button type="button" class="pc-item" (click)="abrirCuidar(x)">
                        <span class="pc-rank">#{{ x.resumen.lider?.rank }}</span>
                        <span class="pc-cuerpo">
                          <span class="pc-nom">{{ propio(x.nombre) || x.sku }}</span>
                          <span class="pc-det">
                            <span class="cp-ver" [ngClass]="claseVeredicto(x.resumen.compra.veredicto)">{{ x.resumen.compra.titulo }}</span>
                            @if (x.resumen.agotadas.length) { <span>Agotado en {{ nombresDe(x.resumen.agotadas) }}</span> }
                            @if (x.resumen.margen_real?.pct != null) { <span class="pc-margen">Margen {{ margenTxt(x.resumen.margen_real) }}</span> }
                          </span>
                        </span>
                        <span class="pc-dinero">{{ dinero(x.resumen.mes) }}<small [class.is-up]="(x.resumen.variacion ?? 0) > 0" [class.is-down]="(x.resumen.variacion ?? 0) < 0">{{ variacion(x.resumen.variacion) }} este mes</small></span>
                      </button>
                    </li>
                  } @empty {
                    <li class="pc-vacio">Ningún líder por este motivo.</li>
                  }
                </ul>
                @if (lideresFiltrados().length > ls.length) {
                  <button type="button" class="pc-mas" (click)="verTodos.set(true)">Ver los {{ lideresFiltrados().length }}</button>
                }
              }
              <p class="pc-meta">Líder = está entre los productos que juntos hacen la mitad de la venta de la red en 90 días
                (nuestra venta, no participación de mercado), en orden de venta.
                @if (c.lideres.calculado) { Ranking al {{ hora(c.lideres.calculado) }}. }</p>
            </article>

            <article class="pc-card">
              <header class="pc-head">
                <h2 class="pc-t">No se venden</h2>
                <span class="pc-n">{{ c.no_se_venden.total }} productos
                  @if (c.no_se_venden.valor_total !== null) { · {{ dinero(c.no_se_venden.valor_total) }} detenidos }</span>
              </header>
              <div class="pc-chips" role="group" aria-label="Filtrar lo que no se vende">
                <button type="button" class="pc-chip" [class.is-on]="tramo() === null" (click)="tramo.set(null)">Todos · {{ c.no_se_venden.total }}</button>
                @for (t of tramos; track t) {
                  @if (c.no_se_venden.por_tramo[t]) {
                    <button type="button" class="pc-chip" [class.is-on]="tramo() === t" (click)="tramo.set(t)">{{ tramoTexto(t) }} · {{ c.no_se_venden.por_tramo[t] }}</button>
                  }
                }
                <button type="button" class="pc-chip pc-chip-cad" [class.is-on]="tramo() === 'caducidad'" (click)="tramo.set('caducidad')">Caducan antes de venderse · {{ c.caducidad.productos.length }}</button>
              </div>
              @if (tramo() === 'caducidad') {
                <ul class="pc-lista">
                  @for (x of c.caducidad.productos; track x.resumen.product_id) {
                    @let cad = caducidad(x);
                    <li>
                      <button type="button" class="pc-item" (click)="abrirCuidar(x)">
                        <span class="pc-cuerpo">
                          <span class="pc-nom">{{ propio(x.nombre) || x.sku }}</span>
                          <span class="pc-det"><span class="pc-cad" [ngClass]="'is-' + cad.estado">{{ cad.texto }}</span></span>
                        </span>
                        @if (x.resumen.caducidad?.proxima; as f) {
                          <span class="pc-fecha">{{ fecha(f) }}<small>{{ diasA(f) }}</small></span>
                        }
                      </button>
                    </li>
                  } @empty {
                    <li class="pc-vacio">Ningún lote registrado está por caducar sin venderse.</li>
                  }
                </ul>
                <p class="pc-meta">Sólo lo que tiene fecha registrada en el andén o en la revisión de caducidades:
                  {{ c.caducidad.cobertura.lotes }} lotes de {{ c.caducidad.cobertura.productos }} productos
                  @if (c.caducidad.cobertura.sucursales.length) { en {{ nombresDe(c.caducidad.cobertura.sucursales) }} }.
                  Lo que no tiene fecha registrada no aparece aquí, y eso no quiere decir que no caduque.</p>
              } @else {
                @if (noVendenVista(); as ns) {
                  <ul class="pc-lista">
                    @for (x of ns; track x.product_id) {
                      <li>
                        <button type="button" class="pc-item" (click)="abrirNoSeVende(x)">
                          <span class="pc-cuerpo">
                            <span class="pc-nom">{{ propio(x.nombre) || x.sku }}</span>
                            <span class="pc-det">
                              <span class="pc-sin">{{ sinVenderTexto(x) }}</span>
                              <span>Hay en {{ nombresDe(x.plazas) }}</span>
                              @if (x.caducidad && (x.caducidad.vencido > 0 || x.caducidad.en_riesgo > 0)) {
                                <span class="pc-cad is-no_alcanza">{{ caducidadTexto(x.caducidad).texto }}</span>
                              }
                            </span>
                          </span>
                          <span class="pc-dinero">
                            @if (x.valor !== null) { {{ dinero(x.valor) }}<small>{{ cajas(x.existencia, x.escalera) }}</small> }
                            @else { {{ cajas(x.existencia, x.escalera) }} }
                          </span>
                        </button>
                      </li>
                    } @empty {
                      <li class="pc-vacio">Nada en este tramo.</li>
                    }
                  </ul>
                  @if (noVendenFiltrados().length > ns.length) {
                    <button type="button" class="pc-mas" (click)="verTodosNV.set(true)">Ver los {{ noVendenFiltrados().length }}</button>
                  }
                }
                <p class="pc-meta">Con existencia y sin una sola venta en toda la red en {{ c.criterio.diasSinVenta }} días o más; primero
                  lo de más dinero detenido{{ c.no_se_venden.valor_total === null ? '' : ' (a costo estándar de Kepler)' }}.
                  @if (c.no_se_venden.nuevos_excluidos) { Fuera los productos nuevos de los últimos {{ c.criterio.ventanaNuevos }} días (tienen su pestaña). }
                  @else { <b>Pueden aparecer productos nuevos:</b> su seguimiento todavía no está calculado. }
                  @if (c.no_se_venden.total > c.no_se_venden.productos.length) { Se muestran los {{ c.no_se_venden.productos.length }} de más dinero. }</p>
              }
            </article>
          </section>
        } @else if (cuidarError()) {
          <p class="pc-meta" role="alert">No se pudo cargar «Para cuidar hoy».</p>
        } @else {
          <p-skeleton height="180px"></p-skeleton>
        }
      }

      <!-- [PF.1] Como se vende el producto: flujo contra el mes anterior, sucursales y si hace falta comprar. -->
      <app-side-peek [open]="abierto() !== null" (openChange)="$event ? null : cerrarFlujo()" [width]="880"
                     [title]="abierto()?.nombre || ''" [subtitle]="abierto() ? ((abierto()!.sku || '') + (abierto()!.proveedor ? ' · ' + abierto()!.proveedor : '')) : null">
        @if (abierto(); as a) {
          <div class="cp-peek-acciones">
            <button pButton size="small" severity="secondary" [outlined]="true" (click)="openEdit(a.id)">
              <span class="p-button-icon p-button-icon-left pi pi-pencil" aria-hidden="true"></span><span class="p-button-label">Editar producto</span></button>
          </div>
          <app-producto-flujo-panel [productId]="a.id" />
        }
      </app-side-peek>

      <!-- Edit Dialog -->
      <p-dialog
        [(visible)]="dialogVisible"
        [modal]="true"
        [draggable]="false"
        [style]="{ width: '560px' }"
        [header]="editing()?.nombre || 'Editar producto'"
        >
        @if (editing(); as e) {
          <div class="pp-edit-body">
            <div class="pp-edit-meta">
              <div><span class="comm-muted is-small">SKU</span> <code class="comm-code">{{ e.sku || '—' }}</code></div>
              @if (e.brand_name) {
                <div><span class="comm-muted is-small">Marca</span> <strong>{{ e.brand_name }}</strong></div>
              }
              @if (e.cost_base != null) {
                <div><span class="comm-muted is-small">Costo base</span> <strong>{{ e.cost_base | currency:'MXN':'symbol-narrow':'1.2-2' }}</strong></div>
              }
              @if (e.prices_count != null) {
                <div><span class="comm-muted is-small">Precios configurados</span> <strong>{{ e.prices_count }}</strong></div>
              }
              @if (e.total_available != null) {
                <div><span class="comm-muted is-small">Stock disponible</span> <strong>{{ fmtNumber(e.total_available) }}</strong></div>
              }
            </div>
            <form [formGroup]="form" class="comm-form">
              <label>
                <span>Descripción larga</span>
                <textarea pInputTextarea rows="3" formControlName="description" maxlength="500"></textarea>
                <span class="comm-muted is-small">Visible en el Portal y la app de vendedores en hover sobre el nombre.</span>
              </label>
              <div class="pp-form-row">
                <label>
                  <span>Ubicación</span>
                  <input pInputText formControlName="location" maxlength="20" placeholder="ej: Z000" />
                </label>
                <label>
                  <span>Ubicación bodega</span>
                  <input pInputText formControlName="location_warehouse" maxlength="20" placeholder="ej: B-12" />
                </label>
              </div>
              <label>
                <span>Puntos de fidelidad</span>
                <p-inputnumber formControlName="loyalty_points" [min]="0" [showButtons]="true"></p-inputnumber>
              </label>
              <label class="pp-toggle-line">
                <p-toggleswitch formControlName="activo"></p-toggleswitch>
                <span>Activo en catálogo</span>
                <span class="comm-muted is-small">(si lo desactivás, no aparece en portal ni vendor)</span>
              </label>
            </form>
          </div>
        }
        <ng-template #footer>
          <button pButton severity="secondary" [outlined]="true" (click)="dialogVisible = false"><span class="p-button-label">Cancelar</span></button>
          <button pButton [loading]="saving()" [disabled]="form.invalid" (click)="save()"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">Guardar</span></button>
        </ng-template>
      </p-dialog>
    </div>
    `,
  styles: [`
    :host { display: block; }
    .cp-divider { opacity: .4; margin: 0 .2rem; }
    .surf-page-sub b { font-weight: var(--fw-bold); color: var(--c-text-1); }
    .cp-head-actions { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }

    .cp-seg { display: inline-flex; padding: 3px; gap: 2px; border-radius: 10px; background: var(--hover-bg); border: 1px solid var(--c-divider); }
    .cp-seg-btn { border: 0; background: transparent; color: var(--c-text-2); font: inherit; font-size: var(--fs-sm); font-weight: var(--fw-medium);
      padding: .35rem .8rem; border-radius: 8px; cursor: pointer; min-height: 2rem; display: inline-flex; align-items: center; gap: .4rem; }
    .cp-seg-btn.is-on { background: var(--c-surface-1); color: var(--c-text-1); font-weight: var(--fw-bold); box-shadow: 0 1px 2px rgba(0,0,0,.08); }
    .cp-seg-n { font-family: var(--font-mono); font-size: var(--fs-xs); padding: 0 .35rem; border-radius: 999px; border: 1px solid var(--action); color: var(--action); font-weight: var(--fw-bold); }
    .cp-seg-btn:focus-visible, .cp-prov:focus-visible, .cp-chip:focus-visible, .cp-fila:focus-visible, .cp-link:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }

    .cp-aviso { display: flex; gap: .55rem; align-items: flex-start; padding: .5rem .75rem; margin: .75rem 0 0;
      border: 1px solid var(--c-divider); border-left-width: 3px; border-radius: 6px; background: var(--c-surface-1);
      font-size: var(--fs-xs); color: var(--c-text-2); }
    .cp-aviso-warn { border-left-color: var(--warn-fg); background: var(--warn-soft-bg); }
    .cp-aviso strong { color: var(--c-text-1); }

    .cp-buscar { display: flex; align-items: center; gap: .5rem; margin: 1rem 0 .75rem; height: 2.6rem; padding: 0 .85rem;
      border: 1px solid var(--c-divider); border-radius: 10px; background: var(--c-surface-1); }
    .cp-buscar:focus-within { border-color: var(--c-text-1); }
    .cp-buscar i { color: var(--c-text-3); }
    .cp-buscar input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; font: inherit; font-size: var(--fs-h3); color: var(--c-text-1); }
    .cp-buscar input::-webkit-search-cancel-button, .cp-rail-filtro input::-webkit-search-cancel-button, .cp-dentro input::-webkit-search-cancel-button { display: none; }
    .cp-buscar input:focus-visible, .cp-rail-filtro input:focus-visible, .cp-dentro input:focus-visible {
      outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    .cp-x { border: 0; background: transparent; color: var(--c-text-3); cursor: pointer; width: 1.8rem; height: 1.8rem; border-radius: 6px; }
    .cp-x:hover { background: var(--hover-bg); color: var(--c-text-1); }

    .cp-layout { display: grid; grid-template-columns: 17.5rem minmax(0, 1fr); gap: 1rem; align-items: start; }
    .cp-rail { position: sticky; top: .75rem; display: flex; flex-direction: column; max-height: calc(100vh - 6rem);
      border: 1px solid var(--c-divider); border-radius: 12px; background: var(--c-surface-1); overflow: hidden; }
    .cp-rail-head { display: flex; align-items: baseline; justify-content: space-between; padding: .7rem .85rem .35rem; }
    .cp-rail-t { font-size: var(--fs-sm); font-weight: var(--fw-bold); color: var(--c-text-1); }
    .cp-rail-sub { font-size: var(--fs-xs); color: var(--c-text-3); }
    .cp-rail-filtro { display: flex; align-items: center; gap: .4rem; margin: 0 .6rem .5rem; padding: 0 .55rem; height: 2rem;
      border: 1px solid var(--c-divider); border-radius: 8px; background: var(--hover-bg); }
    .cp-rail-filtro i { color: var(--c-text-3); font-size: var(--fs-xs); }
    .cp-rail-filtro input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; font: inherit; font-size: var(--fs-sm); color: var(--c-text-1); }
    .cp-rail-lista { list-style: none; margin: 0; padding: 0 .35rem .5rem; overflow-y: auto; display: flex; flex-direction: column; gap: 1px; }
    .cp-rail-sk { padding: .2rem .35rem; }
    .cp-prov { width: 100%; display: flex; flex-direction: column; gap: .15rem; padding: .5rem .55rem; border: 0; border-radius: 8px;
      background: transparent; text-align: left; cursor: pointer; color: inherit; font: inherit; border-left: 3px solid transparent; }
    .cp-prov:hover { background: var(--hover-bg); }
    .cp-prov.is-on { background: var(--hover-bg); border-left-color: var(--action); }
    .cp-prov-fila { display: flex; justify-content: space-between; align-items: baseline; gap: .5rem; min-width: 0; }
    .cp-prov-nom { font-size: var(--fs-sm); font-weight: var(--fw-medium); color: var(--c-text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cp-prov.is-on .cp-prov-nom { font-weight: var(--fw-bold); }
    .cp-prov-mes { flex-shrink: 0; font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-xs); color: var(--c-text-2); }
    .cp-prov-det { font-size: var(--fs-xs); color: var(--c-text-3); }
    .cp-prov-var { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--c-text-3); }
    .cp-prov.is-sin { margin-bottom: .35rem; background: var(--warn-soft-bg); }
    .cp-prov.is-sin .cp-prov-nom { color: var(--warn-soft-fg); }
    .cp-prov.is-sin.is-on { border-left-color: var(--warn-fg); }
    .is-up { color: var(--ok-fg) !important; }
    .is-down { color: var(--bad-fg) !important; }

    .cp-main { min-width: 0; display: flex; flex-direction: column; gap: .75rem; }
    .cp-prov-head { display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap; align-items: flex-start;
      padding: 1rem 1.1rem; border: 1px solid var(--c-divider); border-radius: 12px; background: var(--c-surface-1); }
    .cp-prov-head-t { min-width: 0; display: flex; flex-direction: column; gap: .25rem; }
    .cp-h2 { margin: 0; font-size: var(--fs-h2); font-weight: var(--fw-bold); color: var(--c-text-1); line-height: 1.2; }
    .cp-sub { margin: 0; font-size: var(--fs-sm); color: var(--c-text-2); }
    .cp-alerta-sin { margin: .35rem 0 0; font-size: var(--fs-sm); color: var(--warn-soft-fg); max-width: 38rem; }
    .cp-kpis { display: grid; grid-template-columns: repeat(4, auto); gap: .5rem 1.6rem; margin: 0; }
    .cp-kpi dt { font-size: var(--fs-xs); color: var(--c-text-3); }
    .cp-kpi dd { margin: .1rem 0 0; font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-lg);
      font-weight: var(--fw-bold); color: var(--c-text-1); display: flex; align-items: baseline; gap: .4rem; }
    .cp-kpi dd small { font-size: var(--fs-xs); color: var(--c-text-3); }
    .cp-kpi.is-comprar dd { color: var(--bad-soft-fg); }

    .cp-barra { display: flex; justify-content: space-between; gap: .6rem; flex-wrap: wrap; align-items: center; }
    .cp-chips { display: flex; flex-wrap: wrap; gap: .35rem; }
    .cp-chip { display: inline-flex; align-items: center; gap: .35rem; border: 1px solid var(--c-divider); background: var(--c-surface-1);
      color: var(--c-text-2); border-radius: 999px; padding: .2rem .7rem; font: inherit; font-size: var(--fs-sm); cursor: pointer; min-height: 2rem; }
    .cp-chip-n { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--c-text-3); }
    .cp-chip.is-on { background: var(--c-text-1); border-color: var(--c-text-1); color: var(--c-surface-1); font-weight: var(--fw-bold); }
    .cp-chip.is-on .cp-chip-n { color: inherit; opacity: .75; }
    .cp-chip.f-comprar:not(.is-on) .cp-chip-n { color: var(--bad-soft-fg); font-weight: var(--fw-bold); }
    .cp-barra-der { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
    .cp-dentro { display: flex; align-items: center; gap: .35rem; height: 2rem; padding: 0 .55rem; border: 1px solid var(--c-divider);
      border-radius: 8px; background: var(--c-surface-1); }
    .cp-dentro i { color: var(--c-text-3); font-size: var(--fs-xs); }
    .cp-dentro input { width: 11rem; border: 0; outline: none; background: transparent; font: inherit; font-size: var(--fs-sm); color: var(--c-text-1); }
    .cp-orden { display: inline-flex; align-items: center; gap: .4rem; font-size: var(--fs-xs); color: var(--c-text-3); }
    .cp-orden select { height: 2rem; border: 1px solid var(--c-divider); border-radius: 8px; background: var(--c-surface-1); color: var(--c-text-1);
      font: inherit; font-size: var(--fs-sm); padding: 0 .4rem; }

    .cp-tabla { border: 1px solid var(--c-divider); border-radius: 12px; background: var(--c-surface-1); overflow: hidden; }
    .cp-tr { display: grid; grid-template-columns: minmax(14rem, 2.4fr) 7.5rem 9rem minmax(13rem, 2fr) 1.5rem; gap: 1rem; align-items: center; padding: .65rem 1rem; }
    .cp-tabla.con-margen .cp-tr { grid-template-columns: minmax(14rem, 2.4fr) 7.5rem 9rem 5.5rem minmax(13rem, 2fr) 1.5rem; }
    .cp-th { position: sticky; top: 0; z-index: 1; background: var(--hover-bg); font-size: var(--fs-xs); font-weight: var(--fw-bold);
      color: var(--c-text-3); text-transform: uppercase; letter-spacing: .04em; padding-block: .5rem; }
    .cp-sk { display: block; }
    .cp-fila { border-top: 1px solid var(--c-divider); cursor: pointer; content-visibility: auto; contain-intrinsic-size: auto 3.6rem; }
    .cp-fila:hover { background: var(--hover-bg); }
    .cp-fila:hover .cp-chev { color: var(--c-text-1); transform: translateX(2px); }
    .cp-num { text-align: right; justify-self: end; }
    .cp-prod { min-width: 0; display: flex; flex-direction: column; gap: .2rem; }
    .cp-prod-nom { font-size: var(--fs-h3); font-weight: var(--fw-bold); color: var(--c-text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cp-prod-det { display: flex; flex-wrap: wrap; gap: .35rem; align-items: center; font-size: var(--fs-xs); color: var(--c-text-3); }
    .cp-prod-det code { font-family: var(--font-mono); }
    .cp-tag { padding: 0 .45rem; border-radius: 999px; font-weight: var(--fw-bold); border: 1px solid currentColor; line-height: 1.5; }
    .cp-tag.is-lider { color: var(--action); }
    .cp-tag.is-nuevo { color: var(--c-text-2); }
    .cp-tag.is-cad { color: var(--bad-soft-fg); background: var(--bad-soft-bg); border-color: var(--bad-border); }
    .cp-mes { display: flex; flex-direction: column; align-items: flex-end; font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-weight: var(--fw-bold); color: var(--c-text-1); }
    .cp-mes small, .cp-num small { font-size: var(--fs-xs); font-weight: normal; color: var(--c-text-3); display: block; }
    .cp-cob { display: flex; flex-direction: column; gap: .3rem; font-size: var(--fs-sm); color: var(--c-text-2); }
    .cp-cob-barra { display: block; height: 5px; border-radius: 999px; background: var(--hover-bg); overflow: hidden; }
    .cp-cob-barra > span { display: block; height: 100%; border-radius: 999px; background: var(--c-text-3); }
    .cp-cob-barra > .is-comprar { background: var(--bad-fg); }
    .cp-cob-barra > .is-traspasar { background: var(--warn-fg); }
    .cp-cob-barra > .is-esperar { background: var(--c-text-3); }
    .cp-cob-barra > .is-sobra, .cp-cob-barra > .is-no { background: var(--ok-fg); }
    .cp-margen { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-weight: var(--fw-bold); color: var(--c-text-1); }
    .cp-margen.is-down { color: var(--bad-fg); }
    .cp-tenue { color: var(--c-text-3); }
    .cp-que { min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: .2rem; }
    .cp-ver { display: inline-block; padding: .05rem .5rem; border-radius: 999px; font-size: var(--fs-xs); font-weight: var(--fw-bold);
      border: 1px solid var(--c-divider); color: var(--c-text-2); white-space: nowrap; }
    .cp-ver.is-comprar { color: var(--bad-soft-fg); background: var(--bad-soft-bg); border-color: var(--bad-border); }
    .cp-ver.is-traspasar { color: var(--warn-soft-fg); background: var(--warn-soft-bg); border-color: var(--warn-border); }
    .cp-ver.is-sobra, .cp-ver.is-no { color: var(--ok-fg); background: var(--ok-soft-bg); }
    .cp-motivo { font-size: var(--fs-sm); color: var(--c-text-2); overflow: hidden; text-overflow: ellipsis; display: -webkit-box;
      -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .cp-chev { color: var(--c-text-3); transition: transform 120ms var(--ease-standard), color 120ms; }
    .cp-vacio { padding: 1.5rem 1rem; text-align: center; color: var(--c-text-3); font-size: var(--fs-sm); border-top: 1px solid var(--c-divider); }
    .cp-link { border: 0; background: none; padding: 0; color: var(--action); font: inherit; font-weight: var(--fw-bold); cursor: pointer; }
    .cp-nota { margin: 0; padding: .75rem .85rem; font-size: var(--fs-sm); color: var(--c-text-3); }
    .cp-peek-acciones { display: flex; justify-content: flex-end; margin-bottom: .75rem; }

    .pc { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 26rem), 1fr)); gap: 1rem; margin: 1rem 0; }
    .pc-card { display: flex; flex-direction: column; gap: .5rem; min-width: 0; border: 1px solid var(--c-divider); border-radius: 12px;
      background: var(--c-surface-1); padding: .8rem .9rem; }
    .pc-head { display: flex; align-items: baseline; justify-content: space-between; gap: .5rem; flex-wrap: wrap; }
    .pc-t { margin: 0; font-size: var(--fs-h3); font-weight: var(--fw-bold); color: var(--c-text-1); }
    .pc-n { font-size: var(--fs-xs); color: var(--c-text-2); }
    .pc-chips { display: flex; flex-wrap: wrap; gap: .35rem; }
    .pc-chip { border: 1px solid var(--c-divider); background: var(--c-surface-1); color: var(--c-text-2); border-radius: 999px;
      padding: .15rem .6rem; font-size: var(--fs-xs); cursor: pointer; min-height: 1.75rem; }
    .pc-chip.is-on { background: var(--c-text-1); border-color: var(--c-text-1); color: var(--c-surface-1); font-weight: var(--fw-bold); }
    .pc-chip:focus-visible, .pc-item:focus-visible, .pc-mas:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    .pc-lista { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; max-height: 30rem; overflow-y: auto; }
    .pc-lista > li + li { border-top: 1px solid var(--c-divider); }
    .pc-item { width: 100%; display: flex; align-items: center; gap: .6rem; padding: .5rem .25rem; background: none; border: 0;
      text-align: left; cursor: pointer; color: inherit; font: inherit; }
    .pc-item:hover { background: var(--hover-bg); }
    .pc-rank { flex-shrink: 0; min-width: 2.4rem; font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-xs); color: var(--c-text-3); }
    .pc-cuerpo { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: .15rem; }
    .pc-nom { font-size: var(--fs-sm); font-weight: var(--fw-bold); color: var(--c-text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pc-det { display: flex; flex-wrap: wrap; gap: .35rem; align-items: center; font-size: var(--fs-xs); color: var(--c-text-2); }
    .pc-dinero, .pc-fecha { flex-shrink: 0; display: flex; flex-direction: column; align-items: flex-end; font-family: var(--font-mono);
      font-variant-numeric: tabular-nums; font-size: var(--fs-sm); font-weight: var(--fw-bold); color: var(--c-text-1); }
    .pc-dinero small, .pc-fecha small { font-family: var(--font-sans, inherit); font-size: var(--fs-xs); font-weight: normal; color: var(--c-text-3); }
    .pc-cad { display: inline-block; padding: .05rem .45rem; border-radius: 999px; font-weight: var(--fw-bold); border: 1px solid var(--c-divider); }
    .pc-cad.is-caducado, .pc-cad.is-no_alcanza { color: var(--bad-soft-fg); background: var(--bad-soft-bg); border-color: var(--bad-border); }
    .pc-cad.is-justo { color: var(--warn-soft-fg); background: var(--warn-soft-bg); border-color: var(--warn-border); }
    .pc-vacio { padding: .6rem .25rem; font-size: var(--fs-sm); color: var(--c-text-3); }
    .pc-mas { align-self: flex-start; background: none; border: 0; padding: .2rem 0; color: var(--action); font-size: var(--fs-sm);
      font-weight: var(--fw-bold); cursor: pointer; }
    .pc-meta { margin: 0; font-size: var(--fs-xs); color: var(--c-text-3); }
    .pc-margen { color: var(--c-text-2); }
    .pc-origen { margin: 1rem 0 0; }
    .pc-origen.is-vivo { color: var(--warn-soft-fg); }
    .pc-sin { font-weight: var(--fw-bold); color: var(--warn-soft-fg); }
    .pc-chip-cad.is-on { background: var(--bad-soft-bg); border-color: var(--bad-border); color: var(--bad-soft-fg); }

    .pp-edit-body { display: flex; flex-direction: column; gap: 1rem; }
    .pp-edit-meta { display: grid; grid-template-columns: 1fr 1fr; gap: .65rem 1rem; padding: .75rem 1rem; background: var(--hover-bg); border-radius: 8px; }
    .pp-edit-meta > div { display: flex; flex-direction: column; gap: .15rem; }
    .pp-edit-meta strong { font-variant-numeric: tabular-nums; color: var(--c-text-1); }
    .pp-form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    .pp-toggle-line { display: flex !important; flex-direction: row !important; align-items: center; gap: .65rem; }
    .pp-toggle-line > span:first-of-type { font-weight: var(--fw-medium); }

    @media (max-width: 72rem) {
      .cp-kpis { grid-template-columns: repeat(2, auto); }
      .cp-tr, .cp-tabla.con-margen .cp-tr { grid-template-columns: minmax(0, 1fr) 7rem minmax(0, 1fr) 1.2rem; }
      .cp-tr > :nth-child(3) { display: none; }
      .cp-tabla.con-margen .cp-tr > :nth-child(4) { display: none; }
    }
    @media (max-width: 52rem) {
      .cp-layout { grid-template-columns: 1fr; }
      .cp-rail { position: static; max-height: 16rem; }
      .cp-th { display: none; }
      .cp-tr, .cp-tabla.con-margen .cp-tr { grid-template-columns: minmax(0, 1fr) auto; gap: .35rem .75rem; }
      .cp-que { grid-column: 1 / -1; }
      .cp-chev { display: none; }
      .pp-edit-meta, .pp-form-row { grid-template-columns: 1fr; }
    }
    @media (prefers-reduced-motion: reduce) { .cp-chev { transition: none; } }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComprasCatalogoComponent {
  readonly tabs = CATALOGO_TABS;
  readonly SIN = SIN_PROVEEDOR;
  readonly esqueleto10 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

  private readonly api = inject(ComercialService);
  private readonly fb = inject(FormBuilder);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly flujoApi = inject(ProductosFlujoService);

  /** `[PF.9]` Por proveedor (la vista de trabajo) o "Para cuidar hoy". */
  readonly vista = signal<'proveedor' | 'cuidar'>('proveedor');
  /** Sube cada minuto (con la pestaña visible) y con el botón: recarga todo lo vivo sin vaciar la pantalla. */
  private readonly recarga = signal(0);

  // ── Precio: de dónde sale y qué tan viejo es ([RP.12]/[CAT.PRECIO], lógica en catalogo-precio-aviso.ts) ──
  private readonly statsRes = rxResource({ params: () => this.recarga(), stream: () => this.api.productStats(undefined) });
  readonly stats = computed<ProductStats | null>(() => this.statsRes.value() ?? null);
  readonly avisoPrecio = computed(() => avisoDePrecio(this.stats(), Date.now()));

  // ── [PF.9] La barra de proveedores ──
  readonly proveedoresRes = rxResource({
    params: () => ({ v: this.recarga() }),
    stream: () => this.flujoApi.proveedores(),
  });
  /** Lo último que llegó: una recarga que falla no vacía la barra. */
  private readonly proveedores = linkedSignal<ProveedoresRespuesta | undefined, ProveedoresRespuesta | null>({
    source: () => (this.proveedoresRes.error() ? undefined : this.proveedoresRes.value()),
    computation: (nuevo, previo) => nuevo ?? previo?.value ?? null,
  });
  readonly proveedoresLista = computed<ProveedorFlujo[]>(() => this.proveedores()?.proveedores ?? []);
  readonly sinProveedor = computed(() => this.proveedores()?.sin_proveedor ?? null);
  readonly filtroProveedor = signal('');
  readonly proveedoresVista = computed(() => {
    const q = this.filtroProveedor();
    return this.proveedoresLista().filter((p) => coincideBusqueda(q, p.nombre));
  });

  /** Lo que la persona eligió; si nada, el de la última vez (si sigue existiendo) o el que más vende. */
  private readonly elegido = signal<string | null>(null);
  readonly activo = computed<string | null>(() => {
    const e = this.elegido();
    if (e) return e;
    const g = leerGuardado();
    const xs = this.proveedoresLista();
    if (g && (g === SIN_PROVEEDOR ? !!this.sinProveedor() : xs.some((p) => p.supplier_id === g))) return g;
    return xs[0]?.supplier_id ?? null;
  });
  elegir(id: string): void {
    this.elegido.set(id);
    guardar(id);
    this.filtro.set('todos');
    this.textoTabla.set('');
  }

  // ── [PF.9] Los productos del proveedor elegido, en vivo (el servidor los guarda un minuto) ──
  private readonly proveedorRes = rxResource({
    params: () => {
      const id = this.activo();
      return id && !this.busquedaActiva() ? { id, v: this.recarga() } : undefined;
    },
    stream: ({ params }) => this.flujoApi.productosProveedor(params.id),
  });
  /** El último del proveedor ELEGIDO: al cambiar de proveedor no se ve el anterior; al recargar no se vacía. */
  readonly proveedorDatos = linkedSignal<
    { id: string | null; nuevo: ProductosProveedorRespuesta | undefined }, ProductosProveedorRespuesta | null
  >({
    source: () => ({ id: this.activo(), nuevo: this.proveedorRes.error() ? undefined : this.proveedorRes.value() }),
    computation: ({ id, nuevo }, previo) => {
      const es = (x: ProductosProveedorRespuesta | null | undefined) => !!x && (x.proveedor.supplier_id ?? SIN_PROVEEDOR) === id;
      if (es(nuevo)) return nuevo!;
      return es(previo?.value) ? previo!.value : null;
    },
  });
  readonly proveedorError = computed(() => !!this.proveedorRes.error() && !this.proveedorDatos());

  // ── Búsqueda en todo el catálogo ──
  busqueda = '';
  readonly busquedaSenal = signal('');
  readonly busquedaActiva = computed(() => this.busquedaSenal().length > 0);
  private readonly buscarRes = rxResource({
    params: () => (this.busquedaSenal() ? { page: 1, pageSize: 50, search: this.busquedaSenal() } : undefined),
    stream: ({ params }) => this.api.listProducts(params),
  });
  readonly busquedaTotal = computed(() => this.buscarRes.value()?.pagination?.total ?? 0);
  private readonly encontrados = computed<Product[]>(() => (this.busquedaActiva() ? this.buscarRes.value()?.data ?? [] : []));
  private readonly flujoBusquedaRes = rxResource({
    params: () => {
      const ids = this.encontrados().map((p) => p.id);
      return ids.length ? { ids, v: this.recarga() } : undefined;
    },
    stream: ({ params }) => this.flujoApi.listar(params.ids).pipe(catchError(() => of(null))),
  });
  private readonly flujoBusqueda = linkedSignal<FlujoLista | null | undefined, Map<string, FlujoResumen>>({
    source: () => this.flujoBusquedaRes.value(),
    computation: (nuevo, previo) => {
      const m = new Map(previo?.value ?? []);
      for (const x of nuevo?.productos ?? []) m.set(x.product_id, x);
      return m;
    },
  });
  /** Lo encontrado, en la forma de la tabla. Sin flujo todavía no se pinta como cero: se espera. */
  readonly filasBusqueda = computed<FilaCatalogo[]>(() => {
    const m = this.flujoBusqueda();
    return this.encontrados().flatMap((p) => {
      const r = m.get(p.id);
      return r ? [filaDeResumen(r, { sku: p.sku ?? null, nombre: p.nombre }, alertasTexto(r))] : [];
    });
  });
  private readonly proveedorDe = computed(() => new Map(this.encontrados().map((p) => [p.id, p.supplier_name ?? null])));
  onBusqueda(v: string): void { this.busqueda = v; this.buscarDebounced(v); }
  private readonly buscarDebounced = makeDebouncedSearch((v) => this.busquedaSenal.set((v || '').trim()));
  limpiarBusqueda(): void { this.busqueda = ''; this.busquedaSenal.set(''); }

  // ── La tabla ──
  readonly filtros: FiltroCatalogo[] = ['todos', 'comprar', 'mover', 'esperar', 'no_comprar', 'lideres'];
  readonly filtro = signal<FiltroCatalogo>('todos');
  readonly textoTabla = signal('');
  readonly orden = signal<OrdenCatalogo>('venta');
  readonly filasBase = computed<FilaCatalogo[]>(() => (this.busquedaActiva() ? this.filasBusqueda() : this.proveedorDatos()?.productos ?? []));
  readonly conteos = computed(() => contarFiltros(this.filasBase()));
  readonly filasVista = computed(() => filtrarYOrdenar(this.filasBase(), this.filtro(), this.busquedaActiva() ? '' : this.textoTabla(), this.orden()));
  readonly cargandoTabla = computed(() => this.busquedaActiva()
    ? this.buscarRes.isLoading() || this.flujoBusquedaRes.isLoading()
    : !this.proveedorDatos() && !this.proveedorError());
  /** `[PF.5]` El margen sólo con permiso de costo (el servidor tampoco lo manda sin él). */
  readonly costoVisible = computed(() => (this.busquedaActiva() ? !!this.flujoBusquedaRes.value()?.costo_visible : !!this.proveedorDatos()?.costo_visible));
  private readonly topeCobertura = computed(() => this.proveedorDatos()?.criterio.coberturaSobra ?? this.cuidar()?.criterio.coberturaSobra ?? 60);
  readonly cargandoAlgo = computed(() => this.proveedoresRes.isLoading() || this.proveedorRes.isLoading() || this.cuidarRes.isLoading());
  quitarFiltros(): void { this.filtro.set('todos'); this.textoTabla.set(''); }

  // [NP.5] La etiqueta "Nuevo · dia N". Si falla, la lista sigue sin etiqueta.
  private readonly nuevos = inject(ProductosNuevosService);
  private readonly nuevosRes = rxResource({
    params: () => true,
    stream: () => this.nuevos.listar().pipe(catchError(() => of(null))),
  });
  private readonly etiquetasNuevo = computed(() => {
    const m = new Map<string, string>();
    for (const f of this.nuevosRes.value()?.filas ?? []) {
      if (f.estado === 'seguimiento' && f.etapa !== 'graduado' && f.dia !== null) m.set(f.product_id, `Nuevo · día ${f.dia}`);
      else if (f.estado === 'sin_movimiento') m.set(f.product_id, 'Nuevo · sin movimiento');
    }
    return m;
  });
  nuevo(id: string): string | null { return this.etiquetasNuevo().get(id) ?? null; }

  // ── El panel lateral ──
  readonly abierto = signal<AbiertoFlujo | null>(null);
  abrir(f: FilaCatalogo): void {
    const prov = this.busquedaActiva() ? this.proveedorDe().get(f.product_id) ?? null : this.proveedorDatos()?.proveedor.nombre ?? null;
    this.abierto.set({ id: f.product_id, nombre: this.nombre(f), sku: f.sku || null, proveedor: prov ? nombreProveedor(prov) : null });
  }
  abrirCuidar(x: ProductoACuidar): void { this.abierto.set({ id: x.resumen.product_id, nombre: nombrePropio(x.nombre) || x.sku, sku: x.sku }); }
  abrirNoSeVende(x: NoSeVende): void { this.abierto.set({ id: x.product_id, nombre: nombrePropio(x.nombre) || x.sku, sku: x.sku }); }
  cerrarFlujo(): void { this.abierto.set(null); }

  // ── [PF.2]/[PF.3]/[PF.4] Para cuidar hoy ──
  private readonly cuidarRes = rxResource({
    params: () => ({ v: this.recarga() }),
    stream: () => this.flujoApi.cuidar(),
  });
  readonly cuidar = linkedSignal<CuidarRespuesta | undefined, CuidarRespuesta | null>({
    source: () => (this.cuidarRes.error() ? undefined : this.cuidarRes.value()),
    computation: (nuevo, previo) => nuevo ?? previo?.value ?? null,
  });
  readonly cuidarError = computed(() => !!this.cuidarRes.error() && !this.cuidar());
  /** El número de la pestaña: lo que pide hacer algo hoy (no todos los líderes, que son la mitad de la venta). */
  readonly pendientesCuidar = computed(() => {
    const c = this.cuidar();
    return c ? c.lideres.lista.filter((x) => x.motivos?.length).length + c.caducidad.productos.length : 0;
  });
  readonly motivos: MotivoLider[] = ['agotado', 'comprar', 'mover', 'se_freno'];
  readonly motivo = signal<MotivoLider | null>(null);
  readonly verTodos = signal(false);
  readonly lideresFiltrados = computed(() => {
    const m = this.motivo();
    const xs = this.cuidar()?.lideres.lista ?? [];
    return m ? xs.filter((x) => x.motivos?.includes(m)) : xs;
  });
  readonly lideresVista = computed(() => (this.verTodos() ? this.lideresFiltrados() : this.lideresFiltrados().slice(0, 12)));
  readonly tramos: TramoSinVenta[] = ['mes', 'trimestre', 'anio'];
  readonly tramo = signal<TramoSinVenta | 'caducidad' | null>(null);
  readonly verTodosNV = signal(false);
  readonly noVendenFiltrados = computed(() => {
    const t = this.tramo();
    const xs = this.cuidar()?.no_se_venden.productos ?? [];
    return t && t !== 'caducidad' ? xs.filter((x) => x.tramo === t) : xs;
  });
  readonly noVendenVista = computed(() => (this.verTodosNV() ? this.noVendenFiltrados() : this.noVendenFiltrados().slice(0, 12)));

  // ── Formato ──
  readonly dinero = dinero;
  readonly corto = dineroCorto;
  readonly variacion = variacionTexto;
  readonly fecha = fechaCorta;
  readonly cajas = cantidadEnCajas;
  readonly margenTxt = margenTexto;
  readonly caducidadTexto = caducidadTexto;
  readonly propio = nombrePropio;
  readonly provNombre = nombreProveedor;
  nombre(f: Pick<FilaCatalogo, 'nombre' | 'sku'>): string { return nombrePropio(f.nombre) || f.sku; }
  filtroTexto(f: FiltroCatalogo): string { return FILTRO_TEXTO[f]; }
  claseVeredicto(v: VeredictoCompra): string { return VEREDICTO_CLASE[v]; }
  veredictoCorto(v: VeredictoCompra): string { return VEREDICTO_CORTO[v]; }
  cobAncho(d: number | null): number | null { return coberturaAncho(d, this.topeCobertura()); }
  cobTexto(d: number | null): string { return coberturaTexto(d); }
  pct(v: number | null): string { return v === null ? '—' : Math.round(v * 100) + '%'; }
  tramoTexto(t: TramoSinVenta): string { return TRAMO_TEXTO[t]; }
  sinVenderTexto(x: NoSeVende): string { return sinVenderTexto(x, this.cuidar()?.criterio.ventanaSinVenta ?? 365); }
  motivoTexto(m: MotivoLider): string { return MOTIVO_LIDER[m]; }
  caducidad(x: ProductoACuidar) { return caducidadTexto(x.resumen.caducidad!); }
  nombresDe(xs: Array<{ plaza: string; nombre: string | null }>): string { return xs.map((x) => x.nombre || 'Sucursal ' + x.plaza).join(', '); }
  horaCorta(iso: string | null): string {
    return iso ? new Intl.DateTimeFormat('es-MX', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '—';
  }
  hora(iso: string): string {
    return new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  }
  /** Días que faltan para una fecha, desde hoy en México. */
  diasA(f: string): string {
    const hoy = this.cuidar()?.periodos.hoy ?? new Date().toISOString().slice(0, 10);
    return diasTexto(Math.round((Date.parse(f + 'T00:00:00Z') - Date.parse(hoy + 'T00:00:00Z')) / 86_400_000));
  }
  fmtNumber(n: number | null | undefined): string {
    if (n === null || n === undefined) return '—';
    return new Intl.NumberFormat('es-MX').format(Number(n));
  }

  // ── Editar ──
  readonly editing = signal<Product | null>(null);
  readonly saving = signal(false);
  dialogVisible = false;
  form: FormGroup = this.fb.group({
    description: [''],
    location: [''],
    location_warehouse: [''],
    loyalty_points: [0],
    activo: [true],
  });

  constructor() {
    const id = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') this.recarga.update((n) => n + 1);
    }, 60_000);
    this.destroyRef.onDestroy(() => clearInterval(id));
    effect(() => {
      if (this.buscarRes.error()) this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo buscar en el catálogo' });
    });
  }

  refresh(): void { this.recarga.update((n) => n + 1); }

  openEdit(id: string): void {
    this.api.findProduct(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (full) => {
        this.editing.set(full);
        this.form.reset({
          description: full.description || '',
          location: full.location || '',
          location_warehouse: full.location_warehouse || '',
          loyalty_points: full.loyalty_points || 0,
          activo: full.activo,
        });
        this.dialogVisible = true;
      },
      error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar el producto' }),
    });
  }

  save(): void {
    const e = this.editing();
    if (!e || this.form.invalid) return;
    this.saving.set(true);
    const v = this.form.value;
    const payload: UpdateProductDto = {
      description: v.description?.trim() || null,
      location: v.location?.trim() || null,
      location_warehouse: v.location_warehouse?.trim() || null,
      loyalty_points: v.loyalty_points == null ? null : Number(v.loyalty_points),
      activo: !!v.activo,
    };
    this.api.updateProduct(e.id, payload).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.saving.set(false);
        this.dialogVisible = false;
        this.toast.add({ severity: 'success', summary: 'Producto actualizado' });
        this.refresh();
      },
      error: (err) => {
        this.saving.set(false);
        const detail = err?.error?.message || 'No se pudo guardar';
        this.toast.add({ severity: 'error', summary: 'Error', detail });
      },
    });
  }
}
