import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, HostListener, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { AuthService } from '../../../core/services/auth.service';
import { branchName } from '../../../core/constants/store-branches';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { CountUpDirective } from '../../../shared/directives/count-up.directive';
import { StoreSocketService, type LabelPricesChanged } from '../store-socket.service';
import { EstadoSnapshot, OrigenPrecio, ProductoPrecio, ResultadoBusqueda, SucursalVerificador, VerificadorService } from '../verificador.service';

/** Un renglón del feed de consultas (lo último arriba, patrón POS). */
interface Consulta {
  codigo: string;
  nombre: string;
  precio: number | null;
  unidad: string;
  origen: OrigenPrecio | 'ninguno';
  hora: Date;
}

type Banner = { texto: string; detalle?: string; tono: 'info' | 'ok' | 'warn' | 'bad' } | null;

/**
 * Verificador de precios de mostrador (`/tienda/verificador`).
 *
 * Es el kiosco que la clienta usa apuntando el producto al lector: la pistola teclea el
 * código y manda Enter, y la pantalla contesta con el precio en cifra grande. No hay nada
 * que hacer con el mouse.
 *
 * ── Por qué esta pantalla existe acá y no como archivo suelto ────────────────────────────
 * La versión anterior era un HTML autocontenido que una tarea programada regeneraba a
 * diario con un `.ps1`. Eso queda retirado: el verificador es una PANTALLA del proyecto
 * Tienda, con su ruta, su permiso, su diseño y su respaldo offline armado con la infra que
 * la app ya tiene (service worker + IndexedDB). Cero artefactos fuera del monorepo.
 *
 * ── Híbrido: en vivo primero, respaldo después, y se DICE cuál se usó ───────────────────
 * Cada consulta va al ODS (`/api/kp/precio`); si la red falla o tarda más de 2.5s, el
 * precio sale del snapshot local y la pantalla lo declara ("precio de respaldo"). Nunca se
 * muestra una cifra sin decir de dónde salió — es la regla de VP/ADR-056 aplicada al
 * mostrador, donde el costo de un precio viejo lo paga la caja.
 *
 * ── Superficie ──────────────────────────────────────────────────────────────────────────
 * DESIGN Operations §O.3 (Mostrador/POS): foco permanente en la captura, el precio domina
 * la jerarquía, feed al tope sin paginación. Tokens y PrimeIcons, dark de primera clase.
 */
@Component({
  selector: 'app-tienda-verificador',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, SelectModule, TagModule, ContextHelpComponent, FreshnessPillComponent, CountUpDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="vp-page" [class.is-kiosco]="kiosco()">
      <header class="vp-head">
        <div class="vp-head-txt">
          <h1>Verificador de precios</h1>
          <p class="vp-sub">
            Apunta el producto al lector o teclea la clave y presiona Enter.
            <strong>{{ sucursalNombre() }}</strong>
          </p>
        </div>
        <div class="vp-head-right">
          <!-- measures="data": datos_al lo calcula el backend (latido del CDC de esa
               sucursal), no el reloj del navegador.
               Y cuando el backend NO lo trae, se DECLARA en vez de callarse: la píldora se
               oculta sola con un since en null, y una píldora ausente se lee igual que "todo
               bien" (ADR-056). Medido el 2026-09-08 en el cluster local: analytics.cron_runs
               no tiene ninguna fila cdc_wal_NN, así que hoy datos_al llega null para las
               7 sucursales.
               (Sin acentos graves acá a propósito: rompen el template literal — GOTCHAS.) -->
          @if (datosAl()) {
            <app-freshness-pill measures="data" [since]="datosAl()" [staleAfterSec]="3600" />
          } @else {
            <span class="vp-fresh-nd" title="El backend no reporta el latido del ERP para esta sucursal (analytics.cron_runs, cdc_wal_NN). No se sabe de cuándo es el precio.">
              <i class="pi pi-question-circle" aria-hidden="true"></i> Frescura del ERP sin medir
            </span>
          }
          @if (!sucursalFija()) {
            <p-select [options]="opcionesSucursal()" optionLabel="label" optionValue="value"
                      [ngModel]="sucursal()" (ngModelChange)="cambiarSucursal($event)"
                      placeholder="Sucursal" styleClass="vp-sel" appendTo="body"
                      aria-label="Sucursal del verificador"></p-select>
          }
          <p-button type="button" [icon]="kiosco() ? 'pi pi-window-minimize' : 'pi pi-window-maximize'"
                    [label]="kiosco() ? 'Salir de kiosco' : 'Modo kiosco'"
                    styleClass="p-button-sm p-button-text" (click)="toggleKiosco()"></p-button>
          <app-context-help topic="verificador" />
        </div>
      </header>

      @if (banner(); as b) {
        <div class="vp-banner" [class]="'is-' + b.tono" role="status">
          <i class="pi" [class.pi-info-circle]="b.tono === 'info'" [class.pi-check-circle]="b.tono === 'ok'"
             [class.pi-exclamation-triangle]="b.tono === 'warn'" [class.pi-times-circle]="b.tono === 'bad'"></i>
          <div>
            <strong>{{ b.texto }}</strong>
            @if (b.detalle) { <span>{{ b.detalle }}</span> }
          </div>
        </div>
      }

      <!-- Captura: lo único con foco. El borde/anillo lo lleva la barra por :focus-within,
           así que el input va sin caja propia (input nativo a propósito: p-inputText mete su
           propio borde y rompe el look de la barra). -->
      <div class="vp-scanbar" (click)="enfocar()">
        <i class="pi pi-barcode" aria-hidden="true"></i>
        <input #scan type="text" inputmode="numeric" autocomplete="off" enterkeyhint="search"
               class="vp-scan-input" aria-label="Escanear o teclear la clave o el código de barras"
               placeholder="Escanea el producto o teclea la clave y Enter…"
               [disabled]="!sucursal()"
               (keyup.enter)="consultar(scan.value); scan.value = ''"
               (blur)="reenfocar()" />
        @if (buscando()) { <i class="pi pi-spin pi-spinner vp-scan-busy" aria-label="Consultando"></i> }
        <span class="vp-scan-hint">Clave de 5 dígitos o código de barras</span>
      </div>

      <!-- Resultado: es el "total" de esta superficie, domina todo lo demás (§O.3). -->
      <section class="vp-result" aria-live="polite">
        @switch (estado()) {
          @case ('encontrado') {
            @if (producto(); as p) {
              <!--
                [TDA.6] is-pase-b alterna en cada consulta. NO es decoracion: la tarjeta es el
                MISMO nodo del DOM entre escaneo y escaneo (el @if no la recrea si el estado
                sigue en "encontrado"), asi que una animacion de entrada corria UNA sola vez en
                todo el turno -- justo lo contrario de lo que se pidio. Alternar la clase cambia
                el animation-name y el navegador reinicia la animacion. Un contador y una clase,
                sin recrear el nodo ni tocar la estructura.
              -->
              <div class="vp-card" [class.is-respaldo]="origen() === 'respaldo'"
                   [class.is-pase-b]="pase() % 2 === 1">
                <div class="vp-card-top">
                  <span class="vp-cod">{{ p.codigo }}</span>
                  @if (origen() === 'respaldo') {
                    <p-tag severity="warn" icon="pi pi-exclamation-triangle" value="Precio de respaldo"></p-tag>
                  } @else {
                    <p-tag severity="success" icon="pi pi-bolt" value="Precio en línea"></p-tag>
                  }
                </div>
                <h2 class="vp-nombre">
                  {{ p.nombre || 'Sin nombre en el catálogo' }}
                  <!-- [TDA.4] El gramaje califica al nombre, no es un dato aparte. -->
                  @if (p.contenido) { <span class="vp-gramaje">{{ p.contenido }}</span> }
                </h2>

                <!--
                  [TDA.8] El precio cambio en el ERP mientras estaba en pantalla. Va ARRIBA de la
                  cifra y no abajo: es una advertencia sobre el numero, y una advertencia que se
                  lee despues del numero llega tarde. role=status para que el lector de pantalla
                  lo anuncie sin robar el foco de la captura (O.3: el foco no se mueve nunca).
                -->
                @if (precioCambio()) {
                  <p class="vp-cambio" role="status">
                    <i class="pi pi-refresh" aria-hidden="true"></i>
                    <span>
                      Este precio <strong>acaba de cambiar</strong> en el ERP.
                      @if (precioAnterior() != null) {
                        Antes decía <span class="vp-mono">{{ money(precioAnterior()) }}</span>.
                      }
                      Confirma en caja antes de cobrar.
                    </span>
                  </p>
                }

                <div class="vp-precio-principal">
                  <span class="vp-precio">{{ money(precioPrincipal()) }}</span>
                  <span class="vp-precio-u">por {{ unidadPrincipal() }}</span>
                </div>
                <!--
                  [TDA.3] Solo cuando el producto tiene MAS de una unidad con precio. Medido: el
                  93.6% de los SKUs tiene una sola unidad registrada, asi que un aviso
                  incondicional saldria en 9 de cada 10 escaneos y se aprenderia a ignorar.
                -->
                @if (vaAclararUnidad()) {
                  <p class="vp-u-aclara">
                    <i class="pi pi-barcode" aria-hidden="true"></i>
                    El codigo que escaneaste es de <strong>{{ unidadEscaneada() }}</strong>: este es su precio.
                  </p>
                }
                <!--
                  [TDA.4] EL MAYOREO. Medido en prod: el 94% de los productos lo tiene, asi que
                  no es un extra para un rincon -- es el caso normal, y esta es la pantalla donde
                  se cierra la venta. Va PEGADO al precio grande porque es la continuacion de la
                  misma pregunta ("cuanto cuesta" -> "y si llevo mas?"), antes que cualquier
                  nota secundaria.

                  Lo que NO se hace: mostrar un mayoreo sin saber desde cuantas unidades. El
                  backend ya descarto esos (17 productos en prod) porque un mayoreo cuya
                  condicion no se conoce fabrica una discusion en el mostrador.
                -->
                @if (mayoreo().length) {
                  <div class="vp-mayoreo">
                    @for (x of mayoreoConFoco(); track x.t.etiqueta) {
                      @let t = x.t;
                      <!--
                        [TDA.7] is-foco = el escalon de la unidad que se ESCANEO. Es el que va
                        grande; el otro se atenua. Sin esto los dos salian del mismo tamano y uno
                        podia estar en pesos por paquete y el otro en pesos por pieza.
                      -->
                      <div class="vp-may-row" [class.is-realza]="t.realza"
                           [class.is-foco]="x.destacado">
                        <!--
                          La CONDICION va arriba y grande, no de subtitulo. Es el punto critico
                          de esta pantalla: si el monto de mayoreo crece y la condicion se
                          susurra, alguien que lleva UNA pieza lee el precio de 3 y se cobra mal.
                          El enfasis se gana con tamano y superficie, y la condicion tiene que
                          crecer con el monto.
                        -->
                        <div class="vp-may-cond">
                          <i class="pi pi-tags" aria-hidden="true"></i>
                          Llevando <strong class="vp-may-n">{{ t.desde }}</strong>
                          o más {{ t.palabra }}
                        </div>
                        <div class="vp-may-precio">
                          <span class="vp-may-monto">{{ money(t.precio_con_iva) }}</span>
                          <!--
                            [TDA.7] La unidad del monto VIENE con el escalon; estaba cableada a
                            "c/u" y eso erraba la cifra por 7x. Medido en prod: en 380 productos
                            de base pieza con paquete registrado, wholesale_pack_price es el
                            precio de un PAQUETE (mediana 0.93 contra pack_price). Decirle "c/u"
                            a $65.11 cuando la pieza cuesta $9.37 es otro numero, no otro estilo.
                          -->
                          <span class="vp-may-cu">{{ t.unidad_monto }}</span>
                        </div>
                      </div>
                      <!--
                        El ahorro es lo que cierra la venta: no es lo mismo "$41.10 c/u" que
                        "te ahorras $34.70". Solo se pinta como GANANCIA cuando el descuento es
                        perceptible (>=1%): abajo de eso el numero es cierto pero pintarlo de
                        verde seria mentir con el color. Medido: 366 tiers caen ahi.
                      -->
                      <!--
                        [TDA.7] La pastilla del ahorro va SOLO en el escalon de la unidad leida.
                        Dos ahorros grandes, uno por pieza y otro por paquete, compiten entre si
                        y ninguno queda claro; y el del escalon que no aplica invita a una compra
                        que no es la que se esta cotizando.
                      -->
                      @if (t.realza && x.destacado) {
                        <p class="vp-may-ahorro">
                          <i class="pi pi-arrow-down" aria-hidden="true"></i>
                          Te ahorras
                          <!--
                            [TDA.6] El count-up va SOLO acá, y la excepción es deliberada.
                            El precio unitario y el de mayoreo se leen en voz alta a una
                            clienta: tienen que ser legibles en el primer fotograma, no al
                            final de una transición. El AHORRO es lo contrario -- es la
                            invitación, y contar hasta la cifra es lo que hace que el ojo
                            aterrice ahí. Es el idioma de la casa (DESIGN.md 7b + §Motion KPI
                            3, count-up ~900ms), no un invento de esta pantalla, y usa la
                            directiva compartida en vez de una copia.
                            appCountUpLive: sin esto la directiva anima UNA vez en la vida del
                            nodo y el segundo escaneo del turno no contaría. Su tween cancela
                            el rAF anterior, así que un escaneo a los 2s no deja dos cifras
                            peleando -- rueda del valor anterior al nuevo.
                            El texto final queda en el DOM (la directiva escribe textContent),
                            así que el lector de pantalla lee el importe, no un hueco.
                          -->
                          <strong [appCountUp]="t.ahorro_en_el_minimo" [appCountUpLive]="true"
                                  countUpFormat="money2"></strong>
                          <span class="vp-may-pct">{{ t.descuento_pct }}% menos c/u</span>
                        </p>
                      }
                    }
                  </div>
                }

                <p class="vp-precio-nota">
                  Precio al público, IVA incluido.
                  @if (p.iva_pct != null) { IVA {{ p.iva_pct }}%. }
                  @if (p.ieps_pct) { IEPS {{ p.ieps_pct }}%. }
                  @if (origen() === 'respaldo') { Tomado del respaldo del {{ snapshotAl() | date:'dd/MM/yy HH:mm' }}. }
                  <!--
                    [TDA.2] Procedencia. Se DECLARA en vez de esconderse: hasta este cambio esta
                    pantalla publicaba un numero sin decir de que plaza salia, y sin sucursal el ERP
                    devolvia una fila arbitraria (podia ser la de CEDIS, la que la etiquetera
                    excluye a proposito).
                  -->
                  @if (origenPrecio() === 'override_manual') { Precio corregido a mano: es el mismo que sale en la etiqueta del anaquel. }
                  @if (precioAmbiguo()) { Este producto tiene {{ plazasDistintas() }} precios distintos entre plazas y no se pudo acotar a la tuya: confirmalo en caja. }
                  @if (plazaSinDato()) { Tu sucursal no tiene este producto cargado; el precio es de otra plaza. }
                </p>

                <!--
                  [TDA.3] Las OTRAS unidades: todas menos la que va en grande. Antes era
                  slice(1) --siempre "todas menos la base"--, lo que ahora repetiria el precio
                  grande abajo y esconderia el de la base.
                  El factor se refiere a la unidad BASE, no a la que se muestra en grande: decir
                  "12 CJA" cuando el hero es la caja seria falso.
                -->
                @if (otrasUnidades().length) {
                  <ul class="vp-unidades">
                    @for (u of otrasUnidades(); track u.u) {
                      <li>
                        <span class="vp-u-nom">{{ u.u }}</span>
                        <span class="vp-u-p">{{ money(u.precio_con_iva) }}</span>
                        @if (u.factor > 1 && unidadBase()) { <span class="vp-u-f">{{ u.factor }} {{ unidadBase() }}</span> }
                      </li>
                    }
                  </ul>
                }
              </div>
            }
          }
          @case ('no_encontrado') {
            <!-- Vacío real: el catálogo contestó y no lo tiene. Distinto de un fallo de red. -->
            <div class="vp-vacio">
              <i class="pi pi-search-minus" aria-hidden="true"></i>
              <div>
                <strong>No encontramos <span class="vp-mono">{{ ultimoCodigo() }}</span> en el catálogo.</strong>
                <p>Revisa que el código esté completo, o pregunta en caja: puede ser un producto nuevo sin precio cargado.</p>
              </div>
            </div>
          }
          @case ('sin_datos') {
            <!-- Fallo de red SIN respaldo con qué contestar. No se disfraza de "no existe". -->
            <div class="vp-vacio is-bad">
              <i class="pi pi-wifi" aria-hidden="true"></i>
              <div>
                <strong>Sin conexión y sin respaldo descargado.</strong>
                <p>No se puede consultar el precio de <span class="vp-mono">{{ ultimoCodigo() }}</span> ahora mismo. Cuando vuelva la red, descarga el respaldo para que el mostrador siga funcionando sin señal.</p>
                <p-button type="button" label="Descargar respaldo" icon="pi pi-download"
                          styleClass="p-button-sm" [disabled]="descargando() || !sucursal()"
                          (click)="descargarRespaldo()"></p-button>
              </div>
            </div>
          }
          @default {
            <div class="vp-vacio is-idle">
              <i class="pi pi-barcode" aria-hidden="true"></i>
              <div>
                <strong>Listo para consultar.</strong>
                <p>Pasa el producto por el lector. El precio aparece aquí en grande.</p>
              </div>
            </div>
          }
        }
      </section>

      <footer class="vp-foot">
        <div class="vp-feed">
          <span class="vp-feed-lbl">Últimas consultas</span>
          @if (!feed().length) { <span class="vp-feed-vacio">Todavía ninguna.</span> }
          <ul>
            @for (c of feed(); track c.hora.getTime() + c.codigo) {
              <li>
                <span class="vp-mono">{{ c.codigo }}</span>
                <span class="vp-feed-n">{{ c.nombre || 'no encontrado' }}</span>
                <span class="vp-feed-p">{{ c.precio != null ? money(c.precio) : '—' }}</span>
                @if (c.origen === 'respaldo') { <i class="pi pi-exclamation-triangle" title="Precio de respaldo"></i> }
                <span class="vp-feed-h">{{ c.hora | date:'HH:mm:ss' }}</span>
              </li>
            }
          </ul>
        </div>

        <div class="vp-respaldo">
          @if (snapshot(); as s) {
            <span class="vp-respaldo-ok">
              <i class="pi pi-database" aria-hidden="true"></i>
              Respaldo local: {{ s.total }} productos · {{ s.descargadoAl | date:'dd/MM HH:mm' }}
            </span>
          } @else {
            <span class="vp-respaldo-no">
              <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
              Sin respaldo local: si se cae la red, la pantalla no puede contestar.
            </span>
          }
          <p-button type="button" label="Actualizar respaldo" icon="pi pi-download"
                    styleClass="p-button-sm p-button-text" [disabled]="descargando() || !sucursal()"
                    (click)="descargarRespaldo()"></p-button>
        </div>
      </footer>
    </div>
  `,
  styles: [`
    :host { display: block; }

    /* [TDA.5] La pagina se ACOTA. No lo hacia, y en el monitor ancho del mostrador
       (medido: 5023 px) el resultado no era "amplio", era roto: la cifra quedaba pegada
       al borde izquierdo con ~4,000 px de vacio al lado, y los pares se partian a los
       extremos opuestos de la pantalla -- "CJA / $1,586.23" y, en el pie, el nombre del
       producto contra su propio precio.
       Ninguno de esos tres es un bug aparte: los tres son flex: 1 y 1fr haciendo
       exactamente lo suyo sobre un ancho que nadie limito. Por eso sobrevivio a la
       revision -- en un monitor normal se ve bien, y nunca lo abri en uno que no lo fuera.

       Se acota con el PADDING y no con max-width, a proposito: el modo kiosco de abajo es
       position: fixed; inset: 0 con fondo propio, y un max-width ahi le recortaria el
       fondo y dejaria ver la app por los costados. Asi el sangrado sigue completo y lo que
       se acota es el CONTENIDO -- una sola regla que sirve a los dos modos. */
    .vp-page { display: flex; flex-direction: column; gap: var(--sp-4);
      padding: var(--sp-5) max(var(--sp-6), calc((100% - 78rem) / 2));
      color: var(--text-main); }
    /* Modo kiosco: la pantalla se come el chrome de la app (sidebar incluido) para que
       la clienta vea el precio y nada más. Es un overlay, no un layout aparte.
       Repite el acotado lateral: si sólo cambiara el padding vertical, el max() de arriba
       se perdería y el kiosco —que es JUSTO el que corre en el monitor ancho de la tienda—
       volvería a estirarse de borde a borde. */
    .vp-page.is-kiosco { position: fixed; inset: 0; z-index: 60; overflow: auto;
      background: var(--layout-bg);
      padding: var(--sp-4) max(var(--sp-5), calc((100% - 78rem) / 2)); }

    .vp-head { display: flex; align-items: flex-start; gap: var(--sp-4); flex-wrap: wrap; }
    .vp-head-txt { margin-right: auto; }
    .vp-head-txt h1 { margin: 0; font-size: var(--fs-h2, 1.25rem); font-weight: 700;
      letter-spacing: -0.01em; line-height: 1.2; }
    .vp-sub { margin: .15rem 0 0; font-size: var(--fs-xs, .75rem); color: var(--text-faint); }
    .vp-sub strong { color: var(--text-muted); font-weight: 600; }
    .vp-head-right { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
    /* Sin punto de color: el verde afirmaría salud del dato, y justamente no se midió. */
    .vp-fresh-nd { display: inline-flex; align-items: center; gap: .3rem; font-size: var(--fs-xs, .75rem);
      color: var(--text-faint); white-space: nowrap; cursor: help; }

    .vp-banner { display: flex; align-items: flex-start; gap: .6rem; padding: .6rem .75rem;
      border-radius: var(--r-sm); font-size: var(--fs-sm, .8125rem);
      border: 1px solid var(--info-soft-bg); background: var(--info-soft-bg); color: var(--info-soft-fg); }
    .vp-banner.is-ok { border-color: var(--ok-soft-bg); background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .vp-banner.is-warn { border-color: var(--warn-soft-bg); background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .vp-banner.is-bad { border-color: var(--bad-soft-bg); background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .vp-banner > div { display: flex; flex-direction: column; gap: .1rem; }
    .vp-banner span { opacity: .85; font-size: var(--fs-xs, .75rem); }

    /* ── Captura ─────────────────────────────────────────────────────────── */
    .vp-scanbar { display: flex; align-items: center; gap: .6rem; padding: .6rem .9rem;
      border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg);
      cursor: text; transition: border-color .12s ease, box-shadow .12s ease; }
    .vp-scanbar:focus-within { border-color: var(--action); box-shadow: 0 0 0 3px var(--action-ring); }
    .vp-scanbar > i { color: var(--action); font-size: 1.35rem; }
    .vp-scan-input { flex: 1; min-width: 0; border: 0; background: transparent; color: var(--text-main);
      font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: clamp(1rem, 2.2vw, 1.5rem); padding: .3rem .1rem; }
    .vp-scan-input:focus { outline: none; }
    .vp-scan-input:disabled { color: var(--text-faint); }
    .vp-scan-busy { color: var(--text-faint); font-size: 1rem; }
    .vp-scan-hint { font-size: var(--fs-xs, .75rem); color: var(--text-faint); white-space: nowrap; }
    @media (max-width: 40rem) { .vp-scan-hint { display: none; } }

    /* ── Resultado ───────────────────────────────────────────────────────── */
    .vp-result { flex: 1; display: flex; }
    .vp-card { flex: 1; border: 1px solid var(--border-color); border-radius: var(--r-md);
      background: var(--card-bg); padding: var(--sp-5); display: flex; flex-direction: column; gap: .35rem; }
    .vp-card.is-respaldo { border-color: var(--warn-soft-fg); }
    .vp-card-top { display: flex; align-items: center; gap: var(--sp-3); }
    .vp-cod { font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: var(--fs-sm, .8125rem); color: var(--text-faint); letter-spacing: .04em; }
    .vp-nombre { margin: 0; font-size: clamp(1.05rem, 2.6vw, 1.75rem); font-weight: 700;
      line-height: 1.15; text-wrap: balance; }

    /* ── [TDA.6] La respuesta va CENTRADA ────────────────────────────────
       Estaba alineada a la izquierda. En la pantalla que existe para que un numero se lea
       desde el otro lado del mostrador, el objeto principal pegado a un borde deja de ser
       el centro de atencion y se vuelve una esquina. Se centra el BLOQUE DE RESPUESTA
       (nombre, cifra, mayoreo, unidades); lo que no se centra es la letra chica larga, que
       se acota con max-width para no leerse en zig-zag.

       [TDA.7] CORRIJO LA JUSTIFICACION QUE ESCRIBI ACA. Decia que "§O.3 no dice donde" y me
       autoricé desde el silencio. DESIGN.md no está callado: "todo centrado" está en la lista
       anti-slop, "Centered everything" es antipatrón de Operations, y §Ing.UI 1 manda patrón F
       con las palabras "no centrado por estética". Centrar el NUCLEO de la respuesta se queda
       porque lo pidió 0Sistemas de forma explícita para esta pantalla —y en un mostrador que se
       lee de frente el patrón F no es el que aplica—, pero deja de ser un text-align que se
       hereda a todo: la nota legal y la lista de unidades vuelven a alinearse, porque ahí
       centrar rompía cosas que sí importan (ver .vp-unidades).
       (Sin acentos graves acá: rompen el template literal. Van 8 veces en este repo y esta la
       cometí yo, en el mismo archivo que ya lo advierte arriba.) */
    .vp-card-top { justify-content: center; }
    .vp-nombre, .vp-precio-principal, .vp-u-aclara, .vp-mayoreo { text-align: center; }
    .vp-precio-principal { display: flex; align-items: baseline; gap: var(--sp-3);
      flex-wrap: wrap; justify-content: center; margin-top: var(--sp-2); }
    /* La cifra es el objeto de la pantalla: se lee a un metro y medio, del otro lado del
       mostrador. clamp para que no reviente en el monitor chico del kiosco. */
    .vp-precio { font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-weight: 800; font-size: clamp(2.75rem, 9vw, 6rem); line-height: 1;
      letter-spacing: -0.02em; color: var(--text-main); }
    .vp-precio-u { font-size: var(--fs-body, .875rem); color: var(--text-muted); text-transform: lowercase; }

    /* [TDA.8] La advertencia de precio cambiado. Semantico --warn-*, y nunca solo el color:
       lleva icono y texto (DESIGN.md 5, el color no es unico portador de significado).
       No se centra el parrafo: es texto para leer, no una cifra. El bloque si va centrado. */
    .vp-cambio { margin: var(--sp-2) auto 0; width: fit-content; max-width: 60ch;
      display: flex; align-items: flex-start; gap: .5rem; text-align: left;
      padding: .4rem .75rem; border-radius: var(--r-md);
      background: var(--warn-soft-bg); border: 1px solid var(--warn-border);
      color: var(--warn-soft-fg); font-size: var(--fs-sm, .8125rem); text-wrap: pretty; }
    .vp-cambio > i { color: var(--warn-fg); font-size: .95em; flex: none; margin-top: .15em; }
    .vp-cambio strong { color: var(--warn-fg); }
    .vp-precio-nota { margin: .2rem auto 0; font-size: var(--fs-xs, .75rem); color: var(--text-faint);
      max-width: 68ch; text-wrap: pretty; }

    /* ── [TDA.4] Mayoreo ──────────────────────────────────────────────────
       Colorimetria segun DESIGN.md 5: la marca (--action, sunset) va en lo ACTIVO y en lo que
       hay que mirar, no decorando. Aca la lleva UNA sola cosa: el numero del umbral ("10+"),
       que es el dato accionable -- cuantas hay que llevar. El resto es neutro.

       El ahorro SI es una ganancia, asi que usa el semantico --ok-*, y nunca solo: lleva icono
       y texto (DESIGN.md 5, "color nunca es unico portador de significado"). Y solo aparece
       cuando el descuento es perceptible: por eso .is-realza gatea la fila entera.

       Sin hex inline en todo el bloque. */
    /* ── [TDA.6] El mayoreo pasa a ser LA OFERTA, no un renglon ───────────
       Antes era una fila de 1.6rem con el ahorro en letra chica: cierto y facil de saltear.
       El negocio quiere lo contrario -- que la persona se enfoque en llevarse mas y ahorrar --
       asi que gana superficie propia, franja de marca y una cifra que se lee de lejos.

       ⚠️ EL PUNTO CRITICO, y es de cobro, no de estetica: si el monto de mayoreo crece y la
       CONDICION se susurra, alguien que lleva una sola pieza lee el precio de tres. Por eso la
       condicion sube arriba, en mayusculas, al tamano del cuerpo, con el umbral en color de
       marca y 1.5em -- crece junto con el monto, nunca por detras.

       Y el hero sigue mandando (§O.3): 6rem contra 3.25rem de tope. El enfasis se gana con
       superficie, franja y aire; no robandole tamano al precio unitario. */
    .vp-mayoreo { margin: var(--sp-4) 0 0; padding: var(--sp-4) var(--sp-4) var(--sp-3);
      border-radius: var(--r-md); border: 1px solid var(--action-ring);
      background: var(--surface-ground); position: relative; overflow: hidden;
      display: flex; flex-direction: column; gap: var(--sp-2); }
    /* Franja de marca: marca EL BLOQUE que hay que mirar. Es el idioma de card del
       repertorio (DESIGN.md 7b: hairline + stripe 3px), no decoracion suelta. */
    .vp-mayoreo::before { content: ''; position: absolute; inset-inline: 0; top: 0; height: 3px;
      background: var(--action); }
    .vp-may-row { display: flex; flex-direction: column; align-items: center; gap: .1rem; }
    .vp-may-cond { display: flex; align-items: baseline; justify-content: center; gap: .4rem;
      font-size: var(--fs-body, .875rem); font-weight: 600; text-transform: uppercase;
      letter-spacing: .06em; color: var(--text-muted); }
    .vp-may-cond > i { color: var(--action); font-size: .95em; }
    /* El umbral es lo unico con color de marca dentro del texto: es la respuesta a
       "cuantas necesito", el dato accionable. */
    .vp-may-n { color: var(--action); font-weight: 800; font-family: var(--font-mono);
      font-variant-numeric: tabular-nums; font-size: 1.5em; line-height: 1; }
    .vp-may-precio { display: flex; align-items: baseline; justify-content: center; gap: .35rem; }
    /* Segundo en jerarquia y a mucha distancia del hero (3.25rem vs 6rem), pero ya no es
       letra chica. clamp con maximo 1.71x el minimo (regla: <= 2.5x, DESIGN.md 9). */
    .vp-may-monto { font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-weight: 800; font-size: clamp(1.9rem, 4.5vw, 3.25rem); line-height: 1;
      letter-spacing: -0.015em; color: var(--text-main); }
    .vp-may-cu { font-size: var(--fs-sm, .8125rem); color: var(--text-muted); }
    /* El ahorro deja de ser un renglon y pasa a ser una PASTILLA: es la frase que cierra la
       venta. Semantico --ok-* (es una ganancia), y nunca solo el color -- icono + texto
       (DESIGN.md 5, el color no es unico portador de significado). */
    .vp-may-ahorro { align-self: center; margin: 0; display: inline-flex; align-items: center;
      gap: .4rem; padding: .35rem .8rem; border-radius: var(--r-pill);
      background: var(--ok-soft-bg); border: 1px solid var(--ok-border);
      font-size: var(--fs-body, .875rem); color: var(--ok-soft-fg); }
    .vp-may-ahorro > i { color: var(--ok-fg); font-size: .95em; }
    .vp-may-ahorro strong { font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-weight: 800; font-size: 1.15em; color: var(--ok-fg); }
    .vp-may-pct { color: var(--ok-soft-fg); opacity: .75; font-size: .9em; }
    /* Sin realce (descuento < 1%): el dato se muestra igual, apagado, y el bloque pierde la
       franja. Es cierto, no es oferta -- pintarlo como oferta seria mentir con el color. */
    .vp-may-row:not(.is-realza) .vp-may-monto { font-weight: 600; color: var(--text-muted);
      font-size: clamp(1.4rem, 3vw, 2rem); }
    .vp-mayoreo:not(:has(.is-realza)) { border-color: var(--border-color); }
    .vp-mayoreo:not(:has(.is-realza))::before { background: var(--border-color); }

    /* ── [TDA.7] El escalon que NO es de la unidad leida ───────────────────
       Mismo tratamiento apagado que el sin-realce, y por un motivo mas fuerte: su monto puede
       estar en otra unidad que el hero (pesos por paquete contra pesos por pieza). Se muestra
       porque la cifra es cierta y viene rotulada con su unidad, pero no compite por el ojo con
       la que corresponde a lo que se escaneo.
       El :has() de arriba mira .is-realza, no .is-foco, a proposito: la franja de marca depende
       de que HAYA una oferta real en el bloque, no de cual esta destacada. */
    .vp-may-row:not(.is-foco) .vp-may-monto { font-weight: 600; color: var(--text-muted);
      font-size: clamp(1.4rem, 3vw, 2rem); }
    .vp-may-row:not(.is-foco) .vp-may-cond { opacity: .8; }
    .vp-may-row:not(.is-foco) .vp-may-n { color: var(--text-muted); }

    /* El gramaje califica al nombre: mismo renglon, peso menor. */
    .vp-gramaje { font-size: .55em; font-weight: 500; color: var(--text-faint);
      margin-left: .5rem; white-space: nowrap; }

    /* ── [TDA.4] Movimiento ───────────────────────────────────────────────
       CSS puro con los TOKENS del sistema (tokens.css declara BINDING: micro 120ms, short
       150ms, techo duro 350ms, y solo transform+opacity). Cero librerias: lo que esta pantalla
       pide es micro, y el bundle de view ya excede su budget por 228 kB.

       Se anima la TARJETA, nunca la cifra: en un mostrador el precio tiene que ser legible de
       inmediato, no al final de una transicion. Por eso tampoco hay count-up.

       prefers-reduced-motion lo neutraliza el bloque global de styles.css (regla con * e
       !important), asi que no se repite aca. */
    /* Dos juegos IDENTICOS de keyframes. No es duplicacion por descuido: la tarjeta es el
       mismo nodo entre escaneos, y cambiar el animation-name es lo que hace que el navegador
       reinicie la animacion. La clase is-pase-b alterna en cada consulta (ver la plantilla).
       Sin esto, la entrada corria UNA vez por turno.

       [TDA.7] ACA USABA --ease-spring Y LO DEFENDI CON "ya existe en tokens.css". Existir no es
       estar permitido: DESIGN.md §Motion acota esa curva a "solo gestos drag-to-dismiss", y una
       entrada de tarjeta no es un gesto. Pasa a --ease-decelerate, que es la curva que §Motion
       nombra para ENTRADAS. Se pierde el sobrepaso; el escalonado sigue dando el ritmo.
       NO se agrega libreria -- §U lo prohibe por nombre (anime.js/framer no entran) y motion@12
       ya esta instalada con cero imports desde abril. Una segunda dep muerta no arregla un easing.

       ESCALONADO, y suma bajo el techo duro de 350ms contando el retardo:
         nombre    0ms + 150 = 150      mayoreo    90ms + 150 = 240
         precio   40ms + 150 = 190      pastilla  140ms + 150 = 290
       Los PRECIOS no se animan por dentro: en un mostrador la cifra que se le lee en voz alta a
       una clienta tiene que ser legible en el primer fotograma, no al final de una transicion.
       Se mueve el bloque, nunca el digito. Solo transform + opacity, jamas medidas.
       [TDA.7] Este comentario decia "y no hay count-up" y quedo desactualizado en el commit
       065b4667: SI hay count-up, en el AHORRO (no en un precio). Excepcion documentada en
       DESIGN.md §Motion KPI.

       prefers-reduced-motion lo neutraliza el bloque global de styles.css (regla con * e
       !important), asi que no se repite aca. */
    @keyframes vpEntraA { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
    @keyframes vpEntraB { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
    @keyframes vpPopA { from { opacity: 0; transform: scale(.88); } to { opacity: 1; transform: none; } }
    @keyframes vpPopB { from { opacity: 0; transform: scale(.88); } to { opacity: 1; transform: none; } }
    @keyframes vpFadeA { from { opacity: 0; } to { opacity: 1; } }
    @keyframes vpFadeB { from { opacity: 0; } to { opacity: 1; } }

    .vp-card { --vp-in: vpEntraA; --vp-pop: vpPopA; --vp-fade: vpFadeA;
      animation: var(--vp-fade) var(--dur-short, 150ms) var(--ease-out, ease-out) both; }
    .vp-card.is-pase-b { --vp-in: vpEntraB; --vp-pop: vpPopB; --vp-fade: vpFadeB; }

    .vp-card .vp-nombre { animation: var(--vp-in) var(--dur-short, 150ms) var(--ease-decelerate, ease-out) both; }
    .vp-card .vp-precio-principal { animation: var(--vp-in) var(--dur-short, 150ms) var(--ease-decelerate, ease-out) 40ms both; }
    .vp-card .vp-mayoreo { animation: var(--vp-in) var(--dur-short, 150ms) var(--ease-decelerate, ease-out) 90ms both; }
    .vp-card .vp-may-ahorro { animation: var(--vp-pop) var(--dur-short, 150ms) var(--ease-decelerate, ease-out) 140ms both; }
    /* [TDA.3] "El codigo que escaneaste es de CJA". Va pegada al precio grande porque lo CALIFICA:
       separada, el operador leeria el numero antes de saber de que unidad es. */
    .vp-u-aclara { display: flex; align-items: center; justify-content: center; gap: .4rem;
      margin: .35rem 0 0; font-size: var(--fs-sm, .8125rem); color: var(--text-muted); }
    .vp-u-aclara strong { color: var(--text-main); font-weight: 600; }

    /* [TDA.6] El min-width de 7rem en la etiqueta separaba "CJA" de su propio precio, y en
       pantalla ancha el par se leia como dos datos sin relacion. Eso se queda arreglado.

       [TDA.7] Lo que se DESHACE es haber centrado los renglones. Este bloque conserva
       font-variant-numeric: tabular-nums en .vp-u-p, que existe para una sola cosa: que las
       cifras formen columna y los decimales alineen (DESIGN.md Q.5 lo llama innegociable). Con
       justify-content: center cada renglon se acomodaba a su propio ancho y la columna
       desaparecia -- la propiedad quedaba inerte. Y esta lista 0Sistemas nunca la menciono: se
       centro de arrastre por un text-align en la tarjeta.
       El BLOQUE sigue centrado (margin auto); lo que vuelve es la alineacion interna: etiqueta a
       la izquierda, cifra a la derecha, como pide DESIGN.md para listas de numeros. */
    .vp-unidades { list-style: none; margin: var(--sp-3) auto 0; padding: var(--sp-3) 0 0;
      border-top: 1px solid var(--border-color); display: flex; flex-direction: column; gap: .3rem;
      width: fit-content; min-width: min(100%, 22rem); text-align: left; }
    .vp-unidades li { display: flex; align-items: baseline; justify-content: flex-start;
      gap: var(--sp-3); font-size: var(--fs-sm, .8125rem); }
    /* El auto empuja cifra y equivalencia al borde derecho, JUNTAS: la equivalencia califica a
       la cifra, no es una tercera columna. */
    .vp-unidades li > .vp-u-p { margin-left: auto; }
    .vp-u-nom { color: var(--text-muted); text-transform: uppercase;
      font-size: var(--fs-xs, .75rem); letter-spacing: .06em; }
    .vp-u-p { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-weight: 600; }
    .vp-u-f { color: var(--text-faint); font-size: var(--fs-xs, .75rem); }

    .vp-vacio { flex: 1; display: flex; align-items: center; gap: var(--sp-4);
      border: 1px dashed var(--border-color); border-radius: var(--r-md); padding: var(--sp-5); }
    .vp-vacio > i { font-size: 2rem; color: var(--text-faint); flex: none; }
    .vp-vacio strong { display: block; font-size: var(--fs-body, .875rem); }
    .vp-vacio p { margin: .25rem 0 .5rem; font-size: var(--fs-sm, .8125rem); color: var(--text-muted); max-width: 46ch; }
    .vp-vacio.is-bad { border-style: solid; border-color: var(--bad-soft-bg); background: var(--bad-soft-bg); }
    .vp-vacio.is-bad > i, .vp-vacio.is-bad strong { color: var(--bad-soft-fg); }
    .vp-vacio.is-bad p { color: var(--bad-soft-fg); opacity: .9; }

    /* ── Pie: feed + estado del respaldo ─────────────────────────────────── */
    .vp-foot { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--sp-4);
      align-items: start; border-top: 1px solid var(--border-color); padding-top: var(--sp-3); }
    @media (max-width: 60rem) { .vp-foot { grid-template-columns: 1fr; } }
    .vp-feed-lbl { font-size: var(--fs-micro, .6875rem); text-transform: uppercase;
      letter-spacing: .06em; color: var(--text-faint); }
    .vp-feed-vacio { margin-left: .5rem; font-size: var(--fs-xs, .75rem); color: var(--text-faint); }
    .vp-feed ul { list-style: none; margin: .35rem 0 0; padding: 0; display: flex; flex-direction: column; gap: .15rem; }
    .vp-feed li { display: flex; align-items: baseline; gap: var(--sp-3); font-size: var(--fs-xs, .75rem); }
    .vp-feed li > i { color: var(--warn-soft-fg); font-size: .7rem; }
    .vp-feed-n { color: var(--text-muted); flex: 1; min-width: 0; overflow: hidden;
      white-space: nowrap; text-overflow: ellipsis; }
    .vp-feed-p { font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--text-main); }
    .vp-feed-h { font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--text-faint); }
    .vp-mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }

    .vp-respaldo { display: flex; flex-direction: column; align-items: flex-start; gap: .2rem;
      font-size: var(--fs-xs, .75rem); }
    .vp-respaldo-ok { color: var(--text-faint); display: inline-flex; align-items: center; gap: .35rem; }
    .vp-respaldo-no { color: var(--warn-soft-fg); display: inline-flex; align-items: center; gap: .35rem; }

    @media (prefers-reduced-motion: reduce) {
      .vp-scanbar { transition: none; }
    }
  `],
})
export class TiendaVerificadorComponent implements OnInit {
  private readonly svc = inject(VerificadorService);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly socket = inject(StoreSocketService);
  private readonly destroyRef = inject(DestroyRef);

  @ViewChild('scan') private scanInput?: ElementRef<HTMLInputElement>;

  /** Clave de preferencia del kiosco: la máquina del mostrador queda en kiosco tras recargar. */
  private static readonly LS_KIOSCO = 'tienda.verificador.kiosco';

  readonly sucursal = signal<string | null>(null);
  readonly sucursales = signal<SucursalVerificador[]>([]);
  readonly kiosco = signal(false);
  readonly buscando = signal(false);
  readonly descargando = signal(false);
  readonly banner = signal<Banner>(null);

  readonly estado = signal<'idle' | 'encontrado' | 'no_encontrado' | 'sin_datos'>('idle');
  readonly producto = signal<ProductoPrecio | null>(null);
  readonly origen = signal<OrigenPrecio>('live');
  readonly snapshotAl = signal<string | null>(null);

  // ── `[TDA.2]` Procedencia del precio ───────────────────────────────────────
  // `origen` ya decía de DÓNDE viene el dato (vivo o respaldo). Esto dice lo que faltaba: si el
  // número es el de ESTA plaza o uno que varía entre plazas, y si lo corrigió una persona.
  //
  // Antes `/api/kp/precio` ni tomaba sucursal: devolvía la primera fila de `kdii` en orden
  // arbitrario, y con 385 códigos que difieren entre plazas eso significaba que el mostrador podía
  // mostrar el precio de CEDIS — la fila que la etiquetera excluye a propósito. Anaquel y mostrador
  // podían decir números distintos del mismo producto, sin que la pantalla lo insinuara.
  readonly origenPrecio = signal<'kepler' | 'override_manual'>('kepler');
  readonly precioAmbiguo = signal(false);
  readonly plazasDistintas = signal(1);
  readonly plazaSinDato = signal(false);
  readonly ultimoCodigo = signal('');
  /**
   * `[TDA.6]` Cuántas consultas se contestaron. Existe SÓLO para reiniciar la animación de
   * entrada: la tarjeta es el mismo nodo entre escaneos, así que sin esto la entrada corría
   * una vez por turno. Ver `is-pase-b` en la plantilla.
   */
  readonly pase = signal(0);
  readonly feed = signal<Consulta[]>([]);

  /**
   * `[TDA.8]` El precio que está en pantalla cambió en el ERP mientras estaba a la vista.
   *
   * ── Por qué se DECLARA y no se refresca en silencio ──────────────────────────────────────
   * En un mostrador la cifra se lee en voz alta. Si alguien está diciendo "ochenta y cinco
   * cuarenta y nueve" y el número se transforma solo, nadie —ni quien lee ni quien escucha—
   * sabe cuál de los dos se dijo. La etiquetera resolvió lo mismo MARCANDO las filas en vez de
   * refrescarlas. Acá pesa más: ahí el costo es reimprimir una etiqueta, acá es cobrar mal.
   *
   * Se guarda el precio anterior a propósito. "Este precio cambió" sin decir desde cuánto obliga
   * a creerle a la pantalla; con el número viejo al lado, la persona puede ver el salto y
   * decidir. Es la misma idea que la procedencia de `[TDA.2]`: el número viaja con su historia.
   */
  readonly precioCambio = signal(false);
  readonly precioAnterior = signal<number | null>(null);

  /**
   * ¿Este aviso le habla a ESTA pantalla?
   *
   * ⚠️ La respuesta por default es **sí**, y es deliberado. Sólo se descarta un aviso cuando se
   * puede afirmar que NO es de este producto — o sea, cuando hay `product_id` y no está en la
   * lista. Los dos casos de ignorancia se tratan como incumbencia:
   *
   *  · **`truncated`** — el aviso vino recortado: "no sé cuáles" no es "ninguno". Es la misma
   *    trampa que la etiquetera ya documentó (y la misma que `FRESHNESS_UNKNOWN` con
   *    `stale:false` dejó viva seis días en esa pantalla).
   *  · **sin `product_id`** — el precio salió del respaldo (el snapshot no lleva la llave) o el
   *    código no casó una fila de etiqueta. No se puede descartar, así que se verifica.
   *
   * Verificar cuesta UNA consulta de un producto. Callarse cuesta un cobro mal.
   */
  private meIncumbe(p: LabelPricesChanged): boolean {
    if (p?.truncated) return true;
    const pid = this.producto()?.product_id ?? null;
    if (!pid) return true;
    const ids = Array.isArray(p?.product_ids) ? p.product_ids : [];
    return ids.includes(pid);
  }

  /**
   * Llegó el aviso: se vuelve a preguntar el precio y se marca que cambió.
   *
   * Reusa `svc.buscar` + `aplicar` en vez de escribir un segundo camino de resolución — si el
   * refresco resolviera distinto que el escaneo, la pantalla tendría dos verdades. `aplicar`
   * limpia el banner, así que la marca se pone DESPUÉS de que el resultado aterriza.
   */
  private refrescarPorAviso(p: LabelPricesChanged): void {
    if (this.estado() !== 'encontrado') return;
    const prod = this.producto();
    const suc = this.sucursal();
    if (!prod || !suc || !this.meIncumbe(p)) return;

    const antes = this.precioPrincipal();
    this.svc.buscar(prod.codigo, suc).subscribe({
      next: (r) => {
        this.aplicar(r);
        const ahora = this.precioPrincipal();
        // Si la cifra no se movió, el aviso era de otra unidad o de otro campo de la etiqueta:
        // gritar "cambió" sobre un número idéntico es la clase de alarma que se aprende a
        // ignorar, y entonces deja de servir el día que sí importa.
        if (antes != null && ahora != null && antes !== ahora) {
          this.precioAnterior.set(antes);
          this.precioCambio.set(true);
        }
      },
      // Fail-open: si el refresco no sale, queda lo que ya estaba. Un aviso perdido degrada al
      // comportamiento de siempre (se ve al siguiente escaneo), nunca a una pantalla en blanco.
      error: () => { /* el service ya cae al respaldo; no se toca lo que está en pantalla */ },
    });
  }

  readonly snapshot = signal<EstadoSnapshot | null>(null);

  /** Sucursal del usuario. Si la tiene, la pantalla no ofrece elegir otra. */
  private readonly sucursalUsuario = this.auth.user()?.warehouse_code || '';

  readonly sucursalFija = computed(() => !!this.sucursalUsuario);

  readonly opcionesSucursal = computed(() =>
    this.sucursales().map((s) => ({ label: `${s.codigo} · ${s.nombre}`, value: s.codigo })));

  readonly sucursalNombre = computed(() => {
    const c = this.sucursal();
    if (!c) return 'Sin sucursal asignada';
    const s = this.sucursales().find((x) => x.codigo === c);
    return s?.nombre || branchName(c);
  });

  /** Frescura del ODS de ESA sucursal (viene del servidor, no del navegador). */
  readonly datosAl = computed(() => this.sucursales().find((s) => s.codigo === this.sucursal())?.datos_al ?? null);

  /**
   * `[TDA.3]` El número GRANDE es el de la unidad que se escaneó.
   *
   * Antes era siempre `unidades[0]`, o sea la unidad base: **escanear el código de la caja mostraba
   * el precio de la pieza.** Si el producto tenía base PZA y se escaneaba la pieza, acertaba por
   * coincidencia, no porque lo resolviera.
   *
   * `unidades` sigue en orden base-primero a propósito: sus `factor` significan "cuántas unidades
   * base entran acá", así que reordenar el arreglo volvería falsa la leyenda de las demás ("1 CJA"
   * para una pieza). Lo que cambia es a cuál se le da el número grande, no el orden.
   */
  readonly unidadEscaneada = signal<string | null>(null);

  /**
   * La unidad de factor 1 — a ella se refieren los `factor` de las demás.
   *
   * Se **deriva** de `unidades[0]` en vez de leerse de la respuesta, aunque el backend ahora manda
   * `unidad_base`: el arreglo es base-primero por contrato y el respaldo local también lo cumple.
   * Depender del campo nuevo hacía que la equivalencia ("20 KG") **desapareciera** con un respaldo
   * viejo o un backend sin redeployar — lo cazó el spec que ya existía, y tenía razón.
   */
  readonly unidadBase = computed(() => this.producto()?.unidades?.[0]?.u ?? null);

  /** La unidad que se muestra en grande: la escaneada si se pudo resolver, la base si no. */
  private readonly unidadHero = computed(() => {
    const us = this.producto()?.unidades ?? [];
    const esc = this.unidadEscaneada();
    return (esc && us.find((x) => x.u === esc)) || us[0] || null;
  });

  /**
   * `[TDA.4]` Los escalones de mayoreo del producto en pantalla.
   *
   * Llegan ya filtrados por el backend: si un tier está acá, su umbral es real y su precio es
   * más barato que el unitario. La pantalla **pinta, no decide** — poner acá una segunda regla
   * sería tener la condición del mayoreo en dos lugares.
   */
  readonly mayoreo = computed(() => this.producto()?.mayoreo ?? []);

  /**
   * `[TDA.7]` El escalón que va en GRANDE es el de la unidad que se escaneó.
   *
   * Es la regla que dictó 0Sistemas y que la etiquetera ya tenía escrita —textual en
   * `label.component.ts`: *"el mayoreo debe ser el de la UNIDAD LEÍDA"*, que es por qué
   * `hasMayoreoPza` empieza con `if (!this.bigIsBase) return false`. El mostrador no la tenía:
   * pintaba los dos escalones al mismo tamaño sin relación con lo que se leyó, y el monto de uno
   * puede estar en pesos por PAQUETE mientras el otro está en pesos por pieza.
   *
   * No agrega una segunda regla de negocio: `aplica_a` lo decide el backend (que es quien sabe
   * contra qué base se calculó cada escalón) y acá sólo se compara contra la unidad del hero,
   * reusando `unidadHero()` de `[TDA.3]`. Funciona igual sin red: el respaldo trae `aplica_a` por
   * escalón, así que el kiosco offline destaca el mismo que el modo en línea.
   *
   * El que NO corresponde a la unidad leída se atenúa, no se esconde: su cifra es cierta y viene
   * rotulada con su propia unidad (`unidad_monto` + `palabra`), y esta pantalla existe para
   * contestar "cuánto cuesta", incluido "y si llevo piezas". La etiquetera sí lo oculta porque
   * imprime en papel sin contexto; la diferencia es de ÉNFASIS, no de cifra — las cifras ahora
   * salen del mismo cálculo en las dos.
   */
  readonly mayoreoConFoco = computed(() => {
    const ts = this.mayoreo();
    if (!ts.length) return [];
    const quiere: 'base' | 'paquete' =
      this.unidadHero()?.u === this.unidadBase() ? 'base' : 'paquete';
    return ts
      .map((t) => ({ t, destacado: (t.aplica_a ?? 'base') === quiere }))
      .sort((a, b) => Number(b.destacado) - Number(a.destacado));
  });

  readonly precioPrincipal = computed(() => this.unidadHero()?.precio_con_iva ?? null);
  readonly unidadPrincipal = computed(() => this.unidadHero()?.u || 'unidad');

  /**
   * Las OTRAS unidades: todas menos la que va en grande.
   *
   * Antes era `unidades.slice(1)` —siempre "todas menos la base"—, lo que con el hero móvil dejaría
   * al precio grande repetido abajo y escondería el de la base.
   */
  readonly otrasUnidades = computed(() => {
    const hero = this.unidadHero();
    return (this.producto()?.unidades ?? []).filter((x) => x !== hero);
  });

  /**
   * ¿Vale la pena decir de qué unidad es el precio?
   *
   * Sólo cuando el producto tiene más de una unidad con precio. Está medido que **93.6 % de los
   * SKUs tienen UNA sola unidad registrada**, así que un aviso incondicional saldría en 9 de cada
   * 10 escaneos — y un aviso que sale siempre se aprende a ignorar.
   */
  readonly vaAclararUnidad = computed(
    () => (this.producto()?.unidades?.length ?? 0) > 1 && !!this.unidadEscaneada(),
  );

  ngOnInit(): void {
    // La sucursal sale de la ficha del usuario; el query param la sobreescribe para la
    // máquina del mostrador, que puede no tener cuenta propia de esa tienda.
    const param = this.route.snapshot.queryParamMap.get('sucursal');
    const inicial = (param && /^[0-9]{2}$/.test(param) ? param : this.sucursalUsuario) || null;
    this.sucursal.set(inicial);

    try {
      this.kiosco.set(localStorage.getItem(TiendaVerificadorComponent.LS_KIOSCO) === '1');
    } catch { /* localStorage bloqueado: el kiosco arranca apagado, no es crítico */ }

    // `[TDA.8]` El aviso en vivo de que un precio de etiqueta cambió en el ERP.
    //
    // Conecta y NO desconecta, igual que la etiquetera: el socket es singleton de root y
    // `tienda-state` lo administra con un refcount que llama `disconnect()` al llegar a cero.
    // Un `disconnect()` desde acá le cortaría el socket a los otros consumidores.
    this.socket.connect();
    this.socket.labelPricesChanged$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((p) => this.refrescarPorAviso(p));

    this.svc.sucursales().subscribe({
      next: (list) => {
        // CEDIS (00) no vende al público: no es una plaza de mostrador.
        this.sucursales.set(list.filter((s) => s.codigo !== '00'));
        // Sólo se toca el respaldo si la lista es la que RESOLVIÓ la sucursal: si ya venía
        // de la ficha del usuario, `ngOnInit` lo preparó y volver a llamar acá bajaría el
        // catálogo dos veces.
        if (!this.sucursal() && this.sucursales().length === 1) {
          this.sucursal.set(this.sucursales()[0].codigo);
          this.prepararRespaldo();
        }
        if (!this.sucursal()) {
          this.banner.set({
            texto: 'Elige la sucursal para empezar.',
            detalle: 'Los precios cambian entre plazas, así que la pantalla no adivina cuál es.',
            tono: 'info',
          });
        }
      },
      error: (e) => this.banner.set({
        texto: 'No se pudo leer el catálogo de sucursales.',
        detalle: this.httpMsg(e) + ' El verificador sigue funcionando con el respaldo local si ya está descargado.',
        tono: 'warn',
      }),
    });

    this.prepararRespaldo();
    this.enfocar();
  }

  /** Deja el respaldo listo (lo lee de IndexedDB y lo re-baja si venció). */
  private prepararRespaldo(): void {
    const suc = this.sucursal();
    if (!suc) return;
    this.svc.asegurarSnapshot(suc).subscribe({
      next: (s) => this.snapshot.set(s),
      error: () => this.snapshot.set(null),
    });
  }

  cambiarSucursal(codigo: string): void {
    this.sucursal.set(codigo);
    this.snapshot.set(null);
    this.banner.set(null);
    this.limpiarResultado();
    this.prepararRespaldo();
    this.enfocar();
  }

  /** El acto central: un código entra, un precio sale. */
  consultar(raw: string): void {
    const codigo = (raw || '').trim();
    if (!codigo) { this.enfocar(); return; }
    const suc = this.sucursal();
    if (!suc) { this.enfocar(); return; }

    this.ultimoCodigo.set(codigo);
    this.buscando.set(true);

    this.svc.buscar(codigo, suc).subscribe({
      next: (r) => {
        this.buscando.set(false);
        this.aplicar(r);
        this.enfocar();
      },
      error: (e) => {
        // El service ya cae al respaldo ante fallos de red; llegar acá es algo inesperado,
        // y se muestra en vez de callarse (DESIGN pre-vuelo 6: error != empty).
        this.buscando.set(false);
        this.estado.set('sin_datos');
        this.producto.set(null);
        this.banner.set({ texto: 'La consulta falló.', detalle: this.httpMsg(e), tono: 'bad' });
        this.enfocar();
      },
    });
  }

  private aplicar(r: ResultadoBusqueda): void {
    // `[TDA.6]` Un pase por consulta contestada, encontrada o no. Es lo que reinicia la
    // animación de entrada sobre un nodo que no se recrea.
    this.pase.update((n) => n + 1);
    if (r.estado === 'encontrado') {
      this.estado.set('encontrado');
      this.producto.set(r.producto);
      this.origen.set(r.origen);
      this.snapshotAl.set(r.snapshotAl);
      // `[TDA.2]` Procedencia del número. Se resetea en CADA resultado: si quedara pegada del
      // producto anterior, la pantalla diría "corregido a mano" sobre uno que no lo está.
      this.origenPrecio.set(r.origenPrecio ?? 'kepler');
      this.precioAmbiguo.set(r.precioAmbiguo === true);
      this.plazasDistintas.set(r.plazasDistintas ?? 1);
      this.plazaSinDato.set(r.plazaSinDato === true);
      // `[TDA.3]` Mismo criterio: se resetea en CADA resultado. Pegada del escaneo anterior, la
      // pantalla mostraría en grande el precio de una unidad que este código no representa.
      this.unidadEscaneada.set(r.unidadEscaneada ?? null);
      // `[TDA.8]` Y la marca de "este precio cambió", por el mismo motivo: pegada del producto
      // anterior diría que cambió uno que no cambió. `refrescarPorAviso` la vuelve a poner
      // DESPUÉS, si de verdad se movió la cifra.
      this.precioCambio.set(false);
      this.precioAnterior.set(null);
      if (r.origen === 'respaldo') {
        this.banner.set({
          texto: 'Sin conexión: se está mostrando el precio de respaldo.',
          detalle: 'Es el catálogo descargado en esta máquina; puede haber cambiado. Confirma en caja antes de cobrar.',
          tono: 'warn',
        });
      } else {
        this.banner.set(null);
      }
      this.empujarFeed({
        codigo: r.producto.codigo,
        nombre: r.producto.nombre,
        precio: r.producto.unidades?.[0]?.precio_con_iva ?? null,
        unidad: r.producto.unidades?.[0]?.u || '',
        origen: r.origen,
        hora: new Date(),
      });
      return;
    }

    this.producto.set(null);
    this.estado.set(r.estado);
    if (r.estado === 'no_encontrado') {
      this.origen.set(r.origen);
      this.snapshotAl.set(r.snapshotAl);
      this.banner.set(r.origen === 'respaldo'
        ? { texto: 'Sin conexión: se buscó en el respaldo local.', detalle: 'Un producto dado de alta hoy puede no estar en el respaldo.', tono: 'warn' }
        : null);
    } else {
      this.banner.set({
        texto: 'Sin conexión y sin respaldo con qué contestar.',
        detalle: 'Descarga el respaldo cuando vuelva la red.',
        tono: 'bad',
      });
    }
    this.empujarFeed({
      codigo: this.ultimoCodigo(), nombre: '', precio: null, unidad: '',
      origen: r.estado === 'no_encontrado' ? r.origen : 'ninguno', hora: new Date(),
    });
  }

  /** Lo último arriba, tope de 8: es un feed de mostrador, no una bandeja auditable (§O.3). */
  private empujarFeed(c: Consulta): void {
    this.feed.update((f) => [c, ...f].slice(0, 8));
  }

  private limpiarResultado(): void {
    this.estado.set('idle');
    this.producto.set(null);
    this.ultimoCodigo.set('');
  }

  descargarRespaldo(): void {
    const suc = this.sucursal();
    if (!suc || this.descargando()) return;
    this.descargando.set(true);
    this.banner.set({ texto: 'Descargando el catálogo de precios…', detalle: 'Son unos miles de productos; tarda unos segundos.', tono: 'info' });
    this.svc.descargarSnapshot(suc).subscribe({
      next: (s) => {
        this.descargando.set(false);
        this.snapshot.set(s);
        this.banner.set({ texto: `Respaldo actualizado: ${s.total} productos.`, detalle: 'El mostrador ya puede consultar sin red.', tono: 'ok' });
        this.enfocar();
      },
      error: (e) => {
        this.descargando.set(false);
        this.banner.set({ texto: 'No se pudo descargar el respaldo.', detalle: this.httpMsg(e), tono: 'bad' });
      },
    });
  }

  toggleKiosco(): void {
    const on = !this.kiosco();
    this.kiosco.set(on);
    try { localStorage.setItem(TiendaVerificadorComponent.LS_KIOSCO, on ? '1' : '0'); } catch { /* no crítico */ }
    // Pantalla completa del navegador: mejora progresiva. Si el navegador la niega
    // (o la bloquea por falta de gesto), el overlay ya tapó el chrome de la app igual.
    try {
      if (on) void document.documentElement.requestFullscreen?.().catch(() => undefined);
      else if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => undefined);
    } catch { /* no crítico */ }
    this.enfocar();
  }

  /** Escape sale del kiosco (en pantalla completa no hay chrome del navegador que ayude). */
  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.kiosco()) this.toggleKiosco();
  }

  /**
   * Foco permanente (§O.3). Se re-enfoca al perder el foco SIN robárselo a otro control
   * de la pantalla: si el usuario fue a un botón o al selector de sucursal, se respeta.
   * Sin esa guarda, el foco queda atrapado y no se puede navegar con teclado (a11y).
   */
  reenfocar(): void {
    setTimeout(() => {
      const act = document.activeElement;
      const enUnControl = act instanceof HTMLElement
        && act !== document.body
        && act.closest('button, [role="button"], input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])');
      if (!enUnControl) this.enfocar();
    }, 120);
  }

  enfocar(): void {
    setTimeout(() => this.scanInput?.nativeElement?.focus(), 0);
  }

  money(v: number | null | undefined): string {
    if (v == null) return '—';
    return (Number(v) || 0).toLocaleString('es-MX', {
      style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
  }

  private httpMsg(e: any): string {
    const s = e?.status;
    if (s === 0 || s == null) return 'Sin respuesta del servidor.';
    if (s === 403) return 'Sin permiso (403).';
    if (s === 404) return 'Ruta no encontrada (404) — puede faltar reiniciar la API.';
    return `Error ${s}${e?.error?.message ? ': ' + e.error.message : ''}.`;
  }
}
