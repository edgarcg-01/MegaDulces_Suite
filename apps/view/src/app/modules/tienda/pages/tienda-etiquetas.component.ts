import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, ViewChild, ViewEncapsulation, afterNextRender, computed, effect, inject, signal, viewChild } from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MultiSelectModule } from 'primeng/multiselect';
import { AutoCompleteModule, AutoCompleteCompleteEvent, AutoCompleteSelectEvent } from 'primeng/autocomplete';
import { InputNumberModule } from 'primeng/inputnumber';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { TextareaModule } from 'primeng/textarea';
import { LabelComponent, LabelModel, LabelSections, HeroKey, FUENTES_USABLES } from '../components/label.component';
import { EtiquetasService, Freshness, FreshnessStatus, SearchHit } from '../etiquetas.service';
// `[TDA.1]` El aviso en vivo de que un precio cambió en Kepler.
import { StoreSocketService, type LabelPricesChanged } from '../store-socket.service';

/** `freshness` = la edad del precio en el momento en que ESTE ítem se resolvió. Viaja con él. */
interface QueueItem { model: LabelModel; copies: number; hero: HeroKey; freshness: Freshness | null; }
interface SheetLabel { model: LabelModel; hero: HeroKey; }
type Msg = { text: string; kind: 'info' | 'ok' | 'error' | 'warn' };

/**
 * Orden de gravedad del veredicto de frescura. `unknown` pesa más que `fresh` a propósito: "no
 * pude medir" no es "está al día" (ADR-056), y menos que `stale`, que sí tiene una edad que mostrar.
 */
const RANGO_FRESCURA: Record<FreshnessStatus, number> = { stale: 2, unknown: 1, fresh: 0 };

/**
 * La PEOR frescura de un conjunto; entre iguales, la de dato más viejo (`data_as_of` nulo cuenta
 * como el más viejo). Es lo que pinta el banner: antes se pisaba con cada `resolve`, así que un
 * lote agregado con rezago seguía en la cola después de que un escaneo fresco apagaba el aviso.
 */
function worstFreshness(list: (Freshness | null | undefined)[]): Freshness | null {
  let peor: Freshness | null = null;
  for (const f of list) {
    if (!f) continue;
    if (!peor) { peor = f; continue; }
    const d = RANGO_FRESCURA[f.status] - RANGO_FRESCURA[peor.status];
    if (d > 0 || (d === 0 && (f.data_as_of ?? '') < (peor.data_as_of ?? ''))) peor = f;
  }
  return peor;
}

/**
 * Etiquetera (proyecto Tienda). Arma una cola de etiquetas (buscar en catálogo o pegar lista
 * de códigos) e imprime en hoja Carta horizontal; etiqueta de **82×35 mm**, 15 por hoja.
 *
 * ⚠️ Este encabezado y el texto de la pantalla decían "tamaño físico 100×40 mm" mientras el CSS
 * de `label.component` imprimía **115×40** — 15 mm más ancho que el material que declaraba. Al
 * reducir a 82×35 se corrigieron las dos cosas a la vez, y el número de la hoja pasó de 8 a 15.
 *
 * Vista de hoja: se dibuja a tamaño real y se escala al espacio disponible (fitSheet). Al bajar
 * la etiqueta a 82×35 mm, la caja fija de 500 px que había dejaba el precio en ~10 px de alto y
 * el operador ya no podía leer en pantalla lo que estaba por imprimir. Hoy la hoja es la columna
 * ancha del workspace y la carga masiva se pliega: ese alto es el que la hoja necesitaba.
 *
 * Impresión: se renderiza la hoja fuera de pantalla (para que auto-ajuste el nombre y dibuje
 * los barcodes), luego se clona a un IFRAME aislado con su propio `@page` (Carta horizontal,
 * margen 8 mm) y color forzado. Chrome no respeta `@page` de estilos inyectados por Angular en
 * runtime; el iframe sí.
 *
 * UI sobre el design system "Mercado" (surface Operations): PrimeNG + tokens, quiet-luxury.
 * `ViewEncapsulation.None` es intencional — el clon de estilos al iframe necesita los estilos
 * globales del `<app-label>`; las clases van con prefijo `.etqp-*` para evitar colisiones.
 */
@Component({
  selector: 'app-tienda-etiquetas',
  standalone: true,
  imports: [CommonModule, FormsModule, MultiSelectModule, AutoCompleteModule, InputNumberModule, ButtonModule, TableModule, SelectModule, TextareaModule, LabelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styles: [`
    app-tienda-etiquetas { display: block; }

    .etqp-screen{ padding: var(--sp-5) var(--sp-6); display:flex; flex-direction:column; gap: var(--sp-5);
      color: var(--text-main); }

    /* ── Page head ─────────────────────────────────────────── */
    .etqp-head{ display:flex; align-items:center; gap: var(--sp-4); flex-wrap:wrap; }
    .etqp-title{ margin:0; margin-right:auto; }
    .etqp-title h1{ margin:0; font-size:1.125rem; font-weight:700; letter-spacing:-0.01em; line-height:1.2; }
    .etqp-title p{ margin:.1rem 0 0; font-size: var(--fs-xs,.72rem); color: var(--text-faint); }
    /* Marca de diagnóstico: discreta cuando todo está bien, imposible de ignorar cuando no. */
    .etqp-diag.ok{ color: var(--ok-fg); }
    .etqp-diag.bad{ color: var(--bad-soft-fg); background: var(--bad-soft-bg); font-weight:700;
      padding:1px .4rem; border-radius: var(--r-sm); }
    .etqp-head .p-multiselect{ min-width: 15rem; }

    /* ── Mensaje / banner ──────────────────────────────────── */
    .etqp-msg{ display:flex; align-items:center; gap:.6rem; padding:.6rem .75rem; border-radius: var(--r-sm);
      font-size: var(--fs-sm,.85rem); border:1px solid var(--info-soft-bg); background: var(--info-soft-bg); color: var(--info-soft-fg); }
    .etqp-msg.is-ok{ border-color: var(--ok-soft-bg); background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .etqp-msg.is-warn{ border-color: var(--warn-soft-bg); background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .etqp-msg.is-error{ border-color: var(--bad-soft-bg); background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .etqp-msg > span{ flex:1; }

    /* OBS.6.2 — rezago del precio. Usa los tokens 'warn' igual que el resto de la pantalla: es un
       "cuidado con este dato", no un error. Sin botón de cerrar a propósito — no es un mensaje de
       una accion, es una condicion del dato que sigue siendo verdad hasta que el feed se ponga al dia. */
    .etqp-stale{ display:flex; align-items:flex-start; gap:.6rem; padding:.6rem .75rem;
      border-radius: var(--r-sm); font-size: var(--fs-sm,.85rem);
      border:1px solid var(--warn-soft-bg); background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .etqp-stale > div{ display:flex; flex-direction:column; gap:.15rem; }
    .etqp-stale strong{ font-weight:600; }
    .etqp-stale span{ opacity:.85; font-size: var(--fs-xs,.72rem); }

    /* [TDA.1] El precio de algo en la cola cambio en Kepler, en vivo.
       Deliberadamente INFO y no warn: no es que el precio este mal, es que hay uno mas nuevo y
       aca esta el boton. El aviso de rezago (warn, arriba) dice otra cosa -- "no se sabe si esto
       es vigente" -- y mezclar los dos colores borraria la diferencia. */
    .etqp-changed{ display:flex; align-items:center; gap:.6rem; padding:.6rem .75rem;
      border-radius: var(--r-sm); font-size: var(--fs-sm,.85rem);
      border:1px solid var(--info-soft-bg, var(--action-ring)); background: var(--info-soft-bg, var(--action-ring));
      color: var(--info-soft-fg, var(--text-main)); }
    .etqp-changed > i{ font-size:1.05rem; }
    .etqp-changed > div{ display:flex; flex-direction:column; gap:.15rem; flex:1; min-width:0; }
    .etqp-changed strong{ font-weight:600; }
    .etqp-changed span{ opacity:.85; font-size: var(--fs-xs,.72rem); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    /* La fila que cambio, marcada en la tabla: el banner dice cuantas, esto dice cuales. */
    .etqp-row-changed{ box-shadow: inset 3px 0 0 var(--action); }

    /* ── Escaneo rápido (pistola): auto-agrega al Enter ──────
       §14 Mostrador/POS: campo de captura keyboard-first, sin borde propio (el borde/foco
       lo lleva la barra vía :focus-within). Input nativo intencional (no p-inputText) para
       no romper el look borderless de la scanbar; lleva aria-label y foco permanente. */
    .etqp-scanbar{ display:flex; align-items:center; gap:.6rem; padding:.5rem .75rem; border:1px solid var(--border-color);
      border-radius: var(--r-md); background: var(--card-bg); transition: border-color .12s ease, box-shadow .12s ease; }
    .etqp-scanbar:focus-within{ border-color: var(--action); box-shadow: 0 0 0 3px var(--action-ring); }
    .etqp-scanbar > i{ color: var(--action); font-size:1.1rem; }
    .etqp-scan-input{ flex:1; min-width:0; border:0; background:transparent; color: var(--text-main);
      font-family: var(--font-mono); font-size: var(--fs-md,.9375rem); padding:.35rem .1rem; }
    .etqp-scan-input:focus{ outline:none; }
    .etqp-scan-hint{ font-size: var(--fs-xs,.72rem); color: var(--text-faint); white-space:nowrap; }
    @media (max-width: 640px){ .etqp-scan-hint{ display:none; } }

    /* ── Entrada ────────────────────────────────────────────
       Tres formas de agregar, con el peso que cada una tiene en el mostrador. La pistola manda
       (scanbar, arriba) y el buscador la acompaña EN LA MISMA LÍNEA; la carga masiva se pliega.
       No se retira —sirve para el cambio de precios de temporada— pero tenerla siempre abierta
       costaba una tarjeta entera de alto, y ese alto es justo el que le faltaba a la hoja. */
    .etqp-add{ display:flex; align-items:center; gap: var(--sp-3); flex-wrap:wrap; }
    .etqp-add .etqp-ac{ flex:1 1 20rem; max-width:32rem; }
    .etqp-add .etqp-addlbl{ font-size: var(--fs-xs,.72rem); font-weight:500; text-transform:uppercase;
      letter-spacing:.06em; color: var(--text-faint); white-space:nowrap; }
    .etqp-card{ border:1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); padding: var(--sp-4); }
    .etqp-card > label{ display:block; font-size: var(--fs-xs,.72rem); font-weight:500; text-transform:uppercase; letter-spacing:.06em;
      color: var(--text-faint); margin-bottom:.5rem; }
    .etqp-ac{ display:block; width:100%; }
    .etqp-hit{ display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:.1rem 0; }
    .etqp-hit .nm{ font-size: var(--fs-sm,.85rem); color: var(--text-main); }
    .etqp-hit .sku{ font-family: var(--font-mono); font-size: var(--fs-xs,.72rem); color: var(--text-faint); }
    .etqp-empty-hit{ padding:.5rem .25rem; color: var(--text-muted); font-size: var(--fs-sm,.85rem); }

    .etqp-ta{ width:100%; min-height:84px; resize:vertical; padding:.55rem .7rem; border:1px solid var(--border-color);
      border-radius: var(--r-sm); background: var(--card-bg); color: var(--text-main);
      font-family: var(--font-mono); font-size: var(--fs-sm,.85rem); transition: border-color .12s ease, box-shadow .12s ease; }
    .etqp-ta:focus{ outline:none; border-color: var(--action); box-shadow: 0 0 0 3px var(--action-ring); }
    .etqp-bulk-actions{ margin-top:.6rem; display:flex; gap:.6rem; align-items:center; flex-wrap:wrap; }
    .etqp-warn{ color: var(--warn-soft-fg); font-size: var(--fs-xs,.72rem); }

    /* ── Workspace: cola (tabla) + hoja ─────────────────────
       La hoja manda: es lo que hay que PODER LEER antes de gastar papel. Antes su columna era un
       ancho fijo de 500 px y la tabla se quedaba con todo lo demás; con la etiqueta a 82x35 mm
       (era 115x40) eso dejaba el precio en unos 10 px de alto — ilegible en pantalla. Ahora la
       tabla se queda con lo justo para operar y la hoja con el resto. */
    .etqp-work{ display:grid; grid-template-columns: minmax(420px, 1fr) minmax(0, 1.5fr); gap: var(--sp-5); align-items:start; }
    @media (max-width: 1100px){ .etqp-work{ grid-template-columns: 1fr; } }

    .etqp-tablewrap{ min-width:0; }
    .etqp-tcap{ display:flex; align-items:center; gap:.6rem; }
    .etqp-tcap .lbl{ font-size: var(--fs-sm,.85rem); font-weight:600; color: var(--text-main); }
    .etqp-tcap .count{ font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-xs,.72rem);
      color: var(--text-faint); margin-right:auto; }
    .etqp-qname{ display:flex; flex-direction:column; gap:.1rem; min-width:0; }
    .etqp-qname .nm{ font-size: var(--fs-sm,.85rem); color: var(--text-main); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .etqp-qname .sku{ font-family: var(--font-mono); font-size: var(--fs-xs,.72rem); color: var(--text-faint); }
    .etqp-num{ font-variant-numeric: tabular-nums; }
    /* Selector de precio grande por ticket (hero dinámico) — p-select. */
    .etqp-hero-sel{ width:100%; max-width: 12rem; }
    td.etqp-cnum, th.etqp-cnum{ text-align:right; white-space:nowrap; }
    td.etqp-cact, th.etqp-cact{ text-align:right; width:2.5rem; }

    /* Simulación de hoja Carta con líneas de recorte por etiqueta.
       §12b: los #fff/#888 aquí son LITERALES legítimos — representan la hoja de papel
       física (blanca en ambos temas) y la línea de recorte impresa; no deben tokenizarse. */
    .etqp-sheetpanel{ position:sticky; top: var(--sp-4); display:flex; flex-direction:column; gap:.5rem; }
    .etqp-sheethead{ display:flex; align-items:center; gap:.5rem; min-height:1.75rem;
      font-size: var(--fs-xs,.72rem); font-weight:600; text-transform:uppercase; letter-spacing:.06em;
      color: var(--text-faint); font-variant-numeric: tabular-nums; }
    .etqp-sheethead > span:first-child{ flex:1; }
    /* Pasar de hoja en la vista previa: antes sólo se veía la 1 y con una cola grande no había
       cómo revisar la última antes de imprimir. */
    .etqp-pager{ display:flex; align-items:center; gap:.1rem; }
    .etqp-cuthint{ font-size: var(--fs-xs,.72rem); color: var(--text-faint); }
    /* Regla de medición: ancho de la columna SIN depender del tamaño de la hoja. Medir la caja
       misma sería un lazo (la caja mide lo que el zoom decide, y el zoom sale de lo que mide). */
    .etqp-ruler{ width:100%; height:0; }
    /* La hoja se dibuja a tamaño real (279x216 mm) y se ESCALA. la variable --etqp-k la calcula fitSheet()
       contra el ancho disponible y el alto de la ventana: la hoja entera visible, y lo más grande
       que quepa. El 0.474 fijo de antes estaba atado a una caja de 500 px — en una pantalla
       grande tiraba a la basura la mitad del espacio. El valor del CSS es sólo el arranque. */
    .etqp-sheetbox{ width: calc(279mm * var(--etqp-k, .474)); height: calc(216mm * var(--etqp-k, .474));
      max-width:100%; overflow:hidden; border:1px solid var(--border-color);
      border-radius: var(--r-sm); background:#fff; /* papel */ }
    .etqp-sheet{ width:279mm; height:216mm; padding:8mm; box-sizing:border-box; background:#fff; /* papel */
      transform: scale(var(--etqp-k, .474)); transform-origin:top left; text-align:center; font-size:0; }
    .etqp-sheet app-label{ display:inline-block; vertical-align:top; margin:2mm; }
    .etqp-sheet app-label .etq-label{ border-radius:0 !important; outline:.3mm dashed #888; /* recorte impreso */ }

    /* ── Empty state (Operations) ──────────────────────────── */
    .etqp-empty{ display:flex; flex-direction:column; align-items:center; text-align:center; gap:.4rem;
      padding: var(--sp-8) var(--sp-6); border:1px dashed var(--border-color); border-radius: var(--r-md); color: var(--text-muted); }
    .etqp-empty i{ font-size:1.75rem; color: var(--text-faint); margin-bottom:.25rem; }
    .etqp-empty h2{ margin:0; font-size: var(--fs-md,.9375rem); font-weight:600; color: var(--text-main); }
    .etqp-empty p{ margin:0; font-size: var(--fs-sm,.85rem); max-width:42ch; }

    /* Hoja fuente: fuera de pantalla PERO con layout (para auto-fit del nombre + barcodes).
       No se imprime desde aquí; se clona a un iframe aislado. */
    .etqp-print{ position:fixed; left:-100000px; top:0; width:82mm; }

    /* HOTFIX tablets — varios navegadores (Safari/iPadOS, WebViews de Android) ignoran
       iframe.contentWindow.print() y mandan a imprimir el DOCUMENTO PRINCIPAL: salía toda
       la pantalla de la app en vez de las etiquetas. Esta copia cuelga del <body>, nunca se
       ve en pantalla, y en @media print es lo ÚNICO que queda en pie. En el camino bueno
       (el iframe sí imprime) estas reglas ni se evalúan: el documento impreso es el otro.
       El tamaño de hoja NO se fija acá: estos estilos son globales (encapsulation None) y le
       cambiarían el papel al resto de la app. Va en un <style> temporal que se inyecta al
       imprimir y se quita al terminar (ver printIsolated). */
    .etqp-print-fallback{ display:none; }
    @media print{
      body.etqp-printing > *:not(.etqp-print-fallback){ display:none !important; }
      body.etqp-printing .etqp-print-fallback{ display:block !important; text-align:center; font-size:0; }
      body.etqp-printing .etqp-print-fallback app-label{ display:inline-block; vertical-align:top;
        break-inside:avoid; page-break-inside:avoid; margin:2mm; }
      body.etqp-printing .etqp-print-fallback .etq-label{ border-radius:0 !important; outline:.3mm dashed #888; }
      body.etqp-printing *{ -webkit-print-color-adjust:exact !important; print-color-adjust:exact !important; }
    }

    @media (prefers-reduced-motion: reduce){
      .etqp-ta, .etqp-scanbar{ transition:none; }
    }
  `],
  template: `
    <div class="etqp-screen">
      <div class="etqp-head">
        <div class="etqp-title">
          <h1>Etiquetas de anaquel</h1>
          <p>Arma la cola e imprime en hoja Carta · etiqueta 82×35&nbsp;mm · 15 por hoja
            <!-- Diagnóstico visible: dice si ESTE equipo tiene cargada la protección de
                 impresión. Sin esto, "no imprime bien" y "está corriendo el bundle viejo"
                 se ven idénticos, y el service worker puede dejar una tablet meses atrás.
                 Se resuelve mirando la pantalla, sin consola. -->
            @if (printGuard() === 'ok') {
              <span class="etqp-diag ok" title="Este equipo tiene cargada la protección de impresión aislada.">· impresión aislada ✓</span>
            } @else {
              <span class="etqp-diag bad" title="Este equipo está corriendo una versión vieja de la app: al imprimir va a salir toda la pantalla. Cierra el navegador por completo y vuelve a abrir.">· versión vieja — al imprimir sale toda la pantalla ✗</span>
            }
            <!-- Qué equipo es y con qué tipografía se está midiendo. Con esto, un reporte de
                 "el precio salió de otro tamaño" se contesta con una foto de la pantalla en vez
                 de adivinar. La fuente importa: medir con la de respaldo deja el precio hasta
                 17% más chico, y depende de si ESTA máquina alcanza fonts.googleapis.com. -->
            @if (navegador) { <span class="etqp-diag" title="Navegador de este equipo. Úsalo al reportar.">· {{ navegador }}</span> }
            @switch (fuenteEtiqueta()) {
              @case ('respaldo') {
                <span class="etqp-diag bad" title="Este equipo no pudo cargar la tipografía Anton (fonts.googleapis.com). La etiqueta se mide e imprime con la de respaldo, y los tamaños salen distintos de los de un equipo con internet. Revisa la salida a internet de esta máquina.">· tipografía de respaldo — los tamaños salen distintos ⚠</span>
              }
              @case ('sin_medir') {
                <span class="etqp-diag" title="Este navegador no permite verificar la tipografía; los tamaños pueden no coincidir con otros equipos.">· tipografía sin verificar</span>
              }
              @case ('anton') { <span class="etqp-diag ok" title="Tipografía de la etiqueta cargada: los tamaños son los definitivos.">· tipografía ✓</span> }
            }
          </p>
        </div>
        <p-multiselect [options]="sectionOptions" [ngModel]="sections()" (ngModelChange)="sections.set($event)"
          optionLabel="label" optionValue="value" [showToggleAll]="true" [filter]="false"
          placeholder="Secciones a mostrar" selectedItemsLabel="{0} secciones"
          ariaLabel="Secciones visibles de la etiqueta" [style]="{ minWidth: '15rem' }"></p-multiselect>
        <p-button [label]="printBtnLabel()" icon="pi pi-print" [loading]="printing()"
          [disabled]="!totalLabels()" (onClick)="print()"></p-button>
      </div>

      @if (msg(); as m) {
        <div class="etqp-msg" role="alert"
             [class.is-ok]="m.kind === 'ok'" [class.is-warn]="m.kind === 'warn'" [class.is-error]="m.kind === 'error'">
          <i class="pi" [ngClass]="msgIcon(m.kind)"></i>
          <span>{{ m.text }}</span>
          <p-button icon="pi pi-times" [text]="true" [rounded]="true" size="small" (onClick)="msg.set(null)" ariaLabel="Cerrar aviso"></p-button>
        </div>
      }

      <!--
        [OBS.6.2] El precio declara su edad. Va ARRIBA del escáner y no se puede cerrar: es una
        condición del dato, no un mensaje de una acción. El 27-ago esta pantalla imprimió seis días
        de precios viejos — uno 54% bajo costo — sin nada que mirar. No bloquea: informa.

        [VP.0.1] Dos avisos, no uno. "Viejo" tiene una edad que mostrar; "no se pudo medir" no la
        tiene, y con un solo bloque salía el texto roto "El precio puede estar viejo — de rezago".
        Peor: antes del fix el caso no-medido llegaba con stale:false y acá NO se pintaba nada,
        o sea la pantalla afirmaba frescura por silencio. Son problemas distintos y se dicen
        distinto — el ERP no reporta, o nosotros no pudimos preguntar.
        (Sin acentos graves acá adentro: el template es un literal y NG5002 tumba el build.)
      -->
      @if (freshness(); as f) {
        @if (f.status === 'stale') {
          <div class="etqp-stale" role="status">
            <i class="pi pi-clock"></i>
            <div>
              <strong>El precio puede estar viejo — {{ f.age_human }} de rezago.</strong>
              <span>
                @for (i of staleInputs(); track i.key) {
                  {{ i.label }}: {{ i.age_human || 'sin señal' }}{{ $last ? '' : ' · ' }}
                }
              </span>
            </div>
          </div>
        } @else if (f.status === 'unknown') {
          <div class="etqp-stale" role="status">
            <i class="pi pi-question-circle"></i>
            <div>
              <strong>No se pudo verificar qué tan actual es este precio.</strong>
              <span>
                @if (staleInputs().length) {
                  @for (i of staleInputs(); track i.key) {
                    {{ i.label }}: {{ i.age_human || 'sin señal' }}{{ $last ? '' : ' · ' }}
                  }
                } @else {
                  Falló la medición de frescura. El precio puede estar al día o no — confirmalo
                  antes de imprimir.
                }
              </span>
            </div>
          </div>
        }
      }

      <!--
        [TDA.1] El precio de algo que ya esta en la cola cambio en Kepler, en vivo.

        Es un aviso ACCIONABLE y no un reemplazo automatico: si la fila se actualizara sola,
        alguien parado frente a la impresora veria cambiar el numero bajo los pies y no sabria si
        imprimio el viejo o el nuevo. El operador decide, igual que con el aviso de rezago.

        Cuando el aviso viene recortado (cambio masivo de catalogo) NO se puede decir cuales
        cambiaron: se dice eso, y el boton refresca toda la cola. Una lista parcial presentada como
        completa daria por buenas las filas que no aparecen.
      -->
      @if (cambiadosEnCola().length || avisoTruncado()) {
        <div class="etqp-changed" role="status">
          <i class="pi pi-sync"></i>
          <div>
            @if (avisoTruncado()) {
              <strong>Cambiaron precios en Kepler (cambio masivo).</strong>
              <span>No se puede decir cuales de tu cola: conviene actualizar todo antes de imprimir.</span>
            } @else {
              <strong>
                {{ cambiadosEnCola().length }}
                {{ cambiadosEnCola().length === 1 ? 'etiqueta de tu cola cambio' : 'etiquetas de tu cola cambiaron' }}
                de precio en Kepler.
              </strong>
              <span>{{ nombresCambiados() }}</span>
            }
          </div>
          <p-button size="small" [text]="true" icon="pi pi-refresh"
            [label]="refrescando() ? 'Actualizando...' : 'Actualizar'"
            [disabled]="refrescando()" (onClick)="refrescarPrecios()" />
        </div>
      }

      <div class="etqp-scanbar">
        <i class="pi pi-qrcode"></i>
        <input #scanInput type="text" inputmode="numeric" autocomplete="off" autofocus
          class="etqp-scan-input" aria-label="Escanear o teclear código de producto"
          placeholder="Escanea con la pistola o teclea el código y Enter…"
          (keyup.enter)="onScan(scanInput.value); scanInput.value=''" />
        <span class="etqp-scan-hint">5 díg = SKU · 8/12/13 = código de barras · se agrega solo</span>
      </div>

      <!--
        El buscador va en línea con la pistola, no en una tarjeta aparte: es el camino de todos
        los días. La carga masiva vive detrás de un botón — se usa muy poco (cambio de precios de
        temporada) y abierta se comía una tarjeta entera de alto que le hacía falta a la hoja.
        Sigue completa: mismo textarea, mismo addBulk(), mismo aviso de no encontrados.
      -->
      <div class="etqp-add">
        <span class="etqp-addlbl" id="etqp-searchlbl">Buscar en catálogo</span>
        <p-autocomplete inputId="etqp-search" styleClass="etqp-ac" [(ngModel)]="acSelected"
          [suggestions]="results()" (completeMethod)="searchAc($event)" (onSelect)="onPick($event)"
          optionLabel="name" [delay]="250" [minQueryLength]="2" [showClear]="true" appendTo="body"
          ariaLabelledBy="etqp-searchlbl" placeholder="Nombre, SKU o código de barras…">
          <ng-template let-h #item>
            <div class="etqp-hit"><span class="nm">{{ h.name }}</span><span class="sku">{{ h.sku }}</span></div>
          </ng-template>
          <ng-template #empty><div class="etqp-empty-hit">Sin coincidencias</div></ng-template>
        </p-autocomplete>
        <p-button [label]="bulkOpen() ? 'Ocultar lista' : 'Pegar lista'"
          [icon]="bulkOpen() ? 'pi pi-chevron-up' : 'pi pi-list'" [text]="true" severity="secondary" size="small"
          (onClick)="toggleBulk()"></p-button>
        @if (!bulkOpen() && notFound().length) { <span class="etqp-warn">No encontrados: {{ notFound().join(', ') }}</span> }
      </div>

      @if (bulkOpen()) {
        <div class="etqp-card">
          <label for="etqp-bulk">Carga masiva — un código por línea (SKU o código de barras)</label>
          <textarea #bulkTa pTextarea id="etqp-bulk" class="etqp-ta" [ngModel]="bulk()" (ngModelChange)="bulk.set($event)"
            placeholder="20186&#10;20187&#10;018804701641"></textarea>
          <div class="etqp-bulk-actions">
            <p-button label="Agregar lista" icon="pi pi-plus" [text]="true" [loading]="loading()"
              [disabled]="!bulk().trim()" (onClick)="addBulk()"></p-button>
            @if (notFound().length) { <span class="etqp-warn">No encontrados: {{ notFound().join(', ') }}</span> }
          </div>
        </div>
      }

      @if (queue().length) {
        <div class="etqp-work">
          <div class="etqp-tablewrap">
            <p-table [value]="queue()" styleClass="p-datatable-sm" [scrollable]="true" scrollHeight="440px" dataKey="model.product_id">
              <ng-template #caption>
                <div class="etqp-tcap">
                  <span class="lbl">Cola</span>
                  <span class="count">{{ queue().length }} producto{{ queue().length === 1 ? '' : 's' }} · {{ totalLabels() }} de {{ MAX_LABELS }} etiquetas · {{ totalSheets() }} hoja{{ totalSheets() === 1 ? '' : 's' }}</span>
                  <p-button label="Vaciar" icon="pi pi-trash" [text]="true" severity="secondary" size="small" (onClick)="clearQueue()"></p-button>
                </div>
              </ng-template>
              <ng-template #header>
                <tr>
                  <th>Producto</th>
                  <th>Precio grande</th>
                  <th class="etqp-cnum">Copias</th>
                  <th class="etqp-cact"></th>
                </tr>
              </ng-template>
              <ng-template #body let-it let-i="rowIndex">
                <!-- [TDA.1] El banner dice CUANTAS cambiaron; esta marca dice CUALES. -->
                <tr [class.etqp-row-changed]="filaCambiada(it)">
                  <td>
                    <div class="etqp-qname">
                      <span class="nm" [title]="it.model.name">{{ it.model.name }}</span>
                      <span class="sku">{{ it.model.sku }}</span>
                    </div>
                  </td>
                  <td>
                    <p-select [options]="heroOptions(it.model)" [ngModel]="it.hero" (onChange)="setHero(i, $event.value)"
                      optionLabel="label" optionValue="value" appendTo="body" styleClass="etqp-hero-sel"
                      [ariaLabel]="'Precio grande de ' + it.model.name"></p-select>
                  </td>
                  <td class="etqp-cnum">
                    <p-inputnumber styleClass="etqp-num" [ngModel]="it.copies" (ngModelChange)="setCopies(i, $event)"
                      [showButtons]="true" buttonLayout="horizontal" [min]="1" [max]="maxCopies(i)" [step]="1" [inputStyle]="{ width: '3rem', textAlign: 'center' }"
                      incrementButtonIcon="pi pi-plus" decrementButtonIcon="pi pi-minus"
                      [ariaLabel]="'Copias de ' + it.model.name"></p-inputnumber>
                  </td>
                  <td class="etqp-cact">
                    <p-button icon="pi pi-times" [text]="true" [rounded]="true" severity="danger" size="small"
                      (onClick)="remove(i)" [ariaLabel]="'Quitar ' + it.model.name"></p-button>
                  </td>
                </tr>
              </ng-template>
            </p-table>
          </div>

          <div class="etqp-sheetpanel" [style.--etqp-k]="sheetScale()">
            <div class="etqp-sheethead">
              <span>Vista de hoja (Carta) · Hoja {{ sheetPageShown() }} de {{ totalSheets() }} · {{ totalLabels() }} etiqueta{{ totalLabels() === 1 ? '' : 's' }}</span>
              @if (totalSheets() > 1) {
                <span class="etqp-pager">
                  <p-button icon="pi pi-chevron-left" [text]="true" [rounded]="true" size="small" severity="secondary"
                    [disabled]="sheetPageShown() <= 1" (onClick)="prevSheet()" ariaLabel="Hoja anterior"></p-button>
                  <p-button icon="pi pi-chevron-right" [text]="true" [rounded]="true" size="small" severity="secondary"
                    [disabled]="sheetPageShown() >= totalSheets()" (onClick)="nextSheet()" ariaLabel="Hoja siguiente"></p-button>
                </span>
              }
            </div>
            <div class="etqp-ruler" #sheetRuler></div>
            <div class="etqp-sheetbox">
              <div class="etqp-sheet">
                @for (m of sheetLabels(); track $index) {
                  <app-label [model]="m.model" [hero]="m.hero" [show]="showMap()"></app-label>
                }
              </div>
            </div>
            <div class="etqp-cuthint">– – – línea de recorte por etiqueta (así saldrá impreso)</div>
          </div>
        </div>
      } @else {
        <div class="etqp-empty">
          <i class="pi pi-tags"></i>
          <h2>Sin etiquetas en la cola</h2>
          <p>Busca un producto en el catálogo o pega una lista de códigos para empezar a armar la hoja.</p>
        </div>
      }
    </div>

    <!-- Hoja fuente (fuera de pantalla): se renderiza aquí y se clona al iframe de impresión. -->
    <div class="etqp-print" #printSheet>
      @for (m of printLabels(); track $index) {
        <app-label [model]="m.model" [hero]="m.hero" [show]="showMap()"></app-label>
      }
    </div>
  `,
})
export class TiendaEtiquetasComponent {
  private readonly svc = inject(EtiquetasService);
  private readonly socket = inject(StoreSocketService);
  private readonly destroyRef = inject(DestroyRef);

  // ── `[TDA.1]` El precio cambió mientras la pantalla estaba abierta ──────────
  //
  // Hasta acá esta pantalla era 100% pull: consultaba el precio SÓLO cuando el operador escaneaba,
  // y la frescura viajaba congelada pegada a cada ítem. Si se corregía un precio en Kepler con
  // etiquetas ya en cola, esas filas conservaban el precio viejo **y se imprimían así**. Es el
  // incidente del SKU 88222 visto desde la pantalla.
  //
  // La cadena hasta la base ya era rápida (carril hash @15 s + hop-2 sincrónico); lo que faltaba
  // era el último tramo. Ahora el hop-2 avisa y esto escucha.

  /** `product_id` de la cola cuyo precio cambió y todavía no se refrescó. */
  private readonly precioCambiado = signal<ReadonlySet<string>>(new Set());
  /**
   * El aviso vino recortado: no se puede decir CUÁLES de la cola cambiaron.
   *
   * Se guarda aparte del set a propósito. Tratar "no sé cuáles" como "ninguno" sería el mismo
   * error que esta pantalla ya cometió una vez con la frescura (`unknown` llegando como
   * `stale: false` y el aviso callado).
   */
  readonly avisoTruncado = signal(false);
  readonly refrescando = signal(false);

  private marcarCambiados(p: LabelPricesChanged): void {
    if (p?.truncated) { this.avisoTruncado.set(true); return; }
    const ids = new Set(Array.isArray(p?.product_ids) ? p.product_ids : []);
    if (!ids.size) return;
    // Sólo interesa lo que está EN LA COLA: avisar por un producto que nadie va a imprimir es
    // ruido, y un banner que suena sin motivo se aprende a ignorar.
    const enCola = new Set(this.queue().map((it) => it.model.product_id).filter((id) => ids.has(id)));
    if (!enCola.size) return;
    this.precioCambiado.update((prev) => new Set([...prev, ...enCola]));
  }

  /** Las filas de la cola cuyo precio cambió. Con aviso recortado, son todas. */
  readonly cambiadosEnCola = computed<QueueItem[]>(() => {
    const q = this.queue();
    if (this.avisoTruncado()) return q;
    const ids = this.precioCambiado();
    return q.filter((it) => ids.has(it.model.product_id));
  });

  /** ¿ESTA fila cambió? Se usa para marcarla en la tabla, no sólo en el banner. */
  filaCambiada(it: QueueItem): boolean {
    return this.avisoTruncado() || this.precioCambiado().has(it.model.product_id);
  }

  readonly nombresCambiados = computed(() => {
    const n = this.cambiadosEnCola().map((it) => it.model.name);
    return n.length <= 3 ? n.join(' · ') : `${n.slice(0, 3).join(' · ')} y ${n.length - 3} más`;
  });

  /**
   * Re-resuelve los productos afectados y reemplaza su modelo en la cola, conservando las copias y
   * el hero que el operador ya eligió — perder eso lo obligaría a rearmar el lote.
   *
   * Se re-resuelve por el MISMO camino que el escaneo (`resolve`), no por un endpoint nuevo: así el
   * precio refrescado pasa por la misma reconciliación y trae su propia frescura medida.
   */
  refrescarPrecios(): void {
    const objetivo = this.cambiadosEnCola();
    if (!objetivo.length || this.refrescando()) return;
    // El código con el que se resolvió cada ítem; si no viaja, el sku sirve igual.
    const codes = Array.from(new Set(objetivo.map((it) => it.model.code || it.model.sku).filter((c): c is string => !!c)));
    if (!codes.length) {
      this.msg.set({ text: 'No se puede refrescar: estas filas no traen con qué volver a buscarlas.', kind: 'warn' });
      return;
    }
    this.refrescando.set(true);
    this.svc.resolve(codes).subscribe({
      next: (r) => {
        this.lastFreshness.set(r.freshness ?? null);
        const porId = new Map((r.labels || []).map((l) => [l.product_id, l]));
        this.queue.update((q) => q.map((it) => {
          const fresco = porId.get(it.model.product_id);
          if (!fresco || !this.usable(fresco)) return it;
          // Se conserva `scanned_unit` del original: define el hero y no viene de este resolve.
          return { ...it, model: { ...fresco, scanned_unit: it.model.scanned_unit }, freshness: r.freshness ?? null };
        }));
        const refrescados = (r.labels || []).filter((l) => porId.has(l.product_id) && this.usable(l)).length;
        // Sólo se limpian los que de verdad volvieron: si uno no vino, su marca se queda puesta.
        this.precioCambiado.update((prev) => {
          const next = new Set(prev);
          for (const l of r.labels || []) if (this.usable(l)) next.delete(l.product_id);
          return next;
        });
        if (this.avisoTruncado() && codes.length === objetivo.length) this.avisoTruncado.set(false);
        this.msg.set({ text: `Precios actualizados: ${refrescados} de ${objetivo.length}.`, kind: refrescados === objetivo.length ? 'ok' : 'warn' });
        this.refrescando.set(false);
      },
      error: (e) => {
        // Falla el refresco: la marca NO se limpia. Que quede el aviso puesto es lo correcto —
        // seguimos sin saber si el precio de la cola es el vigente.
        this.msg.set({ text: this.httpMsg('Actualizar precios', e), kind: 'error' });
        this.refrescando.set(false);
      },
    });
  }

  @ViewChild('scanInput') scanInput?: ElementRef<HTMLInputElement>;
  @ViewChild('printSheet') printSheet?: ElementRef<HTMLElement>;
  @ViewChild('bulkTa') bulkTa?: ElementRef<HTMLTextAreaElement>;
  /** Señal y no decorador: la regla nace y muere con la cola, y el effect del zoom tiene que enterarse. */
  private readonly sheetRuler = viewChild<ElementRef<HTMLElement>>('sheetRuler');

  /**
   * Carga masiva plegada. Se usa poco (cambio de precios de temporada) y abierta se llevaba una
   * tarjeta entera de alto — el alto que la vista de hoja necesitaba. La función queda intacta:
   * mismo textarea, mismo addBulk(), mismo aviso de no encontrados.
   */
  readonly bulkOpen = signal(false);
  toggleBulk(): void {
    const abrir = !this.bulkOpen();
    this.bulkOpen.set(abrir);
    if (abrir) setTimeout(() => this.bulkTa?.nativeElement.focus(), 0);
  }

  /**
   * Zoom de la vista de hoja: la hoja se dibuja a tamaño real y se escala con la variable --etqp-k.
   *
   * Se CALCULA, no se fija. El 0.474 de antes estaba atado a una caja de 500 px, y al pasar la
   * etiqueta de 115x40 a 82x35 mm el precio quedó en unos 10 px de alto — nadie podía leer en
   * pantalla lo que estaba por imprimir.
   *
   * Se toma el MENOR entre lo que da el ancho y lo que da el alto, porque es una vista de HOJA:
   * si hay que hacer scroll para ver la última fila deja de servir para lo que sirve. Tope 1.5
   * (por arriba del tamaño físico) y piso 0.45 — lo que había — para que en una pantalla chica
   * nunca quede peor que antes.
   */
  readonly sheetScale = signal(0.474);
  private readonly HOJA_W = (279 / 25.4) * 96; // 1054.5 px CSS (Carta horizontal)
  private readonly HOJA_H = (216 / 25.4) * 96; //  816.4 px CSS
  /** Alto de la ventana que NO es la hoja: encabezado, pie de recorte y aire. Medido en pantalla. */
  private readonly ALTO_RESERVADO = 210;

  private fitSheet(): void {
    const ancho = this.sheetRuler()?.nativeElement.clientWidth ?? 0;
    if (!ancho) return;
    const alto = Math.max(320, window.innerHeight - this.ALTO_RESERVADO);
    const k = Math.min(ancho / this.HOJA_W, alto / this.HOJA_H, 1.5);
    this.sheetScale.set(Math.max(0.45, Math.round(k * 1000) / 1000));
  }

  private readonly acQuery = signal<string | null>(null);
  private readonly acRes = rxResource({
    params: () => { const q = this.acQuery(); return q && q.length >= 2 ? q : undefined; },
    stream: ({ params }) => this.svc.search(params),
  });
  readonly results = computed<SearchHit[]>(() => this.acRes.value() ?? []);
  acSelected: SearchHit | string | null = null;
  bulk = signal('');
  queue = signal<QueueItem[]>([]);
  notFound = signal<string[]>([]);
  /**
   * [OBS.6.2] Edad del precio que se está por imprimir. `null` = todavía no se resolvió nada.
   *
   * Se declara, no se bloquea (decisión de Edgar): el operador decide si imprime. Lo que no puede
   * volver a pasar es lo del 27-ago — seis días imprimiendo precios viejos sin una sola señal.
   *
   * Es la PEOR entre la de cada ítem de la cola (medida cuando ese ítem se resolvió) y la de la
   * última consulta (`lastFreshness`, aunque no haya agregado nada: es la medición más reciente
   * de los carriles). Antes era un signal que se pisaba con cada `resolve`.
   */
  readonly lastFreshness = signal<Freshness | null>(null);
  readonly freshness = computed(() => worstFreshness([...this.queue().map((it) => it.freshness), this.lastFreshness()]));
  /** Sólo los eslabones rezagados: es lo que el aviso tiene que nombrar para ser accionable. */
  readonly staleInputs = computed(() => (this.freshness()?.inputs || []).filter((i) => i.stale));
  loading = signal(false);
  msg = signal<Msg | null>(null);
  printLabels = signal<SheetLabel[]>([]);
  printing = signal(false);
  /** Cuántas etiquetas ya están en la hoja oculta mientras se prepara la impresión (se llena por hojas). */
  printProgress = signal(0);

  /**
   * ¿El CSS que aísla la impresión está vivo en el bundle que corre ESTE equipo?
   *
   * No es paranoia: la app tiene service worker con prefetch, y una tablet que no cambia de
   * ruta puede quedarse meses en una versión vieja. Sin esta marca, "imprime toda la pantalla"
   * y "está corriendo código de hace tres deploys" se ven exactamente igual, y no hay consola
   * a mano en el piso de tienda para distinguirlos.
   */
  readonly printGuard = signal<'ok' | 'missing'>('missing');

  /**
   * Navegador y versión de ESTE equipo, para que un reporte de tienda diga qué máquina es.
   *
   * Medido en prod (94 usuarios con login, censo 2026-09-11): la flota corre Chrome 149-153 y
   * Edge 135/152 — todo Chromium, y en los perfiles de tienda el mínimo es Chrome 150. O sea las
   * diferencias de tamaño que se reportan NO son de motor ni de versión; esto queda para que la
   * próxima vez se pueda afirmar en vez de suponer, con una foto de la pantalla.
   */
  readonly navegador = (() => {
    const ua = (globalThis as { navigator?: Navigator }).navigator?.userAgent || '';
    const m = /Edg\/(\d+)/.exec(ua) || /OPR\/(\d+)/.exec(ua) || /Firefox\/(\d+)/.exec(ua) || /Chrome\/(\d+)/.exec(ua);
    if (!m) return ua ? 'navegador sin identificar' : '';
    const nombre = m[0].startsWith('Edg') ? 'Edge' : m[0].startsWith('OPR') ? 'Opera' : m[0].split('/')[0];
    return `${nombre} ${m[1]}`;
  })();

  /**
   * ¿La etiqueta se está midiendo con SU tipografía (Anton) o con la de respaldo?
   *
   * No es cosmético: medir con la fallback deja el precio hasta 17% más chico (la tabla del
   * encabezado de label.component). Las familias bajan de fonts.googleapis.com, así que un
   * equipo de tienda sin salida a internet imprime distinto que el de al lado **con el mismo
   * navegador** — la única variación por máquina que quedó, y hasta hoy era invisible.
   *
   * Tres estados, no dos (ADR-056): si el navegador no deja preguntar, se dice eso.
   */
  readonly fuenteEtiqueta = signal<'midiendo' | 'anton' | 'respaldo' | 'sin_medir'>('midiendo');

  private checkPrintGuard(): void {
    let found = false;
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        // Una hoja de otro origen tira SecurityError al leer cssRules: se salta.
        if (Array.from(sheet.cssRules).some((r) => r.cssText.includes('etqp-printing'))) { found = true; break; }
      } catch { /* hoja no legible */ }
    }
    this.printGuard.set(found ? 'ok' : 'missing');
  }

  constructor() {
    // Mensaje en error de la búsqueda (equivale al catchError viejo).
    effect(() => {
      const err = this.acRes.error();
      if (err) this.msg.set({ text: this.httpMsg('Búsqueda', err), kind: 'error' });
    });
    // Angular inyecta los estilos del componente al renderizarlo: se mira después del render.
    afterNextRender(() => this.checkPrintGuard());

    // Qué tipografía quedó usable para medir. FUENTES_USABLES resuelve cuando las familias
    // están listas O a los 3 s; recién ahí la respuesta significa algo.
    FUENTES_USABLES.then(() => {
      const f = (document as unknown as { fonts?: { check?: (s: string) => boolean } }).fonts;
      if (!f?.check) { this.fuenteEtiqueta.set('sin_medir'); return; }
      try { this.fuenteEtiqueta.set(f.check('11mm Anton') ? 'anton' : 'respaldo'); }
      catch { this.fuenteEtiqueta.set('sin_medir'); }
    });

    // La hoja se re-escala cuando cambia el ancho de su columna o el alto de la ventana. Se mide
    // la REGLA (.etqp-ruler, ancho de la columna) y no la caja: la caja mide lo que el zoom
    // decide, así que medirla sería un lazo. Sin ResizeObserver (jsdom en los tests) queda el
    // resize de ventana y el valor de arranque del CSS — degradado declarado, no un crash.
    effect((onCleanup) => {
      const el = this.sheetRuler()?.nativeElement;
      if (!el) return;
      const alCambiar = () => this.fitSheet();
      window.addEventListener('resize', alCambiar);
      let ro: ResizeObserver | undefined;
      if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(alCambiar); ro.observe(el); }
      else alCambiar();
      onCleanup(() => { ro?.disconnect(); window.removeEventListener('resize', alCambiar); });
    });

    // `[TDA.1]` El aviso en vivo de que un precio de la cola cambió en Kepler.
    //
    // Conecta y NO desconecta, igual que el aviso de arqueo (`arqueo-due.service.ts`). El socket es
    // singleton de root y `tienda-state` lo administra con un refcount que llama `disconnect()` al
    // llegar a cero: un `disconnect()` desde acá le cortaría el socket a los otros consumidores.
    this.socket.connect();
    this.socket.labelPricesChanged$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((p) => this.marcarCambiados(p));
  }

  totalLabels = computed(() => this.queue().reduce((s, it) => s + (it.copies || 0), 0));
  printBtnLabel = computed(() => {
    if (this.printing()) return this.printProgress() ? `Preparando… ${this.printProgress()}/${this.totalLabels()}` : 'Preparando…';
    const n = this.totalLabels();
    return `Imprimir ${n} etiqueta${n === 1 ? '' : 's'}`;
  });

  // Secciones visibles de la etiqueta (multiselect). Default: todas.
  sectionOptions = [
    { label: 'Mayoreo por pieza', value: 'mayoreoPza' },
    { label: 'Paquete', value: 'paquete' },
    { label: 'Mayoreo por paquete', value: 'mayoreoPaq' },
    { label: 'Caja', value: 'caja' },
    { label: 'Código de barras', value: 'barcode' },
    { label: 'Granel: kg y porción', value: 'granel' },
  ];
  sections = signal<string[]>(['mayoreoPza', 'paquete', 'mayoreoPaq', 'caja', 'barcode', 'granel']);
  showMap = computed<LabelSections>(() => {
    const s = this.sections();
    return {
      mayoreoPza: s.includes('mayoreoPza'),
      paquete: s.includes('paquete'),
      mayoreoPaq: s.includes('mayoreoPaq'),
      caja: s.includes('caja'),
      barcode: s.includes('barcode'),
      granel: s.includes('granel'),
    };
  });

  // Carta horizontal (263×200mm útil) con etiquetas de 82×35 + 2mm de margen de recorte
  // (huella 86×39): 3 columnas × 5 filas = 15 por hoja. Con las de 115×40 eran 8.
  //
  // El margen es 2 y no 2.5mm por TOLERANCIA: a 2.5 la huella mide 87×40 y cinco filas dan
  // 200mm contra 200mm disponibles — cero holgura, y cualquier redondeo de subpíxel manda la
  // 5ª fila a la hoja siguiente (12 aquí + 3 allá, gastando MÁS papel que antes y sin que
  // nadie entienda por qué). A 2mm sobran 5mm de alto y 5mm de ancho.
  private readonly PER_SHEET = 15;
  /**
   * Tope de la cola, en hojas. Es una decisión de LOTE de papel (20 hojas Carta por impresión),
   * no un límite medido de rendimiento: `resolve` acepta 1,000 códigos y sin tope la hoja oculta
   * renderizaba todas las etiquetas de golpe. Lo que mantiene viva la pantalla es que `print()`
   * la arma por hojas cediendo el hilo; el tope acota el trabajo, y lo que no entra vuelve al
   * textarea en vez de perderse.
   */
  readonly MAX_SHEETS = 20;
  readonly MAX_LABELS = this.MAX_SHEETS * this.PER_SHEET;
  totalSheets = computed(() => Math.max(1, Math.ceil(this.totalLabels() / this.PER_SHEET)));
  /** Toda la cola expandida: una entrada por copia, con el hero de su ticket. */
  readonly allLabels = computed<SheetLabel[]>(() => {
    const out: SheetLabel[] = [];
    for (const it of this.queue()) for (let i = 0; i < it.copies; i++) out.push({ model: it.model, hero: it.hero });
    return out;
  });
  /** Hoja que muestra la vista previa. Se clampea sola si la cola se achica. */
  readonly sheetPage = signal(1);
  readonly sheetPageShown = computed(() => Math.max(1, Math.min(this.sheetPage(), this.totalSheets())));
  sheetLabels = computed<SheetLabel[]>(() => {
    const ini = (this.sheetPageShown() - 1) * this.PER_SHEET;
    return this.allLabels().slice(ini, ini + this.PER_SHEET);
  });
  prevSheet(): void { this.sheetPage.set(Math.max(1, this.sheetPageShown() - 1)); }
  nextSheet(): void { this.sheetPage.set(Math.min(this.totalSheets(), this.sheetPageShown() + 1)); }

  msgIcon(kind: Msg['kind']): string {
    return kind === 'error' ? 'pi-exclamation-triangle'
      : kind === 'warn' ? 'pi-exclamation-circle'
      : kind === 'ok' ? 'pi-check-circle'
      : 'pi-info-circle';
  }

  private httpMsg(what: string, e: any): string {
    const s = e?.status;
    if (s === 404) return `${what}: el endpoint /store/labels no existe en el servidor (¿API sin reiniciar/desplegar?).`;
    if (s === 401 || s === 403) return `${what}: sin permiso (STORE_LIVE_VER) o sesión vencida.`;
    return `${what}: error ${s || ''} — ${e?.error?.message || e?.message || 'desconocido'}`;
  }

  searchAc(e: AutoCompleteCompleteEvent): void {
    this.acQuery.set(e.query ?? '');
  }

  onPick(e: AutoCompleteSelectEvent): void {
    const h = e.value as SearchHit;
    this.acSelected = null;
    this.acQuery.set(null);
    this.msg.set(null);
    const code = h.sku || h.barcode;
    if (!code) { this.msg.set({ text: 'El producto no tiene SKU ni código de barras.', kind: 'warn' }); return; }
    this.svc.resolve([code]).subscribe({
      next: (r) => {
        this.lastFreshness.set(r.freshness ?? null);
        const { added, skipped, leftover } = this.pushLabels(r.labels, r.freshness ?? null);
        if (!added) {
          this.msg.set({
            text: leftover.length ? this.topeMsg()
              : skipped.length
                ? `"${h.name}" no tiene precio en Kepler → no se puede etiquetar.`
                : `No se pudo agregar "${h.name}" (sin datos de etiqueta).`,
            kind: 'warn',
          });
        }
      },
      error: (err) => this.msg.set({ text: this.httpMsg('Agregar', err), kind: 'error' }),
    });
  }

  /**
   * F-Scan — escáner/pistola: al Enter (terminador del escáner) resuelve el código y lo agrega
   * automáticamente, sin clic. `resolve` acepta SKU (5 díg) o código de barras (8/12/13) indistinto,
   * así que no hace falta ramificar por longitud. Limpia y re-enfoca para el siguiente escaneo.
   */
  onScan(raw: string): void {
    const code = (raw || '').trim();
    if (!code) { this.focusScan(); return; }
    this.msg.set(null);
    this.svc.resolve([code]).subscribe({
      next: (r) => {
        this.lastFreshness.set(r.freshness ?? null);
        const { added, skipped, leftover } = this.pushLabels(r.labels, r.freshness ?? null);
        if (added) {
          this.msg.set({ text: `Agregado: ${r.labels.find((l) => this.usable(l))?.name ?? code}`, kind: 'ok' });
        } else if (leftover.length) {
          this.msg.set({ text: this.topeMsg(), kind: 'warn' });
        } else if (skipped.length) {
          this.msg.set({ text: `${skipped[0]}: sin precio en Kepler → no se puede etiquetar.`, kind: 'warn' });
        } else {
          this.msg.set({ text: `No encontrado: ${code}`, kind: 'warn' });
        }
        this.focusScan();
      },
      error: (e) => { this.msg.set({ text: this.httpMsg('Escaneo', e), kind: 'error' }); this.focusScan(); },
    });
  }

  private focusScan(): void {
    setTimeout(() => this.scanInput?.nativeElement.focus(), 0);
  }

  addBulk(): void {
    const codes = this.bulk().split(/[\s,;]+/).map((c) => c.trim()).filter(Boolean);
    if (!codes.length) return;
    this.loading.set(true);
    this.msg.set(null);
    this.svc.resolve(codes).subscribe({
      next: (r) => {
        this.lastFreshness.set(r.freshness ?? null);
        const { added, skipped, leftover } = this.pushLabels(r.labels, r.freshness ?? null);
        this.notFound.set(r.not_found || []);
        const nf = r.not_found?.length || 0;
        let text = `Agregados ${added}`;
        if (skipped.length) text += ` · sin precio ${skipped.length}`;
        if (nf) text += ` · no encontrados ${nf}`;
        if (leftover.length) text += ` · ${leftover.length} fuera por el tope de ${this.MAX_LABELS} etiquetas (siguen en la lista)`;
        this.msg.set({ text, kind: (skipped.length || nf || leftover.length) ? 'warn' : 'ok' });
        // Lo que no cupo se queda en el textarea: se imprime esta cola y se vuelve a cargar.
        this.bulk.set(leftover.join('\n'));
        this.loading.set(false);
      },
      error: (e) => { this.msg.set({ text: this.httpMsg('Carga masiva', e), kind: 'error' }); this.loading.set(false); },
    });
  }

  /**
   * Agrega a la cola SOLO productos con dato de precio usable. Los que no tienen (ej. SKU-less
   * sin fila en Kepler, como "OJILOCOS…") se omiten y se devuelven en `skipped` para avisar —
   * antes se agregaba una etiqueta vacía ($0, sin código, sin tiers) = "no muestra info".
   */
  private pushLabels(labels: LabelModel[], freshness: Freshness | null): { added: number; skipped: string[]; leftover: string[] } {
    const q = [...this.queue()];
    const skipped: string[] = [];
    // Lo que no entró por el tope, por su código: vuelve al textarea (ver addBulk).
    const leftover: string[] = [];
    let total = q.reduce((s, it) => s + it.copies, 0);
    let added = 0;
    for (const m of labels) {
      if (!this.usable(m)) { skipped.push(m.name); continue; }
      if (total >= this.MAX_LABELS) { leftover.push(m.code || m.sku || m.name); continue; }
      const existing = q.find((it) => it.model.product_id === m.product_id);
      // Re-escaneado: se queda con el modelo y la frescura de ESTE resolve, que es el más reciente.
      // Antes sólo sumaba la copia y la cola seguía cargando el precio de la primera vez.
      if (existing) { existing.copies += 1; existing.model = m; existing.freshness = freshness; }
      else q.push({ model: m, copies: 1, hero: this.defaultHero(m), freshness });
      total++;
      added++;
    }
    this.queue.set(q);
    return { added, skipped, leftover };
  }

  private topeMsg(): string {
    return `Tope de ${this.MAX_LABELS} etiquetas (${this.MAX_SHEETS} hojas) por impresión — imprime esta cola antes de agregar más.`;
  }

  // ── Precio grande dinámico por ticket ──────────────────────────────
  private n(v: number | null | undefined): number { return typeof v === 'number' && isFinite(v) ? v : 0; }

  /** Un producto es "usable" para etiqueta si tiene AL MENOS un precio (pieza/paquete/caja). */
  private usable(m: LabelModel): boolean {
    return this.n(m.piece_price) > 0 || this.n(m.pack_price) > 0 || this.n(m.box_price) > 0;
  }

  /**
   * Hero por default.
   *
   * ⚠️ **El escaneo decide MUCHO menos de lo que este método parecía decir.** Tenía una tercera
   * rama —"si se escaneó la base / PAQ / PZA / KG → pieza"— que sostenía la idea de que el
   * escaneo mandaba siempre. Medido sobre las **8,080 combinaciones (barcode × producto)** de
   * prod: **borrarla produce 0 diferencias**. Era un prefijo exacto de la cascada de abajo, o
   * sea código muerto que hacía creer que el escaneo elegía cuando en realidad elegía la
   * cascada. Se borró para que la regla verdadera quede a la vista.
   *
   * Lo que el escaneo decide de verdad son dos ASCENSOS, y sólo suman 1,004 de 8,080:
   *   · CJA con precio de caja      → caja      (686)
   *   · PAQ con base menor y precio → paquete   (318)
   * Todo lo demás —**6,890 de 8,080 (85%)**— sale de `piece_price > 0 → pieza`, que NO es el
   * escaneo: es el default. Y ojo con el nombre: el hero `pieza` imprime el **precio BASE** con
   * la palabra de la unidad base, así que en los 73.5% con `unit_base=PAQ` la etiqueta dice
   * "Precio por paquete" — el `pieza` es un nombre interno, no lo que se imprime.
   *
   * ⚠️ Y el supuesto del feedback del 2026-08-25 ("cada unidad tiene su código, el usuario NO
   * debe elegir") **no se cumple**: medido, **10,771 de 11,506 SKUs (93.6%) tienen registrada
   * UNA sola unidad**, así que el escaneo casi nunca puede expresar una elección — refleja lo
   * que casualmente esté cargado en `catalog.product_barcodes`.
   */
  private defaultHero(m: LabelModel): HeroKey {
    const su = (m.scanned_unit || '').toUpperCase();
    const base = (m.unit_base || '').toUpperCase();
    if (su) {
      if (su === 'CJA' && this.n(m.box_price) > 0) return 'caja';
      if (su === 'PAQ' && base !== 'PAQ' && this.n(m.pack_price) > 0) return 'paquete';
    }
    if (this.granelGrams(m) > 0 && this.n(m.piece_price) > 0) return 'kg';
    if (this.n(m.piece_price) > 0) return 'pieza';
    if (this.n(m.pack_price) > 0) return 'paquete';
    if (this.n(m.box_price) > 0) return 'caja';
    return 'pieza';
  }

  /** Granel: gramos de la porción base (KG=1000, "500"/"250"/…). 0 = no granel.
   *  Solo si sold_by_kg (base KG o tier KG en Kepler) — bolsas/palitos numéricos no son granel. */
  private granelGrams(m: LabelModel): number {
    if (!m.sold_by_kg) return 0;
    const ub = (m.unit_base || '').toUpperCase();
    if (ub === 'KG') return 1000;
    return /^\d+$/.test(ub) ? parseInt(ub, 10) : 0;
  }

  /** Palabra de la unidad base (piece_price = c90) según Kepler unit_base: Paquete/Caja/Pieza. */
  private baseWord(m: LabelModel): string {
    const ub = (m.unit_base || '').toUpperCase();
    if (ub === 'PAQ') return 'Paquete';
    if (ub === 'CJA') return 'Caja';
    return 'Pieza';
  }

  /** Opciones de precio grande para el selector del ticket — solo las que tienen precio. */
  heroOptions(m: LabelModel): { value: HeroKey; label: string }[] {
    const opts: { value: HeroKey; label: string }[] = [];
    const fmt = (v: number) => '$' + v.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const g = this.granelGrams(m);
    const piece = this.n(m.piece_price);
    if (piece > 0) {
      if (g > 0 && g < 1000) {
        // Granel de porción < 1 kg → ofrece AMBAS: la porción y el kilo.
        opts.push({ value: 'pieza', label: `${g} g ${fmt(piece)}` });
        opts.push({ value: 'kg', label: `1 kg ${fmt(piece * 1000 / g)}` });
      } else if (g >= 1000) {
        opts.push({ value: 'kg', label: `1 kg ${fmt(piece)}` });
      } else {
        opts.push({ value: 'pieza', label: `${this.baseWord(m)} ${fmt(piece)}` });
      }
    }
    if (this.n(m.pack_price) > 0) opts.push({ value: 'paquete', label: `Paquete ${fmt(this.n(m.pack_price))}` });
    if (this.n(m.box_price) > 0) opts.push({ value: 'caja', label: `Caja ${fmt(this.n(m.box_price))}` });
    return opts;
  }

  setHero(i: number, hero: HeroKey): void {
    const q = [...this.queue()];
    q[i] = { ...q[i], hero };
    this.queue.set(q);
  }

  /** Copias que puede llevar el ítem `i` sin que la cola pase del tope (también es el `[max]` del control). */
  maxCopies(i: number): number {
    const otros = this.queue().reduce((s, it, idx) => s + (idx === i ? 0 : it.copies), 0);
    return Math.max(1, this.MAX_LABELS - otros);
  }

  setCopies(i: number, val: number): void {
    const q = [...this.queue()];
    const pedidas = Math.max(1, Math.floor(Number(val) || 1));
    // El tope también entra por acá: las copias no multiplican la cola más allá del máximo.
    q[i] = { ...q[i], copies: Math.min(this.maxCopies(i), pedidas) };
    this.queue.set(q);
  }
  remove(i: number): void { this.queue.set(this.queue().filter((_, idx) => idx !== i)); }
  clearQueue(): void { this.queue.set([]); this.notFound.set([]); this.msg.set(null); this.lastFreshness.set(null); this.sheetPage.set(1); }

  /** Expande la cola a una etiqueta por copia (cargando el hero por ticket). */
  private expanded(): SheetLabel[] { return this.allLabels(); }

  /**
   * Renderiza la hoja fuera de pantalla, luego imprime en un iframe aislado (Carta horizontal).
   *
   * Dos cosas que NO se hacen de golpe: (1) la hoja oculta se arma POR HOJAS cediendo el hilo,
   * porque 300 etiquetas en un solo pase de Angular congelaban la pantalla sin que el botón
   * alcanzara a decir "Preparando…"; (2) se espera a que cada etiqueta MARQUE que ya se midió
   * con la tipografía definitiva (`data-etq-settled`), en vez de los 500 ms fijos que había: la
   * fuente puede tardar hasta 3 s en quedar usable y el clon al iframe viaja con los tamaños ya
   * inline, así que en un equipo frío se imprimía el número medido con la fallback — el mismo
   * defecto que `label.component` cerró en pantalla, abierto en el papel.
   */
  async print(): Promise<void> {
    const all = this.expanded();
    if (!all.length || this.printing()) return;
    this.msg.set(null);
    this.printing.set(true);
    this.printProgress.set(0);
    this.printLabels.set([]);
    for (let i = 0; i < all.length; i += this.PER_SHEET) {
      this.printLabels.update((cur) => [...cur, ...all.slice(i, i + this.PER_SHEET)]);
      this.printProgress.set(Math.min(all.length, i + this.PER_SHEET));
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    const listas = await this.waitForSettled(all.length);
    if (listas < all.length) {
      // Se imprime igual (el operador decide), pero se DICE: un tope que gana en silencio es
      // exactamente el falso verde que esta espera vino a quitar.
      this.msg.set({ text: `${all.length - listas} etiqueta(s) no terminaron de ajustarse a tiempo — revisa la impresión antes de pegarlas.`, kind: 'warn' });
    }
    this.printIsolated();
  }

  /**
   * Espera a que `n` etiquetas de la hoja oculta lleven la marca `data-etq-settled` (medidas ya
   * con la fuente definitiva). Tope de 8 s por si algo nunca marca; devuelve cuántas alcanzaron.
   */
  private async waitForSettled(n: number): Promise<number> {
    await FUENTES_USABLES;
    const limite = Date.now() + 8000;
    for (;;) {
      const listas = this.printSheet?.nativeElement.querySelectorAll('.etq-label[data-etq-settled]').length ?? 0;
      if (listas >= n || Date.now() > limite) return listas;
      await new Promise<void>((r) => setTimeout(r, 40));
    }
  }

  private printIsolated(): void {
    const sheet = document.querySelector('.etqp-print') as HTMLElement | null;
    if (!sheet || !sheet.innerHTML.trim()) { this.finishPrint(); return; }

    // Red de seguridad para tablets: copia de la hoja colgada del <body> (ver la nota de
    // `.etqp-print-fallback` en los estilos). Si el navegador ignora el iframe e imprime el
    // documento principal, esto es lo único que sale. Los barcodes son <svg>, así que el
    // clon por innerHTML los conserva.
    const fallback = document.createElement('div');
    fallback.className = 'etqp-print-fallback';
    fallback.setAttribute('aria-hidden', 'true');
    fallback.innerHTML = sheet.innerHTML;
    document.body.appendChild(fallback);
    document.body.classList.add('etqp-printing');

    // Si algo apagó la clase entre medio, el navegador nos avisa justo antes de imprimir.
    const rearm = () => { if (document.body.contains(fallback)) document.body.classList.add('etqp-printing'); };
    window.addEventListener('beforeprint', rearm);

    // Clona TODOS los estilos del documento (incluye los estilos del componente etiqueta + fuente Baloo).
    const styles = Array.from(document.querySelectorAll('head style, head link[rel="stylesheet"]'))
      .map((n) => n.outerHTML).join('\n');

    // Papel del camino de respaldo. Va en un <style> temporal y no en los estilos del componente
    // porque `@page` no se puede acotar por selector: dejarlo fijo le cambiaría el tamaño de hoja
    // a cualquier otra impresión de la app después de visitar esta pantalla. Se agrega DESPUÉS de
    // clonar los estilos para no duplicar el @page que el iframe ya declara por su cuenta.
    const pageStyle = document.createElement('style');
    pageStyle.id = 'etqp-print-page';
    pageStyle.textContent = '@page { size: letter landscape; margin: 8mm; }';
    document.head.appendChild(pageStyle);

    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    const dropFallback = () => {
      window.removeEventListener('beforeprint', rearm);
      document.body.classList.remove('etqp-printing');
      fallback.remove();
      pageStyle.remove();
    };
    if (!doc || !win) { dropFallback(); iframe.remove(); this.finishPrint(); return; }

    doc.open();
    doc.write(`<!doctype html><html><head><meta charset="utf-8">${styles}
      <style>
        @page { size:letter landscape; margin:8mm; }
        /* Reset height/overflow del styles.css global clonado: html,body{height:100%} en impresión
           = una hoja completa; con el margen del @page el body desborda ~16mm → 2ª hoja en blanco
           en cada impresión. height:auto lo colapsa al contenido. !important gana al clon. */
        html,body{ margin:0 !important; padding:0 !important; background:#fff;
                   height:auto !important; min-height:0 !important; width:auto !important; overflow:visible !important; }
        *{ -webkit-print-color-adjust:exact !important; print-color-adjust:exact !important; }
        /* Carta horizontal: 2 etiquetas por fila (aprovecha el ancho); se paginan solas y no se parten. */
        body{ text-align:center; font-size:0; }
        app-label{ display:inline-block; vertical-align:top; break-inside:avoid; page-break-inside:avoid; margin:2mm; }
        /* Esquinas rectas + línea de recorte punteada por etiqueta. */
        app-label .etq-label{ border-radius:0 !important; outline:.3mm dashed #888; }
      </style></head><body>${sheet.innerHTML}</body></html>`);
    doc.close();

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener('afterprint', finish);
      dropFallback();
      iframe.remove();
      this.finishPrint();
    };
    win.addEventListener('afterprint', finish);
    // Si el navegador imprimió el documento principal en vez del iframe, el `afterprint`
    // llega a la ventana de arriba y no a la del iframe: sin esto el botón se quedaría
    // en "Preparando…" hasta el timeout de limpieza.
    window.addEventListener('afterprint', finish);
    const fire = () => { try { win.focus(); win.print(); } catch { finish(); } };
    const fonts = (doc as any).fonts;
    if (fonts?.ready) fonts.ready.then(() => setTimeout(fire, 150)).catch(() => setTimeout(fire, 300));
    else setTimeout(fire, 450);
    // Fallback de limpieza si nunca llega afterprint (ej. usuario deja el diálogo abierto).
    setTimeout(finish, 120000);
  }

  private finishPrint(): void {
    this.printing.set(false);
    this.printProgress.set(0);
    this.printLabels.set([]);
  }
}
