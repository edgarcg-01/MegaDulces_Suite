import {
  AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, Input,
  OnChanges, QueryList, ViewChild, ViewChildren, ViewEncapsulation,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import JsBarcode from 'jsbarcode';

export interface LabelSections {
  mayoreoPza: boolean;
  paquete: boolean;
  mayoreoPaq: boolean;
  caja: boolean;
  barcode: boolean;
  /** Renglón alterno del granel (kg ↔ porción). Era el único que el multiselect no podía apagar. */
  granel: boolean;
}
export const ALL_SECTIONS: LabelSections = { mayoreoPza: true, paquete: true, mayoreoPaq: true, caja: true, barcode: true, granel: true };

/** Qué precio va en GRANDE (hero). Intercambiable por ticket. 'kg' = granel por kilo. */
export type HeroKey = 'pieza' | 'paquete' | 'caja' | 'kg';

/**
 * ⭐ EL BUG DEL "número que a veces se ve más chico".
 *
 * `fitPrice()`/`fitAmts()` encogen el texto midiendo su ancho. Si miden ANTES de que la
 * tipografía definitiva esté usable, miden con la **fallback**, que tiene otro ancho, y el
 * tamaño que dejan queda mal en la dirección de esa fallback. Medido (mismo precio, misma
 * caja, cambiando sólo la fuente con la que se mide):
 *
 *   midiendo con        ancho vs Anton    un precio de 4 cifras queda en
 *   Anton (la buena)    —                 9.00 mm
 *   Impact (Windows)    +5…8%             8.50 mm
 *   Helvetica (iPad)    +13…21%           7.50 mm  ← 17% más chico
 *   Arial Narrow        −1…7%             9.25 mm  (y al llegar Anton se RECORTA)
 *
 * `document.fonts.ready` NO alcanzaba, y de ahí lo intermitente: las familias llegan por un
 * `@import` a fonts.googleapis.com DENTRO del CSS de este componente, así que mientras esa
 * hoja no baja **no existe ningún `@font-face`** — no hay carga pendiente, `fonts.ready`
 * resuelve al instante y `layout()` mide con la fallback. Encima el re-layout vivía sólo en
 * `ngAfterViewInit`: toda etiqueta creada por un cambio de input (que es como las crea la
 * etiquetera al armar la cola) se quedaba con la medida equivocada para siempre.
 *
 * Esto espera a que las familias estén **realmente usables** (`fonts.load` + `fonts.check`,
 * con tope de 3 s), una sola vez para toda la app. Si no llegan —equipo sin internet— se
 * sigue midiendo con la fallback, que ahí es lo CORRECTO: es la que va a imprimir.
 *
 * (Ver `FUENTES_USABLES` abajo, que es la pieza que lo implementa.)
 */

/**
 * Tamaños de ARRANQUE de los dos números que se auto-ajustan. Están también en el CSS (los
 * necesita el primer render y el clon de impresión, antes de que corra el TS), y el spec
 * `etiqueta-hoja.spec.ts` exige que coincidan: si se cambia uno solo, el número arranca de un
 * tamaño y se mide contra otro.
 */
const PRECIO_MM = 10;
const MONTO_MM = 5.4;
/** Franja de la unidad: arranque del auto-ajuste de la PALABRA (pieza/paquete/caja/kg). */
const UNIDAD_MM = 4.2;

/**
 * Topes del crecimiento. Los ajustes son BIDIRECCIONALES: antes sólo encogían desde el
 * arranque, así que el precio usaba **57% del alto de su caja siempre** y el bloque de
 * renglones dejaba 7.7 mm de aire en promedio.
 *
 * `PRECIO_MAX_MM` = 15 es un paso arriba del máximo alcanzable real (14.75 mm, el precio de
 * 1 dígito): acota el bucle y nunca es el que topa — el que topa es el ancho de la caja.
 *
 * `MONTO_MAX_MM` = 7.0 NO es el llenado perfecto (2 renglones llenarían a 7.5). Manda la
 * jerarquía: 7.5 contra un hero de 10.25 da 1.37:1 y no lee como dos niveles; 7.0 da 1.46:1.
 * Los 1.4 mm que sobran se los lleva el código de barras. Invariante: MONTO_MAX_MM <= 70% de
 * PRECIO_MM, y en runtime el techo real se clampea contra el hero MEDIDO.
 */
const PRECIO_MAX_MM = 15;
const MONTO_MAX_MM = 7.0;

/**
 * Alto del código de barras. Se lleva el aire que el bloque de renglones no usa: hoy 5 mm es
 * el **19% de la altura nominal de un EAN-13** (25.9 mm), y el símbolo truncado es la causa
 * número uno de no-lectura en ángulo. El ANCHO no se toca — 43.4 mm es un mínimo físico
 * (EAN-13 al 80% pide 29.83) que el candado ya verifica.
 */
const BARCODE_MIN_MM = 5;
const BARCODE_MAX_MM = 12;

/**
 * Zona muda (quiet zone) por simbología, en MÓDULOS [izquierda, derecha]. Va DENTRO del SVG
 * (JsBarcode `marginLeft/Right`, a `BARCODE_MODULE_PX` por módulo) para que se estire con las
 * barras y nadie la pueda pisar desde el layout: con `margin: 0` la franja verde de la unidad
 * quedaba a 1.6 mm de la primera barra, donde un EAN-13 pide 11 módulos (~5 mm). Cuesta módulo:
 * los 43.4 mm de la columna se reparten entre 95 + 18 módulos → 0.384 mm = 116% de
 * magnificación (el mínimo es 80% = 0.264 mm; el candado lo verifica).
 */
const ZONA_MUDA: Record<string, [number, number]> = { EAN13: [11, 7], UPC: [9, 9], EAN8: [7, 7], CODE128: [10, 10] };
/** Píxeles por módulo con que JsBarcode dibuja; la zona muda se expresa en múltiplos de esto. */
const BARCODE_MODULE_PX = 2;

/** Descuento mínimo para que un mayoreo se REALCE como oferta. Ver `realceMayoreo*`. */
const MAYOREO_MIN_DESC = 0.01;

/**
 * Resuelve cuando Anton/Bebas/Baloo están REALMENTE usables (o a los 3 s). Ver el bloque de arriba.
 * Exportada porque la impresión la espera antes de clonar la hoja (ver `print()` en la etiquetera).
 */
export const FUENTES_USABLES: Promise<void> = (() => {
  const f: any = (globalThis as any).document?.fonts;
  const specs = ['11mm Anton', "5mm 'Bebas Neue'", "4mm 'Baloo 2'"];
  if (!f?.load || !f?.check) return Promise.resolve();
  const listas = () => specs.every((s) => { try { return f.check(s); } catch { return true; } });
  return new Promise<void>((resolve) => {
    Promise.all(specs.map((s) => f.load(s).catch(() => undefined))).catch(() => undefined);
    const t0 = Date.now();
    const tick = () => {
      if (listas() || Date.now() - t0 > 3000) { resolve(); return; }
      setTimeout(tick, 60);
    };
    tick();
  });
})();

/**
 * ⭐ El seguro del CRECIMIENTO. Mientras sea `false`, los ajustes sólo pueden encoger — o sea
 * se comportan exactamente como la versión anterior.
 *
 * Sin esto la bidireccionalidad convierte un defecto cosmético en un RECORTE: medir con una
 * fallback más angosta (Arial Narrow mide −1..7% contra Anton, ya medido) y **crecer** deja el
 * número más grande de lo que la fuente definitiva aguanta; cuando llega Anton, se corta.
 * Encoger con la fuente equivocada era seguro (quedaba chico pero cabía); crecer no lo es.
 */
let FUENTES_OK = false;
FUENTES_USABLES.then(() => { FUENTES_OK = true; });

export interface LabelModel {
  code?: string;
  product_id: string;
  sku: string | null;
  name: string;
  content: string | null;
  barcode: string | null;
  barcode_format: string | null;
  piece_price: number | null;
  wholesale_piece_min_qty: number | null;
  wholesale_piece_price: number | null;
  pack_size: number | null;
  pack_price: number | null;
  wholesale_pack_price: number | null;
  wholesale_pack_min_qty: number | null;
  box_size: number | null;
  box_price: number | null;
  unit_base: string | null;
  sold_by_kg?: boolean;
  scanned_unit?: string | null;   // unidad del barcode con que se resolvió (PZA/PAQ/CJA/KG) — auto-selecciona el hero
}

/**
 * Etiqueta de anaquel Mega Dulces — **82×35 mm**.
 *
 * Mismo diseño de `etiqueta-preview.html` (que quedó al tamaño original, 115×40) re-proporcionado.
 * El cambio de tamaño no fue cosmético: 115 mm de ancho daban **2 columnas × 4 filas = 8 por hoja**
 * Carta horizontal, y el umbral de la 3ª columna está en 82.6 mm de ancho (263 mm útiles ÷ 3, menos
 * los 5 mm de margen de recorte). A 82×35 entran **3 × 5 = 15 por hoja**: casi la mitad de papel.
 * Bajar sólo a 100 mm no habría cambiado nada — los saltos son umbrales, no una curva.
 * Además la pantalla ya AFIRMABA "100×40 mm" mientras el CSS imprimía 115: 15 mm más ancho que
 * el material que decía usar.
 *
 * Al angostar, lo único con mínimo físico es el código de barras (un EAN-13 pide ~29.8 mm al 80%
 * de magnificación): toma el ancho completo de su columna, **43.4 mm**. El resto del texto se
 * auto-encoge (`fitHead`/`fitPrice`/`fitTiers`/`fitAmts`), así que ninguna cadena larga desborda.
 * Sin iconos, letra grande, naranja de marca (--brand-700 #F05A28) en lo importante (SKU + número de piezas).
 * ViewEncapsulation.None + clases `etq-*` para que el layout en mm y las fuentes apliquen
 * limpio al imprimir. El barcode se genera con JsBarcode (mismo formato que Kepler).
 */
@Component({
  selector: 'app-label',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styles: [`
    @import url('https://fonts.googleapis.com/css2?family=Anton&family=Baloo+2:wght@500;600;700;800&family=Bebas+Neue&display=swap');
    .etq-label{
      --green:hsl(141,76%,16%); --yellow:#f6c400; --cream:#f8f6ea;
      /* El naranja del texto CHICO (SKU 3.2 mm, cantidades 2.6 mm) es brand-800, no brand-700
         (#F05A28): sobre la crema el 700 daba 3.1:1 de contraste — bien para un titular, corto
         para letra de 3 mm en una impresora gastada. El 800 da 4.75:1 y sigue siendo el mismo
         naranja de marca, un paso más oscuro. El candado mide el ratio desde estos dos hex. */
      --red:#C53E15;
      --font:'Baloo 2',system-ui,sans-serif;
      /* El precio grande va con Anton, que SE DESCARGA. Antes encabezaba 'Impact', que no es
         webfont: existe instalada en Windows y macOS pero no en iPad ni en Android, y ahí toda
         la cadena caía hasta sans-serif — el precio salía en Helvetica normal en vez de la
         condensada pesada. Misma etiqueta, dos tipografías según el equipo que la imprimiera.
         Anton queda primero para que la etiqueta impresa sea idéntica en todos lados; Impact
         queda de respaldo por si el equipo está sin internet y ya la tiene instalada. */
      --font-num:'Anton','Impact','Haettenschweiler','Arial Narrow',sans-serif;
      --font-cond:'Bebas Neue','Impact','Arial Narrow',sans-serif;
      width:82mm; height:35mm; background:var(--cream); border-radius:2.5mm; overflow:hidden;
      font-family:var(--font); color:var(--green); display:flex; flex-direction:column;
      text-align:left; /* reset: el sheet-sim y el body de impresión usan text-align:center y se heredaba adentro (centraba los rótulos) */
      -webkit-print-color-adjust:exact; print-color-adjust:exact;
    }
    .etq-label *{ box-sizing:border-box; margin:0; padding:0; }
    .etq-head{ background:var(--green); color:#fff; height:6.8mm; min-height:6.8mm; display:flex; align-items:center;
      padding:0 2mm; font-weight:800; font-size:3.9mm; letter-spacing:.2px; text-transform:uppercase; overflow:hidden; }
    .etq-head-txt{ display:block; min-width:0; flex:1 1 auto; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    /* El brote se mudó acá desde la caja del precio (ver el comentario del template). Ocupa
       5.6 de los 78 mm del nombre, que ya se auto-encoge. */
    .etq-head .etq-sprout{ position:static; flex:0 0 auto; width:5.6mm; height:5.6mm; margin-left:1.4mm; }
    .etq-red{ color:var(--red); font-weight:800; }
    .etq-body{ flex:1; min-height:0; display:flex; padding:.8mm 1.5mm 1mm 1.5mm; gap:1.6mm; }
    /* 34 + 1.6 de gap + 43.4 + 3 de padding = 82 exactos.
       El reparto YA NO es el original (54:55): al reducir la etiqueta, el mayoreo quedó
       ilegible porque su monto se auto-encogía hasta ~3.7 mm. Se le pasan 4.4 mm del precio
       unitario —que arranca un poco más chico— a la columna del mayoreo, que es donde el
       cliente compara. */
    .etq-left{ width:34mm; display:flex; flex-direction:column; }
    .etq-meta{ display:flex; align-items:baseline; gap:1.2mm; font-weight:800; font-size:3.2mm; margin-bottom:.8mm; }
    .etq-meta .sep{ color:var(--green); opacity:.5; }
    /* ⚠️ El 6.8mm de abajo está DOS veces: acá y en el inset del punteado. Es la reserva de la
       franja de la unidad (6.2mm de alto + 0.6 de aire) y los dos se mueven juntos o el borde
       punteado se mete debajo de la franja. El candado lo verifica. */
    .etq-pricebox{ flex:1; position:relative; background:var(--yellow); border-radius:2mm; display:flex;
      align-items:center; justify-content:center; padding:1.2mm 1.2mm 6.8mm; overflow:hidden; }
    .etq-pricebox::before{ content:""; position:absolute; inset:.8mm .8mm 6.8mm .8mm; border:.28mm dashed var(--green);
      border-bottom:0; border-radius:1.5mm 1.5mm 0 0; pointer-events:none; }
    /* 10mm de arranque (era 11.5): el precio unitario cede tamaño para que el mayoreo se lea.
       ⚠️ Este valor está duplicado en PRECIO_MM (lo necesita el TS para arrancar el
       auto-ajuste) y el spec exige que coincidan. */
    /* flex:none para que offsetWidth siga al font-size cuando el número crece. */
    .etq-price{ flex:none; font-family:var(--font-num); font-weight:400; font-size:10mm; line-height:.82; letter-spacing:0;
      transform:scaleX(1.1); transform-origin:center; }
    .etq-price .cur{ font-size:.5em; vertical-align:.6em; margin-right:.3mm; }
    .etq-price .dot{ font-size:.78em; }
    /* La franja de la UNIDAD: 4.4 → 6.2mm de alto y la palabra 2.7 → 4.2mm (+56%). Se fueron
       los dos guiones decorativos, que se comían 11.6mm (34% del ancho) para no decir nada:
       ese amarillo reaparece en el brote de la banda del nombre. Sin text-transform porque
       bigUnit.word puede ser 500 g y saldría 500 G. */
    .etq-pieza{ position:absolute; left:0; right:0; bottom:0; background:var(--green); color:#fff; height:6.2mm;
      display:flex; align-items:center; justify-content:center; padding:0 1mm;
      font-weight:800; font-size:4.2mm; white-space:nowrap; border-radius:0 0 1.6mm 1.6mm; }
    .etq-pieza-txt{ display:block; max-width:100%; white-space:nowrap; overflow:hidden; }
    .etq-pieza .pre{ font-size:.62em; font-weight:600; opacity:.85; margin-right:1mm; }
    .etq-pieza .u{ font-size:1em; font-weight:800; }
    .etq-right{ width:43.4mm; min-height:0; display:flex; flex-direction:column; }
    /* Los tiers se centran como grupo → 1 o 4 renglones siempre lucen balanceados (no flotan arriba). */
    /* Gap y padding apretados a propósito: el alto que ahorran acá se lo queda el MONTO, que es
       lo que se lee de lejos. Medido sobre los 9,013 productos con precios de etiqueta, el
       **76.1% tiene 2 renglones** y sólo el **2.0% tiene 4**, así que el caso común se imprime
       al tamaño grande y los de 4 bajan lo que haga falta (fitTiers). */
    .etq-tiers{ flex:1; min-height:0; display:flex; flex-direction:column; justify-content:center; gap:.5mm; }
    .etq-tier{ position:relative; display:grid; grid-template-columns:1fr auto; align-items:center;
      column-gap:1.2mm; padding:.2mm 0; min-height:0; }
    .etq-tier::before{ content:""; position:absolute; top:0; left:0; right:0; height:.28mm;
      background:repeating-linear-gradient(90deg, var(--green) 0 .32mm, transparent .32mm .6mm); }
    .etq-tier:first-child::before{ display:none; }
    .etq-tier .txt{ font-family:var(--font-cond); font-size:2.6mm; font-weight:400; line-height:1; letter-spacing:.3px; }
    /* Celda de precio de ancho fijo → todos los precios arrancan en el mismo x (orden a la izquierda). */
    .etq-tier .pricecell{ width:22mm; display:flex; align-items:baseline; gap:.7mm; }
    /* ⚠️ 5.4mm duplicado en MONTO_MM (el TS arranca de ahí el ajuste); el spec lo verifica.
       El PESO va por trazo, no por font-weight: Bebas Neue no tiene bold real y el navegador
       no la sintetiza — medido, font-weight:700 daba el MISMO ancho al píxel, o sea nada. */
    .etq-tier .amt{ font-family:var(--font-cond); font-weight:400; font-size:5.4mm; white-space:nowrap;
      letter-spacing:.3px; font-variant-numeric:tabular-nums; -webkit-text-stroke:.09mm currentColor; }
    .etq-tier .unit{ font-family:var(--font); font-size:1.7mm; font-weight:600; }
    /* MAYOREO: es el renglón por el que el cliente decide comprar más, así que se realza —
       chip amarillo de marca + trazo más grueso en el número. Es el mismo amarillo de la caja
       del precio grande, para que se lean como pareja. */
    .etq-tier.is-mayoreo{ background:rgba(246,196,0,.32); border-radius:1mm; padding:.3mm 1mm; margin:0 -1mm; }
    .etq-tier.is-mayoreo::before{ display:none; }
    .etq-tier.is-mayoreo + .etq-tier::before{ display:none; }
    .etq-tier.is-mayoreo .txt{ font-weight:400; letter-spacing:.4px; }
    .etq-tier.is-mayoreo .amt{ -webkit-text-stroke:.16mm currentColor; }
    /* El código toma el ANCHO COMPLETO de la columna (antes 85%): al angostar la etiqueta es lo
       único con un mínimo físico —un EAN-13 necesita ~29.8 mm al 80% de magnificación— y 39.4 mm
       lo deja con holgura. La altura no baja de 5 mm: es lo que el lector necesita para engancharlo. */
    /* 5mm es el ARRANQUE (lo necesita el primer render y el clon de impresión, igual que
       PRECIO_MM); fitBarcode lo sube inline con el aire que los renglones no usaron. */
    .etq-barcode{ margin-top:.3mm; display:flex; flex-direction:column; align-items:stretch; }
    .etq-barcode svg{ display:block; width:100%; height:5mm; }
    /* Los dígitos legibles del EAN/UPC, debajo de las barras: si el lector falla, es lo que la
       cajera teclea. Los pinta el componente (barcodeDigits), no JsBarcode — con
       preserveAspectRatio:none el texto del SVG se estiraría con las barras. 2 mm: no más chico
       que el "c/u" (1.7), que ya es lo más chico que se imprime. Cuestan ~2.2 mm de alto que
       antes se llevaba el símbolo; el caso común (2 renglones) no cambia de tamaño de monto. */
    .etq-bc-digits{ font-family:var(--font); font-weight:700; font-size:2mm; line-height:1; letter-spacing:.25mm;
      font-variant-numeric:tabular-nums; text-align:center; white-space:nowrap; margin-top:.2mm; }
    /* Sin ningún renglón (5.0% del catálogo) la columna sólo lleva el código: centrado, para
       que el blanco lea como margen y no como una falla. NO se rellena con un dato inventado. */
    .etq-right.is-solo{ justify-content:center; }
    .etq-right.is-solo .etq-tiers{ flex:0 0 auto; }
  `],
  template: `
    <div class="etq-label" #root>
      <!-- El brote vive ACÁ y no en la caja del precio: era el techo del número. Medido, con la
           franja de la unidad más alta, dejarlo adentro anulaba el crecimiento (−0.1%); afuera
           el precio gana +17.4%. Va en amarillo porque el verde medio desaparece sobre esta
           banda. fitPrice no lo tiene cableado: busca un obstáculo DENTRO de la caja y, si no
           lo encuentra, la guarda es 0 sola. -->
      <div class="etq-head" #head>
        <span class="etq-head-txt" #headtxt>{{ headName }}</span>
        <svg class="etq-sprout" viewBox="0 0 40 40" fill="#f6c400" aria-hidden="true"><path transform="translate(12,15) rotate(120)" d="M0 -11 C4.5 -5 5.5 0 4 4.5 C2.8 7.5 -2.8 7.5 -4 4.5 C-5.5 0 -4.5 -5 0 -11 Z"/><path transform="translate(22,10) rotate(150) scale(0.7)" d="M0 -11 C4.5 -5 5.5 0 4 4.5 C2.8 7.5 -2.8 7.5 -4 4.5 C-5.5 0 -4.5 -5 0 -11 Z"/></svg>
      </div>
      <div class="etq-body">
        <div class="etq-left">
          <div class="etq-meta">
            @if (model.content) { <span>{{ model.content }}</span><span class="sep">|</span> }
            <span>Código: <span class="etq-red">{{ model.sku }}</span></span>
          </div>
          <div class="etq-pricebox">
            <div class="etq-price" #priceEl><span class="cur">$</span>{{ bigInt }}<span class="dot">.</span>{{ bigDec }}</div>
            <!-- La UNIDAD del precio grande. El 73.5% de las etiquetas muestran un precio de
                 PAQUETE y el cliente compra esa unidad en el 92.8% de los renglones: leer el
                 número sin su unidad es el error más caro del proyecto (ADR-055). Por eso la
                 palabra va en su propio nivel de jerarquía, no como pie de foto. -->
            <div class="etq-pieza" #pieza>
              <span class="etq-pieza-txt" #piezaTxt><span class="pre">Precio por</span><span class="u">{{ bigUnit.word }}</span></span>
            </div>
          </div>
        </div>
        <div class="etq-right" [class.is-solo]="tierCount === 0">
          <!-- Rótulos CORTOS ("Mayoreo 3+ cajas" en vez de "Mayoreo desde 3 cajas:"): el
               rótulo era lo que se comía el ancho de la columna y obligaba a encoger el monto
               hasta dejarlo ilegible. Acortarlo es lo que permite el monto grande. -->
          <div class="etq-tiers" #tiers>
            @if (granelAltTier; as g) {
              <div class="etq-tier">
                <div class="txt">Por {{ g.label }}</div>
                <div class="pricecell"><span class="amt" #amtEl>\${{ g.value | number:'1.2-2' }}</span></div>
              </div>
            }
            @if (hasMayoreoPza) {
              <div class="etq-tier" [class.is-mayoreo]="realceMayoreoPza">
                <div class="txt">Mayoreo <span class="etq-red">{{ mayoreoMin }}+</span> {{ mayoreoBaseWord }}</div>
                <div class="pricecell"><span class="amt" #amtEl>\${{ model.wholesale_piece_price | number:'1.2-2' }}</span><span class="unit">c/u</span></div>
              </div>
            }
            @if (hasPaquete) {
              <div class="etq-tier">
                <div class="txt">Paquete <span class="etq-red">{{ model.pack_size }}</span> pzas</div>
                <div class="pricecell"><span class="amt" #amtEl>\${{ model.pack_price | number:'1.2-2' }}</span></div>
              </div>
            }
            @if (hasMayoreoPaq) {
              <div class="etq-tier" [class.is-mayoreo]="realceMayoreoPaq">
                <div class="txt">Mayoreo <span class="etq-red">{{ mayoreoPaqMin }}+</span> {{ mayoreoGroupWord }}</div>
                <div class="pricecell"><span class="amt" #amtEl>\${{ model.wholesale_pack_price | number:'1.2-2' }}</span><span class="unit">c/u</span></div>
              </div>
            }
            @if (hasCaja) {
              <div class="etq-tier">
                @if (isGranel) {
                  <div class="txt">Caja <span class="etq-red">{{ cajaWeight }}</span></div>
                } @else {
                  <div class="txt">Caja <span class="etq-red">{{ model.box_size }}</span> {{ boxContentWord }}</div>
                }
                <div class="pricecell"><span class="amt" #amtEl>\${{ model.box_price | number:'1.2-2' }}</span></div>
              </div>
            }
          </div>
          @if (hasBarcode) {
            <div class="etq-barcode">
              <svg #bc></svg>
              @if (barcodeDigits; as d) { <div class="etq-bc-digits">{{ d }}</div> }
            </div>
          }
        </div>
      </div>
    </div>
  `,
})
export class LabelComponent implements AfterViewInit, OnChanges {
  @Input({ required: true }) model!: LabelModel;
  @Input() show: LabelSections = ALL_SECTIONS;
  /** Precio que va en grande. Null = default (pieza con fallback). Intercambiable por ticket. */
  @Input() hero: HeroKey | null = null;
  @ViewChild('root') root?: ElementRef<HTMLElement>;
  @ViewChild('bc') bc?: ElementRef<SVGElement>;
  @ViewChild('head') head?: ElementRef<HTMLElement>;
  @ViewChild('headtxt') headtxt?: ElementRef<HTMLElement>;
  @ViewChild('priceEl') priceEl?: ElementRef<HTMLElement>;
  @ViewChild('pieza') pieza?: ElementRef<HTMLElement>;
  @ViewChild('piezaTxt') piezaTxt?: ElementRef<HTMLElement>;
  @ViewChild('tiers') tiers?: ElementRef<HTMLElement>;
  @ViewChildren('amtEl') amtEls?: QueryList<ElementRef<HTMLElement>>;

  private num(v: number | null | undefined): number { return typeof v === 'number' && isFinite(v) ? v : 0; }

  get headName(): string {
    return (this.model?.name || '').replace(/\s+\d+(?:[.,]\d+)?\s*(?:kg|g|gr|grs|ml|l)\s*\/?\s*\d*\s*$/i, '').trim() || this.model?.name || '';
  }
  /**
   * Umbral del mayoreo por pieza. Devuelve `null` cuando Kepler no lo trae — **nunca 3**.
   *
   * Antes era `this.model?.wholesale_piece_min_qty || 3`: la etiqueta AFIRMABA "Mayoreo 3+"
   * sobre un papel que el cliente sostiene, sin dato que lo respalde (y además convertía un 0
   * o un 1 en 3). Su gemelo `mayoreoPaqMin` ya hacía lo correcto. Medido en prod: hoy 0
   * productos disparan ese default, así que esto no cambia ninguna etiqueta — es el candado
   * para que un hueco de datos nunca se imprima como un hecho.
   */
  get mayoreoMin(): number | null { const m = this.num(this.model?.wholesale_piece_min_qty); return m > 1 ? m : null; }

  // ── Unidad BASE de venta (piece_price == Kepler c90). `unit_base` dice QUÉ es esa fila:
  //    PAQ → el producto se vende POR PAQUETE (c90 = precio del paquete), CJA → por caja, resto
  //    → pieza. (Granel — KG/gramos — se resuelve por kg/porción aparte.) ~75% del catálogo es
  //    base PAQ: antes imprimía "Precio por pieza" con el precio del paquete → bug de unidad.
  get baseUnit(): 'paquete' | 'caja' | 'pieza' {
    const ub = (this.model?.unit_base || '').toUpperCase();
    if (ub === 'PAQ') return 'paquete';
    if (ub === 'CJA') return 'caja';
    return 'pieza';
  }
  /** El producto se vende agrupado (paquete/caja) como unidad base, no por pieza suelta. */
  get baseIsGrouped(): boolean { return this.baseUnit !== 'pieza'; }
  private plural(u: string): string { return u === 'pieza' ? 'pzas' : u === 'paquete' ? 'paquetes' : 'cajas'; }
  /** Umbral del mayoreo por paquete (min_qty del tier elegido). null = sin umbral confiable. */
  get mayoreoPaqMin(): number | null { const m = this.num(this.model?.wholesale_pack_min_qty); return m > 1 ? m : null; }
  /** Palabra plural del tier de mayoreo agrupado: paquetes/cajas (o 'paquetes' en base pieza). */
  get mayoreoGroupWord(): string { return this.baseIsGrouped ? this.plural(this.baseUnit) : 'paquetes'; }
  /** Unidad del mayoreo de la BASE (no agrupada): KG→'kg', granel numérico/PZA→'pzas'. */
  get mayoreoBaseWord(): string { return (this.model?.unit_base || '').toUpperCase() === 'KG' ? 'kg' : 'pzas'; }
  /** Contenido de la caja: en base agrupada la caja trae N paquetes/cajas, no piezas. */
  get boxContentWord(): string { return this.baseIsGrouped ? this.plural(this.baseUnit) : 'pzas'; }

  // ── F1: visibilidad data-driven — un tier solo se muestra si el multiselect lo
  //    pide Y hay dato real (precio > 0 y, donde aplica, tamaño > 0). Mata los $0.00 y (0 pzas).
  // ── F5: además, un mayoreo solo se muestra si CUADRA (es más barato que su precio base);
  //    un "mayoreo" ≥ menudeo es dato erróneo de Kepler → se oculta en vez de imprimir un precio absurdo.
  /** El precio grande (hero) es la unidad BASE (pieza/paquete/caja base o granel). null = sin scan → base. */
  get bigIsBase(): boolean { const h = this.hero; return !h || h === 'pieza' || h === 'kg'; }
  get hasMayoreoPza(): boolean {
    // Base agrupada (paquete/caja) no tiene "pieza suelta" que mayorear → se oculta.
    if (this.baseIsGrouped) return false;
    // El mayoreo debe ser el de la UNIDAD LEÍDA: pieza solo si el hero es la base (pieza/granel).
    if (!this.bigIsBase) return false;
    const w = this.num(this.model?.wholesale_piece_price);
    const base = this.num(this.model?.piece_price);
    // Sin umbral REAL no se imprime: la etiqueta declara un precio que la caja va a cobrar, y
    // un mayoreo cuya condición de cantidad no se conoce fabrica una discusión en el mostrador.
    if (this.mayoreoMin === null) return false;
    return !!this.show.mayoreoPza && w > 0 && (base <= 0 || w < base);
  }

  /**
   * ⭐ El REALCE (chip amarillo + trazo grueso) exige que el mayoreo sea de verdad un descuento.
   *
   * Medido en prod sobre la comparación limpia (base=PAQ vs mayoreo de paquete, 6,441
   * productos): descuento mediano **7.9%**, p90 9.8% — pero **265 productos traen menos de 1%**
   * y hoy imprimen la señal visual de "oferta" sobre un precio materialmente igual. El renglón
   * NO se oculta (el precio sí es más bajo, y esconderlo sorprendería a quien compare contra la
   * pantalla): pierde el realce y se imprime como cualquier otro.
   *
   * Los que son ≥ menudeo ya los descarta `hasMayoreo*`.
   */
  private descuento(w: number, base: number): number {
    return base > 0 && w > 0 ? (base - w) / base : 0;
  }
  get realceMayoreoPza(): boolean {
    return this.descuento(this.num(this.model?.wholesale_piece_price), this.num(this.model?.piece_price)) >= MAYOREO_MIN_DESC;
  }
  get realceMayoreoPaq(): boolean {
    const base = this.baseIsGrouped ? this.num(this.model?.piece_price) : this.num(this.model?.pack_price);
    return this.descuento(this.num(this.model?.wholesale_pack_price), base) >= MAYOREO_MIN_DESC;
  }
  /** Cuántos renglones se van a imprimir. Alimenta el centrado del caso sin renglones. */
  get tierCount(): number {
    return (this.granelAltTier ? 1 : 0) + (this.hasMayoreoPza ? 1 : 0) + (this.hasPaquete ? 1 : 0)
      + (this.hasMayoreoPaq ? 1 : 0) + (this.hasCaja ? 1 : 0);
  }
  get hasPaquete(): boolean { return !!this.show.paquete && this.num(this.model?.pack_price) > 0 && this.num(this.model?.pack_size) > 0; }
  get hasMayoreoPaq(): boolean {
    // El comparativo depende de la unidad base (Kepler unit_base):
    //  · base=paquete/caja → el "precio de paquete" ES el precio base (c90/piece_price); el
    //    mayoreo (wholesale_pack_price) vive suelto porque el paquete no está en pack_size. F-unit.
    //  · base=pieza → paquete REAL de piezas (pack_price + pack_size), igual que antes. F5.
    const w = this.num(this.model?.wholesale_pack_price);
    if (!this.show.mayoreoPaq || w <= 0) return false;
    // Sin umbral REAL no se imprime (17 productos en prod imprimían "Mayoreo" pelado, sin
    // decir desde cuántos). Mismo criterio que `hasMayoreoPza`.
    if (this.mayoreoPaqMin === null) return false;
    if (this.baseIsGrouped) {
      // base es paquete/caja → este ES el mayoreo de la unidad base → solo si el hero es la base.
      if (!this.bigIsBase) return false;
      const base = this.num(this.model?.piece_price);
      return base > 0 && w < base;
    }
    // base=pieza → mayoreo por PAQUETE → solo si se leyó/eligió el paquete.
    if (this.hero !== 'paquete') return false;
    const base = this.num(this.model?.pack_price);
    const size = this.num(this.model?.pack_size);
    return base > 0 && size > 0 && w < base;
  }
  get hasCaja(): boolean { return !!this.show.caja && this.num(this.model?.box_price) > 0 && this.num(this.model?.box_size) > 0; }
  // Muestra el barcode si el multiselect lo pide Y hay algo que codificar: EAN/UPC válido
  // del producto, o al menos el SKU (fallback CODE128) → toda etiqueta sale escaneable.
  get hasBarcode(): boolean { return !!this.show.barcode && (!!(this.model?.barcode && this.model?.barcode_format) || !!(this.model?.sku && this.model.sku.trim())); }

  /**
   * Los dígitos legibles del símbolo, agrupados como en el empaque (EAN-13 "7 501234 567893",
   * UPC-A "0 12345 67890 5", EAN-8 "9638 5074"). `null` para el CODE128 de respaldo: codifica el
   * SKU, que ya está impreso arriba en "Código:", y repetirlo costaría 2 mm de barras.
   */
  get barcodeDigits(): string | null {
    const d = (this.model?.barcode || '').trim();
    switch (this.model?.barcode_format) {
      case 'EAN13': return d.length === 13 ? `${d[0]} ${d.slice(1, 7)} ${d.slice(7)}` : null;
      case 'UPC': return d.length === 12 ? `${d[0]} ${d.slice(1, 6)} ${d.slice(6, 11)} ${d[11]}` : null;
      case 'EAN8': return d.length === 8 ? `${d.slice(0, 4)} ${d.slice(4)}` : null;
      default: return null;
    }
  }

  /**
   * ¿Producto a GRANEL (se vende por KILO)? `unit_base` = tamaño de la porción base: "KG" (1 kg)
   * o gramos ("500"/"250"/"400"). SOLO es granel si `sold_by_kg` (Kepler: base KG o tier KG) →
   * evita fabricar "$/kg" para bolsas/palitos con unit_base numérico que NO se venden por kilo
   * (ej. 68521 PALO, POLIPRO). Sin presentación en kilos → 0 (cae a "Precio por pieza").
   */
  private get granelGrams(): number {
    if (!this.model?.sold_by_kg) return 0;
    const ub = (this.model?.unit_base || '').toUpperCase();
    if (ub === 'KG') return 1000;
    return /^\d+$/.test(ub) ? parseInt(ub, 10) : 0; // 500g/250g/400g; 0 = no es granel
  }
  /** Precio por kg del granel: pza × (1000 / gramos de la porción base). */
  private get perKgPrice(): number {
    const g = this.granelGrams;
    return g > 0 ? this.num(this.model?.piece_price) * 1000 / g : 0;
  }
  get isGranel(): boolean { return this.granelGrams > 0; }
  /** Peso de la caja en granel: box_size × porción (10×500g = "5 kg"). */
  get cajaWeight(): string {
    const g = this.num(this.model?.box_size) * this.granelGrams;
    return g >= 1000 ? `${+(g / 1000).toFixed(2)} kg` : `${g} g`;
  }

  /**
   * Precio grande. Con `hero` explícito (intercambiable por ticket) usa ese precio si es válido.
   * GRANEL (unit_base KG/500/250/…): el "pieza" se muestra como **precio por kg**.
   * Sin override: pieza/kg; si no hay (>0), cae a paquete → caja para no imprimir $0.00.
   */
  get bigUnit(): { word: string; value: number } {
    const m = this.model;
    const grams = this.granelGrams;
    const granel = grams > 0;
    const piece = this.num(m?.piece_price);
    const portionWord = grams >= 1000 ? 'kg' : `${grams} g`; // "500 g" / "kg"

    // Overrides explícitos por ticket.
    if (this.hero === 'kg' && granel) return { word: 'kg', value: this.perKgPrice };
    if (this.hero === 'paquete' && this.num(m?.pack_price) > 0) return { word: 'paquete', value: this.num(m?.pack_price) };
    if (this.hero === 'caja' && this.num(m?.box_price) > 0) return { word: 'caja', value: this.num(m?.box_price) };
    if (this.hero === 'pieza' && piece > 0) return granel ? { word: portionWord, value: piece } : { word: this.baseUnit, value: piece };

    // Default: granel = por kg (se vende por kilo); normal = unidad base (pieza/paquete/caja
    // según Kepler unit_base); con fallback. c90 es el precio de ESA unidad base.
    if (granel && (piece > 0 || this.perKgPrice > 0)) return { word: 'kg', value: this.perKgPrice };
    if (piece > 0) return { word: this.baseUnit, value: piece };
    if (this.num(m?.pack_price) > 0) return { word: 'paquete', value: this.num(m?.pack_price) };
    if (this.num(m?.box_price) > 0) return { word: 'caja', value: this.num(m?.box_price) };
    return granel ? { word: 'kg', value: 0 } : { word: this.baseUnit, value: 0 };
  }

  /**
   * Granel de porción < 1 kg (500 g / 250 g / …): muestra el OTRO precio como tier para ver
   * AMBOS — si el hero es por kg, el tier es la porción; si el hero es la porción, el tier es kg.
   */
  get granelAltTier(): { label: string; value: number } | null {
    // Obedece al multiselect como los otros cuatro renglones: era el único que no se podía apagar.
    if (!this.show.granel) return null;
    const grams = this.granelGrams;
    if (grams <= 0 || grams >= 1000) return null;
    const piece = this.num(this.model?.piece_price);
    if (piece <= 0) return null;
    return this.bigUnit.word === 'kg'
      ? { label: `${grams} g`, value: piece }
      : { label: '1 kg', value: this.perKgPrice };
  }
  private get bigStr(): string { return this.bigUnit.value.toFixed(2); }
  // F4: separador de miles (igual que los tiers con number:'1.2-2') → "1,044".
  get bigInt(): string { return this.bigStr.split('.')[0].replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  get bigDec(): string { return this.bigStr.split('.')[1] ?? '00'; }

  ngAfterViewInit(): void { this.render(); FUENTES_USABLES.then(() => this.settle()); }
  ngOnChanges(): void { queueMicrotask(() => { this.unsettle(); this.render(); FUENTES_USABLES.then(() => this.settle()); }); }

  private render(): void { this.renderBarcode(); this.layout(); }

  /**
   * El pase DEFINITIVO: corre después de `FUENTES_USABLES`, o sea medido con la tipografía que va
   * a imprimir (Anton, o la fallback si a los 3 s no llegó — que ahí es la correcta). Deja una
   * marca en el DOM para quien tenga que esperarlo: la impresión clona la hoja oculta por
   * `innerHTML` con los tamaños ya inline, y antes esperaba 500 ms fijos — en un equipo frío se
   * llevaba los tamaños medidos con la fallback: el número chico, por la única puerta que faltaba.
   */
  private settle(): void {
    this.layout();
    this.root?.nativeElement.setAttribute('data-etq-settled', FUENTES_OK ? 'fonts' : 'fallback');
  }
  /** Un cambio de modelo invalida la marca hasta que se vuelva a medir. */
  private unsettle(): void { this.root?.nativeElement.removeAttribute('data-etq-settled'); }

  /**
   * Corre todos los auto-ajustes. El ORDEN es obligatorio y está candado en el spec:
   *   · `fitUnit` antes de `fitPrice` — la franja de la unidad define cuánto alto le queda al número;
   *   · `fitPrice` antes de `fitTiers` — el techo del monto se clampea contra el hero MEDIDO;
   *   · `fitTiers` antes de `fitAmts` — el primero iguala todos los montos a lo alto, el segundo
   *     encoge el que no quepa a lo ancho de su celda;
   *   · `fitBarcode` al final — el aire sólo se puede medir cuando los montos ya se asentaron.
   */
  private layout(): void { this.fitHead(); this.fitUnit(); this.fitPrice(); this.fitTiers(); this.fitAmts(); this.fitBarcode(); }

  /**
   * Alto que ocupan los renglones de tier, medido por EXTENSIÓN DE LOS HIJOS.
   *
   * ⛔ NO se puede usar `scrollHeight`: el bloque es flex con `justify-content:center`, y ahí
   * `scrollHeight` nunca baja de `clientHeight` (reporta 0 de aire donde hay 6 mm) ni ve el
   * desborde por el borde de arriba (con contenido centrado que se pasa, la mitad del exceso es
   * invisible). Para encoger eso era un defecto tolerado; para CRECER sería un recorte.
   */
  private altoTiers(box: HTMLElement): number {
    const hijos = Array.from(box.children) as HTMLElement[];
    if (!hijos.length) return 0;
    const k = this.escalaVisual(box);
    const gap = parseFloat(getComputedStyle(box).rowGap || '0') || 0;
    return hijos.reduce((a, e) => a + e.getBoundingClientRect().height / k, 0) + (hijos.length - 1) * gap;
  }

  /**
   * ⭐ Escala VISUAL del elemento — y por qué existe.
   *
   * La vista de hoja dibuja las etiquetas bajo un transform:scale. Ahí getBoundingClientRect()
   * viene ESCALADO y offsetHeight / clientHeight siguen en px de layout: son dos espacios
   * distintos y compararlos no es un redondeo, es un factor.
   *
   * Medido sobre altoTiers vs clientHeight, que es justo donde se mezclaban:
   *   escala 0.47 (la vieja, fija) → el alto de los renglones se SUB-estima 53% → nunca dispara
   *     el encogido, los montos crecen hasta el tope y el bloque se desborda (lo tapa el
   *     overflow:hidden, así que se ve como un renglón cortado).
   *   escala 1.42 (monitor grande, con la hoja ya escalada al espacio) → se SOBRE-estima 42% →
   *     el ajuste encoge los montos hasta el piso: "el precio del paquete salió diminuto".
   *
   * La hoja de IMPRESIÓN no va escalada, así que siempre midió bien: de ahí que lo que se ve en
   * pantalla no coincidiera con lo que sale del papel. Con esto, las dos miden igual.
   */
  private escalaVisual(el: HTMLElement): number {
    const alto = el.offsetHeight;
    if (!(alto > 0)) return 1;
    const k = el.getBoundingClientRect().height / alto;
    return Number.isFinite(k) && k > 0.01 ? k : 1;
  }

  /** Reduce la fuente hasta que `el` (contenido) quepa en su contenedor, con piso mínimo. */
  private shrinkToFit(el: HTMLElement, container: HTMLElement, startMm: number, minMm: number, stepMm = 0.2): void {
    let size = startMm;
    el.style.fontSize = size + 'mm';
    let guard = 0;
    while (container.scrollWidth > container.clientWidth && size > minMm && guard++ < 120) {
      size -= stepMm;
      el.style.fontSize = size + 'mm';
    }
  }

  /** Auto-ajuste del nombre (una línea en el header). */
  private fitHead(): void {
    const head = this.head?.nativeElement;
    const txt = this.headtxt?.nativeElement;
    if (!head || !txt) return;
    let size = 3.9;
    head.style.fontSize = size + 'mm';
    let guard = 0;
    while (txt.scrollWidth > txt.clientWidth && size > 2.3 && guard++ < 40) {
      size -= 0.12;
      head.style.fontSize = size + 'mm';
    }
  }

  /** Auto-ajuste de la franja de la UNIDAD. Sólo encoge — calco de `fitHead`. */
  private fitUnit(): void {
    const franja = this.pieza?.nativeElement;
    const txt = this.piezaTxt?.nativeElement;
    if (!franja || !txt) return;
    let size = UNIDAD_MM;
    franja.style.fontSize = size + 'mm';
    if (!(txt.clientWidth > 0)) return;
    let guard = 0;
    while (txt.scrollWidth > txt.clientWidth && size > 2.4 && guard++ < 60) {
      size -= 0.1;
      franja.style.fontSize = size + 'mm';
    }
  }

  /**
   * El precio grande se ajusta a su caja en los DOS sentidos: encoge si no cabe y **crece si
   * sobra**. Antes sólo encogía desde el arranque, así que usaba **57% del alto de la caja
   * siempre** — un `$8.66` se imprimía a 10 mm en un hueco donde caben 14.75.
   *
   * Usa `offsetWidth` (layout, agnóstico al scale del sheet-sim) ×1.12 para compensar el
   * `scaleX(1.1)` del precio. ⛔ NO cambiar a `scrollWidth`: el recorte lo hace el
   * `overflow:hidden` de la caja, así que el texto medido contra sí mismo "siempre cabe" — ese
   * es el falso verde que ya se pagó una vez.
   *
   * La guarda del obstáculo se **mide, no se escribe**: busca un elemento absoluto dentro de la
   * caja y le respeta su alto. Hoy no hay ninguno (el brote se mudó a la banda del nombre) y la
   * guarda sale 0 sola; si mañana alguien mete una insignia ahí, el número se protege solo.
   */
  private fitPrice(): void {
    const el = this.priceEl?.nativeElement;
    const box = el?.parentElement; // .etq-pricebox
    if (!el || !box) return;
    const cs = getComputedStyle(box);
    const avail = box.clientWidth - parseFloat(cs.paddingLeft || '0') - parseFloat(cs.paddingRight || '0');
    // ANTI-TRINQUETE: siempre se resetea al arranque. `layout()` corre 2-4 veces por etiqueta
    // (los dos hooks, `render()`, y otra vez cuando las fuentes quedan usables); crecer desde el
    // tamaño ACTUAL subiría en cada pasada. El defecto no existía cuando todo sólo encogía.
    let size = PRECIO_MM;
    el.style.fontSize = size + 'mm';
    // La OTRA mitad del bug del número chico: si la caja todavía no tiene ancho (etiqueta
    // recién creada, oculta o sin estilos aplicados), `clientWidth` da 0 → `avail` sale
    // NEGATIVO → el bucle corre hasta el piso y el precio queda en 4.5 mm, la versión
    // dramática de "se ve más chico". Sin medida no se encoge: se deja el tamaño de arranque
    // y el siguiente pase (fuentes usables) lo corrige con una medida de verdad.
    if (!(avail > 0)) return;
    const obstaculo = box.querySelector<HTMLElement>('.etq-sprout');
    // La diferencia de dos rects viene en px VISUALES; availH está en px de layout. Se divide
    // por la escala para no restar un número de otro espacio (ver escalaVisual).
    const kBox = this.escalaVisual(box);
    const guarda = obstaculo
      ? Math.max(0, (obstaculo.getBoundingClientRect().bottom - box.getBoundingClientRect().top) / kBox
          - parseFloat(cs.paddingTop || '0'))
      : 0;
    const availH = box.clientHeight - parseFloat(cs.paddingTop || '0') - parseFloat(cs.paddingBottom || '0') - guarda;
    if (!(availH > 0)) return;
    const cabe = () => el.offsetWidth * 1.12 <= avail && el.offsetHeight <= availH;
    let guard = 0;
    if (!cabe()) {
      while (!cabe() && size > 4.5 && guard++ < 120) {
        size -= 0.25;
        el.style.fontSize = size + 'mm';
      }
      return;
    }
    // ⭐ Crecer SÓLO con las fuentes usables. Medir con una fallback más ANGOSTA (Arial Narrow,
    // −1..7%) y crecer dejaría el número más grande de lo que Anton aguanta → al llegar la
    // fuente buena, se recorta. Antes de eso el techo es el arranque, o sea se comporta
    // exactamente como la versión que sólo encogía.
    const techo = FUENTES_OK ? PRECIO_MAX_MM : PRECIO_MM;
    while (size + 0.25 <= techo && guard++ < 120) {
      el.style.fontSize = (size + 0.25) + 'mm';
      if (!cabe()) { el.style.fontSize = size + 'mm'; return; }
      size += 0.25;
    }
  }

  /**
   * Ajuste VERTICAL del bloque de tiers: baja el tamaño de todos los montos por igual hasta
   * que los renglones quepan a lo alto de su columna.
   *
   * Antes no existía y el bloque se RECORTABA en silencio (lo tapa el `overflow:hidden` de la
   * etiqueta): con 4 renglones el contenido medía 100 px contra 92 de caja **ya en la etiqueta
   * de 115×40**, o sea que el último tier salía cortado desde antes de reducir el tamaño. Con
   * esto, 1-3 tiers —el caso común— se imprimen al tamaño grande, y 4 bajan lo necesario en vez
   * de perder un renglón.
   */
  private fitTiers(): void {
    const box = this.tiers?.nativeElement;
    const amts = this.amtEls;
    if (!box || !amts?.length) return;
    if (!(box.clientHeight > 0)) return; // sin medida no se toca (ver fitPrice)
    let size = MONTO_MM; // anti-trinquete: siempre desde el arranque (ver fitPrice)
    const set = (mm: number) => amts.forEach((r) => { r.nativeElement.style.fontSize = mm + 'mm'; });
    set(size);
    const noCabe = () => this.altoTiers(box) > box.clientHeight + 1;
    // El ANCHO entra en los DOS sentidos. En el crecimiento, para no crecer y que después
    // `fitAmts` encoja individualmente los montos de 3-4 cifras. Y en el encogimiento, porque
    // antes sólo se miraba el alto: un monto que ya al arranque no cabía en su celda bajaba SOLO
    // en `fitAmts`, y un monto más chico que su vecino se lee como error de dato, no como
    // diseño. La uniformidad es toda la razón de ser de este ajuste; `fitAmts` queda de red.
    const anchoOk = () => amts.toArray().every((r: ElementRef<HTMLElement>) => {
      const c = r.nativeElement.parentElement;
      return !c || c.scrollWidth <= c.clientWidth;
    });
    let guard = 0;
    if (noCabe() || !anchoOk()) {
      while ((noCabe() || !anchoOk()) && size > 2.6 && guard++ < 60) {
        size -= 0.2;
        set(size);
      }
      return;
    }
    // ── crecimiento
    // El techo se clampea contra el hero MEDIDO, no sólo contra la constante: con un precio de
    // 4 cifras el hero baja de 10 mm y un monto de 7 sería más grande que el precio grande. Así
    // "el precio grande es siempre el número más grande de la etiqueta" queda como invariante.
    const heroMm = parseFloat(this.priceEl?.nativeElement.style.fontSize || '') || PRECIO_MM;
    const techo = FUENTES_OK ? Math.min(MONTO_MAX_MM, heroMm * 0.7) : MONTO_MM;
    while (size + 0.2 <= techo && guard++ < 60) {
      set(size + 0.2);
      if (noCabe() || !anchoOk()) { set(size); return; }
      size += 0.2;
    }
  }

  /**
   * El código de barras se lleva el aire que los renglones NO usaron.
   *
   * A 5 mm el símbolo está al **19% de la altura nominal de un EAN-13** (25.9 mm), y el símbolo
   * truncado es la causa número uno de no-lectura en ángulo. Medido sobre el catálogo, el bloque
   * de renglones deja 7.7 mm de aire en promedio (21 mm en el 5% que no tiene ningún renglón).
   *
   * Es una transferencia de UNA pasada, no un bucle: consume el aire medido menos 0.3 mm de
   * holgura, así que el bloque se contrae exactamente por lo que no estaba usando y no hay
   * circularidad. El ANCHO no se toca (mínimo físico del EAN-13).
   */
  private fitBarcode(): void {
    const svg = this.bc?.nativeElement;
    const box = this.tiers?.nativeElement;
    if (!svg || !box) return;
    if (!(box.clientHeight > 0)) return;
    const aire = (box.clientHeight - this.altoTiers(box)) / 96 * 25.4;
    if (!(aire > 0)) return;
    const alto = Math.max(BARCODE_MIN_MM, Math.min(BARCODE_MAX_MM, BARCODE_MIN_MM + aire - 0.3));
    svg.style.height = alto + 'mm';
  }

  /**
   * Cada monto se encoge hasta caber en su celda, preservando el "c/u". Arranca del tamaño que
   * dejó `fitTiers` (no de la constante) para no deshacer el ajuste vertical.
   */
  private fitAmts(): void {
    this.amtEls?.forEach((ref) => {
      const amt = ref.nativeElement;
      const cell = amt.parentElement; // .pricecell
      if (!cell || !(cell.clientWidth > 0)) return;
      const desde = parseFloat(amt.style.fontSize) || MONTO_MM;
      this.shrinkToFit(amt, cell, desde, 2.4, 0.15);
    });
  }

  private renderBarcode(): void {
    const el = this.bc?.nativeElement;
    if (!el) return;
    el.innerHTML = '';
    // 1) EAN/UPC/EAN8 válido del producto (== lo que el lector matchea). 2) fallback: CODE128
    //    del SKU, para que TODA etiqueta salga con un código escaneable (resolve matchea por SKU).
    let code = this.model?.barcode;
    let fmt = this.model?.barcode_format;
    if (!code || !fmt) {
      const sku = (this.model?.sku || '').trim();
      if (!sku) return;
      code = sku;
      fmt = 'CODE128';
    }
    try {
      // La zona muda va ADENTRO del SVG (ver ZONA_MUDA). `displayValue:false` a propósito: los
      // dígitos los pinta `barcodeDigits` en HTML — el texto del SVG se estiraría con las barras.
      const [zl, zr] = ZONA_MUDA[String(fmt)] ?? ZONA_MUDA['CODE128'];
      JsBarcode(el, code, {
        format: fmt as any, displayValue: false, width: BARCODE_MODULE_PX, height: 66,
        marginTop: 0, marginBottom: 0, marginLeft: zl * BARCODE_MODULE_PX, marginRight: zr * BARCODE_MODULE_PX,
      });
      // JsBarcode escribe `width="226px"` (con unidad); un viewBox lleva NÚMEROS. Se copiaba el
      // texto tal cual y salía `viewBox="0 0 226px 98px"`, inválido. Lo destapó el spec del
      // componente al leer el atributo.
      const w = parseFloat(el.getAttribute('width') || '');
      const h = parseFloat(el.getAttribute('height') || '');
      if (w > 0 && h > 0) {
        el.setAttribute('viewBox', `0 0 ${w} ${h}`);
        el.setAttribute('preserveAspectRatio', 'none');
        el.removeAttribute('width');
        el.removeAttribute('height');
      }
    } catch { /* código inválido → sin barcode */ }
  }
}
