import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, ViewChild, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService } from 'primeng/api';
import { BrowserMultiFormatReader, IScannerControls } from '@zxing/browser';
import { DecodeHintType, BarcodeFormat } from '@zxing/library';
import { controlesSiSigueAbierta, detenerLector } from '../../../shared/util/lector-camara.util';
import { App as CapApp } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
import { ComercialService, InventoryCount, InventoryCounterProgress, ResolvedProduct } from '../comercial.service';
import { CountFocusService } from '../../../core/services/count-focus.service';
import { CantidadFisicaDirective } from '../../../shared/directives/cantidad-fisica.directive';
import { InventoryOfflineService } from '../../../core/services/inventory-offline.service';
import type { InventoryScanPending } from '../../../core/services/offline-database.service';
import { cuentaDeConversion, type CuentaDeConversion } from './conteo-cuenta-de-conversion';

/**
 * `[IC.F13]` Lo que el servidor reconoce de un código, con el nombre de la CATEGORÍA.
 *
 * ⚠️ **Deuda con nombre:** `category_name` va acá y no en `ResolvedProduct` porque al cerrar
 * esto `comercial.service.ts` tenía trabajo sin commitear de otra sesión (`[IC.27]`, la lista
 * universal de asignables) y tocarlo se lo habría llevado puesto en este commit. Cuando eso
 * aterrice, el campo se muda al contrato y este alias se borra.
 */
type ProductoResuelto = ResolvedProduct & { category_name?: string | null };

/** `[IC.F24]` Una opción del selector de unidad, ya con su texto armado. */
interface OpcionDeUnidad {
  unit: string;
  etiqueta: string;
}

interface FeedEntry {
  sku: string | null;
  name: string | null;
  qty: number;
  slot: string;
  ts: Date;
}

/**
 * Página del CONTADOR (Fase I.2) — pensada para handheld (lector HID que teclea
 * el código + Enter). Conteo CIEGO: nunca muestra el teórico ni la varianza.
 *
 * Flujo de un gesto: escaneás el código (→ salta a cantidad) → tecleás cantidad
 * (→ Enter envía) → confirmación en el feed → foco vuelve al código.
 */
@Component({
  selector: 'app-comercial-inventory-count',
  standalone: true,
  imports: [
    // `[ICR.M6]` En un standalone el pipe se declara o el AOT de producción truena, aunque el
    // build local pase en verde.
    DecimalPipe,
    FormsModule,
    ButtonModule,
    SelectModule,
    InputNumberModule,
    InputTextModule,
    TagModule,
    ToastModule,
    TooltipModule,
    CantidadFisicaDirective,
],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in ic-page" [class.is-counting]="sessionActive()">
      <p-toast position="top-center"></p-toast>
      @if (!sessionActive()) {
      }

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Conteo de inventario</h1>
          <p class="surf-page-sub">Escanea el código y registra la cantidad física. No verás el teórico.</p>
        </div>
      </header>

      @if (!folios().length) {
        <div class="ic-empty">
          <i class="pi pi-inbox"></i>
          <!--
            [IC.F22] Esta pantalla NO sabe si no hay folio abierto o si lo hay y no te asignaron:
            la lista de "mis folios" devuelve vacío en los dos casos. Decía «no hay ninguno
            abierto» y mandaba a pedir algo que ya existía — el supervisor que recibía el reclamo
            veía el folio vivo y no entendía nada. El texto ahora dice lo que sí sabe, y la
            acción es la que ya está escrita en ContarOAsignadoGuard.

            ⛔ Sin comillas invertidas acá adentro: parten el template literal (§8).
          -->
          <p>No tienes folios para contar.</p>
          <small>Si ya abrieron uno, pídele a quien arma el equipo que te agregue como contador.</small>
        </div>
      } @else {
        <!-- Selector de folio (oculto mientras hay un conteo en curso) -->
        @if (!sessionActive()) {
          <div class="ic-folio-row">
            <p-select
              [options]="folios()"
              [(ngModel)]="selectedFolioId"
              optionLabel="label"
              optionValue="id"
              placeholder="Elige el folio"
              styleClass="ic-folio-select"
              appendTo="body"
              (onChange)="onFolioChange()"
            ></p-select>
          </div>
        }

        <!--
          [ICR.M5] LA COLA, VISIBLE EN TODOS LOS ESTADOS.

          Estaba dentro del bloque de sesion activa, o sea que desaparecía justo cuando importa:
          al tocar «Terminar» la persona se va, y lo que quedó sin subir se iba con ella sin
          decir nada (E4 del acta del 2026-11-27). Ahora cuelga del folio, no de la jornada:
          se ve al elegir el folio, contando y después de terminar.

          Sigue sin ocupar un pixel cuando no hay nada que decir — las dos cajas son
          condicionales. El marco de esta pantalla ya se come el 48 % del alto en celular.

          ⚠️ El contador de pendientes cuenta la cola ENTERA (todos los folios), no la del folio
          elegido: es a propósito, porque lo que no subió de otro folio tampoco llegó.
        -->
        @if (!offline.online() || offline.pending() > 0) {
          <div class="ic-net" role="status" [class.ic-net-off]="!offline.online()">
            @if (!offline.online()) {
              <span><i class="pi pi-wifi"></i> Sin conexión · <b>{{ offline.pending() }}</b> sin subir — se guardan aquí y se suben al reconectar.</span>
            } @else {
              <span><i class="pi pi-sync pi-spin"></i> <b>{{ offline.pending() }}</b> sin subir…</span>
              <button pButton [text]="true" size="small" class="ic-net-retry" (click)="retrySync()"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Reintentar</span></button>
            }
          </div>
        }
        <!--
          [ICR.M5] Este dispositivo llegó sin el catálogo y sin red: no puede reconocer ni un
          código. Se DICE antes de empezar, en vez de que se descubra escaneando.
          Se pinta sólo con la medición hecha (0) — nunca con catalogoLocal() en null.
        -->
        @if (!offline.online() && catalogoLocal() === 0) {
          <div class="ic-net ic-net-off" role="alert">
            <span><i class="pi pi-database"></i> Este dispositivo no tiene descargado el catálogo del folio y no hay conexión: ningún código se va a reconocer. Conéctate una vez antes de empezar.</span>
          </div>
        }
        <!-- Escaneos rechazados por el servidor (folio cerrado / segregación): no se
             reintentan, pero NO desaparecen en silencio — el contador los ve y avisa. -->
        @if (discarded().length) {
          <div class="ic-net ic-net-off ic-net-discarded" role="alert">
            <span><i class="pi pi-exclamation-triangle"></i> {{ discarded().length }} escaneo(s) rechazado(s) — no llegaron al conteo. Avisa al supervisor.</span>
            <ul class="ic-discarded-list">
              @for (d of discarded(); track d.scan_uuid) {
                <li><b>{{ d.quantity }}</b> · {{ d.barcode || d.product_id }} <small>{{ d.motivo_descarte }}</small></li>
              }
            </ul>
          </div>
        }

        @if (selectedFolioId() && !sessionActive() && justFinishedPass() === null) {
          <!-- Pantalla de inicio: arrancar la jornada de conteo -->
          <div class="ic-start">
            <i class="pi pi-stopwatch"></i>
            <h2>Fase {{ currentPass() }} · {{ currentPass() === 1 ? 'Primer conteo' : 'Segundo conteo (ciego)' }}</h2>
            <p>Al iniciar entras en modo conteo: la app queda fija en esta pantalla hasta que toques <b>Terminar</b>.</p>
            <button pButton class="ic-start-btn" [loading]="starting()" (click)="startCount()"><span class="p-button-icon p-button-icon-left pi pi-play" aria-hidden="true"></span><span class="p-button-label">Iniciar conteo</span></button>
          </div>
        }

        @if (justFinishedPass() !== null) {
          <!--
            Jornada terminada.

            [ICR.M5] El rótulo dice lo que PASÓ, no lo que se esperaba: decía «Registramos tu
            conteo» aunque quedaran escaneos en la cola, que es exactamente el silencio de E4.
            Con cola sucia la tarjeta se pone en rojo y nombra el número — es el momento en que
            alguien se va de la sucursal, y la regla operativa es que nadie se va con la cola
            en rojo. El botón «Reintentar» está arriba, en la caja de la cola.
          -->
          <div class="ic-done" [class.ic-done-sucia]="colaSucia()">
            <i class="pi" [class.pi-check-circle]="!colaSucia()" [class.pi-exclamation-triangle]="colaSucia()"></i>
            <h2>Fase {{ justFinishedPass() }} terminada</h2>
            @if (offline.pending() > 0) {
              <p>Faltan <b>{{ offline.pending() }}</b> escaneos por subir. No cierres la app ni te vayas hasta que llegue a cero.</p>
            } @else if (discarded().length) {
              <p>Tu conteo subió, pero <b>{{ discarded().length }}</b> escaneos quedaron rechazados y no entraron al folio. Avisa al supervisor antes de irte.</p>
            } @else {
              <p>Todo lo que contaste ya se subió. Espera a que el supervisor habilite la siguiente fase o cierre el folio.</p>
            }
            <button pButton [text]="true" severity="secondary" (click)="startCount()"><span class="p-button-icon p-button-icon-left pi pi-replay" aria-hidden="true"></span><span class="p-button-label">Volver a contar esta fase</span></button>
          </div>
        }

        @if (sessionActive()) {
          <div class="ic-phase-banner">
            <span><i class="pi pi-stopwatch"></i> Conteo en curso · Fase {{ currentPass() }}</span>
            <button pButton severity="success" size="small" [loading]="finishing()" (click)="finishCount()"><span class="p-button-icon p-button-icon-left pi pi-flag-fill" aria-hidden="true"></span><span class="p-button-label">Terminar</span></button>
          </div>
          <!-- Progreso ciego -->
          <div class="ic-progress">
            <div class="ic-progress-bar">
              <div class="ic-progress-fill" [style.width.%]="pct()"></div>
            </div>
            <div class="ic-progress-meta">
              <span><b>{{ progress()?.counted ?? 0 }}</b> de <b>{{ progress()?.total ?? 0 }}</b> contados</span>
              <span class="ic-remaining"><b>{{ progress()?.remaining ?? 0 }}</b> restantes</span>
              <span class="ic-mine">tú: <b>{{ progress()?.mine ?? 0 }}</b></span>
            </div>
          </div>

          <div class="ic-work">
          <!-- Captura -->
          <div class="ic-capture">
            <label class="ic-label" for="ic-code">Código de barras</label>
            <div class="ic-code-row">
              <input
                #codeInput
                id="ic-code"
                pInputText
                type="text"
                inputmode="numeric"
                autocomplete="off"
                [(ngModel)]="code"
                (keydown.enter)="onCodeEnter()"
                placeholder="Escanea, teclea o usa la cámara"
                class="ic-input ic-input-code"
              />
              @if (scanSupported()) {
                <button pButton type="button" class="ic-scan-btn" aria-label="Escanear con la cámara" pTooltip="Escanear con la cámara" (click)="startScan()"><span class="p-button-icon p-button-icon-left pi pi-camera" aria-hidden="true"></span></button>
              }
            </div>

            <!-- Overlay de cámara — pantalla completa solo mientras escaneás. -->
            @if (scanning()) {
              <div class="ic-scan-overlay" role="dialog" aria-label="Escanear código de barras" (keydown.escape)="stopScan()">
                <video #scanVideo class="ic-scan-video" playsinline muted></video>
                <div class="ic-scan-mask">
                  <div class="ic-scan-frame"></div>
                  <p class="ic-scan-hint">Apunta al código de barras</p>
                </div>
                <button #scanCancel pButton class="ic-scan-cancel" (click)="stopScan()"><span class="p-button-icon p-button-icon-left pi pi-times" aria-hidden="true"></span><span class="p-button-label">Cancelar</span></button>
              </div>
            }

            <!-- Producto reconocido -->
            @if (resolving()) {
              <div class="ic-prod ic-prod-loading"><i class="pi pi-spin pi-spinner"></i> Buscando producto…</div>
            } @else if (resolved()) {
              <div class="ic-prod ic-prod-ok">
                <i class="pi pi-check-circle"></i>
                <div class="ic-prod-info">
                  <span class="ic-prod-name">{{ resolved()?.product_name }}</span>
                  <span class="ic-prod-meta">{{ resolved()?.sku }}@if (resolved()?.brand_name) { · {{ resolved()?.brand_name }} }@if (resolved()?.category_name) { · {{ resolved()?.category_name }} }@if (resolved()?.location) { · ubic. {{ resolved()?.location }} }</span>
                </div>
              </div>
            } @else if (notFound()) {
              @if (!offline.online()) {
                <div class="ic-prod ic-prod-warn"><i class="pi pi-cloud"></i> Sin conexión — se registra y se identifica al subir.</div>
              } @else {
                <div class="ic-prod ic-prod-bad"><i class="pi pi-exclamation-triangle"></i> Código no reconocido en el catálogo</div>
              }
            }

            <!--
              [IC.F24] EN QUE UNIDAD se cuenta, antes de teclear el numero.
              El teorico del folio esta en la unidad nativa del almacen, y hasta hoy la pantalla
              no la nombraba: el campo decia «Cantidad fisica» a secas. Medido en prod: 2,596 de
              3,364 articulos (77 %) tienen un factor de 12 o mas, asi que contar cajas donde el
              sistema espera paquetes equivoca la varianza por el factor.
              El valor por defecto es el del codigo que viene con el SKU (is_primary, que son
              todos kepler_base con factor 1). El selector solo aparece cuando hay mas de una.
            -->
            @if (resolved()) {
              @if (opcionesDeUnidad().length > 1) {
                <label class="ic-label" for="ic-unidad">Unidad</label>
                <p-select
                  inputId="ic-unidad"
                  [options]="opcionesDeUnidad()"
                  [(ngModel)]="unidad"
                  optionLabel="etiqueta"
                  optionValue="unit"
                  class="ic-unidad"
                ></p-select>
              } @else if (unidad()) {
                <p class="ic-unidad-fija">Se cuenta en <strong>{{ unidad() }}</strong>.</p>
              } @else {
                <p class="ic-unidad-fija ic-unidad-falta">
                  <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                  Este producto no tiene unidad en el catálogo. Cuenta como venga y avisa al supervisor.
                </p>
              }
            }

            <label class="ic-label" for="ic-qty">Cantidad física</label>
            <p-inputnumber
              #qtyInput
              appCantidadFisica
              inputId="ic-qty"
              [(ngModel)]="qty"
              [min]="0"
              [showButtons]="true"
              buttonLayout="horizontal"
              incrementButtonIcon="pi pi-plus"
              decrementButtonIcon="pi pi-minus"
              inputStyleClass="ic-input ic-input-qty"
              (onKeyDown)="onQtyKey($event)"
              placeholder="0"
            ></p-inputnumber>

            <!--
              [ICR.M6] LA CUENTA, ANTES DE ACEPTAR.

              Contar en cajas multiplica el error por el factor, y NINGUNA base sabe cuántas
              piezas trae la caja que está en el anaquel: medido en prod el 2026-11-27 para
              Yurécuaro, de los 133 productos con código de caja el factor del catálogo y el
              del ERP discrepan en 123 de 134 comparaciones. Si alguien cuenta 3 cajas, la
              caja real trae 12 y el sistema cree 24, registramos 72 donde hay 36.

              Entonces la pantalla no esconde la multiplicación: la escribe, con el factor
              suelto, para que se verifique contra la caja que la persona tiene en la mano.
              El factor sale del resolvedor (catalog.product_barcodes) — no se inventa, y sin
              unidad nativa no se afirma ninguna conversion: el bloque entero no se pinta.

              Sólo aparece cuando se cuenta en una unidad que NO es la nativa: en el caso
              común —un solo código, factor 1— la tarjeta queda exactamente como estaba.
            -->
            @if (conversion(); as c) {
              <div class="ic-conversion">
                <span class="ic-conversion-cuenta">{{ c.cantidad | number: '1.0-3' }} {{ c.unidad }} × {{ c.factor | number: '1.0-3' }} = <b>{{ c.total | number: '1.0-3' }} {{ c.nativa }}</b></span>
                <span class="ic-conversion-verifica">Verifica que 1 {{ c.unidad }} traiga {{ c.factor | number: '1.0-3' }} {{ c.nativa }}. Si no, cambia la unidad y avisa al supervisor.</span>
              </div>
            }

            <!--
              [ICR.M6] El botón dice lo que va a ESCRIBIR, no lo que hace. Lo último que toca
              el pulgar es la cifra que queda en el folio, en la unidad del teórico.
              ⛔ PrimeNG 22: la directiva pButton ignora el atributo label — el texto va en el span, como el resto
              de los botones de esta pantalla.
            -->
            <button pButton class="ic-submit" [loading]="submitting()" [disabled]="!code() || qty() === null || qty() === undefined" (click)="submit()"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">@if (conversion(); as c) { Registrar {{ c.total | number: '1.0-3' }} {{ c.nativa }} } @else { Registrar conteo }</span></button>
          </div>

          <!-- Feed de últimos conteos -->
          @if (feed().length) {
            <div class="ic-feed">
              <h3>Últimos conteos</h3>
              @for (e of feed(); track e.ts) {
                <div class="ic-feed-row">
                  <div class="ic-feed-main">
                    <span class="ic-feed-name">{{ e.name || e.sku || '—' }}</span>
                    @if (e.sku) { <span class="ic-feed-sku">{{ e.sku }}</span> }
                  </div>
                  <span class="ic-feed-qty">{{ e.qty }}</span>
                  <p-tag
                    [value]="slotLabel(e.slot)"
                    [severity]="e.slot === 'count_2' ? 'success' : (e.slot === 'count_3' ? 'warn' : 'info')"
                  ></p-tag>
                </div>
              }
            </div>
          }
          </div>
        }
      }
    </div>
  `,
  styles: [`
    /* Layout responsive — móvil/tablet-portrait: 1 columna enfocada. En ≥900px
       (tablet-landscape, laptop; y el modo-foco que va a pantalla completa sin
       sidebar) pasa a 2 columnas: captura sticky | feed, usando el espacio que
       antes quedaba muerto. La columna ancha solo aplica mientras se cuenta. */
    .ic-page { max-width: 560px; margin: 0 auto; }
    .ic-work { display: flex; flex-direction: column; }
    @media (min-width: 56.25rem) {
      .ic-page.is-counting { max-width: 1080px; }
      .ic-page.is-counting .ic-work { display: grid; grid-template-columns: minmax(0, 520px) 1fr; gap: 1.5rem; align-items: start; }
      .ic-page.is-counting .ic-capture { position: sticky; top: 1rem; margin-bottom: 0; }
    }

    /* Empty state operacional (sin folio) — voz técnica, sin CTA (lo abre el supervisor). */
    .ic-empty { text-align: center; padding: 3rem 1rem; color: var(--text-muted, #52525B); }
    .ic-empty i { font-size: 2.5rem; opacity: .5; display: block; margin-bottom: .75rem; color: var(--text-faint, #A1A1AA); }
    .ic-empty p { margin: 0 0 .25rem; font-weight: 600; color: var(--text-main, #09090B); }
    .ic-empty small { color: var(--text-muted, #52525B); }

    /* Selector de folio */
    .ic-folio-row { margin-bottom: 1rem; }
    :host ::ng-deep .ic-folio-select { width: 100%; }

    /* Estados de jornada (arranque / terminada) — card hairline, sin sombra (regla elevación). */
    .ic-start, .ic-done { text-align: center; padding: 2.5rem 1.25rem; background: var(--card-bg, #fff); border: 1px solid var(--border-color, #E4E4E7); border-radius: var(--r-lg, 16px); }
    .ic-start i, .ic-done i { font-size: 2.75rem; display: block; margin-bottom: .75rem; }
    .ic-start i { color: var(--action, #f05a28); }
    .ic-done i { color: var(--ok-fg, #16a34a); }
    /* [ICR.M5] Cola sucia al terminar: el check verde sería un rótulo que miente. */
    .ic-done-sucia { border-color: var(--bad-fg, #dc2626); }
    .ic-done-sucia i { color: var(--bad-fg, #dc2626); }
    .ic-done-sucia p { color: var(--bad-soft-fg, #991b1b); }
    .ic-done-sucia p b { font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; }
    .ic-start h2, .ic-done h2 { font-size: 1.2rem; margin: 0 0 .4rem; color: var(--text-main, #09090B); }
    .ic-start p, .ic-done p { color: var(--text-muted, #52525B); margin: 0 auto 1.25rem; max-width: 34ch; line-height: 1.45; }
    :host ::ng-deep .ic-start-btn { padding: .9rem 2rem; font-size: 1.05rem; min-height: 48px; }

    /* Banner "conteo en curso" */
    .ic-phase-banner { display: flex; align-items: center; justify-content: space-between; gap: .75rem; padding: .5rem .5rem .5rem .9rem; margin-bottom: 1rem; border-radius: var(--r-md, 12px); background: color-mix(in srgb, var(--action, #f05a28) 12%, transparent); color: var(--text-main, #09090B); font-weight: 600; }
    .ic-phase-banner i { margin-right: .35rem; color: var(--action, #f05a28); }

    /* Banner de red (offline-first): conteos a salvo en la cola; cero pérdida. */
    .ic-net { display: flex; align-items: center; gap: .4rem; padding: .5rem .8rem; margin-bottom: 1rem; border-radius: var(--r-md, 12px); font-size: .8rem; font-weight: 600; background: var(--warn-soft-bg, #fef3c7); color: var(--warn-soft-fg, #92400e); }
    .ic-net-off { background: var(--bad-soft-bg, #fee2e2); color: var(--bad-soft-fg, #991b1b); }
    .ic-net i { font-size: 1rem; }
    /* [ICR.M5] El número de la cola, en mono tabular: se lee de reojo y no baila al cambiar. */
    .ic-net b { font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; }
    .ic-net-discarded { flex-direction: column; align-items: flex-start; gap: .35rem; }
    :host ::ng-deep .ic-net-retry { margin-left: auto; }
    .ic-discarded-list { margin: 0; padding-left: 1.1rem; font-size: .78rem; font-weight: 500; }
    .ic-discarded-list li { margin: .1rem 0; }
    .ic-discarded-list small { opacity: .8; }

    /* Progreso ciego — barra + cifras tabulares (Geist Mono). */
    .ic-progress { margin-bottom: 1.25rem; }
    .ic-progress-bar { height: 10px; border-radius: var(--r-pill, 999px); background: var(--border-color, #E4E4E7); overflow: hidden; }
    .ic-progress-fill { height: 100%; background: var(--action, #f05a28); border-radius: inherit; transition: width .3s var(--ease-out, ease); }
    .ic-progress-meta { display: flex; justify-content: space-between; gap: .5rem; font-size: .8rem; margin-top: .45rem; color: var(--text-muted, #52525B); }
    .ic-progress-meta b { font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; color: var(--text-main, #09090B); font-weight: 600; }
    .ic-mine { margin-left: auto; }

    /* Captura — tarjeta activa (lo que el contador mira en bucle). */
    .ic-capture { display: flex; flex-direction: column; gap: .35rem; margin-bottom: 1.5rem; background: var(--card-bg, #fff); border: 1px solid var(--border-color, #E4E4E7); border-radius: var(--r-lg, 16px); padding: 1rem 1rem 1.15rem; }
    .ic-label { font-size: var(--fs-xs); font-weight: 600; color: var(--text-muted, #52525B); text-transform: uppercase; letter-spacing: .04em; margin-top: .5rem; }
    /*
      [IC.F24] La unidad, pegada al campo de cantidad. Cuando hay una sola no se gasta un
      selector: se dice en una linea. Cuando no hay ninguna se avisa, que es distinto de callar.
    */
    .ic-unidad-fija { margin: .35rem 0 0; font-size: var(--fs-sm); color: var(--text-muted, #52525B); }
    .ic-unidad-falta { color: var(--warn-soft-fg); display: flex; gap: .4rem; align-items: baseline; }
    /*
      [IC.F24] La clase va en el ELEMENTO p-select, no en styleClass: asi la regla alcanza
      al host con el encapsulado normal y no hace falta perforar la cascada, que DESIGN.md §S reserva
      para pelear contra vendor. La compuerta de cascada pide que esa deuda BAJE, no que crezca.
    */
    .ic-unidad { display: block; width: 100%; }
    .ic-label:first-child { margin-top: 0; }
    .ic-code-row { display: flex; gap: .5rem; align-items: stretch; }
    .ic-code-row .ic-input-code { flex: 1; }
    :host ::ng-deep .ic-input { font-size: 1.25rem; padding: .8rem .85rem; width: 100%; }
    :host ::ng-deep .ic-input-code { font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; letter-spacing: .02em; }
    :host ::ng-deep .ic-input-qty { text-align: center; font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; font-weight: 700; font-size: 1.5rem; }
    :host ::ng-deep .ic-input:focus-visible { outline: 2px solid var(--action, #f05a28); outline-offset: 1px; }
    :host ::ng-deep .p-inputnumber { width: 100%; }
    /* Steppers neutros y grandes (Fitts) — el ÚNICO naranja es el CTA "Registrar". */
    :host ::ng-deep .p-inputnumber-buttons-horizontal .p-inputnumber-button { min-width: 54px; background: var(--card-bg, #fff); border-color: var(--border-color, #E4E4E7); color: var(--text-main, #09090B); }
    :host ::ng-deep .p-inputnumber-buttons-horizontal .p-inputnumber-button:hover { background: var(--hover-bg, #F4F4F5); color: var(--text-main, #09090B); }
    :host ::ng-deep .ic-scan-btn { min-width: 56px; min-height: 56px; }
    :host ::ng-deep .ic-scan-btn .p-button-icon { font-size: 1.4rem; }

    /* Overlay de cámara — PANTALLA COMPLETA solo mientras escaneás; al cerrar
       devuelve todo el espacio al loop. Es overlay → fixed + safe-area en cancelar. */
    .ic-scan-overlay { position: fixed; inset: 0; z-index: 2000; background: #000; }
    .ic-scan-video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
    .ic-scan-mask { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1rem; padding: 0 1rem; pointer-events: none; }
    .ic-scan-frame { width: min(80%, 360px); aspect-ratio: 5 / 3; border: 3px solid rgba(255,255,255,.92); border-radius: var(--r-md, 12px); box-shadow: 0 0 0 9999px rgba(0,0,0,.45); }
    .ic-scan-hint { margin: 0; color: #fff; font-weight: 600; font-size: .95rem; text-shadow: 0 1px 3px rgba(0,0,0,.7); }
    :host ::ng-deep .ic-scan-cancel { position: absolute; left: 50%; transform: translateX(-50%); bottom: calc(1.5rem + env(safe-area-inset-bottom, 0px)); min-height: 50px; min-width: 170px; background: rgba(255,255,255,.95); color: var(--text-main, #09090B); border: none; box-shadow: 0 4px 16px rgba(0,0,0,.4); }
    :host ::ng-deep .ic-scan-cancel:hover { background: #fff; color: var(--text-main, #09090B); }

    /* Producto reconocido — feedback semántico tokenizado (dark-safe). */
    .ic-prod { display: flex; align-items: center; gap: .6rem; padding: .7rem .85rem; border-radius: var(--r-md, 12px); margin-top: .5rem; }
    .ic-prod i { font-size: 1.4rem; flex-shrink: 0; }
    .ic-prod-loading { background: var(--hover-bg, #F4F4F5); color: var(--text-muted, #52525B); }
    .ic-prod-ok { background: var(--ok-soft-bg, #dcfce7); color: var(--ok-soft-fg, #166534); }
    .ic-prod-ok i { color: var(--ok-fg, #16a34a); }
    .ic-prod-bad { background: var(--bad-soft-bg, #fee2e2); color: var(--bad-soft-fg, #991b1b); }
    .ic-prod-bad i { color: var(--bad-fg, #dc2626); }
    .ic-prod-warn { background: var(--warn-soft-bg, #fef3c7); color: var(--warn-soft-fg, #92400e); }
    .ic-prod-warn i { color: var(--warn-fg, #d97706); }
    .ic-prod-info { display: flex; flex-direction: column; min-width: 0; }
    .ic-prod-name { font-weight: 700; font-size: 1.05rem; line-height: 1.2; color: var(--text-main, #09090B); }
    .ic-prod-meta { font-size: .8rem; color: var(--text-muted, #52525B); font-family: var(--font-mono, monospace); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }

    /*
      [ICR.M6] La cuenta de la conversión. NO es una alarma —se dispararía en cada caja y
      dejaría de significar algo—: es el renglón que se coteja contra la caja en la mano.
      Jerarquía: primario el total en la unidad del teórico (lo que se va a escribir),
      secundario la multiplicación, terciario la instrucción de verificar.
    */
    .ic-conversion { display: flex; flex-direction: column; gap: .15rem; margin-top: .6rem; padding: .6rem .75rem; border: 1px solid var(--border-color, #E4E4E7); border-left-width: 3px; border-radius: var(--r-md, 12px); background: var(--hover-bg, #F4F4F5); }
    .ic-conversion-cuenta { font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; font-size: var(--fs-sm); color: var(--text-muted, #52525B); }
    .ic-conversion-cuenta b { font-size: 1.15rem; font-weight: 700; color: var(--text-main, #09090B); }
    .ic-conversion-verifica { font-size: var(--fs-xs); color: var(--text-muted, #52525B); line-height: 1.35; }

    /* Submit — CTA grande, zona del pulgar. */
    .ic-submit { margin-top: 1rem; width: 100%; }
    :host ::ng-deep .ic-submit { padding: .9rem; font-size: 1.05rem; min-height: 48px; }

    /* Feed de últimos conteos */
    .ic-feed h3 { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .05em; color: var(--text-muted, #52525B); margin: 0 0 .5rem; }
    .ic-feed-row { display: flex; align-items: center; gap: .75rem; padding: .6rem .25rem; border-bottom: 1px solid var(--border-color, #E4E4E7); }
    .ic-feed-row:last-child { border-bottom: none; }
    .ic-feed-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .ic-feed-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-main, #09090B); }
    .ic-feed-sku { font-size: var(--fs-xs); color: var(--text-muted, #52525B); font-family: var(--font-mono, monospace); }
    .ic-feed-qty { font-size: 1.15rem; font-weight: 700; font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; color: var(--text-main, #09090B); }

    @media (prefers-reduced-motion: reduce) {
      .ic-progress-fill { transition: none; }
    }
  `],
})
export class ComercialInventoryCountComponent {
  private readonly svc = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly focus = inject(CountFocusService);
  readonly offline = inject(InventoryOfflineService);

  @ViewChild('codeInput') codeInput?: ElementRef<HTMLInputElement>;
  @ViewChild('qtyInput', { read: ElementRef }) qtyInput?: ElementRef<HTMLElement>;
  @ViewChild('scanVideo') scanVideo?: ElementRef<HTMLVideoElement>;
  @ViewChild('scanCancel', { read: ElementRef }) scanCancel?: ElementRef<HTMLElement>;

  // Escaneo por cámara (ZXing — universal: iOS Safari + Android).
  scanSupported = signal(typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia);
  scanning = signal(false);
  private reader?: BrowserMultiFormatReader;
  private controls?: IScannerControls;

  folios = signal<{ id: string; label: string }[]>([]);
  selectedFolioId = signal<string | null>(null);
  progress = signal<InventoryCounterProgress | null>(null);
  feed = signal<FeedEntry[]>([]);
  submitting = signal(false);
  // Escaneos que el server rechazó (409): visibles para que el contador no crea
  // que sincronizó algo que en realidad nunca llegó al folio.
  discarded = signal<InventoryScanPending[]>([]);
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  // Jornada de conteo: el contador la abre con "Iniciar" y la cierra con
  // "Terminar". Mientras está activa → modo foco (nav oculto, guard al salir).
  sessionActive = signal(false);
  starting = signal(false);
  finishing = signal(false);
  justFinishedPass = signal<number | null>(null);
  currentPass = computed(() => this.progress()?.current_pass ?? 1);

  code = signal<string>('');
  qty = signal<number | null>(null);
  resolved = signal<ProductoResuelto | null>(null);

  /**
   * ⛔⛔ `[IC.F24]` **La unidad en que se cuenta.** Arranca en la del código que viene con el
   * SKU —la nativa, la misma del teórico— y la persona puede cambiarla. `null` cuando el
   * producto no tiene código primario: **no se inventa una**, se declara en pantalla.
   */
  unidad = signal<string | null>(null);

  readonly opcionesDeUnidad = computed<OpcionDeUnidad[]>(() => {
    const us = this.resolved()?.units_available ?? [];
    const nativa = us.find((u) => u.es_nativa)?.unit ?? null;
    return us.map((u) => ({
      unit: u.unit,
      // La nativa se nombra sola; las demás dicen a cuánto equivalen, que es lo que
      // permite elegir sin tener que acordarse del factor.
      etiqueta:
        u.es_nativa || !nativa || u.factor === 1
          ? u.unit
          : `${u.unit} · 1 = ${u.factor} ${nativa}`,
    }));
  });
  /**
   * ⛔⛔ `[ICR.M6]` **La cuenta que se muestra antes de aceptar, cuando se cuenta en cajas.**
   *
   * Un error de una caja son 24 unidades, y **ninguna base de datos sabe cuántas piezas trae
   * la caja que está en el anaquel**: medido en prod el 2026-11-27 para Yurécuaro, 1,905 de
   * 2,024 artículos tienen factor de caja, y donde además hay código de barras de caja (133
   * productos) el factor del catálogo discrepa del del ERP en **123 de 134** comparaciones
   * contra 11 que coinciden. Por eso la multiplicación no se hace a escondidas: se escribe
   * con el factor suelto, que es lo que la persona puede cotejar contra la caja que tiene
   * en la mano.
   *
   * Devuelve `null` —y la pantalla no afirma nada— en los cuatro casos en que no hay cuenta
   * que mostrar: sin cantidad tecleada, contando en la unidad nativa, con factor 1, o
   * **sin unidad nativa conocida** (15 % de los artículos no tienen código primario). Un
   * relleno ahí sería inventar el factor, que es justo el defecto que esto previene.
   *
   * ⚠️ Los tres signals se leen **antes** de llamar a la cuenta: un `computed()` que corta
   * antes de leerlos queda sin esa dependencia y no vuelve a recalcular.
   *
   * La aritmética y sus cinco casos de `null` viven —y se prueban de verdad— en
   * `conteo-cuenta-de-conversion.ts`: esta pantalla no se puede montar en una prueba.
   */
  readonly conversion = computed<CuentaDeConversion | null>(() => {
    const cantidad = this.qty();
    const elegida = this.unidad();
    const unidades = this.resolved()?.units_available ?? [];
    return cuentaDeConversion(cantidad, elegida, unidades);
  });

  /** `[ICR.M5]` Queda algo que no llegó al folio: sin subir, o rechazado. */
  readonly colaSucia = computed(() => this.offline.pending() > 0 || this.discarded().length > 0);

  /**
   * `[ICR.M5]` Productos del folio que este dispositivo tiene descargados. `null` mientras no
   * se midió — **no es cero**: un cero dibujado sin medir sería el defecto que esto previene.
   */
  readonly catalogoLocal = signal<number | null>(null);

  resolving = signal(false);
  notFound = signal(false);

  pct = computed(() => {
    const p = this.progress();
    if (!p || !p.total) return 0;
    return Math.round((p.counted / p.total) * 100);
  });

  // Integridad: detecta si el contador sale de la app / bloquea el celular
  // durante un folio activo y lo registra en la bitácora (auditoría).
  private leftAt: number | null = null;
  private appStateHandle?: PluginListenerHandle;

  constructor() {
    this.loadFolios();
    // `[ICR.M5]` Arranca con la pantalla: lo que quedó sin subir de una jornada anterior se
    // drena solo al volver a entrar, sin que nadie tenga que tocar «Reintentar». El primer
    // intento es inmediato — esperar los 15 s del temporizador es esperar de más cuando la
    // persona acaba de abrir la pantalla justamente a ver si ya subió.
    this.startPeriodicFlush();
    this.retrySync();
    this.destroyRef.onDestroy(() => { this.stopScan(); this.focus.stop(); this.stopPeriodicFlush(); });
    this.setupIntegrityMonitor();
  }

  private setupIntegrityMonitor() {
    const onHidden = () => { if (this.sessionActive()) this.leftAt ??= Date.now(); };
    const onVisibility = () => { document.hidden ? onHidden() : this.flushInterruption('visibility'); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onHidden); // backstop iOS (freeze sin visibilitychange)

    /*
      ⛔ `[ICR.M5]` **Cerrar la app con la cola sucia pregunta primero.**

      Lo capturado NO se pierde —vive en Dexie y se drena al volver a entrar—, pero quien
      cierra la pestaña a media cuenta se va creyendo que entregó lo que contó, y el supervisor
      cierra el folio sin esas filas. La regla operativa del acta es «nadie se va con la cola
      en rojo», y esto es lo que la vuelve ejecutable en el momento exacto en que se rompe.

      ⚠️ El texto lo pone el navegador: desde 2019 ninguno muestra un mensaje propio. Y en la
      app nativa de Capacitor este evento puede no dispararse — ahí el freno es la tarjeta roja
      de «fase terminada» y el candado de la ruta.
    */
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (this.offline.pending() <= 0) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    // Capacitor nativo: más confiable que la web para background/lock en iOS/Android.
    CapApp.addListener('appStateChange', ({ isActive }) => {
      if (!this.sessionActive()) return;
      if (!isActive) this.leftAt ??= Date.now();
      else this.flushInterruption('appstate');
    }).then((h) => (this.appStateHandle = h)).catch(() => { /* web sin plugin nativo */ });

    this.destroyRef.onDestroy(() => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onHidden);
      window.removeEventListener('beforeunload', onBeforeUnload);
      this.appStateHandle?.remove();
    });
  }

  private flushInterruption(source: 'visibility' | 'appstate') {
    const id = this.selectedFolioId();
    if (!id || this.leftAt == null) return;
    const left = this.leftAt;
    this.leftAt = null;
    const seconds = Math.round((Date.now() - left) / 1000);
    if (seconds < 2) return; // ignorar parpadeos (cambio de foco, teclado)
    this.svc.recordInventoryInterruption(id, {
      left_at: new Date(left).toISOString(),
      returned_at: new Date().toISOString(),
      duration_seconds: seconds,
      source,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ error: () => { /* best-effort */ } });
    this.toast.add({
      severity: 'info',
      summary: 'Interrupción registrada',
      detail: `Saliste de la app ${seconds}s — queda en la bitácora del folio.`,
    });
  }

  // ───── Escaneo por cámara (ZXing) ─────
  async startScan() {
    if (!this.scanSupported()) {
      this.toast.add({ severity: 'info', summary: 'Sin acceso a cámara', detail: 'Usa un lector o teclea el código.' });
      return;
    }
    this.scanning.set(true);
    // a11y: foco al botón Cancelar (también habilita Escape para cerrar).
    setTimeout(() => this.scanCancel?.nativeElement?.focus(), 150);
    setTimeout(async () => {
      const v = this.scanVideo?.nativeElement;
      if (!v) return;
      const hints = new Map();
      // Solo los formatos reales de retail → menos trabajo por intento.
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [
        BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
        BarcodeFormat.CODE_128,
      ]);
      // delayBetweenScanAttempts 100ms (default 500) → ~10× más intentos/seg.
      this.reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 100 });
      try {
        this.controls = controlesSiSigueAbierta(await this.reader.decodeFromConstraints(
          { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } },
          v,
          (result) => { if (result) this.onScanned(result.getText()); },
        ), this.scanning());
      } catch {
        this.scanning.set(false);
        this.toast.add({ severity: 'warn', summary: 'No se pudo abrir la cámara', detail: 'Revisa los permisos (requiere HTTPS).' });
      }
    }, 80);
  }

  private onScanned(raw: string) {
    this.code.set(raw.trim());
    if (navigator.vibrate) navigator.vibrate(80);
    this.stopScan();
    this.resolveCode();
    setTimeout(() => {
      const el = this.qtyInput?.nativeElement?.querySelector('input') as HTMLInputElement | null;
      el?.focus(); el?.select();
    }, 60);
  }

  stopScan() {
    this.scanning.set(false);
    detenerLector(this.controls);
    this.controls = undefined;
    this.reader = undefined;
  }

  private loadFolios() {
    // Solo los folios que me tocan: asignado como contador, o folios sin
    // contadores asignados (modo abierto). El backend ya aplica esa regla.
    this.svc.myCountingFolios()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (open: InventoryCount[]) => {
          this.folios.set(open.map((c) => ({
            id: c.id,
            label: `${c.folio} · ${c.warehouse_code ?? ''} ${c.warehouse_name ?? ''}`.trim(),
          })));
          if (open.length === 1) {
            this.selectedFolioId.set(open[0].id);
            this.refreshProgress();
            // `[ICR.M5]` Lo rechazado y el catálogo local se miden al ENTRAR, no al iniciar
            // jornada: si quedó algo de la vez pasada, la persona lo ve sin tocar nada.
            this.refreshDiscarded();
            this.refreshCatalogoLocal();
          }
        },
        error: () => this.toast.add({ severity: 'error', summary: 'No se pudieron cargar los folios' }),
      });
  }

  onFolioChange() {
    this.feed.set([]);
    this.code.set(''); this.qty.set(null);
    this.resolved.set(null); this.notFound.set(false);
    this.sessionActive.set(false);
    this.justFinishedPass.set(null);
    this.focus.stop();
    // `[ICR.M5]` El temporizador NO se apaga al cambiar de folio: la cola es de todos los
    // folios, y lo que quedó sin subir del anterior tiene que seguir subiendo.
    this.refreshProgress();
    this.refreshDiscarded();
    this.refreshCatalogoLocal();
  }

  startCount() {
    const id = this.selectedFolioId();
    if (!id) return;
    this.starting.set(true);
    this.svc.inventoryStartSession(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.starting.set(false);
          this.sessionActive.set(true);
          this.justFinishedPass.set(null);
          this.focus.start();
          this.refreshProgress();
          this.refreshDiscarded();
          this.prefetchCatalog();
          this.startPeriodicFlush();
          this.focusCode();
        },
        error: (e) => {
          this.starting.set(false);
          this.toast.add({ severity: 'warn', summary: 'No se pudo iniciar', detail: e?.error?.message });
        },
      });
  }

  /**
   * ⛔⛔ `[ICR.M5]` **Primero se vacía la cola, después se termina.**
   *
   * El reenvío de un escaneo ya aplicado no duplica (idempotencia por `scan_uuid`), pero una
   * captura **nueva** que sube cuando el folio ya cambió de estado la rechaza el guard de
   * estado con 409 y se descarta: la persona la contó y nunca llegó (E4 del acta del
   * 2026-11-27). Terminar la jornada es exactamente ese cambio de estado, así que la cola se
   * drena **antes** de tocarlo, no después.
   *
   * Si queda algo pendiente —sin red, o el servidor no contesta— **no se niega terminar**:
   * la tarjeta de «fase terminada» lo dice en rojo con su número.
   */
  async finishCount() {
    const id = this.selectedFolioId();
    if (!id) return;
    this.finishing.set(true);
    if (this.offline.pending() > 0 && this.offline.online()) {
      const res = await this.offline.flush();
      if (res.synced) this.refreshProgress();
      if (res.discarded) this.refreshDiscarded();
    }
    this.svc.inventoryFinishSession(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.finishing.set(false);
          this.sessionActive.set(false);
          this.focus.stop();
          this.stopScan();
          // `[ICR.M5]` El drenado sigue corriendo: terminar la jornada no termina la cola.
          this.justFinishedPass.set(r.pass ?? this.currentPass());
          this.refreshDiscarded();
        },
        error: (e) => {
          this.finishing.set(false);
          this.toast.add({ severity: 'warn', summary: 'No se pudo terminar', detail: e?.error?.message });
        },
      });
  }

  private refreshProgress() {
    const id = this.selectedFolioId();
    if (!id) return;
    this.svc.inventoryCountProgress(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (p) => this.progress.set(p) });
  }

  private refreshDiscarded() {
    const id = this.selectedFolioId();
    if (!id) { this.discarded.set([]); return; }
    this.offline.discardedFor(id).then((d) => this.discarded.set(d)).catch(() => { /* best-effort */ });
  }

  /** `[ICR.M5]` Mide si este dispositivo trae el catálogo del folio descargado. */
  private refreshCatalogoLocal() {
    const id = this.selectedFolioId();
    if (!id) { this.catalogoLocal.set(null); return; }
    this.offline.catalogCountFor(id)
      .then((n) => this.catalogoLocal.set(n))
      .catch(() => this.catalogoLocal.set(null)); // no se pudo medir → no se dibuja un cero
  }

  /** Pre-cachea el catálogo del folio (blind-safe) al iniciar la jornada con red,
   *  para que el primer escaneo offline de un SKU del folio se reconozca sin red. */
  private prefetchCatalog() {
    const id = this.selectedFolioId();
    // ⛔ `[ICR.M5]` Sin red no hay descarga, y eso **se mide y se dice**: quien llega a la
    // sucursal con el teléfono ya sin señal no puede reconocer ni un código, y hasta hoy se
    // enteraba escaneando. No se fuerza la descarga —no hay cómo—: se declara.
    if (!id || !this.offline.online()) { this.refreshCatalogoLocal(); return; }
    this.svc.inventoryCounterCatalog(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (rows) => this.offline.cacheFolioCatalog(id, rows.map((r) => ({
          barcode: r.barcode ?? '',
          product_id: r.product_id ?? null,
          sku: r.sku ?? null,
          product_name: r.product_name ?? null,
          location: r.location ?? null,
        }))).then(() => this.refreshCatalogoLocal()).catch(() => this.refreshCatalogoLocal()),
        error: () => this.refreshCatalogoLocal(), // best-effort; el lazy-cache cubre lo escaneado online
      });
  }

  /** Reintento manual de la cola (los fallos transitorios no se reintentan solos
   *  sin un nuevo escaneo ni hasta reconectar). */
  retrySync() {
    this.offline.flush().then((res) => {
      if (res.synced) this.refreshProgress();
      if (res.discarded) this.refreshDiscarded();
    });
  }

  /**
   * Drena la cola cada 15s: cubre fallos transitorios (5xx/timeout) que dejarían pendientes
   * sin un nuevo escaneo que dispare el flush.
   *
   * ⛔ `[ICR.M5]` **Mientras la pantalla esté abierta, no mientras dure la jornada.** Corría
   * sólo con `sessionActive()` y se apagaba al terminar, que es justo cuando quedan los
   * pendientes que nadie va a reintentar: la cola se congelaba en rojo y el único camino era
   * que alguien tocara «Reintentar». Ahora el único freno es el de siempre —hay red y hay
   * pendientes—, y el temporizador muere con el componente.
   */
  private startPeriodicFlush() {
    this.stopPeriodicFlush();
    this.flushTimer = setInterval(() => {
      if (this.offline.online() && this.offline.pending() > 0) {
        this.offline.flush().then((res) => {
          if (res.synced) this.refreshProgress();
          if (res.discarded) this.refreshDiscarded();
        });
      }
      // `[ICR.M5]` Si la jornada arrancó sin red, el catálogo quedó en cero y nadie lo iba a
      // descargar nunca. En cuanto vuelve la señal se baja solo, sin pedirle nada a nadie.
      if (this.sessionActive() && this.offline.online() && this.catalogoLocal() === 0) {
        this.prefetchCatalog();
      }
    }, 15000);
  }

  private stopPeriodicFlush() {
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
  }

  onCodeEnter() {
    if (!this.code()) return;
    this.resolveCode();
    // El lector mandó Enter tras el código → saltar a cantidad.
    const el = this.qtyInput?.nativeElement?.querySelector('input') as HTMLInputElement | null;
    el?.focus();
    el?.select();
  }

  /** Resuelve el código a un producto. Online: cachea para offline (lazy).
   *  Offline / falla: cae al cache local. Si no hay nada, igual se puede
   *  registrar por barcode (se resuelve en el server al sincronizar). */
  private resolveCode() {
    const barcode = this.code().trim();
    const id = this.selectedFolioId();
    if (!barcode) { this.resolved.set(null); this.notFound.set(false); return; }
    this.resolving.set(true);
    this.notFound.set(false);
    this.resolved.set(null);
    this.svc.resolveInventoryProduct(barcode)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (p) => {
          this.resolved.set(p);
          // `[IC.F24]` Por defecto, la del código que trae el SKU.
          this.unidad.set(p?.unit_default ?? null);
          this.resolving.set(false);
          if (id) this.offline.cacheProduct(id, {
            barcode, product_id: p.product_id ?? null, sku: p.sku ?? null,
            product_name: p.product_name ?? null, location: p.location ?? null,
          });
        },
        error: async () => {
          if (id) {
            const c = await this.offline.resolveLocal(id, barcode);
            if (c) {
              this.resolved.set({ product_id: c.product_id, sku: c.sku, product_name: c.product_name, location: c.location } as ResolvedProduct);
              this.resolving.set(false);
              return;
            }
          }
          this.resolving.set(false);
          this.notFound.set(true);
          this.devolverFocoAlCodigo();
        },
      });
  }

  onQtyKey(event: KeyboardEvent) {
    if (event.key === 'Enter') this.submit();
  }

  /**
   * `[IC.F7]` **Si el catálogo no reconoció el código, el foco VUELVE al código.**
   *
   * El gesto manda el foco a Cantidad apenas se escanea, porque eso es lo que sigue el 99 % de
   * las veces. Cuando el código no existe no sigue nada: con una pistola —que manda Enter sola—
   * el siguiente disparo entra **como cantidad**, y el operario mira la tarima, no la pantalla.
   * Medido el 2026-11-26: tras `NOEXISTE12345`, el código `00203` quedó como cantidad **203**.
   *
   * Dos condiciones para no arrebatarle el foco a nadie: sólo si la cantidad **sigue vacía** y
   * sólo si quien lo tiene es el campo de cantidad.
   *
   * ⛔ Y sólo **con red**: sin conexión «no reconocido» significa «todavía no lo sé» —el conteo
   * por código de barras es válido y se identifica al subir—, así que ahí el foco se queda donde
   * está y el gesto sigue.
   */
  private devolverFocoAlCodigo() {
    if (!this.offline.online()) return;
    if (this.qty() !== null && this.qty() !== undefined) return;
    const campo = this.qtyInput?.nativeElement?.querySelector('input');
    if (campo && document.activeElement !== campo) return;
    this.focusCode();
  }

  /** Offline-first: el conteo se PERSISTE local primero (cero pérdida) + feed
   *  optimista; luego se sincroniza best-effort. El motor reintenta al reconectar
   *  e idempotencia server-side (scan_uuid) evita duplicados en el replay. */
  async submit() {
    const id = this.selectedFolioId();
    const barcode = this.code().trim();
    const quantity = this.qty();
    if (!id || !barcode || quantity === null || quantity === undefined) return;

    this.submitting.set(true);
    const r = this.resolved();
    const productId = r?.product_id ?? null;
    const capturePass = this.currentPass();
    const scanUuid = this.offline.newScanUuid();

    // 1) Local primero — el escaneo nunca se pierde aunque no haya red.
    await this.offline.queueScan({
      scan_uuid: scanUuid, count_id: id,
      product_id: productId, barcode: productId ? null : barcode,
      // `[IC.F24]` Viaja con el escaneo: un conteo hecho sin red llega con su unidad.
      quantity, unit: this.unidad(), capture_pass: capturePass,
    });
    // 2) Feed optimista (el server confirma el slot real al sincronizar).
    this.feed.update((f) => [
      { sku: r?.sku ?? null, name: r?.product_name ?? barcode, qty: quantity, slot: `count_${capturePass}`, ts: new Date() },
      ...f,
    ].slice(0, 15));
    // 3) Limpiar para el próximo escaneo — no esperamos a la red.
    this.code.set('');
    this.qty.set(null);
    this.resolved.set(null);
    this.unidad.set(null);
    this.notFound.set(false);
    this.submitting.set(false);
    this.focusCode();
    // 4) Sincronizar best-effort; refresca el avance si subió algo.
    this.offline.flush().then((res) => {
      if (res.synced) this.refreshProgress();
      if (res.discarded) this.refreshDiscarded();
    });
  }

  private focusCode() {
    setTimeout(() => {
      this.codeInput?.nativeElement?.focus();
      this.codeInput?.nativeElement?.select();
    }, 50);
  }

  slotLabel(slot: string): string {
    if (slot === 'count_1') return '1er conteo';
    if (slot === 'count_2') return '2do conteo';
    return 'reconteo';
  }
}
