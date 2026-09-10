import { ChangeDetectionStrategy, Component, ElementRef, HostListener, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
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
  imports: [CommonModule, FormsModule, ButtonModule, SelectModule, TagModule, ContextHelpComponent, FreshnessPillComponent],
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
              <div class="vp-card" [class.is-respaldo]="origen() === 'respaldo'">
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
                    @for (t of mayoreo(); track t.etiqueta) {
                      <div class="vp-may-row" [class.is-realza]="t.realza">
                        <div class="vp-may-cond">
                          <i class="pi pi-tags" aria-hidden="true"></i>
                          Llevando <strong class="vp-may-n">{{ t.desde }}+</strong> {{ t.palabra }}
                        </div>
                        <div class="vp-may-precio">
                          <span class="vp-may-monto">{{ money(t.precio_con_iva) }}</span>
                          <span class="vp-may-cu">c/u</span>
                        </div>
                      </div>
                      <!--
                        El ahorro es lo que cierra la venta: no es lo mismo "$41.10 c/u" que
                        "te ahorras $34.70". Solo se pinta como GANANCIA cuando el descuento es
                        perceptible (>=1%): abajo de eso el numero es cierto pero pintarlo de
                        verde seria mentir con el color. Medido: 366 tiers caen ahi.
                      -->
                      @if (t.realza) {
                        <p class="vp-may-ahorro">
                          <i class="pi pi-arrow-down" aria-hidden="true"></i>
                          Te ahorras <strong>{{ money(t.ahorro_en_el_minimo) }}</strong>
                          <span class="vp-may-pct">({{ t.descuento_pct }}% menos c/u)</span>
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

    .vp-page { display: flex; flex-direction: column; gap: var(--sp-4);
      padding: var(--sp-5) var(--sp-6); color: var(--text-main); }
    /* Modo kiosco: la pantalla se come el chrome de la app (sidebar incluido) para que
       la clienta vea el precio y nada más. Es un overlay, no un layout aparte. */
    .vp-page.is-kiosco { position: fixed; inset: 0; z-index: 60; overflow: auto;
      background: var(--layout-bg); padding: var(--sp-4) var(--sp-5); }

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

    .vp-precio-principal { display: flex; align-items: baseline; gap: var(--sp-3);
      flex-wrap: wrap; margin-top: var(--sp-2); }
    /* La cifra es el objeto de la pantalla: se lee a un metro y medio, del otro lado del
       mostrador. clamp para que no reviente en el monitor chico del kiosco. */
    .vp-precio { font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-weight: 800; font-size: clamp(2.75rem, 9vw, 6rem); line-height: 1;
      letter-spacing: -0.02em; color: var(--text-main); }
    .vp-precio-u { font-size: var(--fs-body, .875rem); color: var(--text-muted); text-transform: lowercase; }
    .vp-precio-nota { margin: .2rem 0 0; font-size: var(--fs-xs, .75rem); color: var(--text-faint); }

    /* ── [TDA.4] Mayoreo ──────────────────────────────────────────────────
       Colorimetria segun DESIGN.md 5: la marca (--action, sunset) va en lo ACTIVO y en lo que
       hay que mirar, no decorando. Aca la lleva UNA sola cosa: el numero del umbral ("10+"),
       que es el dato accionable -- cuantas hay que llevar. El resto es neutro.

       El ahorro SI es una ganancia, asi que usa el semantico --ok-*, y nunca solo: lleva icono
       y texto (DESIGN.md 5, "color nunca es unico portador de significado"). Y solo aparece
       cuando el descuento es perceptible: por eso .is-realza gatea la fila entera.

       Sin hex inline en todo el bloque. */
    .vp-mayoreo { margin: var(--sp-3) 0 0; padding: var(--sp-3); border-radius: var(--r-sm);
      border: 1px solid var(--border-color); background: var(--surface-ground);
      display: flex; flex-direction: column; gap: .15rem; }
    .vp-may-row { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-3);
      font-size: var(--fs-body, .875rem); }
    .vp-may-cond { display: flex; align-items: baseline; gap: .4rem; color: var(--text-muted); }
    .vp-may-cond > i { color: var(--text-faint); font-size: .85em; }
    /* El umbral es lo unico con color de marca: es la respuesta a "cuantas necesito". */
    .vp-may-n { color: var(--action); font-weight: 700; font-family: var(--font-mono);
      font-variant-numeric: tabular-nums; }
    .vp-may-precio { display: flex; align-items: baseline; gap: .3rem; }
    /* Grande, pero deliberadamente MENOR que el precio unitario: el hero manda (DESIGN O.3). */
    .vp-may-monto { font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-weight: 700; font-size: clamp(1.15rem, 2.4vw, 1.6rem); color: var(--text-main); }
    .vp-may-cu { font-size: var(--fs-xs, .75rem); color: var(--text-faint); }
    .vp-may-ahorro { margin: 0 0 .35rem; display: flex; align-items: center; gap: .35rem;
      font-size: var(--fs-sm, .8125rem); color: var(--ok-soft-fg); }
    .vp-may-ahorro > i { color: var(--ok-fg); font-size: .9em; }
    .vp-may-ahorro strong { font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      color: var(--ok-fg); }
    .vp-may-pct { color: var(--text-faint); }
    /* Sin realce (descuento < 1%): el dato se muestra igual, apagado. Es cierto, no es oferta. */
    .vp-may-row:not(.is-realza) .vp-may-monto { font-weight: 600; color: var(--text-muted); }

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
    @keyframes vpEntra { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
    .vp-card { animation: vpEntra var(--dur-short, 150ms) var(--ease-out, ease-out); }
    /* [TDA.3] "El codigo que escaneaste es de CJA". Va pegada al precio grande porque lo CALIFICA:
       separada, el operador leeria el numero antes de saber de que unidad es. */
    .vp-u-aclara { display: flex; align-items: center; gap: .4rem; margin: .35rem 0 0;
      font-size: var(--fs-sm, .8125rem); color: var(--text-muted); }
    .vp-u-aclara strong { color: var(--text-main); font-weight: 600; }

    .vp-unidades { list-style: none; margin: var(--sp-3) 0 0; padding: var(--sp-3) 0 0;
      border-top: 1px solid var(--border-color); display: flex; flex-direction: column; gap: .3rem; }
    .vp-unidades li { display: flex; align-items: baseline; gap: var(--sp-3); font-size: var(--fs-sm, .8125rem); }
    .vp-u-nom { min-width: 7rem; color: var(--text-muted); text-transform: uppercase;
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
  readonly feed = signal<Consulta[]>([]);

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
