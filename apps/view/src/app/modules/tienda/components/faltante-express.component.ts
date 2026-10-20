import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  FaltantesService,
  type ConsultaFaltante,
  type ReportarResultado,
} from '../faltantes.service';
import {
  VerificadorService,
  type HalladoCatalogo,
  type MayoreoTier,
  type UnidadPrecio,
} from '../verificador.service';
import {
  MOTIVO_AUTOMATICO,
  anotaSolo,
  pasoDeReloj,
  porcentajeReloj,
  type VeredictoExistencia,
} from '../faltante-express';
import {
  ETIQUETA_CAMPO,
  escalonesDe,
  presentacionesDe,
  tramoNormal,
} from '../mostrador-catalogo';

/**
 * El producto que se está mostrando. `[MOS.1]` Lleva TODAS sus presentaciones (con lo que trae
 * cada una) y su mayoreo, no sólo el precio de la base: es lo que el cliente pregunta.
 */
type Hallado = {
  codigo: string;
  nombre: string;
  proveedor: string | null;
  unidades: UnidadPrecio[];
  mayoreo: MayoreoTier[];
};

type Aviso = { tono: 'warn' | 'bad'; texto: string } | null;

/**
 * `[MOS.2]` Un código escaneado que Kepler no tiene: en ninguna sucursal (`no_en_catalogo`) o no
 * en ésta (`no_en_sucursal`). Se anota solo en la lista de No registrados de Compras.
 */
type NoRegistradoAviso = {
  kind: 'no_en_catalogo' | 'no_en_sucursal';
  codigo: string;
  sku: string | null;
  nombre: string | null;
  enviando: boolean;
  anotado: ReportarResultado | null;
  descrito: string | null;
};

/** De dónde salieron los precios que se están mostrando. Un precio sin procedencia no se puede defender. */
type OrigenPrecio = 'vivo' | 'respaldo' | 'sin_dato';

const PASO_MS = 100;

@Component({
  selector: 'app-faltante-express',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fx" [class.fx-compacto]="compacto()">
      <!-- ── La caja. Es lo único que hay cuando no pasa nada. ──────────────────────────── -->
      @if (compacto()) {
        <label class="fx-lbl-min" for="fx-q"><i class="pi pi-search" aria-hidden="true"></i> ¿Te pidieron algo?</label>
      } @else {
        <label class="fx-lbl" for="fx-q">¿Qué te pidieron?</label>
      }
      <div class="fx-wrap">
        <i class="pi pi-search fx-ico" aria-hidden="true"></i>
        <input #caja id="fx-q" type="search" class="fx-input" autocomplete="off" spellcheck="false"
               [ngModel]="termino()" (ngModelChange)="alEscribir($event)"
               (keydown)="alTeclear($event)"
               [disabled]="!sucursal()"
               [placeholder]="sucursal() ? 'Nombre, proveedor, SKU o código de barras' : 'Elige la sucursal para poder buscar'"
               [attr.aria-describedby]="sucursal() ? 'fx-ayuda' : null" />
        @if (buscando()) { <i class="pi pi-spin pi-spinner fx-spin" aria-hidden="true"></i> }

        <!-- [MOS.1] Desplegable: nombre, POR QUÉ salió, clave, proveedor y TODAS las
             presentaciones con su precio, mayoreo incluido. Es lo que convierte esta caja en el
             verificador: el cliente pregunta "¿y por caja?" y la respuesta ya está a la vista. -->
        @if (listaAbierta()) {
          <ul class="fx-lista" role="listbox" aria-label="Productos encontrados">
            @for (r of filas(); track r.codigo; let i = $index) {
              <li>
                <button type="button" class="fx-fila" role="option"
                        [attr.aria-selected]="i === resaltado()"
                        [class.on]="i === resaltado()"
                        (mouseenter)="resaltado.set(i)"
                        (click)="elegir(r)">
                  <span class="fx-fila-top">
                    <span class="fx-fila-n">{{ r.nombre }}</span>
                    <span class="fx-por">{{ r.porEtiqueta }}</span>
                  </span>
                  <span class="fx-fila-meta">
                    <span class="num">SKU {{ r.codigo }}</span>
                    @if (r.proveedor) { <span>{{ r.proveedor }}</span> }
                  </span>
                  <span class="fx-pres">
                    @for (p of r.pres; track p.u) {
                      <span class="fx-pz">
                        <b>{{ p.u }}</b>
                        @if (p.trae) { <span class="fx-pz-x">{{ p.trae.n }} {{ p.trae.u }}</span> }
                        <span class="num">{{ p.precio | currency:'MXN':'symbol-narrow':'1.2-2':'es-MX' }}</span>
                      </span>
                    } @empty { <em class="fx-muted">sin precio</em> }
                    @for (e of r.esc; track $index) {
                      <span class="fx-pz fx-pz-may">
                        <b>Mayoreo</b>
                        <span class="num">{{ e.precio | currency:'MXN':'symbol-narrow':'1.2-2':'es-MX' }}</span>
                        <span class="fx-pz-x">{{ e.etiqueta }}</span>
                      </span>
                    }
                  </span>
                </button>
              </li>
            }
          </ul>
        }
      </div>

      <!-- Sin sucursal la caja está deshabilitada, y eso TIENE que decirse. Deshabilitada y muda
           se lee como "está roto": la persona teclea, no pasa nada, y no hay forma de saber que
           el problema está en un campo de más arriba. En la pantalla de faltantes no aparece
           porque ahí la tarjeta ni se dibuja hasta elegir sucursal; acá convive con el arqueo,
           que se abre con la sucursal todavía en blanco cuando alguien alcanza más de una. -->
      @if (!sucursal()) {
        <p class="fx-sin-suc" role="status">
          @if (compacto()) {
            <!-- En compacto NO dice "de arriba": en el arqueo el selector esta ABAJO, y
                 mandar a mirar donde no esta es peor que no decir nada. -->
            <i class="pi pi-info-circle" aria-hidden="true"></i>
            <span>Elige la <strong>sucursal</strong> del arqueo para poder buscar: el precio y la existencia cambian por plaza.</span>
          } @else {
            <i class="pi pi-arrow-up" aria-hidden="true"></i>
            <span>Elige primero la <strong>sucursal</strong> de arriba. El mismo código tiene precio
              y existencia distintos en cada plaza, así que sin ella no hay nada que contestar.</span>
          }
        </p>
      } @else if (!compacto()) {
        <p id="fx-ayuda" class="fx-ayuda">
          La ventana se cierra sola en {{ segundosVentana }} s. Si no hay existencia, el faltante
          queda anotado sin preguntar nada.
        </p>
      }

      @if (aviso(); as a) {
        <div class="fx-aviso" [class]="'t-' + a.tono" role="status">{{ a.texto }}</div>
      }

      <!-- [MOS.2] El código no está en Kepler (o no en esta sucursal). Se anota SOLO en la lista
           de No registrados de Compras; aquí se dice, y se puede quitar si fue un error. -->
      @if (noReg(); as n) {
        <section class="fx-nr" role="status" aria-live="polite">
          <i class="pi pi-exclamation-triangle fx-nr-ico" aria-hidden="true"></i>
          <div class="fx-nr-cuerpo">
            @if (n.kind === 'no_en_sucursal') {
              <strong>{{ n.nombre || n.codigo }} no está dado de alta en esta sucursal.</strong>
              <span>Existe en Kepler (SKU {{ n.sku }}), pero no aquí: no se le puede dar precio.
                @if (n.anotado) { Quedó en No registrados para Compras. }</span>
            } @else {
              <strong>El código {{ n.codigo }} no está registrado en Kepler.</strong>
              @if (n.anotado) {
                <span>Quedó en No registrados para Compras.</span>
                @if (n.descrito) {
                  <span>Guardado: «{{ n.descrito }}».</span>
                } @else {
                  <label class="fx-nr-lbl" for="fx-nr-desc">Si sabes qué es, escríbelo (opcional):</label>
                  <div class="fx-nr-form">
                    <input id="fx-nr-desc" class="fx-input fx-nr-input" type="text" autocomplete="off"
                           maxlength="120" placeholder="Ej. gomita enchilada 1 kg"
                           [ngModel]="descripcion()" (ngModelChange)="descripcion.set($event)"
                           (keydown.enter)="guardarDescripcion()" />
                    <button type="button" class="fx-igual" (click)="guardarDescripcion()"
                            [disabled]="describiendo() || !descripcion().trim()">
                      {{ describiendo() ? 'Guardando…' : 'Guardar' }}
                    </button>
                  </div>
                }
              }
            }
            @if (!n.anotado && n.enviando) { <span>Anotando…</span> }
          </div>
          <div class="fx-nr-acc">
            @if (n.anotado) {
              <button type="button" class="fx-quitar" (click)="quitarNoRegistrado()" [disabled]="deshaciendo()">
                {{ deshaciendo() ? 'Quitando…' : 'Quitar' }}
              </button>
            }
            <button type="button" class="fx-cerrar" (click)="cerrarNoRegistrado()" aria-label="Cerrar aviso">
              <i class="pi pi-times" aria-hidden="true"></i>
            </button>
          </div>
        </section>
      }

      <!-- ── La ventana con tiempo ──────────────────────────────────────────────────────── -->
      @if (ventana()) {
        <section class="fx-ventana" role="status" aria-live="polite"
                 (mouseenter)="pausar(true)" (mouseleave)="pausar(false)"
                 (focusin)="pausar(true)" (focusout)="pausar(false)">
          <div class="fx-v-cuerpo">
            <div class="fx-v-izq">
              <div class="fx-v-nom">
                <strong>{{ elegido()?.nombre }}</strong>
                <span class="fx-v-sku">{{ elegido()?.codigo }}</span>
                @if (elegido()?.proveedor) { <span class="fx-v-prov">{{ elegido()?.proveedor }}</span> }
              </div>

              <!-- [MOS.1] Cada presentación con lo que trae: la caja en paquetes cuando se puede. -->
              @if (presentaciones().length) {
                <ul class="fx-tab" aria-label="Presentaciones y precio">
                  <li class="fx-tab-h" aria-hidden="true">
                    <span>Presentación</span><span class="r">Trae</span><span class="r">Precio</span><span class="r"></span>
                  </li>
                  @for (p of presentaciones(); track p.u) {
                    <li>
                      <span>{{ p.nombre }}</span>
                      <span class="r num fx-muted-n">{{ p.trae ? p.trae.n + ' ' + p.trae.palabra : '—' }}</span>
                      <span class="r num fx-tab-p">{{ p.precio | currency:'MXN':'symbol-narrow':'1.2-2':'es-MX' }}</span>
                      <span class="r num fx-muted-n">
                        @if (p.precioPorTrae !== null) {
                          {{ p.precioPorTrae | currency:'MXN':'symbol-narrow':'1.2-2':'es-MX' }} {{ p.etiquetaPorTrae }}
                        }
                      </span>
                    </li>
                  }
                </ul>
              } @else {
                <span class="fx-sin">sin precio</span>
              }

              <!-- [MOS.1] El mayoreo, en la presentación en que Kepler lo captura. -->
              @if (escalones().length) {
                <div class="fx-escs">
                  @for (e of escalones(); track $index) {
                    <div class="fx-esc">
                      <span class="fx-esc-t">Mayoreo por <strong>{{ e.singular }}</strong></span>
                      @if (e.precioNormal !== null) {
                        <span class="fx-esc-f"><span>{{ e.tramo }}</span>
                          <span class="num">{{ e.precioNormal | currency:'MXN':'symbol-narrow':'1.2-2':'es-MX' }} {{ e.etiqueta }}</span></span>
                      }
                      <span class="fx-esc-f fx-esc-on"><span>{{ e.desde }} {{ e.plural }} o más</span>
                        <span class="num"><strong>{{ e.precio | currency:'MXN':'symbol-narrow':'1.2-2':'es-MX' }}</strong> {{ e.etiqueta }}</span></span>
                    </div>
                  }
                </div>
              }
              <div class="fx-v-origen">
                @switch (origenPrecio()) {
                  @case ('vivo') { <span class="fx-chip ok"><i class="pi pi-circle-fill" aria-hidden="true"></i> Precio en vivo</span> }
                  @case ('respaldo') { <span class="fx-chip warn">De respaldo — puede haber cambiado</span> }
                  @default { <span class="fx-chip warn">No se pudo leer el precio</span> }
                }
              </div>
            </div>

            <div class="fx-v-der">
              <!-- El veredicto. Tres respuestas, no dos: "no se pudo leer" NUNCA se dibuja
                   como cero, porque mandan a hacer cosas opuestas. -->
              @if (!consulta()) {
                <div class="fx-ver v-cargando">
                  <i class="pi pi-spin pi-spinner" aria-hidden="true"></i>
                  <div><strong>Consultando existencia…</strong></div>
                </div>
              } @else {
                <div class="fx-ver" [class]="'v-' + (veredicto() ?? 'no_medido')">
                  @switch (veredicto()) {
                    @case ('hay_en_tienda') {
                      <i class="pi pi-check-circle" aria-hidden="true"></i>
                      <div>
                        <strong>Hay {{ consulta()?.existencia }}</strong>
                        <span>Está en la tienda.</span>
                      </div>
                    }
                    @case ('sin_existencia') {
                      <i class="pi pi-times-circle" aria-hidden="true"></i>
                      <div>
                        <strong>No hay — existencia 0</strong>
                        <span>La venta ya se perdió.</span>
                      </div>
                    }
                    @default {
                      <i class="pi pi-question-circle" aria-hidden="true"></i>
                      <div>
                        <strong>Existencia sin medir</strong>
                        <span>No se pudo leer. No es cero.</span>
                      </div>
                    }
                  }
                </div>
              }

              <!-- Lo que pasó solo, y cómo salirse. -->
              @if (anotado(); as a) {
                @if (!deshecho()) {
                  <div class="fx-anot">
                    <i class="pi pi-flag-fill" aria-hidden="true"></i>
                    <div class="fx-anot-t">
                      <strong>Anotado en faltantes</strong>
                      <span>
                        {{ a.times_reported }} {{ a.times_reported === 1 ? 'vez' : 'veces' }} esta semana
                        @if (a.est_lost_revenue !== null) {
                          · {{ a.est_lost_revenue | currency:'MXN':'symbol-narrow':'1.2-2':'es-MX' }}
                        }
                      </span>
                    </div>
                    <button type="button" class="fx-quitar" (click)="deshacer()" [disabled]="deshaciendo()">
                      {{ deshaciendo() ? 'Quitando…' : 'Quitar' }}
                    </button>
                  </div>
                } @else {
                  <div class="fx-nada">
                    <i class="pi pi-replay" aria-hidden="true"></i>
                    <span>Quitado. No se anotó nada.</span>
                  </div>
                }
              }

              <!-- El único botón de la ventana, y sólo en el caso que no se anota solo. -->
              @if (ofreceAnotarIgual()) {
                <div class="fx-nada">
                  <span>No se anotó nada: cero y «no se pudo leer» no son lo mismo.</span>
                  <button type="button" class="fx-igual" (click)="anotarIgual()" [disabled]="enviando()">
                    {{ enviando() ? 'Anotando…' : 'Anotar igual' }}
                  </button>
                </div>
              }
            </div>
          </div>

          <div class="fx-reloj">
            <div class="fx-barra" [class]="'b-' + (veredicto() ?? 'no_medido')">
              <span [style.width.%]="porcentaje()"></span>
            </div>
            <span class="fx-seg">{{ pausado() ? 'en pausa' : 'se cierra en ' + segundos() + ' s' }}</span>
            <button type="button" class="fx-cerrar" (click)="cerrar()" aria-label="Cerrar ahora">
              <i class="pi pi-times" aria-hidden="true"></i>
            </button>
          </div>
        </section>
      }
    </div>
  `,
  styles: [`
    /* ── Modo tira: el buscador como ACCESORIO, no como seccion ──────────────────
       El arqueo existe para contar efectivo; esta caja no puede comerse el alto.
       ⚠️ .fx.fx-compacto y no .fx-compacto a secas: .fx se declara MAS ABAJO
       con flex-direction: column y la misma especificidad (0,1,0), asi que la
       regla de una sola clase perdia por orden y la tira salia apilada. Con las
       dos clases (0,2,0) gana sin importar el orden. */
    .fx.fx-compacto { flex-direction: row; flex-wrap: wrap; align-items: center; gap: .25rem .5rem; }
    .fx.fx-compacto .fx-lbl-min { display: inline-flex; align-items: center; gap: .25rem; flex: 0 0 auto;
                                  font-size: var(--fs-xs); font-weight: 500; color: var(--text-muted); white-space: nowrap; }
    .fx.fx-compacto .fx-wrap { flex: 1 1 14rem; min-width: 0; max-width: 28rem; }
    /* A la altura del boton de ayuda del mismo renglon, no mas. */
    .fx.fx-compacto .fx-input { min-height: 1.85rem; font-size: var(--fs-sm); padding-left: 1.85rem; }
    .fx.fx-compacto .fx-ico { font-size: var(--fs-xs); left: .55rem; }
    .fx.fx-compacto .fx-sin-suc { flex: 1 1 14rem; min-width: 0; margin: 0; padding: 0;
                                  border: 0; background: none; font-size: var(--fs-micro); }
    /* La ventana con el precio y la existencia NO entra en el renglon: baja a su
       propia linea y ocupa todo el ancho. Es la respuesta, y dura unos segundos. */
    .fx.fx-compacto .fx-ventana { flex: 1 1 100%; }
    .fx.fx-compacto .fx-nr { flex: 1 1 100%; }
    /* ⚠️ Lo compacto es para el MOUSE. Con el dedo vuelve el minimo de 44px
       (DESIGN §11, Ley de Fitts): un campo de 30px en una tablet es un objetivo
       que se falla, y esta caja la usa alguien con un cliente enfrente. El
       font-size de 1rem no es estetica: por debajo de 16px Safari en iOS hace
       zoom al enfocar y descuadra la pantalla a media captura. */
    @media (pointer: coarse) {
      .fx.fx-compacto .fx-input { min-height: var(--tap-min, 44px); font-size: 1rem; padding-left: 2.1rem; }
      .fx.fx-compacto .fx-ico { left: .75rem; }
      .fx.fx-compacto .fx-lbl-min { font-size: var(--fs-sm); }
    }

    /* Operations (DESIGN §O). Todo por token: dark funciona solo. */
    .fx { display: flex; flex-direction: column; gap: .5rem; }
    .fx-lbl { font-size: var(--fs-sm, .82rem); font-weight: 700; color: var(--text-main); }
    .fx-wrap { position: relative; display: flex; align-items: center; }
    .fx-ico { position: absolute; left: .7rem; color: var(--text-muted); font-size: .85rem; pointer-events: none; }
    .fx-spin { position: absolute; right: .7rem; color: var(--text-muted); font-size: .85rem; }
    .fx-input { width: 100%; min-height: var(--tap-min, 44px); padding: 0 .75rem 0 2.1rem;
      border: 1px solid var(--border-color); border-radius: var(--r-sm, 8px);
      background: var(--card-bg); color: var(--text-main); font: inherit; font-size: .95rem; }
    .fx-input:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
    .fx-ayuda { margin: 0; font-size: .72rem; color: var(--text-muted); }
    /* El aviso de "falta la sucursal" NO es un error: es una instruccion. Por eso usa el tono de
       aviso y no el rojo -- nadie se equivoco todavia, falta un paso. */
    .fx-sin-suc { margin: 0; display: flex; align-items: flex-start; gap: .4rem;
      font-size: .74rem; line-height: 1.35; padding: .45rem .6rem;
      border-radius: var(--r-sm, 8px); background: var(--warn-soft-bg);
      color: var(--warn-soft-fg); border: 1px solid var(--warn-border); }
    .fx-sin-suc i { font-size: .8rem; margin-top: .1rem; flex: 0 0 auto; }

    /* [MOS.1] Mas ancha que la caja: cada renglon lleva las presentaciones con su precio. */
    .fx-lista { position: absolute; top: calc(100% + 4px); left: 0; z-index: 50;
      width: max(100%, min(36rem, 92vw));
      list-style: none; margin: 0; padding: 0; max-height: 24rem; overflow-y: auto;
      background: var(--card-bg); border: 1px solid var(--border-color);
      border-radius: var(--r-sm, 8px); box-shadow: var(--shadow-float); }
    .fx-lista li + li .fx-fila { border-top: 1px solid var(--border-color); }
    .fx-fila { width: 100%; display: flex; flex-direction: column; gap: .25rem;
      padding: .55rem .75rem; background: none; border: 0;
      cursor: pointer; text-align: left; color: var(--text-main); font: inherit; font-size: var(--fs-sm); }
    .fx-fila:hover, .fx-fila.on { background: var(--hover-bg); }
    .fx-fila:focus-visible { outline: 2px solid var(--action); outline-offset: -2px; }
    .fx-fila-top { display: flex; align-items: flex-start; justify-content: space-between; gap: .6rem; min-width: 0; }
    .fx-fila-n { font-weight: 600; min-width: 0; }
    .fx-por { flex: 0 0 auto; font-size: var(--fs-micro); font-weight: 600; white-space: nowrap;
      color: var(--text-muted); background: var(--neutral-100); border-radius: var(--r-pill, 999px);
      padding: .05rem .45rem; }
    .fx-fila-meta { display: flex; flex-wrap: wrap; gap: .1rem .7rem; font-size: var(--fs-xs); color: var(--text-muted); }
    .fx-pres { display: flex; flex-wrap: wrap; gap: .3rem; }
    .fx-pz { display: inline-flex; align-items: baseline; gap: .35rem; padding: .1rem .45rem;
      border: 1px solid var(--border-color); border-radius: 6px; font-size: var(--fs-xs); }
    .fx-pz b { font-size: var(--fs-micro); font-weight: 700; color: var(--text-muted); letter-spacing: .03em; }
    .fx-pz .num { font-weight: 600; }
    .fx-pz-x { font-size: var(--fs-micro); color: var(--text-faint); }
    .fx-pz-may { border-color: var(--ok-border); }
    .fx-pz-may b { color: var(--ok-soft-fg); }
    .fx-muted, .fx-sin { color: var(--text-muted); font-style: italic; font-weight: 400; }
    .num { font-variant-numeric: tabular-nums; }

    .fx-aviso { font-size: .78rem; padding: .5rem .7rem; border-radius: var(--r-sm, 8px); }
    .fx-aviso.t-warn { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .fx-aviso.t-bad { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }

    /* ── La ventana ──────────────────────────────────────────────────────────────────── */
    .fx-ventana { margin-top: .3rem; border: 1px solid var(--border-color);
      border-radius: var(--r-md, 12px); background: var(--card-bg); box-shadow: var(--shadow-float);
      overflow: hidden; }
    .fx-v-cuerpo { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(16rem, 100%), 1fr));
      gap: .8rem 1.2rem; padding: .85rem 1rem .7rem; }
    .fx-v-izq { min-width: 0; }
    .fx-v-nom { display: flex; align-items: baseline; gap: .5rem; flex-wrap: wrap; }
    .fx-v-nom strong { font-size: .95rem; }
    .fx-v-sku { font-family: var(--font-mono, monospace); font-size: .72rem; color: var(--text-muted);
      background: var(--neutral-100); border-radius: 4px; padding: .05rem .35rem; }
    .fx-v-prov { font-size: var(--fs-xs); color: var(--text-muted); }

    /* [MOS.1] Presentaciones: lista con forma de tabla chica (4 columnas alineadas). */
    .fx-tab { list-style: none; margin: .5rem 0 0; padding: 0; font-size: var(--fs-sm); }
    .fx-tab li { display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto; gap: .2rem .9rem;
      align-items: baseline; padding: .3rem 0; border-bottom: 1px solid var(--border-color); }
    .fx-tab li:last-child { border-bottom: 0; }
    .fx-tab .fx-tab-h { font-size: var(--fs-micro); font-weight: 600; text-transform: uppercase;
      letter-spacing: .06em; color: var(--text-faint); padding-top: 0; }
    .fx-tab .r { text-align: right; }
    .fx-tab-p { font-size: 1.05rem; font-weight: 700; }
    .fx-muted-n { color: var(--text-muted); font-size: var(--fs-xs); }

    /* [MOS.1] Escaleras de mayoreo. */
    .fx-escs { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(14rem, 100%), 1fr)); gap: .45rem; margin-top: .55rem; }
    .fx-esc { display: flex; flex-direction: column; gap: .2rem; padding: .45rem .55rem;
      border: 1px solid var(--border-color); border-radius: var(--r-sm, 8px); font-size: var(--fs-xs); }
    .fx-esc-t { color: var(--text-muted); }
    .fx-esc-t strong { color: var(--text-main); }
    .fx-esc-f { display: flex; justify-content: space-between; gap: .5rem; padding: .15rem .35rem; border-radius: 6px; }
    .fx-esc-on { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .fx-esc-on strong { font-size: var(--fs-sm); }

    /* [MOS.2] Aviso de codigo no registrado. Tono de aviso, no de error: no es culpa de nadie. */
    .fx-nr { display: flex; align-items: flex-start; gap: .6rem; padding: .6rem .75rem;
      border-radius: var(--r-sm, 8px); background: var(--warn-soft-bg); color: var(--warn-soft-fg);
      border: 1px solid var(--warn-border); }
    .fx-nr-ico { margin-top: .15rem; }
    .fx-nr-cuerpo { display: flex; flex-direction: column; gap: .3rem; min-width: 0; flex: 1 1 auto; font-size: var(--fs-xs); }
    .fx-nr-cuerpo strong { font-size: var(--fs-sm); }
    .fx-nr-lbl { font-weight: 600; }
    .fx-nr-form { display: flex; flex-wrap: wrap; gap: .4rem; }
    .fx-nr-input { flex: 1 1 14rem; max-width: 24rem; padding-left: .75rem; }
    .fx-nr-acc { display: flex; align-items: center; flex: 0 0 auto; }
    .fx-v-origen { margin-top: .35rem; }
    .fx-chip { display: inline-flex; align-items: center; gap: .3rem; font-size: .7rem; font-weight: 600;
      border-radius: var(--r-sm, 8px); padding: .1rem .4rem; }
    .fx-chip i { font-size: .45rem; }
    .fx-chip.ok { color: var(--ok-soft-fg); background: var(--ok-soft-bg); border: 1px solid var(--ok-border); }
    .fx-chip.warn { color: var(--warn-soft-fg); background: var(--warn-soft-bg); border: 1px solid var(--warn-border); }

    .fx-v-der { display: flex; flex-direction: column; gap: .45rem; min-width: 0; }
    .fx-ver { display: flex; align-items: flex-start; gap: .55rem; padding: .55rem .7rem;
      border-radius: var(--r-sm, 8px); }
    .fx-ver i { margin-top: .1rem; }
    .fx-ver div { display: flex; flex-direction: column; gap: .1rem; min-width: 0; }
    .fx-ver strong { font-size: .88rem; }
    .fx-ver span { font-size: var(--fs-xs); }
    .fx-ver.v-hay_en_tienda { background: var(--ok-soft-bg); color: var(--ok-soft-fg); border: 1px solid var(--ok-border); }
    .fx-ver.v-sin_existencia { background: var(--bad-soft-bg); color: var(--bad-soft-fg); border: 1px solid var(--bad-border); }
    .fx-ver.v-no_medido { background: var(--warn-soft-bg); color: var(--warn-soft-fg); border: 1px solid var(--warn-border); }
    .fx-ver.v-cargando { background: var(--neutral-100); color: var(--text-muted); border: 1px solid var(--border-color); }

    .fx-anot { display: flex; align-items: center; gap: .55rem; padding: .5rem .7rem;
      border-radius: var(--r-sm, 8px); background: color-mix(in srgb, var(--action) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--action) 35%, transparent); color: var(--brand-900); }
    .fx-anot-t { display: flex; flex-direction: column; gap: .1rem; min-width: 0; flex: 1 1 auto; }
    .fx-anot-t strong { font-size: .8rem; }
    .fx-anot-t span { font-size: .72rem; }
    .fx-quitar { flex: 0 0 auto; background: none; border: 0; font: inherit; font-size: .74rem;
      font-weight: 700; color: var(--brand-900); text-decoration: underline; cursor: pointer;
      min-height: var(--tap-min, 44px); padding: 0 .4rem; }
    .fx-nada { display: flex; align-items: center; gap: .55rem; flex-wrap: wrap; padding: .5rem .7rem;
      border-radius: var(--r-sm, 8px); background: var(--neutral-100); border: 1px solid var(--border-color);
      font-size: .74rem; color: var(--text-muted); }
    .fx-nada span { flex: 1 1 8rem; }
    .fx-igual { flex: 0 0 auto; min-height: var(--tap-min, 44px); padding: 0 .7rem;
      background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-sm, 8px);
      font: inherit; font-size: .76rem; font-weight: 700; color: var(--text-main); cursor: pointer; }
    .fx-igual:hover { border-color: var(--text-faint); }

    .fx-reloj { display: flex; align-items: center; gap: .6rem; padding: 0 1rem .7rem; }
    .fx-barra { flex: 1 1 auto; height: 4px; border-radius: 999px; background: var(--neutral-200); overflow: hidden; }
    .fx-barra span { display: block; height: 100%; border-radius: 999px; background: var(--text-faint);
      transition: width 100ms linear; }
    .fx-barra.b-hay_en_tienda span { background: var(--ok-fg); }
    .fx-barra.b-sin_existencia span { background: var(--bad-fg); }
    .fx-barra.b-no_medido span { background: var(--warn-fg); }
    .fx-seg { flex: 0 0 auto; font-size: .72rem; color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .fx-cerrar { flex: 0 0 auto; background: none; border: 0; color: var(--text-muted); cursor: pointer;
      width: var(--tap-min, 44px); height: 2rem; display: inline-flex; align-items: center; justify-content: center; }

    @media (prefers-reduced-motion: reduce) {
      .fx-barra span { transition: none; }
    }
  `],
})
export class FaltanteExpressComponent {
  private readonly api = inject(FaltantesService);
  private readonly verificador = inject(VerificadorService);
  private readonly destroyRef = inject(DestroyRef);

  /** Sucursal sobre la que se consulta y se anota. Explícita SIEMPRE: el kiosco no tiene sesión. */
  readonly sucursal = input.required<string | null>();
  /**
   * Modo tira: una sola linea, sin rotulo propio ni renglon de ayuda.
   *
   * Lo pide el arqueo, donde esta caja es un ACCESORIO — la pantalla existe para
   * contar efectivo y el buscador no puede comerse un cuarto del alto. En su
   * propia pantalla sigue completo, que es donde el rotulo y la ayuda valen.
   */
  readonly compacto = input(false);

  /**
   * `[FLT.16]` El código con el que llega quien viene del verificador. Se resuelve una sola vez,
   * para que la persona no lo vuelva a teclear con el cliente enfrente.
   */
  readonly codigoInicial = input<string | null>(null);

  /** Se emite cuando algo se escribió o se deshizo, para que la pantalla recargue su lista. */
  readonly cambio = output<void>();

  /** Ya se resolvió el código de entrada. Sin esto, cada repintado volvería a abrir la ventana. */
  private entradaResuelta = false;

  private readonly caja = viewChild<ElementRef<HTMLInputElement>>('caja');

  /**
   * Cuánto dura la ventana. Declarado acá y no suelto en el template para que se lea una vez.
   *
   * Pedido de Edgar: a la mitad. Eran 9 y la mitad exacta es 4.5, que no sirve — este número
   * se IMPRIME en la ayuda ("se cierra sola en N s") y "4.5 s" se lee como un error. Va 5,
   * el entero más cercano a la mitad.
   *
   * Acortar no deja a nadie sin leer: la ventana se PAUSA al pasar el mouse por encima o al
   * entrar con el teclado (mouseenter/focusin más arriba), así que quien necesite más tiempo
   * lo retiene sin tocar nada. Si no fuera por esa pausa, bajar de 9 a 5 sí habría que medirlo.
   */
  readonly segundosVentana = 5;
  private get totalMs(): number { return this.segundosVentana * 1000; }

  readonly termino = signal('');
  readonly resultados = signal<HalladoCatalogo[]>([]);
  readonly resaltado = signal(0);
  readonly buscando = signal(false);
  readonly aviso = signal<Aviso>(null);
  /**
   * `[MOS.1]` La persona eligió con las flechas. Sólo entonces Enter toma el renglón resaltado
   * cuando lo tecleado son números: la pistola también manda dígitos y Enter, y ahí lo que manda
   * es el código exacto contra Kepler, no el primer parecido de la lista.
   */
  private navego = false;

  /** `[MOS.2]` El código escaneado que Kepler no tiene, y lo que se hizo con él. */
  readonly noReg = signal<NoRegistradoAviso | null>(null);
  readonly descripcion = signal('');
  readonly describiendo = signal(false);

  readonly elegido = signal<Hallado | null>(null);
  /** `[MOS.1]` De dónde salieron las presentaciones que se ven: del ODS o del respaldo local. */
  readonly origenPres = signal<'vivo' | 'respaldo'>('respaldo');
  readonly consulta = signal<ConsultaFaltante | null>(null);
  readonly anotado = signal<ReportarResultado | null>(null);
  readonly deshecho = signal(false);
  readonly enviando = signal(false);
  readonly deshaciendo = signal(false);

  readonly ventana = signal(false);
  readonly restante = signal(0);
  readonly pausado = signal(false);

  private debounce?: ReturnType<typeof setTimeout>;
  private reloj?: ReturnType<typeof setInterval>;

  constructor() {
    // El intervalo sobrevive al componente si nadie lo apaga, y entonces sigue llamando a
    // setState sobre algo que ya no está en el árbol.
    this.destroyRef.onDestroy(() => {
      if (this.debounce) clearTimeout(this.debounce);
      this.pararReloj();
    });

    // El código del verificador llega DESPUÉS que la sucursal (la resuelve una suscripción al
    // alcance), así que no sirve hacerlo en ngOnInit: hay que esperar a que estén los dos.
    effect(() => {
      const code = this.codigoInicial();
      const suc = this.sucursal();
      if (!code || !suc || this.entradaResuelta) return;
      this.entradaResuelta = true;
      this.porCodigo(code);
    });
  }

  readonly listaAbierta = computed(() => !this.ventana() && this.resultados().length > 0);
  readonly veredicto = computed<VeredictoExistencia>(() => this.consulta()?.veredicto);
  readonly porcentaje = computed(() => porcentajeReloj(this.restante(), this.totalMs));
  readonly segundos = computed(() => Math.ceil(this.restante() / 1000));

  /**
   * `[MOS.1]` Los renglones del desplegable, ya con sus presentaciones y su mayoreo calculados:
   * se calculan una vez por búsqueda, no en cada pintada.
   */
  readonly filas = computed(() => this.resultados().map((r) => ({
    ...r,
    porEtiqueta: ETIQUETA_CAMPO[r.por],
    pres: presentacionesDe(r.unidades),
    esc: escalonesDe(r.unidades, r.mayoreo),
  })));

  /** `[MOS.1]` Las presentaciones del producto elegido, con lo que trae cada una. */
  readonly presentaciones = computed(() => presentacionesDe(this.elegido()?.unidades ?? []));
  /** `[MOS.1]` Su mayoreo, en la presentación en que Kepler lo captura, con el tramo normal. */
  readonly escalones = computed(() => {
    const h = this.elegido();
    return escalonesDe(h?.unidades ?? [], h?.mayoreo ?? []).map((e) => ({ ...e, tramo: tramoNormal(e) }));
  });

  /**
   * La procedencia de los precios. El del ODS manda; el local es respaldo y se DECLARA como tal,
   * porque puede estar viejo. Sin precio no se dibuja un cero.
   */
  readonly origenPrecio = computed<OrigenPrecio>(() => {
    if (!this.presentaciones().length) return 'sin_dato';
    return this.origenPres();
  });

  /**
   * El botón de «Anotar igual» sale SÓLO cuando la existencia no se pudo leer. Es el único caso
   * de los tres que no se resuelve solo, y por eso es el único que tiene botón.
   */
  readonly ofreceAnotarIgual = computed(
    () => !!this.consulta() && this.veredicto() === 'no_medido' && !this.anotado(),
  );

  // ── Búsqueda ────────────────────────────────────────────────────────────────────────────────

  /**
   * `[MOS.1]` Busca desde 3 caracteres, letras o números: el nombre, el proveedor, el SKU o un
   * pedazo del código de barras. La pistola dispara dígitos y Enter casi al mismo tiempo; ese
   * camino lo resuelve `alTeclear` contra Kepler, no esta lista.
   */
  alEscribir(v: string): void {
    this.termino.set(v ?? '');
    this.aviso.set(null);
    this.navego = false;
    if (this.debounce) clearTimeout(this.debounce);
    const q = (v ?? '').trim();
    if (q.length < 3) { this.resultados.set([]); return; }
    this.debounce = setTimeout(() => { void this.porTexto(q); }, 250);
  }

  alTeclear(ev: KeyboardEvent): void {
    const n = this.resultados().length;
    if (ev.key === 'ArrowDown' && n) {
      ev.preventDefault(); this.navego = true; this.resaltado.set((this.resaltado() + 1) % n);
    } else if (ev.key === 'ArrowUp' && n) {
      ev.preventDefault(); this.navego = true; this.resaltado.set((this.resaltado() - 1 + n) % n);
    } else if (ev.key === 'Escape') {
      this.resultados.set([]);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const q = this.termino().trim();
      // Con letras, o si la persona eligió con las flechas, Enter toma el renglón resaltado. Con
      // sólo números y sin flechas es un código (la pistola, o alguien tecleándolo completo): va
      // contra Kepler, que es quien sabe si existe.
      const r = this.resultados()[this.resaltado()];
      if (r && (this.navego || /[^0-9]/.test(q))) { this.elegir(r, 'respaldo'); return; }
      if (this.debounce) clearTimeout(this.debounce);
      this.resultados.set([]);
      this.porCodigo(q);
    }
  }

  private async porTexto(q: string): Promise<void> {
    const suc = this.sucursal();
    if (!suc) return;
    this.buscando.set(true);
    try {
      let r = await this.verificador.buscarEnCatalogo(suc, q);
      if (r === null) {
        // `null` = no hay catálogo bajado, que NO es lo mismo que «no hay resultados». Se baja
        // una vez y se reintenta; si tampoco, se dice.
        await new Promise<void>((ok, fail) =>
          this.verificador.descargarSnapshot(suc).subscribe({ next: () => ok(), error: fail }));
        r = await this.verificador.buscarEnCatalogo(suc, q);
      }
      // La persona siguió escribiendo mientras se buscaba: esta respuesta ya no es de lo que hay
      // en la caja.
      if (this.termino().trim() !== q) return;
      this.resultados.set(r ?? []);
      this.resaltado.set(0);
      if (r !== null && r.length === 0) {
        this.aviso.set({
          tono: 'warn',
          texto: /^[0-9]+$/.test(q)
            ? 'Nada coincide en esta sucursal. Si es un código, presiona Enter para buscarlo en Kepler.'
            : 'Nada coincide en el catálogo de esta sucursal.',
        });
      }
    } catch {
      this.resultados.set([]);
      this.aviso.set({ tono: 'bad', texto: 'No se pudo buscar en el catálogo. Revisa la conexión.' });
    } finally {
      this.buscando.set(false);
    }
  }

  private porCodigo(code: string): void {
    const suc = this.sucursal();
    if (!code || !suc) return;
    this.buscando.set(true);
    this.noReg.set(null);
    this.verificador.buscar(code, suc).subscribe({
      next: (r) => {
        this.buscando.set(false);
        if (r.estado === 'encontrado') {
          if (r.plazaSinDato) {
            // `[MOS.2]` Existe en Kepler, pero NO en esta sucursal. Antes la ventana mostraba el
            // precio de la otra plaza como si fuera de aquí; ahora se dice y se anota para Compras.
            this.anotarNoRegistrado({
              kind: 'no_en_sucursal', codigo: code, sku: r.producto.codigo, nombre: r.producto.nombre,
            });
            return;
          }
          this.elegir(this.desdeProducto(r.producto), r.origen === 'live' ? 'vivo' : 'respaldo', true);
        } else if (r.estado === 'no_encontrado') {
          if (r.origen === 'live') {
            // `[MOS.2]` Kepler contestó que no existe: es autoritativo, y se anota SOLO en la
            // lista de No registrados. Sale de ahí en cuanto lo den de alta en Kepler.
            this.anotarNoRegistrado({ kind: 'no_en_catalogo', codigo: code, sku: null, nombre: null });
          } else {
            // Sin red, el «no está» sale del respaldo, que puede ser viejo: no se anota nada.
            this.aviso.set({
              tono: 'warn',
              texto: 'Ese código no está en el respaldo de esta sucursal, y sin conexión no se pudo confirmar con Kepler.',
            });
          }
        } else {
          this.aviso.set({ tono: 'bad', texto: 'No se pudo consultar el catálogo. Revisa la conexión.' });
        }
      },
      error: () => {
        this.buscando.set(false);
        this.aviso.set({ tono: 'bad', texto: 'No se pudo consultar. Revisa la conexión.' });
      },
    });
  }

  private desdeProducto(p: { codigo: string; nombre: string; proveedor?: string | null; unidades: UnidadPrecio[]; mayoreo: MayoreoTier[] }): Hallado {
    return {
      codigo: p.codigo,
      nombre: p.nombre,
      proveedor: p.proveedor ?? null,
      unidades: p.unidades ?? [],
      mayoreo: p.mayoreo ?? [],
    };
  }

  // ── No registrados ──────────────────────────────────────────────────────────────────────────

  private anotarNoRegistrado(o: Pick<NoRegistradoAviso, 'kind' | 'codigo' | 'sku' | 'nombre'>): void {
    const suc = this.sucursal();
    if (!suc) return;
    this.cerrar(false);
    this.termino.set('');
    this.descripcion.set('');
    this.noReg.set({ ...o, enviando: true, anotado: null, descrito: null });
    this.api.reportar({
      warehouse_code: suc,
      kind: o.kind,
      scanned_code: o.codigo,
      ...(o.sku ? { sku: o.sku } : {}),
      source: 'verificador',
    }).subscribe({
      next: (r) => {
        this.noReg.update((n) => (n ? { ...n, enviando: false, anotado: r } : n));
        this.cambio.emit();
      },
      error: () => {
        this.noReg.update((n) => (n ? { ...n, enviando: false } : n));
        // Un no registrado que se creyó anotado y no lo está es peor que uno que nunca se intentó.
        this.aviso.set({ tono: 'bad', texto: 'No se pudo anotar el código para Compras. Revisa la conexión y vuelve a escanear.' });
      },
    });
  }

  guardarDescripcion(): void {
    const n = this.noReg();
    const texto = this.descripcion().trim();
    if (!n?.anotado || !texto || this.describiendo()) return;
    this.describiendo.set(true);
    this.api.describir(n.anotado.id, texto).subscribe({
      next: (r) => {
        this.describiendo.set(false);
        this.noReg.update((x) => (x ? { ...x, descrito: r.product_name } : x));
        this.cambio.emit();
      },
      error: () => {
        this.describiendo.set(false);
        this.aviso.set({ tono: 'bad', texto: 'No se pudo guardar la descripción. El código sí quedó anotado.' });
      },
    });
  }

  quitarNoRegistrado(): void {
    const n = this.noReg();
    if (!n?.anotado || this.deshaciendo()) return;
    this.deshaciendo.set(true);
    this.api.deshacer(n.anotado.id).subscribe({
      next: () => {
        this.deshaciendo.set(false);
        this.noReg.set(null);
        this.aviso.set({ tono: 'warn', texto: 'Quitado. No quedó nada anotado.' });
        this.cambio.emit();
        this.caja()?.nativeElement.focus();
      },
      error: () => {
        this.deshaciendo.set(false);
        this.aviso.set({ tono: 'bad', texto: 'No se pudo quitar. Pídele a Compras que lo marque como "no era faltante".' });
      },
    });
  }

  cerrarNoRegistrado(): void {
    this.noReg.set(null);
    this.caja()?.nativeElement.focus();
  }

  // ── La ventana ──────────────────────────────────────────────────────────────────────────────

  /**
   * Abre la ventana del producto. `origen` dice de dónde vienen sus precios; si vienen del
   * respaldo y hay red, se piden en vivo y la ventana se actualiza sola (`[MOS.1]`).
   */
  elegir(h: Hallado, origen: 'vivo' | 'respaldo' = 'respaldo', yaEnVivo = false): void {
    const suc = this.sucursal();
    if (!suc) return;

    this.noReg.set(null);
    this.origenPres.set(origen);
    this.elegido.set(h);
    if (!yaEnVivo && origen === 'respaldo') this.refrescarEnVivo(h.codigo, suc);
    this.resultados.set([]);
    this.termino.set('');
    this.aviso.set(null);
    this.consulta.set(null);
    this.anotado.set(null);
    this.deshecho.set(false);
    this.ventana.set(true);
    // El reloj NO arranca todavía: mientras la existencia viaja, la ventana no puede cerrarse o
    // se cerraría antes de contestar la única pregunta que la justifica.
    this.pararReloj();
    this.restante.set(this.totalMs);
    this.pausado.set(false);

    this.api.consultar(suc, h.codigo).subscribe({
      next: (c) => { this.consulta.set(c); this.trasConsultar(c); },
      error: () => {
        const c: ConsultaFaltante = {
          encontrado: true, termino: h.codigo, warehouse_code: suc, warehouse_name: null,
          existencia: null, veredicto: 'no_medido',
        };
        this.consulta.set(c);
        this.trasConsultar(c);
      },
    });
  }

  /**
   * `[MOS.1]` Lo elegido de la lista sale del respaldo local, que puede tener horas. Se pide en
   * vivo y, si contesta el ODS, se reemplazan los precios y la procedencia pasa a «en vivo». Si
   * para entonces la persona ya eligió otro producto, la respuesta se descarta.
   */
  private refrescarEnVivo(codigo: string, suc: string): void {
    this.verificador.buscar(codigo, suc).subscribe({
      next: (r) => {
        if (r.estado !== 'encontrado' || r.origen !== 'live' || r.plazaSinDato) return;
        if (this.elegido()?.codigo !== codigo) return;
        this.elegido.set(this.desdeProducto(r.producto));
        this.origenPres.set('vivo');
      },
      // Sin red se queda lo del respaldo, que ya está rotulado como tal.
      error: () => undefined,
    });
  }

  /** Llegó la respuesta: se decide si se anota solo, y recién ahí empieza a correr el reloj. */
  private trasConsultar(c: ConsultaFaltante): void {
    if (anotaSolo(c.veredicto)) this.anotar();
    this.arrancarReloj();
  }

  private anotar(): void {
    const suc = this.sucursal();
    const h = this.elegido();
    if (!suc || !h || this.enviando()) return;
    this.enviando.set(true);
    this.api.reportar({
      warehouse_code: suc,
      kind: MOTIVO_AUTOMATICO,
      sku: h.codigo,
      source: 'verificador',
    }).subscribe({
      next: (r) => {
        this.enviando.set(false);
        this.anotado.set(r);
        this.cambio.emit();
      },
      error: () => {
        this.enviando.set(false);
        // Falló la escritura: se DICE. Un faltante que se creyó anotado y no lo está es peor que
        // uno que nunca se intentó, porque nadie lo vuelve a reportar.
        this.aviso.set({ tono: 'bad', texto: 'No se pudo anotar el faltante. Revisa la conexión y vuelve a escanear.' });
      },
    });
  }

  /** El único botón del caso `no_medido`: lo anota una persona, no la pantalla. */
  anotarIgual(): void {
    this.anotar();
    this.restante.set(this.totalMs);   // le devuelve tiempo para ver qué quedó
  }

  deshacer(): void {
    const a = this.anotado();
    if (!a || this.deshaciendo()) return;
    this.deshaciendo.set(true);
    this.api.deshacer(a.id).subscribe({
      next: () => {
        this.deshaciendo.set(false);
        this.deshecho.set(true);
        this.restante.set(this.totalMs);
        this.cambio.emit();
      },
      error: () => {
        this.deshaciendo.set(false);
        this.aviso.set({ tono: 'bad', texto: 'No se pudo quitar. Pedile a Compras que lo marque como "no era faltante".' });
      },
    });
  }

  pausar(v: boolean): void { this.pausado.set(v); }

  cerrar(enfocar = true): void {
    this.pararReloj();
    this.ventana.set(false);
    this.elegido.set(null);
    this.consulta.set(null);
    this.anotado.set(null);
    this.deshecho.set(false);
    // De vuelta a la caja: en un mostrador lo que sigue es el próximo escaneo.
    if (enfocar) this.caja()?.nativeElement.focus();
  }

  private arrancarReloj(): void {
    this.pararReloj();
    this.reloj = setInterval(() => {
      const r = pasoDeReloj(this.restante(), this.pausado(), PASO_MS);
      this.restante.set(r);
      if (r <= 0) this.cerrar();
    }, PASO_MS);
  }

  private pararReloj(): void {
    if (this.reloj) { clearInterval(this.reloj); this.reloj = undefined; }
  }
}
