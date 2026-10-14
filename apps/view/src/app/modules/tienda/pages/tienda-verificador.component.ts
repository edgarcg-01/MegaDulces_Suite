import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, HostListener, OnDestroy, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ConfirmationService } from 'primeng/api';
import { SelectModule } from 'primeng/select';
import { BrowserMultiFormatReader, IScannerControls } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { branchName } from '../../../core/constants/store-branches';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { CountUpDirective } from '../../../shared/directives/count-up.directive';
import { StoreSocketService, type LabelPricesChanged } from '../store-socket.service';
import { EstadoSnapshot, OrigenPrecio, ProductoPrecio, ResultadoBusqueda, SucursalVerificador, VerificadorService } from '../verificador.service';

/**
 * El precio en dos partes: entero (grande) y centavos (chicos, arriba). Pura, para que el precio
 * principal, el mayoreo y las otras unidades se partan IGUAL.
 *
 * Se parte sobre el total en CENTAVOS enteros y no sobre toFixed: asi 85.995 -> 86.00 acarrea bien
 * al entero en vez de quedar 85 y 100. Sin precio no se dibujan centavos (ni un cero inventado).
 */
export function partesPrecio(v: number | null | undefined): { entero: string; centavos: string } {
  if (v == null) return { entero: '—', centavos: '' };
  const total = Math.round(Math.abs(Number(v) || 0) * 100);
  return {
    entero: Math.floor(total / 100).toLocaleString('es-MX'),
    centavos: String(total % 100).padStart(2, '0'),
  };
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
 * la jerarquía. NO lleva feed de "últimas consultas" a la vista (se tuvo y se quitó,
 * 2026-09-14): en un mostrador público cualquiera que pasa lee qué escaneó el cliente
 * anterior y a qué precio — piso de tienda lo señaló y se declaró correcto retirarlo.
 *
 * ── Piel: la del estándar, sin excepción (`[VAC.U11/U12]`, decisión 0Sistemas, 2026-10-14) ──
 * Desde el 2026-09-12 esta pantalla era la ÚNICA del repo con piel propia (clon del
 * `verificador.html` retirado: Sniglet, paleta cruda, fondo claro fijo con patrón de dulces).
 * Esa excepción se retiró: ahora usa la tipografía de Operations (Hanken Grotesk para texto,
 * Geist Mono para cifras y códigos), los tokens de color de la Suite y **sigue el tema
 * claro/oscuro**, igual que el resto. Sin fondo propio, sin patrón y sin franja decorativa.
 * Lo que no era piel sigue intacto: procedencia del precio (TDA.2), unidad escaneada (TDA.3),
 * mayoreo con foco (TDA.4/7), declarar en vez de ocultar (ADR-056), "no encontrado" != "sin
 * conexión" (DESIGN pre-vuelo 6). Queda pendiente, del plan `FASE_VAC`: descomponer el
 * componente, matriz de estados y a11y (`VAC.U1-U10`).
 */
@Component({
  selector: 'app-tienda-verificador',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, SelectModule, ContextHelpComponent, FreshnessPillComponent, CountUpDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="vf-page" [class.is-kiosco]="kiosco()">
      <!-- Franja de control: lo que el kiosco de 2026 NO tenía y sí necesita (multi-sucursal,
           frescura declarada, ayuda) — funcional, no decoración, así que se queda, sólo con la
           piel nueva. Chica y arriba a la derecha para no competir con el logo/escáner. -->
      <div class="vf-ctrl">
        @if (datosAl()) {
          <app-freshness-pill measures="data" [since]="datosAl()" [staleAfterSec]="3600" />
        } @else {
          <span class="vf-fresh-nd" title="El backend no reporta el latido del ERP para esta sucursal (analytics.cron_runs, cdc_wal_NN). No se sabe de cuándo es el precio.">
            <i class="pi pi-question-circle" aria-hidden="true"></i> Frescura del ERP sin medir
          </span>
        }
        @if (!sucursalFija()) {
          <p-select [options]="opcionesSucursal()" optionLabel="label" optionValue="value"
                    [ngModel]="sucursal()" (ngModelChange)="cambiarSucursal($event)"
                    placeholder="Sucursal" appendTo="body"
                    aria-label="Sucursal del verificador"></p-select>
        } @else {
          <span class="vf-suc">{{ sucursalNombre() }}</span>
        }
        <button type="button" class="vf-icon-btn" [attr.aria-label]="kiosco() ? 'Salir de kiosco' : 'Modo kiosco'"
                (click)="toggleKiosco()">
          <i class="pi" [class.pi-window-minimize]="kiosco()" [class.pi-window-maximize]="!kiosco()"></i>
        </button>
        <app-context-help topic="verificador" />
      </div>

      @if (banner(); as b) {
        <div class="vf-banner" [class]="'is-' + b.tono" role="status">
          <i class="pi" [class.pi-info-circle]="b.tono === 'info'" [class.pi-check-circle]="b.tono === 'ok'"
             [class.pi-exclamation-triangle]="b.tono === 'warn'" [class.pi-times-circle]="b.tono === 'bad'"></i>
          <div>
            <strong>{{ b.texto }}</strong>
            @if (b.detalle) { <span>{{ b.detalle }}</span> }
          </div>
        </div>
      }

      @if (!logoFalla()) {
        <img class="vf-logo" src="assets/logos/mega-dulces-logo.webp" alt="Mega Dulces"
             (error)="logoFalla.set(true)">
      } @else {
        <div class="vf-logo-txt"><span class="vf-m">Mega</span><span class="vf-d">Dulces</span></div>
      }

      <!-- La barra ES el disparador de la cámara: ya tenía el icono y el texto, un botón
           redondo aparte al lado del input era el mismo gesto duplicado dos veces. -->
      @if (!kiosco()) {
        <button type="button" class="vf-scanbar" [disabled]="!sucursal()"
                aria-label="Escanear con la cámara del celular" (click)="abrirCamara()">
          <i class="pi pi-camera" aria-hidden="true"></i> Escanea tu Producto
        </button>
      }

      <!-- Captura: lo único con foco. Input nativo (mismo criterio que antes: un componente de
           PrimeNG metería su propio borde y rompería el look de la píldora). -->
      <div class="vf-input-row">
        <input #scan type="text" inputmode="numeric" autocomplete="off" enterkeyhint="search"
               class="vf-input" aria-label="Escanear o teclear la clave o el código de barras"
               placeholder="Escanea o teclea el código…"
               [disabled]="!sucursal()"
               (keyup.enter)="consultar(scan.value); scan.value = ''"
               (blur)="reenfocar()" />
        @if (buscando()) { <i class="pi pi-spin pi-spinner vf-busy" aria-label="Consultando"></i> }
      </div>
      <div class="vf-hint">Coloca el código de barras frente al lector</div>

      @if (camaraAbierta()) {
        <div class="vf-cam-ov" role="dialog" aria-modal="true" aria-label="Escaneo con la cámara">
          <p class="vf-cam-tip">Encuadra el código de barras</p>
          <video #video class="vf-cam-vid" playsinline muted></video>
          <button #camCancelar type="button" class="vf-cam-x" (click)="cerrarCamara()"
                  (keyup.escape)="cerrarCamara()">Cancelar</button>
        </div>
      }

      <!-- Resultado: la tarjeta, tal como en el HTML original (oculta hasta la primera
           consulta, sin placeholder de "listo para consultar"). -->
      <section class="vf-result" aria-live="polite">
        @switch (vista()) {
          @case ('buscando') {
            <!-- Esqueleto con las MEDIDAS de la tarjeta: cuando llega el resultado nada se
                 corre (CLS 0). Entra con retardo: una consulta rápida nunca lo muestra, y un
                 parpadeo gris en cada escaneo del mostrador sería ruido. -->
            <div class="vf-skel" aria-hidden="true">
              <span class="vf-skel-bar is-nombre"></span>
              <span class="vf-skel-bar is-precio"></span>
              <span class="vf-skel-bar is-nota"></span>
            </div>
          }
          @case ('encontrado') {
            @if (producto(); as p) {
              <!-- [TDA.6] is-pase-b alterna en cada consulta para reiniciar la animación
                   "pop" sobre el MISMO nodo del DOM (ver comentario histórico más abajo). -->
              <div #card class="vf-card" [class.is-respaldo]="origen() === 'respaldo'"
                   [class.is-pase-b]="pase() % 2 === 1">
                @if (!kiosco()) {
                  <div class="vf-card-top">
                    <span class="vf-cod">{{ p.codigo }}</span>
                    @if (origen() === 'respaldo') {
                      <span class="vf-tag is-warn"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> Precio de respaldo</span>
                    } @else {
                      <span class="vf-tag is-ok"><i class="pi pi-bolt" aria-hidden="true"></i> Precio en línea</span>
                    }
                  </div>
                }
                <div class="vf-nombre">
                  {{ p.nombre || 'Sin nombre en el catálogo' }}
                  <!-- [TDA.4] El gramaje califica al nombre, no es un dato aparte. -->
                  @if (p.contenido) { <span class="vf-gramaje">{{ p.contenido }}</span> }
                </div>

                <!--
                  [TDA.8] El precio cambio en el ERP mientras estaba en pantalla. Va ARRIBA de la
                  cifra y no abajo: es una advertencia sobre el numero, y una advertencia que se
                  lee despues del numero llega tarde. role=status para que el lector de pantalla
                  lo anuncie sin robar el foco de la captura (O.3: el foco no se mueve nunca).
                -->
                @if (precioCambio() && !kiosco()) {
                  <p class="vf-cambio" role="status">
                    <i class="pi pi-refresh" aria-hidden="true"></i>
                    <span>
                      Este precio <strong>acaba de cambiar</strong> en el ERP.
                      @if (precioAnterior() != null) {
                        Antes decía <span class="vf-num">{{ money(precioAnterior()) }}</span>.
                      }
                      Confirma en caja antes de cobrar.
                    </span>
                  </p>
                }

                <div class="vf-cuerpo" [class.con-mayoreo]="mayoreo().length > 0">
                  <div class="vf-col-precio">
                  <div class="vf-unidad-lbl">POR {{ unidadLabel(unidadPrincipal()) | uppercase }}</div>
                  <div class="vf-precio"><span class="vf-peso">$</span>{{ precioPartes().entero }}@if (precioPartes().centavos) {<span class="vf-cent"><span class="vf-punto">.</span>{{ precioPartes().centavos }}</span>}</div>
  
                  <!-- [TDA.3] Sólo cuando hay más de una unidad con precio: medido, el 93.6% de
                       los SKUs tiene una sola, así que un aviso incondicional se aprendería a
                       ignorar en 9 de cada 10 escaneos. -->
                  @if (vaAclararUnidad()) {
                    <p class="vf-u-aclara">El código que escaneaste es de <strong>{{ unidadLabel(unidadEscaneada() || '') }}</strong>: este es su precio.</p>
                  }
                  </div>
                  <!-- [TDA.4/7] El mayoreo, con foco en la unidad ESCANEADA (backend ya
                       descartó los tiers sin condición conocida — la pantalla pinta, no decide). -->
                  @if (mayoreo().length) {
                    <div class="vf-mayoreo">
                      <div class="vf-may-titulo"><i class="pi pi-tags" aria-hidden="true"></i> Precio por mayoreo</div>
                      @for (x of mayoreoConFoco(); track x.t.etiqueta) {
                        @let t = x.t;
                        @let pm = partes(t.precio_con_iva);
                        <div class="vf-may-row" [class.is-realza]="t.realza" [class.is-foco]="x.destacado">
                          <div class="vf-may-cond">Llevando <strong class="vf-may-n">{{ t.desde }}</strong> o más {{ t.palabra }}</div>
                          @if (t.equivale_a) {
                            <div class="vf-may-eq">Equivale a {{ t.equivale_a }}</div>
                          }
                          <div class="vf-may-precio">
                            <span class="vf-may-monto"><span class="vf-peso">$</span>{{ pm.entero }}@if (pm.centavos) {<span class="vf-cent"><span class="vf-punto">.</span>{{ pm.centavos }}</span>}</span>
                            <span class="vf-may-cu">{{ t.unidad_monto }}</span>
                          </div>
                        </div>
                        @if (t.realza && x.destacado) {
                          <!-- La cifra principal es el ahorro POR UNIDAD (la que vuelve comparables dos
                               precios); el total del mínimo va de apoyo. Pegar un total a un porcentaje
                               unitario se leía como si el % aplicara a ese total. -->
                          @let tot = partes(t.ahorro_en_el_minimo);
                          <p class="vf-may-ahorro">
                            <span class="vf-may-ahorro-main">
                              Ahorras
                              <strong [appCountUp]="t.ahorro_por_unidad" [appCountUpLive]="true" countUpFormat="money2"></strong>
                              {{ t.unidad_monto === 'c/u' ? 'por unidad' : t.unidad_monto }}
                              <span class="vf-may-pct">({{ t.descuento_pct }}% menos)</span>
                            </span>
                            <span class="vf-may-total">Llevando {{ t.desde }} {{ t.palabra }}: &#36;{{ tot.entero }}.{{ tot.centavos }} en total</span>
                          </p>
                        }
                      }
                    </div>
                  }
                </div>

                <!-- [TDA.3] Las OTRAS unidades, como píldoras (mismo tratamiento visual que
                     .u-item del HTML original). El factor se refiere a la unidad BASE. -->
                @if (otrasUnidades().length) {
                  <div class="vf-otras">
                    @for (u of otrasUnidades(); track u.u) {
                      @let pu = partes(u.precio_con_iva);
                      <span class="vf-u-item">
                        <b>{{ unidadLabel(u.u) }}</b>
                        <span class="vf-u-precio"><span class="vf-peso">$</span>{{ pu.entero }}@if (pu.centavos) {<span class="vf-cent"><span class="vf-punto">.</span>{{ pu.centavos }}</span>}</span>
                        @if (u.factor > 1 && unidadBase()) { <span class="vf-u-f">({{ u.factor }} {{ unidadBase() }})</span> }
                      </span>
                    }
                  </div>
                }

                <!-- [TDA.2] Procedencia: se DECLARA en vez de esconderse (ADR-056). -->
                <p class="vf-nota">
                  Precio al público, IVA incluido.
                  @if (p.iva_pct != null) { IVA {{ p.iva_pct }}%. }
                  @if (p.ieps_pct) { IEPS {{ p.ieps_pct }}%. }
                  @if (origen() === 'respaldo') { Tomado del respaldo del {{ snapshotAl() | date:'dd/MM/yy HH:mm' }}. }
                  @if (origenPrecio() === 'override_manual') { Precio corregido a mano: es el mismo que sale en la etiqueta del anaquel. }
                  @if (codigoAmbiguo()) { <strong>Ese codigo esta en {{ candidatos().length }} productos distintos</strong> del catalogo: {{ candidatos()[0]?.nombre }} y {{ candidatos()[1]?.nombre }}. Lo de arriba es UNO de ellos, elegido por orden. Confirma cual tienes en la mano antes de cobrar. }
                  @if (precioAmbiguo()) { Este producto tiene {{ plazasDistintas() }} precios distintos entre plazas y no se pudo acotar a la tuya: confírmalo en caja. }
                  @if (plazaSinDato()) { Tu sucursal no tiene este producto cargado; el precio es de otra plaza. }
                </p>
              </div>
            }
          }
          @case ('no_encontrado') {
            <!-- Vacío real (el catálogo contestó "no está"), no un error de red — mismo copy
                 del verificador.html original, con tono más suave que "sin_datos" a propósito:
                 DESIGN pre-vuelo 6 exige que las dos se distingan, no sólo en texto. -->
            <div class="vf-err">
              DISCULPE LAS MOLESTIAS
              <small>PRODUCTO NO ENCONTRADO · Código: {{ ultimoCodigo() }}</small>
              <!-- [FLT.16] El momento exacto en que se pierde la venta, y hasta hoy se evaporaba:
                   el cliente preguntó, no lo tenemos, y nadie lo anota. Un toque lo manda a la
                   Lista de faltantes con el código ya puesto. Sólo aparece a quien puede
                   capturar; para el kiosco público sin cuenta, no se pinta. -->
              @if (puedeReportarFaltante()) {
                <p-button type="button" label="El cliente lo pidió" icon="pi pi-flag"
                          styleClass="p-button-sm"
                          (click)="reportarFaltante()"></p-button>
              }
            </div>
          }
          @case ('sin_datos') {
            <!-- Fallo de red SIN respaldo con qué contestar: el estado grave de verdad. -->
            <div class="vf-err is-bad">
              SIN CONEXIÓN AL SERVIDOR
              <small>Verifica la red. Código: {{ ultimoCodigo() }} — sin respaldo local descargado.</small>
              <p-button type="button" label="Descargar respaldo" icon="pi pi-download"
                        styleClass="p-button-sm" [disabled]="descargando() || !sucursal()"
                        (click)="descargarRespaldo()"></p-button>
            </div>
          }
        }
      </section>

      <footer class="vf-foot">
        <span class="vf-counter">
          Productos escaneados: <b>{{ contador() }}</b>
          <button type="button" class="vf-counter-reset" title="Reiniciar contador" (click)="reiniciarContador()">&#8635;</button>
        </span>
        <span class="vf-version">
          @if (snapshot(); as s) {
            Respaldo: {{ s.total }} productos ({{ s.descargadoAl | date:'dd/MM HH:mm' }})
          } @else {
            Sin respaldo local
          }
          <p-button type="button" label="Actualizar respaldo" icon="pi pi-download"
                    styleClass="p-button-sm p-button-text" [disabled]="descargando() || !sucursal()"
                    (click)="descargarRespaldo()"></p-button>
        </span>
      </footer>
    </div>
  `,
  styles: [`
    /* ═══════════════════════════════════════════════════════════════════════════════════
       [VAC.U11/U12] Esta pantalla ya no lleva piel propia: tipografia del estandar (Hanken
       Grotesk para texto, Geist Mono para cifras y codigos) y colores por tokens que siguen
       el tema claro/oscuro de la Suite. Se retiraron la paleta cruda, el fondo claro fijo, el
       patron de dulces y la franja decorativa (decision 0Sistemas, 2026-10-14). Las clases
       conservan su nombre: cambia el valor, no la estructura.
       ═══════════════════════════════════════════════════════════════════════════════════ */
    :host { display: block; font-family: var(--font-body); color: var(--text-main); }

    /* overflow-x: hidden (nunca hidden a secas): atrapaba de verdad la tarjeta cuando el
       mayoreo la hacia mas alta que la ventana. En un kiosco sin mouse esa parte quedaba
       invisible para siempre. El modo kiosco de abajo SI necesita su propio scroll porque
       position: fixed lo saca del flujo del documento. */
    .vf-page { position: relative; overflow-x: hidden;
      display: flex; flex-direction: column; align-items: center; gap: .5rem;
      padding: 0 1.25rem 1.25rem; min-height: 640px; }
    /* Modo kiosco: se come el chrome de la app. Necesita fondo propio: al salir del flujo ya
       no hereda el del layout. */
    .vf-page.is-kiosco { position: fixed; inset: 0; z-index: 60; overflow-y: auto;
      padding-bottom: 2rem; background: var(--surface-ground); }

    /* Franja de control funcional (sucursal, frescura, kiosco, ayuda): chica y arriba a la
       derecha para no competirle al logo ni al escaner. */
    .vf-ctrl { position: relative; z-index: 2; align-self: stretch; display: flex;
      align-items: center; justify-content: flex-end; gap: .5rem; flex-wrap: wrap;
      padding-top: .6rem; font-size: var(--fs-xs); color: var(--text-muted); }
    .vf-fresh-nd { display: inline-flex; align-items: center; gap: .25rem; cursor: help; }
    .vf-suc { font-weight: 700; color: var(--text-main); }
    .vf-icon-btn { min-width: 32px; min-height: 32px; display: inline-flex; align-items: center;
      justify-content: center; background: var(--card-bg); color: var(--text-muted);
      border: 1px solid var(--border-color); border-radius: var(--r-md); cursor: pointer; font: inherit; }
    .vf-icon-btn:hover { color: var(--action); border-color: var(--action); }
    .vf-icon-btn:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }

    .vf-banner { position: relative; z-index: 2; align-self: stretch; display: flex;
      align-items: flex-start; gap: .5rem; padding: .5rem .75rem; margin-top: .35rem;
      border-radius: var(--r-md); font-size: var(--fs-sm);
      border: 1px solid var(--info-border); background: var(--info-soft-bg); color: var(--info-soft-fg); }
    .vf-banner.is-ok { border-color: var(--ok-border); background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .vf-banner.is-warn { border-color: var(--warn-border); background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .vf-banner.is-bad { border-color: var(--bad-border); background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .vf-banner > div { display: flex; flex-direction: column; gap: .1rem; }
    .vf-banner span { opacity: .85; font-size: var(--fs-xs); }

    .vf-logo { position: relative; z-index: 1; display: block; margin: 18px auto 4px;
      max-height: 96px; max-width: 70vw; object-fit: contain; }
    .vf-logo-txt { position: relative; z-index: 1; margin: 22px 0 4px; font-size: var(--fs-h1);
      font-weight: 800; letter-spacing: 1px; text-align: center; line-height: 1; }
    .vf-logo-txt .vf-m { color: var(--action); } .vf-logo-txt .vf-d { color: var(--text-main); }
    /* En kiosco la altura es del precio: logo mas bajo y menos aire entre captura y resultado. */
    .vf-page.is-kiosco .vf-logo { max-height: 64px; margin: 8px auto 0; }
    .vf-page.is-kiosco .vf-result { margin-top: 8px; }
    /* Todo lo que mide 100% y lleva borde o relleno: el ancho incluye el marco, o se sale. */
    .vf-card, .vf-mayoreo, .vf-err, .vf-otras, .vf-cuerpo { box-sizing: border-box; }

    /* ── Captura: barra, input, hint ────────────────────────────────────────────────── */
    /* La camara del celular vive EN la barra: ya decia Escanea tu Producto con icono de
       camara, un segundo boton redondo al lado era el mismo gesto duplicado. */
    .vf-scanbar { position: relative; z-index: 1; background: var(--action); color: var(--action-ink);
      font: inherit; font-size: var(--fs-h3); font-weight: 600; letter-spacing: .5px; padding: 8px 24px;
      min-height: 44px; border: none; border-radius: var(--r-md); margin-top: 6px; display: flex;
      align-items: center; gap: .4rem; cursor: pointer; }
    .vf-scanbar:hover:not(:disabled) { background: var(--action-hover); }
    .vf-scanbar:disabled { opacity: .55; cursor: default; }
    .vf-scanbar:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .vf-input-row { position: relative; z-index: 1; margin-top: 10px;
      width: min(760px, 100%); display: flex; align-items: center; gap: .5rem; }
    .vf-input { flex: 1; min-width: 0; text-align: center; font-size: var(--fs-h1); font-weight: 500;
      font-family: var(--font-mono); font-variant-numeric: tabular-nums; padding: 14px;
      border-radius: var(--r-lg); border: 2px solid var(--border-color);
      background: var(--card-bg); color: var(--text-main); letter-spacing: 2px; outline: none; }
    .vf-input:focus-visible { border-color: var(--action); outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .vf-input::placeholder { color: var(--text-faint); font-family: var(--font-body);
      font-size: var(--fs-h3); letter-spacing: 1px; }
    .vf-input:disabled { color: var(--text-disabled); }
    .vf-busy { color: var(--action); font-size: 1.3rem; }
    .vf-hint { position: relative; z-index: 1; margin-top: 8px; color: var(--text-muted); font-size: var(--fs-sm); }

    /* El scrim de la camara es negro en los dos temas: es un velo sobre la pantalla, no una
       superficie de la app. */
    .vf-cam-ov { position: fixed; inset: 0; z-index: 1200; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: .75rem;
      background: rgba(0, 0, 0, .9); padding: 1rem; }
    .vf-cam-tip { margin: 0; color: #fff; font-size: var(--fs-sm); }
    .vf-cam-vid { width: min(100%, 520px); aspect-ratio: 4 / 3; object-fit: cover;
      background: rgb(0, 0, 0); border-radius: var(--r-lg); }
    .vf-cam-x { min-height: 48px; min-width: 160px; padding: 0 1.25rem; background: var(--card-bg);
      color: var(--text-main); border: 1px solid var(--border-color); border-radius: var(--r-md); font: inherit;
      font-weight: 700; cursor: pointer; }
    .vf-cam-x:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }

    /* ── Tarjeta de resultado ───────────────────────────────────────────────────────────
       Elevacion por borde de 1px, sin sombra (DESIGN datos densos: borde o sombra, nunca
       las dos). El respaldo se distingue por el borde, y ademas dice Precio de respaldo. */
    /* Ancho fluido: la tarjeta ocupa todo lo que da la pantalla (con tope) y el contenido se
       reacomoda por el ancho del CONTENEDOR, no de la ventana. Asi vale igual en un monitor de
       mostrador, en una ventana angosta junto al menu y en el celular. */
    .vf-result { position: relative; z-index: 1; flex: 1; display: flex; container: vf / inline-size;
      align-items: center; justify-content: center; width: 100%; margin-top: 18px; }
    .vf-card { width: 100%; max-width: 1600px; min-height: 260px; background: var(--card-bg); color: var(--text-main);
      border: 1px solid var(--border-color); border-radius: var(--r-xl);
      padding: clamp(1rem, 2.5vw, 2rem) clamp(1rem, 3vw, 2.5rem);
      text-align: center; display: flex; flex-direction: column; align-items: center; gap: .35rem;
      --vf-pop: vfPopA; animation: var(--vf-pop) .18s ease both; }
    .vf-card.is-pase-b { --vf-pop: vfPopB; }
    .vf-card.is-respaldo { border-color: var(--warn); }
    @keyframes vfPopA { from { transform: scale(.96); opacity: .4; } to { transform: scale(1); opacity: 1; } }
    @keyframes vfPopB { from { transform: scale(.96); opacity: .4; } to { transform: scale(1); opacity: 1; } }

    /* [TDA.8] Advertencia de precio cambiado. Nunca solo el color: icono mas texto. El parrafo
       NO se centra: es texto para leer, no una cifra. Ojo: un cierre de comentario escrito
       dentro de otro comentario CSS hace desaparecer la regla del bundle sin romper el build. */
    .vf-cambio { margin: 6px auto 0; width: fit-content; max-width: 60ch;
      display: flex; align-items: flex-start; gap: .5rem; text-align: left;
      padding: .4rem .75rem; border-radius: var(--r-md);
      background: var(--warn-soft-bg); border: 1px solid var(--warn-border); color: var(--warn-soft-fg);
      font-size: var(--fs-sm); text-wrap: pretty; }
    .vf-cambio > i { font-size: .95em; flex: none; margin-top: .15em; }
    .vf-cambio strong { font-weight: 700; }

    .vf-card-top { display: flex; align-items: center; justify-content: center; gap: .6rem; }
    .vf-cod { font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: var(--fs-body); color: var(--text-muted); letter-spacing: 1px; }
    .vf-tag { display: inline-flex; align-items: center; gap: .3rem; font-size: var(--fs-xs);
      font-weight: 700; padding: .2rem .55rem; border-radius: var(--r-pill); text-transform: uppercase;
      letter-spacing: .04em; }
    .vf-tag.is-ok { background: var(--ok-soft-bg); color: var(--ok-soft-fg); border: 1px solid var(--ok-border); }
    .vf-tag.is-warn { background: var(--warn-soft-bg); color: var(--warn-soft-fg); border: 1px solid var(--warn-border); }

    .vf-nombre { font-size: var(--fs-h1); font-weight: 600; color: var(--text-main); margin: 4px 0 12px;
      line-height: 1.15; text-wrap: balance; overflow-wrap: anywhere; min-width: 0; }
    .vf-gramaje { font-size: var(--fs-body); font-weight: 500; color: var(--text-muted); margin-left: .5rem; }
    /* La unidad es parte del precio: un precio sin unidad no es un precio. A 1-2 m (la distancia
       real de un kiosco) el rótulo chico y atenuado no se leía, así que sube de tamaño y de
       contraste (--text-main, no --text-muted). */
    .vf-unidad-lbl { font-size: var(--fs-h1); color: var(--text-main); font-weight: 800;
      text-transform: uppercase; letter-spacing: .06em; line-height: 1.1; }
    /* La cifra: tamano de lectura a distancia, con clamp para no reventar en el kiosco chico
       (maximo 2.5 veces el minimo). Geist Mono con tabular-nums: es el dato, no el titulo. El
       color es el del texto: la jerarquia la da el tamano y el contraste, no un verde. */
    .vf-precio { font-family: var(--font-mono);
      font-size: clamp(3.2rem, 10vw, 7.5rem); font-weight: 700; color: var(--text-main);
      line-height: 1; margin: 2px 0; letter-spacing: -1px; font-variant-numeric: tabular-nums; }
    /* El signo y los centavos van chicos y pegados arriba (como en la etiqueta del anaquel):
       el cliente lee la parte en pesos y los centavos no parecen otro numero. El punto viaja
       con los centavos y encogido hacia los digitos: en monoespaciada ocupa una celda entera. */
    .vf-peso, .vf-cent { font-size: var(--vf-escala-cent); vertical-align: top; line-height: 1.15; }
    .vf-peso { margin-right: .08em; }
    /* Escala del signo y los centavos respecto de la cifra: en la grande .45em; en el mayoreo y
       las otras unidades la cifra base es chica y .45em quedaria en ~9px, asi que ahi .6em. */
    .vf-precio { --vf-escala-cent: .45em; }
    .vf-may-monto, .vf-u-precio { --vf-escala-cent: .6em; }
    .vf-cent { margin-left: .02em; }
    .vf-punto { margin-right: -.22em; }

    .vf-u-aclara { margin: 2px 0 0; font-size: var(--fs-sm); color: var(--text-muted); max-width: 46ch; }
    .vf-u-aclara strong { color: var(--text-main); font-weight: 700; }

    /* Cuerpo: precio y mayoreo. En angosto se apilan; con ancho (contenedor de 56rem o mas) van
       lado a lado y el mayoreo comparte el protagonismo con el precio. */
    .vf-cuerpo { width: 100%; display: flex; flex-direction: column; align-items: center; gap: .75rem; }
    .vf-col-precio { display: flex; flex-direction: column; align-items: center; gap: .35rem; min-width: 0; }
    @container vf (min-width: 56rem) {
      .vf-cuerpo.con-mayoreo { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr);
        align-items: center; gap: clamp(1.5rem, 3vw, 3rem); }
      .vf-cuerpo.con-mayoreo .vf-mayoreo { margin-top: 0; }
    }

    /* Mayoreo (TDA.4/7): es EL argumento de venta (el 94 % del catalogo lo tiene), asi que va
       enmarcado y con el color de accion: la persona que lleva una pieza tiene que ver, sin
       buscarlo, cuanto ahorra llevando mas. La condicion es lo primero que se lee, el precio lo
       segundo y el ahorro en pastilla. */
    .vf-mayoreo { margin-top: 14px; padding: clamp(.75rem, 2vw, 1.5rem); border-radius: var(--r-xl);
      border: 2px solid var(--action);
      background: color-mix(in srgb, var(--action) 7%, var(--card-bg));
      display: flex; flex-direction: column; align-items: center; gap: .6rem; width: 100%; }
    .vf-may-titulo { display: inline-flex; align-items: center; gap: .45rem; padding: .3rem .9rem;
      border-radius: var(--r-pill); background: var(--action); color: var(--action-ink);
      font-size: var(--fs-body); font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    .vf-may-row { display: flex; flex-direction: column; align-items: center; gap: .1rem; }
    .vf-may-cond { font-size: var(--fs-lg); font-weight: 700; text-transform: uppercase;
      letter-spacing: .04em; color: var(--text-main); }
    .vf-may-n { color: var(--text-main); font-weight: 800; font-size: var(--fs-h1); }
    .vf-may-precio { display: flex; align-items: baseline; justify-content: center; gap: .3rem; }
    .vf-may-monto { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-weight: 700;
      font-size: clamp(2.4rem, 6vw, 4.5rem); color: var(--text-main); }
    .vf-may-cu { font-size: var(--fs-lg); font-weight: 700; color: var(--text-main); }
    /* Un umbral por bloque: el segundo escalón es otro bloque (otra condición de compra) y se
       separa con una línea, no se mezcla con el primero. */
    .vf-may-row + .vf-may-row, .vf-may-ahorro ~ .vf-may-row {
      width: 100%; border-top: 1px solid var(--border-color); padding-top: .6rem; margin-top: .2rem; }
    .vf-may-eq { font-size: var(--fs-body); font-weight: 600; color: var(--text-muted); }
    .vf-may-row:not(.is-realza) .vf-may-monto, .vf-may-row:not(.is-foco) .vf-may-monto {
      font-weight: 600; color: var(--text-muted); font-size: clamp(1.4rem, 3vw, 2.2rem); }
    .vf-may-row:not(.is-foco) .vf-may-cond { opacity: .75; font-size: var(--fs-body); }
    .vf-may-ahorro { margin: 0; display: inline-flex; flex-direction: column; align-items: center; gap: .15rem;
      padding: .45rem 1.25rem; border-radius: var(--r-xl); background: var(--ok-soft-bg); border: 1px solid var(--ok-border);
      font-size: var(--fs-lg); font-weight: 600; color: var(--ok-soft-fg); text-align: center; }
    .vf-may-ahorro-main { display: inline-flex; flex-wrap: wrap; justify-content: center; align-items: baseline; gap: .45rem; }
    .vf-may-total { font-size: var(--fs-body); font-weight: 500; opacity: .85; }
    .vf-may-ahorro strong { font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-weight: 700; font-size: var(--fs-h2); color: var(--ok-soft-fg); }
    .vf-may-pct { opacity: .8; font-size: var(--fs-body); }

    /* Otras unidades: pildoras con el precio en Geist Mono. */
    .vf-otras { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px 12px;
      margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border-color); width: 100%; }
    .vf-u-item { font-size: var(--fs-lg); color: var(--text-main); background: var(--surface-ground);
      border: 1px solid var(--border-color); border-radius: var(--r-md);
      padding: 6px 14px; display: flex; align-items: baseline; gap: 5px; }
    .vf-u-item b { color: var(--text-muted); text-transform: uppercase; font-size: var(--fs-sm);
      font-weight: 600; letter-spacing: .5px; }
    .vf-u-precio { font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: var(--fs-h2); font-weight: 600; color: var(--text-main); }
    .vf-u-f { font-size: var(--fs-micro); color: var(--text-muted); }

    .vf-nota { margin: 10px auto 0; font-size: var(--fs-xs); color: var(--text-muted); max-width: 60ch; }

    /* Error / no-encontrado: la severidad se distingue (no existe = aviso; sin conexion =
       grave) por borde, texto y copia, no solo por color. */
    .vf-err { width: 100%; max-width: 1100px; min-height: 200px; background: var(--card-bg);
      border: 1px solid var(--warn-border); border-radius: var(--r-xl); padding: 40px 24px; text-align: center;
      font-size: var(--fs-h1); font-weight: 800; color: var(--warn-soft-fg);
      display: flex; flex-direction: column; align-items: center; gap: 10px;
      animation: vfPopA .18s ease both; }
    .vf-err.is-bad { border-color: var(--bad-border); color: var(--bad-soft-fg); }
    .vf-err small { font-size: var(--fs-h3); color: var(--text-muted); font-weight: 500; }

    .vf-foot { position: relative; z-index: 1; align-self: stretch; margin-top: 12px;
      padding-top: 10px; border-top: 1px solid var(--border-color); display: flex;
      flex-direction: column; gap: 4px; font-size: var(--fs-xs); color: var(--text-muted); }
    .vf-counter b { color: var(--text-main); font-weight: 700; font-family: var(--font-mono);
      font-variant-numeric: tabular-nums; }
    .vf-counter-reset { background: none; border: none; cursor: pointer; opacity: .55;
      padding: 0 4px; font: inherit; color: inherit; }
    .vf-counter-reset:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    /* Cifra dentro de una frase: proporcional, para que el punto no abra un hueco. */
    .vf-num { font-variant-numeric: tabular-nums; font-weight: 700; }
    .vf-version { display: inline-flex; align-items: center; gap: .4rem; color: var(--text-muted); }

    /* Esqueleto de la tarjeta: mismas medidas (ancho, mínimo de alto, padding) y sin animación
       de brillo (el techo de movimiento es 350 ms y un shimmer en bucle no cabe). */
    .vf-skel { width: 100%; max-width: 1600px; min-height: 260px; box-sizing: border-box;
      background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-xl);
      padding: clamp(1rem, 2.5vw, 2rem) clamp(1rem, 3vw, 2.5rem);
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1rem;
      opacity: 0; animation: vf-skel-in .15s ease-out .2s both; }
    .vf-skel-bar { display: block; border-radius: var(--r-md); background: var(--overlay-hover); }
    .vf-skel-bar.is-nombre { width: min(22rem, 70%); height: 2rem; }
    .vf-skel-bar.is-precio { width: min(16rem, 55%); height: 5rem; }
    .vf-skel-bar.is-nota { width: min(14rem, 45%); height: 1rem; }
    @keyframes vf-skel-in { to { opacity: 1; } }

    /* Pantalla táctil: los controles chicos del operador llegan a 44 px (el dedo no es un puntero). */
    @media (pointer: coarse) {
      .vf-icon-btn { min-width: 44px; min-height: 44px; }
      .vf-counter-reset { min-width: 44px; min-height: 44px; }
    }

    /* Alto Contraste de Windows: nada puede depender sólo del color de fondo. Lo que se distingue
       por relleno (pastilla del mayoreo, botón de cámara, rótulos) gana un borde de sistema. */
    @media (forced-colors: active) {
      .vf-scanbar, .vf-may-titulo, .vf-may-ahorro { border: 1px solid ButtonText; }
      .vf-mayoreo { border: 2px solid Highlight; }
      .vf-skel-bar { border: 1px solid GrayText; }
    }

    @media (prefers-reduced-motion: reduce) {
      .vf-card, .vf-err { animation: none; }
      .vf-skel { animation: none; opacity: 1; }
    }
  `],
})
export class TiendaVerificadorComponent implements OnInit, OnDestroy {
  private readonly svc = inject(VerificadorService);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  // `[FLT.16]` Para mandar el código no encontrado a la Lista de faltantes.
  private readonly router = inject(Router);
  private readonly permisos = inject(PermissionsService);
  private readonly socket = inject(StoreSocketService);
  private readonly destroyRef = inject(DestroyRef);

  @ViewChild('scan') private scanInput?: ElementRef<HTMLInputElement>;
  @ViewChild('video') private videoEl?: ElementRef<HTMLVideoElement>;
  @ViewChild('camCancelar') private camCancelarBtn?: ElementRef<HTMLButtonElement>;
  @ViewChild('card') private cardEl?: ElementRef<HTMLDivElement>;
  private lector?: BrowserMultiFormatReader;
  private controles?: IScannerControls;

  /** Clave de preferencia del kiosco: la máquina del mostrador queda en kiosco tras recargar. */
  private static readonly LS_KIOSCO = 'tienda.verificador.kiosco';
  /** Contador de productos escaneados, persistente por equipo — igual que `mdVerifCount` del
   * HTML original, con clave propia (ese localStorage era de otro origen, inalcanzable acá). */
  private static readonly LS_CONTADOR = 'tienda.verificador.contador';
  /** A los 20s de inactividad la tarjeta se limpia sola, como `armarClear()` en el HTML
   * original: un precio (o un error) no debe quedar pegado en pantalla toda la tarde.
   * Subido de 15 a 20 (pedido 0Sistemas): con mayoreo en pantalla, 15s no alcanzaban a
   * leer la condición + el ahorro antes de que se borrara solo. */
  private static readonly MS_AUTOLIMPIA = 20_000;
  private clearTimer?: ReturnType<typeof setTimeout>;

  readonly sucursal = signal<string | null>(null);
  readonly sucursales = signal<SucursalVerificador[]>([]);
  readonly kiosco = signal(false);
  readonly buscando = signal(false);
  /** `[VAC.U4]` El logo no cargó: se muestra el nombre en texto (antes lo hacía un onerror inline). */
  readonly logoFalla = signal(false);
  private readonly confirmacion = inject(ConfirmationService);
  readonly descargando = signal(false);
  readonly banner = signal<Banner>(null);
  /** Overlay de la cámara del celular como lector (tercera vía además de pistola HID y teclado). */
  readonly camaraAbierta = signal(false);

  readonly estado = signal<'idle' | 'encontrado' | 'no_encontrado' | 'sin_datos'>('idle');

  /**
   * `[VAC.U6]` Lo que la sección de resultado pinta. Mientras se consulta y NO hay una tarjeta
   * vigente se muestra el esqueleto; si ya hay un producto en pantalla se conserva (no se
   * parpadea entre escaneos seguidos). El estado de negocio sigue siendo `estado()`.
   */
  readonly vista = computed(() => (this.buscando() && this.estado() !== 'encontrado' ? 'buscando' : this.estado()));
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
  /** `[TDA.9]` El código matchea más de un producto: la pantalla PREGUNTA, no elige. */
  readonly codigoAmbiguo = signal(false);
  readonly candidatos = signal<{ codigo: string; nombre: string; precio_con_iva: number | null }[]>([]);
  readonly plazasDistintas = signal(1);
  readonly plazaSinDato = signal(false);
  readonly ultimoCodigo = signal('');
  /**
   * `[TDA.6]` Cuántas consultas se contestaron. Existe SÓLO para reiniciar la animación de
   * entrada: la tarjeta es el mismo nodo entre escaneos, así que sin esto la entrada corría
   * una vez por turno. Ver `is-pase-b` en la plantilla.
   */
  readonly pase = signal(0);
  /** Productos escaneados en este equipo, de por vida. */
  readonly contador = signal(0);

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
      this.contador.set(parseInt(localStorage.getItem(TiendaVerificadorComponent.LS_CONTADOR) || '0', 10) || 0);
    } catch { /* localStorage bloqueado: el contador arranca en 0, no es crítico */ }

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

    // Una consulta nueva cancela el auto-limpiado de la anterior: si no, un escaneo lento
    // (red) podía tropezar con el timeout de la tarjeta previa a mitad de la espera.
    if (this.clearTimer) clearTimeout(this.clearTimer);
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
    // Como `armarClear()` del HTML original: 20s de inactividad y la pantalla vuelve sola a
    // "listo para consultar" — un precio (o un error) no debe quedar pegado toda la tarde.
    this.armarClear();
    if (r.estado === 'encontrado') {
      this.estado.set('encontrado');
      this.producto.set(r.producto);
      this.origen.set(r.origen);
      this.snapshotAl.set(r.snapshotAl);
      // `[TDA.2]` Procedencia del número. Se resetea en CADA resultado: si quedara pegada del
      // producto anterior, la pantalla diría "corregido a mano" sobre uno que no lo está.
      this.origenPrecio.set(r.origenPrecio ?? 'kepler');
      this.precioAmbiguo.set(r.precioAmbiguo === true);
      this.codigoAmbiguo.set(r.codigoAmbiguo === true);
      this.candidatos.set(Array.isArray(r.candidatos) ? r.candidatos : []);
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
      this.bumpContador();
      this.desplazarResultadoAlaVista();
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
  }

  private limpiarResultado(): void {
    this.estado.set('idle');
    this.producto.set(null);
    this.ultimoCodigo.set('');
  }

  /** `armarClear()` del HTML original: reinicia el reloj de 20s cada vez que hay un resultado nuevo. */
  private armarClear(): void {
    if (this.clearTimer) clearTimeout(this.clearTimer);
    this.clearTimer = setTimeout(() => this.limpiarResultado(), TiendaVerificadorComponent.MS_AUTOLIMPIA);
  }

  /**
   * El mayoreo quedaba fuera de la vista, sin forma de llegar a él.
   *
   * En un kiosco real el único periférico es la pistola: no hay mouse ni dedo para hacer
   * scroll. Medido en vivo (terminal 40/Oficina, ventana chica): con `LA ROSA MAZAPAN /30` el
   * bloque "LLEVANDO 3 O MÁS PAQUETES" quedaba cortado exacto en el borde inferior — no
   * "apretado", **invisible**, porque `.vf-page` además tenía `overflow: hidden` (ver el
   * comentario en esa regla). Con el overflow ya destrabado, esto hace la otra mitad: bajar
   * la ventana sola hasta que el PIE de la tarjeta (mayoreo/ahorro/nota, lo último que se
   * agrega y lo que más espacio pide) quede a la vista, en vez de esperar un scroll que en
   * ese equipo nadie puede dar.
   */
  private desplazarResultadoAlaVista(): void {
    setTimeout(() => {
      const el = this.cardEl?.nativeElement;
      if (!el) return;
      const reducido = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView({ block: 'end', inline: 'nearest', behavior: reducido ? 'auto' : 'smooth' });
    }, 0);
  }

  private bumpContador(): void {
    const n = this.contador() + 1;
    this.contador.set(n);
    try { localStorage.setItem(TiendaVerificadorComponent.LS_CONTADOR, String(n)); } catch { /* no crítico */ }
  }

  reiniciarContador(): void {
    this.confirmacion.confirm({
      header: 'Reiniciar el contador',
      message: '¿Reiniciar el contador de productos escaneados a cero?',
      acceptLabel: 'Reiniciar',
      rejectLabel: 'Cancelar',
      accept: () => {
        this.contador.set(0);
        try { localStorage.setItem(TiendaVerificadorComponent.LS_CONTADOR, '0'); } catch { /* no crítico */ }
      },
    });
  }

  /**
   * `[FLT.16]` ¿Mostrar el botón de reportar faltante?
   *
   * Sólo a quien puede capturar. El verificador también corre como kiosco PÚBLICO sin cuenta
   * (sus endpoints son `@Public()`), y ahí no hay a quién ofrecerle una escritura: el botón
   * llevaría a una pantalla que le va a contestar 403. Ofrecer una puerta que no abre es el
   * defecto que `landing-guards.spec.ts` encontró tres veces en esta app.
   */
  puedeReportarFaltante(): boolean {
    return this.permisos.has(Permission.STORE_STOCKOUT_CAPTURAR);
  }

  /**
   * Manda el código que NO se encontró a la Lista de faltantes, ya escrito.
   *
   * Es el momento exacto en que se pierde la venta —el cliente preguntó, no lo tenemos— y hasta
   * hoy se evaporaba sin dejar rastro. Ninguna otra fuente lo puede ver: una venta que no ocurrió
   * no genera ticket ni movimiento en el ERP.
   */
  reportarFaltante(): void {
    this.router.navigate(['/tienda/faltantes'], {
      queryParams: { sucursal: this.sucursal() || undefined, codigo: this.ultimoCodigo() || undefined },
    });
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

  /**
   * Escape sale del kiosco (en pantalla completa no hay chrome del navegador que ayude).
   * Si la cámara está abierta tiene prioridad: un Escape cierra la cámara, no el kiosco.
   */
  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.camaraAbierta()) { this.cerrarCamara(); return; }
    if (this.kiosco()) this.toggleKiosco();
  }

  /**
   * Cámara del celular como lector — tercera vía junto a la pistola HID y el teclado, para
   * quien recorre el mostrador sin pistola a la mano. Es la misma que ya usaban el Andén
   * (`ScanFieldComponent`) y el escaneo comercial (`ProductScanFieldComponent`): mismo
   * cableado `@zxing/browser`, formatos de retail, vibración al leer. Si aparece un cuarto
   * consumidor, ahí sí conviene extraer una primitiva compartida — con tres, y cada uno con
   * su propio botón/estilo, la duplicación pesa menos que una abstracción prematura.
   */
  async abrirCamara(): Promise<void> {
    if (!this.sucursal() || this.camaraAbierta()) return;
    // `getUserMedia` no existe fuera de contexto seguro: en http de LAN el botón tiene que
    // decir POR QUÉ no abre, no quedarse mudo.
    if (!navigator.mediaDevices?.getUserMedia) {
      this.banner.set({
        texto: 'Este equipo no da acceso a la cámara.',
        detalle: 'Requiere HTTPS. Usa la pistola o teclea el código.',
        tono: 'warn',
      });
      return;
    }
    this.camaraAbierta.set(true);
    // `[MU1EABF2-1]` ver el comentario de `onCameraGlobalError`: la falla llega tarde, como
    // promesa sin capturar, y ningún try/catch de acá abajo la alcanza a ver.
    window.addEventListener('unhandledrejection', this.onCameraGlobalError);
    window.addEventListener('error', this.onCameraGlobalError);
    setTimeout(() => this.camCancelarBtn?.nativeElement?.focus(), 150);
    setTimeout(async () => {
      const v = this.videoEl?.nativeElement;
      if (!v) return;
      const hints = new Map();
      // Solo formatos de retail: menos trabajo por intento, engancha antes.
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [
        BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
        BarcodeFormat.CODE_128, BarcodeFormat.ITF,
      ]);
      this.lector = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 100 });
      try {
        this.controles = await this.lector.decodeFromConstraints(
          { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } },
          v,
          (r) => { if (r) this.leido(r.getText()); },
        );
      } catch {
        this.cerrarCamara();
        this.banner.set({
          texto: 'No se pudo abrir la cámara.',
          detalle: 'Revisa los permisos del navegador (requiere HTTPS).',
          tono: 'warn',
        });
      }
    }, 80);
  }

  private leido(raw: string): void {
    // El zumbido confirma sin mirar la pantalla: en el mostrador se lee de reojo.
    if (navigator.vibrate) navigator.vibrate(80);
    const codigo = raw.trim();
    this.cerrarCamara();
    if (this.scanInput?.nativeElement) this.scanInput.nativeElement.value = '';
    this.consultar(codigo);
  }

  cerrarCamara(): void {
    this.camaraAbierta.set(false);
    window.removeEventListener('unhandledrejection', this.onCameraGlobalError);
    window.removeEventListener('error', this.onCameraGlobalError);
    try { this.controles?.stop(); } catch { /* la cámara ya estaba cerrada */ }
    this.controles = undefined;
    this.lector = undefined;
    this.enfocar();
  }

  /**
   * `setPhotoOptions failed` — bug real de cámara en Android (varios fabricantes), reportado
   * por el monitor de errores en vivo (código `MU1EABF2-1`, `/tienda/verificador`,
   * 2026-09-14T15:25:42Z). zxing pregunta `track.getCapabilities()` para saber si la cámara
   * tiene torch; en esos equipos el navegador falla esa negociación DESPUÉS de que
   * `decodeFromConstraints` ya resolvió — llega como promesa/evento sin capturar, y el
   * try/catch de `abrirCamara()` (que sólo cubre la apertura) no la ve.
   *
   * Sin este listener: la cámara queda abierta y congelada, sin ningún aviso — la persona
   * sigue apuntando a un código que ya no se está leyendo. Con él: se cierra y se declara,
   * como cualquier otra falla de cámara de esta pantalla (ADR-056).
   *
   * Sólo escucha mientras la cámara está abierta (se engancha en `abrirCamara`, se
   * desengancha en `cerrarCamara`) — un listener global permanente en `window` se comería
   * errores de OTRAS partes de la app que no tienen nada que ver con esto.
   */
  private readonly onCameraGlobalError = (ev: PromiseRejectionEvent | ErrorEvent): void => {
    const msg = String(
      (ev as PromiseRejectionEvent).reason?.message ?? (ev as ErrorEvent).message ?? '',
    );
    if (!/setPhotoOptions|getCapabilities|ImageCapture/i.test(msg)) return;
    ev.preventDefault?.();
    this.cerrarCamara();
    this.banner.set({
      texto: 'La cámara se interrumpió.',
      detalle: 'Es una falla conocida de algunos celulares Android al abrir la cámara. Usa la pistola o teclea el código.',
      tono: 'warn',
    });
  };

  ngOnDestroy(): void {
    this.cerrarCamara();
    if (this.clearTimer) clearTimeout(this.clearTimer);
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

  /**
   * El precio hero en dos partes: el entero va GRANDE y los centavos chicos y arriba, como en la
   * etiqueta del anaquel (decisión 0Sistemas, 2026-10-14).
   *
   * Con la cifra entera en monoespaciada el punto ocupaba una celda completa y "85.49" se leía
   * como "85 . 49", o sea dos números. Con los centavos chicos queda clara la parte que se cobra
   * en pesos y la que son centavos. El texto completo sigue siendo "$85.49" (un lector de pantalla
   * y los specs lo leen igual); sólo cambia cómo se dibuja.
   *
   * Se parte sobre el total en CENTAVOS enteros y no sobre `toFixed`: así 85.995 -> 86.00 acarrea
   * bien al entero en vez de quedar "85" y "100".
   */
  readonly precioPartes = computed(() => partesPrecio(this.precioPrincipal()));

  /** Para el template: mayoreo y otras unidades parten su precio igual que el principal. */
  partes(v: number | null | undefined): { entero: string; centavos: string } {
    return partesPrecio(v);
  }

  /** Mismo mapeo de `unidadLabel()` del HTML original. */
  unidadLabel(u: string): string {
    const s = String(u || '').toUpperCase();
    if (s === 'PZA') return 'Pieza';
    if (s === 'PAQ') return 'Paquete';
    if (s === 'CJA') return 'Caja';
    if (s === 'KG') return 'Kilo';
    return s || '';
  }

  private httpMsg(e: any): string {
    const s = e?.status;
    if (s === 0 || s == null) return 'Sin respuesta del servidor.';
    if (s === 403) return 'Sin permiso (403).';
    if (s === 404) return 'Ruta no encontrada (404) — puede faltar reiniciar la API.';
    return `Error ${s}${e?.error?.message ? ': ' + e.error.message : ''}.`;
  }
}
