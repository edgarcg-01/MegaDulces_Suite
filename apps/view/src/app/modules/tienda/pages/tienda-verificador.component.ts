import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, HostListener, OnDestroy, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { BrowserMultiFormatReader, IScannerControls } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';
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
 * la jerarquía, feed al tope sin paginación.
 *
 * ── Excepción confirmada a DESIGN.md §O.3 (decisión 0Sistemas, 2026-09-12) ──────────────
 * Esta pantalla NO usa los tokens de Operations (Hanken Grotesk/Geist Mono, zinc, sunset).
 * Es un clon fiel del look del `verificador.html` que corría como kiosco autocontenido antes
 * de la Fase CV: tipografía Sniglet, paleta cruda (`--vf-*` abajo, con las MISMAS cifras hex
 * del HTML original), fondo cálido con patrón de dulces, precio gigante en verde. Es la única
 * pantalla del repo con esta excepción — no repetir el patrón en otro módulo sin la misma
 * autorización explícita. El tema fijo (siempre claro) es a propósito: un kiosco físico de
 * mostrador no cambia de tema con el modo oscuro del navegador de quien lo dejó configurado.
 * Lo que SÍ sigue intacto (no es "look", es correctud): procedencia del precio (TDA.2),
 * unidad escaneada (TDA.3), mayoreo con foco (TDA.4/7), declarar en vez de ocultar (ADR-056),
 * "no encontrado" != "sin conexión" (DESIGN pre-vuelo 6) — todo esto se conserva, solo cambia
 * la piel.
 */
@Component({
  selector: 'app-tienda-verificador',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, SelectModule, ContextHelpComponent, FreshnessPillComponent, CountUpDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="vf-page" [class.is-kiosco]="kiosco()">
      <!-- Patrón de dulces del verificador.html original, calcado 1:1 (mismas formas/coords). -->
      <svg class="vf-bg" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <defs>
          <pattern id="vfDulces" width="240" height="240" patternUnits="userSpaceOnUse" patternTransform="rotate(8)">
            <g fill="none" stroke-width="3">
              <circle cx="46" cy="46" r="22" stroke="#E8680A"/>
              <path d="M46 46 m-13 0 a13 13 0 1 1 13 13" stroke="#F5C500"/>
              <line x1="46" y1="68" x2="46" y2="104" stroke="#E8680A"/>
            </g>
            <g fill="none" stroke="#ec4899" stroke-width="3" transform="translate(160,64) rotate(18)">
              <ellipse cx="0" cy="0" rx="20" ry="13"/>
              <path d="M-20 0 L-38 -11 L-38 11 Z"/>
              <path d="M20 0 L38 -11 L38 11 Z"/>
            </g>
            <path d="M52 150 Q52 118 70 118 Q88 118 88 150 Z" fill="none" stroke="#0ea5e9" stroke-width="3"/>
            <g fill="none" stroke="#16a34a" stroke-width="3" transform="translate(178,168)">
              <circle cx="0" cy="0" r="14"/>
              <path d="M-14 0 L14 0 M0 -14 L0 14"/>
            </g>
            <g fill="none" stroke="#F5C500" stroke-width="3" transform="translate(120,205) rotate(-12)">
              <ellipse cx="0" cy="0" rx="12" ry="8"/>
              <path d="M-12 0 L-24 -7 L-24 7 Z"/>
              <path d="M12 0 L24 -7 L24 7 Z"/>
            </g>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#vfDulces)"/>
      </svg>
      <div class="vf-top"></div>

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
                    placeholder="Sucursal" styleClass="vf-sel" appendTo="body"
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

      <img class="vf-logo" src="assets/logos/mega-dulces-logo.webp" alt="Mega Dulces"
           onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">
      <div class="vf-logo-txt" style="display:none"><span class="vf-m">Mega</span><span class="vf-d">Dulces</span></div>

      <div class="vf-scanbar"><i class="pi pi-camera" aria-hidden="true"></i> Escanea tu Producto</div>

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
        <!-- Cámara del celular como lector: para quien llega sin pistola HID. -->
        <button type="button" class="vf-cam-btn" aria-label="Escanear con la cámara del celular"
                [disabled]="!sucursal()" (click)="abrirCamara()">
          <i class="pi pi-camera" aria-hidden="true"></i>
        </button>
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
        @switch (estado()) {
          @case ('encontrado') {
            @if (producto(); as p) {
              <!-- [TDA.6] is-pase-b alterna en cada consulta para reiniciar la animación
                   "pop" sobre el MISMO nodo del DOM (ver comentario histórico más abajo). -->
              <div class="vf-card" [class.is-respaldo]="origen() === 'respaldo'"
                   [class.is-pase-b]="pase() % 2 === 1">
                <div class="vf-card-top">
                  <span class="vf-cod">{{ p.codigo }}</span>
                  @if (origen() === 'respaldo') {
                    <span class="vf-tag is-warn"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> Precio de respaldo</span>
                  } @else {
                    <span class="vf-tag is-ok"><i class="pi pi-bolt" aria-hidden="true"></i> Precio en línea</span>
                  }
                </div>
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
                @if (precioCambio()) {
                  <p class="vf-cambio" role="status">
                    <i class="pi pi-refresh" aria-hidden="true"></i>
                    <span>
                      Este precio <strong>acaba de cambiar</strong> en el ERP.
                      @if (precioAnterior() != null) {
                        Antes decía <span class="vf-mono">{{ money(precioAnterior()) }}</span>.
                      }
                      Confirma en caja antes de cobrar.
                    </span>
                  </p>
                }

                <div class="vf-unidad-lbl">POR {{ unidadLabel(unidadPrincipal()) | uppercase }}</div>
                <div class="vf-precio"><span class="vf-peso">$</span>{{ moneySinSigno(precioPrincipal()) }}</div>

                <!-- [TDA.3] Sólo cuando hay más de una unidad con precio: medido, el 93.6% de
                     los SKUs tiene una sola, así que un aviso incondicional se aprendería a
                     ignorar en 9 de cada 10 escaneos. -->
                @if (vaAclararUnidad()) {
                  <p class="vf-u-aclara">El código que escaneaste es de <strong>{{ unidadLabel(unidadEscaneada() || '') }}</strong>: este es su precio.</p>
                }

                <!-- [TDA.4/7] El mayoreo, con foco en la unidad ESCANEADA (backend ya
                     descartó los tiers sin condición conocida — la pantalla pinta, no decide). -->
                @if (mayoreo().length) {
                  <div class="vf-mayoreo">
                    @for (x of mayoreoConFoco(); track x.t.etiqueta) {
                      @let t = x.t;
                      <div class="vf-may-row" [class.is-realza]="t.realza" [class.is-foco]="x.destacado">
                        <div class="vf-may-cond">Llevando <strong class="vf-may-n">{{ t.desde }}</strong> o más {{ t.palabra }}</div>
                        <div class="vf-may-precio">
                          <span class="vf-may-monto">{{ money(t.precio_con_iva) }}</span>
                          <span class="vf-may-cu">{{ t.unidad_monto }}</span>
                        </div>
                      </div>
                      @if (t.realza && x.destacado) {
                        <p class="vf-may-ahorro">
                          Te ahorras
                          <strong [appCountUp]="t.ahorro_en_el_minimo" [appCountUpLive]="true" countUpFormat="money2"></strong>
                          <span class="vf-may-pct">({{ t.descuento_pct }}% menos c/u)</span>
                        </p>
                      }
                    }
                  </div>
                }

                <!-- [TDA.3] Las OTRAS unidades, como píldoras (mismo tratamiento visual que
                     .u-item del HTML original). El factor se refiere a la unidad BASE. -->
                @if (otrasUnidades().length) {
                  <div class="vf-otras">
                    @for (u of otrasUnidades(); track u.u) {
                      <span class="vf-u-item">
                        <b>{{ unidadLabel(u.u) }}</b>
                        <span class="vf-u-precio">{{ money(u.precio_con_iva) }}</span>
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
            </div>
          }
          @case ('sin_datos') {
            <!-- Fallo de red SIN respaldo con qué contestar: el estado grave de verdad. -->
            <div class="vf-err is-bad">
              SIN CONEXIÓN AL SERVIDOR
              <small>Verifica la red. Código: {{ ultimoCodigo() }} — sin respaldo local descargado.</small>
              <p-button type="button" label="Descargar respaldo" icon="pi pi-download"
                        styleClass="p-button-sm vf-btn-respaldo" [disabled]="descargando() || !sucursal()"
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
        <div class="vf-feed">
          @for (c of feed(); track c.hora.getTime() + c.codigo) {
            <span class="vf-feed-item">
              <span class="vf-mono">{{ c.codigo }}</span> {{ c.nombre || 'no encontrado' }}
              <span class="vf-mono">{{ c.precio != null ? money(c.precio) : '—' }}</span>
              @if (c.origen === 'respaldo') { <i class="pi pi-exclamation-triangle" title="Precio de respaldo"></i> }
            </span>
          }
        </div>
        <span class="vf-version">
          v1.0
          @if (snapshot(); as s) {
            · Respaldo: {{ s.total }} productos ({{ s.descargadoAl | date:'dd/MM HH:mm' }})
          } @else {
            · Sin respaldo local
          }
          <p-button type="button" label="Actualizar respaldo" icon="pi pi-download"
                    styleClass="p-button-sm p-button-text vf-btn-respaldo" [disabled]="descargando() || !sucursal()"
                    (click)="descargarRespaldo()"></p-button>
        </span>
      </footer>
    </div>
  `,
  styles: [`
    /* ═══════════════════════════════════════════════════════════════════════════════════
       CLON FIEL de verificador.html (kiosco retirado en Fase CV) — ver el comentario de
       "Excepción confirmada" arriba de la clase. Paleta CRUDA a propósito (son las mismas
       cifras hex del HTML original, no tokens): --vf-amarillo/--vf-naranja/--vf-oscuro/
       --vf-verde. Tema fijo (siempre claro), Sniglet como tipografía única del componente.
       ═══════════════════════════════════════════════════════════════════════════════════ */
    :host {
      --vf-amarillo: #F5C500; --vf-naranja: #E8680A; --vf-oscuro: #151515; --vf-verde: #16a34a;
      --vf-rojo: #b91c1c; --vf-gris: #94a3b8;
      display: block; font-family: 'Sniglet', 'Comic Sans MS', 'Segoe UI', Roboto, Arial, sans-serif;
      color: var(--vf-oscuro);
    }

    .vf-page { position: relative; overflow: hidden; border-radius: var(--r-lg, 16px);
      display: flex; flex-direction: column; align-items: center; gap: .5rem;
      padding: 0 1.25rem 1.25rem; min-height: 640px;
      background: linear-gradient(160deg, #fffdf7 0%, #fdf3e2 100%); }
    /* Modo kiosco: se come el chrome de la app — el mostrador real es un monitor dedicado,
       no una ventana con sidebar al lado. */
    .vf-page.is-kiosco { position: fixed; inset: 0; z-index: 60; overflow: auto;
      border-radius: 0; padding-bottom: 2rem; }

    .vf-bg { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 0;
      opacity: .10; pointer-events: none; }
    .vf-top { position: sticky; top: 0; left: -1.25rem; width: calc(100% + 2.5rem); height: 8px;
      background: linear-gradient(90deg, var(--vf-naranja), var(--vf-amarillo)); z-index: 1; }

    /* Franja de control funcional (sucursal/frescura/kiosco/ayuda) — NO existía en el HTML
       original (era un kiosco de una sola sucursal); se queda por necesidad operativa real,
       chica y discreta arriba a la derecha para no competirle al logo/escáner. */
    .vf-ctrl { position: relative; z-index: 2; align-self: stretch; display: flex;
      align-items: center; justify-content: flex-end; gap: .5rem; flex-wrap: wrap;
      padding-top: .6rem; font-size: 12px; color: #64748b; }
    .vf-fresh-nd { display: inline-flex; align-items: center; gap: .25rem; cursor: help; }
    .vf-suc { font-weight: 700; color: var(--vf-oscuro); }
    .vf-icon-btn { min-width: 32px; min-height: 32px; display: inline-flex; align-items: center;
      justify-content: center; background: #fff; color: #555; border: 1px solid #e5e7eb;
      border-radius: 8px; cursor: pointer; font: inherit; }
    .vf-icon-btn:hover { color: var(--vf-naranja); border-color: var(--vf-naranja); }

    .vf-banner { position: relative; z-index: 2; align-self: stretch; display: flex;
      align-items: flex-start; gap: .5rem; padding: .5rem .75rem; margin-top: .35rem;
      border-radius: 10px; font-size: 13px; border: 1px solid #fde68a; background: #fffbeb; color: #92400e; }
    .vf-banner.is-ok { border-color: #86efac; background: #f0fdf4; color: #166534; }
    .vf-banner.is-warn { border-color: #fdba74; background: #fff7ed; color: #9a3412; }
    .vf-banner.is-bad { border-color: #fca5a5; background: #fef2f2; color: var(--vf-rojo); }
    .vf-banner > div { display: flex; flex-direction: column; gap: .1rem; }
    .vf-banner span { opacity: .85; font-size: 11.5px; }

    .vf-logo { position: relative; z-index: 1; display: block; margin: 18px auto 4px;
      max-height: 96px; max-width: 70vw; object-fit: contain; }
    .vf-logo-txt { position: relative; z-index: 1; margin: 22px 0 4px; font-size: 30px;
      font-weight: 800; letter-spacing: 1px; text-align: center; line-height: 1; }
    .vf-logo-txt .vf-m { color: var(--vf-naranja); } .vf-logo-txt .vf-d { color: var(--vf-oscuro); }

    /* ── Captura: idéntica jerarquía al HTML — barra, input, hint ─────────────────────── */
    .vf-scanbar { position: relative; z-index: 1; background: var(--vf-naranja); color: #fff;
      font-size: 15px; font-weight: 400; letter-spacing: 1px; padding: 8px 24px;
      border-radius: 8px; margin-top: 6px; display: flex; align-items: center; gap: .4rem; }
    .vf-input-row { position: relative; z-index: 1; margin-top: 10px;
      width: min(560px, 92vw); display: flex; align-items: center; gap: .5rem; }
    .vf-input { flex: 1; min-width: 0; text-align: center; font-size: 26px; font-weight: 700;
      font-family: inherit; padding: 14px; border-radius: 14px; border: 3px solid var(--vf-naranja);
      background: #fff; color: var(--vf-oscuro); letter-spacing: 2px; outline: none;
      box-shadow: 0 4px 16px rgba(0,0,0,.06); }
    .vf-input::placeholder { color: #c0c0c0; font-size: 16px; letter-spacing: 1px; }
    .vf-input:disabled { color: #b0b0b0; }
    .vf-busy { color: var(--vf-naranja); font-size: 1.3rem; }
    /* Cámara del celular: NO existía en el HTML (dependía de una pistola física USB/BT); es
       la tercera vía que se agregó en esta sesión, con el mismo cableado @zxing/browser que
       ya usan ScanFieldComponent/ProductScanFieldComponent. */
    .vf-cam-btn { flex: 0 0 auto; width: 52px; height: 52px; display: inline-flex;
      align-items: center; justify-content: center; background: #fff; color: var(--vf-naranja);
      border: 3px solid var(--vf-naranja); border-radius: 14px; font-size: 1.2rem; cursor: pointer; }
    .vf-cam-btn:disabled { opacity: .4; cursor: default; }
    .vf-cam-btn:focus-visible { outline: 2px solid var(--vf-naranja); outline-offset: 2px; }
    .vf-hint { position: relative; z-index: 1; margin-top: 8px; color: #888; font-size: 13px; }

    .vf-cam-ov { position: fixed; inset: 0; z-index: 1200; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: .75rem;
      background: rgba(21,21,21,.92); padding: 1rem; }
    .vf-cam-tip { margin: 0; color: #fff; font-size: .85rem; }
    .vf-cam-vid { width: min(100%, 520px); aspect-ratio: 4 / 3; object-fit: cover;
      background: #333; border-radius: 14px; }
    .vf-cam-x { min-height: 48px; min-width: 160px; padding: 0 1.25rem; background: #fff;
      color: var(--vf-oscuro); border: none; border-radius: 10px; font: inherit;
      font-weight: 700; cursor: pointer; }

    /* ── Tarjeta de resultado ──────────────────────────────────────────────────────────
       min-height/width y sombra calcados del HTML (740px/300px, sombra 0 20px 60px). Los
       otros datos (mayoreo, procedencia) que el HTML original nunca tuvo se agregaron
       después (TDA.2-7) y se conservan íntegros — sólo cambia la piel. */
    .vf-result { position: relative; z-index: 1; flex: 1; display: flex;
      align-items: center; justify-content: center; width: 100%; margin-top: 18px; }
    .vf-card { width: min(740px, 92vw); min-height: 260px; background: #fff; color: var(--vf-oscuro);
      border-radius: 22px; box-shadow: 0 20px 60px rgba(0,0,0,.5); padding: 24px 28px;
      text-align: center; display: flex; flex-direction: column; align-items: center; gap: .35rem;
      --vf-pop: vfPopA; animation: var(--vf-pop) .18s ease both; }
    .vf-card.is-pase-b { --vf-pop: vfPopB; }
    .vf-card.is-respaldo { box-shadow: 0 20px 60px rgba(232,104,10,.35); }
    @keyframes vfPopA { from { transform: scale(.96); opacity: .4; } to { transform: scale(1); opacity: 1; } }
    @keyframes vfPopB { from { transform: scale(.96); opacity: .4; } to { transform: scale(1); opacity: 1; } }

    /* [TDA.8] La advertencia de precio cambiado, re-pintada con la paleta cruda del clon
       (antes usaba --warn-*/--r-md de tokens). Nunca solo el color: icono + texto (DESIGN.md
       5, aunque este bloque ya no vive bajo DESIGN.md por la excepción de §O.3 declarada
       arriba, el principio de fondo se conserva). El párrafo NO se centra: es texto para
       leer, no una cifra — el bloque sí va centrado (margin auto). */
    .vf-cambio { margin: 6px auto 0; width: fit-content; max-width: 60ch;
      display: flex; align-items: flex-start; gap: .5rem; text-align: left;
      padding: .4rem .75rem; border-radius: 10px;
      background: #fff7ed; border: 1px solid #fdba74; color: #9a3412;
      font-size: 13px; text-wrap: pretty; }
    .vf-cambio > i { color: var(--vf-naranja); font-size: .95em; flex: none; margin-top: .15em; }
    .vf-cambio strong { color: var(--vf-naranja); }

    .vf-card-top { display: flex; align-items: center; justify-content: center; gap: .6rem; }
    .vf-cod { font-family: monospace; font-size: 14px; color: #888; letter-spacing: 1px; }
    .vf-tag { display: inline-flex; align-items: center; gap: .3rem; font-size: 11.5px;
      font-weight: 700; padding: .2rem .55rem; border-radius: 999px; text-transform: uppercase;
      letter-spacing: .04em; }
    .vf-tag.is-ok { background: #f0fdf4; color: #166534; border: 1px solid #86efac; }
    .vf-tag.is-warn { background: #fff7ed; color: #9a3412; border: 1px solid #fdba74; }

    .vf-nombre { font-size: 26px; font-weight: 400; color: var(--vf-oscuro); margin: 4px 0 12px;
      line-height: 1.15; }
    .vf-gramaje { font-size: .55em; font-weight: 500; color: #94a3b8; margin-left: .5rem; }
    .vf-unidad-lbl { font-size: 16px; color: var(--vf-naranja); font-weight: 400;
      text-transform: uppercase; letter-spacing: 1px; }
    /* La cifra: 104px como el original, pero con clamp para no reventar en el kiosco chico —
       el HTML era de un solo tamaño de monitor conocido; esta pantalla corre en varios. Impact
       (o su análogo del SO) es la fuente condensada del original; Sniglet no la reemplaza acá
       porque a ese tamaño se ve demasiado redonda para una cifra de mostrador. */
    .vf-precio { font-family: Impact, 'Arial Narrow Bold', 'Haettenschweiler', sans-serif;
      font-size: clamp(3.2rem, 11vw, 6.5rem); font-weight: 400; color: var(--vf-verde);
      line-height: 1; margin: 2px 0; letter-spacing: 1px; font-variant-numeric: tabular-nums; }
    .vf-peso { font-size: .5em; vertical-align: baseline; margin-right: .06em; }

    .vf-u-aclara { margin: 2px 0 0; font-size: 13px; color: #64748b; max-width: 46ch; }
    .vf-u-aclara strong { color: var(--vf-oscuro); font-weight: 700; }

    /* Mayoreo (TDA.4/7): no existía en el HTML original — paleta nueva, misma jerarquía
       ya probada (condición grande arriba, precio segundo, ahorro en pastilla verde). */
    .vf-mayoreo { margin-top: 14px; padding: 12px 16px 10px; border-radius: 14px;
      border: 2px solid var(--vf-amarillo); background: #fffdf5; display: flex;
      flex-direction: column; align-items: center; gap: .4rem; width: 100%; }
    .vf-may-row { display: flex; flex-direction: column; align-items: center; gap: .1rem; }
    .vf-may-cond { font-size: 14px; font-weight: 700; text-transform: uppercase;
      letter-spacing: .04em; color: #57534e; }
    .vf-may-n { color: var(--vf-naranja); font-weight: 800; font-size: 1.4em; }
    .vf-may-precio { display: flex; align-items: baseline; justify-content: center; gap: .3rem; }
    .vf-may-monto { font-family: monospace; font-weight: 800;
      font-size: clamp(1.6rem, 4vw, 2.4rem); color: var(--vf-oscuro); }
    .vf-may-cu { font-size: 13px; color: #78716c; }
    .vf-may-row:not(.is-realza) .vf-may-monto, .vf-may-row:not(.is-foco) .vf-may-monto {
      font-weight: 600; color: #a8a29e; font-size: clamp(1.2rem, 2.6vw, 1.6rem); }
    .vf-may-row:not(.is-foco) .vf-may-cond { opacity: .75; }
    .vf-may-ahorro { margin: 0; display: inline-flex; align-items: center; gap: .35rem;
      padding: .3rem .75rem; border-radius: 999px; background: #f0fdf4; border: 1px solid #86efac;
      font-size: 13.5px; color: #166534; }
    .vf-may-ahorro strong { font-family: monospace; font-weight: 800; font-size: 1.1em; color: var(--vf-verde); }
    .vf-may-pct { opacity: .8; }

    /* Otras unidades: píldoras calcadas de .u-item/.u-precio del HTML original. */
    .vf-otras { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px 12px;
      margin-top: 14px; padding-top: 14px; border-top: 1px solid #e5e7eb; width: 100%; }
    .vf-u-item { font-size: 18px; color: #334155; background: #f1f5f9; border-radius: 10px;
      padding: 6px 14px; display: flex; align-items: baseline; gap: 5px; }
    .vf-u-item b { color: var(--vf-naranja); text-transform: uppercase; font-size: 13px;
      font-weight: 400; letter-spacing: .5px; }
    .vf-u-precio { font-family: monospace; font-size: 22px; color: var(--vf-verde); letter-spacing: .4px; }
    .vf-u-f { font-size: 11px; color: #94a3b8; }

    .vf-nota { margin: 10px auto 0; font-size: 11.5px; color: #94a3b8; max-width: 60ch; }

    /* Error / no-encontrado: copy calcado del HTML ("DISCULPE LAS MOLESTIAS"), con la
       distinción de severidad que DESIGN pre-vuelo 6 exige entre "no existe" (más suave) y
       "sin conexión" (grave) — el HTML original no distinguía, esta pantalla sí debe. */
    .vf-err { width: min(740px, 92vw); min-height: 200px; background: #fff; border-radius: 22px;
      box-shadow: 0 20px 60px rgba(0,0,0,.35); padding: 40px 24px; text-align: center;
      font-size: 30px; font-weight: 800; color: var(--vf-naranja);
      display: flex; flex-direction: column; align-items: center; gap: 10px;
      animation: vfPopA .18s ease both; }
    .vf-err.is-bad { color: var(--vf-rojo); box-shadow: 0 20px 60px rgba(185,28,28,.3); }
    .vf-err small { font-size: 16px; color: #888; font-weight: 500; }
    ::ng-deep .vf-btn-respaldo .p-button { background: var(--vf-verde); border-color: var(--vf-verde); color: #fff; }
    ::ng-deep .vf-btn-respaldo .p-button:hover { filter: brightness(1.08); }

    .vf-foot { position: relative; z-index: 1; align-self: stretch; margin-top: 12px;
      padding-top: 10px; border-top: 1px solid rgba(0,0,0,.06); display: flex;
      flex-direction: column; gap: 4px; font-size: 12px; color: #94a3b8; }
    .vf-counter b { color: var(--vf-naranja); font-weight: 700; }
    .vf-counter-reset { background: none; border: none; cursor: pointer; opacity: .55;
      padding: 0 4px; font: inherit; color: inherit; }
    .vf-feed { display: flex; flex-wrap: wrap; gap: .3rem 1rem; }
    .vf-feed-item { display: inline-flex; align-items: center; gap: .3rem; }
    .vf-mono { font-family: monospace; }
    .vf-version { display: inline-flex; align-items: center; gap: .4rem; color: #b0b8c4; }

    ::ng-deep .vf-sel .p-select { border-radius: 8px; }

    @media (prefers-reduced-motion: reduce) {
      .vf-card, .vf-err { animation: none; }
    }
  `],
})
export class TiendaVerificadorComponent implements OnInit, OnDestroy {
  private readonly svc = inject(VerificadorService);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly socket = inject(StoreSocketService);
  private readonly destroyRef = inject(DestroyRef);

  @ViewChild('scan') private scanInput?: ElementRef<HTMLInputElement>;
  @ViewChild('video') private videoEl?: ElementRef<HTMLVideoElement>;
  @ViewChild('camCancelar') private camCancelarBtn?: ElementRef<HTMLButtonElement>;
  private lector?: BrowserMultiFormatReader;
  private controles?: IScannerControls;

  /** Clave de preferencia del kiosco: la máquina del mostrador queda en kiosco tras recargar. */
  private static readonly LS_KIOSCO = 'tienda.verificador.kiosco';
  /** Contador de productos escaneados, persistente por equipo — igual que `mdVerifCount` del
   * HTML original, con clave propia (ese localStorage era de otro origen, inalcanzable acá). */
  private static readonly LS_CONTADOR = 'tienda.verificador.contador';
  /** A los 15s de inactividad la tarjeta se limpia sola, como `armarClear()` en el HTML
   * original: un precio (o un error) no debe quedar pegado en pantalla toda la tarde. */
  private static readonly MS_AUTOLIMPIA = 15_000;
  private clearTimer?: ReturnType<typeof setTimeout>;

  readonly sucursal = signal<string | null>(null);
  readonly sucursales = signal<SucursalVerificador[]>([]);
  readonly kiosco = signal(false);
  readonly buscando = signal(false);
  readonly descargando = signal(false);
  readonly banner = signal<Banner>(null);
  /** Overlay de la cámara del celular como lector (tercera vía además de pistola HID y teclado). */
  readonly camaraAbierta = signal(false);

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
  /** Productos escaneados en este equipo, de por vida (no se resetea con el feed de 8). */
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
    // Como `armarClear()` del HTML original: 15s de inactividad y la pantalla vuelve sola a
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

  /** `armarClear()` del HTML original: reinicia el reloj de 15s cada vez que hay un resultado nuevo. */
  private armarClear(): void {
    if (this.clearTimer) clearTimeout(this.clearTimer);
    this.clearTimer = setTimeout(() => this.limpiarResultado(), TiendaVerificadorComponent.MS_AUTOLIMPIA);
  }

  private bumpContador(): void {
    const n = this.contador() + 1;
    this.contador.set(n);
    try { localStorage.setItem(TiendaVerificadorComponent.LS_CONTADOR, String(n)); } catch { /* no crítico */ }
  }

  reiniciarContador(): void {
    if (!confirm('¿Reiniciar el contador de productos escaneados a cero?')) return;
    this.contador.set(0);
    try { localStorage.setItem(TiendaVerificadorComponent.LS_CONTADOR, '0'); } catch { /* no crítico */ }
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
    try { this.controles?.stop(); } catch { /* la cámara ya estaba cerrada */ }
    this.controles = undefined;
    this.lector = undefined;
    this.enfocar();
  }

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

  /** El precio hero separa el "$" en un span chico (`.vf-peso`, calcado del HTML original):
   * este helper da el número sin el signo para que el template lo envuelva aparte. */
  moneySinSigno(v: number | null | undefined): string {
    if (v == null) return '—';
    return (Number(v) || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
