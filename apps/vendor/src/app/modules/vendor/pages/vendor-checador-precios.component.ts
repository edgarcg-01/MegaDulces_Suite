import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, OnInit, computed, inject, input, signal, viewChild } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ConnectivityService } from '../../../core/services/connectivity.service';
import { esSinSenal } from '../../../core/http/sin-senal';
import { VendorService } from '../vendor.service';
import { ChecadorPreciosService, type HalladoEnCopia } from '../checador-precios.service';
import {
  TEXTO_MOTIVO,
  cuandoEs,
  mayoreoDelRespaldo,
  pareceCodigo,
  sucursalDelChecador,
  type ResultadoConsulta,
  type SucursalChecador,
} from '../checador-precios';
import { presentacionesDe, unidadesDelRespaldo, type Escalon, type PresentacionMostrador } from '@megadulces/ui-web';
import { LectorCodigoComponent } from '../components/lector-codigo.component';
import { DictarBusquedaComponent } from '../components/dictar-busqueda.component';

const pesos = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Un renglón de la lista mientras se escribe: el producto de la copia con sus presentaciones ya contadas. */
interface Renglon {
  clave: string;
  nombre: string;
  presentaciones: PresentacionMostrador[];
  esPromocion: boolean;
  /** `[VTK.17]` Los escalones de mayoreo (pieza y paquete) de la copia. */
  mayoreo: Escalon[];
  /** `[VTK.17]` El proveedor de la ficha de Kepler; `null` = la copia no lo trae (no se inventa). */
  proveedor: string | null;
}

/**
 * `[VTK.17]` **Checador de precios** — el vendedor consulta el precio de un producto sin salir de
 * lo que está haciendo: por nombre, clave o código de barras, o leyendo el código con la cámara.
 *
 * ── Las cinco preguntas (skill `diseno` §0b), contestadas antes de la plantilla ──────────────────
 *  1. **Qué ve al entrar, en orden:** de qué sucursal es el precio, el buscador con la cámara, y de
 *     cuándo es la copia guardada para usar sin señal. Al buscar: la lista; al elegir o leer: el
 *     precio de cada presentación, grande.
 *  2. **Qué NO ve:** la lista de precio del cliente (vive en Tomar pedido; aquí se dice que no es
 *     ésa), existencias, costo, mayoreo de la tienda (pendiente de decidir), selector de sucursal,
 *     contador de escaneos, modo kiosco.
 *  3. **Accesibilidad de la información:** un toque desde cualquier pantalla (botón «Precios» del
 *     encabezado); buscable por nombre, clave o código; todas las presentaciones a la vista sin otro
 *     toque; `Enter` consulta; la cámara pide permiso sólo al tocarla y, si no hay, se escribe.
 *  4. **Ligas:** es el mismo precio de `/tienda/verificador` (mismos endpoints, misma regla de
 *     presentaciones). No escribe nada ni manda a ningún proceso.
 *  5. **¿Le toca a esta pantalla?** Sí: es consulta pura. Lo que se le cobra al cliente lo decide su
 *     lista en Tomar pedido, y eso no se mezcla aquí.
 *
 * Jerarquía (Q.5): primario = el precio de cada presentación · secundario = el nombre del producto
 * y la presentación · terciario = clave, lo que trae, de dónde y de cuándo es el precio.
 */
@Component({
  selector: 'app-vendor-checador-precios',
  standalone: true,
  imports: [LectorCodigoComponent, DictarBusquedaComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:pointerdown)': 'alTocarFuera($event)' },
  template: `
    <section class="ck" [class.ck-compacto]="compacto()">
      <!-- [VTK.17] Compacto (en el encabezado de la app, como el buscador del arqueo): sólo la caja; lo demás
           baja en una ventana que flota bajo el encabezado mientras se busca, y se cierra sola. -->
      @if (!compacto()) {
      <header class="ck-head">
        <h1>Checador de precios</h1>
        @switch (sucursal().estado) {
          @case ('lista') {
            <p class="ck-sub">
              Precio al público de Kepler en <b>{{ nombreSucursal() }}</b>, el mismo del verificador de la tienda.
              No es la lista de precio del cliente.
            </p>
            @if (sucursalDeLaCopia()) {
              <p class="ck-nota warn" role="status">
                <i class="pi pi-wifi" aria-hidden="true"></i>
                Sin señal: se usa la sucursal de tu última copia guardada.
              </p>
            }
          }
          @case ('cargando') { <p class="ck-sub">Buscando tu sucursal de surtido…</p> }
        }
      </header>
      }

      @if (sucursal().estado === 'no') {
        @if (compacto()) {
          <!-- En el encabezado no cabe el motivo entero: lo dice corto y completo al tocarlo/pasar encima. -->
          <p class="ck-sin" role="status" [attr.title]="motivoSinSucursal()">
            <i class="pi pi-tag" aria-hidden="true"></i> Precios: sin sucursal
          </p>
        } @else {
        <div class="ck-aviso" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span>{{ motivoSinSucursal() }}</span>
        </div>
        }
      } @else if (sucursal().estado === 'lista') {
        <div class="ck-buscar" role="search">
          <i class="pi pi-search" aria-hidden="true"></i>
          <input #campo type="search" class="ck-in" [placeholder]="vozEscucha() ? 'Escuchando… di el producto' : compacto() ? 'Precio: nombre, proveedor, clave o código' : 'Nombre, proveedor, clave o código de barras'"
            aria-label="Buscar precio por nombre, proveedor, clave o código de barras"
            inputmode="search" enterkeyhint="search" autocomplete="off" autocapitalize="none" spellcheck="false"
            maxlength="64" [value]="texto()" (input)="alEscribir($any($event.target).value)" (keydown.enter)="alEnter()"
            (keydown.escape)="limpiar()" />
          @if (texto()) {
            <button type="button" class="ck-limpiar" aria-label="Borrar la búsqueda" (click)="limpiar()">
              <i class="pi pi-times" aria-hidden="true"></i>
            </button>
          }
          <!-- [MCP.26] Buscar dictando, sólo en la pantalla completa: en el encabezado (compacto) un botón
               más dejaría el campo sin ancho en un teléfono de 360 px; ahí queda el micrófono del teclado. -->
          @if (!compacto()) {
            <app-dictar-busqueda (texto)="alEscribir($event)" />
          }
          <app-lector-codigo etiqueta="Leer el código de barras con la cámara"
            (leido)="alLeerCodigo($event)" (sinCamara)="avisoCamara.set($event)" />
        </div>
        @if (vozError(); as ve) {
          <p class="ck-nota warn" role="alert"><i class="pi pi-microphone" aria-hidden="true"></i> {{ ve }}</p>
        }
        <!-- [VTK.17] En compacto, todo lo de abajo vive en una ventana que sólo aparece mientras se busca. -->
        @if (!compacto() || abierta()) {
        <div class="ck-ventana" [class.ck-flota]="compacto()" [attr.role]="compacto() ? 'region' : null"
             [attr.aria-label]="compacto() ? 'Precio encontrado' : null">
        <!-- [VTK.17] En compacto van sólo los precios (David: «esto quítalo»). Lo que NO se calla es lo que
             cambia la lectura: la sucursal sacada de la copia sin señal, y una copia que no es de hoy (abajo). -->
        @if (compacto() && sucursalDeLaCopia()) {
          <p class="ck-v-top warn"><i class="pi pi-wifi" aria-hidden="true"></i> Sin señal: precios de {{ nombreSucursal() }}, la sucursal de tu última copia.</p>
        }
        @if (avisoCamara(); as a) {
          <p class="ck-nota warn" role="status"><i class="pi pi-camera" aria-hidden="true"></i> {{ a }}</p>
        }

        <!-- La copia para usar sin señal: SIEMPRE dice de cuándo es. Nunca se presenta como de hoy.
             [VTK.17] En compacto sólo aparece cuando hay algo que avisar (no es de hoy, no hay, no se guardó). -->
        @if (!compacto() || copiaEnAviso()) {
        <div class="ck-copia" [class.warn]="copiaEnAviso()" role="status">
          <i class="pi" [class.pi-database]="!descargando()" [class.pi-spin]="descargando()" [class.pi-spinner]="descargando()" aria-hidden="true"></i>
          <span>{{ textoCopia() }}</span>
          @if (puedeActualizarCopia()) {
            <button type="button" class="ck-copia-btn" (click)="actualizarCopia()" [disabled]="descargando()">
              {{ copia() ? 'Actualizar' : 'Guardar copia' }}
            </button>
          }
        </div>
        }

        @if (consultando()) {
          <p class="ck-cargando" role="status"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Consultando el precio…</p>
        } @else if (resultado(); as r) {
          @switch (r.estado) {
            @case ('encontrado') {
              @if (r.estado === 'encontrado') {
                @let f = r.ficha;
                <article class="ck-ficha" aria-live="polite">
                  <div class="ck-f-top">
                    <span class="ck-clave">Clave {{ f.clave }}</span>
                    @if (r.origen === 'en_linea') {
                      <span class="chip ok"><i class="pi pi-bolt" aria-hidden="true"></i> En línea · {{ cuando(r.al).texto }}</span>
                    } @else {
                      <span class="chip warn"><i class="pi pi-database" aria-hidden="true"></i> Copia · {{ cuando(r.al).texto }}</span>
                    }
                  </div>
                  <h2 class="ck-nombre">{{ f.nombre || 'Sin nombre en Kepler' }}</h2>
                  @if (f.esPromocion) {
                    <p class="ck-promo"><b>Es una promoción de Kepler, no un producto.</b> No tiene precio de venta: el centavo que trae sólo sirve para registrarla.</p>
                  } @else if (f.presentaciones.length) {
                    <ul class="ck-pres">
                      @for (p of f.presentaciones; track p.u) {
                        <li class="ck-p" [class.leida]="p.u === f.unidadLeida">
                          <span class="ck-p-nom">
                            {{ p.nombre }}
                            @if (p.u === f.unidadLeida) { <span class="ck-leida">Es la que leíste</span> }
                          </span>
                          <span class="ck-p-precio">{{ dinero(p.precio) }}</span>
                          @if (p.trae) {
                            <span class="ck-p-trae">Trae {{ p.trae.n }} {{ p.trae.palabra }} · {{ dinero(p.precioPorTrae) }} {{ p.etiquetaPorTrae }}</span>
                          }
                        </li>
                      }
                    </ul>
                  } @else {
                    <p class="ck-nota">Kepler no tiene precio de venta para este producto en {{ nombreSucursal() }}.</p>
                  }
                  <!-- [VTK.17] Los dos mayoreos (pieza y paquete), desde cuántos y a cuánto. -->
                  @if (!f.esPromocion) {
                    @if (f.mayoreo.length) {
                      <ul class="ck-may" aria-label="Precios de mayoreo">
                        @for (e of f.mayoreo; track $index) {
                          <li><span>Mayoreo {{ desdeTexto(e) }}:</span><b> {{ dinero(e.precio) }}</b><span class="ck-may-e"> {{ e.etiqueta }}</span></li>
                        }
                      </ul>
                    } @else if (f.mayoreoSabido) {
                      <p class="ck-nota">Sin precio de mayoreo en Kepler.</p>
                    } @else {
                      <p class="ck-nota warn">Esta copia no trae el mayoreo: consúltalo con señal.</p>
                    }
                  }
                  <p class="ck-nota">Precio al público con IVA en {{ nombreSucursal() }}.@if (f.corregidoAMano) { Corregido a mano: es el mismo de la etiqueta del anaquel. }</p>
                  @if (f.otrosConElCodigo.length) {
                    <p class="ck-nota warn"><b>Ese código está también en {{ f.otrosConElCodigo.length === 1 ? 'otro producto' : f.otrosConElCodigo.length + ' productos más' }}</b> ({{ f.otrosConElCodigo.join(', ') }}). Confirma cuál es antes de dar el precio.</p>
                  }
                  @if (f.precioAmbiguo) {
                    <p class="ck-nota warn">Este producto tiene precios distintos entre sucursales y no se pudo acotar al de la tuya: confírmalo.</p>
                  }
                  @if (f.deOtraPlaza) {
                    <p class="ck-nota warn">Tu sucursal no tiene este producto en Kepler: el precio es de otra sucursal.</p>
                  }
                  @if (r.origen === 'copia') {
                    <p class="ck-nota warn">{{ textoMotivo(r.motivo) }}: este precio es de la copia {{ deCuando(r.al) }} y pudo cambiar.</p>
                  }
                </article>
              }
            }
            @case ('no_encontrado') {
              @if (r.estado === 'no_encontrado') {
                <div class="ck-vacio" role="status">
                  <i class="pi pi-search" aria-hidden="true"></i>
                  @if (r.origen === 'en_linea') {
                    <p><b>Kepler no tiene el código {{ r.codigo }}</b> en {{ nombreSucursal() }}.</p>
                  } @else {
                    <p><b>El código {{ r.codigo }} no está en tu copia</b> {{ deCuando(r.al) }}.</p>
                    <p class="ck-nota">{{ textoMotivo(r.motivo) }}. Puede ser un producto nuevo: consúltalo cuando vuelva la señal.</p>
                  }
                </div>
              }
            }
            @case ('sin_datos') {
              @if (r.estado === 'sin_datos') {
                <div class="ck-aviso" role="alert">
                  <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                  <span>{{ textoMotivo(r.motivo) }} y no hay copia guardada en este teléfono: no se puede consultar el precio de {{ r.codigo }} ahora.</span>
                </div>
              }
            }
          }
          @if ((hallados()?.length ?? 0) > 1) {
            <button type="button" class="ck-volver" (click)="resultado.set(null)">
              <i class="pi pi-arrow-left" aria-hidden="true"></i> Volver a la lista
            </button>
          }
        } @else if (texto().trim()) {
          @if (hallados() === null) {
            <p class="ck-nota">
              @if (enLinea()) { Para buscar por nombre hace falta la copia. Por código: escríbelo y toca buscar. }
              @else { Sin copia guardada no se puede buscar por nombre. }
            </p>
          } @else if (!hallados()!.length) {
            <div class="ck-vacio" role="status">
              <i class="pi pi-search" aria-hidden="true"></i>
              <p>Nada en tu copia con «{{ texto().trim() }}».</p>
              @if (pareceCodigo(texto())) { <p class="ck-nota">Toca buscar en el teclado para preguntarlo a Kepler.</p> }
            </div>
          } @else {
            @if (!compacto()) {
              <p class="ck-lista-t">{{ hallados()!.length }}{{ hallados()!.length >= limite ? '+' : '' }} en tu copia {{ deCuando(copia()?.generado) }} · toca uno para el precio en línea</p>
            }
            <ul class="ck-lista">
              @for (x of renglones(); track x.clave) {
                <li>
                  <button type="button" class="ck-r" (click)="elegir(x.clave)">
                    <span class="ck-r-nom">{{ x.nombre }}</span>
                    <!-- [VTK.17] El proveedor a la vista (David: «agrégale también por proveedor»): se busca por él y se ve. -->
                    <span class="ck-r-sub">Clave {{ x.clave }}@if (x.proveedor) {<span> · {{ x.proveedor }}</span>}@if (x.esPromocion) {<span> · promoción, sin precio</span>}</span>
                    @if (!x.esPromocion) {
                      <!-- [VTK.17] Cada presentación con lo que trae (David: «el total de paq que tiene la caja,
                           bulto, etc.») y los dos mayoreos. -->
                      <span class="ck-r-precios">
                        @for (p of x.presentaciones; track p.u) {
                          <span>{{ p.nombre }} <b>{{ dinero(p.precio) }}</b>@if (p.trae) {<small class="ck-trae"> · {{ p.trae.n }} {{ p.trae.palabra }}</small>}</span>
                        }
                      </span>
                      @if (x.mayoreo.length) {
                        <span class="ck-r-may">
                          @for (e of x.mayoreo; track $index) {
                            <span>Mayoreo {{ desdeTexto(e) }} <b>{{ dinero(e.precio) }}</b> {{ e.etiqueta }}</span>
                          }
                        </span>
                      }
                    }
                  </button>
                </li>
              }
            </ul>
          }
        } @else {
          <p class="ck-ayuda">Escribe el nombre, la clave o el código de barras, o toca la cámara para leerlo.</p>
        }
        </div>
        }
      } @else if (compacto()) {
        <p class="ck-sin" role="status"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Precios…</p>
      }
    </section>
  `,
  styles: [`
    :host { display: block; }
    .ck { display: flex; flex-direction: column; gap: var(--sp-3); }
    .ck-head h1 { margin: 0; font-size: var(--fs-h2); font-weight: var(--fw-black); color: var(--text-main); }
    .ck-sub { margin: var(--sp-1) 0 0; font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.4; }
    .ck-sub b { color: var(--text-main); }
    .ck-buscar {
      display: flex; align-items: center; gap: var(--sp-2);
      padding: var(--sp-1) var(--sp-1) var(--sp-1) var(--sp-3);
      background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-pill);
    }
    .ck-buscar > .pi { color: var(--text-muted); }
    .ck-in {
      flex: 1; min-width: 0; min-height: max(var(--tap-min), 2.5rem); border: 0; background: none; outline: none;
      color: var(--text-main); font-family: var(--font-body);
      /* 16px (--fs-h3) a propósito: por debajo, iOS hace zoom al enfocar el campo. */
      font-size: var(--fs-h3);
    }
    .ck-in:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; border-radius: var(--r-sm); }
    .ck-limpiar {
      display: grid; place-items: center; min-width: max(var(--tap-min), 2.5rem); min-height: max(var(--tap-min), 2.5rem);
      border: 0; border-radius: var(--r-pill); background: none; color: var(--text-muted); cursor: pointer;
    }
    .ck-limpiar:focus-visible, .ck-copia-btn:focus-visible, .ck-r:focus-visible, .ck-volver:focus-visible {
      outline: 2px solid var(--focus-ring); outline-offset: 2px;
    }
    /* La ventana no existe para el diseño en la página: sus hijos siguen siendo renglones de .ck. */
    .ck-ventana { display: contents; }
    /* [VTK.17] Compacto: la caja vive en el encabezado de la app (como el buscador del arqueo). Lo encontrado
       baja en una ventana pegada bajo el encabezado, a todo su ancho (se posiciona contra el encabezado, que
       es sticky; por eso ni el host ni .ck llevan position), con su propio scroll, y se cierra sola. */
    .ck.ck-compacto { gap: 0; }
    .ck-compacto .ck-buscar { padding: 0 0 0 var(--sp-2); }
    .ck-compacto .ck-in { min-height: var(--tap-min); }
    .ck-ventana.ck-flota {
      position: absolute; top: 100%; left: 0; right: 0; max-height: 60vh; overflow-y: auto; overscroll-behavior: contain;
      display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-3) var(--sp-4) var(--sp-4);
      background: var(--card-bg); color: var(--text-main); border-bottom: 1px solid var(--border-color);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
    }
    .ck-v-top { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .ck-sin { display: inline-flex; align-items: center; gap: var(--sp-1); margin: 0; font-size: var(--fs-xs); color: var(--text-muted); white-space: nowrap; }
    .ck-copia {
      display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap;
      font-size: var(--fs-xs); color: var(--text-muted);
    }
    .ck-copia > span { flex: 1; min-width: 12rem; }
    .ck-copia.warn { color: var(--warn-fg); }
    .ck-copia-btn {
      min-height: max(var(--tap-min), 2rem); padding: 0 var(--sp-3);
      border: 1px solid var(--border-color); border-radius: var(--r-pill);
      background: var(--card-bg); color: var(--text-main); font: inherit; font-weight: var(--fw-bold); cursor: pointer;
    }
    .ck-copia-btn:disabled { opacity: .5; cursor: default; }
    .ck-nota { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.4; }
    /* [MCP.26] Texto en --warn-soft-fg: --warn-fg sobre blanco da 2.15:1 (no pasa AA); es para rellenos e iconos. */
    .ck-nota.warn { color: var(--warn-soft-fg); }
    .ck-aviso {
      display: flex; align-items: flex-start; gap: var(--sp-2); padding: var(--sp-3);
      border: 1px solid var(--warn-border); border-radius: var(--r-md); background: var(--warn-soft-bg); color: var(--warn-soft-fg);
      font-size: var(--fs-sm); line-height: 1.4;
    }
    .ck-cargando, .ck-ayuda { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); }
    .ck-ficha {
      display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-4);
      background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-lg);
    }
    .ck-f-top { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); flex-wrap: wrap; }
    .ck-clave { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-muted); }
    .ck-nombre { margin: 0; font-size: var(--fs-h3); font-weight: var(--fw-bold); color: var(--text-main); overflow-wrap: anywhere; }
    .ck-pres { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .ck-p {
      display: grid; grid-template-columns: 1fr auto; align-items: baseline; gap: 0 var(--sp-3);
      padding: var(--sp-2) 0; border-top: 1px solid var(--border-color);
    }
    .ck-p:first-child { border-top: 0; }
    .ck-p.leida { border-left: 3px solid var(--action); padding-left: var(--sp-2); }
    .ck-p-nom { font-size: var(--fs-body); font-weight: var(--fw-bold); color: var(--text-main); }
    .ck-leida { margin-left: var(--sp-1); font-size: var(--fs-micro); font-weight: var(--fw-bold); color: var(--action); }
    .ck-p-precio { font-family: var(--font-mono); font-size: var(--fs-h2); font-weight: var(--fw-black); color: var(--text-main); font-variant-numeric: tabular-nums; }
    .ck-p-trae { grid-column: 1 / -1; font-size: var(--fs-xs); color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .ck-promo { margin: 0; font-size: var(--fs-sm); color: var(--warn-fg); }
    .ck-vacio { text-align: center; color: var(--text-muted); padding: var(--sp-6) var(--sp-3); display: flex; flex-direction: column; gap: var(--sp-2); align-items: center; }
    .ck-vacio > .pi { font-size: var(--fs-h2); color: var(--text-faint); }
    .ck-vacio p { margin: 0; font-size: var(--fs-sm); }
    .ck-volver {
      align-self: flex-start; display: inline-flex; align-items: center; gap: var(--sp-2);
      min-height: max(var(--tap-min), 2.25rem); padding: 0 var(--sp-3);
      border: 1px solid var(--border-color); border-radius: var(--r-pill); background: var(--card-bg); color: var(--text-main);
      font: inherit; font-size: var(--fs-sm); font-weight: var(--fw-bold); cursor: pointer;
    }
    .ck-lista-t { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .ck-lista { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
    .ck-r {
      width: 100%; display: flex; flex-direction: column; gap: var(--sp-1); text-align: left;
      min-height: var(--tap-min); padding: var(--sp-3);
      background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md);
      color: var(--text-main); font: inherit; cursor: pointer;
    }
    .ck-r-nom { font-size: var(--fs-body); font-weight: var(--fw-bold); overflow-wrap: anywhere; }
    .ck-r-sub { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-muted); }
    .ck-r-precios { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-3); font-size: var(--fs-xs); color: var(--text-muted); }
    .ck-r-precios b { color: var(--text-main); font-variant-numeric: tabular-nums; }
    /* [VTK.17] Lo que trae cada presentación, y los dos mayoreos (en la lista y en la ficha). */
    .ck-trae { font-size: inherit; color: var(--text-muted); }
    .ck-r-may { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-3); font-size: var(--fs-xs); color: var(--text-muted); }
    .ck-r-may b { color: var(--text-main); font-variant-numeric: tabular-nums; }
    .ck-may { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
    .ck-may li { display: flex; align-items: baseline; gap: var(--sp-2); flex-wrap: wrap; font-size: var(--fs-sm); color: var(--text-muted); }
    .ck-may b { color: var(--text-main); font-size: var(--fs-body); font-variant-numeric: tabular-nums; }
    .ck-may-e { font-size: var(--fs-xs); }
    .ck-v-top.warn { color: var(--warn-fg); }
    .chip { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-xs); font-weight: var(--fw-bold); padding: var(--sp-1) var(--sp-2); border-radius: var(--r-pill); white-space: nowrap; }
    .chip.ok { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .chip.warn { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
  `],
})
export class VendorChecadorPreciosComponent implements OnInit, OnDestroy {
  /**
   * `[VTK.17]` Compacto: la caja va en el encabezado de la app, en TODAS las pantallas (David, 2026-11-09:
   * «lo quiero siempre al alcance, sin importar en qué ventana esté; básate en el de arqueos»). Lo
   * encontrado flota bajo el encabezado y se cierra con la X de la caja, con Esc o tocando fuera.
   */
  readonly compacto = input(false);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  /** `[VTK.17]` En compacto, la ventana existe sólo mientras se busca o se muestra algo. */
  readonly abierta = computed(() => {
    const t = this.texto();
    const r = this.resultado();
    const c = this.consultando();
    const a = this.avisoCamara();
    return this.compacto() && (!!t.trim() || !!r || c || !!a);
  });
  private readonly svc = inject(ChecadorPreciosService);
  private readonly vendor = inject(VendorService);
  private readonly red = inject(ConnectivityService);

  readonly limite = 30;
  readonly enLinea = this.red.online;
  readonly copia = this.svc.copia;

  /** La sucursal cuyo precio se consulta. `cargando` mientras se pregunta. */
  readonly sucursal = signal<{ estado: 'cargando' } | { estado: 'lista'; s: Extract<SucursalChecador, { ok: true }> } | { estado: 'no'; motivo: string }>({ estado: 'cargando' });
  readonly texto = signal('');
  readonly hallados = signal<HalladoEnCopia[] | null>([]);
  readonly resultado = signal<ResultadoConsulta | null>(null);
  readonly consultando = signal(false);
  readonly descargando = this.svc.bajandoCopia;
  readonly errorCopia = signal<string | null>(null);
  readonly avisoCamara = signal<string | null>(null);
  /** `[MCP.26]` El micrófono (sólo en la pantalla completa) y por qué no buscó, si no buscó. */
  private readonly voz = viewChild(DictarBusquedaComponent);
  readonly vozError = computed(() => this.voz()?.error() ?? null);
  readonly vozEscucha = computed(() => this.voz()?.escuchando() ?? false);

  private readonly campo = viewChild<ElementRef<HTMLInputElement>>('campo');
  private temporizador: ReturnType<typeof setTimeout> | null = null;
  /** Cada consulta tiene su número: una respuesta vieja no pisa a la nueva. */
  private turno = 0;

  readonly nombreSucursal = computed(() => {
    const s = this.sucursal();
    return s.estado === 'lista' ? s.s.nombre : '';
  });
  readonly sucursalDeLaCopia = computed(() => {
    const s = this.sucursal();
    return s.estado === 'lista' && s.s.deLaCopia;
  });
  readonly motivoSinSucursal = computed(() => {
    const s = this.sucursal();
    return s.estado === 'no' ? s.motivo : '';
  });

  /** La copia que no es de hoy (o de formato anterior, o la que no se pudo guardar) se pinta en aviso. */
  readonly copiaEnAviso = computed(() => {
    const c = this.copia();
    const error = this.errorCopia();
    if (error) return true;
    if (!c) return !this.enLinea();
    return c.formatoAnterior || !cuandoEs(c.generado).esDeHoy;
  });

  readonly textoCopia = computed(() => {
    const c = this.copia();
    const enLinea = this.enLinea();
    const error = this.errorCopia();
    if (this.descargando()) return 'Guardando la copia de precios para usar sin señal…';
    if (!c) {
      if (error) return `No se pudo guardar la copia: ${error}`;
      return enLinea
        ? 'Sin copia guardada en este teléfono: sin señal no podrás consultar.'
        : 'Sin señal y sin copia guardada: sólo se podrá consultar cuando vuelva la señal.';
    }
    const cuando = cuandoEs(c.generado);
    const total = c.total.toLocaleString('es-MX');
    const base = cuando.esDeHoy
      ? `Copia para usar sin señal: ${cuando.texto} · ${total} productos`
      : `Copia para usar sin señal del ${cuando.texto} · no es de hoy · ${total} productos`;
    const formato = c.formatoAnterior ? ' · formato anterior: puede faltar información' : '';
    return error ? `${base}${formato}. No se pudo actualizar: ${error}` : `${base}${formato}`;
  });

  readonly puedeActualizarCopia = computed(() => {
    const c = this.copia();
    const enLinea = this.enLinea();
    if (!enLinea) return false;
    return !c || c.formatoAnterior || !cuandoEs(c.generado).esDeHoy || !!this.errorCopia();
  });

  /** Los renglones de la lista con sus presentaciones ya contadas (la misma regla del verificador). */
  readonly renglones = computed<Renglon[]>(() =>
    (this.hallados() ?? []).map(({ b, esPromocion }) => ({
      clave: b.item.c,
      nombre: b.item.n,
      presentaciones: presentacionesDe(unidadesDelRespaldo(b.item)),
      esPromocion,
      mayoreo: mayoreoDelRespaldo(b.item).mayoreo,
      proveedor: b.proveedor ?? null,
    })),
  );

  /** `[VTK.17]` «Mayoreo desde 3 paquetes». */
  desdeTexto(e: Escalon): string {
    return `desde ${e.desde} ${e.desde === 1 ? e.singular : e.plural}`;
  }

  async ngOnInit(): Promise<void> {
    await this.resolverSucursal();
    const s = this.sucursal();
    if (s.estado === 'lista') await this.prepararCopia(s.s.codigo);
  }

  ngOnDestroy(): void {
    if (this.temporizador) clearTimeout(this.temporizador);
    this.turno++;
  }

  /** La sucursal de surtido (la misma de Tomar pedido). Sin señal, la de la última copia — y se dice. */
  private async resolverSucursal(): Promise<void> {
    try {
      const f = await firstValueFrom(this.vendor.myStockSources());
      const s = sucursalDelChecador(f?.sucursal ?? null);
      this.sucursal.set(s.ok ? { estado: 'lista', s } : { estado: 'no', motivo: s.motivo });
    } catch (e) {
      const ultima = await this.svc.ultimaCopia().catch(() => null);
      if (ultima) {
        this.sucursal.set({ estado: 'lista', s: { ok: true, codigo: ultima.sucursal, nombre: ultima.nombreSucursal, deLaCopia: true } });
        return;
      }
      this.sucursal.set({
        estado: 'no',
        motivo: esSinSenal(e)
          ? 'Sin señal y sin copia guardada en este teléfono: no se puede saber tu sucursal ni consultar precios. Abre esta pantalla con señal una vez para guardar la copia.'
          : 'No se pudo saber tu sucursal de surtido. Sal y vuelve a entrar para intentarlo de nuevo.',
      });
    }
  }

  private async prepararCopia(sucursal: string): Promise<void> {
    const { fallo } = await this.svc.asegurarCopia(sucursal, this.enLinea());
    this.errorCopia.set(fallo ? this.motivoCopia(fallo) : null);
    // Si se escribió mientras bajaba, la lista se arma ya con la copia.
    if (this.texto().trim()) this.buscarAhora();
  }

  async actualizarCopia(): Promise<void> {
    const s = this.sucursal();
    if (s.estado !== 'lista' || this.descargando()) return;
    try {
      await this.svc.descargarCopia(s.s.codigo);
      this.errorCopia.set(null);
    } catch (e) {
      this.errorCopia.set(this.motivoCopia(e));
    }
    if (this.texto().trim()) this.buscarAhora();
  }

  alEscribir(v: string): void {
    this.texto.set(String(v ?? ''));
    this.resultado.set(null);
    this.avisoCamara.set(null);
    if (this.temporizador) clearTimeout(this.temporizador);
    this.temporizador = setTimeout(() => this.buscarAhora(), 120);
  }

  /** Busca lo escrito en la copia (nombre, clave, código). */
  buscarAhora(): void {
    if (this.temporizador) clearTimeout(this.temporizador);
    this.temporizador = null;
    const s = this.sucursal();
    const q = this.texto();
    if (s.estado !== 'lista' || !q.trim()) { this.hallados.set([]); return; }
    void this.svc.buscarEnCopia(s.s.codigo, q, this.limite).then((r) => {
      if (this.texto() === q) this.hallados.set(r);
    });
  }

  /**
   * `Enter`: si la lista tiene UN producto, o uno cuyo código es exactamente lo escrito, se consulta
   * ése. Si lo escrito parece un código, se pregunta a Kepler aunque no esté en la copia (puede ser
   * nuevo, o no haber copia). Con un nombre y varios resultados no hace nada: la lista ya está.
   */
  async alEnter(): Promise<void> {
    const q = this.texto().trim();
    if (!q) return;
    if (this.temporizador) {
      this.buscarAhora();
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    const lista = this.hallados() ?? [];
    const exacto = lista.find((x) => x.exacto);
    if (exacto) return this.consultar(exacto.b.item.c);
    if (lista.length === 1) return this.consultar(lista[0].b.item.c);
    if (pareceCodigo(q)) return this.consultar(q);
  }

  elegir(clave: string): Promise<void> {
    return this.consultar(clave);
  }

  /** La cámara leyó un código: se escribe en el campo (para que se vea qué se leyó) y se consulta. */
  alLeerCodigo(codigo: string): Promise<void> {
    if (this.temporizador) clearTimeout(this.temporizador);
    this.temporizador = null;
    this.texto.set(codigo);
    this.hallados.set([]);
    this.avisoCamara.set(null);
    return this.consultar(codigo);
  }

  async consultar(codigo: string): Promise<void> {
    const s = this.sucursal();
    if (s.estado !== 'lista') return;
    const turno = ++this.turno;
    this.consultando.set(true);
    try {
      const r = await this.svc.consultar(codigo, s.s.codigo);
      if (turno === this.turno) this.resultado.set(r);
    } finally {
      if (turno === this.turno) this.consultando.set(false);
    }
  }

  limpiar(): void {
    this.turno++;
    this.consultando.set(false);
    this.texto.set('');
    this.hallados.set([]);
    this.resultado.set(null);
    this.avisoCamara.set(null);
    // En compacto cerrar es cerrar: devolverle el foco a la caja abriría el teclado del celular otra vez.
    if (!this.compacto()) this.campo()?.nativeElement.focus();
  }

  /** `[VTK.17]` En compacto, tocar fuera (otra parte de la pantalla, la barra de abajo) cierra la ventana. */
  alTocarFuera(ev: Event): void {
    if (!this.abierta()) return;
    const t = ev.target as Node | null;
    if (t && this.host.nativeElement.contains(t)) return;
    this.limpiar();
  }

  dinero(v: number | null | undefined): string {
    return v == null || !Number.isFinite(Number(v)) ? 'sin precio' : pesos.format(Number(v));
  }

  cuando(iso: string | null | undefined): { texto: string; esDeHoy: boolean } {
    return cuandoEs(iso);
  }

  /** «de hoy 08:12» / «del 7 nov, 18:03» / «de ayer 18:03». */
  deCuando(iso: string | null | undefined): string {
    const c = cuandoEs(iso);
    return c.texto.startsWith('hoy') || c.texto.startsWith('ayer') ? `de ${c.texto}` : `del ${c.texto}`;
  }

  textoMotivo(m: keyof typeof TEXTO_MOTIVO): string {
    return TEXTO_MOTIVO[m];
  }

  pareceCodigo(t: string): boolean {
    return pareceCodigo(t);
  }

  private motivoCopia(e: unknown): string {
    if (esSinSenal(e)) return 'sin señal.';
    const status = (e as { status?: unknown } | null)?.status;
    return typeof status === 'number' && status > 0 ? `el servidor contestó ${status}.` : 'llegó vacía o no se pudo leer.';
  }
}
