import {
  AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, Input, NgZone,
  OnChanges, OnDestroy, QueryList, ViewChild, ViewChildren, ViewEncapsulation, inject,
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
 * ⭐ EL BUG DEL "número que a veces se ve más chico" — y su hermano, el que a veces DESBORDA.
 *
 * Los ajustes (`fitPrice`, `fitAmts`, …) encogen o crecen el texto midiendo su ancho. Una
 * medida vale para el instante en que se tomó. Si DESPUÉS cambia la tipografía (llegó Anton, o
 * se está pintando con la de respaldo), el texto (llegó el precio del ERP) o la geometría (la
 * hoja se re-escaló, entró a impresión), el tamaño que dejó queda mal: chico si midió con una
 * fuente más ancha, desbordado si midió con una más angosta o con menos cifras. Medido (mismo
 * precio, misma caja, cambiando sólo la fuente con la que se mide):
 *
 *   midiendo con        ancho vs Anton    un precio de 4 cifras queda en
 *   Anton (la buena)    —                 9.00 mm
 *   Impact (Windows)    +5…8%             8.50 mm
 *   Helvetica (iPad)    +13…21%           7.50 mm  ← 17% más chico
 *   Arial Narrow        −1…7%             9.25 mm  (y al llegar Anton se RECORTA)
 *
 * Tres versiones de este archivo arreglaron "el momento que faltaba" —esperar `fonts.check` en
 * vez de `fonts.ready`; colgar el re-layout también de `ngOnChanges`; volver a medir el número
 * al cierre del pase— y cada una dejó abierto el momento siguiente. El 2026-09-15, en una caja
 * de Yurécuaro y con el último de esos parches ya en producción: número a 15 mm (el techo) con
 * 127 px en 120 disponibles. Para crecer hasta ahí el bucle tuvo que medir ≤107 px, o sea el
 * insumo de la medida cambió un 19% DESPUÉS del pase, y nada volvía a medir.
 *
 * Por eso ya no hay "momentos". `observar()` mira los tres insumos de la medida —geometría
 * (`ResizeObserver`), texto (`MutationObserver`, sin atributos) y tipografía (`fonts`
 * `loadingdone` + `familiasFaltantes()` leída AL MEDIR, no un booleano de una vez)— y
 * `ajustar()` vuelve a correr los ajustes cuando la FIRMA de esos insumos cambia, y sólo
 * entonces (idempotente, sin lazo). Al terminar deja su veredicto en el DOM (`data-etq-fit`)
 * para que la impresión lo DIGA en vez de imprimir callada (ADR-056). Y las tres familias
 * viajan con la app (`assets/fonts`): la caja sin internet mide con lo mismo que la de al lado.
 */

/**
 * Tamaños de ARRANQUE de los dos números que se auto-ajustan. Están también en el CSS (los
 * necesita el primer render y el clon de impresión, antes de que corra el TS), y el spec
 * `etiqueta-hoja.spec.ts` exige que coincidan: si se cambia uno solo, el número arranca de un
 * tamaño y se mide contra otro.
 */
const PRECIO_MM = 10;
const MONTO_MM = 5.4;
/**
 * Arranque y ALTO del renglón "contenido | Código: NNNNN".
 *
 * El alto es lo que importa: es el único bloque de la columna izquierda que se interponía
 * entre la caja del precio y su altura real. Con él fijo, el precio deja de depender de
 * cuántas líneas ocupe un texto que no controlamos. Duplicados en el CSS (ver `.etq-meta`).
 */
const META_MM = 3.2;
const META_ALTO_MM = 5.1;
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
 * Las familias de las que depende el TAMAÑO medido, exportadas para que la pantalla declare
 * exactamente éstas y no otra.
 *
 * ⚠️ Las tres cuentan, y eso no era obvio: el diagnóstico de la etiquetera comprobaba sólo
 * Anton —la del número— y decía "tipografía ✓" mientras el precio salía 25% más chico porque
 * la que faltaba era **Baloo 2**, la del renglón del código, que es la que define cuánto alto
 * le queda a la caja del precio. Un verde que mira la fuente equivocada es un falso verde
 * (ADR-056): la pantalla tiene que declarar la que de verdad decide.
 */
export const FUENTES_SPECS: readonly string[] = ['11mm Anton', "5mm 'Bebas Neue'", "4mm 'Baloo 2'"];

/**
 * ¿Cuáles de las tres familias NO están usables AHORA? `[]` = las tres listas. `null` = este
 * navegador no deja preguntar → se declara "sin verificar", no se asume que está bien.
 *
 * Es una FUNCIÓN y no una bandera a propósito: la respuesta cambia con el tiempo (una fuente
 * llega a los 4 s) y el que mide la necesita en el instante de medir, no la de hace un rato.
 *
 * ⭐ `fonts.check()` solo NO alcanza, y es la especificación, no un bug del navegador: cuando
 * NINGUNA `@font-face` coincide con la familia preguntada, `check()` devuelve **true** ("no hay
 * nada que cargar"). Con las familias por `@import` eso pasaba en la ventana entre montar el
 * componente y bajar el CSS: `check('11mm Anton')` decía sí sin que Anton existiera. Por eso,
 * cuando el navegador expone la lista de caras (`FontFaceSet` es iterable), se exige además una
 * cara de esa familia con `status === 'loaded'`. Sin lista, `check` es todo lo que hay y se usa.
 */
export function familiasFaltantes(): string[] | null {
  const f: any = (globalThis as any).document?.fonts;
  if (!f?.check) return null;
  try {
    let cargadas: Set<string> | null = null;
    if (typeof f[Symbol.iterator] === 'function' || typeof f.forEach === 'function') {
      cargadas = new Set<string>();
      const caras: any[] = [];
      if (typeof f[Symbol.iterator] === 'function') caras.push(...Array.from(f as Iterable<any>));
      else f.forEach((c: any) => caras.push(c));
      for (const c of caras) if (c?.status === 'loaded') cargadas.add(String(c.family || '').replace(/^["']|["']$/g, ''));
    }
    return FUENTES_SPECS.filter((s) => {
      if (!f.check(s)) return true;
      if (!cargadas) return false;
      const familia = s.replace(/^[\d.]+mm /, '').replace(/^["']|["']$/g, '');
      return !cargadas.has(familia);
    });
  } catch { return null; }
}

/**
 * Resuelve cuando las tres familias están REALMENTE usables, o a los 3 s. Es una ESPERA, no una
 * verdad: quien necesita saber si las fuentes están usables pregunta `familiasFaltantes()` en
 * el momento de medir (ver `ajustar()`). Exportada porque la impresión la espera antes de
 * clonar la hoja (ver `print()` en la etiquetera).
 */
export const FUENTES_USABLES: Promise<void> = (() => {
  const f: any = (globalThis as any).document?.fonts;
  if (!f?.load || !f?.check) return Promise.resolve();
  return new Promise<void>((resolve) => {
    Promise.all(FUENTES_SPECS.map((s) => f.load(s).catch(() => undefined))).catch(() => undefined);
    const t0 = Date.now();
    const tick = () => {
      if (familiasFaltantes()?.length === 0 || Date.now() - t0 > 3000) { resolve(); return; }
      setTimeout(tick, 60);
    };
    tick();
  });
})();

/**
 * ⭐ La espera TERMINÓ (con fuentes o por tope). Gobierna únicamente la MARCA `data-etq-settled`
 * que la impresión espera; NUNCA el techo del crecimiento.
 *
 * Antes acá vivía `FUENTES_OK = true`, un booleano de una sola vez que sí gobernaba el techo, y
 * se ponía en `true` también cuando ganaba el tope de 3 s: en una caja con internet lento el
 * número crecía contra la fuente de respaldo, Anton llegaba a los 4 s y nadie volvía a medir.
 * El techo ahora lee `familiasFaltantes()` en cada pase (`this.fuentesOk`), y `loadingdone`
 * vuelve a pedir el pase cuando una familia llega tarde.
 */
let ESPERA_FUENTES_TERMINADA = false;
FUENTES_USABLES.then(() => { ESPERA_FUENTES_TERMINADA = true; });

/** Un pase de medición por cuadro de animación; sin `requestAnimationFrame` (SSR/tests), un tick. */
const agendar = (cb: () => void): number =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : (setTimeout(cb, 0) as unknown as number);
const cancelar = (id: number): void => {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id); else clearTimeout(id);
};

/**
 * Compensación del `transform:scaleX(1.1)` del número: `offsetWidth` es pre-transform, así que
 * el ancho que de verdad ocupa es ×1.1 (y un pelo de aire). Lo usan el ajuste y el veredicto:
 * si midieran con factores distintos, uno diría "cabe" y el otro "desborda" sobre lo mismo.
 */
const PRECIO_ANCHO_K = 1.12;

/** Píxeles CSS por milímetro. Es una constante de CSS (96 dpi), no del equipo ni del monitor. */
const PX_POR_MM = 96 / 25.4;
/** Paso del ajuste del precio, y su piso. Están en mm, como todo lo que se imprime. */
const PRECIO_PASO_MM = 0.25;
const PRECIO_PISO_MM = 4.5;
/**
 * `[ETQ-PROMO.5]` Techo del texto de apoyo CUANDO HAY OFERTA, como fracción del precio medido.
 *
 * El criterio de anaquel (comprador a 50-100 cm) pide que el precio sea **~2x el texto de
 * apoyo**. El techo general de la etiqueta es `MONTO_MAX_MM <= PRECIO_MM * 0.7`, o sea que un
 * monto de renglón puede llegar al 70% del precio — un 40% más de lo que el estándar tolera, y
 * es exactamente por qué la barra de beneficio EMPATABA con el precio en la primera versión.
 * Bajo oferta el precio tiene que ganar sin discusión, así que acá el techo baja a la mitad.
 */
const MONTO_MAX_PROMO_K = 0.5;

/**
 * `[ETQ-PROMO.5]` Techo del código de barras CUANDO HAY OFERTA.
 *
 * `fitBarcode` le da al símbolo el aire que los renglones no usan. Al ocultar mayoreo y caja
 * bajo promo ese aire se disparó y el código se fue a sus 12 mm: **el espacio que se le quitó a
 * la información comercial se lo quedó la operativa**, que es al revés de lo que una etiqueta de
 * promoción quiere. Nadie decidió que el barcode fuera el segundo elemento más pesado; pasó solo.
 */
const BARCODE_MAX_PROMO_MM = 8;
/**
 * Los tres números del CSS de `.etq-price` que necesita el CÁLCULO del tamaño: el alto de línea y
 * los cuerpos relativos del signo y del punto. Están duplicados con el CSS a propósito (el CSS lo
 * necesita para pintar, el TS para calcular) y el spec exige que coincidan — si se mueve uno solo,
 * el cálculo decide un tamaño contra una geometría que no es la que se dibuja.
 */
const PRECIO_LINE_H = 0.82;
const PRECIO_CUR_EM = 0.5;
const PRECIO_DOT_EM = 0.78;
/** El aire entre el signo y la primera cifra. Es FIJO en mm: no escala con el cuerpo, así que
 *  entra en la cuenta como término independiente y no dentro del ancho por milímetro. */
const PRECIO_CUR_MARGIN_MM = 0.3;

/**
 * ⭐⭐ EL MEDIDOR: el ancho de un texto según las MÉTRICAS DE LA TIPOGRAFÍA, no según el elemento.
 *
 * Es la pieza que cierra el defecto de raíz. Cuatro entregas seguidas (ET.5, ET.6, ET.6b, ET.6c)
 * fueron la misma forma de arreglo —"medir el DOM en el momento correcto"— y las cuatro fallaron,
 * porque lo frágil no es el momento: es **medir el DOM**. Mientras el tamaño dependa de leer
 * `offsetWidth` de un elemento vivo hay un estado del navegador (tipografía a medio aplicar,
 * maquetación diferida) en el que ese número miente. Medido en Yurécuaro: el estilo decía 15 mm y
 * `offsetWidth` devolvía 91 px, que es lo que ese `$86.00` mide a **10.75 mm**.
 *
 * `measureText` lee las tablas de la fuente. No hay elemento, no hay reflow, no hay maquetación y
 * por lo tanto no hay momento: el mismo texto con la misma fuente da siempre el mismo ancho. Y si
 * la fuente todavía no está usable, el canvas resuelve la cadena de respaldo igual que el DOM, o
 * sea mide **la que va a pintar** — que es exactamente lo correcto en ese instante.
 *
 * Vive en un objeto exportado para que las pruebas puedan sustituirlo: jsdom no trae canvas, así
 * que sin esto el camino determinista no se podría ejercer en ninguna prueba.
 */
export const MEDIDOR_DE_TEXTO = {
  ctx: undefined as CanvasRenderingContext2D | null | undefined,
  /**
   * Ancho en px de `txt` con `fuente` (la abreviada de CSS completa: `400 50px Anton, sans-serif`).
   * `null` = este navegador no da canvas, y ahí se cae al camino de medir el DOM.
   */
  ancho(txt: string, fuente: string): number | null {
    if (this.ctx === undefined) {
      try { this.ctx = (globalThis as any).document?.createElement('canvas')?.getContext('2d') ?? null; }
      catch { this.ctx = null; }
    }
    if (!this.ctx) return null;
    if (!txt) return 0;
    try { this.ctx.font = fuente; return this.ctx.measureText(txt).width; }
    catch { return null; }
  },
};

export interface LabelModel {
  code?: string;
  product_id: string;
  sku: string | null;
  name: string;
  content: string | null;
  barcode: string | null;
  barcode_format: string | null;
  piece_price: number | null;
  /**
   * [ET.3] De donde salio el precio de arriba. 'erp_vivo' = de kepler_ods.kdii en el momento ·
   * 'erp_sin_precio' = el ERP no lo cotiza en esa tienda (por eso llega null y la etiqueta lo
   * DICE en vez de imprimir un cero) · 'copia' = no se pidio plaza, se conservo la consolidada.
   */
  piece_price_origen?: 'erp_vivo' | 'erp_sin_precio' | 'copia';
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
  /**
   * [ETQ-PROMO.1] Descuento por Cantidad vigente de Kepler (kdpv_descuxq). `promo_pct` es un
   * PORCENTAJE. `promo_aplica` dice a cuál de los tres precios le toca: la promo apunta a una
   * sola presentacion y en el 43% de los casos no es la base. Sin plaza no hay promo (es por
   * tienda), y ahi llega null — que no es lo mismo que "no hay descuento".
   */
  promo_pct?: number | null;
  promo_min_qty?: number | null;
  promo_hasta?: string | null;
  promo_aplica?: 'pieza' | 'paquete' | 'caja' | null;
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
    /* ⛔ ACÁ NO VA NINGÚN @font-face NI @import DE TIPOGRAFÍA. Las tres familias de la etiqueta se
       declaran en el CSS GLOBAL (apps/view/src/styles.css) y los archivos viven en assets/fonts.
       Los estilos de un componente Angular se inyectan al PRIMER render de ese componente: con la
       declaración acá, mientras no hubiera una etiqueta en pantalla no existía ninguna cara y las
       fuentes NO empezaban a bajar — la primera etiqueta siempre se medía con la de respaldo, y
       el chip de la pantalla decía "falta Anton, Bebas Neue y Baloo 2" antes de agregar nada.
       El porqué completo está en el comentario de styles.css; el candado, en etiqueta-hoja.spec. */
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
    /* ⭐ ALTO FIJO, y es la corrección de la que colgaba el tamaño del precio.
       Este renglón no tenía alto ni line-height: lo decidía el texto. Al envolver a dos
       líneas se quedaba con 3.4 mm que salen DIRECTO de la caja del precio, que topa por
       alto. Medido en Chrome con la geometría real: 1 línea → precio 14.75 mm · 2 líneas →
       11.00 mm (−25%) · 2 líneas anchas → 8.50 mm (−42%). Y como el renglón no fijaba
       nowrap, envolvía según los DÍGITOS del SKU: "500 ml" con el 59108 daba 14.75 y con el
       44604 daba 8.50 — misma forma, 42% de diferencia, sin nada que lo explicara en el
       anaquel. 51 de los 8,760 pares (contenido, SKU) de prod caían ahí; con la tipografía
       del texto en respaldo, TODAS.
       ⚠️ El 5.1mm está duplicado en META_ALTO_MM (el TS arranca de ahí su ajuste) y el
       candado exige que coincidan. Es el alto que el renglón ya tenía con Baloo 2 cargada,
       elegido así a propósito: las 8,709 etiquetas que hoy salen bien no cambian de tamaño. */
    .etq-meta{ display:flex; align-items:center; gap:1.2mm; font-weight:800; font-size:3.2mm;
      height:5.1mm; min-height:5.1mm; line-height:1; margin-bottom:.8mm;
      white-space:nowrap; overflow:hidden; font-variant-numeric:tabular-nums; }
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
    /* SIN min-height:0 a proposito. El renglon es flex item de .etq-tiers; con min-height:0 se
       APLASTA por debajo de su contenido en vez de desbordar, y entonces la suma de los rects de
       los renglones nunca puede superar la caja: noCabe() queda estructuralmente en falso, la rama
       de encogido de fitTiers es codigo muerto y el texto se sale por el overflow:hidden. Asi se
       imprimio el SKU 70500 con la fila de CAJA cortada por la mitad y veredicto ok. Era
       vestigial: nacio en c54dbb2d acompanando un flex:1 que ya no esta. El min-height:0 de
       .etq-tiers (arriba) SI se queda: es el que deja que la caja ceda alto al codigo de barras. */
    .etq-tier{ position:relative; display:grid; grid-template-columns:1fr auto; align-items:center;
      column-gap:1.2mm; padding:.2mm 0; }
    .etq-tier::before{ content:""; position:absolute; top:0; left:0; right:0; height:.28mm;
      background:repeating-linear-gradient(90deg, var(--green) 0 .32mm, transparent .32mm .6mm); }
    .etq-tier:first-child::before{ display:none; }
    .etq-tier .txt{ font-family:var(--font-cond); font-size:2.6mm; font-weight:400; line-height:1; letter-spacing:.3px; }
    /* ── [ETQ-PROMO.2] Estado OFERTA ──────────────────────────────────────────────────────
       El precio de promocion tiene que ganar la mirada a un metro, no empatar con el normal.
       Que el numero CAMBIE DE COLOR es la senal: verde = precio de siempre, rojo = oferta. El
       rojo ya es color de marca y aca va sobre el amarillo, que es fondo de titular — con un
       numero de 10 mm o mas el contraste alcanza de sobra.
       El precio NORMAL sube de jerarquia respecto de un renglon comun (negrita, sin apagar) pero
       queda MUY por debajo del grande: su monto entra al ajuste uniforme con los demas (#amtEl),
       asi que no puede crecer por encima del 70% del precio grande. */
    .etq-label.is-promo .etq-price{ color:var(--red); }
    /* [ETQ-PROMO.5] La franja de unidad se queda VERDE a proposito. Estuvo roja una version y fue
       un error: dice QUE unidad te llevas -- es informacion, no argumento comercial -- y en rojo
       peleaba con la barra de beneficio justo encima. Bajo oferta hay UN solo rojo ademas del
       precio, o el rojo deja de ser acento y pasa a ser fondo. */
    .etq-antes .txt{ font-weight:700; letter-spacing:.4px; }
    /* El AHORRO es el unico renglon que se pinta en rojo: es el argumento de compra, no un
       precio mas. Sin separador punteado arriba para que se lea pegado al precio normal --
       los dos juntos son una sola frase: "antes tanto, te ahorras tanto". */
    .etq-oferta-tag{ flex:0 0 auto; margin-right:1.4mm; background:var(--yellow); color:var(--green);
      font-family:var(--font-cond); font-size:3.6mm; line-height:1; letter-spacing:.6px;
      padding:.7mm 1.2mm; border-radius:.6mm; white-space:nowrap; text-transform:uppercase; }
    /* El AHORRO es una BARRA SOLIDA, no un renglon mas: es el argumento de compra y tiene que
       leerse como un sello, no como otra linea de precios. Sin separador punteado arriba, para
       que se lea pegado al precio normal -- los dos juntos son una sola frase. */
    /* [ETQ-PROMO.3] La barra de AHORRO vive DENTRO del panel amarillo, apilada sobre la franja
       de unidad. Las dos juntas reservan 11.4 mm abajo (5.2 + 6.2), y esa reserva tiene que
       viajar en lockstep con el inset del punteado del ::before o el borde le pasa por encima.
       Con el Codigo mudado a la columna derecha el panel gana los 5.9 mm de la meta, asi que el
       hueco del numero queda en 13.8 mm: MAS que los 12.5 de la etiqueta sin oferta.
       La reserva cuelga de .con-ahorro y NO de .is-promo: sin barra (el 57.7% de las promos, que
       ahorran menos de $5) el panel no reserva nada y el precio se queda con los 18.4 mm enteros
       -- ahi los precios de 2 digitos, que son el 66.5%, llegan al techo de 15 mm. */
    .etq-label.con-ahorro .etq-pricebox{ padding-bottom:11.4mm; }
    .etq-label.con-ahorro .etq-pricebox::before{ inset:.8mm .8mm 11.4mm .8mm; }
    .etq-ahorro-bar{ position:absolute; left:0; right:0; bottom:6.2mm; height:5.2mm;
      display:flex; align-items:center; justify-content:center; gap:.8mm;
      background:var(--red); color:#fff; font-size:3.4mm; font-weight:700; line-height:1;
      letter-spacing:.3px; text-transform:uppercase; white-space:nowrap; }
    .etq-ahorro-bar b{ font-weight:800; font-size:4.3mm; font-variant-numeric:tabular-nums; }
    /* La meta, cuando baja a la columna derecha, se pega al codigo de barras (misma familia). */
    .etq-label.is-promo .etq-right .etq-meta{ margin-bottom:.4mm; }
    .etq-tachado{ text-decoration:line-through; text-decoration-color:var(--red);
      text-decoration-thickness:.35mm; }
    /* Insignia de oferta. Absoluta arriba a la derecha de la caja del precio: fitPrice la mide
       como OBSTACULO igual que al brote, asi que si estorba el numero se achica solo. */
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
    /* [ET.3] Se lee como un estado, no como una oferta: sin realce y en el tono apagado. */
    .etq-sinprecio{ font-size:9mm; letter-spacing:.5px; color:#6b6b6b; }
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
    <div class="etq-label" [class.is-promo]="enPromo" [class.con-ahorro]="beneficio !== null" #root>
      <!-- El brote vive ACÁ y no en la caja del precio: era el techo del número. Medido, con la
           franja de la unidad más alta, dejarlo adentro anulaba el crecimiento (−0.1%); afuera
           el precio gana +17.4%. Va en amarillo porque el verde medio desaparece sobre esta
           banda. fitPrice no lo tiene cableado: busca un obstáculo DENTRO de la caja y, si no
           lo encuentra, la guarda es 0 sola. -->
      <div class="etq-head" #head>
        <!-- [ETQ-PROMO.2] La palabra OFERTA va ANTES del nombre, no en su lugar: el nombre del
             producto es la primera razon de existir de la etiqueta de anaquel. -->
        @if (enPromo) { <span class="etq-oferta-tag">Oferta</span> }
        <span class="etq-head-txt" #headtxt>{{ headName }}</span>
        <svg class="etq-sprout" viewBox="0 0 40 40" fill="#f6c400" aria-hidden="true"><path transform="translate(12,15) rotate(120)" d="M0 -11 C4.5 -5 5.5 0 4 4.5 C2.8 7.5 -2.8 7.5 -4 4.5 C-5.5 0 -4.5 -5 0 -11 Z"/><path transform="translate(22,10) rotate(150) scale(0.7)" d="M0 -11 C4.5 -5 5.5 0 4 4.5 C2.8 7.5 -2.8 7.5 -4 4.5 C-5.5 0 -4.5 -5 0 -11 Z"/></svg>
      </div>
      <div class="etq-body">
        <div class="etq-left">
          @if (!enPromo) {
            <div class="etq-meta" #meta>
              @if (model.content) { <span>{{ model.content }}</span><span class="sep">|</span> }
              <span>Código: <span class="etq-red">{{ model.sku }}</span></span>
            </div>
          }
          <div class="etq-pricebox">
            <!-- [ET.3] Sin precio NO se imprime $0.00. Antes este caso ni existia porque la
                 etiqueta tomaba el precio de la COPIA, que conservaba el ultimo valor conocido
                 aunque el ERP ya lo hubiera retirado (medido: 71077 en la plaza 07 imprimia
                 $55.55 con el ERP en cero). Ahora el precio sale del ERP en vivo, y cuando el ERP
                 no lo cotiza la etiqueta lo DICE. Un cero es una afirmacion de precio; "sin
                 precio" es la verdad. Medido en la plaza 07: 9 de 8,693 etiquetas. -->
            @if (sinPrecio) {
              <div class="etq-price etq-sinprecio" #priceEl>SIN PRECIO</div>
            } @else {
              <div class="etq-price" #priceEl><span class="cur">$</span>{{ bigInt }}<span class="dot">.</span>{{ bigDec }}</div>
            }
            <!-- [ETQ-PROMO.3] El ahorro EN PESOS, barra solida DENTRO del panel amarillo: es el
                 argumento de compra y va pegado al numero, no como un renglon mas en la otra
                 columna. Se apila sobre la franja de unidad (5.2 + 6.2 = 11.4 mm reservados
                 abajo) y esa reserva viaja en lockstep con el punteado del ::before. -->
            @if (beneficio; as b) {
              <div class="etq-ahorro-bar">
                @if (b.pesos) { Ahorra <b>\${{ b.valor | number:'1.2-2' }}</b> }
                @else { <b>-{{ b.valor }}%</b> de descuento }
              </div>
            }
            <!-- La UNIDAD del precio grande. El 73.5% de las etiquetas muestran un precio de
                 PAQUETE y el cliente compra esa unidad en el 92.8% de los renglones: leer el
                 número sin su unidad es el error más caro del proyecto (ADR-055). Por eso la
                 palabra va en su propio nivel de jerarquía, no como pie de foto. -->
            <div class="etq-pieza" #pieza>
              <span class="etq-pieza-txt" #piezaTxt>@if (sinPrecio) {<span class="pre">el ERP no lo cotiza en esta tienda</span>} @else {<span class="pre">Precio por</span><span class="u">{{ bigUnit.word }}</span>}</span>
            </div>
          </div>
        </div>
        <div class="etq-right" [class.is-solo]="tierCount === 0">
          <!-- Rótulos CORTOS ("Mayoreo 3+ cajas" en vez de "Mayoreo desde 3 cajas:"): el
               rótulo era lo que se comía el ancho de la columna y obligaba a encoger el monto
               hasta dejarlo ilegible. Acortarlo es lo que permite el monto grande. -->
          <div class="etq-tiers" #tiers>
            <!-- [ETQ-PROMO.1] El precio de LISTA, tachado, cuando el grande ya lleva el descuento
                 por cantidad de Kepler. Va primero para que se lea junto al numero grande.
                 "desde N" solo si el umbral es real (medido: 496 de 498 promos arrancan en 1). -->
            @if (precioNormal; as pn) {
              <div class="etq-tier etq-antes">
                <div class="txt">Precio normal@if (promoDesde; as q) { · desde <span class="etq-red">{{ q }}</span> }</div>
                <div class="pricecell"><span class="amt etq-tachado" #amtEl>\${{ pn | number:'1.2-2' }}</span></div>
              </div>
            }
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
          <!-- [ETQ-PROMO.3] Con oferta el Codigo baja aca, junto al barcode: son la misma
               familia (dato operativo). Eso libera 5.9 mm arriba a la izquierda, que es justo
               lo que la barra de ahorro necesita para no achicar el precio. -->
          @if (enPromo) {
            <div class="etq-meta" #meta>
              @if (model.content) { <span>{{ model.content }}</span><span class="sep">|</span> }
              <span>Código: <span class="etq-red">{{ model.sku }}</span></span>
            </div>
          }
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
export class LabelComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input({ required: true }) model!: LabelModel;
  @Input() show: LabelSections = ALL_SECTIONS;
  /** Precio que va en grande. Null = default (pieza con fallback). Intercambiable por ticket. */
  @Input() hero: HeroKey | null = null;
  @ViewChild('root') root?: ElementRef<HTMLElement>;
  @ViewChild('bc') bc?: ElementRef<SVGElement>;
  @ViewChild('head') head?: ElementRef<HTMLElement>;
  @ViewChild('headtxt') headtxt?: ElementRef<HTMLElement>;
  @ViewChild('meta') meta?: ElementRef<HTMLElement>;
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
    // [ETQ-PROMO.2] Bajo oferta sólo sobrevive si su precio por unidad le gana al promocional.
    if (!this.ganaALaOferta(w, 1)) return false;
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
    return (this.precioNormal !== null ? 1 : 0) + (this.ahorro !== null ? 1 : 0)
      + (this.granelAltTier ? 1 : 0) + (this.hasMayoreoPza ? 1 : 0) + (this.hasPaquete ? 1 : 0)
      + (this.hasMayoreoPaq ? 1 : 0) + (this.hasCaja ? 1 : 0);
  }
  get hasPaquete(): boolean { return !!this.show.paquete && this.num(this.model?.pack_price) > 0 && this.num(this.model?.pack_size) > 0; }
  get hasMayoreoPaq(): boolean {
    // [ETQ-PROMO.2] Mismo criterio que el mayoreo por pieza.
    if (!this.ganaALaOferta(this.num(this.model?.wholesale_pack_price), 1)) return false;
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
  get hasCaja(): boolean {
    if (!this.show.caja) return false;
    const total = this.num(this.model?.box_price);
    const size = this.num(this.model?.box_size);
    // [ETQ-PROMO.2] La caja tiene su PROPIA escalera (va a precio de mayoreo), asi que bajo
    // oferta puede quedar mas cara por unidad que el promocional. Ahi no se imprime.
    return total > 0 && size > 0 && this.ganaALaOferta(total, size);
  }
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
  get bigUnit(): { word: string; value: number; slot: 'pieza' | 'paquete' | 'caja' } {
    const m = this.model;
    const grams = this.granelGrams;
    const granel = grams > 0;
    const piece = this.num(m?.piece_price);
    const portionWord = grams >= 1000 ? 'kg' : `${grams} g`; // "500 g" / "kg"

    // Overrides explícitos por ticket.
    // `slot` = de qué precio del modelo salió este número. Lo devuelve ACÁ y no lo re-deriva
    // nadie: el descuento de Kepler apunta a UNA presentación, y para saber si le toca al precio
    // grande hay que saber cuál es. Re-implementar esta cascada en otro getter sería dos verdades.
    // El granel sale de `piece_price`, así que su ranura es `pieza` aunque la palabra sea "kg".
    if (this.hero === 'kg' && granel) return { word: 'kg', value: this.perKgPrice, slot: 'pieza' };
    if (this.hero === 'paquete' && this.num(m?.pack_price) > 0) return { word: 'paquete', value: this.num(m?.pack_price), slot: 'paquete' };
    if (this.hero === 'caja' && this.num(m?.box_price) > 0) return { word: 'caja', value: this.num(m?.box_price), slot: 'caja' };
    if (this.hero === 'pieza' && piece > 0) return granel ? { word: portionWord, value: piece, slot: 'pieza' } : { word: this.baseUnit, value: piece, slot: 'pieza' };

    // Default: granel = por kg (se vende por kilo); normal = unidad base (pieza/paquete/caja
    // según Kepler unit_base); con fallback. c90 es el precio de ESA unidad base.
    if (granel && (piece > 0 || this.perKgPrice > 0)) return { word: 'kg', value: this.perKgPrice, slot: 'pieza' };
    if (piece > 0) return { word: this.baseUnit, value: piece, slot: 'pieza' };
    if (this.num(m?.pack_price) > 0) return { word: 'paquete', value: this.num(m?.pack_price), slot: 'paquete' };
    if (this.num(m?.box_price) > 0) return { word: 'caja', value: this.num(m?.box_price), slot: 'caja' };
    return granel ? { word: 'kg', value: 0, slot: 'pieza' } : { word: this.baseUnit, value: 0, slot: 'pieza' };
  }

  /**
   * `[ETQ-PROMO.1]` El "Descuento por Cantidad" de Kepler, SÓLO si le toca al precio grande.
   *
   * La promo apunta a una presentación (`promo_aplica`); si el precio grande es otro —el
   * operador puso caja y la promo es de paquete— no se aplica y la etiqueta no lo menciona.
   * Medido: 43% de las promos vigentes NO son de la unidad base, así que esto no es un caso raro.
   *
   * `null` cuando no hay promo, cuando no aplica a esta ranura, o cuando no vino plaza (el
   * descuento es POR TIENDA: sin saber cuál, no se puede afirmar ninguno).
   */
  get promoPct(): number | null {
    const pct = this.num(this.model?.promo_pct);
    if (!(pct > 0) || pct >= 100) return null;
    return this.model?.promo_aplica === this.bigUnit.slot ? pct : null;
  }

  /** ¿Esta etiqueta va en OFERTA? Es el interruptor de todo el estado visual de promo. */
  get enPromo(): boolean { return this.promoPct !== null; }

  /**
   * `[ETQ-PROMO.2]` Bajo oferta, un renglón sólo se imprime si su precio POR UNIDAD le GANA a la
   * oferta. No es una regla estética, es aritmética de anaquel.
   *
   * Medido con el FERRERO 24P en la plaza 05: paquete normal $236.51, oferta $212.86, y la caja
   * de 6 a $1,331.14 — que son **$221.86 por paquete**, el precio de mayoreo. O sea que con la
   * promo puesta la caja quedó MÁS CARA por unidad que comprar suelto. Imprimir los dos números
   * juntos le pide al cliente que haga la división para descubrir que el "volumen" le conviene
   * menos; el que la haga pierde la confianza en la etiqueta, y el que no, paga de más.
   *
   * `ahorro` = la resta, en pesos. "10%" es abstracto; "AHORRA $23.65" es lo que el cliente
   * compara contra lo que trae en la mano.
   */
  private ganaALaOferta(total: number, unidades: number): boolean {
    if (!this.enPromo) return true;
    const porUnidad = unidades > 0 ? total / unidades : total;
    return porUnidad > 0 && porUnidad < this.precioGrande;
  }

  /** Lo que el cliente se ahorra, en pesos. `null` sin oferta. */
  get ahorro(): number | null {
    const normal = this.precioNormal;
    return normal === null ? null : normal - this.precioGrande;
  }

  /**
   * ⭐ `[ETQ-PROMO.5]` El beneficio, con el número que se ve MÁS GRANDE — la "Regla de 100".
   *
   * El comprador no hace la resta: **compara números y gana el que se ve más grande** (Berger,
   * *Contagious*). Bajo $100 el porcentaje es el número mayor; por encima lo es el ahorro en
   * pesos, y hay tres estudios que miden más percepción de valor con el monto en los caros.
   *
   * ⛔ Acá había un `AHORRO_MIN_MXN = 5` que yo inventé ("mostrar pesos si el ahorro llega a
   * $5"). El criterio real es **el precio**, no el ahorro: medido sobre las 388 etiquetas en
   * promo de prod, las dos reglas discrepan en 44 — 42 donde el umbral ponía pesos y corresponde
   * porcentaje.
   *
   * Y no hace falta la constante 100: como `ahorro = precio * pct/100`, entonces
   * **`ahorro > pct` si y sólo si `precio > 100`**. La regla es, literal, "mostrá el número más
   * grande", y así se lee en el código sin ningún número mágico que explicar.
   */
  get beneficio(): { pesos: boolean; valor: number } | null {
    const pct = this.promoPct;
    const ah = this.ahorro;
    if (pct === null || ah === null || !(ah > 0)) return null;
    return ah > pct ? { pesos: true, valor: ah } : { pesos: false, valor: pct };
  }

  /** El precio que se imprime GRANDE: con el descuento ya aplicado si le toca. */
  get precioGrande(): number {
    const pct = this.promoPct;
    const base = this.bigUnit.value;
    return pct === null ? base : base * (1 - pct / 100);
  }

  /** El precio de lista, para el renglón chico tachado. `null` = no hay descuento que contrastar. */
  get precioNormal(): number | null {
    return this.promoPct === null ? null : this.bigUnit.value;
  }

  /**
   * "desde N" — sólo cuando el umbral es real. Medido en prod: `Cant a Partir` = 1 en 496 de las
   * 498 promos vigentes, o sea que casi siempre es una rebaja directa y decir "desde 1" sería
   * ruido. Si alguna vez llega un umbral de verdad, la etiqueta LO TIENE QUE DECIR: un precio
   * grande que el cliente sólo obtiene llevando N piezas, sin el N, es publicidad engañosa.
   */
  get promoDesde(): number | null {
    const q = this.num(this.model?.promo_min_qty);
    return this.promoPct !== null && q > 1 ? q : null;
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
  private get bigStr(): string { return this.precioGrande.toFixed(2); }

  /**
   * `[ET.3]` No hay precio que imprimir.
   *
   * Pasa cuando el ERP dejo de cotizar el producto en ESA tienda (`piece_price_origen =
   * 'erp_sin_precio'`) y tampoco hay paquete ni caja con precio. Antes era invisible: la etiqueta
   * tomaba el precio de la copia, que conserva el ultimo valor conocido porque el computo filtra
   * `c90 > 0.05` y el merge no borra. Imprimir $0.00 seria cambiar un precio falso por otro.
   */
  get sinPrecio(): boolean { return this.precioGrande <= 0; }
  // F4: separador de miles (igual que los tiers con number:'1.2-2') → "1,044".
  get bigInt(): string { return this.bigStr.split('.')[0].replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  get bigDec(): string { return this.bigStr.split('.')[1] ?? '00'; }

  ngAfterViewInit(): void { this.render(); this.observar(); FUENTES_USABLES.then(() => this.programar()); }
  ngOnChanges(): void { queueMicrotask(() => this.render()); }
  ngOnDestroy(): void {
    this.ro?.disconnect();
    this.mo?.disconnect();
    (globalThis as any).document?.fonts?.removeEventListener?.('loadingdone', this.alCambiarFuentes);
    if (this.pendiente) { cancelar(this.pendiente); this.pendiente = 0; }
  }

  /** Dibuja el código de barras y PIDE una medición. No mide él: cuándo medir lo decide `ajustar()`. */
  private render(): void { this.renderBarcode(); this.programar(); }

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // ⭐ EL MECANISMO: se vuelve a medir cuando cambia LO QUE SE MIDE, no cuando un hook cree que
  // algo cambió. Los tres insumos de una medida de texto son la geometría de la caja, el texto y
  // la tipografía con que se pinta; cada uno tiene su observador, los tres desembocan en
  // `programar()`, y `ajustar()` sólo trabaja si la FIRMA de los tres cambió desde el último
  // pase. Eso lo hace idempotente (dos pedidos sin cambio = un pase) y sin lazo (lo que los
  // ajustes ESCRIBEN —`style.fontSize`— son atributos, y el observador de texto no los mira).
  // Ver el encabezado del archivo para el porqué: tres parches de "el momento que faltaba".
  // ───────────────────────────────────────────────────────────────────────────────────────────
  private ro?: ResizeObserver;
  private mo?: MutationObserver;
  private pendiente = 0;
  private ultimaFirma = '';
  /** Verdad de la tipografía EN ESTE pase; la leen los techos de `fitPrice`/`fitTiers`. */
  private fuentesOk = false;
  private readonly alCambiarFuentes = (): void => this.programar();
  private readonly zone = inject(NgZone);

  private observar(): void {
    const root = this.root?.nativeElement;
    if (!root) return;
    // Fuera de la zona de Angular: son medidas de DOM, no cambian estado de la vista.
    this.zone.runOutsideAngular(() => {
      if (typeof ResizeObserver !== 'undefined') {
        this.ro = new ResizeObserver(() => this.programar());
        this.ro.observe(root);
      }
      if (typeof MutationObserver !== 'undefined') {
        this.mo = new MutationObserver(() => this.programar());
        // ⛔ SIN `attributes`: los ajustes escriben `style.fontSize` y observarlo sería un lazo.
        this.mo.observe(root, { childList: true, characterData: true, subtree: true });
      }
      (globalThis as any).document?.fonts?.addEventListener?.('loadingdone', this.alCambiarFuentes);
    });
  }

  /**
   * Pide un pase de medición para el próximo cuadro (coalesce: N pedidos en un cuadro = 1 pase).
   * Quita la marca `data-etq-settled` de inmediato: hasta que se vuelva a medir, esta etiqueta
   * NO está lista para clonarse a impresión.
   */
  /**
   * ⭐⭐ LA FIRMA: lo que hay que vigilar para saber si hace falta volver a medir. Y la pieza que
   * faltaba es que incluye **la medida misma** (`priceEl.offsetWidth`), no sólo sus causas.
   *
   * ── El defecto que esto cierra, medido en Yurécuaro el 2026-09-15 ─────────────────────────
   * El rastro decía `15mm | 91 | 120 | fuentes`: estilo de 15 mm, pero 91 px de ancho — y 91 px
   * es el ancho que ese mismo `$86.00` tiene a **10.75 mm**. O sea el elemento estaba MEDIDO con
   * la maquetación de la tipografía anterior mientras el estilo ya decía 15 mm.
   *
   * `document.fonts` dice "cargada" ANTES de que el navegador vuelva a maquetar el texto que la
   * usa. El bucle crece contra el ancho viejo (más chico) hasta el techo, y cuando entra Anton el
   * número se ensancha y desborda. Por eso **cambiar el tamaño de la ventana lo arreglaba** (fuerza
   * un re-layout) y por eso **en otra computadora salía bien** (ahí el swap ocurre antes de medir).
   *
   * ── Por qué la firma anterior no lo veía ──────────────────────────────────────────────────
   * Miraba `root.offsetWidth/offsetHeight`, y la etiqueta es de tamaño FIJO (82×35 mm): esos dos
   * números no cambian NUNCA. El `ResizeObserver` sobre la raíz, por lo mismo, no dispara jamás.
   * La firma vigilaba las causas que se me ocurrieron (geometría, texto, tipografía) y no el
   * EFECTO — así que un re-maquetado que no venía de ninguna de las tres era invisible.
   *
   * Con el ancho del número adentro, un re-layout tardío cambia la firma solo. Y como cada pase
   * que maqueta pide otro pase, la corrección llega al cuadro siguiente sin que nadie la dispare.
   * Converge: si nada se movió, la firma repite y el pase siguiente no hace nada.
   */
  private firma(): string {
    const root = this.root?.nativeElement;
    const price = this.priceEl?.nativeElement;
    return `${root?.offsetWidth}x${root?.offsetHeight}|${this.fuentesOk}|${price?.offsetWidth}x${price?.offsetHeight}|${root?.textContent}`;
  }

  private programar(): void {
    this.root?.nativeElement.removeAttribute('data-etq-settled');
    if (this.pendiente) return;
    this.zone.runOutsideAngular(() => { this.pendiente = agendar(() => { this.pendiente = 0; this.ajustar(); }); });
  }

  /**
   * El pase. Lee la verdad de la tipografía AHORA, arma la firma de los tres insumos y sólo corre
   * los ajustes si cambió. Después declara: el veredicto (`data-etq-fit`) y la marca que espera
   * la impresión (`data-etq-settled`: 'fonts' si midió con la tipografía definitiva; 'fallback'
   * si la espera venció y midió con la de respaldo, que ahí es la que va a imprimir; ninguna
   * mientras la espera siga abierta).
   */
  private ajustar(): void {
    const root = this.root?.nativeElement;
    if (!root) return;
    this.fuentesOk = familiasFaltantes()?.length === 0;
    if (this.firma() !== this.ultimaFirma) {
      this.layout();
      // La firma se recalcula DESPUÉS de maquetar, y se pide otro pase. Ver `firma()`.
      this.ultimaFirma = this.firma();
      this.programar();
    }
    // ⭐ EL INVARIANTE, y es lo único acá que no depende de entender la causa: un pase NO puede
    // TERMINAR en desborde si un tamaño menor cabe. Si el veredicto sale `overflow`, se vuelve a
    // ajustar el número —`fitPrice` arranca de PRECIO_MM y re-deriva, así que converge— y se
    // vuelve a juzgar. Un solo reintento: si sigue desbordado es porque no cabe ni en el piso, y
    // eso se DECLARA (ADR-056), no se esconde.
    //
    // Medido: en Yurécuaro el número quedaba en 15 mm (el techo) con 127 px en 120 disponibles,
    // mientras la misma etiqueta en otro equipo daba 11.75 mm y `ok`. Llegar al techo exige que
    // en ESE instante midiera ≤107 px, o sea que creció contra un ancho ~19% más chico que el que
    // después pintó. ⛔ Ojo: acá NO alcanza con que el veredicto sea `ok` — si la medida que lee
    // el veredicto es la misma medida vieja, dice `ok` sobre un número que desborda. Por eso el
    // arreglo de fondo es `firma()` (que vigila la medida), y esto es sólo el cinturón.
    let v = this.veredicto();
    if (v === 'overflow') { this.fitPrice(); v = this.veredicto(); }
    root.setAttribute('data-etq-fit', v);
    // ⭐ El RASTRO de la medición, en el DOM. Un "salió de otro tamaño" se contesta leyendo esto
    // en la caja que falla, en vez de tres viajes de ida y vuelta con sondas a medida: qué tamaño
    // quedó, cuánto mide el número, cuánto había, y con qué tipografía se midió. Este defecto
    // costó cuatro hipótesis refutadas y un parche publicado que no arreglaba nada, porque el
    // único dato que importaba —el ancho EN EL INSTANTE de medir— no quedaba escrito en ningún lado.
    const el = this.priceEl?.nativeElement;
    const box = el?.parentElement;
    if (el && box) {
      const cs = getComputedStyle(box);
      const avail = Math.round(box.clientWidth - parseFloat(cs.paddingLeft || '0') - parseFloat(cs.paddingRight || '0'));
      const met = this.anchoPrecioPorMm(el);
      const mm = parseFloat(el.style.fontSize || '') || PRECIO_MM;
      // Los DOS anchos: el calculado con las métricas (el que manda) y el que dice el DOM. Que
      // discrepen es el síntoma del defecto de raíz, y así queda a la vista en una captura.
      const calc = met !== null ? Math.round(met.porMm * mm + met.fijoPx) : 'sin_canvas';
      root.setAttribute('data-etq-medida', `${el.style.fontSize || '?'}|calc:${calc}|dom:${el.offsetWidth}|${avail}|${this.fuentesOk ? 'fuentes' : 'respaldo'}`);
    }
    if (this.fuentesOk) root.setAttribute('data-etq-settled', 'fonts');
    else if (ESPERA_FUENTES_TERMINADA) root.setAttribute('data-etq-settled', 'fallback');
  }

  /**
   * Lo que la impresión y la pantalla pueden DECLARAR de esta etiqueta después de medir:
   *   'ok'          el número y los renglones caben con el criterio de sus propios ajustes;
   *   'overflow'    algo NO cabe aunque los ajustes ya corrieron — se dice, no se imprime callado;
   *   'sin_medida'  la caja no tiene ancho (oculta, sin estilos, jsdom): no se pudo comprobar.
   * Un 'sin_medida' NUNCA se pinta como 'ok' (ADR-056).
   */
  private veredicto(): 'ok' | 'overflow' | 'sin_medida' {
    const el = this.priceEl?.nativeElement;
    const box = el?.parentElement;
    if (!el || !box) return 'sin_medida';
    const cs = getComputedStyle(box);
    const avail = box.clientWidth - parseFloat(cs.paddingLeft || '0') - parseFloat(cs.paddingRight || '0');
    if (!(avail > 0)) return 'sin_medida';
    // ⛔ El veredicto juzga con LA MISMA regla con que se decidió el tamaño — las métricas de la
    // tipografía —, no con `offsetWidth`. Cuando juzgaba con el DOM decía `ok` sobre un número
    // desbordado, porque leía los mismos 91 px falsos que habían causado el desborde: una
    // compuerta que comparte el dato defectuoso con lo que vigila no vigila nada.
    const met = this.anchoPrecioPorMm(el);
    const mm = parseFloat(el.style.fontSize || '') || PRECIO_MM;
    const ancho = met !== null ? met.porMm * mm + met.fijoPx : el.offsetWidth;
    if (ancho * PRECIO_ANCHO_K > avail) return 'overflow';
    const desborda = (e?: HTMLElement): boolean => !!e && e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1;
    if (desborda(this.head?.nativeElement) || desborda(this.meta?.nativeElement)) return 'overflow';
    // ⭐ Los RENGLONES también entran al veredicto, con EL MISMO criterio con que `fitTiers` decide
    // si tiene que encoger (`noCabe`): `altoTiers` contra el alto de la caja. Que la compuerta y el
    // ajuste compartan la regla es justo lo que evita que discrepen.
    //
    // Antes quedaban fuera: `fitTiers` encoge hasta su piso de 2.6 mm y, si ahí sigue sin caber,
    // SALE — y el `overflow:hidden` de `.etq-label` se come el sobrante. El veredicto decía `ok`,
    // así que `print()` —que cuenta `[data-etq-fit="overflow"]` para avisar antes de gastar papel—
    // nunca se enteraba. Medido en vivo con el SKU 70500 en la sucursal 06 (3 renglones: mayoreo,
    // paquete y caja): la fila de CAJA salía cortada por la mitad en el papel, sin una sola señal.
    //
    // ⛔ No se usa `scrollHeight`: es un flex con contenido centrado y ahí nunca baja de
    // `clientHeight` (reporta 0 de aire donde hay 6 mm) ni ve el desborde por arriba. La razón
    // larga está en `altoTiers()`.
    const tiers = this.tiers?.nativeElement;
    if (tiers && tiers.clientHeight > 0 && this.altoTiers(tiers) > tiers.clientHeight + 1) return 'overflow';
    return 'ok';
  }

  /**
   * Corre todos los auto-ajustes. El ORDEN es obligatorio y está candado en el spec:
   *   · `fitMeta` antes de `fitPrice` — el renglón del código define cuánto alto le queda al número;
   *   · `fitUnit` antes de `fitPrice` — la franja de la unidad define lo mismo, por abajo;
   *   · `fitPrice` antes de `fitTiers` — el techo del monto se clampea contra el hero MEDIDO;
   *   · `fitBarcode` antes de `fitTiers` — ⭐ INVERTIDO. Corría al final con el argumento de que
   *     "el aire sólo se puede medir cuando los montos ya se asentaron", y por correr al final
   *     no encontraba aire NUNCA: `fitTiers` crecía los montos hasta llenar la columna. Medido:
   *     con 2, 3 o 4 renglones el símbolo quedaba en su mínimo de 5 mm — el 19% de la altura
   *     nominal de un EAN-13, que el propio decode llama la causa nº 1 de no-lectura en ángulo.
   *     Ahora el código reclama su altura con los montos en su ARRANQUE, y los montos crecen
   *     con lo que sobre. Un monto más chico se sigue leyendo; un código que no engancha obliga
   *     a teclear;
   *   · `fitTiers` antes de `fitAmts` — el primero iguala todos los montos a lo alto, el segundo
   *     encoge el que no quepa a lo ancho de su celda.
   */
  private layout(): void {
    this.fitHead(); this.fitMeta(); this.fitUnit(); this.fitPrice();
    this.fitBarcode(); this.fitTiers(); this.fitAmts();
    // El número se vuelve a medir al cierre del pase. Barato e idempotente (`fitPrice` arranca de
    // PRECIO_MM y re-deriva) y cubre que alguno de los cuatro ajustes de en medio mueva la caja
    // del precio dentro de UN pase.
    //
    // ⚠️ [ET.5] NO fue la causa del desborde del 2026-09-15, y hay que decirlo porque se publicó
    // como si lo fuera. En la caja de Yurécuaro se midió que devolver los montos a su arranque
    // movía la caja del precio **0 px**, y con este cierre ya en producción el número seguía a
    // 15 mm (el techo) con 127 px en 120 disponibles. Para llegar a 15 mm el bucle tuvo que
    // medir ≤107 px: el mismo número era 19% más ancho que cuando se midió. Cambió el INSUMO
    // (texto o tipografía) DESPUÉS del pase, y nada volvía a medir. Eso lo cierra `observar()`,
    // no esta línea. Se queda por lo que sí cubre, no por lo que se creyó que cubría.
    this.fitPrice();
  }

  /**
   * Alto que ocupan los renglones de tier, medido por EXTENSIÓN DE LOS HIJOS.
   *
   * ⛔ NO se puede usar `scrollHeight`: el bloque es flex con `justify-content:center`, y ahí
   * `scrollHeight` nunca baja de `clientHeight` (reporta 0 de aire donde hay 6 mm) ni ve el
   * desborde por el borde de arriba (con contenido centrado que se pasa, la mitad del exceso es
   * invisible). Para encoger eso era un defecto tolerado; para CRECER sería un recorte.
   */
  private altoTiers(box: HTMLElement): number {
    const filas = Array.from(box.children) as HTMLElement[];
    if (!filas.length) return 0;
    const k = this.escalaVisual(box);
    const gap = parseFloat(getComputedStyle(box).rowGap || '0') || 0;
    return filas.reduce((a, f) => a + this.altoFila(f, k), 0) + (filas.length - 1) * gap;
  }

  /**
   * ⭐ Alto que un renglón NECESITA — no el que el navegador le dejó.
   *
   * ⛔ Medir el rect del renglón no sirve, y es la razón por la que este defecto vivió tanto:
   * `.etq-tier` es flex item de `.etq-tiers` y llevaba `min-height:0`, así que se APLASTA por
   * debajo de su contenido en vez de desbordar. La suma de los rects de los renglones entonces
   * **no puede** superar `clientHeight`, `noCabe()` es estructuralmente falso, la rama de
   * encogido de `fitTiers` es código muerto y el texto se sale por el `overflow:hidden` de la
   * etiqueta. Se veía como un renglón cortado, y ninguna medida lo declaraba: el SKU 70500 en
   * la sucursal 06 imprimía la fila de CAJA partida por la mitad con veredicto `ok`.
   *
   * Se miden las CELDAS (`.txt` y `.pricecell`): son grid items con `align-items:center`, así
   * que no se estiran ni se aplastan — su rect ES el alto natural. Es el mismo principio de
   * "extensión de los hijos" de `altoTiers`, un nivel más abajo.
   *
   * ⚠️ El rect viene ESCALADO por el transform de la vista de hoja y el padding de
   * `getComputedStyle` viene en px de LAYOUT: se divide el rect y NUNCA el padding. Mezclarlos
   * es el mismo error que documenta `escalaVisual()`, un nivel más abajo.
   */
  private altoFila(fila: HTMLElement, k: number): number {
    const rect = fila.getBoundingClientRect().height / k;
    const celdas = Array.from(fila.children) as HTMLElement[];
    if (!celdas.length) return rect;
    const cs = getComputedStyle(fila);
    const pad = (parseFloat(cs.paddingTop || '0') || 0) + (parseFloat(cs.paddingBottom || '0') || 0);
    const contenido = Math.max(...celdas.map((c) => c.getBoundingClientRect().height / k)) + pad;
    // Con el renglón sano los dos coinciden; aplastado, el contenido es el que dice la verdad.
    return Math.max(rect, contenido);
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

  /**
   * Auto-ajuste del renglón "contenido | Código". Sólo encoge — calco de `fitHead`.
   *
   * Existe porque el renglón pasó a `nowrap` con alto fijo: sin esto, el texto que antes
   * envolvía ahora se RECORTARÍA (lo tapa el `overflow:hidden`), que es peor — el código del
   * producto es lo que la cajera teclea cuando el lector falla. Encoger es la salida honesta:
   * el renglón se lee más chico, pero se lee entero, y el precio conserva su altura.
   */
  private fitMeta(): void {
    const meta = this.meta?.nativeElement;
    if (!meta) return;
    let size = META_MM;
    meta.style.fontSize = size + 'mm'; // anti-trinquete: siempre desde la constante
    if (!(meta.clientWidth > 0)) return; // sin medida no se toca (ver fitPrice)
    let guard = 0;
    while (meta.scrollWidth > meta.clientWidth && size > 2.2 && guard++ < 40) {
      size -= 0.1;
      meta.style.fontSize = size + 'mm';
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
  /**
   * Los pedazos del precio con su cuerpo relativo: el número se dibuja con el signo y el punto más
   * chicos (`.cur` y `.dot` en el CSS), así que medirlo como una sola cadena al mismo cuerpo daría
   * de más. Cada pedazo se mide con el tamaño con el que se va a dibujar.
   */
  private segmentosPrecio(): { txt: string; em: number }[] {
    if (this.sinPrecio) return [{ txt: 'SIN PRECIO', em: 1 }];
    return [
      { txt: '$', em: PRECIO_CUR_EM },
      { txt: this.bigInt, em: 1 },
      { txt: '.', em: PRECIO_DOT_EM },
      { txt: this.bigDec, em: 1 },
    ];
  }

  /**
   * Ancho del precio en px por cada mm de cuerpo, con la tipografía que el elemento va a usar.
   * `null` = no hay canvas en este navegador (ver `MEDIDOR_DE_TEXTO`).
   *
   * Se mide a un tamaño de REFERENCIA grande y se divide: a cuerpos chicos el redondeo de
   * `measureText` pesa, y acá el error se multiplica por el tamaño final.
   */
  private anchoPrecioPorMm(el: HTMLElement): { porMm: number; fijoPx: number } | null {
    const REF_PX = 100;
    const cs = getComputedStyle(el);
    const peso = cs.fontWeight || '400';
    const familia = cs.fontFamily;
    if (!familia) return null;
    let total = 0;
    for (const s of this.segmentosPrecio()) {
      const px = REF_PX * s.em; // cada pedazo se mide con el cuerpo con el que se dibuja
      const w = MEDIDOR_DE_TEXTO.ancho(s.txt, `${peso} ${px}px ${familia}`);
      if (w === null) return null;
      total += w;
    }
    // El ancho es AFÍN, no lineal: `porMm` escala con el cuerpo y `fijoPx` no (el margen del
    // signo está en mm). Meter el margen dentro del ancho por milímetro lo haría crecer con el
    // número y el tamaño saldría chico de más.
    return {
      porMm: (total / REF_PX) * PX_POR_MM,
      fijoPx: this.sinPrecio ? 0 : PRECIO_CUR_MARGIN_MM * PX_POR_MM,
    };
  }

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

    // ⭐⭐ CAMINO DETERMINISTA: el tamaño se CALCULA con las métricas de la tipografía.
    //
    // El ancho del texto es LINEAL en el cuerpo, así que alcanza con medirlo una vez a un tamaño
    // de referencia y despejar. Sin bucle, sin leer el elemento, sin depender del instante:
    //
    //     tamaño_máx = disponible / (K · ancho_por_mm)      … y lo mismo por alto
    //
    // El camino de abajo (medir `offsetWidth` paso a paso) queda SÓLO para cuando no hay canvas
    // —jsdom, algún kiosco viejo—, y ahí vale lo de siempre: es lo que había.
    const met = this.anchoPrecioPorMm(el);
    if (met !== null && met.porMm > 0) {
      const techoFuentes = this.fuentesOk ? PRECIO_MAX_MM : PRECIO_MM;
      const porAncho = (avail / PRECIO_ANCHO_K - met.fijoPx) / met.porMm;
      const porAlto = availH / (PX_POR_MM * PRECIO_LINE_H);
      const max = Math.min(techoFuentes, porAncho, porAlto);
      // Al PASO de abajo, nunca hacia arriba: redondear hacia arriba es volver a desbordar.
      size = Math.max(PRECIO_PISO_MM, Math.floor(max / PRECIO_PASO_MM) * PRECIO_PASO_MM);
      el.style.fontSize = size + 'mm';
      return;
    }

    const cabe = () => el.offsetWidth * PRECIO_ANCHO_K <= avail && el.offsetHeight <= availH;
    let guard = 0;
    if (!cabe()) {
      while (!cabe() && size > 4.5 && guard++ < 120) {
        size -= 0.25;
        el.style.fontSize = size + 'mm';
      }
      return;
    }
    // ⭐ Crecer SÓLO con las fuentes usables EN ESTE PASE (`this.fuentesOk`, leída por `ajustar()`
    // al arrancar el pase — no una bandera de una vez). Medir con una fallback más ANGOSTA
    // (Arial Narrow, −1..7%) y crecer dejaría el número más grande de lo que Anton aguanta → al
    // llegar la fuente buena, se recorta. Sin fuentes el techo es el arranque, o sea se comporta
    // exactamente como la versión que sólo encogía; cuando lleguen, `loadingdone` re-mide.
    const techo = this.fuentesOk ? PRECIO_MAX_MM : PRECIO_MM;
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
    // `[ETQ-PROMO.5]` Bajo oferta el techo baja al 50%: el criterio de anaquel pide que el precio
    // sea ~2x el texto de apoyo, y el 0.7 general permitia que la barra de beneficio EMPATARA con
    // el precio — que es lo que se vio en la primera version.
    const k = this.enPromo ? MONTO_MAX_PROMO_K : 0.7;
    const techo = this.fuentesOk ? Math.min(MONTO_MAX_MM, heroMm * k) : MONTO_MM;
    while (size + 0.2 <= techo && guard++ < 60) {
      set(size + 0.2);
      if (noCabe() || !anchoOk()) { set(size); return; }
      size += 0.2;
    }
  }

  /**
   * El código de barras reclama el alto que los renglones no necesitan A SU TAMAÑO DE ARRANQUE.
   *
   * A 5 mm el símbolo está al **19% de la altura nominal de un EAN-13** (25.9 mm), y el símbolo
   * truncado es la causa número uno de no-lectura en ángulo.
   *
   * ⭐ Dos cosas cambian respecto de la versión anterior, y las dos las obligó la medición:
   *
   * 1. Corre ANTES de `fitTiers` (ver el orden en `layout`) y **pone los montos en su arranque
   *    antes de medir**. Midiendo después, los montos ya habían crecido hasta llenar la columna
   *    y el aire salía 0: el símbolo se quedaba en 5 mm en el caso común. No es que sobrara
   *    poco espacio — es que el otro ajuste ya se lo había llevado.
   *
   * 2. El aire se mide contra la COLUMNA (`.etq-right`), no contra el bloque de renglones. Con
   *    cero renglones —el 5% del catálogo, y justo el caso donde el decode prometía 21 mm de
   *    aire— `.etq-tiers` va `flex:0 0 auto`, su `clientHeight` es 0 y la guarda sacaba a la
   *    función sin ajustar nada: el caso de más aire era el único que no lo usaba.
   *
   * Sigue siendo una transferencia de UNA pasada, no un bucle: el símbolo arranca de su mínimo
   * (anti-trinquete) y consume el aire medido menos 0.3 mm de holgura, así que no hay
   * circularidad con el `flex:1` de los renglones. El ANCHO no se toca (mínimo físico del EAN-13).
   */
  private fitBarcode(): void {
    const svg = this.bc?.nativeElement;
    const box = this.tiers?.nativeElement;
    const bloque = svg?.parentElement;   // .etq-barcode (símbolo + dígitos legibles)
    const col = box?.parentElement;      // .etq-right
    if (!svg || !box || !bloque || !col) return;
    svg.style.height = BARCODE_MIN_MM + 'mm'; // anti-trinquete: siempre desde el mínimo
    // Los renglones, a su tamaño de ARRANQUE: es el reparto que decide quién se lleva el aire.
    this.amtEls?.forEach((r) => { r.nativeElement.style.fontSize = MONTO_MM + 'mm'; });
    if (!(col.clientHeight > 0)) return; // sin medida no se toca (ver fitPrice)
    const usado = this.altoTiers(box) + bloque.offsetHeight;
    const aire = (col.clientHeight - usado) / 96 * 25.4;
    if (!(aire > 0)) return;
    // `[ETQ-PROMO.5]` Bajo oferta el simbolo tiene su propio techo. Al ocultar mayoreo y caja el
    // aire se dispara y el codigo se iba a sus 12 mm: el espacio que se le quito a lo comercial
    // se lo quedaba lo operativo. El sobrante queda para el precio normal, que es el ancla.
    const techoBc = this.enPromo ? BARCODE_MAX_PROMO_MM : BARCODE_MAX_MM;
    const alto = Math.max(BARCODE_MIN_MM, Math.min(techoBc, BARCODE_MIN_MM + aire - 0.3));
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
